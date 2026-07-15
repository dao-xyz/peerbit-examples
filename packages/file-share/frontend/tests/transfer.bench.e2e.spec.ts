import {
    test,
    type Browser,
    type BrowserContext,
    type CDPSession,
    type Page,
} from "@playwright/test";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { startBootstrapPeer } from "./bootstrapPeer";
import {
    armDownloadedFile,
    armSavedViaPicker,
    crc32SavedViaPicker,
    createCrc32,
    createSyntheticFileOnDisk,
    installNodeBackedMockSaveFilePicker,
    rootUrl,
    sha256AndCrc32File,
    sha256FileBase64,
    type DownloadSinkResult,
    type SyntheticFixtureMetadata,
    type SyntheticFixtureMode,
    waitForFileListed,
    waitForUploadComplete,
    withBootstrap,
} from "./helpers";
import {
    buildReaderShareUrlWithPeerHints,
    classifyReaderCohort,
    classifyReaderTopology,
    getBrowserDialablePeerAddresses,
    getLegacyReaderRole,
    resolveCompatibleIndexRowCount,
    resolveReaderCohort,
    stopSamplerAtCompletion,
    validateHostRssMeasurement,
    validateJsHeapMeasurement,
    validateLargeFileBenchmarkSizeMb,
    type ReaderCohort,
    type ReaderTopologyEvidence,
} from "./transfer-benchmark";
import { createFileShareReplicationRole } from "../src/role-state";

const execFileAsync = promisify(execFile);

const ENABLED = process.env.PW_BENCH === "1";
const SCENARIO = process.env.PW_BENCH_SCENARIO || "local";
const READER_COHORT = resolveReaderCohort(
    process.env.PW_READER_COHORT,
    process.env.PW_READER_ROLE
);
const LEGACY_READER_ROLE = getLegacyReaderRole(READER_COHORT);
const ADAPTIVE_REPLICATION_ROLE = createFileShareReplicationRole({ cpuMax: 1 });
const FILE_SIZE_MB = Number(process.env.PW_FILE_MB || "1024");
const FILE_SIZE_BYTES = ENABLED
    ? validateLargeFileBenchmarkSizeMb(FILE_SIZE_MB)
    : FILE_SIZE_MB * 1024 * 1024;
const RESULT_FILE = process.env.PW_RESULT_FILE;
const parseFixtureMode = (value: string): SyntheticFixtureMode => {
    if (value === "sparse" || value === "deterministic") {
        return value;
    }
    throw new Error(`Unsupported PW_FIXTURE_MODE='${value}'`);
};
const FIXTURE_MODE = parseFixtureMode(
    process.env.PW_FIXTURE_MODE || "deterministic"
);
const FIXTURE_SEED = process.env.PW_FIXTURE_SEED || "peerbit-file-share-v1";
const UPLOAD_TIMEOUT_MS = Number(process.env.PW_UPLOAD_TIMEOUT_MS || "1800000");
const DOWNLOAD_TIMEOUT_MS = Number(
    process.env.PW_DOWNLOAD_TIMEOUT_MS || "1800000"
);
const TOPOLOGY_TIMEOUT_MS = Number(
    process.env.PW_TOPOLOGY_TIMEOUT_MS || "180000"
);
const TOPOLOGY_POLL_INTERVAL_MS = 250;
const requestedJsHeapSampleIntervalMs = Number(
    process.env.PW_JS_HEAP_SAMPLE_INTERVAL_MS || "500"
);
const JS_HEAP_SAMPLE_INTERVAL_MS =
    Number.isFinite(requestedJsHeapSampleIntervalMs) &&
    requestedJsHeapSampleIntervalMs >= 100
        ? requestedJsHeapSampleIntervalMs
        : 500;
const STREAMING_DOWNLOAD_THRESHOLD_BYTES = 250_000_000;

if (!["local", "prod"].includes(SCENARIO)) {
    throw new Error(`Unsupported PW_BENCH_SCENARIO='${SCENARIO}'`);
}

const persistResult = async (result: Record<string, unknown>) => {
    if (!RESULT_FILE) {
        return;
    }
    await mkdir(path.dirname(RESULT_FILE), { recursive: true });
    await writeFile(RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`);
};

const crc32FileHex = async (filePath: string) => {
    const crc32 = createCrc32();
    for await (const chunk of createReadStream(filePath)) {
        crc32.update(chunk);
    }
    return crc32.digestHex();
};

const logStage = (stage: string, details: Record<string, unknown> = {}) => {
    console.log(
        `FILE_SHARE_TRANSFER_BENCH_STAGE ${JSON.stringify({
            stage,
            scenario: SCENARIO,
            readerCohort: READER_COHORT,
            readerRole: LEGACY_READER_ROLE,
            fileSizeMb: FILE_SIZE_MB,
            ...details,
        })}`
    );
};

const waitForCreateSpaceHook = async (page: Page) => {
    await page.waitForFunction(
        () => Boolean((window as any).__peerbitFileShareCreateSpace),
        undefined,
        { timeout: 180_000 }
    );
};

const createSpaceFromHook = async (page: Page, name: string) => {
    return page.evaluate(async (spaceName) => {
        const createSpace = (window as any).__peerbitFileShareCreateSpace;
        if (!createSpace) {
            throw new Error("Missing __peerbitFileShareCreateSpace");
        }
        return createSpace(spaceName);
    }, name);
};

const getDiagnostics = async (page: Page) => {
    return page.evaluate(async () => {
        const hooks = (window as any).__peerbitFileShareTestHooks;
        if (!hooks?.getDiagnostics) {
            throw new Error(
                "Missing __peerbitFileShareTestHooks.getDiagnostics"
            );
        }
        return hooks.getDiagnostics();
    });
};

const getLightweightSnapshot = async (page: Page) => {
    return page.evaluate(() => {
        const hooks = (window as any).__peerbitFileShareTestHooks;
        if (!hooks?.getLightweightSnapshot) {
            throw new Error(
                "Missing __peerbitFileShareTestHooks.getLightweightSnapshot"
            );
        }
        return hooks.getLightweightSnapshot();
    });
};

const getTopologySnapshot = async (page: Page) => {
    return (await page.evaluate(async () => {
        const hooks = (window as any).__peerbitFileShareTestHooks;
        if (!hooks?.getTopologySnapshot) {
            throw new Error(
                "Missing __peerbitFileShareTestHooks.getTopologySnapshot"
            );
        }
        return hooks.getTopologySnapshot();
    })) as ReaderTopologyEvidence;
};

type ReaderTopologyReadiness = {
    cohort: ReaderCohort;
    expectedSelfInReplicatorSet: boolean;
    timeoutMs: number;
    pollingIntervalMs: number;
    waitStartedAt: number | null;
    waitFinishedAt: number | null;
    waitDurationMs: number | null;
    attempts: number;
    ready: boolean;
    evidence: ReaderTopologyEvidence | null;
    validationReasons: string[];
    lastProbeError: string | null;
};

const createReaderTopologyReadiness = (): ReaderTopologyReadiness => ({
    cohort: READER_COHORT,
    expectedSelfInReplicatorSet: READER_COHORT === "live-replicator",
    timeoutMs: TOPOLOGY_TIMEOUT_MS,
    pollingIntervalMs: TOPOLOGY_POLL_INTERVAL_MS,
    waitStartedAt: null,
    waitFinishedAt: null,
    waitDurationMs: null,
    attempts: 0,
    ready: false,
    evidence: null,
    validationReasons: ["topology-not-checked"],
    lastProbeError: null,
});

const waitForReaderTopology = async (
    page: Page,
    readiness: ReaderTopologyReadiness
) => {
    const startedAt = Date.now();
    const deadline = startedAt + readiness.timeoutMs;
    readiness.waitStartedAt = startedAt;
    readiness.validationReasons = [];

    while (Date.now() <= deadline) {
        readiness.attempts += 1;
        try {
            const evidence = await getTopologySnapshot(page);
            const classification = classifyReaderTopology(
                readiness.cohort,
                evidence
            );
            readiness.evidence = evidence;
            readiness.ready = classification.ready;
            readiness.validationReasons = classification.validationReasons;
            readiness.lastProbeError = null;
            if (classification.ready) {
                readiness.waitFinishedAt = Date.now();
                readiness.waitDurationMs = readiness.waitFinishedAt - startedAt;
                return;
            }
        } catch (error) {
            readiness.ready = false;
            readiness.validationReasons = ["topology-probe-error"];
            readiness.lastProbeError =
                error instanceof Error ? error.message : String(error);
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
            break;
        }
        await new Promise((resolve) =>
            setTimeout(
                resolve,
                Math.min(readiness.pollingIntervalMs, remainingMs)
            )
        );
    }

    readiness.waitFinishedAt = Date.now();
    readiness.waitDurationMs = readiness.waitFinishedAt - startedAt;
    throw new Error(
        `Reader topology was not ready for ${readiness.cohort}: ${readiness.validationReasons.join(", ") || "unknown"}`
    );
};

type ReaderJsHeapMeasurement = {
    memoryKind: "javascript-heap";
    scope: "reader-renderer";
    metric: "JSHeapUsedSize";
    unit: "bytes";
    sampleIntervalMs: number;
    startedAt: number;
    finishedAt: number | null;
    firstSampleAt: number | null;
    lastSampleAt: number | null;
    sampleCount: number;
    startBytes: number | null;
    endBytes: number | null;
    peakBytes: number | null;
    samplingErrors: string[];
};

type ReaderJsHeapSampler = {
    stop: () => Promise<ReaderJsHeapMeasurement>;
    snapshot: () => ReaderJsHeapMeasurement;
};

const getErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

const startReaderJsHeapSampler = async (
    context: BrowserContext,
    page: Page
): Promise<ReaderJsHeapSampler> => {
    const measurement: ReaderJsHeapMeasurement = {
        memoryKind: "javascript-heap",
        scope: "reader-renderer",
        metric: "JSHeapUsedSize",
        unit: "bytes",
        sampleIntervalMs: JS_HEAP_SAMPLE_INTERVAL_MS,
        startedAt: Date.now(),
        finishedAt: null,
        firstSampleAt: null,
        lastSampleAt: null,
        sampleCount: 0,
        startBytes: null,
        endBytes: null,
        peakBytes: null,
        samplingErrors: [],
    };
    const snapshot = (): ReaderJsHeapMeasurement => ({
        ...measurement,
        samplingErrors: [...measurement.samplingErrors],
    });

    let session: CDPSession | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeSample: Promise<void> | undefined;
    let stopped = false;
    let stopPromise: Promise<ReaderJsHeapMeasurement> | undefined;

    const takeSample = async () => {
        if (!session) {
            return;
        }
        try {
            const response = await session.send("Performance.getMetrics");
            const heapMetric = response.metrics.find(
                (metric) => metric.name === "JSHeapUsedSize"
            );
            if (!heapMetric || !Number.isFinite(heapMetric.value)) {
                measurement.samplingErrors.push(
                    "Performance.getMetrics omitted JSHeapUsedSize"
                );
                return;
            }
            const capturedAt = Date.now();
            if (measurement.sampleCount === 0) {
                measurement.firstSampleAt = capturedAt;
                measurement.startBytes = heapMetric.value;
            }
            measurement.lastSampleAt = capturedAt;
            measurement.endBytes = heapMetric.value;
            measurement.peakBytes = Math.max(
                measurement.peakBytes ?? heapMetric.value,
                heapMetric.value
            );
            measurement.sampleCount += 1;
        } catch (error) {
            measurement.samplingErrors.push(getErrorMessage(error));
        }
    };

    const scheduleSample = () => {
        if (stopped || !session) {
            return;
        }
        timer = setTimeout(() => {
            activeSample = takeSample().finally(() => {
                activeSample = undefined;
                scheduleSample();
            });
        }, JS_HEAP_SAMPLE_INTERVAL_MS);
    };

    try {
        session = await context.newCDPSession(page);
        await session.send("Performance.enable");
        await takeSample();
        scheduleSample();
    } catch (error) {
        measurement.samplingErrors.push(getErrorMessage(error));
    }

    return {
        snapshot,
        stop: () => {
            if (stopPromise) {
                return stopPromise;
            }
            stopped = true;
            stopPromise = (async () => {
                if (timer) {
                    clearTimeout(timer);
                }
                await activeSample;
                await takeSample();
                measurement.finishedAt = Date.now();
                if (session) {
                    await session.send("Performance.disable").catch((error) => {
                        measurement.samplingErrors.push(getErrorMessage(error));
                    });
                    await session.detach().catch((error) => {
                        measurement.samplingErrors.push(getErrorMessage(error));
                    });
                    session = undefined;
                }
                return snapshot();
            })();
            return stopPromise;
        },
    };
};

type HostRssMeasurement = {
    memoryKind: "resident-set-size";
    scope: "chromium-processes-and-playwright-node";
    metric: "RSS";
    unit: "bytes";
    sampleIntervalMs: number;
    startedAt: number;
    finishedAt: number | null;
    firstSampleAt: number | null;
    lastSampleAt: number | null;
    sampleCount: number;
    startBrowserBytes: number | null;
    endBrowserBytes: number | null;
    peakBrowserBytes: number | null;
    startNodeBytes: number | null;
    endNodeBytes: number | null;
    peakNodeBytes: number | null;
    peakCombinedBytes: number | null;
    startBrowserProcessCount: number | null;
    endBrowserProcessCount: number | null;
    peakBrowserProcessCount: number | null;
    samplingErrors: string[];
};

type HostRssSampler = {
    stop: () => Promise<HostRssMeasurement>;
    snapshot: () => HostRssMeasurement;
};

const readProcessRssBytes = async (processIds: number[]) => {
    if (processIds.length === 0) {
        throw new Error(
            "Chromium did not expose any operating-system process IDs"
        );
    }
    const { stdout } = await execFileAsync(
        "ps",
        ["-o", "rss=", "-p", processIds.join(",")],
        { maxBuffer: 1024 * 1024 }
    );
    const rssKiB = String(stdout)
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((value) => Number(value));
    if (
        rssKiB.length === 0 ||
        rssKiB.some((value) => !Number.isFinite(value) || value < 0)
    ) {
        throw new Error("ps did not return valid Chromium RSS values");
    }
    return rssKiB.reduce((sum, value) => sum + value, 0) * 1024;
};

const startHostRssSampler = async (
    browser: Browser
): Promise<HostRssSampler> => {
    const measurement: HostRssMeasurement = {
        memoryKind: "resident-set-size",
        scope: "chromium-processes-and-playwright-node",
        metric: "RSS",
        unit: "bytes",
        sampleIntervalMs: JS_HEAP_SAMPLE_INTERVAL_MS,
        startedAt: Date.now(),
        finishedAt: null,
        firstSampleAt: null,
        lastSampleAt: null,
        sampleCount: 0,
        startBrowserBytes: null,
        endBrowserBytes: null,
        peakBrowserBytes: null,
        startNodeBytes: null,
        endNodeBytes: null,
        peakNodeBytes: null,
        peakCombinedBytes: null,
        startBrowserProcessCount: null,
        endBrowserProcessCount: null,
        peakBrowserProcessCount: null,
        samplingErrors: [],
    };
    const snapshot = (): HostRssMeasurement => ({
        ...measurement,
        samplingErrors: [...measurement.samplingErrors],
    });

    let session: CDPSession | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeSample: Promise<void> | undefined;
    let stopped = false;
    let stopPromise: Promise<HostRssMeasurement> | undefined;

    const takeSample = async () => {
        if (!session) {
            return;
        }
        try {
            const { processInfo } = await session.send(
                "SystemInfo.getProcessInfo"
            );
            const processIds = [
                ...new Set(
                    processInfo
                        .map((process) => Number(process.id))
                        .filter(
                            (processId) =>
                                Number.isSafeInteger(processId) && processId > 0
                        )
                ),
            ];
            const [browserBytes, nodeBytes] = await Promise.all([
                readProcessRssBytes(processIds),
                Promise.resolve(process.memoryUsage().rss),
            ]);
            const capturedAt = Date.now();
            const combinedBytes = browserBytes + nodeBytes;
            if (measurement.sampleCount === 0) {
                measurement.firstSampleAt = capturedAt;
                measurement.startBrowserBytes = browserBytes;
                measurement.startNodeBytes = nodeBytes;
                measurement.startBrowserProcessCount = processIds.length;
            }
            measurement.lastSampleAt = capturedAt;
            measurement.endBrowserBytes = browserBytes;
            measurement.endNodeBytes = nodeBytes;
            measurement.endBrowserProcessCount = processIds.length;
            measurement.peakBrowserBytes = Math.max(
                measurement.peakBrowserBytes ?? browserBytes,
                browserBytes
            );
            measurement.peakNodeBytes = Math.max(
                measurement.peakNodeBytes ?? nodeBytes,
                nodeBytes
            );
            measurement.peakCombinedBytes = Math.max(
                measurement.peakCombinedBytes ?? combinedBytes,
                combinedBytes
            );
            measurement.peakBrowserProcessCount = Math.max(
                measurement.peakBrowserProcessCount ?? processIds.length,
                processIds.length
            );
            measurement.sampleCount += 1;
        } catch (error) {
            measurement.samplingErrors.push(getErrorMessage(error));
        }
    };

    const scheduleSample = () => {
        if (stopped || !session) {
            return;
        }
        timer = setTimeout(() => {
            activeSample = takeSample().finally(() => {
                activeSample = undefined;
                scheduleSample();
            });
        }, JS_HEAP_SAMPLE_INTERVAL_MS);
    };

    try {
        session = await browser.newBrowserCDPSession();
        await takeSample();
        scheduleSample();
    } catch (error) {
        measurement.samplingErrors.push(getErrorMessage(error));
    }

    return {
        snapshot,
        stop: () => {
            if (stopPromise) {
                return stopPromise;
            }
            stopped = true;
            stopPromise = (async () => {
                if (timer) {
                    clearTimeout(timer);
                }
                await activeSample;
                await takeSample();
                measurement.finishedAt = Date.now();
                if (session) {
                    await session.detach().catch((error) => {
                        measurement.samplingErrors.push(getErrorMessage(error));
                    });
                    session = undefined;
                }
                return snapshot();
            })();
            return stopPromise;
        },
    };
};

const seedReplicationRole = async (
    page: Page,
    address: string,
    role: unknown
) => {
    await page.addInitScript(
        ({ shareAddress, roleOptions }) => {
            window.localStorage.setItem(
                `${shareAddress}-role`,
                JSON.stringify(roleOptions)
            );
        },
        { shareAddress: address, roleOptions: role }
    );
};

const enableOpenProfiler = async (page: Page) => {
    await page.addInitScript(() => {
        Object.defineProperty(window, "__peerbitFileShareEnableOpenProfiler", {
            value: true,
            configurable: true,
            enumerable: false,
            writable: true,
        });
    });
};

const waitForShareUrlPeerHints = async (page: Page, timeout = 180_000) => {
    await page.waitForFunction(
        () => new URL(window.location.href).searchParams.has("peer"),
        undefined,
        { timeout }
    );
};

type ReaderPeerHintEvidence = {
    source: "writer-direct-diagnostics" | "writer-share-url";
    count: number;
    waitStartedAt: number;
    waitFinishedAt: number;
    waitDurationMs: number;
    attempts: number;
    lastProbeError: string | null;
};

const waitForWriterDirectPeerHints = async (page: Page, timeout = 180_000) => {
    const waitStartedAt = Date.now();
    const deadline = waitStartedAt + timeout;
    let attempts = 0;
    let lastProbeError: string | null = null;
    while (Date.now() <= deadline) {
        attempts += 1;
        try {
            const diagnostics = await getDiagnostics(page);
            const peerAddresses = getBrowserDialablePeerAddresses(
                (diagnostics as Record<string, unknown>)?.peerAddresses
            );
            if (peerAddresses.length > 0) {
                const waitFinishedAt = Date.now();
                return {
                    peerAddresses,
                    evidence: {
                        source: "writer-direct-diagnostics",
                        count: peerAddresses.length,
                        waitStartedAt,
                        waitFinishedAt,
                        waitDurationMs: waitFinishedAt - waitStartedAt,
                        attempts,
                        lastProbeError,
                    } satisfies ReaderPeerHintEvidence,
                };
            }
            lastProbeError = "No browser-dialable writer addresses yet";
        } catch (error) {
            lastProbeError = getErrorMessage(error);
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
            break;
        }
        await new Promise((resolve) =>
            setTimeout(resolve, Math.min(250, remainingMs))
        );
    }
    throw new Error(
        `Writer did not expose a browser-dialable direct peer address: ${lastProbeError ?? "unknown"}`
    );
};

const waitForReaderProgramState = async (
    page: Page,
    expectedProgramAddress: string,
    expectedPersistChunkReads: boolean,
    timeout: number
) => {
    const handle = await page.waitForFunction(
        ({ expectedAddress, expectedPersist }) => {
            const hooks = (window as any).__peerbitFileShareTestHooks;
            if (!hooks?.getLightweightSnapshot) {
                return null;
            }
            const snapshot = hooks.getLightweightSnapshot();
            if (snapshot?.programHookStatus === "error") {
                return {
                    state: "error",
                    message:
                        typeof snapshot.programHookError === "string"
                            ? snapshot.programHookError
                            : "unknown program-open error",
                };
            }
            return snapshot?.programAddress === expectedAddress &&
                snapshot?.programClosed === false &&
                snapshot?.persistChunkReads === expectedPersist
                ? { state: "ready" }
                : null;
        },
        {
            expectedAddress: expectedProgramAddress,
            expectedPersist: expectedPersistChunkReads,
        },
        { polling: 25, timeout }
    );
    const result = (await handle.jsonValue()) as {
        state: "ready" | "error";
        message?: string;
    };
    await handle.dispose();
    if (result.state === "error") {
        throw new Error(`Reader program failed to open: ${result.message}`);
    }
};

type ReadyDownloadClick = {
    capturedAt: number;
    clickedAt: number;
    manifestFinalHash: string;
    persistChunkReadsBeforeClick: boolean | null;
    persistChunkReadsAtClick: boolean | null;
    snapshot: Record<string, unknown>;
};

const armReadyManifestDownload = (
    page: Page,
    properties: {
        fileName: string;
        expectedProgramAddress: string;
        expectedFinalHash: string;
        enablePersistOnly: boolean;
        timeout: number;
    }
) => {
    const pending = page
        .waitForFunction(
            ({
                expectedName,
                expectedAddress,
                expectedHash,
                enablePersistOnly,
            }) => {
                const hooks = (window as any).__peerbitFileShareTestHooks;
                if (!hooks?.getLightweightSnapshot) {
                    return null;
                }
                const snapshot = hooks.getLightweightSnapshot();
                if (
                    snapshot?.programAddress !== expectedAddress ||
                    snapshot?.programClosed !== false
                ) {
                    return null;
                }
                const file = snapshot?.listedFiles?.find(
                    (candidate: Record<string, unknown>) =>
                        candidate.name === expectedName
                );
                if (
                    !file ||
                    file.ready !== true ||
                    typeof file.finalHash !== "string" ||
                    file.finalHash.length === 0
                ) {
                    return null;
                }
                if (file.finalHash !== expectedHash) {
                    throw new Error(
                        `Visible manifest hash ${file.finalHash} does not match fixture hash ${expectedHash}`
                    );
                }

                const row = Array.from(document.querySelectorAll("li")).find(
                    (candidate) =>
                        Array.from(candidate.querySelectorAll("span")).some(
                            (label) => label.textContent === expectedName
                        )
                );
                const button = row?.querySelector(
                    '[data-testid="download-file"]'
                );
                if (
                    !(button instanceof HTMLButtonElement) ||
                    button.disabled ||
                    button.textContent?.includes("pending")
                ) {
                    return null;
                }

                const capturedAt = Date.now();
                const persistChunkReadsBeforeClick =
                    typeof snapshot.persistChunkReads === "boolean"
                        ? snapshot.persistChunkReads
                        : null;
                let persistChunkReadsAtClick = persistChunkReadsBeforeClick;
                if (enablePersistOnly) {
                    if (!hooks.setPersistChunkReads) {
                        throw new Error(
                            "Missing persist-only file-share benchmark hook"
                        );
                    }
                    persistChunkReadsAtClick = hooks.setPersistChunkReads(true);
                    if (persistChunkReadsAtClick !== true) {
                        throw new Error(
                            "Failed to enable persisted reads before click"
                        );
                    }
                }

                const clickedAt = Date.now();
                button.click();
                return {
                    capturedAt,
                    clickedAt,
                    manifestFinalHash: file.finalHash,
                    persistChunkReadsBeforeClick,
                    persistChunkReadsAtClick,
                    snapshot,
                };
            },
            {
                expectedName: properties.fileName,
                expectedAddress: properties.expectedProgramAddress,
                expectedHash: properties.expectedFinalHash,
                enablePersistOnly: properties.enablePersistOnly,
            },
            { polling: 25, timeout: properties.timeout }
        )
        .then(async (handle) => {
            try {
                return (await handle.jsonValue()) as ReadyDownloadClick;
            } finally {
                await handle.dispose();
            }
        });
    void pending.catch(() => {});
    return pending;
};

const toMiBPerSecond = (bytes: number, durationMs: number | null) =>
    durationMs != null && durationMs > 0
        ? bytes / (1024 * 1024) / (durationMs / 1000)
        : null;

const toMbps = (bytes: number, durationMs: number | null) =>
    durationMs != null && durationMs > 0
        ? (bytes * 8) / 1_000_000 / (durationMs / 1000)
        : null;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value != null && typeof value === "object"
        ? (value as Record<string, unknown>)
        : undefined;

const asNumber = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

const durationBetween = (
    startedAt: number | null,
    finishedAt: number | null
) => (startedAt != null && finishedAt != null ? finishedAt - startedAt : null);

const getListedFile = (
    diagnostics: Record<string, unknown> | undefined,
    fileName: string
) => {
    const listedFiles = diagnostics?.listedFiles;
    if (!Array.isArray(listedFiles)) {
        return undefined;
    }
    return listedFiles
        .map(asRecord)
        .find((candidate) => candidate?.name === fileName);
};

const createFixtureResult = ({
    fixture,
    manifestFinalHash,
    downloadSha256Base64,
    downloadCrc32Hex,
    downloadCompleted,
    usesStreamingDownload,
}: {
    fixture: SyntheticFixtureMetadata;
    manifestFinalHash: string | null;
    downloadSha256Base64: string | null;
    downloadCrc32Hex: string | null;
    downloadCompleted: boolean;
    usesStreamingDownload: boolean;
}) => {
    const sourceManifestMatch = fixture.sha256Base64
        ? fixture.sha256Base64 === manifestFinalHash
        : null;
    const directDownloadHashMatch = fixture.sha256Base64
        ? downloadSha256Base64 == null
            ? null
            : fixture.sha256Base64 === downloadSha256Base64
        : null;
    const libraryDownloadFinalHashVerified = fixture.sha256Base64
        ? downloadCompleted
        : null;
    const crc32Match =
        fixture.crc32Hex != null && downloadCrc32Hex != null
            ? fixture.crc32Hex === downloadCrc32Hex
            : false;
    const streamingReadbackCrc32Match = usesStreamingDownload
        ? crc32Match
        : null;
    const integrityVerified = fixture.sha256Base64
        ? sourceManifestMatch === true &&
          libraryDownloadFinalHashVerified === true &&
          directDownloadHashMatch === true &&
          crc32Match === true &&
          (!usesStreamingDownload || streamingReadbackCrc32Match === true)
        : null;

    return {
        mode: fixture.mode,
        seed: fixture.seed,
        sourceSha256Base64: fixture.sha256Base64,
        manifestFinalHash,
        downloadSha256Base64,
        sourceCrc32Hex: fixture.crc32Hex,
        downloadCrc32Hex,
        crc32Match,
        streamingReadbackCrc32Match,
        sourceManifestMatch,
        directDownloadHashMatch,
        libraryDownloadFinalHashVerified,
        integrityVerified,
        verification: fixture.sha256Base64
            ? usesStreamingDownload
                ? "source-manifest-library-stream-and-node-file-sha256-crc32"
                : "source-manifest-library-and-browser-download-sha256-crc32"
            : "missing",
    };
};

const createCohortResult = (
    cohort: ReaderCohort,
    diagnostics: Record<string, unknown> | undefined,
    fileName: string,
    integrityVerified: boolean
) => {
    const read = asRecord(diagnostics?.lastReadDiagnostics);
    const listedFile = getListedFile(diagnostics, fileName);
    const initialLocalChunkIndexRowCount = resolveCompatibleIndexRowCount(
        asNumber(read?.initialLocalChunkIndexRowCount),
        asNumber(read?.initialLocalChunkCount),
        "initial local chunk"
    );
    const postReadLocalChunkIndexRowCount = resolveCompatibleIndexRowCount(
        asNumber(listedFile?.localChunkIndexRowCount),
        asNumber(listedFile?.localChunkCount),
        "post-read local chunk"
    );
    return classifyReaderCohort(cohort, {
        integrityVerified,
        programPersistChunkReads:
            typeof read?.programPersistChunkReads === "boolean"
                ? read.programPersistChunkReads
                : null,
        persistChunkReads:
            typeof read?.persistChunkReads === "boolean"
                ? read.persistChunkReads
                : null,
        initialLocalChunkCount: initialLocalChunkIndexRowCount,
        initialLocalChunkBlockCount: asNumber(
            read?.initialLocalChunkBlockCount
        ),
        readAheadSource:
            typeof read?.readAheadSource === "string"
                ? read.readAheadSource
                : null,
        postReadLocalChunkCount: postReadLocalChunkIndexRowCount,
        postReadLocalChunkBlockCount: asNumber(
            listedFile?.localChunkBlockCount
        ),
        chunkCount: asNumber(listedFile?.chunkCount),
    });
};

test.describe("file-share transfer benchmark", () => {
    test.skip(!ENABLED, "Set PW_BENCH=1 to run file-share benchmark");

    test("measures upload and download throughput", async ({
        browser,
        baseURL,
    }) => {
        test.setTimeout(
            Math.max(
                45 * 60 * 1000,
                UPLOAD_TIMEOUT_MS + DOWNLOAD_TIMEOUT_MS + 10 * 60 * 1000
            )
        );
        if (!baseURL) {
            throw new Error("Missing baseURL");
        }

        const usesLocalBootstrap = SCENARIO === "local";
        const fileName = `file-share-transfer-bench-${Date.now()}.bin`;
        let bootstrap:
            | Awaited<ReturnType<typeof startBootstrapPeer>>
            | undefined;
        let writerContext: BrowserContext | undefined;
        let readerContext: BrowserContext | undefined;
        let writer: Page | undefined;
        let reader: Page | undefined;
        let preparedFile:
            | Awaited<ReturnType<typeof createSyntheticFileOnDisk>>
            | undefined;
        let shareUrl: URL | undefined;
        let writerDiagnosticsAfterDownload: Record<string, unknown> | undefined;
        let readerDiagnosticsAfterDownload: Record<string, unknown> | undefined;
        let writerLightweightSnapshotAfterSink:
            | Record<string, unknown>
            | undefined;
        let readyDownloadClick: ReadyDownloadClick | undefined;
        let sinkResult: DownloadSinkResult | undefined;
        let manifestFinalHash: string | null = null;
        let downloadSha256Base64: string | null = null;
        let downloadCrc32Hex: string | null = null;
        let downloadCompleted = false;
        let cleanupDownloadedFile: (() => Promise<void>) | undefined;
        let nodeSinkController:
            | Awaited<ReturnType<typeof installNodeBackedMockSaveFilePicker>>
            | undefined;
        let usesStreamingDownload = false;
        let fixtureResult: ReturnType<typeof createFixtureResult> | undefined;
        let cohortResult: ReturnType<typeof createCohortResult> | undefined;
        let readerPeerHints: ReaderPeerHintEvidence | undefined;
        const readerTopologyReadiness = createReaderTopologyReadiness();
        let readerJsHeapSampler: ReaderJsHeapSampler | undefined;
        let readerJsHeap: ReaderJsHeapMeasurement | undefined;
        let readerJsHeapValidation:
            | ReturnType<typeof validateJsHeapMeasurement>
            | undefined;
        let hostRssSampler: HostRssSampler | undefined;
        let hostRss: HostRssMeasurement | undefined;
        let hostRssValidation:
            | ReturnType<typeof validateHostRssMeasurement>
            | undefined;

        try {
            const fixtureFile = await createSyntheticFileOnDisk(
                fileName,
                FILE_SIZE_MB,
                { mode: FIXTURE_MODE, seed: FIXTURE_SEED }
            );
            preparedFile = fixtureFile;
            if (!fixtureFile.fixture.sha256Base64) {
                fixtureFile.fixture.sha256Base64 = await sha256FileBase64(
                    fixtureFile.filePath
                );
            }
            if (!fixtureFile.fixture.crc32Hex) {
                fixtureFile.fixture.crc32Hex = await crc32FileHex(
                    fixtureFile.filePath
                );
            }
            const expectedFinalHash = fixtureFile.fixture.sha256Base64;
            if (!expectedFinalHash) {
                throw new Error("Benchmark fixture is missing its source hash");
            }

            usesStreamingDownload =
                FILE_SIZE_BYTES >= STREAMING_DOWNLOAD_THRESHOLD_BYTES;
            bootstrap = usesLocalBootstrap
                ? await startBootstrapPeer()
                : undefined;
            writerContext = await browser.newContext({
                acceptDownloads: true,
            });
            readerContext = await browser.newContext({
                acceptDownloads: true,
            });
            const writerPage = await writerContext.newPage();
            const readerPage = await readerContext.newPage();
            writer = writerPage;
            reader = readerPage;
            if (usesStreamingDownload) {
                nodeSinkController = await installNodeBackedMockSaveFilePicker(
                    readerPage,
                    {
                        expectedName: fileName,
                        expectedSizeBytes: FILE_SIZE_BYTES,
                    }
                );
            }

            logStage("create-space");
            const entryUrl =
                usesLocalBootstrap && bootstrap
                    ? withBootstrap(rootUrl(baseURL), bootstrap.addrs)
                    : rootUrl(baseURL);
            await enableOpenProfiler(writerPage);
            await enableOpenProfiler(readerPage);
            await writerPage.goto(entryUrl, {
                waitUntil: "domcontentloaded",
            });
            await waitForCreateSpaceHook(writerPage);
            const address = await createSpaceFromHook(
                writerPage,
                `file-share-transfer-bench-${Date.now()}`
            );
            shareUrl = new URL(writerPage.url());

            const initialReaderPersist = READER_COHORT === "live-replicator";
            logStage("seed-reader-cohort", {
                initialPersistChunkReads: initialReaderPersist,
            });
            await seedReplicationRole(
                readerPage,
                address,
                initialReaderPersist ? ADAPTIVE_REPLICATION_ROLE : false
            );

            if (usesLocalBootstrap) {
                logStage("wait-for-writer-direct-peer-hints");
                const directHints =
                    await waitForWriterDirectPeerHints(writerPage);
                const readerShare = buildReaderShareUrlWithPeerHints(
                    writerPage.url(),
                    directHints.peerAddresses
                );
                shareUrl = new URL(readerShare.href);
                readerPeerHints = directHints.evidence;
            } else {
                const waitStartedAt = Date.now();
                logStage("wait-for-share-peer-hints");
                await waitForShareUrlPeerHints(writerPage);
                shareUrl = new URL(writerPage.url());
                const peerAddresses = getBrowserDialablePeerAddresses(
                    shareUrl.searchParams.get("peer")?.split(",")
                );
                if (peerAddresses.length === 0) {
                    throw new Error(
                        "Writer share URL did not expose a browser-dialable direct peer address"
                    );
                }
                const waitFinishedAt = Date.now();
                readerPeerHints = {
                    source: "writer-share-url",
                    count: peerAddresses.length,
                    waitStartedAt,
                    waitFinishedAt,
                    waitDurationMs: waitFinishedAt - waitStartedAt,
                    attempts: 1,
                    lastProbeError: null,
                };
            }
            logStage("open-reader", {
                shareUrl: shareUrl.toString(),
                peerHintSource: readerPeerHints.source,
                peerHintCount: readerPeerHints.count,
            });
            await readerPage.goto(shareUrl.toString(), {
                waitUntil: "domcontentloaded",
            });
            logStage("wait-for-reader-program-state");
            await waitForReaderProgramState(
                readerPage,
                address,
                initialReaderPersist,
                UPLOAD_TIMEOUT_MS
            );
            logStage("wait-for-reader-topology", {
                expectedSelfInReplicatorSet:
                    readerTopologyReadiness.expectedSelfInReplicatorSet,
            });
            await waitForReaderTopology(readerPage, readerTopologyReadiness);
            logStage("reader-topology-ready", {
                waitDurationMs: readerTopologyReadiness.waitDurationMs,
                attempts: readerTopologyReadiness.attempts,
                evidence: readerTopologyReadiness.evidence,
            });

            logStage("wait-for-input");
            await writerPage.locator("#imgupload").waitFor({
                state: "attached",
                timeout: 60_000,
            });

            logStage("arm-download-sink-and-ready-click");
            const sinkCompletion = usesStreamingDownload
                ? armSavedViaPicker(
                      readerPage,
                      fileName,
                      FILE_SIZE_MB,
                      DOWNLOAD_TIMEOUT_MS
                  )
                : armDownloadedFile(
                      readerPage,
                      fileName,
                      FILE_SIZE_MB,
                      DOWNLOAD_TIMEOUT_MS
                  );
            const readyDownload = armReadyManifestDownload(readerPage, {
                fileName,
                expectedProgramAddress: address,
                expectedFinalHash,
                enablePersistOnly: READER_COHORT === "cold-persisted-read",
                timeout: UPLOAD_TIMEOUT_MS,
            });

            readerJsHeapSampler = await startReaderJsHeapSampler(
                readerContext,
                readerPage
            );
            hostRssSampler = await startHostRssSampler(browser);
            const activeReaderJsHeapSampler = readerJsHeapSampler;
            const activeHostRssSampler = hostRssSampler;
            const measuredSinkCompletion = stopSamplerAtCompletion(
                sinkCompletion,
                {
                    stop: async () => {
                        const [readerJsHeapMeasurement, hostRssMeasurement] =
                            await Promise.all([
                                activeReaderJsHeapSampler.stop(),
                                activeHostRssSampler.stop(),
                            ]);
                        return {
                            readerJsHeapMeasurement,
                            hostRssMeasurement,
                        };
                    },
                }
            ).then(({ result, measurement }) => {
                readerJsHeap = measurement.readerJsHeapMeasurement;
                hostRss = measurement.hostRssMeasurement;
                if (readerJsHeapSampler === activeReaderJsHeapSampler) {
                    readerJsHeapSampler = undefined;
                }
                if (hostRssSampler === activeHostRssSampler) {
                    hostRssSampler = undefined;
                }
                return result;
            });
            void measuredSinkCompletion.catch(() => {});
            logStage("upload");
            const uploadStartedAt = Date.now();
            await writerPage
                .locator("#imgupload")
                .setInputFiles(fixtureFile.filePath);
            await waitForFileListed(writerPage, fileName, UPLOAD_TIMEOUT_MS);
            await waitForUploadComplete(writerPage, UPLOAD_TIMEOUT_MS);
            const uploadFinishedAt = Date.now();

            logStage("wait-for-ready-click-and-sink");
            readyDownloadClick = await readyDownload;
            manifestFinalHash = readyDownloadClick.manifestFinalHash;
            sinkResult = await measuredSinkCompletion;
            cleanupDownloadedFile = sinkResult.cleanup;
            downloadCompleted = true;
            readerJsHeapValidation = validateJsHeapMeasurement(readerJsHeap);
            if (!readerJsHeapValidation.valid) {
                throw new Error(
                    `Invalid reader JS heap measurement: ${readerJsHeapValidation.validationReasons.join(", ")}`
                );
            }
            hostRssValidation = validateHostRssMeasurement(hostRss);
            if (!hostRssValidation.valid) {
                throw new Error(
                    `Invalid host RSS measurement: ${hostRssValidation.validationReasons.join(", ")}`
                );
            }

            // All snapshots, hashing, and rich diagnostics happen after the
            // primary sink completion timestamp. Capture browser diagnostics
            // first so post-sink disk verification cannot change them.
            [
                writerLightweightSnapshotAfterSink,
                writerDiagnosticsAfterDownload,
                readerDiagnosticsAfterDownload,
            ] = await Promise.all([
                getLightweightSnapshot(writerPage),
                getDiagnostics(writerPage).catch(() => undefined),
                getDiagnostics(readerPage).catch(() => undefined),
            ]);
            if (sinkResult.downloadPath) {
                logStage("verify-downloaded-file-digests");
                const digests = await sha256AndCrc32File(
                    sinkResult.downloadPath
                );
                downloadSha256Base64 = digests.sha256Base64;
                downloadCrc32Hex = digests.crc32Hex;
            } else if (usesStreamingDownload) {
                logStage("verify-streaming-sink-crc32");
                downloadCrc32Hex = await crc32SavedViaPicker(
                    readerPage,
                    fileName
                );
            }
            if (sinkResult.downloadPath && downloadSha256Base64 == null) {
                downloadSha256Base64 = await sha256FileBase64(
                    sinkResult.downloadPath
                );
                if (downloadSha256Base64 !== expectedFinalHash) {
                    throw new Error(
                        `Downloaded file hash ${downloadSha256Base64} does not match fixture hash ${expectedFinalHash}`
                    );
                }
            }

            fixtureResult = createFixtureResult({
                fixture: fixtureFile.fixture,
                manifestFinalHash,
                downloadSha256Base64,
                downloadCrc32Hex,
                downloadCompleted,
                usesStreamingDownload,
            });
            if (fixtureResult.integrityVerified !== true) {
                throw new Error(
                    "Benchmark transfer integrity was not verified"
                );
            }
            cohortResult = createCohortResult(
                READER_COHORT,
                readerDiagnosticsAfterDownload,
                fileName,
                true
            );
            if (!cohortResult.valid) {
                throw new Error(
                    `Invalid ${READER_COHORT} sample: ${cohortResult.validationReasons.join(", ")}`
                );
            }

            const read = asRecord(
                readerDiagnosticsAfterDownload?.lastReadDiagnostics
            );
            const libraryStreamStartedAt = asNumber(read?.startedAt);
            const libraryStreamFinishedAt = asNumber(read?.finishedAt);
            const uploadDurationMs = uploadFinishedAt - uploadStartedAt;
            const uploadStartedToReadyVisibleMs =
                readyDownloadClick.capturedAt - uploadStartedAt;
            const uploadFinishedToReadyVisibleMs =
                readyDownloadClick.capturedAt - uploadFinishedAt;
            const readyVisibleToClickMs =
                readyDownloadClick.clickedAt - readyDownloadClick.capturedAt;
            const clickToSinkCompleteMs =
                sinkResult.sinkCompletedAt - readyDownloadClick.clickedAt;
            const libraryStreamDurationMs = durationBetween(
                libraryStreamStartedAt,
                libraryStreamFinishedAt
            );
            const clickToLibraryStreamStartMs = durationBetween(
                readyDownloadClick.clickedAt,
                libraryStreamStartedAt
            );
            const libraryStreamEndToSinkCompleteMs = durationBetween(
                libraryStreamFinishedAt,
                sinkResult.sinkCompletedAt
            );
            const readyManifestVisibilityLagMs = Math.max(
                0,
                uploadFinishedToReadyVisibleMs
            );

            const result = {
                status: "passed",
                scenario: SCENARIO,
                readerCohort: READER_COHORT,
                readerRole: LEGACY_READER_ROLE,
                baseURL,
                shareUrl: shareUrl.toString(),
                fileName,
                fileSizeMb: FILE_SIZE_MB,
                sink: sinkResult.sink,
                downloadMode: sinkResult.sink,
                sinkServerWriteCalls: sinkResult.serverWriteCalls,
                sinkServerWriteDurationMs: sinkResult.serverWriteDurationMs,
                sinkServerWriteDurationDefinition:
                    "loopback-request-body-receive-and-node-filesystem-write-only",
                sizeBytes: sinkResult.size,
                fixture: fixtureResult,
                readerCohortValidation: cohortResult,
                readerPeerHints,
                readerTopologyReadiness,
                readerJsHeap,
                readerJsHeapValidation,
                hostRss,
                hostRssValidation,
                timings: {
                    uploadDurationMs,
                    uploadStartedToReadyVisibleMs,
                    uploadFinishedToReadyVisibleMs,
                    readyVisibleToClickMs,
                    clickToSinkCompleteMs,
                    libraryStreamDurationMs,
                    clickToLibraryStreamStartMs,
                    libraryStreamEndToSinkCompleteMs,
                },
                uploadDurationMs,
                uploadStartedToReadyVisibleMs,
                uploadFinishedToReadyVisibleMs,
                readyVisibleToClickMs,
                clickToSinkCompleteMs,
                libraryStreamDurationMs,
                clickToLibraryStreamStartMs,
                libraryStreamEndToSinkCompleteMs,
                readerReadyManifestVisibleAt: readyDownloadClick.capturedAt,
                readyManifestVisibilityLagMs,
                readyManifestVisibilityOffsetFromUploadFinishedMs:
                    uploadFinishedToReadyVisibleMs,
                readyManifestVisibleToDownloadStartMs: readyVisibleToClickMs,
                discoveryLagMs: readyManifestVisibilityLagMs,
                discoveryLagDefinition:
                    "reader-ready-visible-minus-writer-upload-finished-clamped-at-zero",
                downloadDurationMs: clickToSinkCompleteMs,
                downloadDurationDefinition:
                    "browser-row-click-to-primary-sink-complete",
                downloadStartedAt: readyDownloadClick.clickedAt,
                downloadFinishedAt: sinkResult.sinkCompletedAt,
                libraryStreamStartedAt,
                libraryStreamFinishedAt,
                writerLightweightSnapshotAfterSink,
                readerLightweightSnapshotAtVisibility:
                    readyDownloadClick.snapshot,
                persistChunkReadsBeforeClick:
                    readyDownloadClick.persistChunkReadsBeforeClick,
                persistChunkReadsAtClick:
                    readyDownloadClick.persistChunkReadsAtClick,
                diagnosticsCapturedAfterSink: true,
                writerDiagnostics: writerDiagnosticsAfterDownload,
                readerDiagnostics: readerDiagnosticsAfterDownload,
                writerDiagnosticsAfterDownload,
                readerDiagnosticsAfterDownload,
                uploadMiBps: toMiBPerSecond(sinkResult.size, uploadDurationMs),
                uploadMbps: toMbps(sinkResult.size, uploadDurationMs),
                downloadMiBps: toMiBPerSecond(
                    sinkResult.size,
                    clickToSinkCompleteMs
                ),
                downloadMbps: toMbps(sinkResult.size, clickToSinkCompleteMs),
                startedAt: uploadStartedAt,
                finishedAt: sinkResult.sinkCompletedAt,
            };

            await persistResult(result);
            console.log(`FILE_SHARE_TRANSFER_BENCH ${JSON.stringify(result)}`);
        } catch (error: any) {
            if (readerJsHeapSampler) {
                readerJsHeap = await readerJsHeapSampler.stop();
                readerJsHeapSampler = undefined;
            }
            if (hostRssSampler) {
                hostRss = await hostRssSampler.stop();
                hostRssSampler = undefined;
            }
            const [failureWriterDiagnostics, failureReaderDiagnostics] =
                await Promise.all([
                    writer
                        ? getDiagnostics(writer).catch(() => undefined)
                        : undefined,
                    reader
                        ? getDiagnostics(reader).catch(() => undefined)
                        : undefined,
                ]);
            const result = {
                status: "failed",
                scenario: SCENARIO,
                readerCohort: READER_COHORT,
                readerRole: LEGACY_READER_ROLE,
                shareUrl: shareUrl?.toString(),
                fileName,
                fileSizeMb: FILE_SIZE_MB,
                sink: sinkResult?.sink,
                fixture:
                    fixtureResult ??
                    (preparedFile
                        ? createFixtureResult({
                              fixture: preparedFile.fixture,
                              manifestFinalHash,
                              downloadSha256Base64,
                              downloadCrc32Hex,
                              downloadCompleted,
                              usesStreamingDownload,
                          })
                        : {
                              requestedMode: FIXTURE_MODE,
                              seed:
                                  FIXTURE_MODE === "deterministic"
                                      ? FIXTURE_SEED
                                      : null,
                              setupComplete: false,
                          }),
                readerCohortValidation: cohortResult,
                readerPeerHints,
                readerTopologyReadiness,
                readerJsHeap,
                readerJsHeapValidation,
                hostRss,
                hostRssValidation,
                readyDownloadClick,
                writerLightweightSnapshotAfterSink,
                failure: {
                    message:
                        typeof error?.message === "string"
                            ? error.message
                            : String(error),
                    stack:
                        typeof error?.stack === "string"
                            ? error.stack
                            : undefined,
                },
                writerDiagnostics: failureWriterDiagnostics,
                readerDiagnostics: failureReaderDiagnostics,
            };
            await persistResult(result);
            console.error(
                `FILE_SHARE_TRANSFER_BENCH ${JSON.stringify(result)}`
            );
            throw error;
        } finally {
            if (readerJsHeapSampler) {
                readerJsHeap = await readerJsHeapSampler
                    .stop()
                    .catch(() => readerJsHeapSampler?.snapshot());
                readerJsHeapSampler = undefined;
            }
            if (hostRssSampler) {
                hostRss = await hostRssSampler
                    .stop()
                    .catch(() => hostRssSampler?.snapshot());
                hostRssSampler = undefined;
            }
            if (cleanupDownloadedFile) {
                await cleanupDownloadedFile().catch(() => {});
            }
            await nodeSinkController?.cleanup().catch(() => {});
            await writerContext?.close().catch(() => {});
            await readerContext?.close().catch(() => {});
            await bootstrap?.stop().catch(() => {});
            if (preparedFile) {
                await rm(preparedFile.dir, {
                    recursive: true,
                    force: true,
                }).catch(() => {});
            }
        }
    });
});
