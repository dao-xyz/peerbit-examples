import fs from "node:fs";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const MODE = process.argv[2];
const BASE_URL = (process.env.PW_BASE_URL || "https://files.dao.xyz").replace(
    /\/$/,
    ""
);
const FILE_SIZE_MB = Number(process.env.PW_FILE_MB || "512");
const READER_ROLE = process.env.PW_READER_ROLE || "adaptive";
const RESULT_FILE = process.env.PW_RESULT_FILE;
const STREAMING_DOWNLOAD_THRESHOLD_BYTES = 250_000_000;
const UPLOAD_TIMEOUT_MS = Number(process.env.PW_UPLOAD_TIMEOUT_MS || "1800000");
const DOWNLOAD_TIMEOUT_MS = Number(
    process.env.PW_DOWNLOAD_TIMEOUT_MS || "1800000"
);
const COORDINATION_TIMEOUT_MS = Number(
    process.env.PW_COORDINATION_TIMEOUT_MS || "2700000"
);
const POLL_INTERVAL_MS = Number(process.env.PW_COORDINATION_POLL_MS || "10000");
const RUN_ID = process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
const COORDINATION_FILE = process.env.COORDINATION_FILE;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const COORDINATION_ISSUE = process.env.COORDINATION_ISSUE;

const rootUrl = (baseURL) => `${baseURL.replace(/\/$/, "")}/#/`;

const getReaderRoleOptions = () => {
    if (READER_ROLE === "observer") {
        return false;
    }
    if (READER_ROLE === "adaptive") {
        return { limits: { cpu: { max: 1 } } };
    }
    throw new Error(`Unsupported PW_READER_ROLE='${READER_ROLE}'`);
};

const persistResult = async (result) => {
    if (!RESULT_FILE) {
        return;
    }
    await mkdir(path.dirname(RESULT_FILE), { recursive: true });
    await writeFile(RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`);
};

const toMiBPerSecond = (bytes, durationMs) =>
    durationMs > 0 ? bytes / (1024 * 1024) / (durationMs / 1000) : null;

const toMbps = (bytes, durationMs) =>
    durationMs > 0 ? (bytes * 8) / 1_000_000 / (durationMs / 1000) : null;

const createSyntheticFileOnDisk = async (fileName, sizeMb) => {
    const dir = await fs.promises.mkdtemp(
        path.join(tmpdir(), "peerbit-file-share-")
    );
    const filePath = path.join(dir, fileName);
    const file = await open(filePath, "w");
    try {
        await file.truncate(sizeMb * 1024 * 1024);
    } finally {
        await file.close();
    }
    return { dir, filePath, fileName };
};

const waitForCreateSpaceHook = async (page) => {
    await page.waitForFunction(
        () => Boolean(window.__peerbitFileShareCreateSpace),
        undefined,
        { timeout: 180_000 }
    );
};

const createSpaceFromHook = async (page, name) =>
    page.evaluate(async (spaceName) => {
        const createSpace = window.__peerbitFileShareCreateSpace;
        if (!createSpace) {
            throw new Error("Missing __peerbitFileShareCreateSpace");
        }
        return await createSpace(spaceName);
    }, name);

const seedReplicationRole = async (page, address, roleOptions) => {
    await page.addInitScript(
        ({ shareAddress, role }) => {
            window.localStorage.setItem(
                `${shareAddress}-role`,
                JSON.stringify(role)
            );
        },
        { shareAddress: address, role: roleOptions }
    );
};

const enableOpenProfiler = async (page) => {
    await page.addInitScript(() => {
        Object.defineProperty(window, "__peerbitFileShareEnableOpenProfiler", {
            value: true,
            configurable: true,
            enumerable: false,
            writable: true,
        });
    });
};

const getDiagnostics = async (page) => {
    return await page.evaluate(async () => {
        const hooks = window.__peerbitFileShareTestHooks;
        if (!hooks?.getDiagnostics) {
            throw new Error(
                "Missing __peerbitFileShareTestHooks.getDiagnostics"
            );
        }
        return await hooks.getDiagnostics();
    });
};

const waitForFileListed = async (page, fileName, timeout = 180_000) => {
    await page
        .locator("li", { hasText: fileName })
        .first()
        .waitFor({ timeout });
};

const waitForUploadComplete = async (page, timeout = 600_000) => {
    const progress = page.locator(
        '[data-testid="upload-progress"], .progress-root'
    );
    if ((await progress.count()) === 0) {
        return;
    }
    await progress.first().waitFor({ state: "hidden", timeout });
};

const ignoreTimeout = (promise) =>
    promise.catch((error) => {
        if (
            error?.name === "TimeoutError" ||
            /Timeout .* exceeded/i.test(String(error?.message || ""))
        ) {
            return new Promise(() => {});
        }
        throw error;
    });

const getDownloadButton = async (page, fileName, timeout = 60_000) => {
    const row = page.locator("li", { hasText: fileName }).first();
    await row.waitFor({ timeout });
    const byTestId = row.getByTestId("download-file");
    const button =
        (await byTestId.count()) > 0 ? byTestId : row.locator("button").first();
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await button.isEnabled().catch(() => false)) {
            return { row, button };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Download button for ${fileName} did not become enabled`);
};

const installMockSaveFilePicker = async (page) => {
    await page.addInitScript(() => {
        const savedFiles = [];
        Object.defineProperty(
            window,
            "__peerbitStreamingDownloadThresholdBytes",
            {
                value: 1,
                configurable: true,
                enumerable: false,
                writable: true,
            }
        );
        Object.defineProperty(window, "__mockSavedFiles", {
            value: savedFiles,
            configurable: true,
            enumerable: false,
            writable: false,
        });
        Object.defineProperty(window, "showSaveFilePicker", {
            configurable: true,
            enumerable: false,
            writable: true,
            value: async (options) => {
                let written = 0;
                return {
                    createWritable: async () => ({
                        write: async (data) => {
                            written += data.byteLength ?? 0;
                        },
                        close: async () => {
                            savedFiles.push({
                                name: options?.suggestedName ?? "download.bin",
                                size: written,
                            });
                        },
                        abort: async () => {},
                    }),
                };
            },
        });
    });
};

const expectDownloadedFile = async (
    page,
    fileName,
    expectedSizeMb,
    timeout = 8 * 60 * 1000
) => {
    const { button } = await getDownloadButton(page, fileName, timeout);

    const downloadPromise = page.waitForEvent("download", { timeout });
    const dialogFailure = ignoreTimeout(
        page.waitForEvent("dialog", { timeout }).then(async (dialog) => {
            const message = dialog.message();
            await dialog.dismiss().catch(() => {});
            throw new Error(`Download failed dialog: ${message}`);
        })
    );
    const pageErrorFailure = ignoreTimeout(
        page.waitForEvent("pageerror", { timeout }).then((error) => {
            throw error;
        })
    );

    await button.click();
    const download = await Promise.race([
        downloadPromise,
        dialogFailure,
        pageErrorFailure,
    ]);

    const dir = await fs.promises.mkdtemp(
        path.join(tmpdir(), "peerbit-file-download-")
    );
    const downloadPath = path.join(dir, fileName);
    await download.saveAs(downloadPath);
    const details = await stat(downloadPath);
    if (details.size !== expectedSizeMb * 1024 * 1024) {
        throw new Error(
            `Unexpected downloaded file size ${details.size} for ${fileName}`
        );
    }
    return { downloadPath, size: details.size };
};

const expectSavedViaPicker = async (
    page,
    fileName,
    expectedSizeMb,
    timeout = 8 * 60 * 1000
) => {
    const expectedBytes = expectedSizeMb * 1024 * 1024;
    const { button } = await getDownloadButton(page, fileName, timeout);
    const dialogFailure = ignoreTimeout(
        page.waitForEvent("dialog", { timeout }).then(async (dialog) => {
            const message = dialog.message();
            await dialog.dismiss().catch(() => {});
            throw new Error(`Download failed dialog: ${message}`);
        })
    );
    const pageErrorFailure = ignoreTimeout(
        page.waitForEvent("pageerror", { timeout }).then((error) => {
            throw error;
        })
    );
    const streamedSave = page
        .waitForFunction(
            ({ expectedName, expectedSize }) => {
                const savedFiles = window.__mockSavedFiles ?? [];
                return (
                    savedFiles.find(
                        (file) =>
                            file.name === expectedName &&
                            file.size === expectedSize
                    ) ?? null
                );
            },
            {
                expectedName: fileName,
                expectedSize: expectedBytes,
            },
            { timeout }
        )
        .then(() => ({ size: expectedBytes }));

    await button.click();
    return await Promise.race([streamedSave, dialogFailure, pageErrorFailure]);
};

const marker = (kind) =>
    `<!-- file-share-two-runner run:${RUN_ID} kind:${kind} -->`;

const parseEventBody = (body) => {
    const match = body.match(
        /^<!-- file-share-two-runner run:(.+?) kind:(.+?) -->\n```json\n([\s\S]*?)\n```$/m
    );
    if (!match) {
        return null;
    }
    try {
        return {
            runId: match[1],
            kind: match[2],
            payload: JSON.parse(match[3]),
        };
    } catch {
        return null;
    }
};

const countObjectKeys = (value) =>
    value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value).length
        : undefined;

const tail = (value, count = 5) =>
    Array.isArray(value)
        ? value.slice(Math.max(0, value.length - count))
        : value;

const compactReadDiagnostics = (diagnostics = {}) => ({
    waitUntilReadyResolvedBy: diagnostics.waitUntilReadyResolvedBy,
    waitUntilReadyResolvedReady: diagnostics.waitUntilReadyResolvedReady,
    waitUntilReadyAttempts: diagnostics.waitUntilReadyAttempts,
    lastReadyProbe: diagnostics.lastReadyProbe,
    chunkAttemptTimeoutMs: diagnostics.chunkAttemptTimeoutMs,
    readAhead: diagnostics.readAhead,
    prefetchedChunkCount: diagnostics.prefetchedChunkCount,
    chunkAttemptsCount: countObjectKeys(diagnostics.chunkAttempts),
    chunkResolvedCount: countObjectKeys(diagnostics.chunkResolved),
    chunkManifestHeadsCount: countObjectKeys(diagnostics.chunkManifestHeads),
    chunkIndexedHeadsCount: countObjectKeys(diagnostics.chunkIndexedHeads),
    chunkHeadGetsCount: countObjectKeys(diagnostics.chunkHeadGets),
    readyRemoteGetHeadsCount: diagnostics.readyRemoteGetHeads?.length,
    readyRemoteGetHeads: tail(diagnostics.readyRemoteGetHeads),
    readyRemoteDecodeFallbacks: tail(diagnostics.readyRemoteDecodeFallbacks),
    chunkFailure: diagnostics.chunkFailure,
    finishedAt: diagnostics.finishedAt,
});

const compactDiagnostics = (diagnostics) => {
    if (!diagnostics || typeof diagnostics !== "object") {
        return diagnostics;
    }
    return {
        programAddress: diagnostics.programAddress,
        programClosed: diagnostics.programClosed,
        persistChunkReads: diagnostics.persistChunkReads,
        peerHash: diagnostics.peerHash,
        peerStatus: diagnostics.peerStatus,
        connectionCount: diagnostics.connectionCount,
        connectionPeers: tail(diagnostics.connectionPeers),
        replicatorCount: diagnostics.replicatorCount,
        listCount: diagnostics.listCount,
        listedFiles: diagnostics.listedFiles,
        replicationSetSize: diagnostics.replicationSetSize,
        lastUploadDiagnostics: diagnostics.lastUploadDiagnostics,
        lastReadDiagnostics: compactReadDiagnostics(
            diagnostics.lastReadDiagnostics
        ),
        benchmarkStats: diagnostics.benchmarkStats
            ? {
                  updateListCalls: tail(
                      diagnostics.benchmarkStats.updateListCalls
                  ),
              }
            : diagnostics.benchmarkStats,
        timings: diagnostics.timings,
    };
};

const compactCoordinationPayload = (payload) => {
    if (!payload || typeof payload !== "object") {
        return payload;
    }
    return {
        ...payload,
        writerDiagnostics: compactDiagnostics(payload.writerDiagnostics),
        readerDiagnostics: compactDiagnostics(payload.readerDiagnostics),
        reader: compactCoordinationPayload(payload.reader),
    };
};

const minimalCoordinationPayload = (payload) => {
    if (!payload || typeof payload !== "object") {
        return payload;
    }
    return {
        status: payload.status,
        role: payload.role,
        readerRole: payload.readerRole,
        scenario: payload.scenario,
        baseURL: payload.baseURL,
        shareUrl: payload.shareUrl,
        address: payload.address,
        fileName: payload.fileName,
        fileSizeMb: payload.fileSizeMb,
        sizeBytes: payload.sizeBytes,
        uploadDurationMs: payload.uploadDurationMs,
        uploadMbps: payload.uploadMbps,
        downloadDurationMs: payload.downloadDurationMs,
        downloadMbps: payload.downloadMbps,
        listingWaitMs: payload.listingWaitMs,
        failure: payload.failure,
    };
};

const createFileCoordinator = (filePath) => ({
    async publish(kind, payload) {
        await mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.appendFile(
            filePath,
            `${JSON.stringify({ runId: RUN_ID, kind, payload })}\n`
        );
    },
    async waitForAny(kinds, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (fs.existsSync(filePath)) {
                const text = await readFile(filePath, "utf8");
                const events = text
                    .split("\n")
                    .filter(Boolean)
                    .map((line) => JSON.parse(line))
                    .filter((event) => event.runId === RUN_ID);
                const match = events.find((event) =>
                    kinds.includes(event.kind)
                );
                if (match) {
                    return match;
                }
            }
            await new Promise((resolve) =>
                setTimeout(resolve, POLL_INTERVAL_MS)
            );
        }
        throw new Error(
            `Timed out waiting for coordination event ${kinds.join(", ")}`
        );
    },
});

const githubRequest = async (url, init = {}) => {
    if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !COORDINATION_ISSUE) {
        throw new Error("Missing GitHub coordination environment");
    }
    const response = await fetch(url, {
        ...init,
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            "X-GitHub-Api-Version": "2022-11-28",
            ...(init.headers || {}),
        },
    });
    if (!response.ok) {
        throw new Error(
            `GitHub coordination request failed (${response.status}): ${await response.text()}`
        );
    }
    if (response.status === 204) {
        return null;
    }
    return await response.json();
};

const createGithubCoordinator = () => {
    const issueUrl = `https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${COORDINATION_ISSUE}/comments?per_page=100`;
    const makeBody = (kind, payload) =>
        `${marker(kind)}\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
    return {
        async publish(kind, payload) {
            let body = makeBody(kind, payload);
            if (body.length > 60_000) {
                body = makeBody(kind, compactCoordinationPayload(payload));
            }
            if (body.length > 60_000) {
                body = makeBody(kind, minimalCoordinationPayload(payload));
            }
            await githubRequest(issueUrl, {
                method: "POST",
                body: JSON.stringify({ body }),
            });
        },
        async waitForAny(kinds, timeoutMs) {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const comments = await githubRequest(issueUrl);
                const parsed = comments
                    .map((comment) => parseEventBody(comment.body))
                    .filter(Boolean)
                    .filter((event) => event.runId === RUN_ID)
                    .filter((event) => kinds.includes(event.kind));
                if (parsed.length > 0) {
                    return parsed[parsed.length - 1];
                }
                await new Promise((resolve) =>
                    setTimeout(resolve, POLL_INTERVAL_MS)
                );
            }
            throw new Error(
                `Timed out waiting for coordination event ${kinds.join(", ")}`
            );
        },
    };
};

const createCoordinator = () => {
    if (COORDINATION_FILE) {
        return createFileCoordinator(COORDINATION_FILE);
    }
    return createGithubCoordinator();
};

const createFailure = (error) => ({
    message: typeof error?.message === "string" ? error.message : String(error),
    stack: typeof error?.stack === "string" ? error.stack : undefined,
});

const runWriter = async (coordinator) => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await enableOpenProfiler(page);
    const fileName = `file-share-two-runner-${Date.now()}.bin`;
    const preparedFile = await createSyntheticFileOnDisk(
        fileName,
        FILE_SIZE_MB
    );
    let writerDiagnostics;

    try {
        const entryUrl = rootUrl(BASE_URL);
        await page.goto(entryUrl, { waitUntil: "domcontentloaded" });
        await waitForCreateSpaceHook(page);
        const address = await createSpaceFromHook(
            page,
            `file-share-two-runner-${Date.now()}`
        );
        const shareUrl = new URL(entryUrl);
        shareUrl.hash = `/s/${address}`;

        await page.goto(shareUrl.toString(), { waitUntil: "domcontentloaded" });
        await page.locator("#imgupload").waitFor({
            state: "attached",
            timeout: 60_000,
        });

        const uploadStartedAt = Date.now();
        await page.locator("#imgupload").setInputFiles(preparedFile.filePath);
        await waitForFileListed(page, fileName, UPLOAD_TIMEOUT_MS);
        await waitForUploadComplete(page, UPLOAD_TIMEOUT_MS);
        const uploadFinishedAt = Date.now();
        writerDiagnostics = await getDiagnostics(page);

        const result = {
            status: "passed",
            role: "writer",
            scenario: "prod",
            baseURL: BASE_URL,
            shareUrl: shareUrl.toString(),
            address,
            fileName,
            fileSizeMb: FILE_SIZE_MB,
            sizeBytes: FILE_SIZE_MB * 1024 * 1024,
            uploadDurationMs: uploadFinishedAt - uploadStartedAt,
            uploadMiBps: toMiBPerSecond(
                FILE_SIZE_MB * 1024 * 1024,
                uploadFinishedAt - uploadStartedAt
            ),
            uploadMbps: toMbps(
                FILE_SIZE_MB * 1024 * 1024,
                uploadFinishedAt - uploadStartedAt
            ),
            writerDiagnostics,
            startedAt: uploadStartedAt,
            finishedAt: uploadFinishedAt,
        };

        await coordinator.publish("writer-ready", result);
        const readerEvent = await coordinator.waitForAny(
            ["reader-complete", "reader-failed"],
            COORDINATION_TIMEOUT_MS
        );
        if (readerEvent.kind === "reader-failed") {
            throw new Error(
                `Reader failed: ${readerEvent.payload?.message || "unknown error"}`
            );
        }
        await persistResult({
            ...result,
            reader: readerEvent.payload,
        });
    } catch (error) {
        const failure = createFailure(error);
        const failureDiagnostics =
            writerDiagnostics ??
            (await getDiagnostics(page).catch(() => undefined));
        await persistResult({
            status: "failed",
            role: "writer",
            scenario: "prod",
            fileName,
            fileSizeMb: FILE_SIZE_MB,
            writerDiagnostics: failureDiagnostics,
            failure,
        });
        await coordinator.publish("writer-failed", failure).catch(() => {});
        throw error;
    } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
        await rm(preparedFile.dir, {
            recursive: true,
            force: true,
        }).catch(() => {});
    }
};

const runReader = async (coordinator) => {
    const readyEvent = await coordinator.waitForAny(
        ["writer-ready", "writer-failed"],
        COORDINATION_TIMEOUT_MS
    );
    if (readyEvent.kind === "writer-failed") {
        throw new Error(
            `Writer failed before reader started: ${readyEvent.payload?.message || "unknown error"}`
        );
    }

    const writer = readyEvent.payload;
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await enableOpenProfiler(page);
    const readerRoleOptions = getReaderRoleOptions();
    const usesStreamingDownload =
        FILE_SIZE_MB * 1024 * 1024 >= STREAMING_DOWNLOAD_THRESHOLD_BYTES;
    let readerDiagnostics;

    try {
        if (usesStreamingDownload) {
            await installMockSaveFilePicker(page);
        }
        await seedReplicationRole(page, writer.address, readerRoleOptions);
        await page.goto(writer.shareUrl, { waitUntil: "domcontentloaded" });
        const readerReadyAt = Date.now();
        await waitForFileListed(page, writer.fileName, UPLOAD_TIMEOUT_MS);
        const listedAt = Date.now();
        readerDiagnostics = await getDiagnostics(page);

        const downloadStartedAt = Date.now();
        const downloaded = usesStreamingDownload
            ? await expectSavedViaPicker(
                  page,
                  writer.fileName,
                  FILE_SIZE_MB,
                  DOWNLOAD_TIMEOUT_MS
              ).then(() => ({ size: FILE_SIZE_MB * 1024 * 1024 }))
            : await expectDownloadedFile(
                  page,
                  writer.fileName,
                  FILE_SIZE_MB,
                  DOWNLOAD_TIMEOUT_MS
              );
        const downloadFinishedAt = Date.now();
        const readerDiagnosticsAfterDownload =
            (await getDiagnostics(page).catch(() => undefined)) ??
            readerDiagnostics;

        const result = {
            status: "passed",
            role: "reader",
            readerRole: READER_ROLE,
            scenario: "prod",
            baseURL: BASE_URL,
            shareUrl: writer.shareUrl,
            fileName: writer.fileName,
            fileSizeMb: FILE_SIZE_MB,
            downloadMode: usesStreamingDownload
                ? "save-picker-stream"
                : "browser-download",
            sizeBytes: downloaded.size,
            listingWaitMs: listedAt - readerReadyAt,
            downloadDurationMs: downloadFinishedAt - downloadStartedAt,
            downloadMiBps: toMiBPerSecond(
                downloaded.size,
                downloadFinishedAt - downloadStartedAt
            ),
            downloadMbps: toMbps(
                downloaded.size,
                downloadFinishedAt - downloadStartedAt
            ),
            readerDiagnostics,
            readerDiagnosticsAfterDownload,
            startedAt: readerReadyAt,
            finishedAt: downloadFinishedAt,
        };

        await persistResult(result);
        await coordinator.publish("reader-complete", result);
    } catch (error) {
        const failure = createFailure(error);
        const failureDiagnostics =
            (await getDiagnostics(page).catch(() => undefined)) ??
            readerDiagnostics;
        await persistResult({
            status: "failed",
            role: "reader",
            readerRole: READER_ROLE,
            scenario: "prod",
            fileName: writer.fileName,
            fileSizeMb: FILE_SIZE_MB,
            readerDiagnostics: failureDiagnostics,
            failure,
        });
        await coordinator.publish("reader-failed", failure).catch(() => {});
        throw error;
    } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
    }
};

const runSmoke = async (coordinator) => {
    const payload = { ok: true, at: Date.now() };
    await coordinator.publish("smoke", payload);
    const event = await coordinator.waitForAny(["smoke"], 5_000);
    await persistResult({
        status: "passed",
        role: "smoke",
        payload: event.payload,
    });
};

const main = async () => {
    if (!["writer", "reader", "smoke"].includes(MODE)) {
        throw new Error(
            `Usage: node tests/two-runner.bench.mjs <writer|reader|smoke>`
        );
    }
    const coordinator = createCoordinator();
    if (MODE === "writer") {
        await runWriter(coordinator);
        return;
    }
    if (MODE === "reader") {
        await runReader(coordinator);
        return;
    }
    await runSmoke(coordinator);
};

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
