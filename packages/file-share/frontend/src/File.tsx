import {
    IndexableFile,
    isDeterministicLargeFileChunkSlot,
    isLargeFileLike,
    type LargeFileChunkParentGeometry,
} from "@peerbit/please-lib";
import { Files, AbstractFile } from "@peerbit/please-lib";
import { useEffect, useState } from "react";
import { FaSeedling } from "react-icons/fa";
import { MdDeleteForever, MdDownload } from "react-icons/md";
import { DocumentsChange } from "@peerbit/document";

const formatFileSize = (size: number | bigint) =>
    `${Math.round(Number(size) / 1000)} kb`;

export const formatIndexedChunkRatio = (ratio: number) => `${ratio}% indexed`;

const LOCAL_CHUNK_COUNT_REFRESH_DELAY_MS = 250;
const LOCAL_CHUNK_SNAPSHOT_MAX_ATTEMPTS = 3;
const LOCAL_CHUNK_SNAPSHOT_RETRY_DELAY_MS = 1_000;
const LOCAL_CHUNK_EVENT_RECOVERY_COOLDOWN_MS = 5_000;

export type FileChunkIdChange = {
    added: string[];
    removed: string[];
};

/**
 * Tracks exact local chunk membership after one metadata-only snapshot. Change
 * events received while the snapshot is in flight are compacted by id and
 * replayed afterwards, so mounting during an active transfer cannot miss them.
 */
export class LocalChunkCountTracker {
    private chunkIds?: Set<string>;
    private pending = new Map<string, boolean>();

    initialize(chunkIds: Iterable<string>) {
        const next = new Set(chunkIds);
        for (const [id, present] of this.pending) {
            if (present) {
                next.add(id);
            } else {
                next.delete(id);
            }
        }
        this.pending.clear();
        this.chunkIds = next;
        return next.size;
    }

    apply(change: FileChunkIdChange) {
        if (!this.chunkIds) {
            for (const id of change.removed) {
                this.pending.set(id, false);
            }
            for (const id of change.added) {
                this.pending.set(id, true);
            }
            return false;
        }

        const before = this.chunkIds.size;
        for (const id of change.removed) {
            this.chunkIds.delete(id);
        }
        for (const id of change.added) {
            this.chunkIds.add(id);
        }
        return this.chunkIds.size !== before;
    }

    get count() {
        return this.chunkIds?.size;
    }
}

export const shouldDisableFileDownload = (properties: {
    progress: number | null;
}) => properties.progress != null;

export const getFileChunkIdChange = (
    detail: DocumentsChange<AbstractFile, IndexableFile>,
    parent: LargeFileChunkParentGeometry
): FileChunkIdChange => ({
    added: detail.added
        .filter((file) => isDeterministicLargeFileChunkSlot(parent, file))
        .map((file) => file.id),
    removed: detail.removed
        .filter((file) => isDeterministicLargeFileChunkSlot(parent, file))
        .map((file) => file.id),
});

export const hasFileChunkChange = (
    detail: DocumentsChange<AbstractFile, IndexableFile>,
    parent: LargeFileChunkParentGeometry
) => {
    const change = getFileChunkIdChange(detail, parent);
    return change.added.length > 0 || change.removed.length > 0;
};

export const File = (properties: {
    files: Files;
    isHost: boolean;
    replicated: boolean;
    file: AbstractFile;
    delete: () => void;
    download: (progress: (progress: number | null) => void) => Promise<void>;
}) => {
    const [progress, setProgess] = useState<number | null>(null);
    const [failedDownload, setFailedDownload] = useState<boolean>(false);
    const [replicatedChunksRatio, setReplicatedChunksRatio] = useState(0);
    const largeFile = isLargeFileLike(properties.file)
        ? properties.file
        : undefined;
    const chunkCount = largeFile?.chunkCount ?? 0;
    const downloadDisabled = shouldDisableFileDownload({
        progress,
    });

    useEffect(() => {
        if (!properties.files || !largeFile || !properties.replicated) {
            setReplicatedChunksRatio(0);
            return;
        }

        let disposed = false;
        const tracker = new LocalChunkCountTracker();
        let publishTimer: ReturnType<typeof setTimeout> | undefined;
        let snapshotRetryTimer: ReturnType<typeof setTimeout> | undefined;
        let initialSnapshotAttempts = 0;
        let initialSnapshotRetriesExhausted = false;
        let snapshotInFlight = false;
        let recoveryRequested = false;
        let lastSnapshotFailureAt = 0;

        const publishLocalChunkCount = (count: number) => {
            if (disposed) {
                return;
            }
            setReplicatedChunksRatio(
                Math.min(
                    100,
                    Math.max(
                        0,
                        Math.round((count * 100) / Math.max(chunkCount, 1))
                    )
                )
            );
        };

        const scheduleLocalChunkCountPublish = () => {
            if (disposed || publishTimer || tracker.count == null) {
                return;
            }
            publishTimer = setTimeout(() => {
                publishTimer = undefined;
                const count = tracker.count;
                if (count != null) {
                    publishLocalChunkCount(count);
                }
            }, LOCAL_CHUNK_COUNT_REFRESH_DELAY_MS);
        };

        type SnapshotAttemptKind = "initial" | "recovery";

        const scheduleSnapshotAttempt = (
            kind: SnapshotAttemptKind,
            delayMs: number
        ) => {
            if (
                disposed ||
                tracker.count != null ||
                snapshotInFlight ||
                snapshotRetryTimer
            ) {
                return;
            }
            snapshotRetryTimer = setTimeout(() => {
                snapshotRetryTimer = undefined;
                if (kind === "recovery") {
                    recoveryRequested = false;
                }
                void runSnapshotAttempt(kind);
            }, delayMs);
        };

        const requestSnapshotRecovery = () => {
            if (disposed || tracker.count != null) {
                return;
            }
            recoveryRequested = true;
            if (
                !initialSnapshotRetriesExhausted ||
                snapshotInFlight ||
                snapshotRetryTimer
            ) {
                return;
            }
            scheduleSnapshotAttempt(
                "recovery",
                Math.max(
                    0,
                    lastSnapshotFailureAt +
                        LOCAL_CHUNK_EVENT_RECOVERY_COOLDOWN_MS -
                        Date.now()
                )
            );
        };

        const changeListener = (
            event: CustomEvent<DocumentsChange<AbstractFile, IndexableFile>>
        ) => {
            const change = getFileChunkIdChange(event.detail, largeFile);
            if (change.added.length === 0 && change.removed.length === 0) {
                return;
            }
            if (tracker.apply(change)) {
                scheduleLocalChunkCountPublish();
            }
            if (tracker.count == null) {
                requestSnapshotRecovery();
            }
        };

        properties.files.files.events.addEventListener(
            "change",
            changeListener
        );
        async function runSnapshotAttempt(kind: SnapshotAttemptKind) {
            if (disposed || tracker.count != null || snapshotInFlight) {
                return;
            }
            snapshotInFlight = true;
            if (kind === "initial") {
                initialSnapshotAttempts += 1;
            }
            let nextInitialDelayMs: number | undefined;
            try {
                const chunkIds =
                    await properties.files.listLocalChunkIds(largeFile);
                if (!disposed) {
                    recoveryRequested = false;
                    publishLocalChunkCount(tracker.initialize(chunkIds));
                }
            } catch (error) {
                if (disposed) {
                    return;
                }
                lastSnapshotFailureAt = Date.now();
                if (
                    kind === "initial" &&
                    initialSnapshotAttempts < LOCAL_CHUNK_SNAPSHOT_MAX_ATTEMPTS
                ) {
                    nextInitialDelayMs =
                        LOCAL_CHUNK_SNAPSHOT_RETRY_DELAY_MS *
                        initialSnapshotAttempts;
                } else {
                    initialSnapshotRetriesExhausted = true;
                    if (kind === "initial") {
                        console.warn(
                            "Failed to list local chunks for " +
                                properties.file.name +
                                ": " +
                                (error instanceof Error
                                    ? error.message
                                    : String(error))
                        );
                    }
                }
            } finally {
                snapshotInFlight = false;
            }
            if (disposed || tracker.count != null) {
                return;
            }
            if (nextInitialDelayMs != null) {
                scheduleSnapshotAttempt("initial", nextInitialDelayMs);
            } else if (recoveryRequested) {
                requestSnapshotRecovery();
            }
        }
        void runSnapshotAttempt("initial");
        return () => {
            disposed = true;
            if (publishTimer) {
                clearTimeout(publishTimer);
            }
            if (snapshotRetryTimer) {
                clearTimeout(snapshotRetryTimer);
            }
            properties.files.files.events.removeEventListener(
                "change",
                changeListener
            );
        };
    }, [
        properties.files,
        properties.file.id,
        properties.replicated,
        chunkCount,
    ]);

    return (
        <div className="flex flex-row items-center gap-3 mb-3">
            <span className="max-w-xs">{properties.file.name}</span>
            <div className="ml-auto  flex flex-col leading-3">
                <span className="font-mono text-sm">
                    {formatFileSize(properties.file.size)}
                </span>

                {largeFile && (
                    <span className="font-mono text-xs">
                        {chunkCount} chunks
                        {!largeFile.ready && " (uploading)"}
                    </span>
                )}
            </div>
            {properties.replicated && (
                <div className={`flex flex-row`}>
                    <FaSeedling className="text-green-400" size={20} />

                    {replicatedChunksRatio > 0 && (
                        <div className="ml-[-5px] mt-[-15px]">
                            <span
                                title="Indexed locally; payload availability is verified when the file is read"
                                className="text-xs bg-green-400 rounded-full p-[2px] leading-[5px] !text-black"
                            >
                                {formatIndexedChunkRatio(replicatedChunksRatio)}
                            </span>
                        </div>
                    )}

                    {/* {getReplicatedChunksCount(
                    x
                ) > 0 && (
                        <span className="text-xs absolute bg-green-400 rounded-full p-1 leading-[10px] !text-black left-[15px] top-[-10px]">
                            {getReplicatedChunksCount(
                                x
                            )}
                        </span>
                    )} */}
                </div>
            )}
            <button
                data-testid="download-file"
                disabled={downloadDisabled}
                onClick={() => {
                    setFailedDownload(false);
                    setProgess(0);
                    properties
                        .download((p) => {
                            setProgess(p);
                        })
                        .then(() => {
                            setFailedDownload(false);
                        })
                        .catch((error: any) => {
                            setFailedDownload(true);
                            alert(
                                "Failed to download: " +
                                    properties.file.name +
                                    ". " +
                                    error.message?.toString()
                            );
                        });
                }}
                className={`flex flex-row border border-1 items-center p-2 btn btn-elevated`}
            >
                {largeFile && !largeFile.ready ? (
                    <span className={`text-xs font-mono`}>pending</span>
                ) : progress != null ? (
                    <span className={`text-xs font-mono`}>
                        {Math.round(progress * 100)}%
                    </span>
                ) : (
                    <MdDownload />
                )}
            </button>
            {properties.isHost && (
                <button
                    data-testid="delete-file"
                    onClick={() => {
                        properties.delete();
                    }}
                    className="flex flex-row border border-1 items-center p-2 btn btn-elevated"
                >
                    <MdDeleteForever />
                </button>
            )}
        </div>
    );
};
