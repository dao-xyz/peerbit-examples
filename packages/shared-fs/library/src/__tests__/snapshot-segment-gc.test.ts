import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";

const HOUR_MS = 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
        ((await (program as any).loadSegmentLedgerForTest?.()) ??
            (await loadLedger(program))).current?.cids.map(
            (c: any) => c.cid
        ) ?? [];
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

    it("records intent before any throw and protects the live old generation", async () => {
        await seedFiles(6);
        await fs.snapshotWrite();
        const gen1 = new Set(await manifestCids());

        // Two consecutive failing publishes (thrown after intent, like the
        // payload-cap check): every attempt's delta must still be
        // ledgered, and the LIVE manifest's cids must survive any reap.
        const program: any = fs.program;
        const original = program.putPreferLinked.bind(program);
        let failures = 0;
        program.putPreferLinked = async (value: any) => {
            if (
                failures < 2 &&
                typeof value?.id === "string" &&
                value.id.startsWith("bootstrap:")
            ) {
                failures++;
                throw new Error("injected publish failure");
            }
            return original(value);
        };
        await fs.writeFile("/f-0.txt", "attempt one");
        fakeNow += 1_000;
        await expect(fs.snapshotWrite()).rejects.toThrow(/injected/);
        await fs.writeFile("/f-1.txt", "attempt two");
        fakeNow += 1_000;
        await expect(fs.snapshotWrite()).rejects.toThrow(/injected/);

        // No unrecorded strays: everything the failed attempts put is in
        // the ledger (current or retired).
        const ledger = await loadLedger();
        const recorded = new Set([
            ...(ledger.current?.cids ?? []).map((c: any) => c.cid),
            ...ledger.retired.flatMap((g: any) =>
                g.cids.map((c: any) => c.cid)
            ),
        ]);
        expect(recorded.size).toBeGreaterThan(0);

        // A reap far past grace must keep every cid of the still-live
        // (old) manifest doc, no matter how mangled `current` became.
        await reap(fakeNow + 24 * HOUR_MS);
        for (const cid of gen1) {
            expect(await blocks().has(cid)).toBe(true);
        }

        // The next successful publish supersedes; the stranded deltas flow
        // into retired and a later reap clears them.
        fakeNow += 1_000;
        await fs.snapshotWrite();
        const gen3 = new Set(await manifestCids());
        await reap(fakeNow + 24 * HOUR_MS);
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
        await seedFiles(6);
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
            });
            await waitUntil(async () => {
                expect((await fsB.list("/")).length).toBe(6);
            });

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
