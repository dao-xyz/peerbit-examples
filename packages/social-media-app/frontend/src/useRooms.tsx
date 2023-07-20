import { usePeer } from "@peerbit/react";
import React, { useContext, useEffect, useRef, useState } from "react";
import { Room } from "@dao-xyz/social";

interface IRoomContext {
    root?: Room;
}

export const RoomContext = React.createContext<IRoomContext>({} as any);
export const useRooms = () => useContext(RoomContext);
export const RoomProvider = ({ children }: { children: JSX.Element }) => {
    const { peer } = usePeer();
    const [root, setRoot] = useState<Room>(undefined);
    const loading = useRef<Promise<void>>();
    const memo = React.useMemo<IRoomContext>(
        () => ({
            root,
        }),
        [root?.id.toString()]
    );

    useEffect(() => {
        if (root || !peer || loading.current) {
            return;
        }
        peer.open(new Room({ rootTrust: peer.identity.publicKey }), {
            existing: "reuse",
        })
            .then(async (result) => {
                setRoot(result);
            })
            .then(() => {
                loading.current = undefined;
            });
    }, [peer?.identity?.toString()]);

    return <RoomContext.Provider value={memo}>{children}</RoomContext.Provider>;
};
