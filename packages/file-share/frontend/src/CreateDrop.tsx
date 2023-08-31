import { usePeer } from "@peerbit/react";
import { useNavigate } from "react-router-dom";
import { useEffect, useReducer, useRef } from "react";
import { Files } from "@peerbit/please-lib";
import { getDropAreaPath } from "./routes";

export const CreateDrop = () => {
    const { peer } = usePeer();
    const navigate = useNavigate();
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);

    useEffect(() => {
        if (!peer?.identity.publicKey) {
            return;
        }
        peer.open(
            new Files({
                id: new Uint8Array(32),
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
    }, [peer?.identity?.publicKey.hashcode()]);

    return (
        <div className="w-screen h-screen bg-neutral-200 dark:bg-black flex justify-center items-center transition-all">
            Loading
        </div>
    );
};
