import { Peerbit } from "peerbit";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSharedFs, type BootstrapTelemetryEvent } from "../index.js";
import { stopTestPeers } from "./stop-test-peers.js";

// allowPartialWrites makes a session writable, never its view proven: the
// resurrection guard (Guard D) must not arm on whatever that view lacks.
describe("allowPartialWrites and the resurrection guard", () => {
    const peers: Peerbit[] = [];

    afterEach(async () => {
        vi.restoreAllMocks();
        await stopTestPeers(peers);
    });

    const createPeer = async (directory?: string) => {
        const peer = await Peerbit.create(directory ? { directory } : {});
        peers.push(peer);
        return peer;
    };

    /** A populated donor and a dialed joiner peer. */
    const donorAndJoiner = async (options: { snapshot: boolean }) => {
        const donorPeer = await createPeer();
        const donor = await openSharedFs({
            peerbit: donorPeer,
            machineLabel: "guard-donor",
        });
        await donor.writeBatch(
            Array.from({ length: 20 }, (_, i) => ({
                path: `/f-${i}.txt`,
                content: `content ${i}`,
            }))
        );
        if (options.snapshot) {
            await donor.snapshotWrite();
        }
        const joinerPeer = await createPeer();
        await joinerPeer.dial(donorPeer);
        return { donor, joinerPeer };
    };

    it("stays disarmed when the bootstrap falls back to a plain join", async () => {
        // Without a snapshot the donor's only manifest is the genesis, so
        // discovery finds nothing to install.
        const { donor, joinerPeer } = await donorAndJoiner({
            snapshot: false,
        });
        const postures: string[] = [];
        const joiner = await openSharedFs({
            peerbit: joinerPeer,
            address: donor.address,
            machineLabel: "guard-plain-join",
            allowPartialWrites: true,
            bootstrap: { discoveryTimeoutMs: 500 },
            telemetry: {
                bootstrap: (event: BootstrapTelemetryEvent) => {
                    if (event.type === "fallback") {
                        postures.push(event.posture);
                    }
                },
            },
        });
        await (joiner.program as any).bootstrapDecision;
        expect(postures).toEqual(["plain-join"]);
        expect(joiner.bootstrapStatus()).toMatchObject({
            phase: "off",
            writeReady: true,
            partialWriteOverride: true,
            guardArmed: false,
        });
    });

    it("stays disarmed after a verified retirement", async () => {
        const { donor, joinerPeer } = await donorAndJoiner({ snapshot: true });
        const joiner = await openSharedFs({
            peerbit: joinerPeer,
            address: donor.address,
            machineLabel: "guard-verified",
            allowPartialWrites: true,
        });
        await expect(joiner.awaitBootstrapConverged()).resolves.toEqual({
            verified: true,
        });
        expect(joiner.bootstrapStatus()).toMatchObject({
            phase: "converged",
            snapshotCoverageVerified: true,
            partialWriteOverride: true,
            guardArmed: false,
        });
    });

    it("stays disarmed after an unverified retirement quiesces", async () => {
        const { donor, joinerPeer } = await donorAndJoiner({
            snapshot: false,
        });
        const joiner = await openSharedFs({
            peerbit: joinerPeer,
            address: donor.address,
            machineLabel: "guard-quiescence",
            allowPartialWrites: true,
            bootstrap: false,
        });
        const program: any = joiner.program;
        // Enter the unverified posture and run its two quiescence checks
        // directly: each is five minutes apart in production.
        const realSetInterval = globalThis.setInterval;
        let check: (() => void) | undefined;
        const setIntervalSpy = vi
            .spyOn(globalThis, "setInterval")
            .mockImplementation(((callback: () => void) => {
                check = callback;
                return realSetInterval(() => {}, 2 ** 30);
            }) as typeof setInterval);
        try {
            program.enterUnverified(
                program.openGeneration,
                "test: unverified retirement"
            );
        } finally {
            setIntervalSpy.mockRestore();
        }
        expect(check).toBeDefined();
        expect(joiner.bootstrapStatus()).toMatchObject({
            phase: "unverified",
            guardArmed: false,
        });
        program.lastArrivalMs = 0;
        check!();
        check!();
        expect(joiner.bootstrapStatus()).toMatchObject({
            phase: "converged",
            partialWriteOverride: true,
            guardArmed: false,
        });
    });

    it("stays armed on a warm reopen, whose view is proven", async () => {
        const root = await mkdtemp(join(tmpdir(), "shared-fs-guard-warm-"));
        try {
            const directory = join(root, "peer");
            const creatorPeer = await createPeer(directory);
            const creator = await openSharedFs({
                peerbit: creatorPeer,
                machineLabel: "guard-warm-creator",
            });
            await creator.writeFile("/kept.txt", "kept");
            const address = creator.address!;
            await stopTestPeers(peers);

            const reopenedPeer = await createPeer(directory);
            const reopened = await openSharedFs({
                peerbit: reopenedPeer,
                address,
                machineLabel: "guard-warm-override",
                allowPartialWrites: true,
            });
            await (reopened.program as any).bootstrapDecision;
            expect(reopened.bootstrapStatus()).toMatchObject({
                writeReady: true,
                partialWriteOverride: true,
                writeReadinessSource: "creator",
                guardArmed: true,
            });
        } finally {
            await stopTestPeers(peers);
            await rm(root, { recursive: true, force: true });
        }
    });
});
