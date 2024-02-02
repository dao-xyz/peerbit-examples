import { usePeer } from "@peerbit/react";
import { useNavigate } from "react-router-dom";
import { useEffect, useReducer, useState } from "react";
import { Files } from "@peerbit/please-lib";
import { getDropAreaPath } from "./routes";
import { Spinner } from "./Spinner";

const persistErrorMessage = `Not allowed to persist data by ${
    window["chrome"] ? "Chrome" : "the browser"
}${
    window["chrome"]
        ? ". To persist state, try adding the site as a bookmark"
        : ""
}`;
export const CreateDrop = () => {
    const { peer, canPersist, loading } = usePeer();
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
            {loading ? (
                <Spinner />
            ) : (
                <div className="flex flex-col gap-3  translate-y-[-50%] p-4">
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
                        disabled={name.length === 0 || loading}
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
                                    navigate(getDropAreaPath(db));
                                });
                        }}
                    >
                        Create
                    </button>
                    {!canPersist === false && (
                        <span className="!text-red-600 italic max-w-[300px] text-wrap">
                            {persistErrorMessage}
                        </span>
                    )}
                </div>
            )}
        </div>
    );
};
