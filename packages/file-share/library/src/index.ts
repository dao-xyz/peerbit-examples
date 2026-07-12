import { field, option, variant, vec } from "@dao-xyz/borsh";
import { Program, ProgramHandler } from "@peerbit/program";
import {
    Documents,
    SearchRequest,
    StringMatch,
    StringMatchMethod,
    Or,
    IsNull,
    isPutOperation,
    isDeleteOperation,
    type DocumentsChange,
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
import {
    adaptRemotePersistedReadAhead,
    getRemotePersistedReadAheadLimit,
    REMOTE_PERSISTED_READ_AHEAD_MIN,
} from "./read-scheduling.js";

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

const getErrorCode = (error: unknown) =>
    typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code
        : undefined;

const getContainedErrors = (error: unknown): unknown[] => {
    const errors = (error as { errors?: unknown })?.errors;
    if (Array.isArray(errors)) {
        return errors;
    }
    if (
        errors != null &&
        typeof errors !== "string" &&
        typeof (errors as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
            "function"
    ) {
        try {
            return Array.from(errors as Iterable<unknown>);
        } catch {
            return [];
        }
    }
    return [];
};

const isRetryableChunkLookupError = (
    error: unknown,
    seen = new Set<unknown>()
): boolean => {
    if (seen.has(error)) {
        return false;
    }
    seen.add(error);
    const name = getErrorName(error);
    const message = getErrorMessage(error);
    const code = getErrorCode(error);
    const containedErrors = getContainedErrors(error);
    if (
        name === "AbortError" ||
        name === "DeliveryError" ||
        name === "TimeoutError" ||
        name === "NotFoundError" ||
        name === "StreamStateError" ||
        code === "ERR_NOT_FOUND" ||
        (containedErrors.length === 0 &&
            name === "AggregateError" &&
            message.includes("All promises were rejected")) ||
        message.includes("fanout channel closed") ||
        message.includes("Failed to resolve block") ||
        message.includes("Failed to load entry from head") ||
        message.includes("Message did not have any valid receivers") ||
        message.includes("delivery acknowledges from all nodes")
    ) {
        return true;
    }

    return (
        containedErrors.length > 0 &&
        containedErrors.every((contained) =>
            isRetryableChunkLookupError(contained, new Set(seen))
        )
    );
};

const shouldRetryChunkLookupWithoutHints = (
    error: unknown,
    seen = new Set<unknown>()
): boolean => {
    if (seen.has(error)) {
        return false;
    }
    seen.add(error);
    const name = getErrorName(error);
    const message = getErrorMessage(error);
    if (
        name === "DeliveryError" ||
        message.includes("delivery acknowledges from all nodes") ||
        message.includes("Message did not have any valid receivers")
    ) {
        return true;
    }
    return getContainedErrors(error).some((contained) =>
        shouldRetryChunkLookupWithoutHints(contained, new Set(seen))
    );
};

type FileReadOptions = {
    timeout?: number;
    progress?: (progress: number) => any;
};

type FileReadDiagnostics = Record<string, any>;

type FileReadDiagnosticsContext = {
    diagnostics?: FileReadDiagnostics;
};

const FILE_READ_DIAGNOSTICS_CONTEXT = Symbol("file-read-diagnostics-context");

type InternalFileReadOptions = FileReadOptions & {
    [FILE_READ_DIAGNOSTICS_CONTEXT]?: FileReadDiagnosticsContext;
};

type EffectiveFileReadOptions = FileReadOptions & {
    persist: boolean;
};

type ChunkReadContext = {
    lastReadPeerHints?: string[];
    localChunkEntryHeads?: Map<string, string>;
    localChunkEntryHeadsScan?: Promise<Map<string, string>>;
    fileChangeSignals?: Set<FileChangeSignal>;
};

export interface ReReadableChunkSource {
    size: bigint;
    /**
     * Yield Uint8Array data in any convenient geometry. Empty yields are
     * ignored; large-file uploads coalesce and split all other yields into the
     * requested chunk size while preserving byte order.
     */
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
        const internalProperties = properties as
            | InternalFileReadOptions
            | undefined;
        const diagnosticsContext =
            internalProperties?.[FILE_READ_DIAGNOSTICS_CONTEXT] ?? {};
        const streamProperties: InternalFileReadOptions = {
            ...properties,
            [FILE_READ_DIAGNOSTICS_CONTEXT]: diagnosticsContext,
        };
        let chunkIndex = 0;
        try {
            for await (const chunk of this.streamFile(
                files,
                streamProperties
            )) {
                const debug = diagnosticsContext.diagnostics;
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

type FileChangePredicate = (file: AbstractFile) => boolean;

class FileReadCancelledError extends Error {
    constructor() {
        super("File read cancelled");
        this.name = "FileReadCancelledError";
    }
}

/**
 * A race-free, one-shot-friendly view of relevant Documents changes.
 *
 * The listener is installed before a lookup attempt starts. Callers snapshot
 * the version before querying and then wait only if no matching change arrived
 * in the meantime. The timeout remains necessary for observer reads because a
 * non-replicating remote result does not produce a local Documents event.
 */
class FileChangeSignal {
    private version = 0;
    private closed = false;
    private abortController = new AbortController();
    private waiters = new Set<(changed: boolean) => void>();
    private readonly listener = (
        event: CustomEvent<DocumentsChange<AbstractFile, IndexableFile>>
    ) => {
        if (
            ![...event.detail.added, ...event.detail.removed].some(
                this.predicate
            )
        ) {
            return;
        }

        this.version += 1;
        for (const finish of [...this.waiters]) {
            finish(true);
        }
    };

    constructor(
        private readonly events: Documents<
            AbstractFile,
            IndexableFile
        >["events"],
        private readonly predicate: FileChangePredicate,
        private readonly onClose?: () => void
    ) {
        this.events.addEventListener("change", this.listener);
    }

    snapshot() {
        return this.version;
    }

    get isClosed() {
        return this.closed;
    }

    get abortSignal() {
        return this.abortController.signal;
    }

    throwIfClosed() {
        if (this.closed) {
            throw new FileReadCancelledError();
        }
    }

    waitForChangeAfter(version: number, timeoutMs: number): Promise<boolean> {
        if (this.closed || this.version !== version) {
            return Promise.resolve(!this.closed);
        }
        if (timeoutMs <= 0) {
            return Promise.resolve(false);
        }

        return new Promise<boolean>((resolve) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let settled = false;
            const finish = (changed: boolean) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timer) {
                    clearTimeout(timer);
                }
                this.waiters.delete(finish);
                resolve(changed);
            };

            this.waiters.add(finish);
            timer = setTimeout(() => finish(false), timeoutMs);

            // Keep this check even though JavaScript runs synchronously here:
            // alternate EventTarget implementations may dispatch re-entrantly
            // while a listener is being registered.
            if (this.closed) {
                finish(false);
            } else if (this.version !== version) {
                finish(true);
            }
        });
    }

    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.abortController.abort(new FileReadCancelledError());
        this.events.removeEventListener("change", this.listener);
        for (const finish of [...this.waiters]) {
            finish(false);
        }
        this.onClose?.();
    }
}

const TINY_FILE_SIZE_LIMIT = 5 * 1e6; // 6mb
const LARGE_FILE_SEGMENT_SIZE = TINY_FILE_SIZE_LIMIT / 10;
const LARGE_FILE_TARGET_CHUNK_COUNT = 256;
const CHUNK_SIZE_GRANULARITY = 64 * 1024;
const MAX_LARGE_FILE_SEGMENT_SIZE = 512 * 1024;
const LARGE_FILE_CHUNK_LOOKUP_TIMEOUT_MS = 5 * 60 * 1000;
const LARGE_FILE_CHUNK_BATCH_SPECULATIVE_TIMEOUT_MS = 1_500;
const LARGE_FILE_PERSISTED_READ_AHEAD = 32;
const LARGE_FILE_OBSERVER_READ_AHEAD = 2;
const LARGE_FILE_CHANGE_WAIT_FALLBACK_MS = 250;
const LARGE_FILE_CHUNK_PUT_CONCURRENCY = 4;
const LARGE_FILE_CHUNK_PUT_BYTE_LIMIT = 2 * 1024 * 1024;
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

type InFlightWork = {
    bytes: number;
    promise: Promise<void>;
};

class BoundedAsyncWorkQueue {
    private inFlight = new Set<InFlightWork>();
    private inFlightBytes = 0;
    private failed = false;
    private failure: unknown;
    private rejectFailureSignal!: (error: unknown) => void;
    readonly failureSignal: Promise<never>;
    peakCount = 0;
    peakBytes = 0;

    constructor(
        readonly countLimit: number,
        readonly byteLimit: number
    ) {
        this.failureSignal = new Promise<never>((_resolve, reject) => {
            this.rejectFailureSignal = reject;
        });
        void this.failureSignal.catch(() => undefined);
    }

    private hasCapacity(bytes: number) {
        return (
            this.inFlight.size < this.countLimit &&
            (this.inFlightBytes === 0 ||
                this.inFlightBytes + bytes <= this.byteLimit)
        );
    }

    throwIfFailed() {
        if (this.failed) {
            throw this.failure;
        }
    }

    private async waitForCapacity(bytes: number) {
        while (!this.hasCapacity(bytes)) {
            this.throwIfFailed();
            await Promise.race(
                [...this.inFlight].map((work) =>
                    work.promise.catch(() => undefined)
                )
            );
        }
        this.throwIfFailed();
    }

    async enqueue(bytes: number, task: () => Promise<void>) {
        await this.waitForCapacity(bytes);
        const work = {
            bytes,
            promise: Promise.resolve(),
        } as InFlightWork;
        this.inFlight.add(work);
        this.inFlightBytes += bytes;
        this.peakCount = Math.max(this.peakCount, this.inFlight.size);
        this.peakBytes = Math.max(this.peakBytes, this.inFlightBytes);

        let taskPromise: Promise<void>;
        try {
            // Invoke synchronously after reserving capacity so callers can copy
            // reusable source buffers inside the reservation.
            taskPromise = Promise.resolve(task());
        } catch (error) {
            taskPromise = Promise.reject(error);
        }
        work.promise = taskPromise
            .catch((error) => {
                if (!this.failed) {
                    this.failed = true;
                    this.failure = error;
                    this.rejectFailureSignal(error);
                }
                throw error;
            })
            .finally(() => {
                this.inFlight.delete(work);
                this.inFlightBytes -= bytes;
            });
        // Callers intentionally do not await individual tasks. Attach a
        // handler now while preserving the stored rejection for drain().
        void work.promise.catch(() => undefined);
    }

    async settle() {
        while (this.inFlight.size > 0) {
            await Promise.allSettled(
                [...this.inFlight].map((work) => work.promise)
            );
        }
    }

    async drain() {
        await this.settle();
        this.throwIfFailed();
    }
}

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
const getRemotePayloadAttemptTimeout = (
    payloadBytes: number,
    totalTimeout: number
) => {
    const scaledTimeout =
        payloadBytes > LARGE_FILE_REMOTE_CHUNK_TIMEOUT_SCALE_MIN_BYTES
            ? LARGE_FILE_REMOTE_CHUNK_TIMEOUT_OVERHEAD_MS +
              Math.ceil(
                  (payloadBytes /
                      LARGE_FILE_REMOTE_CHUNK_MIN_BYTES_PER_SECOND) *
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
const getChunkLookupAttemptTimeout = (
    size: number | bigint,
    chunkCount: number,
    index: number,
    totalTimeout: number
) =>
    getRemotePayloadAttemptTimeout(
        getChunkByteLength(size, chunkCount, index),
        totalTimeout
    );
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

    async delete(): Promise<void> {}
}

const isLargeFileChunk = (
    value: unknown
): value is TinyFile & { parentId: string; index: number } =>
    value instanceof TinyFile && value.parentId != null && value.index != null;

const getRetentionOwnerId = (file: AbstractFile) =>
    isLargeFileChunk(file) ? file.parentId : file.id;

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
        const changeSignal = files.createFileChangeSignal(
            (file) =>
                file instanceof TinyFile &&
                file.parentId === this.id &&
                file.index != null
        );

        try {
            while (
                !changeSignal.isClosed &&
                chunks.size < this.chunkCount &&
                Date.now() < deadline
            ) {
                const changeVersion = changeSignal.snapshot();
                const before = chunks.size;
                const remoteFrom = await files.getReadPeerHints();
                changeSignal.throwIfClosed();
                const results = await files.files.index.search(
                    new SearchRequest({
                        query: new StringMatch({
                            key: "parentId",
                            value: this.id,
                        }),
                        fetch: 0xffffffff,
                    }),
                    {
                        local: true,
                        signal: changeSignal.abortSignal,
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
                );
                changeSignal.throwIfClosed();
                recordChunks(results);

                if (chunks.size === before && chunks.size < this.chunkCount) {
                    await changeSignal.waitForChangeAfter(
                        changeVersion,
                        Math.min(
                            LARGE_FILE_CHANGE_WAIT_FALLBACK_MS,
                            Math.max(0, deadline - Date.now())
                        )
                    );
                    changeSignal.throwIfClosed();
                }
            }

            changeSignal.throwIfClosed();
            return [...chunks.values()].sort(
                (a, b) => (a.index || 0) - (b.index || 0)
            );
        } finally {
            changeSignal.close();
        }
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
        changeSignal: FileChangeSignal,
        properties: {
            timeout?: number;
            debug?: Record<string, any>;
            persist: boolean;
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
        if (properties.persist) {
            files.retainChunkRead(chunkId, this.id);
        }
        let hintedDeliveryFailures = 0;
        let directMisses = 0;
        let retryableFailures = 0;
        let nextNonReplicatingReadAfterFailures = 3;
        let skipManifestHeadForChunk = false;
        let triedUnhintedPersistedFields = false;
        const materializeLocalChunk = async (
            resolvedBy: string
        ): Promise<TinyFile | undefined> => {
            const chunk = await files.files.index.get(chunkId, {
                local: true,
                remote: false,
                signal: changeSignal.abortSignal,
            });
            changeSignal.throwIfClosed();
            if (
                chunk instanceof TinyFile &&
                chunk.parentId === this.id &&
                chunk.index === index
            ) {
                knownChunks.set(index, chunk);
                if (properties.persist) {
                    files.retainResolvedChunk(chunk, properties.persist);
                }
                properties?.debug &&
                    ((properties.debug.chunkResolved ||= {})[index] =
                        resolvedBy);
                return chunk;
            }
        };
        const resolveChunkByIndexedFields = async (
            remoteFrom: string[] | undefined,
            timeout: number
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
                    signal: changeSignal.abortSignal,
                    remote: {
                        timeout,
                        // Legacy chunk ids are resolved by parent/name. Once a
                        // persisted local row materializes, do not keep waiting
                        // on an unavailable writer during offline rereads.
                        strategy: "fallback" as any,
                        throwOnMissing: false,
                        retryMissingResponses: false,
                        replicate: properties.persist,
                        from: remoteFrom,
                    },
                } as any
            );
            changeSignal.throwIfClosed();
            const chunk = (chunks as unknown[]).find(
                (candidate): candidate is TinyFile =>
                    candidate instanceof TinyFile &&
                    candidate.parentId === this.id &&
                    candidate.index === index
            );
            if (chunk) {
                knownChunks.set(index, chunk);
                if (properties.persist) {
                    files.retainResolvedChunk(chunk, properties.persist);
                }
                properties?.debug &&
                    ((properties.debug.chunkResolved ||= {})[index] =
                        "indexed-search");
                return chunk;
            }
        };
        const resolveChunkByResolvedFields = async (
            remoteFrom: string[] | undefined,
            timeout: number
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
                    signal: changeSignal.abortSignal,
                    remote: {
                        timeout,
                        throwOnMissing: false,
                        retryMissingResponses: false,
                        replicate: false,
                        from: remoteFrom,
                    },
                } as any
            );
            changeSignal.throwIfClosed();
            const chunk = (chunks as unknown[]).find(
                (candidate): candidate is TinyFile =>
                    candidate instanceof TinyFile &&
                    candidate.parentId === this.id &&
                    candidate.index === index
            );
            if (chunk) {
                knownChunks.set(index, chunk);
                if (properties.persist) {
                    files.retainResolvedChunk(chunk, properties.persist);
                }
                properties?.debug &&
                    ((properties.debug.chunkResolved ||= {})[index] =
                        "resolved-search");
                return chunk;
            }
        };
        const resolveChunkByDirectGet = async (
            remoteFrom: string[] | undefined,
            replicate: boolean,
            timeout: number
        ): Promise<TinyFile | undefined> => {
            const chunk = await files.files.index.get(chunkId, {
                local: true,
                signal: changeSignal.abortSignal,
                remote: {
                    timeout,
                    // Exact chunk reads must still ask the hinted remote when
                    // a local indexed row exists but its payload blocks are no
                    // longer materializable locally.
                    strategy: "always" as any,
                    throwOnMissing: false,
                    retryMissingResponses: false,
                    replicate,
                    from: remoteFrom,
                },
            });
            changeSignal.throwIfClosed();

            if (
                chunk instanceof TinyFile &&
                chunk.parentId === this.id &&
                chunk.index === index
            ) {
                knownChunks.set(index, chunk);
                if (properties.persist) {
                    files.retainResolvedChunk(chunk, properties.persist);
                }
                properties?.debug &&
                    ((properties.debug.chunkResolved ||= {})[index] = replicate
                        ? "remote-get"
                        : "non-replicating-get");
                return chunk;
            }
        };
        const resolveChunkByManifestEntryHead = async (
            remoteFrom: string[] | undefined,
            timeout: number
        ): Promise<TinyFile | undefined> => {
            if (skipManifestHeadForChunk) {
                return;
            }
            const heads = (this as { chunkEntryHeads?: unknown })
                .chunkEntryHeads;
            const head = Array.isArray(heads) ? heads[index] : undefined;
            if (typeof head !== "string") {
                return;
            }
            properties?.debug &&
                ((properties.debug.chunkManifestHeads ||= {})[index] = head);

            const entry = await files.files.log.log.get(head, {
                remote: {
                    timeout,
                    throwOnMissing: false,
                    retryMissingResponses: false,
                    replicate: properties.persist,
                    from: remoteFrom,
                    signal: changeSignal.abortSignal,
                } as any,
            });
            changeSignal.throwIfClosed();
            if (!entry) {
                properties?.debug &&
                    ((properties.debug.chunkManifestHeadMisses ||= {})[index] =
                        ((properties.debug.chunkManifestHeadMisses ||= {})[
                            index
                        ] ?? 0) + 1);
                return;
            }

            const operation = await entry.getPayloadValue();
            changeSignal.throwIfClosed();
            if (!isPutOperation(operation)) {
                return;
            }
            const chunk = files.files.index.valueEncoding.decoder(
                operation.data
            );
            if (
                chunk instanceof TinyFile &&
                chunk.parentId === this.id &&
                chunk.index === index
            ) {
                if (properties.persist) {
                    files.retainChunkEntryHead(head, this.id, chunk.id);
                }
                knownChunks.set(index, chunk);
                if (properties.persist) {
                    files.retainResolvedChunk(chunk, properties.persist);
                }
                properties?.debug &&
                    ((properties.debug.chunkResolved ||= {})[index] =
                        "manifest-head-get");
                return chunk;
            }
        };
        const resolveChunkWithoutPersisting = async (
            remoteFrom: string[] | undefined,
            timeout: number
        ): Promise<TinyFile | undefined> => {
            properties?.debug &&
                ((properties.debug.chunkNonReplicatingGets ||= {})[index] =
                    ((properties.debug.chunkNonReplicatingGets ||= {})[index] ??
                        0) + 1);
            return resolveChunkByDirectGet(remoteFrom, false, timeout);
        };

        type LookupStrategy =
            | "manifest-head"
            | "deterministic-id"
            | "indexed-fields"
            | "unhinted-indexed-fields";
        // Every remote primitive can consume its full timeout. Keep one shared
        // deadline per lookup round so fallbacks cannot multiply a transient
        // five-second stall into 20-30 seconds. The cursor resumes at the next
        // strategy after a budget-consuming call, preserving legacy/indexed
        // recovery without letting one slow route monopolize every retry.
        const lookupStrategies: LookupStrategy[] = [
            "manifest-head",
            "deterministic-id",
            "indexed-fields",
            "unhinted-indexed-fields",
        ];
        let nextLookupStrategyIndex = 0;
        const getRemainingRoundTimeout = (roundDeadline: number) => {
            const remaining = Math.min(deadline, roundDeadline) - Date.now();
            return remaining > 0 ? Math.max(1, Math.floor(remaining)) : 0;
        };

        while (!changeSignal.isClosed && Date.now() < deadline) {
            const changeVersion = changeSignal.snapshot();
            const roundDeadline = Math.min(
                deadline,
                Date.now() + attemptTimeout
            );
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
                changeSignal.throwIfClosed();
                skipManifestHeadForChunk = true;
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
            changeSignal.throwIfClosed();
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

            for (
                let attemptedStrategies = 0;
                attemptedStrategies < lookupStrategies.length;
                attemptedStrategies++
            ) {
                const remainingRoundTimeout =
                    getRemainingRoundTimeout(roundDeadline);
                if (remainingRoundTimeout <= 0) {
                    break;
                }
                const strategy =
                    lookupStrategies[
                        nextLookupStrategyIndex % lookupStrategies.length
                    ];
                nextLookupStrategyIndex =
                    (nextLookupStrategyIndex + 1) % lookupStrategies.length;

                if (
                    strategy === "unhinted-indexed-fields" &&
                    (!properties.persist ||
                        !remoteFrom ||
                        triedUnhintedPersistedFields)
                ) {
                    continue;
                }

                if (strategy === "manifest-head") {
                    try {
                        const chunk = await resolveChunkByManifestEntryHead(
                            remoteFrom,
                            remainingRoundTimeout
                        );
                        if (chunk) {
                            return chunk;
                        }
                    } catch (error) {
                        changeSignal.throwIfClosed();
                        if (!isRetryableChunkLookupError(error)) {
                            properties?.debug &&
                                (properties.debug.chunkFailure = {
                                    index,
                                    type: "non-retryable-manifest-head-get",
                                    message: getErrorMessage(error),
                                });
                            throw error;
                        }
                        if (
                            remoteFrom &&
                            shouldRetryChunkLookupWithoutHints(error)
                        ) {
                            hintedDeliveryFailures += 1;
                        }
                        retryableFailures += 1;
                        properties?.debug &&
                            ((properties.debug.chunkRetryableManifestHeadGetErrors ||=
                                {})[index] = getErrorMessage(error));
                    }
                    continue;
                }

                if (strategy === "deterministic-id") {
                    try {
                        const chunk = await resolveChunkByDirectGet(
                            remoteFrom,
                            properties.persist,
                            remainingRoundTimeout
                        );
                        if (chunk instanceof TinyFile) {
                            return chunk;
                        }
                        properties?.debug &&
                            ((properties.debug.chunkGetMisses ||= {})[index] =
                                ((properties.debug.chunkGetMisses ||= {})[
                                    index
                                ] ?? 0) + 1);
                        directMisses += 1;
                    } catch (error) {
                        changeSignal.throwIfClosed();
                        if (!isRetryableChunkLookupError(error)) {
                            properties?.debug &&
                                (properties.debug.chunkFailure = {
                                    index,
                                    type: "non-retryable",
                                    message: getErrorMessage(error),
                                });
                            throw error;
                        }
                        if (
                            remoteFrom &&
                            shouldRetryChunkLookupWithoutHints(error)
                        ) {
                            hintedDeliveryFailures += 1;
                        }
                        retryableFailures += 1;
                        properties?.debug &&
                            ((properties.debug.chunkRetryableErrors ||= {})[
                                index
                            ] = getErrorMessage(error));
                    }
                    continue;
                }

                if (strategy === "indexed-fields") {
                    try {
                        const chunk = await resolveChunkByIndexedFields(
                            remoteFrom,
                            remainingRoundTimeout
                        );
                        if (chunk) {
                            return chunk;
                        }
                    } catch (error) {
                        changeSignal.throwIfClosed();
                        if (!isRetryableChunkLookupError(error)) {
                            properties?.debug &&
                                (properties.debug.chunkFailure = {
                                    index,
                                    type: "non-retryable-indexed-search",
                                    message: getErrorMessage(error),
                                });
                            throw error;
                        }
                        if (
                            remoteFrom &&
                            shouldRetryChunkLookupWithoutHints(error)
                        ) {
                            hintedDeliveryFailures += 1;
                        }
                        retryableFailures += 1;
                        properties?.debug &&
                            ((properties.debug.chunkRetryableSearchErrors ||=
                                {})[index] = getErrorMessage(error));
                    }
                    continue;
                }

                triedUnhintedPersistedFields = true;
                properties?.debug &&
                    ((properties.debug.chunkUnhintedPersistedSearches ||= {})[
                        index
                    ] = true);
                try {
                    const chunk = await resolveChunkByIndexedFields(
                        undefined,
                        remainingRoundTimeout
                    );
                    if (chunk) {
                        properties?.debug &&
                            ((properties.debug.chunkResolved ||= {})[index] =
                                "unhinted-persisted-indexed-search");
                        return chunk;
                    }
                } catch (error) {
                    changeSignal.throwIfClosed();
                    if (!isRetryableChunkLookupError(error)) {
                        throw error;
                    }
                    retryableFailures += 1;
                    properties?.debug &&
                        ((properties.debug.chunkRetryableUnhintedPersistedSearchErrors ||=
                            {})[index] = getErrorMessage(error));
                }
            }

            if (
                directMisses + retryableFailures >=
                    nextNonReplicatingReadAfterFailures &&
                getRemainingRoundTimeout(roundDeadline) > 0
            ) {
                // A miss is not evidence that a peer hint is stale. Keep using
                // the known writer/replicator hint for direct reads unless a
                // delivery error specifically tells us to try without it.
                const sourceHints =
                    remoteFrom ??
                    readContext.lastReadPeerHints ??
                    (await files.getReadPeerHints());
                changeSignal.throwIfClosed();
                const remoteSources = sourceHints
                    ? [undefined, sourceHints]
                    : [undefined];
                let attemptedNonReplicatingLookup = false;
                for (const sourceFrom of remoteSources) {
                    const remainingRoundTimeout =
                        getRemainingRoundTimeout(roundDeadline);
                    if (remainingRoundTimeout <= 0) {
                        break;
                    }
                    attemptedNonReplicatingLookup = true;
                    try {
                        const chunk = await resolveChunkWithoutPersisting(
                            sourceFrom,
                            remainingRoundTimeout
                        );
                        if (chunk) {
                            return chunk;
                        }
                    } catch (error) {
                        changeSignal.throwIfClosed();
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
                    const remainingRoundTimeout =
                        getRemainingRoundTimeout(roundDeadline);
                    if (remainingRoundTimeout <= 0) {
                        break;
                    }
                    attemptedNonReplicatingLookup = true;
                    try {
                        const chunk = await resolveChunkByResolvedFields(
                            sourceFrom,
                            remainingRoundTimeout
                        );
                        if (chunk) {
                            return chunk;
                        }
                    } catch (error) {
                        changeSignal.throwIfClosed();
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
                if (attemptedNonReplicatingLookup) {
                    nextNonReplicatingReadAfterFailures *= 2;
                }
            }

            await changeSignal.waitForChangeAfter(
                changeVersion,
                Math.min(
                    LARGE_FILE_CHANGE_WAIT_FALLBACK_MS,
                    Math.max(0, deadline - Date.now())
                )
            );
            changeSignal.throwIfClosed();
        }

        changeSignal.throwIfClosed();
        throw new Error(
            `Failed to resolve chunk ${index + 1}/${this.chunkCount} for file ${this.id}`
        );
    }

    private async waitUntilReady(
        files: Files,
        properties: EffectiveFileReadOptions,
        debug: FileReadDiagnostics
    ): Promise<LargeFile> {
        if (this.ready) {
            return this;
        }

        const changeSignal = files.createFileChangeSignal(
            (file) => file.id === this.id
        );
        try {
            return await this.waitUntilReadyWithSignal(
                files,
                changeSignal,
                properties,
                debug
            );
        } finally {
            changeSignal.close();
        }
    }

    private async waitUntilReadyWithSignal(
        files: Files,
        changeSignal: FileChangeSignal,
        properties: EffectiveFileReadOptions,
        debug: FileReadDiagnostics
    ): Promise<LargeFile> {
        const totalTimeout =
            properties?.timeout ?? LARGE_FILE_CHUNK_LOOKUP_TIMEOUT_MS;
        const deadline = Date.now() + totalTimeout;
        const attemptTimeout = Math.min(totalTimeout, 5_000);

        while (!changeSignal.isClosed && Date.now() < deadline) {
            const changeVersion = changeSignal.snapshot();
            debug.waitUntilReadyAttempts += 1;
            const remoteFrom = await files.getReadPeerHints();
            changeSignal.throwIfClosed();
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
                signal: changeSignal.abortSignal,
            } as any);
            changeSignal.throwIfClosed();
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
            const attemptDeadline = Math.min(
                deadline,
                Date.now() + attemptTimeout
            );
            const getRemainingAttemptTimeout = () => {
                const remaining = attemptDeadline - Date.now();
                return remaining > 0 ? Math.max(1, Math.floor(remaining)) : 0;
            };
            let remoteMatches: AbstractFile[] = [];
            const remoteSearchTimeout = getRemainingAttemptTimeout();
            if (remoteSearchTimeout > 0) {
                try {
                    remoteMatches = await files.files.index.search(request, {
                        local: false,
                        signal: changeSignal.abortSignal,
                        remote: {
                            timeout: remoteSearchTimeout,
                            throwOnMissing: false,
                            retryMissingResponses: true,
                            replicate: properties.persist,
                            from: remoteFrom,
                        },
                    } as any);
                    changeSignal.throwIfClosed();
                } catch (error) {
                    changeSignal.throwIfClosed();
                    if (debug) {
                        (debug.readyRemoteSearchErrors ||= []).push(
                            getErrorMessage(error)
                        );
                    }
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
            const directGetTimeout = getRemainingAttemptTimeout();
            if (directGetTimeout > 0) {
                try {
                    const directRemote = await files.files.index.get(this.id, {
                        local: false,
                        signal: changeSignal.abortSignal,
                        remote: {
                            timeout: directGetTimeout,
                            strategy: "always" as any,
                            throwOnMissing: false,
                            retryMissingResponses: true,
                            replicate: properties.persist,
                            from: remoteFrom,
                        },
                    });
                    changeSignal.throwIfClosed();
                    const directReady = toReadableLargeFile(directRemote);
                    const directReadySource = "ready-manifest-get";
                    if (
                        debug?.lastReadyProbe &&
                        isLargeFileLike(directRemote)
                    ) {
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
                    changeSignal.throwIfClosed();
                    if (debug) {
                        (debug.readyRemoteGetErrors ||= []).push(
                            getErrorMessage(error)
                        );
                    }
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
            changeSignal.throwIfClosed();
            if (debug?.lastReadyProbe) {
                debug.lastReadyProbe.localChunkCount = localChunkCount;
            }
            if (localChunkCount >= countCandidate.chunkCount) {
                if (debug) {
                    debug.waitUntilReadyResolvedBy = "complete-chunks";
                }
                return countCandidate;
            }
            await changeSignal.waitForChangeAfter(
                changeVersion,
                Math.min(
                    LARGE_FILE_CHANGE_WAIT_FALLBACK_MS,
                    Math.max(0, deadline - Date.now())
                )
            );
            changeSignal.throwIfClosed();
        }

        changeSignal.throwIfClosed();
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
        // Keep one immutable read policy for the entire stream. Role changes can
        // update the program default concurrently, but must not switch an
        // in-flight read between persisted and non-persisted scheduling paths.
        const persistChunkReads = files.persistChunkReads;
        const effectiveProperties: EffectiveFileReadOptions = {
            ...properties,
            persist: persistChunkReads,
        };
        const debug = {
            fileId: this.id,
            fileName: this.name,
            persistChunkReads,
            programPersistChunkReads: persistChunkReads,
            startedAt: Date.now(),
            waitUntilReadyAttempts: 0,
            waitUntilReadyResolvedAt: null as number | null,
            waitUntilReadyResolvedReady: null as boolean | null,
            waitUntilReadyResolvedBy: null as string | null,
            prefetchedChunkCount: 0,
            chunkBatchQueryCount: 0,
            chunkBatchResultCount: 0,
            chunkBatchFallbackCount: 0,
            chunkBatchFallbackResultCount: 0,
            chunkBatchResolverFallbackCount: 0,
            chunkPersistedRemoteBatchSkipCount: 0,
            chunkPersistedRemoteBatchSkippedIndexCount: 0,
            chunkManifestHeadBatchQueryCount: 0,
            chunkManifestHeadLocalBatchQueryCount: 0,
            chunkManifestHeadRemoteBatchQueryCount: 0,
            chunkManifestHeadBatchRequestedIndexCount: 0,
            chunkManifestHeadBatchAcceptedCount: 0,
            chunkManifestHeadLocalBatchAcceptedCount: 0,
            chunkManifestHeadRemoteBatchAcceptedCount: 0,
            chunkManifestHeadBatchMissingCount: 0,
            chunkManifestHeadBatchInvalidCount: 0,
            chunkManifestHeadBatchInvalidErrors: [] as {
                index: number;
                message: string;
            }[],
            chunkManifestHeadBatchPartialCount: 0,
            chunkManifestHeadBatchErrorCount: 0,
            chunkManifestHeadBatchErrors: [] as string[],
            chunkManifestHeadBatchDisabled: false,
            chunkManifestHeadBatchDisabledReason: null as string | null,
            chunkManifestHeadBatchDisabledSkipCount: 0,
            chunkManifestHeadBatchDisabledSkippedIndexCount: 0,
            chunkManifestHeadBatchAttemptTimeoutMs: 0,
            maxManifestHeadBatchSize: 0,
            activeManifestHeadBatches: 0,
            maxConcurrentManifestHeadBatches: 0,
            chunkManifestHeadBatchResolved: {} as Record<number, string>,
            chunkBatchAttemptTimeoutMs: 0,
            chunkBatchRemoteReclassificationCount: 0,
            chunkLocalIndexedBatchQueryCount: 0,
            chunkLocalIndexedBatchResultCount: 0,
            chunkBatchErrorCount: 0,
            chunkBatchErrors: [] as string[],
            maxRemoteChunkBatchSize: 0,
            activeRemoteChunkBatches: 0,
            maxConcurrentRemoteChunkBatches: 0,
            peakKnownChunkCount: 0,
            finalKnownChunkCount: null as number | null,
            readAhead: 0,
            readAheadInitial: 0,
            readAheadLimit: 0,
            readAheadPeak: 0,
            maxInFlightChunks: 0,
            readAheadChanges: [] as {
                index: number;
                from: number;
                to: number;
                demandWaitMs: number;
                attempts: number;
            }[],
            initialLocalChunkCount: null as number | null,
            initialLocalChunkBlockCount: null as number | null,
            readAheadSource: null as string | null,
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
        const diagnosticsContext = (
            properties as InternalFileReadOptions | undefined
        )?.[FILE_READ_DIAGNOSTICS_CONTEXT];
        if (diagnosticsContext) {
            diagnosticsContext.diagnostics = debug;
        }
        files.lastReadDiagnostics = debug;
        if (persistChunkReads) {
            files.retainFileRead(this);
        }
        const resolvedFile = await this.waitUntilReady(
            files,
            effectiveProperties,
            debug
        );
        debug.waitUntilReadyResolvedAt = Date.now();
        debug.waitUntilReadyResolvedReady = resolvedFile.ready;
        if (persistChunkReads) {
            files.retainFileRead(resolvedFile);
        }

        properties?.progress?.(0);

        let processed = 0n;
        const hasher = resolvedFile.finalHash ? new SHA256() : undefined;
        const knownChunks = new Map<number, TinyFile>();
        const readContext: ChunkReadContext = {
            fileChangeSignals: new Set(),
        };
        const initialReadPeerHints = await files.getReadPeerHints();
        if (initialReadPeerHints) {
            readContext.lastReadPeerHints = initialReadPeerHints;
            debug.initialReadPeerHints = initialReadPeerHints;
        }
        if (persistChunkReads) {
            const [initialLocalChunkCount, initialLocalChunkBlockCount] =
                await Promise.all([
                    files.countLocalChunks(resolvedFile).catch(() => null),
                    files.countLocalChunkBlocks(resolvedFile).catch(() => null),
                ]);
            debug.initialLocalChunkCount = initialLocalChunkCount;
            debug.initialLocalChunkBlockCount =
                initialLocalChunkBlockCount ?? null;
        }
        const remoteReadAheadLimit = getRemotePersistedReadAheadLimit(
            resolvedFile.size,
            resolvedFile.chunkCount
        );
        const localReadAheadLimit = Math.min(
            resolvedFile.chunkCount,
            LARGE_FILE_PERSISTED_READ_AHEAD
        );
        const manifestChunkEntryHeads = (
            resolvedFile as { chunkEntryHeads?: unknown }
        ).chunkEntryHeads;
        const hasCompleteChunkEntryHeads =
            Array.isArray(manifestChunkEntryHeads) &&
            manifestChunkEntryHeads.length === resolvedFile.chunkCount &&
            manifestChunkEntryHeads.every(
                (head: unknown) => typeof head === "string"
            );
        let isRemotePersistedRead =
            persistChunkReads &&
            (debug.initialLocalChunkCount == null ||
                debug.initialLocalChunkCount < resolvedFile.chunkCount);
        let isAdaptiveRemoteRead = !persistChunkReads || isRemotePersistedRead;
        let readAheadLimit = isAdaptiveRemoteRead
            ? remoteReadAheadLimit
            : localReadAheadLimit;
        // A count can be stale when local index rows outlive their payloads.
        // Probe a small exact batch before granting the 32-chunk local window.
        let localReadAheadVerified =
            !persistChunkReads || isRemotePersistedRead;
        let usesLegacyLocalChunkIds = false;
        let readAhead = isAdaptiveRemoteRead
            ? Math.min(
                  resolvedFile.chunkCount,
                  persistChunkReads
                      ? hasCompleteChunkEntryHeads
                          ? readAheadLimit
                          : REMOTE_PERSISTED_READ_AHEAD_MIN
                      : LARGE_FILE_OBSERVER_READ_AHEAD,
                  readAheadLimit
              )
            : Math.min(
                  resolvedFile.chunkCount,
                  REMOTE_PERSISTED_READ_AHEAD_MIN,
                  readAheadLimit
              );
        const batchPromisesByIndex = new Map<number, Promise<void>>();
        const batchAttemptedIndices = new Set<number>();
        const intentionallySkippedBatchIndices = new Set<number>();
        const skipPersistedRemoteBatch = (indices: number[]) => {
            debug.chunkPersistedRemoteBatchSkipCount += 1;
            debug.chunkPersistedRemoteBatchSkippedIndexCount += indices.length;
            for (const index of indices) {
                intentionallySkippedBatchIndices.add(index);
            }
        };
        const reclassifyAsRemotePersistedRead = () => {
            if (!persistChunkReads || isRemotePersistedRead) {
                return;
            }
            isRemotePersistedRead = true;
            isAdaptiveRemoteRead = true;
            localReadAheadVerified = false;
            readAheadLimit = remoteReadAheadLimit;
            readAhead = hasCompleteChunkEntryHeads
                ? readAheadLimit
                : Math.min(readAhead, readAheadLimit);
            debug.chunkBatchRemoteReclassificationCount += 1;
            debug.readAhead = readAhead;
            debug.readAheadLimit = readAheadLimit;
            debug.readAheadSource = "persisted-remote-adaptive";
        };
        const verifyLocalReadAhead = () => {
            if (
                !persistChunkReads ||
                isRemotePersistedRead ||
                localReadAheadVerified
            ) {
                return;
            }
            localReadAheadVerified = true;
            readAheadLimit = localReadAheadLimit;
            readAhead = readAheadLimit;
            debug.readAhead = readAhead;
            debug.readAheadLimit = readAheadLimit;
            debug.readAheadPeak = Math.max(debug.readAheadPeak, readAhead);
        };
        const updateKnownChunkPeak = () => {
            debug.peakKnownChunkCount = Math.max(
                debug.peakKnownChunkCount,
                knownChunks.size
            );
        };
        let manifestHeadBatchDisabled = false;
        const disableManifestHeadBatch = (reason: string) => {
            manifestHeadBatchDisabled = true;
            debug.chunkManifestHeadBatchDisabled = true;
            debug.chunkManifestHeadBatchDisabledReason ??= reason;
        };
        type ManifestHeadEntry =
            | {
                  getPayloadValue: () => Promise<Operation>;
              }
            | undefined;
        type ManifestHeadRemote =
            | false
            | {
                  timeout: number;
                  replicate: true;
                  from: string[] | undefined;
                  signal: AbortSignal;
              };
        const readManifestHeadEntries = async (
            heads: string[],
            remote: ManifestHeadRemote
        ): Promise<ManifestHeadEntry[]> => {
            const log = files.files.log.log as any;
            if (typeof log.getMany === "function") {
                return log.getMany(heads, { remote });
            }

            const entryIndex = log.entryIndex;
            if (typeof entryIndex?.getMany === "function") {
                return entryIndex.getMany(heads, {
                    type: "full",
                    ignoreMissing: true,
                    remote,
                });
            }

            if (typeof log.get !== "function") {
                throw new Error("Log does not support manifest-head reads");
            }
            const batchSize = Math.max(
                1,
                Math.min(8, remoteReadAheadLimit || 1)
            );
            const entries: ManifestHeadEntry[] = [];
            for (let offset = 0; offset < heads.length; offset += batchSize) {
                if (remote && remote.signal.aborted) {
                    throw remote.signal.reason;
                }
                entries.push(
                    ...(await Promise.all(
                        heads
                            .slice(offset, offset + batchSize)
                            .map((head) => log.get(head, { remote }))
                    ))
                );
            }
            return entries;
        };
        const queryPersistedManifestHeadBatch = async (
            indices: number[],
            from: string[] | undefined,
            changeSignal: FileChangeSignal
        ) => {
            if (indices.length === 0) {
                return indices;
            }
            changeSignal.throwIfClosed();
            if (manifestHeadBatchDisabled) {
                debug.chunkManifestHeadBatchDisabledSkipCount += 1;
                debug.chunkManifestHeadBatchDisabledSkippedIndexCount +=
                    indices.length;
                return indices;
            }

            const heads = (resolvedFile as { chunkEntryHeads?: unknown })
                .chunkEntryHeads;
            const requested = indices.flatMap((index) => {
                const head = Array.isArray(heads) ? heads[index] : undefined;
                return typeof head === "string" ? [{ head, index }] : [];
            });
            if (requested.length === 0) {
                return indices;
            }

            debug.chunkManifestHeadBatchQueryCount += 1;
            debug.chunkManifestHeadBatchRequestedIndexCount += requested.length;
            debug.maxManifestHeadBatchSize = Math.max(
                debug.maxManifestHeadBatchSize,
                requested.length
            );
            const attemptTimeout = Math.min(
                LARGE_FILE_CHUNK_BATCH_SPECULATIVE_TIMEOUT_MS,
                Math.max(
                    1,
                    properties?.timeout ??
                        LARGE_FILE_CHUNK_BATCH_SPECULATIVE_TIMEOUT_MS
                )
            );
            debug.chunkManifestHeadBatchAttemptTimeoutMs = attemptTimeout;
            debug.activeManifestHeadBatches += 1;
            debug.maxConcurrentManifestHeadBatches = Math.max(
                debug.maxConcurrentManifestHeadBatches,
                debug.activeManifestHeadBatches
            );

            let accepted = 0;
            const acceptEntries = async (
                candidates: typeof requested,
                entries: ManifestHeadEntry[],
                phase: "local" | "remote"
            ) => {
                const missing: typeof requested = [];
                for (const [
                    position,
                    { head, index },
                ] of candidates.entries()) {
                    const entry = entries[position];
                    if (!entry) {
                        missing.push({ head, index });
                        continue;
                    }

                    let operation: Operation;
                    try {
                        operation = await entry.getPayloadValue();
                        changeSignal.throwIfClosed();
                    } catch (error) {
                        changeSignal.throwIfClosed();
                        debug.chunkManifestHeadBatchInvalidCount += 1;
                        (debug.chunkManifestHeadBatchInvalidErrors ||= []).push(
                            {
                                index,
                                message: getErrorMessage(error),
                            }
                        );
                        continue;
                    }
                    if (!isPutOperation(operation)) {
                        debug.chunkManifestHeadBatchInvalidCount += 1;
                        continue;
                    }

                    let chunk: AbstractFile;
                    try {
                        chunk = files.files.index.valueEncoding.decoder(
                            operation.data
                        );
                    } catch (error) {
                        debug.chunkManifestHeadBatchInvalidCount += 1;
                        (debug.chunkManifestHeadBatchInvalidErrors ||= []).push(
                            {
                                index,
                                message: getErrorMessage(error),
                            }
                        );
                        continue;
                    }
                    if (
                        !(chunk instanceof TinyFile) ||
                        chunk.parentId !== resolvedFile.id ||
                        chunk.index !== index
                    ) {
                        debug.chunkManifestHeadBatchInvalidCount += 1;
                        continue;
                    }

                    if (persistChunkReads) {
                        files.retainChunkEntryHead(
                            head,
                            resolvedFile.id,
                            chunk.id
                        );
                    }
                    knownChunks.set(index, chunk);
                    if (persistChunkReads) {
                        files.retainResolvedChunk(chunk, persistChunkReads);
                    }
                    debug.chunkManifestHeadBatchResolved[index] = head;
                    accepted += 1;
                    debug.chunkManifestHeadBatchAcceptedCount += 1;
                    debug.prefetchedChunkCount += 1;
                    if (phase === "local") {
                        debug.chunkManifestHeadLocalBatchAcceptedCount += 1;
                    } else {
                        debug.chunkManifestHeadRemoteBatchAcceptedCount += 1;
                    }
                }
                return missing;
            };

            try {
                debug.chunkManifestHeadLocalBatchQueryCount += 1;
                const localEntries = await readManifestHeadEntries(
                    requested.map(({ head }) => head),
                    false
                );
                changeSignal.throwIfClosed();
                const remotelyMissing = await acceptEntries(
                    requested,
                    localEntries,
                    "local"
                );
                if (remotelyMissing.length > 0) {
                    debug.chunkManifestHeadRemoteBatchQueryCount += 1;
                    const remoteEntries = await readManifestHeadEntries(
                        remotelyMissing.map(({ head }) => head),
                        {
                            timeout: attemptTimeout,
                            replicate: true,
                            from,
                            signal: changeSignal.abortSignal,
                        }
                    );
                    changeSignal.throwIfClosed();
                    const stillMissing = await acceptEntries(
                        remotelyMissing,
                        remoteEntries,
                        "remote"
                    );
                    debug.chunkManifestHeadBatchMissingCount +=
                        stillMissing.length;
                }
            } catch (error) {
                changeSignal.throwIfClosed();
                debug.chunkManifestHeadBatchErrorCount += 1;
                debug.chunkManifestHeadBatchErrors.push(getErrorMessage(error));
                disableManifestHeadBatch("error");
                return indices.filter((index) => !knownChunks.has(index));
            } finally {
                debug.activeManifestHeadBatches -= 1;
            }

            if (accepted === 0) {
                disableManifestHeadBatch("zero-accepted");
            } else if (accepted < requested.length) {
                debug.chunkManifestHeadBatchPartialCount += 1;
            }
            return indices.filter((index) => !knownChunks.has(index));
        };
        const queryChunkBatch = async (
            indices: number[],
            from: string[] | undefined,
            remote: boolean,
            fallback: boolean,
            changeSignal: FileChangeSignal
        ) => {
            if (indices.length === 0) {
                return [];
            }
            changeSignal.throwIfClosed();
            debug.chunkBatchQueryCount += 1;
            if (remote) {
                debug.maxRemoteChunkBatchSize = Math.max(
                    debug.maxRemoteChunkBatchSize,
                    indices.length
                );
                debug.activeRemoteChunkBatches += 1;
                debug.maxConcurrentRemoteChunkBatches = Math.max(
                    debug.maxConcurrentRemoteChunkBatches,
                    debug.activeRemoteChunkBatches
                );
            }
            const requested = new Map(
                indices.map((index) => [
                    getChunkId(resolvedFile.id, index),
                    index,
                ])
            );
            let results: AbstractFile[];
            try {
                const totalTimeout =
                    properties?.timeout ?? LARGE_FILE_CHUNK_LOOKUP_TIMEOUT_MS;
                const batchAttemptTimeout = Math.min(
                    getChunkLookupAttemptTimeout(
                        resolvedFile.size,
                        resolvedFile.chunkCount,
                        indices[0],
                        totalTimeout
                    ),
                    LARGE_FILE_CHUNK_BATCH_SPECULATIVE_TIMEOUT_MS
                );
                if (remote) {
                    debug.chunkBatchAttemptTimeoutMs = batchAttemptTimeout;
                }
                results = await files.files.index.search(
                    new SearchRequest({
                        query: new Or(
                            [...requested.keys()].map(
                                (id) =>
                                    new StringMatch({
                                        key: "id",
                                        value: id,
                                        caseInsensitive: false,
                                        method: StringMatchMethod.exact,
                                    })
                            )
                        ),
                        fetch: indices.length,
                    }),
                    remote
                        ? ({
                              local: false,
                              signal: changeSignal.abortSignal,
                              remote: {
                                  timeout: batchAttemptTimeout,
                                  throwOnMissing: false,
                                  retryMissingResponses: false,
                                  replicate: persistChunkReads,
                                  from,
                              },
                          } as any)
                        : ({
                              local: true,
                              remote: false,
                              signal: changeSignal.abortSignal,
                          } as any)
                );
                changeSignal.throwIfClosed();
            } catch (error) {
                changeSignal.throwIfClosed();
                debug.chunkBatchErrorCount += 1;
                (debug.chunkBatchErrors ||= []).push(getErrorMessage(error));
                return indices.filter((index) => !knownChunks.has(index));
            } finally {
                if (remote) {
                    debug.activeRemoteChunkBatches -= 1;
                }
            }

            let accepted = 0;
            for (const candidate of results) {
                const expectedIndex = requested.get(candidate.id);
                if (
                    expectedIndex == null ||
                    !(candidate instanceof TinyFile) ||
                    candidate.parentId !== resolvedFile.id ||
                    candidate.index !== expectedIndex ||
                    candidate.id !== getChunkId(resolvedFile.id, expectedIndex)
                ) {
                    continue;
                }
                if (!knownChunks.has(expectedIndex)) {
                    knownChunks.set(expectedIndex, candidate);
                    if (persistChunkReads) {
                        files.retainResolvedChunk(candidate, persistChunkReads);
                    }
                    accepted += 1;
                }
            }
            debug.chunkBatchResultCount += accepted;
            if (fallback) {
                debug.chunkBatchFallbackResultCount += accepted;
            }
            debug.prefetchedChunkCount += accepted;
            return indices.filter((index) => !knownChunks.has(index));
        };
        const queryLocalIndexedChunkBatch = async (
            indices: number[],
            changeSignal: FileChangeSignal
        ) => {
            const missing: number[] = [];
            for (const index of indices) {
                changeSignal.throwIfClosed();
                debug.chunkLocalIndexedBatchQueryCount += 1;
                try {
                    const results = await files.files.index.search(
                        new SearchRequest({
                            query: [
                                new StringMatch({
                                    key: "parentId",
                                    value: resolvedFile.id,
                                    caseInsensitive: false,
                                    method: StringMatchMethod.exact,
                                }),
                                new StringMatch({
                                    key: "name",
                                    value: `${resolvedFile.name}/${index}`,
                                    caseInsensitive: false,
                                    method: StringMatchMethod.exact,
                                }),
                            ],
                            fetch: 1,
                        }),
                        {
                            local: true,
                            remote: false,
                            signal: changeSignal.abortSignal,
                        } as any
                    );
                    changeSignal.throwIfClosed();
                    const chunk = (results as unknown[]).find(
                        (candidate): candidate is TinyFile =>
                            candidate instanceof TinyFile &&
                            candidate.parentId === resolvedFile.id &&
                            candidate.index === index
                    );
                    if (chunk) {
                        knownChunks.set(index, chunk);
                        if (persistChunkReads) {
                            files.retainResolvedChunk(chunk, persistChunkReads);
                        }
                        debug.chunkLocalIndexedBatchResultCount += 1;
                    } else {
                        missing.push(index);
                    }
                } catch (error) {
                    changeSignal.throwIfClosed();
                    debug.chunkBatchErrorCount += 1;
                    (debug.chunkBatchErrors ||= []).push(
                        getErrorMessage(error)
                    );
                    missing.push(index);
                }
            }
            return missing;
        };
        const prefetchChunkBatch = async (
            indices: number[],
            changeSignal: FileChangeSignal
        ) => {
            changeSignal.throwIfClosed();
            const hintedFrom =
                readContext.lastReadPeerHints ??
                (await files.getReadPeerHints());
            changeSignal.throwIfClosed();
            if (hintedFrom) {
                readContext.lastReadPeerHints = hintedFrom;
            }
            if (persistChunkReads && isRemotePersistedRead) {
                const boundedIndices = indices.slice(0, remoteReadAheadLimit);
                const deferred = indices.slice(remoteReadAheadLimit);
                for (const index of deferred) {
                    batchAttemptedIndices.delete(index);
                }
                const missing = await queryPersistedManifestHeadBatch(
                    boundedIndices,
                    hintedFrom,
                    changeSignal
                );
                skipPersistedRemoteBatch(missing);
                updateKnownChunkPeak();
                return [...missing, ...deferred];
            }
            let missing = await queryChunkBatch(
                indices,
                undefined,
                false,
                false,
                changeSignal
            );
            if (
                missing.length > 0 &&
                persistChunkReads &&
                !isRemotePersistedRead &&
                (!localReadAheadVerified || usesLegacyLocalChunkIds)
            ) {
                const before = missing.length;
                missing = await queryLocalIndexedChunkBatch(
                    missing,
                    changeSignal
                );
                if (missing.length < before) {
                    usesLegacyLocalChunkIds = true;
                }
                if (missing.length === 0) {
                    // Legacy ids cannot use the 32-id deterministic query, so
                    // retain a small local window and resolve by indexed fields.
                    localReadAheadVerified = true;
                    updateKnownChunkPeak();
                    return missing;
                }
            }
            if (missing.length === 0) {
                verifyLocalReadAhead();
                updateKnownChunkPeak();
                return missing;
            }
            if (persistChunkReads && isRemotePersistedRead) {
                skipPersistedRemoteBatch(missing);
                updateKnownChunkPeak();
                return missing;
            }
            const wasVerifiedLocalRead =
                persistChunkReads && !isRemotePersistedRead;
            reclassifyAsRemotePersistedRead();
            const boundedIndices = indices.slice(0, remoteReadAheadLimit);
            const deferred = indices.slice(remoteReadAheadLimit);
            let evictedLocalResults = 0;
            // A batch may have been assembled under the former 32-chunk local
            // window. Discard payload-bearing results outside the new network
            // budget and unlock them for a later bounded local-first batch.
            for (const index of deferred) {
                if (wasVerifiedLocalRead && knownChunks.delete(index)) {
                    evictedLocalResults += 1;
                }
                batchAttemptedIndices.delete(index);
            }
            debug.chunkBatchResultCount -= evictedLocalResults;
            debug.prefetchedChunkCount -= evictedLocalResults;
            missing = boundedIndices.filter((index) => !knownChunks.has(index));
            if (persistChunkReads && isRemotePersistedRead) {
                missing = await queryPersistedManifestHeadBatch(
                    missing,
                    hintedFrom,
                    changeSignal
                );
                skipPersistedRemoteBatch(missing);
                updateKnownChunkPeak();
                return [...missing, ...deferred];
            }
            if (missing.length > 0) {
                missing = await queryChunkBatch(
                    missing,
                    hintedFrom,
                    true,
                    false,
                    changeSignal
                );
            }
            if (hintedFrom && missing.length > 0) {
                debug.chunkBatchFallbackCount += 1;
                missing = await queryChunkBatch(
                    missing,
                    undefined,
                    true,
                    true,
                    changeSignal
                );
            }
            updateKnownChunkPeak();
            return [...missing, ...deferred];
        };
        const prefetchBatchForIndex = (
            index: number,
            changeSignal: FileChangeSignal
        ) => {
            if (knownChunks.has(index)) {
                return Promise.resolve();
            }
            const existing = batchPromisesByIndex.get(index);
            if (existing) {
                return existing;
            }
            if (batchAttemptedIndices.has(index)) {
                return Promise.resolve();
            }
            const indices: number[] = [];
            for (
                let candidate = index;
                candidate <
                Math.min(
                    resolvedFile.chunkCount,
                    index + Math.max(readAhead, 1)
                );
                candidate++
            ) {
                if (!knownChunks.has(candidate)) {
                    indices.push(candidate);
                    batchAttemptedIndices.add(candidate);
                }
            }
            if (indices.length === 0) {
                return Promise.resolve();
            }
            let pending: Promise<void>;
            pending = prefetchChunkBatch(indices, changeSignal)
                .then(() => undefined)
                .finally(() => {
                    for (const candidate of indices) {
                        if (batchPromisesByIndex.get(candidate) === pending) {
                            batchPromisesByIndex.delete(candidate);
                        }
                    }
                });
            for (const candidate of indices) {
                batchPromisesByIndex.set(candidate, pending);
            }
            return pending;
        };
        const inFlightChunks = new Map<number, Promise<TinyFile>>();
        const resolveChunkWithReadAhead = (index: number) => {
            const cached = inFlightChunks.get(index);
            if (cached) {
                return cached;
            }
            const pending = (async () => {
                debug.chunkResolveStartedAt[index] = Date.now();
                const chunkId = getChunkId(resolvedFile.id, index);
                const changeSignal = files.createFileChangeSignal(
                    (file) =>
                        file.id === chunkId ||
                        (file instanceof TinyFile &&
                            file.parentId === resolvedFile.id &&
                            file.index === index)
                );
                readContext.fileChangeSignals!.add(changeSignal);
                try {
                    await prefetchBatchForIndex(index, changeSignal);
                    while (
                        !knownChunks.has(index) &&
                        !batchAttemptedIndices.has(index)
                    ) {
                        await prefetchBatchForIndex(index, changeSignal);
                    }
                    const intentionallySkippedBatch =
                        intentionallySkippedBatchIndices.delete(index);
                    if (!knownChunks.has(index) && !intentionallySkippedBatch) {
                        debug.chunkBatchResolverFallbackCount += 1;
                    }
                    const chunk = await resolvedFile.resolveChunk(
                        files,
                        index,
                        knownChunks,
                        readContext,
                        changeSignal,
                        {
                            timeout: properties?.timeout,
                            debug,
                            persist: persistChunkReads,
                        }
                    );
                    updateKnownChunkPeak();
                    return chunk;
                } finally {
                    changeSignal.close();
                    readContext.fileChangeSignals!.delete(changeSignal);
                    debug.chunkResolveFinishedAt[index] = Date.now();
                }
            })();
            inFlightChunks.set(index, pending);
            return pending;
        };

        debug.readAhead = readAhead;
        debug.readAheadInitial = readAhead;
        debug.readAheadLimit = readAheadLimit;
        debug.readAheadPeak = readAhead;
        debug.readAheadSource = persistChunkReads
            ? isRemotePersistedRead
                ? "persisted-remote-adaptive"
                : "persisted-local"
            : "observer-adaptive";

        let nextChunkToSchedule = 0;
        const fillReadAhead = () => {
            // One resolver can still issue a 32-id local query. Keeping only
            // that resolver active lets a partial local miss reclassify the
            // stream before any deferred index can start a remote RPC.
            const schedulerLimit = isAdaptiveRemoteRead ? readAhead : 1;
            while (
                nextChunkToSchedule < resolvedFile.chunkCount &&
                inFlightChunks.size < schedulerLimit
            ) {
                const index = nextChunkToSchedule++;
                void resolveChunkWithReadAhead(index).catch(() => undefined);
            }
            debug.maxInFlightChunks = Math.max(
                debug.maxInFlightChunks,
                inFlightChunks.size
            );
        };

        try {
            fillReadAhead();

            for (let index = 0; index < resolvedFile.chunkCount; index++) {
                const demandStartedAt = Date.now();
                const chunkFile = await resolveChunkWithReadAhead(index);
                const demandWaitMs = Date.now() - demandStartedAt;
                inFlightChunks.delete(index);
                if (isAdaptiveRemoteRead) {
                    const attempts = debug.chunkAttempts[index] ?? 1;
                    const adaptedReadAhead = adaptRemotePersistedReadAhead(
                        readAhead,
                        readAheadLimit,
                        { demandWaitMs, attempts }
                    );
                    if (adaptedReadAhead !== readAhead) {
                        debug.readAheadChanges.push({
                            index,
                            from: readAhead,
                            to: adaptedReadAhead,
                            demandWaitMs,
                            attempts,
                        });
                        readAhead = adaptedReadAhead;
                        debug.readAhead = readAhead;
                        debug.readAheadPeak = Math.max(
                            debug.readAheadPeak,
                            readAhead
                        );
                    }
                }
                fillReadAhead();
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
                const nextProcessed = processed + BigInt(chunk.byteLength);
                if (nextProcessed > resolvedFile.size) {
                    throw new Error(
                        `File size does not match the expected size. Expected ${resolvedFile.size} bytes, got at least ${nextProcessed}`
                    );
                }
                debug.chunkHashStartedAt[index] = Date.now();
                hasher?.update(chunk);
                debug.chunkHashFinishedAt[index] = Date.now();
                processed = nextProcessed;
                properties?.progress?.(
                    Number(processed) / Math.max(Number(resolvedFile.size), 1)
                );
                yield chunk;
                knownChunks.delete(index);
            }

            if (processed !== resolvedFile.size) {
                throw new Error(
                    `File size does not match the expected size. Expected ${resolvedFile.size} bytes, got ${processed}`
                );
            }
            if (
                hasher &&
                toBase64(hasher.digest()) !== resolvedFile.finalHash
            ) {
                throw new Error(
                    "File hash does not match the expected content"
                );
            }
            debug.finishedAt = Date.now();
        } finally {
            for (const signal of readContext.fileChangeSignals ?? []) {
                signal.close();
            }
            readContext.fileChangeSignals?.clear();
            knownChunks.clear();
            batchPromisesByIndex.clear();
            batchAttemptedIndices.clear();
            intentionallySkippedBatchIndices.clear();
            debug.finalKnownChunkCount = knownChunks.size;
        }
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
        return toLargeFileDelegate(this).streamFile(files, properties);
    }

    delete(files: Files) {
        return toLargeFileDelegate(this).delete(files);
    }
}

const toLargeFileDelegate = (
    value: LargeFile | LargeFileWithChunkHeads
): LargeFile => {
    const file = new LargeFile({
        id: value.id,
        name: value.name,
        size: value.size,
        chunkCount: value.chunkCount,
        ready: value.ready,
        finalHash: value.finalHash,
    });
    const chunkEntryHeads = (value as { chunkEntryHeads?: unknown })
        .chunkEntryHeads;
    if (Array.isArray(chunkEntryHeads)) {
        (
            file as LargeFile & {
                chunkEntryHeads?: string[];
            }
        ).chunkEntryHeads = chunkEntryHeads.filter(
            (head): head is string => typeof head === "string"
        );
    }
    return file;
};

export const isLargeFileLike = (value: unknown): value is LargeFile => {
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

const getCompleteChunkEntryHeads = (file: LargeFile): string[] | undefined => {
    const candidateHeads = (file as LargeFile & { chunkEntryHeads?: unknown })
        .chunkEntryHeads;
    return Array.isArray(candidateHeads) &&
        candidateHeads.length === file.chunkCount &&
        candidateHeads.every(
            (head): head is string =>
                typeof head === "string" && head.length > 0
        )
        ? candidateHeads
        : undefined;
};

const toReadableLargeFile = (value: unknown): LargeFile | undefined => {
    if (!isLargeFileLike(value)) {
        return;
    }
    if (typeof (value as any).resolveChunk === "function") {
        return value as LargeFile;
    }
    if (Array.isArray((value as any).chunkEntryHeads)) {
        return toLargeFileDelegate(value);
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
    chunkPutConcurrencyLimit: number;
    chunkPutByteLimit: number;
    maxConcurrentChunkPuts: number;
    maxConcurrentChunkPutBytes: number;
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
    private retainedChunkIdsByFileId = new Map<string, Set<string>>();
    private retainedLargeFileChunkCounts = new Map<string, number>();
    private retainedChunkEntryHeads = new Set<string>();
    private retainedEntryHeadsByFileId = new Map<string, Set<string>>();
    private retainedEntryHeadsByDocumentId = new Map<string, Set<string>>();
    private retainedChunkEntryHeadOwners = new Map<
        string,
        Map<string, Set<string>>
    >();
    private retainedEntryHeadDocumentIds = new Map<string, Set<string>>();
    private unscopedRetainedChunkEntryHeads = new Set<string>();
    private pendingAuthoredDocumentIds = new Map<string, number>();
    private activeFileChangeSignals = new Set<FileChangeSignal>();
    private fileMutationTails = new Map<string, Promise<void>>();
    private pendingLargeFileDeletions = new Map<string, LargeFile>();

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

    retainChunkRead(chunkId: string, fileId?: string) {
        this.retainedChunkIds ??= new Set();
        this.retainedChunkIds.add(chunkId);
        const trackedFileId =
            fileId ??
            (() => {
                const separator = chunkId.lastIndexOf(":");
                return separator > 0 &&
                    /^\d+$/.test(chunkId.slice(separator + 1))
                    ? chunkId.slice(0, separator)
                    : undefined;
            })();
        if (trackedFileId) {
            this.retainedChunkIdsByFileId ??= new Map();
            let ids = this.retainedChunkIdsByFileId.get(trackedFileId);
            if (!ids) {
                ids = new Set();
                this.retainedChunkIdsByFileId.set(trackedFileId, ids);
            }
            ids.add(chunkId);
        }
    }

    retainChunkEntryHead(
        entryHash: string,
        fileId?: string,
        documentId?: string
    ) {
        this.retainedChunkEntryHeads ??= new Set();
        this.retainedChunkEntryHeads.add(entryHash);
        if (fileId) {
            this.retainedChunkEntryHeadOwners ??= new Map();
            let ownersByFile = this.retainedChunkEntryHeadOwners.get(entryHash);
            if (!ownersByFile) {
                ownersByFile = new Map();
                this.retainedChunkEntryHeadOwners.set(entryHash, ownersByFile);
            }
            const trackedDocumentId = documentId ?? fileId;
            let ownedDocumentIds = ownersByFile.get(fileId);
            if (!ownedDocumentIds) {
                ownedDocumentIds = new Set();
                ownersByFile.set(fileId, ownedDocumentIds);
            }
            ownedDocumentIds.add(trackedDocumentId);
            this.retainedEntryHeadsByFileId ??= new Map();
            let heads = this.retainedEntryHeadsByFileId.get(fileId);
            if (!heads) {
                heads = new Set();
                this.retainedEntryHeadsByFileId.set(fileId, heads);
            }
            heads.add(entryHash);
            this.retainedEntryHeadsByDocumentId ??= new Map();
            let documentHeads =
                this.retainedEntryHeadsByDocumentId.get(trackedDocumentId);
            if (!documentHeads) {
                documentHeads = new Set();
                this.retainedEntryHeadsByDocumentId.set(
                    trackedDocumentId,
                    documentHeads
                );
            }
            documentHeads.add(entryHash);
            this.retainedEntryHeadDocumentIds ??= new Map();
            let headDocumentIds =
                this.retainedEntryHeadDocumentIds.get(entryHash);
            if (!headDocumentIds) {
                headDocumentIds = new Set();
                this.retainedEntryHeadDocumentIds.set(
                    entryHash,
                    headDocumentIds
                );
            }
            headDocumentIds.add(trackedDocumentId);
        } else {
            this.unscopedRetainedChunkEntryHeads ??= new Set();
            this.unscopedRetainedChunkEntryHeads.add(entryHash);
        }
    }

    retainResolvedChunk(
        value: unknown,
        persistChunkReads = this.persistChunkReads
    ) {
        if (!persistChunkReads) {
            return;
        }
        if (isLargeFileChunk(value)) {
            this.retainChunkRead(value.id, value.parentId);
        }
        const head = getContextHead(value);
        if (head) {
            const file = value as { id?: unknown };
            const fileId =
                value instanceof AbstractFile
                    ? getRetentionOwnerId(value)
                    : typeof file.id === "string"
                      ? file.id
                      : undefined;
            this.retainChunkEntryHead(
                head,
                fileId,
                typeof file.id === "string" ? file.id : undefined
            );
        }
    }

    retainFileRead(file: AbstractFile) {
        if (isLargeFileChunk(file)) {
            this.retainChunkRead(file.id, file.parentId);
            return;
        }
        if (isLargeFileLike(file)) {
            this.retainedLargeFileChunkCounts ??= new Map();
            this.retainedLargeFileChunkCounts.set(file.id, file.chunkCount);
        }
    }

    private retainAuthoredFile(file: AbstractFile, entryHash?: string) {
        if (isLargeFileChunk(file)) {
            this.retainChunkRead(file.id, file.parentId);
        } else if (isLargeFileLike(file)) {
            this.retainedLargeFileChunkCounts ??= new Map();
            this.retainedLargeFileChunkCounts.set(file.id, file.chunkCount);
        }
        if (entryHash) {
            this.retainChunkEntryHead(
                entryHash,
                getRetentionOwnerId(file),
                file.id
            );
        }
    }

    private async putAuthoredFile(
        file: AbstractFile,
        options?: Parameters<Documents<AbstractFile, IndexableFile>["put"]>[1],
        onLocalCommit?: (entryHead: string) => void
    ) {
        let capturedLocalHead: string | undefined;
        const captureLocalHead = onLocalCommit
            ? (
                  event: CustomEvent<
                      DocumentsChange<AbstractFile, IndexableFile>
                  >
              ) => {
                  if (capturedLocalHead) {
                      return;
                  }
                  const committed = event.detail.added.find(
                      (candidate) =>
                          candidate.id === file.id &&
                          this.isExactFileVersion(candidate, file)
                  );
                  const committedHead = getContextHead(committed);
                  if (!committedHead) {
                      return;
                  }
                  capturedLocalHead = committedHead;
                  onLocalCommit(committedHead);
                  this.files.events.removeEventListener(
                      "change",
                      captureLocalHead
                  );
              }
            : undefined;
        if (captureLocalHead) {
            this.files.events.addEventListener("change", captureLocalHead);
        }
        this.pendingAuthoredDocumentIds ??= new Map();
        this.pendingAuthoredDocumentIds.set(
            file.id,
            (this.pendingAuthoredDocumentIds.get(file.id) ?? 0) + 1
        );
        try {
            const appended = await this.files.put(file, options);
            if (onLocalCommit && !capturedLocalHead) {
                capturedLocalHead = appended.entry.hash;
                onLocalCommit(capturedLocalHead);
            }
            this.retainAuthoredFile(file, appended.entry.hash);
            return appended;
        } finally {
            if (captureLocalHead) {
                this.files.events.removeEventListener(
                    "change",
                    captureLocalHead
                );
            }
            const remaining =
                (this.pendingAuthoredDocumentIds.get(file.id) ?? 1) - 1;
            if (remaining > 0) {
                this.pendingAuthoredDocumentIds.set(file.id, remaining);
            } else {
                this.pendingAuthoredDocumentIds.delete(file.id);
            }
        }
    }

    private isExactFileVersion(
        current: AbstractFile,
        target: AbstractFile,
        expectedHead?: string
    ) {
        if (current.id !== target.id) {
            return false;
        }
        if (expectedHead != null) {
            return getContextHead(current) === expectedHead;
        }
        if (current instanceof TinyFile && target instanceof TinyFile) {
            return (
                current.name === target.name &&
                current.parentId === target.parentId &&
                current.index === target.index &&
                current.hash === target.hash
            );
        }
        if (isLargeFileLike(current) && isLargeFileLike(target)) {
            const currentHeads = (current as { chunkEntryHeads?: unknown })
                .chunkEntryHeads;
            const targetHeads = (target as { chunkEntryHeads?: unknown })
                .chunkEntryHeads;
            const sameChunkHeads =
                Array.isArray(currentHeads) || Array.isArray(targetHeads)
                    ? Array.isArray(currentHeads) &&
                      Array.isArray(targetHeads) &&
                      currentHeads.length === targetHeads.length &&
                      currentHeads.every(
                          (head, index) => head === targetHeads[index]
                      )
                    : true;
            return (
                current.name === target.name &&
                current.size === target.size &&
                current.chunkCount === target.chunkCount &&
                current.ready === target.ready &&
                current.finalHash === target.finalHash &&
                sameChunkHeads
            );
        }
        return false;
    }

    private async confirmRejectedDeleteCommitted(
        id: string,
        deleteError: unknown
    ) {
        let current: AbstractFile | undefined;
        try {
            current = await this.files.index.get(id, {
                local: true,
                remote: false,
            });
        } catch {
            throw deleteError;
        }
        if (current) {
            throw deleteError;
        }
    }

    private async cleanupFailedUploadIfCurrent(
        target: LargeFile,
        expectedHead: string | undefined,
        chunkEntryHeads: string[],
        expectedChunkCount: number
    ) {
        if (!expectedHead) {
            return false;
        }
        return this.withFileMutation(target.id, async () => {
            let current: AbstractFile | undefined;
            try {
                current = await this.files.index.get(target.id, {
                    local: true,
                    remote: false,
                });
            } catch {
                return false;
            }
            if (current) {
                if (!this.isExactFileVersion(current, target, expectedHead)) {
                    return false;
                }

                let targetEntry;
                try {
                    targetEntry = await this.files.log.log.get(expectedHead);
                } catch {
                    return false;
                }
                if (!targetEntry) {
                    return false;
                }

                try {
                    await this.files.del(target.id, {
                        meta: { next: [targetEntry] },
                    });
                } catch {
                    try {
                        current = await this.files.index.get(target.id, {
                            local: true,
                            remote: false,
                        });
                    } catch {
                        return false;
                    }
                    if (current != null) {
                        return false;
                    }
                }

                try {
                    current = await this.files.index.get(target.id, {
                        local: true,
                        remote: false,
                    });
                } catch {
                    return false;
                }
                if (current != null) {
                    return false;
                }
            }

            this.releaseOwnedEntryHead(expectedHead, target.id, target.id);
            await this.cleanupChunkedUpload(
                target.id,
                expectedChunkCount,
                chunkEntryHeads
            ).catch(() => {});

            try {
                current = await this.files.index.get(target.id, {
                    local: true,
                    remote: false,
                });
            } catch {
                return true;
            }
            this.retainedLargeFileChunkCounts ??= new Map();
            if (!current) {
                this.retainedLargeFileChunkCounts.delete(target.id);
            } else if (isLargeFileLike(current)) {
                this.retainedLargeFileChunkCounts.set(
                    target.id,
                    current.chunkCount
                );
            } else {
                this.retainedLargeFileChunkCounts.delete(target.id);
            }
            return true;
        });
    }

    private async commitReadyManifest(
        pendingFile: LargeFile,
        pendingPut: { entry: { hash: string } },
        readyFile: LargeFileWithChunkHeads
    ) {
        await this.withFileMutation(readyFile.id, async () => {
            const pendingHead = pendingPut.entry.hash;
            const currentPending = await this.files.index.get(readyFile.id, {
                local: true,
                remote: false,
            });
            if (
                !currentPending ||
                !isLargeFileLike(currentPending) ||
                currentPending.ready ||
                getContextHead(currentPending) !== pendingHead ||
                !this.isExactFileVersion(currentPending, pendingFile)
            ) {
                throw new Error(
                    `Upload ${readyFile.id} was cancelled or superseded before ready manifest commit`
                );
            }

            try {
                await this.putAuthoredFile(readyFile, {
                    meta: { next: [pendingPut.entry as any] },
                });
            } catch (error) {
                let current: AbstractFile | undefined;
                try {
                    current = await this.files.index.get(readyFile.id, {
                        local: true,
                        remote: false,
                    });
                } catch {
                    throw error;
                }
                if (!current || !this.isExactFileVersion(current, readyFile)) {
                    throw error;
                }
                const currentHead = getContextHead(current);
                if (!currentHead) {
                    throw error;
                }
                this.retainAuthoredFile(current, currentHead);
            }
            this.retireAuthoredFileEntry(pendingFile, pendingHead);
        });
    }

    private retireAuthoredFileEntry(file: AbstractFile, entryHash: string) {
        this.releaseOwnedEntryHead(
            entryHash,
            getRetentionOwnerId(file),
            file.id
        );
    }

    private forgetRetainedChunkRead(fileId: string, chunkId: string) {
        this.retainedChunkIds.delete(chunkId);
        const ids = this.retainedChunkIdsByFileId.get(fileId);
        ids?.delete(chunkId);
        if (ids?.size === 0) {
            this.retainedChunkIdsByFileId.delete(fileId);
        }
    }

    private async validateCurrentChild(
        file: TinyFile
    ): Promise<"valid" | "invalid" | "unknown"> {
        if (file.parentId == null) {
            return "invalid";
        }
        const parentId = file.parentId;
        this.retainedLargeFileChunkCounts.delete(parentId);

        let parent: AbstractFile | undefined;
        try {
            parent = await this.files.index.get(parentId, {
                local: true,
                remote: false,
            });
        } catch {
            return "unknown";
        }

        const index = file.index;
        const deterministicId =
            index == null ? undefined : getChunkId(parentId, index);
        const isLegacyId =
            file.id.length > 0 && !file.id.startsWith(`${parentId}:`);
        if (!isLargeFileLike(parent)) {
            this.forgetRetainedChunkRead(parentId, file.id);
            return "invalid";
        }
        const valid =
            parent.id === parentId &&
            index != null &&
            Number.isInteger(index) &&
            index >= 0 &&
            Number.isInteger(parent.chunkCount) &&
            index < parent.chunkCount &&
            file.name === `${parent.name}/${index}` &&
            (file.id === deterministicId || isLegacyId);
        if (!valid) {
            this.forgetRetainedChunkRead(parentId, file.id);
            return "invalid";
        }

        this.retainedLargeFileChunkCounts.set(parentId, parent.chunkCount);
        this.retainChunkRead(file.id, parentId);
        return "valid";
    }

    private async retainedEntryHeadStatus(
        entryHash: string
    ): Promise<"current" | "stale" | "unknown"> {
        this.retainedEntryHeadDocumentIds ??= new Map();
        const documentIds = this.retainedEntryHeadDocumentIds.get(entryHash);
        if (!documentIds || documentIds.size === 0) {
            return "unknown";
        }
        let lookupFailed = false;
        for (const documentId of documentIds) {
            try {
                const current = await this.files.index.get(documentId, {
                    local: true,
                    remote: false,
                } as any);
                if (getContextHead(current) === entryHash) {
                    if (isLargeFileChunk(current)) {
                        const childStatus =
                            await this.validateCurrentChild(current);
                        if (childStatus === "valid") {
                            return "current";
                        }
                        if (childStatus === "unknown") {
                            lookupFailed = true;
                        }
                        continue;
                    }
                    return "current";
                }
            } catch {
                lookupFailed = true;
            }
        }
        return lookupFailed ? "unknown" : "stale";
    }

    private isPendingAuthoredEntryHead(entryHash: string) {
        this.pendingAuthoredDocumentIds ??= new Map();
        return [
            ...(this.retainedEntryHeadDocumentIds.get(entryHash) ?? []),
        ].some((documentId) => this.pendingAuthoredDocumentIds.has(documentId));
    }

    private releaseRetainedEntryHead(entryHash: string) {
        this.retainedChunkEntryHeadOwners ??= new Map();
        this.unscopedRetainedChunkEntryHeads ??= new Set();
        const ownersByFile = this.retainedChunkEntryHeadOwners.get(entryHash);
        for (const [fileId, documentIds] of [
            ...(ownersByFile?.entries() ?? []),
        ]) {
            for (const documentId of [...documentIds]) {
                this.releaseOwnedEntryHead(entryHash, fileId, documentId);
            }
        }
        this.unscopedRetainedChunkEntryHeads.delete(entryHash);
        if (!this.retainedChunkEntryHeadOwners.has(entryHash)) {
            this.retainedChunkEntryHeads.delete(entryHash);
        }
    }

    private releaseOwnedEntryHead(
        entryHash: string,
        fileId: string,
        documentId?: string
    ) {
        this.retainedChunkEntryHeadOwners ??= new Map();
        this.unscopedRetainedChunkEntryHeads ??= new Set();
        this.retainedEntryHeadsByDocumentId ??= new Map();
        this.retainedEntryHeadDocumentIds ??= new Map();
        const ownersByFile = this.retainedChunkEntryHeadOwners.get(entryHash);
        const ownedDocumentIds = ownersByFile?.get(fileId);
        if (!ownedDocumentIds) {
            return false;
        }
        const removedDocumentIds = documentId
            ? ownedDocumentIds.delete(documentId)
                ? [documentId]
                : []
            : [...ownedDocumentIds];
        if (removedDocumentIds.length === 0) {
            return false;
        }
        if (documentId == null) {
            ownedDocumentIds.clear();
        }
        if (ownedDocumentIds.size === 0) {
            ownersByFile!.delete(fileId);
            const fileHeads = this.retainedEntryHeadsByFileId.get(fileId);
            fileHeads?.delete(entryHash);
            if (fileHeads?.size === 0) {
                this.retainedEntryHeadsByFileId.delete(fileId);
            }
        }
        for (const removedDocumentId of removedDocumentIds) {
            const remainsOwned = [...(ownersByFile?.values() ?? [])].some(
                (ids) => ids.has(removedDocumentId)
            );
            if (!remainsOwned) {
                const documentHeads =
                    this.retainedEntryHeadsByDocumentId.get(removedDocumentId);
                documentHeads?.delete(entryHash);
                if (documentHeads?.size === 0) {
                    this.retainedEntryHeadsByDocumentId.delete(
                        removedDocumentId
                    );
                }
                this.retainedEntryHeadDocumentIds
                    .get(entryHash)
                    ?.delete(removedDocumentId);
            }
        }
        if (ownersByFile?.size === 0) {
            this.retainedChunkEntryHeadOwners.delete(entryHash);
            if (!this.unscopedRetainedChunkEntryHeads.has(entryHash)) {
                this.retainedChunkEntryHeads.delete(entryHash);
                for (const trackedDocumentId of this.retainedEntryHeadDocumentIds.get(
                    entryHash
                ) ?? []) {
                    const documentHeads =
                        this.retainedEntryHeadsByDocumentId.get(
                            trackedDocumentId
                        );
                    documentHeads?.delete(entryHash);
                    if (documentHeads?.size === 0) {
                        this.retainedEntryHeadsByDocumentId.delete(
                            trackedDocumentId
                        );
                    }
                }
                this.retainedEntryHeadDocumentIds.delete(entryHash);
            }
        }
        return true;
    }

    releaseChunkRetention(
        fileId: string,
        chunkId: string,
        _entryHead?: string
    ) {
        this.forgetRetainedChunkRead(fileId, chunkId);

        const heads = new Set(
            this.retainedEntryHeadsByDocumentId.get(chunkId) ?? []
        );
        // Context heads are only hints. Ownership comes exclusively from the
        // validated group/document mapping above.
        for (const head of heads) {
            this.releaseOwnedEntryHead(head, fileId, chunkId);
        }
    }

    releaseFileRetention(
        fileOrId:
            | string
            | {
                  id: string;
                  chunkEntryHeads?: unknown;
              }
    ) {
        const file = typeof fileOrId === "string" ? { id: fileOrId } : fileOrId;
        this.retainedChunkIds ??= new Set();
        this.retainedChunkIdsByFileId ??= new Map();
        this.retainedLargeFileChunkCounts ??= new Map();
        this.retainedChunkEntryHeads ??= new Set();
        this.retainedEntryHeadsByFileId ??= new Map();

        this.retainedLargeFileChunkCounts.delete(file.id);
        const trackedChunkIds = this.retainedChunkIdsByFileId.get(file.id);
        if (trackedChunkIds) {
            for (const chunkId of [...trackedChunkIds]) {
                this.releaseChunkRetention(file.id, chunkId);
            }
            this.retainedChunkIdsByFileId.delete(file.id);
        }
        const trackedHeads = this.retainedEntryHeadsByFileId.get(file.id);
        if (trackedHeads) {
            for (const head of [...trackedHeads]) {
                this.releaseOwnedEntryHead(head, file.id);
            }
            this.retainedEntryHeadsByFileId.delete(file.id);
        }
    }

    releaseLargeFileRetention(file: {
        id: string;
        chunkCount: number;
        chunkEntryHeads?: unknown;
    }) {
        this.releaseFileRetention(file);
    }

    createFileChangeSignal(predicate: FileChangePredicate) {
        this.activeFileChangeSignals ??= new Set();
        let signal: FileChangeSignal;
        signal = new FileChangeSignal(this.files.events, predicate, () => {
            this.activeFileChangeSignals.delete(signal);
        });
        this.activeFileChangeSignals.add(signal);
        return signal;
    }

    private async shouldKeepFileEntry(entryLike: unknown) {
        this.retainedChunkIds ??= new Set();
        this.retainedLargeFileChunkCounts ??= new Map();
        this.retainedChunkEntryHeads ??= new Set();
        const isSignedBySelf = (
            signatures:
                | { publicKey?: { equals?: (key: unknown) => boolean } }[]
                | undefined
        ) =>
            signatures?.some((signature) =>
                signature.publicKey?.equals?.(this.node.identity.publicKey)
            ) === true;
        const hash = getEntryHash(entryLike);
        if (hash && this.retainedChunkEntryHeads.has(hash)) {
            const status = await this.retainedEntryHeadStatus(hash);
            if (status === "current" || status === "unknown") {
                return true;
            }
            if (
                isSignedBySelf(getEntrySignatures(entryLike)) &&
                this.isPendingAuthoredEntryHead(hash)
            ) {
                return true;
            }
            this.releaseRetainedEntryHead(hash);
            return false;
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

        if (!entry) {
            return false;
        }

        try {
            const operation = await entry.getPayloadValue();
            if (!isPutOperation(operation)) {
                return (
                    isDeleteOperation(operation) &&
                    (isSignedBySelf(getEntrySignatures(entryLike)) ||
                        isSignedBySelf(getEntrySignatures(entry)))
                );
            }
            const file = this.files.index.valueEncoding.decoder(operation.data);
            const signedBySelf =
                isSignedBySelf(getEntrySignatures(entryLike)) ||
                isSignedBySelf(getEntrySignatures(entry));
            let currentHead: string | undefined;
            try {
                const current = await this.files.index.get(file.id, {
                    local: true,
                    remote: false,
                } as any);
                currentHead = getContextHead(current);
            } catch {
                if (
                    signedBySelf &&
                    this.pendingAuthoredDocumentIds.has(file.id)
                ) {
                    return true;
                }
                return false;
            }
            if (currentHead !== entry.hash) {
                if (
                    signedBySelf &&
                    this.pendingAuthoredDocumentIds.has(file.id)
                ) {
                    return true;
                }
                return false;
            }
            if (!signedBySelf && !this.persistChunkReads) {
                return false;
            }

            if (isLargeFileChunk(file)) {
                const childStatus = await this.validateCurrentChild(file);
                if (childStatus !== "valid") {
                    // A current authored entry is kept conservatively if its
                    // parent lookup failed transiently. Confirmed missing or
                    // incompatible parents are never enough to retain it.
                    return childStatus === "unknown" && signedBySelf;
                }
                if (signedBySelf) {
                    this.retainAuthoredFile(file, entry.hash);
                } else {
                    this.retainChunkEntryHead(
                        entry.hash,
                        file.parentId,
                        file.id
                    );
                }
                return true;
            }

            if (signedBySelf) {
                this.retainAuthoredFile(file, entry.hash);
                return true;
            }

            if (
                (file instanceof TinyFile && !isLargeFileChunk(file)) ||
                (isLargeFileLike(file) && file.parentId == null)
            ) {
                this.retainFileRead(file);
                this.retainChunkEntryHead(entry.hash, file.id, file.id);
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
            await this.putAuthoredFile(tinyFile);
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
            await this.putAuthoredFile(tinyFile);
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
                if (!(chunk instanceof Uint8Array)) {
                    throw new Error("Source yielded a non-Uint8Array chunk");
                }
                if (chunk.byteLength === 0) {
                    continue;
                }
                const nextProcessed = processed + BigInt(chunk.byteLength);
                if (nextProcessed > source.size) {
                    ensureSourceSize(nextProcessed, source.size);
                }
                // Sources are allowed to reuse their yielded buffer. Take a
                // stable copy before requesting the next chunk.
                const stableChunk = new Uint8Array(chunk);
                chunks.push(stableChunk);
                processed = nextProcessed;
            }
            ensureSourceSize(processed, source.size);
            const tinyFile = new TinyFile({
                name,
                file: chunks.length === 0 ? new Uint8Array(0) : concat(chunks),
                parentId,
            });
            await this.putAuthoredFile(tinyFile);
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
            chunkPutConcurrencyLimit: LARGE_FILE_CHUNK_PUT_CONCURRENCY,
            chunkPutByteLimit: LARGE_FILE_CHUNK_PUT_BYTE_LIMIT,
            maxConcurrentChunkPuts: 0,
            maxConcurrentChunkPutBytes: 0,
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

        let pendingManifest:
            | Awaited<ReturnType<typeof this.putAuthoredFile>>
            | undefined;
        let pendingManifestHead: string | undefined;
        const hasher = new SHA256();
        const putQueue = new BoundedAsyncWorkQueue(
            LARGE_FILE_CHUNK_PUT_CONCURRENCY,
            LARGE_FILE_CHUNK_PUT_BYTE_LIMIT
        );
        const updateQueueDiagnostics = () => {
            diagnostics.maxConcurrentChunkPuts = putQueue.peakCount;
            diagnostics.maxConcurrentChunkPutBytes = putQueue.peakBytes;
        };
        let chunkCount = 0;
        const chunkEntryHeads: string[] = [];
        let sourceIterator: AsyncIterator<Uint8Array> | undefined;
        let sourceIteratorDone = false;
        try {
            diagnostics.manifestStartedAt = Date.now();
            pendingManifest = await this.putAuthoredFile(
                manifest,
                undefined,
                (entryHead) => {
                    pendingManifestHead ??= entryHead;
                }
            );
            pendingManifestHead = pendingManifest.entry.hash;
            diagnostics.manifestFinishedAt = Date.now();
            // Iterator construction belongs inside the guarded region: a
            // source may throw synchronously before yielding its first chunk.
            sourceIterator = source
                .readChunks(chunkSize)
                [Symbol.asyncIterator]();
            let readBytes = 0n;
            let committedBytes = 0n;
            const normalizedChunk = new Uint8Array(chunkSize);
            let normalizedChunkLength = 0;
            const enqueueNormalizedChunk = async (chunkBytes: Uint8Array) => {
                hasher.update(chunkBytes);
                const chunkIndex = chunkCount;
                await putQueue.enqueue(chunkBytes.byteLength, async () => {
                    // The normalizer reuses its one-chunk buffer. Copy only
                    // after queue capacity is reserved and before it is reused.
                    const stableChunkBytes = new Uint8Array(chunkBytes);
                    const chunk = new TinyFile({
                        name: name + "/" + chunkIndex,
                        file: stableChunkBytes,
                        parentId: uploadId,
                        index: chunkIndex,
                    });
                    const putStartedAt = Date.now();
                    diagnostics.firstChunkStartedAt ??= putStartedAt;
                    const appended = await this.putAuthoredFile(
                        chunk,
                        undefined,
                        (entryHead) => {
                            chunkEntryHeads[chunkIndex] ??= entryHead;
                        }
                    );
                    chunkEntryHeads[chunkIndex] = appended.entry.hash;
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
                        diagnostics.slowestChunkIndex = chunkIndex;
                    }
                    committedBytes += BigInt(stableChunkBytes.byteLength);
                    progress?.(
                        Math.min(
                            Number(committedBytes) / Math.max(Number(size), 1),
                            1
                        )
                    );
                });
                chunkCount += 1;
                updateQueueDiagnostics();
            };
            while (true) {
                const next = await Promise.race([
                    sourceIterator.next(),
                    putQueue.failureSignal,
                ]);
                if (next.done) {
                    sourceIteratorDone = true;
                    break;
                }
                const sourceBytes = next.value;
                putQueue.throwIfFailed();
                if (!(sourceBytes instanceof Uint8Array)) {
                    throw new Error("Source yielded a non-Uint8Array chunk");
                }
                if (sourceBytes.byteLength === 0) {
                    continue;
                }
                const nextReadBytes =
                    readBytes + BigInt(sourceBytes.byteLength);
                if (nextReadBytes > source.size) {
                    ensureSourceSize(nextReadBytes, source.size);
                }
                readBytes = nextReadBytes;

                let sourceOffset = 0;
                while (sourceOffset < sourceBytes.byteLength) {
                    // Keep the newest normalized chunk unpublished until more
                    // data or iterator completion proves whether it is final.
                    if (normalizedChunkLength === chunkSize) {
                        await enqueueNormalizedChunk(normalizedChunk);
                        normalizedChunkLength = 0;
                    }
                    const take = Math.min(
                        chunkSize - normalizedChunkLength,
                        sourceBytes.byteLength - sourceOffset
                    );
                    normalizedChunk.set(
                        sourceBytes.subarray(sourceOffset, sourceOffset + take),
                        normalizedChunkLength
                    );
                    normalizedChunkLength += take;
                    sourceOffset += take;
                }
                if (
                    normalizedChunkLength === chunkSize &&
                    readBytes < source.size
                ) {
                    await enqueueNormalizedChunk(normalizedChunk);
                    normalizedChunkLength = 0;
                }
            }
            ensureSourceSize(readBytes, source.size);
            if (normalizedChunkLength > 0) {
                await enqueueNormalizedChunk(
                    normalizedChunk.subarray(0, normalizedChunkLength)
                );
            }
            await putQueue.drain();
            updateQueueDiagnostics();
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
            await this.commitReadyManifest(
                manifest,
                pendingManifest,
                readyManifest
            );
            diagnostics.readyManifestFinishedAt = Date.now();
            diagnostics.chunkCount = chunkCount;
        } catch (error) {
            if (!sourceIteratorDone) {
                try {
                    const returned = sourceIterator?.return?.();
                    if (returned) {
                        void Promise.resolve(returned).catch(() => undefined);
                    }
                } catch {
                    // Best-effort cancellation; cleanup must not wait on a
                    // source whose current next() is blocked.
                }
            }
            await putQueue.settle();
            updateQueueDiagnostics();
            diagnostics.failureAt = Date.now();
            diagnostics.failureMessage =
                error instanceof Error ? error.message : String(error);
            await this.cleanupFailedUploadIfCurrent(
                manifest,
                pendingManifest?.entry.hash ?? pendingManifestHead,
                chunkEntryHeads,
                Math.max(expectedChunkCount, chunkCount)
            );
            throw error;
        }

        diagnostics.finishedAt = Date.now();
        progress?.(1);
        return uploadId;
    }

    private async cleanupChunkedUpload(
        uploadId: string,
        _expectedChunkCount: number,
        chunkEntryHeads: string[],
        preserveFailedCleanupState = false
    ) {
        let firstError: unknown;
        for (const [index, expectedHead] of chunkEntryHeads.entries()) {
            if (!expectedHead) {
                continue;
            }
            const chunkId = getChunkId(uploadId, index);
            let current: AbstractFile | undefined;
            let releaseExpectedHead = false;
            try {
                current = await this.files.index.get(chunkId, {
                    local: true,
                    remote: false,
                });
                if (
                    !isLargeFileChunk(current) ||
                    current.parentId !== uploadId ||
                    getContextHead(current) !== expectedHead
                ) {
                    releaseExpectedHead = true;
                    continue;
                }
                const targetEntry = await this.files.log.log.get(expectedHead);
                if (!targetEntry) {
                    throw new Error(
                        `Missing exact entry '${expectedHead}' while cleaning chunk '${chunkId}'`
                    );
                }
                try {
                    await this.files.del(chunkId, {
                        meta: { next: [targetEntry] },
                    });
                } catch (error) {
                    try {
                        current = await this.files.index.get(chunkId, {
                            local: true,
                            remote: false,
                        });
                    } catch {
                        throw error;
                    }
                    if (getContextHead(current) === expectedHead) {
                        throw error;
                    }
                }
                current = await this.files.index.get(chunkId, {
                    local: true,
                    remote: false,
                });
                if (getContextHead(current) === expectedHead) {
                    throw new Error(
                        `Exact chunk '${chunkId}' remained after deletion`
                    );
                }
                releaseExpectedHead = true;
            } catch (error) {
                firstError ??= error;
            } finally {
                if (releaseExpectedHead || !preserveFailedCleanupState) {
                    this.releaseOwnedEntryHead(expectedHead, uploadId, chunkId);
                    try {
                        current = await this.files.index.get(chunkId, {
                            local: true,
                            remote: false,
                        });
                        if (
                            !current ||
                            getContextHead(current) === expectedHead
                        ) {
                            this.forgetRetainedChunkRead(uploadId, chunkId);
                        }
                    } catch {
                        // Preserve id-level retention when replacement state cannot
                        // be established safely.
                    }
                }
            }
        }

        if (firstError) {
            throw firstError;
        }
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
            chunkPutConcurrencyLimit: LARGE_FILE_CHUNK_PUT_CONCURRENCY,
            chunkPutByteLimit: LARGE_FILE_CHUNK_PUT_BYTE_LIMIT,
            maxConcurrentChunkPuts: 0,
            maxConcurrentChunkPutBytes: 0,
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

        let pendingManifest:
            | Awaited<ReturnType<typeof this.putAuthoredFile>>
            | undefined;
        let pendingManifestHead: string | undefined;
        const hasher = new SHA256();
        const putQueue = new BoundedAsyncWorkQueue(
            LARGE_FILE_CHUNK_PUT_CONCURRENCY,
            LARGE_FILE_CHUNK_PUT_BYTE_LIMIT
        );
        const chunkEntryHeads: string[] = [];
        const updateQueueDiagnostics = () => {
            diagnostics.maxConcurrentChunkPuts = putQueue.peakCount;
            diagnostics.maxConcurrentChunkPutBytes = putQueue.peakBytes;
        };
        try {
            diagnostics.manifestStartedAt = Date.now();
            pendingManifest = await this.putAuthoredFile(
                manifest,
                undefined,
                (entryHead) => {
                    pendingManifestHead ??= entryHead;
                }
            );
            pendingManifestHead = pendingManifest.entry.hash;
            diagnostics.manifestFinishedAt = Date.now();
            let committedBytes = 0;
            for (let i = 0; i < chunkCount; i++) {
                putQueue.throwIfFailed();
                const readStartedAt = Date.now();
                const chunkBytes = await getChunk(i);
                putQueue.throwIfFailed();
                const readFinishedAt = Date.now();
                diagnostics.chunkReadTotalMs += readFinishedAt - readStartedAt;
                diagnostics.chunkReadMaxMs = Math.max(
                    diagnostics.chunkReadMaxMs,
                    readFinishedAt - readStartedAt
                );
                hasher.update(chunkBytes);
                await putQueue.enqueue(chunkBytes.byteLength, async () => {
                    // Reserve queue capacity before allocating the stable
                    // per-chunk copy counted by the byte limit.
                    const stableChunkBytes = new Uint8Array(chunkBytes);
                    const chunk = new TinyFile({
                        name: name + "/" + i,
                        file: stableChunkBytes,
                        parentId: uploadId,
                        index: i,
                    });
                    const putStartedAt = Date.now();
                    diagnostics.firstChunkStartedAt ??= putStartedAt;
                    const appended = await this.putAuthoredFile(
                        chunk,
                        undefined,
                        (entryHead) => {
                            chunkEntryHeads[i] ??= entryHead;
                        }
                    );
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
                    committedBytes += stableChunkBytes.byteLength;
                    progress?.(
                        Math.min(committedBytes / Math.max(Number(size), 1), 1)
                    );
                });
                updateQueueDiagnostics();
            }
            await putQueue.drain();
            updateQueueDiagnostics();
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
            await this.commitReadyManifest(
                manifest,
                pendingManifest,
                readyManifest
            );
            diagnostics.readyManifestFinishedAt = Date.now();
        } catch (error) {
            await putQueue.settle();
            updateQueueDiagnostics();
            diagnostics.failureAt = Date.now();
            diagnostics.failureMessage =
                error instanceof Error ? error.message : String(error);
            await this.cleanupFailedUploadIfCurrent(
                manifest,
                pendingManifest?.entry.hash ?? pendingManifestHead,
                chunkEntryHeads,
                chunkCount
            );
            throw error;
        }

        diagnostics.finishedAt = Date.now();
        progress?.(1);
        return uploadId;
    }

    private async removeFileUnlocked(file: AbstractFile) {
        if (isLargeFileLike(file)) {
            this.pendingLargeFileDeletions ??= new Map();
            let pending = this.pendingLargeFileDeletions.get(file.id);
            if (!pending) {
                try {
                    await this.files.del(file.id);
                } catch (error) {
                    await this.confirmRejectedDeleteCommitted(file.id, error);
                }
                pending = file;
                this.pendingLargeFileDeletions.set(file.id, pending);
            }

            const chunkEntryHeads = getCompleteChunkEntryHeads(pending);
            if (chunkEntryHeads) {
                await this.cleanupChunkedUpload(
                    pending.id,
                    pending.chunkCount,
                    chunkEntryHeads,
                    true
                );
                const rootHead = getContextHead(pending);
                if (rootHead) {
                    this.releaseOwnedEntryHead(
                        rootHead,
                        pending.id,
                        pending.id
                    );
                }
                const currentRoot = await this.files.index.get(pending.id, {
                    local: true,
                    remote: false,
                });
                if (isLargeFileLike(currentRoot)) {
                    this.retainedLargeFileChunkCounts.set(
                        pending.id,
                        currentRoot.chunkCount
                    );
                } else {
                    this.retainedLargeFileChunkCounts.delete(pending.id);
                }
            } else {
                await (toReadableLargeFile(pending) ?? pending).delete(this);
                this.releaseFileRetention(pending);
            }
            this.pendingLargeFileDeletions.delete(file.id);
            return;
        }

        const head = getContextHead(file);
        try {
            await this.files.del(file.id);
        } catch (error) {
            await this.confirmRejectedDeleteCommitted(file.id, error);
        }

        if (isLargeFileChunk(file)) {
            this.releaseChunkRetention(file.parentId, file.id, head);
            return;
        }

        this.releaseFileRetention(file);
    }

    private removeFile(file: AbstractFile) {
        return this.withFileMutation(file.id, () =>
            this.removeFileUnlocked(file)
        );
    }

    async removeById(id: string) {
        await this.withFileMutation(id, async () => {
            const pending = this.pendingLargeFileDeletions?.get(id);
            if (pending) {
                await this.removeFileUnlocked(pending);
                return;
            }
            let file = await this.files.index.get(id, {
                local: true,
                remote: false,
            });
            if (!file) {
                const remoteFrom = await this.getReadPeerHints();
                if (!remoteFrom?.length) {
                    throw new Error(
                        `Cannot confirm whether file '${id}' exists because no remote read peers are available`
                    );
                }
                const remoteMatches = await this.files.index.search(
                    new SearchRequest({
                        query: new StringMatch({
                            key: "id",
                            value: id,
                            caseInsensitive: false,
                            method: StringMatchMethod.exact,
                        }),
                        fetch: 0xffffffff,
                    }),
                    {
                        local: false,
                        remote: {
                            timeout: 10_000,
                            throwOnMissing: true,
                            retryMissingResponses: false,
                            replicate: true,
                            from: remoteFrom,
                        },
                    } as any
                );
                const remoteRoot = remoteMatches.find(
                    (candidate) =>
                        candidate.id === id && candidate.parentId == null
                );
                if (!remoteRoot) {
                    return;
                }
                file = await this.files.index.get(id, {
                    local: true,
                    remote: false,
                });
                if (!file || file.id !== id || file.parentId != null) {
                    throw new Error(
                        `Failed to materialize current remote file '${id}' for deletion`
                    );
                }
            }
            await this.removeFileUnlocked(file);
        });
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
            await this.removeFile(file);
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

    /**
     * Count exact manifest entry blocks that are present in the local block
     * store. This is deliberately separate from countLocalChunks(), which
     * reports Documents index rows. Persisted observer reads cache exact entry
     * blocks without joining them into the replication log or document index.
     *
     * Undefined means the manifest does not contain one valid entry head for
     * every chunk, so block locality cannot be measured by this fast path.
     */
    async countLocalChunkBlocks(
        parent: LargeFile
    ): Promise<number | undefined> {
        const candidateHeads = getCompleteChunkEntryHeads(parent);
        if (!candidateHeads) {
            return undefined;
        }

        const blocks = this.files.log.log.blocks;
        const local =
            typeof blocks.hasMany === "function"
                ? await blocks.hasMany(candidateHeads)
                : await Promise.all(
                      candidateHeads.map((head) => blocks.has(head))
                  );
        return local.reduce((count, present) => count + (present ? 1 : 0), 0);
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

    private withFileMutation<T>(id: string, operation: () => Promise<T>) {
        this.fileMutationTails ??= new Map();
        const previous = this.fileMutationTails.get(id) ?? Promise.resolve();
        const result = previous.then(operation, operation);
        const tail = result.then(
            () => undefined,
            () => undefined
        );
        this.fileMutationTails.set(id, tail);
        return result.finally(() => {
            if (this.fileMutationTails.get(id) === tail) {
                this.fileMutationTails.delete(id);
            }
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

    private clearFileRuntimeState() {
        this.activeFileChangeSignals ??= new Set();
        for (const signal of [...this.activeFileChangeSignals]) {
            signal.close();
        }
        this.activeFileChangeSignals.clear();
        this.retainedChunkIds?.clear();
        this.retainedChunkIdsByFileId?.clear();
        this.retainedLargeFileChunkCounts?.clear();
        this.retainedChunkEntryHeads?.clear();
        this.retainedEntryHeadsByFileId?.clear();
        this.retainedEntryHeadsByDocumentId?.clear();
        this.retainedChunkEntryHeadOwners?.clear();
        this.retainedEntryHeadDocumentIds?.clear();
        this.unscopedRetainedChunkEntryHeads?.clear();
        this.pendingAuthoredDocumentIds?.clear();
        this.fileMutationTails?.clear();
        this.pendingLargeFileDeletions?.clear();
    }

    async close(from?: Program): Promise<boolean> {
        const closed = await super.close(from);
        if (closed) {
            this.clearFileRuntimeState();
        }
        return closed;
    }

    async drop(from?: Program): Promise<boolean> {
        const dropped = await super.drop(from);
        if (dropped) {
            this.clearFileRuntimeState();
        }
        return dropped;
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
