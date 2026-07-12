import { IndexableFile, TinyFile, isLargeFileLike } from "@peerbit/please-lib";
import { Files, AbstractFile } from "@peerbit/please-lib";
import { useEffect, useState } from "react";
import { FaSeedling } from "react-icons/fa";
import { MdDeleteForever, MdDownload } from "react-icons/md";
import { DocumentsChange } from "@peerbit/document";

const formatFileSize = (size: number | bigint) =>
    `${Math.round(Number(size) / 1000)} kb`;

export const formatIndexedChunkRatio = (ratio: number) => `${ratio}% indexed`;

const LOCAL_CHUNK_COUNT_REFRESH_DELAY_MS = 250;

export const shouldDisableFileDownload = (properties: {
    progress: number | null;
}) => properties.progress != null;

export const hasFileChunkChange = (
    detail: {
        added?: AbstractFile[];
        removed?: Pick<IndexableFile, "parentId">[];
    },
    fileId: string
) =>
    (detail.added ?? []).some(
        (added) => added instanceof TinyFile && added.parentId === fileId
    ) || (detail.removed ?? []).some((removed) => removed.parentId === fileId);

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
        let refreshTimer: ReturnType<typeof setTimeout> | undefined;
        let refreshInFlight = false;
        let refreshQueued = false;

        const fetchLocalChunks = async () => {
            refreshTimer = undefined;
            if (disposed || refreshInFlight) {
                return;
            }
            refreshInFlight = true;
            refreshQueued = false;
            try {
                const count =
                    await properties.files.countLocalChunks(largeFile);
                if (!disposed) {
                    setReplicatedChunksRatio(
                        Math.round((count * 100) / Math.max(chunkCount, 1))
                    );
                }
            } catch (error) {
                if (!disposed) {
                    console.warn(
                        "Failed to count local chunks for " +
                            properties.file.name +
                            ": " +
                            (error instanceof Error
                                ? error.message
                                : String(error))
                    );
                }
            } finally {
                refreshInFlight = false;
                if (refreshQueued && !disposed) {
                    scheduleLocalChunkCountRefresh();
                }
            }
        };

        const scheduleLocalChunkCountRefresh = () => {
            refreshQueued = true;
            if (disposed || refreshInFlight || refreshTimer) {
                return;
            }
            refreshTimer = setTimeout(() => {
                void fetchLocalChunks();
            }, LOCAL_CHUNK_COUNT_REFRESH_DELAY_MS);
        };

        const changeListener = (
            event: CustomEvent<DocumentsChange<AbstractFile, IndexableFile>>
        ) => {
            if (hasFileChunkChange(event.detail, properties.file.id)) {
                scheduleLocalChunkCountRefresh();
            }
        };

        properties.files.files.events.addEventListener(
            "change",
            changeListener
        );
        void fetchLocalChunks();
        return () => {
            disposed = true;
            if (refreshTimer) {
                clearTimeout(refreshTimer);
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
