import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const CAMPAIGN_REPORT_SCHEMA = Object.freeze({
    id: "peerbit-file-share-outbound-candidate-pruning-comparison",
    version: 1,
});

export const BENCHMARK_SUMMARY_SCHEMA = Object.freeze({
    id: "peerbit-file-share-benchmark-summary",
    version: 5,
});

export const BENCHMARK_RESULT_SCHEMA = Object.freeze({
    id: "peerbit-file-share-benchmark",
    version: 9,
});

export const BENCHMARK_INVOCATION_SCHEMA = Object.freeze({
    id: "peerbit-file-share-benchmark-invocation",
    version: 4,
});

export const PUBSUB_PROTOCOL = "/peerbit/topic-control-plane/2.0.0";
export const TRANSPORT_COUNTER_KEY_FIELDS = Object.freeze([
    "service",
    "remotePeerHash",
    "remotePeer",
    "direction",
    "connectionId",
    "id",
    "multiplexer",
    "protocol",
]);

const MIB = 1024 * 1024;
const DEFAULT_CONTRACT = Object.freeze({
    fileSizeBytes: 1024 * MIB,
    chunkCount: 2048,
    chunkSizeBytes: 512 * 1024,
    localPrefixBlockCount: 1024,
    localPrefixIndexRowCount: 0,
    remotePayloadBytes: 1024 * 512 * 1024,
    remotePayloadUpperBytes: 1024 * 512 * 1024 + 16 * MIB,
    counterpartByteSkewBytes: MIB,
});

const isRecord = (value) =>
    value != null && typeof value === "object" && !Array.isArray(value);

const isNonNegativeSafeInteger = (value) =>
    Number.isSafeInteger(value) && value >= 0;

const isPositiveFiniteNumber = (value) =>
    typeof value === "number" && Number.isFinite(value) && value > 0;

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const writeJson = (filePath, value) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const check = (issues, condition, issue) => {
    if (!condition) {
        issues.push(issue);
    }
};

const exactIntegerKeys = (record, count) => {
    if (!isRecord(record)) {
        return false;
    }
    const keys = Object.keys(record)
        .map(Number)
        .sort((left, right) => left - right);
    return (
        keys.length === count && keys.every((value, index) => value === index)
    );
};

const exactRange = (value, count) =>
    Array.isArray(value) &&
    value.length === count &&
    value.every((entry, index) => entry === index);

const safeRecordValuesByIndex = (record, count) => {
    if (!exactIntegerKeys(record, count)) {
        throw new Error(`Expected exact integer keys 0..${count - 1}`);
    }
    const values = Array.from({ length: count }, (_, index) => record[index]);
    if (
        values.some(
            (value) => typeof value !== "number" || !Number.isFinite(value)
        )
    ) {
        throw new Error("Indexed metric contains a non-finite number");
    }
    return values;
};

const sum = (values) => values.reduce((total, value) => total + value, 0);

const resolveRunUrl = (environment) =>
    environment.GITHUB_SERVER_URL &&
    environment.GITHUB_REPOSITORY &&
    environment.GITHUB_RUN_ID
        ? `${environment.GITHUB_SERVER_URL}/${environment.GITHUB_REPOSITORY}/actions/runs/${environment.GITHUB_RUN_ID}`
        : null;

const requireContractEnvironment = (environment) => {
    const required = [
        "RESULTS_ROOT",
        "PAIR_ORDER",
        "BASE_CORE_COMMIT",
        "HEAD_CORE_COMMIT",
        "HARNESS_CORE_COMMIT",
        "EXAMPLES_COMMIT",
        "EXAMPLES_LOCK_SHA256",
        "EXPECTED_SHA256_BASE64",
        "EXPECTED_CRC32_HEX",
        "FIXTURE_SEED",
    ];
    for (const name of required) {
        if (!environment[name]) {
            throw new Error(`Missing campaign environment variable ${name}`);
        }
    }
    if (!/^[0-9a-f]{40}$/.test(environment.BASE_CORE_COMMIT)) {
        throw new Error("BASE_CORE_COMMIT is not a full commit SHA");
    }
    if (!/^[0-9a-f]{40}$/.test(environment.HEAD_CORE_COMMIT)) {
        throw new Error("HEAD_CORE_COMMIT is not a full commit SHA");
    }
    if (!/^[0-9a-f]{40}$/.test(environment.HARNESS_CORE_COMMIT)) {
        throw new Error("HARNESS_CORE_COMMIT is not a full commit SHA");
    }
    if (!/^[0-9a-f]{40}$/.test(environment.EXAMPLES_COMMIT)) {
        throw new Error("EXAMPLES_COMMIT is not a full commit SHA");
    }
    if (!/^[0-9a-f]{64}$/.test(environment.EXAMPLES_LOCK_SHA256)) {
        throw new Error("EXAMPLES_LOCK_SHA256 is not a SHA-256 digest");
    }
    if (!["baseline-head", "head-baseline"].includes(environment.PAIR_ORDER)) {
        throw new Error(`Unsupported pair order ${environment.PAIR_ORDER}`);
    }
    return {
        ...DEFAULT_CONTRACT,
        baselineCoreCommit: environment.BASE_CORE_COMMIT,
        headCoreCommit: environment.HEAD_CORE_COMMIT,
        harnessCoreCommit: environment.HARNESS_CORE_COMMIT,
        examplesCommit: environment.EXAMPLES_COMMIT,
        examplesLockSha256: environment.EXAMPLES_LOCK_SHA256,
        expectedSha256Base64: environment.EXPECTED_SHA256_BASE64,
        expectedCrc32Hex: environment.EXPECTED_CRC32_HEX,
        fixtureSeed: environment.FIXTURE_SEED,
        pairOrder: environment.PAIR_ORDER,
    };
};

const makeTransportKey = (stream) =>
    JSON.stringify(TRANSPORT_COUNTER_KEY_FIELDS.map((field) => stream[field]));

const relevantCounterpartStreams = (
    topology,
    { direction, expectedRemotePeerHash, expectedRemotePeerId }
) => {
    if (!Array.isArray(topology?.transportStreams)) {
        throw new Error("Topology is missing transportStreams");
    }
    if (topology.transportStreams.some((stream) => !isRecord(stream))) {
        throw new Error("Topology contains a malformed transport stream entry");
    }
    return topology.transportStreams.filter(
        (stream) =>
            stream.service === "pubsub" &&
            stream.direction === direction &&
            (stream.remotePeerHash === expectedRemotePeerHash ||
                stream.remotePeer === expectedRemotePeerId)
    );
};

const auditTransportSnapshot = (
    topology,
    { direction, expectedRemotePeerHash, expectedRemotePeerId, label }
) => {
    const streams = relevantCounterpartStreams(topology, {
        direction,
        expectedRemotePeerHash,
        expectedRemotePeerId,
    });
    if (streams.length === 0) {
        throw new Error(`${label} has no counterpart pubsub stream`);
    }
    const counters = new Map();
    for (const [index, stream] of streams.entries()) {
        if (
            stream.remotePeerHash !== expectedRemotePeerHash ||
            stream.remotePeer !== expectedRemotePeerId ||
            stream.peerHashIdentityMatch !== true ||
            stream.serviceProtocol !== PUBSUB_PROTOCOL ||
            stream.expectedProtocol !== PUBSUB_PROTOCOL ||
            stream.protocol !== PUBSUB_PROTOCOL ||
            stream.protocolIdentityMatch !== true ||
            stream.counterStreamIdentityMatch !== true ||
            stream.connectionIdentityMatchCount !== 1 ||
            typeof stream.connectionId !== "string" ||
            stream.connectionId.length === 0 ||
            typeof stream.id !== "string" ||
            stream.id.length === 0 ||
            typeof stream.multiplexer !== "string" ||
            stream.multiplexer.length === 0 ||
            !isNonNegativeSafeInteger(stream.bytes) ||
            (direction === "outbound"
                ? stream.aborted !== false
                : stream.aborted !== null)
        ) {
            throw new Error(
                `${label} counterpart pubsub stream ${index} is not authoritative`
            );
        }
        const key = makeTransportKey(stream);
        if (counters.has(key)) {
            throw new Error(`${label} has a duplicate local transport key`);
        }
        counters.set(key, {
            key,
            bytes: stream.bytes,
            multiplexer: stream.multiplexer,
        });
    }
    return [...counters.values()].sort((left, right) =>
        left.key.localeCompare(right.key)
    );
};

export const auditEndpointTransport = ({
    beforeTopology,
    afterTopology,
    direction,
    expectedRemotePeerHash,
    expectedRemotePeerId,
    label,
}) => {
    const before = auditTransportSnapshot(beforeTopology, {
        direction,
        expectedRemotePeerHash,
        expectedRemotePeerId,
        label: `${label} pre-read`,
    });
    const after = auditTransportSnapshot(afterTopology, {
        direction,
        expectedRemotePeerHash,
        expectedRemotePeerId,
        label: `${label} post-read`,
    });
    const beforeKeys = before.map(({ key }) => key);
    const afterKeys = after.map(({ key }) => key);
    if (!isDeepStrictEqual(beforeKeys, afterKeys)) {
        throw new Error(
            `${label} transport key set changed during the timed read`
        );
    }
    const deltas = after.map((counter, index) => {
        const beforeBytes = before[index].bytes;
        if (counter.bytes < beforeBytes) {
            throw new Error(`${label} transport counter decreased`);
        }
        return {
            key: counter.key,
            multiplexer: counter.multiplexer,
            beforeBytes,
            afterBytes: counter.bytes,
            deltaBytes: counter.bytes - beforeBytes,
        };
    });
    const totalDeltaBytes = sum(deltas.map(({ deltaBytes }) => deltaBytes));
    if (!isNonNegativeSafeInteger(totalDeltaBytes)) {
        throw new Error(`${label} total transport delta is not a safe integer`);
    }
    const dominantDeltaBytes = Math.max(
        0,
        ...deltas.map(({ deltaBytes }) => deltaBytes)
    );
    const carrierCount = deltas.filter(
        ({ deltaBytes }) => deltaBytes >= DEFAULT_CONTRACT.remotePayloadBytes
    ).length;
    const dominantShare =
        totalDeltaBytes === 0 ? 0 : dominantDeltaBytes / totalDeltaBytes;
    const duplicationFactor =
        dominantDeltaBytes === 0 ? null : totalDeltaBytes / dominantDeltaBytes;
    return {
        direction,
        keyFields: [...TRANSPORT_COUNTER_KEY_FIELDS],
        preReadKeys: beforeKeys,
        postReadKeys: afterKeys,
        deltas,
        totalDeltaBytes,
        dominantDeltaBytes,
        carrierCount,
        dominantShare,
        duplicationFactor,
        actualMultiplexers: [
            ...new Set(deltas.map(({ multiplexer }) => multiplexer)),
        ].sort(),
    };
};

export const evaluateVariantCarrierGate = (variant, endpoint) => {
    const P = DEFAULT_CONTRACT.remotePayloadBytes;
    const U = DEFAULT_CONTRACT.remotePayloadUpperBytes;
    if (variant === "head") {
        return (
            endpoint.carrierCount === 1 &&
            endpoint.dominantDeltaBytes >= P &&
            endpoint.totalDeltaBytes <= U &&
            endpoint.dominantShare >= 0.99 &&
            endpoint.duplicationFactor != null &&
            endpoint.duplicationFactor <= 1.01
        );
    }
    if (variant === "baseline") {
        return (
            endpoint.carrierCount >= 2 &&
            endpoint.dominantDeltaBytes >= P &&
            endpoint.dominantDeltaBytes <= U &&
            endpoint.totalDeltaBytes >= 1.8 * endpoint.dominantDeltaBytes &&
            endpoint.duplicationFactor != null &&
            endpoint.duplicationFactor >= 1.8
        );
    }
    throw new Error(`Unknown variant ${variant}`);
};

export const evaluateCounterpartDeltaSkew = (
    writer,
    reader,
    maxSkewBytes = DEFAULT_CONTRACT.counterpartByteSkewBytes
) => {
    if (
        !isNonNegativeSafeInteger(writer?.totalDeltaBytes) ||
        !isNonNegativeSafeInteger(reader?.totalDeltaBytes) ||
        !isNonNegativeSafeInteger(maxSkewBytes)
    ) {
        throw new Error("Counterpart transport totals are not safe integers");
    }
    const totalDeltaSkewBytes = Math.abs(
        writer.totalDeltaBytes - reader.totalDeltaBytes
    );
    return {
        totalDeltaSkewBytes,
        maxSkewBytes,
        passed: totalDeltaSkewBytes <= maxSkewBytes,
    };
};

const validateCleanProvenance = (
    issues,
    provenance,
    { commit, lockfileSha256, label }
) => {
    check(issues, isRecord(provenance), `${label}-provenance`);
    check(
        issues,
        provenance?.resolvedCommit === commit,
        `${label}-resolved-commit`
    );
    check(issues, provenance?.dirty === false, `${label}-dirty`);
    check(
        issues,
        provenance?.worktreeDigest === null,
        `${label}-worktree-digest`
    );
    if (lockfileSha256 != null) {
        check(
            issues,
            provenance?.lockfileSha256 === lockfileSha256,
            `${label}-lockfile`
        );
    }
};

const validateExactInvocation = (issues, invocation, contract) => {
    check(
        issues,
        isDeepStrictEqual(invocation?.schema, BENCHMARK_INVOCATION_SCHEMA),
        "invocation-schema"
    );
    const exact = {
        scenario: "upload",
        mode: "fixed1",
        networkMode: "local",
        integrationMode: "link",
        fileSizeMb: 1024,
        fileSizeBytes: contract.fileSizeBytes,
        fixtureSeed: contract.fixtureSeed,
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
        readerLocalChunkTarget: contract.localPrefixBlockCount,
        readerLocalChunkMaxOvershoot: 0,
        readerTerminalTopology: "replicator",
        baseUrl: null,
        protocol: "http",
        viteMode: null,
        viteConfig: null,
        serverMode: "production-preview",
        serverHost: "127.0.0.1",
        enableVisibilityProbe: false,
        verbose: false,
    };
    for (const [key, value] of Object.entries(exact)) {
        check(
            issues,
            isDeepStrictEqual(invocation?.[key], value),
            `invocation-${key}`
        );
    }
    check(
        issues,
        Array.isArray(invocation?.localPackages) &&
            invocation.localPackages.length > 0 &&
            new Set(invocation.localPackages).size ===
                invocation.localPackages.length &&
            invocation.localPackages.includes("@peerbit/stream") &&
            invocation.localPackages.includes("@peerbit/pubsub") &&
            invocation.localPackages.includes("@peerbit/shared-log") &&
            invocation.localPackages.includes("peerbit"),
        "invocation-local-packages"
    );
};

const validateIntegrity = (issues, result, contract) => {
    const integrity = result?.integrity;
    check(issues, isRecord(integrity), "integrity-object");
    const exact = {
        fixtureMode: "deterministic",
        fixtureFormat: "aes-256-ctr-v1",
        fixtureSeed: contract.fixtureSeed,
        expectedSizeBytes: contract.fileSizeBytes,
        sourceSizeBytes: contract.fileSizeBytes,
        manifestSizeBytes: contract.fileSizeBytes,
        downloadedSizeBytes: contract.fileSizeBytes,
        sourceSha256Base64: contract.expectedSha256Base64,
        libraryComputedSha256Base64: contract.expectedSha256Base64,
        downloadedSha256Base64: null,
        manifestSha256Base64: contract.expectedSha256Base64,
        sourceCrc32Hex: contract.expectedCrc32Hex,
        downloadedCrc32Hex: contract.expectedCrc32Hex,
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
    };
    for (const [key, value] of Object.entries(exact)) {
        check(
            issues,
            isDeepStrictEqual(integrity?.[key], value),
            `integrity-${key}`
        );
    }
    check(issues, result?.integrityVerified === true, "integrity-verified");
    check(
        issues,
        result?.downloadSink === "hash-only" &&
            result?.requestedDownloadSink === "hash-only" &&
            result?.primaryDownloadAuthoritative === true &&
            result?.sinkServerWriteCalls === null &&
            result?.sinkServerWriteDurationMs === null &&
            result?.sinkServerWriteDurationDefinition === null,
        "hash-only-contract"
    );
};

const validateChunkGeometry = (issues, result, contract) => {
    const upload = result?.writerDiagnostics?.lastUploadDiagnostics;
    const read = result?.readerDiagnostics?.lastReadDiagnostics;
    check(
        issues,
        contract.chunkCount * contract.chunkSizeBytes ===
            contract.fileSizeBytes &&
            result?.readTransfer?.chunkCount === contract.chunkCount &&
            result?.readTransfer?.totalBytes === contract.fileSizeBytes &&
            result?.sinkWriteCalls === contract.chunkCount &&
            upload?.sizeBytes === contract.fileSizeBytes &&
            upload?.chunkSize === contract.chunkSizeBytes &&
            upload?.chunkCount === contract.chunkCount &&
            upload?.chunkPutCount === contract.chunkCount,
        "exact-chunk-geometry"
    );
    check(
        issues,
        exactIntegerKeys(read?.chunkByteLength, contract.chunkCount) &&
            Array.from(
                { length: contract.chunkCount },
                (_, index) => read.chunkByteLength[index]
            ).every((value) => value === contract.chunkSizeBytes),
        "exact-read-chunk-byte-lengths"
    );
    check(
        issues,
        read?.chunkManifestEntryPersistenceFailedCount === 0 &&
            read?.chunkManifestEntryPersistenceMissingIndices?.length === 0 &&
            read?.chunkManifestEntryContentMismatchIndices?.length === 0 &&
            read?.chunkManifestHeadBatchErrorCount === 0 &&
            read?.chunkManifestHeadBatchInvalidCount === 0 &&
            read?.chunkManifestHeadBatchMissingCount === 0 &&
            read?.chunkManifestHeadPhysicalRemoteRequestErrorCount === 0 &&
            read?.chunkManifestHeadPhysicalRemoteRequestErrors?.length === 0 &&
            read?.chunkManifestHeadPhysicalRemoteRequestCount > 0 &&
            read?.maxManifestHeadBatchSize === 1 &&
            read?.maxManifestHeadLogicalWindowSize === 8,
        "manifest-persistence-and-head-geometry"
    );
};

const validateTopologyRole = (
    topology,
    {
        ownPeerHash,
        expectedReplicatorHashes,
        expectedSelfInReplicatorSet,
        expectedReplicatorCount,
    }
) =>
    topology?.peerHash === ownPeerHash &&
    topology?.selfInReplicatorSet === expectedSelfInReplicatorSet &&
    topology?.replicatorCount === expectedReplicatorCount &&
    isDeepStrictEqual(topology?.replicatorHashes, expectedReplicatorHashes);

const validateLocalityAndTransport = (issues, result, contract) => {
    const locality = result?.readerLocalityControl;
    check(issues, locality?.status === "complete", "locality-status");
    check(issues, locality?.failure === null, "locality-failure");
    check(
        issues,
        locality?.profile === "observer-topology-exact-manifest-prefix" &&
            locality?.provisioningMethod === "exact-manifest-head-import" &&
            locality?.requestedLocalChunkBlockCount ===
                contract.localPrefixBlockCount &&
            locality?.maxSpeculativeOvershootChunkCount === 0 &&
            locality?.writerUploadRole === "fixed1" &&
            locality?.readerUploadRole === "observer" &&
            locality?.readerTimedReadPolicy === "persist-chunk-reads" &&
            locality?.expectedTerminalTopology === "replicator",
        "locality-contract"
    );
    const expectedCohort = `observer-persistent-prefix-b${contract.localPrefixBlockCount}-i${contract.localPrefixIndexRowCount}`;
    check(
        issues,
        result?.readerLocalChunkTarget === contract.localPrefixBlockCount &&
            result?.readerLocalChunkMaxOvershoot === 0 &&
            result?.readerTerminalTopology === "replicator" &&
            result?.readerLocalChunkBlockCount ===
                contract.localPrefixBlockCount &&
            result?.readerLocalChunkIndexRowCount ===
                contract.localPrefixIndexRowCount &&
            result?.readerLocalityCohortKey === expectedCohort &&
            locality?.actualLocalChunkBlockCount ===
                contract.localPrefixBlockCount &&
            locality?.actualLocalChunkIndexRowCount ===
                contract.localPrefixIndexRowCount &&
            locality?.speculativeOvershootChunkCount === 0 &&
            locality?.cohortKey === expectedCohort,
        "locality-exact-cohort"
    );
    const expectedPrefix = Array.from(
        { length: contract.localPrefixBlockCount },
        (_, index) => index
    );
    const preload = locality?.preloadEvidence;
    const preDownload = locality?.preDownloadObservation;
    check(
        issues,
        preload?.requestedManifestEntryCount ===
            contract.localPrefixBlockCount &&
            preload?.importedManifestEntryCount ===
                contract.localPrefixBlockCount &&
            isDeepStrictEqual(
                preload?.importedManifestEntryIndices,
                expectedPrefix
            ) &&
            isDeepStrictEqual(
                preload?.localManifestEntryIndicesAfter,
                expectedPrefix
            ),
        "locality-exact-imported-prefix"
    );
    check(
        issues,
        preDownload?.blockCount === contract.localPrefixBlockCount &&
            preDownload?.indexRowCount === contract.localPrefixIndexRowCount &&
            isDeepStrictEqual(preDownload?.blockChunkIndices, expectedPrefix) &&
            isDeepStrictEqual(preDownload?.indexedChunkIndices, []) &&
            preDownload?.persistChunkReads === true,
        "locality-exact-pre-read-prefix"
    );

    const writerBeforeUpload = locality?.writerTopologyBeforeUpload;
    const readerBeforeUpload = locality?.readerTopologyBeforeUpload;
    const writerPre = locality?.writerTopologyBeforeTimedRead;
    const readerPre = locality?.readerTopologyBeforeTimedRead;
    const writerPost = locality?.writerTopologyAfterTimedRead;
    const readerPost = locality?.readerTopologyAfterTimedRead;
    const writerHash = writerPre?.peerHash;
    const readerHash = readerPre?.peerHash;
    const writerPeerId = writerPre?.peerId;
    const readerPeerId = readerPre?.peerId;
    check(
        issues,
        typeof writerHash === "string" &&
            writerHash.length > 0 &&
            typeof readerHash === "string" &&
            readerHash.length > 0 &&
            writerHash !== readerHash &&
            typeof writerPeerId === "string" &&
            writerPeerId.length > 0 &&
            typeof readerPeerId === "string" &&
            readerPeerId.length > 0 &&
            writerPeerId !== readerPeerId &&
            writerBeforeUpload?.peerHash === writerHash &&
            readerBeforeUpload?.peerHash === readerHash &&
            writerBeforeUpload?.peerId === writerPeerId &&
            readerBeforeUpload?.peerId === readerPeerId &&
            writerPost?.peerHash === writerHash &&
            readerPost?.peerHash === readerHash &&
            writerPost?.peerId === writerPeerId &&
            readerPost?.peerId === readerPeerId,
        "topology-peer-identities"
    );
    const singleton = [writerHash];
    check(
        issues,
        validateTopologyRole(writerBeforeUpload, {
            ownPeerHash: writerHash,
            expectedReplicatorHashes: singleton,
            expectedSelfInReplicatorSet: true,
            expectedReplicatorCount: 1,
        }) &&
            validateTopologyRole(readerBeforeUpload, {
                ownPeerHash: readerHash,
                expectedReplicatorHashes: singleton,
                expectedSelfInReplicatorSet: false,
                expectedReplicatorCount: 1,
            }) &&
            validateTopologyRole(writerPre, {
                ownPeerHash: writerHash,
                expectedReplicatorHashes: singleton,
                expectedSelfInReplicatorSet: true,
                expectedReplicatorCount: 1,
            }) &&
            validateTopologyRole(readerPre, {
                ownPeerHash: readerHash,
                expectedReplicatorHashes: singleton,
                expectedSelfInReplicatorSet: false,
                expectedReplicatorCount: 1,
            }),
        "pre-read-writer-only-singleton"
    );

    const terminalHashes = [writerHash, readerHash]
        .filter((value) => typeof value === "string")
        .sort((left, right) => left.localeCompare(right));
    const terminalIdle = locality?.terminalIdleObservation;
    check(
        issues,
        terminalIdle?.chunkCount === contract.chunkCount &&
            terminalIdle?.blockCount === contract.chunkCount &&
            terminalIdle?.indexRowCount === contract.chunkCount &&
            exactRange(terminalIdle?.blockChunkIndices, contract.chunkCount) &&
            exactRange(
                terminalIdle?.indexedChunkIndices,
                contract.chunkCount
            ) &&
            terminalIdle?.persistChunkReads === true &&
            locality?.terminalTopologyRole === "replicator" &&
            locality?.terminalTopologyExpectationSatisfied === true,
        "terminal-full-replicator-index"
    );
    check(
        issues,
        Array.isArray(locality?.terminalTopologyObservations) &&
            locality.terminalTopologyObservations.length === 3 &&
            locality.terminalTopologyObservations.every(
                (observation) =>
                    validateTopologyRole(observation?.writerTopology, {
                        ownPeerHash: writerHash,
                        expectedReplicatorHashes: terminalHashes,
                        expectedSelfInReplicatorSet: true,
                        expectedReplicatorCount: 2,
                    }) &&
                    validateTopologyRole(observation?.readerTopology, {
                        ownPeerHash: readerHash,
                        expectedReplicatorHashes: terminalHashes,
                        expectedSelfInReplicatorSet: true,
                        expectedReplicatorCount: 2,
                    })
            ),
        "terminal-reader-included-topology"
    );
    check(
        issues,
        result?.writerDiagnostics?.peerHash === writerHash &&
            result?.readerDiagnostics?.peerHash === readerHash &&
            result?.writerDiagnostics?.replicatorCount === 2 &&
            result?.readerDiagnostics?.replicatorCount === 2 &&
            result?.writerDiagnostics?.replicationSetSize === 1 &&
            result?.readerDiagnostics?.replicationSetSize === 1,
        "terminal-peer-diagnostics"
    );

    let transport = null;
    try {
        const writer = auditEndpointTransport({
            beforeTopology: writerPre,
            afterTopology: writerPost,
            direction: "outbound",
            expectedRemotePeerHash: readerHash,
            expectedRemotePeerId: readerPeerId,
            label: "writer",
        });
        const reader = auditEndpointTransport({
            beforeTopology: readerPre,
            afterTopology: readerPost,
            direction: "inbound",
            expectedRemotePeerHash: writerHash,
            expectedRemotePeerId: writerPeerId,
            label: "reader",
        });
        const skew = evaluateCounterpartDeltaSkew(
            writer,
            reader,
            contract.counterpartByteSkewBytes
        );
        check(issues, skew.passed, "writer-reader-transport-delta-skew");
        transport = {
            service: "pubsub",
            protocol: PUBSUB_PROTOCOL,
            remotePayloadBytes: contract.remotePayloadBytes,
            remotePayloadUpperBytes: contract.remotePayloadUpperBytes,
            maxCounterpartByteSkewBytes: contract.counterpartByteSkewBytes,
            totalDeltaSkewBytes: skew.totalDeltaSkewBytes,
            writer,
            reader,
        };
    } catch (error) {
        issues.push(`transport-audit:${error?.message ?? String(error)}`);
    }
    return {
        transport,
        cohort: {
            key: result?.readerLocalityCohortKey,
            blockCount: result?.readerLocalChunkBlockCount,
            indexRowCount: result?.readerLocalChunkIndexRowCount,
        },
    };
};

const collectPerformanceMetrics = (issues, result, contract) => {
    const diagnostics = result?.readerDiagnostics?.lastReadDiagnostics;
    let demandValues = [];
    let attempts = [];
    try {
        demandValues = safeRecordValuesByIndex(
            diagnostics?.chunkDemandWaitMs,
            contract.chunkCount
        );
    } catch {
        issues.push("demand-wait-series");
    }
    try {
        attempts = safeRecordValuesByIndex(
            diagnostics?.chunkAttempts,
            contract.chunkCount
        );
    } catch {
        issues.push("chunk-attempt-series");
    }
    const startedAt = diagnostics?.startedAt;
    const boundary = diagnostics?.chunkWriteFinishedAt?.[1023];
    const finishedAt = diagnostics?.finishedAt;
    check(
        issues,
        isNonNegativeSafeInteger(startedAt) &&
            isNonNegativeSafeInteger(boundary) &&
            isNonNegativeSafeInteger(finishedAt) &&
            startedAt <= boundary &&
            boundary <= finishedAt,
        "read-half-boundary"
    );
    const firstHalfMs = boundary - startedAt;
    const secondHalfMs = finishedAt - boundary;
    const derivedLibraryStreamWallMs = finishedAt - startedAt;
    const libraryStreamWallMs =
        result?.libraryStreamWallMs ?? derivedLibraryStreamWallMs;
    check(
        issues,
        isPositiveFiniteNumber(libraryStreamWallMs) &&
            libraryStreamWallMs === derivedLibraryStreamWallMs &&
            isPositiveFiniteNumber(firstHalfMs) &&
            isPositiveFiniteNumber(secondHalfMs),
        "primary-performance-metrics"
    );
    const firstHalfDemandWaitMs = sum(
        demandValues.slice(0, contract.localPrefixBlockCount)
    );
    const secondHalfDemandWaitMs = sum(
        demandValues.slice(contract.localPrefixBlockCount)
    );
    const demandWaitSumMs = sum(demandValues);
    check(
        issues,
        result?.readTransfer?.demandWait?.sampleCount === contract.chunkCount &&
            result?.readTransfer?.demandWait?.sumMs === demandWaitSumMs,
        "demand-wait-summary"
    );
    const hostRss = result?.downloadMemoryTelemetry?.hostRss;
    const memoryTelemetry = result?.downloadMemoryTelemetry;
    check(
        issues,
        memoryTelemetry?.profile === "download-memory-v2" &&
            memoryTelemetry?.complete === true &&
            memoryTelemetry?.cleanupComplete === true &&
            [
                memoryTelemetry?.readerJsHeap,
                memoryTelemetry?.writerJsHeap,
                hostRss,
            ].every(
                (series) =>
                    Number.isSafeInteger(series?.sampleCount) &&
                    series.sampleCount >= 2 &&
                    Array.isArray(series?.samplingErrors) &&
                    series.samplingErrors.length === 0 &&
                    series?.samplingErrorOverflowCount === 0
            ),
        "memory-telemetry"
    );
    const memoryCounters = [
        hostRss?.startBrowserBytes,
        hostRss?.peakBrowserBytes,
        hostRss?.startCombinedBytes,
        hostRss?.peakCombinedBytes,
    ];
    check(
        issues,
        memoryCounters.every(isNonNegativeSafeInteger) &&
            hostRss?.peakBrowserBytes >= hostRss?.startBrowserBytes &&
            hostRss?.peakCombinedBytes >= hostRss?.startCombinedBytes,
        "memory-rss-counters"
    );
    const browserGrowthBytes = Math.max(
        0,
        hostRss?.peakBrowserBytes - hostRss?.startBrowserBytes
    );
    const combinedGrowthBytes = Math.max(
        0,
        hostRss?.peakCombinedBytes - hostRss?.startCombinedBytes
    );
    const metrics = {
        libraryStreamWallMs,
        firstHalfMs,
        secondHalfMs,
        demandWaitSumMs,
        firstHalfDemandWaitMs,
        secondHalfDemandWaitMs,
        maxDemandWaitMs:
            demandValues.length > 0 ? Math.max(...demandValues) : Number.NaN,
        over10sDemandWaitCount: demandValues.filter((value) => value > 10_000)
            .length,
        maxChunkAttempts:
            attempts.length > 0 ? Math.max(...attempts) : Number.NaN,
        startBrowserBytes: hostRss?.startBrowserBytes,
        peakBrowserBytes: hostRss?.peakBrowserBytes,
        browserGrowthBytes,
        browserGrowthOverFile: browserGrowthBytes / contract.fileSizeBytes,
        startCombinedBytes: hostRss?.startCombinedBytes,
        peakCombinedBytes: hostRss?.peakCombinedBytes,
        combinedGrowthBytes,
        combinedGrowthOverFile: combinedGrowthBytes / contract.fileSizeBytes,
    };
    check(
        issues,
        Object.values(metrics).every(
            (value) => typeof value === "number" && Number.isFinite(value)
        ),
        "finite-performance-metrics"
    );
    return metrics;
};

const loadVariantSummary = (root, variant) => {
    const names = fs
        .readdirSync(root)
        .filter((entry) => entry.endsWith(`-${variant}-summary.json`));
    if (names.length !== 1) {
        throw new Error(
            `Expected exactly one ${variant} summary, found ${names.length}`
        );
    }
    const summaryFile = names[0];
    const summary = readJson(path.join(root, summaryFile));
    if (!Array.isArray(summary?.results) || summary.results.length !== 1) {
        throw new Error(
            `${variant} summary does not contain exactly one result`
        );
    }
    const rawResult = summary.results[0];
    const result = rawResult?.browserResult ?? rawResult;
    if (!isRecord(result)) {
        throw new Error(`${variant} summary is missing its browser result`);
    }
    return { summaryFile, summary, result };
};

const analyzeVariant = (root, variant, contract) => {
    const { summaryFile, summary, result } = loadVariantSummary(root, variant);
    const correctnessIssues = [];
    const performanceIssues = [];
    const expectedPeerbitCommit =
        variant === "baseline"
            ? contract.baselineCoreCommit
            : contract.headCoreCommit;
    check(
        correctnessIssues,
        isDeepStrictEqual(summary?.schema, BENCHMARK_SUMMARY_SCHEMA),
        "summary-schema"
    );
    check(correctnessIssues, summary?.status === "passed", "summary-status");
    check(
        correctnessIssues,
        isDeepStrictEqual(result?.schema, BENCHMARK_RESULT_SCHEMA),
        "result-schema"
    );
    check(correctnessIssues, result?.status === "passed", "result-status");
    validateCleanProvenance(correctnessIssues, summary?.harnessProvenance, {
        commit: contract.harnessCoreCommit,
        label: "harness",
    });
    validateCleanProvenance(correctnessIssues, summary?.peerbitProvenance, {
        commit: expectedPeerbitCommit,
        label: "peerbit",
    });
    validateCleanProvenance(correctnessIssues, summary?.examplesProvenance, {
        commit: contract.examplesCommit,
        lockfileSha256: contract.examplesLockSha256,
        label: "examples",
    });
    check(
        correctnessIssues,
        isDeepStrictEqual(
            result?.provenance?.harness,
            summary?.harnessProvenance
        ) &&
            isDeepStrictEqual(
                result?.provenance?.peerbit,
                summary?.peerbitProvenance
            ) &&
            isDeepStrictEqual(
                result?.provenance?.examples,
                summary?.examplesProvenance
            ),
        "result-summary-provenance"
    );
    validateExactInvocation(correctnessIssues, result?.invocation, contract);
    validateIntegrity(correctnessIssues, result, contract);
    validateChunkGeometry(correctnessIssues, result, contract);
    check(
        correctnessIssues,
        result?.errorCollectionComplete === true && result?.errorCount === 0,
        "errors"
    );
    check(
        correctnessIssues,
        result?.requestFailureCollectionComplete === true &&
            result?.requestFailureCount === 0,
        "request-failures"
    );
    check(
        correctnessIssues,
        result?.droppedSeeders === false &&
            result?.unexpectedSeederDrop === false,
        "seeder-stability"
    );
    const { transport, cohort } = validateLocalityAndTransport(
        correctnessIssues,
        result,
        contract
    );
    const metrics = collectPerformanceMetrics(
        performanceIssues,
        result,
        contract
    );
    let carrierGatePassed = false;
    if (transport) {
        const writerGate = evaluateVariantCarrierGate(
            variant,
            transport.writer
        );
        const readerGate = evaluateVariantCarrierGate(
            variant,
            transport.reader
        );
        check(
            correctnessIssues,
            writerGate,
            `${variant}-writer-carrier-envelope`
        );
        check(
            correctnessIssues,
            readerGate,
            `${variant}-reader-carrier-envelope`
        );
        carrierGatePassed = writerGate && readerGate;
    }
    return {
        summaryFile,
        invocation: result?.invocation,
        correctnessIssues,
        performanceIssues,
        correctnessPassed: correctnessIssues.length === 0,
        carrierGatePassed,
        cohort,
        transport,
        metrics,
    };
};

export const evaluatePerformanceGate = (baselineMetrics, headMetrics) => {
    const primaryTimingWithinTenPercent = [
        "libraryStreamWallMs",
        "secondHalfMs",
    ].every((key) => headMetrics[key] <= baselineMetrics[key] * 1.1);
    const demandWithinTolerance = [
        "demandWaitSumMs",
        "secondHalfDemandWaitMs",
    ].every(
        (key) =>
            headMetrics[key] <=
            Math.max(baselineMetrics[key] * 1.05, baselineMetrics[key] + 1_000)
    );
    const memoryWithinTolerance = [
        "browserGrowthBytes",
        "combinedGrowthBytes",
    ].every(
        (key) =>
            headMetrics[key] <=
            Math.max(
                baselineMetrics[key] * 1.1,
                baselineMetrics[key] + 256 * MIB
            )
    );
    return {
        passed:
            primaryTimingWithinTenPercent &&
            demandWithinTolerance &&
            memoryWithinTolerance,
        primaryTimingWithinTenPercent,
        demandWithinTolerance,
        memoryWithinTolerance,
        thresholds: {
            primaryTiming:
                "head libraryStreamWallMs and secondHalfMs must each be <= baseline * 1.10",
            demandWait:
                "head demandWaitSumMs and secondHalfDemandWaitMs must each be <= max(baseline * 1.05, baseline + 1000 ms)",
            memoryGrowth:
                "head browserGrowthBytes and combinedGrowthBytes must each be <= max(baseline * 1.10, baseline + 256 MiB)",
        },
    };
};

const readOrderEvidence = (root, pairOrder) => {
    const expectedOrder =
        pairOrder === "baseline-head"
            ? ["baseline", "head"]
            : ["head", "baseline"];
    const order = fs
        .readFileSync(path.join(root, "order.txt"), "utf8")
        .trim()
        .split(/\r?\n/);
    const runStatus = fs
        .readFileSync(path.join(root, "overall-run-status.txt"), "utf8")
        .trim();
    return { order, expectedOrder, runStatus };
};

export const buildCampaignReport = (environment = process.env) => {
    const contract = requireContractEnvironment(environment);
    const root = environment.RESULTS_ROOT;
    const baseline = analyzeVariant(root, "baseline", contract);
    const head = analyzeVariant(root, "head", contract);
    const pairedIssues = [];
    check(
        pairedIssues,
        isDeepStrictEqual(baseline.invocation, head.invocation),
        "invocation-mismatch"
    );
    check(
        pairedIssues,
        isDeepStrictEqual(baseline.cohort, head.cohort),
        "cohort-mismatch"
    );
    const { order, expectedOrder, runStatus } = readOrderEvidence(
        root,
        contract.pairOrder
    );
    check(
        pairedIssues,
        isDeepStrictEqual(order, expectedOrder),
        "pair-order-mismatch"
    );
    check(pairedIssues, runStatus === "0", "run-lifecycle-failed");

    const workflowSource = {
        repository: environment.GITHUB_REPOSITORY ?? null,
        ref: environment.GITHUB_WORKFLOW_REF ?? null,
        sha: environment.GITHUB_WORKFLOW_SHA ?? null,
    };
    check(
        pairedIssues,
        workflowSource.repository === "dao-xyz/peerbit-examples" &&
            typeof workflowSource.ref === "string" &&
            workflowSource.ref.includes(
                "/.github/workflows/file-share-benchmarks.yml@"
            ) &&
            /^[0-9a-f]{40}$/.test(workflowSource.sha ?? ""),
        "workflow-source-provenance"
    );

    const carrierComparisons = {};
    for (const endpoint of ["writer", "reader"]) {
        const baselineTotal = baseline.transport?.[endpoint]?.totalDeltaBytes;
        const headTotal = head.transport?.[endpoint]?.totalDeltaBytes;
        const headOverBaseline =
            isPositiveFiniteNumber(baselineTotal) &&
            isNonNegativeSafeInteger(headTotal)
                ? headTotal / baselineTotal
                : null;
        const passed = headOverBaseline != null && headOverBaseline <= 0.6;
        carrierComparisons[endpoint] = {
            baselineTotalDeltaBytes: baselineTotal ?? null,
            headTotalDeltaBytes: headTotal ?? null,
            headOverBaseline,
            threshold: 0.6,
            passed,
        };
        check(pairedIssues, passed, `comparative-${endpoint}-carrier-total`);
    }

    const evaluatedPerformance = evaluatePerformanceGate(
        baseline.metrics,
        head.metrics
    );
    const performance = {
        ...evaluatedPerformance,
        passed:
            evaluatedPerformance.passed &&
            baseline.performanceIssues.length === 0 &&
            head.performanceIssues.length === 0,
        evidenceIssues: {
            baseline: baseline.performanceIssues,
            head: head.performanceIssues,
        },
    };
    const delta = {};
    for (const key of Object.keys(baseline.metrics)) {
        delta[key] = {
            baseline: baseline.metrics[key],
            head: head.metrics[key],
            delta: head.metrics[key] - baseline.metrics[key],
            headOverBaseline:
                baseline.metrics[key] === 0
                    ? null
                    : head.metrics[key] / baseline.metrics[key],
        };
    }
    const correctnessAndCarrierPassed =
        baseline.correctnessPassed &&
        head.correctnessPassed &&
        baseline.carrierGatePassed &&
        head.carrierGatePassed &&
        carrierComparisons.writer.passed &&
        carrierComparisons.reader.passed &&
        pairedIssues.length === 0;
    const currentRunUrl = resolveRunUrl(environment);
    const campaignContract = {
        workflowSource,
        harnessCoreCommit: contract.harnessCoreCommit,
        baselineCoreCommit: contract.baselineCoreCommit,
        headCoreCommit: contract.headCoreCommit,
        examplesCommit: contract.examplesCommit,
        examplesLockSha256: contract.examplesLockSha256,
        invocation: baseline.invocation,
        transportCounterKeyFields: [...TRANSPORT_COUNTER_KEY_FIELDS],
        remotePayloadBytes: contract.remotePayloadBytes,
        remotePayloadUpperBytes: contract.remotePayloadUpperBytes,
    };
    return {
        schema: CAMPAIGN_REPORT_SCHEMA,
        generatedAt: new Date().toISOString(),
        currentRunUrl,
        order,
        runStatus,
        campaignContract,
        assessments: {
            correctnessAndCarrierEvidence: {
                passed: correctnessAndCarrierPassed,
                gatesWorkflow: true,
                definition:
                    "both immutable variants must pass deterministic integrity, exact chunk/locality/topology/provenance checks and independently audited pre/post pubsub counter envelopes on writer outbound and reader inbound endpoints",
                comparativeCarrierTotals: carrierComparisons,
            },
            perPairPerformanceSafety: {
                ...performance,
                gatesWorkflow: true,
                definition:
                    "this single order only rejects a greater-than-10% regression in either primary timing and retains conservative relative demand-wait and memory-growth safety bounds; it does not establish the two-order campaign benefit",
            },
            campaignAcceptance: {
                passed: null,
                evaluatedBySingleRun: false,
                requiresTwoGreenRunUrls: true,
                requiredOrders: ["baseline-head", "head-baseline"],
                currentOrder: contract.pairOrder,
                currentRunUrl,
                requiredIdenticalContractAcrossRuns: true,
                compareExactFieldAcrossRunUrls: "campaignContract",
                geometricMeanThresholds: {
                    secondHalfHeadOverBaseline: 0.9,
                    libraryStreamWallHeadOverBaseline: 0.95,
                },
                definition:
                    "final acceptance requires two green run URLs with opposite explicit orders, identical immutable campaignContract values, geometric mean(head secondHalfMs / baseline secondHalfMs) <= 0.90, and geometric mean(head libraryStreamWallMs / baseline libraryStreamWallMs) <= 0.95",
            },
        },
        comparisonGatePassed: correctnessAndCarrierPassed && performance.passed,
        pairedIssues,
        baseline: {
            summaryFile: baseline.summaryFile,
            correctnessIssues: baseline.correctnessIssues,
            performanceIssues: baseline.performanceIssues,
            cohort: baseline.cohort,
            transport: baseline.transport,
            metrics: baseline.metrics,
        },
        head: {
            summaryFile: head.summaryFile,
            correctnessIssues: head.correctnessIssues,
            performanceIssues: head.performanceIssues,
            cohort: head.cohort,
            transport: head.transport,
            metrics: head.metrics,
        },
        delta,
    };
};

const failureReport = (environment, error) => ({
    schema: CAMPAIGN_REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    currentRunUrl: resolveRunUrl(environment),
    assessments: {
        correctnessAndCarrierEvidence: {
            passed: false,
            gatesWorkflow: true,
        },
        perPairPerformanceSafety: {
            passed: false,
            gatesWorkflow: true,
        },
        campaignAcceptance: {
            passed: null,
            evaluatedBySingleRun: false,
            requiresTwoGreenRunUrls: true,
            requiredOrders: ["baseline-head", "head-baseline"],
            currentOrder: environment.PAIR_ORDER ?? null,
            currentRunUrl: resolveRunUrl(environment),
            geometricMeanThresholds: {
                secondHalfHeadOverBaseline: 0.9,
                libraryStreamWallHeadOverBaseline: 0.95,
            },
        },
    },
    comparisonGatePassed: false,
    error: error?.stack ?? String(error),
});

const reportPath = (environment) =>
    path.join(
        environment.RESULTS_ROOT,
        "outbound-candidate-pruning-comparison.json"
    );

const buildAndPersist = (environment) => {
    let report;
    try {
        report = buildCampaignReport(environment);
    } catch (error) {
        report = failureReport(environment, error);
    }
    writeJson(reportPath(environment), report);
    console.log(JSON.stringify(report, null, 2));
    return report;
};

const appendStepSummary = (environment) => {
    const report = readJson(reportPath(environment));
    const mark = (passed) => (passed ? "PASS" : "FAIL");
    const correctness = report.assessments?.correctnessAndCarrierEvidence;
    const performance = report.assessments?.perPairPerformanceSafety;
    const campaign = report.assessments?.campaignAcceptance;
    const summary = [
        "## Exact 1 GiB outbound-candidate pruning pair",
        "",
        `- Run URL: ${report.currentRunUrl ?? "unavailable"}`,
        `- Explicit order: ${campaign?.currentOrder ?? "unavailable"}`,
        `- Correctness and pubsub carrier evidence (gating): ${mark(correctness?.passed)}`,
        `- Per-pair performance safety (gating): ${mark(performance?.passed)}`,
        "",
        "This single run does **not** evaluate final campaign acceptance.",
        "Final acceptance requires two green run URLs with opposite orders, identical immutable campaign contracts, geometric mean `head secondHalfMs / baseline secondHalfMs <= 0.90`, and geometric mean `head libraryStreamWallMs / baseline libraryStreamWallMs <= 0.95`.",
        "No stream multiplexer is prescribed; the evidence records the actual negotiated values.",
        "",
    ].join("\n");
    if (environment.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(environment.GITHUB_STEP_SUMMARY, summary);
    }
    console.log(summary);
};

const enforce = (environment, assessment) => {
    const report = readJson(reportPath(environment));
    if (
        report.error != null ||
        report.assessments?.[assessment]?.passed !== true
    ) {
        process.exitCode = 1;
    }
};

export const main = (
    argv = process.argv.slice(2),
    environment = process.env
) => {
    const command = argv[0] ?? "build";
    if (command === "build") {
        buildAndPersist(environment);
        return;
    }
    if (command === "summary") {
        appendStepSummary(environment);
        return;
    }
    if (command === "enforce-correctness") {
        enforce(environment, "correctnessAndCarrierEvidence");
        return;
    }
    if (command === "enforce-performance") {
        enforce(environment, "perPairPerformanceSafety");
        return;
    }
    throw new Error(`Unknown command ${command}`);
};

if (
    process.argv[1] != null &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    try {
        main();
    } catch (error) {
        console.error(error?.stack ?? String(error));
        process.exit(1);
    }
}
