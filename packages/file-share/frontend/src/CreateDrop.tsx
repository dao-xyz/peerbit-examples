import { usePeer } from "@peerbit/react";
import { useNavigate } from "react-router-dom";
import { useEffect, useReducer, useState } from "react";
import { Files } from "@peerbit/please-lib";
import { getDropAreaPath } from "./routes";

export const CreateDrop = () => {
    const { peer } = usePeer();
    const navigate = useNavigate();
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);
    const [name, setName] = useState("");
    useEffect(() => {
        if (!peer?.identity.publicKey) {
            return;
        }
    }, [peer?.identity?.publicKey.hashcode()]);

    return (
        <div className="w-screen h-screen bg-neutral-200 dark:bg-black flex justify-center items-center transition-all">
            <div className="flex flex-col gap-3  translate-y-[-50%]">
                <span>Create space</span>
                <input
                    className="p-2"
                    value={name}
                    onChange={(e) => {
                        setName(e.target.value);
                    }}
                    placeholder="Type a name"
                ></input>
                <button
                    disabled={name.length === 0 || !peer}
                    className="btn btn-elevated"
                    onClick={() => {
                        peer.open(
                            new Files({
                                id: new Uint8Array(32),
                                name,
                                rootKey: peer.identity.publicKey,
                            }),
                            { existing: "reuse" }
                        )
                            .then((f) => {
                                forceUpdate();
                                return f;
                            })
                            .then((db) => {
                                console.log("NAVIAGE", db.address);
                                navigate(getDropAreaPath(db));
                            });
                    }}
                >
                    Create
                </button>
            </div>
        </div>
    );
};
