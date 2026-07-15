import { TINY_FILE_WRITE_SIZE_LIMIT_BYTES } from "@peerbit/please-lib";

export const READER_COHORTS = [
    "live-replicator",
    "cold-observer",
    "cold-persisted-read",
] as const;

export type ReaderCohort = (typeof READER_COHORTS)[number];

export const DOWNLOAD_SINKS = ["hash-only", "opfs", "node-file"] as const;

export type BenchmarkDownloadSink = (typeof DOWNLOAD_SINKS)[number];

export const resolveBenchmarkDownloadSink = (
    value?: string
): BenchmarkDownloadSink => {
    const sink = value?.trim() || "hash-only";
    if ((DOWNLOAD_SINKS as readonly string[]).includes(sink)) {
        return sink as BenchmarkDownloadSink;
    }
    throw new Error(`Unsupported PW_DOWNLOAD_SINK='${value}'`);
};

export const TINY_FILE_SIZE_LIMIT_BYTES = TINY_FILE_WRITE_SIZE_LIMIT_BYTES;
const MEBIBYTE_BYTES = 1024 * 1024;

export const validateLargeFileBenchmarkSizeMb = (fileSizeMb: number) => {
    const sizeBytes = fileSizeMb * MEBIBYTE_BYTES;
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw new Error(
            `Invalid file-share benchmark configuration: PW_FILE_MB='${fileSizeMb}' must resolve to a non-negative safe-integer byte size`
        );
    }
    if (sizeBytes <= TINY_FILE_SIZE_LIMIT_BYTES) {
        throw new Error(
            `Invalid file-share benchmark configuration: PW_FILE_MB='${fileSizeMb}' resolves to ${sizeBytes} bytes, which uses TinyFile at or below the ${TINY_FILE_SIZE_LIMIT_BYTES}-byte cutoff; this benchmark requires the LargeFile ready-manifest protocol (use 6 MiB or larger)`
        );
    }
    return sizeBytes;
};

export const stopSamplerAtCompletion = <TResult, TMeasurement>(
    completion: Promise<TResult>,
    sampler: { stop: () => Promise<TMeasurement> }
) =>
    completion.then(async (result) => ({
        result,
        measurement: await sampler.stop(),
    }));

export type JsHeapMeasurementSummary = {
    sampleCount: number;
    startBytes: number | null;
    endBytes: number | null;
    peakBytes: number | null;
};

const isFiniteHeapByteValue = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;

export const validateJsHeapMeasurement = (
    measurement: JsHeapMeasurementSummary | null | undefined
) => {
    const validationReasons: string[] = [];
    if (measurement == null) {
        validationReasons.push("missing-js-heap-measurement");
        return { valid: false, validationReasons };
    }
    if (
        !Number.isFinite(measurement.sampleCount) ||
        measurement.sampleCount <= 0
    ) {
        validationReasons.push("invalid-js-heap-sample-count");
    }
    if (!isFiniteHeapByteValue(measurement.startBytes)) {
        validationReasons.push("invalid-js-heap-start-bytes");
    }
    if (!isFiniteHeapByteValue(measurement.endBytes)) {
        validationReasons.push("invalid-js-heap-end-bytes");
    }
    if (!isFiniteHeapByteValue(measurement.peakBytes)) {
        validationReasons.push("invalid-js-heap-peak-bytes");
    }
    return {
        valid: validationReasons.length === 0,
        validationReasons,
    };
};

export type HostRssMeasurementSummary = {
    sampleCount: number;
    startBrowserBytes: number | null;
    endBrowserBytes: number | null;
    peakBrowserBytes: number | null;
    startNodeBytes: number | null;
    endNodeBytes: number | null;
    peakNodeBytes: number | null;
    peakCombinedBytes: number | null;
    samplingErrors: string[];
};

export const validateHostRssMeasurement = (
    measurement: HostRssMeasurementSummary | null | undefined
) => {
    const validationReasons: string[] = [];
    if (measurement == null) {
        validationReasons.push("missing-host-rss-measurement");
        return { valid: false, validationReasons };
    }
    if (
        !Number.isFinite(measurement.sampleCount) ||
        measurement.sampleCount <= 0
    ) {
        validationReasons.push("invalid-host-rss-sample-count");
    }
    for (const [name, value] of [
        ["start-browser", measurement.startBrowserBytes],
        ["end-browser", measurement.endBrowserBytes],
        ["peak-browser", measurement.peakBrowserBytes],
        ["start-node", measurement.startNodeBytes],
        ["end-node", measurement.endNodeBytes],
        ["peak-node", measurement.peakNodeBytes],
        ["peak-combined", measurement.peakCombinedBytes],
    ] as const) {
        if (!isFiniteHeapByteValue(value) || value === 0) {
            validationReasons.push(`invalid-host-rss-${name}-bytes`);
        }
    }
    if (!Array.isArray(measurement.samplingErrors)) {
        validationReasons.push("invalid-host-rss-sampling-errors");
    } else if (measurement.samplingErrors.length > 0) {
        validationReasons.push("host-rss-sampling-errors");
    }
    return {
        valid: validationReasons.length === 0,
        validationReasons,
    };
};

const BROWSER_DIAL_TRANSPORT =
    /\/(?:ws|wss|webrtc|webrtc-direct|webtransport)(?:\/|$)/;

export const getBrowserDialablePeerAddresses = (value: unknown) => {
    if (!Array.isArray(value)) {
        return [];
    }
    return [
        ...new Set(
            value
                .filter(
                    (address): address is string => typeof address === "string"
                )
                .map((address) => address.trim())
                .filter(
                    (address) =>
                        address.length > 0 &&
                        address.includes("/p2p/") &&
                        BROWSER_DIAL_TRANSPORT.test(address)
                )
        ),
    ];
};

export const buildReaderShareUrlWithPeerHints = (
    shareHref: string,
    addresses: unknown
) => {
    const peerAddresses = getBrowserDialablePeerAddresses(addresses);
    if (peerAddresses.length === 0) {
        throw new Error(
            "Writer did not expose a browser-dialable direct peer address"
        );
    }
    const url = new URL(shareHref);
    url.searchParams.delete("bootstrap");
    url.searchParams.set("peer", peerAddresses.join(","));
    return {
        href: url.toString(),
        peerAddresses,
    };
};

export const resolveReaderCohort = (
    explicitCohort?: string,
    legacyRole?: string
): ReaderCohort => {
    if (explicitCohort) {
        if ((READER_COHORTS as readonly string[]).includes(explicitCohort)) {
            return explicitCohort as ReaderCohort;
        }
        throw new Error(`Unsupported PW_READER_COHORT='${explicitCohort}'`);
    }

    if (!legacyRole || legacyRole === "adaptive") {
        return "live-replicator";
    }
    if (legacyRole === "observer") {
        return "cold-observer";
    }
    throw new Error(`Unsupported PW_READER_ROLE='${legacyRole}'`);
};

export const getLegacyReaderRole = (cohort: ReaderCohort) =>
    cohort === "live-replicator" ? "adaptive" : "observer";

export type ReaderTopologyEvidence = {
    capturedAt: number | null;
    peersProvided: boolean | null;
    peerHintSource: string | null;
    peerAddressCount: number | null;
    appConnectionState: string | null;
    appDialStartedAt: number | null;
    appDialFinishedAt: number | null;
    connectionCount: number | null;
    peerHash: string | null;
    replicatorCount: number | null;
    selfInReplicatorSet: boolean | null;
};

export const classifyReaderTopology = (
    cohort: ReaderCohort,
    evidence: ReaderTopologyEvidence
) => {
    const validationReasons: string[] = [];
    if (evidence.appConnectionState !== "ready") {
        validationReasons.push("app-dial-not-ready");
    }
    if (evidence.peersProvided !== true) {
        validationReasons.push("app-peer-hints-not-provided");
    }
    if (evidence.peerHintSource !== "peer") {
        validationReasons.push("app-direct-peer-hints-not-provided");
    }
    if (evidence.peerAddressCount == null) {
        validationReasons.push("missing-app-peer-address-count");
    } else if (evidence.peerAddressCount < 1) {
        validationReasons.push("no-app-peer-addresses");
    }
    if (evidence.appDialStartedAt == null) {
        validationReasons.push("app-dial-not-started");
    }
    if (evidence.appDialFinishedAt == null) {
        validationReasons.push("app-dial-not-finished");
    } else if (
        evidence.appDialStartedAt != null &&
        evidence.appDialFinishedAt < evidence.appDialStartedAt
    ) {
        validationReasons.push("app-dial-timestamps-invalid");
    }
    if (evidence.connectionCount == null) {
        validationReasons.push("missing-libp2p-connection-count");
    } else if (evidence.connectionCount < 1) {
        validationReasons.push("no-libp2p-connections");
    }
    if (!evidence.peerHash) {
        validationReasons.push("missing-peer-hash");
    }
    if (evidence.selfInReplicatorSet == null) {
        validationReasons.push("missing-replicator-membership");
    } else if (cohort === "live-replicator" && !evidence.selfInReplicatorSet) {
        validationReasons.push("reader-not-in-replicator-set");
    } else if (cohort !== "live-replicator" && evidence.selfInReplicatorSet) {
        validationReasons.push("cold-reader-in-replicator-set");
    }

    return {
        cohort,
        expectedSelfInReplicatorSet: cohort === "live-replicator",
        ready: validationReasons.length === 0,
        evidence,
        validationReasons,
    };
};

export type ReaderCohortEvidence = {
    integrityVerified: boolean;
    programPersistChunkReads: boolean | null;
    persistChunkReads: boolean | null;
    /** Documents index rows; retained for result-schema compatibility. */
    initialLocalChunkCount: number | null;
    /** Exact manifest-entry blocks present in the local block store. */
    initialLocalChunkBlockCount: number | null;
    readAheadSource: string | null;
    /** Documents index rows; retained for result-schema compatibility. */
    postReadLocalChunkCount: number | null;
    /** Exact manifest-entry blocks present in the local block store. */
    postReadLocalChunkBlockCount: number | null;
    chunkCount: number | null;
};

export const resolveCompatibleIndexRowCount = (
    explicitIndexRowCount: number | null,
    legacyLocalChunkCount: number | null,
    label: string
) => {
    if (
        explicitIndexRowCount != null &&
        legacyLocalChunkCount != null &&
        explicitIndexRowCount !== legacyLocalChunkCount
    ) {
        throw new Error(
            `${label} index-row diagnostics disagree: explicit=${explicitIndexRowCount}, legacy=${legacyLocalChunkCount}`
        );
    }
    return explicitIndexRowCount ?? legacyLocalChunkCount;
};

const requireCompletePostReadChunkBlocks = (
    evidence: ReaderCohortEvidence,
    validationReasons: string[]
) => {
    const hasKnownPositiveChunkCount =
        evidence.chunkCount != null &&
        Number.isFinite(evidence.chunkCount) &&
        evidence.chunkCount > 0;
    if (!hasKnownPositiveChunkCount) {
        validationReasons.push(
            evidence.chunkCount == null
                ? "missing-chunk-count"
                : "invalid-chunk-count"
        );
    }
    if (evidence.postReadLocalChunkBlockCount == null) {
        validationReasons.push("missing-post-read-local-block-count");
    } else if (
        hasKnownPositiveChunkCount &&
        evidence.postReadLocalChunkBlockCount !== evidence.chunkCount
    ) {
        validationReasons.push(
            evidence.postReadLocalChunkBlockCount < evidence.chunkCount!
                ? "incomplete-post-read-local-chunk-blocks"
                : "unexpected-post-read-local-chunk-block-count"
        );
    }
};

const classifyLiveRead = ({
    initialLocalChunkCount,
    chunkCount,
}: ReaderCohortEvidence) => {
    if (initialLocalChunkCount == null) {
        return "indexed-unknown";
    }
    if (initialLocalChunkCount === 0) {
        return "indexed-cold";
    }
    if (
        chunkCount != null &&
        chunkCount > 0 &&
        initialLocalChunkCount >= chunkCount
    ) {
        return "indexed-local";
    }
    return "indexed-hybrid";
};

export const classifyReaderCohort = (
    cohort: ReaderCohort,
    evidence: ReaderCohortEvidence
) => {
    const validationReasons: string[] = [];
    if (!evidence.integrityVerified) {
        validationReasons.push("integrity-not-verified");
    }

    let classification:
        | "indexed-local"
        | "indexed-hybrid"
        | "indexed-cold"
        | "indexed-unknown"
        | "cold";
    let classificationBasis: string;
    if (cohort === "live-replicator") {
        classification = classifyLiveRead(evidence);
        classificationBasis = "initial-index-row-count";
        if (evidence.programPersistChunkReads !== true) {
            validationReasons.push("live-program-persistence-mismatch");
        }
        if (evidence.persistChunkReads !== true) {
            validationReasons.push("live-effective-persistence-mismatch");
        }
        if (
            evidence.readAheadSource !== "persisted-local" &&
            evidence.readAheadSource !== "persisted-remote-adaptive"
        ) {
            validationReasons.push("live-read-ahead-mismatch");
        }
        requireCompletePostReadChunkBlocks(evidence, validationReasons);
    } else if (cohort === "cold-observer") {
        classification = "cold";
        classificationBasis = "configured-cold-observer";
        if (evidence.persistChunkReads !== false) {
            validationReasons.push("observer-persistence-mismatch");
        }
        if (!evidence.readAheadSource?.startsWith("observer")) {
            validationReasons.push("observer-read-ahead-mismatch");
        }
        if (
            evidence.postReadLocalChunkBlockCount != null &&
            evidence.postReadLocalChunkBlockCount !== 0
        ) {
            validationReasons.push("observer-persisted-chunks");
        }
    } else {
        classification = "cold";
        classificationBasis = "configured-cold-persisted-read";
        if (evidence.programPersistChunkReads !== true) {
            validationReasons.push(
                "persisted-read-program-persistence-mismatch"
            );
        }
        if (evidence.persistChunkReads !== true) {
            validationReasons.push("persisted-read-persistence-mismatch");
        }
        if (evidence.initialLocalChunkCount !== 0) {
            validationReasons.push(
                evidence.initialLocalChunkCount == null
                    ? "missing-initial-local-count"
                    : "preloaded-local-chunks"
            );
        }
        if (evidence.initialLocalChunkBlockCount !== 0) {
            validationReasons.push(
                evidence.initialLocalChunkBlockCount == null
                    ? "missing-initial-local-block-count"
                    : "preloaded-local-chunk-blocks"
            );
        }
        if (evidence.readAheadSource !== "persisted-remote-adaptive") {
            validationReasons.push("persisted-read-ahead-mismatch");
        }
        requireCompletePostReadChunkBlocks(evidence, validationReasons);
    }

    const valid = validationReasons.length === 0;
    return {
        cohort,
        classification,
        // Live replication is observational: all index-row starting states are
        // eligible and must never be censored. Integrity and policy mismatches
        // still mark the sample invalid.
        eligible: cohort === "live-replicator" ? true : valid,
        valid,
        ...evidence,
        initialLocalChunkIndexRowCount: evidence.initialLocalChunkCount,
        postReadLocalChunkIndexRowCount: evidence.postReadLocalChunkCount,
        classificationBasis,
        validationReasons,
    };
};

type ReadDiagnostics = Record<string, unknown>;

const requireFiniteDiagnosticNumber = (value: unknown, label: string) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${label} must be a non-negative finite number`);
    }
    return value;
};

const requireDiagnosticRecord = (
    diagnostics: ReadDiagnostics,
    name: string
) => {
    const value = diagnostics[name];
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Missing ${name} read diagnostics`);
    }
    return value as Record<string, unknown>;
};

const nearestRank = (values: number[], percentile: number) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.ceil((percentile / 100) * sorted.length) - 1];
};

const sum = (values: number[]) =>
    values.reduce((total, value) => total + value, 0);

/**
 * Converts the per-chunk library diagnostics into stable benchmark evidence.
 * `streamReadExclusiveMs` removes time spent awaiting the configured output
 * sink from the library stream wall clock; it still includes manifest-ready
 * waiting, chunk demand, materialization, hashing, and scheduler bookkeeping.
 */
export const summarizeReadTransferDiagnostics = (
    diagnostics: ReadDiagnostics,
    expectedSizeBytes: number
) => {
    const sources = requireDiagnosticRecord(diagnostics, "chunkResolved");
    const indices = Object.keys(sources)
        .map((value) => Number(value))
        .sort((left, right) => left - right);
    if (
        indices.length === 0 ||
        indices.some(
            (value, position) =>
                !Number.isSafeInteger(value) || value !== position
        )
    ) {
        throw new Error(
            "chunkResolved read diagnostics must contain contiguous chunk indices"
        );
    }

    const readNumberSeries = (name: string) => {
        const record = requireDiagnosticRecord(diagnostics, name);
        return indices.map((index) =>
            requireFiniteDiagnosticNumber(record[index], `${name}[${index}]`)
        );
    };
    const readDurationSeries = (startedName: string, finishedName: string) => {
        const started = readNumberSeries(startedName);
        const finished = readNumberSeries(finishedName);
        return finished.map((value, index) => {
            if (value < started[index]) {
                throw new Error(
                    `${finishedName}[${index}] preceded ${startedName}[${index}]`
                );
            }
            return value - started[index];
        });
    };

    const chunkBytes = readNumberSeries("chunkByteLength");
    if (
        chunkBytes.some((value) => !Number.isSafeInteger(value) || value <= 0)
    ) {
        throw new Error(
            "chunkByteLength diagnostics must be positive integers"
        );
    }
    const totalBytes = sum(chunkBytes);
    if (totalBytes !== expectedSizeBytes) {
        throw new Error(
            `Read diagnostics covered ${totalBytes} bytes, expected ${expectedSizeBytes}`
        );
    }

    const demandWaitMs = readNumberSeries("chunkDemandWaitMs");
    const sinkWriteMs = readDurationSeries(
        "chunkWriteStartedAt",
        "chunkWriteFinishedAt"
    );
    const materializeMs = readDurationSeries(
        "chunkMaterializeStartedAt",
        "chunkMaterializeFinishedAt"
    );
    const hashMs = readDurationSeries(
        "chunkHashStartedAt",
        "chunkHashFinishedAt"
    );
    const libraryStreamStartedAt = requireFiniteDiagnosticNumber(
        diagnostics.startedAt,
        "read startedAt"
    );
    const libraryStreamFinishedAt = requireFiniteDiagnosticNumber(
        diagnostics.finishedAt,
        "read finishedAt"
    );
    if (libraryStreamFinishedAt < libraryStreamStartedAt) {
        throw new Error("read finishedAt preceded startedAt");
    }
    const libraryStreamWallMs =
        libraryStreamFinishedAt - libraryStreamStartedAt;
    const sinkWriteAwaitMs = sum(sinkWriteMs);
    const streamReadExclusiveMs = Math.max(
        0,
        libraryStreamWallMs - sinkWriteAwaitMs
    );
    const demandWaitSumMs = sum(demandWaitMs);
    const materializeSumMs = sum(materializeMs);
    const hashSumMs = sum(hashMs);

    const sourceSummary: Record<string, { chunkCount: number; bytes: number }> =
        {};
    for (const [position, index] of indices.entries()) {
        const source = sources[index];
        if (typeof source !== "string" || source.length === 0) {
            throw new Error(`chunkResolved[${index}] is missing its source`);
        }
        const current = (sourceSummary[source] ??= {
            chunkCount: 0,
            bytes: 0,
        });
        current.chunkCount += 1;
        current.bytes += chunkBytes[position];
    }

    return {
        chunkCount: indices.length,
        totalBytes,
        sources: Object.fromEntries(
            Object.entries(sourceSummary).sort(([left], [right]) =>
                left.localeCompare(right)
            )
        ),
        demandWait: {
            definition:
                "wall-clock time each sequential stream consumer awaited its scheduled chunk",
            sampleCount: demandWaitMs.length,
            sumMs: demandWaitSumMs,
            p50Ms: nearestRank(demandWaitMs, 50),
            p95Ms: nearestRank(demandWaitMs, 95),
            p99Ms: nearestRank(demandWaitMs, 99),
            maxMs: Math.max(...demandWaitMs),
            over1sCount: demandWaitMs.filter((value) => value > 1_000).length,
            over5sCount: demandWaitMs.filter((value) => value > 5_000).length,
            over10sCount: demandWaitMs.filter((value) => value > 10_000).length,
        },
        stages: {
            libraryStreamWallMs,
            sinkWriteAwaitMs,
            streamReadExclusiveMs,
            demandWaitMs: demandWaitSumMs,
            materializeMs: materializeSumMs,
            contentHashMs: hashSumMs,
            otherStreamReadMs: Math.max(
                0,
                streamReadExclusiveMs -
                    demandWaitSumMs -
                    materializeSumMs -
                    hashSumMs
            ),
        },
    };
};
