import { AsyncLocalStorage } from "node:async_hooks";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";
import type { ReadinessRuntime } from "../readiness/runtime.js";
import { OpenV1 } from "../readiness/wire.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * Nothing shared-fs started outlives its peers' stop. Each scenario runs in
 * its own async context with the global timers wrapped, and a timer's
 * callback runs in the context that armed it, so only the scenario's timers
 * and their re-arms count, whichever file ran before this one.
 *
 * A timer is this package's own when a frame of the stack that armed it,
 * async frames included, is this package's code. That covers some of what
 * shared-fs opened (a SharedLog timer armed through an awaited call from
 * openSharedFs), but not timers a dependency arms from its own loops, such
 * as shared-log's replicator liveness or the sqlite indexer's intervals,
 * whose stacks hold no shared-fs frame. No own timer may be armed once the
 * peers stopped, and none may still be pending at the end.
 *
 * A dependency may still finish work it started before the stop: libp2p
 * 3.3.8 releases peer-store locks that its peer:disconnect handlers took
 * while the node stopped, and a release that lands in the stop's last loop
 * turn arms it-queue's 1 ms emitEmpty and emitIdle after it (macOS CI under
 * load). Such a chain must settle: no interval, no timeout past the
 * window, and nothing pending once it played out. A component that re-arms
 * from its own timer callbacks (or within their microtasks) never settles
 * and fails; one that waits on I/O between re-arms can look settled at the
 * end, and only a time limit could tell it from a slow chain that ends.
 *
 * Fake clocks need no help from this test: vitest.setup.ts lets a file
 * install one only alone in a fresh process that created no peer, so no
 * dependency's timer can land in it.
 */

interface ArmedTimer {
    kind: "setTimeout" | "setInterval";
    ms: number;
    stack: string;
}

interface TrackedTimer extends ArmedTimer {
    own: boolean;
    afterStop: boolean;
    /** Resolves when a timeout fired, or when the timer was cleared. */
    done: Promise<void>;
    settle(): void;
}

/**
 * Past libp2p's 1 s address debounce, on the real clock. Also the longest
 * timeout a dependency may arm after the stop.
 */
const WINDOW_MS = 1_500;

/**
 * The generations of a dependency's after-stop timers the end waits for.
 * A lock release takes two (the read queue's pair, then the lock's).
 */
const SETTLE_GENERATIONS = 8;

/** A frame of this package's own code (not of its tests). */
const OWN_FRAME =
    /[\\/]shared-fs[\\/]library[\\/](?:src|lib)[\\/](?!__tests__)/;

/**
 * Runs `scenario`, which ends by stopping its peers, in its own async
 * context with the global timers wrapped. Returns the own timers armed
 * after `scenario` resolved, the own timers armed at any point that are
 * neither fired nor cleared at the end, and a dependency's timers armed
 * after `scenario` resolved that did not settle. The end comes `WINDOW_MS`
 * after the stop, once each generation of a dependency's after-stop
 * timers still pending then has fired, for at most `SETTLE_GENERATIONS`.
 * Waiting on the timers themselves, not on more time, keeps a slow event
 * loop from failing a chain that does settle. A dependency's bounded
 * timeout armed before the stop may still be pending at the end (a pubsub
 * route query's 5 s); one of ours may not.
 */
const timersAfterStop = async (scenario: () => Promise<void>) => {
    const context = new AsyncLocalStorage<true>();
    const real: Record<
        "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval",
        (...args: any[]) => any
    > = {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        setInterval: globalThis.setInterval,
        clearInterval: globalThis.clearInterval,
    };
    const live = new Map<unknown, TrackedTimer>();
    const ownArmedAfterStop: ArmedTimer[] = [];
    let stopped = false;
    const retire = (handle: unknown) => {
        live.get(handle)?.settle();
        live.delete(handle);
    };
    const wrap =
        (kind: ArmedTimer["kind"]) =>
        (callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
            if (!context.getStore()) {
                return real[kind](callback, ms, ...args);
            }
            const limit = Error.stackTraceLimit;
            Error.stackTraceLimit = 30;
            const frames = (new Error().stack ?? "").split("\n").slice(2);
            Error.stackTraceLimit = limit;
            const own = frames.find((frame) => OWN_FRAME.test(frame));
            let settle!: () => void;
            const done = new Promise<void>((resolve) => (settle = resolve));
            const timer: TrackedTimer = {
                kind,
                ms: Number(ms ?? 0),
                stack: own?.trim() ?? frames.slice(0, 8).join("\n"),
                own: own !== undefined,
                afterStop: stopped,
                done,
                settle,
            };
            if (timer.own && stopped) ownArmedAfterStop.push(armed(timer));
            const handle: unknown = real[kind](
                (...callbackArgs: any[]) => {
                    if (kind === "setTimeout") retire(handle);
                    callback(...callbackArgs);
                },
                ms,
                ...args
            );
            live.set(handle, timer);
            return handle;
        };
    const clear =
        (kind: "clearTimeout" | "clearInterval") => (handle?: any) => {
            retire(handle);
            real[kind](handle);
        };
    /** A dependency's timers armed after the stop, still pending. */
    const unsettled = () =>
        [...live.values()].filter((timer) => timer.afterStop && !timer.own);
    /**
     * Waits until the pending ones fired or were cleared, and returns
     * false when one cannot end by itself (an interval, or a timeout past
     * the window). The wait is bounded in case a timer is cleared by a
     * path the wrap misses.
     */
    const settleGeneration = async () => {
        const pending = unsettled();
        if (
            pending.length === 0 ||
            pending.some(
                (timer) => timer.kind === "setInterval" || timer.ms > WINDOW_MS
            )
        ) {
            return false;
        }
        await new Promise<void>((resolve) => {
            const bound = real.setTimeout(resolve, WINDOW_MS);
            void Promise.all(pending.map((timer) => timer.done)).then(() => {
                real.clearTimeout(bound);
                resolve();
            });
        });
        return true;
    };
    Object.assign(globalThis, {
        setTimeout: wrap("setTimeout"),
        setInterval: wrap("setInterval"),
        clearTimeout: clear("clearTimeout"),
        clearInterval: clear("clearInterval"),
    });
    try {
        await context.run(true, scenario);
        stopped = true;
        await new Promise((resolve) => real.setTimeout(resolve, WINDOW_MS));
        for (let n = 0; n < SETTLE_GENERATIONS; n++) {
            if (!(await settleGeneration())) break;
        }
    } finally {
        Object.assign(globalThis, real);
    }
    return {
        ownArmedAfterStop,
        ownStillPending: [...live.values()]
            .filter((timer) => timer.own)
            .map(armed),
        foreignUnsettled: unsettled().map(armed),
    };
};

const armed = ({ kind, ms, stack }: ArmedTimer): ArmedTimer => ({
    kind,
    ms,
    stack,
});

const NONE = {
    ownArmedAfterStop: [],
    ownStillPending: [],
    foreignUnsettled: [],
};

const runtimeOf = (fs: SharedFsHandle): ReadinessRuntime | undefined =>
    (fs.program as any).readinessRuntime;

const waitUntil = async (condition: () => boolean) => {
    const deadline = Date.now() + (process.env.CI ? 60_000 : 30_000);
    while (!condition()) {
        if (Date.now() > deadline) throw new Error("timed out waiting");
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
};

describe("timers after a peer stops", () => {
    const peers: Peerbit[] = [];

    afterEach(async () => {
        await stopTestPeers(peers);
    });

    const createPeer = async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        return peer;
    };

    it("a stopped peer arms none", async () => {
        const timers = await timersAfterStop(async () => {
            await createPeer();
            await stopTestPeers(peers);
        });
        expect(timers).toEqual(NONE);
    });

    // A joiner gated on a donor that drops every OPEN: a readiness session
    // waits on its OPEN attempts (bounded in-flight timers; write readiness
    // itself arms none since PR-3 commit 4).
    it.each(["close", "drop", "stop"] as const)(
        "a joiner gated mid-session and ended by %s arms none once its peers stopped",
        async (end) => {
            const timers = await timersAfterStop(async () => {
                const donorPeer = await createPeer();
                const donor = await openSharedFs({
                    peerbit: donorPeer,
                    machineLabel: "stop-timers-donor",
                    gc: false,
                });
                await donor.writeFile("/donor.txt", "from the donor");
                const responder = runtimeOf(donor)!.responder!;
                const onMessage = responder.onMessage;
                responder.onMessage = (message, from) => {
                    if (message instanceof OpenV1) return;
                    onMessage.call(responder, message, from);
                };
                const joinerPeer = await createPeer();
                await joinerPeer.dial(donorPeer);
                const joiner = await openSharedFs({
                    peerbit: joinerPeer,
                    address: donor.address,
                    machineLabel: "stop-timers-joiner",
                    bootstrap: false,
                    gc: false,
                });
                await waitUntil(
                    () =>
                        (runtimeOf(joiner)?.coordinator?.debug().sessions ??
                            0) > 0
                );
                expect(joiner.bootstrapStatus().writeReady).toBe(false);
                if (end === "close") await joiner.close();
                if (end === "drop") await (joiner.program as any).drop();
                await stopTestPeers(peers);
            });
            expect(timers).toEqual(NONE);
        }
    );
});
