import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    COHORT_PROFILES,
    PUBSUB_PROTOCOL,
    TRANSPORT_COUNTER_KEY_FIELDS,
    auditEndpointTransport,
    baselineDuplicateCarrierObserved,
    buildCampaignReport,
    combineCampaignReports,
    evaluateCounterpartDeltaSkew,
    evaluatePerformanceGate,
    evaluateVariantCarrierGate,
} from "./file-share-pruning-campaign.mjs";

const P = 536_870_912;

const transportStream = ({
    direction,
    remotePeerHash,
    remotePeer,
    connectionId,
    id,
    multiplexer,
    bytes,
}) => ({
    service: "pubsub",
    remotePeerHash,
    peerHashIdentityMatch: true,
    remotePeer,
    direction,
    serviceProtocol: PUBSUB_PROTOCOL,
    expectedProtocol: PUBSUB_PROTOCOL,
    protocol: PUBSUB_PROTOCOL,
    protocolIdentityMatch: true,
    counterStreamIdentityMatch: true,
    connectionIdentityMatchCount: 1,
    connectionId,
    id,
    multiplexer,
    bytes,
    aborted: direction === "outbound" ? false : null,
});

const topology = (streams) => ({ transportStreams: streams });

test("audits exact local keys and accepts both legitimate Yamux protocol names", () => {
    const properties = [
        {
            connectionId: "connection-a",
            id: "stream-a",
            multiplexer: "/yamux/1.0.0",
            initial: 100,
            delta: P,
        },
        {
            connectionId: "connection-b",
            id: "stream-b",
            multiplexer: "/peerbit/yamux/1.0.0",
            initial: 200,
            delta: P + 1024,
        },
    ];
    const make = (entry, after) =>
        transportStream({
            direction: "outbound",
            remotePeerHash: "reader-hash",
            remotePeer: "reader-peer-id",
            connectionId: entry.connectionId,
            id: entry.id,
            multiplexer: entry.multiplexer,
            bytes: entry.initial + (after ? entry.delta : 0),
        });
    const evidence = auditEndpointTransport({
        beforeTopology: topology(properties.map((entry) => make(entry, false))),
        afterTopology: topology(properties.map((entry) => make(entry, true))),
        direction: "outbound",
        expectedRemotePeerHash: "reader-hash",
        expectedRemotePeerId: "reader-peer-id",
        label: "writer",
    });

    assert.deepEqual(evidence.keyFields, TRANSPORT_COUNTER_KEY_FIELDS);
    assert.equal(evidence.carrierCount, 2);
    assert.equal(evidence.totalDeltaBytes, 2 * P + 1024);
    assert.deepEqual(evidence.actualMultiplexers, [
        "/peerbit/yamux/1.0.0",
        "/yamux/1.0.0",
    ]);
    assert.equal(evaluateVariantCarrierGate("baseline", evidence), true);
    assert.equal(evaluateVariantCarrierGate("head", evidence), false);
});

test("does not compare local connection ids across endpoints", () => {
    const writerBefore = transportStream({
        direction: "outbound",
        remotePeerHash: "reader-hash",
        remotePeer: "reader-peer-id",
        connectionId: "writer-local-connection",
        id: "writer-local-stream",
        multiplexer: "/yamux/1.0.0",
        bytes: 10,
    });
    const writerAfter = { ...writerBefore, bytes: 10 + P };
    const readerBefore = transportStream({
        direction: "inbound",
        remotePeerHash: "writer-hash",
        remotePeer: "writer-peer-id",
        connectionId: "reader-local-connection",
        id: "reader-local-stream",
        multiplexer: "/peerbit/yamux/1.0.0",
        bytes: 20,
    });
    const readerAfter = { ...readerBefore, bytes: 20 + P };
    const writer = auditEndpointTransport({
        beforeTopology: topology([writerBefore]),
        afterTopology: topology([writerAfter]),
        direction: "outbound",
        expectedRemotePeerHash: "reader-hash",
        expectedRemotePeerId: "reader-peer-id",
        label: "writer",
    });
    const reader = auditEndpointTransport({
        beforeTopology: topology([readerBefore]),
        afterTopology: topology([readerAfter]),
        direction: "inbound",
        expectedRemotePeerHash: "writer-hash",
        expectedRemotePeerId: "writer-peer-id",
        label: "reader",
    });

    assert.equal(writer.totalDeltaBytes, reader.totalDeltaBytes);
    assert.equal(evaluateVariantCarrierGate("head", writer), true);
    assert.equal(evaluateVariantCarrierGate("head", reader), true);
});

test("rejects a peer hash or protocol identity mismatch", () => {
    const before = transportStream({
        direction: "outbound",
        remotePeerHash: "reader-hash",
        remotePeer: "reader-peer-id",
        connectionId: "connection",
        id: "stream",
        multiplexer: "/yamux/1.0.0",
        bytes: 0,
    });
    const after = {
        ...before,
        bytes: P,
        peerHashIdentityMatch: false,
        protocolIdentityMatch: false,
    };
    assert.throws(
        () =>
            auditEndpointTransport({
                beforeTopology: topology([before]),
                afterTopology: topology([after]),
                direction: "outbound",
                expectedRemotePeerHash: "reader-hash",
                expectedRemotePeerId: "reader-peer-id",
                label: "writer",
            }),
        /not authoritative/
    );
});

test("rejects malformed transport entries before counterpart filtering", () => {
    assert.throws(
        () =>
            auditEndpointTransport({
                beforeTopology: topology([null]),
                afterTopology: topology([null]),
                direction: "outbound",
                expectedRemotePeerHash: "reader-hash",
                expectedRemotePeerId: "reader-peer-id",
                label: "writer",
            }),
        /malformed transport stream entry/
    );
});

test("rejects the correct peer id paired with the wrong peer hash", () => {
    const malformed = transportStream({
        direction: "outbound",
        remotePeerHash: "wrong-hash",
        remotePeer: "reader-peer-id",
        connectionId: "connection",
        id: "stream",
        multiplexer: "/yamux/1.0.0",
        bytes: 0,
    });
    assert.throws(
        () =>
            auditEndpointTransport({
                beforeTopology: topology([malformed]),
                afterTopology: topology([malformed]),
                direction: "outbound",
                expectedRemotePeerHash: "reader-hash",
                expectedRemotePeerId: "reader-peer-id",
                label: "writer",
            }),
        /not authoritative/
    );
});

test("rejects the correct peer hash paired with the wrong peer id", () => {
    const malformed = transportStream({
        direction: "outbound",
        remotePeerHash: "reader-hash",
        remotePeer: "wrong-peer-id",
        connectionId: "connection",
        id: "stream",
        multiplexer: "/yamux/1.0.0",
        bytes: 0,
    });
    assert.throws(
        () =>
            auditEndpointTransport({
                beforeTopology: topology([malformed]),
                afterTopology: topology([malformed]),
                direction: "outbound",
                expectedRemotePeerHash: "reader-hash",
                expectedRemotePeerId: "reader-peer-id",
                label: "writer",
            }),
        /not authoritative/
    );
});

test("rejects duplicate local transport keys", () => {
    const duplicate = transportStream({
        direction: "outbound",
        remotePeerHash: "reader-hash",
        remotePeer: "reader-peer-id",
        connectionId: "connection",
        id: "stream",
        multiplexer: "/yamux/1.0.0",
        bytes: 0,
    });
    assert.throws(
        () =>
            auditEndpointTransport({
                beforeTopology: topology([duplicate, { ...duplicate }]),
                afterTopology: topology([duplicate, { ...duplicate }]),
                direction: "outbound",
                expectedRemotePeerHash: "reader-hash",
                expectedRemotePeerId: "reader-peer-id",
                label: "writer",
            }),
        /duplicate local transport key/
    );
});

test("rejects a decreasing transport counter", () => {
    const before = transportStream({
        direction: "outbound",
        remotePeerHash: "reader-hash",
        remotePeer: "reader-peer-id",
        connectionId: "connection",
        id: "stream",
        multiplexer: "/yamux/1.0.0",
        bytes: 10,
    });
    assert.throws(
        () =>
            auditEndpointTransport({
                beforeTopology: topology([before]),
                afterTopology: topology([{ ...before, bytes: 9 }]),
                direction: "outbound",
                expectedRemotePeerHash: "reader-hash",
                expectedRemotePeerId: "reader-peer-id",
                label: "writer",
            }),
        /counter decreased/
    );
});

test("rejects a changed pre/post local transport key set", () => {
    const before = transportStream({
        direction: "outbound",
        remotePeerHash: "reader-hash",
        remotePeer: "reader-peer-id",
        connectionId: "before-connection",
        id: "stream",
        multiplexer: "/yamux/1.0.0",
        bytes: 0,
    });
    const after = {
        ...before,
        connectionId: "after-connection",
        bytes: P,
    };
    assert.throws(
        () =>
            auditEndpointTransport({
                beforeTopology: topology([before]),
                afterTopology: topology([after]),
                direction: "outbound",
                expectedRemotePeerHash: "reader-hash",
                expectedRemotePeerId: "reader-peer-id",
                label: "writer",
            }),
        /key set changed/
    );
});

test("performance safety permits at most a ten-percent primary timing regression", () => {
    const baseline = {
        libraryStreamWallMs: 100_000,
        secondHalfMs: 50_000,
        demandWaitSumMs: 80_000,
        secondHalfDemandWaitMs: 40_000,
        browserGrowthBytes: 500_000_000,
        combinedGrowthBytes: 700_000_000,
    };
    const within = {
        ...baseline,
        libraryStreamWallMs: 110_000,
        secondHalfMs: 55_000,
    };
    const regression = {
        ...within,
        secondHalfMs: 55_001,
    };

    assert.equal(evaluatePerformanceGate(baseline, within).passed, true);
    assert.equal(evaluatePerformanceGate(baseline, regression).passed, false);
});

test("separates baseline carrier safety from duplicate-condition evidence", () => {
    const headAtBoundary = {
        carrierCount: 1,
        dominantDeltaBytes: P,
        totalDeltaBytes: P,
        dominantShare: 1,
        duplicationFactor: 1,
    };
    const duplicateBoundaryTotal = Math.ceil(1.8 * P);
    const baselineAtBoundary = {
        carrierCount: 2,
        dominantDeltaBytes: P,
        totalDeltaBytes: duplicateBoundaryTotal,
        dominantShare: P / duplicateBoundaryTotal,
        duplicationFactor: duplicateBoundaryTotal / P,
    };
    const baselineSingle = { ...headAtBoundary };
    assert.equal(evaluateVariantCarrierGate("head", headAtBoundary), true);
    assert.equal(
        evaluateVariantCarrierGate("head", {
            ...headAtBoundary,
            totalDeltaBytes: 553_648_129,
        }),
        false
    );
    assert.equal(
        evaluateVariantCarrierGate("baseline", baselineAtBoundary),
        true
    );
    assert.equal(evaluateVariantCarrierGate("baseline", baselineSingle), true);
    assert.equal(baselineDuplicateCarrierObserved(baselineSingle), false);
    assert.equal(
        evaluateVariantCarrierGate("baseline", {
            ...baselineSingle,
            totalDeltaBytes: P + 1,
            dominantShare: P / (P + 1),
            duplicationFactor: (P + 1) / P,
        }),
        true
    );
    assert.equal(baselineDuplicateCarrierObserved(baselineAtBoundary), true);
    assert.equal(
        baselineDuplicateCarrierObserved({
            ...baselineAtBoundary,
            duplicationFactor: 1.799,
        }),
        false
    );
    assert.equal(
        evaluateVariantCarrierGate("baseline", {
            ...baselineAtBoundary,
            totalDeltaBytes: 2 * 553_648_128 + 1,
        }),
        false
    );
});

test("uses the selected cohort payload when evaluating carrier envelopes", () => {
    const halfLocalCarrier = {
        carrierCount: 1,
        dominantDeltaBytes: P,
        totalDeltaBytes: P,
        dominantShare: 1,
        duplicationFactor: 1,
    };

    assert.equal(
        evaluateVariantCarrierGate(
            "head",
            halfLocalCarrier,
            COHORT_PROFILES["half-local"]
        ),
        true
    );
    assert.equal(
        evaluateVariantCarrierGate(
            "head",
            halfLocalCarrier,
            COHORT_PROFILES["cold-progress"]
        ),
        false
    );
});

test("rejects writer and reader totals more than one MiB apart", () => {
    const within = evaluateCounterpartDeltaSkew(
        { totalDeltaBytes: P },
        { totalDeltaBytes: P + 1_048_576 }
    );
    const outside = evaluateCounterpartDeltaSkew(
        { totalDeltaBytes: P },
        { totalDeltaBytes: P + 1_048_577 }
    );
    assert.equal(within.passed, true);
    assert.equal(outside.passed, false);
});

const indexedRecord = (count, value) =>
    Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
            index,
            typeof value === "function" ? value(index) : value,
        ])
    );

const cleanProvenance = (commit, extra = {}) => ({
    requestedRef: commit,
    resolvedCommit: commit,
    dirty: false,
    worktreeDigest: null,
    ...extra,
});

const CAMPAIGN_FIXTURE_CONTRACT = Object.freeze({
    baseline: "8fc5533b14228b4091dffb3962fc8b1ff088bd89",
    head: "221411b880189df02404e9957591147142423aa2",
    harness: "20a398dcaea3e94e49b886315221cd0a1c562832",
    examples: "0cc0bc74682cd1a7b741232f07f46fe6f67c1cbc",
    lock: "7a306a1baaea4c1374674a56ffe6381e502915fd32670a9cd66814ce5fe114b1",
    sha256: "bvqiNpaxF0jivbi8SZBjuQ2/qU4wXlT+j22AhO6ywHU=",
    crc32: "125fb916",
});

const makeCampaignFixture = ({
    variant,
    contract,
    baselineCarrierCount = 2,
    baselineWriterCarrierCount = baselineCarrierCount,
    baselineReaderCarrierCount = baselineCarrierCount,
}) => {
    const localPrefixBlockCount = contract.localPrefixBlockCount;
    const remoteChunkCount = 2048 - localPrefixBlockCount;
    const remotePayloadBytes = contract.remotePayloadBytes;
    const writerHash = "writer-hash";
    const readerHash = "reader-hash";
    const writerPeerId = "writer-peer-id";
    const readerPeerId = "reader-peer-id";
    const makeStreams = ({ direction, before }) =>
        Array.from(
            {
                length:
                    variant === "baseline"
                        ? direction === "outbound"
                            ? baselineWriterCarrierCount
                            : baselineReaderCarrierCount
                        : 1,
            },
            (_, index) =>
                transportStream({
                    direction,
                    remotePeerHash:
                        direction === "outbound" ? readerHash : writerHash,
                    remotePeer:
                        direction === "outbound" ? readerPeerId : writerPeerId,
                    connectionId: `${direction}-local-connection-${index}`,
                    id: `${direction}-local-stream-${index}`,
                    multiplexer:
                        index === 0 ? "/yamux/1.0.0" : "/peerbit/yamux/1.0.0",
                    bytes: 100 + index + (before ? 0 : remotePayloadBytes),
                })
        );
    const singleton = [writerHash];
    const topologySnapshot = ({
        owner,
        replicatorHashes,
        selfInReplicatorSet,
        streams,
        capturedAt,
    }) => ({
        capturedAt,
        peerHash: owner === "writer" ? writerHash : readerHash,
        peerId: owner === "writer" ? writerPeerId : readerPeerId,
        replicatorHashes,
        replicatorCount: replicatorHashes.length,
        selfInReplicatorSet,
        transportStreams: streams,
    });
    const writerPre = topologySnapshot({
        owner: "writer",
        replicatorHashes: singleton,
        selfInReplicatorSet: true,
        streams: makeStreams({ direction: "outbound", before: true }),
        capturedAt: 1_000,
    });
    const readerPre = topologySnapshot({
        owner: "reader",
        replicatorHashes: singleton,
        selfInReplicatorSet: false,
        streams: makeStreams({ direction: "inbound", before: true }),
        capturedAt: 1_001,
    });
    const writerPost = topologySnapshot({
        owner: "writer",
        replicatorHashes: singleton,
        selfInReplicatorSet: true,
        streams: makeStreams({ direction: "outbound", before: false }),
        capturedAt: 100_000,
    });
    const readerPost = topologySnapshot({
        owner: "reader",
        replicatorHashes: singleton,
        selfInReplicatorSet: false,
        streams: makeStreams({ direction: "inbound", before: false }),
        capturedAt: 100_001,
    });
    const terminalTopologyStartedAt = 110_000;
    const terminalObservations = [110_000, 110_100, 110_200].map(
        (capturedAt) => ({
            capturedAt,
            writerTopology: { ...writerPost, capturedAt },
            readerTopology: { ...readerPost, capturedAt },
        })
    );
    const fullRange = Array.from({ length: 2048 }, (_, index) => index);
    const prefixRange = fullRange.slice(0, localPrefixBlockCount);
    const libraryStreamWallMs = variant === "baseline" ? 100_000 : 90_000;
    const payloadStreamWallMs = variant === "baseline" ? 96_000 : 86_400;
    const readStartedAt = 1_000_000;
    const demandWait = indexedRecord(2048, 10);
    const chunkWriteFinishedAt = indexedRecord(
        2048,
        (index) =>
            readStartedAt +
            Math.ceil((payloadStreamWallMs * (index + 1)) / 2048)
    );
    const readDiagnostics = {
        startedAt: readStartedAt,
        finishedAt: readStartedAt + libraryStreamWallMs,
        persistChunkReads: true,
        programPersistChunkReads: true,
        initialLocalChunkBlockCount: localPrefixBlockCount,
        initialLocalChunkIndexRowCount: 0,
        initialLocalChunkCount: 0,
        chunkWriteFinishedAt,
        chunkByteLength: indexedRecord(2048, 524_288),
        chunkDemandWaitMs: demandWait,
        chunkAttempts: indexedRecord(2048, 1),
        chunkManifestEntryPersistenceFailedCount: 0,
        chunkManifestEntryPersistenceMissingIndices: [],
        chunkManifestEntryContentMismatchIndices: [],
        chunkManifestHeadBatchErrorCount: 0,
        chunkManifestHeadBatchInvalidCount: 0,
        chunkManifestHeadBatchMissingCount: 0,
        chunkManifestHeadPhysicalRemoteRequestErrorCount: 0,
        chunkManifestHeadPhysicalRemoteRequestErrors: [],
        chunkManifestHeadBatchRequestedIndexCount: 2048,
        chunkManifestHeadBatchAcceptedCount: 2048,
        chunkManifestHeadLocalBatchAcceptedCount: localPrefixBlockCount,
        chunkManifestHeadRemoteBatchAcceptedCount: remoteChunkCount,
        chunkManifestHeadPhysicalRemoteRequestCount: remoteChunkCount,
        chunkManifestHeadBatchResolved: indexedRecord(
            2048,
            (index) => `manifest-entry-${index}`
        ),
        maxManifestHeadBatchSize: 1,
        maxManifestHeadLogicalWindowSize: 8,
    };
    const hostStart = 1_000_000_000;
    const browserGrowth = variant === "baseline" ? 200_000_000 : 180_000_000;
    const combinedGrowth = variant === "baseline" ? 240_000_000 : 210_000_000;
    const cleanSeries = {
        sampleCount: 2,
        samplingErrors: [],
        samplingErrorOverflowCount: 0,
    };
    const memory = {
        profile: "download-memory-v2",
        complete: true,
        cleanupComplete: true,
        readerJsHeap: cleanSeries,
        writerJsHeap: cleanSeries,
        hostRss: {
            ...cleanSeries,
            startBrowserBytes: hostStart,
            peakBrowserBytes: hostStart + browserGrowth,
            startCombinedBytes: hostStart + 100_000_000,
            peakCombinedBytes: hostStart + 100_000_000 + combinedGrowth,
        },
    };
    const invocation = {
        schema: {
            id: "peerbit-file-share-benchmark-invocation",
            version: 4,
        },
        scenario: "upload",
        mode: "fixed1",
        networkMode: "local",
        integrationMode: "link",
        fileSizeMb: 1024,
        fileSizeBytes: 1_073_741_824,
        fixtureSeed: "peerbit-file-share-benchmark-v1",
        downloadSink: "hash-only",
        uploadTimeoutMs: 1_200_000,
        downloadTimeoutMs: contract.downloadTimeoutMs,
        postUploadMonitorMs: 5_000,
        pollMs: 1_000,
        minReadySeeders: 1,
        readyTimeoutMs: 120_000,
        sampleMs: 15_000,
        sampleCount: 4,
        targetSeeders: 2,
        readerLocalChunkTarget: localPrefixBlockCount,
        readerLocalChunkMaxOvershoot: 0,
        readerTerminalTopology: "observer",
        baseUrl: null,
        protocol: "http",
        viteMode: null,
        viteConfig: null,
        localPackages: [
            "@peerbit/pubsub",
            "@peerbit/shared-log",
            "@peerbit/stream",
            "peerbit",
        ],
        serverMode: "production-preview",
        serverHost: "127.0.0.1",
        enableVisibilityProbe: false,
        verbose: false,
    };
    const harness = cleanProvenance(contract.harness);
    const peerbit = cleanProvenance(
        variant === "baseline" ? contract.baseline : contract.head
    );
    const examples = cleanProvenance(contract.examples, {
        lockfileSha256: contract.lock,
    });
    const result = {
        schema: { id: "peerbit-file-share-benchmark", version: 9 },
        status: "passed",
        invocation,
        provenance: { harness, peerbit, examples },
        integrity: {
            fixtureMode: "deterministic",
            fixtureFormat: "aes-256-ctr-v1",
            fixtureSeed: "peerbit-file-share-benchmark-v1",
            expectedSizeBytes: 1_073_741_824,
            sourceSizeBytes: 1_073_741_824,
            manifestSizeBytes: 1_073_741_824,
            downloadedSizeBytes: 1_073_741_824,
            sourceSha256Base64: contract.sha256,
            libraryComputedSha256Base64: contract.sha256,
            downloadedSha256Base64: null,
            manifestSha256Base64: contract.sha256,
            sourceCrc32Hex: contract.crc32,
            downloadedCrc32Hex: contract.crc32,
            downloadSink: "hash-only",
            sinkPersistence: "none",
            sinkPersistenceVerified: null,
            sizeVerified: true,
            sha256Verified: true,
            librarySha256Verified: true,
            persistedSinkSha256Verified: null,
            crc32Verified: true,
            manifestVerified: true,
            verified: true,
        },
        integrityVerified: true,
        downloadSink: "hash-only",
        requestedDownloadSink: "hash-only",
        primaryDownloadAuthoritative: true,
        sinkServerWriteCalls: null,
        sinkServerWriteDurationMs: null,
        sinkServerWriteDurationDefinition: null,
        sinkWriteCalls: 2048,
        readTransfer: {
            chunkCount: 2048,
            totalBytes: 1_073_741_824,
            demandWait: { sampleCount: 2048, sumMs: 20_480 },
        },
        libraryStreamWallMs,
        downloadMemoryTelemetry: memory,
        errorCollectionComplete: true,
        errorCount: 0,
        requestFailureCollectionComplete: true,
        requestFailureCount: 0,
        droppedSeeders: false,
        unexpectedSeederDrop: false,
        readerLocalChunkTarget: localPrefixBlockCount,
        readerLocalChunkMaxOvershoot: 0,
        readerTerminalTopology: "observer",
        readerLocalChunkBlockCount: localPrefixBlockCount,
        readerLocalChunkIndexRowCount: 0,
        readerLocalityCohortKey: `observer-persistent-prefix-b${localPrefixBlockCount}-i0`,
        readerLocalityControl: {
            status: "complete",
            failure: null,
            profile: "observer-topology-exact-manifest-prefix",
            provisioningMethod: "exact-manifest-head-import",
            requestedLocalChunkBlockCount: localPrefixBlockCount,
            maxSpeculativeOvershootChunkCount: 0,
            writerUploadRole: "fixed1",
            readerUploadRole: "observer",
            readerTimedReadPolicy: "persist-chunk-reads",
            expectedTerminalTopology: "observer",
            actualLocalChunkBlockCount: localPrefixBlockCount,
            actualLocalChunkIndexRowCount: 0,
            speculativeOvershootChunkCount: 0,
            cohortKey: `observer-persistent-prefix-b${localPrefixBlockCount}-i0`,
            preloadEvidence: {
                requestedManifestEntryCount: localPrefixBlockCount,
                importedManifestEntryCount: localPrefixBlockCount,
                importedManifestEntryIndices: prefixRange,
                localManifestEntryIndicesAfter: prefixRange,
            },
            preDownloadObservation: {
                blockCount: localPrefixBlockCount,
                indexRowCount: 0,
                blockChunkIndices: prefixRange,
                indexedChunkIndices: [],
                persistChunkReads: true,
            },
            writerTopologyBeforeUpload: writerPre,
            readerTopologyBeforeUpload: readerPre,
            writerTopologyBeforeTimedRead: writerPre,
            readerTopologyBeforeTimedRead: readerPre,
            writerTopologyAfterTimedRead: writerPost,
            readerTopologyAfterTimedRead: readerPost,
            terminalIdleObservation: {
                capturedAt: 109_999,
                chunkCount: 2048,
                blockCount: 2048,
                indexRowCount: 0,
                blockChunkIndices: fullRange,
                indexedChunkIndices: [],
                persistChunkReads: true,
            },
            terminalTopologyRole: "observer",
            terminalTopologyExpectationSatisfied: true,
            stabilityPollIntervalMs: 100,
            terminalTopologyStartedAt,
            terminalTopologyDeadlineAt: terminalTopologyStartedAt + 120_000,
            terminalTopologyFinishedAt: 110_200,
            terminalTopologyObservations: terminalObservations,
        },
        writerDiagnostics: {
            peerHash: writerHash,
            replicatorCount: 1,
            replicationSetSize: 1,
            lastUploadDiagnostics: {
                sizeBytes: 1_073_741_824,
                chunkSize: 524_288,
                chunkCount: 2048,
                chunkPutCount: 2048,
            },
        },
        readerDiagnostics: {
            peerHash: readerHash,
            replicatorCount: 1,
            replicationSetSize: 1,
            lastReadDiagnostics: readDiagnostics,
        },
    };
    return {
        schema: {
            id: "peerbit-file-share-benchmark-summary",
            version: 5,
        },
        status: "passed",
        harnessProvenance: harness,
        peerbitProvenance: peerbit,
        examplesProvenance: examples,
        results: [result],
    };
};

const buildFixtureReport = (
    context,
    {
        order = "baseline-head",
        runId = "1",
        baselineCarrierCount = 2,
        baselineWriterCarrierCount = baselineCarrierCount,
        baselineReaderCarrierCount = baselineCarrierCount,
        cohortProfile = "half-local",
        environmentOverrides = {},
        mutate,
    } = {}
) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pruning-report-test-"));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const profileContract = COHORT_PROFILES[cohortProfile];
    assert.ok(profileContract);
    const fixtureContract = {
        ...CAMPAIGN_FIXTURE_CONTRACT,
        ...profileContract,
        cohortProfile,
    };
    const summaries = {
        baseline: makeCampaignFixture({
            variant: "baseline",
            contract: fixtureContract,
            baselineCarrierCount,
            baselineWriterCarrierCount,
            baselineReaderCarrierCount,
        }),
        head: makeCampaignFixture({
            variant: "head",
            contract: fixtureContract,
        }),
    };
    mutate?.(summaries);
    const variants = order.split("-");
    for (const [index, variant] of variants.entries()) {
        fs.writeFileSync(
            path.join(root, `${index + 1}-${variant}-summary.json`),
            JSON.stringify(summaries[variant])
        );
    }
    fs.writeFileSync(path.join(root, "order.txt"), `${variants.join("\n")}\n`);
    fs.writeFileSync(path.join(root, "overall-run-status.txt"), "0\n");
    return buildCampaignReport({
        RESULTS_ROOT: root,
        PAIR_ORDER: order,
        BASE_CORE_COMMIT: CAMPAIGN_FIXTURE_CONTRACT.baseline,
        HEAD_CORE_COMMIT: CAMPAIGN_FIXTURE_CONTRACT.head,
        HARNESS_CORE_COMMIT: CAMPAIGN_FIXTURE_CONTRACT.harness,
        EXAMPLES_COMMIT: CAMPAIGN_FIXTURE_CONTRACT.examples,
        EXAMPLES_LOCK_SHA256: CAMPAIGN_FIXTURE_CONTRACT.lock,
        EXPECTED_SHA256_BASE64: CAMPAIGN_FIXTURE_CONTRACT.sha256,
        EXPECTED_CRC32_HEX: CAMPAIGN_FIXTURE_CONTRACT.crc32,
        FIXTURE_SEED: "peerbit-file-share-benchmark-v1",
        COHORT_PROFILE: cohortProfile,
        LOCAL_PREFIX_BLOCK_COUNT: String(profileContract.localPrefixBlockCount),
        LOCAL_PREFIX_INDEX_ROW_COUNT: String(
            profileContract.localPrefixIndexRowCount
        ),
        REMOTE_PAYLOAD_BYTES: String(profileContract.remotePayloadBytes),
        REMOTE_PAYLOAD_UPPER_BYTES: String(
            profileContract.remotePayloadUpperBytes
        ),
        DOWNLOAD_TIMEOUT_MS: String(profileContract.downloadTimeoutMs),
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "dao-xyz/peerbit-examples",
        GITHUB_RUN_ID: runId,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_ACTOR: "peerbit-org",
        GITHUB_TRIGGERING_ACTOR: "peerbit-org",
        GITHUB_WORKFLOW_REF:
            "dao-xyz/peerbit-examples/.github/workflows/file-share-benchmarks.yml@refs/heads/test",
        GITHUB_WORKFLOW_SHA: "a".repeat(40),
        ...environmentOverrides,
    });
};

const setUniformProgressTimings = (
    metrics,
    { quarterMs, postPayloadFinalizeMs }
) => {
    const quarterPayloadMiB = 256;
    const halfPayloadMiB = 512;
    metrics.quarter1Ms = quarterMs;
    metrics.quarter2Ms = quarterMs;
    metrics.quarter3Ms = quarterMs;
    metrics.quarter4Ms = quarterMs;
    metrics.firstHalfMs = quarterMs * 2;
    metrics.secondHalfMs = quarterMs * 2;
    metrics.payloadStreamWallMs = quarterMs * 4;
    metrics.postPayloadFinalizeMs = postPayloadFinalizeMs;
    metrics.libraryStreamWallMs =
        metrics.payloadStreamWallMs + postPayloadFinalizeMs;
    metrics.firstHalfMiBPerSecond =
        halfPayloadMiB / (metrics.firstHalfMs / 1_000);
    metrics.secondHalfMiBPerSecond =
        halfPayloadMiB / (metrics.secondHalfMs / 1_000);
    metrics.secondHalfOverFirstHalfDuration = 1;
    metrics.quarter1MiBPerSecond = quarterPayloadMiB / (quarterMs / 1_000);
    metrics.quarter2MiBPerSecond = quarterPayloadMiB / (quarterMs / 1_000);
    metrics.quarter3MiBPerSecond = quarterPayloadMiB / (quarterMs / 1_000);
    metrics.quarter4MiBPerSecond = quarterPayloadMiB / (quarterMs / 1_000);
    metrics.fourthQuarterOverFirstQuarterDuration = 1;
    metrics.fourthQuarterOverThirdQuarterDuration = 1;
};

test("builds valid pair evidence while leaving aggregate acceptance unevaluated", (context) => {
    const report = buildFixtureReport(context);

    assert.equal(
        report.assessments.correctnessAndTransportEvidence.passed,
        true
    );
    assert.equal(report.assessments.performanceEvidenceValidity.passed, true);
    assert.equal(report.assessments.perPairPerformanceSafety.passed, true);
    assert.equal(report.workflowGatePassed, true);
    assert.equal(report.assessments.campaignAcceptance.passed, null);
    assert.equal(
        report.assessments.campaignAcceptance.evaluatedBySingleRun,
        false
    );
    assert.equal(
        report.assessments.baselineDuplicateCarrierCondition.observed,
        true
    );
    assert.equal(report.assessments.pruningBenefitEvidence.passed, true);
    assert.equal(
        report.assessments.correctnessAndTransportEvidence
            .comparativeCarrierTotals.writer.headOverBaseline,
        0.5
    );
});

test("keeps a safe single-carrier baseline correct and benefit unevaluated", (context) => {
    const report = buildFixtureReport(context, { baselineCarrierCount: 1 });

    assert.equal(
        report.assessments.correctnessAndTransportEvidence.passed,
        true
    );
    assert.equal(report.workflowGatePassed, true);
    assert.equal(
        report.assessments.baselineDuplicateCarrierCondition.observed,
        false
    );
    assert.deepEqual(report.assessments.pruningBenefitEvidence, {
        passed: null,
        evaluated: false,
        gatesWorkflow: false,
        evidenceIssues: [],
        definition:
            "per-pair carrier-byte reduction is evaluated only when the duplicate-carrier condition is actually observed on both baseline endpoints; otherwise pruning benefit remains explicitly unevaluated",
    });
    assert.equal(
        report.assessments.correctnessAndTransportEvidence
            .comparativeCarrierTotals.writer.passed,
        null
    );
});

test("builds an exact all-remote cold-progress pair with fixed quarter metrics", (context) => {
    const report = buildFixtureReport(context, {
        cohortProfile: "cold-progress",
        baselineCarrierCount: 1,
    });

    assert.equal(report.workflowGatePassed, true);
    assert.equal(report.campaignContract.cohortProfile, "cold-progress");
    assert.equal(report.campaignContract.localPrefixBlockCount, 0);
    assert.equal(report.campaignContract.allPayloadRemote, true);
    assert.equal(report.campaignContract.remotePayloadBytes, 1_073_741_824);
    assert.equal(report.campaignContract.downloadTimeoutMs, 5_400_000);
    assert.deepEqual(report.baseline.cohort, {
        key: "observer-persistent-prefix-b0-i0",
        blockCount: 0,
        indexRowCount: 0,
    });
    assert.equal(report.baseline.metrics.quarter1Ms, 24_000);
    assert.equal(report.baseline.metrics.quarter2Ms, 24_000);
    assert.equal(report.baseline.metrics.quarter3Ms, 24_000);
    assert.equal(report.baseline.metrics.quarter4Ms, 24_000);
    assert.equal(report.baseline.metrics.postPayloadFinalizeMs, 4_000);
    assert.equal(report.baseline.metrics.firstHalfDemandWaitMs, 10_240);
    assert.equal(report.baseline.metrics.secondHalfDemandWaitMs, 10_240);
    assert.equal(report.baseline.metrics.quarter1DemandWaitMs, 5_120);
    assert.equal(
        report.baseline.transport.writer.totalDeltaBytes,
        1_073_741_824
    );
    assert.equal(report.assessments.pruningBenefitEvidence.passed, null);
});

test("rejects a cold cohort missing one physical remote request", (context) => {
    const report = buildFixtureReport(context, {
        cohortProfile: "cold-progress",
        mutate: ({ baseline }) => {
            baseline.results[0].readerDiagnostics.lastReadDiagnostics.chunkManifestHeadPhysicalRemoteRequestCount = 2047;
        },
    });

    assert.equal(report.workflowGatePassed, false);
    assert.ok(
        report.baseline.correctnessIssues.includes(
            "manifest-persistence-and-head-geometry"
        )
    );
});

test("rejects any locally accepted chunk in the all-remote cohort", (context) => {
    const report = buildFixtureReport(context, {
        cohortProfile: "cold-progress",
        mutate: ({ baseline }) => {
            const read =
                baseline.results[0].readerDiagnostics.lastReadDiagnostics;
            read.chunkManifestHeadLocalBatchAcceptedCount = 1;
            read.chunkManifestHeadRemoteBatchAcceptedCount = 2047;
        },
    });

    assert.equal(report.workflowGatePassed, false);
    assert.ok(
        report.baseline.correctnessIssues.includes(
            "manifest-persistence-and-head-geometry"
        )
    );
});

test("rejects declared geometry that does not exactly match the cohort profile", (context) => {
    assert.throws(
        () =>
            buildFixtureReport(context, {
                cohortProfile: "cold-progress",
                environmentOverrides: {
                    LOCAL_PREFIX_BLOCK_COUNT: "1",
                },
            }),
        /LOCAL_PREFIX_BLOCK_COUNT does not match cohort profile cold-progress/
    );
});

test("rejects an incomplete all-chunk progress timestamp series", (context) => {
    const report = buildFixtureReport(context, {
        cohortProfile: "cold-progress",
        mutate: ({ baseline }) => {
            delete baseline.results[0].readerDiagnostics.lastReadDiagnostics
                .chunkWriteFinishedAt[2047];
        },
    });

    assert.equal(report.workflowGatePassed, false);
    assert.ok(
        report.baseline.performanceIssues.includes(
            "chunk-write-finished-series"
        )
    );
});

test("rejects a progress timestamp outside the read interval", (context) => {
    const report = buildFixtureReport(context, {
        cohortProfile: "cold-progress",
        mutate: ({ baseline }) => {
            baseline.results[0].readerDiagnostics.lastReadDiagnostics.chunkWriteFinishedAt[0] = 999_999;
        },
    });

    assert.equal(report.workflowGatePassed, false);
    assert.ok(
        report.baseline.performanceIssues.includes("read-quarter-boundaries")
    );
});

test("rejects an out-of-order interior progress timestamp", (context) => {
    const report = buildFixtureReport(context, {
        cohortProfile: "cold-progress",
        mutate: ({ baseline }) => {
            const timestamps =
                baseline.results[0].readerDiagnostics.lastReadDiagnostics
                    .chunkWriteFinishedAt;
            timestamps[1000] = timestamps[999] - 1;
        },
    });

    assert.equal(report.workflowGatePassed, false);
    assert.ok(
        report.baseline.performanceIssues.includes("read-quarter-boundaries")
    );
});

test("rejects a post-read reader promotion from the observer cohort", (context) => {
    const report = buildFixtureReport(context, {
        mutate: ({ baseline }) => {
            const locality = baseline.results[0].readerLocalityControl;
            locality.readerTopologyAfterTimedRead.selfInReplicatorSet = true;
            locality.readerTopologyAfterTimedRead.replicatorCount = 2;
            locality.readerTopologyAfterTimedRead.replicatorHashes = [
                "reader-hash",
                "writer-hash",
            ].sort();
        },
    });

    assert.equal(report.workflowGatePassed, false);
    assert.ok(
        report.baseline.correctnessIssues.includes(
            "post-read-writer-only-singleton"
        )
    );
});

test("rejects terminal observer snapshots without the required stable spacing", (context) => {
    const report = buildFixtureReport(context, {
        mutate: ({ baseline }) => {
            const observations =
                baseline.results[0].readerLocalityControl
                    .terminalTopologyObservations;
            observations[1].capturedAt = observations[0].capturedAt + 99;
        },
    });

    assert.equal(report.workflowGatePassed, false);
    assert.ok(
        report.baseline.correctnessIssues.includes(
            "terminal-topology-chronology"
        )
    );
});

test("fails inconsistent endpoint transport while leaving benefit unevaluated", (context) => {
    const report = buildFixtureReport(context, {
        baselineWriterCarrierCount: 2,
        baselineReaderCarrierCount: 1,
    });

    assert.equal(report.workflowGatePassed, false);
    assert.equal(
        report.assessments.baselineDuplicateCarrierCondition
            .endpointClassificationConsistent,
        false
    );
    assert.equal(report.assessments.pruningBenefitEvidence.passed, null);
    assert.ok(
        report.benefitIssues.includes(
            "baseline-duplicate-carrier-condition-endpoint-mismatch"
        )
    );
});

test("combines opposite orders and removes a noisy single-order timing effect", (context) => {
    const baselineHead = buildFixtureReport(context, {
        order: "baseline-head",
        runId: "1",
        baselineCarrierCount: 1,
    });
    const headBaseline = buildFixtureReport(context, {
        order: "head-baseline",
        runId: "2",
        baselineCarrierCount: 1,
    });
    setUniformProgressTimings(baselineHead.baseline.metrics, {
        quarterMs: 25,
        postPayloadFinalizeMs: 0,
    });
    setUniformProgressTimings(baselineHead.head.metrics, {
        quarterMs: 28,
        postPayloadFinalizeMs: 0,
    });
    setUniformProgressTimings(headBaseline.baseline.metrics, {
        quarterMs: 25,
        postPayloadFinalizeMs: 0,
    });
    setUniformProgressTimings(headBaseline.head.metrics, {
        quarterMs: 24,
        postPayloadFinalizeMs: 0,
    });
    baselineHead.delta.libraryStreamWallMs.headOverBaseline = 99;
    baselineHead.delta.secondHalfMs.headOverBaseline = 99;

    const combined = combineCampaignReports([baselineHead, headBaseline]);

    assert.equal(combined.assessments.evidenceValidity.passed, true);
    assert.equal(combined.assessments.regressionSafety.passed, true);
    assert.equal(
        combined.assessments.baselineDuplicateCarrierCondition.observedInBoth,
        false
    );
    assert.equal(combined.assessments.pruningBenefit.passed, null);
    assert.equal(
        combined.assessments.progressSlowdownDiagnostic.evaluated,
        false
    );
    assert.equal(combined.assessments.campaignAcceptance.passed, true);
    assert.equal(combined.workflowGatePassed, true);
    assert.ok(combined.aggregateRatios.libraryStreamWallHeadOverBaseline < 1.1);
});

test("combines all-remote progress metrics across opposite orders", (context) => {
    const reports = [
        buildFixtureReport(context, {
            order: "baseline-head",
            runId: "1",
            cohortProfile: "cold-progress",
            baselineCarrierCount: 1,
        }),
        buildFixtureReport(context, {
            order: "head-baseline",
            runId: "2",
            cohortProfile: "cold-progress",
            baselineCarrierCount: 1,
        }),
    ];
    setUniformProgressTimings(reports[0].baseline.metrics, {
        quarterMs: 24_000,
        postPayloadFinalizeMs: 0,
    });
    setUniformProgressTimings(reports[1].baseline.metrics, {
        quarterMs: 6_000,
        postPayloadFinalizeMs: 6_000,
    });
    setUniformProgressTimings(reports[0].head.metrics, {
        quarterMs: 21_600,
        postPayloadFinalizeMs: 0,
    });
    setUniformProgressTimings(reports[1].head.metrics, {
        quarterMs: 5_400,
        postPayloadFinalizeMs: 7_200,
    });

    const combined = combineCampaignReports(reports);

    assert.equal(combined.assessments.evidenceValidity.passed, true);
    assert.equal(combined.campaignContract.cohortProfile, "cold-progress");
    assert.ok(
        Math.abs(combined.aggregateProgress.baseline.quarter1Ms - 12_000) < 1e-9
    );
    assert.ok(
        Math.abs(combined.aggregateProgress.baseline.quarter4Ms - 12_000) < 1e-9
    );
    assert.equal(
        combined.aggregateProgress.baseline.secondHalfOverFirstHalfDuration,
        1
    );
    assert.equal(
        combined.aggregateProgress.baseline
            .fourthQuarterOverThirdQuarterDuration,
        1
    );
    assert.ok(
        Math.abs(combined.aggregateProgress.head.quarter1Ms - 10_800) < 1e-9
    );
    assert.ok(
        Math.abs(combined.aggregateProgress.head.quarter4Ms - 10_800) < 1e-9
    );
    assert.equal(
        combined.aggregateProgress.baseline.postPayloadFinalizeMs,
        3_000
    );
    assert.equal(combined.aggregateProgress.head.postPayloadFinalizeMs, 3_600);
    assert.equal(
        combined.assessments.progressSlowdownDiagnostic.gatesWorkflow,
        false
    );
    assert.equal(
        combined.assessments.progressSlowdownDiagnostic.evaluated,
        true
    );
    assert.equal(combined.assessments.pruningBenefit.passed, null);
    assert.equal(combined.workflowGatePassed, true);
});

test("combiner rejects mixed locality cohort reports", (context) => {
    const halfLocal = buildFixtureReport(context, {
        order: "baseline-head",
        runId: "1",
        cohortProfile: "half-local",
        baselineCarrierCount: 1,
    });
    const cold = buildFixtureReport(context, {
        order: "head-baseline",
        runId: "2",
        cohortProfile: "cold-progress",
        baselineCarrierCount: 1,
    });

    const combined = combineCampaignReports([halfLocal, cold]);

    assert.equal(combined.assessments.evidenceValidity.passed, false);
    assert.equal(combined.workflowGatePassed, false);
    assert.ok(
        combined.validationIssues.includes("identical-campaign-contract")
    );
});

test("combiner rejects identically mislabeled cohort contracts", (context) => {
    const reports = [
        buildFixtureReport(context, {
            order: "baseline-head",
            runId: "1",
            cohortProfile: "cold-progress",
            baselineCarrierCount: 1,
        }),
        buildFixtureReport(context, {
            order: "head-baseline",
            runId: "2",
            cohortProfile: "cold-progress",
            baselineCarrierCount: 1,
        }),
    ];
    for (const report of reports) {
        report.campaignContract.cohortProfile = "half-local";
    }

    const combined = combineCampaignReports(reports);

    assert.equal(combined.assessments.evidenceValidity.passed, false);
    assert.equal(combined.workflowGatePassed, false);
    assert.ok(combined.validationIssues.includes("pair-1-cohort-contract"));
    assert.ok(combined.validationIssues.includes("pair-2-cohort-contract"));
});

test("combiner rejects finite but semantically invalid progress metrics", (context) => {
    const reports = [
        buildFixtureReport(context, {
            order: "baseline-head",
            runId: "1",
            cohortProfile: "cold-progress",
            baselineCarrierCount: 1,
        }),
        buildFixtureReport(context, {
            order: "head-baseline",
            runId: "2",
            cohortProfile: "cold-progress",
            baselineCarrierCount: 1,
        }),
    ];
    reports[1].head.metrics.quarter1Ms = 0;

    const combined = combineCampaignReports(reports);

    assert.equal(combined.assessments.evidenceValidity.passed, false);
    assert.equal(combined.workflowGatePassed, false);
    assert.ok(
        combined.validationIssues.includes(
            "pair-2-raw-performance-metric-semantics"
        )
    );
});

test("combiner fails closed on same orders, contracts, URLs, and raw evidence", (context) => {
    const first = buildFixtureReport(context, {
        order: "baseline-head",
        runId: "1",
    });
    const second = buildFixtureReport(context, {
        order: "baseline-head",
        runId: "1",
    });
    second.campaignContract = {
        ...second.campaignContract,
        headCoreCommit: "f".repeat(40),
    };
    second.head.performanceIssues.push("missing-memory-evidence");
    delete second.head.metrics.combinedGrowthOverFile;

    const combined = combineCampaignReports([first, second]);

    assert.equal(combined.assessments.evidenceValidity.passed, false);
    assert.equal(combined.workflowGatePassed, false);
    assert.equal(combined.assessments.regressionSafety.passed, null);
    assert.ok(combined.validationIssues.includes("opposite-pair-orders"));
    assert.ok(combined.validationIssues.includes("distinct-workflow-runs"));
    assert.ok(
        combined.validationIssues.includes("identical-campaign-contract")
    );
    assert.ok(combined.validationIssues.includes("pair-2-raw-evidence-issues"));
    assert.ok(
        combined.validationIssues.includes("pair-2-raw-performance-metrics")
    );
});

test("combiner evaluates and passes pruning benefit only when both baselines duplicate", (context) => {
    const reports = [
        buildFixtureReport(context, {
            order: "baseline-head",
            runId: "1",
        }),
        buildFixtureReport(context, {
            order: "head-baseline",
            runId: "2",
        }),
    ];

    const combined = combineCampaignReports(reports);

    assert.equal(
        combined.assessments.baselineDuplicateCarrierCondition.observedInBoth,
        true
    );
    assert.equal(combined.assessments.pruningBenefit.evaluated, true);
    assert.equal(combined.assessments.pruningBenefit.passed, true);
    assert.equal(combined.workflowGatePassed, true);
});

test("combiner leaves benefit unevaluated when only one order duplicates", (context) => {
    const reports = [
        buildFixtureReport(context, {
            order: "baseline-head",
            runId: "1",
        }),
        buildFixtureReport(context, {
            order: "head-baseline",
            runId: "2",
            baselineCarrierCount: 1,
        }),
    ];

    const combined = combineCampaignReports(reports);

    assert.equal(combined.assessments.evidenceValidity.passed, true);
    assert.equal(
        combined.assessments.baselineDuplicateCarrierCondition.observedInBoth,
        false
    );
    assert.equal(combined.assessments.pruningBenefit.evaluated, false);
    assert.equal(combined.assessments.pruningBenefit.passed, null);
    assert.equal(combined.workflowGatePassed, true);
});

test("combiner rejects an aggregate regression and an observed failed benefit", (context) => {
    const reports = [
        buildFixtureReport(context, {
            order: "baseline-head",
            runId: "1",
        }),
        buildFixtureReport(context, {
            order: "head-baseline",
            runId: "2",
        }),
    ];
    for (const report of reports) {
        setUniformProgressTimings(report.baseline.metrics, {
            quarterMs: 25,
            postPayloadFinalizeMs: 0,
        });
        setUniformProgressTimings(report.head.metrics, {
            quarterMs: 27.75,
            postPayloadFinalizeMs: 0,
        });
    }

    const combined = combineCampaignReports(reports);

    assert.equal(combined.assessments.regressionSafety.passed, false);
    assert.equal(combined.assessments.pruningBenefit.passed, false);
    assert.equal(combined.assessments.campaignAcceptance.passed, false);
    assert.equal(combined.workflowGatePassed, false);
});
