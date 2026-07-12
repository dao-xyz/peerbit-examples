import { afterEach, describe, expect, it, vi } from "vitest";
import {
    bindRefreshContext,
    callEvenInterval,
    createRefreshContextGuard,
    drainCoalescedRefreshQueue,
    isRefreshContextActive,
    queueCoalescedRefresh,
    type RefreshContext,
} from "../src/refresh-scheduler";

describe("refresh scheduler", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("cancels a queued refresh during effect cleanup", async () => {
        vi.useFakeTimers();
        const refresh = vi.fn();
        const scheduled = callEvenInterval(refresh, 500);

        scheduled("old-share");
        scheduled.cancel();
        await vi.advanceTimersByTimeAsync(500);

        expect(refresh).not.toHaveBeenCalled();
    });

    it("rejects delayed work bound to an old generation or program", async () => {
        vi.useFakeTimers();
        const oldProgram = {};
        const newProgram = {};
        let current: RefreshContext<object | null> = {
            generation: 1,
            program: oldProgram,
        };
        const refresh = vi.fn();
        const bound = bindRefreshContext(
            () => current,
            { generation: 1, program: oldProgram },
            refresh
        );
        const scheduled = callEvenInterval(bound, 500);

        scheduled("old-share");
        current = { generation: 2, program: newProgram };
        await vi.advanceTimersByTimeAsync(500);

        expect(refresh).not.toHaveBeenCalled();
    });

    it("rejects a deferred result after same-generation program replacement", async () => {
        const oldProgram = {};
        const newProgram = {};
        let current: RefreshContext<object | null> = {
            generation: 3,
            program: oldProgram,
        };
        const isCurrent = createRefreshContextGuard(() => current, {
            generation: 3,
            program: oldProgram,
        });
        let resolveWork: () => void = () => {};
        const applied = vi.fn();
        const work = (async () => {
            await new Promise<void>((resolve) => {
                resolveWork = resolve;
            });
            if (isCurrent()) {
                applied();
            }
        })();

        current = { generation: 3, program: newProgram };
        resolveWork();
        await work;

        expect(applied).not.toHaveBeenCalled();
    });

    it("immediately drains a replacement queued by a stale root-list result", async () => {
        const queue = { current: "initial" as string | null };
        const refreshes: string[] = [];

        await drainCoalescedRefreshQueue(
            queue,
            () => true,
            async (source) => {
                refreshes.push(source);
                if (source === "initial") {
                    queueCoalescedRefresh(queue, "stale-root-revision");
                }
            }
        );

        expect(refreshes).toEqual(["initial", "stale-root-revision"]);
        expect(queue.current).toBeNull();
    });

    it("reads the current role before allowing bound adaptive work", () => {
        const program = {};
        const context = { generation: 1, program };
        let currentRole: false | { limits: object } = { limits: {} };
        const canRefresh = () =>
            isRefreshContextActive(context, context, currentRole !== false);

        expect(canRefresh()).toBe(true);
        currentRole = false;
        expect(canRefresh()).toBe(false);
    });

    it("reports rejected scheduled work without an unhandled rejection", async () => {
        vi.useFakeTimers();
        const failure = new Error("refresh failed");
        const onError = vi.fn();
        const scheduled = callEvenInterval(
            () => Promise.reject(failure),
            500,
            onError
        );

        scheduled();
        await vi.advanceTimersByTimeAsync(500);

        expect(onError).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledWith(failure);
    });

    it("suppresses an in-flight failure after cancellation", async () => {
        vi.useFakeTimers();
        let rejectRefresh: (error: Error) => void = () => {};
        const onError = vi.fn();
        const scheduled = callEvenInterval(
            () =>
                new Promise<void>((_resolve, reject) => {
                    rejectRefresh = reject;
                }),
            500,
            onError
        );

        scheduled();
        vi.advanceTimersByTime(500);
        await Promise.resolve();
        scheduled.cancel();
        rejectRefresh(new Error("stale refresh failed"));
        await Promise.resolve();
        await Promise.resolve();

        expect(onError).not.toHaveBeenCalled();
    });
});
