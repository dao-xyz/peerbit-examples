import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
    median,
    nearestRankPercentile,
    runBenchmarkSummary,
    summarizeBenchmarkResults,
} from "./summarize-file-share-benchmarks.mjs";

const validResult = (overrides = {}) => ({
    status: "passed",
    scenario: "local",
    readerCohort: "live-replicator",
    fileSizeMb: 256,
    sizeBytes: 256 * 1024 * 1024,
    fixture: {
        mode: "aes-256-ctr-v1",
        seed: "peerbit-file-share-v1",
        sourceSha256Base64: "A".repeat(43) + "=",
        manifestFinalHash: "A".repeat(43) + "=",
        downloadSha256Base64: "A".repeat(43) + "=",
        sourceCrc32Hex: "1234abcd",
        downloadCrc32Hex: "1234abcd",
        crc32Match: true,
        sourceManifestMatch: true,
        directDownloadHashMatch: true,
        libraryDownloadFinalHashVerified: true,
        streamingReadbackCrc32Match: true,
        integrityVerified: true,
    },
    readerCohortValidation: { valid: true },
    readerTopologyReadiness: { ready: true },
    readerJsHeapValidation: { valid: true },
    readerJsHeap: { peakBytes: 32 * 1024 * 1024 },
    hostRssValidation: { valid: true },
    hostRss: { peakCombinedBytes: 256 * 1024 * 1024 },
    uploadMbps: 100,
    downloadMbps: 80,
    uploadDurationMs: 1_000,
    downloadDurationMs: 2_000,
    discoveryLagMs: 250,
    ...overrides,
});

test("uses an exact median and nearest-rank tail percentiles", () => {
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(nearestRankPercentile([10, 20, 30, 40], 5), 10);
    assert.equal(nearestRankPercentile([10, 20, 30, 40], 95), 40);
    assert.throws(() => median([]), /at least one/);
    assert.throws(() => nearestRankPercentile([1], 0), /greater than 0/);
});

test("summarizes throughput, latency, JS heap, and host RSS tails", () => {
    const results = [
        validResult(),
        validResult({
            uploadMbps: 50,
            downloadMbps: 40,
            uploadDurationMs: 2_000,
            downloadDurationMs: 4_000,
            discoveryLagMs: 1_000,
            readerJsHeap: { peakBytes: 64 * 1024 * 1024 },
            hostRss: { peakCombinedBytes: 384 * 1024 * 1024 },
        }),
        validResult({
            uploadMbps: 25,
            downloadMbps: 20,
            uploadDurationMs: 4_000,
            downloadDurationMs: 8_000,
            discoveryLagMs: 2_000,
            readerJsHeap: { peakBytes: 96 * 1024 * 1024 },
            hostRss: { peakCombinedBytes: 512 * 1024 * 1024 },
        }),
        validResult({
            uploadMbps: 10,
            downloadMbps: 8,
            uploadDurationMs: 10_000,
            downloadDurationMs: 20_000,
            discoveryLagMs: 3_000,
            readerJsHeap: { peakBytes: 128 * 1024 * 1024 },
            hostRss: { peakCombinedBytes: 640 * 1024 * 1024 },
        }),
    ];

    const summary = summarizeBenchmarkResults(results, {
        expectedRuns: 4,
        scenario: "local",
        readerCohort: "live-replicator",
        fileSizeMb: 256,
    });

    assert.equal(summary.medianUploadMbps, 37.5);
    assert.equal(summary.p05UploadMbps, 10);
    assert.equal(summary.p95UploadSeconds, 10);
    assert.equal(summary.medianDownloadMbps, 30);
    assert.equal(summary.p05DownloadMbps, 8);
    assert.equal(summary.p95DownloadSeconds, 20);
    assert.equal(summary.p95DiscoverySeconds, 3);
    assert.equal(summary.p95ReaderPeakHeapBytes, 128 * 1024 * 1024);
    assert.equal(summary.medianPeakCombinedRssBytes, 448 * 1024 * 1024);
    assert.equal(summary.p95PeakCombinedRssBytes, 640 * 1024 * 1024);
});

test("fails closed on missing samples or unverifiable result evidence", () => {
    const options = {
        expectedRuns: 2,
        scenario: "local",
        readerCohort: "live-replicator",
        fileSizeMb: 256,
    };
    assert.throws(
        () => summarizeBenchmarkResults([validResult()], options),
        /Expected exactly 2/
    );
    assert.throws(
        () =>
            summarizeBenchmarkResults(
                [
                    validResult(),
                    validResult({
                        fixture: {
                            ...validResult().fixture,
                            integrityVerified: false,
                        },
                    }),
                ],
                options
            ),
        /end-to-end transfer integrity/
    );
    assert.throws(
        () =>
            summarizeBenchmarkResults(
                [
                    validResult(),
                    validResult({
                        fixture: {
                            ...validResult().fixture,
                            mode: "sparse-zero",
                        },
                    }),
                ],
                options
            ),
        /deterministic fixture bytes/
    );
    assert.throws(
        () =>
            summarizeBenchmarkResults(
                [
                    validResult(),
                    validResult({
                        fixture: {
                            ...validResult().fixture,
                            downloadCrc32Hex: "ffffffff",
                        },
                    }),
                ],
                options
            ),
        /source\/download CRC-32 did not match/
    );
    assert.throws(
        () =>
            summarizeBenchmarkResults(
                [
                    validResult({
                        fileSizeMb: 6,
                        sizeBytes: 6 * 1024 * 1024,
                    }),
                    validResult({
                        fileSizeMb: 6,
                        sizeBytes: 6 * 1024 * 1024,
                        fixture: {
                            ...validResult().fixture,
                            downloadCrc32Hex: "ffffffff",
                            crc32Match: false,
                            streamingReadbackCrc32Match: null,
                        },
                    }),
                ],
                {
                    ...options,
                    fileSizeMb: 6,
                }
            ),
        /source\/download CRC-32 did not match/
    );
    assert.throws(
        () =>
            summarizeBenchmarkResults(
                [validResult(), validResult({ uploadMbps: null })],
                options
            ),
        /upload Mbps must be a finite number/
    );
    assert.throws(
        () =>
            summarizeBenchmarkResults(
                [validResult(), validResult({ readerJsHeap: {} })],
                options
            ),
        /reader peak heap must be a finite number/
    );
    assert.throws(
        () =>
            summarizeBenchmarkResults(
                [
                    validResult(),
                    validResult({ hostRssValidation: { valid: false } }),
                ],
                options
            ),
        /valid host RSS sample/
    );
    assert.throws(
        () =>
            summarizeBenchmarkResults(
                [validResult(), validResult({ hostRss: {} })],
                options
            ),
        /peak combined RSS must be a finite number/
    );
});

test("requires the exact run file set and writes machine and human summaries", async () => {
    const directory = await mkdtemp(
        path.join(tmpdir(), "peerbit-file-share-summary-")
    );
    const stepSummary = path.join(directory, "step-summary.md");
    try {
        await Promise.all([
            writeFile(
                path.join(directory, "run-1.json"),
                JSON.stringify(validResult())
            ),
            writeFile(
                path.join(directory, "run-2.json"),
                JSON.stringify(validResult({ uploadMbps: 50 }))
            ),
        ]);
        const environment = {
            BENCH_RESULTS_DIR: directory,
            BENCH_RUNS: "2",
            BENCH_SCENARIO: "local",
            BENCH_READER_COHORT: "live-replicator",
            BENCH_FILE_MB: "256",
            BENCH_MIN_UPLOAD_MBPS: "0",
            BENCH_MIN_DOWNLOAD_MBPS: "0",
            GITHUB_STEP_SUMMARY: stepSummary,
        };

        const summary = runBenchmarkSummary({ environment });
        assert.equal(summary.runs, 2);
        assert.equal(
            JSON.parse(
                await readFile(path.join(directory, "summary.json"), "utf8")
            ).medianUploadMbps,
            75
        );
        const markdown = await readFile(stepSummary, "utf8");
        assert.match(markdown, /p95 latency/);
        assert.match(markdown, /Host peak combined RSS/);

        await writeFile(
            path.join(directory, "run-3.json"),
            JSON.stringify(validResult())
        );
        assert.throws(
            () => runBenchmarkSummary({ environment }),
            /must be exactly run-1.json, run-2.json/
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
