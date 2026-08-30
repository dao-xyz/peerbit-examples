import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    BootstrapPendingError,
    openSharedFs,
    type SharedFsHandle,
} from "../index.js";

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const waitUntil = async (
    assertion: () => Promise<void> | void,
    options: { timeoutMs?: number; intervalMs?: number } = {}
) => {
    const timeoutMs = options.timeoutMs ?? (process.env.CI ? 120_000 : 45_000);
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

describe("shared fs cold-start bootstrap", () => {
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

    const createPeer = async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        return peer;
    };

    /** A donor with a populated tree and a published snapshot. */
    const populatedDonor = async (fileCount: number) => {
        const peer = await createPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "donor",
        });
        await fs.writeBatch(
            Array.from({ length: fileCount }, (_, i) => ({
                path: `/tree/dir-${i % 10}/file-${i}.txt`,
                content: `content ${i}`,
            }))
        );
        // Post-snapshot history must not be required for a correct view:
        // edit one file, delete another, before the snapshot.
        await fs.writeFile("/tree/dir-0/file-0.txt", "edited content");
        await fs.rm("/tree/dir-1/file-1.txt");
        const snapshot = await fs.snapshotWrite();
        return { peer, fs, snapshot };
    };

    it(
        "serves a readable, winner-correct tree from the snapshot before the log replicates",
        { retry: 1, timeout: 240_000 },
        async () => {
            const donor = await populatedDonor(300);
            expect(donor.snapshot.segments).toBeGreaterThan(0);
            expect(Number(donor.snapshot.docs)).toBeGreaterThan(300);

            const joinerPeer = await createPeer();
            await joinerPeer.dial(donor.peer);
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: donor.fs.address,
                machineLabel: "joiner",
            });
            await waitUntil(
                () => {
                    const phase = joiner.bootstrapStatus().phase;
                    expect(["overlay-active", "converged"]).toContain(phase);
                },
                { intervalMs: 20 }
            );
            const statusAtReady = joiner.bootstrapStatus();
            if (statusAtReady.phase === "overlay-active") {
                // The whole point: the tree is correct while the log is
                // still replicating behind it.
                expect(statusAtReady.pendingDocs).toBeGreaterThan(0);
                expect(statusAtReady.guardArmed).toBe(false);
                expect(statusAtReady.manifest?.docs).toBe(donor.snapshot.docs);
                expect((await joiner.list("/tree")).length).toBe(10);
                expect((await joiner.list("/tree/dir-2")).length).toBe(30);
                // Post-snapshot-write states, via overlay heads: the edit
                // is visible, the deleted file is absent, and content
                // streams lazily from remote peers within the chunk-fetch
                // budget even though nothing is local yet.
                expect(
                    decode(await joiner.readFile("/tree/dir-0/file-0.txt"))
                ).toBe("edited content");
                expect(
                    await joiner.stat("/tree/dir-1/file-1.txt")
                ).toBeUndefined();
                expect(
                    decode(await joiner.readFile("/tree/dir-3/file-13.txt"))
                ).toBe("content 13");
                // Whole-store scans are gated while the view is partial.
                await expect(joiner.namingConflicts()).rejects.toThrow(
                    BootstrapPendingError
                );
                await expect(
                    joiner.versionsByChangeset("anything")
                ).rejects.toThrow(BootstrapPendingError);
                await expect(
                    joiner.namingConflicts(undefined, { allowPartial: true })
                ).resolves.toBeDefined();
                // Writes during the overlay window are allowed.
                await joiner.writeFile("/from-joiner.txt", "hello donor");
            }
            const converged = await joiner.awaitBootstrapConverged();
            expect(converged.verified).toBe(true);
            const statusAfter = joiner.bootstrapStatus();
            expect(statusAfter.phase).toBe("converged");
            expect(statusAfter.guardArmed).toBe(true);
            expect(statusAfter.pendingDocs).toBe(0);

            // After retirement the joiner serves the same world from its
            // own (cleared and refilled) caches and index.
            expect((await joiner.list("/tree")).length).toBe(10);
            expect(
                decode(await joiner.readFile("/tree/dir-0/file-0.txt"))
            ).toBe("edited content");
            expect(await joiner.stat("/tree/dir-1/file-1.txt")).toBeUndefined();
            expect(await joiner.namingConflicts()).toEqual([]);
            await waitUntil(async () => {
                expect(
                    decode(await donor.fs.readFile("/from-joiner.txt"))
                ).toBe("hello donor");
            });
        }
    );

    it(
        "falls back to a plain join when no snapshot exists",
        { retry: 1, timeout: 240_000 },
        async () => {
            const donorPeer = await createPeer();
            const donorFs = await openSharedFs({
                peerbit: donorPeer,
                machineLabel: "donor",
            });
            await donorFs.writeFile("/plain.txt", "no snapshot here");

            const joinerPeer = await createPeer();
            await joinerPeer.dial(donorPeer);
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: donorFs.address,
                machineLabel: "joiner",
            });
            await waitUntil(async () => {
                expect(decode(await joiner.readFile("/plain.txt"))).toBe(
                    "no snapshot here"
                );
            });
            expect(joiner.bootstrapStatus().phase).toBe("off");
            expect(joiner.bootstrapStatus().guardArmed).toBe(true);
        }
    );

    it(
        "require mode throws when no usable snapshot is found",
        { retry: 1, timeout: 240_000 },
        async () => {
            const donorPeer = await createPeer();
            const donorFs = await openSharedFs({
                peerbit: donorPeer,
                machineLabel: "donor",
            });
            await donorFs.writeFile("/x.txt", "1");
            const joinerPeer = await createPeer();
            await joinerPeer.dial(donorPeer);
            await expect(
                openSharedFs({
                    peerbit: joinerPeer,
                    address: donorFs.address,
                    machineLabel: "joiner",
                    bootstrap: { mode: "require", discoveryTimeoutMs: 2_000 },
                })
            ).rejects.toThrow(/bootstrap/);
        }
    );

    it(
        "rejects stale snapshots and falls back",
        { retry: 1, timeout: 240_000 },
        async () => {
            const donor = await populatedDonor(20);
            const joinerPeer = await createPeer();
            await joinerPeer.dial(donor.peer);
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: donor.fs.address,
                machineLabel: "joiner",
                bootstrap: { maxSnapshotAgeMs: 1, discoveryTimeoutMs: 2_000 },
            });
            await waitUntil(async () => {
                expect((await joiner.list("/tree")).length).toBe(10);
            });
            expect(joiner.bootstrapStatus().phase).toBe("off");
        }
    );

    it(
        "verifies the manifest against its own trust graph on an access-controlled filesystem",
        { retry: 1, timeout: 240_000 },
        async () => {
            const ownerPeer = await createPeer();
            const owner = await openSharedFs({
                peerbit: ownerPeer,
                machineLabel: "owner",
                rootKey: ownerPeer.identity.publicKey,
            });
            await owner.writeBatch(
                Array.from({ length: 40 }, (_, i) => ({
                    path: `/acl/f-${i}.txt`,
                    content: `guarded ${i}`,
                }))
            );
            await owner.snapshotWrite();

            const joinerPeer = await createPeer();
            await joinerPeer.dial(ownerPeer);
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: owner.address,
                machineLabel: "joiner",
            });
            await waitUntil(async () => {
                expect((await joiner.list("/acl")).length).toBe(40);
                expect(decode(await joiner.readFile("/acl/f-7.txt"))).toBe(
                    "guarded 7"
                );
            });
            const converged = await joiner.awaitBootstrapConverged();
            expect(converged.verified).toBe(true);
        }
    );

    it(
        "carries conflict fidelity: all heads ship, winners match the donor",
        { retry: 1, timeout: 240_000 },
        async () => {
            // Two writers race the same path, then A snapshots the
            // conflicted state.
            const a = await createPeer();
            const b = await createPeer();
            await a.dial(b);
            const fsA = await openSharedFs({ peerbit: a, machineLabel: "a" });
            const fsB = await openSharedFs({
                peerbit: b,
                address: fsA.address,
                machineLabel: "b",
            });
            await Promise.all([
                fsA.writeFile("/contested.txt", "from a"),
                fsB.writeFile("/contested.txt", "from b"),
            ]);
            await waitUntil(async () => {
                expect((await fsA.namingConflicts()).length).toBeGreaterThan(0);
                expect(await fsA.readFile("/contested.txt")).toBeDefined();
                expect(decode(await fsA.readFile("/contested.txt"))).toBe(
                    decode(await fsB.readFile("/contested.txt"))
                );
            });
            const donorWinner = decode(await fsA.readFile("/contested.txt"));
            await fsA.snapshotWrite();

            const joinerPeer = await createPeer();
            await joinerPeer.dial(a);
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: fsA.address,
                machineLabel: "joiner",
            });
            await waitUntil(async () => {
                expect(decode(await joiner.readFile("/contested.txt"))).toBe(
                    donorWinner
                );
            });
            await joiner.awaitBootstrapConverged();
            expect((await joiner.namingConflicts()).length).toBeGreaterThan(0);
            expect(decode(await joiner.readFile("/contested.txt"))).toBe(
                donorWinner
            );
        }
    );

    it(
        "keeps the safety posture when sync stalls: W1 dedup, gating asymmetry, unverified retirement",
        { retry: 1, timeout: 240_000 },
        async () => {
            const { chunkIdForBytes } = await import("../model.js");
            // Deep-history donor: a SMALL snapshot (heads only) over a LARGE
            // log (superseded versions). The joiner's overlay activates after
            // a few segment fetches while the log still has thousands of
            // history entries to stream — so stranding it mid-sync is
            // structural, not a timing race a fast runner can dissolve
            // (both fixed-size 1,000- and 3,000-file trees raced on CI).
            const buildDonor = async () => {
                const peer = await createPeer();
                const fs = await openSharedFs({
                    peerbit: peer,
                    machineLabel: "donor",
                });
                await fs.writeBatch(
                    Array.from({ length: 400 }, (_, i) => ({
                        path: `/tree/dir-${i % 10}/file-${i}.txt`,
                        content: `content ${i}`,
                    }))
                );
                for (let round = 1; round <= 8; round++) {
                    await fs.writeBatch(
                        Array.from({ length: 400 }, (_, i) => ({
                            path: `/tree/dir-${i % 10}/file-${i}.txt`,
                            content: `round ${round} content ${i}`,
                        }))
                    );
                }
                // One shallow, never-edited file: a stable probe for the
                // gating-asymmetry check (deep-history files can show
                // TRANSIENT multi-head conflicts mid-sync, legitimately).
                await fs.writeFile("/tree/shallow-probe.txt", "single version");
                await fs.writeFile("/tree/dir-0/file-0.txt", "edited content");
                await fs.rm("/tree/dir-1/file-1.txt");
                const snapshot = await fs.snapshotWrite();
                return { peer, fs, snapshot };
            };
            // Stranding a joiner mid-sync is inherently a race against the
            // replication engine; the deep-history donor makes the stall
            // window wide, and a bounded retry makes the setup reliable on
            // any runner speed. Assertions run on the first stranded join.
            let donor!: Awaited<ReturnType<typeof buildDonor>>;
            let joiner!: Awaited<ReturnType<typeof openSharedFs>>;
            let stranded = false;
            for (let attempt = 0; attempt < 4 && !stranded; attempt++) {
                donor = await buildDonor();
                const joinerPeer = await createPeer();
                await joinerPeer.dial(donor.peer);
                joiner = await openSharedFs({
                    peerbit: joinerPeer,
                    address: donor.fs.address,
                    machineLabel: "joiner",
                    bootstrap: { retirementTimeoutMs: 3_000 },
                });
                await waitUntil(
                    () => {
                        expect(joiner.bootstrapStatus().phase).toBe(
                            "overlay-active"
                        );
                    },
                    { intervalMs: 2 }
                );
                // Strand the joiner mid-sync: the overlay must keep
                // serving, and retirement must take the unverified path.
                await donor.peer.stop();
                if (joiner.bootstrapStatus().pendingDocs > 0) {
                    stranded = true;
                } else {
                    // The engine outran the stop; rebuild and try again.
                    await joinerPeer.stop().catch(() => {});
                }
            }
            expect(stranded).toBe(true);

            // Gating asymmetry: the per-file branch is overlay-consistent
            // and stays available; whole-store scans are gated. The probe
            // file has exactly one version, so no transient multi-head
            // state can surface as a conflict here.
            await expect(
                joiner.conflicts("/tree/shallow-probe.txt")
            ).resolves.toEqual([]);
            await expect(joiner.conflicts()).rejects.toThrow(/bootstrap/);

            // W1 pin: a write whose content matches an overlay-referenced
            // chunk must still PUT the chunk — overlay references are
            // invisible to dedup witness probes, so nothing may be skipped
            // on their account.
            const program: any = joiner.program;
            let sharedContent: string | undefined;
            let sharedChunkId: string | undefined;
            // Overlay heads carry the final round's content; scan back
            // through history rounds so a partially streamed chunk set can
            // always yield an absent-but-referenced candidate.
            outer: for (let round = 8; round >= 1; round--) {
                for (let i = 399; i >= 0; i--) {
                    const candidate = `round ${round} content ${i}`;
                    const id = chunkIdForBytes(
                        new TextEncoder().encode(candidate)
                    );
                    if (!(await program.hasDocument(id))) {
                        sharedContent = candidate;
                        sharedChunkId = id;
                        break outer;
                    }
                }
            }
            expect(sharedContent).toBeDefined();
            await joiner.writeFile("/dup-of-overlay.txt", sharedContent!);
            expect(await program.hasDocument(sharedChunkId!)).toBe(true);

            // Retirement times out (the donor is gone) into the
            // unverified posture: overlay retired, guard still down, GC
            // and snapshots refused, whole-store scans available again,
            // and awaitBootstrapConverged resolves instead of hanging.
            await waitUntil(() => {
                expect(joiner.bootstrapStatus().phase).toBe("unverified");
            });
            const status = joiner.bootstrapStatus();
            expect(status.guardArmed).toBe(false);
            await expect(joiner.awaitBootstrapConverged()).resolves.toEqual({
                verified: false,
            });
            await expect(joiner.snapshotWrite()).rejects.toThrow(/partial/);
            await expect(joiner.program.collectGarbage()).rejects.toThrow(
                /bootstrap/
            );
            await expect(joiner.namingConflicts()).resolves.toBeDefined();
            // The joiner's own write survived and is readable locally.
            expect(decode(await joiner.readFile("/dup-of-overlay.txt"))).toBe(
                sharedContent
            );
        }
    );
});
