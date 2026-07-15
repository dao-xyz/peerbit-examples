import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SUPPORTED_DOWNLOAD_SINKS = new Set(["hash-only", "opfs", "node-file"]);

const requireFiniteNumber = (value, label, { minimum } = {}) => {
    const number = Number(value);
    if (!Number.isFinite(number) || (minimum != null && number < minimum)) {
        throw new Error(
            `${label} must be a finite number${minimum != null ? ` >= ${minimum}` : ""}`
        );
    }
    return number;
};

const requirePositiveInteger = (value, label) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return number;
};

const requireResultNumber = (value, label, { minimum } = {}) => {
    if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (minimum != null && value < minimum)
    ) {
        throw new Error(
            `${label} must be a finite number${minimum != null ? ` >= ${minimum}` : ""}`
        );
    }
    return value;
};

const requireResultNonNegativeSafeInteger = (value, label) => {
    if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0
    ) {
        throw new Error(`${label} must be a non-negative safe integer`);
    }
    return value;
};

const requireMatchingString = (left, right, label, pattern) => {
    if (
        typeof left !== "string" ||
        !pattern.test(left) ||
        typeof right !== "string" ||
        left !== right
    ) {
        throw new Error(`${label} did not match`);
    }
};

const resultNumberTolerance = (left, right) =>
    Math.max(1e-9, Math.max(Math.abs(left), Math.abs(right)) * 1e-12);

const resultNumbersMatch = (left, right, { minimum } = {}) =>
    typeof left === "number" &&
    Number.isFinite(left) &&
    typeof right === "number" &&
    Number.isFinite(right) &&
    (minimum == null || (left >= minimum && right >= minimum)) &&
    Math.abs(left - right) <= resultNumberTolerance(left, right);

const deriveDemandWaitSumBounds = ({ sampleCount, percentiles, tails }) => {
    const lowerBounds = [
        { startRank: 1, value: 0 },
        ...percentiles.map(({ rank, value }) => ({
            startRank: rank,
            value,
        })),
        ...tails
            .filter(({ count }) => count > 0)
            .map(({ threshold, count }) => ({
                startRank: sampleCount - count + 1,
                value: threshold + 1,
            })),
    ];
    const upperBounds = [
        ...percentiles.map(({ rank, value }) => ({
            endRank: rank,
            value,
        })),
        ...tails
            .filter(({ count }) => count < sampleCount)
            .map(({ threshold, count }) => ({
                endRank: sampleCount - count,
                value: threshold,
            })),
    ];
    const segmentStarts = new Set([1]);
    for (const { startRank } of lowerBounds) {
        segmentStarts.add(startRank);
    }
    for (const { endRank } of upperBounds) {
        if (endRank < sampleCount) {
            segmentStarts.add(endRank + 1);
        }
    }

    const sortedSegmentStarts = [...segmentStarts].sort(
        (left, right) => left - right
    );
    let minimum = 0;
    let maximum = 0;
    for (let index = 0; index < sortedSegmentStarts.length; index++) {
        const startRank = sortedSegmentStarts[index];
        const endRank =
            index + 1 < sortedSegmentStarts.length
                ? sortedSegmentStarts[index + 1] - 1
                : sampleCount;
        const length = endRank - startRank + 1;
        const lower = Math.max(
            ...lowerBounds
                .filter((bound) => bound.startRank <= startRank)
                .map((bound) => bound.value)
        );
        const upper = Math.min(
            ...upperBounds
                .filter((bound) => bound.endRank >= startRank)
                .map((bound) => bound.value)
        );
        if (lower > upper) {
            throw new Error(
                "demand-wait percentiles and tails described no feasible samples"
            );
        }
        minimum += length * lower;
        maximum += length * upper;
    }
    return { minimum, maximum };
};

const requireMatchingResultNumber = (value, expected, label) => {
    const number = requireResultNumber(value, label, {
        minimum: Number.MIN_VALUE,
    });
    if (!resultNumbersMatch(number, expected)) {
        throw new Error(`${label} did not match exact bytes and duration`);
    }
    return number;
};

const throughputMbps = (bytes, durationMs) => (bytes * 8) / (durationMs * 1000);

export const median = (values) => {
    if (values.length === 0) {
        throw new Error("median requires at least one value");
    }
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
};

export const nearestRankPercentile = (values, percentile) => {
    if (values.length === 0) {
        throw new Error("percentile requires at least one value");
    }
    if (!(percentile > 0 && percentile <= 100)) {
        throw new Error("percentile must be greater than 0 and at most 100");
    }
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.ceil((percentile / 100) * sorted.length) - 1];
};

const requireResultEvidence = (
    result,
    index,
    { scenario, readerCohort, downloadSink, fileSizeMb }
) => {
    const label = `run ${index + 1}`;
    if (result?.status !== "passed") {
        throw new Error(
            `${label} failed: ${result?.failure?.message || "unknown failure"}`
        );
    }
    if (result.scenario !== scenario) {
        throw new Error(
            `${label} used unexpected scenario '${result.scenario}'`
        );
    }
    if (result.readerCohort !== readerCohort) {
        throw new Error(
            `${label} used unexpected reader cohort '${result.readerCohort}'`
        );
    }
    if (Number(result.fileSizeMb) !== fileSizeMb) {
        throw new Error(
            `${label} used unexpected file size '${result.fileSizeMb}'`
        );
    }
    if (!SUPPORTED_DOWNLOAD_SINKS.has(downloadSink)) {
        throw new Error(
            `Unsupported benchmark download sink '${downloadSink}'`
        );
    }
    if (result.sink !== downloadSink || result.requestedSink !== downloadSink) {
        throw new Error(
            `${label} used unexpected download sink '${result.sink}'`
        );
    }
    const expectedSizeBytes = fileSizeMb * 1024 * 1024;
    if (
        !Number.isSafeInteger(expectedSizeBytes) ||
        result.sizeBytes !== expectedSizeBytes
    ) {
        throw new Error(`${label} did not prove the exact transferred size`);
    }
    const fixture = result.fixture;
    if (
        fixture?.mode !== "aes-256-ctr-v1" ||
        typeof fixture.seed !== "string" ||
        fixture.seed.length === 0
    ) {
        throw new Error(`${label} did not use deterministic fixture bytes`);
    }
    requireMatchingString(
        fixture.sourceSha256Base64,
        fixture.manifestFinalHash,
        `${label} source/manifest SHA-256`,
        /^[A-Za-z0-9+/]{43}=$/
    );
    requireMatchingString(
        fixture.sourceSha256Base64,
        fixture.libraryComputedSha256Base64,
        `${label} source/library-stream SHA-256`,
        /^[A-Za-z0-9+/]{43}=$/
    );
    if (downloadSink === "node-file") {
        requireMatchingString(
            fixture.sourceSha256Base64,
            fixture.downloadSha256Base64,
            `${label} source/node-file SHA-256`,
            /^[A-Za-z0-9+/]{43}=$/
        );
        if (fixture.directDownloadHashMatch !== true) {
            throw new Error(`${label} did not prove node-file SHA-256`);
        }
    } else if (
        fixture.downloadSha256Base64 != null ||
        fixture.directDownloadHashMatch != null
    ) {
        throw new Error(`${label} claimed an unavailable sink SHA-256`);
    }
    requireMatchingString(
        fixture.sourceCrc32Hex,
        fixture.downloadCrc32Hex,
        `${label} source/download CRC-32`,
        /^[0-9a-f]{8}$/
    );
    if (fixture.crc32Match !== true) {
        throw new Error(`${label} did not prove download CRC-32`);
    }
    if (fixture.streamingReadbackCrc32Match !== true) {
        throw new Error(`${label} did not prove browser-sink CRC-32`);
    }
    if (
        fixture?.integrityVerified !== true ||
        fixture.sourceManifestMatch !== true ||
        fixture.libraryStreamSha256Match !== true ||
        fixture.libraryDownloadFinalHashVerified !== true
    ) {
        throw new Error(`${label} did not prove end-to-end transfer integrity`);
    }
    if (result.readerCohortValidation?.valid !== true) {
        throw new Error(`${label} did not prove the requested reader cohort`);
    }
    if (result.readerTopologyReadiness?.ready !== true) {
        throw new Error(`${label} did not prove reader topology readiness`);
    }
    if (result.readerJsHeapValidation?.valid !== true) {
        throw new Error(`${label} did not prove a valid reader heap sample`);
    }
    if (result.writerJsHeapValidation?.valid !== true) {
        throw new Error(`${label} did not prove a valid writer heap sample`);
    }
    if (result.hostRssValidation?.valid !== true) {
        throw new Error(`${label} did not prove a valid host RSS sample`);
    }

    const readTransfer = result.readTransfer;
    if (
        readTransfer?.totalBytes !== expectedSizeBytes ||
        !Number.isSafeInteger(readTransfer?.chunkCount) ||
        readTransfer.chunkCount <= 0
    ) {
        throw new Error(`${label} did not prove exact read-source coverage`);
    }
    const sourceEntries = Object.entries(readTransfer.sources ?? {});
    let sourceChunkCount = 0;
    let sourceByteCount = 0;
    for (const [sourceName, source] of sourceEntries) {
        if (
            sourceName.length === 0 ||
            !Number.isSafeInteger(source?.chunkCount) ||
            source.chunkCount <= 0 ||
            !Number.isSafeInteger(source?.bytes) ||
            source.bytes <= 0
        ) {
            throw new Error(`${label} contained invalid per-source evidence`);
        }
        sourceChunkCount += source.chunkCount;
        sourceByteCount += source.bytes;
    }
    if (
        sourceEntries.length === 0 ||
        sourceChunkCount !== readTransfer.chunkCount ||
        sourceByteCount !== expectedSizeBytes
    ) {
        throw new Error(`${label} did not prove per-source byte coverage`);
    }
    const demandWaitSampleCount = requireResultNonNegativeSafeInteger(
        readTransfer.demandWait?.sampleCount,
        `${label} demand-wait sample count`
    );
    if (demandWaitSampleCount !== readTransfer.chunkCount) {
        throw new Error(
            `${label} did not prove per-chunk demand-wait coverage`
        );
    }
    const requireDemandWaitCount = (value, valueLabel) => {
        if (
            !Number.isSafeInteger(value) ||
            value < 0 ||
            value > demandWaitSampleCount
        ) {
            throw new Error(
                `${valueLabel} must be a safe integer between 0 and the demand-wait sample count`
            );
        }
        return value;
    };
    const demandWaitOver1sCount = requireDemandWaitCount(
        readTransfer.demandWait?.over1sCount,
        `${label} demand waits over 1s`
    );
    const demandWaitOver5sCount = requireDemandWaitCount(
        readTransfer.demandWait?.over5sCount,
        `${label} demand waits over 5s`
    );
    const demandWaitOver10sCount = requireDemandWaitCount(
        readTransfer.demandWait?.over10sCount,
        `${label} demand waits over 10s`
    );
    if (
        demandWaitOver10sCount > demandWaitOver5sCount ||
        demandWaitOver5sCount > demandWaitOver1sCount
    ) {
        throw new Error(`${label} contained inconsistent demand-wait tails`);
    }
    const uploadDurationMs = requireResultNumber(
        result.uploadDurationMs,
        `${label} upload duration`,
        { minimum: Number.MIN_VALUE }
    );
    const clickToSinkDurationMs = requireResultNumber(
        result.downloadDurationMs,
        `${label} click-to-sink duration`,
        { minimum: Number.MIN_VALUE }
    );
    const streamReadExclusiveMs = requireResultNumber(
        readTransfer.stages?.streamReadExclusiveMs,
        `${label} sink-exclusive stream-read duration`,
        { minimum: Number.MIN_VALUE }
    );
    const sinkWriteAwaitMs = requireResultNumber(
        readTransfer.stages?.sinkWriteAwaitMs,
        `${label} awaited sink-write duration`,
        { minimum: 0 }
    );
    const libraryStreamWallMs = requireResultNumber(
        readTransfer.stages?.libraryStreamWallMs,
        `${label} library stream-wall duration`,
        { minimum: Number.MIN_VALUE }
    );
    const demandWaitSumMs = requireResultNonNegativeSafeInteger(
        readTransfer.demandWait?.sumMs,
        `${label} demand-wait sum`
    );
    const demandWaitP50Ms = requireResultNonNegativeSafeInteger(
        readTransfer.demandWait?.p50Ms,
        `${label} demand-wait p50`
    );
    const demandWaitP95Ms = requireResultNonNegativeSafeInteger(
        readTransfer.demandWait?.p95Ms,
        `${label} demand-wait p95`
    );
    const demandWaitP99Ms = requireResultNonNegativeSafeInteger(
        readTransfer.demandWait?.p99Ms,
        `${label} demand-wait p99`
    );
    const demandWaitMaxMs = requireResultNonNegativeSafeInteger(
        readTransfer.demandWait?.maxMs,
        `${label} demand-wait max`
    );
    const stagedDemandWaitSumMs = requireResultNonNegativeSafeInteger(
        readTransfer.stages?.demandWaitMs,
        `${label} staged demand-wait sum`
    );
    const demandWaitPercentiles = [
        { percentile: 50, value: demandWaitP50Ms },
        { percentile: 95, value: demandWaitP95Ms },
        { percentile: 99, value: demandWaitP99Ms },
        { percentile: 100, value: demandWaitMaxMs },
    ].map(({ percentile, value }) => ({
        rank: Math.ceil((percentile / 100) * demandWaitSampleCount),
        value,
    }));
    for (let index = 1; index < demandWaitPercentiles.length; index++) {
        const previous = demandWaitPercentiles[index - 1];
        const current = demandWaitPercentiles[index];
        if (
            previous.value > current.value ||
            (previous.rank === current.rank && previous.value !== current.value)
        ) {
            throw new Error(
                `${label} contained inconsistent demand-wait percentiles`
            );
        }
    }
    const demandWaitTails = [
        { threshold: 1_000, count: demandWaitOver1sCount },
        { threshold: 5_000, count: demandWaitOver5sCount },
        { threshold: 10_000, count: demandWaitOver10sCount },
    ];
    for (const { threshold, count } of demandWaitTails) {
        for (const percentile of demandWaitPercentiles) {
            const minimumOverThreshold =
                percentile.value > threshold
                    ? demandWaitSampleCount - percentile.rank + 1
                    : 0;
            const maximumOverThreshold =
                percentile.value <= threshold
                    ? demandWaitSampleCount - percentile.rank
                    : demandWaitSampleCount;
            if (count < minimumOverThreshold || count > maximumOverThreshold) {
                throw new Error(
                    `${label} contained inconsistent demand-wait tails`
                );
            }
        }
    }
    let demandWaitSumBounds;
    try {
        demandWaitSumBounds = deriveDemandWaitSumBounds({
            sampleCount: demandWaitSampleCount,
            percentiles: demandWaitPercentiles,
            tails: demandWaitTails,
        });
    } catch {
        throw new Error(`${label} contained inconsistent demand-wait tails`);
    }
    const minimumDemandWaitSumMs = demandWaitSumBounds.minimum;
    const maximumDemandWaitSumMs = demandWaitSumBounds.maximum;
    if (
        !Number.isFinite(minimumDemandWaitSumMs) ||
        !Number.isFinite(maximumDemandWaitSumMs) ||
        minimumDemandWaitSumMs > demandWaitSumMs ||
        demandWaitSumMs > maximumDemandWaitSumMs
    ) {
        throw new Error(`${label} contained an inconsistent demand-wait sum`);
    }
    if (
        !resultNumbersMatch(
            result.streamReadExclusiveMs,
            streamReadExclusiveMs,
            { minimum: Number.MIN_VALUE }
        ) ||
        !resultNumbersMatch(result.sinkWriteAwaitMs, sinkWriteAwaitMs, {
            minimum: 0,
        }) ||
        !resultNumbersMatch(
            result.libraryStreamDurationMs,
            libraryStreamWallMs,
            { minimum: Number.MIN_VALUE }
        ) ||
        stagedDemandWaitSumMs !== demandWaitSumMs ||
        !resultNumbersMatch(
            streamReadExclusiveMs + sinkWriteAwaitMs,
            libraryStreamWallMs
        ) ||
        libraryStreamWallMs - clickToSinkDurationMs >
            resultNumberTolerance(libraryStreamWallMs, clickToSinkDurationMs)
    ) {
        throw new Error(`${label} contained inconsistent read-stage durations`);
    }
    const uploadMbps = throughputMbps(expectedSizeBytes, uploadDurationMs);
    const downloadMbps = throughputMbps(
        expectedSizeBytes,
        streamReadExclusiveMs
    );
    const clickToSinkMbps = throughputMbps(
        expectedSizeBytes,
        clickToSinkDurationMs
    );
    requireMatchingResultNumber(
        result.uploadMbps,
        uploadMbps,
        `${label} upload Mbps`
    );
    requireMatchingResultNumber(
        result.streamReadExclusiveMbps,
        downloadMbps,
        `${label} sink-exclusive stream-read Mbps`
    );
    requireMatchingResultNumber(
        result.downloadMbps,
        clickToSinkMbps,
        `${label} click-to-sink Mbps`
    );
    const optionalFiniteNumber = (value, valueLabel) =>
        value == null
            ? null
            : requireResultNumber(value, valueLabel, {
                  minimum: Number.NEGATIVE_INFINITY,
              });

    return {
        uploadMbps,
        downloadMbps,
        clickToSinkMbps,
        uploadSeconds: uploadDurationMs / 1000,
        downloadSeconds: streamReadExclusiveMs / 1000,
        clickToSinkSeconds: clickToSinkDurationMs / 1000,
        sinkWriteSeconds: sinkWriteAwaitMs / 1000,
        demandWaitSumSeconds: demandWaitSumMs / 1000,
        demandWaitP50Ms,
        demandWaitP95Ms,
        demandWaitP99Ms,
        demandWaitMaxMs,
        demandWaitOver1sCount,
        demandWaitOver5sCount,
        demandWaitOver10sCount,
        sources: readTransfer.sources,
        discoverySeconds:
            requireResultNumber(
                result.discoveryLagMs,
                `${label} discovery lag`,
                { minimum: 0 }
            ) / 1000,
        readerPeakHeapBytes: requireResultNumber(
            result.readerJsHeap?.peakBytes,
            `${label} reader peak heap`,
            { minimum: Number.MIN_VALUE }
        ),
        writerPeakHeapBytes: requireResultNumber(
            result.writerJsHeap?.peakBytes,
            `${label} writer peak heap`,
            { minimum: Number.MIN_VALUE }
        ),
        peakCombinedRssBytes: requireResultNumber(
            result.hostRss?.peakCombinedBytes,
            `${label} peak combined RSS`,
            { minimum: Number.MIN_VALUE }
        ),
        readerPeerbitLogDeltaBytes: optionalFiniteNumber(
            result.storageAttribution?.reader?.peerbitLogUsageDeltaBytes,
            `${label} reader Peerbit log storage delta`
        ),
        writerPeerbitLogDeltaBytes: optionalFiniteNumber(
            result.storageAttribution?.writer?.peerbitLogUsageDeltaBytes,
            `${label} writer Peerbit log storage delta`
        ),
        readerBackingStorageDeltaBytes: optionalFiniteNumber(
            result.storageAttribution?.reader?.backingStorageUsageDeltaBytes,
            `${label} reader backing-storage delta`
        ),
        writerBackingStorageDeltaBytes: optionalFiniteNumber(
            result.storageAttribution?.writer?.backingStorageUsageDeltaBytes,
            `${label} writer backing-storage delta`
        ),
    };
};

export const summarizeBenchmarkResults = (
    results,
    { expectedRuns, scenario, readerCohort, downloadSink, fileSizeMb }
) => {
    const runs = requirePositiveInteger(
        expectedRuns,
        "expected benchmark runs"
    );
    const size = requireFiniteNumber(fileSizeMb, "benchmark file size", {
        minimum: 0,
    });
    if (!Array.isArray(results) || results.length !== runs) {
        throw new Error(
            `Expected exactly ${runs} benchmark results, received ${results?.length ?? 0}`
        );
    }

    const evidence = results.map((result, index) =>
        requireResultEvidence(result, index, {
            scenario,
            readerCohort,
            downloadSink,
            fileSizeMb: size,
        })
    );
    const values = (key) => evidence.map((sample) => sample[key]);
    const average = (samples) =>
        samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
    const sum = (samples) =>
        samples.reduce((total, sample) => total + sample, 0);
    const optionalMedian = (samples) => {
        const available = samples.filter((sample) => sample != null);
        return {
            availableRuns: available.length,
            median: available.length > 0 ? median(available) : null,
        };
    };
    const aggregateSources = {};
    for (const sample of evidence) {
        for (const [source, sourceEvidence] of Object.entries(sample.sources)) {
            const aggregate = (aggregateSources[source] ??= {
                chunkCount: 0,
                bytes: 0,
            });
            aggregate.chunkCount += sourceEvidence.chunkCount;
            aggregate.bytes += sourceEvidence.bytes;
        }
    }

    return {
        scenario,
        readerCohort,
        downloadSink,
        fileSizeMb: size,
        runs,
        medianUploadMbps: median(values("uploadMbps")),
        p05UploadMbps: nearestRankPercentile(values("uploadMbps"), 5),
        medianDownloadMbps: median(values("downloadMbps")),
        p05DownloadMbps: nearestRankPercentile(values("downloadMbps"), 5),
        medianUploadSeconds: median(values("uploadSeconds")),
        p95UploadSeconds: nearestRankPercentile(values("uploadSeconds"), 95),
        medianDownloadSeconds: median(values("downloadSeconds")),
        p95DownloadSeconds: nearestRankPercentile(
            values("downloadSeconds"),
            95
        ),
        medianClickToSinkSeconds: median(values("clickToSinkSeconds")),
        medianClickToSinkMbps: median(values("clickToSinkMbps")),
        medianSinkWriteSeconds: median(values("sinkWriteSeconds")),
        medianDemandWaitSumSeconds: median(values("demandWaitSumSeconds")),
        medianDemandWaitP50Ms: median(values("demandWaitP50Ms")),
        medianDemandWaitP95Ms: median(values("demandWaitP95Ms")),
        medianDemandWaitP99Ms: median(values("demandWaitP99Ms")),
        medianDemandWaitMaxMs: median(values("demandWaitMaxMs")),
        totalDemandWaitOver1sCount: sum(values("demandWaitOver1sCount")),
        totalDemandWaitOver5sCount: sum(values("demandWaitOver5sCount")),
        totalDemandWaitOver10sCount: sum(values("demandWaitOver10sCount")),
        sources: Object.fromEntries(
            Object.entries(aggregateSources).sort(([left], [right]) =>
                left.localeCompare(right)
            )
        ),
        medianDiscoverySeconds: median(values("discoverySeconds")),
        p95DiscoverySeconds: nearestRankPercentile(
            values("discoverySeconds"),
            95
        ),
        medianReaderPeakHeapBytes: median(values("readerPeakHeapBytes")),
        p95ReaderPeakHeapBytes: nearestRankPercentile(
            values("readerPeakHeapBytes"),
            95
        ),
        medianWriterPeakHeapBytes: median(values("writerPeakHeapBytes")),
        p95WriterPeakHeapBytes: nearestRankPercentile(
            values("writerPeakHeapBytes"),
            95
        ),
        medianPeakCombinedRssBytes: median(values("peakCombinedRssBytes")),
        p95PeakCombinedRssBytes: nearestRankPercentile(
            values("peakCombinedRssBytes"),
            95
        ),
        averageUploadMbps: average(values("uploadMbps")),
        averageDownloadMbps: average(values("downloadMbps")),
        storageAttribution: {
            readerPeerbitLogDeltaBytes: optionalMedian(
                values("readerPeerbitLogDeltaBytes")
            ),
            writerPeerbitLogDeltaBytes: optionalMedian(
                values("writerPeerbitLogDeltaBytes")
            ),
            readerBackingStorageDeltaBytes: optionalMedian(
                values("readerBackingStorageDeltaBytes")
            ),
            writerBackingStorageDeltaBytes: optionalMedian(
                values("writerBackingStorageDeltaBytes")
            ),
        },
        rawResults: results,
    };
};

const toMiB = (bytes) => bytes / (1024 * 1024);

export const formatBenchmarkSummary = (summary) => {
    const formatStorage = (measurement) =>
        measurement.median == null
            ? `unavailable (0/${summary.runs} runs)`
            : `${toMiB(measurement.median).toFixed(2)} MiB (${measurement.availableRuns}/${summary.runs} runs)`;
    const lines = [
        "# File-share benchmark",
        "",
        `- Scenario: \`${summary.scenario}\``,
        `- Reader cohort: \`${summary.readerCohort}\``,
        `- Download sink: \`${summary.downloadSink}\``,
        `- File size: \`${summary.fileSizeMb} MiB\``,
        `- Runs: \`${summary.runs}\``,
        `- Upload: p50 \`${summary.medianUploadSeconds.toFixed(2)}s\` at \`${summary.medianUploadMbps.toFixed(2)} Mbps\`; p95 latency \`${summary.p95UploadSeconds.toFixed(2)}s\`, p5 throughput \`${summary.p05UploadMbps.toFixed(2)} Mbps\``,
        `- Discovery lag: p50 \`${summary.medianDiscoverySeconds.toFixed(2)}s\`; p95 \`${summary.p95DiscoverySeconds.toFixed(2)}s\``,
        `- Peerbit stream read (sink waits excluded): p50 \`${summary.medianDownloadSeconds.toFixed(2)}s\` at \`${summary.medianDownloadMbps.toFixed(2)} Mbps\`; p95 latency \`${summary.p95DownloadSeconds.toFixed(2)}s\`, p5 throughput \`${summary.p05DownloadMbps.toFixed(2)} Mbps\``,
        `- Click to sink complete: p50 \`${summary.medianClickToSinkSeconds.toFixed(2)}s\` at \`${summary.medianClickToSinkMbps.toFixed(2)} Mbps\`; awaited sink writes p50 \`${summary.medianSinkWriteSeconds.toFixed(2)}s\``,
        `- Chunk demand wait: p50 \`${summary.medianDemandWaitP50Ms.toFixed(0)}ms\`, p95 \`${summary.medianDemandWaitP95Ms.toFixed(0)}ms\`, p99 \`${summary.medianDemandWaitP99Ms.toFixed(0)}ms\`, max p50 \`${summary.medianDemandWaitMaxMs.toFixed(0)}ms\`; totals over 1s/5s/10s: \`${summary.totalDemandWaitOver1sCount}/${summary.totalDemandWaitOver5sCount}/${summary.totalDemandWaitOver10sCount}\``,
        `- Reader peak JS heap: p50 \`${toMiB(summary.medianReaderPeakHeapBytes).toFixed(2)} MiB\`; p95 \`${toMiB(summary.p95ReaderPeakHeapBytes).toFixed(2)} MiB\``,
        `- Writer peak JS heap: p50 \`${toMiB(summary.medianWriterPeakHeapBytes).toFixed(2)} MiB\`; p95 \`${toMiB(summary.p95WriterPeakHeapBytes).toFixed(2)} MiB\``,
        `- Host peak combined RSS (Chromium + Playwright Node): p50 \`${toMiB(summary.medianPeakCombinedRssBytes).toFixed(2)} MiB\`; p95 \`${toMiB(summary.p95PeakCombinedRssBytes).toFixed(2)} MiB\``,
        `- Per-source totals: ${Object.entries(summary.sources)
            .map(
                ([source, evidence]) =>
                    `\`${source}\`=${evidence.chunkCount} chunks/${toMiB(evidence.bytes).toFixed(2)} MiB`
            )
            .join(", ")}`,
        `- Storage deltas (p50 when available): reader Peerbit log ${formatStorage(summary.storageAttribution.readerPeerbitLogDeltaBytes)}, writer Peerbit log ${formatStorage(summary.storageAttribution.writerPeerbitLogDeltaBytes)}, reader origin backing storage ${formatStorage(summary.storageAttribution.readerBackingStorageDeltaBytes)}, writer origin backing storage ${formatStorage(summary.storageAttribution.writerBackingStorageDeltaBytes)}`,
        "",
        "## Raw runs",
        "",
    ];

    summary.rawResults.forEach((result, index) => {
        lines.push(
            `- Run ${index + 1}: upload=${(Number(result.uploadDurationMs) / 1000).toFixed(2)}s (${Number(result.uploadMbps).toFixed(2)} Mbps), discovery=${(Number(result.discoveryLagMs) / 1000).toFixed(2)}s, stream-read=${(Number(result.streamReadExclusiveMs) / 1000).toFixed(2)}s (${Number(result.streamReadExclusiveMbps).toFixed(2)} Mbps), sink-wait=${(Number(result.sinkWriteAwaitMs) / 1000).toFixed(2)}s, click-to-sink=${(Number(result.downloadDurationMs) / 1000).toFixed(2)}s, demand-p95=${Number(result.readTransfer.demandWait.p95Ms).toFixed(0)}ms, reader/writer-peak-heap=${toMiB(Number(result.readerJsHeap.peakBytes)).toFixed(2)}/${toMiB(Number(result.writerJsHeap.peakBytes)).toFixed(2)} MiB, peak-combined-rss=${toMiB(Number(result.hostRss.peakCombinedBytes)).toFixed(2)} MiB`
        );
    });
    return `${lines.join("\n")}\n`;
};

export const runBenchmarkSummary = ({ environment = process.env } = {}) => {
    const resultsDirectory = path.resolve(
        environment.BENCH_RESULTS_DIR || "bench-results"
    );
    const expectedRuns = requirePositiveInteger(
        environment.BENCH_RUNS,
        "BENCH_RUNS"
    );
    const expectedFiles = Array.from(
        { length: expectedRuns },
        (_, index) => `run-${index + 1}.json`
    );
    const observedFiles = readdirSync(resultsDirectory)
        .filter((name) => /^run-\d+\.json$/.test(name))
        .sort((left, right) =>
            left.localeCompare(right, undefined, { numeric: true })
        );
    if (JSON.stringify(observedFiles) !== JSON.stringify(expectedFiles)) {
        throw new Error(
            `Benchmark result files must be exactly ${expectedFiles.join(", ")}; received ${observedFiles.join(", ") || "none"}`
        );
    }

    const results = observedFiles.map((name) =>
        JSON.parse(readFileSync(path.join(resultsDirectory, name), "utf8"))
    );
    const summary = summarizeBenchmarkResults(results, {
        expectedRuns,
        scenario: environment.BENCH_SCENARIO,
        readerCohort: environment.BENCH_READER_COHORT,
        downloadSink: environment.BENCH_DOWNLOAD_SINK,
        fileSizeMb: environment.BENCH_FILE_MB,
    });
    writeFileSync(
        path.join(resultsDirectory, "summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`
    );
    const markdown = formatBenchmarkSummary(summary);
    if (environment.GITHUB_STEP_SUMMARY) {
        writeFileSync(environment.GITHUB_STEP_SUMMARY, markdown, { flag: "a" });
    } else {
        process.stdout.write(markdown);
    }

    const minimumUpload = requireFiniteNumber(
        environment.BENCH_MIN_UPLOAD_MBPS || 0,
        "minimum upload Mbps",
        { minimum: 0 }
    );
    const minimumDownload = requireFiniteNumber(
        environment.BENCH_MIN_DOWNLOAD_MBPS || 0,
        "minimum download Mbps",
        { minimum: 0 }
    );
    if (minimumUpload > 0 && summary.medianUploadMbps < minimumUpload) {
        throw new Error(
            `Median upload throughput ${summary.medianUploadMbps.toFixed(2)} Mbps is below threshold ${minimumUpload} Mbps`
        );
    }
    if (minimumDownload > 0 && summary.medianDownloadMbps < minimumDownload) {
        throw new Error(
            `Median download throughput ${summary.medianDownloadMbps.toFixed(2)} Mbps is below threshold ${minimumDownload} Mbps`
        );
    }
    return summary;
};

const isMain =
    process.argv[1] != null &&
    pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
    try {
        runBenchmarkSummary();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
