import { usePeer } from "@peerbit/react";
import { useNavigate } from "react-router";
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
    const { peer, persisted, loading, status } = usePeer();
    const navigate = useNavigate();
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);
    const [name, setName] = useState("");

    const createSpace = async (spaceName: string) => {
        if (!peer) {
            throw new Error("Peer is not ready");
        }
        const db = await peer.open(
            new Files({
                id: new Uint8Array(32),
                name: spaceName,
                rootKey: peer.identity.publicKey,
            }),
            { existing: "reuse" }
        );
        forceUpdate();
        navigate(getDropAreaPath(db));
        return db.address;
    };

    useEffect(() => {
        if (!peer?.identity.publicKey) {
            return;
        }
    }, [peer?.identity?.publicKey.hashcode()]);

    useEffect(() => {
        const testWindow = window as Window & {
            __peerbitFileShareCreateSpace?: (name: string) => Promise<string>;
        };
        if (!peer || loading) {
            delete testWindow.__peerbitFileShareCreateSpace;
            return;
        }
        testWindow.__peerbitFileShareCreateSpace = async (spaceName: string) =>
            createSpace(spaceName);
        return () => {
            delete testWindow.__peerbitFileShareCreateSpace;
        };
    }, [loading, navigate, peer]);

    return (
        <div className="w-screen h-screen bg-neutral-200 dark:bg-black flex justify-center items-center transition-all">
            {loading ? (
                <Spinner />
            ) : (
                <div className="flex flex-col gap-3  translate-y-[-50%] p-4">
                    <span>Create space</span>
                    <input
                        className="p-2"
                        data-testid="space-name-input"
                        value={name}
                        onChange={(e) => {
                            setName(e.target.value);
                        }}
                        placeholder="Type a name"
                    ></input>
                    <button
                        disabled={name.length === 0 || loading || !peer}
                        className="btn btn-elevated"
                        data-testid="create-space"
                        onClick={() => {
                            createSpace(name)
                                .then((f) => {
                                    return f;
                                })
                                .catch((error) => {
                                    console.error(
                                        "Failed to create space:",
                                        (error as any)?.stack ?? error
                                    );
                                    alert(
                                        "Failed to create space: " +
                                            (error?.message ?? error)
                                    );
                                });
                        }}
                    >
                        Create
                    </button>
                    {status !== "connected" && (
                        <span className="italic text-sm">
                            Connecting to network...
                        </span>
                    )}
                    {persisted === false && (
                        <span className="!text-red-600 italic max-w-[300px] text-wrap">
                            {persistErrorMessage}
                        </span>
                    )}
                </div>
            )}
        </div>
    );
};
