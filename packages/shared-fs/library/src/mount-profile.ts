import { open, unlink } from "node:fs/promises";
import { finished } from "node:stream/promises";
import type { Writable } from "node:stream";

export const SHARED_FS_MOUNT_PROFILE_SCHEMA = "peerbit.shared-fs.mount-profile";
export const SHARED_FS_MOUNT_PROFILE_SCHEMA_VERSION = 1;

export type SharedFsMountProfileSource =
    | "fuse-native"
    | "native-adapter"
    | "node-daemon";

export type SharedFsMountProfilePhase =
    | "native.callback"
    | "ipc.queue"
    | "ipc.roundTrip"
    | "ipc.service"
    | "mount.localCommit"
    | "mount.target.writeFile"
    | "profile.start"
    | "profile.summary";

export type SharedFsMountProfileDetailValue = string | number | boolean;

/**
 * One opt-in timing observation from the mounted I/O path.
 *
 * `startUnixNs` is a decimal Unix-epoch nanosecond string (it exceeds 2^53, so
 * it is not a JSON number); it anchors records from different processes on
 * the same host. `durationNs` is a monotonic elapsed duration.
 */
export type SharedFsMountProfileEvent = {
    schema: typeof SHARED_FS_MOUNT_PROFILE_SCHEMA;
    schemaVersion: typeof SHARED_FS_MOUNT_PROFILE_SCHEMA_VERSION;
    source: SharedFsMountProfileSource;
    phase: SharedFsMountProfilePhase;
    operation: string;
    startUnixNs: string;
    durationNs: number;
    ok: boolean;
    /** Phase-specific, bounded scalar context. */
    detail?: Readonly<Record<string, SharedFsMountProfileDetailValue>>;
};

/**
 * Report-only sink. Exceptions are isolated from filesystem operations. A sink
 * runs on the mount path, so it must return quickly; use
 * {@link createSharedFsMountProfileWriter} for bounded asynchronous output.
 */
export type SharedFsMountProfileSink = (
    event: SharedFsMountProfileEvent
) => void;

type ProfileEventIdentity = {
    source: SharedFsMountProfileSource;
    phase: SharedFsMountProfilePhase;
    operation: string;
    detail?: Readonly<Record<string, SharedFsMountProfileDetailValue>>;
};

// Pair one wall-clock reading with the monotonic clock once, then derive every
// record's Unix start from the monotonic reading that also times its duration.
// performance.timeOrigin + performance.now() is the process's high-resolution
// wall-clock estimate; both it and process.hrtime use a monotonic source.
const UNIX_ANCHOR_NS = BigInt(
    Math.round((performance.timeOrigin + performance.now()) * 1e6)
);
const MONOTONIC_ANCHOR_NS = process.hrtime.bigint();

/** @internal Convert a process.hrtime.bigint() reading to Unix nanoseconds. */
export const sharedFsMountProfileUnixNs = (monotonicNs: bigint) =>
    (UNIX_ANCHOR_NS + (monotonicNs - MONOTONIC_ANCHOR_NS)).toString();

const elapsedNs = (started: bigint) => {
    const value = process.hrtime.bigint() - started;
    if (value < 0n) return 0;
    return Number(
        value > BigInt(Number.MAX_SAFE_INTEGER)
            ? BigInt(Number.MAX_SAFE_INTEGER)
            : value
    );
};

/**
 * @internal Errno-like code for a failed phase: the error's own string `code`
 * when it has one, otherwise EIO (what an uncoded failure surfaces as).
 */
export const sharedFsMountProfileErrorCode = (error: unknown): string => {
    const code =
        error !== null && typeof error === "object"
            ? Reflect.get(error, "code")
            : undefined;
    return typeof code === "string" && /^E[A-Z0-9_]{1,31}$/u.test(code)
        ? code
        : "EIO";
};

/** @internal A broken observer must never break mounted I/O. */
export const emitSharedFsMountProfile = (
    sink: SharedFsMountProfileSink | undefined,
    event: SharedFsMountProfileEvent
) => {
    if (!sink) return;
    try {
        // TypeScript deliberately permits value-returning functions (including
        // async functions) where a void observer is expected. Inspect the
        // runtime result without narrowing that convenient public callback
        // type, and immediately consume a possible asynchronous rejection.
        const pending = (sink as (value: SharedFsMountProfileEvent) => unknown)(
            event
        );
        if (
            pending !== null &&
            (typeof pending === "object" || typeof pending === "function") &&
            typeof Reflect.get(pending, "then") === "function"
        ) {
            void Promise.resolve(pending).catch(() => {});
        }
    } catch {
        // Profiling is observational. Sink failures are deliberately ignored.
    }
};

/**
 * @internal Emit one completed phase that started at `started`
 * (process.hrtime.bigint()) and return its measured duration.
 */
export const finishSharedFsMountProfile = (
    sink: SharedFsMountProfileSink,
    identity: ProfileEventIdentity,
    started: bigint,
    ok: boolean,
    extraDetail?: Readonly<Record<string, SharedFsMountProfileDetailValue>>
) => {
    const durationNs = elapsedNs(started);
    const detail =
        identity.detail && extraDetail
            ? { ...identity.detail, ...extraDetail }
            : (identity.detail ?? extraDetail);
    const event: SharedFsMountProfileEvent = {
        schema: SHARED_FS_MOUNT_PROFILE_SCHEMA,
        schemaVersion: SHARED_FS_MOUNT_PROFILE_SCHEMA_VERSION,
        source: identity.source,
        phase: identity.phase,
        operation: identity.operation,
        startUnixNs: sharedFsMountProfileUnixNs(started),
        durationNs,
        ok,
    };
    if (detail) event.detail = detail;
    emitSharedFsMountProfile(sink, event);
    return durationNs;
};

/** @internal Begin a callback-shaped phase after the caller opted in. */
export const beginSharedFsMountProfile = (
    sink: SharedFsMountProfileSink,
    identity: ProfileEventIdentity
) => {
    const started = process.hrtime.bigint();
    return (
        ok: boolean,
        extraDetail?: Readonly<Record<string, SharedFsMountProfileDetailValue>>
    ) => finishSharedFsMountProfile(sink, identity, started, ok, extraDetail);
};

/**
 * Time an async phase after its caller has established that a sink exists.
 * A failure records `detail.code` without replacing the operation's error.
 * @internal
 */
export const profileSharedFsMountOperation = async <T>(
    sink: SharedFsMountProfileSink,
    identity: ProfileEventIdentity,
    operation: () => Promise<T>,
    errorCode: (error: unknown) => string = sharedFsMountProfileErrorCode
): Promise<T> => {
    const started = process.hrtime.bigint();
    try {
        const result = await operation();
        finishSharedFsMountProfile(sink, identity, started, true);
        return result;
    } catch (error) {
        finishSharedFsMountProfile(sink, identity, started, false, {
            code: errorCode(error),
        });
        throw error;
    }
};

export type SharedFsMountProfileWriterOptions = {
    /** Events accepted but not yet serialized (default 16384). */
    maxQueuedEvents?: number;
    /** Serialized bytes waiting in the output stream (default 8 MiB). */
    maxQueuedBytes?: number;
    /** Source written on the writer's own start/summary records. */
    source?: SharedFsMountProfileSource;
    /**
     * Upper bound for `close()` (default 5000 ms). A profile output that stops
     * making progress is destroyed after this and its in-flight events are
     * counted as lost, so a wedged disk cannot hang mount shutdown.
     */
    closeTimeoutMs?: number;
};

export type SharedFsMountProfileWriterStats = {
    /** Events offered to the sink while the writer was open. */
    emitted: number;
    /** Events whose serialized bytes the output confirmed. */
    written: number;
    /** Events rejected by a full queue or a failed output. */
    dropped: number;
    /** Events serialized but lost to an output error or a close timeout. */
    lost: number;
    /** Events offered after close began; never written. */
    droppedAfterClose: number;
    writeErrors: number;
    /** close() hit its time bound and destroyed the output. */
    closeTimedOut: boolean;
    maxQueuedEvents: number;
    maxQueuedBytes: number;
};

export type SharedFsMountProfileWriter = {
    /** Never blocks and never throws; excess events are counted as dropped. */
    readonly sink: SharedFsMountProfileSink;
    stats(): SharedFsMountProfileWriterStats;
    /**
     * Stop admission, flush accepted events, append a `profile.summary`
     * record with the final counters, and end the output stream. Bounded by
     * `closeTimeoutMs`; it resolves (never rejects) with the final counters.
     */
    close(): Promise<SharedFsMountProfileWriterStats>;
};

const DEFAULT_MAX_QUEUED_EVENTS = 16_384;
const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

const positiveInteger = (value: number | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(
            `Profile writer bounds must be positive integers: ${value}`
        );
    }
    return value;
};

const resolveWriterOptions = (options: SharedFsMountProfileWriterOptions) => ({
    maxQueuedEvents: positiveInteger(
        options.maxQueuedEvents,
        DEFAULT_MAX_QUEUED_EVENTS
    ),
    maxQueuedBytes: positiveInteger(
        options.maxQueuedBytes,
        DEFAULT_MAX_QUEUED_BYTES
    ),
    closeTimeoutMs: positiveInteger(
        options.closeTimeoutMs,
        DEFAULT_CLOSE_TIMEOUT_MS
    ),
    source: options.source ?? "node-daemon",
});

type ProfileBatch = { events: number; settled: boolean };

/**
 * Bounded asynchronous NDJSON writer for mount profile events.
 *
 * The sink only appends to an in-memory queue (bounded by event count) and
 * schedules one batch serialization on a later macrotask. Batches go to the
 * output stream without awaiting it; while the stream holds `maxQueuedBytes`
 * or more unwritten bytes, new events are dropped and counted. The mount path
 * therefore never waits for disk, and memory stays bounded.
 */
export const createSharedFsMountProfileWriter = (
    output: Writable,
    options: SharedFsMountProfileWriterOptions = {}
): SharedFsMountProfileWriter => {
    const { maxQueuedEvents, maxQueuedBytes, closeTimeoutMs, source } =
        resolveWriterOptions(options);
    const openedAt = process.hrtime.bigint();
    const counters = {
        emitted: 0,
        written: 0,
        dropped: 0,
        lost: 0,
        droppedAfterClose: 0,
        writeErrors: 0,
    };
    let pending: SharedFsMountProfileEvent[] = [];
    let scheduled: NodeJS.Immediate | undefined;
    let closed = false;
    let closeTimedOut = false;
    let failed = false;
    let closing: Promise<SharedFsMountProfileWriterStats> | undefined;
    const inFlight = new Set<ProfileBatch>();
    let idleWaiters: Array<() => void> = [];

    const stats = (): SharedFsMountProfileWriterStats => ({
        ...counters,
        closeTimedOut,
        maxQueuedEvents,
        maxQueuedBytes,
    });

    const releaseIdleWaiters = () => {
        if (inFlight.size === 0 && idleWaiters.length > 0) {
            const waiters = idleWaiters;
            idleWaiters = [];
            for (const resolve of waiters) resolve();
        }
    };

    // Each batch is counted exactly once: by its write callback, or as lost
    // when close() gives up on a stalled output.
    const settleBatch = (batch: ProfileBatch, error?: unknown) => {
        if (batch.settled) return;
        batch.settled = true;
        inFlight.delete(batch);
        if (error) counters.lost += batch.events;
        else counters.written += batch.events;
        releaseIdleWaiters();
    };

    const onOutputError = () => {
        failed = true;
        counters.writeErrors++;
    };
    output.on("error", onOutputError);

    const writeLines = (text: string, events: number) => {
        const batch: ProfileBatch = { events, settled: false };
        inFlight.add(batch);
        try {
            output.write(text, (error) => settleBatch(batch, error));
        } catch (error) {
            failed = true;
            counters.writeErrors++;
            settleBatch(batch, error ?? new Error("profile write failed"));
        }
    };

    const drain = () => {
        scheduled = undefined;
        if (pending.length === 0) return;
        const batch = pending;
        pending = [];
        if (failed) {
            counters.dropped += batch.length;
            return;
        }
        let text = "";
        for (const event of batch) text += `${JSON.stringify(event)}\n`;
        writeLines(text, batch.length);
    };

    const meta = (
        phase: "profile.start" | "profile.summary",
        operation: string,
        durationNs: number,
        ok: boolean,
        detail: Record<string, SharedFsMountProfileDetailValue>
    ): SharedFsMountProfileEvent => ({
        schema: SHARED_FS_MOUNT_PROFILE_SCHEMA,
        schemaVersion: SHARED_FS_MOUNT_PROFILE_SCHEMA_VERSION,
        source,
        phase,
        operation,
        startUnixNs: sharedFsMountProfileUnixNs(openedAt),
        durationNs,
        ok,
        detail,
    });

    writeLines(
        `${JSON.stringify(
            meta("profile.start", "open", 0, true, {
                pid: process.pid,
                maxQueuedEvents,
                maxQueuedBytes,
            })
        )}\n`,
        0
    );

    const sink: SharedFsMountProfileSink = (event) => {
        if (closed) {
            counters.droppedAfterClose++;
            return;
        }
        counters.emitted++;
        if (
            failed ||
            pending.length >= maxQueuedEvents ||
            output.writableLength >= maxQueuedBytes
        ) {
            counters.dropped++;
            return;
        }
        pending.push(event);
        scheduled ??= setImmediate(drain);
    };

    const flushAndEnd = async () => {
        if (inFlight.size > 0) {
            await new Promise<void>((resolve) => idleWaiters.push(resolve));
        }
        if (closeTimedOut) return;
        const final = stats();
        if (!failed) {
            writeLines(
                `${JSON.stringify(
                    meta(
                        "profile.summary",
                        "close",
                        elapsedNs(openedAt),
                        final.writeErrors === 0,
                        {
                            pid: process.pid,
                            emitted: final.emitted,
                            written: final.written,
                            dropped: final.dropped,
                            lost: final.lost,
                            droppedAfterClose: final.droppedAfterClose,
                            writeErrors: final.writeErrors,
                            maxQueuedEvents,
                            maxQueuedBytes,
                        }
                    )
                )}\n`,
                0
            );
        }
        output.end();
        try {
            await finished(output);
        } catch {
            // The error listener (kept attached so a late error cannot
            // become an uncaught exception) already counted the failure.
        }
    };

    const close = () => {
        closing ??= (async () => {
            closed = true;
            if (scheduled) clearImmediate(scheduled);
            drain();
            let timer: NodeJS.Timeout | undefined;
            const deadline = new Promise<"timeout">((resolve) => {
                timer = setTimeout(() => resolve("timeout"), closeTimeoutMs);
                // Do not keep an otherwise finished process alive.
                timer.unref?.();
            });
            const outcome = await Promise.race([
                flushAndEnd().then(() => "flushed" as const),
                deadline,
            ]);
            clearTimeout(timer);
            if (outcome === "timeout") {
                closeTimedOut = true;
                for (const batch of [...inFlight]) {
                    settleBatch(batch, new Error("profile close timed out"));
                }
                output.destroy();
            }
            return stats();
        })();
        return closing;
    };

    return { sink, stats, close };
};

/**
 * Create `path` exclusively (an existing file is never truncated or appended
 * to) and return a bounded writer for it.
 */
export const openSharedFsMountProfileFile = async (
    path: string,
    options: SharedFsMountProfileWriterOptions = {}
): Promise<SharedFsMountProfileWriter> => {
    // Reject invalid bounds before creating the file, so a bad call neither
    // leaks a handle nor leaves an empty file that blocks an exclusive retry.
    resolveWriterOptions(options);
    const handle = await open(path, "wx");
    try {
        return createSharedFsMountProfileWriter(
            handle.createWriteStream(),
            options
        );
    } catch (error) {
        await handle.close().catch(() => {});
        await unlink(path).catch(() => {});
        throw error;
    }
};
