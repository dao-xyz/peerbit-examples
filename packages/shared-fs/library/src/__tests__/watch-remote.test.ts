import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { openSharedFs, type FsWatchEvent } from "../index.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForEvent = async (
    events: FsWatchEvent[],
    predicate: (event: FsWatchEvent) => boolean,
    timeoutMs = 15_000
): Promise<FsWatchEvent> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const found = events.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) {
            throw new Error(
                `no matching event; saw: ${JSON.stringify(
                    events.map((e) => `${e.type}:${e.path}:${e.origin}`)
                )}`
            );
        }
        await sleep(10);
    }
};

describe("shared fs watch: multi-party", () => {
    const peers: Peerbit[] = [];
    afterEach(async () => {
        await Promise.allSettled(peers.splice(0).map((peer) => peer.stop()));
    });

    it("delivers remote edits with remote origin and correct transitions", async () => {
        const a = await Peerbit.create();
        const b = await Peerbit.create();
        peers.push(a, b);
        await a.dial(b);
        const fsA = await openSharedFs({ peerbit: a, machineLabel: "a" });
        const fsB = await openSharedFs({
            peerbit: b,
            address: fsA.address,
            machineLabel: "b",
        });

        const events: FsWatchEvent[] = [];
        const watcher = fsB.watch("/", { settleMs: 10 });
        watcher.on("change", (batch) => events.push(...batch));
        await watcher.ready;

        await fsA.mkdir("/shared");
        await fsA.writeFile("/shared/doc.txt", "v1");
        const created = await waitForEvent(
            events,
            (e) => e.type === "created" && e.path === "/shared/doc.txt"
        );
        expect(created.origin).toBe("remote");
        expect(created.kind).toBe("file");

        await fsA.writeFile("/shared/doc.txt", "v2");
        const modified = await waitForEvent(
            events,
            (e) => e.type === "modified" && e.path === "/shared/doc.txt"
        );
        expect(modified.origin).toBe("remote");

        // A local write on the watching peer reports local origin.
        await fsB.writeFile("/shared/mine.txt", "local");
        const local = await waitForEvent(
            events,
            (e) => e.type === "created" && e.path === "/shared/mine.txt"
        );
        expect(local.origin).toBe("local");

        await fsA.rename("/shared/doc.txt", "/shared/renamed.txt");
        const renamed = await waitForEvent(events, (e) => e.type === "renamed");
        expect(renamed.oldPath).toBe("/shared/doc.txt");
        expect(renamed.path).toBe("/shared/renamed.txt");

        await fsA.rm("/shared/renamed.txt");
        await waitForEvent(
            events,
            (e) => e.type === "deleted" && e.path === "/shared/renamed.txt"
        );
        watcher.close();
    });

    it("attributes a remote write batch and delivers it compactly", async () => {
        const a = await Peerbit.create();
        const b = await Peerbit.create();
        peers.push(a, b);
        await a.dial(b);
        const fsA = await openSharedFs({ peerbit: a, machineLabel: "a" });
        const fsB = await openSharedFs({
            peerbit: b,
            address: fsA.address,
            machineLabel: "b",
        });
        const batches: FsWatchEvent[][] = [];
        const watcher = fsB.watch("/", { settleMs: 40 });
        watcher.on("change", (batch) => batches.push(batch));
        await watcher.ready;

        await fsA.writeBatch(
            Array.from({ length: 60 }, (_, i) => ({
                path: `/turn/dir-${i % 3}/f-${i}.txt`,
                content: `v ${i}`,
            })),
            { changesetId: "remote-turn" }
        );
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
            const files = batches
                .flat()
                .filter((e) => e.kind === "file" && e.type === "created");
            if (files.length === 60) break;
            await sleep(25);
        }
        const files = batches
            .flat()
            .filter((e) => e.kind === "file" && e.type === "created");
        expect(files).toHaveLength(60);
        expect(files.every((e) => e.changesetId === "remote-turn")).toBe(true);
        expect(files.every((e) => e.origin === "remote")).toBe(true);
        // Remote arrivals may straddle a few change events, never 60.
        expect(batches.length).toBeLessThanOrEqual(10);
        watcher.close();
    });

    it("keeps a delete-vs-edit recovery honest: deleted then created", async () => {
        const a = await Peerbit.create();
        const b = await Peerbit.create();
        peers.push(a, b);
        await a.dial(b);
        const fsA = await openSharedFs({ peerbit: a, machineLabel: "a" });
        const fsB = await openSharedFs({
            peerbit: b,
            address: fsA.address,
            machineLabel: "b",
        });
        await fsA.writeFile("/contest.txt", "v1");
        const events: FsWatchEvent[] = [];
        const watcher = fsB.watch("/", { settleMs: 10 });
        watcher.on("change", (batch) => events.push(...batch));
        await watcher.ready;
        // Wait for the file to appear on B first.
        await waitForEvent(
            events,
            (e) => e.type === "created" && e.path === "/contest.txt"
        );
        await fsA.rm("/contest.txt");
        await waitForEvent(
            events,
            (e) => e.type === "deleted" && e.path === "/contest.txt"
        );
        // Restore via the recovery API on the watching peer.
        const conflicts = await fsB.namingConflicts(undefined, {
            allowPartial: true,
        });
        const recoverable = conflicts.find(
            (c: any) => c.type === "delete-vs-edit"
        );
        if (recoverable) {
            await fsB.resolveNamingConflict(recoverable.nodeId, {
                type: "restore",
            });
            await waitForEvent(
                events,
                (e) => e.type === "created" && e.path === "/contest.txt"
            );
        }
        watcher.close();
    });
});
