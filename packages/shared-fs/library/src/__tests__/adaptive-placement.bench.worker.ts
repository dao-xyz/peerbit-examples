import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Documents } from "@peerbit/document";
import { Peerbit } from "peerbit";
import {
    digest,
    fixtureFile,
    PlacementChunk,
    PlacementChunkRow,
    PlacementManifest,
    storeId,
    verifyChunk,
    type PlacementCommand,
    type PlacementConfig,
} from "./adaptive-placement.bench.model.js";
import { scanProcessSoakStateDirectory } from "./process-isolated-soak-storage.js";
import {
    createPlacementProfile,
    errorInfo,
} from "./adaptive-placement-telemetry.js";

const config: PlacementConfig = JSON.parse(process.argv[2]);
assert(
    Number.isInteger(config.peer) &&
        config.peer >= 0 &&
        config.peer <= config.minCopies + 2
);
assert(config.mode === "full" || config.mode === "adaptive");
assert(config.minCopies === 2 || config.minCopies === 3);
assert(Number.isSafeInteger(config.generation) && config.generation > 0);
assert(typeof config.profile === "boolean");
const send = (message: unknown) =>
    new Promise<void>((resolve, reject) => {
        assert(process.send);
        process.send(message, (error) => (error ? reject(error) : resolve()));
    });
const provenance = async (name: string) => {
    const entry = await realpath(fileURLToPath(import.meta.resolve(name)));
    for (let dir = dirname(entry); ; dir = dirname(dir)) {
        try {
            const bytes = await readFile(join(dir, "package.json"));
            const pkg = JSON.parse(bytes.toString());
            if (pkg.name === name)
                return {
                    version: pkg.version,
                    entry,
                    entrySha256: digest(await readFile(entry)),
                    packageSha256: digest(bytes),
                };
        } catch (error: any) {
            if (error.code !== "ENOENT") throw error;
        }
        assert.notEqual(
            dir,
            dirname(dir),
            `missing package provenance: ${name}`
        );
    }
};
let peer: Peerbit | undefined;
let stopped = false;
const main = async () => {
    const modules = Object.fromEntries(
        await Promise.all(
            [
                "peerbit",
                "@peerbit/document",
                "@peerbit/shared-log",
                "@dao-xyz/borsh",
                "@peerbit/crypto",
            ].map(async (name) => [name, await provenance(name)])
        )
    );
    peer = await Peerbit.create({
        directory: config.directory,
        ...(config.offline
            ? {
                  libp2p: {
                      addresses: { listen: [] },
                      connectionGater: Object.fromEntries(
                          [
                              "denyDialPeer",
                              "denyDialMultiaddr",
                              "denyInboundConnection",
                              "denyOutboundConnection",
                              "denyInboundEncryptedConnection",
                              "denyOutboundEncryptedConnection",
                              "denyInboundUpgradedConnection",
                              "denyOutboundUpgradedConnection",
                          ].map((name) => [name, () => true])
                      ),
                  },
              }
            : {}),
    });
    const localPeer = peer;
    const role = config.peer === 0 ? "publisher" : "custodian";
    const profiles = config.profile
        ? {
              metadata: createPlacementProfile(),
              chunks: createPlacementProfile(),
          }
        : undefined;
    const metadata = await localPeer.open(
        new Documents<PlacementManifest>({
            id: storeId(config.run, "metadata"),
            immutable: true,
        }),
        {
            args: {
                type: PlacementManifest,
                replicate: config.offline ? false : { factor: 1 },
                replicas: { min: config.minCopies },
                ...(profiles
                    ? { sync: { profile: profiles.metadata.sink } }
                    : {}),
            },
        }
    );
    const replication =
        config.offline || role === "publisher"
            ? false
            : config.mode === "full"
              ? { factor: 1 }
              : { limits: { storage: config.capacityBytes! } };
    const chunks = await localPeer.open(
        new Documents<PlacementChunk, PlacementChunkRow>({
            id: storeId(config.run, "chunks"),
            immutable: true,
        }),
        {
            args: {
                type: PlacementChunk,
                replicate: replication,
                replicas: { min: config.minCopies },
                ...(profiles
                    ? { sync: { profile: profiles.chunks.sink } }
                    : {}),
                // Publisher retains its authored source until the explicit stop phase.
                // It is excluded from all custodian coverage/placement statistics.
                ...(role === "publisher" ? { keep: "self" as const } : {}),
                index: {
                    type: PlacementChunkRow,
                    transform: (chunk: PlacementChunk) =>
                        new PlacementChunkRow(chunk),
                },
                canPerform: (operation: any) =>
                    operation.type === "put" && verifyChunk(operation.value),
            },
        }
    );
    let capacityBytes = config.capacityBytes;
    const chunkEntries: any[] = [];
    const metadataEntries: any[] = [];
    const metadataLogAddress = metadata.log.address;
    const chunksLogAddress = chunks.log.address;
    const profileSnapshot = () =>
        profiles
            ? {
                  metadata: {
                      logAddress: metadataLogAddress,
                      ...profiles.metadata.snapshot(),
                  },
                  chunks: {
                      logAddress: chunksLogAddress,
                      ...profiles.chunks.snapshot(),
                  },
              }
            : null;
    const snapshot = async (verify = false) => {
        const [chunkRows, manifests, participation, localLogBytes] =
            await Promise.all([
                chunks.index
                    .iterate({}, { local: true, remote: false, resolve: false })
                    .all(),
                metadata.index
                    .iterate({}, { local: true, remote: false, resolve: false })
                    .all(),
                chunks.log.calculateMyTotalParticipation(),
                chunks.log.getMemoryUsage(),
            ]);
        if (verify)
            for (const row of chunkRows) {
                const value = await chunks.index.get(row.id, {
                    local: true,
                    remote: false,
                });
                assert(value && verifyChunk(value));
                assert.equal(value.data.length, row.bytes);
            }
        return {
            peer: config.peer,
            generation: config.generation,
            identity: localPeer.identity.publicKey.hashcode(),
            role,
            capacityBytes,
            participation,
            localLogBytes,
            chunks: chunkRows.map((row) => ({ id: row.id, bytes: row.bytes })),
            metadata: manifests.map((row) => ({
                id: row.id,
                chunkIds: [...row.chunkIds],
                chunkBytes: [...row.chunkBytes],
                bytes: row.bytes,
                hash: row.hash,
            })),
            verifiedLocalChunks: verify ? chunkRows.length : null,
            memory: process.memoryUsage(),
            resources: process.resourceUsage(),
            connections: localPeer.libp2p.getConnections().length,
            profile: profileSnapshot(),
        };
    };
    const execute = async (command: PlacementCommand) => {
        if (command.type === "dial") {
            assert(!config.offline);
            for (const addresses of command.addresses) {
                assert(
                    addresses.length > 0,
                    "online peer advertised no address"
                );
                // Peerbit accepts a string or Multiaddr[], not string[].
                await localPeer.dial(addresses[0], { dialTimeoutMs: 10_000 });
            }
            return { connected: localPeer.libp2p.getConnections().length };
        }
        if (command.type === "snapshot") return snapshot(command.verify);
        if (command.type === "budget") {
            assert(
                config.mode === "adaptive" &&
                    role === "custodian" &&
                    !config.offline
            );
            assert(Number.isSafeInteger(command.bytes) && command.bytes > 0);
            capacityBytes = command.bytes;
            await chunks.log.replicate({ limits: { storage: capacityBytes } });
            return snapshot();
        }
        if (command.type === "write") {
            assert(role === "publisher" && !config.offline);
            assert(
                command.files.length === 1,
                "one file per bounded write command"
            );
            const signal = AbortSignal.timeout(25_000);
            const timings = [];
            for (const file of command.files) {
                const fixture = fixtureFile(file, command.chunkBytes);
                const started = performance.now();
                let chunkReceiptMs = 0;
                for (const chunk of fixture.chunks) {
                    const before = performance.now();
                    const result = await chunks.put(chunk, {
                        delivery: {
                            reliability: "persisted",
                            minAcks: config.minCopies,
                            timeout: 20_000,
                            signal,
                        },
                    });
                    chunkEntries.push(result.entry);
                    chunkReceiptMs += performance.now() - before;
                }
                const before = performance.now();
                // No metadata publication until every referenced chunk has
                // returned its actual persisted receipt, not just readiness.
                const result = await metadata.put(fixture.manifest, {
                    delivery: {
                        reliability: "persisted",
                        minAcks: config.minCopies,
                        timeout: 20_000,
                        signal,
                    },
                });
                metadataEntries.push(result.entry);
                timings.push({
                    file,
                    bytes: fixture.manifest.bytes,
                    chunkReceiptMs,
                    metadataReceiptMs: performance.now() - before,
                    totalMs: performance.now() - started,
                });
            }
            return { timings };
        }
        if (command.type === "barrier") {
            assert(role === "publisher" && !config.offline);
            const started = performance.now();
            const signal = AbortSignal.timeout(25_000);
            for (const [documents, entries] of [
                [chunks, chunkEntries],
                [metadata, metadataEntries],
            ] as const) {
                await documents.log.deliverPersistedEntries(entries, {
                    target: "replicators",
                    delivery: {
                        reliability: "persisted",
                        minAcks: config.minCopies,
                        timeout: 20_000,
                        signal,
                    },
                });
            }
            return {
                chunkEntries: chunkEntries.length,
                metadataEntries: metadataEntries.length,
                persistedRemoteAcksPerEntry: config.minCopies,
                totalMs: performance.now() - started,
            };
        }
        if (command.type === "read") {
            const timings = [];
            const signal = AbortSignal.timeout(25_000);
            let localMisses = 0;
            let remoteReturns = 0;
            for (const file of command.files) {
                signal.throwIfAborted();
                const expected: PlacementManifest = fixtureFile(
                    file,
                    command.chunkBytes
                ).manifest;
                const start = performance.now();
                const manifest = await metadata.index.get(expected.id, {
                    local: true,
                    remote: false,
                });
                assert(manifest, "metadata must be locally complete");
                assert.deepEqual(manifest.chunkIds, expected.chunkIds);
                assert.deepEqual(manifest.chunkBytes, expected.chunkBytes);
                assert.equal(manifest.bytes, expected.bytes);
                assert.equal(manifest.hash, expected.hash);
                const values = [];
                for (const id of manifest.chunkIds) {
                    signal.throwIfAborted();
                    let value = await chunks.index.get(id, {
                        local: true,
                        remote: false,
                        signal,
                    });
                    if (!value) {
                        localMisses++;
                        if (command.remote) {
                            value = await chunks.index.get(id, {
                                local: false,
                                remote: { replicate: false, timeout: 10_000 },
                                signal,
                            });
                            if (value) remoteReturns++;
                        }
                    }
                    assert(
                        value && verifyChunk(value),
                        `unavailable or corrupt chunk ${id}`
                    );
                    values.push(value.data);
                }
                const bytes = Buffer.concat(values);
                assert.equal(bytes.length, expected.bytes);
                assert.equal(digest(bytes), expected.hash);
                timings.push({
                    file,
                    verifiedReadMs: performance.now() - start,
                });
            }
            return { timings, localMisses, remoteReturns };
        }
        assert.equal(command.type, "stop");
        await localPeer.stop();
        stopped = true;
        return {
            stopped: true,
            storage: await scanProcessSoakStateDirectory(config.directory),
        };
    };
    let queue = Promise.resolve();
    process.on(
        "message",
        (message: { request: number; command: PlacementCommand }) => {
            // Only reads detached counters: do not queue behind a stalled store call.
            if (message.command.type === "profile") {
                void send({
                    request: message.request,
                    ok: true,
                    value: profileSnapshot(),
                }).catch((error) => {
                    console.error(error);
                    process.exitCode = 1;
                });
                return;
            }
            queue = queue
                .then(async () => {
                    try {
                        const value = await execute(message.command);
                        await send({
                            request: message.request,
                            ok: true,
                            value,
                        });
                        if (message.command.type === "stop") {
                            process.removeAllListeners("message");
                            process.disconnect(); // natural exit is independently required by the parent
                        }
                    } catch (error) {
                        await send({
                            request: message.request,
                            ok: false,
                            error: errorInfo(error),
                            profile: profileSnapshot(),
                            context: {
                                peer: config.peer,
                                generation: config.generation,
                                identity:
                                    localPeer.identity.publicKey.hashcode(),
                                offline: config.offline,
                                command: message.command.type,
                                minCopies: config.minCopies,
                                metadataLog: metadataLogAddress,
                                chunksLog: chunksLogAddress,
                            },
                        });
                    }
                })
                .catch((error) => {
                    console.error(error);
                    process.exitCode = 1;
                });
        }
    );
    process.once("disconnect", () => {
        if (!stopped) {
            process.exitCode = 2;
            void localPeer.stop().catch((error) => console.error(error));
        }
    });
    await send({
        ready: true,
        peer: config.peer,
        generation: config.generation,
        pid: process.pid,
        hash: localPeer.identity.publicKey.hashcode(),
        addresses: localPeer.getMultiaddrs().map(String),
        modules,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
    });
};
main().catch(async (error) => {
    await send({ fatal: errorInfo(error) }).catch(() => {});
    process.exitCode = 1;
    await peer?.stop().catch((cleanup) => console.error(cleanup));
    if (process.connected) process.disconnect();
});
