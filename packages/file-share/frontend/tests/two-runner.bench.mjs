import fs from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    createCrc32,
    createDeterministicFileOnDisk,
    evaluateIntegrity,
    installNodeFileChecksumSink,
    requireIntegrity,
    sha256AndCrc32File,
    validateLargeFileSizeMb,
} from "./two-runner-integrity.mjs";

const MODE = process.argv[2];
const CONFIGURED_BASE_URL = process.env.PW_BASE_URL?.trim();
if (MODE !== "self-test" && !CONFIGURED_BASE_URL) {
    throw new Error("PW_BASE_URL is required for two-runner benchmarks");
}
const BASE_URL = (CONFIGURED_BASE_URL || "https://example.invalid").replace(
    /\/$/,
    ""
);
const FILE_SIZE_MB = Number(process.env.PW_FILE_MB || "512");
const FIXTURE_SEED =
    process.env.PW_FIXTURE_SEED?.trim() || "peerbit-file-share-v1";
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
const RUN_ID = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_RUN_ID}-attempt-${process.env.GITHUB_RUN_ATTEMPT || "1"}`
    : `local-${Date.now()}`;
const COORDINATION_FILE = process.env.COORDINATION_FILE;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const COORDINATION_ISSUE = process.env.COORDINATION_ISSUE;
const TEST_HOOK_TIMEOUT_MS = Number(
    process.env.PW_TEST_HOOK_TIMEOUT_MS || "60000"
);
const MAX_RECORDED_PAGE_EVENTS = 50;
const MAX_RECORDED_TEXT_LENGTH = 2_000;

const rootUrl = (baseURL) => `${baseURL.replace(/\/$/, "")}/#/`;

const launchChromium = async () => {
    const { chromium } = await import("@playwright/test");
    return await chromium.launch({ headless: true });
};

const getReaderRoleOptions = () => {
    if (READER_ROLE === "observer") {
        return false;
    }
    if (READER_ROLE === "adaptive") {
        return { limits: { interval: 300_000, cpu: { max: 1 } } };
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

const waitForShareUrlPeerHints = async (page, timeout = 180_000) => {
    await page.waitForFunction(
        () => new URL(window.location.href).searchParams.has("peer"),
        undefined,
        { timeout }
    );
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

const getTopologySnapshot = async (page) => {
    return await page.evaluate(async () => {
        const hooks = window.__peerbitFileShareTestHooks;
        if (!hooks?.getTopologySnapshot) {
            throw new Error(
                "Missing __peerbitFileShareTestHooks.getTopologySnapshot"
            );
        }
        return await hooks.getTopologySnapshot();
    });
};

const toSafeByteSize = (value, label) => {
    const size = Number(value);
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(`Invalid ${label} size '${value}'`);
    }
    return size;
};

const getReadyManifest = (
    diagnostics,
    { fileName, expectedSizeBytes, expectedFileId, expectedProgramAddress }
) => {
    if (diagnostics?.programAddress !== expectedProgramAddress) {
        throw new Error(
            `Unexpected file-share program address '${diagnostics?.programAddress}'`
        );
    }
    const listedFiles = diagnostics?.listedFiles;
    if (!Array.isArray(listedFiles)) {
        throw new Error("Missing file-share listed-file diagnostics");
    }
    const matches = listedFiles.filter((file) => file?.name === fileName);
    if (matches.length !== 1) {
        throw new Error(
            `Expected exactly one manifest for '${fileName}', found ${matches.length}`
        );
    }
    const file = matches[0];
    const sizeBytes = toSafeByteSize(file.size, "manifest");
    if (file.type !== "large" || file.ready !== true) {
        throw new Error(`Manifest for '${fileName}' is not a ready LargeFile`);
    }
    if (sizeBytes !== expectedSizeBytes) {
        throw new Error(
            `Manifest size mismatch for '${fileName}': expected ${expectedSizeBytes}, received ${sizeBytes}`
        );
    }
    if (typeof file.id !== "string" || file.id.length === 0) {
        throw new Error(`Manifest for '${fileName}' is missing its file id`);
    }
    if (expectedFileId && file.id !== expectedFileId) {
        throw new Error(
            `Manifest id mismatch for '${fileName}': expected '${expectedFileId}', received '${file.id}'`
        );
    }
    if (typeof file.finalHash !== "string" || file.finalHash.length === 0) {
        throw new Error(`Manifest for '${fileName}' is missing finalHash`);
    }
    return {
        fileId: file.id,
        sizeBytes,
        finalHash: file.finalHash,
        chunkCount: file.chunkCount,
    };
};

const waitForReadyManifest = async (
    page,
    {
        fileName,
        expectedFileId,
        expectedSizeBytes,
        expectedFinalHash,
        expectedProgramAddress,
        timeout,
    }
) => {
    const handle = await page.waitForFunction(
        ({ name, fileId, sizeBytes, finalHash, programAddress }) => {
            const hooks = window.__peerbitFileShareTestHooks;
            if (!hooks?.getLightweightSnapshot) {
                return null;
            }
            const snapshot = hooks.getLightweightSnapshot();
            if (
                snapshot?.programAddress !== programAddress ||
                snapshot?.programClosed !== false
            ) {
                return null;
            }
            const file = snapshot?.listedFiles?.find(
                (candidate) =>
                    candidate.name === name && candidate.id === fileId
            );
            if (!file || file.ready !== true) {
                return null;
            }
            if (Number(file.size) !== sizeBytes) {
                throw new Error(
                    `Reader manifest size ${file.size} does not match ${sizeBytes}`
                );
            }
            if (file.finalHash !== finalHash) {
                throw new Error(
                    `Reader manifest hash ${file.finalHash} does not match ${finalHash}`
                );
            }
            return snapshot;
        },
        {
            name: fileName,
            fileId: expectedFileId,
            sizeBytes: expectedSizeBytes,
            finalHash: expectedFinalHash,
            programAddress: expectedProgramAddress,
        },
        { polling: 50, timeout }
    );
    try {
        return await handle.jsonValue();
    } finally {
        await handle.dispose();
    }
};

const waitForTestHooks = async (page, timeout = TEST_HOOK_TIMEOUT_MS) => {
    await page.waitForFunction(
        () =>
            Boolean(
                window.__peerbitFileShareTestHooks &&
                window.__peerbitFileShareTestHooks.getDiagnostics
            ),
        undefined,
        { timeout }
    );
};

const getPageState = async (page) => {
    return await page.evaluate((maxTextLength) => {
        const hooks = window.__peerbitFileShareTestHooks;
        const appDiagnostics =
            typeof window.__peerbitFileShareAppDiagnostics === "function"
                ? window.__peerbitFileShareAppDiagnostics()
                : null;
        return {
            href: window.location.href,
            pathname: window.location.pathname,
            search: window.location.search,
            hash: window.location.hash,
            readyState: document.readyState,
            title: document.title,
            appDiagnostics,
            hookPresent: Boolean(hooks),
            hookKeys: hooks ? Object.keys(hooks) : [],
            bodyText: document.body?.innerText?.slice(0, maxTextLength) ?? "",
            listItems: Array.from(document.querySelectorAll("li"))
                .slice(0, 20)
                .map((item) => item.textContent?.trim() ?? ""),
            uploadInputPresent: Boolean(document.querySelector("#imgupload")),
            scriptSrcs: Array.from(document.scripts)
                .map((script) => script.src)
                .filter(Boolean)
                .slice(-10),
        };
    }, MAX_RECORDED_TEXT_LENGTH);
};

const createPageEventRecorder = (page) => {
    const events = [];
    const push = (event) => {
        events.push({ at: Date.now(), ...event });
        if (events.length > MAX_RECORDED_PAGE_EVENTS) {
            events.shift();
        }
    };
    page.on("console", (message) => {
        const type = message.type();
        if (!["error", "warning"].includes(type)) {
            return;
        }
        push({
            type: `console:${type}`,
            text: message.text().slice(0, MAX_RECORDED_TEXT_LENGTH),
        });
    });
    page.on("pageerror", (error) => {
        push({
            type: "pageerror",
            text:
                error instanceof Error
                    ? error.message.slice(0, MAX_RECORDED_TEXT_LENGTH)
                    : String(error).slice(0, MAX_RECORDED_TEXT_LENGTH),
        });
    });
    page.on("requestfailed", (request) => {
        const failure = request.failure();
        push({
            type: "requestfailed",
            url: request.url().slice(0, MAX_RECORDED_TEXT_LENGTH),
            method: request.method(),
            failure: failure?.errorText,
        });
    });
    return {
        getEvents: () => events.slice(),
    };
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

const expectDownloadedFile = async (
    page,
    fileName,
    expectedSizeBytes,
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

    if (download.suggestedFilename() !== fileName) {
        throw new Error(
            `Unexpected downloaded file name '${download.suggestedFilename()}'`
        );
    }
    const downloadPath = await download.path();
    const details = await stat(downloadPath);
    if (details.size !== expectedSizeBytes) {
        throw new Error(
            `Unexpected downloaded file size ${details.size} for ${fileName}`
        );
    }
    return {
        downloadPath,
        size: details.size,
        sink: "browser-download",
        fileBacked: true,
        boundedMemory: false,
        sinkCompletedAt: Date.now(),
        cleanup: () => download.delete(),
    };
};

const expectSavedViaPicker = async (
    page,
    fileName,
    expectedSizeBytes,
    timeout = 8 * 60 * 1000
) => {
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
                expectedSize: expectedSizeBytes,
            },
            { timeout }
        )
        .then(async (handle) => {
            try {
                return await handle.jsonValue();
            } finally {
                await handle.dispose();
            }
        });

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

const compactReadDiagnostics = (diagnostics) => {
    if (diagnostics === undefined) {
        return {};
    }
    if (!diagnostics || typeof diagnostics !== "object") {
        return diagnostics;
    }
    return {
        waitUntilReadyResolvedBy: diagnostics.waitUntilReadyResolvedBy,
        waitUntilReadyResolvedReady: diagnostics.waitUntilReadyResolvedReady,
        waitUntilReadyAttempts: diagnostics.waitUntilReadyAttempts,
        lastReadyProbe: diagnostics.lastReadyProbe,
        chunkAttemptTimeoutMs: diagnostics.chunkAttemptTimeoutMs,
        readAhead: diagnostics.readAhead,
        prefetchedChunkCount: diagnostics.prefetchedChunkCount,
        chunkAttemptsCount: countObjectKeys(diagnostics.chunkAttempts),
        chunkResolvedCount: countObjectKeys(diagnostics.chunkResolved),
        chunkFailure: diagnostics.chunkFailure,
        finishedAt: diagnostics.finishedAt,
    };
};

const compactDiagnostics = (diagnostics) => {
    if (!diagnostics || typeof diagnostics !== "object") {
        return diagnostics;
    }
    return {
        programAddress: diagnostics.programAddress,
        programClosed: diagnostics.programClosed,
        persistChunkReads: diagnostics.persistChunkReads,
        peerHash: diagnostics.peerHash,
        peerAddresses: tail(diagnostics.peerAddresses),
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
        readerDiagnosticsBeforeListing: compactDiagnostics(
            payload.readerDiagnosticsBeforeListing
        ),
        readerDiagnostics: compactDiagnostics(payload.readerDiagnostics),
        readerDiagnosticsAfterDownload: compactDiagnostics(
            payload.readerDiagnosticsAfterDownload
        ),
        reader: compactCoordinationPayload(payload.reader),
    };
};

const compactFailure = (failure) => {
    if (!failure || typeof failure !== "object") {
        return failure;
    }
    return {
        message:
            typeof failure.message === "string"
                ? failure.message.slice(0, 2_000)
                : String(failure.message ?? "unknown failure").slice(0, 2_000),
        stack:
            typeof failure.stack === "string"
                ? failure.stack.slice(0, 4_000)
                : undefined,
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
        fixture: payload.fixture,
        manifest: payload.manifest,
        integrity: payload.integrity,
        cohort: payload.cohort,
        topology: payload.topology,
        sink: payload.sink,
        downloadMode: payload.downloadMode,
        writerPeerAddressCount: payload.writerPeerAddressCount,
        uploadDurationMs: payload.uploadDurationMs,
        uploadMbps: payload.uploadMbps,
        downloadDurationMs: payload.downloadDurationMs,
        downloadMbps: payload.downloadMbps,
        listingWaitMs: payload.listingWaitMs,
        writerDiagnostics: compactDiagnostics(payload.writerDiagnostics),
        failure: compactFailure(payload.failure),
    };
};

const essentialCoordinationPayload = (payload) => {
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
        fixture: payload.fixture,
        manifest: payload.manifest,
        integrity: payload.integrity,
        cohort: payload.cohort,
        topology: payload.topology,
        sink: payload.sink,
        uploadDurationMs: payload.uploadDurationMs,
        uploadMbps: payload.uploadMbps,
        downloadDurationMs: payload.downloadDurationMs,
        downloadMbps: payload.downloadMbps,
        listingWaitMs: payload.listingWaitMs,
        writerDiagnostics: payload.writerDiagnostics
            ? {
                  programAddress: payload.writerDiagnostics.programAddress,
                  peerHash: payload.writerDiagnostics.peerHash,
                  peerAddresses: tail(payload.writerDiagnostics.peerAddresses),
              }
            : undefined,
        failure: compactFailure(payload.failure),
    };
};

const lastResortCoordinationPayload = (payload) => ({
    status: "failed",
    role: payload?.role,
    readerRole: payload?.readerRole,
    scenario: payload?.scenario,
    fileName:
        typeof payload?.fileName === "string"
            ? payload.fileName.slice(0, 512)
            : undefined,
    sizeBytes: payload?.sizeBytes,
    failure: {
        message:
            compactFailure(payload?.failure)?.message ??
            "Coordination payload exceeded the safe GitHub comment budget",
    },
});

const MAX_COORDINATION_BODY_BYTES = 60_000;

const makeCoordinationBody = (kind, payload) =>
    `${marker(kind)}\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;

const createCoordinationBody = (kind, payload) => {
    for (const selectPayload of [
        compactCoordinationPayload,
        minimalCoordinationPayload,
        essentialCoordinationPayload,
        lastResortCoordinationPayload,
    ]) {
        const body = makeCoordinationBody(kind, selectPayload(payload));
        if (Buffer.byteLength(body, "utf8") <= MAX_COORDINATION_BODY_BYTES) {
            return body;
        }
    }
    throw new Error(
        "Unable to fit the coordination event within the GitHub comment budget"
    );
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

const githubRequestWithResponse = async (url, init = {}) => {
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
        return { body: null, headers: response.headers };
    }
    return { body: await response.json(), headers: response.headers };
};

const githubRequest = async (url, init = {}) => {
    const { body } = await githubRequestWithResponse(url, init);
    return body;
};

const getLinkHeaderUrl = (linkHeader, rel) => {
    if (!linkHeader) {
        return undefined;
    }
    for (const part of linkHeader.split(",")) {
        const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
        if (match?.[2] === rel) {
            return match[1];
        }
    }
    return undefined;
};

const listRecentIssueComments = async (commentsUrl) => {
    const firstPageUrl = `${commentsUrl}?per_page=100`;
    const firstPage = await githubRequestWithResponse(firstPageUrl);
    const lastPageUrl = getLinkHeaderUrl(firstPage.headers.get("link"), "last");
    if (lastPageUrl && lastPageUrl !== firstPageUrl) {
        return await githubRequest(lastPageUrl);
    }
    return firstPage.body ?? [];
};

const isTrustedGithubActionsComment = (comment) =>
    comment?.user?.login === "github-actions[bot]" &&
    comment?.user?.type === "Bot";

const createGithubCoordinator = () => {
    const issueUrl = `https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${COORDINATION_ISSUE}/comments`;
    return {
        async publish(kind, payload) {
            const body = createCoordinationBody(kind, payload);
            await githubRequest(issueUrl, {
                method: "POST",
                body: JSON.stringify({ body }),
            });
        },
        async waitForAny(kinds, timeoutMs) {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const comments = await listRecentIssueComments(issueUrl);
                const parsed = comments
                    .filter(isTrustedGithubActionsComment)
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

const publishFailureEvent = async (
    coordinator,
    kind,
    payload,
    originalError
) => {
    try {
        await coordinator.publish(kind, payload);
    } catch (publishError) {
        throw new AggregateError(
            [originalError, publishError],
            `Failed to publish ${kind} coordination after: ${originalError?.message || originalError}`
        );
    }
};

const BROWSER_DIAL_TRANSPORT =
    /\/(?:ws|wss|webrtc|webrtc-direct|webtransport)(?:\/|$)/;

const getWriterPeerAddresses = (writer) => [
    ...new Set(
        (writer?.writerDiagnostics?.peerAddresses ?? [])
            .filter((address) => typeof address === "string")
            .map((address) => address.trim())
            .filter(
                (address) =>
                    address.length > 0 &&
                    address.includes("/p2p/") &&
                    BROWSER_DIAL_TRANSPORT.test(address)
            )
    ),
];

const requireWriterCohort = (writerDiagnostics, address) => {
    const peerHash = writerDiagnostics?.peerHash;
    const peerAddresses = getWriterPeerAddresses({ writerDiagnostics });
    const validationReasons = [];
    if (writerDiagnostics?.programAddress !== address) {
        validationReasons.push("writer-program-address-mismatch");
    }
    if (typeof peerHash !== "string" || peerHash.length === 0) {
        validationReasons.push("missing-writer-peer-hash");
    }
    if (peerAddresses.length === 0) {
        validationReasons.push("missing-writer-browser-dial-address");
    }
    if (validationReasons.length > 0) {
        throw new Error(
            `Invalid writer cohort: ${validationReasons.join(", ")}`
        );
    }
    return {
        valid: true,
        programAddress: address,
        writerPeerHash: peerHash,
        browserDialAddressCount: peerAddresses.length,
        validationReasons,
    };
};

const requireReaderCohort = ({
    writer,
    readerDiagnostics,
    topologyEvidence,
}) => {
    const cohort =
        READER_ROLE === "adaptive" ? "live-replicator" : "cold-observer";
    const writerPeerHash = writer?.cohort?.writerPeerHash;
    const readerPeerHash = topologyEvidence?.peerHash;
    const expectedSelfInReplicatorSet = READER_ROLE === "adaptive";
    const validationReasons = [];
    if (readerDiagnostics?.programAddress !== writer.address) {
        validationReasons.push("reader-program-address-mismatch");
    }
    if (topologyEvidence?.appConnectionState !== "ready") {
        validationReasons.push("app-dial-not-ready");
    }
    if (topologyEvidence?.peersProvided !== true) {
        validationReasons.push("app-peer-hints-not-provided");
    }
    if (topologyEvidence?.peerHintSource !== "peer") {
        validationReasons.push("app-direct-peer-hints-not-provided");
    }
    if (
        !Number.isFinite(topologyEvidence?.peerAddressCount) ||
        topologyEvidence.peerAddressCount < 1
    ) {
        validationReasons.push("no-app-peer-addresses");
    }
    if (
        !Number.isFinite(topologyEvidence?.connectionCount) ||
        topologyEvidence.connectionCount < 1
    ) {
        validationReasons.push("no-libp2p-connections");
    }
    if (typeof writerPeerHash !== "string" || writerPeerHash.length === 0) {
        validationReasons.push("missing-writer-peer-hash");
    }
    if (typeof readerPeerHash !== "string" || readerPeerHash.length === 0) {
        validationReasons.push("missing-reader-peer-hash");
    } else if (readerPeerHash === writerPeerHash) {
        validationReasons.push("writer-reader-peer-identity-reused");
    }
    if (topologyEvidence?.selfInReplicatorSet !== expectedSelfInReplicatorSet) {
        validationReasons.push(
            expectedSelfInReplicatorSet
                ? "reader-not-in-replicator-set"
                : "observer-in-replicator-set"
        );
    }
    if (validationReasons.length > 0) {
        throw new Error(
            `Invalid ${cohort} cohort: ${validationReasons.join(", ")}`
        );
    }
    return {
        name: cohort,
        valid: true,
        writerPeerHash,
        readerPeerHash,
        distinctPeerIdentities: true,
        programAddress: writer.address,
        expectedSelfInReplicatorSet,
        validationReasons,
    };
};

const waitForReaderCohort = async (
    page,
    { writer, readerDiagnostics },
    timeout = 60_000
) => {
    const deadline = Date.now() + timeout;
    let lastError;
    let topologyEvidence;
    while (Date.now() < deadline) {
        topologyEvidence = await getTopologySnapshot(page);
        try {
            const cohort = requireReaderCohort({
                writer,
                readerDiagnostics,
                topologyEvidence,
            });
            return { cohort, topologyEvidence };
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
        `Reader cohort did not become valid: ${lastError?.message || "unknown topology error"}`
    );
};

const withWriterPeerAddresses = (shareUrl, writer) => {
    const addresses = getWriterPeerAddresses(writer);
    if (addresses.length === 0) {
        return shareUrl;
    }
    const url = new URL(shareUrl);
    url.searchParams.delete("bootstrap");
    url.searchParams.set("peer", addresses.join(","));
    return url.toString();
};

const requireWriterEnvelope = (writer, expectedSizeBytes) => {
    const validationReasons = [];
    let configuredBase;
    let publishedBase;
    let publishedShare;
    try {
        configuredBase = new URL(BASE_URL);
        publishedBase = new URL(writer?.baseURL);
        publishedShare = new URL(writer?.shareUrl);
    } catch {
        validationReasons.push("invalid-writer-url");
    }
    const normalizePath = (pathname) => pathname.replace(/\/+$/, "") || "/";
    if (
        configuredBase &&
        publishedBase &&
        (publishedBase.origin !== configuredBase.origin ||
            normalizePath(publishedBase.pathname) !==
                normalizePath(configuredBase.pathname))
    ) {
        validationReasons.push("writer-base-url-mismatch");
    }
    if (
        configuredBase &&
        publishedShare &&
        (publishedShare.origin !== configuredBase.origin ||
            normalizePath(publishedShare.pathname) !==
                normalizePath(configuredBase.pathname) ||
            publishedShare.username.length > 0 ||
            publishedShare.password.length > 0)
    ) {
        validationReasons.push("writer-share-url-origin-mismatch");
    }
    if (typeof writer?.address !== "string" || writer.address.length === 0) {
        validationReasons.push("missing-writer-program-address");
    } else if (publishedShare?.hash !== `#/s/${writer.address}`) {
        validationReasons.push("writer-share-address-mismatch");
    }
    if (
        typeof writer?.fileName !== "string" ||
        !/^file-share-two-runner-\d+\.bin$/.test(writer.fileName)
    ) {
        validationReasons.push("invalid-writer-file-name");
    }
    if (writer?.sizeBytes !== expectedSizeBytes) {
        validationReasons.push("writer-size-mismatch");
    }
    if (
        typeof writer?.manifest?.fileId !== "string" ||
        writer.manifest.fileId.length === 0
    ) {
        validationReasons.push("missing-writer-file-id");
    }
    if (validationReasons.length > 0) {
        throw new Error(
            `Invalid writer coordination envelope: ${validationReasons.join(", ")}`
        );
    }
    return {
        baseURL: publishedBase.toString(),
        shareUrl: publishedShare.toString(),
        address: writer.address,
        fileName: writer.fileName,
        fileId: writer.manifest.fileId,
        sizeBytes: expectedSizeBytes,
        valid: true,
        validationReasons,
    };
};

const runWriter = async (coordinator) => {
    const fileName = `file-share-two-runner-${Date.now()}.bin`;
    let sizeBytes;
    let preparedFile;
    let browser;
    let context;
    let page;
    let writerDiagnostics;

    try {
        sizeBytes = validateLargeFileSizeMb(FILE_SIZE_MB);
        preparedFile = await createDeterministicFileOnDisk(
            fileName,
            sizeBytes,
            FIXTURE_SEED
        );
        browser = await launchChromium();
        context = await browser.newContext({ acceptDownloads: true });
        page = await context.newPage();
        await enableOpenProfiler(page);
        const entryUrl = rootUrl(BASE_URL);
        await page.goto(entryUrl, { waitUntil: "domcontentloaded" });
        await waitForCreateSpaceHook(page);
        const address = await createSpaceFromHook(
            page,
            `file-share-two-runner-${Date.now()}`
        );
        let shareUrl = new URL(entryUrl);
        shareUrl.hash = `/s/${address}`;

        await page.goto(shareUrl.toString(), { waitUntil: "domcontentloaded" });
        await waitForShareUrlPeerHints(page);
        shareUrl = new URL(page.url());
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
        const sourceDetails = await stat(preparedFile.filePath);
        const writerManifest = getReadyManifest(writerDiagnostics, {
            fileName,
            expectedSizeBytes: sizeBytes,
            expectedProgramAddress: address,
        });
        const integrity = requireIntegrity({
            stage: "writer",
            expectedSizeBytes: sizeBytes,
            sourceSizeBytes: sourceDetails.size,
            writerManifestSizeBytes: writerManifest.sizeBytes,
            sourceSha256Base64: preparedFile.fixture.sourceSha256Base64,
            writerManifestFinalHash: writerManifest.finalHash,
            sourceCrc32Hex: preparedFile.fixture.sourceCrc32Hex,
        });
        const cohort = requireWriterCohort(writerDiagnostics, address);

        const result = {
            status: "passed",
            role: "writer",
            scenario: "prod",
            baseURL: BASE_URL,
            shareUrl: shareUrl.toString(),
            address,
            fileName,
            fileSizeMb: FILE_SIZE_MB,
            sizeBytes,
            fixture: {
                mode: preparedFile.fixture.mode,
                seed: preparedFile.fixture.seed,
            },
            manifest: writerManifest,
            integrity,
            cohort,
            uploadDurationMs: uploadFinishedAt - uploadStartedAt,
            uploadMiBps: toMiBPerSecond(
                sizeBytes,
                uploadFinishedAt - uploadStartedAt
            ),
            uploadMbps: toMbps(sizeBytes, uploadFinishedAt - uploadStartedAt),
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
            const readerFailure =
                readerEvent.payload?.failure ?? readerEvent.payload;
            throw new Error(
                `Reader failed: ${readerFailure?.message || "unknown error"}`
            );
        }
        await persistResult({
            ...result,
            reader: readerEvent.payload,
        });
    } catch (error) {
        const failure = createFailure(error);
        const failureDiagnostics = page
            ? (writerDiagnostics ??
              (await getDiagnostics(page).catch(() => undefined)))
            : writerDiagnostics;
        await persistResult({
            status: "failed",
            role: "writer",
            scenario: "prod",
            fileName,
            fileSizeMb: FILE_SIZE_MB,
            sizeBytes,
            fixture: preparedFile?.fixture,
            writerDiagnostics: failureDiagnostics,
            failure,
        });
        await publishFailureEvent(
            coordinator,
            "writer-failed",
            {
                status: "failed",
                role: "writer",
                scenario: "prod",
                fileName,
                fileSizeMb: FILE_SIZE_MB,
                sizeBytes,
                failure,
            },
            error
        );
        throw error;
    } finally {
        await context?.close().catch(() => {});
        await browser?.close().catch(() => {});
        if (preparedFile) {
            await rm(preparedFile.dir, {
                recursive: true,
                force: true,
            }).catch(() => {});
        }
    }
};

const runReader = async (coordinator) => {
    const readyEvent = await coordinator.waitForAny(
        ["writer-ready", "writer-failed"],
        COORDINATION_TIMEOUT_MS
    );
    if (readyEvent.kind === "writer-failed") {
        const writerFailure = readyEvent.payload?.failure ?? readyEvent.payload;
        const failure = createFailure(
            new Error(
                `Writer failed before reader started: ${writerFailure?.message || "unknown error"}`
            )
        );
        await persistResult({
            status: "failed",
            role: "reader",
            readerRole: READER_ROLE,
            scenario: "prod",
            fileSizeMb: FILE_SIZE_MB,
            failure,
            writerFailure,
        });
        throw new Error(
            `Writer failed before reader started: ${writerFailure?.message || "unknown error"}`
        );
    }

    const writer = readyEvent.payload;
    let shareUrl = writer?.shareUrl;
    let browser;
    let context;
    let page;
    let pageEventRecorder;
    let nodeSinkController;
    let downloadCleanup;
    let usesStreamingDownload = false;
    let sizeBytes;
    let writerEnvelope;
    let validatedWriterIntegrity;
    let readerIntegrity;
    let readerManifest;
    let topology;
    let cohort;
    let sink;
    let readerDiagnostics;
    let readerDiagnosticsBeforeListing;
    let readerPageStateBeforeListing;

    try {
        sizeBytes = validateLargeFileSizeMb(FILE_SIZE_MB);
        writerEnvelope = requireWriterEnvelope(writer, sizeBytes);
        if (
            writer?.fixture?.mode !== "aes-256-ctr-v1" ||
            typeof writer?.fixture?.seed !== "string" ||
            writer.fixture.seed.length === 0
        ) {
            throw new Error(
                "Writer did not publish deterministic fixture metadata"
            );
        }
        validatedWriterIntegrity = requireIntegrity({
            stage: "writer",
            expectedSizeBytes: sizeBytes,
            sourceSizeBytes: writer?.integrity?.sourceSizeBytes,
            writerManifestSizeBytes: writer?.manifest?.sizeBytes,
            sourceSha256Base64: writer?.integrity?.sourceSha256Base64,
            writerManifestFinalHash: writer?.manifest?.finalHash,
            sourceCrc32Hex: writer?.integrity?.sourceCrc32Hex,
        });
        const validatedWriterCohort = requireWriterCohort(
            writer.writerDiagnostics,
            writer.address
        );
        const validatedWriter = {
            ...writer,
            cohort: validatedWriterCohort,
        };
        shareUrl = withWriterPeerAddresses(writer.shareUrl, writer);
        browser = await launchChromium();
        context = await browser.newContext({ acceptDownloads: true });
        page = await context.newPage();
        pageEventRecorder = createPageEventRecorder(page);
        await enableOpenProfiler(page);
        const readerRoleOptions = getReaderRoleOptions();
        usesStreamingDownload = sizeBytes >= STREAMING_DOWNLOAD_THRESHOLD_BYTES;
        if (usesStreamingDownload) {
            await context.grantPermissions(["local-network-access"], {
                origin: new URL(BASE_URL).origin,
            });
            nodeSinkController = await installNodeFileChecksumSink(page, {
                expectedName: writer.fileName,
                expectedSizeBytes: sizeBytes,
            });
        }
        await seedReplicationRole(page, writer.address, readerRoleOptions);
        await page.goto(shareUrl, { waitUntil: "domcontentloaded" });
        const readerReadyAt = Date.now();
        await waitForTestHooks(page).catch(() => undefined);
        readerDiagnosticsBeforeListing = await getDiagnostics(page).catch(
            () => undefined
        );
        readerPageStateBeforeListing = await getPageState(page).catch(
            () => undefined
        );
        await waitForReadyManifest(page, {
            fileName: writer.fileName,
            expectedFileId: writer.manifest.fileId,
            expectedSizeBytes: sizeBytes,
            expectedFinalHash: writer.manifest.finalHash,
            expectedProgramAddress: writer.address,
            timeout: UPLOAD_TIMEOUT_MS,
        });
        await waitForFileListed(page, writer.fileName, UPLOAD_TIMEOUT_MS);
        const listedAt = Date.now();
        readerDiagnostics = await getDiagnostics(page);
        readerManifest = getReadyManifest(readerDiagnostics, {
            fileName: writer.fileName,
            expectedSizeBytes: sizeBytes,
            expectedFileId: writer.manifest.fileId,
            expectedProgramAddress: writer.address,
        });
        const cohortResult = await waitForReaderCohort(page, {
            writer: validatedWriter,
            readerDiagnostics,
        });
        cohort = cohortResult.cohort;
        topology = {
            valid: true,
            evidence: cohortResult.topologyEvidence,
            validationReasons: [],
        };

        const downloadStartedAt = Date.now();
        const downloaded = usesStreamingDownload
            ? await expectSavedViaPicker(
                  page,
                  writer.fileName,
                  sizeBytes,
                  DOWNLOAD_TIMEOUT_MS
              )
            : await expectDownloadedFile(
                  page,
                  writer.fileName,
                  sizeBytes,
                  DOWNLOAD_TIMEOUT_MS
              );
        const downloadFinishedAt = downloaded.sinkCompletedAt;
        downloadCleanup = downloaded.cleanup;
        const persistedDownloadPath = usesStreamingDownload
            ? nodeSinkController?.filePath
            : downloaded.downloadPath;
        if (!persistedDownloadPath) {
            throw new Error(
                "Missing persisted download path for integrity readback"
            );
        }
        const verificationStartedAt = Date.now();
        const downloadDigests = await sha256AndCrc32File(persistedDownloadPath);
        const verificationFinishedAt = Date.now();
        sink = {
            type: downloaded.sink,
            fileBacked: downloaded.fileBacked,
            boundedMemory: downloaded.boundedMemory,
            sizeBytes: downloaded.size,
            serverWriteCalls: downloaded.serverWriteCalls,
            serverWriteDurationMs: downloaded.serverWriteDurationMs,
            localNetworkAccessGranted: usesStreamingDownload,
            completedAt: downloadFinishedAt,
            verification: "closed-file-sha256-crc32-readback",
            verificationDurationMs:
                verificationFinishedAt - verificationStartedAt,
        };
        readerIntegrity = requireIntegrity({
            stage: "reader",
            expectedSizeBytes: sizeBytes,
            sourceSizeBytes: validatedWriterIntegrity.sourceSizeBytes,
            writerManifestSizeBytes: writer.manifest.sizeBytes,
            readerManifestSizeBytes: readerManifest.sizeBytes,
            sinkSizeBytes: downloaded.size,
            sourceSha256Base64: validatedWriterIntegrity.sourceSha256Base64,
            writerManifestFinalHash: writer.manifest.finalHash,
            readerManifestFinalHash: readerManifest.finalHash,
            downloadSha256Base64: downloadDigests.sha256Base64,
            sourceCrc32Hex: validatedWriterIntegrity.sourceCrc32Hex,
            downloadCrc32Hex: downloadDigests.crc32Hex,
        });
        const readerDiagnosticsAfterDownload =
            (await getDiagnostics(page).catch(() => undefined)) ??
            readerDiagnostics;

        const result = {
            status: "passed",
            role: "reader",
            readerRole: READER_ROLE,
            scenario: "prod",
            baseURL: BASE_URL,
            shareUrl,
            address: writer.address,
            writerEnvelope,
            writerPeerAddressCount: getWriterPeerAddresses(writer).length,
            fileName: writer.fileName,
            fileSizeMb: FILE_SIZE_MB,
            fixture: writer.fixture,
            manifest: readerManifest,
            integrity: readerIntegrity,
            cohort,
            topology,
            sink,
            downloadMode: usesStreamingDownload
                ? "node-file-stream"
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
            readerDiagnosticsBeforeListing,
            readerDiagnosticsAfterDownload,
            readerPageStateBeforeListing,
            readerPageEvents: pageEventRecorder.getEvents(),
            startedAt: readerReadyAt,
            finishedAt: downloadFinishedAt,
        };

        await persistResult(result);
        await coordinator.publish("reader-complete", result);
    } catch (error) {
        const failure = createFailure(error);
        const failureDiagnostics = page
            ? ((await getDiagnostics(page).catch(() => undefined)) ??
              readerDiagnostics)
            : readerDiagnostics;
        const failurePageState = page
            ? await getPageState(page).catch(() => undefined)
            : undefined;
        const result = {
            status: "failed",
            role: "reader",
            readerRole: READER_ROLE,
            scenario: "prod",
            baseURL: BASE_URL,
            shareUrl,
            address: writer.address,
            writerEnvelope,
            writerPeerAddressCount: getWriterPeerAddresses(writer).length,
            fileName: writer.fileName,
            fileSizeMb: FILE_SIZE_MB,
            sizeBytes,
            fixture: writer.fixture,
            manifest: readerManifest,
            integrity: readerIntegrity ?? validatedWriterIntegrity,
            cohort,
            topology,
            sink,
            readerDiagnosticsBeforeListing,
            readerDiagnostics: failureDiagnostics,
            readerPageStateBeforeListing,
            readerPageStateAtFailure: failurePageState,
            readerPageEvents: pageEventRecorder?.getEvents() ?? [],
            message: failure.message,
            failure,
        };
        await persistResult(result);
        await publishFailureEvent(coordinator, "reader-failed", result, error);
        throw error;
    } finally {
        await downloadCleanup?.().catch(() => {});
        await nodeSinkController?.cleanup().catch(() => {});
        await context?.close().catch(() => {});
        await browser?.close().catch(() => {});
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

const runBrowserSinkSelfTest = async (bytes, expectedFixture) => {
    const origin = "https://two-runner-integrity.invalid";
    const fileName = "browser-sink-self-test.bin";
    const browser = await launchChromium();
    const context = await browser.newContext();
    let sinkController;
    try {
        await context.grantPermissions(["local-network-access"], { origin });
        const page = await context.newPage();
        await page.route(`${origin}/**`, (route) =>
            route.fulfill({
                contentType: "text/html",
                body: "<title>two-runner sink self-test</title>",
            })
        );
        sinkController = await installNodeFileChecksumSink(page, {
            expectedName: fileName,
            expectedSizeBytes: bytes.byteLength,
        });
        await page.goto(origin, { waitUntil: "domcontentloaded" });
        const saved = await page.evaluate(
            async ({ name, payload }) => {
                const handle = await window.showSaveFilePicker({
                    suggestedName: name,
                });
                const writable = await handle.createWritable();
                const bytes = Uint8Array.from(payload);
                const split = Math.min(17_123, bytes.byteLength);
                await writable.write(bytes.subarray(0, split));
                await writable.write(bytes.subarray(split));
                await writable.close();
                return window.__mockSavedFiles[0];
            },
            { name: fileName, payload: [...bytes] }
        );
        const persistedDigests = await sha256AndCrc32File(
            sinkController.filePath
        );
        if (
            saved?.size !== bytes.byteLength ||
            persistedDigests.sha256Base64 !==
                expectedFixture.sourceSha256Base64 ||
            persistedDigests.crc32Hex !== expectedFixture.sourceCrc32Hex
        ) {
            throw new Error(
                `Browser file-backed sink integrity mismatch: ${JSON.stringify(saved)}`
            );
        }
    } finally {
        await sinkController?.cleanup().catch(() => {});
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
    }
};

const runSelfTest = async () => {
    const assert = (condition, message) => {
        if (!condition) {
            throw new Error(message);
        }
    };
    const linkHeader =
        '<https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=2>; rel="next", <https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=5>; rel="last"';
    if (
        getLinkHeaderUrl(linkHeader, "last") !==
        "https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=5"
    ) {
        throw new Error("Expected GitHub Link header last page to parse");
    }
    const payload = {
        status: "passed",
        role: "reader",
        readerDiagnostics: {
            lastReadDiagnostics: null,
            benchmarkStats: {
                updateListCalls: Array.from({ length: 10 }, (_, index) => ({
                    index,
                })),
            },
        },
        readerDiagnosticsAfterDownload: {
            lastReadDiagnostics: null,
        },
        reader: {
            status: "passed",
            readerDiagnostics: {
                lastReadDiagnostics: null,
            },
        },
    };
    const compacted = compactCoordinationPayload(payload);
    if (compacted.readerDiagnostics.lastReadDiagnostics !== null) {
        throw new Error("Expected null reader lastReadDiagnostics to survive");
    }
    if (compacted.readerDiagnosticsAfterDownload.lastReadDiagnostics !== null) {
        throw new Error(
            "Expected null post-download lastReadDiagnostics to survive"
        );
    }
    if (compacted.reader.readerDiagnostics.lastReadDiagnostics !== null) {
        throw new Error(
            "Expected nested null reader lastReadDiagnostics to survive"
        );
    }
    if (compactReadDiagnostics(undefined) === undefined) {
        throw new Error("Expected undefined diagnostics to compact to object");
    }

    const crc32 = createCrc32();
    crc32.update(new TextEncoder().encode("1234"));
    crc32.update(new TextEncoder().encode("56789"));
    assert(crc32.digestHex() === "cbf43926", "CRC32 golden vector failed");

    const fixtureSizeBytes = 64 * 1024;
    const fixtures = [];
    let sinkController;
    try {
        const first = await createDeterministicFileOnDisk(
            "first.bin",
            fixtureSizeBytes,
            "self-test-seed"
        );
        fixtures.push(first);
        const second = await createDeterministicFileOnDisk(
            "second.bin",
            fixtureSizeBytes,
            "self-test-seed"
        );
        fixtures.push(second);
        const different = await createDeterministicFileOnDisk(
            "different.bin",
            fixtureSizeBytes,
            "different-self-test-seed"
        );
        fixtures.push(different);

        const firstBytes = await readFile(first.filePath);
        assert(
            firstBytes.byteLength === fixtureSizeBytes,
            "Deterministic fixture size mismatch"
        );
        assert(
            firstBytes.some((byte) => byte !== 0),
            "Deterministic fixture must not be all zeroes"
        );
        assert(
            first.fixture.sourceSha256Base64 ===
                second.fixture.sourceSha256Base64 &&
                first.fixture.sourceCrc32Hex === second.fixture.sourceCrc32Hex,
            "Same seed and size must produce identical fixture digests"
        );
        assert(
            first.fixture.sourceSha256Base64 !==
                different.fixture.sourceSha256Base64 &&
                first.fixture.sourceCrc32Hex !==
                    different.fixture.sourceCrc32Hex,
            "Different fixture seeds must produce different digests"
        );
        const reread = await sha256AndCrc32File(first.filePath);
        assert(
            reread.sha256Base64 === first.fixture.sourceSha256Base64 &&
                reread.crc32Hex === first.fixture.sourceCrc32Hex,
            "Streamed fixture reread digests do not match generation digests"
        );

        const fakePage = {
            addInitScript: async () => {},
            once: () => {},
        };
        sinkController = await installNodeFileChecksumSink(fakePage, {
            expectedName: "self-test-download.bin",
            expectedSizeBytes: fixtureSizeBytes,
        });
        const sinkRequest = async (action, init = {}) => {
            const response = await fetch(
                `${sinkController.endpoint}/${action}`,
                init
            );
            const body = await response.json();
            if (!response.ok) {
                throw new Error(body.error || `Sink request failed: ${action}`);
            }
            return body;
        };
        await sinkRequest("open", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "self-test-download.bin" }),
        });
        await sinkRequest("write", {
            method: "POST",
            body: firstBytes.subarray(0, 17_123),
        });
        await sinkRequest("write", {
            method: "POST",
            body: firstBytes.subarray(17_123),
        });
        const sinkResult = await sinkRequest("close", { method: "POST" });
        const sinkDigests = await sha256AndCrc32File(sinkController.filePath);
        assert(
            sinkResult.size === fixtureSizeBytes &&
                sinkDigests.sha256Base64 === first.fixture.sourceSha256Base64 &&
                sinkDigests.crc32Hex === first.fixture.sourceCrc32Hex,
            "Node file-backed sink did not preserve fixture integrity"
        );

        const validProperties = {
            stage: "reader",
            expectedSizeBytes: fixtureSizeBytes,
            sourceSizeBytes: fixtureSizeBytes,
            writerManifestSizeBytes: fixtureSizeBytes,
            readerManifestSizeBytes: fixtureSizeBytes,
            sinkSizeBytes: fixtureSizeBytes,
            sourceSha256Base64: first.fixture.sourceSha256Base64,
            writerManifestFinalHash: first.fixture.sourceSha256Base64,
            readerManifestFinalHash: first.fixture.sourceSha256Base64,
            downloadSha256Base64: sinkDigests.sha256Base64,
            sourceCrc32Hex: first.fixture.sourceCrc32Hex,
            downloadCrc32Hex: sinkDigests.crc32Hex,
        };
        const validIntegrity = evaluateIntegrity(validProperties);
        assert(
            validIntegrity.integrityVerified,
            "Matching source, manifests, and sink must pass integrity"
        );

        const mutatedBytes = Buffer.from(firstBytes);
        mutatedBytes[31] ^= 0xff;
        const mutatedPath = sinkController.filePath;
        await writeFile(mutatedPath, mutatedBytes);
        const mutated = await sha256AndCrc32File(mutatedPath);
        const corruptedIntegrity = evaluateIntegrity({
            ...validProperties,
            downloadSha256Base64: mutated.sha256Base64,
            downloadCrc32Hex: mutated.crc32Hex,
        });
        assert(
            !corruptedIntegrity.integrityVerified &&
                corruptedIntegrity.validationReasons.includes(
                    "source-download-sha256-mismatch"
                ) &&
                corruptedIntegrity.validationReasons.includes(
                    "source-download-crc32-mismatch"
                ),
            "Same-size persisted-file corruption must fail SHA256 and CRC32"
        );

        const midpoint = firstBytes.byteLength / 2;
        const reorderedPath = path.join(first.dir, "reordered.bin");
        await writeFile(
            reorderedPath,
            Buffer.concat([
                firstBytes.subarray(midpoint),
                firstBytes.subarray(0, midpoint),
            ])
        );
        const reordered = await sha256AndCrc32File(reorderedPath);
        assert(
            !evaluateIntegrity({
                ...validProperties,
                downloadSha256Base64: reordered.sha256Base64,
                downloadCrc32Hex: reordered.crc32Hex,
            }).integrityVerified,
            "Same-size chunk reordering must fail integrity"
        );
        assert(
            !evaluateIntegrity({
                ...validProperties,
                downloadSha256Base64: undefined,
            }).integrityVerified,
            "Missing download digest must fail integrity"
        );
        assert(
            !evaluateIntegrity({
                ...validProperties,
                writerManifestFinalHash: different.fixture.sourceSha256Base64,
            }).integrityVerified,
            "Writer manifest mismatch must fail integrity"
        );

        const coordinationPayload = {
            status: "passed",
            role: "writer",
            fileName: "self-test-download.bin",
            sizeBytes: fixtureSizeBytes,
            fixture: first.fixture,
            manifest: {
                fileId: "self-test-file-id",
                sizeBytes: fixtureSizeBytes,
                finalHash: first.fixture.sourceSha256Base64,
            },
            integrity: validIntegrity,
            cohort: { valid: true },
            topology: { valid: true },
            sink: { type: "node-file", sizeBytes: fixtureSizeBytes },
        };
        for (const [label, coordinated] of [
            ["compact", compactCoordinationPayload(coordinationPayload)],
            ["minimal", minimalCoordinationPayload(coordinationPayload)],
        ]) {
            assert(
                coordinated.integrity.sourceSha256Base64 ===
                    first.fixture.sourceSha256Base64 &&
                    coordinated.manifest.finalHash ===
                        first.fixture.sourceSha256Base64 &&
                    coordinated.fixture.mode === "aes-256-ctr-v1" &&
                    coordinated.sink.type === "node-file",
                `${label} coordination payload dropped integrity evidence`
            );
        }
        assert(
            isTrustedGithubActionsComment({
                user: { login: "github-actions[bot]", type: "Bot" },
            }) &&
                !isTrustedGithubActionsComment({
                    user: { login: "untrusted-user", type: "User" },
                }),
            "GitHub coordination comment authentication failed"
        );
        const envelopeAddress = "zb2rh-self-test-address";
        assert(
            requireWriterEnvelope(
                {
                    baseURL: BASE_URL,
                    shareUrl: `${BASE_URL}/#/s/${envelopeAddress}`,
                    address: envelopeAddress,
                    fileName: "file-share-two-runner-123.bin",
                    sizeBytes: fixtureSizeBytes,
                    manifest: { fileId: "self-test-file-id" },
                },
                fixtureSizeBytes
            ).valid,
            "Valid writer coordination envelope was rejected"
        );
        let rejectedForeignOrigin = false;
        try {
            requireWriterEnvelope(
                {
                    baseURL: BASE_URL,
                    shareUrl: `https://attacker.invalid/#/s/${envelopeAddress}`,
                    address: envelopeAddress,
                    fileName: "file-share-two-runner-123.bin",
                    sizeBytes: fixtureSizeBytes,
                    manifest: { fileId: "self-test-file-id" },
                },
                fixtureSizeBytes
            );
        } catch {
            rejectedForeignOrigin = true;
        }
        assert(
            rejectedForeignOrigin,
            "Foreign writer share origin must be rejected"
        );
        const noisyPayload = {
            ...coordinationPayload,
            readerPageEvents: Array.from({ length: 50 }, () => ({
                text: "🔥".repeat(2_000),
            })),
            readerPageStateAtFailure: {
                bodyText: "🔥".repeat(20_000),
            },
            failure: {
                message: "🔥".repeat(20_000),
                stack: "🔥".repeat(20_000),
            },
        };
        const boundedPayload = minimalCoordinationPayload(noisyPayload);
        assert(
            boundedPayload.readerPageEvents === undefined &&
                Buffer.byteLength(JSON.stringify(boundedPayload), "utf8") <
                    60_000,
            "Minimal coordination payload exceeded its UTF-8 byte budget"
        );
        const boundedBody = createCoordinationBody(
            "reader-failed",
            noisyPayload
        );
        const boundedEvent = parseEventBody(boundedBody);
        assert(
            Buffer.byteLength(boundedBody, "utf8") <=
                MAX_COORDINATION_BODY_BYTES &&
                boundedEvent?.kind === "reader-failed" &&
                boundedEvent?.payload?.failure?.message,
            "Final coordination body fallback is not bounded or parseable"
        );
        if (process.env.PW_TWO_RUNNER_BROWSER_SELF_TEST === "1") {
            await runBrowserSinkSelfTest(firstBytes, first.fixture);
        }
    } finally {
        await sinkController?.cleanup().catch(() => {});
        await Promise.all(
            fixtures.map((fixture) =>
                rm(fixture.dir, { recursive: true, force: true })
            )
        );
    }
    await persistResult({
        status: "passed",
        role: "self-test",
    });
};

const main = async () => {
    if (!["writer", "reader", "smoke", "self-test"].includes(MODE)) {
        throw new Error(
            `Usage: node tests/two-runner.bench.mjs <writer|reader|smoke|self-test>`
        );
    }
    if (MODE === "self-test") {
        await runSelfTest();
        return;
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
