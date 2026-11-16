import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    CONFLICTS_DIR,
    FileVersion,
    NamingEvent,
    createSharedFsMountBackend,
    openSharedFs,
    topMostUnreachable,
    type SharedFsHandle,
    type SharedFsMountBackend,
} from "../index.js";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

const root = `/${CONFLICTS_DIR}`;

/** Create `path` holding `text` through `mount`, as a program would. */
const create = async (
    mount: SharedFsMountBackend,
    path: string,
    text: string
) => {
    const handle = await mount.open(path, {
        write: true,
        create: true,
        exclusive: true,
    });
    await mount.write(handle, encode(text), 0);
    await mount.release(handle);
};

/** Replace the bytes of `path` through `mount` (O_TRUNC). */
const overwrite = async (
    mount: SharedFsMountBackend,
    path: string,
    text: string
) => {
    const handle = await mount.open(path, { write: true, truncate: true });
    await mount.write(handle, encode(text), 0);
    await mount.release(handle);
};

/** The bytes at `path` through `mount`, as cat reads them. */
const readThrough = async (mount: SharedFsMountBackend, path: string) => {
    const handle = await mount.open(path, { read: true });
    try {
        return decode(await mount.read(handle, 1 << 20, 0));
    } finally {
        await mount.release(handle);
    }
};

/** readThrough, or undefined while the bytes cannot be read yet. */
const bytesAt = (mount: SharedFsMountBackend, path: string) =>
    readThrough(mount, path).catch(() => undefined);

const namesOf = async (mount: SharedFsMountBackend, path: string) =>
    (await mount.readdir(path)).map((entry) => entry.name).sort();

/**
 * Resolves once `ready()` holds, rechecked after every document change the
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

/** Resolves once `peer` has no connection: checked now and on each close. */
const disconnected = (peer: Peerbit) =>
    new Promise<void>((resolve) => {
        const check = () => {
            if (peer.libp2p.getConnections().length > 0) return;
            peer.libp2p.removeEventListener("connection:close", check);
            resolve();
        };
        peer.libp2p.addEventListener("connection:close", check);
        check();
    });

/** The naming event that currently places a path's node. */
const winnerOf = async (fs: SharedFsHandle, path: string) =>
    (await (fs.program as any).resolvePath(path)).winner as {
        id: string;
        nodeId: string;
        causalDepth: bigint;
    };

/** Another writer's first version of node `nodeId`: the bytes at `donor`. */
const versionOf = async (
    fs: SharedFsHandle,
    donor: string,
    nodeId: string,
    id: string
) => {
    const [head] = (await fs.stat(donor))!.headVersionIds!;
    const bytes = (await fs.program.entries.index.get(head, {
        local: true,
        remote: false,
        resolve: true,
    })) as unknown as FileVersion;
    return new FileVersion({
        id,
        nodeId,
        parentVersionIds: [],
        causalDepth: 1n,
        contentHash: bytes.contentHash,
        size: bytes.size,
        mode: bytes.mode,
        mtime: bytes.mtime,
        chunkIds: bytes.chunkIds,
        createdAt: 2n,
        authorKey: "remote",
        machineLabel: "desktop",
    });
};

describe("mount conflict tree", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;

    beforeEach(async () => {
        peer = await Peerbit.create();
        fs = await openSharedFs({ peerbit: peer, machineLabel: "laptop" });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await peer.stop();
    });

    it("refuses every write inside the tree with EROFS, ready or not", async () => {
        await fs.writeFile("/plain.txt", "plain");
        await fs.mkdir("/plain-dir");
        const base = await fs.writeFile("/forked.txt", "base");
        for (const side of ["left", "right"]) {
            await fs.writeFile("/forked.txt", side, {
                baseVersionIds: [base.id],
            });
        }
        // A restored directory claims a name another one took meanwhile.
        await fs.mkdir("/shadow");
        const first = (await fs.stat("/shadow"))!.nodeId;
        await fs.rm("/shadow");
        await fs.mkdir("/shadow");
        await fs.resolveNamingConflict(first, { type: "restore" });

        // The same mount target, but before its first view settled.
        const unready = new Proxy(fs, {
            get: (target, key) =>
                key === "bootstrapStatus"
                    ? () => ({ phase: "overlay-active", writeReady: false })
                    : (() => {
                          const value = Reflect.get(target, key, target);
                          return typeof value === "function"
                              ? value.bind(target)
                              : value;
                      })(),
        });
        for (const mount of [
            createSharedFsMountBackend(fs),
            createSharedFsMountBackend(unready),
        ]) {
            const names = await namesOf(mount, root);
            expect(names.map((name) => name.split(" ")[0])).toEqual([
                "content",
                "content",
                "duplicate-name",
            ]);
            const file = `${root}/${names[0]}`;
            const dir = `${root}/${names[2]}`;
            expect((await mount.getattr(dir)).kind).toBe("directory");
            const attempts: [string, () => Promise<unknown>][] = [
                [
                    "create",
                    () =>
                        mount.open(`${root}/new.txt`, {
                            write: true,
                            create: true,
                        }),
                ],
                [
                    "create in a directory entry",
                    () =>
                        mount.open(`${dir}/new.txt`, {
                            write: true,
                            create: true,
                            exclusive: true,
                        }),
                ],
                ["open to write", () => mount.open(file, { write: true })],
                [
                    "open to read and write",
                    () => mount.open(file, { read: true, write: true }),
                ],
                [
                    "open to append",
                    () => mount.open(file, { write: true, append: true }),
                ],
                [
                    "open to truncate",
                    () => mount.open(file, { write: true, truncate: true }),
                ],
                ["mkdir", () => mount.mkdir(`${root}/new`)],
                ["mkdir in a directory entry", () => mount.mkdir(`${dir}/new`)],
                ["mkdir the tree", () => mount.mkdir(root)],
                ["truncate", () => mount.truncate(file, 0)],
                ["chmod", () => mount.setattr(file, { mode: 0o755 })],
                ["utimens", () => mount.setattr(file, { mtimeMs: 1 })],
                ["chmod the tree", () => mount.setattr(root, { mode: 0o700 })],
                [
                    "rename within",
                    () => mount.rename(file, `${root}/renamed.txt`),
                ],
                ["rename out", () => mount.rename(file, "/out.txt")],
                [
                    "rename in",
                    () => mount.rename("/plain.txt", `${root}/in.txt`),
                ],
                [
                    "rename into a directory entry",
                    () => mount.rename("/plain.txt", `${dir}/in.txt`),
                ],
                ["rename the tree", () => mount.rename(root, "/elsewhere")],
                [
                    "rename over the tree",
                    () => mount.rename("/plain-dir", root),
                ],
                ["unlink", () => mount.unlink(file)],
                ["rmdir", () => mount.rmdir(dir)],
                ["rmdir the tree", () => mount.rmdir(root)],
                ["symlink", () => mount.symlink("plain.txt", `${root}/ln`)],
            ];
            const outcomes: [string, string][] = [];
            for (const [label, attempt] of attempts) {
                outcomes.push([
                    label,
                    await attempt().then(
                        () => "done",
                        (error) => error.code
                    ),
                ]);
            }
            expect(outcomes).toEqual(
                attempts.map(([label]) => [label, "EROFS"])
            );
            expect(await namesOf(mount, root)).toEqual(names);
            expect(await readThrough(mount, "/plain.txt")).toBe("plain");
            expect(await namesOf(mount, "/")).toEqual([
                "forked.txt",
                "plain-dir",
                "plain.txt",
                "shadow",
            ]);
        }
    });

    it("is never listed in /, and scans once per change", async () => {
        await fs.writeFile("/plain.txt", "plain");
        const conflicts = vi.spyOn(fs, "conflicts");
        const naming = vi.spyOn(fs, "namingConflicts");
        const mount = createSharedFsMountBackend(fs);

        // Listing / and looking up the tree itself scan nothing.
        for (let i = 0; i < 3; i++) {
            expect(await namesOf(mount, "/")).toEqual(["plain.txt"]);
            expect(await mount.getattr(root)).toMatchObject({
                kind: "directory",
                mode: 0o040755,
            });
        }
        expect(conflicts).not.toHaveBeenCalled();
        expect(naming).not.toHaveBeenCalled();

        // The first read of the tree scans once; later ones reuse it.
        for (let i = 0; i < 3; i++) {
            expect(await mount.readdir(root)).toEqual([]);
            await expect(
                mount.getattr(`${root}/missing`)
            ).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(conflicts).toHaveBeenCalledTimes(1);
        expect(naming).toHaveBeenCalledTimes(1);

        // A save that forks nothing changes no entry: still one scan.
        await fs.writeFile("/plain.txt", "edited");
        expect(await mount.readdir(root)).toEqual([]);
        expect(conflicts).toHaveBeenCalledTimes(1);

        // A fork does: one more scan shows it.
        const [base] = (await fs.stat("/plain.txt"))!.headVersionIds!;
        for (const side of ["left", "right"]) {
            await fs.writeFile("/plain.txt", side, { baseVersionIds: [base] });
        }
        expect(await namesOf(mount, root)).toHaveLength(2);
        expect(await namesOf(mount, root)).toHaveLength(2);
        expect(conflicts).toHaveBeenCalledTimes(2);
        expect(naming).toHaveBeenCalledTimes(2);
    });

    it("checks only the entry a lookup names while other files change, and scans to list", async () => {
        const base = await fs.writeFile("/c.txt", "base");
        const heads: string[] = [];
        for (const side of ["left", "right"]) {
            heads.push(
                (
                    await fs.writeFile("/c.txt", side, {
                        baseVersionIds: [base.id],
                    })
                ).id
            );
        }
        await fs.writeFile("/dup.txt", "first life");
        const first = (await fs.stat("/dup.txt"))!.nodeId;
        await fs.rm("/dup.txt");
        await fs.writeFile("/dup.txt", "second life");
        await fs.resolveNamingConflict(first, { type: "restore" });
        const conflicts = vi.spyOn(fs, "conflicts");
        const naming = vi.spyOn(fs, "namingConflicts");
        const mount = createSharedFsMountBackend(fs);
        const names = await namesOf(mount, root);
        expect(names.map((name) => name.split(" ")[0])).toEqual([
            "content",
            "content",
            "duplicate-name",
        ]);
        const bytes = new Map<string, string>();
        for (const name of names) {
            bytes.set(name, await readThrough(mount, `${root}/${name}`));
        }
        let changes = 0;
        const elsewhere = () =>
            fs.writeFile(`/elsewhere-${changes++}.txt`, "x");

        // A create elsewhere before each lookup, open and read: each checks
        // its own entry, and none scans.
        for (const name of names) {
            await elsewhere();
            expect(await mount.getattr(`${root}/${name}`)).toMatchObject({
                kind: "file",
                size: bytes.get(name)!.length,
            });
            await elsewhere();
            expect(await readThrough(mount, `${root}/${name}`)).toBe(
                bytes.get(name)
            );
        }
        // Names no entry can have (Finder's and Explorer's probes among
        // them) are missing without a look.
        await elsewhere();
        for (const probe of [
            ".DS_Store",
            `._${names[0]}`,
            "desktop.ini",
            "Thumbs.db",
            "content",
            `${names[0]}.swp`,
        ]) {
            await expect(
                mount.getattr(`${root}/${probe}`)
            ).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(conflicts).toHaveBeenCalledTimes(1);
        expect(naming).toHaveBeenCalledTimes(1);

        // A resolved conflict's entries are gone on their next lookup.
        await fs.resolveConflict("/c.txt", heads[0]);
        for (const name of names.slice(0, 2)) {
            await expect(
                mount.getattr(`${root}/${name}`)
            ).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(conflicts).toHaveBeenCalledTimes(1);

        // Listing scans, once per change.
        expect(await namesOf(mount, root)).toEqual([names[2]]);
        expect(await namesOf(mount, root)).toEqual([names[2]]);
        expect(conflicts).toHaveBeenCalledTimes(2);

        // A name of the right form the last scan lacks may be a new entry:
        // after a change it scans, then the scan answers.
        await elsewhere();
        const unknown = `content nothing.txt laptop 20261116T000000Z ${"0".repeat(12)}.txt`;
        for (let i = 0; i < 2; i++) {
            await expect(
                mount.getattr(`${root}/${unknown}`)
            ).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(conflicts).toHaveBeenCalledTimes(3);
        expect(naming).toHaveBeenCalledTimes(3);
    });

    it("keeps a content entry's name when a chmod or touch replaces its head", async () => {
        const base = await fs.writeFile("/c.txt", "base");
        for (const side of ["left", "right"]) {
            await fs.writeFile("/c.txt", side, { baseVersionIds: [base.id] });
        }
        const mount = createSharedFsMountBackend(fs);
        const names = await namesOf(mount, root);
        expect(names).toHaveLength(2);
        const visible = await readThrough(mount, "/c.txt");

        for (const patch of [{ mtimeMs: 1_700_000_000_000 }, { mode: 0o755 }]) {
            const before = (await fs.stat("/c.txt"))!.versionId;
            await mount.setattr("/c.txt", patch);
            // A new head holds the same bytes: still the same two contents.
            expect((await fs.stat("/c.txt"))!.versionId).not.toBe(before);
            expect(await fs.conflicts("/c.txt")).toHaveLength(1);
            for (const name of names) {
                expect(await mount.getattr(`${root}/${name}`)).toMatchObject({
                    kind: "file",
                });
            }
            expect(await namesOf(mount, root)).toEqual(names);
        }
        expect(
            (
                await Promise.all(
                    names.map((name) => readThrough(mount, `${root}/${name}`))
                )
            ).sort()
        ).toEqual(["left", "right"]);
        expect(await readThrough(mount, "/c.txt")).toBe(visible);
    });

    it("shows a hidden claimant once its first content lands, and not after its content leaves", async () => {
        await fs.writeFile("/dup.txt", "visible");
        await fs.writeFile("/donor.txt", "hidden claimant");
        // Another writer's file claims the name; its naming lands first,
        // and a file with no content is not shown.
        const nodeId = "file:late-claimant";
        await fs.program.entries.put(
            new NamingEvent({
                id: "naming:~late-claimant", // sorts last: it loses the name
                nodeId,
                parentId: "root",
                name: "dup.txt",
                parentNamingIds: [],
                causalDepth: 1n,
                createdAt: 2n,
                authorKey: "remote",
                machineLabel: "desktop",
            }),
            { unique: true }
        );
        const mount = createSharedFsMountBackend(fs);
        // The scan looked the claimant up: its rows are warm now.
        expect(await mount.readdir(root)).toEqual([]);

        // Its first content: no naming change and no fork in that batch.
        const version = await versionOf(
            fs,
            "/donor.txt",
            nodeId,
            "version:late"
        );
        await fs.program.entries.put(version, { unique: true });
        const [name, ...others] = await namesOf(mount, root);
        expect(others).toEqual([]);
        expect(name).toMatch(
            /^duplicate-name dup\.txt desktop 19700101T000000Z [0-9a-f]{12}\.txt$/
        );
        expect(await readThrough(mount, `${root}/${name}`)).toBe(
            "hidden claimant"
        );
        expect(await readThrough(mount, "/dup.txt")).toBe("visible");

        // Its only version leaves: hidden again, so its entry goes.
        await fs.program.entries.del(version.id);
        expect(await mount.readdir(root)).toEqual([]);
        await expect(mount.getattr(`${root}/${name}`)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("lists a hidden directory under the handle's ignore rules, as / would", async () => {
        const other = await Peerbit.create();
        try {
            const ignoring = await openSharedFs({
                peerbit: other,
                machineLabel: "laptop",
                ignore: { patterns: ["*.log", "build/"] },
            });
            await ignoring.mkdir("/parent");
            await ignoring.mkdir("/parent/proj");
            await ignoring.writeFile("/parent/proj/a.txt", "a");
            // A peer without the rules wrote these.
            await ignoring.program.writeFile("/parent/proj/debug.log", "log");
            await ignoring.program.mkdir("/parent/proj/build");
            const mount = createSharedFsMountBackend(ignoring);
            expect(await namesOf(mount, "/parent/proj")).toEqual(["a.txt"]);

            // Another writer deleted /parent, so /parent/proj is unreachable.
            const parent = await winnerOf(ignoring, "/parent");
            await ignoring.program.entries.put(
                new NamingEvent({
                    id: "naming:parent-removed",
                    nodeId: parent.nodeId,
                    parentId: "root",
                    name: "parent",
                    deleted: true,
                    parentNamingIds: [parent.id],
                    causalDepth: parent.causalDepth + 1n,
                    createdAt: 5n,
                    authorKey: "remote",
                    machineLabel: "desktop",
                }),
                { unique: true }
            );
            const [entry] = await namesOf(mount, root);
            expect(entry).toMatch(/^unreachable parent／proj laptop /);
            const dir = `${root}/${entry}`;
            // Ignored names stay out of the listing, and a name reaches one.
            expect(await namesOf(mount, dir)).toEqual(["a.txt"]);
            expect(await readThrough(mount, `${dir}/debug.log`)).toBe("log");
        } finally {
            await other.stop();
        }
    });

    it("shows a move cycle once, from its least id, and stops browsing where it repeats", async () => {
        await fs.mkdir("/x");
        await fs.mkdir("/y");
        await fs.writeFile("/x/inside-x.txt", "x");
        await fs.writeFile("/y/inside-y.txt", "y");
        const [x, y] = [await winnerOf(fs, "/x"), await winnerOf(fs, "/y")];
        // Two writers each moved one directory into the other.
        for (const [moved, into, name] of [
            [x, y, "x"],
            [y, x, "y"],
        ] as const) {
            await fs.program.entries.put(
                new NamingEvent({
                    id: `naming:${name}-moved`,
                    nodeId: moved.nodeId,
                    parentId: into.nodeId,
                    name,
                    parentNamingIds: [moved.id],
                    causalDepth: moved.causalDepth + 1n,
                    createdAt: 1n,
                    authorKey: "remote",
                    machineLabel: "desktop",
                }),
                { unique: true }
            );
        }
        const mount = createSharedFsMountBackend(fs);
        expect(await namesOf(mount, "/")).toEqual([]);

        // Every node of the cycle is unreachable; one entry stands for it.
        const [entry, ...others] = await mount.readdir(root);
        expect(others).toEqual([]);
        expect(entry).toMatchObject({ kind: "directory" });
        expect(entry.name).toMatch(
            /^unreachable \S+ desktop 19700101T000000Z [0-9a-f]{12}$/
        );
        const [top, other] =
            [x.nodeId, y.nodeId].sort()[0] === x.nodeId
                ? ["x", "y"]
                : ["y", "x"];
        const dir = `${root}/${entry.name}`;
        expect(await namesOf(mount, dir)).toEqual([`inside-${top}.txt`, other]);
        // The way back to the entry's own node is not shown again.
        expect(await namesOf(mount, `${dir}/${other}`)).toEqual([
            `inside-${other}.txt`,
        ]);
        await expect(
            mount.getattr(`${dir}/${other}/${top}`)
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(
            await readThrough(mount, `${dir}/${other}/inside-${other}.txt`)
        ).toBe(other);
        await expect(
            mount.readdir(`${dir}/inside-${top}.txt`)
        ).rejects.toMatchObject({ code: "ENOTDIR" });
    });
});

describe("top-most unreachable nodes", () => {
    /** A parent map that counts its lookups. */
    class Counted extends Map<string, string> {
        lookups = 0;
        get(key: string) {
            this.lookups++;
            return super.get(key);
        }
        has(key: string) {
            this.lookups++;
            return super.has(key);
        }
    }

    it("are each chain's top, each cycle's least id, never a node below", () => {
        const parents = new Counted([
            ["c", "b"],
            ["b", "a"],
            ["a", "dir:deleted"],
            ["t", "x"], // below the cycle x -> y -> z -> x
            ["y", "z"],
            ["x", "y"],
            ["z", "x"],
            ["s", "s"],
        ]);
        expect([...topMostUnreachable(parents)].sort()).toEqual([
            "a",
            "s",
            "x",
        ]);
    });

    it("take one pass, however deep a chain is", () => {
        for (const order of ["top first", "top last"]) {
            const n = 1000;
            const chain = Array.from(
                { length: n },
                (_, i) =>
                    [
                        `n${String(i).padStart(4, "0")}`,
                        i === 0 ? "gone" : `n${String(i - 1).padStart(4, "0")}`,
                    ] as [string, string]
            );
            const parents = new Counted(
                order === "top first" ? chain : chain.reverse()
            );
            expect([...topMostUnreachable(parents)]).toEqual(["n0000"]);
            expect(parents.lookups).toBeLessThanOrEqual(6 * n);
        }
    });
});

describe("mount conflict tree across two replicas", () => {
    const peers: Peerbit[] = [];
    const mounts: (SharedFsMountBackend & { dispose(): void })[] = [];

    afterEach(async () => {
        for (const mount of mounts.splice(0)) mount.dispose();
        await Promise.allSettled(peers.splice(0).map((peer) => peer.stop()));
    });

    /**
     * Two replicas of one filesystem with a mount each, and a partition
     * switch: while it is on, the gater refuses every connection.
     */
    const replicas = async () => {
        let partitioned = false;
        const deny = () => partitioned;
        const create = async () => {
            const created = await Peerbit.create({
                libp2p: {
                    connectionGater: {
                        denyDialPeer: deny,
                        denyDialMultiaddr: deny,
                        denyInboundConnection: deny,
                        denyOutboundConnection: deny,
                        denyInboundEncryptedConnection: deny,
                        denyOutboundEncryptedConnection: deny,
                        denyInboundUpgradedConnection: deny,
                        denyOutboundUpgradedConnection: deny,
                    },
                },
            });
            peers.push(created);
            return created;
        };
        const [a, b] = [await create(), await create()];
        await a.dial(b);
        // As in multi-peer.test.ts: a partitioned peer's block announcement
        // dials its bootstraps without a timeout, so it announces to none.
        for (const each of [a, b]) each.services.fanout.setBootstraps([]);
        const fsA = await openSharedFs({ peerbit: a, machineLabel: "laptop" });
        const fsB = await openSharedFs({
            peerbit: b,
            address: fsA.address,
            machineLabel: "desktop",
            allowPartialWrites: true,
        });
        const mountA = createSharedFsMountBackend(fsA);
        const mountB = createSharedFsMountBackend(fsB);
        mounts.push(mountA, mountB);
        return {
            fsA,
            fsB,
            mountA,
            mountB,
            partition: async () => {
                partitioned = true;
                await a.hangUp(b.identity.publicKey);
                await Promise.all([disconnected(a), disconnected(b)]);
            },
            heal: async () => {
                partitioned = false;
                await a.dial(b);
            },
        };
    };

    it("keeps both concurrent creates of a name readable: one at its path, the other in the tree", async () => {
        const { fsA, fsB, mountA, mountB, partition, heal } = await replicas();
        await mountA.mkdir("/shared");
        await whenApplied(
            fsB,
            async () =>
                (await mountB.getattr("/shared").catch(() => undefined))
                    ?.kind === "directory"
        );
        // Read once before: only the feed can make the mount scan again.
        expect(await mountA.readdir(root)).toEqual([]);
        await partition();
        await create(mountA, "/shared/notes.txt", "from the laptop");
        await create(mountB, "/shared/notes.txt", "from the desktop");
        await heal();
        const settled = (fs: SharedFsHandle, mount: SharedFsMountBackend) =>
            whenApplied(fs, async () => {
                const names = await namesOf(mount, root).catch(() => []);
                return (
                    names.length === 1 &&
                    (await bytesAt(mount, "/shared/notes.txt")) !== undefined &&
                    (await bytesAt(mount, `${root}/${names[0]}`)) !== undefined
                );
            });
        await Promise.all([settled(fsA, mountA), settled(fsB, mountB)]);

        const [name] = await namesOf(mountA, root);
        // Both replicas name the entry alike: a name depends on it alone.
        expect(await namesOf(mountB, root)).toEqual([name]);
        expect(name).toMatch(
            /^duplicate-name shared\uff0fnotes\.txt (laptop|desktop) \d{8}T\d{6}Z [0-9a-f]{12}\.txt$/
        );
        const shown = await readThrough(mountA, "/shared/notes.txt");
        const hidden = await readThrough(mountA, `${root}/${name}`);
        expect([shown, hidden].sort()).toEqual([
            "from the desktop",
            "from the laptop",
        ]);
        // The entry names the hidden claimant's writer.
        expect(name).toContain(
            hidden === "from the laptop" ? " laptop " : " desktop "
        );
        expect(await mountA.getattr(`${root}/${name}`)).toMatchObject({
            kind: "file",
            size: hidden.length,
            mode: 0o100644,
        });
        expect(await namesOf(mountA, "/")).toEqual(["shared"]);
        expect(await namesOf(mountA, "/shared")).toEqual(["notes.txt"]);

        // Moving the hidden claimant aside resolves it: its entry leaves.
        const conflict = (await fsA.namingConflicts()).find(
            (candidate) => candidate.type === "duplicate-name"
        )!;
        await fsA.resolveNamingConflict(conflict.shadowedNodeIds![0], {
            type: "move",
            to: "/shared/notes (2).txt",
        });
        expect(await mountA.readdir(root)).toEqual([]);
        expect(await namesOf(mountA, "/shared")).toEqual([
            "notes (2).txt",
            "notes.txt",
        ]);
        expect(await readThrough(mountA, "/shared/notes (2).txt")).toBe(hidden);
        expect(await readThrough(mountA, "/shared/notes.txt")).toBe(shown);
    });

    it("shows the bytes another replica saved over a delete it had not seen", async () => {
        const { fsA, fsB, mountA, mountB, partition, heal } = await replicas();
        await create(mountA, "/plan.md", "v1");
        await whenApplied(
            fsB,
            async () => (await bytesAt(mountB, "/plan.md")) === "v1"
        );
        // Read once before: only the feed can make the mount scan again.
        expect(await mountA.readdir(root)).toEqual([]);
        await partition();
        await mountA.unlink("/plan.md");
        await overwrite(mountB, "/plan.md", "v2 from the desktop");
        await heal();
        // The save extends the only content head, so it forks nothing.
        await whenApplied(fsA, async () => {
            const names = await namesOf(mountA, root).catch(() => []);
            return (
                names.length === 1 &&
                (await bytesAt(mountA, `${root}/${names[0]}`)) ===
                    "v2 from the desktop"
            );
        });

        // The delete stays visible; the edit is readable in the tree.
        await expect(mountA.getattr("/plan.md")).rejects.toMatchObject({
            code: "ENOENT",
        });
        const [name] = await namesOf(mountA, root);
        expect(name).toMatch(
            /^delete-vs-edit plan\.md desktop \d{8}T\d{6}Z [0-9a-f]{12}\.md$/
        );

        // Restoring brings the edit back at its path and empties the tree.
        const conflict = (await fsA.namingConflicts()).find(
            (candidate) => candidate.type === "delete-vs-edit"
        )!;
        await fsA.resolveNamingConflict(conflict.nodeId, { type: "restore" });
        expect(await mountA.readdir(root)).toEqual([]);
        expect(await readThrough(mountA, "/plan.md")).toBe(
            "v2 from the desktop"
        );
    });

    it("shows a directory another replica made inside one it removed, with its files", async () => {
        const { fsA, fsB, mountA, mountB, partition, heal } = await replicas();
        await mountA.mkdir("/docs");
        await whenApplied(
            fsB,
            async () =>
                (await mountB.getattr("/docs").catch(() => undefined))?.kind ===
                "directory"
        );
        expect(await mountA.readdir(root)).toEqual([]);
        await partition();
        await mountA.rmdir("/docs");
        await mountB.mkdir("/docs/drafts");
        await create(mountB, "/docs/drafts/today.md", "draft from the desktop");
        await heal();
        await whenApplied(fsA, async () => {
            const names = await namesOf(mountA, root).catch(() => []);
            return (
                names.length === 1 &&
                (await bytesAt(mountA, `${root}/${names[0]}/today.md`)) ===
                    "draft from the desktop"
            );
        });

        // Only the top-most unreachable node is an entry; the rest is inside.
        const [entry] = await mountA.readdir(root, { includeStats: true });
        expect(entry).toMatchObject({
            kind: "directory",
            stat: { mode: 0o040755 },
        });
        expect(entry.name).toMatch(
            /^unreachable docs／drafts desktop \d{8}T\d{6}Z [0-9a-f]{12}$/
        );
        const dir = `${root}/${entry.name}`;
        expect(await mountA.readdir(dir)).toEqual([
            { name: "today.md", kind: "file" },
        ]);
        expect(await mountA.getattr(`${dir}/today.md`)).toMatchObject({
            kind: "file",
            size: "draft from the desktop".length,
        });
        await expect(mountA.getattr("/docs")).rejects.toMatchObject({
            code: "ENOENT",
        });

        // Moving it back into the namespace resolves it.
        const conflict = (await fsA.namingConflicts()).find(
            (candidate) =>
                candidate.type === "unreachable" &&
                candidate.path === "/docs/drafts"
        )!;
        await fsA.resolveNamingConflict(conflict.nodeId, {
            type: "move",
            to: "/drafts",
        });
        expect(await mountA.readdir(root)).toEqual([]);
        expect(await readThrough(mountA, "/drafts/today.md")).toBe(
            "draft from the desktop"
        );
    });
});
