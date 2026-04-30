import { IndexableFile, LargeFile, TinyFile } from "@peerbit/please-lib";
import { Files, AbstractFile } from "@peerbit/please-lib";
import { useEffect, useReducer, useState } from "react";
import { FaSeedling } from "react-icons/fa";
import { MdDeleteForever, MdDownload } from "react-icons/md";
import { DocumentsChange } from "@peerbit/document";

const formatFileSize = (size: number | bigint) =>
    `${Math.round(Number(size) / 1000)} kb`;

export const shouldDisableFileDownload = (properties: {
    progress: number | null;
    largeFileReady?: boolean;
    replicated: boolean;
    replicatedChunksRatio: number;
}) =>
    properties.progress != null ||
    (properties.largeFileReady === false &&
        properties.replicated &&
        properties.replicatedChunksRatio < 100);

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
    const largeFile =
        properties.file instanceof LargeFile ? properties.file : undefined;
    const chunkCount = largeFile?.chunkCount ?? 0;
    const downloadDisabled = shouldDisableFileDownload({
        progress,
        largeFileReady: largeFile?.ready,
        replicated: properties.replicated,
        replicatedChunksRatio,
    });

    useEffect(() => {
        if (!properties.files) {
            return;
        }

        let fetchLocalChunks = () =>
            properties.files
                .countLocalChunks(properties.file as LargeFile)
                .then((count) => {
                    largeFile &&
                        setReplicatedChunksRatio(
                            Math.round((count * 100) / Math.max(chunkCount, 1))
                        );
                });
        let changeListener = largeFile
            ? (
                  e: CustomEvent<DocumentsChange<AbstractFile, IndexableFile>>
              ) => {
                  for (const added of e.detail.added) {
                      if (
                          added instanceof TinyFile &&
                          added.parentId === properties.file.id
                      ) {
                          fetchLocalChunks();
                      }
                  }
              }
            : undefined;

        changeListener &&
            properties.files.files.events.addEventListener(
                "change",
                changeListener
            );
        fetchLocalChunks();
        return () =>
            changeListener &&
            properties.files.files.events.removeEventListener(
                "change",
                changeListener
            );
    }, [properties.files.address, properties.file.id]);

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
                            <span className="text-xs bg-green-400 rounded-full p-[2px] leading-[5px] !text-black">
                                {replicatedChunksRatio}%
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
                            throw error;
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
