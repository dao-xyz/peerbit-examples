import { AsyncLocalStorage } from "node:async_hooks";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";
import type { ReadinessRuntime } from "../readiness/runtime.js";
import { OpenV1 } from "../readiness/wire.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * Nothing a test did arms timers once its peers stopped. The suite runs a
 * worker's files with isolate:false, so a timer armed through the global
 * setTimeout after a file's last `peer.stop()` lands in whatever fake clock
 * a later file of that worker installed: readiness-tap's `getTimerCount()`
 * read 2 on Windows when mount-backend ran before it (libp2p's address
 * debounce, cancelled in vitest.setup.ts). Each scenario runs in its own
 * async context, and a timer's callback runs in the context that armed it,
 * so only the scenario's timers and their re-arms count, whichever file ran
 * before this one.
 */

interface ArmedTimer {
    kind: "setTimeout" | "setInterval";
    ms: number;
    stack: string;
}

/** Past libp2p's 1 s address debounce, on the real clock. */
const WINDOW_MS = 1_500;

/** A frame of this package's own code (not of its tests). */
const OWN_FRAME =
    /[\\/]shared-fs[\\/]library[\\/](?:src|lib)[\\/](?!__tests__)/;

/**
 * Runs `scenario`, which ends by stopping its peers, in its own async
 * context with the global timers wrapped. Returns the timers that context
 * armed after `scenario` resolved (within `WINDOW_MS`), and the ones this
 * package armed at any point that are still neither fired nor cleared at
 * the end. A dependency's bounded timeout may still be pending then (a
 * pubsub route query's 5 s); one of ours may not.
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
    const pending = new Map<unknown, ArmedTimer>();
    const armedAfterStop: ArmedTimer[] = [];
    let stopped = false;
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
            const timer: ArmedTimer = {
                kind,
                ms: Number(ms ?? 0),
                stack: frames.slice(0, 8).join("\n"),
            };
            if (stopped) armedAfterStop.push(timer);
            const handle: unknown = real[kind](
                (...callbackArgs: any[]) => {
                    if (kind === "setTimeout") pending.delete(handle);
                    callback(...callbackArgs);
                },
                ms,
                ...args
            );
            const own = frames.find((frame) => OWN_FRAME.test(frame));
            if (own) {
                pending.set(handle, { ...timer, stack: own.trim() });
            }
            return handle;
        };
    const clear =
        (kind: "clearTimeout" | "clearInterval") => (handle?: any) => {
            pending.delete(handle);
            real[kind](handle);
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
    } finally {
        Object.assign(globalThis, real);
    }
    return { armedAfterStop, ownStillPending: [...pending.values()] };
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
        expect(timers).toEqual({ armedAfterStop: [], ownStillPending: [] });
    });

    // A joiner gated on a donor that drops every OPEN: the write-readiness
    // tracker polls and a readiness session waits on its OPEN attempts.
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
                    writeReadinessSettleMs: 100,
                } as any);
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
            expect(timers).toEqual({ armedAfterStop: [], ownStillPending: [] });
        }
    );
});
