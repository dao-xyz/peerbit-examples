import type { PlacementErrorInfo } from "./adaptive-placement-telemetry.js";

export type PlacementEntryContext = {
    request: number;
    plane: "chunks" | "metadata";
    file: number;
    part?: number;
    documentId: string;
    bytes: number;
    logAddress: string;
    requestedMinAcks: 2 | 3;
};
type Failure = {
    name?: string;
    message?: string;
    localCommitSucceeded?: boolean;
    retrySafe?: boolean;
    committedHashes?: string[];
    committedHashesOmitted?: number;
};
export type PlacementEntryTimelineRecord = {
    seq: number;
    status: "pending" | "fulfilled" | "rejected";
    invocationAtMs: number | null;
    resultAtMs?: number | null;
    elapsedMs?: number | null;
    context: PlacementEntryContext;
    committedEntryHash?: string;
    failure?: Failure;
};

const MAX = Number.MAX_SAFE_INTEGER;
const add = (value: number, amount = 1) => Math.min(MAX, value + amount);
const count = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 512;

/** Synchronous test observer only: never wraps, waits for, or changes a write. */
export const createPlacementEntryTimeline = (options?: {
    now?: () => number;
}) => {
    const records: PlacementEntryTimelineRecord[] = [];
    // null owns an omitted span; undefined means no operation is pending.
    let active: PlacementEntryTimelineRecord | null | undefined;
    let omitted = 0;
    let invalid = 0;
    let sequence = 0;
    const fault = () => {
        invalid = add(invalid);
    };
    const read = (input: unknown, key: string): unknown => {
        try {
            if (input === null || typeof input !== "object") return undefined;
            const descriptor = Object.getOwnPropertyDescriptor(input, key);
            if (!descriptor) return undefined;
            if ("value" in descriptor) return descriptor.value;
        } catch {
            /* Count inaccessible fields without invoking accessors. */
        }
        fault();
        return undefined;
    };
    const requestedClock = read(options, "now");
    if (requestedClock !== undefined && typeof requestedClock !== "function")
        fault();
    const now =
        typeof requestedClock === "function"
            ? requestedClock
            : () => performance.now();
    const clock = (): number | null => {
        try {
            const value: unknown = now();
            if (
                typeof value === "number" &&
                Number.isFinite(value) &&
                value >= 0 &&
                value <= MAX
            )
                return value;
        } catch {
            /* Diagnostic clocks cannot alter the operation outcome. */
        }
        fault();
        return null;
    };
    const begin = (input: PlacementEntryContext): void => {
        if (active !== undefined) {
            fault();
            return;
        }
        const invalidBefore = invalid;
        const request = read(input, "request");
        const plane = read(input, "plane");
        const file = read(input, "file");
        const part = read(input, "part");
        const documentId = read(input, "documentId");
        const bytes = read(input, "bytes");
        const logAddress = read(input, "logAddress");
        const requestedMinAcks = read(input, "requestedMinAcks");
        if (invalid !== invalidBefore) return;
        if (
            !count(request) ||
            request === 0 ||
            (plane !== "chunks" && plane !== "metadata") ||
            !count(file) ||
            (part !== undefined && !count(part)) ||
            !text(documentId) ||
            !count(bytes) ||
            !text(logAddress) ||
            (requestedMinAcks !== 2 && requestedMinAcks !== 3)
        ) {
            fault();
            return;
        }
        sequence = add(sequence);
        if (records.length === 128) {
            omitted = add(omitted);
            active = null;
            return;
        }
        active = {
            seq: sequence,
            status: "pending",
            invocationAtMs: clock(),
            context: {
                request,
                plane,
                file,
                ...(part === undefined ? {} : { part }),
                documentId,
                bytes,
                logAddress,
                requestedMinAcks,
            },
        };
        records.push(active);
    };
    const settle = (status: "fulfilled" | "rejected") => {
        const record = active;
        active = undefined;
        if (record === undefined) fault();
        if (record === null) clock();
        if (!record) return undefined;
        record.status = status;
        const result = clock();
        const backwards =
            result !== null &&
            record.invocationAtMs !== null &&
            result < record.invocationAtMs;
        if (backwards) fault();
        record.resultAtMs = backwards ? null : result;
        record.elapsedMs =
            record.resultAtMs !== null && record.invocationAtMs !== null
                ? record.resultAtMs - record.invocationAtMs
                : null;
        return record;
    };
    const fulfilled = () => {
        const record = settle("fulfilled");
        if (!record) return;
        let used = false;
        // The caller materializes its normal result exactly once after the
        // settlement timestamp. This one-shot recorder stays bound to this span.
        return (extractHash: () => unknown): void => {
            if (used) {
                fault();
                return;
            }
            used = true;
            let hash: unknown;
            try {
                hash = extractHash();
            } catch {
                fault();
                return;
            }
            if (text(hash)) record.committedEntryHash = hash;
            else fault();
        };
    };
    const rejected = (evidence: PlacementErrorInfo): void => {
        // A later IPC reply error must not reject a previously settled put.
        if (active === undefined) return;
        const record = settle("rejected");
        if (!record) return;
        const failure: Failure = {};
        record.failure = failure;
        if (evidence === null || typeof evidence !== "object") {
            fault();
            return;
        }
        for (const key of ["name", "message"] as const) {
            const value = read(evidence, key);
            if (typeof value === "string") {
                if (value.length > 512) fault();
                failure[key] = value.slice(0, 512);
            } else if (value !== undefined) fault();
        }
        for (const key of ["localCommitSucceeded", "retrySafe"] as const) {
            const value = read(evidence, key);
            if (typeof value === "boolean") failure[key] = value;
            else if (value !== undefined) fault();
        }
        const hashes = read(evidence, "committedHashes");
        const priorOmitted = read(evidence, "committedHashesOmitted");
        let missing = count(priorOmitted) ? priorOmitted : 0;
        if (priorOmitted !== undefined && !count(priorOmitted)) fault();
        if (hashes !== undefined) {
            // Array.isArray can itself throw for a revoked proxy.
            try {
                const length = Array.isArray(hashes)
                    ? read(hashes, "length")
                    : undefined;
                if (!count(length)) fault();
                else {
                    failure.committedHashes = [];
                    missing = add(missing, Math.max(0, length - 8));
                    for (let index = 0; index < Math.min(8, length); index++) {
                        const hash = read(hashes, String(index));
                        if (text(hash)) failure.committedHashes.push(hash);
                        else {
                            fault();
                            missing = add(missing);
                        }
                    }
                }
            } catch {
                fault();
            }
        }
        if (missing) failure.committedHashesOmitted = missing;
    };
    return {
        begin,
        fulfilled,
        rejected,
        snapshot: () => ({
            schema: 1 as const,
            clock: "writer-process.performance.now" as const,
            records: records.map((record) => ({
                ...record,
                context: { ...record.context },
                ...(record.failure
                    ? {
                          failure: {
                              ...record.failure,
                              ...(record.failure.committedHashes
                                  ? {
                                        committedHashes: [
                                            ...record.failure.committedHashes,
                                        ],
                                    }
                                  : {}),
                          },
                      }
                    : {}),
            })),
            omitted,
            invalid,
        }),
    };
};
