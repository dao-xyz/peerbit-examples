import { usePeer } from "@peerbit/react";
import { useParams } from "react-router-dom";
import { useEffect, useReducer, useRef, useState } from "react";
import { Files, AbstractFile } from "@peerbit/please-lib";
import { Observer, Replicator } from "@peerbit/document";
import { MdDownload } from "react-icons/md";
export const Drop = () => {
    const { peer } = usePeer();
    const filesRef = useRef<Files>(undefined);
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);
    const params = useParams();
    const [list, setList] = useState<AbstractFile[]>([]);
    const [isHost, setIsHost] = useState<boolean>();

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
                await f.waitFor(f.rootKey).catch(() => {
                    alert("Host is not online");
                });
            }

            await updateList();
            // TODO
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
        setList(list);
        forceUpdate();
    };
    const download = async (file: AbstractFile) => {
        const bytes = await file.getFile(filesRef.current);
        var blob = new Blob([bytes]);
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
                    var reader = new FileReader();
                    reader.readAsArrayBuffer(file);
                    reader.onload = function () {
                        var arrayBuffer = reader.result;
                        var bytes = new Uint8Array(arrayBuffer as ArrayBuffer);
                        filesRef.current
                            .add(file.name, bytes)
                            .then((d) => {
                                console.log("ADDED", d);
                            })
                            .then(() => {
                                updateList();
                            });
                    };
                }
            });
        } else {
            // Use DataTransfer interface to access the file(s)
            [...ev.dataTransfer.files].forEach((file, i) => {
                console.log(`… file[${i}].name = ${file.name}`);
            });
        }
    }

    function dragOverHandler(ev) {
        if (!isHost) {
            return;
        }
        console.log("File(s) in drop zone");

        // Prevent default behavior (Prevent file from being opened)
        ev.preventDefault();
    }
    return (
        <div
            onDrop={dropHandler}
            onDragOver={dragOverHandler}
            className="w-screen h-screen flex flex-col bg-neutral-200 dark:bg-black flex justify-center items-center transition-all"
        >
            {isHost && <span>Drop a file</span>}
            <br></br>
            {list?.length > 0 ? (
                <div className="flex justify-start flex-col">
                    <h1 className="text-xl">Files ({list.length})</h1>
                    <ul>
                        {list.map((x, ix) => {
                            return (
                                <li key={ix}>
                                    <button
                                        onClick={() => {
                                            download(x);
                                        }}
                                        className="flex flex-row border border-1 items-center mt-3 btn btn-elevated"
                                    >
                                        <span>{x.name}</span>
                                        <MdDownload className="ml-2" />
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            ) : (
                <span className="italic">No files found</span>
            )}
        </div>
    );
};
