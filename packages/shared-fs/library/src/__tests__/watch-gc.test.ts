import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    openSharedFs,
    type FsWatchEvent,
    type SharedFsHandle,
} from "../index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("shared fs watch: gc and history retirement", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;
    let fakeNow: number;

    beforeEach(async () => {
        fakeNow = Date.now();
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "gc-watch",
            clock: () => fakeNow,
        });
    });

    afterEach(async () => {
        try {
            await peer.stop();
        } catch {
            /* close races are benign here */
        }
    });

    it("a full GC run over deep history emits zero watch events", async () => {
        // Build churn: files with many versions, plus deleted files.
        await fs.mkdir("/work");
        for (let i = 0; i < 8; i++) {
            for (let round = 0; round < 6; round++) {
                await fs.writeFile(
                    `/work/f-${i}.txt`,
                    `round ${round} of ${i}`
                );
            }
        }
        await fs.writeFile("/work/doomed.txt", "temporary");
        await fs.rm("/work/doomed.txt");

        const events: FsWatchEvent[] = [];
        const watcher = fs.watch("/", { settleMs: 5, guardHoldMs: 100 });
        watcher.on("change", (batch) => events.push(...batch));
        await watcher.ready;

        // Age everything past every window, then run the two-pass GC.
        fakeNow += 40 * DAY_MS;
        await fs.collectGarbage({
            settleMs: 0,
            chunkSweep: "immediate",
            nowMs: fakeNow,
        });
        fakeNow += 2 * 60 * 60 * 1000;
        await fs.collectGarbage({
            settleMs: 0,
            chunkSweep: "immediate",
            nowMs: fakeNow,
        });

        // Give the removal-only settle window plus quarantine time to pass:
        // retirement of non-winning history must never surface as events.
        await sleep(800);
        expect(events.map((e) => `${e.type}:${e.path}`)).toEqual([]);

        // The served view is intact and the watcher still works.
        const listed = await fs.list("/work");
        expect(listed).toHaveLength(8);
        await fs.writeFile("/work/after-gc.txt", "still live");
        const deadline = Date.now() + 5_000;
        while (
            !events.some((e) => e.path === "/work/after-gc.txt") &&
            Date.now() < deadline
        ) {
            await sleep(10);
        }
        expect(
            events.some(
                (e) => e.type === "created" && e.path === "/work/after-gc.txt"
            )
        ).toBe(true);
        watcher.close();
    });

    it("an explicit delete during heavy version churn emits exactly once", async () => {
        await fs.mkdir("/mix");
        await fs.writeFile("/mix/hot.txt", "v0");
        const events: FsWatchEvent[] = [];
        const watcher = fs.watch("/mix", { settleMs: 10, guardHoldMs: 100 });
        watcher.on("change", (batch) => events.push(...batch));
        await watcher.ready;
        for (let i = 1; i <= 20; i++) {
            await fs.writeFile("/mix/hot.txt", `v${i}`);
        }
        await fs.rm("/mix/hot.txt");
        await sleep(600);
        const deletes = events.filter(
            (e) => e.type === "deleted" && e.path === "/mix/hot.txt"
        );
        expect(deletes).toHaveLength(1);
        // A user delete is an ADDED tombstone — it must not wait out the
        // removal quarantine (fast path).
        watcher.close();
    });
});
