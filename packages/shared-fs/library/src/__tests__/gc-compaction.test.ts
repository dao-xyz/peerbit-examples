import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    openSharedFs,
    type FsWatchEvent,
    type SharedFsHandle,
} from "../index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

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

describe("naming compaction under stable heads", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;
    let fakeNow: number;

    const fastGc = (overrides: Record<string, unknown> = {}) =>
        fs.collectGarbage({
            settleMs: 0,
            chunkSweep: "immediate",
            nowMs: fakeNow,
            ...overrides,
        });

    const namingRows = async (program: any = fs.program) =>
        (await program.entries.index
            .iterate(
                { query: { kind: "naming" } },
                { local: true, remote: false, resolve: false }
            )
            .all()) as any[];

    beforeEach(async () => {
        fakeNow = Date.now();
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "gc-compaction",
            clock: () => fakeNow,
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        try {
            await peer.stop();
        } catch {
            /* close races are benign here */
        }
    });

    it("compacts history under a fresh but stable head (unstarving)", async () => {
        await fs.writeFile("/chain.txt", "v"); // E1
        fakeNow += 5 * DAY_MS;
        await fs.rename("/chain.txt", "/chain-b.txt"); // E2
        fakeNow += 15 * DAY_MS;
        await fs.rename("/chain-b.txt", "/chain-c.txt"); // E3, the head, 0d old
        expect((await namingRows()).length).toBe(3);

        // The head is fresh by author age. The retired every-head-fresh
        // rule starved this node forever; a huge stability window emulates
        // it and must still plan nothing (regression baseline).
        const starved = await fastGc({
            namingHeadStabilityMs: 3650 * DAY_MS,
        });
        expect(starved.compactedNamingEvents).toBe(0);

        // Default stability (1 h of local arrival): the head arrived long
        // ago relative to the aged run clock, so compaction proceeds and
        // retires exactly the >=14d ancestors.
        const report = await fastGc();
        expect(report.compactedNamingEvents).toBe(2);
        expect((await namingRows()).length).toBe(1);
        expect(decode(await fs.readFile("/chain-c.txt"))).toBe("v");
        expect(await fs.stat("/chain-b.txt")).toBeUndefined();
        expect(await fs.program.namingConflicts()).toHaveLength(0);
    });

    it("fixpoint un-retires the child-set of a young survivor", async () => {
        await fs.writeFile("/fx.txt", "v"); // E1
        await fs.rename("/fx.txt", "/fx-b.txt"); // E2
        await fs.rename("/fx-b.txt", "/fx-c.txt"); // E3
        await fs.rename("/fx-c.txt", "/fx-d.txt"); // E4, the head

        // Author stamps come from the wall clock, so re-stamp E2 as if its
        // author's clock ran 30 days ahead (createdAt is display/aging
        // data, never part of winner selection — same id, same DAG).
        const docs = (await fs.program.entries.index
            .iterate(
                { query: { kind: "naming" } },
                { local: true, remote: false }
            )
            .all()) as any[];
        const e2 = docs.find((doc) => Number(doc.causalDepth) === 2)!;
        e2.createdAt = BigInt(fakeNow + 30 * DAY_MS);
        await fs.program.entries.put(e2);

        fakeNow += 32 * DAY_MS;
        // Candidates are E1 and E3 (E2 is author-young, E4 is the head).
        // Retiring E3 would leave survivor E2 with every present child
        // gone — the fixpoint must un-retire it, leaving exactly E1.
        const report = await fastGc();
        expect(report.compactedNamingEvents).toBe(1);
        const rows = await namingRows();
        expect(rows.length).toBe(3);
        expect(decode(await fs.readFile("/fx-d.txt"))).toBe("v");
        expect(await fs.program.namingConflicts()).toHaveLength(0);
    });

    it("caps per-node compaction and drains the backlog across runs", async () => {
        await fs.writeFile("/cap-0.txt", "v");
        for (let i = 1; i < 30; i++) {
            await fs.rename(`/cap-${i - 1}.txt`, `/cap-${i}.txt`);
        }
        expect((await namingRows()).length).toBe(30);
        fakeNow += 40 * DAY_MS;

        const first = await fastGc({ namingCompactionBatchLimit: 10 });
        expect(first.compactedNamingEvents).toBe(10);
        expect(await fs.program.namingConflicts()).toHaveLength(0);

        let total = first.compactedNamingEvents;
        for (let round = 0; round < 5 && total < 29; round++) {
            const report = await fastGc({ namingCompactionBatchLimit: 10 });
            total += report.compactedNamingEvents;
        }
        expect(total).toBe(29);
        expect((await namingRows()).length).toBe(1);
        expect(decode(await fs.readFile("/cap-29.txt"))).toBe("v");
        expect(await fs.program.namingConflicts()).toHaveLength(0);
    });

    it("watchers stay silent through a naming compaction", async () => {
        await fs.writeFile("/w.txt", "v");
        fakeNow += 5 * DAY_MS;
        await fs.rename("/w.txt", "/w-b.txt");
        fakeNow += 15 * DAY_MS;
        await fs.rename("/w-b.txt", "/w-c.txt");

        const events: FsWatchEvent[] = [];
        const watcher = fs.watch("/", { settleMs: 5, guardHoldMs: 100 });
        watcher.on("change", (batch) => events.push(...batch));
        await watcher.ready;

        const report = await fastGc();
        expect(report.compactedNamingEvents).toBe(2);
        await sleep(700); // quarantine + guard windows
        expect(events).toEqual([]);
        watcher.close();
    });

    it("damper suppresses a reordered mid-chain resurrection but spares a lagging peer's deepest event", async () => {
        // Build a 10-event chain, then age everything.
        await fs.writeFile("/d-0.txt", "v");
        for (let i = 1; i < 10; i++) {
            await fs.rename(`/d-${i - 1}.txt`, `/d-${i}.txt`);
        }
        const byDepth = [...(await namingRows())].sort((a, b) =>
            Number(BigInt(a.causalDepth) - BigInt(b.causalDepth))
        );
        expect(byDepth.length).toBe(10);
        fakeNow += 20 * DAY_MS;

        // Simulate the split-flush reorder a compaction burst can produce
        // on a peer: deletes for E6..E9 land in one guard flush (the union
        // still has the single true head, so nothing re-puts) ...
        for (const row of byDepth.slice(5, 9)) {
            await fs.program.entries.del(row.id);
        }
        await waitUntil(async () => {
            expect((await namingRows()).length).toBe(6);
        });
        await sleep(600); // let that guard flush window close

        // ... then the delete of E5 arrives in a LATER flush. E5 is now a
        // union head (its child is already gone), and without the damper
        // Guard D would re-put it as a permanent spurious head. A present
        // strictly-deeper event (the true head) plus an old author stamp
        // suppress the re-put.
        await fs.program.entries.del(byDepth[4].id);
        await sleep(900);
        const after = await namingRows();
        expect(after.map((row) => row.id)).not.toContain(byDepth[4].id);
        expect(after.length).toBe(5);
        // Mid-burst the view may show a transient multi-head (E4 dangles
        // until its own delete arrives) — that is the designed wobble; the
        // winner is depth-based and stays correct throughout.
        expect(decode(await fs.readFile("/d-9.txt"))).toBe("v");

        // The trailing flush of the same burst deletes E1..E4; E4 is a
        // union head there too and must also be suppressed, converging the
        // peer to exactly the compacted state.
        for (const row of byDepth.slice(0, 4)) {
            await fs.program.entries.del(row.id);
        }
        await sleep(900);
        const converged = await namingRows();
        expect(converged.map((row) => row.id)).toEqual([byDepth[9].id]);
        expect(await fs.program.namingConflicts()).toHaveLength(0);
        expect(decode(await fs.readFile("/d-9.txt"))).toBe("v");

        // Counter-case: deleting the DEEPEST present event leaves nothing
        // deeper — a genuinely lagging peer must keep full Guard D
        // protection, old author stamp or not.
        await fs.program.entries.del(byDepth[9].id);
        await waitUntil(async () => {
            expect(decode(await fs.readFile("/d-9.txt"))).toBe("v");
            expect((await namingRows()).map((row) => row.id)).toContain(
                byDepth[9].id
            );
        });
    });

    it("a synced peer and a fresh joiner both converge on the compacted state", async () => {
        await fs.writeFile("/sync.txt", "v");
        fakeNow += 5 * DAY_MS;
        await fs.rename("/sync.txt", "/sync-b.txt");
        fakeNow += 15 * DAY_MS;
        await fs.rename("/sync-b.txt", "/sync-c.txt");
        const address = fs.program.address!.toString();

        const peerB = await Peerbit.create();
        let peerC: Peerbit | undefined;
        try {
            await peerB.dial(peer.getMultiaddrs());
            const fsB = await openSharedFs({
                peerbit: peerB,
                address,
                machineLabel: "gc-compaction-b",
                clock: () => fakeNow,
            });
            await waitUntil(async () => {
                expect((await namingRows(fsB.program)).length).toBe(3);
            });
            const putSpy = vi.spyOn(fsB.program.entries, "put" as any);

            const report = await fastGc();
            expect(report.compactedNamingEvents).toBe(2);

            // Deletions replicate; the synced peer trims without a single
            // guard re-put (silence) and keeps the same view.
            await waitUntil(async () => {
                expect((await namingRows(fsB.program)).length).toBe(1);
            });
            await sleep(700);
            expect((await namingRows(fsB.program)).length).toBe(1);
            expect(putSpy).not.toHaveBeenCalled();
            expect(decode(await fsB.readFile("/sync-c.txt"))).toBe("v");
            expect(await fsB.stat("/sync-b.txt")).toBeUndefined();

            // A fresh joiner sees only the compacted set: the stored
            // causalDepth on survivors must fully determine the winner.
            peerC = await Peerbit.create();
            await peerC.dial(peer.getMultiaddrs());
            const fsC = await openSharedFs({
                peerbit: peerC,
                address,
                machineLabel: "gc-compaction-c",
                clock: () => fakeNow,
            });
            await waitUntil(async () => {
                expect(decode(await fsC.readFile("/sync-c.txt"))).toBe("v");
            });
            expect(await fsC.program.namingConflicts()).toHaveLength(0);
        } finally {
            await peerB.stop();
            await peerC?.stop();
        }
    });
});
