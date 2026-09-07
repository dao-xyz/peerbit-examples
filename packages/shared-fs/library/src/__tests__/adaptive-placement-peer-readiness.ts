import { PublicSignKey } from "@peerbit/crypto";
import type { PersistedReceiptPeerReadiness } from "@peerbit/shared-log";
import {
    errorInfo,
    type PlacementErrorInfo,
} from "./adaptive-placement-telemetry.js";

type Plane = "chunks" | "metadata";
type ReadinessLog = {
    address: string;
    getPersistedReceiptPeerReadiness(
        key: PublicSignKey,
        options: { diagnostics: true }
    ): Promise<PersistedReceiptPeerReadiness>;
};

export type PlacementPeerReadinessInput = {
    observerHash: string;
    candidates: readonly { peer: number; key: PublicSignKey }[];
    logs: readonly {
        plane: Plane;
        log: ReadinessLog;
        committedEntryHash?: string;
    }[];
    now?: () => number;
};

type RecordContext = {
    observerHash: string;
    remoteHash: string;
    peer: number;
    plane: Plane;
    logAddress: string;
    committedEntryHash?: string;
    invocationAtMs: number;
    resultAtMs: number;
    elapsedMs: number;
};
export type PlacementPeerReadinessRecord = RecordContext &
    (
        | { status: "fulfilled"; snapshot: PersistedReceiptPeerReadiness }
        | { status: "rejected"; error: PlacementErrorInfo }
    );

const boundedText = (value: string, label: string): string => {
    if (typeof value !== "string" || value.length === 0 || value.length > 512)
        throw new RangeError(`${label} must contain 1–512 characters`);
    return value;
};

/**
 * Test-only, non-atomic, advisory observations of at most ten current
 * peer/plane bindings. No entries, replicas, planning, recovery or waiters are
 * requested. Even "ready" is neither entry leadership nor a durability proof.
 * Every issued inspection remains owned until it settles; no timeout races.
 */
export const capturePlacementPeerReadiness = async (
    input: PlacementPeerReadinessInput
): Promise<PlacementPeerReadinessRecord[]> => {
    const observerHash = boundedText(input.observerHash, "observerHash");
    if (!Array.isArray(input.candidates) || input.candidates.length > 5)
        throw new RangeError("At most five remote candidates are allowed");
    if (!Array.isArray(input.logs) || input.logs.length > 2)
        throw new RangeError("At most two log planes are allowed");
    const peers = new Set<number>();
    const hashes = new Set<string>();
    const candidates = input.candidates.map(({ peer, key }) => {
        if (!Number.isSafeInteger(peer) || peer < 0 || peers.has(peer))
            throw new RangeError(
                "Candidate peer numbers must be distinct nonnegative integers"
            );
        if (!(key instanceof PublicSignKey))
            throw new TypeError(
                "Candidate key must be an actual PublicSignKey"
            );
        const remoteHash = boundedText(key.hashcode(), "remoteHash");
        if (remoteHash === observerHash || hashes.has(remoteHash))
            throw new RangeError(
                "Candidate hashes must identify distinct remote peers"
            );
        peers.add(peer);
        hashes.add(remoteHash);
        return { peer, key, remoteHash };
    });
    const planes = new Set<Plane>();
    const addresses = new Set<string>();
    let committedPlanes = 0;
    const logs = input.logs.map(({ plane, log, committedEntryHash }) => {
        if ((plane !== "chunks" && plane !== "metadata") || planes.has(plane))
            throw new RangeError(
                "Log planes must be distinct chunks or metadata"
            );
        const logAddress = boundedText(log.address, "logAddress");
        if (addresses.has(logAddress))
            throw new RangeError("Log addresses must be distinct");
        const inspect = log.getPersistedReceiptPeerReadiness;
        if (typeof inspect !== "function")
            throw new TypeError("Log must expose the public readiness getter");
        if (committedEntryHash !== undefined) {
            boundedText(committedEntryHash, "committedEntryHash");
            if (++committedPlanes > 1)
                throw new RangeError(
                    "Only the failed plane may carry a committed entry hash"
                );
        }
        planes.add(plane);
        addresses.add(logAddress);
        return { plane, log, logAddress, inspect, committedEntryHash };
    });
    const now = input.now ?? (() => performance.now());
    if (typeof now !== "function")
        throw new TypeError("now must be a function");
    const clock = () => {
        const value = now();
        if (
            !Number.isFinite(value) ||
            value < 0 ||
            value > Number.MAX_SAFE_INTEGER
        )
            throw new RangeError(
                "Diagnostic timestamp must be finite and nonnegative"
            );
        return value;
    };
    // Admission and all callable/identity captures finish before the first call.
    const tasks = candidates.flatMap(({ peer, key, remoteHash }) =>
        logs.map(
            async ({
                plane,
                log,
                logAddress,
                inspect,
                committedEntryHash,
            }): Promise<PlacementPeerReadinessRecord> => {
                const invocationAtMs = clock();
                let outcome:
                    | {
                          status: "fulfilled";
                          snapshot: PersistedReceiptPeerReadiness;
                      }
                    | { status: "rejected"; error: PlacementErrorInfo };
                try {
                    // Upstream promises a bounded, payload-free, JSON-safe public view.
                    // Native cloning detaches it; do not invent another serializer.
                    const snapshot = structuredClone(
                        await inspect.call(log, key, { diagnostics: true })
                    );
                    outcome = { status: "fulfilled", snapshot };
                } catch (error) {
                    outcome = { status: "rejected", error: errorInfo(error) };
                }
                const resultAtMs = clock();
                if (resultAtMs < invocationAtMs)
                    throw new RangeError("Diagnostic clock moved backwards");
                return {
                    observerHash,
                    remoteHash,
                    peer,
                    plane,
                    logAddress,
                    ...(committedEntryHash === undefined
                        ? {}
                        : { committedEntryHash }),
                    invocationAtMs,
                    resultAtMs,
                    elapsedMs: resultAtMs - invocationAtMs,
                    ...outcome,
                };
            }
        )
    );
    // Even an injected-clock fault must not orphan already issued inspections.
    const settled = await Promise.allSettled(tasks);
    const faults = settled.filter((item) => item.status === "rejected");
    if (faults.length)
        throw new AggregateError(
            faults.map((item) => item.reason),
            "Readiness diagnostic failed after all inspections settled"
        );
    return settled.flatMap((item) =>
        item.status === "fulfilled" ? [item.value] : []
    );
};
