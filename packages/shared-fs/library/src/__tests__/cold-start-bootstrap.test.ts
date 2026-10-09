import { deserialize } from "@dao-xyz/borsh";
import { Peerbit } from "peerbit";
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Documents } from "@peerbit/document";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    BootstrapPendingError,
    SharedFileSystem,
    SharedFsWritePendingError,
    createSharedFsMountBackend,
    encodePublicSignKey,
    openSharedFs,
    type BootstrapTelemetryEvent,
    type SharedFsHandle,
} from "../index.js";
import {
    BootstrapManifest,
    FileVersion,
    NamingEvent,
    SharedFsEntry,
    SnapshotManifestPayload,
} from "../model.js";

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

    /**
     * Holds `peer`'s next filesystem store open until replicated history
     * matching `matches` has been committed to it (a slow open, as on a
     * loaded machine), so its bootstrap decides over a store this open
     * filled. By default the hold sits after the whole Documents open; with
     * `inLog` it sits right after the store's log opened, before the rest of
     * Documents.open has run.
     *
     * The hold releases on the batch's commit diagnostic, not its change
     * event: shared-fs records a during-open batch's readiness evidence at
     * that diagnostic, so the open resolves with the evidence recorded. With
     * `deferCommit` the open resolves between the two instead: the first
     * matching batch's diagnostic is withheld and handed to shared-fs only
     * when it registers its steady-state change listener.
     */
    const holdOpenUntilHistory = (
        peer: Peerbit,
        matches: (value: unknown) => boolean = (value) =>
            value instanceof FileVersion,
        options: { inLog?: boolean; deferCommit?: boolean } = {}
    ) => {
        const documentsOpen = Documents.prototype.open;
        let restoreAddListener: (() => void) | undefined;
        const held = {
            arrived: false,
            /** Change events, and those matching `matches`, during the hold. */
            changes: 0,
            batches: 0,
            delivered: false,
            evidenceBeforeDelivery: undefined as boolean | undefined,
            restore: () => {
                spy.mockRestore();
                restoreAddListener?.();
            },
        };
        const spy = vi
            .spyOn(Documents.prototype, "open")
            .mockImplementation(async function (
                this: Documents<any, any>,
                ...args: any[]
            ) {
                if (
                    (this as any).node !== peer ||
                    args[0]?.type !== SharedFsEntry
                ) {
                    return documentsOpen.apply(this, args as any);
                }
                let committed!: () => void;
                const arrived = new Promise<void>(
                    (resolve) => (committed = resolve)
                );
                let pending = false;
                const onChange = (event: any) => {
                    pending = (event?.detail?.added ?? []).some(matches);
                    held.changes++;
                    if (pending) {
                        held.batches++;
                    }
                };
                let deliver: (() => void) | undefined;
                const sync = args[0].sync;
                const profile = sync.profile;
                sync.profile = (event: { name: string }) => {
                    const commit =
                        event.name === "log.joinPreparedFacts.change" ||
                        event.name === "log.joinIndependent.change";
                    if (commit && pending && options.deferCommit && !deliver) {
                        pending = false;
                        deliver = () => profile?.(event);
                        committed();
                        return;
                    }
                    profile?.(event);
                    if (!commit) {
                        return;
                    }
                    if (pending) {
                        committed();
                    }
                    pending = false;
                };
                let bound: ReturnType<typeof setTimeout> | undefined;
                const hold = async () => {
                    await Promise.race([
                        arrived,
                        new Promise((_, reject) => {
                            bound = setTimeout(
                                () =>
                                    reject(
                                        new Error(
                                            "no history arrived during open"
                                        )
                                    ),
                                30_000
                            );
                        }),
                    ]);
                    held.arrived = true;
                };
                const log = (this as any).log;
                const logOpen = log.open;
                const ownLogOpen = Object.hasOwn(log, "open");
                if (options.inLog) {
                    log.open = async function (...logArgs: any[]) {
                        const result = await logOpen.apply(this, logArgs);
                        await hold();
                        return result;
                    };
                }
                this.events.addEventListener("change", onChange);
                try {
                    const result = await documentsOpen.apply(this, args as any);
                    if (!options.inLog) {
                        await hold();
                    }
                    if (deliver) {
                        // shared-fs registers that listener as soon as the
                        // store's open resolved, before anything else arrives.
                        const events = this.events as any;
                        const store = this as any;
                        const add = events.addEventListener;
                        const ownAdd = Object.hasOwn(
                            events,
                            "addEventListener"
                        );
                        restoreAddListener = () => {
                            restoreAddListener = undefined;
                            if (ownAdd) {
                                events.addEventListener = add;
                            } else {
                                delete events.addEventListener;
                            }
                        };
                        events.addEventListener = function (
                            this: unknown,
                            ...listenerArgs: unknown[]
                        ) {
                            const added = add.apply(this, listenerArgs);
                            if (listenerArgs[0] === "change") {
                                restoreAddListener?.();
                                held.evidenceBeforeDelivery =
                                    store.parents?.[0]?.writeReadinessRemoteEvidence;
                                held.delivered = true;
                                deliver!();
                            }
                            return added;
                        };
                    }
                    return result;
                } finally {
                    clearTimeout(bound);
                    this.events.removeEventListener("change", onChange);
                    if (options.inLog && ownLogOpen) {
                        log.open = logOpen;
                    } else if (options.inLog) {
                        delete log.open;
                    }
                }
            });
        return held;
    };

    /** Mirrors shared-fs's readiness-evidence predicate. */
    const isReadinessEvidence = (value: unknown) =>
        value instanceof NamingEvent ||
        value instanceof FileVersion ||
        value instanceof BootstrapManifest;

    /**
     * Captures the commit-diagnostic sink of `peer`'s next filesystem store
     * open (the latest one). Calling it after open stands in for the late
     * diagnostic of a message received during open. The open ends with a
     * metadata change event that no diagnostic follows, as a local replay's
     * would (this cohort's persisted index replays none on its own).
     */
    const captureOpenSink = (peer: Peerbit) => {
        const documentsOpen = Documents.prototype.open;
        const captured = {
            sink: undefined as ((event: { name: string }) => void) | undefined,
            restore: () => spy.mockRestore(),
        };
        const spy = vi
            .spyOn(Documents.prototype, "open")
            .mockImplementation(async function (
                this: Documents<any, any>,
                ...args: any[]
            ) {
                if (
                    (this as any).node !== peer ||
                    args[0]?.type !== SharedFsEntry
                ) {
                    return documentsOpen.apply(this, args as any);
                }
                captured.sink = args[0].sync.profile;
                const result = await documentsOpen.apply(this, args as any);
                this.events.dispatchEvent(
                    new CustomEvent("change", {
                        detail: {
                            added: [Object.create(FileVersion.prototype)],
                            removed: [],
                        },
                    })
                );
                return result;
            });
        return captured;
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
                mode: 0o100644,
                mtime: 1n,
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

    it("keeps partial-write recovery session-only", async () => {
        const root = await mkdtemp(
            join(tmpdir(), "shared-fs-partial-write-override-")
        );
        const directory = join(root, "peer");
        let creatorPeer: Peerbit | undefined;
        let observerPeer: Peerbit | undefined;
        let overridePeer: Peerbit | undefined;
        let finalPeer: Peerbit | undefined;
        try {
            creatorPeer = await Peerbit.create({ directory });
            const creator = await openSharedFs({
                peerbit: creatorPeer,
                machineLabel: "override-creator",
            });
            await creator.writeFile("/kept.txt", "before override");
            const address = creator.address!;
            await creatorPeer.stop();
            creatorPeer = undefined;

            // An observer open withdraws the creator's persisted proof, so
            // the next full open of this directory starts gated.
            observerPeer = await Peerbit.create({ directory });
            await openSharedFs({
                peerbit: observerPeer,
                address,
                machineLabel: "override-observer",
                replicate: false,
                bootstrap: false,
            });
            await observerPeer.stop();
            observerPeer = undefined;

            const stateDirectory = join(directory, "shared-fs-bootstrap");
            const [stateName] = await readdir(stateDirectory);
            const statePath = join(stateDirectory, stateName);
            const gatedState = JSON.parse(await readFile(statePath, "utf8"));
            expect(gatedState).toMatchObject({ writeReady: false });
            expect(gatedState).not.toHaveProperty("writeReadySource");
            // Retired sidecar fields are no longer written.
            expect(gatedState).not.toHaveProperty("openedBefore");
            expect(gatedState).not.toHaveProperty("legacyUnproven");

            overridePeer = await Peerbit.create({ directory });
            const override = await openSharedFs({
                peerbit: overridePeer,
                address,
                machineLabel: "override-session",
                bootstrap: false,
                allowPartialWrites: true,
            });
            expect(override.bootstrapStatus()).toMatchObject({
                writeReady: true,
                partialWriteOverride: true,
            });
            expect(override.bootstrapStatus().writeReadinessSource).toBe(
                undefined
            );
            await override.writeFile("/recovery.txt", "session-only");
            await overridePeer.stop();
            overridePeer = undefined;

            const afterOverride = JSON.parse(await readFile(statePath, "utf8"));
            expect(afterOverride).toMatchObject({ writeReady: false });
            expect(afterOverride).not.toHaveProperty("writeReadySource");

            finalPeer = await Peerbit.create({ directory });
            const final = await openSharedFs({
                peerbit: finalPeer,
                address,
                machineLabel: "after-override",
                bootstrap: false,
                writeReadinessSettleMs: 100,
            } as any);
            expect(final.bootstrapStatus()).toMatchObject({
                writeReady: false,
                partialWriteOverride: false,
                guardArmed: false,
            });
            await expect(
                final.awaitWriteReady({ timeout: 350 })
            ).rejects.toMatchObject({ code: "ETIMEDOUT" });
        } finally {
            await finalPeer?.stop().catch(() => {});
            await overridePeer?.stop().catch(() => {});
            await observerPeer?.stop().catch(() => {});
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
            const captured = captureOpenSink(reopenedPeer);
            let reopened: SharedFsHandle;
            try {
                reopened = await openSharedFs({
                    peerbit: reopenedPeer,
                    address,
                    machineLabel: "missing-sidecar-reopen",
                    bootstrap: false,
                    writeReadinessSettleMs: 100,
                } as any);
            } finally {
                captured.restore();
            }
            expect(decode(await reopened.readFile("/persisted.txt"))).toBe(
                "local replay"
            );
            // A message received during open whose evidence-free change and
            // commit diagnostic land after open must not pair with the
            // replay's classification.
            (reopened.program as any).entries.events.dispatchEvent(
                new CustomEvent("change", {
                    detail: { added: [], removed: [] },
                })
            );
            captured.sink!({ name: "log.joinIndependent.change" });
            expect((reopened.program as any).writeReadinessRemoteEvidence).toBe(
                false
            );
            await expect(
                reopened.awaitWriteReady({ timeout: 500 })
            ).rejects.toMatchObject({ code: "ETIMEDOUT" });
            expect(reopened.bootstrapStatus()).toMatchObject({
                writeReady: false,
                guardArmed: false,
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
            const captured = captureOpenSink(localPeer);
            let reopened: SharedFileSystem;
            try {
                reopened = await localPeer.open(originalProgram, {
                    existing: "reuse",
                    args: {
                        addressOpen: true,
                        machineLabel: "same-program-reopen",
                        bootstrap: false,
                        writeReadinessSettleMs: 100,
                    } as any,
                });
            } finally {
                captured.restore();
            }
            const staleSink = captured.sink;
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
            });

            // The replay left that open's classification set. A commit
            // diagnostic still in flight from it must not mark the next open.
            await reopened.close();
            const again = await localPeer.open(originalProgram, {
                existing: "reuse",
                args: {
                    addressOpen: true,
                    machineLabel: "same-program-again",
                    bootstrap: false,
                    writeReadinessSettleMs: 100,
                } as any,
            });
            staleSink!({ name: "log.joinIndependent.change" });
            expect((again as any).writeReadinessRemoteEvidence).toBe(false);
            await expect(
                again.awaitWriteReady({ timeout: 500 })
            ).rejects.toMatchObject({ code: "ETIMEDOUT" });
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
            });
            await unknownPeer.stop();
            unknownPeer = undefined;

            await writeFile(statePath, JSON.stringify({ writeReady: true }));
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
            });
        } finally {
            await sourceLessPeer?.stop().catch(() => {});
            await unknownPeer?.stop().catch(() => {});
            await creatorPeer?.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it("ignores retired sidecar keys but fails closed on a retired readiness source", async () => {
        const root = await mkdtemp(join(tmpdir(), "shared-fs-retired-state-"));
        const directory = join(root, "peer");
        let creatorPeer: Peerbit | undefined;
        let retiredKeysPeer: Peerbit | undefined;
        let retiredSourcePeer: Peerbit | undefined;
        try {
            creatorPeer = await Peerbit.create({ directory });
            const creator = await openSharedFs({
                peerbit: creatorPeer,
                machineLabel: "retired-state-creator",
            });
            const address = creator.address!;
            await creator.writeFile("/kept.txt", "kept");
            await creatorPeer.stop();
            creatorPeer = undefined;

            const stateDirectory = join(directory, "shared-fs-bootstrap");
            const [stateName] = await readdir(stateDirectory);
            const statePath = join(stateDirectory, stateName);
            const state = JSON.parse(await readFile(statePath, "utf8"));
            expect(state).toMatchObject({
                writeReady: true,
                writeReadySource: "creator",
            });
            expect(state).not.toHaveProperty("openedBefore");
            expect(state).not.toHaveProperty("legacyUnproven");

            // A sidecar written before this release still carries
            // openedBefore and legacyUnproven:false. Those keys are ignored,
            // so its creator proof stays valid.
            await writeFile(
                statePath,
                JSON.stringify({
                    openedBefore: true,
                    writeReady: true,
                    legacyUnproven: false,
                    writeReadySource: "creator",
                })
            );
            retiredKeysPeer = await Peerbit.create({ directory });
            const retiredKeys = await openSharedFs({
                peerbit: retiredKeysPeer,
                address,
                machineLabel: "retired-keys-reopen",
                bootstrap: false,
            });
            expect(retiredKeys.bootstrapStatus()).toMatchObject({
                writeReady: true,
                writeReadinessSource: "creator",
                guardArmed: true,
            });
            await retiredKeys.writeFile("/kept.txt", "still writable");
            await retiredKeysPeer.stop();
            retiredKeysPeer = undefined;

            // The removed operator-assertion provenance is no longer a valid
            // source: the sidecar is malformed and the reopen fails closed
            // until remote-settled readiness.
            await writeFile(
                statePath,
                JSON.stringify({
                    openedBefore: true,
                    writeReady: true,
                    legacyUnproven: false,
                    writeReadySource: "legacy-operator-assertion",
                })
            );
            retiredSourcePeer = await Peerbit.create({ directory });
            const retiredSource = await openSharedFs({
                peerbit: retiredSourcePeer,
                address,
                machineLabel: "retired-source-reopen",
                bootstrap: false,
                writeReadinessSettleMs: 100,
            } as any);
            expect(retiredSource.bootstrapStatus()).toMatchObject({
                writeReady: false,
                guardArmed: false,
            });
            expect(retiredSource.bootstrapStatus().writeReadinessSource).toBe(
                undefined
            );
            await expect(
                retiredSource.writeFile("/kept.txt", "unsafe")
            ).rejects.toBeInstanceOf(SharedFsWritePendingError);
            await expect(
                retiredSource.awaitWriteReady({ timeout: 350 })
            ).rejects.toMatchObject({ code: "ETIMEDOUT" });
            expect(decode(await retiredSource.readFile("/kept.txt"))).toBe(
                "still writable"
            );
            const gatedState = JSON.parse(await readFile(statePath, "utf8"));
            expect(gatedState).toMatchObject({ writeReady: false });
            expect(gatedState).not.toHaveProperty("writeReadySource");
        } finally {
            await retiredSourcePeer?.stop().catch(() => {});
            await retiredKeysPeer?.stop().catch(() => {});
            await creatorPeer?.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it("counts a replicated empty snapshot as evidence without bootstrapping from it", async () => {
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
        expect(joiner.bootstrapStatus().manifest).toBeUndefined();
        await joiner.writeFile("/first.txt", "first safe write");
        await waitUntil(async () => {
            expect(decode(await donor.readFile("/first.txt"))).toBe(
                "first safe write"
            );
        });
    });

    it("makes joiners of a never-written filesystem write-ready", async () => {
        // The most basic onboarding flow: create, share the address, other
        // machines join. Nothing was ever written, so the creator's genesis
        // manifest is the only entry whose replication can prove sync.
        const creatorPeer = await createPeer();
        const creator = await openSharedFs({
            peerbit: creatorPeer,
            machineLabel: "never-written-creator",
        });
        const join = async (machineLabel: string, bootstrap?: unknown) => {
            const peer = await createPeer();
            await peer.dial(creatorPeer);
            return openSharedFs({
                peerbit: peer,
                address: creator.address,
                machineLabel,
                bootstrap,
                writeReadinessSettleMs: 100,
            } as any);
        };
        const joiners = [
            await join("never-written-joiner"),
            await join("never-written-plain", false),
        ];
        for (const joiner of joiners) {
            expect(await joiner.list("/")).toEqual([]);
            await joiner.awaitWriteReady({ timeout: 20_000 });
            // The genesis is replication evidence, not a snapshot to
            // bootstrap from.
            expect(joiner.bootstrapStatus()).toMatchObject({ phase: "off" });
            expect(joiner.bootstrapStatus().manifest).toBeUndefined();
        }
        await joiners[0].writeFile("/first.txt", "first safe write");
        await waitUntil(async () => {
            expect(decode(await creator.readFile("/first.txt"))).toBe(
                "first safe write"
            );
        });
    });

    it("keeps a joiner of an empty filesystem gated until a replicator is reachable", async () => {
        const creatorPeer = await createPeer();
        const creator = await openSharedFs({
            peerbit: creatorPeer,
            machineLabel: "unreachable-creator",
        });
        // The joiner resolves the program locally and opens before it can
        // reach any replicator: nothing proves what exists, so it stays
        // closed.
        const joinerPeer = await createPeer();
        await creator.program.save(joinerPeer.services.blocks);
        const joiner = await openSharedFs({
            peerbit: joinerPeer,
            address: creator.address,
            machineLabel: "early-joiner",
            writeReadinessSettleMs: 100,
        } as any);
        await expect(
            joiner.writeFile("/too-early.txt", "unsafe")
        ).rejects.toBeInstanceOf(SharedFsWritePendingError);
        await expect(
            joiner.awaitWriteReady({ timeout: 1_000 })
        ).rejects.toMatchObject({ code: "ETIMEDOUT" });
        expect(joiner.bootstrapStatus()).toMatchObject({
            writeReady: false,
            guardArmed: false,
        });

        // Reaching the creator replicates its genesis manifest, the evidence
        // that opens the gate.
        await joinerPeer.dial(creatorPeer);
        await joiner.awaitWriteReady({ timeout: 20_000 });
        await joiner.writeFile("/after-join.txt", "safe");
        await waitUntil(async () => {
            expect(decode(await creator.readFile("/after-join.txt"))).toBe(
                "safe"
            );
        });
    });

    it("never bootstraps from a zero-document manifest or counts finding one as evidence", async () => {
        const root = await mkdtemp(
            join(tmpdir(), "shared-fs-genesis-discovery-")
        );
        const directory = join(root, "joiner");
        let joinerPeer: Peerbit | undefined;
        try {
            // The genesis manifest is older than the data and describes none
            // of it; an overlay from it would retire without any log
            // coverage. A joiner that holds it locally, from an earlier
            // session that never became ready, must not use or count it.
            const creatorPeer = await createPeer();
            const creator = await openSharedFs({
                peerbit: creatorPeer,
                machineLabel: "genesis-creator",
            });
            await creator.writeFile("/data.txt", "written after genesis");
            const manifestId = `bootstrap:${encodePublicSignKey(
                creatorPeer.identity.publicKey
            )}`;

            joinerPeer = await Peerbit.create({ directory });
            await joinerPeer.dial(creatorPeer);
            const first = await openSharedFs({
                peerbit: joinerPeer,
                address: creator.address,
                machineLabel: "genesis-joiner",
                bootstrap: false,
                writeReadinessSettleMs: 60_000,
            } as any);
            await waitUntil(async () => {
                expect(decode(await first.readFile("/data.txt"))).toBe(
                    "written after genesis"
                );
                expect(
                    await (first.program as any).getDocument(manifestId)
                ).toBeDefined();
            });
            expect(first.bootstrapStatus().writeReady).toBe(false);
            await joinerPeer.stop();

            joinerPeer = await Peerbit.create({ directory });
            const reopened = await openSharedFs({
                peerbit: joinerPeer,
                address: creator.address,
                machineLabel: "genesis-joiner-reopen",
                writeReadinessSettleMs: 100,
            } as any);
            await (reopened.program as any).bootstrapDecision;
            expect(reopened.bootstrapStatus().manifest).toBeUndefined();
            expect((reopened.program as any).writeReadinessRemoteEvidence).toBe(
                false
            );
            await expect(
                reopened.awaitWriteReady({ timeout: 500 })
            ).rejects.toMatchObject({ code: "ETIMEDOUT" });
        } finally {
            await joinerPeer?.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it("replaces its snapshot manifest without leaving a delete entry", async () => {
        const peer = await createPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "manifest-replacer",
        });
        const log = (fs.program as any).entries.log.log;
        // The genesis manifest is the never-written filesystem's only entry.
        expect(log.length).toBe(1);
        const snapshot = await fs.snapshotWrite();
        expect(snapshot.snapshotSeq).toBe(2n);
        // The replacement CUTs the genesis head in the same entry. A separate
        // delete entry could stay pending in a joiner's sync indefinitely.
        expect(log.length).toBe(1);
    });

    it("returns a creating open with its genesis published, even when asked to bootstrap", async () => {
        // A script that creates, prints the address and stops must leave the
        // genesis behind. A creating open has nothing to bootstrap from, so
        // it never waits on discovery, whichever API opens it.
        const creatorPeer = await createPeer();
        await creatorPeer.dial(await createPeer());
        const created: any = await creatorPeer.open(new SharedFileSystem(), {
            args: {
                replicate: { factor: 1 },
                bootstrap: { discoveryTimeoutMs: 60_000 },
            },
        });
        expect(created.bootstrapStatus()).toMatchObject({
            phase: "off",
            writeReady: true,
            writeReadinessSource: "creator",
        });
        expect(
            await created.getDocument(
                `bootstrap:${encodePublicSignKey(creatorPeer.identity.publicKey)}`
            )
        ).toBeDefined();
    });

    it("gates a program loaded from an address, whichever API opens it", async () => {
        // Only the constructor marks a creation. A program loaded from an
        // address has seen none of the data: it settles a remote view before
        // it may write, and never publishes a manifest of its own.
        const creatorPeer = await createPeer();
        const creator = await openSharedFs({
            peerbit: creatorPeer,
            machineLabel: "loaded-creator",
        });
        await creator.writeBatch(
            Array.from({ length: 50 }, (_, i) => ({
                path: `/data/file-${i}.txt`,
                content: `content ${i}`,
            }))
        );
        const loadedPeer = await createPeer();
        await loadedPeer.dial(creatorPeer);
        const loaded = await SharedFileSystem.open(
            creator.address,
            loadedPeer as any,
            {
                args: {
                    replicate: { factor: 1 },
                    bootstrap: false,
                    writeReadinessSettleMs: 100,
                } as any,
            }
        );
        expect(loaded.bootstrapStatus()).toMatchObject({
            writeReady: false,
            guardArmed: false,
        });
        expect(loaded.bootstrapStatus().writeReadinessSource).toBeUndefined();
        await expect(
            loaded.writeFile("/unsafe.txt", "before any view")
        ).rejects.toBeInstanceOf(SharedFsWritePendingError);
        await loaded.awaitWriteReady({ timeout: 20_000 });
        expect(loaded.bootstrapStatus().writeReadinessSource).toBe(
            "remote-settled"
        );
        await waitUntil(async () => {
            expect(decode(await loaded.readFile("/data/file-49.txt"))).toBe(
                "content 49"
            );
        });
        expect(
            await (loaded as any).getDocument(
                `bootstrap:${encodePublicSignKey(loadedPeer.identity.publicKey)}`
            )
        ).toBeUndefined();
    });

    it("lets a join of a never-written filesystem that ended before it was ready be retried", async () => {
        const root = await mkdtemp(join(tmpdir(), "shared-fs-empty-retry-"));
        const start = async (directory: string) => {
            const peer = await Peerbit.create({
                directory: join(root, directory),
            });
            peers.push(peer);
            return peer;
        };
        const stop = (peer: Peerbit) => {
            peers.splice(peers.indexOf(peer), 1);
            return peer.stop();
        };
        const logOf = (fs: SharedFsHandle) =>
            (fs.program as any).entries.log.log;
        const heads = async (fs: SharedFsHandle) =>
            (await logOf(fs).getHeads().all()).map(
                (entry: any) => entry.hash as string
            );
        try {
            let creatorPeer = await start("creator");
            const creator = await openSharedFs({
                peerbit: creatorPeer,
                machineLabel: "retry-creator",
            });
            const [genesis] = await heads(creator);
            const address = creator.address;
            const join = async (directory: string, settleMs: number) => {
                const peer = await start(directory);
                await peer.dial(creatorPeer);
                const fs = await openSharedFs({
                    peerbit: peer,
                    address,
                    machineLabel: directory,
                    bootstrap: { discoveryTimeoutMs: 500 },
                    writeReadinessSettleMs: settleMs,
                } as any);
                return { peer, fs };
            };
            // Each first join ends inside its quiet window (Ctrl-C, a crash,
            // a mount timeout) holding everything the creator has, including
            // the re-publication for its own session. Nothing is written, so
            // a retry has nothing new to replicate but a re-publication.
            const interrupt = async (directory: string, crash: boolean) => {
                const before = logOf(creator).length;
                const { peer, fs } = await join(directory, 60_000);
                await waitUntil(async () => {
                    expect(logOf(creator).length).toBe(before + 1);
                    for (const hash of await heads(creator)) {
                        expect(await logOf(fs).has(hash)).toBe(true);
                    }
                });
                expect(fs.bootstrapStatus().writeReady).toBe(false);
                if (crash) {
                    // The network goes first, so nothing announces the
                    // departure: shared-log emits no replicator:join for the
                    // returning key.
                    await (peer as any).libp2p.stop();
                }
                await stop(peer);
            };
            await interrupt("joiner-a", true);

            // Retried while the creator stays online: its re-publication for
            // the joiner's new session is the new evidence. A linked put, so
            // the chain stays whole for the first real snapshot to CUT.
            const retried = await join("joiner-a", 100);
            await retried.fs.awaitWriteReady({ timeout: 20_000 });
            expect(await logOf(creator).has(genesis)).toBe(true);
            expect(await heads(creator)).toHaveLength(1);
            expect(logOf(creator).length).toBe(3);
            await stop(retried.peer);

            // A creator reopen that finds nobody subscribed adds nothing.
            await interrupt("joiner-b", false);
            const before = await heads(creator);
            await stop(creatorPeer);
            creatorPeer = await start("creator");
            const alone = await openSharedFs({
                peerbit: creatorPeer,
                address,
                machineLabel: "retry-creator-alone",
                bootstrap: false,
            });
            expect(await heads(alone)).toEqual(before);
            await stop(creatorPeer);

            // Retried across a creator restart: the joiner waits, gated, and
            // the creator's reopen re-publishes for it. The reopen's store is
            // held open a moment, so the joiner's subscription lands before
            // the reopen listens for new ones.
            const waitingPeer = await start("joiner-b");
            creatorPeer = await start("creator");
            await waitingPeer.dial(creatorPeer);
            const waiting = await openSharedFs({
                peerbit: waitingPeer,
                address,
                machineLabel: "joiner-b-waiting",
                bootstrap: false,
                writeReadinessSettleMs: 100,
            } as any);
            const documentsOpen = Documents.prototype.open;
            const heldOpen = vi
                .spyOn(Documents.prototype, "open")
                .mockImplementationOnce(async function (
                    this: Documents<any, any>,
                    ...args: any[]
                ) {
                    const result = await documentsOpen.apply(this, args as any);
                    await new Promise((resolve) => setTimeout(resolve, 1_000));
                    return result;
                });
            let reopened: SharedFsHandle;
            try {
                reopened = await openSharedFs({
                    peerbit: creatorPeer,
                    address,
                    machineLabel: "retry-creator-mount",
                    bootstrap: false,
                });
            } finally {
                heldOpen.mockRestore();
            }
            await waiting.awaitWriteReady({ timeout: 20_000 });
            expect(logOf(reopened).length).toBe(5);
            await waiting.writeFile("/first.txt", "after retry");
            await waitUntil(async () => {
                expect(decode(await reopened.readFile("/first.txt"))).toBe(
                    "after retry"
                );
            });
        } finally {
            await Promise.allSettled(
                peers.splice(0).map((peer) => peer.stop())
            );
            await rm(root, { recursive: true, force: true });
        }
    });

    it("lets a join that ended before its bootstrap decision be retried with bootstrap off", async () => {
        const root = await mkdtemp(join(tmpdir(), "shared-fs-undecided-"));
        const directory = join(root, "joiner");
        const logOf = (fs: SharedFsHandle) =>
            (fs.program as any).entries.log.log;
        let joinerPeer: Peerbit | undefined;
        try {
            const creatorPeer = await createPeer();
            const creator = await openSharedFs({
                peerbit: creatorPeer,
                machineLabel: "undecided-creator",
            });
            const address = creator.address;

            // The first join syncs and then stops (Ctrl-C, a mount timeout)
            // while its discovery is still deciding, so nothing clears the
            // "active" marker written before its store opened. Discovery is
            // held until close aborts it: the order a loaded machine only
            // sometimes produces.
            let reached!: () => void;
            const deciding = new Promise<void>(
                (resolve) => (reached = resolve)
            );
            const discovery = vi
                .spyOn(
                    SharedFileSystem.prototype as any,
                    "fetchAndInstallOverlay"
                )
                .mockImplementationOnce(
                    (signal: any) =>
                        new Promise<boolean>((resolve) => {
                            reached();
                            if (signal.aborted) {
                                return resolve(false);
                            }
                            signal.addEventListener(
                                "abort",
                                () => resolve(false),
                                { once: true }
                            );
                        })
                );
            try {
                joinerPeer = await Peerbit.create({ directory });
                await joinerPeer.dial(creatorPeer);
                const first = await openSharedFs({
                    peerbit: joinerPeer,
                    address,
                    machineLabel: "undecided-first",
                });
                await deciding;
                // Holding everything the creator has, including the
                // re-publication for its own session.
                await waitUntil(async () => {
                    expect(logOf(creator).length).toBeGreaterThan(1);
                    for (const entry of await logOf(creator).getHeads().all()) {
                        expect(await logOf(first).has(entry.hash)).toBe(true);
                    }
                });
                expect(first.bootstrapStatus().phase).toBe("fetching");
                await joinerPeer.stop();
            } finally {
                discovery.mockRestore();
            }
            const stateDirectory = join(directory, "shared-fs-bootstrap");
            const [stateName] = await readdir(stateDirectory);
            const statePath = join(stateDirectory, stateName);
            const state = async () =>
                JSON.parse(await readFile(statePath, "utf8"));
            expect(await state()).toMatchObject({ bootstrap: "active" });

            // It stored no content, so a retry with bootstrap off is a plain
            // join, not a partial store held unverified for ten minutes or
            // more: the creator's re-publication for its session makes it
            // write-ready.
            joinerPeer = await Peerbit.create({ directory });
            await joinerPeer.dial(creatorPeer);
            const retried = await openSharedFs({
                peerbit: joinerPeer,
                address,
                machineLabel: "undecided-retry",
                bootstrap: false,
                writeReadinessSettleMs: 100,
            } as any);
            expect(retried.bootstrapStatus().phase).toBe("off");
            await (retried.program as any).stateWriteChain;
            expect(await state()).not.toHaveProperty("bootstrap");
            await retried.awaitWriteReady({ timeout: 20_000 });
            await retried.writeFile("/first.txt", "after retry");
            await waitUntil(async () => {
                expect(decode(await creator.readFile("/first.txt"))).toBe(
                    "after retry"
                );
            });
            await joinerPeer.stop();

            // A marker over a store with content may be a partial bootstrap:
            // that still holds the unverified posture.
            await writeFile(
                statePath,
                JSON.stringify({ writeReady: false, bootstrap: "active" })
            );
            joinerPeer = await Peerbit.create({ directory });
            const partial = await openSharedFs({
                peerbit: joinerPeer,
                address,
                machineLabel: "undecided-partial",
                bootstrap: false,
            });
            expect(partial.bootstrapStatus()).toMatchObject({
                phase: "unverified",
                writeReady: false,
                guardArmed: false,
            });
        } finally {
            await joinerPeer?.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    /** A donor with history but no snapshot (only the genesis manifest). */
    const donorWithoutSnapshot = async (
        options: { rootKey?: boolean } = {}
    ) => {
        const donorPeer = await createPeer();
        const donor = await openSharedFs({
            peerbit: donorPeer,
            machineLabel: "opening-donor",
            ...(options.rootKey
                ? { rootKey: donorPeer.identity.publicKey }
                : {}),
        });
        // No snapshot: the donor's only manifest is the zero-document
        // genesis, so a joiner's discovery finds nothing to install.
        await donor.writeBatch(
            Array.from({ length: 20 }, (_, i) => ({
                path: `/f-${i}.txt`,
                content: `content ${i}`,
            }))
        );
        const joinerPeer = await createPeer();
        await joinerPeer.dial(donorPeer);
        return { donor, joinerPeer };
    };

    /** Opens `joinerPeer`'s join of `address` with its store held open. */
    const joinWhileOpening = async (
        joinerPeer: Peerbit,
        address: string,
        options: Record<string, unknown> = {},
        hold: { inLog?: boolean } = {}
    ) => {
        const held = holdOpenUntilHistory(joinerPeer, undefined, hold);
        try {
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address,
                machineLabel: "opening-joiner",
                bootstrap: { discoveryTimeoutMs: 500 },
                writeReadinessSettleMs: 100,
                ...options,
            } as any);
            expect(held.arrived).toBe(true);
            await (joiner.program as any).bootstrapDecision;
            return joiner;
        } finally {
            held.restore();
        }
    };

    it.each([
        ["store", false],
        ["log", true],
    ])(
        "joins plainly when history arrives while its %s is still opening",
        async (_, inLog) => {
            const { donor, joinerPeer } = await donorWithoutSnapshot();
            const joiner = await joinWhileOpening(
                joinerPeer,
                donor.address,
                {},
                { inLog }
            );
            // Nothing was stored before this open, so a failed discovery is
            // a plain join, gated by the usual evidence and quiet window,
            // not a resumed partial bootstrap held unverified for ten
            // minutes or more.
            expect(joiner.bootstrapStatus().phase).toBe("off");
            await joiner.awaitWriteReady({ timeout: 20_000 });
            await joiner.writeFile("/after-join.txt", "written");
            await waitUntil(async () => {
                expect(decode(await donor.readFile("/after-join.txt"))).toBe(
                    "written"
                );
            });
        }
    );

    it("admits history that waited on the pre-open read across a trust change", async () => {
        const { donor, joinerPeer } = await donorWithoutSnapshot({
            rootKey: true,
        });
        // A trust-graph change lands while the first ingest waits on the
        // read of the store's pre-open content; on a fresh access-controlled
        // join, trust edges replicate beside the content.
        const read = (SharedFileSystem.prototype as any).hasLocalContentRow;
        let changedTrust = false;
        const probe = vi
            .spyOn(SharedFileSystem.prototype as any, "hasLocalContentRow")
            .mockImplementation(function (this: any) {
                const result = read.call(this);
                const trustChanged = this.trustChangeListener;
                if (this.node === joinerPeer && trustChanged && !changedTrust) {
                    changedTrust = true;
                    trustChanged();
                }
                return result;
            });
        const canPerformEntry = (SharedFileSystem.prototype as any)
            .canPerformEntry;
        let rejected = 0;
        const admission = vi
            .spyOn(SharedFileSystem.prototype as any, "canPerformEntry")
            .mockImplementation(async function (this: any, operation: any) {
                const admitted = await canPerformEntry.call(this, operation);
                if (this.node === joinerPeer && !admitted) {
                    rejected++;
                }
                return admitted;
            });
        let joiner: SharedFsHandle;
        try {
            joiner = await joinWhileOpening(joinerPeer, donor.address);
        } finally {
            probe.mockRestore();
            admission.mockRestore();
        }
        expect(changedTrust).toBe(true);
        expect(rejected).toBe(0);
        expect(joiner.bootstrapStatus().phase).toBe("off");
    });

    it("abandons a required bootstrap whose history arrived while its store was opening", async () => {
        const { donor, joinerPeer } = await donorWithoutSnapshot();
        const postures: string[] = [];
        await expect(
            joinWhileOpening(joinerPeer, donor.address, {
                bootstrap: { mode: "require", discoveryTimeoutMs: 500 },
                telemetry: {
                    bootstrap: (event: BootstrapTelemetryEvent) => {
                        if (event.type === "fallback") {
                            postures.push(event.posture);
                        }
                    },
                },
            })
        ).rejects.toThrow(/bootstrap/);
        // A fresh join: the failure surfaces to the opener, as a plain
        // join's, not as a resumed partial bootstrap's unverified posture.
        expect(postures).toEqual(["plain-join"]);
    });

    it("treats an unreadable pre-open store as a partial bootstrap", async () => {
        const { donor, joinerPeer } = await donorWithoutSnapshot();
        const probe = vi
            .spyOn(SharedFileSystem.prototype as any, "hasLocalContentRow")
            .mockRejectedValueOnce(new Error("index unreadable"));
        let joiner: SharedFsHandle;
        try {
            joiner = await joinWhileOpening(joinerPeer, donor.address);
        } finally {
            probe.mockRestore();
        }
        expect(joiner.bootstrapStatus()).toMatchObject({
            phase: "unverified",
            writeReady: false,
            guardArmed: false,
        });
    });

    it("keeps the evidence of a batch committed just after its store opened", async () => {
        // A quiet donor: what it wrote reaches the joiner in one batch, so
        // that batch is the joiner's only readiness evidence.
        const donorPeer = await createPeer();
        const donor = await openSharedFs({
            peerbit: donorPeer,
            machineLabel: "late-commit-donor",
        });
        await donor.writeFile("/quiet.txt", "quiet");
        const joinerPeer = await createPeer();
        await joinerPeer.dial(donorPeer);

        // The joiner's store open resolves after that batch's change event
        // and before its commit diagnostic.
        const held = holdOpenUntilHistory(joinerPeer, isReadinessEvidence, {
            deferCommit: true,
        });
        let joiner: SharedFsHandle;
        try {
            joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: donor.address,
                machineLabel: "late-commit-joiner",
                bootstrap: false,
                writeReadinessSettleMs: 100,
            } as any);
        } finally {
            held.restore();
        }
        expect(held).toMatchObject({
            delivered: true,
            changes: 1,
            batches: 1,
            evidenceBeforeDelivery: false,
        });
        expect((joiner.program as any).writeReadinessRemoteEvidence).toBe(true);
        expect(decode(await joiner.readFile("/quiet.txt"))).toBe("quiet");
        // Nothing else arrives on a quiet filesystem, so without that
        // batch's evidence the joiner would wait for a new write forever.
        await joiner.awaitWriteReady({ timeout: 20_000 });
        await joiner.writeFile("/after-join.txt", "written");
        expect(decode(await joiner.readFile("/after-join.txt"))).toBe(
            "written"
        );
    });

    it(
        "judges an unfinished bootstrap by what was stored before the open",
        { timeout: 240_000 },
        async () => {
            const root = await mkdtemp(join(tmpdir(), "shared-fs-opening-"));
            const directory = join(root, "joiner");
            const logOf = (fs: SharedFsHandle) =>
                (fs.program as any).entries.log.log;
            let joinerPeer: Peerbit | undefined;
            try {
                const donorPeer = await createPeer();
                const donor = await openSharedFs({
                    peerbit: donorPeer,
                    machineLabel: "opening-donor",
                });
                await donor.writeFile("/first.txt", "first");
                const address = donor.address;
                const statePath = (at: string) =>
                    join(at, "shared-fs-bootstrap", `${address}.json`);
                const state = async (at = directory) =>
                    JSON.parse(await readFile(statePath(at), "utf8"));
                const writeState = async (
                    sidecar: object = {
                        writeReady: false,
                        bootstrap: "active",
                    },
                    at = directory
                ) => {
                    await mkdir(join(at, "shared-fs-bootstrap"), {
                        recursive: true,
                    });
                    await writeFile(statePath(at), JSON.stringify(sidecar));
                };
                const reopen = async (
                    label: string,
                    bootstrap: false | { discoveryTimeoutMs: number },
                    at = directory
                ) => {
                    await donor.writeFile(`/${label}.txt`, label);
                    joinerPeer = await Peerbit.create({ directory: at });
                    await joinerPeer.dial(donorPeer);
                    const held = holdOpenUntilHistory(
                        joinerPeer,
                        (value) =>
                            value instanceof NamingEvent &&
                            value.name === `${label}.txt`
                    );
                    let fs: SharedFsHandle;
                    try {
                        fs = await openSharedFs({
                            peerbit: joinerPeer,
                            address,
                            machineLabel: label,
                            bootstrap,
                            writeReadinessSettleMs: 100,
                        } as any);
                    } finally {
                        held.restore();
                    }
                    expect(held.arrived).toBe(true);
                    await (fs.program as any).bootstrapDecision;
                    return fs;
                };
                const joinedPlainly = async (
                    fs: SharedFsHandle,
                    at: string
                ) => {
                    expect(fs.bootstrapStatus().phase).toBe("off");
                    // The plain join cleared the marker, so a later reopen
                    // of the now-populated store is not held unverified.
                    await (fs.program as any).stateWriteChain;
                    expect(await state(at)).not.toHaveProperty("bootstrap");
                    await fs.awaitWriteReady({ timeout: 20_000 });
                    await waitUntil(async () => {
                        for (const entry of await logOf(donor)
                            .getHeads()
                            .all()) {
                            expect(await logOf(fs).has(entry.hash)).toBe(true);
                        }
                    });
                    await joinerPeer!.stop();
                };

                // A join stopped before its bootstrap decided left an
                // "active" marker over a store with no content (as a mount
                // timeout does). A retry whose open receives the donor's
                // history is still a plain join, with the bootstrap on and
                // with it off.
                const autoDirectory = join(root, "joiner-auto");
                await writeState(undefined, autoDirectory);
                await joinedPlainly(
                    await reopen(
                        "empty-retry-auto",
                        { discoveryTimeoutMs: 500 },
                        autoDirectory
                    ),
                    autoDirectory
                );
                await writeState();
                await joinedPlainly(
                    await reopen("empty-retry", false),
                    directory
                );

                // The same marker over content an earlier session stored may
                // be a partial bootstrap, whatever this open receives: it
                // holds the unverified posture, with the bootstrap on and
                // with it off.
                await writeState();
                const resumed = await reopen("resumed", {
                    discoveryTimeoutMs: 500,
                });
                expect(resumed.bootstrapStatus()).toMatchObject({
                    phase: "unverified",
                    writeReady: false,
                    guardArmed: false,
                });
                await joinerPeer!.stop();
                await writeState();
                const resumedOff = await reopen("resumed-off", false);
                expect(resumedOff.bootstrapStatus()).toMatchObject({
                    phase: "unverified",
                    writeReady: false,
                    guardArmed: false,
                });
                await joinerPeer!.stop();

                // A join that abandoned to a plain join cleared its marker;
                // stopped before it was write-ready, it left content and no
                // marker. The next open writes its own "active" marker, and
                // that content still makes it a resumed bootstrap.
                await writeState({ writeReady: false });
                const remarked = await reopen("re-marked", {
                    discoveryTimeoutMs: 500,
                });
                expect(remarked.bootstrapStatus()).toMatchObject({
                    phase: "unverified",
                    writeReady: false,
                    guardArmed: false,
                });
            } finally {
                await joinerPeer?.stop().catch(() => {});
                await rm(root, { recursive: true, force: true });
            }
        }
    );

    it("never lets a repeated genesis supersede a real snapshot", async () => {
        const fs = await openSharedFs({
            peerbit: await createPeer(),
            machineLabel: "genesis-fence",
        });
        const program: any = fs.program;
        const manifestId = `bootstrap:${program.authorKey()}`;
        const genesis = await program.getDocument(manifestId);
        // Hold a repeated genesis between its decision (nothing written) and
        // its put, while data and a real snapshot land.
        let reached!: () => void;
        let release!: () => void;
        const atPut = new Promise<void>((resolve) => (reached = resolve));
        const held = new Promise<void>((resolve) => (release = resolve));
        const put = program.entries.put.bind(program.entries);
        vi.spyOn(program.entries, "put").mockImplementationOnce(
            async (...args: any[]) => {
                reached();
                await held;
                return put(...args);
            }
        );
        const repeated = program.publishEmptyManifest(false);
        await atPut;
        await fs.writeFile("/data.txt", "written meanwhile");
        const snapshot = fs.snapshotWrite();
        await Promise.race([
            snapshot,
            new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
        release();
        await Promise.all([repeated, snapshot]);
        expect(
            (await program.getDocument(manifestId)).payloadBytes
        ).not.toEqual(genesis.payloadBytes);
    });

    it("never re-publishes the genesis from a partial view", async () => {
        const fs = await openSharedFs({
            peerbit: await createPeer(),
            machineLabel: "genesis-partial",
        });
        const program: any = fs.program;
        const heads = async () =>
            (await program.entries.log.log.getHeads().all()).map(
                (entry: any) => entry.hash as string
            );
        const before = await heads();
        // An unverified or overlay view cannot vouch that nothing is written.
        for (const phase of ["unverified", "overlay-active"]) {
            program.bootstrapPhase = phase;
            await program.publishEmptyManifest(false);
            expect(await heads()).toEqual(before);
        }
        program.bootstrapPhase = "off";
        // Requests that arrive while one is queued share its put.
        const length = program.entries.log.log.length;
        await Promise.all([
            program.publishEmptyManifest(false),
            program.publishEmptyManifest(false),
            program.publishEmptyManifest(false),
        ]);
        expect(await heads()).not.toEqual(before);
        expect(program.entries.log.log.length).toBe(length + 1);
    });

    it("never lets a gated genesis author re-publish its genesis", async () => {
        const root = await mkdtemp(join(tmpdir(), "shared-fs-gated-genesis-"));
        const directory = join(root, "creator");
        let creatorPeer: Peerbit | undefined;
        try {
            creatorPeer = await Peerbit.create({ directory });
            const creator = await openSharedFs({
                peerbit: creatorPeer,
                machineLabel: "gated-author",
            });
            const address = creator.address!;
            await creatorPeer.stop();
            // An observer open of the same directory clears the readiness
            // proof, so the author's next full open is gated.
            creatorPeer = await Peerbit.create({ directory });
            await openSharedFs({
                peerbit: creatorPeer,
                address,
                machineLabel: "gated-author-observer",
                replicate: false,
                bootstrap: false,
            });
            await creatorPeer.stop();
            creatorPeer = await Peerbit.create({ directory });
            const gated = await openSharedFs({
                peerbit: creatorPeer,
                address,
                machineLabel: "gated-author-full",
                bootstrap: false,
                writeReadinessSettleMs: 100,
            } as any);
            expect(gated.bootstrapStatus().writeReady).toBe(false);
            const log = (gated.program as any).entries.log.log;
            const heads = async () =>
                (await log.getHeads().all()).map(
                    (entry: any) => entry.hash as string
                );
            const before = await heads();

            // A fresh peer opens it and settles from the author's genesis. It
            // brings nothing new, and the author may not re-publish: its own
            // put would count as an arrival and open its gate on no evidence.
            const joinerPeer = await createPeer();
            await joinerPeer.dial(creatorPeer);
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address,
                machineLabel: "gated-author-joiner",
                bootstrap: false,
                writeReadinessSettleMs: 100,
            } as any);
            await joiner.awaitWriteReady({ timeout: 20_000 });
            await expect(
                gated.awaitWriteReady({ timeout: 1_000 })
            ).rejects.toMatchObject({ code: "ETIMEDOUT" });
            expect(await heads()).toEqual(before);
            expect((gated.program as any).writeReadinessRemoteEvidence).toBe(
                false
            );
        } finally {
            await creatorPeer?.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it("listens for peer sessions only while its genesis is needed", async () => {
        const root = await mkdtemp(join(tmpdir(), "shared-fs-genesis-listen-"));
        let creatorPeer: Peerbit | undefined;
        try {
            creatorPeer = await Peerbit.create({
                directory: join(root, "creator"),
            });
            const pubsub: any = creatorPeer.services.pubsub;
            const listeners = () => pubsub.listenerCount("subscribe");
            const listening = (fs: SharedFsHandle) =>
                (fs.program as any).emptyManifestListener !== undefined;
            const before = listeners();
            const creator = await openSharedFs({
                peerbit: creatorPeer,
                machineLabel: "listener-creator",
            });
            const address = creator.address;
            expect(listening(creator)).toBe(true);
            // Close unregisters it (pubsub used to keep it, and with it the
            // closed program).
            await creator.program.close();
            expect(listeners()).toBe(before);

            // The author of a zero-document manifest listens again on reopen.
            const reopen = (machineLabel: string) =>
                openSharedFs({
                    peerbit: creatorPeer!,
                    address,
                    machineLabel,
                    bootstrap: false,
                });
            const reopened = await reopen("listener-reopen");
            expect(listening(reopened)).toBe(true);
            // Once something is written, the next peer session drops it.
            await reopened.writeFile("/data.txt", "data");
            const joinerPeer = await createPeer();
            await joinerPeer.dial(creatorPeer);
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address,
                machineLabel: "listener-joiner",
                bootstrap: false,
                writeReadinessSettleMs: 100,
            } as any);
            await waitUntil(() => expect(listening(reopened)).toBe(false));
            // Neither a peer without its own genesis nor the author of a
            // snapshot with documents listens.
            expect(listening(joiner)).toBe(false);
            await reopened.snapshotWrite();
            await reopened.program.close();
            expect(listening(await reopen("listener-populated"))).toBe(false);
        } finally {
            await creatorPeer?.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it("drops the genesis listener once written, whatever its bootstrap phase", async () => {
        const fs = await openSharedFs({
            peerbit: await createPeer(),
            machineLabel: "genesis-converged",
        });
        const program: any = fs.program;
        await fs.writeFile("/data.txt", "data");
        // A genesis author that reconverged from another replica's snapshot
        // stays "converged" for the whole open.
        program.bootstrapPhase = "converged";
        await program.publishEmptyManifest(false);
        expect(program.emptyManifestListener).toBeUndefined();
    });

    it("replaces the genesis at the first publisher check after a write", async () => {
        const fs = await openSharedFs({
            peerbit: await createPeer(),
            machineLabel: "genesis-publisher",
            snapshot: { publishIntervalMs: 100 },
        });
        const program: any = fs.program;
        const manifestId = `bootstrap:${program.authorKey()}`;
        // One write is far below minChangesBetween and the genesis is fresh,
        // but a zero-document manifest counts as no snapshot at all.
        await fs.writeFile("/data.txt", "data");
        await waitUntil(
            async () => {
                const manifest = await program.getDocument(manifestId);
                expect(
                    deserialize(manifest.payloadBytes, SnapshotManifestPayload)
                        .counts.docs
                ).toBeGreaterThan(0n);
            },
            { timeoutMs: 10_000 }
        );
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
                // still replicating behind it. The overlay installs before
                // the phase flips, so a slow segment install can finish
                // after the log already covered every snapshot id; the phase
                // then stays overlay-active with nothing pending until the
                // retirement double check, so pendingDocs may be 0 here.
                // The view assertions below hold either way.
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
        "keeps whole-store scans gated while a stalled overlay is partial",
        { retry: 1, timeout: 240_000 },
        async () => {
            const donor = await populatedDonor(20);
            const joinerPeer = await createPeer();
            await joinerPeer.dial(donor.peer);
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: donor.fs.address,
                machineLabel: "joiner",
            });
            await waitUntil(
                () => {
                    expect(joiner.bootstrapStatus().phase).toBe(
                        "overlay-active"
                    );
                },
                { intervalMs: 2 }
            );
            // Pin the stall: verified retirement needs every pending id
            // covered (and a 300 ms double check after that), and this one
            // has no row anywhere, so the overlay stays active.
            (joiner.program as any).overlayPending.set("stalled", {
                nodeId: "stalled",
                kind: "file-version",
            });

            // Gating asymmetry: the per-file branch is overlay-consistent
            // and stays available; whole-store scans are gated. The probe
            // file has exactly one version, so no transient multi-head
            // state can surface as a conflict here.
            await expect(
                joiner.conflicts("/tree/dir-3/file-13.txt")
            ).resolves.toEqual([]);
            await expect(joiner.conflicts()).rejects.toThrow(/bootstrap/);
        }
    );

    it(
        "retires unverified into the safety posture when convergence times out",
        { retry: 1, timeout: 240_000 },
        async () => {
            const donor = await populatedDonor(20);
            const joinerPeer = await createPeer();
            await joinerPeer.dial(donor.peer);
            let settle!: (event: BootstrapTelemetryEvent) => void;
            const outcome = new Promise<BootstrapTelemetryEvent>(
                (resolve) => (settle = resolve)
            );
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: donor.fs.address,
                machineLabel: "joiner",
                // Armed as the overlay activates, before the first coverage
                // sweep; verified retirement needs a later 300 ms double
                // check, so the timeout always fires first.
                bootstrap: { retirementTimeoutMs: 1 },
                telemetry: {
                    bootstrap: (event) => {
                        if (
                            event.type === "overlay-retired" ||
                            event.type === "fallback" ||
                            event.type === "aborted"
                        ) {
                            settle(event);
                        }
                    },
                },
            });
            expect(await outcome).toMatchObject({
                type: "overlay-retired",
                verified: false,
            });

            // The unverified posture: overlay retired, guard still down, GC
            // and snapshots refused, whole-store scans available again, and
            // awaitBootstrapConverged resolves instead of hanging.
            const status = joiner.bootstrapStatus();
            expect(status.phase).toBe("unverified");
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
        }
    );

    it("waits for a bootstrap the open is still deciding on", async () => {
        const donor = await populatedDonor(20);
        const joinerPeer = await createPeer();
        await joinerPeer.dial(donor.peer);
        // The open returns before it decides whether to bootstrap, and its
        // phase reads "off" until its read of the pre-open store answers.
        // Hold that read, so the call below lands inside the window.
        const contentStoredBeforeOpen = (SharedFileSystem.prototype as any)
            .contentStoredBeforeOpen;
        let reached!: () => void;
        const deciding = new Promise<void>((resolve) => (reached = resolve));
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        const probe = vi
            .spyOn(SharedFileSystem.prototype as any, "contentStoredBeforeOpen")
            .mockImplementation(async function (this: any, ...args: any[]) {
                if (this.node === joinerPeer) {
                    reached();
                    await released;
                }
                return contentStoredBeforeOpen.apply(this, args);
            });
        try {
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: donor.fs.address,
                machineLabel: "joiner",
            });
            await deciding;
            expect(joiner.bootstrapStatus().phase).toBe("off");
            let answer: { verified: boolean } | undefined;
            const converged = joiner
                .awaitBootstrapConverged()
                .then((value) => (answer = value));
            // An answer that does not wait has settled by the next turn.
            await new Promise((resolve) => setImmediate(resolve));
            expect(answer).toBeUndefined();
            release();
            await converged;
            expect(answer).toEqual({ verified: true });
            expect(joiner.bootstrapStatus()).toMatchObject({
                phase: "converged",
                snapshotCoverageVerified: true,
            });
        } finally {
            release();
            probe.mockRestore();
        }
    });
});
