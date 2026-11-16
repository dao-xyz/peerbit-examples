import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Peerbit, openSharedFs, type SharedFsHandle } from "@peerbit/shared-fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectMountToNetwork } from "../index.js";

/**
 * A mount's --peer reconnects (roadmap N1). Real Peerbit peers over real
 * TCP on loopback, without FUSE: a hub with a persistent identity (its state
 * directory) listening on a fixed address, restarted at that same address,
 * and clients connected through the mount's network function. A client
 * listens on no address, as a machine whose CLI listens only on its own
 * loopback looks to a hub elsewhere, so every reconnect is the client's own
 * dial. Every wait resolves on an event and only gives up at its deadline.
 *
 * Peerbit's pubsub redials a down --peer about once a second; no test here
 * depends on that rate beyond its bounds. A --peer client never uses
 * bootstrap recovery, whose Peerbit.bootstrap() would replace the topic-root
 * candidates its start chose.
 */

/** The roadmap's bound for a write made after the hub restarted. */
const WRITE_AFTER_RESTART_REACHES_HUB_MS = 10_000;
/**
 * A client that mounted while its --peer was down: connecting, then
 * catching up both ways. A refused dial to loopback takes about 2 s on
 * Windows.
 */
const CATCH_UP_AFTER_HUB_UP_MS = 30_000;
/**
 * A third client's join, and sync between clients, after one client's
 * connections closed. A --peer client whose topic-root candidates switched
 * stalled a later join for 61-85 s; a healthy join took 0.4-8.3 s on a
 * heavily loaded machine.
 */
const JOIN_AND_SYNC_MS = 30_000;
/** Steps that are not under test: a join, a disconnect. */
const SETUP_MS = 60_000;

const text = (bytes: Uint8Array | undefined) =>
    bytes ? new TextDecoder().decode(bytes) : undefined;

const freePort = () =>
    new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as net.AddressInfo;
            server.close(() => resolve(port));
        });
    });

/** Rejects with `label` once `ms` pass; never resolves anything itself. */
const giveUpAfter = (ms: number, label: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`gave up after ${ms} ms: ${label}`)),
            ms
        );
    });
    return { expired, clear: () => clearTimeout(timer) };
};

/** Resolves once `check()` holds, checking again on each change batch. */
const untilChanged = async (
    handle: SharedFsHandle,
    check: () => Promise<boolean>,
    ms: number,
    label: string
) => {
    const watcher = handle.watch("/", { settleMs: 0 });
    const deadline = giveUpAfter(ms, label);
    try {
        await Promise.race([
            new Promise<void>((resolve) => {
                let checking = false;
                let again = false;
                const run = async () => {
                    if (checking) {
                        again = true;
                        return;
                    }
                    checking = true;
                    do {
                        again = false;
                        if (await check().catch(() => false)) {
                            resolve();
                            return;
                        }
                    } while (again);
                    checking = false;
                };
                watcher.on("change", () => void run());
                void watcher.ready.then(run);
            }),
            deadline.expired,
        ]);
    } finally {
        deadline.clear();
        watcher.close();
    }
};

const readsAs = (handle: SharedFsHandle, file: string, expected: string) =>
    untilChanged(
        handle,
        async () => text(await handle.readFile(file)) === expected,
        SETUP_MS,
        `${file} reads "${expected}"`
    );

/** Resolves once `peer` has no connections, on its close events. */
const untilDisconnected = async (peer: Peerbit, label: string) => {
    const deadline = giveUpAfter(SETUP_MS, label);
    const target = peer.libp2p as unknown as EventTarget;
    let listener: (() => void) | undefined;
    try {
        await Promise.race([
            new Promise<void>((resolve) => {
                listener = () => {
                    if (peer.libp2p.getConnections().length === 0) resolve();
                };
                target.addEventListener("connection:close", listener);
                listener();
            }),
            deadline.expired,
        ]);
    } finally {
        deadline.clear();
        if (listener) target.removeEventListener("connection:close", listener);
    }
};

/** The time of `peer`'s next opened connection. */
const nextConnection = (peer: Peerbit) =>
    new Promise<number>((resolve) =>
        (peer.libp2p as unknown as EventTarget).addEventListener(
            "connection:open",
            () => resolve(performance.now()),
            { once: true }
        )
    );

const connectedTo = (peer: Peerbit, remote: string) =>
    peer.libp2p
        .getConnections()
        .some((connection) => connection.remotePeer.toString() === remote);

/** Resolves when `peer` is connected to `remote`, on its open events. */
const untilConnectedTo = async (
    peer: Peerbit,
    remote: string,
    ms: number,
    label: string
) => {
    const deadline = giveUpAfter(ms, label);
    const target = peer.libp2p as unknown as EventTarget;
    let listener: (() => void) | undefined;
    try {
        await Promise.race([
            new Promise<void>((resolve) => {
                listener = () => {
                    if (connectedTo(peer, remote)) resolve();
                };
                target.addEventListener("connection:open", listener);
                listener();
            }),
            deadline.expired,
        ]);
    } finally {
        deadline.clear();
        if (listener) target.removeEventListener("connection:open", listener);
    }
    return performance.now();
};

/** Every Peerbit.bootstrap() call `peer` makes from now on. */
const bootstrapCalls = (peer: Peerbit) => {
    const calls: unknown[] = [];
    const bootstrap = peer.bootstrap.bind(peer);
    vi.spyOn(peer, "bootstrap").mockImplementation(
        async (...args: Parameters<Peerbit["bootstrap"]>) => {
            calls.push(args[0]);
            return bootstrap(...args);
        }
    );
    return calls;
};

const report = (label: string, data: Record<string, number>) =>
    console.log(
        `peer reconnect ${label}:`,
        JSON.stringify(data, (_key, value) =>
            typeof value === "number" ? Math.round(value) : value
        )
    );

const escapeRegExp = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("mount --peer reconnect over real TCP", () => {
    const live = new Set<Peerbit>();
    const directories: string[] = [];

    afterEach(async () => {
        vi.restoreAllMocks();
        await Promise.allSettled([...live].map((peer) => stop(peer)));
        for (const directory of directories.splice(0)) {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    const stop = async (peer: Peerbit) => {
        live.delete(peer);
        await peer.stop();
        await peer.services.blocks.stop();
    };

    const newDirectory = async (label: string) => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), `peerbit-shared-fs-cli-reconnect-${label}-`)
        );
        directories.push(directory);
        return directory;
    };

    const open = (peerbit: Peerbit, label: string, address?: string) =>
        openSharedFs({
            peerbit,
            ...(address ? { address } : {}),
            machineLabel: label,
            replicate: { factor: 1 },
            gc: false,
        });

    /** A node with one state directory and one fixed TCP address. */
    const createNode = async (label: string) => {
        const directory = await newDirectory(label);
        const listen = `/ip4/127.0.0.1/tcp/${await freePort()}`;
        let peerId: string | undefined;
        const node = {
            peer: undefined as Peerbit | undefined,
            /** Its persistent identity. */
            peerId: "",
            /** --peer: the fixed address and the persistent identity. */
            multiaddr: "",
            start: async () => {
                const peer = await Peerbit.create({
                    directory,
                    libp2p: { addresses: { listen: [listen] } },
                });
                live.add(peer);
                node.peer = peer;
                // Same state directory, same identity, same multiaddr.
                peerId ??= peer.peerId.toString();
                expect(peer.peerId.toString()).toBe(peerId);
                node.peerId = peerId;
                node.multiaddr = `${listen}/p2p/${peerId}`;
                return peer;
            },
            stop: async () => {
                if (node.peer) await stop(node.peer);
            },
        };
        return node;
    };

    /** A hub that holds the filesystem; it creates it without an address. */
    const createHub = async () => {
        const node = await createNode("hub");
        return {
            ...node,
            get peer() {
                return node.peer;
            },
            get peerId() {
                return node.peerId;
            },
            get multiaddr() {
                return node.multiaddr;
            },
            start: async (address?: string) =>
                open(await node.start(), "hub", address),
        };
    };

    /** A client that cannot be dialled: it reaches the hub only by dialling. */
    const startClient = async (directory: string) => {
        const peer = await Peerbit.create({
            directory,
            libp2p: { addresses: { listen: [] } },
        });
        live.add(peer);
        return peer;
    };

    const notReached = (address: string) =>
        new RegExp(
            `^Could not reach --peer ${escapeRegExp(address)} \\([\\s\\S]+\\); Peerbit keeps redialling while the mount runs\\.$`
        );

    it("redials its --peer after the hub restarts at the same address, and a write made after the restart reaches the hub", async () => {
        const hub = await createHub();
        let hubFs = await hub.start();
        const address = hubFs.address;
        await hubFs.writeFile("/from-hub.txt", "hub");

        const client = await startClient(await newDirectory("client"));
        const bootstraps = bootstrapCalls(client);
        const warn = vi.fn();
        await connectMountToNetwork(client, { peer: [hub.multiaddr] }, warn);
        expect(warn).not.toHaveBeenCalled();
        const clientFs = await open(client, "client", address);
        await clientFs.awaitWriteReady({ timeout: SETUP_MS });
        await readsAs(clientFs, "/from-hub.txt", "hub");

        const stoppedAt = performance.now();
        await hub.stop();
        await untilDisconnected(client, "the client sees the hub go away");
        const disconnectedAt = performance.now();

        const reconnected = nextConnection(client);
        hubFs = await hub.start(address);
        const hubUpAt = performance.now();
        await clientFs.writeFile("/after-restart.txt", "after");
        const writtenAt = performance.now();
        await untilChanged(
            hubFs,
            async () =>
                text(await hubFs.readFile("/after-restart.txt")) === "after",
            WRITE_AFTER_RESTART_REACHES_HUB_MS,
            "a write made after the hub restarted reaches the hub"
        );
        const reachedHubAt = performance.now();
        report("after a hub restart", {
            hubDownMs: hubUpAt - stoppedAt,
            disconnectedAfterStopMs: disconnectedAt - stoppedAt,
            reconnectAfterHubUpMs: (await reconnected) - hubUpAt,
            writeReachedHubMs: reachedHubAt - writtenAt,
        });
        expect(warn).not.toHaveBeenCalled();
        // Pubsub redialled it; its topic-root candidates stayed automatic.
        expect(bootstraps).toEqual([]);
    });

    it("mounts while its --peer is down, then connects and catches up both ways when the peer comes up", async () => {
        const hub = await createHub();
        let hubFs = await hub.start();
        const address = hubFs.address;
        await hubFs.writeFile("/from-hub.txt", "hub");

        // The client joins once, so its state directory holds a replica.
        const clientDirectory = await newDirectory("client");
        let client = await startClient(clientDirectory);
        await connectMountToNetwork(client, { peer: [hub.multiaddr] });
        let clientFs = await open(client, "client", address);
        await clientFs.awaitWriteReady({ timeout: SETUP_MS });
        await readsAs(clientFs, "/from-hub.txt", "hub");
        await stop(client);

        // The hub writes while the client is away, then goes down too.
        await hubFs.writeFile("/while-away.txt", "hub again");
        await hub.stop();

        // The mount starts while its only --peer is down.
        client = await startClient(clientDirectory);
        const bootstraps = bootstrapCalls(client);
        const warn = vi.fn();
        const unreachable = await connectMountToNetwork(
            client,
            { peer: [hub.multiaddr] },
            warn
        );
        expect(warn.mock.calls).toEqual([
            [expect.stringMatching(notReached(hub.multiaddr))],
        ]);
        expect(unreachable).toHaveLength(1);
        clientFs = await open(client, "client", address);
        // A warm replica is writable at once, offline.
        expect(clientFs.bootstrapStatus().writeReady).toBe(true);
        await clientFs.writeFile("/offline.txt", "offline");
        expect(client.libp2p.getConnections()).toEqual([]);

        // The hub comes back at the same address.
        const connected = nextConnection(client);
        hubFs = await hub.start(address);
        const hubUpAt = performance.now();
        await Promise.all([
            untilChanged(
                hubFs,
                async () =>
                    text(await hubFs.readFile("/offline.txt")) === "offline",
                CATCH_UP_AFTER_HUB_UP_MS,
                "the hub receives the write the client made offline"
            ),
            untilChanged(
                clientFs,
                async () =>
                    text(await clientFs.readFile("/while-away.txt")) ===
                    "hub again",
                CATCH_UP_AFTER_HUB_UP_MS,
                "the client catches up with the hub's write"
            ),
        ]);
        const caughtUpAt = performance.now();
        report("after starting while the hub was down", {
            connectedAfterHubUpMs: (await connected) - hubUpAt,
            caughtUpAfterHubUpMs: caughtUpAt - hubUpAt,
        });
        expect(bootstraps).toEqual([]);
    });

    // Peerbit.dial registers a peer for pubsub's redial only when it
    // answers: before, a --peer that was down at mount start was never
    // dialled again while the mount was connected to anything else.
    it("with --bootstrap, connects a --peer that was down at mount start when it comes up, while the bootstrap node stays connected", async () => {
        const relay = await createNode("relay");
        await relay.start();
        const hub = await createHub();
        let hubFs = await hub.start();
        const address = hubFs.address;
        await hubFs.writeFile("/from-hub.txt", "hub");
        // The hub is not connected to the relay: only a dial reaches it.
        const network = { bootstrap: [relay.multiaddr], peer: [hub.multiaddr] };

        // The client joins once, so its state directory holds a replica.
        // (Joined with the relay too, its first read of the hub's file
        // takes about 10 s: its topic roots are at the relay, the hub's at
        // the hub.)
        const clientDirectory = await newDirectory("client");
        let client = await startClient(clientDirectory);
        await connectMountToNetwork(client, { peer: [hub.multiaddr] });
        let clientFs = await open(client, "client", address);
        await clientFs.awaitWriteReady({ timeout: SETUP_MS });
        await readsAs(clientFs, "/from-hub.txt", "hub");
        await stop(client);
        await hub.stop();

        client = await startClient(clientDirectory);
        const warn = vi.fn();
        await connectMountToNetwork(client, network, warn);
        const bootstraps = bootstrapCalls(client);
        expect(warn.mock.calls).toEqual([
            [expect.stringMatching(notReached(hub.multiaddr))],
        ]);
        expect(connectedTo(client, relay.peerId)).toBe(true);
        clientFs = await open(client, "client", address);
        await clientFs.writeFile("/before-hub.txt", "before");

        hubFs = await hub.start(address);
        const hubUpAt = performance.now();
        const connectedAt = await untilConnectedTo(
            client,
            hub.peerId,
            CATCH_UP_AFTER_HUB_UP_MS,
            "the client dials the --peer that came up"
        );
        await untilChanged(
            hubFs,
            async () =>
                text(await hubFs.readFile("/before-hub.txt")) === "before",
            CATCH_UP_AFTER_HUB_UP_MS,
            "the client's write reaches the --peer that came up"
        );
        report("a --peer down at mount start, with --bootstrap", {
            connectedAfterHubUpMs: connectedAt - hubUpAt,
            writeReachedHubAfterUpMs: performance.now() - hubUpAt,
        });
        expect(connectedTo(client, relay.peerId)).toBe(true);
        // No recovery: the relay stayed connected throughout.
        expect(bootstraps).toEqual([]);
    });

    // Bootstrap recovery used to redial a --peer mount's hub, and its
    // Peerbit.bootstrap() switched that mount's topic-root candidates from
    // automatic to the hub once it reconnected: a later client then took
    // 61-85 s to join, and its writes did not reach the switched client
    // within 60 s.
    it("keeps three --peer clients in sync after one loses its connections while the hub stays up", async () => {
        const hub = await createHub();
        const hubFs = await hub.start();
        const address = hubFs.address;
        /** A --peer client that is write-ready within `ms`. */
        const join = async (label: string, ms: number) => {
            const startedAt = performance.now();
            const peer = await startClient(await newDirectory(label));
            const warn = vi.fn();
            await connectMountToNetwork(peer, { peer: [hub.multiaddr] }, warn);
            expect(warn).not.toHaveBeenCalled();
            const deadline = giveUpAfter(ms, `client ${label} joins`);
            try {
                const handle = await Promise.race([
                    (async () => {
                        const handle = await open(peer, label, address);
                        await handle.awaitWriteReady({ timeout: ms });
                        return handle;
                    })(),
                    deadline.expired,
                ]);
                return {
                    peer,
                    handle,
                    joinMs: performance.now() - startedAt,
                };
            } finally {
                deadline.clear();
            }
        };
        const sees = (
            reader: SharedFsHandle,
            file: string,
            expected: string,
            label: string
        ) =>
            untilChanged(
                reader,
                async () => text(await reader.readFile(file)) === expected,
                JOIN_AND_SYNC_MS,
                label
            );

        const a = await join("a", SETUP_MS);
        const b = await join("b", SETUP_MS);
        await a.handle.writeFile("/a1.txt", "a1");
        await readsAs(b.handle, "/a1.txt", "a1");

        // A's connections close while the hub stays up.
        const bootstraps = bootstrapCalls(a.peer);
        const blipAt = performance.now();
        await Promise.all(
            a.peer.libp2p
                .getConnections()
                .map((connection) => connection.close())
        );
        const reconnectedAt = await untilConnectedTo(
            a.peer,
            hub.peerId,
            SETUP_MS,
            "client a redials the hub"
        );

        const syncedAt = performance.now();
        await a.handle.writeFile("/a2.txt", "a2");
        await b.handle.writeFile("/b2.txt", "b2");
        await Promise.all([
            sees(b.handle, "/a2.txt", "a2", "b sees a's write after a's blip"),
            sees(a.handle, "/b2.txt", "b2", "a sees b's write after a's blip"),
        ]);
        const abSyncMs = performance.now() - syncedAt;

        const c = await join("c", JOIN_AND_SYNC_MS);
        const cWroteAt = performance.now();
        await c.handle.writeFile("/c1.txt", "c1");
        await Promise.all([
            sees(a.handle, "/c1.txt", "c1", "a sees c's write"),
            sees(c.handle, "/a2.txt", "a2", "c sees a's write"),
        ]);
        report("three clients after a client-side blip", {
            reconnectMs: reconnectedAt - blipAt,
            abSyncMs,
            joinCMs: c.joinMs,
            acSyncMs: performance.now() - cWroteAt,
        });
        expect(bootstraps).toEqual([]);
    });
});
