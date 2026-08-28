import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    DEFAULT_FILE_CHUNK_SIZE,
    openSharedFs,
    type SharedFsHandle,
} from "../index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const patternedBytes = (size: number, seed = 0) => {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < bytes.byteLength; i++) {
        bytes[i] = (i + seed) % 251;
    }
    return bytes;
};

const waitUntil = async (
    assertion: () => Promise<void> | void,
    options: { timeoutMs?: number; intervalMs?: number } = {}
) => {
    const timeoutMs = options.timeoutMs ?? 20_000;
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

describe("shared fs garbage collection", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;
    /** Injected clock; tests advance it to age documents past GC windows. */
    let fakeNow: number;

    const countRows = async (kind: string) =>
        (
            await fs.program.entries.index
                .iterate(
                    { query: { kind } },
                    { local: true, remote: false, resolve: false }
                )
                .all()
        ).length;

    /** Fast-path GC config: no settling, immediate chunk sweep. */
    const fastGc = (overrides: Record<string, unknown> = {}) =>
        fs.collectGarbage({
            settleMs: 0,
            chunkSweep: "immediate",
            nowMs: fakeNow,
            ...overrides,
        });

    beforeEach(async () => {
        fakeNow = Date.now();
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "gc-test",
            clock: () => fakeNow,
        });
    });

    afterEach(async () => {
        try {
            await peer.stop();
        } catch (error) {
            if (
                !(
                    error instanceof TypeError &&
                    error.message.includes("clearAll")
                )
            ) {
                throw error;
            }
        }
    });

    it("requires a full replica", async () => {
        const observer = await Peerbit.create();
        try {
            const partial = await openSharedFs({
                peerbit: observer,
                machineLabel: "observer",
                replicate: false,
            });
            await expect(partial.collectGarbage()).rejects.toThrow(
                /full replica/
            );
        } finally {
            await observer.stop().catch(() => {});
        }
    });

    it("retires superseded versions and reclaims their chunks, keeping the file readable", async () => {
        // 15 distinct saves of a multi-chunk file: each version has unique
        // content so old chunks become orphans once versions retire.
        for (let i = 0; i < 15; i++) {
            await fs.writeFile(
                "/doc.bin",
                patternedBytes(DEFAULT_FILE_CHUNK_SIZE + 17, i)
            );
        }
        const versionsBefore = await countRows("file-version");
        const chunksBefore = await countRows("file-chunk");
        expect(versionsBefore).toBe(15);
        expect(chunksBefore).toBeGreaterThanOrEqual(15);

        // Nothing is old enough yet: GC must be a strict no-op.
        const noop = await fastGc();
        expect(noop.retiredVersions).toBe(0);
        expect(noop.deletedChunks).toBe(0);

        // A month later the history is stale; keepVersions=3 bounds it.
        fakeNow += 40 * DAY_MS;
        const report = await fastGc({ keepVersions: 3 });
        expect(report.retiredVersions).toBeGreaterThan(0);
        expect(report.deletedChunks).toBeGreaterThan(0);
        expect(report.reclaimedChunkBytes).toBeGreaterThan(0n);
        expect(await countRows("file-version")).toBe(
            versionsBefore - report.retiredVersions
        );
        expect(await countRows("file-chunk")).toBe(
            chunksBefore - report.deletedChunks
        );

        // The visible head (and its bytes) are untouched.
        expect(
            (await fs.readFile("/doc.bin"))?.length ===
                DEFAULT_FILE_CHUNK_SIZE + 17
        ).toBe(true);
        expect(decode(await fs.readFile("/doc.bin"))).toBe(
            decode(patternedBytes(DEFAULT_FILE_CHUNK_SIZE + 17, 14))
        );
    });

    it("never retires the newest keepVersions or anything younger than retention", async () => {
        for (let i = 0; i < 8; i++) {
            await fs.writeFile("/kept.txt", `revision ${i}`);
        }
        fakeNow += 40 * DAY_MS;
        // One fresh save after the jump: it and its ancestors' keep rules
        // still apply.
        await fs.writeFile("/kept.txt", "fresh revision");
        const report = await fastGc({ keepVersions: 4 });
        const versions = await fs.versions("/kept.txt");
        expect(versions.length).toBeGreaterThanOrEqual(4);
        expect(versions[0].id).toBeDefined();
        expect(decode(await fs.readFile("/kept.txt"))).toBe("fresh revision");
        expect(report.warnings.filter((w) => w.includes("damaged"))).toEqual(
            []
        );
    });

    it("compacts naming histories without changing winners", async () => {
        await fs.writeFile("/wander.txt", "content");
        for (let i = 0; i < 20; i++) {
            await fs.rename(
                i === 0 ? "/wander.txt" : `/wander-${i - 1}.txt`,
                `/wander-${i}.txt`
            );
        }
        const namingBefore = await countRows("naming");
        expect(namingBefore).toBeGreaterThanOrEqual(21);

        fakeNow += 40 * DAY_MS;
        const report = await fastGc();
        expect(report.compactedNamingEvents).toBeGreaterThan(0);
        expect(await countRows("naming")).toBe(
            namingBefore - report.compactedNamingEvents
        );
        // The compacted node resolves to the same place with the same bytes.
        expect(decode(await fs.readFile("/wander-19.txt"))).toBe("content");
        expect((await fs.list("/")).map((entry) => entry.name)).toEqual([
            "wander-19.txt",
        ]);
        expect(await fs.namingConflicts()).toEqual([]);
    });

    it("uses a two-run ledger barrier by default: records first, reclaims on the next run", async () => {
        await fs.writeFile("/twice.bin", patternedBytes(2048, 1));
        await fs.writeFile("/twice.bin", patternedBytes(2048, 2));
        fakeNow += 40 * DAY_MS;

        const first = await fs.collectGarbage({
            settleMs: 0,
            keepVersions: 1,
            minOrphanSpanMs: 60_000,
            nowMs: fakeNow,
        });
        expect(first.retiredVersions).toBe(1);
        expect(first.deletedChunks).toBe(0);
        expect(first.chunkCandidatesRecorded).toBeGreaterThan(0);

        // Before the span elapses a rerun still refuses to sweep.
        const early = await fs.collectGarbage({
            settleMs: 0,
            keepVersions: 1,
            minOrphanSpanMs: 60_000,
            nowMs: fakeNow + 1_000,
        });
        expect(early.deletedChunks).toBe(0);

        const second = await fs.collectGarbage({
            settleMs: 0,
            keepVersions: 1,
            minOrphanSpanMs: 60_000,
            nowMs: fakeNow + 120_000,
        });
        expect(second.deletedChunks).toBeGreaterThan(0);
        expect(decode(await fs.readFile("/twice.bin"))).toBe(
            decode(patternedBytes(2048, 2))
        );
    });

    it("purges deleted nodes after the barrier and keeps the tombstone sticky", async () => {
        await fs.writeFile("/gone.bin", patternedBytes(4096, 9));
        await fs.rm("/gone.bin");
        expect(await fs.stat("/gone.bin")).toBeUndefined();
        fakeNow += 40 * DAY_MS;

        const first = await fastGc({
            minOrphanSpanMs: 60_000,
            chunkSweep: "ledger",
        });
        expect(first.purgeCandidatesRecorded).toBe(1);
        expect(first.purgedNodes).toBe(0);

        fakeNow += 120_000;
        const second = await fastGc({
            minOrphanSpanMs: 60_000,
            chunkSweep: "ledger",
        });
        expect(second.purgedNodes).toBe(1);

        // Content is gone for good...
        fakeNow += 120_000;
        await fastGc({ minOrphanSpanMs: 60_000, chunkSweep: "ledger" });
        expect(await countRows("file-version")).toBe(0);
        // ...the deletion tombstone survives (deletion stays sticky), and a
        // restore now fails loudly instead of resurrecting a ghost.
        expect(await countRows("naming")).toBeGreaterThan(0);
        const conflicts = await fs.namingConflicts();
        expect(conflicts).toEqual([]);
        const nodeRows = (await fs.program.entries.index
            .iterate(
                { query: { kind: "naming" } },
                { local: true, remote: false, resolve: true }
            )
            .all()) as any[];
        const nodeId = nodeRows[0].nodeId as string;
        await expect(
            fs.resolveNamingConflict(nodeId, { type: "restore" })
        ).rejects.toThrow(/no recoverable content survives/);
    });

    it("restore before purge carries content and survives a subsequent sweep", async () => {
        await fs.writeFile("/phoenix.txt", "rise again");
        await fs.rm("/phoenix.txt");
        const nodeRows = (await fs.program.entries.index
            .iterate(
                { query: { kind: "naming" } },
                { local: true, remote: false, resolve: true }
            )
            .all()) as any[];
        const nodeId = nodeRows.find((row) =>
            (row.nodeId as string).startsWith("file:")
        )!.nodeId as string;

        await fs.resolveNamingConflict(nodeId, { type: "restore" });
        expect(decode(await fs.readFile("/phoenix.txt"))).toBe("rise again");

        // The restore minted a fresh version reference, so even an aggressive
        // sweep long after keeps the content alive.
        fakeNow += 40 * DAY_MS;
        await fastGc({ keepVersions: 1 });
        expect(decode(await fs.readFile("/phoenix.txt"))).toBe("rise again");
    });

    it("Guard D resurrects a chunk that is still referenced by a live version", async () => {
        await fs.writeFile("/guarded.bin", patternedBytes(1024, 3));
        const chunkRows = (await fs.program.entries.index
            .iterate(
                { query: { kind: "file-chunk" } },
                { local: true, remote: false, resolve: false }
            )
            .all()) as any[];
        expect(chunkRows.length).toBe(1);
        const chunkId = chunkRows[0].id as string;

        // Simulate a misbehaving collector deleting a referenced chunk.
        await fs.program.entries.del(chunkId);
        await waitUntil(async () => {
            const back = await fs.program.entries.index.get(chunkId, {
                local: true,
                remote: false,
                resolve: false,
            } as any);
            expect(back != null).toBe(true);
        });
        expect(decode(await fs.readFile("/guarded.bin"))).toBe(
            decode(patternedBytes(1024, 3))
        );
    });

    it("Guard D resurrects a removed content head", async () => {
        await fs.writeFile("/headguard.txt", "only head");
        const versions = await fs.versions("/headguard.txt");
        expect(versions).toHaveLength(1);
        await fs.program.entries.del(versions[0].id);
        await waitUntil(async () => {
            expect(decode(await fs.readFile("/headguard.txt"))).toBe(
                "only head"
            );
        });
    });

    it("dryRun reports the plan without mutating anything", async () => {
        for (let i = 0; i < 6; i++) {
            await fs.writeFile("/dry.txt", `v${i}`);
        }
        fakeNow += 40 * DAY_MS;
        const versionsBefore = await countRows("file-version");
        const report = await fastGc({ keepVersions: 2, dryRun: true });
        expect(report.dryRun).toBe(true);
        expect(report.retiredVersions).toBeGreaterThan(0);
        expect(await countRows("file-version")).toBe(versionsBefore);
    });

    it("skips conflicted nodes' branch-exclusive history", async () => {
        await fs.writeFile("/branchy.txt", "base");
        const base = (await fs.versions("/branchy.txt"))
            .filter((version) => version.head)
            .map((version) => version.id);
        await fs.writeFile("/branchy.txt", "left", { baseVersionIds: base });
        await fs.writeFile("/branchy.txt", "right", { baseVersionIds: base });
        expect((await fs.conflicts("/branchy.txt")).length).toBe(1);

        fakeNow += 40 * DAY_MS;
        const report = await fastGc({ keepVersions: 1 });
        // Both conflict heads must survive any sweep; only the shared
        // ancestor (base) is ever eligible.
        const remaining = await fs.versions("/branchy.txt");
        const heads = remaining.filter((version) => version.head);
        expect(heads.length).toBe(2);
        expect(report.warnings.filter((w) => w.includes("damaged"))).toEqual(
            []
        );
    });
});

describe("shared fs garbage collection across peers", () => {
    const peers: Peerbit[] = [];

    afterEach(async () => {
        const stopping = peers.splice(0);
        await Promise.allSettled(
            stopping.map(async (peer) => {
                try {
                    await peer.stop();
                } catch {
                    /* known benign close races */
                }
            })
        );
    });

    it("a collector on one peer converges with a holder on another; data survives", async () => {
        let fakeNow = Date.now();
        const clock = () => fakeNow;
        const a = await Peerbit.create();
        const b = await Peerbit.create();
        peers.push(a, b);
        await a.dial(b);
        const fsA = await openSharedFs({
            peerbit: a,
            machineLabel: "collector",
            clock,
        });
        const fsB = await openSharedFs({
            peerbit: b,
            address: fsA.address,
            machineLabel: "holder",
            clock,
        });

        for (let i = 0; i < 10; i++) {
            await fsA.writeFile("/shared.bin", patternedBytes(2048, i));
        }
        await waitUntil(async () => {
            expect(decode(await fsB.readFile("/shared.bin"))).toBe(
                decode(patternedBytes(2048, 9))
            );
        });

        fakeNow += 40 * DAY_MS;
        const report = await fsA.collectGarbage({
            settleMs: 0,
            chunkSweep: "immediate",
            keepVersions: 2,
            nowMs: fakeNow,
        });
        expect(report.retiredVersions).toBeGreaterThan(0);

        // Deletions replicate; both peers converge to the same trimmed
        // history with the same readable content.
        await waitUntil(async () => {
            const versionsA = await fsA.versions("/shared.bin");
            const versionsB = await fsB.versions("/shared.bin");
            expect(versionsB.map((v) => v.id).sort()).toEqual(
                versionsA.map((v) => v.id).sort()
            );
        });
        expect(decode(await fsB.readFile("/shared.bin"))).toBe(
            decode(patternedBytes(2048, 9))
        );
        expect(decode(await fsA.readFile("/shared.bin"))).toBe(
            decode(patternedBytes(2048, 9))
        );
    });
});
