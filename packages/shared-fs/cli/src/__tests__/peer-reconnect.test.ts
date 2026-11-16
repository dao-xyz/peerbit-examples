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
 * and a client connected through the mount's network function with --peer.
 * The client listens on no address, as a machine whose CLI listens only on
 * its own loopback looks to a hub elsewhere, so every reconnect is the
 * client's own dial. Every wait resolves on an event and only gives up at
 * its deadline.
 */

/** The roadmap's bound for a write made after the hub restarted. */
const WRITE_AFTER_RESTART_REACHES_HUB_MS = 10_000;
/**
 * A client started while the hub was down redials on recovery's backoff:
 * about 1, 2, 4 and 8 s after its failed attempts, and a refused dial to
 * loopback takes about 2 s on Windows.
 */
const CATCH_UP_AFTER_HUB_UP_MS = 30_000;
/** Steps that are not under test: a join, a disconnect, a first redial. */
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

    /** A hub with one state directory and one fixed TCP address. */
    const createHub = async () => {
        const directory = await newDirectory("hub");
        const listen = `/ip4/127.0.0.1/tcp/${await freePort()}`;
        let peerId: string | undefined;
        const hub = {
            peer: undefined as Peerbit | undefined,
            /** --peer: the fixed address and the persistent identity. */
            multiaddr: "",
            /** Opens the filesystem; creates it without an address. */
            start: async (address?: string) => {
                const peer = await Peerbit.create({
                    directory,
                    libp2p: { addresses: { listen: [listen] } },
                });
                live.add(peer);
                hub.peer = peer;
                // Same state directory, same identity, same multiaddr.
                peerId ??= peer.peerId.toString();
                expect(peer.peerId.toString()).toBe(peerId);
                hub.multiaddr = `${listen}/p2p/${peerId}`;
                return open(peer, "hub", address);
            },
            stop: async () => {
                if (hub.peer) await stop(hub.peer);
            },
        };
        return hub;
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

    it("redials its --peer after the hub restarts at the same address, and a write made after the restart reaches the hub", async () => {
        const hub = await createHub();
        let hubFs = await hub.start();
        const address = hubFs.address;
        await hubFs.writeFile("/from-hub.txt", "hub");

        const client = await startClient(await newDirectory("client"));
        const warn = vi.fn();
        await connectMountToNetwork(client, { peer: [hub.multiaddr] }, warn);
        expect(warn).not.toHaveBeenCalled();
        const clientFs = await open(client, "client", address);
        await clientFs.awaitWriteReady({ timeout: SETUP_MS });
        await readsAs(clientFs, "/from-hub.txt", "hub");

        // Each recovery attempt is a bootstrap of the --peer addresses.
        const attempts: unknown[] = [];
        let attempted!: () => void;
        const firstAttempt = new Promise<void>((resolve) => {
            attempted = resolve;
        });
        const bootstrap = client.bootstrap.bind(client);
        vi.spyOn(client, "bootstrap").mockImplementation(
            async (...args: Parameters<Peerbit["bootstrap"]>) => {
                attempts.push(args[0]);
                attempted();
                return bootstrap(...args);
            }
        );

        const stoppedAt = performance.now();
        await hub.stop();
        await untilDisconnected(client, "the client sees the hub go away");
        const disconnectedAt = performance.now();
        const attempt = giveUpAfter(
            SETUP_MS,
            "the client's recovery redials the --peer address"
        );
        try {
            await Promise.race([firstAttempt, attempt.expired]);
        } finally {
            attempt.clear();
        }
        const attemptedAt = performance.now();
        expect(attempts[0]).toEqual([hub.multiaddr]);

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
            firstRedialAfterDisconnectMs: attemptedAt - disconnectedAt,
            reconnectAfterHubUpMs: (await reconnected) - hubUpAt,
            writeReachedHubMs: reachedHubAt - writtenAt,
            recoveryAttempts: attempts.length,
        });
        expect(warn).not.toHaveBeenCalled();
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
        const warn = vi.fn();
        await connectMountToNetwork(client, { peer: [hub.multiaddr] }, warn);
        expect(warn.mock.calls).toEqual([
            [
                expect.stringMatching(
                    new RegExp(
                        `^Could not dial --peer ${escapeRegExp(hub.multiaddr)} \\([\\s\\S]+\\); mounting from local state\\. Peerbit redials it with backoff whenever this mount has no connections\\.$`
                    )
                ),
            ],
        ]);
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
    });
});
