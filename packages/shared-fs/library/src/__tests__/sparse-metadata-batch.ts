import { And, Or, StringMatch } from "@peerbit/document";
import { NamingEvent, type SharedFsEntry } from "../model.js";
import type { SparseQueryClient } from "./sparse-query-client.js";

type Entries = ConstructorParameters<typeof SparseQueryClient>[0];
export type SparseSlot = { parentId: string; name: string };
const MAX_LIMITS = {
    maxKeys: 8,
    maxRows: 64,
    maxPages: 64,
    pageSize: 64,
    timeout: 5_000,
} as const;
type BatchLimits = { -readonly [Key in keyof typeof MAX_LIMITS]: number };

/** TEST ONLY: bounded independent lookups at one source, not an atomic snapshot.
 * Slot discovery must finish before node-history revalidation starts. Call the
 * unchanged readNode afterwards to refresh naming/version state and verify bytes.
 * No metadata/byte cache, log joins, push subscriptions, or reader-policy shim.
 */
export class SparseMetadataBatchClient {
    readonly counters = { queries: 0, rows: 0 };
    private session = new AbortController();
    private connected = true;
    private busy = false;
    private readonly limits;

    constructor(
        private readonly entries: Entries,
        private readonly source: string,
        limits: BatchLimits = {
            maxKeys: 8,
            maxRows: 64,
            maxPages: 64,
            pageSize: 8,
            timeout: 5_000,
        }
    ) {
        if (!source.trim())
            throw new Error("Sparse query requires an explicit source");
        if (!limits || typeof limits !== "object" || Array.isArray(limits))
            throw new Error("Sparse query requires complete bounded limits");
        const keys = Object.keys(MAX_LIMITS) as Array<keyof BatchLimits>;
        if (
            Object.keys(limits).length !== keys.length ||
            Object.keys(limits).some((key) => !Object.hasOwn(MAX_LIMITS, key))
        )
            throw new Error("Sparse query requires complete bounded limits");
        // Validate a snapshot of every required value, never only whichever
        // properties a JavaScript caller happened to supply.
        const owned = { ...limits };
        for (const key of keys) {
            const value = owned[key];
            if (
                !Object.hasOwn(owned, key) ||
                !Number.isSafeInteger(value) ||
                value < 1
            )
                throw new Error(
                    "Sparse query limits must be positive safe integers"
                );
            if (value > MAX_LIMITS[key])
                throw new Error(
                    `Sparse query limit ${key} exceeds ${MAX_LIMITS[key]}`
                );
        }
        this.limits = owned;
    }

    disconnect() {
        this.connected = false;
        this.session.abort(new Error("Sparse query session invalidated"));
    }

    reconnect() {
        this.disconnect();
        this.session = new AbortController();
        this.connected = true;
    }

    private async query(
        branches: Record<string, string>[],
        signal: AbortSignal,
        budget: { rows: number }
    ): Promise<SharedFsEntry[]> {
        signal.throwIfAborted();
        if (!branches.length || branches.length > this.limits.maxKeys)
            throw new Error("Sparse batch key budget exceeded");
        this.counters.queries++;
        const iterator = this.entries.index.iterate(
            {
                query: [
                    new Or(
                        branches.map(
                            (branch) =>
                                new And(
                                    Object.entries(branch).map(
                                        ([key, value]) =>
                                            new StringMatch({ key, value })
                                    )
                                )
                        )
                    ),
                ],
            },
            {
                local: false,
                resolve: true,
                signal,
                remote: {
                    from: [this.source],
                    replicate: false,
                    throwOnMissing: true,
                    retryMissingResponses: false,
                    timeout: this.limits.timeout,
                },
            }
        );
        const rows: SharedFsEntry[] = [];
        let pages = 0;
        try {
            while (!iterator.done()) {
                if (++pages > this.limits.maxPages)
                    throw new Error("Sparse query page budget exceeded");
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

    async lookupMany(slots: readonly SparseSlot[], signal?: AbortSignal) {
        if (!this.connected)
            throw new Error("Sparse source freshness unknown: disconnected");
        if (this.busy)
            throw new Error("Only one sparse batch may be in flight");
        if (slots.length > this.limits.maxKeys)
            throw new Error("Sparse batch key budget exceeded");
        // Copy before the first await: callers cannot alter in-flight predicates.
        const requested = slots.map(({ parentId, name }) => ({
            parentId,
            name,
        }));
        this.busy = true;
        const coverage = "single-source-non-atomic" as const;
        try {
            // Untyped callers can pass a non-signal; construction may throw,
            // but the operation guard must still be released for a later call.
            const active = AbortSignal.any([
                this.session.signal,
                AbortSignal.timeout(this.limits.timeout),
                ...(signal ? [signal] : []),
            ]);
            active.throwIfAborted();
            if (!requested.length) return [];
            const budget = { rows: 0 };
            const rows = await this.query(
                requested.map((slot) => ({ kind: "naming", ...slot })),
                active,
                budget
            );
            const candidates = new Set<string>();
            const slotCandidates = requested.map(() => new Set<string>());
            for (const row of rows) {
                if (
                    !(row instanceof NamingEvent) ||
                    !requested.some(
                        (slot) =>
                            slot.parentId === row.parentId &&
                            slot.name === row.name
                    )
                )
                    throw new Error("Invalid slot response");
                candidates.add(row.nodeId);
                requested.forEach((slot, index) => {
                    if (
                        slot.parentId === row.parentId &&
                        slot.name === row.name
                    )
                        slotCandidates[index].add(row.nodeId);
                });
            }
            // A contested slot may have many histories; do not turn its excess
            // candidates into an unbounded OR or silently truncate the search.
            if (candidates.size > this.limits.maxKeys)
                throw new Error("Sparse batch key budget exceeded");
            const current = new Map<string, NamingEvent>();
            if (candidates.size) {
                const history = await this.query(
                    [...candidates].map((nodeId) => ({
                        kind: "naming",
                        nodeId,
                    })),
                    active,
                    budget
                );
                const groups = new Map(
                    [...candidates].map((id) => [id, [] as NamingEvent[]])
                );
                for (const row of history) {
                    if (
                        !(row instanceof NamingEvent) ||
                        !groups.has(row.nodeId)
                    )
                        throw new Error("Invalid naming response");
                    groups.get(row.nodeId)!.push(row);
                }
                for (const [nodeId, docs] of groups) {
                    if (!docs.length)
                        throw new Error("Source changed during slot lookup");
                    const referenced = new Set(
                        docs.flatMap((doc) => doc.parentNamingIds)
                    );
                    const heads = docs.filter((doc) => !referenced.has(doc.id));
                    if (heads.length !== 1)
                        throw new Error(
                            "Sparse prototype does not resolve conflicting or cyclic heads"
                        );
                    current.set(nodeId, heads[0]);
                }
            }
            const result = requested.map((slot, index) => {
                const claimants = [...current.values()].filter(
                    (row) =>
                        slotCandidates[index].has(row.nodeId) &&
                        !row.deleted &&
                        row.parentId === slot.parentId &&
                        row.name === slot.name
                );
                if (claimants.length > 1)
                    throw new Error(
                        "Sparse prototype does not resolve contested slots"
                    );
                return {
                    status: claimants.length
                        ? ("observed" as const)
                        : ("not-observed" as const),
                    nodeId: claimants[0]?.nodeId,
                    coverage,
                };
            });
            active.throwIfAborted();
            return result;
        } finally {
            this.busy = false;
        }
    }
}
