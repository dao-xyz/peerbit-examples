import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    openSharedFs,
    type FsWatchEvent,
    type SharedFsHandle,
} from "../index.js";

const encode = (value: string) => new TextEncoder().encode(value);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until the collector holds an event matching the predicate. */
const waitForEvent = async (
    events: FsWatchEvent[],
    predicate: (event: FsWatchEvent) => boolean,
    timeoutMs = 10_000
): Promise<FsWatchEvent> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const found = events.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) {
            throw new Error(
                `no matching event; saw: ${JSON.stringify(
                    events.map((e) => `${e.type}:${e.path}`)
                )}`
            );
        }
        await sleep(10);
    }
};

/** A path-keyed mirror applying batches per the documented contract. */
class Mirror {
    entries = new Map<string, { nodeId: string; kind: string }>();

    apply(batch: FsWatchEvent[]) {
        for (const event of batch) {
            if (event.type === "created" || event.type === "modified") {
                this.entries.set(event.path, {
                    nodeId: event.nodeId,
                    kind: event.kind,
                });
            } else if (event.type === "deleted") {
                if (event.kind === "directory") {
                    const prefix = `${event.path}/`;
                    for (const key of [...this.entries.keys()]) {
                        if (key.startsWith(prefix)) this.entries.delete(key);
                    }
                }
                this.entries.delete(event.path);
            } else if (event.type === "renamed") {
                const moved = this.entries.get(event.oldPath!) ?? {
                    nodeId: event.nodeId,
                    kind: event.kind,
                };
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

const mirrorMatchesList = async (
    mirror: Mirror,
    fs: SharedFsHandle,
    root = "/"
) => {
    const served = new Map<string, string>();
    const walk = async (dir: string) => {
        for (const entry of await fs.list(dir)) {
            served.set(entry.path, entry.kind);
            if (entry.kind === "directory") await walk(entry.path);
        }
    };
    await walk(root);
    const mirrored = new Map([...mirror.entries].map(([p, v]) => [p, v.kind]));
    expect(Object.fromEntries([...mirrored].sort())).toEqual(
        Object.fromEntries([...served].sort())
    );
};

describe("shared fs watch: basics", () => {
    const peers: Peerbit[] = [];
    afterEach(async () => {
        await Promise.allSettled(peers.splice(0).map((peer) => peer.stop()));
    });

    const open = async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        const fs = await openSharedFs({ peerbit: peer, machineLabel: "w" });
        return fs;
    };

    it("emits one correct event per basic operation and mirrors list()", async () => {
        const fs = await open();
        const events: FsWatchEvent[] = [];
        const mirror = new Mirror();
        const watcher = fs.watch("/", { settleMs: 5 });
        watcher.on("change", (batch) => {
            events.push(...batch);
            mirror.apply(batch);
        });
        await watcher.ready;

        await fs.mkdir("/docs");
        const created = await waitForEvent(
            events,
            (e) => e.type === "created" && e.path === "/docs"
        );
        expect(created.kind).toBe("directory");
        expect(created.origin).toBe("local");
        expect(created.parentId).toBeDefined();

        await fs.writeFile("/docs/a.txt", encode("one"));
        const fileCreated = await waitForEvent(
            events,
            (e) => e.type === "created" && e.path === "/docs/a.txt"
        );
        expect(fileCreated.kind).toBe("file");
        expect(fileCreated.versionId).toBeDefined();

        await fs.writeFile("/docs/a.txt", encode("two"));
        const modified = await waitForEvent(
            events,
            (e) => e.type === "modified" && e.path === "/docs/a.txt"
        );
        expect(modified.versionId).not.toBe(fileCreated.versionId);

        await fs.rename("/docs/a.txt", "/docs/b.txt");
        const renamed = await waitForEvent(events, (e) => e.type === "renamed");
        expect(renamed.oldPath).toBe("/docs/a.txt");
        expect(renamed.path).toBe("/docs/b.txt");

        await fs.rm("/docs/b.txt");
        const deleted = await waitForEvent(
            events,
            (e) => e.type === "deleted" && e.path === "/docs/b.txt"
        );
        expect(deleted.kind).toBe("file");

        await sleep(150);
        await mirrorMatchesList(mirror, fs);
        watcher.close();
        expect(watcher.closed).toBe(true);
    });

    it("scopes a subtree watch and survives an ancestor delete of the root", async () => {
        const fs = await open();
        await fs.mkdir("/project");
        await fs.mkdir("/project/build");
        await fs.writeFile("/project/build/out.txt", encode("x"));
        const events: FsWatchEvent[] = [];
        const watcher = fs.watch("/project/build", { settleMs: 5 });
        watcher.on("change", (batch) => events.push(...batch));
        await watcher.ready;

        // Out-of-scope churn emits nothing.
        await fs.writeFile("/elsewhere.txt", encode("y"));
        await sleep(120);
        expect(events).toHaveLength(0);

        // In-scope write emits.
        await fs.writeFile("/project/build/two.txt", encode("z"));
        await waitForEvent(
            events,
            (e) => e.type === "created" && e.path === "/project/build/two.txt"
        );

        // Ancestor rename: the watched root's spine changed; the watcher
        // stays armed and its view empties (the path no longer resolves).
        await fs.rename("/project", "/moved");
        await waitForEvent(
            events,
            (e) => e.type === "deleted" && e.path === "/project/build/out.txt"
        );
        await waitForEvent(
            events,
            (e) => e.type === "deleted" && e.path === "/project/build/two.txt"
        );

        // Re-birth of the watched path resumes the flow.
        await fs.mkdir("/project");
        await fs.mkdir("/project/build");
        await fs.writeFile("/project/build/back.txt", encode("b"));
        await waitForEvent(
            events,
            (e) => e.type === "created" && e.path === "/project/build/back.txt"
        );
        watcher.close();
    });

    it("watch on a not-yet-existing path arms and fires on birth", async () => {
        const fs = await open();
        const events: FsWatchEvent[] = [];
        const watcher = fs.watch("/later", { settleMs: 5 });
        watcher.on("change", (batch) => events.push(...batch));
        await watcher.ready;
        await fs.mkdir("/later");
        await fs.writeFile("/later/f.txt", encode("v"));
        await waitForEvent(
            events,
            (e) => e.type === "created" && e.path === "/later/f.txt"
        );
        watcher.close();
    });

    it("initial snapshot delivers the existing tree, shallow-first", async () => {
        const fs = await open();
        await fs.mkdir("/a");
        await fs.mkdir("/a/b");
        await fs.writeFile("/a/b/c.txt", encode("v"));
        const batches: FsWatchEvent[][] = [];
        const watcher = fs.watch("/", { initial: "snapshot", settleMs: 5 });
        watcher.on("change", (batch) => batches.push(batch));
        await watcher.ready;
        await sleep(50);
        const first = batches[0] ?? [];
        expect(first.map((e) => `${e.type}:${e.path}`)).toEqual([
            "created:/a",
            "created:/a/b",
            "created:/a/b/c.txt",
        ]);
        expect(first.every((e) => e.cause === "snapshot")).toBe(true);
        watcher.close();
    });

    it("non-recursive mode ignores grandchild churn", async () => {
        const fs = await open();
        await fs.mkdir("/top");
        await fs.mkdir("/top/sub");
        const events: FsWatchEvent[] = [];
        const watcher = fs.watch("/top", { recursive: false, settleMs: 5 });
        watcher.on("change", (batch) => events.push(...batch));
        await watcher.ready;
        await fs.writeFile("/top/sub/deep.txt", encode("v"));
        await sleep(150);
        expect(events).toHaveLength(0);
        await fs.writeFile("/top/direct.txt", encode("v"));
        await waitForEvent(
            events,
            (e) => e.type === "created" && e.path === "/top/direct.txt"
        );
        watcher.close();
    });

    it("async iteration yields composed batches; second iterator throws", async () => {
        const fs = await open();
        const watcher = fs.watch("/", { settleMs: 5 });
        await watcher.ready;
        await fs.mkdir("/it");
        const iterator = watcher[Symbol.asyncIterator]();
        expect(() => watcher[Symbol.asyncIterator]()).toThrow();
        const first = await iterator.next();
        expect(first.done).toBe(false);
        expect(
            first.value.some(
                (e: FsWatchEvent) => e.type === "created" && e.path === "/it"
            )
        ).toBe(true);
        watcher.close();
        const done = await iterator.next();
        expect(done.done).toBe(true);
    });

    it("pre-aborted signal closes before any work; handle.close closes only its watchers", async () => {
        const fs = await open();
        const aborted = new AbortController();
        aborted.abort();
        const dead = fs.watch("/", { signal: aborted.signal });
        expect(dead.closed).toBe(true);
        await expect(dead.ready).rejects.toThrow();

        const alive = fs.watch("/", { settleMs: 5 });
        await alive.ready;
        fs.close();
        expect(alive.closed).toBe(true);
    });
});
