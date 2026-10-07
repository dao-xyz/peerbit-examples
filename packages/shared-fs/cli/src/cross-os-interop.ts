#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Peerbit, encodePublicSignKey, openSharedFs } from "@peerbit/shared-fs";

type Options = {
    role: "seed" | "join";
    machine: string;
    expected: string[];
    addressFile: string;
    timeoutMs: number;
    directory?: string;
};

type SharedFs = Awaited<ReturnType<typeof openSharedFs>>;

const parseArgs = (args: string[]): Options => {
    const value = (name: string) => {
        const index = args.indexOf(name);
        return index === -1 ? undefined : args[index + 1];
    };
    const role = value("--role");
    if (role !== "seed" && role !== "join") {
        throw new Error("--role must be seed or join");
    }
    const machine = value("--machine");
    if (!machine) {
        throw new Error("--machine is required");
    }
    const addressFile = value("--address-file");
    if (!addressFile) {
        throw new Error("--address-file is required");
    }
    return {
        role,
        machine,
        expected: (value("--expected") ?? "linux,macos,windows")
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        addressFile,
        timeoutMs: Number(value("--timeout-ms") ?? 10 * 60 * 1000),
        directory: value("--directory"),
    };
};

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const waitUntil = async (
    assertion: () => Promise<void> | void,
    timeoutMs: number,
    intervalMs = 2_000
) => {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }
    throw lastError;
};

const filePathForMachine = (machine: string) => `/${machine}.txt`;

const waitForAllMachines = async (
    fs: SharedFs,
    expected: string[],
    timeoutMs: number
) => {
    await waitUntil(async () => {
        const missing: string[] = [];
        for (const machine of expected) {
            const contents = decode(
                await fs.readFile(filePathForMachine(machine))
            );
            if (contents !== `hello from ${machine}`) {
                missing.push(machine);
            }
        }
        if (missing.length > 0) {
            throw new Error(`Missing files from: ${missing.join(", ")}`);
        }
    }, timeoutMs);
};

// Diagnostics. Every line is prefixed "[interop <machine>]" and stamped, so
// the three job logs can be merged into one timeline. They only read state;
// none of them changes what the peer does.

const stamp = () => new Date().toISOString();
const short = (hash: string | undefined) => (hash ? hash.slice(0, 10) : "?");

const say = (machine: string, message: string) =>
    console.log(`${stamp()} [interop ${machine}] ${message}`);

const safely = async (
    machine: string,
    what: string,
    run: () => Promise<void> | void
) => {
    try {
        await run();
    } catch (error) {
        say(
            machine,
            `diag ${what} failed: ${error instanceof Error ? error.message : String(error)}`
        );
    }
};

/** machineLabel by author key, learned from the versions this peer can see. */
const authorLabels = async (fs: SharedFs, expected: string[]) => {
    const labels = new Map<string, string>();
    for (const machine of expected) {
        try {
            for (const version of await fs.versions(
                filePathForMachine(machine)
            )) {
                labels.set(version.authorKey, version.machineLabel);
            }
        } catch {
            // missing file: no versions to learn from
        }
    }
    return labels;
};

/**
 * Live membership timeline: when this peer saw each replicator join or leave
 * the shared log, and when a machine file first became readable.
 */
const traceMembership = (machine: string, peer: Peerbit, fs: SharedFs) => {
    const log = (fs.program as any).entries.log;
    const self = peer.identity.publicKey.hashcode();
    for (const type of ["replicator:join", "replicator:leave"]) {
        log.events.addEventListener(type, (event: any) => {
            const key = event.detail?.publicKey?.hashcode?.();
            if (key !== self) {
                say(machine, `${type} ${short(key)}`);
            }
        });
    }
};

const dumpDiagnostics = async (
    machine: string,
    peer: Peerbit,
    fs: SharedFs,
    expected: string[]
) => {
    const log = (fs.program as any).entries.log;
    const self = peer.identity.publicKey.hashcode();
    // Label peers by the machineLabel of the versions they authored.
    const labels = await authorLabels(fs, expected);
    const keyByHash = new Map<string, any>([[self, peer.identity.publicKey]]);
    const learnKey = (key: any) => {
        if (key?.hashcode) keyByHash.set(key.hashcode(), key);
    };
    const name = (hash: string) => {
        const key = keyByHash.get(hash);
        const label = key ? labels.get(encodePublicSignKey(key)) : undefined;
        return `${short(hash)}${hash === self ? `(${machine}, self)` : label ? `(${label})` : ""}`;
    };
    try {
        const entries = await log.log.toArray();
        for (const entry of entries) {
            for (const signature of await entry.getSignatures()) {
                learnKey(signature.publicKey);
            }
        }
        for (const key of (await (peer.services.pubsub as any).getSubscribers(
            log.topic
        )) ?? []) {
            learnKey(key);
        }
    } catch {
        // labels are best effort
    }
    say(machine, `diag begin self=${name(self)} peerId=${peer.peerId}`);

    await safely(machine, "connections", () => {
        const connections = peer.libp2p.getConnections();
        say(machine, `diag connections=${connections.length}`);
        for (const connection of connections) {
            const address = connection.remoteAddr.toString();
            say(
                machine,
                `diag   peer=${connection.remotePeer} status=${connection.status} direction=${connection.direction} relayed=${address.includes("/p2p-circuit")} openedAgoMs=${Date.now() - connection.timeline.open} addr=${address}`
            );
        }
    });

    await safely(machine, "subscribers", async () => {
        const subscribers =
            (await (peer.services.pubsub as any).getSubscribers(log.topic)) ??
            [];
        say(
            machine,
            `diag topic subscribers=[${subscribers.map((key: any) => name(key.hashcode())).join(", ")}]`
        );
    });

    await safely(machine, "replicators", async () => {
        const pubsub = peer.services.pubsub as any;
        const replicators = [...(await log.getReplicators())] as string[];
        say(machine, `diag replicators=${replicators.length}`);
        for (const hash of replicators) {
            if (hash === self) continue;
            const hint = pubsub.routes?.getBestRouteHint?.(self, hash);
            say(
                machine,
                `diag   replicator=${name(hash)} reachable=${pubsub.routes?.isReachable?.(self, hash)} nextHop=${hint?.nextHop ? short(hint.nextHop) : "none"} expiring=${hint?.expiresAt != null}`
            );
        }
    });

    await safely(machine, "log", async () => {
        const entries = await log.log.toArray();
        const heads = await log.log.getHeads(true).all();
        const headHashes = new Set(heads.map((entry: any) => entry.hash));
        const byAuthor = new Map<string, { entries: number; heads: number }>();
        for (const entry of entries) {
            const signatures = await entry.getSignatures();
            const author = signatures[0]?.publicKey?.hashcode?.() ?? "?";
            const counts = byAuthor.get(author) ?? { entries: 0, heads: 0 };
            counts.entries++;
            if (headHashes.has(entry.hash)) counts.heads++;
            byAuthor.set(author, counts);
        }
        say(
            machine,
            `diag log entries=${entries.length} heads=${heads.length}`
        );
        for (const [author, counts] of byAuthor) {
            say(
                machine,
                `diag   author=${name(author)} entries=${counts.entries} heads=${counts.heads}`
            );
        }
    });

    await safely(machine, "sync", async () => {
        const synchronizer = log.syncronizer;
        say(
            machine,
            `diag sync inFlight=${synchronizer?.syncInFlight?.size ?? "?"} pending=${synchronizer?.pending?.size ?? "?"}`
        );
        const status = await log.getReplicationStatus?.();
        if (status) {
            say(
                machine,
                `diag replication status=${JSON.stringify(status, (_key, value) => (typeof value === "bigint" ? String(value) : value))}`
            );
        }
        say(
            machine,
            `diag bootstrap=${JSON.stringify(fs.bootstrapStatus(), (_key, value) => (typeof value === "bigint" ? String(value) : value))}`
        );
    });

    await safely(machine, "files", async () => {
        const listing = await fs.list("/");
        say(
            machine,
            `diag root=[${listing.map((item: any) => item.name ?? item.path ?? String(item)).join(", ")}]`
        );
        for (const expectedMachine of expected) {
            const file = filePathForMachine(expectedMachine);
            let state: string;
            try {
                const contents = decode(await fs.readFile(file));
                state =
                    contents === undefined
                        ? "missing"
                        : contents === `hello from ${expectedMachine}`
                          ? "ok"
                          : `unexpected ${JSON.stringify(contents)}`;
            } catch (error) {
                state = `missing (${error instanceof Error ? error.message : String(error)})`;
            }
            const versions = await fs.versions(file).catch(() => []);
            say(
                machine,
                `diag   ${file}: ${state} versions=[${versions.map((version) => `${version.machineLabel}:${short(version.authorKey)}`).join(", ")}]`
            );
        }
    });
    say(machine, "diag end");
};

// Exit barrier. A peer must not leave while another peer may still need a
// file that only the leaving peer can deliver: shared-log never forwards an
// entry it received from its author to a replicator the author missed
// (upstream U-53/U-54), so the author has to stay until every peer has it.
//   every peer: hello -> all hello -> /done-<machine>.txt
//   seed:       all done -> /all-done.txt -> all /bye-<joiner>.txt -> exit
//   joiner:     /all-done.txt -> /bye-<machine>.txt -> exit
// The seed writes the final signal and leaves last, so no joiner waits on a
// marker whose author already left. If a bye is lost on the way out, the
// seed waits out its deadline and still exits 0.

const markerFor = (kind: "done" | "bye", machine: string) =>
    `/${kind}-${machine}.txt`;
const ALL_DONE = "/all-done.txt";

const waitForMarkers = async (
    fs: SharedFs,
    paths: string[],
    deadline: number
) => {
    await waitUntil(
        async () => {
            const missing: string[] = [];
            for (const file of paths) {
                if (
                    (await fs.readFile(file).catch(() => undefined)) ===
                    undefined
                ) {
                    missing.push(file);
                }
            }
            if (missing.length > 0) {
                throw new Error(`Missing markers: ${missing.join(", ")}`);
            }
        },
        Math.max(1, deadline - Date.now())
    );
};

const exitBarrier = async (
    options: Options,
    peer: Peerbit,
    fs: SharedFs,
    deadline: number
) => {
    await fs.writeFile(markerFor("done", options.machine), "done");
    try {
        if (options.role === "seed") {
            await waitForMarkers(
                fs,
                options.expected.map((machine) => markerFor("done", machine)),
                deadline
            );
            await fs.writeFile(ALL_DONE, "all done");
            say(
                options.machine,
                "every peer read every file; waiting for joiners to leave"
            );
            await waitForMarkers(
                fs,
                options.expected
                    .filter((machine) => machine !== options.machine)
                    .map((machine) => markerFor("bye", machine)),
                deadline
            );
        } else {
            await waitForMarkers(fs, [ALL_DONE], deadline);
            await fs.writeFile(markerFor("bye", options.machine), "bye");
        }
        say(options.machine, "exit barrier passed");
    } catch (error) {
        // This peer already read every file; a stuck barrier means another
        // peer is still missing one. That peer fails; this one reports.
        say(
            options.machine,
            `exit barrier did not complete: ${error instanceof Error ? error.message : String(error)}`
        );
        await dumpDiagnostics(options.machine, peer, fs, options.expected);
    }
};

const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const peer = await Peerbit.create({ directory: options.directory });
    try {
        await peer.bootstrap();
        say(
            options.machine,
            `identity key=${short(peer.identity.publicKey.hashcode())} authorKey=${short(encodePublicSignKey(peer.identity.publicKey))} peerId=${peer.peerId}`
        );
        const address =
            options.role === "join"
                ? (await readFile(options.addressFile, "utf8")).trim()
                : undefined;
        const fs = await openSharedFs({
            peerbit: peer,
            address,
            machineLabel: options.machine,
        });
        traceMembership(options.machine, peer, fs);

        if (options.role === "seed") {
            await mkdir(path.dirname(options.addressFile), { recursive: true });
            await writeFile(options.addressFile, fs.address ?? "", "utf8");
            console.log(`seed address: ${fs.address}`);
        } else {
            console.log(`joining address: ${address}`);
            await fs.awaitWriteReady({ timeout: options.timeoutMs });
        }

        // Who this peer will push its own file to: an append is delivered
        // only to the replicators known at this moment.
        const knownAtWrite = [
            ...(await (fs.program as any).entries.log.getReplicators()),
        ] as string[];
        await fs.writeFile(
            filePathForMachine(options.machine),
            `hello from ${options.machine}`
        );
        say(
            options.machine,
            `wrote ${filePathForMachine(options.machine)} authorKey=${short(encodePublicSignKey(peer.identity.publicKey))}; replicators known at write=[${knownAtWrite.map(short).join(", ")}]`
        );
        const deadline = Date.now() + options.timeoutMs;
        try {
            await waitForAllMachines(fs, options.expected, options.timeoutMs);
        } catch (error) {
            await dumpDiagnostics(options.machine, peer, fs, options.expected);
            throw error;
        }
        console.log(
            `read files from all machines: ${options.expected.join(", ")}`
        );
        await exitBarrier(options, peer, fs, deadline);
    } finally {
        await peer.stop();
    }
};

main().catch((error) => {
    console.error(
        error instanceof Error ? error.stack || error.message : error
    );
    process.exitCode = 1;
});
