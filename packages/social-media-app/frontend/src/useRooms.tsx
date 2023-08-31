import { usePeer } from "@peerbit/react";
import React, {
    useContext,
    useEffect,
    useRef,
    useState,
    useReducer,
} from "react";
import { Room } from "@dao-xyz/social";
import { useLocation } from "react-router-dom";

interface IRoomContext {
    root?: Room;
    location: Room[];
}

export const getRoomPathFromURL = (pathname: string): string[] => {
    const path = pathname.split("/").map((x) => decodeURIComponent(x));
    path.splice(0, 2); // remove '' and 'path'
    return path;
};

export const RoomContext = React.createContext<IRoomContext>({} as any);
export const useRooms = () => useContext(RoomContext);
const ROOM_ID_SEED = new TextEncoder().encode("dao | xyz");
export const RoomProvider = ({ children }: { children: JSX.Element }) => {
    const { peer } = usePeer();
    const [root, setRoot] = useState<Room>(undefined);
    const [rooms, setRooms] = useState<Room[]>([]);
    const loading = useRef<Promise<void>>();
    const location = useLocation();
    const [update, forceUpdate] = useReducer((x) => x + 1, 0);

    const memo = React.useMemo<IRoomContext>(
        () => ({
            root,
            location: rooms,
        }),
        [root?.id.toString(), update]
    );

    useEffect(() => {
        if (!root) {
            forceUpdate();
            return;
        }

        const roomPath = getRoomPathFromURL(location.pathname);

        document.title = roomPath.join(" / ") || "dao | xyz";
        root.getCreateRoomByPath(roomPath)
            .then((result) => {
                setRooms(result);
                forceUpdate();
            })
            .catch((e) => {
                console.error(e);
            })
            .finally(() => {
                console.log("RSOLVED ROOM?");
            });
    }, [root?.address, location.pathname]);

    useEffect(() => {
        if (root || !peer || loading.current) {
            return;
        }
        peer.open(
            new Room({
                seed: ROOM_ID_SEED,
                rootTrust: peer.identity.publicKey,
            }),
            {
                existing: "reuse",
            }
        )
            .then(async (result) => {
                setRoot(result);
            })
            .then(() => {
                loading.current = undefined;
            });
    }, [peer?.identity?.toString()]);

    return <RoomContext.Provider value={memo}>{children}</RoomContext.Provider>;
};
