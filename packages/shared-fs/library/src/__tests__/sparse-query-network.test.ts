import { performance } from "node:perf_hooks";
import { Peerbit } from "peerbit";
import { afterEach, expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";
import { SparseQueryClient } from "./sparse-query-client.js";
import { SparseQueryProfile } from "./sparse-query-profile.js";
import { SparseQueryScanProfile } from "./sparse-query-scan-profile.js";
import { SparseQueryTransportProfile } from "./sparse-query-transport-profile.js";

const peers: Peerbit[] = [];
let firstOperationProfile: SparseQueryProfile | undefined;
let firstTransportProfile: SparseQueryTransportProfile | undefined;
let lateScanProfile: SparseQueryScanProfile | undefined;
let lateScanTransport: SparseQueryTransportProfile | undefined;
let profileContext: Record<string, unknown> | undefined;
afterEach(async () => {
    const errors: unknown[] = [];
    const attempt = (fn: () => void) => {
        try {
            fn();
        } catch (error) {
            errors.push(error);
        }
    };
    // A diagnostic cleanup/output failure must not skip another diagnostic or
    // real peer shutdown. Preserve every failure, including `undefined`.
    for (const [event, profile, scope] of [
        [
            "shared-fs.sparse-query-profile",
            firstOperationProfile,
            "initial connection only; no wire-arrival/server-time/remote-session attribution",
        ],
        [
            "shared-fs.sparse-query-transport-profile",
            firstTransportProfile,
            "same-process public boundaries; exact one-way outer-ID chains only; no request-response pairing or wire/handler-time proof",
        ],
        [
            "shared-fs.sparse-query-scan-profile",
            lateScanProfile,
            "all scan queries summarized; top eight temporal file windows plus first failure retained; no request-response pairing or causal file attribution",
        ],
        [
            "shared-fs.sparse-query-scan-transport-tail",
            lateScanTransport,
            "unassigned boundaries after last drained window; counters are lifetime cumulative; not another set of query timings",
        ],
    ] as const) {
        if (!profile) continue;
        attempt(() => profile.stop());
        attempt(() =>
            console.log(
                JSON.stringify({
                    event,
                    context: profileContext,
                    profile: profile.snapshot(),
                    scope,
                })
            )
        );
    }
    firstOperationProfile = undefined;
    firstTransportProfile = undefined;
    lateScanProfile = undefined;
    lateScanTransport = undefined;
    profileContext = undefined;
    const results = await Promise.allSettled(
        peers.splice(0).map(async (peer) => peer.stop())
    );
    for (const result of results)
        if (result.status === "rejected") errors.push(result.reason);
    if (errors.length)
        throw new AggregateError(errors, "Sparse probe cleanup failed");
});

const payload = (seed: number) => {
    const bytes = new Uint8Array(4096);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + seed) % 251;
    new DataView(bytes.buffer).setUint32(0, seed);
    return bytes;
};

const residency = async (peer: Peerbit, fs: SharedFsHandle) => {
    let blocks = 0;
    let censusBytes = 0;
    for await (const [, bytes] of peer.services.blocks.iterator()) {
        blocks++;
        censusBytes += bytes.byteLength;
        if (blocks > 1024 || censusBytes > 16 * 1024 * 1024)
            throw new Error("Sparse block census budget exceeded");
    }
    return {
        documents: await fs.program.entries.index.getSize(),
        logEntries: fs.program.entries.log.log.length,
        ranges: (await fs.program.entries.log.getMyReplicationSegments())
            .length,
        blocks,
        censusBytes,
        blockBytes: String(await peer.services.blocks.size()),
    };
};

it(
    "queries a sparse real shared-fs observer across edits, moves, deletes and reconnects",
    { retry: 0 },
    async () => {
        const files = Number(process.env.PEERBIT_SHARED_FS_SPARSE_FILES ?? 64);
        if (!Number.isSafeInteger(files) || files < 32 || files > 10_000)
            throw new Error("Sparse fixture files must be 32..10000");
        const transportEnabled =
            process.env.PEERBIT_SHARED_FS_SPARSE_TRANSPORT_PROFILE === "1";
        const scanEnabled =
            process.env.PEERBIT_SHARED_FS_SPARSE_SCAN_PROFILE === "1";
        if (scanEnabled && !transportEnabled)
            throw new Error("Scan profile requires transport profile");
        if (
            transportEnabled &&
            process.env.PEERBIT_SHARED_FS_SPARSE_PROFILE !== "1"
        )
            throw new Error("Transport profile requires phase profile");
        const sourcePeer = await Peerbit.create();
        peers.push(sourcePeer);
        const transportProfile = transportEnabled
            ? new SparseQueryTransportProfile()
            : undefined;
        firstTransportProfile = transportProfile;
        transportProfile?.attachPeer(sourcePeer, "source");
        const scanTransport = scanEnabled
            ? new SparseQueryTransportProfile({ maxEvents: 128, maxIds: 64 })
            : undefined;
        lateScanTransport = scanTransport;
        scanTransport?.attachPeer(sourcePeer, "source");
        const scanProfile = scanEnabled
            ? new SparseQueryScanProfile({
                  source: sourcePeer.identity.publicKey.hashcode(),
                  transport: scanTransport,
              })
            : undefined;
        lateScanProfile = scanProfile;
        const profile =
            process.env.PEERBIT_SHARED_FS_SPARSE_PROFILE === "1"
                ? new SparseQueryProfile({
                      source: sourcePeer.identity.publicKey.hashcode(),
                      maxEvents: 512,
                  })
                : undefined;
        firstOperationProfile = profile;
        profileContext = profile
            ? {
                  schema: 1,
                  files,
                  source: sourcePeer.identity.publicKey.hashcode(),
                  applicationGeneration: 0,
                  platform: process.platform,
                  arch: process.arch,
                  node: process.version,
                  readinessAPI:
                      "entries.waitFor (unchanged from original probe)",
                  queryOptions: {
                      local: false,
                      replicate: false,
                      timeout: 5000,
                      retries: false,
                  },
              }
            : undefined;
        const measure = <T>(label: string, fn: () => Promise<T>) =>
            profile ? profile.measure(label, fn) : fn();
        const openProfile = {
            events: [] as Array<Record<string, unknown>>,
            dropped: 0,
            callbackErrors: 0,
        };
        if (profileContext) profileContext.openProfile = openProfile;
        const source = await openSharedFs({
            peerbit: sourcePeer,
            machineLabel: "sparse-source",
            bootstrap: false,
        });
        await source.writeBatch(
            Array.from({ length: files }, (_, i) => ({
                path: `/cold/f-${i}.bin`,
                content: payload(i),
            }))
        );
        await source.mkdir("/elsewhere");
        const sourceDocuments = await source.program.entries.index.getSize();
        expect(sourceDocuments).toBeGreaterThanOrEqual(files * 3);

        const observerPeer = await Peerbit.create();
        peers.push(observerPeer);
        transportProfile?.attachPeer(observerPeer, "observer");
        scanTransport?.attachPeer(observerPeer, "observer");
        if (profileContext) {
            profileContext.observer =
                observerPeer.identity.publicKey.hashcode();
            profileContext.address = source.address;
        }
        await measure("observer-dial", () => observerPeer.dial(sourcePeer));
        const openStart = performance.now();
        const observer = await measure("observer-open", () =>
            openSharedFs({
                peerbit: observerPeer,
                address: source.address,
                machineLabel: "sparse-observer",
                replicate: false,
                bootstrap: false,
                ...(profile
                    ? {
                          telemetry: {
                              openProfile: (event) => {
                                  try {
                                      if (openProfile.events.length >= 64) {
                                          openProfile.dropped++;
                                          return;
                                      }
                                      openProfile.events.push({
                                          name: event.name.slice(0, 128),
                                          durationMs: event.durationMs,
                                          count: event.count,
                                          entries: event.entries,
                                          targets: event.targets,
                                          cacheHit: event.cacheHit,
                                          traceId: event.traceId?.slice(0, 128),
                                          details: event.details
                                              ? Object.fromEntries(
                                                    Object.entries(
                                                        event.details
                                                    )
                                                        .slice(0, 16)
                                                        .map(([key, value]) => [
                                                            key.slice(0, 128),
                                                            typeof value ===
                                                            "string"
                                                                ? value.slice(
                                                                      0,
                                                                      128
                                                                  )
                                                                : value,
                                                        ])
                                                )
                                              : undefined,
                                      });
                                  } catch {
                                      openProfile.callbackErrors++;
                                  }
                              },
                          },
                      }
                    : {}),
            })
        );
        const openMs = performance.now() - openStart;
        transportProfile?.arm(source.program.entries, observer.program.entries);
        scanTransport?.arm(source.program.entries, observer.program.entries);
        await measure("post-open-readiness", () =>
            observer.program.entries.waitFor(sourcePeer.identity.publicKey, {
                timeout: 5_000,
            })
        );
        const before = await measure("initial-residency", () =>
            residency(observerPeer, observer)
        );
        expect(before).toMatchObject({
            documents: 0,
            logEntries: 0,
            ranges: 0,
        });
        const initialEntries = profile
            ? profile.wrap(observer.program.entries)
            : observer.program.entries;
        const reader = new SparseQueryClient(
            scanProfile
                ? scanProfile.wrap(observer.program.entries, initialEntries)
                : initialEntries,
            sourcePeer.identity.publicKey.hashcode()
        );
        const firstStart = performance.now();
        const cold = await measure("lookup-root-cold", () =>
            reader.lookup("root", "cold")
        );
        expect(cold.status).toBe("observed");
        const selected = await measure("lookup-selected-slot", () =>
            reader.lookup(cold.nodeId!, "f-0.bin")
        );
        expect(selected.status).toBe("observed");
        const nodeId = selected.nodeId!;
        const first = await measure("read-selected-node", () =>
            reader.readNode(nodeId)
        );
        profile?.stop();
        transportProfile?.stop();
        expect(first.status).toBe("observed");
        expect(first.bytes).toEqual(payload(0));
        expect(reader.counters.chunkFetches).toBe(1);
        const firstReadMs = performance.now() - firstStart;
        first.bytes!.fill(255);
        expect(await residency(observerPeer, observer)).toEqual(before);
        const warmStart = performance.now();
        expect((await reader.readNode(nodeId)).bytes).toEqual(payload(0));
        const warmReadMs = performance.now() - warmStart;
        expect(reader.counters.chunkFetches).toBe(1);
        expect(reader.counters.cacheHits).toBe(1);

        const scan = Math.min(files, 128);
        scanProfile?.begin();
        const scanStart = performance.now();
        const scanFile = async (i: number) => {
            const slot = await reader.lookup(cold.nodeId!, `f-${i}.bin`);
            expect((await reader.readNode(slot.nodeId!)).bytes).toEqual(
                payload(i)
            );
            expect(reader.cache.stats().bytes).toBeLessThanOrEqual(16 * 1024);
            expect(reader.cache.stats().entries).toBeLessThanOrEqual(4);
        };
        for (let i = 1; i < scan; i++) {
            if (scanProfile) await scanProfile.measure(i, () => scanFile(i));
            else await scanFile(i);
        }
        const scanMs = performance.now() - scanStart;
        scanProfile?.stop();
        scanTransport?.stop();
        if (scanProfile) {
            const report = scanProfile.snapshot();
            expect(report.counters).toEqual({
                completedWindows: scan - 1,
                failedWindows: 0,
                diagnosticErrors: 0,
                phaseDropped: 0,
                phaseObserverErrors: 0,
            });
            expect(report.windows).toHaveLength(8);
            expect(report.firstFailure).toBeUndefined();
            const perFile = {
                "naming-slot": 1,
                "naming-node": 2,
                "versions-node": 1,
                "chunk-id": 1,
                unknown: 0,
            };
            for (const [kind, count] of Object.entries(perFile)) {
                const aggregate =
                    report.aggregates[kind as keyof typeof perFile];
                expect(aggregate).toMatchObject({
                    queries: count * (scan - 1),
                    nextCalls: count * (scan - 1),
                    nextRejected: 0,
                    closeCalls: count * (scan - 1),
                    closeRejected: 0,
                });
                expect(
                    aggregate.nextBuckets.reduce((sum, value) => sum + value, 0)
                ).toBe(count * (scan - 1));
            }
            // Also check the final stopped recorder: a late boundary between
            // the last drain and stop belongs to the unassigned tail.
            for (const counters of [
                report.transportCounters,
                scanTransport?.snapshot().counters,
            ])
                expect(counters).toMatchObject({
                    eventsDropped: 0,
                    idsDropped: 0,
                    malformed: 0,
                    duplicates: 0,
                    captureErrors: 0,
                });
        }
        expect(reader.cache.stats().evictions).toBe(scan - 4);
        const scanCache = reader.cache.stats();
        expect(await residency(observerPeer, observer)).toEqual(before);
        const fetchesBeforeReread = reader.counters.chunkFetches;
        expect((await reader.readNode(nodeId)).bytes).toEqual(payload(0));
        expect(reader.counters.chunkFetches).toBe(fetchesBeforeReread + 1);

        await source.writeFile("/cold/f-0.bin", payload(10_001));
        expect((await reader.readNode(nodeId)).bytes).toEqual(payload(10_001));
        await source.rename("/cold/f-0.bin", "/elsewhere/renamed.bin");
        expect((await reader.lookup(cold.nodeId!, "f-0.bin")).status).toBe(
            "not-observed"
        );
        const destination = await reader.lookup("root", "elsewhere");
        expect(
            (await reader.lookup(destination.nodeId!, "renamed.bin")).nodeId
        ).toBe(nodeId);
        expect((await reader.readNode(nodeId)).naming?.name).toBe(
            "renamed.bin"
        );

        reader.disconnect();
        await observerPeer.hangUp(sourcePeer.identity.publicKey);
        await expect(reader.readNode(nodeId)).rejects.toThrow("disconnected");
        expect(reader.cache.stats()).toMatchObject({ entries: 0, bytes: 0 });
        await source.writeFile("/elsewhere/renamed.bin", payload(10_002));
        await observerPeer.dial(sourcePeer);
        await observer.program.entries.waitFor(sourcePeer.identity.publicKey, {
            timeout: 5_000,
        });
        reader.reconnect();
        // Fresh slot + stable-ID queries, not reuse of a stale path-to-node binding.
        expect(
            (await reader.lookup(destination.nodeId!, "renamed.bin")).nodeId
        ).toBe(nodeId);
        expect((await reader.readNode(nodeId)).bytes).toEqual(payload(10_002));
        await source.rm("/elsewhere/renamed.bin");
        expect((await reader.readNode(nodeId)).status).toBe("deleted");
        expect(
            (await reader.lookup(destination.nodeId!, "renamed.bin")).status
        ).toBe("not-observed");
        const after = await residency(observerPeer, observer);
        expect(after).toEqual(before);
        console.log(
            JSON.stringify({
                event: "shared-fs.sparse-query-probe",
                files,
                sourceDocuments,
                fixturePayloadBytes: files * 4096,
                totalUniqueReadFiles: scan,
                timedScanFiles: scan - 1,
                openMs,
                firstPathLookupAndReadMs: firstReadMs,
                warmNodeReadMs: warmReadMs,
                scanMs,
                scanCache,
                before,
                after,
                counters: reader.counters,
                cache: reader.cache.stats(),
                scope: "single-source read-only explicit-refresh; not live push, global completeness, N-receipts or physical reclamation",
            })
        );
        reader.disconnect();
    }
);
