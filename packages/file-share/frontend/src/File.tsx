import { IndexableFile, LargeFile, TinyFile } from "@peerbit/please-lib";
import { Files, AbstractFile } from "@peerbit/please-lib";
import { useEffect, useReducer, useState } from "react";
import { FaSeedling } from "react-icons/fa";
import { MdDeleteForever, MdDownload } from "react-icons/md";
import { DocumentsChange } from "@peerbit/document";
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

    useEffect(() => {
        if (!properties.files) {
            return;
        }

        let fetchLocalChunks = () =>
            properties.files
                .countLocalChunks(properties.file as LargeFile)
                .then((count) => {
                    properties.file instanceof LargeFile &&
                        setReplicatedChunksRatio(
                            Math.round(
                                (count * 100) /
                                    (properties.file as LargeFile).fileIds
                                        .length
                            )
                        );
                });
        let changeListener =
            properties.file instanceof LargeFile
                ? (
                      e: CustomEvent<
                          DocumentsChange<AbstractFile, IndexableFile>
                      >
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
                    {Math.round(properties.file.size / 1000) + " kb"}
                </span>

                {properties.file instanceof LargeFile && (
                    <span className="font-mono text-xs">
                        {properties.file.fileIds.length} chunks
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
                disabled={progress != null}
                onClick={() => {
                    setFailedDownload(false);
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
                {progress != null ? (
                    <span className={`text-xs font-mono`}>
                        {Math.round(progress * 100)}%
                    </span>
                ) : (
                    <MdDownload />
                )}
            </button>
            {properties.isHost && (
                <button
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
