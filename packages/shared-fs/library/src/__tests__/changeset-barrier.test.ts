import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("shared fs changeset barrier", () => {
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

    const open = async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        return openSharedFs({ peerbit: peer, machineLabel: "cb" });
    };

    const pair = async (): Promise<[SharedFsHandle, SharedFsHandle]> => {
        const a = await Peerbit.create();
        const b = await Peerbit.create();
        peers.push(a, b);
        await a.dial(b);
        const fsA = await openSharedFs({ peerbit: a, machineLabel: "writer" });
        const fsB = await openSharedFs({
            peerbit: b,
            address: fsA.address,
            machineLabel: "reader",
        });
        return [fsA, fsB];
    };

    it("write -> local barrier completes with exact membership (A1)", async () => {
        const fs = await open();
        const result = await fs.writeBatch(
            [
                { path: "/turn/a.txt", content: "one" },
                { path: "/turn/sub/b.txt", content: "two" },
                { path: "/turn/c.txt", content: "three" },
            ],
            { changesetId: "turn-1", manifest: true }
        );
        expect(result.manifest).toBeDefined();
        // Members: 3 versions + naming (2 dirs + 3 creates) = 8.
        expect(result.manifest!.memberCount).toBe(8);
        const status = await fs.awaitChangeset("turn-1", {
            manifestId: result.manifest!.manifestId,
        });
        expect(status.complete).toBe(true);
        expect(status.verdict).toBe("complete");
        expect(status.expected).toBe(8);
        expect(status.arrived).toBe(8);
        expect(status.manifests[0].authorKey).toBeDefined();
    });

    it("remote barrier completes only when the whole turn arrived, then reads see it (R1)", async () => {
        const [fsA, fsB] = await pair();
        const result = await fsA.writeBatch(
            Array.from({ length: 40 }, (_, i) => ({
                path: `/t/d-${i % 4}/f-${i}.txt`,
                content: `payload ${i}`,
            })),
            { changesetId: "remote-turn", manifest: true }
        );
        const status = await fsB.awaitChangeset("remote-turn", {
            manifestId: result.manifest!.manifestId,
            timeoutMs: 30_000,
        });
        expect(status.complete).toBe(true);
        // The completed barrier promises the metadata is readable NOW.
        const listed = await fsB.list("/t");
        expect(listed).toHaveLength(4);
        let files = 0;
        for (const dir of listed) files += (await fsB.list(dir.path)).length;
        expect(files).toBe(40);
        expect(decode(await fsB.readFile("/t/d-1/f-1.txt"))).toBe("payload 1");
    });

    it("deletes are members: a turn ending in deletes is gated on tombstones (B10)", async () => {
        const [fsA, fsB] = await pair();
        await fsA.writeBatch([
            { path: "/keep.txt", content: "k" },
            { path: "/gone.txt", content: "g" },
        ]);
        // Wait for the reader to see the first batch.
        const first = Date.now();
        for (;;) {
            if (decode(await fsB.readFile("/gone.txt").catch(() => undefined)))
                break;
            if (Date.now() - first > 20_000) throw new Error("no sync");
            await sleep(20);
        }
        const result = await fsA.writeBatch(
            [
                { path: "/keep.txt", content: "k2" },
                { path: "/gone.txt", delete: true },
            ],
            { changesetId: "del-turn", manifest: true }
        );
        // 1 version + 1 tombstone + the edited file's adopted naming
        // winner (adoption closure: an edit's visibility needs its naming
        // event, so a reordered replica cannot certify an invisible file).
        expect(result.manifest!.memberCount).toBe(3);
        const status = await fsB.awaitChangeset("del-turn", {
            manifestId: result.manifest!.manifestId,
        });
        expect(status.complete).toBe(true);
        expect(await fsB.readFile("/gone.txt").catch(() => undefined)).toBe(
            undefined
        );
        expect(decode(await fsB.readFile("/keep.txt"))).toBe("k2");
    });

    it("a zero-member manifest completes immediately and certifies nothing prior (B9/A4)", async () => {
        const fs = await open();
        const result = await fs.writeBatch([], {
            changesetId: "empty-turn",
            manifest: true,
        });
        expect(result.manifest!.memberCount).toBe(0);
        const status = await fs.awaitChangeset("empty-turn");
        expect(status.complete).toBe(true);
        expect(status.expected).toBe(0);
    });

    it("changesetId reuse spans manifests with union semantics (B4/A3)", async () => {
        const fs = await open();
        const first = await fs.writeBatch(
            [{ path: "/u/one.txt", content: "1" }],
            { changesetId: "reused", manifest: true }
        );
        const second = await fs.writeBatch(
            [{ path: "/u/two.txt", content: "2" }],
            { changesetId: "reused", manifest: true }
        );
        expect(first.manifest!.manifestId).not.toBe(
            second.manifest!.manifestId
        );
        const status = await fs.awaitChangeset("reused");
        expect(status.complete).toBe(true);
        expect(status.manifests).toHaveLength(2);
        // Scoped to either single manifest also completes.
        const scoped = await fs.awaitChangeset("reused", {
            manifestId: first.manifest!.manifestId,
        });
        expect(scoped.complete).toBe(true);
    });

    it("a same-id retry whose writes all no-op adopts the real turn's documents (A5/B11)", async () => {
        const fs = await open();
        const run1 = await fs.writeBatch(
            [
                { path: "/r/x.txt", content: "same" },
                { path: "/r/sub/y.txt", content: "other" },
            ],
            { changesetId: "retry-turn", manifest: true }
        );
        // Retry the identical batch under the SAME changesetId: every write
        // no-ops, but the manifest must adopt run 1's documents rather than
        // certify an empty turn.
        const run2 = await fs.writeBatch(
            [
                { path: "/r/x.txt", content: "same" },
                { path: "/r/sub/y.txt", content: "other" },
            ],
            { changesetId: "retry-turn", manifest: true }
        );
        expect(run2.manifest!.memberCount).toBeGreaterThan(0);
        const scoped = await fs.awaitChangeset("retry-turn", {
            manifestId: run2.manifest!.manifestId,
        });
        expect(scoped.complete).toBe(true);
        // The retry manifest's membership covers run 1's version + naming
        // (2 versions + 2 creates + 2 dirs = same count as run 1).
        expect(run2.manifest!.memberCount).toBe(run1.manifest!.memberCount);
    });

    it("a repeated manifested delete adopts its young tombstone", async () => {
        const fs = await open();
        await fs.writeFile("/delete-retry.txt", "gone");
        const run1 = await fs.writeBatch(
            [{ path: "/delete-retry.txt", delete: true }],
            { changesetId: "delete-retry", manifest: true }
        );
        expect(run1.manifest!.memberCount).toBe(1);

        // The path is already absent, so this exercises youngTombstoneAt's
        // exact-slot history lookup instead of publishing another deletion.
        const run2 = await fs.writeBatch(
            [{ path: "/delete-retry.txt", delete: true }],
            { changesetId: "delete-retry", manifest: true }
        );
        expect(run2.manifest!.memberCount).toBe(run1.manifest!.memberCount);
        const scoped = await fs.awaitChangeset("delete-retry", {
            manifestId: run2.manifest!.manifestId,
        });
        expect(scoped.complete).toBe(true);
        expect(scoped.expected).toBe(1);
        expect(await fs.stat("/delete-retry.txt")).toBeUndefined();
    });

    it("an unknown changeset times out honestly with status attached (B5-wedge)", async () => {
        const fs = await open();
        const start = Date.now();
        try {
            await fs.awaitChangeset("never-existed", { timeoutMs: 500 });
            expect.unreachable("should have timed out");
        } catch (error: any) {
            expect(error.code).toBe("ETIMEDOUT");
            expect(error.status).toBeDefined();
            expect(error.status.verdict).toBe("unknown");
        }
        expect(Date.now() - start).toBeLessThan(5_000);
    });

    it("watchChangesets sees the manifest and the completion (W1)", async () => {
        const [fsA, fsB] = await pair();
        const events: any[] = [];
        const watcher = fsB.watchChangesets();
        watcher.on("change", (batch: any[]) => events.push(...batch));
        const result = await fsA.writeBatch(
            [{ path: "/w/seen.txt", content: "v" }],
            { changesetId: "watched-turn", manifest: true }
        );
        const deadline = Date.now() + 20_000;
        while (
            !events.some(
                (e) => e.type === "complete" && e.changesetId === "watched-turn"
            ) &&
            Date.now() < deadline
        ) {
            await sleep(20);
        }
        const completes = events.filter(
            (e) => e.type === "complete" && e.changesetId === "watched-turn"
        );
        expect(completes).toHaveLength(1);
        expect(completes[0].status.complete).toBe(true);
        expect(
            events.some(
                (e) =>
                    e.type === "manifest" &&
                    e.manifest.manifestId === result.manifest!.manifestId
            )
        ).toBe(true);
        watcher.close();
    });

    it("close() rejects pending waiters with ECLOSED (C7)", async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        const fs = await openSharedFs({ peerbit: peer, machineLabel: "c" });
        const pending = fs.awaitChangeset("never-arrives", {
            timeoutMs: 60_000,
        });
        const guard = pending.catch((error: any) => error);
        await sleep(100);
        await peer.stop();
        const error = await guard;
        expect(error.code).toBe("ECLOSED");
    });
});
