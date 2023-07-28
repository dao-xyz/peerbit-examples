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

        root.getCreateRoomByPath(getRoomPathFromURL(location.pathname)).then(
            (result) => {
                setRooms(result);
                forceUpdate();
            }
        );
    }, [root?.address, location.pathname]);

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
