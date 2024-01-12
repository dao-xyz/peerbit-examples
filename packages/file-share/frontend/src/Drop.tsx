import { usePeer, useProgram } from "@peerbit/react";
import { useNavigate, useParams } from "react-router-dom";
import { useEffect, useReducer, useRef, useState } from "react";
import { Files, AbstractFile } from "@peerbit/please-lib";
import * as Toggle from "@radix-ui/react-toggle";

import { MdArrowBack, MdUploadFile } from "react-icons/md";
import { FaSeedling } from "react-icons/fa";
import { File } from "./File";
import { Spinner } from "./Spinner";

const saveRoleLocalStorage = (files: Files, role: string) => {
    localStorage.setItem(files.address + "-role", role); // Save role in localstorage for next time
};
const getRoleFromLocalStorage = (files: Files) => {
    return localStorage.getItem(files.address + "-role"); // Save role in localstorage for next time
};

export const Drop = () => {
    const navigate = useNavigate();

    const { peer } = usePeer();
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);
    const params = useParams();
    const [list, setList] = useState<AbstractFile[]>([]);
    const [chunkMap, setChunkMap] = useState<Map<string, AbstractFile[]>>(
        new Map()
    );

    const [replicationSet, setReplicationSet] = useState<Set<string>>(
        new Set()
    );
    const [isHost, setIsHost] = useState<boolean>();
    const [role, setRole] = useState<"replicator" | "observer">("observer");
    const [replicatorCount, setReplicatorCount] = useState(0);
    const [left, setLeft] = useState(false);

    const files = useProgram<Files>(
        params.address && decodeURIComponent(params.address),
        {
            existing: "reuse",
            args: { role: { type: "replicator", factor: 1 } },
        }
    );

    const updateRole = async (newRole: "replicator" | "observer") => {
        setRole(newRole);

        saveRoleLocalStorage(files.program, newRole); // Save role in localstorage for next time

        await files.program.files.log.updateRole(newRole);
    };

    useEffect(() => {
        if (!files.program?.address) {
            return;
        }

        const fn = async () => {
            const isTrusted =
                !files.program.trustGraph ||
                (await files.program.trustGraph.isTrusted(
                    peer.identity.publicKey
                ));

            files.program = files.program;

            // Second condition is for when we last time did use this files address, and if we where replicator at that time, be a replicator this time again
            if (
                isTrusted ||
                getRoleFromLocalStorage(files.program) === "replicator"
            ) {
                // by default open as replicator
                await updateRole("replicator");
            }

            setIsHost(isTrusted);
            if (!isTrusted) {
                /*   setWaitingForHost(true);
              forceUpdate();
              await f.waitFor(f.rootKey).catch(() => {
                  alert("Host is not online");
              });
              setWaitingForHost(false); */
            }
            await updateList();
        };
        fn();

        let updateListTimeout = undefined;

        const networkChangeListener = () => {
            updateListTimeout && clearTimeout(updateListTimeout);
            updateListTimeout = setTimeout(() => {
                updateList();
            }, 100);
        };

        files.program.files.log.events.addEventListener(
            "join",
            networkChangeListener
        );
        files.program.files.log.events.addEventListener(
            "leave",
            networkChangeListener
        );
        files.program.files.events.addEventListener(
            "change",
            networkChangeListener
        );

        const roleChangeListener = () => {
            setReplicatorCount(
                files.program.files.log.getReplicatorsSorted()?.length
            );
        };

        files.program.files.log.events.addEventListener(
            "role",
            roleChangeListener
        );

        /*   console.log([...peer.services.pubsub["topics"].keys()]);
      [...peer.services.pubsub["topics"].keys()].map(x => peer.services.pubsub.requestSubscribers(x)) */

        return () => {
            files.program.files.log.events.removeEventListener(
                "join",
                networkChangeListener
            );
            files.program.files.log.events.removeEventListener(
                "leave",
                networkChangeListener
            );
            files.program.files.events.removeEventListener(
                "change",
                networkChangeListener
            );
            files.program.files.log.events.removeEventListener(
                "role",
                roleChangeListener
            );
        };
    }, [files.program?.address]);

    const updateList = async () => {
        const list = await files.program.list();
        let chunkMap = new Map();
        setList(
            list
                .filter((x) => !x.parentId)
                .sort((a, b) => a.name.localeCompare(b.name))
        );
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

        // Get replication set
        setReplicationSet(new Set(files.program.files.index.index.keys()));
        forceUpdate();
    };
    const download = async (
        file: AbstractFile,
        progress: (progress: number | null) => void
    ) => {
        console.log("FETCH FILE START");
        const bytes = await file
            .getFile(files.program, {
                as: "chunks",
                timeout: 10 * 1000,
                progress,
            })
            .catch((e) => {
                console.error(e);
                throw e;
            })
            .finally(() => {
                progress(null);
            });
        console.log("FETCH FILE DONE");
        var blob = new Blob(bytes);
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

    const getReplicatedChunks = (file: AbstractFile): AbstractFile[] => {
        return [...(chunkMap.get(file.id)?.values() || [])].filter((y) =>
            replicationSet.has(y.id)
        );
    };

    const addFile = async (filesToAdd: FileList | File[]) => {
        for (const file of filesToAdd) {
            var reader = new FileReader();
            reader.readAsArrayBuffer(file);
            reader.onload = function () {
                var arrayBuffer = reader.result;
                var bytes = new Uint8Array(arrayBuffer as ArrayBuffer);
                console.log(bytes);
                files.program.add(file.name, bytes).then(() => {
                    updateList();
                });
            };
        }
    };

    const goBack = () => (
        <button
            className="w-fit btn btn-elevated flex flex-row items-center p-2"
            onClick={() => {
                setLeft(true);
                navigate("/");
            }}
        >
            <MdArrowBack size={20} className="mr-2" /> <span>Create space</span>
        </button>
    );

    function dragOverHandler(ev) {
        if (!isHost) {
            return;
        }

        // Prevent default behavior (Prevent file from being opened)
        ev.preventDefault();
    }

    return (
        <>
            {files.loading ? (
                <div className="flex flex-col items-center justify-center content-center h-full gap-4">
                    <div className="flex flex-row gap-4 items-center justify-center">
                        <span className="italic">Loading</span> <Spinner />
                    </div>{" "}
                    {goBack()}
                </div>
            ) : (
                <div
                    onDrop={dropHandler}
                    onDragOver={dragOverHandler}
                    className="flex flex-col h-[calc(100% - 40px)] items-center w-screen h-full "
                >
                    <div className="max-w-3xl w-full flex flex-col p-4  ">
                        <div className="flex flex-row gap-4 items-center">
                            <div className="flex flex-col ">
                                <h1 className="text-3xl italic">
                                    {files.program?.name}
                                </h1>
                                <span className="font-mono text-xs">
                                    Seeders:{" "}
                                    <span className="!text-green-400">
                                        {replicatorCount}
                                    </span>
                                </span>
                                <span className="italice text-xs ">
                                    Copy the URL to share all files
                                </span>
                            </div>

                            <div className="ml-auto flex flex-row items-end gap-2 align-items: center">
                                {isHost && (
                                    <>
                                        <input
                                            type="file"
                                            id="imgupload"
                                            className="hidden"
                                            onChange={(e) => {
                                                addFile(e.target?.files);
                                            }}
                                        />
                                        <button
                                            className="w-fit btn btn-elevated flex flex-row items-center gap-2"
                                            onClick={() => {
                                                document
                                                    .getElementById("imgupload")
                                                    .click();
                                            }}
                                        >
                                            <span className="hidden sm:block">
                                                Upload
                                            </span>{" "}
                                            <MdUploadFile size={20} />
                                        </button>
                                    </>
                                )}
                                {!isHost && goBack()}
                                <Toggle.Root
                                    onPressedChange={(e) => {
                                        updateRole(
                                            role === "observer"
                                                ? "replicator"
                                                : "observer"
                                        );
                                    }}
                                    disabled={!files.program}
                                    pressed={role === "replicator"}
                                    className="w-fit btn-icon btn-toggle flex flex-row items-center gap-2"
                                    aria-label="Toggle italic"
                                >
                                    <span className="hidden sm:block">
                                        Seed
                                    </span>
                                    <FaSeedling
                                        className="text-green-400"
                                        size={20}
                                    />
                                </Toggle.Root>
                            </div>
                        </div>
                        <br></br>
                        {list?.length > 0 ? (
                            <div className="flex justify-start flex-col">
                                <h1 className="text-xl">
                                    Files ({list.length}):
                                </h1>
                                <ul>
                                    {list
                                        .filter((x) => !x.parentId)
                                        .map((x, ix) => {
                                            return (
                                                <li key={ix}>
                                                    <File
                                                        chunks={chunkMap.get(
                                                            x.id
                                                        )}
                                                        isHost={isHost}
                                                        delete={() => {
                                                            files.program
                                                                .removeById(
                                                                    x.id
                                                                )
                                                                .then(() => {
                                                                    updateList();
                                                                })
                                                                .catch(
                                                                    (error) => {
                                                                        alert(
                                                                            "Failed to delete: " +
                                                                                error.message
                                                                        );
                                                                    }
                                                                );
                                                        }}
                                                        download={(progress) =>
                                                            download(
                                                                x,
                                                                progress
                                                            )
                                                        }
                                                        file={x}
                                                        replicated={
                                                            role ===
                                                                "replicator" &&
                                                            replicationSet.has(
                                                                x.id
                                                            )
                                                        }
                                                        replicatedChunks={getReplicatedChunks(
                                                            x
                                                        )}
                                                    />
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
            )}
        </>
    );
};
