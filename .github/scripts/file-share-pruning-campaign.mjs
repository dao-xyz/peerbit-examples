import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const CAMPAIGN_REPORT_SCHEMA = Object.freeze({
    id: "peerbit-file-share-outbound-candidate-pruning-comparison",
    version: 2,
});

export const COMBINED_CAMPAIGN_REPORT_SCHEMA = Object.freeze({
    id: "peerbit-file-share-outbound-candidate-pruning-counterbalanced",
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
const PERFORMANCE_METRIC_KEYS = Object.freeze([
    "libraryStreamWallMs",
    "firstHalfMs",
    "secondHalfMs",
    "demandWaitSumMs",
    "firstHalfDemandWaitMs",
    "secondHalfDemandWaitMs",
    "maxDemandWaitMs",
    "over10sDemandWaitCount",
    "maxChunkAttempts",
    "startBrowserBytes",
    "peakBrowserBytes",
    "browserGrowthBytes",
    "browserGrowthOverFile",
    "startCombinedBytes",
    "peakCombinedBytes",
    "combinedGrowthBytes",
    "combinedGrowthOverFile",
]);

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

const parsePositiveSafeInteger = (value) => {
    if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
        return null;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
};

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
    if (
        !isRecord(endpoint) ||
        !isNonNegativeSafeInteger(endpoint.dominantDeltaBytes) ||
        !isNonNegativeSafeInteger(endpoint.totalDeltaBytes)
    ) {
        return false;
    }
    if (variant === "head") {
        return (
            endpoint.carrierCount === 1 &&
            endpoint.dominantDeltaBytes >= P &&
            endpoint.totalDeltaBytes >= endpoint.dominantDeltaBytes &&
            endpoint.totalDeltaBytes <= U &&
            endpoint.dominantShare >= 0.99 &&
            endpoint.dominantShare <= 1 &&
            endpoint.duplicationFactor != null &&
            endpoint.duplicationFactor >= 1 &&
            endpoint.duplicationFactor <= 1.01
        );
    }
    if (variant === "baseline") {
        return (
            Number.isSafeInteger(endpoint.carrierCount) &&
            endpoint.carrierCount >= 1 &&
            endpoint.dominantDeltaBytes >= P &&
            endpoint.dominantDeltaBytes <= U &&
            endpoint.totalDeltaBytes >= endpoint.dominantDeltaBytes &&
            endpoint.totalDeltaBytes <= endpoint.carrierCount * U &&
            endpoint.dominantShare > 0 &&
            endpoint.dominantShare <= 1 &&
            endpoint.duplicationFactor != null &&
            endpoint.duplicationFactor >= 1
        );
    }
    throw new Error(`Unknown variant ${variant}`);
};

export const baselineDuplicateCarrierObserved = (endpoint) =>
    evaluateVariantCarrierGate("baseline", endpoint) &&
    endpoint.carrierCount >= 2 &&
    endpoint.totalDeltaBytes >= 1.8 * endpoint.dominantDeltaBytes &&
    endpoint.duplicationFactor >= 1.8;

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
        readerTerminalTopology: "observer",
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
            locality?.expectedTerminalTopology === "observer",
        "locality-contract"
    );
    const expectedCohort = `observer-persistent-prefix-b${contract.localPrefixBlockCount}-i${contract.localPrefixIndexRowCount}`;
    check(
        issues,
        result?.readerLocalChunkTarget === contract.localPrefixBlockCount &&
            result?.readerLocalChunkMaxOvershoot === 0 &&
            result?.readerTerminalTopology === "observer" &&
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
    check(
        issues,
        validateTopologyRole(writerPost, {
            ownPeerHash: writerHash,
            expectedReplicatorHashes: singleton,
            expectedSelfInReplicatorSet: true,
            expectedReplicatorCount: 1,
        }) &&
            validateTopologyRole(readerPost, {
                ownPeerHash: readerHash,
                expectedReplicatorHashes: singleton,
                expectedSelfInReplicatorSet: false,
                expectedReplicatorCount: 1,
            }),
        "post-read-writer-only-singleton"
    );

    const terminalIdle = locality?.terminalIdleObservation;
    check(
        issues,
        terminalIdle?.chunkCount === contract.chunkCount &&
            terminalIdle?.blockCount === contract.chunkCount &&
            terminalIdle?.indexRowCount === 0 &&
            exactRange(terminalIdle?.blockChunkIndices, contract.chunkCount) &&
            isDeepStrictEqual(terminalIdle?.indexedChunkIndices, []) &&
            terminalIdle?.persistChunkReads === true &&
            locality?.terminalTopologyRole === "observer" &&
            locality?.terminalTopologyExpectationSatisfied === true,
        "terminal-full-observer-block-persistence"
    );
    const terminalObservations = locality?.terminalTopologyObservations;
    const terminalStartedAt = locality?.terminalTopologyStartedAt;
    const terminalDeadlineAt = locality?.terminalTopologyDeadlineAt;
    const terminalFinishedAt = locality?.terminalTopologyFinishedAt;
    const stabilityPollIntervalMs = locality?.stabilityPollIntervalMs;
    check(
        issues,
        isNonNegativeSafeInteger(terminalIdle?.capturedAt) &&
            isNonNegativeSafeInteger(terminalStartedAt) &&
            isNonNegativeSafeInteger(terminalDeadlineAt) &&
            isNonNegativeSafeInteger(terminalFinishedAt) &&
            Number.isSafeInteger(stabilityPollIntervalMs) &&
            stabilityPollIntervalMs > 0 &&
            terminalIdle.capturedAt <= terminalStartedAt &&
            terminalDeadlineAt ===
                terminalStartedAt + result?.invocation?.readyTimeoutMs &&
            terminalStartedAt <= terminalFinishedAt &&
            terminalFinishedAt <= terminalDeadlineAt &&
            Array.isArray(terminalObservations) &&
            terminalObservations.length === 3 &&
            terminalObservations.every(
                (observation, index) =>
                    isNonNegativeSafeInteger(observation?.capturedAt) &&
                    isNonNegativeSafeInteger(
                        observation?.writerTopology?.capturedAt
                    ) &&
                    isNonNegativeSafeInteger(
                        observation?.readerTopology?.capturedAt
                    ) &&
                    observation.writerTopology.capturedAt <=
                        observation.capturedAt &&
                    observation.readerTopology.capturedAt <=
                        observation.capturedAt &&
                    observation.writerTopology.capturedAt >=
                        terminalStartedAt &&
                    observation.readerTopology.capturedAt >=
                        terminalStartedAt &&
                    observation.capturedAt >= terminalStartedAt &&
                    observation.capturedAt <= terminalFinishedAt &&
                    (index === 0 ||
                        observation.capturedAt -
                            terminalObservations[index - 1].capturedAt >=
                            stabilityPollIntervalMs)
            ),
        "terminal-topology-chronology"
    );
    check(
        issues,
        Array.isArray(terminalObservations) &&
            terminalObservations.length === 3 &&
            terminalObservations.every(
                (observation) =>
                    validateTopologyRole(observation?.writerTopology, {
                        ownPeerHash: writerHash,
                        expectedReplicatorHashes: singleton,
                        expectedSelfInReplicatorSet: true,
                        expectedReplicatorCount: 1,
                    }) &&
                    validateTopologyRole(observation?.readerTopology, {
                        ownPeerHash: readerHash,
                        expectedReplicatorHashes: singleton,
                        expectedSelfInReplicatorSet: false,
                        expectedReplicatorCount: 1,
                    })
            ),
        "terminal-reader-excluded-observer-topology"
    );
    check(
        issues,
        result?.writerDiagnostics?.peerHash === writerHash &&
            result?.readerDiagnostics?.peerHash === readerHash &&
            result?.writerDiagnostics?.replicatorCount === 1 &&
            result?.readerDiagnostics?.replicatorCount === 1 &&
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
    const workflowExecution = {
        runId: parsePositiveSafeInteger(environment.GITHUB_RUN_ID),
        runAttempt: parsePositiveSafeInteger(environment.GITHUB_RUN_ATTEMPT),
        actor: environment.GITHUB_ACTOR ?? null,
        triggeringActor: environment.GITHUB_TRIGGERING_ACTOR ?? null,
    };
    check(
        pairedIssues,
        workflowExecution.runId != null &&
            workflowExecution.runAttempt != null &&
            typeof workflowExecution.actor === "string" &&
            workflowExecution.actor.length > 0 &&
            typeof workflowExecution.triggeringActor === "string" &&
            workflowExecution.triggeringActor.length > 0,
        "workflow-execution-provenance"
    );

    const benefitIssues = [];
    const carrierComparisons = {};
    for (const endpoint of ["writer", "reader"]) {
        const baselineTotal = baseline.transport?.[endpoint]?.totalDeltaBytes;
        const headTotal = head.transport?.[endpoint]?.totalDeltaBytes;
        const conditionObserved = baselineDuplicateCarrierObserved(
            baseline.transport?.[endpoint]
        );
        const headOverBaseline =
            isPositiveFiniteNumber(baselineTotal) &&
            isNonNegativeSafeInteger(headTotal)
                ? headTotal / baselineTotal
                : null;
        const passed =
            conditionObserved && headOverBaseline != null
                ? headOverBaseline <= 0.6
                : null;
        carrierComparisons[endpoint] = {
            baselineTotalDeltaBytes: baselineTotal ?? null,
            headTotalDeltaBytes: headTotal ?? null,
            headOverBaseline,
            duplicateCarrierConditionObserved: conditionObserved,
            evaluated: conditionObserved,
            threshold: 0.6,
            passed,
        };
        if (conditionObserved) {
            check(
                benefitIssues,
                passed === true,
                `comparative-${endpoint}-carrier-total`
            );
        }
    }
    const duplicateCarrierConditionConsistent =
        carrierComparisons.writer.duplicateCarrierConditionObserved ===
        carrierComparisons.reader.duplicateCarrierConditionObserved;
    check(
        benefitIssues,
        duplicateCarrierConditionConsistent,
        "baseline-duplicate-carrier-condition-endpoint-mismatch"
    );
    const duplicateCarrierConditionObserved =
        duplicateCarrierConditionConsistent
            ? carrierComparisons.writer.duplicateCarrierConditionObserved
            : null;

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
    const performanceEvidenceComplete =
        baseline.performanceIssues.length === 0 &&
        head.performanceIssues.length === 0;
    const correctnessAndTransportPassed =
        baseline.correctnessPassed &&
        head.correctnessPassed &&
        baseline.carrierGatePassed &&
        head.carrierGatePassed &&
        pairedIssues.length === 0;
    const pairEvidencePassed =
        correctnessAndTransportPassed && performanceEvidenceComplete;
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
        workflowExecution,
        order,
        runStatus,
        campaignContract,
        assessments: {
            correctnessAndTransportEvidence: {
                passed: correctnessAndTransportPassed,
                gatesWorkflow: true,
                definition:
                    "both immutable variants must pass deterministic integrity, exact chunk/locality/observer-topology/provenance checks and independently audited pre/post pubsub counter safety envelopes on writer outbound and reader inbound endpoints",
                comparativeCarrierTotals: carrierComparisons,
            },
            baselineDuplicateCarrierCondition: {
                evaluated: duplicateCarrierConditionConsistent,
                observed: duplicateCarrierConditionObserved,
                endpointClassificationConsistent:
                    duplicateCarrierConditionConsistent,
                gatesWorkflow: false,
                definition:
                    "the historical baseline condition is observed only when both endpoints carry at least 1.8 copies of the dominant remote payload across two or more stable pubsub carriers",
            },
            performanceEvidenceValidity: {
                passed: performanceEvidenceComplete,
                gatesWorkflow: true,
                evidenceIssues: {
                    baseline: baseline.performanceIssues,
                    head: head.performanceIssues,
                },
                definition:
                    "both variants must provide complete finite timing, demand-wait, chunk-attempt, and memory telemetry before the pair report can be combined",
            },
            pruningBenefitEvidence: {
                passed:
                    duplicateCarrierConditionObserved === true
                        ? carrierComparisons.writer.passed === true &&
                          carrierComparisons.reader.passed === true
                        : null,
                evaluated: duplicateCarrierConditionObserved === true,
                gatesWorkflow: false,
                evidenceIssues: benefitIssues,
                definition:
                    "per-pair carrier-byte reduction is evaluated only when the duplicate-carrier condition is actually observed on both baseline endpoints; otherwise pruning benefit remains explicitly unevaluated",
            },
            perPairPerformanceSafety: {
                ...performance,
                evidenceComplete: performanceEvidenceComplete,
                gatesWorkflow: false,
                definition:
                    "this single-order timing, demand-wait, and memory comparison is diagnostic because execution-order effects are removed only by the counterbalanced aggregate",
            },
            campaignAcceptance: {
                passed: null,
                evaluatedBySingleRun: false,
                requiresTwoValidatedPairReports: true,
                requiredOrders: ["baseline-head", "head-baseline"],
                currentOrder: contract.pairOrder,
                currentRunUrl,
                requiredIdenticalContractAcrossRuns: true,
                compareExactFieldAcrossRunUrls: "campaignContract",
                requiresDuplicateCarrierConditionInBothRunsForPruningBenefit: true,
                geometricMeanThresholds: {
                    regressionSafety: {
                        secondHalfHeadOverBaseline: 1.1,
                        libraryStreamWallHeadOverBaseline: 1.1,
                    },
                    pruningBenefit: {
                        secondHalfHeadOverBaseline: 0.9,
                        libraryStreamWallHeadOverBaseline: 0.95,
                    },
                },
                definition:
                    "final assessment requires two correct reports with opposite explicit orders and identical immutable campaignContract values; aggregate regression safety uses <= 1.10 timing geometric means, while pruning benefit remains unevaluated unless both baselines reproduce the duplicate-carrier condition",
            },
        },
        workflowGatePassed: pairEvidencePassed,
        pairedIssues,
        benefitIssues,
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

const geometricMean = (values) => {
    if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.some((value) => !isPositiveFiniteNumber(value))
    ) {
        return null;
    }
    return Math.exp(
        values.reduce((total, value) => total + Math.log(value), 0) /
            values.length
    );
};

const hasCompleteRawPerformanceMetrics = (metrics) =>
    isRecord(metrics) &&
    isDeepStrictEqual(
        Object.keys(metrics).sort(),
        [...PERFORMANCE_METRIC_KEYS].sort()
    ) &&
    Object.values(metrics).every(
        (value) => typeof value === "number" && Number.isFinite(value)
    );

export const combineCampaignReports = (reports) => {
    const validationIssues = [];
    check(
        validationIssues,
        Array.isArray(reports) && reports.length === 2,
        "exactly-two-pair-reports"
    );
    const pairReports = Array.isArray(reports) ? reports : [];
    for (const [index, report] of pairReports.entries()) {
        check(
            validationIssues,
            isDeepStrictEqual(report?.schema, CAMPAIGN_REPORT_SCHEMA),
            `pair-${index + 1}-schema`
        );
        check(
            validationIssues,
            report?.error == null,
            `pair-${index + 1}-report-error`
        );
        check(
            validationIssues,
            report?.runStatus === "0",
            `pair-${index + 1}-run-status`
        );
        check(
            validationIssues,
            Number.isSafeInteger(report?.workflowExecution?.runId) &&
                report.workflowExecution.runId > 0 &&
                Number.isSafeInteger(report?.workflowExecution?.runAttempt) &&
                report.workflowExecution.runAttempt > 0 &&
                typeof report.workflowExecution.actor === "string" &&
                report.workflowExecution.actor.length > 0 &&
                typeof report.workflowExecution.triggeringActor === "string" &&
                report.workflowExecution.triggeringActor.length > 0 &&
                typeof report?.currentRunUrl === "string" &&
                report.currentRunUrl.endsWith(
                    `/actions/runs/${report.workflowExecution.runId}`
                ),
            `pair-${index + 1}-workflow-execution`
        );
        check(
            validationIssues,
            report?.assessments?.correctnessAndTransportEvidence?.passed ===
                true && report?.workflowGatePassed === true,
            `pair-${index + 1}-correctness`
        );
        check(
            validationIssues,
            report?.assessments?.perPairPerformanceSafety?.evidenceComplete ===
                true,
            `pair-${index + 1}-performance-evidence`
        );
        check(
            validationIssues,
            hasCompleteRawPerformanceMetrics(report?.baseline?.metrics) &&
                hasCompleteRawPerformanceMetrics(report?.head?.metrics),
            `pair-${index + 1}-raw-performance-metrics`
        );
        check(
            validationIssues,
            Array.isArray(report?.pairedIssues) &&
                report.pairedIssues.length === 0 &&
                Array.isArray(report?.baseline?.correctnessIssues) &&
                report.baseline.correctnessIssues.length === 0 &&
                Array.isArray(report?.head?.correctnessIssues) &&
                report.head.correctnessIssues.length === 0 &&
                Array.isArray(report?.baseline?.performanceIssues) &&
                report.baseline.performanceIssues.length === 0 &&
                Array.isArray(report?.head?.performanceIssues) &&
                report.head.performanceIssues.length === 0,
            `pair-${index + 1}-raw-evidence-issues`
        );
        check(
            validationIssues,
            evaluateVariantCarrierGate(
                "baseline",
                report?.baseline?.transport?.writer
            ) &&
                evaluateVariantCarrierGate(
                    "baseline",
                    report?.baseline?.transport?.reader
                ) &&
                evaluateVariantCarrierGate(
                    "head",
                    report?.head?.transport?.writer
                ) &&
                evaluateVariantCarrierGate(
                    "head",
                    report?.head?.transport?.reader
                ),
            `pair-${index + 1}-raw-carrier-envelope`
        );
    }

    const requiredOrders = ["baseline-head", "head-baseline"];
    const actualOrders = pairReports
        .map(
            (report) =>
                report?.assessments?.campaignAcceptance?.currentOrder ?? null
        )
        .sort();
    check(
        validationIssues,
        isDeepStrictEqual(actualOrders, [...requiredOrders].sort()),
        "opposite-pair-orders"
    );
    for (const report of pairReports) {
        const order =
            report?.assessments?.campaignAcceptance?.currentOrder ?? null;
        const expectedOrder =
            order === "baseline-head"
                ? ["baseline", "head"]
                : order === "head-baseline"
                  ? ["head", "baseline"]
                  : null;
        check(
            validationIssues,
            expectedOrder != null &&
                isDeepStrictEqual(report?.order, expectedOrder),
            `pair-order-evidence:${order ?? "missing"}`
        );
    }

    const runUrls = pairReports.map((report) => report?.currentRunUrl ?? null);
    const runIds = pairReports.map(
        (report) => report?.workflowExecution?.runId ?? null
    );
    check(
        validationIssues,
        runUrls.every(
            (runUrl) => typeof runUrl === "string" && runUrl.length > 0
        ) &&
            new Set(runUrls).size === 2 &&
            runIds.every((runId) => Number.isSafeInteger(runId) && runId > 0) &&
            new Set(runIds).size === 2,
        "distinct-workflow-runs"
    );
    const campaignContract = pairReports[0]?.campaignContract ?? null;
    check(
        validationIssues,
        pairReports.length === 2 &&
            isRecord(campaignContract) &&
            isDeepStrictEqual(
                campaignContract,
                pairReports[1]?.campaignContract
            ),
        "identical-campaign-contract"
    );

    const ratios = pairReports.map((report, index) => {
        const writerCondition = baselineDuplicateCarrierObserved(
            report?.baseline?.transport?.writer
        );
        const readerCondition = baselineDuplicateCarrierObserved(
            report?.baseline?.transport?.reader
        );
        const conditionClassificationConsistent =
            writerCondition === readerCondition;
        const baselineDuplicateCarrierConditionObserved =
            conditionClassificationConsistent ? writerCondition : null;
        const carrierRatios = Object.fromEntries(
            ["writer", "reader"].map((endpoint) => {
                const baselineTotal =
                    report?.baseline?.transport?.[endpoint]?.totalDeltaBytes;
                const headTotal =
                    report?.head?.transport?.[endpoint]?.totalDeltaBytes;
                return [
                    endpoint,
                    isPositiveFiniteNumber(baselineTotal) &&
                    isNonNegativeSafeInteger(headTotal)
                        ? headTotal / baselineTotal
                        : null,
                ];
            })
        );
        const carrierPruningEvidencePassed =
            baselineDuplicateCarrierConditionObserved === true
                ? isPositiveFiniteNumber(carrierRatios.writer) &&
                  isPositiveFiniteNumber(carrierRatios.reader) &&
                  carrierRatios.writer <= 0.6 &&
                  carrierRatios.reader <= 0.6
                : null;
        check(
            validationIssues,
            report?.assessments?.baselineDuplicateCarrierCondition
                ?.evaluated === conditionClassificationConsistent &&
                report?.assessments?.baselineDuplicateCarrierCondition
                    ?.observed === baselineDuplicateCarrierConditionObserved &&
                report?.assessments?.pruningBenefitEvidence?.passed ===
                    carrierPruningEvidencePassed,
            `pair-${index + 1}-assessment-consistency`
        );
        return {
            order:
                report?.assessments?.campaignAcceptance?.currentOrder ?? null,
            runUrl: report?.currentRunUrl ?? null,
            libraryStreamWallHeadOverBaseline:
                isPositiveFiniteNumber(
                    report?.baseline?.metrics?.libraryStreamWallMs
                ) &&
                isPositiveFiniteNumber(
                    report?.head?.metrics?.libraryStreamWallMs
                )
                    ? report.head.metrics.libraryStreamWallMs /
                      report.baseline.metrics.libraryStreamWallMs
                    : null,
            secondHalfHeadOverBaseline:
                isPositiveFiniteNumber(
                    report?.baseline?.metrics?.secondHalfMs
                ) && isPositiveFiniteNumber(report?.head?.metrics?.secondHalfMs)
                    ? report.head.metrics.secondHalfMs /
                      report.baseline.metrics.secondHalfMs
                    : null,
            conditionClassificationConsistent,
            baselineDuplicateCarrierConditionObserved,
            carrierRatios,
            carrierPruningEvidencePassed,
        };
    });
    check(
        validationIssues,
        ratios.every(
            (ratio) =>
                isPositiveFiniteNumber(
                    ratio.libraryStreamWallHeadOverBaseline
                ) && isPositiveFiniteNumber(ratio.secondHalfHeadOverBaseline)
        ),
        "finite-positive-timing-ratios"
    );

    const libraryStreamWallHeadOverBaseline = geometricMean(
        ratios.map((ratio) => ratio.libraryStreamWallHeadOverBaseline)
    );
    const secondHalfHeadOverBaseline = geometricMean(
        ratios.map((ratio) => ratio.secondHalfHeadOverBaseline)
    );
    const aggregateEvidenceValid = validationIssues.length === 0;
    const regressionSafetyPassed = aggregateEvidenceValid
        ? libraryStreamWallHeadOverBaseline <= 1.1 &&
          secondHalfHeadOverBaseline <= 1.1
        : null;
    const duplicateCarrierConditionObservedInBoth =
        aggregateEvidenceValid &&
        ratios.every(
            (ratio) => ratio.baselineDuplicateCarrierConditionObserved
        );
    const carrierPruningEvidencePassedInBoth =
        duplicateCarrierConditionObservedInBoth &&
        ratios.every((ratio) => ratio.carrierPruningEvidencePassed === true);
    const pruningBenefitEvaluated =
        aggregateEvidenceValid && duplicateCarrierConditionObservedInBoth;
    const pruningBenefitPassed = pruningBenefitEvaluated
        ? carrierPruningEvidencePassedInBoth &&
          libraryStreamWallHeadOverBaseline <= 0.95 &&
          secondHalfHeadOverBaseline <= 0.9
        : null;
    const campaignAcceptancePassed = aggregateEvidenceValid
        ? regressionSafetyPassed === true && pruningBenefitPassed !== false
        : null;
    const aggregateWorkflowGatePassed = campaignAcceptancePassed === true;

    return {
        schema: COMBINED_CAMPAIGN_REPORT_SCHEMA,
        generatedAt: new Date().toISOString(),
        campaignContract,
        validationIssues,
        pairReports: ratios,
        aggregateRatios: {
            libraryStreamWallHeadOverBaseline,
            secondHalfHeadOverBaseline,
        },
        assessments: {
            evidenceValidity: {
                passed: aggregateEvidenceValid,
                definition:
                    "exactly two correct reports must have opposite explicit orders, distinct run URLs, identical immutable campaign contracts, and complete performance evidence",
            },
            regressionSafety: {
                evaluated: aggregateEvidenceValid,
                passed: regressionSafetyPassed,
                thresholds: {
                    libraryStreamWallHeadOverBaseline: 1.1,
                    secondHalfHeadOverBaseline: 1.1,
                },
            },
            baselineDuplicateCarrierCondition: {
                evaluated: aggregateEvidenceValid,
                observedInBoth: duplicateCarrierConditionObservedInBoth,
            },
            pruningBenefit: {
                evaluated: pruningBenefitEvaluated,
                passed: pruningBenefitPassed,
                carrierPruningEvidencePassedInBoth:
                    carrierPruningEvidencePassedInBoth,
                thresholds: {
                    libraryStreamWallHeadOverBaseline: 0.95,
                    secondHalfHeadOverBaseline: 0.9,
                },
                definition:
                    "benefit is evaluated only when both correct counterbalanced reports reproduce the baseline duplicate-carrier condition",
            },
            campaignAcceptance: {
                evaluated: aggregateEvidenceValid,
                passed: campaignAcceptancePassed,
                definition:
                    "acceptance requires valid evidence and aggregate regression safety; an observed duplicate-carrier condition additionally requires pruning benefit, while absent conditions remain explicitly unevaluated",
            },
        },
        workflowGatePassed: aggregateWorkflowGatePassed,
    };
};

const failureReport = (environment, error) => ({
    schema: CAMPAIGN_REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    currentRunUrl: resolveRunUrl(environment),
    workflowExecution: {
        runId: parsePositiveSafeInteger(environment.GITHUB_RUN_ID),
        runAttempt: parsePositiveSafeInteger(environment.GITHUB_RUN_ATTEMPT),
        actor: environment.GITHUB_ACTOR ?? null,
        triggeringActor: environment.GITHUB_TRIGGERING_ACTOR ?? null,
    },
    assessments: {
        correctnessAndTransportEvidence: {
            passed: false,
            gatesWorkflow: true,
        },
        baselineDuplicateCarrierCondition: {
            evaluated: false,
            observed: null,
            endpointClassificationConsistent: false,
            gatesWorkflow: false,
        },
        performanceEvidenceValidity: {
            passed: false,
            gatesWorkflow: true,
        },
        pruningBenefitEvidence: {
            passed: null,
            evaluated: false,
            gatesWorkflow: false,
        },
        perPairPerformanceSafety: {
            passed: false,
            evidenceComplete: false,
            gatesWorkflow: false,
        },
        campaignAcceptance: {
            passed: null,
            evaluatedBySingleRun: false,
            requiresTwoValidatedPairReports: true,
            requiredOrders: ["baseline-head", "head-baseline"],
            currentOrder: environment.PAIR_ORDER ?? null,
            currentRunUrl: resolveRunUrl(environment),
            geometricMeanThresholds: {
                regressionSafety: {
                    secondHalfHeadOverBaseline: 1.1,
                    libraryStreamWallHeadOverBaseline: 1.1,
                },
                pruningBenefit: {
                    secondHalfHeadOverBaseline: 0.9,
                    libraryStreamWallHeadOverBaseline: 0.95,
                },
            },
        },
    },
    workflowGatePassed: false,
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

const combineAndPersist = (inputPaths, outputPath) => {
    if (inputPaths.length !== 2 || !outputPath) {
        throw new Error(
            "combine requires exactly two pair-report paths and one output path"
        );
    }
    const report = combineCampaignReports(inputPaths.map(readJson));
    writeJson(outputPath, report);
    console.log(JSON.stringify(report, null, 2));
    return report;
};

const appendCombinedStepSummary = (environment, combinedPath) => {
    const report = readJson(combinedPath);
    const mark = (passed) =>
        passed === true ? "PASS" : passed === false ? "FAIL" : "UNEVALUATED";
    const regression = report.assessments?.regressionSafety;
    const condition = report.assessments?.baselineDuplicateCarrierCondition;
    const benefit = report.assessments?.pruningBenefit;
    const acceptance = report.assessments?.campaignAcceptance;
    const summary = [
        "## Counterbalanced outbound-candidate pruning campaign",
        "",
        `- Evidence validity: ${mark(report.assessments?.evidenceValidity?.passed)}`,
        `- Aggregate regression safety: ${mark(regression?.passed)}`,
        `- Baseline duplicate-carrier condition in both orders: ${condition?.evaluated !== true ? "UNEVALUATED" : condition.observedInBoth === true ? "OBSERVED" : "NOT OBSERVED"}`,
        `- Pruning benefit: ${mark(benefit?.passed)}`,
        `- Aggregate workflow gate: ${mark(acceptance?.passed)}`,
        `- Library wall geometric mean (head/baseline): ${report.aggregateRatios?.libraryStreamWallHeadOverBaseline ?? "unavailable"}`,
        `- Second-half geometric mean (head/baseline): ${report.aggregateRatios?.secondHalfHeadOverBaseline ?? "unavailable"}`,
        "",
    ].join("\n");
    if (environment.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(environment.GITHUB_STEP_SUMMARY, summary);
    }
    console.log(summary);
};

const enforceCombined = (combinedPath) => {
    const report = readJson(combinedPath);
    if (
        !isDeepStrictEqual(report?.schema, COMBINED_CAMPAIGN_REPORT_SCHEMA) ||
        report?.workflowGatePassed !== true
    ) {
        process.exitCode = 1;
    }
};

const appendStepSummary = (environment) => {
    const report = readJson(reportPath(environment));
    const mark = (passed) =>
        passed === true ? "PASS" : passed === false ? "FAIL" : "UNEVALUATED";
    const observed = (value) =>
        value === true
            ? "OBSERVED"
            : value === false
              ? "NOT OBSERVED"
              : "UNEVALUATED";
    const correctness = report.assessments?.correctnessAndTransportEvidence;
    const condition = report.assessments?.baselineDuplicateCarrierCondition;
    const performanceEvidence = report.assessments?.performanceEvidenceValidity;
    const pruningBenefit = report.assessments?.pruningBenefitEvidence;
    const performance = report.assessments?.perPairPerformanceSafety;
    const campaign = report.assessments?.campaignAcceptance;
    const summary = [
        "## Exact 1 GiB outbound-candidate pruning pair",
        "",
        `- Run URL: ${report.currentRunUrl ?? "unavailable"}`,
        `- Explicit order: ${campaign?.currentOrder ?? "unavailable"}`,
        `- Correctness and transport evidence (workflow gate): ${mark(correctness?.passed)}`,
        `- Performance evidence completeness (workflow gate): ${mark(performanceEvidence?.passed)}`,
        `- Baseline duplicate-carrier condition: ${observed(condition?.observed)}`,
        `- Per-pair carrier pruning evidence: ${mark(pruningBenefit?.passed)}`,
        `- Per-pair performance comparison (diagnostic): ${mark(performance?.passed)}`,
        "",
        "This single run does **not** evaluate final campaign acceptance.",
        "Combine two correct reports with opposite orders and identical immutable campaign contracts. Aggregate regression safety requires both timing geometric means to be `<= 1.10`. Pruning benefit is evaluated only if both baselines reproduce duplicate carriers, then requires `secondHalf <= 0.90` and `libraryStreamWall <= 0.95`.",
        "No stream multiplexer is prescribed; the evidence records the actual negotiated values.",
        "",
    ].join("\n");
    if (environment.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(environment.GITHUB_STEP_SUMMARY, summary);
    }
    console.log(summary);
};

const enforceWorkflowGate = (environment) => {
    const report = readJson(reportPath(environment));
    if (report.error != null || report.workflowGatePassed !== true) {
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
    if (command === "combine") {
        if (argv.length !== 4) {
            throw new Error(
                "combine requires REPORT_A REPORT_B OUTPUT arguments"
            );
        }
        combineAndPersist(argv.slice(1, 3), argv[3]);
        return;
    }
    if (command === "summary-combined") {
        if (!argv[1]) {
            throw new Error("summary-combined requires a combined report path");
        }
        appendCombinedStepSummary(environment, argv[1]);
        return;
    }
    if (command === "enforce-combined") {
        if (!argv[1]) {
            throw new Error("enforce-combined requires a combined report path");
        }
        enforceCombined(argv[1]);
        return;
    }
    if (command === "summary") {
        appendStepSummary(environment);
        return;
    }
    if (command === "enforce-pair-evidence") {
        enforceWorkflowGate(environment);
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
