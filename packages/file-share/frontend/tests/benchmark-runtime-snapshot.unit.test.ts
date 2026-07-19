import { createElement, useEffect } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import {
    BENCHMARK_RUNTIME_SNAPSHOT_LIMITS,
    getFileShareBenchmarkRuntimeSnapshot,
    getFileShareBenchmarkShutdownPostconditions,
    useFileShareBenchmarkRuntimeSession,
} from "../src/Drop";

const createProgram = (properties: {
    runtimeGetter?: () => unknown;
    eagerGetter?: () => unknown;
}) => ({
    address: "program-address",
    closed: false,
    files: {
        log: {
            ...(properties.runtimeGetter == null
                ? {}
                : { getRuntimeSnapshot: properties.runtimeGetter }),
            ...(properties.eagerGetter == null
                ? {}
                : {
                      getEagerBlockCacheTelemetry: properties.eagerGetter,
                  }),
        },
    },
});

describe("file-share benchmark runtime snapshot", () => {
    it("captures a committed session per peer/program lifecycle without rewriting old hook closures", async () => {
        const installed: Array<() => string | null> = [];
        const Harness = ({
            peer,
            program,
            revision,
        }: {
            peer: unknown;
            program: unknown;
            revision: number;
        }) => {
            const sessionRef = useFileShareBenchmarkRuntimeSession(
                peer,
                program as any
            );
            useEffect(() => {
                const committedSession = sessionRef.current;
                installed.push(() => committedSession?.sessionId ?? null);
            }, [peer, program, revision, sessionRef]);
            return null;
        };
        const container = document.createElement("div");
        const root = createRoot(container);
        const previousActEnvironment = (
            globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT;
        (
            globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = true;
        const firstPeer = {};
        const firstProgram = createProgram({});
        await act(async () => {
            root.render(
                createElement(Harness, {
                    peer: firstPeer,
                    program: firstProgram,
                    revision: 0,
                })
            );
        });
        const firstHook = installed.at(-1)!;
        const firstSessionId = firstHook();
        expect(firstSessionId).toBeTruthy();

        await act(async () => {
            root.render(
                createElement(Harness, {
                    peer: firstPeer,
                    program: firstProgram,
                    revision: 1,
                })
            );
        });
        expect(installed.at(-1)!()).toBe(firstSessionId);

        const secondPeer = {};
        const secondProgram = createProgram({});
        await act(async () => {
            root.render(
                createElement(Harness, {
                    peer: secondPeer,
                    program: secondProgram,
                    revision: 2,
                })
            );
        });
        const secondHook = installed.at(-1)!;
        expect(secondHook()).toBeTruthy();
        expect(secondHook()).not.toBe(firstSessionId);
        expect(firstHook()).toBe(firstSessionId);

        await act(async () => root.unmount());
        (
            globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    });

    it("reports shutdown only after both public postconditions hold", () => {
        expect(
            getFileShareBenchmarkShutdownPostconditions(
                { closed: true } as any,
                { libp2p: { status: "stopped" } }
            )
        ).toEqual({ programClosed: true, peerStopped: true });
        expect(
            getFileShareBenchmarkShutdownPostconditions(
                { closed: false } as any,
                { libp2p: { status: "stopping" } }
            )
        ).toEqual({ programClosed: false, peerStopped: false });
        expect(
            getFileShareBenchmarkShutdownPostconditions(undefined, undefined)
        ).toEqual({ programClosed: false, peerStopped: false });
    });

    it("reports unavailable runtime APIs without inspecting private state", () => {
        expect(
            getFileShareBenchmarkRuntimeSnapshot(
                undefined,
                undefined,
                null,
                123
            )
        ).toEqual({
            capturedAt: 123,
            programReady: false,
            identity: {
                programAddress: null,
                peerId: null,
                peerHash: null,
                sessionId: null,
            },
            nativeGraph: { active: null, useHeads: null },
            eagerBlocks: {
                telemetryAvailable: false,
                enabled: null,
                telemetry: null,
            },
            pubsub: {
                runtimeSnapshotAvailable: false,
                snapshot: null,
                error: null,
            },
        });
    });

    it("distinguishes an available but disabled eager cache", () => {
        const snapshot = getFileShareBenchmarkRuntimeSnapshot(
            createProgram({ eagerGetter: () => undefined }) as any,
            { services: { pubsub: {} } },
            "session-disabled",
            456
        );

        expect(snapshot).toMatchObject({
            capturedAt: 456,
            programReady: true,
            nativeGraph: { active: null, useHeads: null },
            eagerBlocks: {
                telemetryAvailable: true,
                enabled: false,
                telemetry: null,
            },
            pubsub: {
                runtimeSnapshotAvailable: false,
                snapshot: null,
                error: null,
            },
        });
    });

    it("returns bounded plain telemetry and effective pubsub settings without exposing native objects", () => {
        const collisionPrefix = "k".repeat(
            BENCHMARK_RUNTIME_SNAPSHOT_LIMITS.maxKeyLength
        );
        const hostileKeys = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(hostileKeys, "__proto__", {
            enumerable: true,
            value: "safe-own-value",
        });
        Object.defineProperty(hostileKeys, `${collisionPrefix}-first`, {
            enumerable: true,
            value: "first",
        });
        Object.defineProperty(hostileKeys, `${collisionPrefix}-second`, {
            enumerable: true,
            value: "second",
        });
        const pubsubSnapshot: Record<string, unknown> = {
            fanout: {
                root: { uploadLimitBps: 20_000_000 },
                node: { uploadLimitBps: 20_000_000 },
            },
            values: Array.from({ length: 64 }, (_, index) => index),
            long: "x".repeat(1_000),
            wide: Object.fromEntries(
                Array.from({ length: 64 }, (_, index) => [
                    `key-${index}`,
                    index,
                ])
            ),
            keyed: { ["k".repeat(256)]: "value" },
            hostileKeys,
            hugeBigInt:
                (1n <<
                    BigInt(
                        BENCHMARK_RUNTIME_SNAPSHOT_LIMITS.maxStringLength * 4
                    )) -
                1n,
            deep: { a: { b: { c: { d: { e: { f: "hidden" } } } } } },
        };
        pubsubSnapshot.self = pubsubSnapshot;
        const snapshot = getFileShareBenchmarkRuntimeSnapshot(
            createProgram({
                runtimeGetter: () => ({
                    nativeGraph: { active: true, useHeads: true },
                }),
                eagerGetter: () => ({
                    entries: 2,
                    bytes: 1_024,
                    limits: { maxEntries: 1_000, maxBytes: 32 * 1024 * 1024 },
                }),
            }) as any,
            {
                services: {
                    pubsub: {
                        getRuntimeSnapshot: () => pubsubSnapshot,
                    },
                },
            },
            "session-enabled",
            789
        );

        expect(snapshot.nativeGraph).toEqual({ active: true, useHeads: true });
        expect(snapshot.eagerBlocks).toEqual({
            telemetryAvailable: true,
            enabled: true,
            telemetry: {
                bytes: 1_024,
                entries: 2,
                limits: { maxBytes: 32 * 1024 * 1024, maxEntries: 1_000 },
            },
        });
        expect(snapshot.pubsub.runtimeSnapshotAvailable).toBe(true);
        expect(snapshot.pubsub.error).toBeNull();
        expect(snapshot.pubsub.snapshot?.fanout).toEqual({
            node: { uploadLimitBps: 20_000_000 },
            root: { uploadLimitBps: 20_000_000 },
        });
        expect(snapshot.pubsub.snapshot?.values).toHaveLength(
            BENCHMARK_RUNTIME_SNAPSHOT_LIMITS.maxArrayItems
        );
        expect((snapshot.pubsub.snapshot?.long as string).length).toBe(
            BENCHMARK_RUNTIME_SNAPSHOT_LIMITS.maxStringLength
        );
        expect(
            Object.keys(
                snapshot.pubsub.snapshot?.wide as Record<string, unknown>
            )
        ).toHaveLength(BENCHMARK_RUNTIME_SNAPSHOT_LIMITS.maxObjectKeys);
        expect(
            Object.keys(
                snapshot.pubsub.snapshot?.keyed as Record<string, unknown>
            )[0]
        ).toHaveLength(BENCHMARK_RUNTIME_SNAPSHOT_LIMITS.maxKeyLength);
        const boundedHostileKeys = snapshot.pubsub.snapshot
            ?.hostileKeys as Record<string, unknown>;
        expect(Object.getPrototypeOf(boundedHostileKeys)).toBeNull();
        expect(
            Object.prototype.hasOwnProperty.call(
                boundedHostileKeys,
                "__proto__"
            )
        ).toBe(true);
        expect(boundedHostileKeys.__proto__).toBe("safe-own-value");
        expect(Object.values(boundedHostileKeys)).toEqual([
            "safe-own-value",
            "first",
            "second",
        ]);
        expect(new Set(Object.keys(boundedHostileKeys)).size).toBe(3);
        expect(
            Object.keys(boundedHostileKeys).every(
                (key) =>
                    key.length <= BENCHMARK_RUNTIME_SNAPSHOT_LIMITS.maxKeyLength
            )
        ).toBe(true);
        expect((snapshot.pubsub.snapshot?.hugeBigInt as string).length).toBe(
            BENCHMARK_RUNTIME_SNAPSHOT_LIMITS.maxStringLength
        );
        expect(JSON.stringify(snapshot)).toContain("[circular]");
        expect(JSON.stringify(snapshot)).toContain("[truncated-depth]");
    });

    it("binds a ready snapshot to stable public program, peer, and session identities", () => {
        const program = createProgram({}) as any;
        const peer = {
            peerId: { toString: () => "peer-id" },
            identity: { publicKey: { hashcode: () => "peer-hash" } },
            services: { pubsub: {} },
        };

        expect(
            getFileShareBenchmarkRuntimeSnapshot(
                program,
                peer,
                "page-session",
                1_234
            ).identity
        ).toEqual({
            programAddress: "program-address",
            peerId: "peer-id",
            peerHash: "peer-hash",
            sessionId: "page-session",
        });
    });

    it.each([
        ["non-object snapshot", "invalid"],
        ["missing native graph", {}],
        ["non-boolean fields", { nativeGraph: { active: 1, useHeads: 0 } }],
        [
            "impossible disabled useHeads",
            { nativeGraph: { active: false, useHeads: true } },
        ],
    ])("fails closed for a %s", (_label, runtimeSnapshot) => {
        const snapshot = getFileShareBenchmarkRuntimeSnapshot(
            createProgram({ runtimeGetter: () => runtimeSnapshot }) as any,
            undefined
        );

        expect(snapshot.nativeGraph).toEqual({ active: null, useHeads: null });
    });

    it("fails closed when the shared-log runtime getter throws", () => {
        const snapshot = getFileShareBenchmarkRuntimeSnapshot(
            createProgram({
                runtimeGetter: () => {
                    throw new Error("runtime unavailable");
                },
            }) as any,
            undefined
        );

        expect(snapshot.nativeGraph).toEqual({ active: null, useHeads: null });
    });

    it("contains pubsub getter failures", () => {
        const snapshot = getFileShareBenchmarkRuntimeSnapshot(
            createProgram({ eagerGetter: () => undefined }) as any,
            {
                services: {
                    pubsub: {
                        getRuntimeSnapshot: () => {
                            throw new Error("runtime snapshot failed");
                        },
                    },
                },
            }
        );
        expect(snapshot.pubsub).toEqual({
            runtimeSnapshotAvailable: true,
            snapshot: null,
            error: "runtime snapshot failed",
        });
    });

    it.each([
        ["null", null],
        ["undefined", undefined],
        ["empty message", { message: "" }],
        [
            "oversized string",
            "x".repeat(BENCHMARK_RUNTIME_SNAPSHOT_LIMITS.maxStringLength * 2),
        ],
        ["unstringifiable object", Object.create(null)],
    ])("normalizes a %s pubsub getter failure", (_label, thrown) => {
        const snapshot = getFileShareBenchmarkRuntimeSnapshot(
            createProgram({ eagerGetter: () => undefined }) as any,
            {
                services: {
                    pubsub: {
                        getRuntimeSnapshot: () => {
                            throw thrown;
                        },
                    },
                },
            }
        );

        expect(snapshot.pubsub.snapshot).toBeNull();
        expect(snapshot.pubsub.error).toBeTruthy();
        expect(snapshot.pubsub.error!.length).toBeLessThanOrEqual(
            BENCHMARK_RUNTIME_SNAPSHOT_LIMITS.maxStringLength
        );
    });
});
