import { field, variant, vec, option } from "@dao-xyz/borsh";
import { Program, ProgramHandler } from "@peerbit/program";
import {
    Documents,
    SearchRequest,
    StringMatch,
    StringMatchMethod,
    IsNull,
} from "@peerbit/document";
import {
    PublicSignKey,
    sha256Base64Sync,
    randomBytes,
    toBase64,
    toBase64URL,
} from "@peerbit/crypto";
import { concat } from "uint8arrays";
import { sha256Sync } from "@peerbit/crypto";
import { TrustedNetwork } from "@peerbit/trusted-network";
import { ReplicationOptions, SharedLog } from "@peerbit/shared-log";
import { SHA256 } from "@stablelib/sha256";

const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

type RuntimeOpenProfileSample = {
    label: string;
    target: string;
    startedAt: number;
    finishedAt: number;
    durationMs: number;
};

type RuntimeOpenProfilerState = {
    patched: boolean;
    samples: RuntimeOpenProfileSample[];
};

const isRuntimeOpenProfilerEnabled = () => {
    const scope = globalThis as typeof globalThis & {
        __peerbitFileShareEnableOpenProfiler?: boolean;
    };
    return scope.__peerbitFileShareEnableOpenProfiler === true;
};

const getRuntimeOpenProfilerState = (): RuntimeOpenProfilerState => {
    const scope = globalThis as typeof globalThis & {
        __peerbitFileShareRuntimeOpenProfiler?: RuntimeOpenProfilerState;
    };
    scope.__peerbitFileShareRuntimeOpenProfiler ??= {
        patched: false,
        samples: [],
    };
    return scope.__peerbitFileShareRuntimeOpenProfiler;
};

const recordRuntimeOpenProfileSample = (
    label: string,
    target: string,
    startedAt: number
) => {
    if (!isRuntimeOpenProfilerEnabled()) {
        return;
    }
    const finishedAt = Date.now();
    getRuntimeOpenProfilerState().samples.push({
        label,
        target,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
    });
};

const wrapAsyncMethod = (
    ctor:
        | {
              name?: string;
              prototype?: object;
          }
        | undefined,
    method: string,
    getLabel: (instance: any, args: any[]) => string
) => {
    const prototype = ctor?.prototype as Record<string, unknown> | undefined;
    if (!prototype || typeof prototype[method] !== "function") {
        return;
    }
    const original = prototype[method] as ((...args: any[]) => Promise<any>) & {
        __peerbitOpenProfilePatched?: boolean;
    };
    if (original.__peerbitOpenProfilePatched) {
        return;
    }
    const wrapped = async function (this: any, ...args: any[]) {
        const startedAt = Date.now();
        try {
            return await original.apply(this, args);
        } finally {
            recordRuntimeOpenProfileSample(
                getLabel(this, args),
                this?.constructor?.name ?? ctor?.name ?? "unknown",
                startedAt
            );
        }
    };
    wrapped.__peerbitOpenProfilePatched = true;
    prototype[method] = wrapped;
};

const describeOpenTarget = (target: unknown) => {
    if (typeof target === "string") {
        return "address";
    }
    return (target as { constructor?: { name?: string } })?.constructor?.name ?? "unknown";
};

const installRuntimeOpenProfiler = () => {
    if (!isRuntimeOpenProfilerEnabled()) {
        return;
    }
    const state = getRuntimeOpenProfilerState();
    if (state.patched) {
        return;
    }
    state.patched = true;

    wrapAsyncMethod(ProgramHandler, "open", (_instance, args) => {
        return `ProgramHandler.open(${describeOpenTarget(args[0])})`;
    });
    wrapAsyncMethod(Program, "beforeOpen", (instance) => {
        return `Program.beforeOpen(${instance?.constructor?.name ?? "unknown"})`;
    });
    wrapAsyncMethod(Program, "afterOpen", (instance) => {
        return `Program.afterOpen(${instance?.constructor?.name ?? "unknown"})`;
    });
    wrapAsyncMethod(Documents, "open", (instance) => {
        return `Documents.open(${instance?.constructor?.name ?? "unknown"})`;
    });
    wrapAsyncMethod(SharedLog, "open", (instance) => {
        return `SharedLog.open(${instance?.constructor?.name ?? "unknown"})`;
    });
    wrapAsyncMethod(TrustedNetwork, "open", (instance) => {
        return `TrustedNetwork.open(${instance?.constructor?.name ?? "unknown"})`;
    });
};

installRuntimeOpenProfiler();

const isRetryableChunkLookupError = (error: unknown) =>
    error instanceof Error &&
    (error.name === "AbortError" ||
        error.message.includes("fanout channel closed"));

type FileReadOptions = {
    timeout?: number;
    progress?: (progress: number) => any;
};

export interface ReReadableChunkSource {
    size: bigint;
    readChunks(chunkSize: number): AsyncIterable<Uint8Array>;
}

interface ChunkWritable {
    write(chunk: Uint8Array): Promise<void> | void;
    close?(): Promise<void> | void;
    abort?(reason?: unknown): Promise<void> | void;
}

export abstract class AbstractFile {
    abstract id: string;
    abstract name: string;
    abstract size: bigint;
    abstract parentId?: string;
    abstract streamFile(
        files: Files,
        properties?: FileReadOptions
    ): AsyncIterable<Uint8Array>;

    async getFile<
        OutputType extends "chunks" | "joined" = "joined",
        Output = OutputType extends "chunks" ? Uint8Array[] : Uint8Array,
    >(
        files: Files,
        properties?: {
            as: OutputType;
        } & FileReadOptions
    ): Promise<Output> {
        const chunks: Uint8Array[] = [];
        for await (const chunk of this.streamFile(files, properties)) {
            chunks.push(chunk);
        }
        return (
            properties?.as === "chunks" ? chunks : concat(chunks)
        ) as Output;
    }

    async writeFile(
        files: Files,
        writable: ChunkWritable,
        properties?: FileReadOptions
    ) {
        try {
            for await (const chunk of this.streamFile(files, properties)) {
                await writable.write(chunk);
            }
            await writable.close?.();
        } catch (error) {
            if (writable.abort) {
                try {
                    await writable.abort(error);
                } catch {
                    // Ignore writable cleanup failures.
                }
            }
            throw error;
        }
    }

    abstract delete(files: Files): Promise<void>;
}

@variant("files_indexable_file")
export class IndexableFile {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    name: string;

    @field({ type: "u64" })
    size: bigint;

    @field({ type: option("string") })
    parentId?: string;

    constructor(file: AbstractFile) {
        this.id = file.id;
        this.name = file.name;
        this.size = file.size;
        this.parentId = file.parentId;
    }
}

const TINY_FILE_SIZE_LIMIT = 5 * 1e6; // 6mb
const LARGE_FILE_SEGMENT_SIZE = TINY_FILE_SIZE_LIMIT / 10;
const LARGE_FILE_TARGET_CHUNK_COUNT = 1024;
const CHUNK_SIZE_GRANULARITY = 64 * 1024;
const MAX_LARGE_FILE_SEGMENT_SIZE = TINY_FILE_SIZE_LIMIT - 256 * 1024;
const LARGE_FILE_CHUNK_LOOKUP_TIMEOUT_MS = 5 * 60 * 1000;
const LARGE_FILE_PERSISTED_READ_AHEAD = 16;
const LARGE_FILE_OBSERVER_READ_AHEAD = 2;
const LARGE_FILE_OBSERVER_PREFETCH_TIMEOUT_MS = 5_000;
const TINY_FILE_SIZE_LIMIT_BIGINT = BigInt(TINY_FILE_SIZE_LIMIT);

const roundUpTo = (value: number, multiple: number) =>
    Math.ceil(value / multiple) * multiple;
const getLargeFileSegmentSize = (size: number | bigint) =>
    Math.min(
        MAX_LARGE_FILE_SEGMENT_SIZE,
        roundUpTo(
            Math.max(
                LARGE_FILE_SEGMENT_SIZE,
                Math.ceil(Number(size) / LARGE_FILE_TARGET_CHUNK_COUNT)
            ),
            CHUNK_SIZE_GRANULARITY
        )
    );
const getChunkStart = (index: number, chunkSize = LARGE_FILE_SEGMENT_SIZE) =>
    index * chunkSize;
const getChunkEnd = (
    index: number,
    size: number | bigint,
    chunkSize = LARGE_FILE_SEGMENT_SIZE
) => Math.min((index + 1) * chunkSize, Number(size));
const getChunkCount = (
    size: number | bigint,
    chunkSize = LARGE_FILE_SEGMENT_SIZE
) => Math.ceil(Number(size) / chunkSize);
const getChunkId = (parentId: string, index: number) => `${parentId}:${index}`;
const createUploadId = () => toBase64URL(randomBytes(16));
const isBlobLike = (value: Uint8Array | Blob): value is Blob =>
    typeof Blob !== "undefined" && value instanceof Blob;
const readBlobChunk = async (blob: Blob, index: number, chunkSize: number) =>
    new Uint8Array(
        await blob
            .slice(
                getChunkStart(index, chunkSize),
                getChunkEnd(index, blob.size, chunkSize)
            )
            .arrayBuffer()
    );
const ensureSourceSize = (actual: bigint, expected: bigint) => {
    if (actual !== expected) {
        throw new Error(
            `Source size changed during upload. Expected ${expected} bytes, got ${actual}`
        );
    }
};

@variant(0) // for versioning purposes
export class TinyFile extends AbstractFile {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    name: string;

    @field({ type: Uint8Array })
    file: Uint8Array; // 10 mb imit

    @field({ type: "string" })
    hash: string;

    @field({ type: option("string") })
    parentId?: string;

    @field({ type: option("u32") })
    index?: number;

    get size() {
        return BigInt(this.file.byteLength);
    }

    constructor(properties: {
        id?: string;
        name: string;
        file: Uint8Array;
        hash?: string;
        parentId?: string;
        index?: number;
    }) {
        super();
        this.parentId = properties.parentId;
        this.index = properties.index;
        this.id =
            properties.id ||
            (properties.parentId != null && properties.index != null
                ? `${properties.parentId}:${properties.index}`
                : sha256Base64Sync(properties.file));
        this.name = properties.name;
        this.file = properties.file;
        this.hash = properties.hash || sha256Base64Sync(properties.file);
    }

    async *streamFile(
        _files: Files,
        properties?: FileReadOptions
    ): AsyncIterable<Uint8Array> {
        if (sha256Base64Sync(this.file) !== this.hash) {
            throw new Error("Hash does not match the file content");
        }
        properties?.progress?.(1);
        yield this.file;
    }

    async delete(): Promise<void> {
        // Do nothing, since no releated files where created
    }
}

@variant(1) // for versioning purposes
export class LargeFile extends AbstractFile {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    name: string;

    @field({ type: "u64" })
    size: bigint;

    @field({ type: "u32" })
    chunkCount: number;

    @field({ type: "bool" })
    ready: boolean;

    @field({ type: option("string") })
    finalHash?: string;

    constructor(properties: {
        id?: string;
        name: string;
        size: bigint;
        chunkCount: number;
        ready?: boolean;
        finalHash?: string;
    }) {
        super();
        this.id = properties.id || createUploadId();
        this.name = properties.name;
        this.size = properties.size;
        this.chunkCount = properties.chunkCount;
        this.ready = properties.ready ?? false;
        this.finalHash = properties.finalHash;
    }

    get parentId() {
        // Large file can never have a parent
        return undefined;
    }

    async fetchChunks(
        files: Files,
        properties?: {
            timeout?: number;
        }
    ) {
        const chunks = new Map<number, TinyFile>();
        const totalTimeout = properties?.timeout ?? 30_000;
        const deadline = Date.now() + totalTimeout;
        const queryTimeout = Math.min(totalTimeout, 5_000);
        const recordChunks = (results: AbstractFile[]) => {
            for (const chunk of results) {
                if (
                    chunk instanceof TinyFile &&
                    chunk.parentId === this.id &&
                    chunk.index != null &&
                    !chunks.has(chunk.index)
                ) {
                    chunks.set(chunk.index, chunk);
                }
            }
        };

        while (chunks.size < this.chunkCount && Date.now() < deadline) {
            const before = chunks.size;
            const remoteFrom = await files.getReadPeerHints();
            recordChunks(
                await files.files.index.search(
                    new SearchRequest({
                        query: new StringMatch({ key: "parentId", value: this.id }),
                        fetch: 0xffffffff,
                    }),
                    {
                        local: true,
                        remote: {
                            timeout: queryTimeout,
                            throwOnMissing: false,
                            // Chunk queries return the full TinyFile document including its
                            // bytes. Observer reads can stream that result directly, while
                            // actual replicators should still persist downloaded chunks.
                            replicate: files.persistChunkReads,
                            from: remoteFrom,
                        },
                    } as any
                )
            );

            if (chunks.size === before && chunks.size < this.chunkCount) {
                await sleep(250);
            }
        }

        return [...chunks.values()].sort((a, b) => (a.index || 0) - (b.index || 0));
    }
    async delete(files: Files) {
        await Promise.all((await this.fetchChunks(files)).map((x) => files.files.del(x.id)));
    }

    private async resolveChunk(
        files: Files,
        index: number,
        knownChunks: Map<number, TinyFile>,
        properties?: {
            timeout?: number;
            debug?: Record<string, any>;
        }
    ): Promise<TinyFile> {
        const totalTimeout =
            properties?.timeout ?? LARGE_FILE_CHUNK_LOOKUP_TIMEOUT_MS;
        const deadline = Date.now() + totalTimeout;
        const attemptTimeout = Math.min(totalTimeout, 5_000);
        const chunkId = getChunkId(this.id, index);

        while (Date.now() < deadline) {
            properties?.debug &&
                ((properties.debug.chunkAttempts ||= {})[index] =
                    ((properties.debug.chunkAttempts ||= {})[index] ?? 0) + 1);
            const cached = knownChunks.get(index);
            if (cached) {
                properties?.debug &&
                    ((properties.debug.chunkResolved ||= {})[index] = "cached");
                return cached;
            }
            const remoteFrom = await files.getReadPeerHints();
            if (properties?.debug) {
                (properties.debug.chunkHints ||= {})[index] = remoteFrom ?? null;
            }

            try {
                const chunk = await files.files.index.get(chunkId, {
                    local: true,
                    waitFor: attemptTimeout,
                    remote: {
                        timeout: attemptTimeout,
                        // Chunk docs are immutable once the ready manifest is
                        // visible. Using keep-open waits here under read-ahead
                        // fan-out creates long-lived remote queries that can
                        // stall bulk reads instead of helping them complete.
                        // We use short stateless retries in the outer loop
                        // instead.
                        throwOnMissing: false,
                        retryMissingResponses: true,
                        replicate: files.persistChunkReads,
                        from: remoteFrom,
                    },
                });

                if (
                    chunk instanceof TinyFile &&
                    chunk.parentId === this.id &&
                    chunk.index === index
                ) {
                    knownChunks.set(index, chunk);
                    properties?.debug &&
                        ((properties.debug.chunkResolved ||= {})[index] =
                            "remote-get");
                    return chunk;
                }
            } catch (error) {
                if (!isRetryableChunkLookupError(error)) {
                    properties?.debug &&
                        (properties.debug.chunkFailure = {
                            index,
                            type: "non-retryable",
                            message:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        });
                    throw error;
                }
            }

            await sleep(250);
        }

        throw new Error(
            `Failed to resolve chunk ${index + 1}/${this.chunkCount} for file ${this.id}`
        );
    }

    private async waitUntilReady(
        files: Files,
        properties?: FileReadOptions
    ): Promise<LargeFile> {
        if (this.ready) {
            return this;
        }

        const totalTimeout =
            properties?.timeout ?? LARGE_FILE_CHUNK_LOOKUP_TIMEOUT_MS;
        const deadline = Date.now() + totalTimeout;
        const attemptTimeout = Math.min(totalTimeout, 5_000);

        while (Date.now() < deadline) {
            const debug = files.lastReadDiagnostics;
            if (debug) {
                debug.waitUntilReadyAttempts += 1;
            }
            const remoteFrom = await files.getReadPeerHints();
            const latest = await files.resolveById(this.id, {
                timeout: attemptTimeout,
                replicate: true,
                from: remoteFrom,
            });
            if (debug) {
                debug.lastReadyProbe = {
                    at: Date.now(),
                    ready: latest instanceof LargeFile ? latest.ready : null,
                    from: remoteFrom ?? null,
                };
            }

            if (latest instanceof LargeFile && latest.ready) {
                return latest;
            }

            await sleep(250);
        }

        throw new Error(
            `File ${this.id} is still uploading after waiting ${Math.round(
                totalTimeout / 1000
            )} seconds`
        );
    }

    async *streamFile(
        files: Files,
        properties?: FileReadOptions
    ): AsyncIterable<Uint8Array> {
        const debug = {
            fileId: this.id,
            fileName: this.name,
            persistChunkReads: files.persistChunkReads,
            startedAt: Date.now(),
            waitUntilReadyAttempts: 0,
            waitUntilReadyResolvedAt: null as number | null,
            waitUntilReadyResolvedReady: null as boolean | null,
            prefetchedChunkCount: 0,
            finishedAt: null as number | null,
            chunkAttempts: {} as Record<number, number>,
            chunkHints: {} as Record<number, string[] | null>,
            chunkResolved: {} as Record<number, string>,
            chunkFailure: null as
                | {
                      index: number;
                      type: string;
                      message: string;
                  }
                | null,
        };
        files.lastReadDiagnostics = debug;
        const resolvedFile = await this.waitUntilReady(files, properties);
        debug.waitUntilReadyResolvedAt = Date.now();
        debug.waitUntilReadyResolvedReady = resolvedFile.ready;

        properties?.progress?.(0);

        let processed = 0;
        const hasher = resolvedFile.finalHash ? new SHA256() : undefined;
        const knownChunks = new Map<number, TinyFile>();
        if (!files.persistChunkReads) {
            for (const chunk of await resolvedFile.fetchChunks(files, {
                timeout: Math.min(
                    properties?.timeout ?? LARGE_FILE_CHUNK_LOOKUP_TIMEOUT_MS,
                    LARGE_FILE_OBSERVER_PREFETCH_TIMEOUT_MS
                ),
            })) {
                knownChunks.set(chunk.index || 0, chunk);
            }
            debug.prefetchedChunkCount = knownChunks.size;
        }
        const inFlightChunks = new Map<number, Promise<TinyFile>>();
        const resolveChunkWithReadAhead = (index: number) => {
            const cached = inFlightChunks.get(index);
            if (cached) {
                return cached;
            }
            const pending = this.resolveChunk(files, index, knownChunks, {
                timeout: properties?.timeout,
                debug,
            });
            inFlightChunks.set(index, pending);
            return pending;
        };

        const readAhead = files.persistChunkReads
            ? LARGE_FILE_PERSISTED_READ_AHEAD
            : LARGE_FILE_OBSERVER_READ_AHEAD;

        for (
            let index = 0;
            index < Math.min(resolvedFile.chunkCount, readAhead);
            index++
        ) {
            void resolveChunkWithReadAhead(index);
        }

        for (let index = 0; index < resolvedFile.chunkCount; index++) {
            const nextIndex = index + readAhead;
            if (nextIndex < resolvedFile.chunkCount) {
                void resolveChunkWithReadAhead(nextIndex);
            }
            const chunkFile = await resolveChunkWithReadAhead(index);
            inFlightChunks.delete(index);
            if (!chunkFile) {
                throw new Error(
                    `Failed to resolve chunk ${index + 1}/${resolvedFile.chunkCount} for file ${resolvedFile.id}`
                );
            }
            const chunk = await chunkFile.getFile(files, {
                as: "joined",
                timeout: properties?.timeout,
            });
            hasher?.update(chunk);
            processed += chunk.byteLength;
            properties?.progress?.(
                processed / Math.max(Number(resolvedFile.size), 1)
            );
            yield chunk;
        }

        if (
            hasher &&
            toBase64(hasher.digest()) !== resolvedFile.finalHash
        ) {
            throw new Error("File hash does not match the expected content");
        }
        debug.finishedAt = Date.now();
    }
}

type Args = { replicate: ReplicationOptions };

type OpenDiagnostics = {
    startedAt: number;
    trustGraphOpenStartedAt: number | null;
    trustGraphOpenFinishedAt: number | null;
    filesOpenStartedAt: number | null;
    filesOpenFinishedAt: number | null;
    finishedAt: number | null;
    runtimeProfileSamples?: RuntimeOpenProfileSample[];
};

type UploadDiagnostics = {
    uploadId: string;
    fileName: string;
    sizeBytes: number;
    chunkSize: number;
    chunkCount: number;
    startedAt: number;
    manifestStartedAt: number | null;
    manifestFinishedAt: number | null;
    firstChunkStartedAt: number | null;
    firstChunkFinishedAt: number | null;
    lastChunkFinishedAt: number | null;
    chunkPutCount: number;
    chunkReadTotalMs: number;
    chunkReadMaxMs: number;
    chunkPutTotalMs: number;
    chunkPutMaxMs: number;
    slowestChunkIndex: number | null;
    slowestChunkPutMs: number | null;
    readyManifestStartedAt: number | null;
    readyManifestFinishedAt: number | null;
    finishedAt: number | null;
    failureAt: number | null;
    failureMessage: string | null;
};

@variant("files")
export class Files extends Program<Args> {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: "string" })
    name: string;

    @field({ type: option(TrustedNetwork) })
    trustGraph?: TrustedNetwork;

    @field({ type: Documents })
    files: Documents<AbstractFile, IndexableFile>;

    persistChunkReads: boolean;
    openDiagnostics?: OpenDiagnostics;
    lastReadDiagnostics?: Record<string, any>;
    lastUploadDiagnostics?: UploadDiagnostics;

    constructor(
        properties: {
            id?: Uint8Array;
            name?: string;
            rootKey?: PublicSignKey;
        } = {}
    ) {
        super();
        this.id = properties.id || randomBytes(32);
        this.name = properties.name || "";
        this.trustGraph = properties.rootKey
            ? new TrustedNetwork({ id: this.id, rootTrust: properties.rootKey })
            : undefined;
        this.files = new Documents({
            id: sha256Sync(
                concat([
                    this.id,
                    new TextEncoder().encode(this.name),
                    properties.rootKey?.bytes || new Uint8Array(0),
                ])
            ),
        });
        this.persistChunkReads = true;
    }

    async add(
        name: string,
        file: Uint8Array | Blob,
        parentId?: string,
        progress?: (progress: number) => void
    ) {
        if (isBlobLike(file)) {
            return this.addBlob(name, file, parentId, progress);
        }

        progress?.(0);
        if (BigInt(file.byteLength) <= TINY_FILE_SIZE_LIMIT_BIGINT) {
            const tinyFile = new TinyFile({ name, file, parentId });
            await this.files.put(tinyFile);
            progress?.(1);
            return tinyFile.id;
        }

        const chunkSize = getLargeFileSegmentSize(file.byteLength);
        return this.addChunkedFile(
            name,
            BigInt(file.byteLength),
            (index) =>
                Promise.resolve(
                    file.subarray(
                        getChunkStart(index, chunkSize),
                        getChunkEnd(index, file.byteLength, chunkSize)
                    )
                ),
            chunkSize,
            parentId,
            progress
        );
    }

    async addBlob(
        name: string,
        file: Blob,
        parentId?: string,
        progress?: (progress: number) => void
    ) {
        progress?.(0);
        if (BigInt(file.size) <= TINY_FILE_SIZE_LIMIT_BIGINT) {
            const tinyFile = new TinyFile({
                name,
                file: new Uint8Array(await file.arrayBuffer()),
                parentId,
            });
            await this.files.put(tinyFile);
            progress?.(1);
            return tinyFile.id;
        }

        const chunkSize = getLargeFileSegmentSize(file.size);
        return this.addChunkedFile(
            name,
            BigInt(file.size),
            (index) => readBlobChunk(file, index, chunkSize),
            chunkSize,
            parentId,
            progress
        );
    }

    async addSource(
        name: string,
        source: ReReadableChunkSource,
        parentId?: string,
        progress?: (progress: number) => void
    ) {
        progress?.(0);
        if (source.size <= TINY_FILE_SIZE_LIMIT_BIGINT) {
            const chunks: Uint8Array[] = [];
            let processed = 0n;
            for await (const chunk of source.readChunks(TINY_FILE_SIZE_LIMIT)) {
                chunks.push(chunk);
                processed += BigInt(chunk.byteLength);
            }
            ensureSourceSize(processed, source.size);
            const tinyFile = new TinyFile({
                name,
                file: chunks.length === 0 ? new Uint8Array(0) : concat(chunks),
                parentId,
            });
            await this.files.put(tinyFile);
            progress?.(1);
            return tinyFile.id;
        }

        if (parentId) {
            throw new Error("Unexpected that a LargeFile to have a parent");
        }

        const size = source.size;
        const chunkSize = getLargeFileSegmentSize(size);
        const uploadId = createUploadId();
        const manifest = new LargeFile({
            id: uploadId,
            name,
            size,
            chunkCount: getChunkCount(size, chunkSize),
            ready: false,
        });

        await this.files.put(manifest);
        const hasher = new SHA256();
        try {
            let uploadedBytes = 0n;
            let chunkCount = 0;
            for await (const chunkBytes of source.readChunks(chunkSize)) {
                hasher.update(chunkBytes);
                await this.files.put(
                    new TinyFile({
                        name: name + "/" + chunkCount,
                        file: chunkBytes,
                        parentId: uploadId,
                        index: chunkCount,
                    })
                );
                uploadedBytes += BigInt(chunkBytes.byteLength);
                chunkCount++;
                progress?.(Number(uploadedBytes) / Math.max(Number(size), 1));
            }
            ensureSourceSize(uploadedBytes, source.size);
            await this.files.put(
                new LargeFile({
                    id: uploadId,
                    name,
                    size,
                    chunkCount,
                    ready: true,
                    finalHash: toBase64(hasher.digest()),
                })
            );
        } catch (error) {
            await this.cleanupChunkedUpload(uploadId).catch(() => {});
            await this.files.del(uploadId).catch(() => {});
            throw error;
        }

        progress?.(1);
        return uploadId;
    }

    private async cleanupChunkedUpload(uploadId: string) {
        const chunks = await this.files.index.search(
            new SearchRequest({
                query: new StringMatch({
                    key: "parentId",
                    value: uploadId,
                }),
                fetch: 0xffffffff,
            }),
            { local: true }
        );
        await Promise.all(chunks.map((chunk) => this.files.del(chunk.id)));
    }

    private async addChunkedFile(
        name: string,
        size: bigint,
        getChunk: (index: number) => Promise<Uint8Array>,
        chunkSize: number,
        parentId?: string,
        progress?: (progress: number) => void
    ) {
        if (parentId) {
            throw new Error("Unexpected that a LargeFile to have a parent");
        }

        const uploadId = createUploadId();
        const chunkCount = getChunkCount(size, chunkSize);
        const diagnostics: UploadDiagnostics = {
            uploadId,
            fileName: name,
            sizeBytes: Number(size),
            chunkSize,
            chunkCount,
            startedAt: Date.now(),
            manifestStartedAt: null,
            manifestFinishedAt: null,
            firstChunkStartedAt: null,
            firstChunkFinishedAt: null,
            lastChunkFinishedAt: null,
            chunkPutCount: 0,
            chunkReadTotalMs: 0,
            chunkReadMaxMs: 0,
            chunkPutTotalMs: 0,
            chunkPutMaxMs: 0,
            slowestChunkIndex: null,
            slowestChunkPutMs: null,
            readyManifestStartedAt: null,
            readyManifestFinishedAt: null,
            finishedAt: null,
            failureAt: null,
            failureMessage: null,
        };
        this.lastUploadDiagnostics = diagnostics;
        const manifest = new LargeFile({
            id: uploadId,
            name,
            size,
            chunkCount,
            ready: false,
        });

        diagnostics.manifestStartedAt = Date.now();
        await this.files.put(manifest);
        diagnostics.manifestFinishedAt = Date.now();
        const hasher = new SHA256();
        try {
            let uploadedBytes = 0;
            for (let i = 0; i < chunkCount; i++) {
                const readStartedAt = Date.now();
                const chunkBytes = await getChunk(i);
                const readFinishedAt = Date.now();
                diagnostics.chunkReadTotalMs += readFinishedAt - readStartedAt;
                diagnostics.chunkReadMaxMs = Math.max(
                    diagnostics.chunkReadMaxMs,
                    readFinishedAt - readStartedAt
                );
                hasher.update(chunkBytes);
                const putStartedAt = Date.now();
                diagnostics.firstChunkStartedAt ??= putStartedAt;
                await this.files.put(
                    new TinyFile({
                        name: name + "/" + i,
                        file: chunkBytes,
                        parentId: uploadId,
                        index: i,
                    })
                );
                const putFinishedAt = Date.now();
                const putDurationMs = putFinishedAt - putStartedAt;
                diagnostics.firstChunkFinishedAt ??= putFinishedAt;
                diagnostics.lastChunkFinishedAt = putFinishedAt;
                diagnostics.chunkPutCount += 1;
                diagnostics.chunkPutTotalMs += putDurationMs;
                diagnostics.chunkPutMaxMs = Math.max(
                    diagnostics.chunkPutMaxMs,
                    putDurationMs
                );
                if (
                    diagnostics.slowestChunkPutMs == null ||
                    putDurationMs > diagnostics.slowestChunkPutMs
                ) {
                    diagnostics.slowestChunkPutMs = putDurationMs;
                    diagnostics.slowestChunkIndex = i;
                }
                uploadedBytes += chunkBytes.byteLength;
                progress?.(uploadedBytes / Math.max(Number(size), 1));
            }
            diagnostics.readyManifestStartedAt = Date.now();
            await this.files.put(
                new LargeFile({
                    id: uploadId,
                    name,
                    size,
                    chunkCount,
                    ready: true,
                    finalHash: toBase64(hasher.digest()),
                })
            );
            diagnostics.readyManifestFinishedAt = Date.now();
        } catch (error) {
            diagnostics.failureAt = Date.now();
            diagnostics.failureMessage =
                error instanceof Error ? error.message : String(error);
            await this.cleanupChunkedUpload(uploadId).catch(() => {});
            await this.files.del(uploadId).catch(() => {});
            throw error;
        }

        diagnostics.finishedAt = Date.now();
        progress?.(1);
        return uploadId;
    }

    async removeById(id: string) {
        const file = await this.files.index.get(id);
        if (file) {
            await file.delete(this);
            await this.files.del(file.id);
        }
    }

    async removeByName(name: string) {
        const files = await this.files.index.search(
            new SearchRequest({
                query: new StringMatch({
                    key: ["name"],
                    value: name,
                    caseInsensitive: false,
                    method: StringMatchMethod.exact,
                }),
                fetch: 0xffffffff,
            })
        );
        for (const file of files) {
            await file.delete(this);
            await this.files.del(file.id);
        }
    }

    async list() {
        const remoteFrom = await this.getReadPeerHints();
        // only root files (don't fetch fetch chunks here)
        const files = await this.files.index.search(
            new SearchRequest({
                query: new IsNull({ key: "parentId" }),
                fetch: 0xffffffff,
            }),
            {
                local: true,
                remote: {
                    // Allow partial results while the network is still forming. If we
                    // throw on missing shards here, the UI can appear "empty" until
                    // all shard roots respond, which feels broken during joins/churn.
                    throwOnMissing: false,
                    replicate: true, // sync here because this, because we might want to access it offline, even though we are not replicators
                    from: remoteFrom,
                },
            } as any
        );
        return files;
    }

    async countLocalChunks(parent: LargeFile): Promise<number> {
        const count = await this.files.index.index.count(
            new SearchRequest({
                query: new StringMatch({ key: "parentId", value: parent.id }),
                fetch: 0xffffffff,
            })
        );
        return count;
    }

    async resolveById(
        id: string,
        properties?: {
            timeout?: number;
            replicate?: boolean;
            from?: string[];
        }
    ): Promise<AbstractFile | undefined> {
        return this.files.index.get(id, {
            local: true,
            waitFor: properties?.timeout,
            remote: {
                timeout: properties?.timeout ?? 10 * 1000,
                wait: properties?.timeout
                    ? {
                          timeout: properties.timeout,
                          behavior: "keep-open",
                      }
                    : undefined,
                throwOnMissing: false,
                retryMissingResponses: true,
                replicate: properties?.replicate,
                from: properties?.from,
            },
        });
    }

    async resolveByName(
        name: string,
        properties?: {
            timeout?: number;
            replicate?: boolean;
            from?: string[];
        }
    ): Promise<AbstractFile | undefined> {
        const results = await this.files.index.search(
            new SearchRequest({
                query: [
                    new StringMatch({
                        key: "name",
                        value: name,
                        caseInsensitive: false,
                        method: StringMatchMethod.exact,
                    }),
                ],
                fetch: 1,
            }),
            {
                local: true,
                remote: {
                    timeout: properties?.timeout ?? 10 * 1000,
                    throwOnMissing: false,
                    replicate: properties?.replicate,
                    from: properties?.from,
                },
            } as any
        );
        return results[0];
    }

    async getReadPeerHints(): Promise<string[] | undefined> {
        const replicators = await this.files.log.getReplicators().catch(() => undefined);
        if (!replicators || replicators.size === 0) {
            return undefined;
        }

        const selfHash = this.node.identity.publicKey.hashcode();

        const hashes = [...replicators]
            .map((replicator: string | { hashcode?: () => string }) =>
                typeof replicator === "string"
                    ? replicator
                    : replicator.hashcode?.()
            )
            .filter(
                (hash, index, values): hash is string =>
                    hash != null &&
                    hash !== selfHash &&
                    values.indexOf(hash) === index
            );

        return hashes.length > 0 ? hashes : undefined;
    }

    /**
     * Get by name
     * @param id
     * @returns
     */
    async getById<
        OutputType extends "chunks" | "joined" = "joined",
        Output = OutputType extends "chunks" ? Uint8Array[] : Uint8Array,
    >(
        id: string,
        properties?: { as: OutputType }
    ): Promise<{ id: string; name: string; bytes: Output } | undefined> {
        const results = await this.files.index.search(
            new SearchRequest({
                query: [new StringMatch({ key: "id", value: id })],
                fetch: 0xffffffff,
            }),
            {
                local: true,
                remote: {
                    timeout: 10 * 1000,
                },
            }
        );

        for (const result of results) {
            const file = await result.getFile(this, properties);
            if (file) {
                return {
                    id: result.id,
                    name: result.name,
                    bytes: file as Output,
                };
            }
        }
    }

    /**
     * Get by name
     * @param name
     * @returns
     */
    async getByName<
        OutputType extends "chunks" | "joined" = "joined",
        Output = OutputType extends "chunks" ? Uint8Array[] : Uint8Array,
    >(
        name: string,
        properties?: { as: OutputType }
    ): Promise<{ id: string; name: string; bytes: Output } | undefined> {
        const results = await this.files.index.search(
            new SearchRequest({
                query: [new StringMatch({ key: "name", value: name })],
                fetch: 0xffffffff,
            }),
            {
                local: true,
                remote: {
                    timeout: 10 * 1000,
                },
            }
        );

        for (const result of results) {
            const file = await result.getFile(this, properties);
            if (file) {
                return {
                    id: result.id,
                    name: result.name,
                    bytes: file as Output,
                };
            }
        }
    }

    // Setup lifecycle, will be invoked on 'open'
    async open(args?: Args): Promise<void> {
        const runtimeProfileStartIndex =
            getRuntimeOpenProfilerState().samples.length;
        const openDiagnostics: OpenDiagnostics = {
            startedAt: Date.now(),
            trustGraphOpenStartedAt: null,
            trustGraphOpenFinishedAt: null,
            filesOpenStartedAt: null,
            filesOpenFinishedAt: null,
            finishedAt: null,
        };
        this.openDiagnostics = openDiagnostics;
        this.persistChunkReads = args?.replicate !== false;
        openDiagnostics.trustGraphOpenStartedAt = Date.now();
        const trustGraphOpenPromise =
            this.trustGraph?.open({
                replicate: args?.replicate,
            }) ?? Promise.resolve();
        void trustGraphOpenPromise.finally(() => {
            openDiagnostics.trustGraphOpenFinishedAt = Date.now();
        });

        openDiagnostics.filesOpenStartedAt = Date.now();
        const filesOpenPromise = this.files.open({
            type: AbstractFile,
            // TODO add ACL
            replicate: args?.replicate,
            replicas: { min: 3 },
            canPerform: async (operation) => {
                if (!this.trustGraph) {
                    return true;
                }
                await trustGraphOpenPromise;
                for (const key of await operation.entry.getPublicKeys()) {
                    if (await this.trustGraph.isTrusted(key)) {
                        return true;
                    }
                }
                return false;
            },
            index: {
                type: IndexableFile,
            },
        });
        void filesOpenPromise.finally(() => {
            openDiagnostics.filesOpenFinishedAt = Date.now();
        });

        await Promise.all([trustGraphOpenPromise, filesOpenPromise]);
        openDiagnostics.finishedAt = Date.now();
        openDiagnostics.runtimeProfileSamples = getRuntimeOpenProfilerState().samples.slice(
            runtimeProfileStartIndex
        );
    }
}
