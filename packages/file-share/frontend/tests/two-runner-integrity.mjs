import fs from "node:fs";
import { createCipheriv, createHash, randomUUID } from "node:crypto";
import { open, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const MEBIBYTE_BYTES = 1024 * 1024;
const TINY_FILE_SIZE_LIMIT_BYTES = 5_000_000;
const FIXTURE_CHUNK_BYTES = MEBIBYTE_BYTES;
const DEFAULT_FIXTURE_SEED = "peerbit-file-share-v1";
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

const updateCrc32State = (state, bytes) => {
    let next = state >>> 0;
    for (const byte of bytes) {
        next = CRC32_TABLE[(next ^ byte) & 0xff] ^ (next >>> 8);
    }
    return next >>> 0;
};

const formatCrc32State = (state) =>
    ((state ^ CRC32_INITIAL_STATE) >>> 0).toString(16).padStart(8, "0");

export const createCrc32 = () => {
    let state = CRC32_INITIAL_STATE;
    return {
        update(bytes) {
            state = updateCrc32State(state, bytes);
        },
        digestHex() {
            return formatCrc32State(state);
        },
    };
};

const writeFully = async (file, bytes) => {
    let offset = 0;
    while (offset < bytes.byteLength) {
        const { bytesWritten } = await file.write(
            bytes,
            offset,
            bytes.byteLength - offset,
            null
        );
        if (bytesWritten <= 0) {
            throw new Error(
                "Failed to make progress while writing benchmark data"
            );
        }
        offset += bytesWritten;
    }
};

export const validateLargeFileSizeMb = (sizeMb) => {
    const sizeBytes = sizeMb * MEBIBYTE_BYTES;
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw new Error(
            `Invalid PW_FILE_MB='${sizeMb}': expected a safe-integer byte size`
        );
    }
    if (sizeBytes <= TINY_FILE_SIZE_LIMIT_BYTES) {
        throw new Error(
            `Invalid PW_FILE_MB='${sizeMb}': the two-runner integrity benchmark requires the LargeFile manifest path (use 6 MiB or larger)`
        );
    }
    return sizeBytes;
};

export const createDeterministicFileOnDisk = async (
    fileName,
    sizeBytes,
    seed = DEFAULT_FIXTURE_SEED
) => {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw new Error(`Invalid deterministic fixture size: ${sizeBytes}`);
    }
    if (!seed.trim()) {
        throw new Error("Deterministic fixture seed must not be empty");
    }
    if (path.basename(fileName) !== fileName) {
        throw new Error("Deterministic fixture name must not contain a path");
    }

    const dir = await mkdtemp(path.join(tmpdir(), "peerbit-file-share-"));
    const filePath = path.join(dir, fileName);
    try {
        const file = await open(filePath, "wx");
        try {
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
            const sha256 = createHash("sha256");
            const crc32 = createCrc32();
            const zeroes = Buffer.alloc(
                Math.min(FIXTURE_CHUNK_BYTES, Math.max(sizeBytes, 1))
            );

            let remaining = sizeBytes;
            while (remaining > 0) {
                const length = Math.min(zeroes.byteLength, remaining);
                const output = cipher.update(zeroes.subarray(0, length));
                await writeFully(file, output);
                sha256.update(output);
                crc32.update(output);
                remaining -= length;
            }

            const final = cipher.final();
            if (final.byteLength > 0) {
                await writeFully(file, final);
                sha256.update(final);
                crc32.update(final);
            }

            return {
                dir,
                filePath,
                fileName,
                fixture: {
                    mode: "aes-256-ctr-v1",
                    seed,
                    sizeBytes,
                    sourceSha256Base64: sha256.digest("base64"),
                    sourceCrc32Hex: crc32.digestHex(),
                },
            };
        } finally {
            await file.close();
        }
    } catch (error) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        throw error;
    }
};

export const sha256AndCrc32File = async (filePath) => {
    const sha256 = createHash("sha256");
    const crc32 = createCrc32();
    for await (const chunk of fs.createReadStream(filePath)) {
        sha256.update(chunk);
        crc32.update(chunk);
    }
    return {
        sha256Base64: sha256.digest("base64"),
        crc32Hex: crc32.digestHex(),
    };
};

const isSha256Base64 = (value) => {
    if (typeof value !== "string" || value.length === 0) {
        return false;
    }
    try {
        const bytes = Buffer.from(value, "base64");
        return bytes.byteLength === 32 && bytes.toString("base64") === value;
    } catch {
        return false;
    }
};

const isCrc32Hex = (value) =>
    typeof value === "string" && /^[0-9a-f]{8}$/.test(value);

export const evaluateIntegrity = (properties) => {
    const {
        stage,
        expectedSizeBytes,
        sourceSizeBytes,
        writerManifestSizeBytes,
        readerManifestSizeBytes,
        sinkSizeBytes,
        sourceSha256Base64,
        writerManifestFinalHash,
        readerManifestFinalHash,
        downloadSha256Base64,
        sourceCrc32Hex,
        downloadCrc32Hex,
    } = properties;
    const validationReasons = [];
    const requireReader = stage === "reader";

    if (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 0) {
        validationReasons.push("invalid-expected-size");
    }
    if (sourceSizeBytes !== expectedSizeBytes) {
        validationReasons.push("source-size-mismatch");
    }
    if (writerManifestSizeBytes !== expectedSizeBytes) {
        validationReasons.push("writer-manifest-size-mismatch");
    }
    if (requireReader && readerManifestSizeBytes !== expectedSizeBytes) {
        validationReasons.push("reader-manifest-size-mismatch");
    }
    if (requireReader && sinkSizeBytes !== expectedSizeBytes) {
        validationReasons.push("sink-size-mismatch");
    }
    if (!isSha256Base64(sourceSha256Base64)) {
        validationReasons.push("invalid-source-sha256");
    }
    if (!isSha256Base64(writerManifestFinalHash)) {
        validationReasons.push("invalid-writer-manifest-final-hash");
    }
    if (sourceSha256Base64 !== writerManifestFinalHash) {
        validationReasons.push("source-writer-manifest-sha256-mismatch");
    }
    if (!isCrc32Hex(sourceCrc32Hex)) {
        validationReasons.push("invalid-source-crc32");
    }

    if (requireReader) {
        if (!isSha256Base64(readerManifestFinalHash)) {
            validationReasons.push("invalid-reader-manifest-final-hash");
        }
        if (sourceSha256Base64 !== readerManifestFinalHash) {
            validationReasons.push("source-reader-manifest-sha256-mismatch");
        }
        if (writerManifestFinalHash !== readerManifestFinalHash) {
            validationReasons.push("writer-reader-manifest-sha256-mismatch");
        }
        if (!isSha256Base64(downloadSha256Base64)) {
            validationReasons.push("invalid-download-sha256");
        }
        if (sourceSha256Base64 !== downloadSha256Base64) {
            validationReasons.push("source-download-sha256-mismatch");
        }
        if (!isCrc32Hex(downloadCrc32Hex)) {
            validationReasons.push("invalid-download-crc32");
        }
        if (sourceCrc32Hex !== downloadCrc32Hex) {
            validationReasons.push("source-download-crc32-mismatch");
        }
    }

    return {
        stage,
        expectedSizeBytes,
        sourceSizeBytes,
        writerManifestSizeBytes,
        readerManifestSizeBytes: requireReader
            ? readerManifestSizeBytes
            : undefined,
        sinkSizeBytes: requireReader ? sinkSizeBytes : undefined,
        sourceSha256Base64,
        writerManifestFinalHash,
        readerManifestFinalHash: requireReader
            ? readerManifestFinalHash
            : undefined,
        downloadSha256Base64: requireReader ? downloadSha256Base64 : undefined,
        sourceCrc32Hex,
        downloadCrc32Hex: requireReader ? downloadCrc32Hex : undefined,
        sourceWriterManifestMatch:
            isSha256Base64(sourceSha256Base64) &&
            sourceSha256Base64 === writerManifestFinalHash,
        sourceReaderManifestMatch: requireReader
            ? isSha256Base64(sourceSha256Base64) &&
              sourceSha256Base64 === readerManifestFinalHash
            : undefined,
        writerReaderManifestMatch: requireReader
            ? isSha256Base64(writerManifestFinalHash) &&
              writerManifestFinalHash === readerManifestFinalHash
            : undefined,
        sourceDownloadSha256Match: requireReader
            ? isSha256Base64(sourceSha256Base64) &&
              sourceSha256Base64 === downloadSha256Base64
            : undefined,
        sourceDownloadCrc32Match: requireReader
            ? isCrc32Hex(sourceCrc32Hex) && sourceCrc32Hex === downloadCrc32Hex
            : undefined,
        integrityVerified: validationReasons.length === 0,
        validationReasons,
    };
};

export const requireIntegrity = (properties) => {
    const integrity = evaluateIntegrity(properties);
    if (!integrity.integrityVerified) {
        throw new Error(
            `File-share benchmark integrity failed: ${integrity.validationReasons.join(", ")}`
        );
    }
    return integrity;
};

const readJsonBody = async (request, maxBytes = 64 * 1024) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > maxBytes) {
            throw new Error("Benchmark sink request body is too large");
        }
        chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
};

export const installNodeFileChecksumSink = async (
    page,
    { expectedName, expectedSizeBytes }
) => {
    if (!expectedName || path.basename(expectedName) !== expectedName) {
        throw new Error("Invalid benchmark sink file name");
    }
    if (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 0) {
        throw new Error("Invalid benchmark sink size");
    }

    const directory = await mkdtemp(
        path.join(tmpdir(), "peerbit-file-share-download-")
    );
    const filePath = path.join(directory, randomUUID());
    const routeSecret = randomUUID();
    let file;
    let state = "idle";
    let size = 0;
    let busy = false;
    let result;
    let serverWriteCalls = 0;
    let serverWriteDurationMs = 0;
    let stopped = false;

    const corsHeaders = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-allow-private-network": "true",
        "cache-control": "no-store",
    };
    const server = createServer((request, response) => {
        const respondJson = (status, body) => {
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
                if (state !== "idle") {
                    throw new Error("Benchmark sink can only be opened once");
                }
                const body = await readJsonBody(request);
                if (body.name !== expectedName) {
                    throw new Error(
                        `Unexpected benchmark sink name: expected '${expectedName}', received '${body.name}'`
                    );
                }
                file = await open(filePath, "wx");
                state = "open";
                respondJson(200, { opened: true });
                return;
            }

            if (action === "write" && request.method === "POST") {
                if (state !== "open" || !file) {
                    throw new Error("Cannot write to a closed benchmark sink");
                }
                if (busy) {
                    throw new Error(
                        "Concurrent benchmark sink writes are not allowed"
                    );
                }
                const contentLength = Number(request.headers["content-length"]);
                if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
                    throw new Error(
                        "Benchmark sink write is missing a valid content length"
                    );
                }
                if (size + contentLength > expectedSizeBytes) {
                    throw new Error(
                        "Benchmark sink write exceeds expected size"
                    );
                }

                busy = true;
                const startedAt = process.hrtime.bigint();
                let received = 0;
                try {
                    for await (const chunk of request) {
                        const bytes = Buffer.isBuffer(chunk)
                            ? chunk
                            : Buffer.from(chunk);
                        if (
                            size + received + bytes.byteLength >
                            expectedSizeBytes
                        ) {
                            throw new Error(
                                "Benchmark sink write exceeds expected size"
                            );
                        }
                        await writeFully(file, bytes);
                        received += bytes.byteLength;
                    }
                    if (received !== contentLength) {
                        throw new Error(
                            `Benchmark sink request length mismatch: expected ${contentLength}, received ${received}`
                        );
                    }
                    size += received;
                    serverWriteCalls += 1;
                    serverWriteDurationMs +=
                        Number(process.hrtime.bigint() - startedAt) / 1e6;
                    respondJson(200, { size });
                } finally {
                    busy = false;
                }
                return;
            }

            if (action === "close" && request.method === "POST") {
                if (state !== "open" || !file) {
                    throw new Error("Benchmark sink is not open");
                }
                if (busy) {
                    throw new Error("Benchmark sink is busy");
                }
                if (size !== expectedSizeBytes) {
                    throw new Error(
                        `Benchmark sink size mismatch: expected ${expectedSizeBytes}, received ${size}`
                    );
                }
                await file.close();
                file = undefined;
                const details = await stat(filePath);
                if (details.size !== expectedSizeBytes) {
                    throw new Error(
                        `Stored benchmark sink size mismatch: expected ${expectedSizeBytes}, received ${details.size}`
                    );
                }
                state = "closed";
                result = {
                    name: expectedName,
                    size: details.size,
                    sink: "node-file",
                    fileBacked: true,
                    boundedMemory: true,
                    serverWriteCalls,
                    serverWriteDurationMs,
                    sinkCompletedAt: Date.now(),
                };
                respondJson(200, result);
                return;
            }

            if (action === "abort" && request.method === "POST") {
                if (file) {
                    await file.close().catch(() => {});
                    file = undefined;
                }
                state = "aborted";
                await rm(filePath, { force: true });
                respondJson(200, { aborted: true });
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

    const cleanup = async () => {
        if (stopped) {
            return;
        }
        stopped = true;
        if (file) {
            await file.close().catch(() => {});
            file = undefined;
        }
        if (server.listening) {
            await new Promise((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections?.();
            });
        }
        await rm(directory, { recursive: true, force: true });
    };

    try {
        await new Promise((resolve, reject) => {
            const onError = (error) => {
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
                const savedFiles = [];
                const request = async (action, init) => {
                    const response = await fetch(`${endpoint}/${action}`, init);
                    const body = await response.json();
                    if (!response.ok) {
                        throw new Error(
                            body.error ??
                                `Benchmark sink request failed (${response.status})`
                        );
                    }
                    return body;
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
                Object.defineProperty(window, "showSaveFilePicker", {
                    configurable: true,
                    enumerable: false,
                    writable: true,
                    value: async (options) => {
                        const name = options?.suggestedName ?? "download.bin";
                        await request("open", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ name }),
                        });
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
                                    write: async (data) => {
                                        if (writableClosed) {
                                            throw new Error(
                                                "Cannot write to a closed benchmark sink"
                                            );
                                        }
                                        await request("write", {
                                            method: "POST",
                                            body: data,
                                        });
                                    },
                                    close: async () => {
                                        if (writableClosed) {
                                            throw new Error(
                                                "Benchmark sink is already closed"
                                            );
                                        }
                                        const saved = await request("close", {
                                            method: "POST",
                                        });
                                        writableClosed = true;
                                        savedFiles.push(saved);
                                    },
                                    abort: async () => {
                                        if (writableClosed) {
                                            return;
                                        }
                                        writableClosed = true;
                                        await request("abort", {
                                            method: "POST",
                                        }).catch(() => {});
                                    },
                                };
                            },
                        };
                    },
                });
            },
            { endpoint }
        );
        page.once("close", () => {
            void cleanup().catch(() => {});
        });
        return {
            cleanup,
            directory,
            endpoint,
            filePath,
            getResult: () => result,
        };
    } catch (error) {
        await cleanup().catch(() => {});
        throw error;
    }
};
