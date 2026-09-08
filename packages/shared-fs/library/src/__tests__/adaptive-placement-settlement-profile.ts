import { readPlacementDataField as field } from "./adaptive-placement-telemetry.js";

const PREFIX = "sharedLog.persistedDelivery.";
const MAX = Number.MAX_SAFE_INTEGER;
const families = [
    "plan",
    "candidate",
    "peerPhase",
    "progress",
    "settle",
] as const;
type Family = (typeof families)[number];
export type PlacementSettlementOperation = {
    request: number;
    kind: "put" | "barrier";
    file?: number;
    part?: number;
};
type RecordEvent = {
    seq: number;
    name: string;
    component: "shared-log";
    traceId: string;
    entries: number;
    peer?: string;
    durationMs: number;
    details: Record<string, string | number>;
    receivedAtMs: number | null;
};
type Trace = {
    traceId: string;
    operation?: PlacementSettlementOperation;
    events: RecordEvent[];
    terminal?: RecordEvent;
};
const isCount = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isTime = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
const isText = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 128;

/** Test-only v1 observations; trace IDs are process-local, not entry identities. */
export const createPlacementSettlementProfile = (options: {
    runId: string;
    peer: number;
    generation: number;
    plane: "chunks" | "metadata";
    observerHash: string;
    now?: () => number;
}) => {
    const { runId, peer, generation, plane, observerHash } = options;
    if (
        !isText(runId) ||
        runId.length > 64 ||
        !isCount(peer) ||
        !isCount(generation) ||
        generation === 0 ||
        (plane !== "chunks" && plane !== "metadata") ||
        !isText(observerHash) ||
        (options.now !== undefined && typeof options.now !== "function")
    )
        throw new TypeError("Invalid settlement collector namespace or clock");
    const now = options.now ?? (() => performance.now());
    let logAddress: string | null = null;
    const traces: Trace[] = [];
    let saturated = false;
    const counters = {
        matchingEvents: 0,
        invalidEvents: 0,
        unsupportedVersions: 0,
        unknownFamilies: 0,
        unboundEvents: 0,
        lateEvents: 0,
        detailDroppedEvents: 0,
        capacityDroppedEvents: 0,
        terminalCapacityDroppedEvents: 0,
        evictedTraces: 0,
        evictedEvents: 0,
        operationConflicts: 0,
    };
    const increment = (key: keyof typeof counters, by = 1) => {
        // Saturated arrival sequences are no longer unique; expose that limit.
        if (counters[key] >= MAX - by) {
            saturated = true;
            counters[key] = MAX;
        } else counters[key] += by;
    };
    const clock = () => {
        try {
            const value = now();
            if (isTime(value)) return value;
        } catch {
            /* Observation only. */
        }
        increment("invalidEvents");
        return null;
    };
    const operationCopy = (
        input: PlacementSettlementOperation | undefined
    ): PlacementSettlementOperation | undefined => {
        if (input === undefined) return undefined;
        let valid = true;
        const read = (key: string) => {
            const result = field(input, key);
            valid &&= !result.unreadable;
            return result.value;
        };
        const request = read("request"),
            kind = read("kind"),
            file = read("file"),
            part = read("part");
        if (
            !valid ||
            !isCount(request) ||
            request === 0 ||
            (kind !== "put" && kind !== "barrier") ||
            (file !== undefined && !isCount(file)) ||
            (part !== undefined && !isCount(part))
        ) {
            increment("invalidEvents");
            return undefined;
        }
        return {
            request,
            kind,
            ...(file === undefined ? {} : { file }),
            ...(part === undefined ? {} : { part }),
        };
    };
    const sink = (
        event: unknown,
        operation?: PlacementSettlementOperation
    ): void => {
        try {
            const nameField = field(event, "name");
            if (nameField.unreadable) {
                increment("invalidEvents");
                return;
            }
            const name = nameField.value;
            if (typeof name !== "string" || !name.startsWith(PREFIX)) return;
            increment("matchingEvents");
            if (logAddress === null) {
                increment("unboundEvents");
                return;
            }
            const family = name.slice(PREFIX.length) as Family;
            if (!(families as readonly string[]).includes(family)) {
                increment("unknownFamilies");
                return;
            }
            let valid = true;
            const read = (input: unknown, key: string) => {
                const value = field(input, key);
                if (value.unreadable) valid = false;
                return value.value;
            };
            const details = read(event, "details");
            if (!details || typeof details !== "object") valid = false;
            const version = read(details, "v");
            if (valid && isCount(version) && version !== 1) {
                increment("unsupportedVersions");
                return;
            }
            if (version !== 1) valid = false;
            const component = read(event, "component");
            const traceId = read(event, "traceId");
            const entries = read(event, "entries");
            const remote = read(event, "peer");
            const durationMs = read(event, "durationMs");
            if (
                component !== "shared-log" ||
                !isText(traceId) ||
                !isCount(entries) ||
                !isTime(durationMs) ||
                (remote !== undefined && !isText(remote)) ||
                (["candidate", "peerPhase", "progress"].includes(family) &&
                    remote === undefined)
            )
                valid = false;
            const selected: Record<string, string | number> = { v: 1 };
            const number = (
                key: string,
                optional = false,
                time = false,
                max = MAX
            ) => {
                const value = read(details, key);
                if (value === undefined && optional) return;
                if (
                    (time ? isTime(value) : isCount(value)) &&
                    (value as number) <= max
                )
                    selected[key] = value as number;
                else valid = false;
            };
            const choice = (
                key: string,
                choices: readonly string[],
                optional = false
            ) => {
                const value = read(details, key);
                if (value === undefined && optional) return;
                if (typeof value === "string" && choices.includes(value))
                    selected[key] = value;
                else valid = false;
            };
            for (const key of [
                "minAcks",
                "leaderDegree",
                "entriesOutsideSampleWindow",
                "round",
            ])
                number(key);
            number("entrySampleWindow", false, false, 16);
            number("elapsedMs", false, true, Infinity);
            if (
                family === "plan" ||
                family === "candidate" ||
                family === "progress"
            )
                number("entryIndex", false, false, 15);
            if (family === "plan")
                for (const key of [
                    "remoteLeaderCount",
                    "selectedRequestPeerCount",
                    "carriedAckCount",
                ])
                    number(key);
            if (family === "candidate")
                choice("status", [
                    "carried-receipt",
                    "leader-no-current-session",
                    "selected-for-request",
                ]);
            if (family === "peerPhase") {
                choice("phase", [
                    "confirmation",
                    "transfer-admission",
                    "receipt-egress",
                    "receipt-request",
                ]);
                choice("edge", ["start", "end"]);
                choice("outcome", [
                    "pending",
                    "fulfilled",
                    "rejected",
                    "not-admitted",
                    "stale",
                ]);
                number("requestedEntries");
                number("attempt", true);
                number("timeoutMs", true, true, Infinity);
                number("acceptedEntries", true);
            }
            if (family === "progress") {
                number("attempt");
                number("carriedAckCount");
            }
            if (family === "settle") {
                choice("outcome", ["quorum-validated", "failed", "aborted"]);
                choice(
                    "reason",
                    ["timeout", "signal", "no-peers", "error"],
                    true
                );
                number("emittedEvents");
                number("droppedEvents");
            }
            if (!valid) {
                increment("invalidEvents");
                return;
            }
            let trace = traces.find((item) => item.traceId === traceId);
            if (trace?.terminal) {
                increment("lateEvents");
                return;
            }
            const label = operationCopy(operation);
            if (
                trace &&
                label &&
                (label.request !== trace.operation?.request ||
                    label.kind !== trace.operation?.kind ||
                    label.file !== trace.operation?.file ||
                    label.part !== trace.operation?.part)
            ) {
                increment("operationConflicts");
                increment("invalidEvents");
            }
            if (!trace) {
                if (traces.length === 8) {
                    const oldestTerminal = traces.findIndex(
                        (item) => item.terminal !== undefined
                    );
                    if (oldestTerminal === -1) {
                        increment("capacityDroppedEvents");
                        if (family === "settle")
                            increment("terminalCapacityDroppedEvents");
                        return;
                    }
                    const [evicted] = traces.splice(oldestTerminal, 1);
                    increment("evictedTraces");
                    increment("evictedEvents", evicted.events.length + 1);
                }
                trace = {
                    traceId: traceId as string,
                    ...(label ? { operation: label } : {}),
                    events: [],
                };
                traces.push(trace);
            }
            if (family !== "settle" && trace.events.length === 256) {
                increment("detailDroppedEvents");
                return;
            }
            const record: RecordEvent = {
                seq: counters.matchingEvents,
                name,
                component: "shared-log",
                traceId: traceId as string,
                entries: entries as number,
                ...(remote === undefined ? {} : { peer: remote as string }),
                durationMs: durationMs as number,
                details: selected,
                receivedAtMs: clock(),
            };
            if (family === "settle") trace.terminal = record;
            else trace.events.push(record);
        } catch {
            increment("invalidEvents");
        }
    };
    const clone = (event: RecordEvent): RecordEvent => ({
        ...event,
        details: { ...event.details },
    });
    return {
        bindLog(address: string): void {
            if (!isText(address))
                throw new TypeError("Invalid settlement log address");
            if (logAddress !== null && logAddress !== address)
                throw new Error("Settlement log already bound");
            logAddress = address;
        },
        sink,
        snapshot: () => ({
            schema: 1 as const,
            namespace: {
                runId,
                peer,
                generation,
                plane,
                observerHash,
                logAddress,
            },
            limits: { maxTraces: 8, maxDetailEvents: 256 },
            counters: { ...counters, saturated },
            // An evicted ID reappearing is new retained coverage, not dedup proof.
            traces: traces.map((trace) => ({
                traceId: trace.traceId,
                ...(trace.operation
                    ? { operation: { ...trace.operation } }
                    : {}),
                events: trace.events.map(clone),
                ...(trace.terminal ? { terminal: clone(trace.terminal) } : {}),
            })),
        }),
    };
};
