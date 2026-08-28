import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const waitUntil = async (
    assertion: () => Promise<void> | void,
    options: { timeoutMs?: number; intervalMs?: number } = {}
) => {
    const timeoutMs = options.timeoutMs ?? (process.env.CI ? 90_000 : 30_000);
    const intervalMs = options.intervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }
    throw lastError;
};

/**
 * The memoized trust-verdict cache must never change WHO can write — only
 * how often the trust-graph BFS runs. Revocation-shaped changes (any
 * trust-graph change) flush it; negative verdicts expire quickly so a
 * writer whose trust relation is still replicating is retried.
 */
describe("shared fs trust-verdict cache", () => {
    const peers: Peerbit[] = [];

    afterEach(async () => {
        await Promise.allSettled(
            peers.splice(0).map(async (peer) => {
                try {
                    await peer.stop();
                } catch {
                    /* benign close races */
                }
            })
        );
    });

    it("rejects an untrusted writer with a warm cache, accepts after authorization", async () => {
        const owner = await Peerbit.create();
        const stranger = await Peerbit.create();
        peers.push(owner, stranger);
        await owner.dial(stranger);
        const ownerFs = await openSharedFs({
            peerbit: owner,
            machineLabel: "owner",
            rootKey: owner.identity.publicKey,
        });
        await ownerFs.writeFile("/owned.txt", "by owner");
        const strangerFs = await openSharedFs({
            peerbit: stranger,
            address: ownerFs.address,
            machineLabel: "stranger",
        });
        // Two consecutive attempts: the second hits the negative-verdict
        // cache path and must be rejected identically.
        await expect(
            strangerFs.writeFile("/intruder.txt", "nope")
        ).rejects.toThrow();
        await expect(
            strangerFs.writeFile("/intruder.txt", "still nope")
        ).rejects.toThrow();

        await ownerFs.authorizeWriter(stranger.identity.publicKey);
        // The trust relation replicates to the stranger's replica, whose
        // change listener flushes the verdict cache; the write then lands.
        await waitUntil(async () => {
            await strangerFs.writeFile("/granted.txt", "now trusted");
        });
        await waitUntil(async () => {
            expect(decode(await ownerFs.readFile("/granted.txt"))).toBe(
                "now trusted"
            );
        });
    });

    it("flushes every memoized verdict on any trust-graph change", async () => {
        const owner = await Peerbit.create();
        const other = await Peerbit.create();
        peers.push(owner, other);
        const ownerFs = await openSharedFs({
            peerbit: owner,
            machineLabel: "owner",
            rootKey: owner.identity.publicKey,
        });
        await ownerFs.writeFile("/warm.txt", "warms the cache");
        const program: any = ownerFs.program;
        expect(program.trustVerdicts.size).toBeGreaterThan(0);

        await ownerFs.authorizeWriter(other.identity.publicKey);
        await waitUntil(() => {
            expect(program.trustVerdicts.size).toBe(0);
        });
        // And the cache re-warms on the next validated write.
        await ownerFs.writeFile("/rewarm.txt", "again");
        expect(program.trustVerdicts.size).toBeGreaterThan(0);
    });
});
