import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { StringMatch, StringMatchMethod } from "@peerbit/document";
import type { SparseQueryClient } from "./sparse-query-client.js";

type Entries = ConstructorParameters<typeof SparseQueryClient>[0];
type Iterate = Entries["index"]["iterate"];
type IterateOptions = NonNullable<Parameters<Iterate>[1]>;
type RemoteOptions = Exclude<NonNullable<IterateOptions["remote"]>, boolean>;
type ResponseCallback = NonNullable<RemoteOptions["onResponse"]>;
type Operation = { operationId: number; label: string };
type EventFields = Partial<Operation> & {
    phase: string;
    queryId?: number;
    queryKind?: "naming-slot" | "naming-node" | "versions-node" | "chunk-id";
    callId?: number;
    requested?: number;
    returned?: number;
    from?: string;
    durationMs?: number;
    outcome?: "fulfilled" | "rejected";
    rejectionType?: string;
};
type ProfileEvent = EventFields & {
    atMs: number;
    source: string;
    connection: "initial-local";
    applicationGeneration: 0;
};

/** Recognize only our four public exact-query shapes; retain no predicate values. */
const queryKind = (
    request: Parameters<Iterate>[0]
): EventFields["queryKind"] => {
    const query = request?.query;
    if (!Array.isArray(query)) return;
    const exact = query.filter(
        (part): part is StringMatch =>
            part instanceof StringMatch &&
            part.key.length === 1 &&
            part.method === StringMatchMethod.exact &&
            !part.caseInsensitive
    );
    if (exact.length !== query.length) return;
    const fields = new Map(exact.map((part) => [part.key[0], part]));
    if (fields.size !== query.length) return;
    if (fields.size === 1 && fields.has("id")) return "chunk-id";
    const kind = fields.get("kind")?.value;
    if (
        fields.size === 3 &&
        kind === "naming" &&
        fields.has("parentId") &&
        fields.has("name")
    )
        return "naming-slot";
    if (fields.size === 2 && fields.has("nodeId")) {
        if (kind === "naming") return "naming-node";
        if (kind === "file-version") return "versions-node";
    }
};

/** A read-only facade; original receivers (including private fields) survive. */
const facade = <T extends object>(
    target: T,
    overrides: Map<PropertyKey, unknown>
): T =>
    new Proxy(target, {
        get(object, key) {
            if (overrides.has(key)) return overrides.get(key);
            const value = Reflect.get(object, key, object);
            return typeof value === "function" ? value.bind(object) : value;
        },
        set: () => false,
    });

/**
 * TEST ONLY. Records local phase boundaries, not wire latency, server time,
 * namespace freshness, durability, or remote sessions. The public RPC response
 * hook runs after decode and before Documents finishes introducing the results.
 * It does not expose the remote session or raw transport request identifier.
 * No payload/error objects are retained or serialized by this observer.
 */
export class SparseQueryProfile {
    private readonly start = performance.now();
    private readonly source: string;
    private readonly maxEvents: number;
    private readonly operations = new AsyncLocalStorage<Operation>();
    private readonly events: ProfileEvent[] = [];
    private dropped = 0;
    private observerErrors = 0;
    private stopped = false;
    private operationId = 0;
    private queryId = 0;

    constructor(options: { source: string; maxEvents?: number }) {
        this.source = options.source;
        this.maxEvents = options.maxEvents ?? 512;
        if (!Number.isSafeInteger(this.maxEvents) || this.maxEvents < 0)
            throw new Error(
                "Profile maxEvents must be a nonnegative safe integer"
            );
    }

    private capture(fields: () => EventFields): void {
        if (this.stopped) return;
        if (this.events.length >= this.maxEvents) {
            this.dropped++;
            return;
        }
        try {
            this.events.push({
                ...fields(),
                atMs: performance.now() - this.start,
                source: this.source,
                connection: "initial-local",
                applicationGeneration: 0,
            });
        } catch {
            this.observerErrors++;
        }
    }

    async measure<T>(label: string, fn: () => Promise<T>): Promise<T> {
        const operation = { operationId: ++this.operationId, label };
        return this.operations.run(operation, async () => {
            const start = performance.now();
            let outcome: "fulfilled" | "rejected" = "fulfilled";
            let rejectionType: string | undefined;
            this.capture(() => ({ ...operation, phase: "operation.start" }));
            try {
                return await fn();
            } catch (error) {
                outcome = "rejected";
                rejectionType = error === null ? "null" : typeof error;
                throw error;
            } finally {
                this.capture(() => ({
                    ...operation,
                    phase: "operation.end",
                    outcome,
                    rejectionType,
                    durationMs: performance.now() - start,
                }));
            }
        });
    }

    wrap(entries: Entries): Entries {
        const index = entries.index;
        const iterate = (...args: Parameters<Iterate>): ReturnType<Iterate> => {
            const queryId = ++this.queryId;
            const context = {
                ...this.operations.getStore(),
                queryId,
                queryKind: undefined as EventFields["queryKind"],
            };
            const start = performance.now();
            let outcome: "fulfilled" | "rejected" = "fulfilled";
            let rejectionType: string | undefined;
            this.capture(() => {
                context.queryKind = queryKind(args[0]);
                return { ...context, phase: "query.create.start" };
            });
            try {
                const options = args[1];
                if (options?.remote && typeof options.remote === "object") {
                    const previous = options.remote.onResponse;
                    const capture = this.capture.bind(this);
                    const onResponse: ResponseCallback = function (
                        this: unknown,
                        response,
                        from
                    ) {
                        capture(() => ({
                            ...context,
                            phase: "query.decoded-response",
                            from: from?.hashcode(),
                        }));
                        // Only our capture is nonthrowing. Do not swallow, await,
                        // or otherwise alter a pre-existing consumer callback.
                        return previous?.call(this, response, from);
                    };
                    args[1] = {
                        ...options,
                        remote: { ...options.remote, onResponse },
                    };
                }
                const iterator = Reflect.apply(
                    index.iterate,
                    index,
                    args
                ) as ReturnType<Iterate>;
                let callId = 0;
                const timeCall = async <T>(
                    phase: "next" | "close",
                    fn: () => Promise<T>,
                    requested?: number
                ): Promise<T> => {
                    const call = ++callId;
                    const start = performance.now();
                    let outcome: "fulfilled" | "rejected" = "fulfilled";
                    let rejectionType: string | undefined;
                    let result: T | undefined;
                    this.capture(() => ({
                        ...context,
                        callId: call,
                        phase: `query.${phase}.start`,
                        requested,
                    }));
                    try {
                        result = await fn();
                        return result;
                    } catch (error) {
                        outcome = "rejected";
                        rejectionType = error === null ? "null" : typeof error;
                        throw error;
                    } finally {
                        this.capture(() => ({
                            ...context,
                            callId: call,
                            phase: `query.${phase}.end`,
                            requested,
                            returned:
                                phase === "next" &&
                                outcome === "fulfilled" &&
                                Array.isArray(result)
                                    ? result.length
                                    : undefined,
                            outcome,
                            rejectionType,
                            durationMs: performance.now() - start,
                        }));
                    }
                };
                // Other iterator methods retain their original receiver and
                // behavior; internal calls made by all()/first() are not timed.
                return facade(
                    iterator,
                    new Map<PropertyKey, unknown>([
                        [
                            "next",
                            (amount: number) =>
                                timeCall(
                                    "next",
                                    () => iterator.next(amount),
                                    amount
                                ),
                        ],
                        [
                            "close",
                            () => timeCall("close", () => iterator.close()),
                        ],
                    ])
                );
            } catch (error) {
                outcome = "rejected";
                rejectionType = error === null ? "null" : typeof error;
                throw error;
            } finally {
                this.capture(() => ({
                    ...context,
                    phase: "query.create.end",
                    outcome,
                    rejectionType,
                    durationMs: performance.now() - start,
                }));
            }
        };
        const wrappedIndex = facade(
            index,
            new Map([["iterate", iterate as Iterate]])
        );
        return facade(entries, new Map([["index", wrappedIndex]]));
    }

    stop(): void {
        this.stopped = true;
    }

    snapshot(): {
        events: ProfileEvent[];
        dropped: number;
        observerErrors: number;
    } {
        return {
            events: this.events.map((event) => ({ ...event })),
            dropped: this.dropped,
            observerErrors: this.observerErrors,
        };
    }
}
