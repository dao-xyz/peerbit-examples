import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    openSharedFs,
    type FsWatchEvent,
    type IgnoreAwareFs,
} from "../index.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (
    predicate: () => boolean,
    label: string,
    timeoutMs = 15_000
) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
        await sleep(15);
    }
};

describe("shared fs watch: ignore policy filtering", () => {
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

    it("filters events per handle policy; includeIgnored bypasses", async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        const fs = (await openSharedFs({
            peerbit: peer,
            machineLabel: "i",
            ignore: { patterns: ["dist/"] },
        })) as IgnoreAwareFs;

        const filtered: FsWatchEvent[] = [];
        const unfiltered: FsWatchEvent[] = [];
        const watcher = fs.watch("/", { settleMs: 5 });
        watcher.on("change", (batch) => filtered.push(...batch));
        const rawWatcher = fs.watch("/", { settleMs: 5, includeIgnored: true });
        rawWatcher.on("change", (batch) => unfiltered.push(...batch));
        await watcher.ready;
        await rawWatcher.ready;

        await fs.writeFile("/src.txt", "visible");
        // The policy blocks local writes into dist/, so simulate a remote
        // writer via a second policy-free handle on another peer.
        const remote = await Peerbit.create();
        peers.push(remote);
        await remote.dial(peer);
        const fsRemote = await openSharedFs({
            peerbit: remote,
            address: fs.address,
            machineLabel: "r",
        });
        await fsRemote.mkdir("/dist");
        await fsRemote.writeFile("/dist/out.js", "bundle");

        await waitFor(
            () => unfiltered.some((e) => e.path === "/dist/out.js"),
            "raw watcher sees ignored write"
        );
        await waitFor(
            () => filtered.some((e) => e.path === "/src.txt"),
            "filtered watcher sees visible write"
        );
        await sleep(200);
        expect(filtered.some((e) => e.path.startsWith("/dist"))).toBe(false);
        expect(unfiltered.some((e) => e.path === "/dist/out.js")).toBe(true);
        watcher.close();
        rawWatcher.close();
    });

    it("a rules-file change reconciles the stream with cause:policy", async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        const fs = (await openSharedFs({
            peerbit: peer,
            machineLabel: "p",
            ignore: {},
        })) as IgnoreAwareFs;

        await fs.mkdir("/logs");
        await fs.writeFile("/logs/app.log", "line");
        await fs.writeFile("/keep.txt", "keep");

        const events: FsWatchEvent[] = [];
        const watcher = fs.watch("/", { settleMs: 5 });
        watcher.on("change", (batch) => events.push(...batch));
        await watcher.ready;

        // Publish a rules file that newly ignores /logs.
        await fs.writeFile("/.artifactignore", "logs/\n");
        await waitFor(
            () =>
                events.some(
                    (e) =>
                        e.cause === "policy" &&
                        e.type === "deleted" &&
                        e.path === "/logs/app.log"
                ),
            "policy delete for newly ignored file",
            30_000
        );
        const policyDeletes = events.filter((e) => e.cause === "policy");
        expect(
            policyDeletes.some(
                (e) => e.type === "deleted" && e.path === "/logs"
            )
        ).toBe(true);
        // Un-ignore again: the entries come back as policy creates.
        const before = events.length;
        await fs.writeFile("/.artifactignore", "# nothing ignored\n");
        await waitFor(
            () =>
                events
                    .slice(before)
                    .some(
                        (e) =>
                            e.cause === "policy" &&
                            e.type === "created" &&
                            e.path === "/logs/app.log"
                    ),
            "policy create when un-ignored",
            30_000
        );
        watcher.close();
    });
});
