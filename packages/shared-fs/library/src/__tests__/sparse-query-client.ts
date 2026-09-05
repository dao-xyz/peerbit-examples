import { sha256Base64Sync } from "@peerbit/crypto";
import { StringMatch } from "@peerbit/document";
import type { SharedFsHandle } from "../index.js";
import {
    FileChunk,
    FileVersion,
    NamingEvent,
    type SharedFsEntry,
} from "../model.js";
import { SparseReadCache } from "./sparse-query-cache.js";

/** TEST ONLY: a source-scoped read probe, not a mounted/writable filesystem.
 * No local log joins, live-query replication pins, metadata cache or GC.
 * A completed query observes one source, not a global/atomic namespace frontier.
 * Conflicts and excessive history fail closed instead of guessing a winner.
 */
export class SparseQueryClient {
    readonly cache: SparseReadCache;
    readonly counters = { queries: 0, rows: 0, chunkFetches: 0, cacheHits: 0 };
    private session = new AbortController();
    private connected = true;
    private busy = false;

    constructor(
        private readonly entries: SharedFsHandle["program"]["entries"],
        private readonly source: string,
        private readonly limits = {
            maxRows: 64,
            pageSize: 8,
            maxPages: 64,
            maxFileBytes: 64 * 1024,
            maxChunkBytes: 64 * 1024,
            timeout: 5_000,
        },
        cache = new SparseReadCache({ maxBytes: 16 * 1024, maxEntries: 4 })
    ) {
        if (!source.trim())
            throw new Error("Sparse query requires an explicit source");
        this.limits = { ...limits };
        for (const value of Object.values(limits)) {
            if (!Number.isSafeInteger(value) || value < 1) {
                throw new Error(
                    "Sparse query limits must be positive safe integers"
                );
            }
        }
        this.cache = cache;
    }

    /** Caller must invalidate on connectivity loss; cached bytes prove no freshness. */
    disconnect() {
        this.connected = false;
        this.session.abort(new Error("Sparse query session invalidated"));
        this.cache.clear();
    }

    reconnect() {
        this.disconnect();
        this.session = new AbortController();
        this.connected = true;
    }

    private async operation<T>(
        fn: (signal: AbortSignal, budget: { rows: number }) => Promise<T>,
        signal?: AbortSignal
    ) {
        if (!this.connected)
            throw new Error("Sparse source freshness unknown: disconnected");
        if (this.busy) throw new Error("Only one sparse read may be in flight");
        this.busy = true;
        const combined = AbortSignal.any([
            this.session.signal,
            AbortSignal.timeout(this.limits.timeout),
            ...(signal ? [signal] : []),
        ]);
        try {
            combined.throwIfAborted();
            const value = await fn(combined, { rows: 0 });
            combined.throwIfAborted();
            return value;
        } finally {
            this.busy = false;
        }
    }

    private async query(
        matches: Record<string, string>,
        signal: AbortSignal,
        budget: { rows: number }
    ): Promise<SharedFsEntry[]> {
        signal.throwIfAborted();
        this.counters.queries++;
        const iterator = this.entries.index.iterate(
            {
                query: Object.entries(matches).map(
                    ([key, value]) => new StringMatch({ key, value })
                ),
            },
            {
                local: false,
                remote: {
                    from: [this.source],
                    replicate: false,
                    throwOnMissing: true,
                    retryMissingResponses: false,
                    timeout: this.limits.timeout,
                },
                resolve: true,
                signal,
            }
        );
        const rows: SharedFsEntry[] = [];
        let pages = 0;
        try {
            while (!iterator.done()) {
                if (++pages > this.limits.maxPages)
                    throw new Error("Sparse query page budget exceeded");
                // One sentinel row detects overflow; never report truncated coverage.
                const page = await iterator.next(
                    Math.min(
                        this.limits.pageSize,
                        this.limits.maxRows - budget.rows + 1
                    )
                );
                signal.throwIfAborted();
                this.counters.rows += page.length;
                budget.rows += page.length;
                if (budget.rows > this.limits.maxRows)
                    throw new Error("Sparse query row budget exceeded");
                rows.push(...page);
            }
        } catch (queryError) {
            try {
                await iterator.close();
            } catch (closeError) {
                throw new AggregateError(
                    [queryError, closeError],
                    "Sparse query and iterator cleanup failed"
                );
            }
            throw queryError;
        }
        await iterator.close();
        signal.throwIfAborted();
        return rows;
    }

    private uniqueHead<T extends NamingEvent | FileVersion>(
        docs: T[]
    ): T | undefined {
        if (!docs.length) return undefined;
        const referenced = new Set(
            docs.flatMap((doc) =>
                doc instanceof NamingEvent
                    ? doc.parentNamingIds
                    : doc.parentVersionIds
            )
        );
        const heads = docs.filter((doc) => !referenced.has(doc.id));
        if (heads.length !== 1)
            throw new Error(
                "Sparse prototype does not resolve conflicting or cyclic heads"
            );
        return heads[0];
    }

    private async naming(
        nodeId: string,
        signal: AbortSignal,
        budget: { rows: number }
    ) {
        const rows = await this.query(
            { kind: "naming", nodeId },
            signal,
            budget
        );
        if (
            !rows.every(
                (row) => row instanceof NamingEvent && row.nodeId === nodeId
            )
        )
            throw new Error("Invalid naming response");
        return this.uniqueHead(rows as NamingEvent[]);
    }

    /** Exact slot discovery followed by node-ID revalidation catches moves OUT. */
    lookup(parentId: string, name: string, signal?: AbortSignal) {
        return this.operation(async (active, budget) => {
            const rows = await this.query(
                { kind: "naming", parentId, name },
                active,
                budget
            );
            const candidates = new Set(
                rows.map((row) => {
                    if (
                        !(row instanceof NamingEvent) ||
                        row.parentId !== parentId ||
                        row.name !== name
                    )
                        throw new Error("Invalid slot response");
                    return row.nodeId;
                })
            );
            const claimants: string[] = [];
            for (const nodeId of candidates) {
                const current = await this.naming(nodeId, active, budget);
                if (!current)
                    throw new Error("Source changed during slot lookup");
                if (
                    !current.deleted &&
                    current.parentId === parentId &&
                    current.name === name
                )
                    claimants.push(nodeId);
            }
            if (claimants.length > 1)
                throw new Error(
                    "Sparse prototype does not resolve contested slots"
                );
            return {
                status: claimants.length
                    ? ("observed" as const)
                    : ("not-observed" as const),
                nodeId: claimants[0],
                coverage: "single-source-non-atomic" as const,
            };
        }, signal);
    }

    /** Explicit refresh by stable node ID; never relies on an old path predicate. */
    readNode(nodeId: string, signal?: AbortSignal) {
        return this.operation(async (active, budget) => {
            const naming = await this.naming(nodeId, active, budget);
            const coverage = "single-source-non-atomic" as const;
            if (!naming) return { status: "not-observed" as const, coverage };
            if (naming.deleted)
                return { status: "deleted" as const, coverage, naming };
            const rows = await this.query(
                { kind: "file-version", nodeId },
                active,
                budget
            );
            if (
                !rows.every(
                    (row) => row instanceof FileVersion && row.nodeId === nodeId
                )
            )
                throw new Error("Invalid version response");
            const version = this.uniqueHead(rows as FileVersion[]);
            if (!version) throw new Error("File version unavailable at source");
            if (version.size > BigInt(this.limits.maxFileBytes))
                throw new Error("Sparse file byte budget exceeded");
            // Bound manifest fanout independently of the file size claim.
            if (version.chunkIds.length > this.limits.maxRows)
                throw new Error("Sparse chunk count budget exceeded");
            const bytes = new Uint8Array(Number(version.size));
            let offset = 0;
            for (const id of version.chunkIds) {
                active.throwIfAborted();
                let chunk = this.cache.get(id);
                if (chunk) {
                    this.counters.cacheHits++;
                } else {
                    this.counters.chunkFetches++;
                    const found = await this.query({ id }, active, budget);
                    if (found.length !== 1 || !(found[0] instanceof FileChunk))
                        throw new Error("Chunk unavailable at source");
                    const value = found[0];
                    if (
                        value.id !== id ||
                        value.bytes.byteLength > this.limits.maxChunkBytes ||
                        value.hash !== sha256Base64Sync(value.bytes) ||
                        `chunk:${value.hash}` !== id
                    )
                        throw new Error("Invalid or oversized chunk");
                    chunk = value.bytes;
                    this.cache.set(id, chunk);
                }
                if (offset + chunk.byteLength > bytes.byteLength)
                    throw new Error("Chunk layout exceeds file size");
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
            }
            if (
                offset !== bytes.byteLength ||
                sha256Base64Sync(bytes) !== version.contentHash
            )
                throw new Error("File content verification failed");
            return {
                status: "observed" as const,
                coverage,
                naming,
                version,
                bytes,
            };
        }, signal);
    }
}
