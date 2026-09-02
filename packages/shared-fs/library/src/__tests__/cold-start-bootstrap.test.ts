import { Peerbit } from "peerbit";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    BootstrapPendingError,
    SharedFsWritePendingError,
    createSharedFsMountBackend,
    openSharedFs,
    type SharedFsHandle,
} from "../index.js";
import { FileVersion } from "../model.js";

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

    it("keeps creators and proven warm persisted reopens immediately writable", async () => {
        const root = await mkdtemp(join(tmpdir(), "shared-fs-write-ready-"));
        let creatorPeer: Peerbit | undefined;
        let reopenedPeer: Peerbit | undefined;
        let observerPeer: Peerbit | undefined;
        let postObserverPeer: Peerbit | undefined;
        try {
            const directory = join(root, "peer");
            creatorPeer = await Peerbit.create({ directory });
            const creator = await openSharedFs({
                peerbit: creatorPeer,
                machineLabel: "creator",
            });
            expect(creator.bootstrapStatus().writeReady).toBe(true);
            await creator.awaitWriteReady({ timeout: 100 });
            await creator.writeFile("/creator.txt", "one");
            const address = creator.address!;
            await creatorPeer.stop();
            creatorPeer = undefined;

            reopenedPeer = await Peerbit.create({ directory });
            const reopened = await openSharedFs({
                peerbit: reopenedPeer,
                address,
                machineLabel: "warm-reopen",
            });
            expect(reopened.bootstrapStatus().writeReady).toBe(true);
            await reopened.writeFile("/creator.txt", "two");
            expect(decode(await reopened.readFile("/creator.txt"))).toBe("two");
            await reopenedPeer.stop();
            reopenedPeer = undefined;

            // A persisted full-replica proof must not accidentally make a
            // later observer writable. Observers cannot establish or retain
            // a complete namespace and therefore stay closed by default.
            observerPeer = await Peerbit.create({ directory });
            const observer = await openSharedFs({
                peerbit: observerPeer,
                address,
                machineLabel: "warm-observer",
                replicate: false,
            });
            expect(observer.bootstrapStatus().writeReady).toBe(false);
            await expect(
                observer.awaitWriteReady({ timeout: 100 })
            ).rejects.toMatchObject({ code: "ETIMEDOUT" });
            expect(decode(await observer.readFile("/creator.txt"))).toBe("two");
            await observerPeer.stop();
            observerPeer = undefined;

            // Opening as an observer invalidates the old persisted proof;
            // changing back to a full replica cannot resurrect it without
            // fresh remote evidence.
            postObserverPeer = await Peerbit.create({ directory });
            const postObserver = await openSharedFs({
                peerbit: postObserverPeer,
                address,
                machineLabel: "post-observer-full",
                bootstrap: false,
                writeReadinessSettleMs: 100,
            } as any);
            expect(postObserver.bootstrapStatus().writeReady).toBe(false);
            await expect(
                postObserver.writeFile("/creator.txt", "unsafe")
            ).rejects.toBeInstanceOf(SharedFsWritePendingError);
            // Even if delayed local replay/repair is misclassified as
            // metadata evidence, a disconnected store cannot self-certify.
            (postObserver.program as any).writeReadinessRemoteEvidence = true;
            await expect(
                postObserver.awaitWriteReady({ timeout: 350 })
            ).rejects.toMatchObject({ code: "ETIMEDOUT" });
        } finally {
            await postObserverPeer?.stop().catch(() => {});
            await observerPeer?.stop().catch(() => {});
            await reopenedPeer?.stop().catch(() => {});
            await creatorPeer?.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it("cancels and joins warm-reopen bootstrap work before close returns", async () => {
        const root = await mkdtemp(
            join(tmpdir(), "shared-fs-close-bootstrap-")
        );
        const directory = join(root, "peer");
        let creatorPeer: Peerbit | undefined;
        let reopenedPeer: Peerbit | undefined;
        try {
            creatorPeer = await Peerbit.create({ directory });
            const creator = await openSharedFs({
                peerbit: creatorPeer,
                machineLabel: "close-bootstrap-creator",
            });
            const address = creator.address!;
            await creatorPeer.stop();
            await creatorPeer.services.blocks.stop();
            creatorPeer = undefined;

            reopenedPeer = await Peerbit.create({ directory });
            const reopened = await openSharedFs({
                peerbit: reopenedPeer,
                address,
                machineLabel: "close-bootstrap-warm",
                bootstrap: { discoveryTimeoutMs: 100 },
            });
            expect(reopened.bootstrapStatus().writeReady).toBe(true);
            await reopenedPeer.stop();
            await reopenedPeer.services.blocks.stop();
            reopenedPeer = undefined;

            await rm(directory, { recursive: true, force: true });
            // Without lifecycle cancellation, the timed-out background
            // bootstrap falls back after close and recreates this directory.
            await new Promise((resolve) => setTimeout(resolve, 300));
            await expect(readdir(directory)).rejects.toMatchObject({
                code: "ENOENT",
            });
        } finally {
            await creatorPeer?.stop().catch(() => {});
            await reopenedPeer?.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it("retires promptly when the final pending overlay document arrives", async () => {
        const peer = await createPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "exact-arrival-retirement",
        });
        const program: any = fs.program;
        const pending = (id: string) =>
            new Map([
                [id, { nodeId: "exact-arrival-node", kind: "file-version" }],
            ]);
        const version = (id: string) =>
            new FileVersion({
                id,
                nodeId: "exact-arrival-node",
                causalDepth: 1n,
                contentHash: "empty",
                size: 0n,
                chunkIds: [],
                createdAt: 1n,
                authorKey: "test-author",
                machineLabel: "test-machine",
            });
        program.bootstrapPhase = "overlay-active";
        program.bootstrapVerified = false;
        program.guardArmed = false;
        program.overlayPending = pending("first-final-id");

        // Exercise the real Documents change consumer. This fixture does not
        // start the five-second supersession sweep, so verified convergence
        // can only happen through the exact non-empty -> empty transition.
        program.changeListener({
            detail: { added: [version("first-final-id")], removed: [] },
        });
        expect(program.overlayPending.size).toBe(0);
        const firstTimer = program.verifiedRetirementTimer;
        expect(firstTimer).toBeDefined();

        // Concurrent sweep completion must reuse the already scheduled check.
        program.maybeRetireVerified();
        expect(program.verifiedRetirementTimer).toBe(firstTimer);

        // Additions do not shrink the view and leave the coalescing deadline
        // alone, while a metadata-removal burst restarts the quiet check.
        program.changeListener({
            detail: { added: [version("later-addition")], removed: [] },
        });
        expect(program.verifiedRetirementTimer).toBe(firstTimer);
        program.changeListener({
            detail: { added: [], removed: [version("later-removal")] },
        });
        expect(program.verifiedRetirementTimer).toBeDefined();
        expect(program.verifiedRetirementTimer).not.toBe(firstTimer);

        // The same cancellation path used by close/reopen must disarm it.
        program.clearBootstrapTimers();
        expect(program.verifiedRetirementTimer).toBeUndefined();
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(program.bootstrapPhase).toBe("overlay-active");

        // A subsequent generation of pending work can schedule normally and
        // converges after the 300 ms double-check, without a sweep tick.
        program.overlayPending = pending("second-final-id");
        program.changeListener({
            detail: { added: [version("second-final-id")], removed: [] },
        });
        await waitUntil(
            () => {
                expect(program.bootstrapPhase).toBe("converged");
                expect(program.bootstrapVerified).toBe(true);
            },
            { timeoutMs: 1_500, intervalMs: 10 }
        );
    });

    it("reconciles already-covered and empty overlays immediately", async () => {
        const peer = await createPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "immediate-retirement-reconcile",
        });
        const program: any = fs.program;
        const generation = program.openGeneration;
        program.bootstrapPhase = "overlay-active";
        program.bootstrapVerified = false;
        program.guardArmed = false;

        // A verified empty snapshot has no final change event to wake the
        // tracker, but must still schedule the verified double-check now.
        program.overlayPending = new Map();
        program.startRetirementTracking(generation);
        expect(program.verifiedRetirementTimer).toBeDefined();
        program.clearBootstrapTimers();

        // Likewise, replication may have committed a snapshot id before the
        // overlay was installed. The initial query reconciles that state
        // without waiting for the five-second interval.
        program.overlayPending = new Map([
            [
                "already-present",
                {
                    nodeId: "already-present-node",
                    kind: "file-version",
                },
            ],
        ]);
        program.queryRows = async () => [
            {
                id: "already-present",
                nodeId: "already-present-node",
                kind: "file-version",
                causalRefs: [],
                causalDepth: 1n,
            },
        ];
        program.startRetirementTracking(generation);
        await waitUntil(
            () => {
                expect(program.overlayPending.size).toBe(0);
                expect(program.verifiedRetirementTimer).toBeDefined();
            },
            { timeoutMs: 1_000, intervalMs: 5 }
        );
        program.clearBootstrapTimers();
    });

    it("ignores a supersession query that completes after reopen", async () => {
        const peer = await createPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "stale-retirement-sweep",
        });
        const program: any = fs.program;
        const originalGeneration = program.openGeneration;
        const originalQueryRows = program.queryRows.bind(program);
        let resolveQuery!: (rows: unknown[]) => void;
        program.bootstrapPhase = "overlay-active";
        program.overlayPending = new Map([
            [
                "same-id-across-reopen",
                { nodeId: "same-node", kind: "file-version" },
            ],
        ]);
        program.queryRows = () =>
            new Promise<unknown[]>((resolve) => {
                resolveQuery = resolve;
            });

        const staleSweep = program.supersessionSweep(originalGeneration);
        await waitUntil(() => expect(resolveQuery).toBeTypeOf("function"), {
            timeoutMs: 1_000,
            intervalMs: 5,
        });
        const reopenedGeneration = originalGeneration + 1;
        program.openGeneration = reopenedGeneration;
        program.overlayPending = new Map([
            [
                "same-id-across-reopen",
                { nodeId: "same-node", kind: "file-version" },
            ],
        ]);
        // Model a new generation that began its own sweep before the stale
        // query returned; the old finally must not clear this ownership.
        program.sweepRunningGeneration = reopenedGeneration;
        resolveQuery([
            {
                id: "same-id-across-reopen",
                nodeId: "same-node",
                kind: "file-version",
                causalRefs: [],
                causalDepth: 1n,
            },
        ]);
        await staleSweep;
        expect(program.overlayPending.has("same-id-across-reopen")).toBe(true);
        expect(program.sweepRunningGeneration).toBe(reopenedGeneration);

        program.queryRows = originalQueryRows;
        program.sweepRunningGeneration = undefined;
        program.bootstrapPhase = "off";
    });

    it("keeps fresh observers closed unless partial writes are explicit", async () => {
        const donorPeer = await createPeer();
        const donor = await openSharedFs({
            peerbit: donorPeer,
            machineLabel: "donor",
        });
        await donor.writeFile("/existing.txt", "one");

        const observerPeer = await createPeer();
        await observerPeer.dial(donorPeer);
        const observer = await openSharedFs({
            peerbit: observerPeer,
            address: donor.address,
            machineLabel: "observer",
            replicate: false,
        });
        await expect(
            observer.awaitWriteReady({ timeout: 100 })
        ).rejects.toMatchObject({ code: "ETIMEDOUT" });
        await expect(
            observer.writeFile("/unsafe.txt", "no")
        ).rejects.toBeInstanceOf(SharedFsWritePendingError);
        const controller = new AbortController();
        const aborted = observer.awaitWriteReady({
            signal: controller.signal,
        });
        controller.abort(new Error("caller stopped waiting"));
        await expect(aborted).rejects.toThrow("caller stopped waiting");

        const overridePeer = await createPeer();
        await overridePeer.dial(donorPeer);
        const override = await openSharedFs({
            peerbit: overridePeer,
            address: donor.address,
            machineLabel: "override",
            replicate: false,
            allowPartialWrites: true,
        });
        expect(override.bootstrapStatus()).toMatchObject({
            writeReady: true,
            partialWriteOverride: true,
        });
        await expect(
            override.writeFile("/explicitly-unsafe.txt", "yes")
        ).resolves.toBeDefined();
        // The override is deliberately limited to recoverable namespace
        // mutations. It must never publish/collect/certify partial state.
        await expect(override.snapshotWrite()).rejects.toMatchObject({
            code: "EAGAIN",
        });
        await expect(override.collectGarbage()).rejects.toMatchObject({
            code: "EAGAIN",
        });
        await expect(
            override.prepareForDisposal({ minAcks: 1 })
        ).rejects.toMatchObject({ code: "EAGAIN" });

        const closedWait = observer.awaitWriteReady();
        const closedExpectation = expect(closedWait).rejects.toMatchObject({
            code: "ECLOSED",
        });
        await observerPeer.stop();
        await closedExpectation;
    });

    it("fails closed for a pre-marker store until an explicit legacy trust assertion persists", async () => {
        const root = await mkdtemp(join(tmpdir(), "shared-fs-legacy-ready-"));
        const directory = join(root, "peer");
        let creatorPeer: Peerbit | undefined;
        let reopenedPeer: Peerbit | undefined;
        let promotionPeer: Peerbit | undefined;
        let finalPeer: Peerbit | undefined;
        try {
            creatorPeer = await Peerbit.create({ directory });
            const creator = await openSharedFs({
                peerbit: creatorPeer,
                machineLabel: "legacy-creator",
            });
            const address = creator.address!;
            await creator.writeFile("/legacy.txt", "persisted local state");
            await creatorPeer.stop();
            creatorPeer = undefined;

            const stateDirectory = join(directory, "shared-fs-bootstrap");
            const [stateName] = await readdir(stateDirectory);
            const statePath = join(stateDirectory, stateName);
            const legacy = JSON.parse(await readFile(statePath, "utf8"));
            delete legacy.writeReady;
            delete legacy.writeReadySource;
            delete legacy.legacyUnproven;
            await writeFile(statePath, JSON.stringify(legacy));

            reopenedPeer = await Peerbit.create({ directory });
            const reopened = await openSharedFs({
                peerbit: reopenedPeer,
                address,
                machineLabel: "legacy-status-like-open",
                writeReadinessSettleMs: 100,
            } as any);
            expect(decode(await reopened.readFile("/legacy.txt"))).toBe(
                "persisted local state"
            );
            expect(reopened.bootstrapStatus().writeReady).toBe(false);
            expect(reopened.bootstrapStatus().guardArmed).toBe(false);
            expect(reopened.bootstrapStatus().legacyPromotionEligible).toBe(
                true
            );
            await expect(
                reopened.awaitWriteReady({ timeout: 350 })
            ).rejects.toMatchObject({ code: "ETIMEDOUT" });
            await expect(
                (reopened as any).trustLegacyLocalReplica({})
            ).rejects.toMatchObject({ code: "EINVAL" });

            // The first upgraded open records durable eligibility without
            // turning the absence of remote changes into proof.
            const gatedState = JSON.parse(await readFile(statePath, "utf8"));
            expect(gatedState).toMatchObject({
                openedBefore: true,
                writeReady: false,
                legacyUnproven: true,
            });
            await reopenedPeer.stop();
            reopenedPeer = undefined;

            promotionPeer = await Peerbit.create({ directory });
            const promotion = await openSharedFs({
                peerbit: promotionPeer,
                address,
                machineLabel: "legacy-promotion",
                bootstrap: false,
                writeReadinessSettleMs: 100,
            } as any);
            expect(promotion.bootstrapStatus().legacyPromotionEligible).toBe(
                true
            );
            const program: any = promotion.program;
            const writeBootstrapState =
                program.writeBootstrapState.bind(program);
            program.writeBootstrapState = async (
                patch: any,
                ...rest: any[]
            ) => {
                if (patch?.writeReadySource === "legacy-operator-assertion") {
                    throw new Error("simulated state write failure");
                }
                return writeBootstrapState(patch, ...rest);
            };
            await expect(
                promotion.trustLegacyLocalReplica({
                    assumeComplete: true,
                    timeout: 2_000,
                })
            ).rejects.toThrow("simulated state write failure");
            expect(promotion.bootstrapStatus()).toMatchObject({
                writeReady: false,
                guardArmed: false,
                legacyPromotionEligible: true,
            });
            program.writeBootstrapState = writeBootstrapState;
            let releaseLegacyWrite!: () => void;
            let legacyWriteStarted!: () => void;
            const legacyWriteGate = new Promise<void>((resolve) => {
                releaseLegacyWrite = resolve;
            });
            const legacyWriteEntered = new Promise<void>((resolve) => {
                legacyWriteStarted = resolve;
            });
            program.writeBootstrapState = async (
                patch: any,
                ...rest: any[]
            ) => {
                if (patch?.writeReadySource === "legacy-operator-assertion") {
                    legacyWriteStarted();
                    await legacyWriteGate;
                }
                return writeBootstrapState(patch, ...rest);
            };
            const explicitPromotion = promotion.trustLegacyLocalReplica({
                assumeComplete: true,
                timeout: 2_000,
            });
            await legacyWriteEntered;
            // A remote-ready callback that races behind the explicit
            // assertion must not overwrite its durable/status provenance.
            const remotePromotion = program.markWriteReady(
                program.openGeneration
            );
            releaseLegacyWrite();
            await explicitPromotion;
            await remotePromotion;
            program.writeBootstrapState = writeBootstrapState;
            expect(promotion.bootstrapStatus()).toMatchObject({
                writeReady: true,
                guardArmed: true,
                legacyPromotionEligible: false,
                writeReadinessSource: "legacy-operator-assertion",
            });
            expect(
                JSON.parse(await readFile(statePath, "utf8")).writeReadySource
            ).toBe("legacy-operator-assertion");
            await promotion.writeFile("/legacy.txt", "trusted local state");
            await promotionPeer.stop();
            promotionPeer = undefined;

            // The assertion is per directory/address and survives a normal
            // offline reopen; it is not a flag that must be repeated.
            finalPeer = await Peerbit.create({ directory });
            const final = await openSharedFs({
                peerbit: finalPeer,
                address,
                machineLabel: "legacy-final-reopen",
                bootstrap: false,
            });
            expect(final.bootstrapStatus()).toMatchObject({
                writeReady: true,
                writeReadinessSource: "legacy-operator-assertion",
            });
            expect(decode(await final.readFile("/legacy.txt"))).toBe(
                "trusted local state"
            );
        } finally {
            await finalPeer?.stop().catch(() => {});
            await promotionPeer?.stop().catch(() => {});
            await reopenedPeer?.stop().catch(() => {});
            await creatorPeer?.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it("keeps partial-write recovery session-only and clears legacy promotion eligibility", async () => {
        const root = await mkdtemp(
            join(tmpdir(), "shared-fs-legacy-override-")
        );
        const directory = join(root, "peer");
        let creatorPeer: Peerbit | undefined;
        let overridePeer: Peerbit | undefined;
        let finalPeer: Peerbit | undefined;
        try {
            creatorPeer = await Peerbit.create({ directory });
            const creator = await openSharedFs({
                peerbit: creatorPeer,
                machineLabel: "legacy-override-creator",
            });
            await creator.writeFile("/legacy.txt", "before override");
            const address = creator.address!;
            await creatorPeer.stop();
            creatorPeer = undefined;

            const stateDirectory = join(directory, "shared-fs-bootstrap");
            const [stateName] = await readdir(stateDirectory);
            const statePath = join(stateDirectory, stateName);
            const legacy = JSON.parse(await readFile(statePath, "utf8"));
            delete legacy.writeReady;
            delete legacy.writeReadySource;
            delete legacy.legacyUnproven;
            await writeFile(statePath, JSON.stringify(legacy));

            overridePeer = await Peerbit.create({ directory });
            const override = await openSharedFs({
                peerbit: overridePeer,
                address,
                machineLabel: "legacy-override",
                bootstrap: false,
                allowPartialWrites: true,
            });
            expect(override.bootstrapStatus()).toMatchObject({
                writeReady: true,
                partialWriteOverride: true,
                legacyPromotionEligible: false,
            });
            await override.writeFile("/recovery.txt", "session-only");
            await overridePeer.stop();
            overridePeer = undefined;

            finalPeer = await Peerbit.create({ directory });
            const final = await openSharedFs({
                peerbit: finalPeer,
                address,
                machineLabel: "after-legacy-override",
                bootstrap: false,
                writeReadinessSettleMs: 100,
            } as any);
            expect(final.bootstrapStatus()).toMatchObject({
                writeReady: false,
                partialWriteOverride: false,
                legacyPromotionEligible: false,
                guardArmed: false,
            });
            await expect(
                final.trustLegacyLocalReplica({
                    assumeComplete: true,
                    timeout: 500,
                })
            ).rejects.toMatchObject({ code: "EINVAL" });
        } finally {
            await finalPeer?.stop().catch(() => {});
            await overridePeer?.stop().catch(() => {});
            await creatorPeer?.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it("does not leave a trusted marker when close rejects a queued legacy promotion", async () => {
        const root = await mkdtemp(
            join(tmpdir(), "shared-fs-legacy-close-race-")
        );
        const directory = join(root, "peer");
        let creatorPeer: Peerbit | undefined;
        let promotionPeer: Peerbit | undefined;
        let reopenedPeer: Peerbit | undefined;
        try {
            creatorPeer = await Peerbit.create({ directory });
            const creator = await openSharedFs({
                peerbit: creatorPeer,
                machineLabel: "legacy-close-creator",
            });
            const address = creator.address!;
            await creator.writeFile("/before.txt", "complete local state");
            await creatorPeer.stop();
            creatorPeer = undefined;

            const stateDirectory = join(directory, "shared-fs-bootstrap");
            const [stateName] = await readdir(stateDirectory);
            const statePath = join(stateDirectory, stateName);
            const legacy = JSON.parse(await readFile(statePath, "utf8"));
            delete legacy.writeReady;
            delete legacy.writeReadySource;
            delete legacy.legacyUnproven;
            await writeFile(statePath, JSON.stringify(legacy));

            promotionPeer = await Peerbit.create({ directory });
            const promotion = await openSharedFs({
                peerbit: promotionPeer,
                address,
                machineLabel: "legacy-close-promotion",
                bootstrap: false,
                writeReadinessSettleMs: 100,
            } as any);
            const program: any = promotion.program;
            let releaseQueue!: () => void;
            const queueGate = new Promise<void>((resolve) => {
                releaseQueue = resolve;
            });
            program.writeReadinessTransitionChain = queueGate;
            const trust = promotion.trustLegacyLocalReplica({
                assumeComplete: true,
                timeout: 2_000,
            });
            await waitUntil(
                () => {
                    expect(program.writeReadinessTransitionChain).not.toBe(
                        queueGate
                    );
                },
                { timeoutMs: 3_000, intervalMs: 10 }
            );

            const stopping = promotionPeer.stop();
            await waitUntil(
                () => {
                    expect(program.writeReadinessLifecycleBlocked).toBe(true);
                },
                { timeoutMs: 3_000, intervalMs: 10 }
            );
            releaseQueue();
            await expect(trust).rejects.toMatchObject({ code: "ECLOSED" });
            await stopping;
            promotionPeer = undefined;

            expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject(
                {
                    writeReady: false,
                }
            );
            reopenedPeer = await Peerbit.create({ directory });
            const reopened = await openSharedFs({
                peerbit: reopenedPeer,
                address,
                machineLabel: "legacy-close-reopen",
                bootstrap: false,
            });
            expect(reopened.bootstrapStatus()).toMatchObject({
                writeReady: false,
                guardArmed: false,
                legacyPromotionEligible: true,
            });
        } finally {
            await reopenedPeer?.stop().catch(() => {});
            await promotionPeer?.stop().catch(() => {});
            await creatorPeer?.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it("does not count local replay when a populated store lost its sidecar", async () => {
        const root = await mkdtemp(
            join(tmpdir(), "shared-fs-missing-sidecar-")
        );
        const directory = join(root, "persisted");
        let originalPeer: Peerbit | undefined;
        let donorPeer: Peerbit | undefined;
        let reopenedPeer: Peerbit | undefined;
        try {
            originalPeer = await Peerbit.create({ directory });
            const original = await openSharedFs({
                peerbit: originalPeer,
                machineLabel: "missing-sidecar-original",
            });
            await original.writeFile("/persisted.txt", "local replay");
            const address = original.address!;

            donorPeer = await Peerbit.create();
            await donorPeer.dial(originalPeer);
            const donor = await openSharedFs({
                peerbit: donorPeer,
                address,
                machineLabel: "missing-sidecar-donor",
                bootstrap: false,
            });
            await waitUntil(async () => {
                expect(decode(await donor.readFile("/persisted.txt"))).toBe(
                    "local replay"
                );
            });
            await originalPeer.stop();
            originalPeer = undefined;

            const stateDirectory = join(directory, "shared-fs-bootstrap");
            const [stateName] = await readdir(stateDirectory);
            await rm(join(stateDirectory, stateName));

            reopenedPeer = await Peerbit.create({ directory });
            await reopenedPeer.dial(donorPeer);
            const reopened = await openSharedFs({
                peerbit: reopenedPeer,
                address,
                machineLabel: "missing-sidecar-reopen",
                bootstrap: false,
                writeReadinessSettleMs: 100,
            } as any);
            expect(decode(await reopened.readFile("/persisted.txt"))).toBe(
                "local replay"
            );
            expect((reopened.program as any).writeReadinessRemoteEvidence).toBe(
                false
            );
            await expect(
                reopened.awaitWriteReady({ timeout: 500 })
            ).rejects.toMatchObject({ code: "ETIMEDOUT" });
            expect(reopened.bootstrapStatus()).toMatchObject({
                writeReady: false,
                guardArmed: false,
                legacyPromotionEligible: false,
            });
        } finally {
            await reopenedPeer?.stop().catch(() => {});
            await donorPeer?.stop().catch(() => {});
            await originalPeer?.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it("does not reuse a prior listener as evidence on same-program reopen", async () => {
        const root = await mkdtemp(
            join(tmpdir(), "shared-fs-same-program-replay-")
        );
        const directory = join(root, "persisted");
        let localPeer: Peerbit | undefined;
        let donorPeer: Peerbit | undefined;
        try {
            localPeer = await Peerbit.create({ directory });
            const original = await openSharedFs({
                peerbit: localPeer,
                machineLabel: "same-program-original",
            });
            await original.writeFile("/persisted.txt", "local replay");
            const address = original.address!;
            const originalProgram = original.program;

            donorPeer = await Peerbit.create();
            await donorPeer.dial(localPeer);
            const donor = await openSharedFs({
                peerbit: donorPeer,
                address,
                machineLabel: "same-program-donor",
                bootstrap: false,
            });
            await waitUntil(async () => {
                expect(decode(await donor.readFile("/persisted.txt"))).toBe(
                    "local replay"
                );
            });

            // Program.open(existing:"reuse") retains the Documents EventTarget.
            // The old generation's listener must be detached before the local
            // index replays, and the temporary listener may accept only a
            // document change paired with a successful network commit phase.
            await original.program.close();
            const stateDirectory = join(directory, "shared-fs-bootstrap");
            const [stateName] = await readdir(stateDirectory);
            await rm(join(stateDirectory, stateName));
            const reopened = await localPeer.open(originalProgram, {
                existing: "reuse",
                args: {
                    addressOpen: true,
                    machineLabel: "same-program-reopen",
                    bootstrap: false,
                    writeReadinessSettleMs: 100,
                } as any,
            });
            expect(reopened === originalProgram).toBe(true);
            expect(decode(await reopened.readFile("/persisted.txt"))).toBe(
                "local replay"
            );
            expect((reopened as any).writeReadinessRemoteEvidence).toBe(false);
            await expect(
                reopened.awaitWriteReady({ timeout: 500 })
            ).rejects.toMatchObject({ code: "ETIMEDOUT" });
            expect(reopened.bootstrapStatus()).toMatchObject({
                writeReady: false,
                guardArmed: false,
                legacyPromotionEligible: false,
            });
        } finally {
            await donorPeer?.stop().catch(() => {});
            await localPeer?.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it("treats unknown markers and source-less ready state as corrupt", async () => {
        const root = await mkdtemp(join(tmpdir(), "shared-fs-corrupt-state-"));
        const directory = join(root, "peer");
        let creatorPeer: Peerbit | undefined;
        let unknownPeer: Peerbit | undefined;
        let sourceLessPeer: Peerbit | undefined;
        try {
            creatorPeer = await Peerbit.create({ directory });
            const creator = await openSharedFs({
                peerbit: creatorPeer,
                machineLabel: "corrupt-state-creator",
            });
            const address = creator.address!;
            await creator.writeFile("/kept.txt", "kept");
            await creatorPeer.stop();
            creatorPeer = undefined;

            const stateDirectory = join(directory, "shared-fs-bootstrap");
            const [stateName] = await readdir(stateDirectory);
            const statePath = join(stateDirectory, stateName);
            const state = JSON.parse(await readFile(statePath, "utf8"));
            await writeFile(
                statePath,
                JSON.stringify({ ...state, bootstrap: "future-marker" })
            );

            unknownPeer = await Peerbit.create({ directory });
            const unknown = await openSharedFs({
                peerbit: unknownPeer,
                address,
                machineLabel: "unknown-marker",
                bootstrap: false,
            });
            expect(unknown.bootstrapStatus()).toMatchObject({
                writeReady: false,
                guardArmed: false,
                legacyPromotionEligible: false,
            });
            await unknownPeer.stop();
            unknownPeer = undefined;

            await writeFile(
                statePath,
                JSON.stringify({ openedBefore: true, writeReady: true })
            );
            sourceLessPeer = await Peerbit.create({ directory });
            const sourceLess = await openSharedFs({
                peerbit: sourceLessPeer,
                address,
                machineLabel: "source-less-ready",
                bootstrap: false,
            });
            expect(sourceLess.bootstrapStatus()).toMatchObject({
                writeReady: false,
                guardArmed: false,
                legacyPromotionEligible: false,
            });
        } finally {
            await sourceLessPeer?.stop().catch(() => {});
            await unknownPeer?.stop().catch(() => {});
            await creatorPeer?.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it("uses a verified empty snapshot as remote write-readiness evidence", async () => {
        const donorPeer = await createPeer();
        const donor = await openSharedFs({
            peerbit: donorPeer,
            machineLabel: "empty-donor",
        });
        const snapshot = await donor.snapshotWrite();
        expect(snapshot.docs).toBe(0n);
        expect(snapshot.segments).toBe(0);

        const joinerPeer = await createPeer();
        await joinerPeer.dial(donorPeer);
        const joiner = await openSharedFs({
            peerbit: joinerPeer,
            address: donor.address,
            machineLabel: "empty-joiner",
            writeReadinessSettleMs: 100,
        } as any);

        expect(await joiner.list("/")).toEqual([]);
        await joiner.awaitWriteReady({ timeout: 10_000 });
        await joiner.writeFile("/first.txt", "first safe write");
        await waitUntil(async () => {
            expect(decode(await donor.readFile("/first.txt"))).toBe(
                "first safe write"
            );
        });
    });

    it("keeps normal remote readiness gated until its durable marker succeeds", async () => {
        const root = await mkdtemp(
            join(tmpdir(), "shared-fs-ready-write-failure-")
        );
        let donorPeer: Peerbit | undefined;
        let joinerPeer: Peerbit | undefined;
        try {
            donorPeer = await Peerbit.create();
            const donor = await openSharedFs({
                peerbit: donorPeer,
                machineLabel: "marker-failure-donor",
            });
            await donor.writeFile("/evidence.txt", "remote evidence");

            joinerPeer = await Peerbit.create({
                directory: join(root, "joiner"),
            });
            await joinerPeer.dial(donorPeer);
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: donor.address,
                machineLabel: "marker-failure-joiner",
                bootstrap: false,
                writeReadinessSettleMs: 500,
            } as any);
            const program: any = joiner.program;
            const writeBootstrapState =
                program.writeBootstrapState.bind(program);
            let failedMarker!: () => void;
            const markerFailed = new Promise<void>((resolve) => {
                failedMarker = resolve;
            });
            let failOnce = true;
            program.writeBootstrapState = async (
                patch: any,
                ...rest: any[]
            ) => {
                if (failOnce && patch?.writeReadySource === "remote-settled") {
                    failOnce = false;
                    failedMarker();
                    throw new Error("simulated remote marker failure");
                }
                return writeBootstrapState(patch, ...rest);
            };

            await markerFailed;
            expect(joiner.bootstrapStatus()).toMatchObject({
                writeReady: false,
                guardArmed: false,
            });
            await expect(
                joiner.writeFile("/still-gated.txt", "no")
            ).rejects.toBeInstanceOf(SharedFsWritePendingError);

            program.writeBootstrapState = writeBootstrapState;
            await joiner.awaitWriteReady({ timeout: 10_000 });
            expect(joiner.bootstrapStatus()).toMatchObject({
                writeReady: true,
                guardArmed: true,
                writeReadinessSource: "remote-settled",
            });
            const stateDirectory = join(root, "joiner", "shared-fs-bootstrap");
            const [stateName] = await readdir(stateDirectory);
            expect(
                JSON.parse(
                    await readFile(join(stateDirectory, stateName), "utf8")
                ).writeReadySource
            ).toBe("remote-settled");
        } finally {
            await joinerPeer?.stop().catch(() => {});
            await donorPeer?.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it("does not treat an unrelated connected peer as a reachable filesystem replicator", async () => {
        const donorPeer = await createPeer();
        const donor = await openSharedFs({
            peerbit: donorPeer,
            machineLabel: "readiness-donor",
        });
        await donor.writeFile("/evidence.txt", "arrived before disconnect");

        const joinerPeer = await createPeer();
        await joinerPeer.dial(donorPeer);
        const joiner = await openSharedFs({
            peerbit: joinerPeer,
            address: donor.address,
            machineLabel: "readiness-joiner",
            bootstrap: false,
            writeReadinessSettleMs: 3_000,
        } as any);
        await waitUntil(async () => {
            expect(decode(await joiner.readFile("/evidence.txt"))).toBe(
                "arrived before disconnect"
            );
        });
        expect((joiner.program as any).writeReadinessRemoteEvidence).toBe(true);
        expect(joiner.bootstrapStatus().writeReady).toBe(false);

        const unrelatedPeer = await createPeer();
        await unrelatedPeer.dial(joinerPeer);
        const donorHash = donorPeer.identity.publicKey.hashcode();
        await donorPeer.stop();
        await waitUntil(() => {
            const connected = (joinerPeer.services.pubsub as any).peers as Map<
                string,
                unknown
            >;
            expect(connected.size).toBeGreaterThan(0);
            expect(connected.has(donorHash)).toBe(false);
        });

        await expect(
            joiner.awaitWriteReady({ timeout: 3_500 })
        ).rejects.toMatchObject({ code: "ETIMEDOUT" });
        expect(joiner.bootstrapStatus()).toMatchObject({
            writeReady: false,
            guardArmed: false,
        });
    });

    it("accepts a current routed donor without requiring a direct stream", async () => {
        const peer = await createPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "routed-readiness-probe",
        });
        const program: any = fs.program;
        const pubsub: any = peer.services.pubsub;
        const self = peer.identity.publicKey.hashcode();
        const donorHash = "routed-donor";
        const relayHash = "live-relay";
        const getReplicators = program.entries.log.getReplicators.bind(
            program.entries.log
        );
        const isReachable = pubsub.routes.isReachable.bind(pubsub.routes);
        const getBestRouteHint = pubsub.routes.getBestRouteHint.bind(
            pubsub.routes
        );
        pubsub.peers.set(relayHash, {});
        program.entries.log.getReplicators = async () =>
            new Set([self, donorHash]);
        pubsub.routes.isReachable = (from: string, target: string) =>
            from === self && target === donorHash;
        pubsub.routes.getBestRouteHint = (from: string, target: string) =>
            from === self && target === donorHash
                ? { nextHop: relayHash, distance: 2, updatedAt: Date.now() }
                : undefined;
        try {
            expect(pubsub.peers.has(donorHash)).toBe(false);
            await expect(program.hasConnectedRemoteReplicator()).resolves.toBe(
                true
            );

            pubsub.routes.getBestRouteHint = () => ({
                nextHop: relayHash,
                distance: 2,
                updatedAt: Date.now() - 20_000,
                expiresAt: Date.now() + 1_000,
            });
            await expect(program.hasConnectedRemoteReplicator()).resolves.toBe(
                false
            );
        } finally {
            program.entries.log.getReplicators = getReplicators;
            pubsub.routes.isReachable = isReachable;
            pubsub.routes.getBestRouteHint = getBestRouteHint;
            pubsub.peers.delete(relayHash);
        }
    });

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
            expect(statusAtReady.writeReady).toBe(false);
            // Attach every call-time contract assertion before yielding: the
            // overlay may legitimately converge as soon as this turn ends.
            const earlyWriteAssertion = expect(
                joiner.writeFile("/from-joiner.txt", "too early")
            ).rejects.toMatchObject({
                name: "SharedFsWritePendingError",
                code: "EAGAIN",
                retryable: true,
                retrySafe: true,
            });
            if (statusAtReady.phase === "overlay-active") {
                // Attach all three scans before yielding. The overlay can
                // legitimately finish replicating while the readable-tree
                // assertions below await remote chunks; the partial-view
                // contract applies at call time, not to an earlier status
                // snapshot.
                const scanAssertions = [
                    expect(joiner.namingConflicts()).rejects.toThrow(
                        BootstrapPendingError
                    ),
                    expect(
                        joiner.versionsByChangeset("anything")
                    ).rejects.toThrow(BootstrapPendingError),
                    expect(
                        joiner.namingConflicts(undefined, {
                            allowPartial: true,
                        })
                    ).resolves.toBeDefined(),
                ];
                await Promise.all([earlyWriteAssertion, ...scanAssertions]);

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
            } else {
                await earlyWriteAssertion;
            }
            const converged = await joiner.awaitBootstrapConverged();
            expect(converged.verified).toBe(true);
            const statusAfter = joiner.bootstrapStatus();
            expect(statusAfter.phase).toBe("converged");
            expect(statusAfter.snapshotCoverageVerified).toBe(true);
            expect(statusAfter.guardArmed).toBe(false);
            expect(statusAfter.pendingDocs).toBe(0);
            await joiner.awaitWriteReady();
            expect(joiner.bootstrapStatus().writeReady).toBe(true);
            expect(joiner.bootstrapStatus().guardArmed).toBe(true);
            await joiner.writeFile("/from-joiner.txt", "hello donor");

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
            // Exercise SharedLog's native-default SyncOptions clone without
            // requiring the optional native runtime in this test. The
            // during-open diagnostic sink must be removed from the retained
            // clone so steady-state replication has zero profiling overhead.
            (joinerPeer as any).sharedLogNativeDefaults = {
                sync: { rawExchangeHeads: true },
            };
            await joinerPeer.dial(donorPeer);
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: donorFs.address,
                machineLabel: "joiner",
            });
            expect(
                (joiner.program.entries.log as any)._logProperties?.sync
                    ?.profile
            ).toBeUndefined();
            await expect(
                joiner.writeFile("/plain.txt", "too early")
            ).rejects.toBeInstanceOf(SharedFsWritePendingError);
            await waitUntil(async () => {
                expect(decode(await joiner.readFile("/plain.txt"))).toBe(
                    "no snapshot here"
                );
            });
            expect(joiner.bootstrapStatus().phase).toBe("off");
            expect(joiner.bootstrapStatus().snapshotCoverageVerified).toBe(
                false
            );
            await expect(joiner.awaitBootstrapConverged()).resolves.toEqual({
                verified: false,
            });
            expect(joiner.bootstrapStatus().guardArmed).toBe(false);
            // The donor is intentionally quiescent after the join starts. A
            // successful network log commit is correlated with its immediately
            // preceding Documents change during open, so this fresh small join
            // can become writable without manufacturing another mutation.
            await joiner.awaitWriteReady({ timeout: 20_000 });
            expect(joiner.bootstrapStatus().guardArmed).toBe(true);
            await expect(
                joiner.writeFile("/after-catchup.txt", "safe")
            ).resolves.toBeDefined();
        }
    );

    it(
        "gates a large plain join, then edits the donor node without manufacturing a naming conflict",
        { timeout: 120_000 },
        async () => {
            const donorPeer = await createPeer();
            const donor = await openSharedFs({
                peerbit: donorPeer,
                machineLabel: "large-plain-donor",
            });
            await donor.writeBatch(
                Array.from({ length: 300 }, (_, i) => ({
                    path: `/plain/dir-${i % 10}/file-${i}.txt`,
                    content: `donor ${i}`,
                }))
            );
            const targetPath = "/plain/dir-9/file-299.txt";
            const donorNode = (await donor.stat(targetPath))!.nodeId;

            const joinerPeer = await createPeer();
            await joinerPeer.dial(donorPeer);
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: donor.address,
                machineLabel: "large-plain-joiner",
                bootstrap: false,
                writeReadinessSettleMs: 1_000,
            } as any);
            const backend = createSharedFsMountBackend(joiner);
            await expect(
                backend.open(targetPath, { read: true, write: true })
            ).rejects.toMatchObject({ code: "EAGAIN" });

            await waitUntil(async () => {
                expect(decode(await joiner.readFile(targetPath))).toBe(
                    "donor 299"
                );
            });
            await joiner.awaitWriteReady({ timeout: 20_000 });
            const handle = await backend.open(targetPath, {
                read: true,
                write: true,
            });
            await backend.truncate(handle, 0);
            await backend.write(
                handle,
                new TextEncoder().encode("joined edit"),
                0
            );
            await backend.release(handle);

            expect((await joiner.stat(targetPath))!.nodeId).toBe(donorNode);
            await waitUntil(async () => {
                expect(decode(await donor.readFile(targetPath))).toBe(
                    "joined edit"
                );
            });
            expect(await joiner.namingConflicts()).toEqual([]);
        }
    );

    it(
        "keeps writes gated across the post-snapshot replication gap",
        { retry: 1, timeout: 240_000 },
        async () => {
            const donor = await populatedDonor(120);
            const joinerPeer = await createPeer();
            await joinerPeer.dial(donor.peer);
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: donor.fs.address,
                machineLabel: "joiner",
                // A short but non-zero deterministic test window. Production
                // keeps the five-second default.
                writeReadinessSettleMs: 1_000,
            } as any);

            expect(joiner.bootstrapStatus().writeReady).toBe(false);
            // This mutation is newer than the selected snapshot. Its arrival
            // must restart the readiness quiet window instead of allowing the
            // snapshot's own coverage retirement to false-ready the joiner.
            await donor.fs.writeFile("/after-snapshot.txt", "late v1");
            await waitUntil(async () => {
                expect(
                    decode(await joiner.readFile("/after-snapshot.txt"))
                ).toBe("late v1");
            });
            expect(joiner.bootstrapStatus().writeReady).toBe(false);
            await expect(
                joiner.writeFile("/after-snapshot.txt", "too early")
            ).rejects.toBeInstanceOf(SharedFsWritePendingError);

            await joiner.awaitWriteReady();
            await joiner.writeFile("/after-snapshot.txt", "late v2");
            await waitUntil(async () => {
                expect(
                    decode(await donor.fs.readFile("/after-snapshot.txt"))
                ).toBe("late v2");
            });
            expect(await joiner.namingConflicts()).toEqual([]);
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
                // Deliberately race the first write into an empty namespace.
                allowPartialWrites: true,
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
                    // This test intentionally exercises W1 while the view is
                    // partial; production callers must not opt in casually.
                    allowPartialWrites: true,
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
            expect(joiner.bootstrapStatus().partialWriteOverride).toBe(true);

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
            expect(status.snapshotCoverageVerified).toBe(false);
            expect(status.guardArmed).toBe(false);
            await expect(joiner.awaitBootstrapConverged()).resolves.toEqual({
                verified: false,
            });
            await expect(joiner.snapshotWrite()).rejects.toMatchObject({
                code: "EAGAIN",
            });
            await expect(joiner.program.collectGarbage()).rejects.toMatchObject(
                { code: "EAGAIN" }
            );
            await expect(joiner.namingConflicts()).resolves.toBeDefined();
            // The joiner's own write survived and is readable locally.
            expect(decode(await joiner.readFile("/dup-of-overlay.txt"))).toBe(
                sharedContent
            );
        }
    );
});
