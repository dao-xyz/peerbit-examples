import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { openSharedFs } from "../index.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * Upstream contract for cold-join discovery. shared-fs used to ask each
 * direct pubsub neighbour for the log topic's subscribers itself, because a
 * joiner that lost its one shard-routed Subscribe could sit next to a
 * replicator and never see a subscriber. Peerbit's pubsub now covers the
 * same neighbours: announceDirectSubscriptions sends a direct
 * Subscribe{requestSubscribers: true} to every writable neighbour when a
 * topic is subscribed, and to each new neighbour once its outbound stream
 * is ready. shared-fs relies on that, so this test fails if a Peerbit bump
 * stops calling it on either path.
 *
 * The hook is an instance property on the joiner's pubsub. It shadows the
 * prototype method, and both upstream call sites go through `this`. A bare
 * peer that never opens the filesystem is included, as the old guard did,
 * so the call cannot come from shared-log's capability exchange.
 */

type AnnouncementRecorder = {
    announced(topic: string, hash: string): boolean;
    waitForAnnouncement(
        topic: string,
        hash: string,
        timeoutMs: number
    ): Promise<void>;
};

const recordDirectAnnouncements = (peer: Peerbit): AnnouncementRecorder => {
    const pubsub = peer.services.pubsub as any;
    const original = pubsub.announceDirectSubscriptions;
    if (typeof original !== "function") {
        throw new Error("pubsub has no announceDirectSubscriptions");
    }
    const calls: Array<{ topics: string[]; to: string[] }> = [];
    const waiters = new Set<() => void>();
    pubsub.announceDirectSubscriptions = function (
        this: any,
        topics: string[],
        peers?: Array<{
            publicKey: { hashcode(): string };
            isWritable: boolean;
        }>,
        subscribed?: boolean
    ) {
        if (subscribed !== false) {
            // Upstream sends only to writable neighbours; a neighbour that is
            // not writable yet is covered later by its stream:outbound call.
            const targets = peers ?? [...this.peers.values()];
            calls.push({
                topics: topics.map(String),
                to: targets
                    .filter((target) => target.isWritable)
                    .map((target) => target.publicKey.hashcode()),
            });
            for (const waiter of [...waiters]) waiter();
        }
        return original.apply(this, arguments);
    };
    const announced = (topic: string, hash: string) =>
        calls.some(
            (call) => call.topics.includes(topic) && call.to.includes(hash)
        );
    return {
        announced,
        waitForAnnouncement: (topic, hash, timeoutMs) =>
            new Promise<void>((resolve, reject) => {
                const check = () => {
                    if (!announced(topic, hash)) return;
                    waiters.delete(check);
                    clearTimeout(timer);
                    resolve();
                };
                const timer = setTimeout(() => {
                    waiters.delete(check);
                    reject(
                        new Error(
                            `no direct Subscribe(${topic}) to ${hash} within ${timeoutMs} ms`
                        )
                    );
                }, timeoutMs);
                waiters.add(check);
                check();
            }),
    };
};

describe("pubsub direct subscriber exchange", () => {
    const peers: Peerbit[] = [];

    afterEach(async () => {
        await stopTestPeers(peers);
    });

    it("announces the log topic directly to neighbours at open and on connect", async () => {
        const a = await Peerbit.create();
        const hub = await Peerbit.create();
        const late = await Peerbit.create();
        const c = await Peerbit.create();
        peers.push(a, hub, late, c);
        const fsA = await openSharedFs({ peerbit: a, machineLabel: "party-a" });
        await c.dial(a);
        await c.dial(hub);
        const recorder = recordDirectAnnouncements(c);

        const fsC = await openSharedFs({
            peerbit: c,
            address: fsA.address,
            machineLabel: "party-c",
        });
        const topic = fsC.program.entries.log.topic;
        expect(topic).toBe(fsA.program.entries.log.topic);
        // Neighbours connected before open: the subscribe path.
        await recorder.waitForAnnouncement(
            topic,
            a.identity.publicKey.hashcode(),
            10_000
        );
        await recorder.waitForAnnouncement(
            topic,
            hub.identity.publicKey.hashcode(),
            10_000
        );

        // A neighbour that connects after open: the stream:outbound path.
        const lateHash = late.identity.publicKey.hashcode();
        expect(recorder.announced(topic, lateHash)).toBe(false);
        await c.dial(late);
        await recorder.waitForAnnouncement(topic, lateHash, 10_000);
    });

    // Known gap, induced only (0 of 1,500 natural soak runs): if the joiner's
    // direct Subscribe to its neighbour is lost too and the joiner is the log
    // topic's shard root, nothing asks the neighbour again and the join stays
    // write-gated. Enable once Peerbit's shard root re-announces after it
    // subscribes.
    it.todo(
        "a joiner that is the log shard root recovers a lost direct Subscribe"
    );
});
