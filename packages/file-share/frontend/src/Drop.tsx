import { usePeer } from "@peerbit/react";
import { useParams } from "react-router-dom";
import { useEffect, useReducer, useRef, useState } from "react";
import { Files, AbstractFile } from "@peerbit/please-lib";
import { Observer, Replicator } from "@peerbit/document";
import {
    MdDownload,
    MdDeleteForever,
    MdArrowBack,
    MdUploadFile,
} from "react-icons/md";
const isMobile = "ontouchstart" in window;

export const Drop = () => {
    const { peer } = usePeer();
    const filesRef = useRef<Files>(undefined);
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);
    const params = useParams();
    const [list, setList] = useState<AbstractFile[]>([]);
    const [chunkMap, setChunkMap] = useState<Map<string, AbstractFile[]>>(
        new Map()
    );
    const [isHost, setIsHost] = useState<boolean>();
    const [waitingForHost, setWaitingForHost] = useState<boolean>(false);

    useEffect(() => {
        if (!peer?.identity.publicKey) {
            return;
        }

        peer.open<Files>(decodeURIComponent(params.address), {
            existing: "reuse",
            args: { role: new Observer() },
        }).then(async (f) => {
            const isHost =
                !f.rootKey || f.rootKey.equals(peer.identity.publicKey);
            if (isHost && f.files.log.role instanceof Replicator === false) {
                await f.close();
                f = await peer.open<Files>(f.clone(), {
                    existing: "reuse",
                    args: { role: new Replicator() },
                });
            }
            filesRef.current = f;
            setIsHost(isHost);
            if (!isHost) {
                setWaitingForHost(true);
                forceUpdate();
                await f.waitFor(f.rootKey).catch(() => {
                    alert("Host is not online");
                });
                setWaitingForHost(false);
            }

            f.files.events.addEventListener("change", async () => {
                await updateList();
            });

            await updateList();

            // TODO remove
            setTimeout(async () => {
                await updateList();
            }, 3000);
            return f;
        });
    }, [peer?.identity?.publicKey.hashcode()]);

    const updateList = async () => {
        const list = await filesRef.current.list();
        console.log(
            "???",
            list,
            filesRef.current.files.log.role,
            peer.services.pubsub.getSubscribers(
                filesRef.current.files.log.topic
            )
        );

        let chunkMap = new Map();
        setList(list.filter((x) => !x.parentId));
        for (const element of list) {
            if (element.parentId) {
                let arr = chunkMap.get(element.parentId);
                if (!arr) {
                    arr = [];
                    chunkMap.set(element.parentId, arr);
                }
                arr.push(element);
            }
        }
        setChunkMap(chunkMap);
        forceUpdate();
    };
    const download = async (file: AbstractFile) => {
        console.log("FETCH FILE START");
        const bytes = await file.getFile(filesRef.current).catch((e) => {
            console.error(e);
            throw e;
        });
        console.log("FETCH FILE DONE");
        var blob = new Blob([bytes]);
        console.log("DOWNLOAD FILE");
        var link = document.createElement("a");
        link.href = window.URL.createObjectURL(blob);
        var fileName = file.name;
        link.download = fileName;
        link.click();
    };

    function dropHandler(ev) {
        if (!isHost) {
            return;
        }
        console.log("File(s) dropped");

        // Prevent default behavior (Prevent file from being opened)
        ev.preventDefault();

        if (ev.dataTransfer.items) {
            // Use DataTransferItemList interface to access the file(s)
            console.log(ev.dataTransfer.files);
            [...ev.dataTransfer.items].forEach((item, i) => {
                // If dropped items aren't files, reject them
                if (item.kind === "file") {
                    const file: File = item.getAsFile();
                    addFile([file]);
                }
            });
        } else {
            // Use DataTransfer interface to access the file(s)
            [...ev.dataTransfer.files].forEach((file, i) => {
                addFile([file]);
            });
        }
    }

    const addFile = async (files: FileList | File[]) => {
        for (const file of files) {
            var reader = new FileReader();
            reader.readAsArrayBuffer(file);
            reader.onload = function () {
                var arrayBuffer = reader.result;
                var bytes = new Uint8Array(arrayBuffer as ArrayBuffer);
                console.log(bytes);
                filesRef.current.add(file.name, bytes).then(() => {
                    updateList();
                });
            };
        }
    };
    function dragOverHandler(ev) {
        if (!isHost) {
            return;
        }

        // Prevent default behavior (Prevent file from being opened)
        ev.preventDefault();
    }

    return (
        <div
            onDrop={dropHandler}
            onDragOver={dragOverHandler}
            className="flex flex-col h-[calc(100% - 40px)] items-center w-screen h-full "
        >
            <div className="max-w-3xl w-full flex flex-col p-4">
                {isHost && (
                    <div className="flex flex-row   items-center gap-3">
                        <div className="flex flex-col">
                            <input
                                type="file"
                                id="imgupload"
                                className="hidden"
                                onChange={(e) => {
                                    addFile(e.target?.files);
                                }}
                            />
                            <button
                                className="w-fit btn btn-icon flex flex-row items-center p-2 gap-2"
                                onClick={() => {
                                    document
                                        .getElementById("imgupload")
                                        .click();
                                }}
                            >
                                Upload <MdUploadFile size={20} />
                            </button>
                            {isMobile ? (
                                <></>
                            ) : (
                                <span className="italic pl-2 text-xs">
                                    or drop a file anywhere
                                </span>
                            )}
                        </div>
                        {!isMobile ? (
                            <>
                                <img
                                    width={40}
                                    className="invert scale-x-[-1] ml-auto"
                                    src="arrow.svg"
                                />
                                <span>
                                    Copy the url to share your files with
                                    friends
                                </span>
                            </>
                        ) : (
                            <span className="ml-auto italic">
                                Copy the url to share your files with friends
                            </span>
                        )}
                    </div>
                )}
                {!isHost && (
                    <div className="flex flex-row items-center">
                        <button className="w-fit btn flex flex-row items-center p-2">
                            <MdArrowBack size={20} className="mr-2" />{" "}
                            <span>Upload your own files</span>
                        </button>
                        {waitingForHost ? (
                            <div className="italic ml-auto">
                                Waiting for host...
                            </div>
                        ) : (
                            <div className="italic ml-auto">Connected</div>
                        )}
                    </div>
                )}
                <br></br>
                {list?.length > 0 ? (
                    <div className="flex justify-start flex-col">
                        <h1 className="text-xl">Files ({list.length}):</h1>
                        <ul>
                            {list
                                .filter((x) => !x.parentId)
                                .map((x, ix) => {
                                    return (
                                        <li
                                            className="flex flex-row items-center gap-3"
                                            key={ix}
                                        >
                                            <span className="max-w-xs">
                                                {x.name}
                                            </span>
                                            <span className="ml-auto font-mono">
                                                {Math.round(x.size / 1000) +
                                                    " kb"}
                                            </span>
                                            {chunkMap.has(x.id) && (
                                                <span className="font-mono">
                                                    ({chunkMap.get(x.id).length}{" "}
                                                    chunks)
                                                </span>
                                            )}
                                            <button
                                                onClick={() => {
                                                    download(x);
                                                }}
                                                className="flex flex-row border border-1 items-center p-2 btn btn-elevated"
                                            >
                                                <MdDownload />
                                            </button>
                                            {isHost && (
                                                <button
                                                    onClick={() => {
                                                        filesRef.current
                                                            .removeById(x.id)
                                                            .then(() => {
                                                                updateList();
                                                            })
                                                            .catch((error) => {
                                                                alert(
                                                                    "Failed to delete: " +
                                                                        error.message
                                                                );
                                                            });
                                                    }}
                                                    className="flex flex-row border border-1 items-center p-2 btn btn-elevated"
                                                >
                                                    <MdDeleteForever />
                                                </button>
                                            )}
                                        </li>
                                    );
                                })}
                        </ul>
                    </div>
                ) : (
                    <span className="italic">No files available</span>
                )}
            </div>
        </div>
    );
};
