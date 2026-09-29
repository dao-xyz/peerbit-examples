import type { PublicSignKey } from "@peerbit/crypto";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { openSharedFs } from "../index.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * Wiring guard for the joiner's direct subscriber request. It does not
 * reproduce the lost-announcement race, which fanout backfill heals in most
 * runs. It only checks that opening a filesystem asks every direct pubsub
 * neighbour for the log topic's subscribers, and that a neighbour connected
 * later is asked too.
 *
 * A bare peer that does not open the filesystem tells this request apart
 * from upstream's own requests. shared-log asks only peers that send it
 * replication capabilities, and a bare peer sends none.
 */

type RequestRecorder = {
    requested(topic: string, key: PublicSignKey): boolean;
    waitForRequest(
        topic: string,
        key: PublicSignKey,
        timeoutMs: number
    ): Promise<void>;
};

const recordSubscriberRequests = (peer: Peerbit): RequestRecorder => {
    const pubsub = peer.services.pubsub as any;
    const original = pubsub.requestSubscribers.bind(pubsub);
    const calls: Array<{ topic: string; to?: string }> = [];
    const waiters = new Set<() => void>();
    pubsub.requestSubscribers = (topic: string, to?: PublicSignKey) => {
        calls.push({ topic: String(topic), to: to?.hashcode() });
        for (const waiter of [...waiters]) waiter();
        return original(topic, to);
    };
    const requested = (topic: string, key: PublicSignKey) =>
        calls.some(
            (call) => call.topic === topic && call.to === key.hashcode()
        );
    return {
        requested,
        waitForRequest: (topic, key, timeoutMs) =>
            new Promise<void>((resolve, reject) => {
                const check = () => {
                    if (!requested(topic, key)) return;
                    waiters.delete(check);
                    clearTimeout(timer);
                    resolve();
                };
                const timer = setTimeout(() => {
                    waiters.delete(check);
                    reject(
                        new Error(
                            `no requestSubscribers(${topic}, ${key.hashcode()}) within ${timeoutMs} ms`
                        )
                    );
                }, timeoutMs);
                waiters.add(check);
                check();
            }),
    };
};

describe("shared fs neighbour subscriber discovery", () => {
    const peers: Peerbit[] = [];

    afterEach(async () => {
        await stopTestPeers(peers);
    });

    it("asks direct neighbours for log subscribers at open and on connect", async () => {
        const a = await Peerbit.create();
        const hub = await Peerbit.create();
        const late = await Peerbit.create();
        const c = await Peerbit.create();
        peers.push(a, hub, late, c);
        const fsA = await openSharedFs({ peerbit: a, machineLabel: "party-a" });
        await c.dial(a);
        await c.dial(hub);
        const recorder = recordSubscriberRequests(c);

        const fsC = await openSharedFs({
            peerbit: c,
            address: fsA.address,
            machineLabel: "party-c",
        });
        const topic = fsC.program.entries.log.topic;
        expect(topic).toBe(fsA.program.entries.log.topic);
        // Sent while opening, before open returns.
        expect(recorder.requested(topic, a.identity.publicKey)).toBe(true);
        expect(recorder.requested(topic, hub.identity.publicKey)).toBe(true);

        // A neighbour that connects after open is asked once its outbound
        // stream is ready.
        expect(recorder.requested(topic, late.identity.publicKey)).toBe(false);
        await c.dial(late);
        await recorder.waitForRequest(topic, late.identity.publicKey, 10_000);
    });
});
