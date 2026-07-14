import { describe, expect, it } from "vitest";
import {
    buildReaderShareUrlWithPeerHints,
    classifyReaderCohort,
    classifyReaderTopology,
    getBrowserDialablePeerAddresses,
    resolveCompatibleIndexRowCount,
    resolveReaderCohort,
    stopSamplerAtCompletion,
    TINY_FILE_SIZE_LIMIT_BYTES,
    validateLargeFileBenchmarkSizeMb,
    validateJsHeapMeasurement,
    type ReaderCohortEvidence,
    type ReaderTopologyEvidence,
} from "./transfer-benchmark";

const validEvidence = (
    overrides: Partial<ReaderCohortEvidence> = {}
): ReaderCohortEvidence => ({
    integrityVerified: true,
    programPersistChunkReads: true,
    persistChunkReads: true,
    initialLocalChunkCount: 0,
    initialLocalChunkBlockCount: 0,
    readAheadSource: "persisted-remote-adaptive",
    postReadLocalChunkCount: 0,
    postReadLocalChunkBlockCount: 8,
    chunkCount: 8,
    ...overrides,
});

const readyTopology = (
    overrides: Partial<ReaderTopologyEvidence> = {}
): ReaderTopologyEvidence => ({
    capturedAt: 1_000,
    peersProvided: true,
    peerHintSource: "peer",
    peerAddressCount: 1,
    appConnectionState: "ready",
    appDialStartedAt: 900,
    appDialFinishedAt: 950,
    connectionCount: 1,
    peerHash: "reader-peer",
    replicatorCount: 2,
    selfInReplicatorSet: true,
    ...overrides,
});

describe("file-share transfer benchmark cohorts", () => {
    it("prefers explicit index-row diagnostics and rejects alias drift", () => {
        expect(resolveCompatibleIndexRowCount(7, 7, "post-read")).toBe(7);
        expect(resolveCompatibleIndexRowCount(null, 6, "post-read")).toBe(6);
        expect(resolveCompatibleIndexRowCount(5, null, "post-read")).toBe(5);
        expect(() => resolveCompatibleIndexRowCount(7, 6, "post-read")).toThrow(
            "post-read index-row diagnostics disagree: explicit=7, legacy=6"
        );
    });

    it("selects browser-dialable writer addresses without duplicates", () => {
        expect(
            getBrowserDialablePeerAddresses([
                " /ip4/127.0.0.1/tcp/9000/ws/p2p/writer ",
                "/ip4/127.0.0.1/tcp/9000/ws/p2p/writer",
                "/ip4/127.0.0.1/tcp/9001/p2p/server-only",
                123,
            ])
        ).toEqual(["/ip4/127.0.0.1/tcp/9000/ws/p2p/writer"]);
    });

    it("builds a direct reader URL while preserving the share hash", () => {
        const result = buildReaderShareUrlWithPeerHints(
            "http://127.0.0.1:9000/?bootstrap=relay#/s/share-address",
            ["/ip4/127.0.0.1/tcp/9001/ws/p2p/writer"]
        );
        const url = new URL(result.href);

        expect(url.hash).toBe("#/s/share-address");
        expect(url.searchParams.has("bootstrap")).toBe(false);
        expect(url.searchParams.get("peer")).toBe(
            "/ip4/127.0.0.1/tcp/9001/ws/p2p/writer"
        );
        expect(result.peerAddresses).toHaveLength(1);
    });

    it("rejects reader URLs without a browser-dialable writer address", () => {
        expect(() =>
            buildReaderShareUrlWithPeerHints(
                "http://127.0.0.1:9000/#/s/share-address",
                ["/ip4/127.0.0.1/tcp/9001/p2p/server-only"]
            )
        ).toThrow("browser-dialable direct peer address");
    });

    it("stops sampling as soon as the primary sink completes", async () => {
        let resolveSink: (result: {
            sinkCompletedAt: number;
        }) => void = () => {};
        const sinkCompletion = new Promise<{ sinkCompletedAt: number }>(
            (resolve) => {
                resolveSink = resolve;
            }
        );
        let writerWaitFinished = false;
        let stopCount = 0;
        const measuredCompletion = stopSamplerAtCompletion(sinkCompletion, {
            stop: async () => {
                stopCount += 1;
                return {
                    stoppedBeforeWriterWait: !writerWaitFinished,
                };
            },
        });

        resolveSink({ sinkCompletedAt: 123 });
        const measured = await measuredCompletion;

        expect(measured).toEqual({
            result: { sinkCompletedAt: 123 },
            measurement: { stoppedBeforeWriterWait: true },
        });
        expect(stopCount).toBe(1);
        writerWaitFinished = true;
    });

    it("accepts a finite JS heap measurement with at least one sample", () => {
        expect(
            validateJsHeapMeasurement({
                sampleCount: 1,
                startBytes: 10,
                endBytes: 12,
                peakBytes: 14,
            })
        ).toEqual({ valid: true, validationReasons: [] });
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
        "rejects an invalid JS heap sample count (%s)",
        (sampleCount) => {
            expect(
                validateJsHeapMeasurement({
                    sampleCount,
                    startBytes: 10,
                    endBytes: 12,
                    peakBytes: 14,
                }).validationReasons
            ).toContain("invalid-js-heap-sample-count");
        }
    );

    it("rejects missing or non-finite JS heap byte values", () => {
        expect(
            validateJsHeapMeasurement({
                sampleCount: 3,
                startBytes: null,
                endBytes: Number.POSITIVE_INFINITY,
                peakBytes: Number.NaN,
            })
        ).toEqual({
            valid: false,
            validationReasons: [
                "invalid-js-heap-start-bytes",
                "invalid-js-heap-end-bytes",
                "invalid-js-heap-peak-bytes",
            ],
        });
        expect(validateJsHeapMeasurement(undefined)).toEqual({
            valid: false,
            validationReasons: ["missing-js-heap-measurement"],
        });
    });

    it("rejects TinyFile-sized benchmark fixtures at the exact byte boundary", () => {
        const thresholdMiB = TINY_FILE_SIZE_LIMIT_BYTES / (1024 * 1024);
        expect(() => validateLargeFileBenchmarkSizeMb(1)).toThrow(
            "which uses TinyFile"
        );
        expect(() => validateLargeFileBenchmarkSizeMb(thresholdMiB)).toThrow(
            `${TINY_FILE_SIZE_LIMIT_BYTES}-byte cutoff`
        );
    });

    it("accepts the first byte above TinyFile and preserves 6 MiB benchmarks", () => {
        expect(
            validateLargeFileBenchmarkSizeMb(
                (TINY_FILE_SIZE_LIMIT_BYTES + 1) / (1024 * 1024)
            )
        ).toBe(TINY_FILE_SIZE_LIMIT_BYTES + 1);
        expect(validateLargeFileBenchmarkSizeMb(6)).toBe(6 * 1024 * 1024);
    });

    it("rejects benchmark sizes that cannot produce an integer byte length", () => {
        expect(() => validateLargeFileBenchmarkSizeMb(Number.NaN)).toThrow(
            "must resolve to a non-negative safe-integer byte size"
        );
        expect(() => validateLargeFileBenchmarkSizeMb(4.8)).toThrow(
            "must resolve to a non-negative safe-integer byte size"
        );
    });

    it("accepts explicit cohorts and maps legacy reader roles", () => {
        expect(resolveReaderCohort("cold-persisted-read", "observer")).toBe(
            "cold-persisted-read"
        );
        expect(resolveReaderCohort(undefined, "adaptive")).toBe(
            "live-replicator"
        );
        expect(resolveReaderCohort(undefined, "observer")).toBe(
            "cold-observer"
        );
        expect(() => resolveReaderCohort("unknown")).toThrow(
            "Unsupported PW_READER_COHORT"
        );
    });

    it("requires a connected live reader to appear in the replicator set", () => {
        expect(
            classifyReaderTopology("live-replicator", readyTopology())
        ).toMatchObject({
            ready: true,
            expectedSelfInReplicatorSet: true,
            validationReasons: [],
        });
        expect(
            classifyReaderTopology(
                "live-replicator",
                readyTopology({ selfInReplicatorSet: false })
            ).validationReasons
        ).toContain("reader-not-in-replicator-set");
    });

    it.each(["cold-observer", "cold-persisted-read"] as const)(
        "requires a connected %s reader to remain outside the replicator set",
        (cohort) => {
            expect(
                classifyReaderTopology(
                    cohort,
                    readyTopology({ selfInReplicatorSet: false })
                )
            ).toMatchObject({
                ready: true,
                expectedSelfInReplicatorSet: false,
                validationReasons: [],
            });
            expect(
                classifyReaderTopology(cohort, readyTopology())
                    .validationReasons
            ).toContain("cold-reader-in-replicator-set");
        }
    );

    it("does not accept role membership before app dialing and libp2p connectivity are ready", () => {
        expect(
            classifyReaderTopology(
                "live-replicator",
                readyTopology({
                    appConnectionState: "pending",
                    connectionCount: 0,
                })
            )
        ).toMatchObject({
            ready: false,
            validationReasons: ["app-dial-not-ready", "no-libp2p-connections"],
        });
    });

    it("requires supplied peer hints and completed explicit dial evidence", () => {
        expect(
            classifyReaderTopology(
                "live-replicator",
                readyTopology({
                    peersProvided: false,
                    peerHintSource: "bootstrap",
                    peerAddressCount: 0,
                    appDialStartedAt: null,
                    appDialFinishedAt: null,
                })
            )
        ).toMatchObject({
            ready: false,
            validationReasons: [
                "app-peer-hints-not-provided",
                "app-direct-peer-hints-not-provided",
                "no-app-peer-addresses",
                "app-dial-not-started",
                "app-dial-not-finished",
            ],
        });
        expect(
            classifyReaderTopology(
                "live-replicator",
                readyTopology({ appDialFinishedAt: null })
            ).validationReasons
        ).toContain("app-dial-not-finished");
    });

    it("never censors live replication and classifies its starting locality", () => {
        expect(
            classifyReaderCohort(
                "live-replicator",
                validEvidence({ initialLocalChunkCount: 8 })
            )
        ).toMatchObject({
            eligible: true,
            valid: true,
            classification: "indexed-local",
            classificationBasis: "initial-index-row-count",
            initialLocalChunkIndexRowCount: 8,
            postReadLocalChunkIndexRowCount: 0,
        });
        expect(
            classifyReaderCohort(
                "live-replicator",
                validEvidence({ initialLocalChunkCount: 3 })
            ).classification
        ).toBe("indexed-hybrid");
        expect(
            classifyReaderCohort(
                "live-replicator",
                validEvidence({ initialLocalChunkCount: 0 })
            ).classification
        ).toBe("indexed-cold");
        expect(
            classifyReaderCohort(
                "live-replicator",
                validEvidence({ integrityVerified: false })
            )
        ).toMatchObject({
            eligible: true,
            valid: false,
            validationReasons: ["integrity-not-verified"],
        });
        expect(
            classifyReaderCohort(
                "live-replicator",
                validEvidence({ programPersistChunkReads: false })
            ).validationReasons
        ).toContain("live-program-persistence-mismatch");
        expect(
            classifyReaderCohort(
                "live-replicator",
                validEvidence({ persistChunkReads: false })
            ).validationReasons
        ).toContain("live-effective-persistence-mismatch");
        expect(
            classifyReaderCohort(
                "live-replicator",
                validEvidence({ readAheadSource: "observer-adaptive" })
            ).validationReasons
        ).toContain("live-read-ahead-mismatch");
    });

    it("accepts partial live index rows when every exact chunk block is local", () => {
        expect(
            classifyReaderCohort(
                "live-replicator",
                validEvidence({
                    initialLocalChunkCount: 3,
                    postReadLocalChunkCount: 7,
                    postReadLocalChunkBlockCount: 8,
                })
            )
        ).toMatchObject({
            eligible: true,
            valid: true,
            classification: "indexed-hybrid",
            postReadLocalChunkIndexRowCount: 7,
            postReadLocalChunkBlockCount: 8,
            validationReasons: [],
        });
    });

    it.each([
        [null, "missing-post-read-local-block-count"],
        [7, "incomplete-post-read-local-chunk-blocks"],
        [9, "unexpected-post-read-local-chunk-block-count"],
    ] as const)(
        "rejects a live read with post-read exact-block count %s",
        (postReadLocalChunkBlockCount, validationReason) => {
            expect(
                classifyReaderCohort(
                    "live-replicator",
                    validEvidence({ postReadLocalChunkBlockCount })
                )
            ).toMatchObject({
                eligible: true,
                valid: false,
                validationReasons: [validationReason],
            });
        }
    );

    it("validates a non-persisting observer read", () => {
        expect(
            classifyReaderCohort(
                "cold-observer",
                validEvidence({
                    programPersistChunkReads: false,
                    persistChunkReads: false,
                    initialLocalChunkCount: null,
                    readAheadSource: "observer-adaptive",
                    postReadLocalChunkBlockCount: 0,
                })
            )
        ).toMatchObject({
            eligible: true,
            valid: true,
            classification: "cold",
        });

        expect(
            classifyReaderCohort(
                "cold-observer",
                validEvidence({
                    programPersistChunkReads: false,
                    persistChunkReads: false,
                    initialLocalChunkCount: null,
                    readAheadSource: "observer-adaptive",
                    postReadLocalChunkBlockCount: 1,
                })
            ).validationReasons
        ).toContain("observer-persisted-chunks");
    });

    it("requires a cold persisted remote adaptive read that stores every manifest block", () => {
        expect(
            classifyReaderCohort(
                "cold-persisted-read",
                validEvidence({
                    persistChunkReads: true,
                    readAheadSource: "persisted-remote-adaptive",
                    postReadLocalChunkBlockCount: 8,
                })
            )
        ).toMatchObject({
            eligible: true,
            valid: true,
            classification: "cold",
        });
        expect(
            classifyReaderCohort(
                "cold-persisted-read",
                validEvidence({
                    persistChunkReads: true,
                    initialLocalChunkCount: 1,
                    readAheadSource: "persisted-remote-adaptive",
                    postReadLocalChunkBlockCount: 8,
                })
            ).validationReasons
        ).toContain("preloaded-local-chunks");
        expect(
            classifyReaderCohort(
                "cold-persisted-read",
                validEvidence({ initialLocalChunkBlockCount: 1 })
            ).validationReasons
        ).toContain("preloaded-local-chunk-blocks");
    });

    it("rejects cold persisted reads when program persistence is disabled", () => {
        expect(
            classifyReaderCohort(
                "cold-persisted-read",
                validEvidence({
                    programPersistChunkReads: false,
                    postReadLocalChunkBlockCount: 8,
                })
            )
        ).toMatchObject({
            eligible: false,
            valid: false,
            validationReasons: ["persisted-read-program-persistence-mismatch"],
        });
    });

    it("rejects cold persisted reads when effective persistence is disabled", () => {
        expect(
            classifyReaderCohort(
                "cold-persisted-read",
                validEvidence({
                    persistChunkReads: false,
                    postReadLocalChunkBlockCount: 8,
                })
            )
        ).toMatchObject({
            eligible: false,
            valid: false,
            validationReasons: ["persisted-read-persistence-mismatch"],
        });
    });

    it.each([
        ["zero", 0],
        ["partial", 7],
    ] as const)(
        "rejects cold persisted reads with a %s post-read local block count",
        (_description, postReadLocalChunkBlockCount) => {
            expect(
                classifyReaderCohort(
                    "cold-persisted-read",
                    validEvidence({ postReadLocalChunkBlockCount })
                )
            ).toMatchObject({
                eligible: false,
                valid: false,
                validationReasons: ["incomplete-post-read-local-chunk-blocks"],
            });
        }
    );

    it.each([
        [null, 8, "missing-chunk-count"],
        [0, 0, "invalid-chunk-count"],
        [8, null, "missing-post-read-local-block-count"],
    ] as const)(
        "rejects cold persisted reads with chunk count %s and post-read block count %s",
        (chunkCount, postReadLocalChunkBlockCount, validationReason) => {
            expect(
                classifyReaderCohort(
                    "cold-persisted-read",
                    validEvidence({
                        chunkCount,
                        postReadLocalChunkBlockCount,
                    })
                )
            ).toMatchObject({
                eligible: false,
                valid: false,
                validationReasons: [validationReason],
            });
        }
    );
});
