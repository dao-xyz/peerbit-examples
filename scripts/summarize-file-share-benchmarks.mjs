import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
    { scenario, readerCohort, fileSizeMb }
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
        fixture.downloadSha256Base64,
        `${label} source/download SHA-256`,
        /^[A-Za-z0-9+/]{43}=$/
    );
    requireMatchingString(
        fixture.sourceCrc32Hex,
        fixture.downloadCrc32Hex,
        `${label} source/download CRC-32`,
        /^[0-9a-f]{8}$/
    );
    if (fixture.crc32Match !== true) {
        throw new Error(`${label} did not prove download CRC-32`);
    }
    if (expectedSizeBytes >= 250_000_000) {
        if (fixture.streamingReadbackCrc32Match !== true) {
            throw new Error(`${label} did not prove streaming CRC-32`);
        }
    }
    if (
        fixture?.integrityVerified !== true ||
        fixture.sourceManifestMatch !== true ||
        fixture.directDownloadHashMatch !== true ||
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
    if (result.hostRssValidation?.valid !== true) {
        throw new Error(`${label} did not prove a valid host RSS sample`);
    }

    return {
        uploadMbps: requireResultNumber(
            result.uploadMbps,
            `${label} upload Mbps`,
            {
                minimum: Number.MIN_VALUE,
            }
        ),
        downloadMbps: requireResultNumber(
            result.downloadMbps,
            `${label} download Mbps`,
            { minimum: Number.MIN_VALUE }
        ),
        uploadSeconds:
            requireResultNumber(
                result.uploadDurationMs,
                `${label} upload duration`,
                { minimum: Number.MIN_VALUE }
            ) / 1000,
        downloadSeconds:
            requireResultNumber(
                result.downloadDurationMs,
                `${label} download duration`,
                { minimum: Number.MIN_VALUE }
            ) / 1000,
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
        peakCombinedRssBytes: requireResultNumber(
            result.hostRss?.peakCombinedBytes,
            `${label} peak combined RSS`,
            { minimum: Number.MIN_VALUE }
        ),
    };
};

export const summarizeBenchmarkResults = (
    results,
    { expectedRuns, scenario, readerCohort, fileSizeMb }
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
            fileSizeMb: size,
        })
    );
    const values = (key) => evidence.map((sample) => sample[key]);
    const average = (samples) =>
        samples.reduce((sum, sample) => sum + sample, 0) / samples.length;

    return {
        scenario,
        readerCohort,
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
        medianPeakCombinedRssBytes: median(values("peakCombinedRssBytes")),
        p95PeakCombinedRssBytes: nearestRankPercentile(
            values("peakCombinedRssBytes"),
            95
        ),
        averageUploadMbps: average(values("uploadMbps")),
        averageDownloadMbps: average(values("downloadMbps")),
        rawResults: results,
    };
};

const toMiB = (bytes) => bytes / (1024 * 1024);

export const formatBenchmarkSummary = (summary) => {
    const lines = [
        "# File-share benchmark",
        "",
        `- Scenario: \`${summary.scenario}\``,
        `- Reader cohort: \`${summary.readerCohort}\``,
        `- File size: \`${summary.fileSizeMb} MiB\``,
        `- Runs: \`${summary.runs}\``,
        `- Upload: p50 \`${summary.medianUploadSeconds.toFixed(2)}s\` at \`${summary.medianUploadMbps.toFixed(2)} Mbps\`; p95 latency \`${summary.p95UploadSeconds.toFixed(2)}s\`, p5 throughput \`${summary.p05UploadMbps.toFixed(2)} Mbps\``,
        `- Discovery lag: p50 \`${summary.medianDiscoverySeconds.toFixed(2)}s\`; p95 \`${summary.p95DiscoverySeconds.toFixed(2)}s\``,
        `- Download: p50 \`${summary.medianDownloadSeconds.toFixed(2)}s\` at \`${summary.medianDownloadMbps.toFixed(2)} Mbps\`; p95 latency \`${summary.p95DownloadSeconds.toFixed(2)}s\`, p5 throughput \`${summary.p05DownloadMbps.toFixed(2)} Mbps\``,
        `- Reader peak JS heap: p50 \`${toMiB(summary.medianReaderPeakHeapBytes).toFixed(2)} MiB\`; p95 \`${toMiB(summary.p95ReaderPeakHeapBytes).toFixed(2)} MiB\``,
        `- Host peak combined RSS (Chromium + Playwright Node): p50 \`${toMiB(summary.medianPeakCombinedRssBytes).toFixed(2)} MiB\`; p95 \`${toMiB(summary.p95PeakCombinedRssBytes).toFixed(2)} MiB\``,
        "",
        "## Raw runs",
        "",
    ];

    summary.rawResults.forEach((result, index) => {
        lines.push(
            `- Run ${index + 1}: upload=${(Number(result.uploadDurationMs) / 1000).toFixed(2)}s (${Number(result.uploadMbps).toFixed(2)} Mbps), discovery=${(Number(result.discoveryLagMs) / 1000).toFixed(2)}s, download=${(Number(result.downloadDurationMs) / 1000).toFixed(2)}s (${Number(result.downloadMbps).toFixed(2)} Mbps), reader-peak-heap=${toMiB(Number(result.readerJsHeap.peakBytes)).toFixed(2)} MiB, peak-combined-rss=${toMiB(Number(result.hostRss.peakCombinedBytes)).toFixed(2)} MiB`
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
