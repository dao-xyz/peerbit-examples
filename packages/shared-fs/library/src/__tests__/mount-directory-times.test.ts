import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    CONFLICTS_DIR,
    FileVersion,
    NamingEvent,
    createSharedFsMountBackend,
    encodeConflictPathName,
    openSharedFs,
    type SharedFsHandle,
    type SharedFsMountBackend,
    type SharedFsMountBackendTarget,
    type SharedFsNamespaceChange,
    type SharedFsNamespaceNamingChange,
} from "../index.js";

const encode = (value: string) => new TextEncoder().encode(value);

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
};

const mountTarget = (
    fs: SharedFsHandle,
    overrides: Partial<SharedFsMountBackendTarget> = {}
): SharedFsMountBackendTarget => ({
    readVersionForMount: (path, versionId) =>
        fs.readVersionForMount(path, versionId),
    writeFile: (path, source, options) => fs.writeFile(path, source, options),
    setMetadata: (path, patch, options) => fs.setMetadata(path, patch, options),
    mkdir: (path) => fs.mkdir(path),
    mutateNamespaceForMount: (mutation) => fs.mutateNamespaceForMount(mutation),
    list: (path) => fs.list(path),
    versions: (path) => fs.versions(path),
    conflicts: (path, options) => fs.conflicts(path, options),
    stat: (path) => fs.stat(path),
    bootstrapStatus: () => fs.bootstrapStatus(),
    onNamespaceChange: (listener) => fs.onNamespaceChange(listener),
    ...overrides,
});

/** A replicated-looking naming event, put straight into the store. */
const namingEvent = (properties: {
    id: string;
    nodeId: string;
    parentId: string;
    name: string;
    parentNamingIds: string[];
    causalDepth: bigint;
    deleted?: boolean;
}) =>
    new NamingEvent({
        ...properties,
        createdAt: 1n,
        authorKey: "remote",
        machineLabel: "remote",
    });

/** The naming event that currently places a path's node. */
const winnerOf = async (fs: SharedFsHandle, path: string) =>
    (await (fs.program as any).resolvePath(path)).winner as {
        id: string;
        nodeId: string;
        causalDepth: bigint;
    };

/** Directory time as a consumer sees it; mtime and ctime always agree. */
const timeOf = async (backend: SharedFsMountBackend, path: string) => {
    const stat = await backend.getattr(path);
    expect(stat.ctimeMs).toBe(stat.mtimeMs);
    return stat.mtimeMs;
};

const namesOf = async (backend: SharedFsMountBackend, path: string) =>
    (await backend.readdir(path)).map((entry) => entry.name).sort();

/** A crafted content version of `nodeId`, as another writer's sync delivers it. */
const fileVersion = (id: string, nodeId: string, parents: string[] = []) =>
    new FileVersion({
        id,
        nodeId,
        parentVersionIds: parents,
        causalDepth: BigInt(parents.length + 1),
        contentHash: `hash-${id}`,
        size: 0,
        mode: 0o100644,
        mtime: 1,
        chunkIds: [],
        createdAt: 1n,
        authorKey: "remote",
        machineLabel: "remote",
    });

describe("mount directory change times", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;
    // A frozen clock unless a test advances it: only name changes move
    // directory times, never elapsed time.
    let now: number;
    const clock = () => now;

    beforeEach(async () => {
        now = 1_700_000_000_500;
        peer = await Peerbit.create();
        fs = await openSharedFs({ peerbit: peer, machineLabel: "dir-times" });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await peer.stop();
    });

    it("passes git's untracked-cache self-test sequence", async () => {
        const backend = createSharedFsMountBackend(fs, { clock });
        await backend.mkdir("/mtime-test");
        const dir = "/mtime-test";
        // git sleeps a second between steps (avoid_racy).
        const step = () => (now += 1001);
        const times = [await timeOf(backend, dir)];
        const changed = async () => {
            const time = await timeOf(backend, dir);
            expect(time).toBeGreaterThan(times.at(-1)!);
            times.push(time);
        };
        const unchanged = async () => {
            expect(await timeOf(backend, dir)).toBe(times.at(-1));
        };

        step();
        const newfile = await backend.open(`${dir}/newfile`, {
            write: true,
            create: true,
            exclusive: true,
        });
        await changed(); // adding a file

        step();
        await backend.mkdir(`${dir}/new-dir`);
        await changed(); // adding a directory

        step();
        await backend.write(newfile, encode("data"), 0);
        await backend.release(newfile);
        await unchanged(); // updating a file

        step();
        const nested = await backend.open(`${dir}/new-dir/new`, {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.release(nested);
        await unchanged(); // adding a file inside the subdirectory

        step();
        await backend.unlink(`${dir}/newfile`);
        await changed(); // deleting a file

        step();
        await backend.unlink(`${dir}/new-dir/new`);
        await backend.rmdir(`${dir}/new-dir`);
        await changed(); // deleting a directory
    });

    it("moves the directory when a provisional create is abandoned", async () => {
        await fs.mkdir("/d");
        const backend = createSharedFsMountBackend(
            mountTarget(fs, {
                writeFile: async () => {
                    throw new Error("injected commit failure");
                },
            }),
            { clock }
        );
        const before = await timeOf(backend, "/d");
        const handle = await backend.open("/d/abandoned.txt", {
            write: true,
            create: true,
            releaseFailure: "discard",
        });
        const listed = await timeOf(backend, "/d");
        expect(listed).toBeGreaterThan(before);
        expect((await backend.readdir("/d")).map((e) => e.name)).toEqual([
            "abandoned.txt",
        ]);

        await expect(backend.release(handle)).rejects.toMatchObject({
            code: "EIO",
        });
        expect(await backend.readdir("/d")).toEqual([]);
        expect(await timeOf(backend, "/d")).toBeGreaterThan(listed);
    });

    it("moves the directory when a provisional create is unlinked or renamed over", async () => {
        await fs.mkdir("/d");
        await fs.writeFile("/d/source.txt", "source");
        const backend = createSharedFsMountBackend(fs, { clock });
        const flags = { write: true, create: true, exclusive: true };
        const temporary = await backend.open("/d/temporary", flags);
        const replaced = await backend.open("/d/replaced", flags);
        let time = await timeOf(backend, "/d");
        expect(await namesOf(backend, "/d")).toEqual([
            "replaced",
            "source.txt",
            "temporary",
        ]);

        await backend.unlink("/d/temporary");
        expect(await namesOf(backend, "/d")).toEqual([
            "replaced",
            "source.txt",
        ]);
        expect(await timeOf(backend, "/d")).toBeGreaterThan(time);
        time = await timeOf(backend, "/d");

        await backend.rename("/d/source.txt", "/d/replaced");
        expect(await namesOf(backend, "/d")).toEqual(["replaced"]);
        expect(await timeOf(backend, "/d")).toBeGreaterThan(time);
        time = await timeOf(backend, "/d");

        // Their descriptors close without changing a name.
        await backend.release(temporary);
        await backend.release(replaced);
        expect(await namesOf(backend, "/d")).toEqual(["replaced"]);
        expect(await timeOf(backend, "/d")).toBe(time);
    });

    it("keeps the directory for child chmod, utimens and content writes", async () => {
        await fs.mkdir("/d");
        await fs.writeFile("/d/f.txt", "f");
        const backend = createSharedFsMountBackend(fs, { clock });
        const before = await timeOf(backend, "/d");
        await backend.readdir("/d", { includeStats: true });

        await backend.setattr("/d/f.txt", { mode: 0o755 });
        await backend.setattr("/d/f.txt", { mtimeMs: 946684800000 });
        const handle = await backend.open("/d/f.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("edited"), 0);
        expect(await timeOf(backend, "/d")).toBe(before);
        await backend.release(handle);
        await fs.writeFile("/d/f.txt", "edited elsewhere");
        // utimens on a directory stays a no-op.
        await backend.setattr("/d", { mtimeMs: 1 });
        expect(await timeOf(backend, "/d")).toBe(before);
    });

    it("moves both parents for other writers' creates, deletes and moves", async () => {
        for (const path of ["/top", "/top/a", "/top/b", "/top/sibling"]) {
            await fs.mkdir(path);
        }
        await fs.writeFile("/top/a/m.txt", "m");
        const backend = createSharedFsMountBackend(fs, { clock });
        const paths = ["/top", "/top/a", "/top/b", "/top/sibling"];
        const snapshot = async () =>
            Object.fromEntries(
                await Promise.all(
                    paths.map(async (path) => [
                        path,
                        await timeOf(backend, path),
                    ])
                )
            ) as Record<string, number>;
        await backend.readdir("/top/a");
        const moved =
            (keys: string[], before: Record<string, number>) => async () => {
                const after = await snapshot();
                for (const path of paths) {
                    if (keys.includes(path)) {
                        expect(after[path], path).toBeGreaterThan(before[path]);
                    } else {
                        expect(after[path], path).toBe(before[path]);
                    }
                }
                return after;
            };

        let before = await snapshot();
        await fs.writeFile("/top/a/new.txt", "new");
        before = await moved(["/top/a"], before)();

        await fs.rm("/top/a/new.txt");
        before = await moved(["/top/a"], before)();

        await fs.rename("/top/a/m.txt", "/top/b/m.txt");
        before = await moved(["/top/a", "/top/b"], before)();

        // A directory move: both parents and the moved directory itself
        // (its `..`), never its children or a sibling.
        await fs.mkdir("/top/a/sub");
        await fs.mkdir("/top/a/sub/child");
        const sub = await timeOf(backend, "/top/a/sub");
        const child = await timeOf(backend, "/top/a/sub/child");
        before = await snapshot();
        await fs.rename("/top/a/sub", "/top/b/sub");
        await moved(["/top/a", "/top/b"], before)();
        expect(await timeOf(backend, "/top/b/sub")).toBeGreaterThan(sub);
        expect(await timeOf(backend, "/top/b/sub/child")).toBe(child);
    });

    it("moves the old parent of a served node whose naming rows went cold", async () => {
        await fs.mkdir("/a");
        await fs.mkdir("/b");
        await fs.writeFile("/a/n.txt", "n");
        const b = (await fs.stat("/b"))!;
        const created = await winnerOf(fs, "/a/n.txt");
        const backend = createSharedFsMountBackend(fs, { clock });
        await backend.readdir("/a");
        const before = await timeOf(backend, "/a");

        // As after an eviction, GC or overlay retirement: no warm rows say
        // where the node was; the move names only its new parent.
        (fs.program as any).namingRowCache.delete(created.nodeId);
        await fs.program.entries.put(
            namingEvent({
                id: "naming:remote-move",
                nodeId: created.nodeId,
                parentId: b.nodeId,
                name: "n.txt",
                parentNamingIds: [created.id],
                causalDepth: created.causalDepth + 1n,
            }),
            { unique: true }
        );
        expect(await backend.readdir("/a")).toEqual([]);
        expect(await timeOf(backend, "/a")).toBeGreaterThan(before);
    });

    it("moves the directory a concurrent rename's winner left, and a tombstone's", async () => {
        for (const path of ["/d0", "/d1", "/d2"]) await fs.mkdir(path);
        await fs.writeFile("/d0/n.txt", "n");
        const created = await winnerOf(fs, "/d0/n.txt");
        await fs.rename("/d0/n.txt", "/d1/n.txt");
        const [d0, d2] = [(await fs.stat("/d0"))!, (await fs.stat("/d2"))!];
        const backend = createSharedFsMountBackend(fs, { clock });
        expect((await backend.readdir("/d1")).map((e) => e.name)).toEqual([
            "n.txt",
        ]);
        const [d1Before, d2Before] = [
            await timeOf(backend, "/d1"),
            await timeOf(backend, "/d2"),
        ];

        // Another writer moved the same node from d0 to d2, deeper: the
        // event names only d0's history and d2, yet d1 loses the name.
        const flip = namingEvent({
            id: "naming:remote-flip",
            nodeId: created.nodeId,
            parentId: d2.nodeId,
            name: "n.txt",
            parentNamingIds: [created.id],
            causalDepth: created.causalDepth + 5n,
        });
        await fs.program.entries.put(flip, { unique: true });
        expect(await backend.readdir("/d1")).toEqual([]);
        expect(await timeOf(backend, "/d1")).toBeGreaterThan(d1Before);
        expect((await backend.readdir("/d2")).map((e) => e.name)).toEqual([
            "n.txt",
        ]);
        const d2Flipped = await timeOf(backend, "/d2");
        expect(d2Flipped).toBeGreaterThan(d2Before);

        // A deeper tombstone from a branch this replica never saw names d0,
        // where that branch last placed the node, yet d2 loses the name.
        await fs.program.entries.put(
            namingEvent({
                id: "naming:remote-tombstone",
                nodeId: created.nodeId,
                parentId: d0.nodeId,
                name: "n.txt",
                parentNamingIds: [created.id],
                causalDepth: created.causalDepth + 9n,
                deleted: true,
            }),
            { unique: true }
        );
        expect(await backend.readdir("/d2")).toEqual([]);
        expect(await timeOf(backend, "/d2")).toBeGreaterThan(d2Flipped);
    });

    it("moves the directory when a hidden file's first content arrives", async () => {
        await fs.mkdir("/d");
        const d = (await fs.stat("/d"))!;
        const backend = createSharedFsMountBackend(fs, { clock });
        // The naming arrives first: the node is hidden until it has content.
        await fs.program.entries.put(
            namingEvent({
                id: "naming:remote-late",
                nodeId: "file:remote-late",
                parentId: d.nodeId,
                name: "late.txt",
                parentNamingIds: [],
                causalDepth: 1n,
            }),
            { unique: true }
        );
        expect(await backend.readdir("/d")).toEqual([]);
        const hidden = await timeOf(backend, "/d");

        await fs.program.entries.put(
            new FileVersion({
                id: "version:remote-late",
                nodeId: "file:remote-late",
                causalDepth: 1n,
                contentHash: "remote-late",
                size: 0,
                mode: 0o100644,
                mtime: 1,
                chunkIds: [],
                createdAt: 1n,
                authorKey: "remote",
                machineLabel: "remote",
            }),
            { unique: true }
        );
        expect((await backend.readdir("/d")).map((e) => e.name)).toEqual([
            "late.txt",
        ]);
        expect(await timeOf(backend, "/d")).toBeGreaterThan(hidden);
    });

    it("moves every directory once the whole view may have changed", async () => {
        await fs.mkdir("/d");
        const backend = createSharedFsMountBackend(fs, { clock });
        const before = await Promise.all(
            ["/", "/d", `/${CONFLICTS_DIR}`].map((path) =>
                timeOf(backend, path)
            )
        );
        // A bootstrap overlay retirement replaces the served view at once.
        (fs.program as any).retireOverlay(true);
        const after = await Promise.all(
            ["/", "/d", `/${CONFLICTS_DIR}`].map((path) =>
                timeOf(backend, path)
            )
        );
        after.forEach((time, i) => expect(time).toBeGreaterThan(before[i]));
        // So does a timed-out one, which drops unproven overlay documents.
        (fs.program as any).retireOverlay(false);
        const timedOut = await Promise.all(
            ["/", "/d", `/${CONFLICTS_DIR}`].map((path) =>
                timeOf(backend, path)
            )
        );
        timedOut.forEach((time, i) => expect(time).toBeGreaterThan(after[i]));
    });

    it("moves the directory when content a timed-out overlay showed arrives", async () => {
        const program = fs.program as any;
        await fs.mkdir("/d");
        const d = (await fs.stat("/d"))!;
        const backend = createSharedFsMountBackend(fs, { clock });
        const placed = (name: string) =>
            namingEvent({
                id: `naming:overlay-${name}`,
                nodeId: `file:overlay-${name}`,
                parentId: d.nodeId,
                name,
                parentNamingIds: [],
                causalDepth: 1n,
            });
        const content = (name: string) =>
            fileVersion(`version:overlay-${name}`, `file:overlay-${name}`);
        // A cold-start overlay lists n.txt, whose naming replicated while its
        // content exists only in the overlay, and m.txt, which exists only
        // in the overlay.
        await fs.program.entries.put(placed("n.txt"), { unique: true });
        program.bootstrapPhase = "overlay-active";
        program.installOverlayDoc(content("n.txt"));
        program.installOverlayDoc(placed("m.txt"));
        program.installOverlayDoc(content("m.txt"));
        expect(await namesOf(backend, "/d")).toEqual(["m.txt", "n.txt"]);

        // The overlay times out: its unproven documents leave the view.
        program.retireOverlay(false);
        expect(await backend.readdir("/d")).toEqual([]);
        await fs.program.entries.put(placed("m.txt"), { unique: true });
        expect(await backend.readdir("/d")).toEqual([]);
        const hidden = await timeOf(backend, "/d");

        // Their content replicates later.
        now += 5000;
        await fs.program.entries.put(content("n.txt"), { unique: true });
        expect(await namesOf(backend, "/d")).toEqual(["n.txt"]);
        const shown = await timeOf(backend, "/d");
        expect(shown).toBeGreaterThan(hidden);
        await fs.program.entries.put(content("m.txt"), { unique: true });
        expect(await namesOf(backend, "/d")).toEqual(["m.txt", "n.txt"]);
        expect(await timeOf(backend, "/d")).toBeGreaterThan(shown);
    });

    it("never repeats a time for a replaced directory or across a second", async () => {
        const backend = createSharedFsMountBackend(fs, { clock });
        // Past the mount's first second, whose times start a second ahead.
        now += 1000;
        await backend.mkdir("/x");
        const replaced = await timeOf(backend, "/x");
        await backend.rmdir("/x");
        await backend.mkdir("/x");
        // Another directory node at the path, read in the same millisecond.
        const replacement = await timeOf(backend, "/x");
        expect(Math.floor(replacement / 1000)).toBeGreaterThan(
            Math.floor(replaced / 1000)
        );

        // Two changes within one wall second, each observed: the first moves
        // to the next whole second; later ones stay within a second ahead.
        await fs.mkdir("/s");
        const first = await timeOf(backend, "/s");
        await fs.writeFile("/s/a.txt", "a");
        const second = await timeOf(backend, "/s");
        expect(Math.floor(second / 1000)).toBeGreaterThan(
            Math.floor(first / 1000)
        );
        await fs.writeFile("/s/b.txt", "b");
        const third = await timeOf(backend, "/s");
        expect(third).toBeGreaterThan(second);
        expect(third).toBeLessThanOrEqual(now + 1000);
    });

    it("never runs a directory time more than a second ahead of the clock", async () => {
        await fs.mkdir("/d");
        const d = (await fs.stat("/d"))!;
        const backend = createSharedFsMountBackend(fs, { clock });
        await backend.readdir("/d");
        // Replicated names arrive faster than the clock ticks, and each one
        // is followed by a stat of the directory.
        let time = await timeOf(backend, "/d");
        for (let i = 0; i < 600; i++) {
            await fs.program.entries.put(
                namingEvent({
                    id: `naming:burst-${i}`,
                    nodeId: `file:burst-${i}`,
                    parentId: d.nodeId,
                    name: `f${i}.txt`,
                    parentNamingIds: [],
                    causalDepth: 1n,
                }),
                { unique: true }
            );
            const next = await timeOf(backend, "/d");
            expect(next).toBeGreaterThanOrEqual(time);
            expect(next).toBeLessThanOrEqual(now + 1000);
            time = next;
        }
        // The change the cap held back shows once the clock moves.
        now += 1;
        expect(await timeOf(backend, "/d")).toBeGreaterThan(time);
    });

    it("moves the directory when a dirty open file reappears or disappears", async () => {
        await fs.mkdir("/d");
        await fs.writeFile("/d/f.txt", "f");
        const backend = createSharedFsMountBackend(fs, { clock });
        const handle = await backend.open("/d/f.txt", {
            read: true,
            write: true,
        });
        await backend.readdir("/d");
        const before = await timeOf(backend, "/d");

        // Another writer deletes the clean open file.
        await fs.rm("/d/f.txt");
        const removed = await timeOf(backend, "/d");
        expect(removed).toBeGreaterThan(before);
        expect(await backend.readdir("/d")).toEqual([]);

        // A local write resurrects the name through the dirty overlay.
        await backend.write(handle, encode("local"), 0);
        expect((await backend.readdir("/d")).map((e) => e.name)).toEqual([
            "f.txt",
        ]);
        const resurrected = await timeOf(backend, "/d");
        expect(resurrected).toBeGreaterThan(removed);

        // The commit loses its node binding; the overlay leaves again.
        await expect(backend.release(handle)).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect(await backend.readdir("/d")).toEqual([]);
        expect(await timeOf(backend, "/d")).toBeGreaterThan(resurrected);
    });

    it("settles an open file a rename touched once a commit lists it again", async () => {
        await fs.mkdir("/d");
        await fs.writeFile("/d/app.log", "1");
        const backend = createSharedFsMountBackend(fs, { clock });
        const handle = await backend.open("/d/app.log", {
            read: true,
            write: true,
            append: true,
        });
        // Log rotation renames the file under the open descriptor.
        await backend.rename("/d/app.log", "/d/app.log.1");
        await backend.write(handle, encode("2"), 0);
        await backend.flush(handle);
        const settled = await timeOf(backend, "/d");

        await backend.write(handle, encode("3"), 0);
        await backend.flush(handle);
        expect(await timeOf(backend, "/d")).toBe(settled);
        await backend.release(handle);
        expect((await backend.readdir("/d")).map((e) => e.name)).toEqual([
            "app.log.1",
        ]);
    });

    it("moves the conflict directories when conflicts appear, move or resolve", async () => {
        const backend = createSharedFsMountBackend(fs, { clock });
        const conflictsTime = () => timeOf(backend, `/${CONFLICTS_DIR}`);
        await fs.mkdir("/d");
        await fs.writeFile("/d/plain.txt", "plain");
        expect(await backend.readdir(`/${CONFLICTS_DIR}`)).toEqual([]);

        // A content edit changes no name, so it cannot reveal a conflict.
        let before = await conflictsTime();
        await fs.writeFile("/d/plain.txt", "edited");
        expect(await conflictsTime()).toBe(before);

        const base = await fs.writeFile("/d/c.txt", "base");
        await fs.stat("/d/c.txt");
        before = await conflictsTime();
        await fs.writeFile("/d/c.txt", "left", { baseVersionIds: [base.id] });
        await fs.writeFile("/d/c.txt", "right", { baseVersionIds: [base.id] });
        expect(await conflictsTime()).toBeGreaterThan(before);
        expect(
            (await backend.readdir(`/${CONFLICTS_DIR}`)).map((e) => e.name)
        ).toEqual([encodeConflictPathName("/d/c.txt")]);

        // Renaming the conflicted file renames its conflict directory.
        before = await conflictsTime();
        await fs.rename("/d/c.txt", "/d/moved.txt");
        expect(await conflictsTime()).toBeGreaterThan(before);

        // Resolving merges the heads and removes the conflict directory.
        before = await conflictsTime();
        const [head] = (await fs.stat("/d/moved.txt"))!.headVersionIds!;
        await fs.resolveConflict("/d/moved.txt", head);
        expect(await backend.readdir(`/${CONFLICTS_DIR}`)).toEqual([]);
        expect(await conflictsTime()).toBeGreaterThan(before);
    });

    it("redoes a listing or lookup that a namespace change raced", async () => {
        for (const path of ["/d", "/e"]) await fs.mkdir(path);
        for (const name of ["x.txt", "y.txt", "z.txt"]) {
            await fs.writeFile(`/d/${name}`, name);
        }
        const gate = { list: false, stat: false };
        const entered = deferred();
        const allowed = { list: deferred(), stat: deferred() };
        const list = vi.fn(async (path?: string) => {
            const entries = await fs.list(path);
            if (gate.list) {
                gate.list = false;
                entered.resolve();
                await allowed.list.promise;
            }
            return entries;
        });
        const statEntered = deferred();
        const stat = vi.fn(async (path: string) => {
            const entry = await fs.stat(path);
            if (gate.stat && path === "/d/z.txt") {
                gate.stat = false;
                statEntered.resolve();
                await allowed.stat.promise;
            }
            return entry;
        });
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { list, stat }),
            { clock }
        );
        const before = await timeOf(backend, "/d");

        // The first listing still holds x and y when they go.
        gate.list = true;
        const reading = backend.readdir("/d");
        await entered.promise;
        await fs.rm("/d/x.txt");
        await fs.rename("/d/y.txt", "/e/y.txt");
        allowed.list.resolve();
        expect((await reading).map((entry) => entry.name)).toEqual(["z.txt"]);
        expect(list).toHaveBeenCalledTimes(2);

        // A lookup that resolved z before its delete reports ENOENT.
        gate.stat = true;
        const looking = backend.getattr("/d/z.txt");
        await statEntered.promise;
        await fs.rm("/d/z.txt");
        allowed.stat.resolve();
        await expect(looking).rejects.toMatchObject({ code: "ENOENT" });
        expect(await timeOf(backend, "/d")).toBeGreaterThan(before);
    });

    it("gives up after three raced passes and moves the listed directory", async () => {
        await fs.mkdir("/d");
        await fs.mkdir("/other");
        await fs.writeFile("/d/kept.txt", "kept");
        let race = 0;
        const list = vi.fn(async (path?: string) => {
            const entries = await fs.list(path);
            if (path === "/d") {
                // Unrelated namespace traffic lands during every pass.
                await fs.mkdir(`/other/race-${race++}`);
            }
            return entries;
        });
        const backend = createSharedFsMountBackend(mountTarget(fs, { list }), {
            clock,
        });
        const before = await timeOf(backend, "/d");
        list.mockClear();

        expect(
            (await backend.readdir("/d")).map((entry) => entry.name)
        ).toEqual(["kept.txt"]);
        expect(list).toHaveBeenCalledTimes(3);
        expect(await timeOf(backend, "/d")).toBeGreaterThan(before);
    });

    it("scans once for the conflict listing while a collector retires versions", async () => {
        const program = fs.program as any;
        const root = `/${CONFLICTS_DIR}`;
        await fs.mkdir("/d");
        const old: string[] = [];
        for (let i = 0; i < 4; i++) {
            old.push((await fs.writeFile("/d/log.txt", `v${i}`)).id);
        }
        await fs.stat("/d/log.txt");
        let during: number | undefined;
        let backend!: SharedFsMountBackend;
        const conflicts = vi.fn(
            async (path?: string, options?: { allowPartial?: boolean }) => {
                const result = await fs.conflicts(path, options);
                if (path === undefined && old.length > 1) {
                    // An old version leaves while each scan of every file
                    // version is in flight, and a consumer reads the time.
                    program.guardArmed = false;
                    await fs.program.entries.del(old.shift()!);
                    during = await timeOf(backend, root);
                }
                return result;
            }
        );
        backend = createSharedFsMountBackend(mountTarget(fs, { conflicts }), {
            clock,
        });

        expect(await backend.readdir(root)).toEqual([]);
        expect(conflicts).toHaveBeenCalledTimes(1);
        // The listing may predate the removal: its time moved instead.
        expect(await timeOf(backend, root)).toBeGreaterThan(during!);
    });

    it("redoes a conflict directory lookup that a fork raced", async () => {
        const root = `/${CONFLICTS_DIR}`;
        const dir = `${root}/${encodeConflictPathName("/d/c.txt")}`;
        await fs.mkdir("/d");
        const base = await fs.writeFile("/d/c.txt", "base");
        await fs.stat("/d/c.txt");
        let race: ((pass: number) => Promise<void>) | undefined;
        let passes = 0;
        const conflicts = vi.fn(
            async (path?: string, options?: { allowPartial?: boolean }) => {
                const result = await fs.conflicts(path, options);
                if (race && path === "/d/c.txt") await race(++passes);
                return result;
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { conflicts }),
            { clock }
        );

        // Another writer forks the file while the first lookup is in flight.
        race = async (pass) => {
            if (pass > 1) return;
            await fs.writeFile("/d/c.txt", "left", {
                baseVersionIds: [base.id],
            });
            await fs.writeFile("/d/c.txt", "right", {
                baseVersionIds: [base.id],
            });
        };
        expect(await backend.getattr(dir)).toMatchObject({
            kind: "directory",
        });
        expect(passes).toBe(2);

        // Name changes land during every pass: the lookup gives up, and the
        // conflict directories' time moves past one read meanwhile.
        let during: number | undefined;
        passes = 0;
        race = async (pass) => {
            await fs.writeFile(`/d/other-${pass}.txt`, "other");
            if (pass === 3) during = await timeOf(backend, root);
        };
        await backend.getattr(dir);
        expect(passes).toBe(3);
        expect(await timeOf(backend, root)).toBeGreaterThan(during!);
    });

    it("moves the conflict directories when a name reveals an existing fork", async () => {
        const backend = createSharedFsMountBackend(fs, { clock });
        const root = `/${CONFLICTS_DIR}`;
        await fs.mkdir("/d");
        const d = (await fs.stat("/d"))!;

        // Another writer's forked content arrives before its naming: the
        // file is hidden, so the listing is empty although a fork exists.
        const nodeId = "file:remote-forked";
        await fs.program.entries.put(fileVersion("version:base", nodeId), {
            unique: true,
        });
        for (const side of ["left", "right"]) {
            await fs.program.entries.put(
                fileVersion(`version:${side}`, nodeId, ["version:base"]),
                { unique: true }
            );
        }
        expect(await backend.readdir(root)).toEqual([]);
        let before = await timeOf(backend, root);
        await fs.program.entries.put(
            namingEvent({
                id: "naming:remote-forked",
                nodeId,
                parentId: d.nodeId,
                name: "forked.txt",
                parentNamingIds: [],
                causalDepth: 1n,
            }),
            { unique: true }
        );
        expect(await namesOf(backend, root)).toEqual([
            encodeConflictPathName("/d/forked.txt"),
        ]);
        expect(await timeOf(backend, root)).toBeGreaterThan(before);

        // A deleted conflicted file leaves the listing; a concurrent rename
        // (a non-delete head beats a delete at equal depth) revives it.
        const created = await winnerOf(fs, "/d/forked.txt");
        await fs.rm("/d/forked.txt");
        expect(await backend.readdir(root)).toEqual([]);
        before = await timeOf(backend, root);
        await fs.program.entries.put(
            namingEvent({
                id: "naming:remote-revive",
                nodeId,
                parentId: d.nodeId,
                name: "revived.txt",
                parentNamingIds: [created.id],
                causalDepth: created.causalDepth + 1n,
            }),
            { unique: true }
        );
        expect(await namesOf(backend, root)).toEqual([
            encodeConflictPathName("/d/revived.txt"),
        ]);
        expect(await timeOf(backend, root)).toBeGreaterThan(before);

        // Sibling versions of a warm file delivered in one sync change.
        const program = fs.program as any;
        const base = await fs.writeFile("/d/c.txt", "base");
        const c = (await fs.stat("/d/c.txt"))!;
        before = await timeOf(backend, root);
        const siblings = ["sync-left", "sync-right"].map((id) =>
            fileVersion(`version:${id}`, c.nodeId, [base.id])
        );
        const listener = program.changeListener;
        program.entries.events.removeEventListener("change", listener);
        try {
            for (const sibling of siblings) {
                await program.entries.put(sibling, { unique: true });
            }
        } finally {
            program.entries.events.addEventListener("change", listener);
        }
        listener({ detail: { added: siblings, removed: [] } });
        expect(await namesOf(backend, root)).toContain(
            encodeConflictPathName("/d/c.txt")
        );
        expect(await timeOf(backend, root)).toBeGreaterThan(before);
    });

    it("moves the directory a hidden slot winner leaves", async () => {
        for (const path of ["/d1", "/d2"]) await fs.mkdir(path);
        await fs.writeFile("/d1/x", "m");
        const [d1, d2] = [(await fs.stat("/d1"))!, (await fs.stat("/d2"))!];
        const backend = createSharedFsMountBackend(fs, { clock });
        expect(await namesOf(backend, "/d1")).toEqual(["x"]);

        // Another writer's same-name create wins the slot (its id sorts
        // first) before its content arrives, hiding x.
        const claim = namingEvent({
            id: "naming:!hidden-claim",
            nodeId: "file:!hidden",
            parentId: d1.nodeId,
            name: "x",
            parentNamingIds: [],
            causalDepth: 1n,
        });
        await fs.program.entries.put(claim, { unique: true });
        expect(await backend.readdir("/d1")).toEqual([]);
        const hidden = await timeOf(backend, "/d1");

        // It moves to d2, still without content: x is visible in d1 again.
        await fs.program.entries.put(
            namingEvent({
                id: "naming:!hidden-moved",
                nodeId: "file:!hidden",
                parentId: d2.nodeId,
                name: "x",
                parentNamingIds: [claim.id],
                causalDepth: 2n,
            }),
            { unique: true }
        );
        expect(await namesOf(backend, "/d1")).toEqual(["x"]);
        expect(await timeOf(backend, "/d1")).toBeGreaterThan(hidden);
    });

    it("moves the directories a removed winning head leaves and re-exposes", async () => {
        for (const path of ["/d0", "/d1", "/d2"]) await fs.mkdir(path);
        await fs.writeFile("/d0/h.txt", "h");
        await fs.mkdir("/d0/sub");
        const [d1, d2] = [(await fs.stat("/d1"))!, (await fs.stat("/d2"))!];
        const backend = createSharedFsMountBackend(fs, { clock });
        // A file and a directory, each with a deeper head in d1 and a
        // shallower concurrent one in d2.
        const deep: string[] = [];
        for (const name of ["h.txt", "sub"]) {
            const created = await winnerOf(fs, `/d0/${name}`);
            for (const [parent, extra] of [
                [d2, 1n],
                [d1, 2n],
            ] as const) {
                const event = namingEvent({
                    id: `naming:${name}-${extra}`,
                    nodeId: created.nodeId,
                    parentId: parent.nodeId,
                    name,
                    parentNamingIds: [created.id],
                    causalDepth: created.causalDepth + extra,
                });
                await fs.program.entries.put(event, { unique: true });
                if (extra === 2n) deep.push(event.id);
            }
        }
        expect(await namesOf(backend, "/d1")).toEqual(["h.txt", "sub"]);
        expect(await namesOf(backend, "/d2")).toEqual([]);
        const before = {
            d2: await timeOf(backend, "/d2"),
            sub: await timeOf(backend, "/d1/sub"),
        };

        // A collector elsewhere deletes the winning heads before their
        // successors arrive (Guard D disarmed, as while unverified).
        (fs.program as any).guardArmed = false;
        for (const id of deep) await fs.program.entries.del(id);
        expect(await namesOf(backend, "/d2")).toEqual(["h.txt", "sub"]);
        expect(await timeOf(backend, "/d2")).toBeGreaterThan(before.d2);
        // The re-exposed directory's `..` changed too.
        expect(await timeOf(backend, "/d2/sub")).toBeGreaterThan(before.sub);
    });

    it("moves the directory when a file's last version leaves and when content returns", async () => {
        const program = fs.program as any;
        await fs.mkdir("/d");
        const written = await fs.writeFile("/d/v.txt", "v1");
        const version = await program.getDocument(written.id);
        const backend = createSharedFsMountBackend(fs, { clock });
        expect(await namesOf(backend, "/d")).toEqual(["v.txt"]);
        const listed = await timeOf(backend, "/d");

        // A remote delete of the only version arrives before its successor.
        program.guardArmed = false;
        await fs.program.entries.del(written.id);
        expect(await backend.readdir("/d")).toEqual([]);
        expect(await timeOf(backend, "/d")).toBeGreaterThan(listed);

        // A consumer re-lists after an unrelated create, without v.txt.
        await fs.writeFile("/d/w.txt", "w");
        expect(await namesOf(backend, "/d")).toEqual(["w.txt"]);
        const relisted = await timeOf(backend, "/d");
        await fs.program.entries.put(version, { unique: true });
        expect(await namesOf(backend, "/d")).toEqual(["v.txt", "w.txt"]);
        expect(await timeOf(backend, "/d")).toBeGreaterThan(relisted);
    });

    it("moves the directory when another writer's delete or move races a commit", async () => {
        for (const path of ["/d", "/e"]) await fs.mkdir(path);
        await fs.writeFile("/d/x", "x");
        await fs.writeFile("/d/y", "y");
        let race: (() => Promise<unknown>) | undefined;
        let midCommit: { time: number; names: string[] } | undefined;
        const backend: SharedFsMountBackend = createSharedFsMountBackend(
            mountTarget(fs, {
                writeFile: async (path, source, options) => {
                    const result = await fs.writeFile(path, source, options);
                    const raced = race;
                    race = undefined;
                    if (raced) {
                        // The change lands after the compare-and-set and
                        // before the commit returns; a consumer reads then.
                        await raced();
                        midCommit = {
                            time: await timeOf(backend, "/d"),
                            names: await namesOf(backend, "/d"),
                        };
                    }
                    return result;
                },
            }),
            { clock }
        );
        for (const [name, change] of [
            ["x", () => fs.rm("/d/x")],
            ["y", () => fs.rename("/d/y", "/e/y")],
            // A create's new node, removed or moved right after its commit
            // made it visible.
            ["new-a", () => fs.rm("/d/new-a")],
            ["new-b", () => fs.rename("/d/new-b", "/e/new-b")],
        ] as const) {
            const handle = await backend.open(`/d/${name}`, {
                read: true,
                write: true,
                create: true,
            });
            await backend.readdir("/d");
            await backend.write(handle, encode("edited"), 0);
            race = change;
            await backend.release(handle);
            // Listed by the dirty overlay only, until the commit finished.
            expect(midCommit!.names).toContain(name);
            expect(await namesOf(backend, "/d")).not.toContain(name);
            expect(await timeOf(backend, "/d")).toBeGreaterThan(
                midCommit!.time
            );
        }
    });

    it("records a listing's placements in the same continuation that checks for races", async () => {
        const program = fs.program as any;
        for (const path of ["/d", "/e"]) await fs.mkdir(path);
        const e = (await fs.stat("/e"))!;
        for (let hops = 0; hops <= 6; hops++) {
            await fs.writeFile(`/d/x${hops}`, "x");
            const x = await winnerOf(fs, `/d/x${hops}`);
            let held: SharedFsNamespaceChange[] | undefined;
            let deliver!: (change: SharedFsNamespaceChange) => void;
            let armed = false;
            const backend = createSharedFsMountBackend(
                mountTarget(fs, {
                    list: async (path) => {
                        const entries = await fs.list(path);
                        if (armed && path === "/d") {
                            armed = false;
                            // Another writer moves x out; with its naming
                            // rows cold, only the served placement says
                            // where the mount listed it. Applied now,
                            // reported `hops` microtasks later: around the
                            // race check.
                            held = [];
                            program.namingRowCache.delete(x.nodeId);
                            await fs.program.entries.put(
                                namingEvent({
                                    id: `naming:race-${hops}`,
                                    nodeId: x.nodeId,
                                    parentId: e.nodeId,
                                    name: `x${hops}`,
                                    parentNamingIds: [x.id],
                                    causalDepth: x.causalDepth + 1n,
                                }),
                                { unique: true }
                            );
                            const batches = held;
                            held = undefined;
                            let delay = hops;
                            const later = () => {
                                if (delay-- > 0) queueMicrotask(later);
                                else
                                    for (const batch of batches) deliver(batch);
                            };
                            later();
                        }
                        return entries;
                    },
                    onNamespaceChange: (listener) => {
                        deliver = listener;
                        return fs.onNamespaceChange((change) =>
                            held ? held.push(change) : listener(change)
                        );
                    },
                }),
                { clock }
            );
            const before = await timeOf(backend, "/d");
            armed = true;
            const listed = await namesOf(backend, "/d");
            const after = await timeOf(backend, "/d");
            const current = await namesOf(backend, "/d");
            expect(current).not.toContain(`x${hops}`);
            // A listing that missed the move leaves a changed time behind.
            if (listed.join() !== current.join()) {
                expect(after, `${hops} hops`).toBeGreaterThan(before);
            }
            backend.dispose();
        }
    });

    it("moves the directory when a dirty open file reappears after another node claimed its slot", async () => {
        await fs.mkdir("/d");
        const d = (await fs.stat("/d"))!;
        await fs.writeFile("/d/x", "a");
        const x = await winnerOf(fs, "/d/x");
        const backend = createSharedFsMountBackend(fs, { clock });
        const handle = await backend.open("/d/x", { read: true, write: true });
        await backend.readdir("/d");

        // Another writer's node claims the slot deeper; its content has not
        // arrived, so the name is hidden.
        await fs.program.entries.put(
            namingEvent({
                id: "naming:competitor",
                nodeId: "file:competitor",
                parentId: d.nodeId,
                name: "x",
                parentNamingIds: [],
                causalDepth: x.causalDepth + 10n,
            }),
            { unique: true }
        );
        expect(await backend.readdir("/d")).toEqual([]);
        const hidden = await timeOf(backend, "/d");

        // A local write lists x again through the dirty overlay.
        await backend.write(handle, encode("local"), 0);
        expect(await namesOf(backend, "/d")).toEqual(["x"]);
        const shown = await timeOf(backend, "/d");
        expect(shown).toBeGreaterThan(hidden);
        await expect(backend.release(handle)).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect(await backend.readdir("/d")).toEqual([]);
        expect(await timeOf(backend, "/d")).toBeGreaterThan(shown);
    });

    it("moves the directory now at an open file's parent path when its overlay changes", async () => {
        await fs.mkdir("/d");
        await fs.writeFile("/d/x", "a");
        const backend = createSharedFsMountBackend(fs, { clock });
        const handle = await backend.open("/d/x", { read: true, write: true });

        // Another writer moves /d away and creates a new /d.
        await fs.rename("/d", "/e");
        await fs.mkdir("/d");
        expect(await backend.readdir("/d")).toEqual([]);
        const replaced = await timeOf(backend, "/d");

        // Listings merge the overlay by path: x appears in the new /d.
        await backend.write(handle, encode("local"), 0);
        expect(await namesOf(backend, "/d")).toEqual(["x"]);
        const shown = await timeOf(backend, "/d");
        expect(shown).toBeGreaterThan(replaced);
        await expect(backend.release(handle)).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect(await backend.readdir("/d")).toEqual([]);
        expect(await timeOf(backend, "/d")).toBeGreaterThan(shown);
    });

    it("moves the directory now at a provisional create's parent path when the create is abandoned", async () => {
        await fs.mkdir("/d");
        await fs.mkdir("/d/sub");
        const backend = createSharedFsMountBackend(fs, { clock });
        const handle = await backend.open("/d/sub/new.txt", {
            write: true,
            create: true,
        });
        await backend.write(handle, encode("local"), 0);

        // Another writer replaces /d/sub with a new directory node.
        await fs.rm("/d/sub");
        await fs.mkdir("/d/sub");
        // Listings merge the overlay by path: new.txt shows in the new /d/sub.
        expect(await namesOf(backend, "/d/sub")).toEqual(["new.txt"]);
        const shown = await timeOf(backend, "/d/sub");

        // Its commit finds another parent there and abandons the create.
        await expect(backend.release(handle)).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect(await backend.readdir("/d/sub")).toEqual([]);
        expect(await timeOf(backend, "/d/sub")).toBeGreaterThan(shown);
    });

    it("moves the directory only on the first write after an event touched the open file", async () => {
        for (const path of ["/d", "/other"]) await fs.mkdir(path);
        await fs.writeFile("/d/app.log", "1");
        let traffic = 0;
        const backend = createSharedFsMountBackend(
            mountTarget(fs, {
                writeFile: async (path, source, options) => {
                    const result = await fs.writeFile(path, source, options);
                    // Other writers keep creating files elsewhere while
                    // every commit is in flight.
                    if (path.startsWith("/d/")) {
                        await fs.writeFile(`/other/n${traffic++}`, "n");
                    }
                    return result;
                },
            }),
            { clock }
        );
        const handle = await backend.open("/d/app.log", {
            read: true,
            write: true,
            append: true,
        });
        // Log rotation renames the file under the open descriptor.
        await backend.rename("/d/app.log", "/d/app.log.1");
        await backend.write(handle, encode("2"), 0);
        await backend.flush(handle);
        const settled = await timeOf(backend, "/d");
        for (let round = 0; round < 5; round++) {
            await backend.write(handle, encode("3"), 0);
            await backend.flush(handle);
            expect(await timeOf(backend, "/d"), `round ${round}`).toBe(settled);
        }
        expect(traffic).toBe(6);
        await backend.release(handle);
    });

    it("moves a directory whose served name the mount forgets", async () => {
        for (const path of ["/a", "/b"]) await fs.mkdir(path);
        await fs.writeFile("/a/n.txt", "n");
        const backend = createSharedFsMountBackend(fs, {
            clock,
            servedLimit: 2,
        });
        expect(await namesOf(backend, "/a")).toEqual(["n.txt"]);
        const before = await timeOf(backend, "/a");
        // A third served name forgets the oldest, n.txt in /a: a later move
        // of n.txt could not move /a, so /a moves now.
        await backend.getattr("/b");
        expect(await timeOf(backend, "/a")).toBeGreaterThan(before);
    });

    it("moves the parent after three raced lookups", async () => {
        for (const path of ["/d", "/other"]) await fs.mkdir(path);
        await fs.writeFile("/d/f.txt", "f");
        let race = 0;
        const stat = vi.fn(async (path: string) => {
            const entry = await fs.stat(path);
            if (path === "/d/f.txt") {
                // Unrelated namespace traffic lands during every pass.
                await fs.mkdir(`/other/race-${race++}`);
            }
            return entry;
        });
        const backend = createSharedFsMountBackend(mountTarget(fs, { stat }), {
            clock,
        });
        const before = await timeOf(backend, "/d");
        await backend.getattr("/d/f.txt");
        expect(race).toBe(3);
        expect(await timeOf(backend, "/d")).toBeGreaterThan(before);
    });

    it("moves the parent past a time read during a lookup that gave up on ENOENT", async () => {
        for (const path of ["/d", "/other"]) await fs.mkdir(path);
        let race = 0;
        let during: number | undefined;
        let backend!: SharedFsMountBackend;
        const stat = vi.fn(async (path: string) => {
            const entry = await fs.stat(path);
            if (path === "/d/x.txt" && ++race < 3) {
                // Unrelated namespace traffic lands during every pass.
                await fs.mkdir(`/other/race-${race}`);
            } else if (path === "/d/x.txt") {
                // In the last one another writer creates the name, and a
                // consumer reads the parent's time meanwhile.
                await fs.writeFile("/d/x.txt", "x");
                during = await timeOf(backend, "/d");
            }
            return entry;
        });
        backend = createSharedFsMountBackend(mountTarget(fs, { stat }), {
            clock,
        });
        await backend.readdir("/d");

        await expect(backend.getattr("/d/x.txt")).rejects.toMatchObject({
            code: "ENOENT",
        });
        expect(race).toBe(3);
        expect(await namesOf(backend, "/d")).toEqual(["x.txt"]);
        // The parent time paired with the stale ENOENT does not stay.
        expect(await timeOf(backend, "/d")).toBeGreaterThan(during!);
    });

    it("serves warm directory stats without row queries", async () => {
        await fs.mkdir("/d");
        await fs.writeFile("/d/f.txt", "f");
        const backend = createSharedFsMountBackend(fs, { clock });
        await backend.getattr("/d");
        await backend.readdir("/d", { includeStats: true });
        const queries = fs.program.rowQueries;
        for (let i = 0; i < 10; i++) {
            await backend.getattr("/d");
            await backend.getattr("/");
            await backend.getattr(`/${CONFLICTS_DIR}`);
        }
        expect(fs.program.rowQueries).toBe(queries);
    });

    it("adds no row queries to 500 creates in one directory", async () => {
        const program = fs.program as any;
        const attribute = vi.spyOn(program, "attributeNamespace");
        const createAll = async (dir: string) => {
            await fs.mkdir(dir);
            const queries = program.rowQueries;
            for (let i = 0; i < 500; i++) {
                await fs.writeFile(`${dir}/file-${i}.txt`, "x");
            }
            return program.rowQueries - queries;
        };
        // Warm the shared caches the same way for both runs.
        await createAll("/warmup");
        const unobserved = await createAll("/plain");
        const backend = createSharedFsMountBackend(fs, { clock });
        await backend.readdir("/");
        const observed = await createAll("/mounted");
        expect(observed).toBe(unobserved);
        expect(attribute).not.toHaveBeenCalled();
        backend.dispose();
    }, 240_000);

    it("moves times only on its own syscalls without a namespace feed", async () => {
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { onNamespaceChange: undefined }),
            { clock }
        );
        let root = await timeOf(backend, "/");
        await backend.mkdir("/d");
        expect(await timeOf(backend, "/")).toBeGreaterThan(root);
        root = await timeOf(backend, "/");

        let d = await timeOf(backend, "/d");
        await backend.mkdir("/d/sub");
        expect(await timeOf(backend, "/d")).toBeGreaterThan(d);
        d = await timeOf(backend, "/d");

        // Degraded: other writers' changes are not reflected.
        await fs.writeFile("/d/remote.txt", "remote");
        expect(await timeOf(backend, "/d")).toBe(d);

        await backend.rename("/d/remote.txt", "/moved.txt");
        expect(await timeOf(backend, "/d")).toBeGreaterThan(d);
        expect(await timeOf(backend, "/")).toBeGreaterThan(root);
        d = await timeOf(backend, "/d");
        await backend.symlink("x", "/d/link");
        expect(await timeOf(backend, "/d")).toBeGreaterThan(d);
        d = await timeOf(backend, "/d");
        await backend.unlink("/d/link");
        expect(await timeOf(backend, "/d")).toBeGreaterThan(d);
        root = await timeOf(backend, "/");
        await backend.rmdir("/d/sub");
        await backend.rmdir("/d");
        expect(await timeOf(backend, "/")).toBeGreaterThan(root);
    });

    it("stops following the feed after dispose", async () => {
        await fs.mkdir("/d");
        const backend = createSharedFsMountBackend(fs, { clock });
        const before = await timeOf(backend, "/d");
        backend.dispose();
        backend.dispose();
        await fs.writeFile("/d/late.txt", "late");
        expect(await timeOf(backend, "/d")).toBe(before);
    });
});

/**
 * Resolves once `ready()` holds, re-checked after every document change the
 * replica applies: replication is awaited by event, never by polling.
 */
const whenApplied = (fs: SharedFsHandle, ready: () => Promise<boolean>) =>
    new Promise<void>((resolve, reject) => {
        const events = fs.program.entries.events;
        let running = false;
        let again = false;
        let done = false;
        const check = async () => {
            if (done) return;
            if (running) {
                again = true;
                return;
            }
            running = true;
            try {
                do {
                    again = false;
                    if (await ready()) {
                        done = true;
                        events.removeEventListener("change", check);
                        resolve();
                        return;
                    }
                } while (again);
            } catch (error) {
                done = true;
                events.removeEventListener("change", check);
                reject(error);
            } finally {
                running = false;
            }
        };
        events.addEventListener("change", check);
        void check();
    });

/** The next feed item matching `predicate`; subscribe before acting. */
const nextNamingItem = (
    fs: SharedFsHandle,
    predicate: (item: SharedFsNamespaceNamingChange) => boolean
) =>
    new Promise<SharedFsNamespaceNamingChange>((resolve) => {
        const off = fs.onNamespaceChange((change) => {
            const item = change.naming.find(predicate);
            if (item) {
                off();
                resolve(item);
            }
        });
    });

describe("mount directory times across peers", () => {
    const peers: Peerbit[] = [];

    afterEach(async () => {
        await Promise.allSettled(peers.splice(0).map((peer) => peer.stop()));
    });

    it("moves a served directory for another peer's creates, deletes and moves only", async () => {
        const [a, b] = [await Peerbit.create(), await Peerbit.create()];
        peers.push(a, b);
        await a.dial(b);
        const fsA = await openSharedFs({ peerbit: a, machineLabel: "a" });
        for (const path of ["/d", "/d/sub", "/e"]) await fsA.mkdir(path);
        for (const path of ["/d/f.txt", "/d/y.txt", "/e/m.txt"]) {
            await fsA.writeFile(path, path);
        }
        const fsB = await openSharedFs({
            peerbit: b,
            address: fsA.address,
            machineLabel: "b",
            allowPartialWrites: true,
        });
        await whenApplied(fsB, async () =>
            (
                await Promise.all(
                    ["/d/sub", "/d/f.txt", "/d/y.txt", "/e/m.txt"].map((path) =>
                        fsB.stat(path)
                    )
                )
            ).every(Boolean)
        );

        const [d, e, sub, y, m] = await Promise.all(
            ["/d", "/e", "/d/sub", "/d/y.txt", "/e/m.txt"].map(
                async (path) => (await fsA.stat(path))!
            )
        );
        const backend = createSharedFsMountBackend(fsA, {
            clock: () => 1_700_000_000_500,
        });
        await backend.readdir("/d", { includeStats: true });
        let time = await timeOf(backend, "/d");
        const changed = async () => {
            const next = await timeOf(backend, "/d");
            expect(next).toBeGreaterThan(time);
            time = next;
        };

        let arrived = nextNamingItem(
            fsA,
            (item) => item.parentId === d.nodeId && item.name === "new.txt"
        );
        await fsB.writeFile("/d/new.txt", "new");
        const created = await arrived;
        await changed();

        arrived = nextNamingItem(
            fsA,
            (item) => item.nodeId === created.nodeId && item.deleted
        );
        await fsB.rm("/d/new.txt");
        await arrived;
        await changed();

        arrived = nextNamingItem(
            fsA,
            (item) => item.nodeId === y.nodeId && item.parentId === e.nodeId
        );
        await fsB.rename("/d/y.txt", "/e/y.txt");
        await arrived;
        await changed(); // moved out: /d served y

        arrived = nextNamingItem(
            fsA,
            (item) => item.nodeId === m.nodeId && item.parentId === d.nodeId
        );
        await fsB.rename("/e/m.txt", "/d/m.txt");
        await arrived;
        await changed(); // moved in

        // Neither a content edit of a listed file nor a nested create
        // changes /d's names.
        const edit = await fsB.writeFile("/d/f.txt", "edited");
        await whenApplied(
            fsA,
            async () => (await fsA.stat("/d/f.txt"))?.versionId === edit.id
        );
        expect(await timeOf(backend, "/d")).toBe(time);
        arrived = nextNamingItem(
            fsA,
            (item) => item.parentId === sub.nodeId && item.name === "nested.txt"
        );
        await fsB.writeFile("/d/sub/nested.txt", "nested");
        await arrived;
        expect(await timeOf(backend, "/d")).toBe(time);
        backend.dispose();
    });
});
