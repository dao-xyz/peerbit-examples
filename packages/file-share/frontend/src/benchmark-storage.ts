export const FILE_SHARE_BENCHMARK_STORAGE_MODE_HOOK =
    "__peerbitFileShareBenchmarkStorageMode" as const;

export type FileShareBenchmarkStorageMode = "memory" | "opfs";

type BenchmarkStorageModeWindow = Window & {
    [FILE_SHARE_BENCHMARK_STORAGE_MODE_HOOK]?: unknown;
};

const MAX_BENCHMARK_STORAGE_ERROR_LENGTH = 512;

const getBoundedErrorMessage = (error: unknown) => {
    try {
        const message =
            error instanceof Error
                ? error.message
                : typeof error === "string"
                  ? error
                  : String(error);
        return (message || "Unknown error").slice(
            0,
            MAX_BENCHMARK_STORAGE_ERROR_LENGTH
        );
    } catch {
        return "Error message could not be read";
    }
};

export const getFileShareBenchmarkStorageMode = (
    target: Window = window
): FileShareBenchmarkStorageMode | null => {
    let value: unknown;
    try {
        value = (target as BenchmarkStorageModeWindow)[
            FILE_SHARE_BENCHMARK_STORAGE_MODE_HOOK
        ];
    } catch (error) {
        throw new Error(
            `Unable to read ${FILE_SHARE_BENCHMARK_STORAGE_MODE_HOOK}: ${getBoundedErrorMessage(
                error
            )}`
        );
    }
    if (value === undefined) {
        return null;
    }
    if (value === "memory" || value === "opfs") {
        return value;
    }
    throw new Error(
        `Invalid ${FILE_SHARE_BENCHMARK_STORAGE_MODE_HOOK}; expected "memory" or "opfs"`
    );
};

export type FileShareBenchmarkPersistedEvidence = {
    api: string;
    available: boolean;
    persisted: boolean | null;
    error: string | null;
};

export type FileShareBenchmarkStorageBackendEvidence = {
    requestedMode: FileShareBenchmarkStorageMode | null;
    directoryConfigured: boolean | null;
    directoryConfigurationError: string | null;
    persistence: {
        navigatorStorage: FileShareBenchmarkPersistedEvidence;
        peerStorage: FileShareBenchmarkPersistedEvidence;
        peerBlocks: FileShareBenchmarkPersistedEvidence;
        peerIndexer: FileShareBenchmarkPersistedEvidence;
    };
};

const probePersisted = async (
    api: string,
    getOwner: () => unknown
): Promise<FileShareBenchmarkPersistedEvidence> => {
    let available = false;
    try {
        const owner = getOwner();
        const persisted = (owner as { persisted?: unknown } | null | undefined)
            ?.persisted;
        if (typeof persisted !== "function") {
            return {
                api,
                available: false,
                persisted: null,
                error: null,
            };
        }
        available = true;
        const value = await persisted.call(owner);
        if (typeof value !== "boolean") {
            throw new Error(`${api} returned a non-boolean value`);
        }
        return {
            api,
            available: true,
            persisted: value,
            error: null,
        };
    } catch (error) {
        return {
            api,
            available,
            persisted: null,
            error: getBoundedErrorMessage(error),
        };
    }
};

export const getFileShareBenchmarkStorageBackendEvidence = async ({
    peer,
    requestedMode,
    navigatorStorage = typeof navigator === "undefined"
        ? undefined
        : navigator.storage,
}: {
    peer: unknown;
    requestedMode: FileShareBenchmarkStorageMode | null;
    navigatorStorage?: Pick<StorageManager, "persisted">;
}): Promise<FileShareBenchmarkStorageBackendEvidence> => {
    let directoryConfigured: boolean | null = null;
    let directoryConfigurationError: string | null = null;
    if (peer != null) {
        try {
            const directory = (peer as { directory?: unknown }).directory;
            directoryConfigured =
                directory == null
                    ? false
                    : typeof directory === "string" && directory.length > 0;
            if (directory != null && typeof directory !== "string") {
                directoryConfigurationError = "peer.directory was not a string";
                directoryConfigured = null;
            }
        } catch (error) {
            directoryConfigurationError = getBoundedErrorMessage(error);
        }
    }

    const [
        navigatorStorageEvidence,
        peerStorageEvidence,
        peerBlocksEvidence,
        peerIndexerEvidence,
    ] = await Promise.all([
        probePersisted("navigator.storage.persisted", () => navigatorStorage),
        probePersisted("peer.storage.persisted", () =>
            peer == null ? undefined : (peer as { storage?: unknown }).storage
        ),
        probePersisted("peer.services.blocks.persisted", () =>
            peer == null
                ? undefined
                : (peer as { services?: { blocks?: unknown } }).services?.blocks
        ),
        probePersisted("peer.indexer.persisted", () =>
            peer == null ? undefined : (peer as { indexer?: unknown }).indexer
        ),
    ]);

    return {
        requestedMode,
        directoryConfigured,
        directoryConfigurationError,
        persistence: {
            navigatorStorage: navigatorStorageEvidence,
            peerStorage: peerStorageEvidence,
            peerBlocks: peerBlocksEvidence,
            peerIndexer: peerIndexerEvidence,
        },
    };
};
