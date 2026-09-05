/**
 * One opt-in monotonic timing observation from the mounted I/O path.
 *
 * Durations use nanoseconds so the TypeScript and native Go adapter can emit
 * the same report shape. They are elapsed durations, never wall-clock times.
 */
export type SharedFsMountProfileEvent = {
    schema: "peerbit.shared-fs.mount-profile.v1";
    source: "fuse-native" | "native-adapter" | "node-daemon";
    phase:
        | "native.callback"
        | "ipc.queue"
        | "ipc.roundTrip"
        | "ipc.service"
        | "mount.fsync.localCommit"
        | "mount.target.writeFile";
    operation: string;
    durationNs: number;
    ok: boolean;
    /** Phase-specific, bounded scalar context. */
    detail?: Readonly<Record<string, string | number | boolean>>;
};

/**
 * Report-only sink. Exceptions are isolated from filesystem operations.
 */
export type SharedFsMountProfileSink = (
    event: SharedFsMountProfileEvent
) => void;

export type SharedFsMountProfileSource = SharedFsMountProfileEvent["source"];
export type SharedFsMountProfilePhase = SharedFsMountProfileEvent["phase"];

const elapsedNs = (started: bigint) => {
    const value = process.hrtime.bigint() - started;
    return Number(
        value > BigInt(Number.MAX_SAFE_INTEGER)
            ? BigInt(Number.MAX_SAFE_INTEGER)
            : value
    );
};

/** @internal Begin a synchronous-or-callback phase after the caller opted in. */
export const beginSharedFsMountProfile = (
    sink: SharedFsMountProfileSink,
    event: Omit<SharedFsMountProfileEvent, "schema" | "durationNs" | "ok">
) => {
    const started = process.hrtime.bigint();
    return (ok: boolean) =>
        emitSharedFsMountProfile(sink, {
            schema: "peerbit.shared-fs.mount-profile.v1",
            ...event,
            durationNs: elapsedNs(started),
            ok,
        });
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
            // A callback declared `async` is assignable to ordinary observer
            // APIs. Attach the rejection handler immediately without awaiting
            // it so reporting remains out of the filesystem result path.
            void Promise.resolve(pending).catch(() => {});
        }
    } catch {
        // Profiling is observational. Sink failures are deliberately ignored.
    }
};

/**
 * Time an async phase after its caller has established that a sink exists.
 * @internal
 */
export const profileSharedFsMountOperation = async <T>(
    sink: SharedFsMountProfileSink,
    event: Omit<SharedFsMountProfileEvent, "schema" | "durationNs" | "ok">,
    operation: () => Promise<T>
): Promise<T> => {
    const started = process.hrtime.bigint();
    try {
        const result = await operation();
        emitSharedFsMountProfile(sink, {
            schema: "peerbit.shared-fs.mount-profile.v1",
            ...event,
            durationNs: elapsedNs(started),
            ok: true,
        });
        return result;
    } catch (error) {
        emitSharedFsMountProfile(sink, {
            schema: "peerbit.shared-fs.mount-profile.v1",
            ...event,
            durationNs: elapsedNs(started),
            ok: false,
        });
        throw error;
    }
};
