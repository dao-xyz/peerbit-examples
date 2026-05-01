import { field, option, variant, vec } from "@dao-xyz/borsh";
import { Program, ProgramHandler } from "@peerbit/program";
import {
    Documents,
    SearchRequest,
    StringMatch,
    StringMatchMethod,
    IsNull,
    isPutOperation,
    type Operation,
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    return (
        (target as { constructor?: { name?: string } })?.constructor?.name ??
        "unknown"
    );
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

const getErrorName = (error: unknown) =>
    typeof (error as { name?: unknown })?.name === "string"
        ? (error as { name: string }).name
        : undefined;

const getErrorMessage = (error: unknown) =>
    error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : typeof (error as { message?: unknown })?.message === "string"
            ? (error as { message: string }).message
            : String(error);

const isRetryableChunkLookupError = (error: unknown) => {
    const name = getErrorName(error);
    const message = getErrorMessage(error);
    return (
        name === "AbortError" ||
        name === "DeliveryError" ||
        name === "StreamStateError" ||
        message.includes("fanout channel closed") ||
        message.includes("Failed to resolve block") ||
        message.includes("Failed to load entry from head") ||
        message.includes("Message did not have any valid receivers") ||
        message.includes("delivery acknowledges from all nodes")
    );
};

const shouldRetryChunkLookupWithoutHints = (error: unknown) => {
    const name = getErrorName(error);
    const message = getErrorMessage(error);
    return (
        name === "DeliveryError" ||
        message.includes("delivery acknowledges from all nodes") ||
        message.includes("Message did not have any valid receivers")
    );
};

type FileReadOptions = {
    timeout?: number;
    progress?: (progress: number) => any;
};

type ChunkReadContext = {
    lastReadPeerHints?: string[];
    localChunkEntryHeads?: Map<string, string>;
    localChunkEntryHeadsScan?: Promise<Map<string, string>>;
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
        let chunkIndex = 0;
        try {
            for await (const chunk of this.streamFile(files, properties)) {
                const debug = files.lastReadDiagnostics;
                if (debug) {
                    (debug.chunkWriteStartedAt ||= {})[chunkIndex] = Date.now();
                }
                await writable.write(chunk);
                if (debug) {
                    (debug.chunkWriteFinishedAt ||= {})[chunkIndex] =
                        Date.now();
                }
                chunkIndex++;
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
const LARGE_FILE_TARGET_CHUNK_COUNT = 256;
const CHUNK_SIZE_GRANULARITY = 64 * 1024;
const MAX_LARGE_FILE_SEGMENT_SIZE = 512 * 1024;
const LARGE_FILE_CHUNK_LOOKUP_TIMEOUT_MS = 5 * 60 * 1000;
const LARGE_FILE_PERSISTED_READ_AHEAD = 32;
const LARGE_FILE_OBSERVER_READ_AHEAD = 2;
const LARGE_FILE_OBSERVER_PREFETCH_TIMEOUT_MS = 5_000;
const LARGE_FILE_MIN_CHUNK_ATTEMPT_TIMEOUT_MS = 5_000;
const LARGE_FILE_MAX_CHUNK_ATTEMPT_TIMEOUT_MS = 45_000;
const LARGE_FILE_REMOTE_CHUNK_TIMEOUT_OVERHEAD_MS = 5_000;
const LARGE_FILE_REMOTE_CHUNK_TIMEOUT_SCALE_MIN_BYTES = 1 * 1024 * 1024;
const LARGE_FILE_REMOTE_CHUNK_MIN_BYTES_PER_SECOND = 128 * 1024;
const TINY_FILE_SIZE_LIMIT_BIGINT = BigInt(TINY_FILE_SIZE_LIMIT);
const ADAPTIVE_SYNC_SIMPLE_ENTRY_BUDGET = 128;

const getAdaptiveSyncPriority = (entry: { wallTime?: bigint | number }) => {
    const wallTime = Number(entry.wallTime);
    return Number.isFinite(wallTime) ? wallTime : 0;
};

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
const getChunkByteLength = (
    size: number | bigint,
    chunkCount: number,
    index: number
) => {
    const total = Number(size);
    const estimatedChunkSize = Math.ceil(total / Math.max(chunkCount, 1));
    const start = index * estimatedChunkSize;
    return Math.max(0, Math.min(estimatedChunkSize, total - start));
};
const getChunkLookupAttemptTimeout = (
    size: number | bigint,
    chunkCount: number,
    index: number,
    totalTimeout: number
) => {
    const chunkBytes = getChunkByteLength(size, chunkCount, index);
    const scaledTimeout =
        chunkBytes > LARGE_FILE_REMOTE_CHUNK_TIMEOUT_SCALE_MIN_BYTES
            ? LARGE_FILE_REMOTE_CHUNK_TIMEOUT_OVERHEAD_MS +
              Math.ceil(
                  (chunkBytes / LARGE_FILE_REMOTE_CHUNK_MIN_BYTES_PER_SECOND) *
                      1000
              )
            : LARGE_FILE_MIN_CHUNK_ATTEMPT_TIMEOUT_MS;
    return Math.min(
        totalTimeout,
        Math.max(
            LARGE_FILE_MIN_CHUNK_ATTEMPT_TIMEOUT_MS,
            Math.min(scaledTimeout, LARGE_FILE_MAX_CHUNK_ATTEMPT_TIMEOUT_MS)
        )
    );
};
const getChunkId = (parentId: string, index: number) => `${parentId}:${index}`;
const createUploadId = () => toBase64URL(randomBytes(16));
const getEntryHash = (entry: unknown) =>
    typeof (entry as { hash?: unknown })?.hash === "string"
        ? (entry as { hash: string }).hash
        : undefined;
const getEntrySignatures = (entry: unknown) => {
    const signatures = (entry as { signatures?: unknown })?.signatures;
    return Array.isArray(signatures)
        ? (signatures as {
              publicKey?: { equals?: (key: unknown) => boolean };
          }[])
        : undefined;
};
const getContextHead = (value: unknown) =>
    typeof (value as { __context?: { head?: unknown } })?.__context?.head ===
    "string"
        ? (value as { __context: { head: string } }).__context.head
        : undefined;
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
const readBlobSequentialChunks = async function* (
    blob: Blob,
    chunkSize: number
): AsyncIterable<Uint8Array> {
    if (typeof blob.stream !== "function") {
        for (
            let index = 0;
            index < getChunkCount(blob.size, chunkSize);
            index++
        ) {
            yield readBlobChunk(blob, index, chunkSize);
        }
        return;
    }

    const reader = blob.stream().getReader();
    let pending = new Uint8Array(chunkSize);
    let pendingOffset = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (!value || value.byteLength === 0) {
                continue;
            }

            let offset = 0;
            while (offset < value.byteLength) {
                const available = chunkSize - pendingOffset;
                const take = Math.min(available, value.byteLength - offset);
                pending.set(
                    value.subarray(offset, offset + take),
                    pendingOffset
                );
                pendingOffset += take;
                offset += take;

                if (pendingOffset === chunkSize) {
                    yield pending;
                    pending = new Uint8Array(chunkSize);
                    pendingOffset = 0;
                }
            }
        }

        if (pendingOffset > 0) {
            yield pending.slice(0, pendingOffset);
        }
    } finally {
        reader.releaseLock();
    }
};
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
                        query: new StringMatch({
                            key: "parentId",
                            value: this.id,
                        }),
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

        return [...chunks.values()].sort(
            (a, b) => (a.index || 0) - (b.index || 0)
        );
    }
    async delete(files: Files) {
        await Promise.all(
            (await this.fetchChunks(files)).map((x) => files.files.del(x.id))
        );
    }

    private async resolveChunk(
        files: Files,
        index: number,
        knownChunks: Map<number, TinyFile>,
        readContext: ChunkReadContext,
        properties?: {
            timeout?: number;
            debug?: Record<string, any>;
        }
    ): Promise<TinyFile> {
        const totalTimeout =
            properties?.timeout ?? LARGE_FILE_CHUNK_LOOKUP_TIMEOUT_MS;
        const deadline = Date.now() + totalTimeout;
        const attemptTimeout = getChunkLookupAttemptTimeout(
            this.size,
            this.chunkCount,
            index,
            totalTimeout
        );
        if (properties?.debug) {
            properties.debug.chunkAttemptTimeoutMs = attemptTimeout;
        }
        const chunkId = getChunkId(this.id, index);
        if (files.persistChunkReads) {
            files.retainChunkRead(chunkId);
        }
        let hintedDeliveryFailures = 0;
        let directMisses = 0;
        let retryableFailures = 0;
        let nextNonReplicatingReadAfterFailures = 3;
        const materializeLocalChunk = async (
            resolvedBy: string
        ): Promise<TinyFile | undefined> => {
            const chunk = await files.files.index.get(chunkId, {
                local: true,
                remote: false,
            });
            if (
                chunk instanceof TinyFile &&
                chunk.parentId === this.id &&
                chunk.index === index
            ) {
                knownChunks.set(index, chunk);
                files.retainResolvedChunk(chunk);
                properties?.debug &&
                    ((properties.debug.chunkResolved ||= {})[index] =
                        resolvedBy);
                return chunk;
            }
        };
        const resolveChunkByIndexedFields = async (
            remoteFrom: string[] | undefined
        ): Promise<TinyFile | undefined> => {
            properties?.debug &&
                ((properties.debug.chunkIndexedSearches ||= {})[index] =
                    ((properties.debug.chunkIndexedSearches ||= {})[index] ??
                        0) + 1);
            const chunks = await files.files.index.search(
                new SearchRequest({
                    query: [
                        new StringMatch({
                            key: "parentId",
                            value: this.id,
                            caseInsensitive: false,
                            method: StringMatchMethod.exact,
                        }),
                        new StringMatch({
                            key: "name",
                            value: `${this.name}/${index}`,
                            caseInsensitive: false,
                            method: StringMatchMethod.exact,
                        }),
                    ],
                    fetch: 1,
                }),
                {
                    local: true,
                    remote: {
                        timeout: attemptTimeout,
                        throwOnMissing: false,
                        retryMissingResponses: true,
                        replicate: files.persistChunkReads,
                        from: remoteFrom,
                    },
                } as any
            );
            const chunk = (chunks as unknown[]).find(
                (candidate): candidate is TinyFile =>
                    candidate instanceof TinyFile &&
                    candidate.parentId === this.id &&
                    candidate.index === index
            );
            if (chunk) {
                knownChunks.set(index, chunk);
                files.retainResolvedChunk(chunk);
                properties?.debug &&
                    ((properties.debug.chunkResolved ||= {})[index] =
                        "indexed-search");
                return chunk;
            }
        };
        const resolveChunkByResolvedFields = async (
            remoteFrom: string[] | undefined
        ): Promise<TinyFile | undefined> => {
            properties?.debug &&
                ((properties.debug.chunkResolvedSearches ||= {})[index] =
                    ((properties.debug.chunkResolvedSearches ||= {})[index] ??
                        0) + 1);
            const chunks = await files.files.index.search(
                new SearchRequest({
                    query: [
                        new StringMatch({
                            key: "parentId",
                            value: this.id,
                            caseInsensitive: false,
                            method: StringMatchMethod.exact,
                        }),
                        new StringMatch({
                            key: "name",
                            value: `${this.name}/${index}`,
                            caseInsensitive: false,
                            method: StringMatchMethod.exact,
                        }),
                    ],
                    fetch: 1,
                }),
                {
                    local: false,
                    remote: {
                        timeout: attemptTimeout,
                        throwOnMissing: false,
                        retryMissingResponses: true,
                        replicate: false,
                        from: remoteFrom,
                    },
                } as any
            );
            const chunk = (chunks as unknown[]).find(
                (candidate): candidate is TinyFile =>
                    candidate instanceof TinyFile &&
                    candidate.parentId === this.id &&
                    candidate.index === index
            );
            if (chunk) {
                knownChunks.set(index, chunk);
                files.retainResolvedChunk(chunk);
                properties?.debug &&
                    ((properties.debug.chunkResolved ||= {})[index] =
                        "resolved-search");
                return chunk;
            }
        };
        const resolveChunkByDirectGet = async (
            remoteFrom: string[] | undefined,
            replicate: boolean
        ): Promise<TinyFile | undefined> => {
            const chunk = await files.files.index.get(chunkId, {
                local: true,
                remote: {
                    timeout: attemptTimeout,
                    // Exact chunk reads must still ask the hinted remote when
                    // a local indexed row exists but its payload blocks are no
                    // longer materializable locally.
                    strategy: "always" as any,
                    throwOnMissing: false,
                    retryMissingResponses: true,
                    replicate,
                    from: remoteFrom,
                },
            });

            if (
                chunk instanceof TinyFile &&
                chunk.parentId === this.id &&
                chunk.index === index
            ) {
                knownChunks.set(index, chunk);
                files.retainResolvedChunk(chunk);
                properties?.debug &&
                    ((properties.debug.chunkResolved ||= {})[index] = replicate
                        ? "remote-get"
                        : "non-replicating-get");
                return chunk;
            }
        };
        const resolveChunkWithoutPersisting = async (
            remoteFrom: string[] | undefined
        ): Promise<TinyFile | undefined> => {
            properties?.debug &&
                ((properties.debug.chunkNonReplicatingGets ||= {})[index] =
                    ((properties.debug.chunkNonReplicatingGets ||= {})[index] ??
                        0) + 1);
            return resolveChunkByDirectGet(remoteFrom, false);
        };
        const resolveChunksByParentSearch = async (
            remoteFrom: string[] | undefined,
            options?: {
                replicate?: boolean;
                resolvedBy?: string;
            }
        ): Promise<TinyFile | undefined> => {
            const replicate = options?.replicate ?? files.persistChunkReads;
            if (properties?.debug) {
                const counter = replicate
                    ? (properties.debug.chunkParentSearches ||= {})
                    : (properties.debug.chunkNonReplicatingParentSearches ||=
                          {});
                counter[index] = (counter[index] ?? 0) + 1;
            }
            const chunks = await files.files.index.search(
                new SearchRequest({
                    query: new StringMatch({
                        key: "parentId",
                        value: this.id,
                    }),
                    fetch: 0xffffffff,
                }),
                {
                    local: true,
                    remote: {
                        timeout: attemptTimeout,
                        throwOnMissing: false,
                        retryMissingResponses: true,
                        replicate,
                        from: remoteFrom,
                    },
                } as any
            );
            for (const chunk of chunks) {
                if (chunk instanceof TinyFile && chunk.parentId === this.id) {
                    knownChunks.set(chunk.index || 0, chunk);
                    files.retainResolvedChunk(chunk);
                }
            }
            const chunk = knownChunks.get(index);
            if (chunk) {
                properties?.debug &&
                    ((properties.debug.chunkResolved ||= {})[index] =
                        options?.resolvedBy ?? "parent-search");
                return chunk;
            }
        };

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
            try {
                const localChunk = await materializeLocalChunk("local");
                if (localChunk) {
                    return localChunk;
                }
            } catch (error) {
                if (!isRetryableChunkLookupError(error)) {
                    properties?.debug &&
                        (properties.debug.chunkFailure = {
                            index,
                            type: "non-retryable-local-get",
                            message: getErrorMessage(error),
                        });
                    throw error;
                }
                retryableFailures += 1;
                properties?.debug &&
                    ((properties.debug.chunkRetryableErrors ||= {})[index] =
                        getErrorMessage(error));
            }
            const candidateReadPeerHints = await files.getReadPeerHints();
            if (candidateReadPeerHints) {
                readContext.lastReadPeerHints = candidateReadPeerHints;
            }
            const availableReadPeerHints =
                candidateReadPeerHints ?? readContext.lastReadPeerHints;
            const remoteFrom =
                hintedDeliveryFailures >= 3
                    ? undefined
                    : availableReadPeerHints;
            if (properties?.debug) {
                (properties.debug.chunkHints ||= {})[index] =
                    remoteFrom ?? null;
            }

            try {
                const chunk = await resolveChunkByDirectGet(
                    remoteFrom,
                    files.persistChunkReads
                );
                if (chunk instanceof TinyFile) {
                    return chunk;
                }
                properties?.debug &&
                    ((properties.debug.chunkGetMisses ||= {})[index] =
                        ((properties.debug.chunkGetMisses ||= {})[index] ?? 0) +
                        1);
                directMisses += 1;
            } catch (error) {
                if (!isRetryableChunkLookupError(error)) {
                    properties?.debug &&
                        (properties.debug.chunkFailure = {
                            index,
                            type: "non-retryable",
                            message: getErrorMessage(error),
                        });
                    throw error;
                }
                if (remoteFrom && shouldRetryChunkLookupWithoutHints(error)) {
                    hintedDeliveryFailures += 1;
                }
                retryableFailures += 1;
                properties?.debug &&
                    ((properties.debug.chunkRetryableErrors ||= {})[index] =
                        getErrorMessage(error));
            }

            try {
                const chunk = await resolveChunkByIndexedFields(remoteFrom);
                if (chunk) {
                    return chunk;
                }
            } catch (error) {
                if (!isRetryableChunkLookupError(error)) {
                    properties?.debug &&
                        (properties.debug.chunkFailure = {
                            index,
                            type: "non-retryable-indexed-search",
                            message: getErrorMessage(error),
                        });
                    throw error;
                }
                if (remoteFrom && shouldRetryChunkLookupWithoutHints(error)) {
                    hintedDeliveryFailures += 1;
                }
                retryableFailures += 1;
                properties?.debug &&
                    ((properties.debug.chunkRetryableSearchErrors ||= {})[
                        index
                    ] = getErrorMessage(error));
            }

            if (
                directMisses + retryableFailures >=
                nextNonReplicatingReadAfterFailures
            ) {
                // A miss is not evidence that a peer hint is stale. Keep using
                // the known writer/replicator hint for direct reads unless a
                // delivery error specifically tells us to try without it.
                const sourceHints =
                    remoteFrom ??
                    readContext.lastReadPeerHints ??
                    (await files.getReadPeerHints());
                const remoteSources = sourceHints
                    ? [undefined, sourceHints]
                    : [undefined];
                for (const sourceFrom of remoteSources) {
                    try {
                        const chunk =
                            await resolveChunkWithoutPersisting(sourceFrom);
                        if (chunk) {
                            return chunk;
                        }
                    } catch (error) {
                        if (!isRetryableChunkLookupError(error)) {
                            properties?.debug &&
                                (properties.debug.chunkFailure = {
                                    index,
                                    type: "non-retryable-non-replicating-get",
                                    message: getErrorMessage(error),
                                });
                            throw error;
                        }
                        if (
                            sourceFrom &&
                            shouldRetryChunkLookupWithoutHints(error)
                        ) {
                            hintedDeliveryFailures += 1;
                        }
                        retryableFailures += 1;
                        properties?.debug &&
                            ((properties.debug.chunkRetryableNonReplicatingGetErrors ||=
                                {})[index] = getErrorMessage(error));
                    }
                }
                for (const sourceFrom of remoteSources) {
                    try {
                        const chunk =
                            await resolveChunkByResolvedFields(sourceFrom);
                        if (chunk) {
                            return chunk;
                        }
                    } catch (error) {
                        if (!isRetryableChunkLookupError(error)) {
                            properties?.debug &&
                                (properties.debug.chunkFailure = {
                                    index,
                                    type: "non-retryable-resolved-search",
                                    message: getErrorMessage(error),
                                });
                            throw error;
                        }
                        if (
                            sourceFrom &&
                            shouldRetryChunkLookupWithoutHints(error)
                        ) {
                            hintedDeliveryFailures += 1;
                        }
                        retryableFailures += 1;
                        properties?.debug &&
                            ((properties.debug.chunkRetryableResolvedSearchErrors ||=
                                {})[index] = getErrorMessage(error));
                    }
                }
                for (const sourceFrom of remoteSources) {
                    try {
                        const chunk =
                            await resolveChunksByParentSearch(sourceFrom);
                        if (chunk) {
                            return chunk;
                        }
                    } catch (error) {
                        if (!isRetryableChunkLookupError(error)) {
                            properties?.debug &&
                                (properties.debug.chunkFailure = {
                                    index,
                                    type: "non-retryable-parent-search",
                                    message: getErrorMessage(error),
                                });
                            throw error;
                        }
                        if (
                            sourceFrom &&
                            shouldRetryChunkLookupWithoutHints(error)
                        ) {
                            hintedDeliveryFailures += 1;
                        }
                        retryableFailures += 1;
                        properties?.debug &&
                            ((properties.debug.chunkRetryableParentSearchErrors ||=
                                {})[index] = getErrorMessage(error));
                    }
                }
                if (files.persistChunkReads) {
                    for (const sourceFrom of remoteSources) {
                        try {
                            const chunk = await resolveChunksByParentSearch(
                                sourceFrom,
                                {
                                    replicate: false,
                                    resolvedBy: "non-replicating-parent-search",
                                }
                            );
                            if (chunk) {
                                return chunk;
                            }
                        } catch (error) {
                            if (!isRetryableChunkLookupError(error)) {
                                properties?.debug &&
                                    (properties.debug.chunkFailure = {
                                        index,
                                        type: "non-retryable-non-replicating-parent-search",
                                        message: getErrorMessage(error),
                                    });
                                throw error;
                            }
                            if (
                                sourceFrom &&
                                shouldRetryChunkLookupWithoutHints(error)
                            ) {
                                hintedDeliveryFailures += 1;
                            }
                            retryableFailures += 1;
                            properties?.debug &&
                                ((properties.debug.chunkRetryableNonReplicatingParentSearchErrors ||=
                                    {})[index] = getErrorMessage(error));
                        }
                    }
                }
                nextNonReplicatingReadAfterFailures *= 2;
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
            const request = new SearchRequest({
                query: new StringMatch({
                    key: "id",
                    value: this.id,
                    caseInsensitive: false,
                    method: StringMatchMethod.exact,
                }),
                fetch: 0xffffffff,
            });
            const pickLatest = (matches: AbstractFile[]) => {
                const largeMatches = matches.filter(isLargeFileLike);
                return (
                    largeMatches.find(
                        (match) =>
                            match.ready &&
                            Array.isArray((match as any).chunkEntryHeads) &&
                            (match as any).chunkEntryHeads.length > 0
                    ) ??
                    largeMatches.find((match) => match.ready) ??
                    largeMatches[0]
                );
            };
            const hasChunkEntryHeads = (file: LargeFile | undefined) =>
                Array.isArray((file as any)?.chunkEntryHeads) &&
                (file as any).chunkEntryHeads.some(
                    (head: unknown) => typeof head === "string"
                );
            const localMatches = await files.files.index.search(request, {
                local: true,
                remote: false,
            } as any);
            const localLatest = pickLatest(localMatches);
            const thisCandidate = toReadableLargeFile(this) ?? this;
            const localCandidate = toReadableLargeFile(localLatest);
            const readinessCandidate =
                localCandidate &&
                (localCandidate.ready ||
                    !hasChunkEntryHeads(thisCandidate) ||
                    hasChunkEntryHeads(localCandidate))
                    ? localCandidate
                    : thisCandidate;
            if (debug) {
                debug.lastReadyProbe = {
                    at: Date.now(),
                    ready: readinessCandidate.ready,
                    from: remoteFrom ?? null,
                    localChunkCount: null,
                };
            }

            const localReady = toReadableLargeFile(localLatest);
            if (localReady && localReady.ready) {
                if (debug) {
                    debug.waitUntilReadyResolvedBy = "ready-manifest";
                }
                return localReady;
            }
            let remoteMatches: AbstractFile[] = [];
            try {
                remoteMatches = await files.files.index.search(request, {
                    local: false,
                    remote: {
                        timeout: attemptTimeout,
                        throwOnMissing: false,
                        retryMissingResponses: true,
                        replicate: files.persistChunkReads,
                        from: remoteFrom,
                    },
                } as any);
            } catch (error) {
                if (debug) {
                    (debug.readyRemoteSearchErrors ||= []).push(
                        getErrorMessage(error)
                    );
                }
            }
            const remoteLatest = pickLatest(remoteMatches);
            let remoteReady = toReadableLargeFile(remoteLatest);
            if (debug?.lastReadyProbe && isLargeFileLike(remoteLatest)) {
                debug.lastReadyProbe.ready = remoteLatest.ready;
            }

            if (remoteReady && remoteReady.ready) {
                if (debug) {
                    debug.waitUntilReadyResolvedBy = "ready-manifest";
                }
                return remoteReady;
            }
            try {
                const directRemote = await files.files.index.get(this.id, {
                    local: false,
                    remote: {
                        timeout: attemptTimeout,
                        strategy: "always" as any,
                        throwOnMissing: false,
                        retryMissingResponses: true,
                        replicate: files.persistChunkReads,
                        from: remoteFrom,
                    },
                });
                let directReady = toReadableLargeFile(directRemote);
                let directReadySource = "ready-manifest-get";
                if (debug?.lastReadyProbe && isLargeFileLike(directRemote)) {
                    debug.lastReadyProbe.ready = directRemote.ready;
                }
                if (debug?.lastReadyProbe && directReady) {
                    debug.lastReadyProbe.ready = directReady.ready;
                }
                if (directReady?.ready) {
                    if (debug) {
                        debug.waitUntilReadyResolvedBy = directReadySource;
                    }
                    return directReady;
                }
                if (
                    directReady &&
                    (!remoteReady ||
                        hasChunkEntryHeads(directReady) ||
                        !hasChunkEntryHeads(remoteReady))
                ) {
                    remoteReady = directReady;
                }
            } catch (error) {
                if (debug) {
                    (debug.readyRemoteGetErrors ||= []).push(
                        getErrorMessage(error)
                    );
                }
            }
            const countCandidate =
                remoteReady &&
                (remoteReady.ready ||
                    !hasChunkEntryHeads(readinessCandidate) ||
                    hasChunkEntryHeads(remoteReady))
                    ? remoteReady
                    : readinessCandidate;
            const localChunkCount = await files
                .countLocalChunks(countCandidate)
                .catch(() => 0);
            if (debug?.lastReadyProbe) {
                debug.lastReadyProbe.localChunkCount = localChunkCount;
            }
            if (localChunkCount >= countCandidate.chunkCount) {
                if (debug) {
                    debug.waitUntilReadyResolvedBy = "complete-chunks";
                }
                return countCandidate;
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
            waitUntilReadyResolvedBy: null as string | null,
            prefetchedChunkCount: 0,
            readAhead: 0,
            initialReadPeerHints: null as string[] | null,
            chunkAttemptTimeoutMs: 0,
            finishedAt: null as number | null,
            chunkAttempts: {} as Record<number, number>,
            chunkHints: {} as Record<number, string[] | null>,
            chunkResolved: {} as Record<number, string>,
            chunkResolveStartedAt: {} as Record<number, number>,
            chunkResolveFinishedAt: {} as Record<number, number>,
            chunkMaterializeStartedAt: {} as Record<number, number>,
            chunkMaterializeFinishedAt: {} as Record<number, number>,
            chunkHashStartedAt: {} as Record<number, number>,
            chunkHashFinishedAt: {} as Record<number, number>,
            chunkWriteStartedAt: {} as Record<number, number>,
            chunkWriteFinishedAt: {} as Record<number, number>,
            chunkFailure: null as {
                index: number;
                type: string;
                message: string;
            } | null,
        };
        files.lastReadDiagnostics = debug;
        if (files.persistChunkReads) {
            files.retainFileRead(this);
        }
        const resolvedFile = await this.waitUntilReady(files, properties);
        debug.waitUntilReadyResolvedAt = Date.now();
        debug.waitUntilReadyResolvedReady = resolvedFile.ready;
        if (files.persistChunkReads) {
            files.retainFileRead(resolvedFile);
        }

        properties?.progress?.(0);

        let processed = 0;
        const hasher = resolvedFile.finalHash ? new SHA256() : undefined;
        const knownChunks = new Map<number, TinyFile>();
        const readContext: ChunkReadContext = {};
        if (files.persistChunkReads) {
            const initialReadPeerHints = await files.getReadPeerHints();
            if (initialReadPeerHints) {
                readContext.lastReadPeerHints = initialReadPeerHints;
                debug.initialReadPeerHints = initialReadPeerHints;
            }
        }
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
            const pending = (async () => {
                debug.chunkResolveStartedAt[index] = Date.now();
                try {
                    return await resolvedFile.resolveChunk(
                        files,
                        index,
                        knownChunks,
                        readContext,
                        {
                            timeout: properties?.timeout,
                            debug,
                        }
                    );
                } finally {
                    debug.chunkResolveFinishedAt[index] = Date.now();
                }
            })();
            inFlightChunks.set(index, pending);
            return pending;
        };

        const configuredReadAhead = files.persistChunkReads
            ? LARGE_FILE_PERSISTED_READ_AHEAD
            : LARGE_FILE_OBSERVER_READ_AHEAD;
        const readAhead = Math.min(resolvedFile.chunkCount, configuredReadAhead);
        debug.readAhead = readAhead;

        for (
            let index = 0;
            index < Math.min(resolvedFile.chunkCount, readAhead);
            index++
        ) {
            void resolveChunkWithReadAhead(index).catch(() => undefined);
        }

        for (let index = 0; index < resolvedFile.chunkCount; index++) {
            const chunkFile = await resolveChunkWithReadAhead(index);
            inFlightChunks.delete(index);
            const nextIndex = index + readAhead;
            if (nextIndex < resolvedFile.chunkCount) {
                void resolveChunkWithReadAhead(nextIndex).catch(
                    () => undefined
                );
            }
            if (!chunkFile) {
                throw new Error(
                    `Failed to resolve chunk ${index + 1}/${resolvedFile.chunkCount} for file ${resolvedFile.id}`
                );
            }
            debug.chunkMaterializeStartedAt[index] = Date.now();
            const chunk = await chunkFile.getFile(files, {
                as: "joined",
                timeout: properties?.timeout,
            });
            debug.chunkMaterializeFinishedAt[index] = Date.now();
            debug.chunkHashStartedAt[index] = Date.now();
            hasher?.update(chunk);
            debug.chunkHashFinishedAt[index] = Date.now();
            processed += chunk.byteLength;
            properties?.progress?.(
                processed / Math.max(Number(resolvedFile.size), 1)
            );
            yield chunk;
        }

        if (hasher && toBase64(hasher.digest()) !== resolvedFile.finalHash) {
            throw new Error("File hash does not match the expected content");
        }
        debug.finishedAt = Date.now();
    }
}

@variant(2)
export class LargeFileWithChunkHeads extends AbstractFile {
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

    @field({ type: vec("string") })
    chunkEntryHeads: string[];

    constructor(properties: {
        id?: string;
        name: string;
        size: bigint;
        chunkCount: number;
        ready?: boolean;
        finalHash?: string;
        chunkEntryHeads?: string[];
    }) {
        super();
        this.id = properties.id || createUploadId();
        this.name = properties.name;
        this.size = properties.size;
        this.chunkCount = properties.chunkCount;
        this.ready = properties.ready ?? false;
        this.finalHash = properties.finalHash;
        this.chunkEntryHeads = properties.chunkEntryHeads ?? [];
    }

    get parentId() {
        return undefined;
    }

    streamFile(files: Files, properties?: FileReadOptions) {
        return LargeFile.prototype.streamFile.call(
            this as unknown as LargeFile,
            files,
            properties
        );
    }

    delete(files: Files) {
        return LargeFile.prototype.delete.call(
            this as unknown as LargeFile,
            files
        );
    }
}
Object.setPrototypeOf(LargeFileWithChunkHeads.prototype, LargeFile.prototype);

const isLargeFileLike = (value: unknown): value is LargeFile => {
    const file = value as Partial<LargeFile> & {
        parentId?: unknown;
    };
    return (
        value instanceof LargeFile ||
        (value != null &&
            typeof value === "object" &&
            file.parentId == null &&
            typeof file.id === "string" &&
            typeof file.name === "string" &&
            typeof file.size === "bigint" &&
            typeof file.chunkCount === "number" &&
            typeof file.ready === "boolean")
    );
};

const toReadableLargeFile = (value: unknown): LargeFile | undefined => {
    if (!isLargeFileLike(value)) {
        return;
    }
    if (typeof (value as any).resolveChunk === "function") {
        return value as LargeFile;
    }
    if (Array.isArray((value as any).chunkEntryHeads)) {
        return new LargeFileWithChunkHeads({
            id: value.id,
            name: value.name,
            size: value.size,
            chunkCount: value.chunkCount,
            ready: value.ready,
            finalHash: value.finalHash,
            chunkEntryHeads: (value as any).chunkEntryHeads,
        }) as unknown as LargeFile;
    }
    return new LargeFile({
        id: value.id,
        name: value.name,
        size: value.size,
        chunkCount: value.chunkCount,
        ready: value.ready,
        finalHash: value.finalHash,
    });
};

const preferListCandidate = (
    candidate: AbstractFile,
    existing: AbstractFile
) => {
    if (isLargeFileLike(candidate) && isLargeFileLike(existing)) {
        if (candidate.ready !== existing.ready) {
            return candidate.ready;
        }
        if (candidate.finalHash && !existing.finalHash) {
            return true;
        }
        return candidate.chunkCount > existing.chunkCount;
    }
    return false;
};

const deduplicateListedRoots = (files: AbstractFile[]) => {
    const byId = new Map<string, AbstractFile>();
    for (const file of files) {
        const existing = byId.get(file.id);
        if (!existing || preferListCandidate(file, existing)) {
            byId.set(file.id, file);
        }
    }
    return [...byId.values()];
};

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
    private retainedChunkIds = new Set<string>();
    private retainedChunkEntryHeads = new Set<string>();

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

    retainChunkRead(chunkId: string) {
        this.retainedChunkIds ??= new Set();
        this.retainedChunkIds.add(chunkId);
    }

    retainChunkEntryHead(entryHash: string) {
        this.retainedChunkEntryHeads ??= new Set();
        this.retainedChunkEntryHeads.add(entryHash);
    }

    retainResolvedChunk(value: unknown) {
        const head = getContextHead(value);
        if (head) {
            this.retainChunkEntryHead(head);
        }
    }

    retainFileRead(file: AbstractFile) {
        if (file instanceof TinyFile && file.parentId != null) {
            this.retainChunkRead(file.id);
            return;
        }
        if (isLargeFileLike(file)) {
            for (let index = 0; index < file.chunkCount; index++) {
                this.retainChunkRead(getChunkId(file.id, index));
            }
        }
    }

    private retainAuthoredChunk(chunk: TinyFile, entryHash?: string) {
        if (chunk.parentId != null) {
            this.retainChunkRead(chunk.id);
        }
        if (entryHash) {
            this.retainChunkEntryHead(entryHash);
        }
    }

    private async shouldKeepFileEntry(entryLike: unknown) {
        this.retainedChunkIds ??= new Set();
        this.retainedChunkEntryHeads ??= new Set();
        const hash = getEntryHash(entryLike);
        if (hash && this.retainedChunkEntryHeads.has(hash)) {
            return true;
        }

        const isSignedBySelf = (
            signatures:
                | { publicKey?: { equals?: (key: unknown) => boolean } }[]
                | undefined
        ) =>
            signatures?.some((signature) =>
                signature.publicKey?.equals?.(this.node.identity.publicKey)
            ) === true;

        if (isSignedBySelf(getEntrySignatures(entryLike))) {
            if (hash) {
                this.retainedChunkEntryHeads.add(hash);
            }
            return true;
        }

        let entry:
            | {
                  hash: string;
                  signatures?: {
                      publicKey?: { equals?: (key: unknown) => boolean };
                  }[];
                  getPayloadValue: () => Promise<Operation>;
              }
            | undefined;
        try {
            entry =
                typeof (entryLike as { getPayloadValue?: unknown })
                    ?.getPayloadValue === "function"
                    ? (entryLike as typeof entry)
                    : hash
                      ? ((await this.files.log.log.get(hash)) as typeof entry)
                      : undefined;
        } catch {
            return false;
        }

        if (isSignedBySelf(getEntrySignatures(entry))) {
            const entryHash = hash ?? getEntryHash(entry);
            if (entryHash) {
                this.retainedChunkEntryHeads.add(entryHash);
            }
            return true;
        }

        if (!entry) {
            return false;
        }

        if (!this.persistChunkReads) {
            return false;
        }

        try {
            const operation = await entry.getPayloadValue();
            if (!isPutOperation(operation)) {
                return false;
            }
            const file = this.files.index.valueEncoding.decoder(operation.data);
            if (
                (file instanceof TinyFile || isLargeFileLike(file)) &&
                file.parentId == null
            ) {
                this.retainedChunkEntryHeads.add(entry.hash);
                return true;
            }
            if (
                file instanceof TinyFile &&
                file.parentId != null &&
                this.retainedChunkIds.has(file.id)
            ) {
                this.retainedChunkEntryHeads.add(entry.hash);
                return true;
            }
        } catch {
            return false;
        }

        return false;
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

        return this.addSource(
            name,
            {
                size: BigInt(file.size),
                readChunks: (chunkSize) =>
                    readBlobSequentialChunks(file, chunkSize),
            },
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
        const expectedChunkCount = getChunkCount(size, chunkSize);
        const diagnostics: UploadDiagnostics = {
            uploadId,
            fileName: name,
            sizeBytes: Number(size),
            chunkSize,
            chunkCount: expectedChunkCount,
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
            chunkCount: expectedChunkCount,
            ready: false,
        });

        diagnostics.manifestStartedAt = Date.now();
        const pendingManifest = await this.files.put(manifest);
        diagnostics.manifestFinishedAt = Date.now();
        const hasher = new SHA256();
        try {
            let uploadedBytes = 0n;
            let chunkCount = 0;
            const chunkEntryHeads: string[] = [];
            for await (const chunkBytes of source.readChunks(chunkSize)) {
                hasher.update(chunkBytes);
                const putStartedAt = Date.now();
                diagnostics.firstChunkStartedAt ??= putStartedAt;
                const chunk = new TinyFile({
                    name: name + "/" + chunkCount,
                    file: chunkBytes,
                    parentId: uploadId,
                    index: chunkCount,
                });
                this.retainAuthoredChunk(chunk);
                const appended = await this.files.put(chunk);
                this.retainAuthoredChunk(chunk, appended.entry.hash);
                chunkEntryHeads[chunkCount] = appended.entry.hash;
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
                    diagnostics.slowestChunkIndex = chunkCount;
                }
                uploadedBytes += BigInt(chunkBytes.byteLength);
                chunkCount++;
                progress?.(Number(uploadedBytes) / Math.max(Number(size), 1));
            }
            ensureSourceSize(uploadedBytes, source.size);
            diagnostics.readyManifestStartedAt = Date.now();
            const readyManifest = new LargeFileWithChunkHeads({
                id: uploadId,
                name,
                size,
                chunkCount,
                ready: true,
                finalHash: toBase64(hasher.digest()),
                chunkEntryHeads,
            });
            await this.files.put(
                readyManifest,
                { meta: { next: [pendingManifest.entry] } }
            );
            diagnostics.readyManifestFinishedAt = Date.now();
            diagnostics.chunkCount = chunkCount;
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
        const pendingManifest = await this.files.put(manifest);
        diagnostics.manifestFinishedAt = Date.now();
        const hasher = new SHA256();
        try {
            let uploadedBytes = 0;
            const chunkEntryHeads: string[] = [];
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
                const chunk = new TinyFile({
                    name: name + "/" + i,
                    file: chunkBytes,
                    parentId: uploadId,
                    index: i,
                });
                this.retainAuthoredChunk(chunk);
                const appended = await this.files.put(chunk);
                this.retainAuthoredChunk(chunk, appended.entry.hash);
                chunkEntryHeads[i] = appended.entry.hash;
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
            const readyManifest = new LargeFileWithChunkHeads({
                id: uploadId,
                name,
                size,
                chunkCount,
                ready: true,
                finalHash: toBase64(hasher.digest()),
                chunkEntryHeads,
            });
            await this.files.put(
                readyManifest,
                { meta: { next: [pendingManifest.entry] } }
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
                    replicate: this.persistChunkReads,
                    from: remoteFrom,
                },
            } as any
        );
        const rootFiles = deduplicateListedRoots(files);
        const resolvedRoots = await Promise.all(
            rootFiles.map(async (file) => {
                if (!isLargeFileLike(file) || file.ready) {
                    return file;
                }
                try {
                    const matches = await this.files.index.search(
                        new SearchRequest({
                            query: new StringMatch({
                                key: "id",
                                value: file.id,
                                caseInsensitive: false,
                                method: StringMatchMethod.exact,
                            }),
                            fetch: 0xffffffff,
                        }),
                        {
                            local: true,
                            remote: {
                                timeout: 5_000,
                                throwOnMissing: false,
                                retryMissingResponses: true,
                                replicate: this.persistChunkReads,
                                from: remoteFrom,
                            },
                        } as any
                    );
                    const resolved = deduplicateListedRoots(
                        matches.filter((match) => !match.parentId)
                    ).find((match) => match.id === file.id);
                    return resolved && preferListCandidate(resolved, file)
                        ? resolved
                        : file;
                } catch {
                    return file;
                }
            })
        );
        return deduplicateListedRoots(resolvedRoots);
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
            wait?: boolean;
        }
    ): Promise<AbstractFile | undefined> {
        return this.files.index.get(id, {
            local: true,
            waitFor: properties?.timeout,
            remote: {
                timeout: properties?.timeout ?? 10 * 1000,
                wait:
                    properties?.timeout && properties.wait !== false
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
        const replicators = await this.files.log
            .getReplicators()
            .catch(() => undefined);
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
            sync: {
                priority: getAdaptiveSyncPriority,
                maxSimpleEntries: ADAPTIVE_SYNC_SIMPLE_ENTRY_BUDGET,
            },
            keep: (entry) => this.shouldKeepFileEntry(entry),
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
        openDiagnostics.runtimeProfileSamples =
            getRuntimeOpenProfilerState().samples.slice(
                runtimeProfileStartIndex
            );
    }
}
