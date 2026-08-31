import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { openSharedFs } from "../index.js";

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
 * Machine de-provisioning: revokeWriter removes the caller's outgoing
 * trust edge (directional ownership — only the truster who granted an
 * edge can revoke it), and new writes from the revoked machine bounce on
 * every converged replica while its pre-revocation documents remain.
 */
describe("shared fs writer revocation", () => {
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

    it("revoked writers lose write access; their history remains; re-grant restores", async () => {
        const owner = await Peerbit.create();
        const machine = await Peerbit.create();
        peers.push(owner, machine);
        await owner.dial(machine);
        const ownerFs = await openSharedFs({
            peerbit: owner,
            machineLabel: "owner",
            rootKey: owner.identity.publicKey,
        });
        const machineFs = await openSharedFs({
            peerbit: machine,
            address: ownerFs.address,
            machineLabel: "ephemeral",
            // This ACL fixture opens an empty namespace; readiness has no
            // namespace evidence until the machine itself writes.
            allowPartialWrites: true,
        });

        await ownerFs.authorizeWriter(machine.identity.publicKey);
        await waitUntil(async () => {
            await machineFs.writeFile("/from-machine.txt", "hello");
        });
        await waitUntil(async () => {
            expect(decode(await ownerFs.readFile("/from-machine.txt"))).toBe(
                "hello"
            );
        });

        // De-provision the machine.
        await ownerFs.revokeWriter(machine.identity.publicKey);
        expect(await ownerFs.isTrustedWriter(machine.identity.publicKey)).toBe(
            false
        );

        // Wait for the revocation to replicate to the machine's own
        // trust-graph copy (its verdict cache flushes on any graph change),
        // THEN assert the write bounces — probing by writing would let the
        // pre-replication attempts succeed and later identical writes
        // no-op-resolve without ever reaching canPerform.
        await waitUntil(async () => {
            expect(
                await machineFs.isTrustedWriter(machine.identity.publicKey)
            ).toBe(false);
        });
        await expect(
            machineFs.writeFile("/after-revoke.txt", "should fail")
        ).rejects.toThrow();
        // The owner never admits post-revocation writes either.
        expect(
            await ownerFs.readFile("/after-revoke.txt").catch(() => undefined)
        ).toBe(undefined);
        // Pre-revocation history is untouched (revocation is not
        // retroactive).
        expect(decode(await ownerFs.readFile("/from-machine.txt"))).toBe(
            "hello"
        );

        // Idempotent revoke; a fresh grant restores access.
        await ownerFs.revokeWriter(machine.identity.publicKey);
        await ownerFs.authorizeWriter(machine.identity.publicKey);
        await waitUntil(async () => {
            await machineFs.writeFile("/re-granted.txt", "back again");
        });
        await waitUntil(async () => {
            expect(decode(await ownerFs.readFile("/re-granted.txt"))).toBe(
                "back again"
            );
        });
    });

    it("a trusted member cannot revoke edges it does not own", async () => {
        const owner = await Peerbit.create();
        const memberA = await Peerbit.create();
        const memberB = await Peerbit.create();
        peers.push(owner, memberA, memberB);
        await owner.dial(memberA);
        await owner.dial(memberB);
        await memberA.dial(memberB);
        const ownerFs = await openSharedFs({
            peerbit: owner,
            machineLabel: "owner",
            rootKey: owner.identity.publicKey,
        });
        const aFs = await openSharedFs({
            peerbit: memberA,
            address: ownerFs.address,
            machineLabel: "a",
        });
        await ownerFs.authorizeWriter(memberA.identity.publicKey);
        await ownerFs.authorizeWriter(memberB.identity.publicKey);
        await waitUntil(async () => {
            expect(await aFs.isTrustedWriter(memberB.identity.publicKey)).toBe(
                true
            );
        });

        // A tries to revoke the OWNER's edge to B: directional ownership
        // means A owns no edge to B, so nothing is removed — B stays
        // trusted on every replica.
        await aFs.revokeWriter(memberB.identity.publicKey).catch(() => {
            /* rejecting outright is equally acceptable */
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(await ownerFs.isTrustedWriter(memberB.identity.publicKey)).toBe(
            true
        );
        expect(await aFs.isTrustedWriter(memberB.identity.publicKey)).toBe(
            true
        );
    });
});
