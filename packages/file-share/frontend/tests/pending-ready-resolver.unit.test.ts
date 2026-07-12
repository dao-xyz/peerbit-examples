import { afterEach, describe, expect, it, vi } from "vitest";
import { LargeFile, type Files } from "@peerbit/please-lib";
import {
    createPendingReadyResolver,
    resolveRemoteReadyRoot,
    type PendingReadyStartResult,
} from "../src/pending-ready-resolver";

const startedPromise = (result: PendingReadyStartResult) => {
    expect(result.status).toBe("started");
    if (result.status !== "started") {
        throw new Error(`Expected started result, got ${result.status}`);
    }
    return result.promise;
};

describe("pending ready-file resolver", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("reports existing work without duplicate diagnostics or finalizers", async () => {
        let resolveAttempt: (value: string) => void = () => {};
        const attempt = new Promise<string>((resolve) => {
            resolveAttempt = resolve;
        });
        const resolve = vi.fn(() => attempt);
        const onReady = vi.fn();
        const program = {};
        const resolver = createPendingReadyResolver({
            resolve,
            isActive: () => true,
            onReady,
        });

        let startDiagnostics = 0;
        let finalizers = 0;
        const startFromSnapshot = () => {
            const result = resolver.start("file", program);
            if (result.status === "started") {
                startDiagnostics += 1;
                void result.promise.finally(() => {
                    finalizers += 1;
                });
            }
            return result;
        };
        const first = startFromSnapshot();
        const second = startFromSnapshot();
        expect(first.status).toBe("started");
        expect(second.status).toBe("existing");
        if (first.status !== "started" || second.status !== "existing") {
            throw new Error("Unexpected admission results");
        }
        expect(first.promise).toBe(second.promise);
        expect(resolve).toHaveBeenCalledOnce();
        expect(startDiagnostics).toBe(1);

        resolveAttempt("ready");
        await first.promise;
        expect(onReady).toHaveBeenCalledOnce();
        expect(finalizers).toBe(1);
        expect(resolver.size).toBe(0);
    });

    it("aborts and removes work on cancellation", async () => {
        let attemptSignal: AbortSignal | undefined;
        const onReady = vi.fn();
        const program = {};
        const resolver = createPendingReadyResolver({
            resolve: (_key, _program, signal) => {
                attemptSignal = signal;
                return new Promise<undefined>((resolve) => {
                    signal.addEventListener("abort", () => resolve(undefined), {
                        once: true,
                    });
                });
            },
            isActive: () => true,
            onReady,
        });

        const pending = startedPromise(resolver.start("file", program));
        expect(resolver.cancel("file", program)).toBe(true);
        await pending;

        expect(attemptSignal?.aborted).toBe(true);
        expect(onReady).not.toHaveBeenCalled();
        expect(resolver.size).toBe(0);
    });

    it("refuses roots above capacity without evicting active work and retries later", async () => {
        const signals = new Map<string, AbortSignal>();
        const promises: Promise<void>[] = [];
        const resolver = createPendingReadyResolver<object, string>({
            maxEntries: 64,
            resolve: (key, _program, signal) => {
                signals.set(key, signal);
                return new Promise<undefined>((resolve) => {
                    signal.addEventListener("abort", () => resolve(undefined), {
                        once: true,
                    });
                });
            },
            isActive: () => true,
            onReady: vi.fn(),
        });
        const program = {};

        for (let index = 0; index < 64; index += 1) {
            promises.push(
                startedPromise(resolver.start(`file-${index}`, program))
            );
        }
        const excess = resolver.start("file-64", program);
        expect(excess).toEqual({
            status: "capacity",
            activeCount: 64,
            maxEntries: 64,
        });
        expect(resolver.size).toBe(64);
        expect([...signals.values()].every((signal) => !signal.aborted)).toBe(
            true
        );

        expect(resolver.cancel("file-0", program)).toBe(true);
        const admitted = resolver.start("file-64", program);
        promises.push(startedPromise(admitted));
        expect(resolver.size).toBe(64);
        expect(signals.get("file-1")?.aborted).toBe(false);

        resolver.cancelAll();
        await Promise.all(promises);
        expect(resolver.size).toBe(0);
    });

    it("keeps expired roots in cooldown and admits them after cooldown", async () => {
        vi.useFakeTimers();
        const onExpired = vi.fn();
        const resolver = createPendingReadyResolver<object, string>({
            maxLifetimeMs: 1_000,
            expiryCooldownMs: 5_000,
            retryDelayMs: 100,
            resolve: async () => undefined,
            isActive: () => true,
            onReady: vi.fn(),
            onExpired,
        });
        const program = {};

        const first = startedPromise(resolver.start("file", program));
        await vi.advanceTimersByTimeAsync(1_100);
        await first;
        expect(onExpired).toHaveBeenCalledOnce();
        expect(resolver.size).toBe(0);
        expect(resolver.cooldownSize).toBe(1);

        const cooldown = resolver.start("file", program);
        expect(cooldown.status).toBe("cooldown");
        if (cooldown.status !== "cooldown") {
            throw new Error("Expected cooldown result");
        }
        const remainingCooldownMs = cooldown.retryAt - Date.now();
        await vi.advanceTimersByTimeAsync(remainingCooldownMs - 1);
        expect(resolver.start("file", program).status).toBe("cooldown");
        await vi.advanceTimersByTimeAsync(1);

        const restarted = startedPromise(resolver.start("file", program));
        resolver.cancelAll();
        await restarted;
        expect(resolver.cooldownSize).toBe(0);
    });

    it("defaults expiry cooldown to the full polling lifetime", async () => {
        vi.useFakeTimers();
        const resolver = createPendingReadyResolver<object, string>({
            maxLifetimeMs: 100,
            retryDelayMs: 10,
            resolve: async () => undefined,
            isActive: () => true,
            onReady: vi.fn(),
        });
        const program = {};

        const expired = startedPromise(resolver.start("file", program));
        await vi.advanceTimersByTimeAsync(110);
        await expired;
        const cooldown = resolver.start("file", program);
        expect(cooldown.status).toBe("cooldown");
        if (cooldown.status !== "cooldown") {
            throw new Error("Expected cooldown result");
        }

        const retryAt = cooldown.retryAt;
        await vi.advanceTimersByTimeAsync(40);
        expect(resolver.start("file", program)).toMatchObject({
            status: "cooldown",
            retryAt,
        });
        await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1);
        expect(resolver.start("file", program).status).toBe("cooldown");
        await vi.advanceTimersByTimeAsync(1);

        const restarted = startedPromise(resolver.start("file", program));
        resolver.cancelAll();
        await restarted;
    });

    it("clears expiry state when a root is removed", async () => {
        vi.useFakeTimers();
        const resolver = createPendingReadyResolver<object, string>({
            maxLifetimeMs: 100,
            expiryCooldownMs: 1_000,
            retryDelayMs: 10,
            resolve: async () => undefined,
            isActive: () => true,
            onReady: vi.fn(),
        });
        const program = {};

        const expired = startedPromise(resolver.start("file", program));
        await vi.advanceTimersByTimeAsync(110);
        await expired;
        expect(resolver.start("file", program).status).toBe("cooldown");

        expect(resolver.cancel("file", program)).toBe(true);
        expect(resolver.cooldownSize).toBe(0);
        const restarted = startedPromise(resolver.start("file", program));
        resolver.cancel("file", program);
        await restarted;
    });

    it("clears active and cooldown state on program and resolver cleanup", async () => {
        vi.useFakeTimers();
        const signals = new Map<string, AbortSignal>();
        const resolver = createPendingReadyResolver<object, string>({
            maxEntries: 4,
            maxLifetimeMs: 100,
            expiryCooldownMs: 1_000,
            retryDelayMs: 10,
            resolve: (key, _program, signal) => {
                signals.set(key, signal);
                return Promise.resolve(undefined);
            },
            isActive: () => true,
            onReady: vi.fn(),
        });
        const programA = {};
        const programB = {};

        const expired = startedPromise(resolver.start("expired", programA));
        await vi.advanceTimersByTimeAsync(110);
        await expired;
        expect(resolver.cooldownSize).toBe(1);

        const activeA = startedPromise(resolver.start("active-a", programA));
        const activeB = startedPromise(resolver.start("active-b", programB));
        expect(resolver.cancelProgram(programA)).toBe(1);
        expect(signals.get("active-a")?.aborted).toBe(true);
        expect(signals.get("active-b")?.aborted).toBe(false);
        expect(resolver.cooldownSize).toBe(0);
        expect(resolver.size).toBe(1);

        expect(resolver.cancelAll()).toBe(1);
        await Promise.all([activeA, activeB]);
        expect(resolver.size).toBe(0);
        expect(resolver.cooldownSize).toBe(0);
    });

    it("uses writer hints for an always-remote exact-id lookup", async () => {
        const ready = new LargeFile({
            id: "file",
            name: "file.bin",
            size: 1n,
            chunkCount: 1,
            ready: true,
            finalHash: "hash",
        });
        const get = vi.fn().mockResolvedValue(ready);
        const program = {
            getReadPeerHints: vi.fn().mockResolvedValue(["writer"]),
            files: { index: { get } },
        } as unknown as Files;
        const controller = new AbortController();

        await expect(
            resolveRemoteReadyRoot(program, "file", controller.signal, 1_500)
        ).resolves.toBe(ready);
        expect(get).toHaveBeenCalledWith(
            "file",
            expect.objectContaining({
                local: false,
                signal: controller.signal,
                remote: expect.objectContaining({
                    timeout: 1_500,
                    strategy: "always",
                    replicate: false,
                    from: ["writer"],
                }),
            })
        );
    });
});
