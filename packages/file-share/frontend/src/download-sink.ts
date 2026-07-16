export type BrowserFileWriter = {
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
};

type OpfsWritable = {
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort?(reason?: unknown): Promise<void>;
};

type OpfsFileHandle = {
    createWritable(): Promise<OpfsWritable>;
    getFile(): Promise<Blob>;
};

export type OpfsDirectoryHandle = {
    getFileHandle(
        name: string,
        options?: { create?: boolean }
    ): Promise<OpfsFileHandle>;
    removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
    entries?(): AsyncIterableIterator<[string, unknown]>;
};

export type OpfsDownloadDependencies = {
    getDirectory(): Promise<OpfsDirectoryHandle>;
    createObjectURL(file: Blob): string;
    revokeObjectURL(url: string): void;
    triggerDownload(url: string, fileName: string): void;
    randomToken(): string;
    now(): number;
    schedule(callback: () => void, delayMs: number): unknown;
    acquireEntryLease?(name: string): Promise<{ release(): void }>;
    runIfEntryInactive?(
        name: string,
        callback: () => Promise<void>
    ): Promise<boolean>;
};

export type CreateOpfsDownloadWriterOptions = {
    fileName: string;
    expectedSize: bigint;
    retentionMs?: number;
};

export const DEFAULT_BOUNDED_DOWNLOAD_THRESHOLD_BYTES = 32n * 1024n * 1024n;
export const DEFAULT_OPFS_DOWNLOAD_RETENTION_MS = 5 * 60 * 1000;
export const DEFAULT_OPFS_CRASH_RECOVERY_MS = 24 * 60 * 60 * 1000;

const OPFS_DOWNLOAD_PREFIX = "peerbit-download-v1-";
const OPFS_DELIVERED_MARKER = ".delivered-";
const OPFS_STALE_RETRY_MS = 30_000;
const OPFS_LOCK_PREFIX = "peerbit-file-share-download:";
const MAX_DOWNLOAD_FILE_NAME_UTF8_BYTES = 240;
const MAX_DOWNLOAD_EXTENSION_UTF8_BYTES = 32;
const activeOpfsDownloads = new Set<string>();
let fallbackTokenSequence = 0;

type DownloadLockManager = {
    request<T>(
        name: string,
        callback: (lock: unknown) => Promise<T> | T
    ): Promise<T>;
    request<T>(
        name: string,
        options: { ifAvailable: true },
        callback: (lock: unknown | null) => Promise<T> | T
    ): Promise<T>;
};

export class BoundedDownloadUnavailableError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "BoundedDownloadUnavailableError";
    }
}

export const getBoundedDownloadThresholdBytes = (override?: number) => {
    if (typeof override === "number" && Number.isFinite(override)) {
        return BigInt(Math.max(0, Math.floor(override)));
    }
    return DEFAULT_BOUNDED_DOWNLOAD_THRESHOLD_BYTES;
};

export const requiresBoundedDownload = (
    size: number | bigint,
    thresholdOverride?: number
) =>
    (typeof size === "bigint" ? size : BigInt(size)) >=
    getBoundedDownloadThresholdBytes(thresholdOverride);

const WINDOWS_RESERVED_FILE_NAME =
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const INVALID_FILE_NAME_CHARACTERS =
    // Control characters are deliberately part of the untrusted-name filter.
    // eslint-disable-next-line no-control-regex
    /[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu;

const utf8Length = (value: string) => new TextEncoder().encode(value).length;

const truncateUtf8 = (value: string, maxBytes: number) => {
    let result = "";
    let bytes = 0;
    for (const codePoint of value) {
        const codePointBytes = utf8Length(codePoint);
        if (bytes + codePointBytes > maxBytes) {
            break;
        }
        result += codePoint;
        bytes += codePointBytes;
    }
    return result;
};

const truncateDownloadFileName = (name: string) => {
    if (utf8Length(name) <= MAX_DOWNLOAD_FILE_NAME_UTF8_BYTES) {
        return name;
    }
    const extensionOffset = name.lastIndexOf(".");
    if (extensionOffset > 0) {
        const extension = name.slice(extensionOffset);
        const extensionBytes = utf8Length(extension);
        if (extensionBytes <= MAX_DOWNLOAD_EXTENSION_UTF8_BYTES) {
            return (
                truncateUtf8(
                    name.slice(0, extensionOffset),
                    MAX_DOWNLOAD_FILE_NAME_UTF8_BYTES - extensionBytes
                ) + extension
            );
        }
    }
    return truncateUtf8(name, MAX_DOWNLOAD_FILE_NAME_UTF8_BYTES);
};

/**
 * Peer names are protocol data, not trusted local paths. Preserve ordinary
 * Unicode names while replacing characters that are invalid on a major
 * desktop filesystem, stripping bidi controls, bounding picker input by UTF-8
 * bytes without splitting a code point, and avoiding special/reserved path
 * components.
 */
export const sanitizeDownloadFileName = (name: string) => {
    let safeName = (typeof name === "string" ? name : "").replace(
        INVALID_FILE_NAME_CHARACTERS,
        "_"
    );
    safeName = safeName.replace(/[ .]+$/u, (suffix) =>
        "_".repeat(Array.from(suffix).length)
    );
    if (!safeName || safeName === "." || safeName === "..") {
        safeName = "download";
    }
    if (WINDOWS_RESERVED_FILE_NAME.test(safeName)) {
        safeName = `_${safeName}`;
    }
    return truncateDownloadFileName(safeName);
};

const isNotFoundError = (error: unknown) =>
    Boolean(
        error &&
        typeof error === "object" &&
        "name" in error &&
        error.name === "NotFoundError"
    );

const removeEntryIfPresent = async (
    directory: OpfsDirectoryHandle,
    name: string
) => {
    try {
        await directory.removeEntry(name, { recursive: false });
    } catch (error) {
        if (!isNotFoundError(error)) {
            throw error;
        }
    }
};

const parseOpfsDownloadTimestamp = (name: string) => {
    if (!name.startsWith(OPFS_DOWNLOAD_PREFIX)) {
        return undefined;
    }
    const timestampText = name
        .slice(OPFS_DOWNLOAD_PREFIX.length)
        .split("-", 1)[0];
    const timestamp = Number(timestampText);
    return Number.isSafeInteger(timestamp) && timestamp >= 0
        ? timestamp
        : undefined;
};

const parseDeliveredMarker = (name: string) => {
    const markerOffset = name.lastIndexOf(OPFS_DELIVERED_MARKER);
    if (markerOffset < 0) {
        return undefined;
    }
    const storageName = name.slice(0, markerOffset);
    if (parseOpfsDownloadTimestamp(storageName) == null) {
        return undefined;
    }
    const deliveredAt = Number(
        name.slice(markerOffset + OPFS_DELIVERED_MARKER.length)
    );
    if (!Number.isSafeInteger(deliveredAt) || deliveredAt < 0) {
        return undefined;
    }
    return { storageName, deliveredAt };
};

const getDeliveredMarkerName = (storageName: string, deliveredAt: number) =>
    `${storageName}${OPFS_DELIVERED_MARKER}${deliveredAt}`;

export type CleanupStaleOpfsDownloadOptions = {
    deliveredRetentionMs?: number;
    crashRecoveryMs?: number;
    runIfEntryInactive?: OpfsDownloadDependencies["runIfEntryInactive"];
};

export type CleanupStaleOpfsDownloadResult = {
    nextCleanupDelayMs: number | undefined;
    errors: unknown[];
};

const getNonNegativeDuration = (
    value: number | undefined,
    fallback: number,
    description: string
) => {
    const duration = value ?? fallback;
    if (!Number.isFinite(duration) || duration < 0) {
        throw new Error(`${description} must be a non-negative duration`);
    }
    return duration;
};

export const cleanupStaleOpfsDownloads = async (
    directory: OpfsDirectoryHandle,
    now: number,
    options: CleanupStaleOpfsDownloadOptions = {}
): Promise<CleanupStaleOpfsDownloadResult> => {
    if (!directory.entries) {
        return { nextCleanupDelayMs: undefined, errors: [] };
    }
    const deliveredRetentionMs = getNonNegativeDuration(
        options.deliveredRetentionMs,
        DEFAULT_OPFS_DOWNLOAD_RETENTION_MS,
        "Delivered OPFS download retention"
    );
    const crashRecoveryMs = getNonNegativeDuration(
        options.crashRecoveryMs,
        DEFAULT_OPFS_CRASH_RECOVERY_MS,
        "OPFS download crash recovery"
    );
    const names: string[] = [];
    for await (const [name] of directory.entries()) {
        names.push(name);
    }
    const dataNames = new Set<string>();
    const deliveredMarkers = new Map<
        string,
        Array<{ name: string; deliveredAt: number }>
    >();
    for (const name of names) {
        const marker = parseDeliveredMarker(name);
        if (marker) {
            const markers = deliveredMarkers.get(marker.storageName) ?? [];
            markers.push({ name, deliveredAt: marker.deliveredAt });
            deliveredMarkers.set(marker.storageName, markers);
            continue;
        }
        if (parseOpfsDownloadTimestamp(name) != null) {
            dataNames.add(name);
        }
    }

    let nextCleanupDelayMs: number | undefined;
    const scheduleRetry = (delayMs: number) => {
        const safeDelay = Math.max(1, Math.ceil(delayMs));
        nextCleanupDelayMs =
            nextCleanupDelayMs == null
                ? safeDelay
                : Math.min(nextCleanupDelayMs, safeDelay);
    };
    const cleanupErrors: unknown[] = [];
    for (const name of names) {
        if (parseDeliveredMarker(name)) {
            continue;
        }
        const createdAt = parseOpfsDownloadTimestamp(name);
        if (createdAt == null) {
            continue;
        }
        const markers = deliveredMarkers.get(name) ?? [];
        const deliveredAt = markers.reduce(
            (latest, marker) => Math.max(latest, marker.deliveredAt),
            -1
        );
        const expiresAt =
            deliveredAt >= 0
                ? deliveredAt + deliveredRetentionMs
                : createdAt + crashRecoveryMs;
        if (activeOpfsDownloads.has(name)) {
            scheduleRetry(
                expiresAt > now ? expiresAt - now : OPFS_STALE_RETRY_MS
            );
            continue;
        }
        if (expiresAt > now) {
            scheduleRetry(expiresAt - now);
            continue;
        }

        // Without cross-tab exclusion, an old unmarked file could still be a
        // very long transfer. Keep it instead of risking data corruption.
        if (deliveredAt < 0 && !options.runIfEntryInactive) {
            continue;
        }

        const remove = async () => {
            await removeEntryIfPresent(directory, name);
            for (const marker of markers) {
                await removeEntryIfPresent(directory, marker.name);
            }
        };
        try {
            const removed = options.runIfEntryInactive
                ? await options.runIfEntryInactive(name, remove)
                : (await remove(), true);
            if (!removed) {
                scheduleRetry(OPFS_STALE_RETRY_MS);
            } else {
                dataNames.delete(name);
                deliveredMarkers.delete(name);
            }
        } catch (error) {
            cleanupErrors.push(error);
            scheduleRetry(OPFS_STALE_RETRY_MS);
        }
    }

    for (const [storageName, markers] of deliveredMarkers) {
        if (dataNames.has(storageName)) {
            continue;
        }
        const deliveredAt = markers.reduce(
            (latest, marker) => Math.max(latest, marker.deliveredAt),
            -1
        );
        if (deliveredAt + deliveredRetentionMs > now) {
            scheduleRetry(deliveredAt + deliveredRetentionMs - now);
            continue;
        }
        for (const marker of markers) {
            try {
                await removeEntryIfPresent(directory, marker.name);
            } catch (error) {
                cleanupErrors.push(error);
                scheduleRetry(OPFS_STALE_RETRY_MS);
            }
        }
    }
    return { nextCleanupDelayMs, errors: cleanupErrors };
};

const getDownloadLockManager = () =>
    typeof navigator === "undefined"
        ? undefined
        : (navigator as unknown as { locks?: DownloadLockManager }).locks;

const acquireEntryLease = async (name: string) => {
    const locks = getDownloadLockManager();
    if (!locks) {
        return { release: () => {} };
    }
    let releaseLease!: () => void;
    const released = new Promise<void>((resolve) => {
        releaseLease = resolve;
    });
    let acquired!: () => void;
    let failed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
        acquired = resolve;
        failed = reject;
    });
    let lockAcquired = false;
    const holding = locks.request(
        OPFS_LOCK_PREFIX + name,
        async (lock: unknown) => {
            if (!lock) {
                throw new Error("Download entry lock was not acquired");
            }
            lockAcquired = true;
            acquired();
            await released;
        }
    );
    void holding.catch((error) => {
        if (!lockAcquired) {
            failed(error);
        } else {
            console.warn(
                "File-share download entry lock failed: " +
                    getErrorMessage(error)
            );
        }
    });
    await ready;
    let releasedOnce = false;
    return {
        release: () => {
            if (!releasedOnce) {
                releasedOnce = true;
                releaseLease();
            }
        },
    };
};

const runIfEntryInactive = async (
    name: string,
    callback: () => Promise<void>
) => {
    const locks = getDownloadLockManager();
    if (!locks) {
        return false;
    }
    try {
        return await locks.request(
            OPFS_LOCK_PREFIX + name,
            { ifAvailable: true },
            async (lock: unknown | null) => {
                if (!lock) {
                    return false;
                }
                await callback();
                return true;
            }
        );
    } catch (error) {
        console.warn(
            "Unable to inspect a stale file-share download lock: " +
                getErrorMessage(error)
        );
        return false;
    }
};

const getDefaultDependencies = (): OpfsDownloadDependencies => {
    const supportsEntryLocks = Boolean(getDownloadLockManager());
    return {
        getDirectory: async () => {
            const storage = navigator.storage as unknown as {
                getDirectory?: () => Promise<OpfsDirectoryHandle>;
            };
            if (typeof storage?.getDirectory !== "function") {
                throw new BoundedDownloadUnavailableError(
                    "This browser does not provide origin-private file storage"
                );
            }
            return storage.getDirectory.call(storage);
        },
        createObjectURL: (file) => URL.createObjectURL(file),
        revokeObjectURL: (url) => URL.revokeObjectURL(url),
        triggerDownload: (url, fileName) => {
            const link = document.createElement("a");
            link.href = url;
            link.download = fileName;
            link.rel = "noopener";
            link.style.display = "none";
            (document.body ?? document.documentElement).appendChild(link);
            try {
                link.click();
            } finally {
                link.remove();
            }
        },
        randomToken: () => {
            if (typeof globalThis.crypto?.randomUUID === "function") {
                return globalThis.crypto.randomUUID();
            }
            fallbackTokenSequence += 1;
            return `${Math.random().toString(36).slice(2)}-${fallbackTokenSequence}`;
        },
        now: () => Date.now(),
        schedule: (callback, delayMs) => setTimeout(callback, delayMs),
        acquireEntryLease: supportsEntryLocks ? acquireEntryLease : undefined,
        runIfEntryInactive: supportsEntryLocks ? runIfEntryInactive : undefined,
    };
};

const getErrorMessage = (error: unknown): string => {
    if (error instanceof AggregateError) {
        const details = error.errors.map(getErrorMessage).join("; ");
        return details ? `${error.message}: ${details}` : error.message;
    }
    return error instanceof Error ? error.message : String(error);
};

const warnCleanupErrors = (errors: unknown[]) => {
    if (errors.length === 0) {
        return;
    }
    console.warn(
        "Failed to clean one or more stale file-share downloads: " +
            errors.map(getErrorMessage).join("; ")
    );
};

/**
 * Reclaims completed downloads on app startup and schedules the next known
 * expiry. Unmarked entries use the much longer crash-recovery window and are
 * only removed while a cross-tab lease proves that no writer is active.
 */
export const cleanupOpfsDownloadsOnStartup = async (
    dependencies: OpfsDownloadDependencies = getDefaultDependencies(),
    options: CleanupStaleOpfsDownloadOptions = {}
) => {
    let directory: OpfsDirectoryHandle;
    try {
        directory = await dependencies.getDirectory();
    } catch (error) {
        if (error instanceof BoundedDownloadUnavailableError) {
            return;
        }
        throw error;
    }
    const result = await cleanupStaleOpfsDownloads(
        directory,
        dependencies.now(),
        {
            ...options,
            runIfEntryInactive:
                options.runIfEntryInactive ?? dependencies.runIfEntryInactive,
        }
    );
    warnCleanupErrors(result.errors);
    if (result.nextCleanupDelayMs != null) {
        dependencies.schedule(() => {
            void cleanupOpfsDownloadsOnStartup(dependencies, options).catch(
                (error) => {
                    console.warn(
                        "Failed to resume temporary file-share cleanup: " +
                            getErrorMessage(error)
                    );
                }
            );
        }, result.nextCleanupDelayMs);
    }
};

const createDeliveredMarker = async (
    directory: OpfsDirectoryHandle,
    storageName: string,
    deliveredAt: number
) => {
    const markerName = getDeliveredMarkerName(storageName, deliveredAt);
    const markerHandle = await directory.getFileHandle(markerName, {
        create: true,
    });
    const markerWritable = await markerHandle.createWritable();
    await markerWritable.close();
    return markerName;
};

/**
 * Streams a download into an origin-private temporary file, then exposes the
 * disk-backed File to the browser download manager. No aggregate byte array or
 * Blob is built in JavaScript memory. The temporary entry must remain until the
 * browser has consumed the object URL, so it is removed after a conservative
 * grace period and stale entries are reclaimed by later downloads.
 */
export const createOpfsDownloadWriter = async (
    options: CreateOpfsDownloadWriterOptions,
    dependencies: OpfsDownloadDependencies = getDefaultDependencies()
): Promise<BrowserFileWriter> => {
    if (options.expectedSize < 0n) {
        throw new Error("Download size must not be negative");
    }
    const retentionMs = getNonNegativeDuration(
        options.retentionMs,
        DEFAULT_OPFS_DOWNLOAD_RETENTION_MS,
        "OPFS download retention"
    );

    let directory: OpfsDirectoryHandle;
    try {
        directory = await dependencies.getDirectory();
    } catch (error) {
        if (error instanceof BoundedDownloadUnavailableError) {
            throw error;
        }
        throw new BoundedDownloadUnavailableError(
            "Unable to open origin-private storage for a bounded-memory download: " +
                getErrorMessage(error),
            { cause: error }
        );
    }

    const createdAt = dependencies.now();
    const storageName = `${OPFS_DOWNLOAD_PREFIX}${createdAt}-${dependencies.randomToken()}`;
    let handle: OpfsFileHandle;
    let writable: OpfsWritable;
    try {
        handle = await directory.getFileHandle(storageName, { create: true });
        if (
            typeof handle.createWritable !== "function" ||
            typeof handle.getFile !== "function"
        ) {
            throw new BoundedDownloadUnavailableError(
                "This browser cannot stream origin-private files from the page"
            );
        }
        writable = await handle.createWritable();
    } catch (error) {
        await removeEntryIfPresent(directory, storageName).catch(() => {});
        if (error instanceof BoundedDownloadUnavailableError) {
            throw error;
        }
        throw new BoundedDownloadUnavailableError(
            "Unable to create temporary browser storage for a bounded-memory download: " +
                getErrorMessage(error),
            { cause: error }
        );
    }

    let entryLease: { release(): void } = { release: () => {} };
    try {
        if (dependencies.acquireEntryLease) {
            entryLease = await dependencies.acquireEntryLease(storageName);
        }
    } catch (error) {
        try {
            if (writable.abort) {
                await writable.abort(error);
            } else {
                await writable.close();
            }
        } catch {
            // Removing the entry below is authoritative.
        }
        await removeEntryIfPresent(directory, storageName).catch(() => {});
        throw new BoundedDownloadUnavailableError(
            "Unable to reserve temporary browser storage for a bounded-memory download: " +
                getErrorMessage(error),
            { cause: error }
        );
    }

    activeOpfsDownloads.add(storageName);
    void cleanupStaleOpfsDownloads(directory, createdAt, {
        runIfEntryInactive: dependencies.runIfEntryInactive,
    })
        .then((result) => warnCleanupErrors(result.errors))
        .catch((error) => {
            console.warn(
                "Failed to inspect stale file-share downloads: " +
                    getErrorMessage(error)
            );
        });

    let state: "open" | "closing" | "delivered" | "aborted" = "open";
    let bytesWritten = 0n;
    let writeInFlight = false;
    let writableFinished = false;
    let objectUrl: string | undefined;
    let deliveredMarkerName: string | undefined;
    let cleanupPromise: Promise<void> | undefined;
    let cleanupRetryScheduled = false;

    const removeTemporaryEntry = () => {
        if (cleanupPromise) {
            return cleanupPromise;
        }
        const attempt = (async () => {
            try {
                if (objectUrl) {
                    try {
                        dependencies.revokeObjectURL(objectUrl);
                    } catch {
                        // OPFS cleanup remains required even if URL cleanup fails.
                    }
                    objectUrl = undefined;
                }
                const errors: unknown[] = [];
                for (const name of [storageName, deliveredMarkerName]) {
                    if (!name) {
                        continue;
                    }
                    try {
                        await removeEntryIfPresent(directory, name);
                    } catch (error) {
                        errors.push(error);
                    }
                }
                if (errors.length > 0) {
                    throw new AggregateError(
                        errors,
                        "Failed to remove temporary file-share storage"
                    );
                }
            } finally {
                activeOpfsDownloads.delete(storageName);
                entryLease.release();
            }
        })();
        cleanupPromise = attempt;
        void attempt.catch(() => {
            if (cleanupPromise === attempt) {
                cleanupPromise = undefined;
            }
        });
        return attempt;
    };

    const retryTemporaryEntryCleanup = (error: unknown) => {
        console.warn(
            "Failed to remove a temporary file-share download; retrying: " +
                getErrorMessage(error)
        );
        if (cleanupRetryScheduled) {
            return;
        }
        cleanupRetryScheduled = true;
        dependencies.schedule(() => {
            cleanupRetryScheduled = false;
            void removeTemporaryEntry().catch(retryTemporaryEntryCleanup);
        }, OPFS_STALE_RETRY_MS);
    };

    const abortWritableAndRemove = async (reason?: unknown) => {
        if (!writableFinished) {
            writableFinished = true;
            try {
                if (writable.abort) {
                    await writable.abort(reason);
                } else {
                    await writable.close();
                }
            } catch {
                // Removing the OPFS entry below is the authoritative cleanup.
            }
        }
        try {
            await removeTemporaryEntry();
        } catch (error) {
            retryTemporaryEntryCleanup(error);
            // Cleanup continues independently; a close failure must preserve
            // its original transfer error, and abort remains best-effort.
        }
    };

    return {
        write: async (data) => {
            if (state !== "open") {
                throw new Error("Cannot write to a finished browser download");
            }
            if (writeInFlight) {
                throw new Error(
                    "Concurrent browser download writes are not allowed"
                );
            }
            if (!(data instanceof Uint8Array)) {
                throw new Error("Browser downloads require Uint8Array chunks");
            }
            const nextSize = bytesWritten + BigInt(data.byteLength);
            if (nextSize > options.expectedSize) {
                throw new Error(
                    `Download exceeds its declared size of ${options.expectedSize} bytes`
                );
            }
            writeInFlight = true;
            try {
                await writable.write(data);
                bytesWritten = nextSize;
            } finally {
                writeInFlight = false;
            }
        },
        close: async () => {
            if (state !== "open") {
                throw new Error("Browser download is already finished");
            }
            if (writeInFlight) {
                throw new Error(
                    "Cannot close while a download write is active"
                );
            }
            state = "closing";
            try {
                if (bytesWritten !== options.expectedSize) {
                    throw new Error(
                        `Download size mismatch: expected ${options.expectedSize} bytes, received ${bytesWritten}`
                    );
                }
                await writable.close();
                writableFinished = true;
                const file = await handle.getFile();
                if (BigInt(file.size) !== options.expectedSize) {
                    throw new Error(
                        `Stored download size mismatch: expected ${options.expectedSize} bytes, stored ${file.size}`
                    );
                }
                try {
                    deliveredMarkerName = await createDeliveredMarker(
                        directory,
                        storageName,
                        dependencies.now()
                    );
                } catch (error) {
                    // The owner still schedules cleanup below. If it exits
                    // first, the conservative crash-recovery window applies.
                    console.warn(
                        "Failed to mark a temporary file-share download as delivered: " +
                            getErrorMessage(error)
                    );
                }
                objectUrl = dependencies.createObjectURL(file);
                dependencies.triggerDownload(
                    objectUrl,
                    sanitizeDownloadFileName(options.fileName)
                );
                state = "delivered";
                dependencies.schedule(() => {
                    void removeTemporaryEntry().catch(
                        retryTemporaryEntryCleanup
                    );
                }, retentionMs);
            } catch (error) {
                state = "aborted";
                await abortWritableAndRemove(error);
                throw error;
            }
        },
        abort: async (reason) => {
            // close() owns finalization once it starts. In particular, do not
            // revoke an object URL after the browser handoff has begun.
            if (state !== "open") {
                return;
            }
            state = "aborted";
            await abortWritableAndRemove(reason);
        },
    };
};
