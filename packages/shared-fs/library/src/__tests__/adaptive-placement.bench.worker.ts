import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deserialize } from "@dao-xyz/borsh";
import { PublicSignKey } from "@peerbit/crypto";
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
import {
    createPlacementStopTrace,
    observePlacementStopMethods,
} from "./adaptive-placement-stop-trace.js";
import { capturePlacementPeerReadiness } from "./adaptive-placement-peer-readiness.js";
import { createPlacementEntryTimeline } from "./adaptive-placement-entry-timeline.js";
import {
    createPlacementSettlementProfile,
    type PlacementSettlementOperation,
} from "./adaptive-placement-settlement-profile.js";

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
assert(typeof config.peerReadinessDiagnostics === "boolean");
assert(typeof config.entryTimeline === "boolean");
assert(typeof config.settlementProfile === "boolean");
assert(
    !config.entryTimeline || config.profile,
    "entry timeline needs profile checkpoints"
);
assert(
    !config.settlementProfile || config.profile,
    "settlement profile needs profile checkpoints"
);
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
    const observerHash = localPeer.identity.publicKey.hashcode();
    const profiles = config.profile
        ? {
              metadata: createPlacementProfile(),
              chunks: createPlacementProfile(),
          }
        : undefined;
    // Callback-observed context: the audited emitter closes synchronously before
    // the owned awaited operation settles. Recheck that contract on upgrade.
    let currentSettlementOperation: PlacementSettlementOperation | undefined;
    const settlementProfiles =
        config.settlementProfile && role === "publisher"
            ? {
                  metadata: createPlacementSettlementProfile({
                      runId: digest(config.run),
                      peer: config.peer,
                      generation: config.generation,
                      plane: "metadata",
                      observerHash,
                  }),
                  chunks: createPlacementSettlementProfile({
                      runId: digest(config.run),
                      peer: config.peer,
                      generation: config.generation,
                      plane: "chunks",
                      observerHash,
                  }),
              }
            : undefined;
    const profileSink = (plane: "metadata" | "chunks") =>
        settlementProfiles
            ? (event: unknown) => {
                  profiles![plane].sink(event);
                  settlementProfiles[plane].sink(
                      event,
                      currentSettlementOperation
                  );
              }
            : profiles![plane].sink;
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
                    ? { sync: { profile: profileSink("metadata") } }
                    : {}),
            },
        }
    );
    const metadataLogAddress = metadata.log.address;
    settlementProfiles?.metadata.bindLog(metadataLogAddress);
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
                    ? { sync: { profile: profileSink("chunks") } }
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
    const chunksLogAddress = chunks.log.address;
    settlementProfiles?.chunks.bindLog(chunksLogAddress);
    const entryTimeline =
        config.entryTimeline && role === "publisher"
            ? createPlacementEntryTimeline()
            : undefined;
    let currentWritePlane: "chunks" | "metadata" | undefined;
    let failedWrite:
        | { plane: "chunks" | "metadata"; committedEntryHash?: string }
        | undefined;
    let peerReadinessCaptured = false;
    type StopTrace = ReturnType<typeof createPlacementStopTrace>;
    let tracedStopRequests = 0;
    let activeStopTrace: { request: number; trace: StopTrace } | undefined;
    let lastReceivedStopTrace: typeof activeStopTrace;
    const profileSnapshot = () =>
        profiles
            ? {
                  metadata: {
                      logAddress: metadataLogAddress,
                      ...profiles.metadata.snapshot(),
                      ...(settlementProfiles
                          ? {
                                persistedDelivery:
                                    settlementProfiles.metadata.snapshot(),
                            }
                          : {}),
                  },
                  chunks: {
                      logAddress: chunksLogAddress,
                      ...profiles.chunks.snapshot(),
                      ...(settlementProfiles
                          ? {
                                persistedDelivery:
                                    settlementProfiles.chunks.snapshot(),
                            }
                          : {}),
                  },
                  ...(entryTimeline
                      ? { entryTimeline: entryTimeline.snapshot() }
                      : {}),
                  shutdown: (() => {
                      const current = activeStopTrace ?? lastReceivedStopTrace;
                      return current
                          ? {
                                request: current.request,
                                ...current.trace.snapshot(),
                            }
                          : null;
                  })(),
              }
            : null;
    const settlementRequestSnapshot = (request: number) =>
        settlementProfiles
            ? {
                  settlementProfiles: Object.fromEntries(
                      (["chunks", "metadata"] as const).map((plane) => {
                          const snapshot = settlementProfiles[plane].snapshot();
                          return [
                              plane,
                              {
                                  ...snapshot,
                                  // Counters remain worker/log-lifetime totals;
                                  // only the retained traces are request-filtered.
                                  traceFilter: { request },
                                  traces: snapshot.traces.filter(
                                      (trace) =>
                                          trace.operation?.request === request
                                  ),
                              },
                          ];
                      })
                  ),
              }
            : {};
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
            identity: observerHash,
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
    const execute = async (
        command: PlacementCommand,
        request: number,
        stopTrace?: StopTrace
    ) => {
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
        if (command.type === "peer-readiness") {
            assert(config.peerReadinessDiagnostics && role === "publisher");
            assert(
                !peerReadinessCaptured,
                "peer-only capture is once per worker"
            );
            peerReadinessCaptured = true;
            assert(
                Array.isArray(command.candidates) &&
                    command.candidates.length <= 5
            );
            const candidates = command.candidates.map((candidate) => {
                assert(
                    Number.isSafeInteger(candidate.generation) &&
                        candidate.generation > 0
                );
                assert(
                    typeof candidate.hash === "string" &&
                        candidate.hash.length > 0 &&
                        candidate.hash.length <= 512
                );
                assert(
                    typeof candidate.publicKey === "string" &&
                        candidate.publicKey.length > 0 &&
                        candidate.publicKey.length <= 512
                );
                const bytes = Buffer.from(candidate.publicKey, "base64");
                assert.equal(bytes.toString("base64"), candidate.publicKey);
                const key = deserialize(bytes, PublicSignKey);
                assert.equal(key.hashcode(), candidate.hash);
                return { peer: candidate.peer, key };
            });
            // This command stays in the normal owned queue. A parent IPC
            // timeout does not detach it: stop remains queued behind all probes
            // and retains the original stop/exit failure deadlines.
            const records = await capturePlacementPeerReadiness({
                observerHash,
                candidates,
                logs: [
                    {
                        plane: "chunks",
                        log: chunks.log,
                        ...(failedWrite?.plane === "chunks"
                            ? {
                                  committedEntryHash:
                                      failedWrite.committedEntryHash,
                              }
                            : {}),
                    },
                    {
                        plane: "metadata",
                        log: metadata.log,
                        ...(failedWrite?.plane === "metadata"
                            ? {
                                  committedEntryHash:
                                      failedWrite.committedEntryHash,
                              }
                            : {}),
                    },
                ],
            });
            return {
                clock: "writer-process.performance.now",
                semantics: "peer-only-non-atomic-advisory",
                failedWrite: failedWrite ?? null,
                records: records.map((record) => ({
                    ...record,
                    remoteGeneration: command.candidates.find(
                        (candidate) => candidate.peer === record.peer
                    )!.generation,
                })),
            };
        }
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
            currentWritePlane = "chunks";
            failedWrite = undefined;
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
                for (const [part, chunk] of fixture.chunks.entries()) {
                    const before = performance.now();
                    // Synchronous bookkeeping around the original awaited put:
                    // no listeners, extra delivery call, waiter or IPC on this path.
                    entryTimeline?.begin({
                        request,
                        plane: "chunks",
                        file,
                        part,
                        documentId: chunk.id,
                        bytes: chunk.data.length,
                        logAddress: chunksLogAddress,
                        requestedMinAcks: config.minCopies,
                    });
                    if (settlementProfiles)
                        currentSettlementOperation = {
                            request,
                            kind: "put",
                            file,
                            part,
                        };
                    const result = await chunks.put(chunk, {
                        delivery: {
                            reliability: "persisted",
                            minAcks: config.minCopies,
                            timeout: 20_000,
                            signal,
                        },
                    });
                    currentSettlementOperation = undefined;
                    const captureHash = entryTimeline?.fulfilled();
                    const entry = result.entry;
                    captureHash?.(() => entry.hash);
                    chunkEntries.push(entry);
                    chunkReceiptMs += performance.now() - before;
                }
                const before = performance.now();
                // No metadata publication until every referenced chunk has
                // returned its actual persisted receipt, not just readiness.
                currentWritePlane = "metadata";
                entryTimeline?.begin({
                    request,
                    plane: "metadata",
                    file,
                    documentId: fixture.manifest.id,
                    bytes: fixture.manifest.bytes,
                    logAddress: metadataLogAddress,
                    requestedMinAcks: config.minCopies,
                });
                if (settlementProfiles)
                    currentSettlementOperation = { request, kind: "put", file };
                const result = await metadata.put(fixture.manifest, {
                    delivery: {
                        reliability: "persisted",
                        minAcks: config.minCopies,
                        timeout: 20_000,
                        signal,
                    },
                });
                currentSettlementOperation = undefined;
                const captureHash = entryTimeline?.fulfilled();
                const entry = result.entry;
                captureHash?.(() => entry.hash);
                metadataEntries.push(entry);
                timings.push({
                    file,
                    bytes: fixture.manifest.bytes,
                    chunkReceiptMs,
                    metadataReceiptMs: performance.now() - before,
                    totalMs: performance.now() - started,
                });
            }
            currentWritePlane = undefined;
            const timeline = entryTimeline?.snapshot();
            return {
                timings,
                ...settlementRequestSnapshot(request),
                // Reply only the current command's bounded records. Full detached
                // history (including a pending put) remains in profile checkpoints.
                ...(timeline
                    ? {
                          entryTimeline: {
                              ...timeline,
                              records: timeline.records.filter(
                                  (record) => record.context.request === request
                              ),
                          },
                      }
                    : {}),
            };
        }
        if (command.type === "barrier") {
            assert(role === "publisher" && !config.offline);
            const started = performance.now();
            const signal = AbortSignal.timeout(25_000);
            for (const [documents, entries] of [
                [chunks, chunkEntries],
                [metadata, metadataEntries],
            ] as const) {
                if (settlementProfiles)
                    currentSettlementOperation = { request, kind: "barrier" };
                await documents.log.deliverPersistedEntries(entries, {
                    target: "replicators",
                    delivery: {
                        reliability: "persisted",
                        minAcks: config.minCopies,
                        timeout: 20_000,
                        signal,
                    },
                });
                currentSettlementOperation = undefined;
            }
            return {
                chunkEntries: chunkEntries.length,
                metadataEntries: metadataEntries.length,
                persistedRemoteAcksPerEntry: config.minCopies,
                totalMs: performance.now() - started,
                ...settlementRequestSnapshot(request),
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
        if (stopTrace) {
            // Instance-only observation; do not patch upstream modules/prototypes.
            // A fulfilled phase means its original call settled, not that all
            // nested cleanup was error-free or that placement is complete.
            const restore = observePlacementStopMethods(stopTrace, [
                {
                    target: localPeer,
                    key: "transitionBootstrapRecovery",
                    phase: "peer.bootstrapRecovery",
                },
                {
                    target: localPeer.handler,
                    key: "stop",
                    phase: "peer.handler.stop",
                },
                {
                    target: localPeer.storage,
                    key: "close",
                    phase: "peer.storage.close",
                },
                {
                    target: localPeer.indexer,
                    key: "stop",
                    phase: "peer.indexer.stop",
                },
                {
                    target: localPeer.libp2p,
                    key: "stop",
                    phase: "peer.libp2p.stop",
                },
            ]);
            try {
                await stopTrace.observe("peer.stop", () => localPeer.stop());
            } finally {
                restore();
            }
        } else {
            await localPeer.stop();
        }
        stopped = true;
        return {
            stopped: true,
            storage: await (stopTrace
                ? stopTrace.observe("disk.scan", () =>
                      scanProcessSoakStateDirectory(config.directory)
                  )
                : scanProcessSoakStateDirectory(config.directory)),
        };
    };
    const reply = async (message: unknown, stopTrace?: StopTrace) => {
        stopTrace?.point("ipc.reply.begin");
        try {
            await send(message);
        } catch (error) {
            stopTrace?.point("ipc.reply.error");
            throw error;
        }
        stopTrace?.point("ipc.reply.end");
    };
    let queue = Promise.resolve();
    process.on(
        "message",
        (message: { request: number; command: PlacementCommand }) => {
            const stopping = message.command.type === "stop";
            // One normal stop plus one error-cleanup stop can be traced. Keep
            // closures request-local so a queued cleanup cannot relabel old spans.
            const stopTrace =
                config.profile && stopping && tracedStopRequests < 2
                    ? createPlacementStopTrace({
                          emit: (event) => {
                              // No diagnostic acknowledgement is awaited. IPC
                              // still adds some work; this is not zero-overhead.
                              void send({
                                  stopTrace: event,
                                  stopTraceRequest: message.request,
                              }).catch(() => {});
                          },
                      })
                    : undefined;
            if (stopTrace) {
                tracedStopRequests++;
                lastReceivedStopTrace = {
                    request: message.request,
                    trace: stopTrace,
                };
                stopTrace.point("command.received");
            }
            // Only reads detached counters: do not queue behind a stalled store call.
            if (message.command.type === "profile") {
                void send({
                    request: message.request,
                    ok: true,
                    value: profileSnapshot(),
                }).catch(() => {}); // Optional checkpoint IPC never changes exit status.
                return;
            }
            queue = queue
                .then(async () => {
                    if (stopTrace) {
                        activeStopTrace = {
                            request: message.request,
                            trace: stopTrace,
                        };
                        stopTrace.point("command.dequeued");
                    }
                    try {
                        const value = await execute(
                            message.command,
                            message.request,
                            stopTrace
                        );
                        await reply(
                            { request: message.request, ok: true, value },
                            stopTrace
                        );
                        if (message.command.type === "stop") {
                            process.removeAllListeners("message");
                            process.disconnect(); // natural exit is independently required by the parent
                        }
                    } catch (error) {
                        const evidence = errorInfo(error);
                        // Existing rejection checkpoint, not a pure receipt-wait
                        // timestamp. Never reject a previously settled put on IPC error.
                        if (message.command.type === "write")
                            entryTimeline?.rejected(evidence);
                        if (
                            message.command.type === "write" &&
                            currentWritePlane
                        ) {
                            failedWrite = {
                                plane: currentWritePlane,
                                ...(evidence.committedHashes?.length === 1
                                    ? {
                                          committedEntryHash:
                                              evidence.committedHashes[0],
                                      }
                                    : {}),
                            };
                        }
                        await reply(
                            {
                                request: message.request,
                                ok: false,
                                error: evidence,
                                profile: profileSnapshot(),
                                context: {
                                    peer: config.peer,
                                    generation: config.generation,
                                    identity: observerHash,
                                    offline: config.offline,
                                    command: message.command.type,
                                    minCopies: config.minCopies,
                                    metadataLog: metadataLogAddress,
                                    chunksLog: chunksLogAddress,
                                },
                            },
                            stopTrace
                        );
                    } finally {
                        if (
                            currentSettlementOperation?.request ===
                            message.request
                        )
                            currentSettlementOperation = undefined;
                        if (activeStopTrace?.request === message.request)
                            activeStopTrace = undefined;
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
        hash: observerHash,
        ...(config.peerReadinessDiagnostics
            ? {
                  publicKey: Buffer.from(
                      localPeer.identity.publicKey.bytes
                  ).toString("base64"),
              }
            : {}),
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
