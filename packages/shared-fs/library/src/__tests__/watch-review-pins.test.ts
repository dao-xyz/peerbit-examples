import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { openSharedFs, type FsWatchEvent } from "../index.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Strict path-keyed mirror: applies the documented contract EXACTLY and
 *  throws on any precondition violation — the review's G1 oracle. */
class StrictMirror {
    entries = new Map<string, { nodeId: string; kind: string }>();

    apply(batch: FsWatchEvent[]) {
        for (const event of batch) {
            if (event.type === "created") {
                if (this.entries.has(event.path)) {
                    throw new Error(`create on occupied slot ${event.path}`);
                }
                this.entries.set(event.path, {
                    nodeId: event.nodeId,
                    kind: event.kind,
                });
            } else if (event.type === "modified") {
                this.entries.set(event.path, {
                    nodeId: event.nodeId,
                    kind: event.kind,
                });
            } else if (event.type === "deleted") {
                if (!this.entries.has(event.path)) {
                    throw new Error(`delete on empty slot ${event.path}`);
                }
                if (event.kind === "directory") {
                    const prefix = `${event.path}/`;
                    for (const key of [...this.entries.keys()]) {
                        if (key.startsWith(prefix)) this.entries.delete(key);
                    }
                }
                this.entries.delete(event.path);
            } else if (event.type === "renamed") {
                const moved = this.entries.get(event.oldPath!);
                if (!moved) {
                    throw new Error(
                        `rename from empty slot ${event.oldPath} -> ${event.path}`
                    );
                }
                if (this.entries.has(event.path)) {
                    throw new Error(`rename onto occupied slot ${event.path}`);
                }
                if (event.kind === "directory") {
                    const prefix = `${event.oldPath}/`;
                    for (const key of [...this.entries.keys()]) {
                        if (key.startsWith(prefix)) {
                            const entry = this.entries.get(key)!;
                            this.entries.delete(key);
                            this.entries.set(
                                event.path + key.slice(event.oldPath!.length),
                                entry
                            );
                        }
                    }
                }
                this.entries.delete(event.oldPath!);
                this.entries.set(event.path, moved);
            }
        }
    }
}

const mirrorEqualsList = async (mirror: StrictMirror, fs: any) => {
    const served = new Map<string, string>();
    const walk = async (dir: string) => {
        for (const entry of await fs.list(dir)) {
            served.set(entry.path, entry.kind);
            if (entry.kind === "directory") await walk(entry.path);
        }
    };
    await walk("/");
    const mirrored = new Map([...mirror.entries].map(([p, v]) => [p, v.kind]));
    expect(Object.fromEntries([...mirrored].sort())).toEqual(
        Object.fromEntries([...served].sort())
    );
};

describe("shared fs watch: review-pinned guarantees", () => {
    const peers: Peerbit[] = [];
    afterEach(async () => {
        await Promise.allSettled(peers.splice(0).map((peer) => peer.stop()));
    });

    const open = async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        return openSharedFs({ peerbit: peer, machineLabel: "pin" });
    };

    it("mv-out-then-rmdir in one window applies to a strict mirror (W1)", async () => {
        const fs = await open();
        await fs.mkdir("/d");
        await fs.mkdir("/x");
        await fs.writeFile("/d/f.txt", "escape me");
        const mirror = new StrictMirror();
        mirror.entries.set("/d", { nodeId: "?", kind: "directory" });
        mirror.entries.set("/x", { nodeId: "?", kind: "directory" });
        mirror.entries.set("/d/f.txt", { nodeId: "?", kind: "file" });
        const watcher = fs.watch("/", { settleMs: 60 });
        watcher.on("change", (batch) => mirror.apply(batch));
        await watcher.ready;
        await fs.rename("/d/f.txt", "/x/f.txt");
        await fs.rm("/d");
        await sleep(500);
        expect(mirror.entries.has("/x/f.txt")).toBe(true);
        expect(mirror.entries.has("/d")).toBe(false);
        await mirrorEqualsList(mirror, fs);
        watcher.close();
    });

    it("an A<->B swap in one window applies to a strict mirror (RL-1)", async () => {
        const fs = await open();
        await fs.mkdir("/s");
        await fs.writeFile("/s/a.txt", "A");
        await fs.writeFile("/s/b.txt", "B");
        const mirror = new StrictMirror();
        mirror.entries.set("/s", { nodeId: "?", kind: "directory" });
        mirror.entries.set("/s/a.txt", { nodeId: "?", kind: "file" });
        mirror.entries.set("/s/b.txt", { nodeId: "?", kind: "file" });
        const watcher = fs.watch("/", { settleMs: 80 });
        watcher.on("change", (batch) => mirror.apply(batch));
        await watcher.ready;
        await fs.rename("/s/a.txt", "/s/tmp.txt");
        await fs.rename("/s/b.txt", "/s/a.txt");
        await fs.rename("/s/tmp.txt", "/s/b.txt");
        await sleep(600);
        expect(mirror.entries.has("/s/a.txt")).toBe(true);
        expect(mirror.entries.has("/s/b.txt")).toBe(true);
        await mirrorEqualsList(mirror, fs);
        watcher.close();
    });

    it("a directory rename carries its subtree with no per-descendant events (W5)", async () => {
        const fs = await open();
        const events: FsWatchEvent[] = [];
        const watcher = fs.watch("/", { settleMs: 60 });
        watcher.on("change", (batch) => events.push(...batch));
        await watcher.ready;
        // Create the tree and rename its root within ONE settle window.
        await fs.mkdir("/old");
        await fs.writeFile("/old/deep.txt", "v");
        await fs.rename("/old", "/new");
        await sleep(500);
        const forFile = events.filter((e) => e.path.endsWith("deep.txt"));
        // The file appears exactly once (created, at whichever path won the
        // window) — never as a spurious renamed piggy-backing the ancestor.
        expect(forFile.filter((e) => e.type === "renamed")).toHaveLength(0);
        expect(forFile.filter((e) => e.type === "created")).toHaveLength(1);
        watcher.close();
    });

    it("ready settles when the watcher closes before the build commits (RL-9)", async () => {
        const fs = await open();
        const watcher = fs.watch("/");
        watcher.close();
        await expect(watcher.ready).rejects.toThrow();
    });
});
