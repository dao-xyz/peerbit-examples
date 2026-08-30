import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { openSharedFs, type FsWatchEvent } from "../index.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("shared fs watch: write batches", () => {
    const peers: Peerbit[] = [];
    afterEach(async () => {
        await Promise.allSettled(peers.splice(0).map((peer) => peer.stop()));
    });

    const open = async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        return openSharedFs({ peerbit: peer, machineLabel: "b" });
    };

    it("coalesces a large write batch into one delivered batch with attribution", async () => {
        const fs = await open();
        const batches: FsWatchEvent[][] = [];
        const watcher = fs.watch("/", { settleMs: 30 });
        watcher.on("change", (batch) => batches.push(batch));
        await watcher.ready;

        const entries = Array.from({ length: 500 }, (_, i) => ({
            path: `/set/d-${i % 5}/f-${i}.txt`,
            content: `payload ${i}`,
        }));
        await fs.writeBatch(entries, { changesetId: "turn-42" });
        await sleep(400);

        const all = batches.flat();
        const fileCreates = all.filter(
            (e) => e.type === "created" && e.kind === "file"
        );
        expect(fileCreates).toHaveLength(500);
        // Per node at most one create/modify in the window.
        const perNode = new Map<string, number>();
        for (const e of all) {
            if (e.type === "created" || e.type === "modified") {
                perNode.set(e.nodeId, (perNode.get(e.nodeId) ?? 0) + 1);
            }
        }
        expect(Math.max(...perNode.values())).toBe(1);
        // Every file event carries the batch's changeset identity.
        expect(fileCreates.every((e) => e.changesetId === "turn-42")).toBe(
            true
        );
        // Directory parents precede their children within delivery order.
        const seen = new Set<string>(["/"]);
        for (const e of batches.flat()) {
            if (e.type !== "created") continue;
            const parent = e.path.slice(0, e.path.lastIndexOf("/")) || "/";
            expect(seen.has(parent)).toBe(true);
            seen.add(e.path);
        }
        // Default settle coalesces the whole batch into very few deliveries.
        expect(batches.length).toBeLessThanOrEqual(3);
        watcher.close();
    });

    it("nets create+delete within one window to nothing", async () => {
        const fs = await open();
        await fs.mkdir("/tmp");
        const batches: FsWatchEvent[][] = [];
        const watcher = fs.watch("/tmp", { settleMs: 120 });
        watcher.on("change", (batch) => batches.push(batch));
        await watcher.ready;
        await fs.writeFile("/tmp/scratch.txt", "x");
        await fs.rm("/tmp/scratch.txt");
        await sleep(500);
        expect(batches.flat()).toHaveLength(0);
        watcher.close();
    });

    it("orders replace-destination renames applyably", async () => {
        const fs = await open();
        await fs.mkdir("/r");
        await fs.writeFile("/r/a.txt", "a");
        await fs.writeFile("/r/b.txt", "b");
        const batches: FsWatchEvent[][] = [];
        const watcher = fs.watch("/r", { settleMs: 60 });
        watcher.on("change", (batch) => batches.push(batch));
        await watcher.ready;
        // b replaces a: delete a, then rename b -> a within one window.
        await fs.rm("/r/a.txt");
        await fs.rename("/r/b.txt", "/r/a.txt");
        await sleep(400);
        const all = batches.flat();
        // Sequential application to a path-keyed mirror must be valid:
        // the slot /r/a.txt is freed before it is re-occupied.
        const occupied = new Set(["/r/a.txt", "/r/b.txt"]);
        for (const e of all) {
            if (e.type === "deleted") {
                expect(occupied.has(e.path)).toBe(true);
                occupied.delete(e.path);
            } else if (e.type === "renamed") {
                expect(occupied.has(e.oldPath!)).toBe(true);
                expect(occupied.has(e.path)).toBe(false);
                occupied.delete(e.oldPath!);
                occupied.add(e.path);
            } else if (e.type === "created") {
                expect(occupied.has(e.path)).toBe(false);
                occupied.add(e.path);
            }
        }
        expect(occupied.has("/r/a.txt")).toBe(true);
        expect(occupied.has("/r/b.txt")).toBe(false);
        watcher.close();
    });

    it("settleMs:0 exposes the low-latency path", async () => {
        const fs = await open();
        const events: FsWatchEvent[] = [];
        const watcher = fs.watch("/", { settleMs: 0, maxSettleMs: 0 });
        watcher.on("change", (batch) => events.push(...batch));
        await watcher.ready;
        const start = performance.now();
        await fs.writeFile("/fast.txt", "v");
        const deadline = Date.now() + 5_000;
        while (
            !events.some((e) => e.path === "/fast.txt") &&
            Date.now() < deadline
        ) {
            await sleep(2);
        }
        const elapsed = performance.now() - start;
        expect(events.some((e) => e.path === "/fast.txt")).toBe(true);
        // Generous CI bound; locally this is single-digit ms over the write.
        expect(elapsed).toBeLessThan(1_000);
        watcher.close();
    });
});
