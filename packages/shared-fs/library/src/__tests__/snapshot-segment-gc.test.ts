import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";

const HOUR_MS = 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
};

const DEFAULT_WAIT_MS = process.env.CI ? 90_000 : 30_000;

const waitUntil = async (
    assertion: () => Promise<void> | void,
    options: { timeoutMs?: number; intervalMs?: number } = {}
) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
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

describe("snapshot segment reclamation", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;
    let fakeNow: number;

    const blocks = () => (fs.program as any).node.services.blocks;
    const manifestCids = async (program: any = fs.program): Promise<string[]> =>
        (
            (await (program as any).loadSegmentLedgerForTest?.()) ??
            (await loadLedger(program))
        ).current?.cids.map((c: any) => c.cid) ?? [];
    const loadLedger = (program: any = fs.program) =>
        (program as any).loadSegmentLedger() as Promise<any>;
    const reap = (nowMs: number) =>
        (fs.program as any).reapSnapshotSegments(nowMs) as Promise<{
            deleted: number;
            bytes: bigint;
        }>;

    beforeEach(async () => {
        fakeNow = Date.now();
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "segment-gc",
            clock: () => fakeNow,
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        try {
            await peer.stop();
        } catch {
            /* benign double-stop */
        }
    });

    const seedFiles = async (count = 12) => {
        for (let i = 0; i < count; i++) {
            await fs.writeFile(`/f-${i}.txt`, `content ${i}`);
        }
    };

    it("reaps superseded generations, keeps live and dedup-shared cids", async () => {
        await seedFiles();
        await fs.snapshotWrite();
        const gen1 = new Set(await manifestCids());
        expect(gen1.size).toBeGreaterThan(1);

        // Mutate exactly one file: its shard's bytes change, the other
        // shards dedup to identical cids across generations.
        await fs.writeFile("/f-0.txt", "mutated");
        fakeNow += 1_000;
        await fs.snapshotWrite();
        const gen2 = new Set(await manifestCids());
        const shared = [...gen1].filter((cid) => gen2.has(cid));
        const retiredOnly = [...gen1].filter((cid) => !gen2.has(cid));
        expect(shared.length).toBeGreaterThan(0);
        expect(retiredOnly.length).toBeGreaterThan(0);

        // Inside the grace window nothing is deleted (a joiner may still
        // be fetching the superseded manifest).
        const early = await reap(fakeNow + 1 * HOUR_MS);
        expect(early.deleted).toBe(0);
        for (const cid of retiredOnly) {
            expect(await blocks().has(cid)).toBe(true);
        }

        // Past the grace the superseded delta goes; live and shared cids
        // stay. The GC hook carries the same numbers into the report.
        const report = await fs.collectGarbage({
            settleMs: 0,
            nowMs: fakeNow + 4 * HOUR_MS,
        });
        expect(report.segmentBlocksDeleted).toBe(retiredOnly.length);
        expect(report.reclaimedSegmentBytes).toBeGreaterThan(0n);
        for (const cid of retiredOnly) {
            expect(await blocks().has(cid)).toBe(false);
        }
        for (const cid of [...gen2, ...shared]) {
            expect(await blocks().has(cid)).toBe(true);
        }
        // Processed generations leave the ledger.
        expect((await loadLedger()).retired).toHaveLength(0);
    });

    it("records intent before the cap throw and reap protects the live old generation", async () => {
        await seedFiles(6);
        await fs.snapshotWrite();
        const gen1 = new Set(await manifestCids());
        const program: any = fs.program;
        const manifestId = `bootstrap:${program.authorKey()}`;

        // Two consecutive publishes failing AT THE PAYLOAD-CAP CHECK —
        // before the CUT, so the gen-1 manifest stays LIVE while
        // ledger.current holds a stranded unpublished generation. This is
        // the one window where reap's own-manifest liveness protection is
        // load-bearing (current-set membership alone would not protect
        // the live delta).
        program.manifestPayloadCapBytes = 1;
        const blocksAny: any = program.node.services.blocks;
        const originalPut = blocksAny.put.bind(blocksAny);
        const attemptPutCids: string[] = [];
        blocksAny.put = async (bytes: any, ...rest: any[]) => {
            const cid = await originalPut(bytes, ...rest);
            attemptPutCids.push(cid);
            return cid;
        };
        try {
            await fs.writeFile("/f-0.txt", "attempt one");
            fakeNow += 1_000;
            await expect(fs.snapshotWrite()).rejects.toThrow(/exceeds/);
            await fs.writeFile("/f-1.txt", "attempt two");
            fakeNow += 1_000;
            await expect(fs.snapshotWrite()).rejects.toThrow(/exceeds/);
        } finally {
            blocksAny.put = originalPut;
        }
        // The old manifest doc must still be live (the throw preceded the
        // CUT) and `current` must be the stranded attempt, not gen-1.
        expect(await program.getDocument(manifestId)).toBeDefined();
        const ledger = await loadLedger();
        const currentSet = new Set(
            (ledger.current?.cids ?? []).map((c: any) => c.cid)
        );
        expect([...currentSet].sort()).not.toEqual([...gen1].sort());
        // No unrecorded strays: every block the failed attempts put is
        // positively recorded (current or retired).
        const recorded = new Set([
            ...currentSet,
            ...ledger.retired.flatMap((g: any) =>
                g.cids.map((c: any) => c.cid)
            ),
        ]);
        for (const cid of attemptPutCids) {
            expect(recorded.has(cid)).toBe(true);
        }

        // Far past grace, the retired gen-1 delta is expired and NOT in
        // `current` — only the live-manifest protection can keep it. A
        // failed-attempt-only shard may also be retired here when both
        // mutations happened to hash into the same random shard; that
        // shard is dead and may be reclaimed.
        const safelyDead = new Set(
            ledger.retired
                .flatMap((generation: any) => generation.cids)
                .map((entry: any) => entry.cid)
                .filter((cid: string) => !gen1.has(cid) && !currentSet.has(cid))
        );
        const guarded = await reap(fakeNow + 24 * HOUR_MS);
        expect(guarded.deleted).toBe(safelyDead.size);
        for (const cid of gen1) {
            expect(await blocks().has(cid)).toBe(true);
        }
        for (const cid of safelyDead) {
            expect(await blocks().has(cid)).toBe(false);
        }
        expect((await loadLedger()).retired.length).toBeGreaterThan(0);

        // Cap restored: the next publish supersedes for real, stranded
        // deltas flow through retired, and a later reap clears them.
        program.manifestPayloadCapBytes = 100_000;
        fakeNow += 1_000;
        await fs.snapshotWrite();
        const gen3 = new Set(await manifestCids());
        await reap(fakeNow + 48 * HOUR_MS);
        for (const cid of gen3) {
            expect(await blocks().has(cid)).toBe(true);
        }
        const after = await loadLedger();
        expect(after.retired).toHaveLength(0);
        for (const cid of gen1) {
            if (!gen3.has(cid)) {
                expect(await blocks().has(cid)).toBe(false);
            }
        }
    });

    it("durably records successful shards when a later block put fails without publishing a replacement", async () => {
        const directory = mkdtempSync(
            join(tmpdir(), "sfs-segment-partial-put-")
        );
        const partialPeer = await Peerbit.create({
            directory: join(directory, "peer"),
        });
        try {
            const partialFs = await openSharedFs({
                peerbit: partialPeer,
                machineLabel: "segment-partial-put",
                snapshot: { disabled: true },
                gc: false,
            });
            for (let i = 0; i < 16; i++) {
                await partialFs.writeFile(`/partial-${i}.txt`, `before-${i}`);
            }
            const baseline = await partialFs.snapshotWrite();
            expect(baseline.segments).toBeGreaterThan(1);

            const program: any = partialFs.program;
            const manifestId = `bootstrap:${program.authorKey()}`;
            const manifestBefore = await program.getDocument(manifestId);
            expect(manifestBefore).toBeDefined();
            for (let i = 0; i < 16; i++) {
                await partialFs.writeFile(`/partial-${i}.txt`, `after-${i}`);
            }

            const blocksAny: any = program.node.services.blocks;
            const originalPut = blocksAny.put.bind(blocksAny);
            const successfulCids: string[] = [];
            let putCalls = 0;
            blocksAny.put = async (...args: any[]) => {
                putCalls++;
                if (putCalls === 2) {
                    throw new Error("injected later shard put failure");
                }
                const cid = await originalPut(...args);
                successfulCids.push(cid);
                return cid;
            };
            let failure: unknown;
            try {
                failure = await partialFs.snapshotWrite().then(
                    () => undefined,
                    (error) => error
                );
            } finally {
                blocksAny.put = originalPut;
            }

            expect(failure).toMatchObject({
                message: "injected later shard put failure",
            });
            expect(putCalls).toBe(2);
            expect(successfulCids).toHaveLength(1);
            const ledgerPath = await program.segmentLedgerPath();
            expect(ledgerPath).toBeDefined();
            const durableLedger = JSON.parse(
                await readFile(ledgerPath, "utf8")
            );
            const recorded = new Set([
                ...(durableLedger.current?.cids ?? []).map(
                    (entry: any) => entry.cid
                ),
                ...durableLedger.retired.flatMap((generation: any) =>
                    generation.cids.map((entry: any) => entry.cid)
                ),
            ]);
            for (const cid of successfulCids) {
                expect(recorded.has(cid)).toBe(true);
            }
            const manifestAfter = await program.getDocument(manifestId);
            expect(manifestAfter?.payloadBytes).toEqual(
                manifestBefore.payloadBytes
            );
        } finally {
            await partialPeer.stop().catch(() => {});
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("skips reaping while a publish is in flight (except its own tail)", async () => {
        await seedFiles(4);
        await fs.snapshotWrite();
        await fs.writeFile("/f-0.txt", "mutated");
        fakeNow += 1_000;
        await fs.snapshotWrite();
        const program: any = fs.program;
        // A concurrent publish has put its shard blocks but its intent may
        // not have reached the ledger chain yet — reap must stand down.
        program.snapshotRunning = true;
        const skipped = await reap(fakeNow + 24 * HOUR_MS);
        expect(skipped.deleted).toBe(0);
        program.snapshotRunning = false;
        const real = await reap(fakeNow + 24 * HOUR_MS);
        expect(real.deleted).toBeGreaterThan(0);
    });

    it("memory ledger survives a program reopen on the same node", async () => {
        await seedFiles(4);
        await fs.snapshotWrite();
        await fs.writeFile("/f-0.txt", "mutated");
        fakeNow += 1_000;
        await fs.snapshotWrite();
        const retiredBefore = (await loadLedger()).retired;
        expect(retiredBefore.length).toBeGreaterThan(0);
        const address = fs.program.address!.toString();
        await fs.program.close();

        // The in-memory block store lives on the NODE and survives the
        // program reopen — the ledger's memory fallback must too, or every
        // generation retired before the reopen would be silently exempt.
        fs = await openSharedFs({
            peerbit: peer,
            address,
            machineLabel: "segment-gc-reopen",
            clock: () => fakeNow,
        });
        const retiredAfter = (await loadLedger()).retired;
        expect(
            retiredAfter.flatMap((g: any) => g.cids.map((c: any) => c.cid))
        ).toEqual(
            retiredBefore.flatMap((g: any) => g.cids.map((c: any) => c.cid))
        );
        const reaped = await reap(fakeNow + 24 * HOUR_MS);
        expect(reaped.deleted).toBeGreaterThan(0);
    });

    it("close drains an admitted snapshot intent and no stale publish crosses reopen", async () => {
        await seedFiles(4);
        const program: any = fs.program;
        const manifestId = `bootstrap:${program.authorKey()}`;
        const blocksAny: any = program.node.services.blocks;
        const originalPut = blocksAny.put.bind(blocksAny);
        const originalSave = program.saveSegmentLedgerCas.bind(program);
        const originalPublish = program.putPreferLinked.bind(program);
        const intentEntered = deferred();
        const intentAllowed = deferred();
        const putCids: string[] = [];
        const staleMutations: string[] = [];
        const completionOrder: string[] = [];
        let gateIntent = true;
        let closeReturned = false;
        let intentTailCompleted = false;
        let intentSignal: AbortSignal | undefined;

        vi.spyOn(blocksAny, "put").mockImplementation(
            async (...args: any[]) => {
                const cid = await originalPut(...args);
                putCids.push(cid);
                return cid;
            }
        );
        vi.spyOn(program, "saveSegmentLedgerCas").mockImplementation(
            async (...args: any[]) => {
                if (closeReturned) staleMutations.push("ledger");
                if (gateIntent) {
                    gateIntent = false;
                    intentSignal = args[3];
                    intentEntered.resolve();
                    await intentAllowed.promise;
                }
                const result = await originalSave(...args);
                intentTailCompleted = true;
                completionOrder.push("intent-tail");
                return result;
            }
        );
        vi.spyOn(program, "putPreferLinked").mockImplementation(
            async (...args: any[]) => {
                if (closeReturned) staleMutations.push("manifest");
                return originalPublish(...args);
            }
        );

        const snapshotOutcome = fs.snapshotWrite().then(
            () => undefined,
            (error) => error
        );
        let closing: Promise<boolean> | undefined;
        try {
            await intentEntered.promise;
            const maintenanceSignal = program.maintenanceAbortController.signal;
            expect(intentSignal).toBe(maintenanceSignal);
            closing = program.close().then((result: boolean) => {
                closeReturned = true;
                completionOrder.push("close");
                return result;
            });
            expect(intentSignal?.aborted).toBe(true);
            expect(intentSignal?.reason).toMatchObject({ code: "ECLOSED" });
            // close() aborts the lifecycle synchronously before its first await.
            // Releasing now makes completion order, not elapsed time, the proof.
            intentAllowed.resolve();

            const [snapshotError] = await Promise.all([
                snapshotOutcome,
                closing,
            ]);
            expect(putCids.length).toBeGreaterThan(0);
            expect(snapshotError).toMatchObject({ code: "ECLOSED" });
            expect(intentTailCompleted).toBe(true);
            expect(completionOrder).toEqual(["intent-tail", "close"]);
        } finally {
            intentAllowed.resolve();
            await Promise.allSettled(
                [snapshotOutcome, closing].filter(
                    (task): task is Promise<unknown> => task !== undefined
                )
            );
        }

        const reopenedProgram = await (peer as any).open(program, {
            existing: "reuse",
            args: {
                machineLabel: "segment-intent-close-reopen",
                allowPartialWrites: true,
                addressOpen: true,
                bootstrap: false,
                clock: () => fakeNow,
                snapshot: { disabled: true },
                gc: false,
            },
        });
        expect(reopenedProgram).toBe(program);

        const recordedCids = (ledger: any) =>
            new Set([
                ...(ledger.current?.cids ?? []).map((entry: any) => entry.cid),
                ...ledger.retired.flatMap((generation: any) =>
                    generation.cids.map((entry: any) => entry.cid)
                ),
            ]);
        const ledger = await loadLedger(program);
        const ledgerBeforeWait = JSON.stringify(ledger);
        const recorded = recordedCids(ledger);
        for (const cid of putCids) {
            expect(recorded.has(cid)).toBe(true);
        }
        expect(await program.getDocument(manifestId)).toBeUndefined();
        await sleep(20);
        const ledgerAfterWait = await loadLedger(program);
        expect(JSON.stringify(ledgerAfterWait)).toBe(ledgerBeforeWait);
        for (const cid of putCids) {
            expect(recordedCids(ledgerAfterWait).has(cid)).toBe(true);
        }
        expect(await program.getDocument(manifestId)).toBeUndefined();
        expect(staleMutations).toEqual([]);
    });

    it("close joins a reaper from block deletion through its ledger CAS", async () => {
        await seedFiles();
        await fs.snapshotWrite();
        const gen1 = new Set(await manifestCids());
        await fs.writeFile("/f-0.txt", "mutated before joined reap");
        fakeNow += 1_000;
        await fs.snapshotWrite();
        const gen2 = new Set(await manifestCids());
        const retiredOnly = [...gen1].filter((cid) => !gen2.has(cid));
        expect(retiredOnly.length).toBeGreaterThan(0);

        const program: any = fs.program;
        // Queue behind any publish-tail reap without reaching into the private
        // chain; current time is still inside grace, so this only drains it.
        await reap(fakeNow);
        const blocksAny: any = program.node.services.blocks;
        const originalSave = program.saveSegmentLedgerCas.bind(program);
        const ledgerCasEntered = deferred();
        const ledgerCasAllowed = deferred();
        const completionOrder: string[] = [];
        let gateLedgerCas = true;
        let closeReturned = false;
        let staleLedgerWrites = 0;
        let deletedCids: string[] = [];
        let blocksAbsentAtCas = false;
        let ledgerCasCompleted = false;
        let ledgerCasSignal: AbortSignal | undefined;
        vi.spyOn(program, "saveSegmentLedgerCas").mockImplementation(
            async (...args: any[]) => {
                if (closeReturned) staleLedgerWrites++;
                const reapedCids = args[2];
                const isTargetCas =
                    gateLedgerCas &&
                    reapedCids instanceof Set &&
                    reapedCids.size > 0;
                if (isTargetCas) {
                    gateLedgerCas = false;
                    ledgerCasSignal = args[3];
                    deletedCids = [...reapedCids];
                    blocksAbsentAtCas = (
                        await Promise.all(
                            deletedCids.map((cid) => blocksAny.has(cid))
                        )
                    ).every((present) => !present);
                    ledgerCasEntered.resolve();
                    await ledgerCasAllowed.promise;
                }
                const result = await originalSave(...args);
                if (isTargetCas) {
                    ledgerCasCompleted = true;
                    completionOrder.push("ledger-cas");
                }
                return result;
            }
        );

        let reaperSettled = false;
        const reaping = reap(fakeNow + 24 * HOUR_MS).then((result) => {
            reaperSettled = true;
            completionOrder.push("reaper");
            return result;
        });
        let closing: Promise<boolean> | undefined;
        let closeObservedCompletedReaper = false;
        try {
            await ledgerCasEntered.promise;
            const maintenanceSignal = program.maintenanceAbortController.signal;
            expect(ledgerCasSignal).toBe(maintenanceSignal);
            closing = program.close().then((result: boolean) => {
                closeObservedCompletedReaper =
                    ledgerCasCompleted && reaperSettled;
                closeReturned = true;
                completionOrder.push("close");
                return result;
            });
            expect(ledgerCasSignal?.aborted).toBe(true);
            expect(ledgerCasSignal?.reason).toMatchObject({ code: "ECLOSED" });
            ledgerCasAllowed.resolve();

            const [result] = await Promise.all([reaping, closing]);
            expect(deletedCids.length).toBeGreaterThan(0);
            expect(blocksAbsentAtCas).toBe(true);
            expect(result.deleted).toBe(deletedCids.length);
            expect(closeObservedCompletedReaper).toBe(true);
            expect(completionOrder).toEqual(["ledger-cas", "reaper", "close"]);
        } finally {
            ledgerCasAllowed.resolve();
            await Promise.allSettled(
                [reaping, closing].filter(
                    (task): task is Promise<unknown> => task !== undefined
                )
            );
        }

        const reopenedProgram = await (peer as any).open(program, {
            existing: "reuse",
            args: {
                machineLabel: "segment-reap-close-reopen",
                allowPartialWrites: true,
                addressOpen: true,
                bootstrap: false,
                clock: () => fakeNow,
                snapshot: { disabled: true },
                gc: false,
            },
        });
        expect(reopenedProgram).toBe(program);
        const ledger = await loadLedger(program);
        const ledgerBeforeWait = JSON.stringify(ledger);
        const stillRetired = new Set(
            ledger.retired.flatMap((generation: any) =>
                generation.cids.map((entry: any) => entry.cid)
            )
        );
        for (const cid of deletedCids) {
            expect(stillRetired.has(cid)).toBe(false);
            expect(await blocksAny.has(cid)).toBe(false);
        }
        await sleep(20);
        const ledgerAfterWait = await loadLedger(program);
        expect(JSON.stringify(ledgerAfterWait)).toBe(ledgerBeforeWait);
        const retiredAfterWait = new Set(
            ledgerAfterWait.retired.flatMap((generation: any) =>
                generation.cids.map((entry: any) => entry.cid)
            )
        );
        for (const cid of deletedCids) {
            expect(retiredAfterWait.has(cid)).toBe(false);
            expect(await blocksAny.has(cid)).toBe(false);
        }
        expect(staleLedgerWrites).toBe(0);
    });

    it("fails a physically-complete reap on false ledger CAS and clears absent cids on retry", async () => {
        await seedFiles();
        await fs.snapshotWrite();
        const gen1 = new Set(await manifestCids());
        await fs.writeFile("/f-0.txt", "mutated before false reap CAS");
        fakeNow += 1_000;
        await fs.snapshotWrite();
        const gen2 = new Set(await manifestCids());
        expect([...gen1].some((cid) => !gen2.has(cid))).toBe(true);

        // Drain the publish tail while every retired generation is inside grace.
        await reap(fakeNow);
        const program: any = fs.program;
        const blocksAny: any = program.node.services.blocks;
        const originalSave = program.saveSegmentLedgerCas.bind(program);
        let failNextReapCas = true;
        let falseCasCalls = 0;
        let physicallyReaped: string[] = [];
        vi.spyOn(program, "saveSegmentLedgerCas").mockImplementation(
            async (...args: any[]) => {
                const reapedCids = args[2];
                if (
                    failNextReapCas &&
                    reapedCids instanceof Set &&
                    reapedCids.size > 0
                ) {
                    failNextReapCas = false;
                    falseCasCalls++;
                    physicallyReaped = [...reapedCids];
                    return false;
                }
                return originalSave(...args);
            }
        );

        const firstFailure = await reap(fakeNow + 24 * HOUR_MS).then(
            () => undefined,
            (error) => error
        );
        expect(firstFailure).toBeInstanceOf(Error);
        expect(falseCasCalls).toBe(1);
        expect(physicallyReaped.length).toBeGreaterThan(0);
        const ledgerAfterFailure = await loadLedger(program);
        const stillRecorded = new Set(
            ledgerAfterFailure.retired.flatMap((generation: any) =>
                generation.cids.map((entry: any) => entry.cid)
            )
        );
        for (const cid of physicallyReaped) {
            expect(await blocksAny.has(cid)).toBe(false);
            expect(stillRecorded.has(cid)).toBe(true);
        }

        const retry = await reap(fakeNow + 24 * HOUR_MS);
        expect(retry.deleted).toBe(0);
        expect(retry.bytes).toBe(0n);
        const ledgerAfterRetry = await loadLedger(program);
        const retiredAfterRetry = new Set(
            ledgerAfterRetry.retired.flatMap((generation: any) =>
                generation.cids.map((entry: any) => entry.cid)
            )
        );
        for (const cid of physicallyReaped) {
            expect(retiredAfterRetry.has(cid)).toBe(false);
            expect(await blocksAny.has(cid)).toBe(false);
        }
    });

    it("clamps a sub-floor grace with a warning", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        await peer.stop();
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "segment-gc-floor",
            clock: () => fakeNow,
            snapshot: { segmentReclaim: { graceMs: 60_000 } },
        });
        await seedFiles(4);
        await fs.snapshotWrite();
        await fs.writeFile("/f-0.txt", "mutated");
        fakeNow += 1_000;
        await fs.snapshotWrite();
        // 90 minutes past retirement: above the requested 1 min grace but
        // below the 2 h maxSnapshotAgeMs floor — nothing may be deleted.
        const early = await reap(fakeNow + 1.5 * HOUR_MS);
        expect(early.deleted).toBe(0);
        expect(
            warnSpy.mock.calls.some((c) =>
                String(c[0]).includes("segmentReclaim.graceMs raised")
            )
        ).toBe(true);
        const late = await reap(fakeNow + 4 * HOUR_MS);
        expect(late.deleted).toBeGreaterThan(0);
    });

    it("segmentReclaim: false disables reaping", async () => {
        await peer.stop();
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "segment-gc-off",
            clock: () => fakeNow,
            snapshot: { segmentReclaim: false },
        });
        await seedFiles(4);
        await fs.snapshotWrite();
        await fs.writeFile("/f-0.txt", "mutated");
        fakeNow += 1_000;
        await fs.snapshotWrite();
        const result = await reap(fakeNow + 24 * HOUR_MS);
        expect(result.deleted).toBe(0);
    });

    it("generation CAS merges a stale write instead of losing cids", async () => {
        const dir = mkdtempSync(join(tmpdir(), "sfs-segment-cas-"));
        const casPeer = await Peerbit.create({ directory: join(dir, "peer") });
        try {
            const casFs = await openSharedFs({
                peerbit: casPeer,
                machineLabel: "segment-gc-cas",
            });
            const program: any = casFs.program;
            for (let i = 0; i < 4; i++) {
                await casFs.writeFile(`/c-${i}.txt`, `v${i}`);
            }
            await casFs.snapshotWrite();
            const ledger = await program.loadSegmentLedger();
            expect(ledger.generation).toBeGreaterThan(0);
            expect(ledger.current).not.toBeNull();

            // A stale writer (generation 0 view) tries to record a
            // different retired gen: the CAS path must merge, not clobber
            // — no positively-recorded cid may vanish.
            const stale = {
                v: 1,
                generation: 0,
                current: null,
                retired: [
                    {
                        cids: [{ cid: "stale-cid-1", bytes: 11 }],
                        retiredAtMs: 123,
                        snapshotSeq: "9",
                    },
                ],
            };
            const ok = await program.saveSegmentLedgerCas(0, stale);
            expect(ok).toBe(true);
            const path = await program.segmentLedgerPath();
            const merged = JSON.parse(await readFile(path, "utf8"));
            expect(merged.generation).toBe(ledger.generation + 1);
            // The live current survived the stale writer...
            expect(merged.current?.cids?.length).toBe(
                ledger.current.cids.length
            );
            // ...and the stale writer's retired gen was folded in.
            expect(
                merged.retired.some((g: any) =>
                    g.cids.some((c: any) => c.cid === "stale-cid-1")
                )
            ).toBe(true);
        } finally {
            await casPeer.stop();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("another author's live manifest protects identical cids", async () => {
        // Leave one file to publish after B has opened so its readiness
        // proof is a real post-listener remote metadata arrival.
        await seedFiles(5);
        const address = fs.program.address!.toString();
        const peerB = await Peerbit.create();
        try {
            await peerB.dial(peer.getMultiaddrs());
            const fsB = await openSharedFs({
                peerbit: peerB,
                address,
                machineLabel: "segment-gc-b",
                clock: () => fakeNow,
                bootstrap: false,
                writeReadinessSettleMs: 100,
            } as any);
            await fs.writeFile("/f-5.txt", "content 5");
            await waitUntil(async () => {
                expect((await fsB.list("/")).length).toBe(6);
            });
            // The injected clock is intentionally manual in this suite;
            // advance it past the quiet window after B has seen the write.
            fakeNow += 1_000;
            await fsB.awaitWriteReady({ timeout: DEFAULT_WAIT_MS });

            // Same document set on both sides: B's snapshot dedups to the
            // very cids A published.
            await fs.snapshotWrite();
            const genA1 = new Set(await manifestCids());
            await waitUntil(async () => {
                // B must hold A's manifest doc before publishing its own.
                const doc = await (fsB.program as any).getDocument(
                    `bootstrap:${(fs.program as any).authorKey()}`
                );
                expect(doc).toBeDefined();
            });
            await fsB.snapshotWrite();
            const genB = new Set(
                (await loadLedger(fsB.program)).current?.cids.map(
                    (c: any) => c.cid
                ) ?? []
            );
            const overlap = [...genA1].filter((cid) => genB.has(cid));
            expect(overlap.length).toBeGreaterThan(0);

            // A supersedes its generation; B's manifest (replicated to A)
            // still references the shared cids — A's reap must keep every
            // one of them and ledger them for retry.
            await waitUntil(async () => {
                const rows = (await fs.program.entries.index
                    .iterate(
                        { query: { kind: "bootstrap-manifest" } },
                        { local: true, remote: false, resolve: false }
                    )
                    .all()) as any[];
                expect(rows.length).toBe(2);
            });
            await fs.writeFile("/f-0.txt", "superseded");
            fakeNow += 1_000;
            await fs.snapshotWrite();
            const genA2 = new Set(await manifestCids());

            await reap(fakeNow + 24 * HOUR_MS);
            for (const cid of overlap) {
                expect(await blocks().has(cid)).toBe(true);
            }
            const ledger = await loadLedger();
            const stillLedgered = new Set(
                ledger.retired.flatMap((g: any) =>
                    g.cids.map((c: any) => c.cid)
                )
            );
            for (const cid of overlap) {
                if (!genA2.has(cid)) {
                    expect(stillLedgered.has(cid)).toBe(true);
                }
            }
        } finally {
            await peerB.stop();
        }
    });
});
