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

const toMbps = (bytes, durationMs) => (bytes * 8) / (durationMs * 1000);

const validResult = (overrides = {}) => {
    const fileSizeMb = overrides.fileSizeMb ?? 256;
    const sizeBytes = overrides.sizeBytes ?? fileSizeMb * 1024 * 1024;
    const uploadDurationMs = overrides.uploadDurationMs ?? 1_000;
    const downloadDurationMs = overrides.downloadDurationMs ?? 2_000;
    const streamReadExclusiveMs = overrides.streamReadExclusiveMs ?? 1_800;
    const sinkWriteAwaitMs = overrides.sinkWriteAwaitMs ?? 200;
    const libraryStreamDurationMs = streamReadExclusiveMs + sinkWriteAwaitMs;
    return {
        status: "passed",
        scenario: "local",
        readerCohort: "live-replicator",
        requestedSink: "hash-only",
        sink: "hash-only",
        fileSizeMb,
        sizeBytes,
        fixture: {
            mode: "aes-256-ctr-v1",
            seed: "peerbit-file-share-v1",
            sourceSha256Base64: "A".repeat(43) + "=",
            manifestFinalHash: "A".repeat(43) + "=",
            libraryComputedSha256Base64: "A".repeat(43) + "=",
            downloadSha256Base64: null,
            sourceCrc32Hex: "1234abcd",
            downloadCrc32Hex: "1234abcd",
            crc32Match: true,
            sourceManifestMatch: true,
            libraryStreamSha256Match: true,
            directDownloadHashMatch: null,
            libraryDownloadFinalHashVerified: true,
            streamingReadbackCrc32Match: true,
            integrityVerified: true,
        },
        readerCohortValidation: { valid: true },
        readerTopologyReadiness: { ready: true },
        readerJsHeapValidation: { valid: true },
        readerJsHeap: { peakBytes: 32 * 1024 * 1024 },
        writerJsHeapValidation: { valid: true },
        writerJsHeap: { peakBytes: 48 * 1024 * 1024 },
        hostRssValidation: { valid: true },
        hostRss: { peakCombinedBytes: 256 * 1024 * 1024 },
        uploadMbps: toMbps(sizeBytes, uploadDurationMs),
        downloadMbps: toMbps(sizeBytes, downloadDurationMs),
        uploadDurationMs,
        downloadDurationMs,
        libraryStreamDurationMs,
        streamReadExclusiveMbps: toMbps(sizeBytes, streamReadExclusiveMs),
        streamReadExclusiveMs,
        sinkWriteAwaitMs,
        readTransfer: {
            chunkCount: 2,
            totalBytes: sizeBytes,
            sources: {
                cached: { chunkCount: 1, bytes: sizeBytes / 2 },
                local: { chunkCount: 1, bytes: sizeBytes / 2 },
            },
            demandWait: {
                sampleCount: 2,
                sumMs: 1_000,
                p50Ms: 100,
                p95Ms: 900,
                p99Ms: 900,
                maxMs: 900,
                over1sCount: 0,
                over5sCount: 0,
                over10sCount: 0,
            },
            stages: {
                libraryStreamWallMs: libraryStreamDurationMs,
                sinkWriteAwaitMs,
                streamReadExclusiveMs,
                demandWaitMs: 1_000,
            },
        },
        storageAttribution: {
            reader: {
                peerbitLogUsageDeltaBytes: sizeBytes,
                backingStorageUsageDeltaBytes: sizeBytes + 4 * 1024 * 1024,
            },
            writer: {
                peerbitLogUsageDeltaBytes: sizeBytes,
                backingStorageUsageDeltaBytes: null,
            },
        },
        discoveryLagMs: 250,
        ...overrides,
    };
};

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
            uploadDurationMs: 2_000,
            downloadDurationMs: 4_200,
            streamReadExclusiveMs: 4_000,
            discoveryLagMs: 1_000,
            readerJsHeap: { peakBytes: 64 * 1024 * 1024 },
            hostRss: { peakCombinedBytes: 384 * 1024 * 1024 },
        }),
        validResult({
            uploadDurationMs: 4_000,
            downloadDurationMs: 8_200,
            streamReadExclusiveMs: 8_000,
            discoveryLagMs: 2_000,
            readerJsHeap: { peakBytes: 96 * 1024 * 1024 },
            hostRss: { peakCombinedBytes: 512 * 1024 * 1024 },
        }),
        validResult({
            uploadDurationMs: 10_000,
            downloadDurationMs: 20_200,
            streamReadExclusiveMs: 20_000,
            discoveryLagMs: 3_000,
            readerJsHeap: { peakBytes: 128 * 1024 * 1024 },
            hostRss: { peakCombinedBytes: 640 * 1024 * 1024 },
        }),
    ];

    const summary = summarizeBenchmarkResults(results, {
        expectedRuns: 4,
        scenario: "local",
        readerCohort: "live-replicator",
        downloadSink: "hash-only",
        fileSizeMb: 256,
    });

    const sizeBytes = 256 * 1024 * 1024;
    assert.equal(
        summary.medianUploadMbps,
        (toMbps(sizeBytes, 2_000) + toMbps(sizeBytes, 4_000)) / 2
    );
    assert.equal(summary.p05UploadMbps, toMbps(sizeBytes, 10_000));
    assert.equal(summary.p95UploadSeconds, 10);
    assert.equal(
        summary.medianDownloadMbps,
        (toMbps(sizeBytes, 4_000) + toMbps(sizeBytes, 8_000)) / 2
    );
    assert.equal(summary.p05DownloadMbps, toMbps(sizeBytes, 20_000));
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
        downloadSink: "hash-only",
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
                            libraryComputedSha256Base64: "B".repeat(43) + "=",
                        },
                    }),
                ],
                options
            ),
        /source\/library-stream SHA-256 did not match/
    );
    assert.throws(
        () =>
            summarizeBenchmarkResults(
                [
                    validResult(),
                    validResult({
                        fixture: {
                            ...validResult().fixture,
                            downloadSha256Base64: "A".repeat(43) + "=",
                            directDownloadHashMatch: true,
                        },
                    }),
                ],
                options
            ),
        /claimed an unavailable sink SHA-256/
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
                        readTransfer: {
                            ...validResult().readTransfer,
                            totalBytes: 6 * 1024 * 1024,
                            sources: {
                                cached: {
                                    chunkCount: 2,
                                    bytes: 6 * 1024 * 1024,
                                },
                            },
                        },
                    }),
                    validResult({
                        fileSizeMb: 6,
                        sizeBytes: 6 * 1024 * 1024,
                        readTransfer: {
                            ...validResult().readTransfer,
                            totalBytes: 6 * 1024 * 1024,
                            sources: {
                                cached: {
                                    chunkCount: 2,
                                    bytes: 6 * 1024 * 1024,
                                },
                            },
                        },
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
    assert.throws(
        () =>
            summarizeBenchmarkResults(
                [
                    validResult(),
                    validResult({
                        readTransfer: {
                            ...validResult().readTransfer,
                            sources: {
                                cached: {
                                    chunkCount: 1,
                                    bytes: 256 * 1024 * 1024,
                                },
                            },
                        },
                    }),
                ],
                options
            ),
        /per-source byte coverage/
    );
    assert.throws(
        () =>
            summarizeBenchmarkResults(
                [
                    validResult(),
                    validResult({
                        readTransfer: {
                            ...validResult().readTransfer,
                            demandWait: {
                                ...validResult().readTransfer.demandWait,
                                sampleCount: 1,
                            },
                        },
                    }),
                ],
                options
            ),
        /per-chunk demand-wait coverage/
    );
    assert.throws(
        () =>
            summarizeBenchmarkResults(
                [validResult(), validResult({ streamReadExclusiveMbps: 1 })],
                options
            ),
        /sink-exclusive stream-read Mbps did not match exact bytes and duration/
    );
    assert.throws(
        () =>
            summarizeBenchmarkResults(
                [
                    validResult(),
                    validResult({
                        readTransfer: {
                            ...validResult().readTransfer,
                            stages: {
                                ...validResult().readTransfer.stages,
                                streamReadExclusiveMs: 1_799,
                            },
                        },
                    }),
                ],
                options
            ),
        /inconsistent read-stage durations/
    );
    assert.throws(
        () =>
            summarizeBenchmarkResults([validResult(), validResult()], {
                ...options,
                downloadSink: "browser-download",
            }),
        /Unsupported benchmark download sink/
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
                JSON.stringify(validResult())
            ),
        ]);
        const environment = {
            BENCH_RESULTS_DIR: directory,
            BENCH_RUNS: "2",
            BENCH_SCENARIO: "local",
            BENCH_READER_COHORT: "live-replicator",
            BENCH_DOWNLOAD_SINK: "hash-only",
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
            toMbps(256 * 1024 * 1024, 1_000)
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
