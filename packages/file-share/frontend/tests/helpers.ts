import fs from "node:fs";
import { createCipheriv, createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, type Page } from "@playwright/test";
import { mkdtemp, open, rm, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type SyntheticFixtureMode = "sparse" | "deterministic";

export type SyntheticFixtureMetadata = {
    mode: "sparse-zero" | "aes-256-ctr-v1";
    seed: string | null;
    sha256Base64: string | null;
    crc32Hex: string | null;
};

type SyntheticFixtureOptions = {
    mode?: SyntheticFixtureMode;
    seed?: string;
};

const DETERMINISTIC_FIXTURE_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_DETERMINISTIC_FIXTURE_SEED = "peerbit-file-share-v1";
const CRC32_INITIAL_STATE = 0xffffffff;
const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < table.length; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) {
            value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        table[index] = value >>> 0;
    }
    return table;
})();

const updateCrc32State = (state: number, bytes: Uint8Array) => {
    let next = state >>> 0;
    for (const byte of bytes) {
        next = CRC32_TABLE[(next ^ byte) & 0xff] ^ (next >>> 8);
    }
    return next >>> 0;
};

const formatCrc32State = (state: number) =>
    ((state ^ CRC32_INITIAL_STATE) >>> 0).toString(16).padStart(8, "0");

export const createCrc32 = () => {
    let state = CRC32_INITIAL_STATE;
    return {
        update(bytes: Uint8Array) {
            state = updateCrc32State(state, bytes);
        },
        digestHex() {
            return formatCrc32State(state);
        },
    };
};

const writeFully = async (file: FileHandle, bytes: Uint8Array) => {
    let offset = 0;
    while (offset < bytes.byteLength) {
        const { bytesWritten } = await file.write(
            bytes,
            offset,
            bytes.byteLength - offset,
            null
        );
        if (bytesWritten <= 0) {
            throw new Error("Failed to make progress while writing fixture");
        }
        offset += bytesWritten;
    }
};

const writeDeterministicFixture = async (
    file: FileHandle,
    sizeBytes: number,
    seed: string
) => {
    const descriptor = `${seed}\0${sizeBytes}`;
    const key = createHash("sha256")
        .update("peerbit-file-share-fixture-key-v1\0")
        .update(descriptor)
        .digest();
    const iv = createHash("sha256")
        .update("peerbit-file-share-fixture-iv-v1\0")
        .update(descriptor)
        .digest()
        .subarray(0, 16);
    const cipher = createCipheriv("aes-256-ctr", key, iv);
    const hasher = createHash("sha256");
    const crc32 = createCrc32();
    const input = Buffer.alloc(
        Math.min(DETERMINISTIC_FIXTURE_CHUNK_BYTES, Math.max(sizeBytes, 1))
    );

    let remaining = sizeBytes;
    while (remaining > 0) {
        const length = Math.min(input.byteLength, remaining);
        const output = cipher.update(input.subarray(0, length));
        await writeFully(file, output);
        hasher.update(output);
        crc32.update(output);
        remaining -= length;
    }

    const final = cipher.final();
    if (final.byteLength > 0) {
        await writeFully(file, final);
        hasher.update(final);
        crc32.update(final);
    }
    return {
        sha256Base64: hasher.digest("base64"),
        crc32Hex: crc32.digestHex(),
    };
};

const temporaryDirectories = new Set<string>();
let temporaryDirectoryCleanupRegistered = false;

const registerTemporaryDirectory = (directory: string) => {
    temporaryDirectories.add(directory);
    if (temporaryDirectoryCleanupRegistered) {
        return;
    }
    temporaryDirectoryCleanupRegistered = true;
    process.on("exit", () => {
        for (const dir of temporaryDirectories) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch {
                // ignore best-effort cleanup failures
            }
        }
    });
};

const cleanupTemporaryDirectory = async (directory: string) => {
    await rm(directory, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
};

export function rootUrl(baseURL: string): string {
    return `${baseURL.replace(/\/$/, "")}/#/`;
}

export function withBootstrap(baseURL: string, addrs: string[]): string {
    const url = new URL(baseURL.replace(/#.*$/, ""));
    url.searchParams.set("bootstrap", addrs.join(","));
    url.hash = "/";
    return url.toString();
}

export function withPeer(baseURL: string, addrs: string[]): string {
    const url = new URL(baseURL.replace(/#.*$/, ""));
    url.searchParams.set("peer", addrs.join(","));
    url.hash = "/";
    return url.toString();
}

export async function createSyntheticFileOnDisk(
    fileName: string,
    sizeMb: number,
    options: SyntheticFixtureOptions = {}
) {
    const sizeBytes = sizeMb * 1024 * 1024;
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw new Error(`Invalid synthetic fixture size: ${sizeMb} MiB`);
    }
    const mode = options.mode ?? "sparse";
    const dir = await mkdtemp(path.join(tmpdir(), "peerbit-file-share-"));
    const filePath = path.join(dir, fileName);
    try {
        const file = await open(filePath, "w");
        let fixture: SyntheticFixtureMetadata;
        try {
            if (mode === "deterministic") {
                const seed =
                    options.seed?.trim() || DEFAULT_DETERMINISTIC_FIXTURE_SEED;
                const digests = await writeDeterministicFixture(
                    file,
                    sizeBytes,
                    seed
                );
                fixture = {
                    mode: "aes-256-ctr-v1",
                    seed,
                    ...digests,
                };
            } else {
                await file.truncate(sizeBytes);
                fixture = {
                    mode: "sparse-zero",
                    seed: null,
                    sha256Base64: null,
                    crc32Hex: null,
                };
            }
        } finally {
            await file.close();
        }
        return {
            dir,
            filePath,
            fileName,
            fixture,
        };
    } catch (error) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        throw error;
    }
}

export const sha256FileBase64 = async (filePath: string) => {
    const hasher = createHash("sha256");
    for await (const chunk of fs.createReadStream(filePath)) {
        hasher.update(chunk);
    }
    return hasher.digest("base64");
};

export const sha256AndCrc32File = async (filePath: string) => {
    const hasher = createHash("sha256");
    const crc32 = createCrc32();
    for await (const chunk of fs.createReadStream(filePath)) {
        hasher.update(chunk);
        crc32.update(chunk);
    }
    return {
        sha256Base64: hasher.digest("base64"),
        crc32Hex: crc32.digestHex(),
    };
};

export async function createSpace(
    page: Page,
    url: string,
    name: string
): Promise<string> {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const nameInput = page.getByTestId("space-name-input");
    const createButton = page.getByTestId("create-space");
    await expect(nameInput).toBeVisible({ timeout: 60_000 });
    await nameInput.fill(name);
    await expect(createButton).toBeEnabled({ timeout: 180_000 });
    await createButton.click();
    await expect(page).toHaveURL(/#\/s\//, { timeout: 180_000 });
    await page
        .getByText("Copy the URL to share all files")
        .waitFor({ timeout: 180_000 });
    return page.url();
}

export async function getSeederCount(page: Page): Promise<number> {
    const label = page.locator("span", { hasText: "Seeders:" }).first();
    await expect(label).toBeVisible({ timeout: 60_000 });
    const text = (await label.innerText()).replace(/\s+/g, " ");
    const match = text.match(/Seeders:\s*(\d+)/i);
    if (!match) {
        throw new Error(`Could not parse seeder count from "${text}"`);
    }
    return Number.parseInt(match[1], 10);
}

export async function expectSeeders(
    page: Page,
    expected: number,
    timeout = 120_000
) {
    await expect
        .poll(async () => getSeederCount(page), {
            timeout,
            message: `Expected seeder count to become ${expected}`,
        })
        .toBe(expected);
}

export async function expectSeedersAtLeast(
    page: Page,
    expected: number,
    timeout = 120_000
) {
    await expect
        .poll(async () => getSeederCount(page), {
            timeout,
            message: `Expected seeder count to reach at least ${expected}`,
        })
        .toBeGreaterThanOrEqual(expected);
}

export async function uploadSyntheticFile(
    page: Page,
    fileName: string,
    sizeMb: number
) {
    const bytes = sizeMb * 1024 * 1024;
    if (bytes <= 50 * 1024 * 1024) {
        await page.locator("#imgupload").setInputFiles({
            name: fileName,
            mimeType: "application/octet-stream",
            buffer: Buffer.alloc(bytes, 7),
        });
    } else {
        const tempFile = await createSyntheticFileOnDisk(fileName, sizeMb);
        registerTemporaryDirectory(tempFile.dir);
        await page.locator("#imgupload").setInputFiles(tempFile.filePath);
    }
    await expect(page.locator("#imgupload")).toHaveValue("");
}

export async function waitForFileListed(
    page: Page,
    fileName: string,
    timeout = 180_000
) {
    await page
        .locator("li", { hasText: fileName })
        .first()
        .waitFor({ timeout });
}

export async function waitForReadyFileListed(
    page: Page,
    fileName: string,
    expectedProgramAddress: string,
    timeout = 180_000
) {
    const snapshotHandle = await page.waitForFunction(
        ({ expectedName, expectedAddress }) => {
            const hooks = (window as any).__peerbitFileShareTestHooks;
            if (!hooks?.getLightweightSnapshot) {
                return null;
            }
            const snapshot = hooks.getLightweightSnapshot();
            const isReady = Boolean(
                snapshot?.programAddress === expectedAddress &&
                snapshot?.programClosed === false &&
                snapshot?.listedFiles?.some(
                    (file: Record<string, unknown>) =>
                        file.name === expectedName &&
                        file.ready === true &&
                        typeof file.finalHash === "string" &&
                        file.finalHash.length > 0
                )
            );
            return isReady ? snapshot : null;
        },
        { expectedName: fileName, expectedAddress: expectedProgramAddress },
        { polling: 50, timeout }
    );
    try {
        return (await snapshotHandle.jsonValue()) as Record<string, unknown>;
    } finally {
        await snapshotHandle.dispose();
    }
}

export async function waitForUploadComplete(page: Page, timeout = 600_000) {
    const progress = page.locator(
        '[data-testid="upload-progress"], .progress-root'
    );
    if ((await progress.count()) === 0) {
        return;
    }
    await progress.first().waitFor({ state: "hidden", timeout });
}

export async function setSeedMode(page: Page, seeded: boolean) {
    const byTestId = page.getByTestId("seed-toggle");
    const toggle = (await byTestId.count())
        ? byTestId
        : page.locator("button", { hasText: "Seed" }).first();
    await expect(toggle).toBeVisible({ timeout: 60_000 });
    const expected = seeded ? "on" : "off";
    const current = await toggle.getAttribute("data-state");
    if (current !== expected) {
        await toggle.click();
    }
    await expect(toggle).toHaveAttribute("data-state", expected);
}

export type DownloadSinkResult = {
    sink: "browser-download" | "opfs" | "node-file";
    size: number;
    sinkCompletedAt: number;
    downloadPath?: string;
    serverWriteCalls?: number;
    serverWriteDurationMs?: number;
    cleanup: () => Promise<void>;
};

type MockSavedFileSink = "opfs" | "node-file";

type NodeBackedSinkSession = {
    id: string;
    name: string;
    filePath: string;
    file: FileHandle | null;
    state: "open" | "closed";
    size: number;
    completedAt: number | null;
    serverWriteCalls: number;
    serverWriteDurationMs: number;
    busy: boolean;
};

type NodeBackedMockSaveFilePickerOptions = {
    expectedName: string;
    expectedSizeBytes: number;
};

type NodeBackedSinkController = {
    cleanup: () => Promise<void>;
    directory: string;
    getClosedFile: (
        storageName: string,
        expectedName: string
    ) => { filePath: string };
};

const nodeBackedSinkControllers = new WeakMap<Page, NodeBackedSinkController>();

export function armDownloadedFile(
    page: Page,
    fileName: string,
    expectedSizeMb: number,
    timeout = 8 * 60 * 1000
): Promise<DownloadSinkResult> {
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

    const completion = (async (): Promise<DownloadSinkResult> => {
        const download = await Promise.race([
            downloadPromise,
            dialogFailure,
            pageErrorFailure,
        ]);
        expect(download.suggestedFilename()).toBe(fileName);

        // `path()` resolves when Chromium has completed its own download sink.
        // Avoid `saveAs()` here: that would add a second filesystem copy to the
        // click-to-sink benchmark interval.
        const downloadPath = await download.path();
        const details = await stat(downloadPath);
        expect(details.size).toBe(expectedSizeMb * 1024 * 1024);
        return {
            sink: "browser-download",
            downloadPath,
            size: details.size,
            sinkCompletedAt: Date.now(),
            cleanup: () => download.delete(),
        };
    })();
    void completion.catch(() => {});
    return completion;
}

export async function expectDownloadedFile(
    page: Page,
    fileName: string,
    expectedSizeMb: number,
    timeout = 8 * 60 * 1000
) {
    const completion = armDownloadedFile(
        page,
        fileName,
        expectedSizeMb,
        timeout
    );
    const { button } = await getDownloadButton(page, fileName, timeout);
    await button.click();
    return completion;
}

const ignoreTimeout = <T>(promise: Promise<T>) =>
    promise.catch((error: any) => {
        if (
            error?.name === "TimeoutError" ||
            /Timeout .* exceeded/i.test(String(error?.message || ""))
        ) {
            return new Promise<T>(() => {});
        }
        throw error;
    });

const getDownloadButton = async (
    page: Page,
    fileName: string,
    timeout = 60_000
) => {
    const row = page.locator("li", { hasText: fileName }).first();
    await expect(row).toBeVisible({ timeout });
    const byTestId = row.getByTestId("download-file");
    const button =
        (await byTestId.count()) > 0 ? byTestId : row.locator("button").first();
    await expect(button).toBeEnabled({ timeout });
    return { row, button };
};

/**
 * Installs a save-file picker whose bytes are streamed to a temporary Node
 * file over loopback HTTP. Keeping the benchmark output outside browser
 * storage prevents a large download from competing with Peerbit for the same
 * origin quota while preserving backpressure at every write.
 */
export async function installNodeBackedMockSaveFilePicker(
    page: Page,
    options: NodeBackedMockSaveFilePickerOptions
) {
    if (
        !Number.isSafeInteger(options.expectedSizeBytes) ||
        options.expectedSizeBytes < 0
    ) {
        throw new Error(
            `Invalid Node benchmark sink size: ${options.expectedSizeBytes}`
        );
    }
    if (!options.expectedName || options.expectedName.length > 4096) {
        throw new Error("Invalid Node benchmark sink file name");
    }
    if (nodeBackedSinkControllers.has(page)) {
        throw new Error("A Node benchmark sink is already installed");
    }
    const directory = await mkdtemp(
        path.join(tmpdir(), "peerbit-file-share-download-")
    );
    registerTemporaryDirectory(directory);
    const routeSecret = randomUUID();
    const sessions = new Map<string, NodeBackedSinkSession>();
    let stopped = false;
    let controller: NodeBackedSinkController | undefined;

    const corsHeaders = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-allow-private-network": "true",
        "cache-control": "no-store",
    };
    const server = createServer((request, response) => {
        const respondJson = (status: number, body: unknown) => {
            response.writeHead(status, {
                ...corsHeaders,
                "content-type": "application/json",
            });
            response.end(JSON.stringify(body));
        };
        const handleRequest = async () => {
            if (request.method === "OPTIONS") {
                response.writeHead(204, corsHeaders);
                response.end();
                return;
            }

            const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
            const route = requestUrl.pathname.split("/").filter(Boolean);
            if (route.shift() !== routeSecret) {
                respondJson(404, { error: "Unknown benchmark sink route" });
                return;
            }

            const action = route.shift();
            if (action === "open" && request.method === "POST") {
                let bodyBytes = 0;
                const chunks: Buffer[] = [];
                for await (const chunk of request) {
                    const bytes = Buffer.isBuffer(chunk)
                        ? chunk
                        : Buffer.from(chunk);
                    bodyBytes += bytes.byteLength;
                    if (bodyBytes > 64 * 1024) {
                        throw new Error("Save-file picker name is too large");
                    }
                    chunks.push(bytes);
                }
                const body = JSON.parse(
                    Buffer.concat(chunks).toString("utf8") || "{}"
                ) as { name?: unknown };
                const name =
                    typeof body.name === "string" && body.name.length > 0
                        ? body.name
                        : "download.bin";
                if (name !== options.expectedName) {
                    throw new Error(
                        `Unexpected benchmark sink name: expected "${options.expectedName}", received "${name}"`
                    );
                }
                const id = randomUUID();
                const filePath = path.join(directory, id);
                const file = await open(filePath, "wx");
                sessions.set(id, {
                    id,
                    name,
                    filePath,
                    file,
                    state: "open",
                    size: 0,
                    completedAt: null,
                    serverWriteCalls: 0,
                    serverWriteDurationMs: 0,
                    busy: false,
                });
                respondJson(200, { storageName: id });
                return;
            }

            const id = route.shift();
            const session = id ? sessions.get(id) : undefined;
            if (!session) {
                respondJson(404, { error: "Unknown benchmark sink file" });
                return;
            }

            if (action === "write" && request.method === "POST") {
                if (session.state !== "open" || !session.file) {
                    throw new Error("Cannot write to a closed benchmark sink");
                }
                if (session.busy) {
                    throw new Error(
                        "Concurrent benchmark sink operations are not allowed"
                    );
                }
                session.busy = true;
                try {
                    const contentLengthValue =
                        request.headers["content-length"];
                    const contentLength = Number(contentLengthValue);
                    if (
                        !Number.isSafeInteger(contentLength) ||
                        contentLength < 0
                    ) {
                        throw new Error(
                            "Benchmark sink write is missing a valid content length"
                        );
                    }
                    if (
                        session.size + contentLength >
                        options.expectedSizeBytes
                    ) {
                        throw new Error(
                            `Benchmark sink write exceeds expected size ${options.expectedSizeBytes}`
                        );
                    }
                    const writeStartedAt = process.hrtime.bigint();
                    let written = 0;
                    for await (const chunk of request) {
                        const bytes = Buffer.isBuffer(chunk)
                            ? chunk
                            : Buffer.from(chunk);
                        if (
                            session.size + written + bytes.byteLength >
                            options.expectedSizeBytes
                        ) {
                            throw new Error(
                                `Benchmark sink write exceeds expected size ${options.expectedSizeBytes}`
                            );
                        }
                        await writeFully(session.file, bytes);
                        written += bytes.byteLength;
                    }
                    if (written !== contentLength) {
                        throw new Error(
                            `Benchmark sink request length mismatch: expected ${contentLength}, received ${written}`
                        );
                    }
                    session.size += written;
                    session.serverWriteCalls += 1;
                    session.serverWriteDurationMs +=
                        Number(process.hrtime.bigint() - writeStartedAt) / 1e6;
                    respondJson(200, { size: session.size });
                } finally {
                    session.busy = false;
                }
                return;
            }

            if (action === "close" && request.method === "POST") {
                if (session.state !== "open" || !session.file) {
                    throw new Error("Benchmark sink is already closed");
                }
                if (session.busy) {
                    throw new Error(
                        "Concurrent benchmark sink operations are not allowed"
                    );
                }
                session.busy = true;
                try {
                    if (session.size !== options.expectedSizeBytes) {
                        throw new Error(
                            `Benchmark sink size mismatch: expected ${options.expectedSizeBytes}, received ${session.size}`
                        );
                    }
                    await session.file.close();
                    session.file = null;
                    session.state = "closed";
                    const details = await stat(session.filePath);
                    if (details.size !== session.size) {
                        throw new Error(
                            `Benchmark sink size mismatch: wrote ${session.size}, stored ${details.size}`
                        );
                    }
                    session.completedAt = Date.now();
                    respondJson(200, {
                        name: session.name,
                        storageName: session.id,
                        size: details.size,
                        completedAt: session.completedAt,
                        sink: "node-file",
                        serverWriteCalls: session.serverWriteCalls,
                        serverWriteDurationMs: session.serverWriteDurationMs,
                    });
                } finally {
                    session.busy = false;
                }
                return;
            }

            if (action === "crc32" && request.method === "GET") {
                if (session.state !== "closed") {
                    throw new Error(
                        "Cannot verify CRC32 before the benchmark sink closes"
                    );
                }
                const crc32 = createCrc32();
                for await (const chunk of fs.createReadStream(
                    session.filePath
                )) {
                    crc32.update(chunk);
                }
                respondJson(200, { crc32Hex: crc32.digestHex() });
                return;
            }

            if (
                (action === "abort" && request.method === "POST") ||
                (action === "cleanup" && request.method === "DELETE")
            ) {
                if (session.file) {
                    await session.file.close().catch(() => {});
                    session.file = null;
                }
                sessions.delete(session.id);
                await rm(session.filePath, { force: true });
                respondJson(200, { removed: true });
                return;
            }

            respondJson(404, { error: "Unknown benchmark sink action" });
        };

        void handleRequest().catch((error) => {
            if (!response.headersSent) {
                respondJson(500, {
                    error:
                        error instanceof Error ? error.message : String(error),
                });
            } else {
                response.destroy(error instanceof Error ? error : undefined);
            }
        });
    });

    const stop = async () => {
        if (stopped) {
            return;
        }
        stopped = true;
        await Promise.all(
            [...sessions.values()].map(async (session) => {
                if (session.file) {
                    await session.file.close().catch(() => {});
                    session.file = null;
                }
            })
        );
        sessions.clear();
        if (server.listening) {
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections?.();
            });
        }
        if (controller && nodeBackedSinkControllers.get(page) === controller) {
            nodeBackedSinkControllers.delete(page);
        }
        await cleanupTemporaryDirectory(directory);
    };

    try {
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => {
                server.off("listening", onListening);
                reject(error);
            };
            const onListening = () => {
                server.off("error", onError);
                resolve();
            };
            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(0, "127.0.0.1");
        });
        const address = server.address();
        if (!address || typeof address === "string") {
            throw new Error("Benchmark sink did not bind a TCP port");
        }
        const endpoint = `http://127.0.0.1:${address.port}/${routeSecret}`;

        await page.addInitScript(
            ({ endpoint }) => {
                type SavedFile = {
                    name: string;
                    size: number;
                    completedAt: number;
                    storageName: string;
                    sink: "node-file";
                    serverWriteCalls: number;
                    serverWriteDurationMs: number;
                };
                const savedFiles: SavedFile[] = [];
                const activeStorageNames = new Map<string, string>();
                const request = async <T>(
                    route: string,
                    init?: RequestInit
                ): Promise<T> => {
                    const response = await fetch(`${endpoint}/${route}`, init);
                    const body = (await response.json()) as T & {
                        error?: string;
                    };
                    if (!response.ok) {
                        throw new Error(
                            body.error ??
                                `Benchmark sink request failed (${response.status})`
                        );
                    }
                    return body;
                };
                const cleanupStorageName = async (storageName: string) => {
                    await request(
                        `cleanup/${encodeURIComponent(storageName)}`,
                        {
                            method: "DELETE",
                        }
                    ).catch((error) => {
                        if (
                            !/Unknown benchmark sink file/.test(String(error))
                        ) {
                            throw error;
                        }
                    });
                };

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
                Object.defineProperty(window, "__cleanupMockSavedFile", {
                    configurable: true,
                    enumerable: false,
                    writable: false,
                    value: async (name: string) => {
                        const storageNames = new Set(
                            savedFiles
                                .filter((file) => file.name === name)
                                .map((file) => file.storageName)
                        );
                        const activeStorageName = activeStorageNames.get(name);
                        if (activeStorageName) {
                            storageNames.add(activeStorageName);
                        }
                        await Promise.all(
                            [...storageNames].map(cleanupStorageName)
                        );
                        activeStorageNames.delete(name);
                        for (
                            let index = savedFiles.length - 1;
                            index >= 0;
                            index--
                        ) {
                            if (savedFiles[index].name === name) {
                                savedFiles.splice(index, 1);
                            }
                        }
                    },
                });
                Object.defineProperty(window, "__crc32MockSavedFile", {
                    configurable: true,
                    enumerable: false,
                    writable: false,
                    value: async (name: string) => {
                        let saved: SavedFile | undefined;
                        for (
                            let index = savedFiles.length - 1;
                            index >= 0;
                            index--
                        ) {
                            if (savedFiles[index].name === name) {
                                saved = savedFiles[index];
                                break;
                            }
                        }
                        if (!saved) {
                            throw new Error(
                                `No saved Node filesystem file named "${name}"`
                            );
                        }
                        const result = await request<{ crc32Hex: string }>(
                            `crc32/${encodeURIComponent(saved.storageName)}`
                        );
                        return result.crc32Hex;
                    },
                });
                Object.defineProperty(window, "showSaveFilePicker", {
                    configurable: true,
                    enumerable: false,
                    writable: true,
                    value: async (options?: { suggestedName?: string }) => {
                        const name = options?.suggestedName ?? "download.bin";
                        const opened = await request<{
                            storageName: string;
                        }>("open", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ name }),
                        });
                        const storageName = opened.storageName;
                        activeStorageNames.set(name, storageName);
                        let writableCreated = false;
                        let writableClosed = false;
                        return {
                            createWritable: async () => {
                                if (writableCreated) {
                                    throw new Error(
                                        "Benchmark sink writable already created"
                                    );
                                }
                                writableCreated = true;
                                return {
                                    write: async (data: Uint8Array) => {
                                        if (writableClosed) {
                                            throw new Error(
                                                "Cannot write to a closed benchmark sink"
                                            );
                                        }
                                        await request(
                                            `write/${encodeURIComponent(storageName)}`,
                                            {
                                                method: "POST",
                                                body: data as unknown as BodyInit,
                                            }
                                        );
                                    },
                                    close: async () => {
                                        if (writableClosed) {
                                            throw new Error(
                                                "Benchmark sink is already closed"
                                            );
                                        }
                                        const saved = await request<SavedFile>(
                                            `close/${encodeURIComponent(storageName)}`,
                                            { method: "POST" }
                                        );
                                        writableClosed = true;
                                        savedFiles.push(saved);
                                        activeStorageNames.delete(name);
                                    },
                                    abort: async () => {
                                        if (writableClosed) {
                                            return;
                                        }
                                        writableClosed = true;
                                        try {
                                            await request(
                                                `abort/${encodeURIComponent(storageName)}`,
                                                { method: "POST" }
                                            ).catch((error) => {
                                                if (
                                                    !/Unknown benchmark sink file/.test(
                                                        String(error)
                                                    )
                                                ) {
                                                    throw error;
                                                }
                                            });
                                        } finally {
                                            activeStorageNames.delete(name);
                                        }
                                    },
                                };
                            },
                        };
                    },
                });
            },
            { endpoint }
        );
        controller = {
            cleanup: stop,
            directory,
            getClosedFile: (storageName, expectedName) => {
                const session = sessions.get(storageName);
                if (
                    !session ||
                    session.state !== "closed" ||
                    session.name !== expectedName
                ) {
                    throw new Error(
                        `Missing closed Node benchmark sink file "${expectedName}"`
                    );
                }
                return { filePath: session.filePath };
            },
        };
        nodeBackedSinkControllers.set(page, controller);
        page.once("close", () => {
            void stop().catch(() => {});
        });
        return controller;
    } catch (error) {
        await stop().catch(() => {});
        throw error;
    }
}

export async function installMockSaveFilePicker(page: Page) {
    await page.addInitScript(() => {
        type SavedFile = {
            name: string;
            size: number;
            completedAt: number;
            storageName: string;
            sink: "opfs";
        };
        const savedFiles: SavedFile[] = [];
        const activeStorageNames = new Map<string, string>();
        let fileSequence = 0;
        const crc32InitialState = 0xffffffff;
        const crc32Table = (() => {
            const table = new Uint32Array(256);
            for (let index = 0; index < table.length; index++) {
                let value = index;
                for (let bit = 0; bit < 8; bit++) {
                    value =
                        value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
                }
                table[index] = value >>> 0;
            }
            return table;
        })();
        const updateCrc32 = (state: number, bytes: Uint8Array) => {
            let next = state >>> 0;
            for (const byte of bytes) {
                next = crc32Table[(next ^ byte) & 0xff] ^ (next >>> 8);
            }
            return next >>> 0;
        };
        const formatCrc32 = (state: number) =>
            ((state ^ crc32InitialState) >>> 0).toString(16).padStart(8, "0");
        const getRoot = () =>
            (
                navigator.storage as StorageManager & {
                    getDirectory(): Promise<any>;
                }
            ).getDirectory();
        const removeStoredEntry = async (root: any, storageName: string) => {
            try {
                await root.removeEntry(storageName, { recursive: false });
            } catch (error) {
                if (
                    !(error instanceof DOMException) ||
                    error.name !== "NotFoundError"
                ) {
                    throw error;
                }
            }
        };
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
        Object.defineProperty(window, "__cleanupMockSavedFile", {
            configurable: true,
            enumerable: false,
            writable: false,
            value: async (name: string) => {
                const storageNames = new Set(
                    savedFiles
                        .filter((file) => file.name === name)
                        .map((file) => file.storageName)
                );
                const activeStorageName = activeStorageNames.get(name);
                if (activeStorageName) {
                    storageNames.add(activeStorageName);
                }
                if (storageNames.size > 0) {
                    const root = await getRoot();
                    await Promise.all(
                        [...storageNames].map((storageName) =>
                            removeStoredEntry(root, storageName)
                        )
                    );
                }
                activeStorageNames.delete(name);
                for (let index = savedFiles.length - 1; index >= 0; index--) {
                    if (savedFiles[index].name === name) {
                        savedFiles.splice(index, 1);
                    }
                }
            },
        });
        Object.defineProperty(window, "__crc32MockSavedFile", {
            configurable: true,
            enumerable: false,
            writable: false,
            value: async (name: string) => {
                let saved: SavedFile | undefined;
                for (let index = savedFiles.length - 1; index >= 0; index--) {
                    if (savedFiles[index].name === name) {
                        saved = savedFiles[index];
                        break;
                    }
                }
                if (!saved) {
                    throw new Error(`No saved OPFS file named "${name}"`);
                }

                const root = await getRoot();
                const fileHandle = await root.getFileHandle(saved.storageName);
                const file = await fileHandle.getFile();
                const reader = file.stream().getReader();
                let state = crc32InitialState;
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            break;
                        }
                        if (value?.byteLength) {
                            state = updateCrc32(state, value);
                        }
                    }
                } finally {
                    reader.releaseLock();
                }
                return formatCrc32(state);
            },
        });
        Object.defineProperty(window, "showSaveFilePicker", {
            configurable: true,
            enumerable: false,
            writable: true,
            value: async (options?: { suggestedName?: string }) => {
                const name = options?.suggestedName ?? "download.bin";
                const storageName = `peerbit-file-share-${Date.now()}-${fileSequence++}`;
                const root = await getRoot();
                const fileHandle = await root.getFileHandle(storageName, {
                    create: true,
                });
                activeStorageNames.set(name, storageName);
                return {
                    createWritable: async () => {
                        const writable = await fileHandle.createWritable();
                        return {
                            write: async (data: Uint8Array) => {
                                await writable.write(data);
                            },
                            close: async () => {
                                await writable.close();
                                const saved = await fileHandle.getFile();
                                savedFiles.push({
                                    name,
                                    size: saved.size,
                                    completedAt: Date.now(),
                                    storageName,
                                    sink: "opfs",
                                });
                                activeStorageNames.delete(name);
                            },
                            abort: async (reason?: unknown) => {
                                try {
                                    await writable.abort(reason);
                                } finally {
                                    await removeStoredEntry(
                                        root,
                                        storageName
                                    ).catch(() => {});
                                    activeStorageNames.delete(name);
                                }
                            },
                        };
                    },
                };
            },
        });
    });
}

export const crc32SavedViaPicker = async (page: Page, fileName: string) =>
    page.evaluate(async (expectedName) => {
        const crc32 = (
            window as unknown as {
                __crc32MockSavedFile?: (name: string) => Promise<string>;
            }
        ).__crc32MockSavedFile;
        if (!crc32) {
            throw new Error("Missing save-file picker CRC32 readback hook");
        }
        return crc32(expectedName);
    }, fileName);

export function armSavedViaPicker(
    page: Page,
    fileName: string,
    expectedSizeMb: number,
    timeout = 8 * 60 * 1000
): Promise<DownloadSinkResult> {
    const expectedBytes = expectedSizeMb * 1024 * 1024;
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
    const pageCrashFailure = ignoreTimeout(
        page.waitForEvent("crash", { timeout }).then(() => {
            throw new Error("Download page crashed before sink completion");
        })
    );
    const streamedSave = page
        .waitForFunction(
            (expectedName) => {
                const savedFiles =
                    (
                        window as unknown as {
                            __mockSavedFiles?: Array<{
                                name: string;
                                size: number;
                                completedAt: number;
                                storageName: string;
                                sink: MockSavedFileSink;
                                serverWriteCalls?: number;
                                serverWriteDurationMs?: number;
                            }>;
                        }
                    ).__mockSavedFiles ?? [];
                return (
                    savedFiles.find((file) => file.name === expectedName) ??
                    null
                );
            },
            fileName,
            { polling: 25, timeout }
        )
        .then(async (handle) => {
            try {
                return await handle.jsonValue();
            } finally {
                await handle.dispose();
            }
        });
    void streamedSave.catch(() => {});

    const completion = Promise.race([
        streamedSave,
        dialogFailure,
        pageErrorFailure,
        pageCrashFailure,
    ]).then((saved): DownloadSinkResult => {
        expect(saved.size).toBe(expectedBytes);
        const nodeSink =
            saved.sink === "node-file"
                ? nodeBackedSinkControllers.get(page)
                : undefined;
        if (saved.sink === "node-file" && !nodeSink) {
            throw new Error("Missing Node benchmark sink controller");
        }
        const downloadPath = nodeSink?.getClosedFile(
            saved.storageName,
            fileName
        ).filePath;
        return {
            sink: saved.sink,
            downloadPath,
            size: saved.size,
            sinkCompletedAt: saved.completedAt,
            serverWriteCalls: saved.serverWriteCalls,
            serverWriteDurationMs: saved.serverWriteDurationMs,
            cleanup: async () => {
                await page.evaluate(async (expectedName) => {
                    const cleanup = (
                        window as unknown as {
                            __cleanupMockSavedFile?: (
                                name: string
                            ) => Promise<void>;
                        }
                    ).__cleanupMockSavedFile;
                    if (!cleanup) {
                        throw new Error(
                            "Missing save-file picker cleanup hook"
                        );
                    }
                    await cleanup(expectedName);
                }, fileName);
            },
        };
    });
    void completion.catch(() => {});
    return completion;
}

export async function expectSavedViaPicker(
    page: Page,
    fileName: string,
    expectedSizeMb: number,
    timeout = 8 * 60 * 1000
) {
    const completion = armSavedViaPicker(
        page,
        fileName,
        expectedSizeMb,
        timeout
    );
    const { button } = await getDownloadButton(page, fileName, timeout);
    await button.click();
    return completion;
}
