import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    PUBSUB_PROTOCOL,
    TRANSPORT_COUNTER_KEY_FIELDS,
    auditEndpointTransport,
    buildCampaignReport,
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

test("enforces exact head and baseline carrier-envelope boundaries", () => {
    const headAtBoundary = {
        carrierCount: 1,
        dominantDeltaBytes: P,
        totalDeltaBytes: P,
        dominantShare: 1,
        duplicationFactor: 1,
    };
    const baselineAtBoundary = {
        carrierCount: 2,
        dominantDeltaBytes: P,
        totalDeltaBytes: 1.8 * P,
        dominantShare: 1 / 1.8,
        duplicationFactor: 1.8,
    };
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
    assert.equal(
        evaluateVariantCarrierGate("baseline", {
            ...baselineAtBoundary,
            duplicationFactor: 1.799,
        }),
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

const makeCampaignFixture = ({ variant, contract }) => {
    const writerHash = "writer-hash";
    const readerHash = "reader-hash";
    const writerPeerId = "writer-peer-id";
    const readerPeerId = "reader-peer-id";
    const carrierCount = variant === "baseline" ? 2 : 1;
    const makeStreams = ({ direction, before }) =>
        Array.from({ length: carrierCount }, (_, index) =>
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
                bytes: 100 + index + (before ? 0 : P),
            })
        );
    const singleton = [writerHash];
    const pair = [writerHash, readerHash].sort();
    const topologySnapshot = ({
        owner,
        replicatorHashes,
        selfInReplicatorSet,
        streams,
    }) => ({
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
    });
    const readerPre = topologySnapshot({
        owner: "reader",
        replicatorHashes: singleton,
        selfInReplicatorSet: false,
        streams: makeStreams({ direction: "inbound", before: true }),
    });
    const writerPost = topologySnapshot({
        owner: "writer",
        replicatorHashes: pair,
        selfInReplicatorSet: true,
        streams: makeStreams({ direction: "outbound", before: false }),
    });
    const readerPost = topologySnapshot({
        owner: "reader",
        replicatorHashes: pair,
        selfInReplicatorSet: true,
        streams: makeStreams({ direction: "inbound", before: false }),
    });
    const terminalObservations = Array.from({ length: 3 }, () => ({
        writerTopology: writerPost,
        readerTopology: readerPost,
    }));
    const fullRange = Array.from({ length: 2048 }, (_, index) => index);
    const prefixRange = fullRange.slice(0, 1024);
    const libraryStreamWallMs = variant === "baseline" ? 100_000 : 90_000;
    const firstHalfMs = variant === "baseline" ? 40_000 : 36_000;
    const readStartedAt = 1_000_000;
    const demandWait = indexedRecord(2048, 10);
    const readDiagnostics = {
        startedAt: readStartedAt,
        finishedAt: readStartedAt + libraryStreamWallMs,
        chunkWriteFinishedAt: { 1023: readStartedAt + firstHalfMs },
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
        chunkManifestHeadPhysicalRemoteRequestCount: 1,
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
        downloadTimeoutMs: 3_300_000,
        postUploadMonitorMs: 5_000,
        pollMs: 1_000,
        minReadySeeders: 1,
        readyTimeoutMs: 120_000,
        sampleMs: 15_000,
        sampleCount: 4,
        targetSeeders: 2,
        readerLocalChunkTarget: 1024,
        readerLocalChunkMaxOvershoot: 0,
        readerTerminalTopology: "replicator",
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
        readerLocalChunkTarget: 1024,
        readerLocalChunkMaxOvershoot: 0,
        readerTerminalTopology: "replicator",
        readerLocalChunkBlockCount: 1024,
        readerLocalChunkIndexRowCount: 0,
        readerLocalityCohortKey: "observer-persistent-prefix-b1024-i0",
        readerLocalityControl: {
            status: "complete",
            failure: null,
            profile: "observer-topology-exact-manifest-prefix",
            provisioningMethod: "exact-manifest-head-import",
            requestedLocalChunkBlockCount: 1024,
            maxSpeculativeOvershootChunkCount: 0,
            writerUploadRole: "fixed1",
            readerUploadRole: "observer",
            readerTimedReadPolicy: "persist-chunk-reads",
            expectedTerminalTopology: "replicator",
            actualLocalChunkBlockCount: 1024,
            actualLocalChunkIndexRowCount: 0,
            speculativeOvershootChunkCount: 0,
            cohortKey: "observer-persistent-prefix-b1024-i0",
            preloadEvidence: {
                requestedManifestEntryCount: 1024,
                importedManifestEntryCount: 1024,
                importedManifestEntryIndices: prefixRange,
                localManifestEntryIndicesAfter: prefixRange,
            },
            preDownloadObservation: {
                blockCount: 1024,
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
                chunkCount: 2048,
                blockCount: 2048,
                indexRowCount: 2048,
                blockChunkIndices: fullRange,
                indexedChunkIndices: fullRange,
                persistChunkReads: true,
            },
            terminalTopologyRole: "replicator",
            terminalTopologyExpectationSatisfied: true,
            terminalTopologyObservations: terminalObservations,
        },
        writerDiagnostics: {
            peerHash: writerHash,
            replicatorCount: 2,
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
            replicatorCount: 2,
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

test("builds a passing report while leaving two-order campaign acceptance unevaluated", (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pruning-report-test-"));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const contract = {
        baseline: "8fc5533b14228b4091dffb3962fc8b1ff088bd89",
        head: "221411b880189df02404e9957591147142423aa2",
        harness: "20a398dcaea3e94e49b886315221cd0a1c562832",
        examples: "0cc0bc74682cd1a7b741232f07f46fe6f67c1cbc",
        lock: "7a306a1baaea4c1374674a56ffe6381e502915fd32670a9cd66814ce5fe114b1",
        sha256: "bvqiNpaxF0jivbi8SZBjuQ2/qU4wXlT+j22AhO6ywHU=",
        crc32: "125fb916",
    };
    fs.writeFileSync(
        path.join(root, "1-baseline-summary.json"),
        JSON.stringify(makeCampaignFixture({ variant: "baseline", contract }))
    );
    fs.writeFileSync(
        path.join(root, "2-head-summary.json"),
        JSON.stringify(makeCampaignFixture({ variant: "head", contract }))
    );
    fs.writeFileSync(path.join(root, "order.txt"), "baseline\nhead\n");
    fs.writeFileSync(path.join(root, "overall-run-status.txt"), "0\n");
    const report = buildCampaignReport({
        RESULTS_ROOT: root,
        PAIR_ORDER: "baseline-head",
        BASE_CORE_COMMIT: contract.baseline,
        HEAD_CORE_COMMIT: contract.head,
        HARNESS_CORE_COMMIT: contract.harness,
        EXAMPLES_COMMIT: contract.examples,
        EXAMPLES_LOCK_SHA256: contract.lock,
        EXPECTED_SHA256_BASE64: contract.sha256,
        EXPECTED_CRC32_HEX: contract.crc32,
        FIXTURE_SEED: "peerbit-file-share-benchmark-v1",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "dao-xyz/peerbit-examples",
        GITHUB_RUN_ID: "1",
        GITHUB_WORKFLOW_REF:
            "dao-xyz/peerbit-examples/.github/workflows/file-share-benchmarks.yml@refs/heads/test",
        GITHUB_WORKFLOW_SHA: "a".repeat(40),
    });

    assert.equal(report.assessments.correctnessAndCarrierEvidence.passed, true);
    assert.equal(report.assessments.perPairPerformanceSafety.passed, true);
    assert.equal(report.comparisonGatePassed, true);
    assert.equal(report.assessments.campaignAcceptance.passed, null);
    assert.equal(
        report.assessments.campaignAcceptance.evaluatedBySingleRun,
        false
    );
    assert.equal(
        report.assessments.correctnessAndCarrierEvidence
            .comparativeCarrierTotals.writer.headOverBaseline,
        0.5
    );
});
