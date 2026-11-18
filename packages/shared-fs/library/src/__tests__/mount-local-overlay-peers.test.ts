import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    createSharedFsMountBackend,
    openMountLocalOverlay,
    openSharedFs,
    type SharedFsHandle,
    type SharedFsMountBackend,
} from "../index.js";

/**
 * A mount's local overlay between two replicas on loopback TCP: a package
 * install's worth of local files reaches neither the writer's log nor the
 * other replica, while a shared write right after it does. Every wait
 * resolves on an event and only gives up at a labelled deadline.
 */

/** Give-up bound for one awaited event; never a pass condition. */
const STEP_MS = 30_000;

const encode = (text: string) => new TextEncoder().encode(text);

/** `promise`, or a rejection naming `label` once STEP_MS pass. */
const within = async <T>(promise: Promise<T>, label: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(`gave up after ${STEP_MS} ms: ${label}`)
                        ),
                    STEP_MS
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

/** The ids of every document `fs` indexes, sorted. */
const indexedIds = async (fs: SharedFsHandle) =>
    (
        await fs.program.entries.index
            .iterate(
                { query: [] },
                { local: true, remote: false, resolve: false }
            )
            .all()
    )
        .map((row: { id: string }) => row.id)
        .sort();

/** The hashes of every entry in `fs`'s log, sorted. */
const logHashes = async (fs: SharedFsHandle) =>
    (await fs.program.entries.log.log.toArray())
        .map((entry) => entry.hash)
        .sort();

/** Resolves once `fs` indexes exactly the documents `source` does. */
const untilIndexMatches = (fs: SharedFsHandle, source: SharedFsHandle) => {
    const events = fs.program.entries.events;
    let check: (() => void) | undefined;
    const matched = new Promise<void>((resolve, reject) => {
        let checking = false;
        let again = false;
        check = () => {
            if (checking) {
                again = true;
                return;
            }
            checking = true;
            void (async () => {
                do {
                    again = false;
                    const [ids, expected] = await Promise.all([
                        indexedIds(fs),
                        indexedIds(source),
                    ]);
                    if (JSON.stringify(ids) === JSON.stringify(expected)) {
                        resolve();
                        return;
                    }
                } while (again);
            })()
                .catch(reject)
                .finally(() => {
                    checking = false;
                });
        };
        events.addEventListener("change", check);
        check();
    });
    return within(
        matched,
        "the other replica indexes the writer's documents"
    ).finally(() => events.removeEventListener("change", check!));
};

/** Resolves once `fs` has seen another replica join (it can then persist). */
const untilReplicaSeen = (fs: SharedFsHandle) => {
    const events = fs.program.entries.log.events;
    let check: (() => void) | undefined;
    const seen = new Promise<void>((resolve) => {
        check = () => {
            if (fs.pendingLocalWrites().remoteReplicaSeen) resolve();
        };
        events.addEventListener("replicator:join", check);
        check();
    });
    return within(seen, "the other replica joins").finally(() =>
        events.removeEventListener("replicator:join", check!)
    );
};

/**
 * From now on: the documents `fs` adds that are not in `held`, and every
 * document it removes. A document already held can still be announced
 * late (its change event follows the index write), so it is not counted.
 */
const watchChanges = (fs: SharedFsHandle, held: readonly string[]) => {
    const known = new Set(held);
    const added = new Set<string>();
    const removed = new Set<string>();
    const waiters = new Set<() => void>();
    const listener = (event: any) => {
        for (const doc of event?.detail?.added ?? []) {
            if (!known.has(doc.id)) added.add(doc.id);
        }
        for (const doc of event?.detail?.removed ?? []) removed.add(doc.id);
        for (const waiter of [...waiters]) waiter();
    };
    const events = fs.program.entries.events;
    events.addEventListener("change", listener);
    const byKind = (ids: Set<string>) => {
        const counts: Record<string, number> = {};
        for (const id of ids) {
            const kind = id.slice(0, id.indexOf(":"));
            counts[kind] = (counts[kind] ?? 0) + 1;
        }
        return counts;
    };
    return {
        added: () => [...added].sort(),
        removed: () => [...removed].sort(),
        byKind: () => ({ added: byKind(added), removed: byKind(removed) }),
        /** Resolves once every one of `ids` was added. */
        untilAdded: (ids: readonly string[], label: string) => {
            let waiter: (() => void) | undefined;
            const done = new Promise<void>((resolve) => {
                waiter = () => {
                    if (ids.every((id) => added.has(id))) resolve();
                };
                waiters.add(waiter);
                waiter();
            });
            return within(done, label).finally(() => waiters.delete(waiter!));
        },
        stop: () => events.removeEventListener("change", listener),
    };
};

const writeThrough = async (
    backend: SharedFsMountBackend,
    path: string,
    text: string
) => {
    const handle = await backend.open(path, {
        write: true,
        create: true,
        truncate: true,
    });
    await backend.write(handle, encode(text), 0);
    await backend.release(handle);
};

/**
 * 20 packages of 10 files, with bin links, exec bits and staged renames;
 * then one package is retired (renamed aside) and removed, as npm does.
 */
const installPackages = async (backend: SharedFsMountBackend) => {
    await backend.mkdir("/node_modules");
    await backend.mkdir("/node_modules/.bin");
    for (let pkg = 0; pkg < 20; pkg++) {
        const dir = `/node_modules/pkg-${pkg}`;
        await backend.mkdir(dir);
        await backend.mkdir(`${dir}/lib`);
        for (let file = 0; file < 9; file++) {
            await writeThrough(
                backend,
                `${dir}/lib/file-${file}.js`,
                `module.exports = ${pkg * 10 + file};\n`
            );
        }
        await writeThrough(
            backend,
            `${dir}/.package.json.tmp`,
            `{"name":"pkg-${pkg}"}`
        );
        await backend.rename(`${dir}/.package.json.tmp`, `${dir}/package.json`);
        await backend.setattr(`${dir}/lib/file-0.js`, {
            mode: 0o755,
            mtimeMs: 499_162_500_000,
        });
        await backend
            .symlink(
                `../pkg-${pkg}/lib/file-0.js`,
                `/node_modules/.bin/pkg-${pkg}`
            )
            .catch((error: { code?: string }) => {
                // A Windows account without the symlink privilege: EPERM.
                if (error?.code !== "EPERM") throw error;
            });
    }
    const retired = "/node_modules/.pkg-19-retired";
    await backend.rename("/node_modules/pkg-19", retired);
    await backend
        .unlink("/node_modules/.bin/pkg-19")
        .catch((error: { code?: string }) => {
            // Never made where the host refused symlinks.
            if (error?.code !== "ENOENT") throw error;
        });
    for (let file = 0; file < 9; file++) {
        await backend.unlink(`${retired}/lib/file-${file}.js`);
    }
    await backend.rmdir(`${retired}/lib`);
    await backend.unlink(`${retired}/package.json`);
    await backend.rmdir(retired);
};

describe("mount local overlay between replicas", () => {
    const peers: Peerbit[] = [];
    const directories: string[] = [];
    const backends: Array<{ dispose(): void }> = [];

    afterEach(async () => {
        for (const backend of backends.splice(0)) backend.dispose();
        await Promise.allSettled(peers.splice(0).map((peer) => peer.stop()));
        for (const directory of directories.splice(0)) {
            await rm(directory, {
                recursive: true,
                force: true,
                maxRetries: 10,
                retryDelay: 200,
            });
        }
    });

    const temporaryDirectory = async (label: string) => {
        const directory = await mkdtemp(
            join(tmpdir(), `shared-fs-local-overlay-peers-${label}-`)
        );
        directories.push(directory);
        return directory;
    };

    // On disk: a replica acknowledges an entry once it persisted it.
    const createPeer = async (label: string) => {
        const peer = await Peerbit.create({
            directory: await temporaryDirectory(label),
            libp2p: { addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] } },
        });
        peers.push(peer);
        return peer;
    };

    const open = (peerbit: Peerbit, label: string, address?: string) =>
        openSharedFs({
            peerbit,
            ...(address ? { address, allowPartialWrites: true } : {}),
            machineLabel: label,
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
            snapshot: { disabled: true },
        });

    it("keeps a package install off the other replica while a shared write still reaches it", async () => {
        const a = await createPeer("a");
        const b = await createPeer("b");
        await a.dial(b.getMultiaddrs());
        const fsA = await open(a, "a");
        const fsB = await open(b, "b", fsA.address);
        await untilReplicaSeen(fsA);

        const backend = createSharedFsMountBackend(fsA, {
            localOverlay: await openMountLocalOverlay({
                directory: await temporaryDirectory("overlay"),
                address: fsA.address,
                sealedNames: fsA.program.sealedIgnoredNames,
            }),
        });
        backends.push(backend);

        // Settle: B indexes all of A's documents and acknowledged its entries.
        await writeThrough(backend, "/package.json", '{"name":"app"}');
        await untilIndexMatches(fsB, fsA);
        await fsA.persistLocalWrites({ timeout: STEP_MS });
        expect(fsA.pendingLocalWrites().entries).toBe(0);
        const before = {
            idsA: await indexedIds(fsA),
            hashesA: await logHashes(fsA),
            idsB: await indexedIds(fsB),
            hashesB: await logHashes(fsB),
        };
        expect(before.idsB).toEqual(before.idsA);

        const changesOnB = watchChanges(fsB, before.idsB);
        try {
            await installPackages(backend);
            // .bin and 19 packages remain.
            expect((await backend.readdir("/node_modules")).length).toBe(20);

            // A published nothing, so there is nothing to send to B.
            expect(fsA.pendingLocalWrites().entries).toBe(0);
            expect(await indexedIds(fsA)).toEqual(before.idsA);
            expect(await logHashes(fsA)).toEqual(before.hashesA);
            expect(changesOnB.byKind()).toEqual({ added: {}, removed: {} });
            expect(await indexedIds(fsB)).toEqual(before.idsB);
            expect(await logHashes(fsB)).toEqual(before.hashesB);

            // A shared write after it reaches B, and only it does.
            await writeThrough(backend, "/after.txt", "after");
            const idsA = await indexedIds(fsA);
            const written = idsA.filter((id) => !before.idsA.includes(id));
            expect(written.length).toBeGreaterThan(0);
            await changesOnB.untilAdded(
                written,
                "B announces the shared write"
            );
            expect(changesOnB.added()).toEqual(written);
            expect(changesOnB.removed()).toEqual(
                before.idsA.filter((id) => !idsA.includes(id))
            );
            expect(await indexedIds(fsB)).toEqual(idsA);
            expect(
                new TextDecoder().decode(await fsB.readFile("/after.txt"))
            ).toBe("after");
            expect(
                (await fsB.list("/")).map((entry) => entry.name).sort()
            ).toEqual(["after.txt", "package.json"]);
            await fsA.persistLocalWrites({ timeout: STEP_MS });
            expect(await logHashes(fsB)).toEqual(await logHashes(fsA));
        } finally {
            changesOnB.stop();
        }
    });
});
