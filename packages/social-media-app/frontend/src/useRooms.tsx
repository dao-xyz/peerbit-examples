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
    loading: boolean;
    path: string[];
    create: () => Promise<Room[]>;
}

export const getRoomPathFromURL = (): string[] => {
    if (!window.location.hash) {
        return [];
    }
    const pathname = window.location.hash.split("#")[1];
    console.log("PATHNAME", pathname);
    const path = pathname.split("/").map((x) => decodeURIComponent(x));
    path.splice(0, 2); // remove '' and 'root path'
    if (path[0] === "") {
        path.splice(0, 1);
    }
    return path;
};

export const RoomContext = React.createContext<IRoomContext>({} as any);
export const useRooms = () => useContext(RoomContext);
const ROOM_ID_SEED = new TextEncoder().encode("dao | xyz");
export const RoomProvider = ({ children }: { children: JSX.Element }) => {
    const { peer, loading: loadingPeer } = usePeer();
    const [root, setRoot] = useState<Room>(undefined);
    const [rooms, setRooms] = useState<Room[]>([]);
    const loading = useRef<Promise<void>>();
    const [isLoading, setIsLoading] = useState(false);
    const [update, forceUpdate] = useReducer((x) => x + 1, 0);
    const [roomPath, setRoomPath] = useState([]);
    const rlocation = useLocation();

    const memo = React.useMemo<IRoomContext>(
        () => ({
            root,
            location: rooms,
            loading: isLoading || loadingPeer,
            path: roomPath,
            create: async () => {
                setIsLoading(true);
                return root
                    .getCreateRoomByPath(roomPath)
                    .then((rooms) => {
                        return Promise.all(
                            rooms.map((room) =>
                                peer.open(room, { existing: "reuse" })
                            )
                        ).then((openRooms) => {
                            setRooms(openRooms);
                            return openRooms;
                        });
                    })
                    .finally(() => {
                        setIsLoading(false);
                        forceUpdate();
                    });
            },
        }),
        [
            root?.id.toString(),
            update,
            isLoading,
            loadingPeer,
            JSON.stringify(roomPath),
        ]
    );

    const updateRooms = (reset = true) => {
        let startLocation = window.location.hash;
        const maybeSetRooms = (rooms: Room[]) => {
            if (startLocation === window.location.hash) {
                console.log("SET ROOMS", window.location.hash, startLocation);
                setRooms(rooms);
            }
        };
        const newRoomPath = getRoomPathFromURL();
        setRoomPath(newRoomPath);
        document.title = newRoomPath.join(" / ") || "dao | xyz";
        if (reset) {
            maybeSetRooms([]);
            setIsLoading(true);
        }

        root.findRoomsByPath(newRoomPath)
            .then((result) => {
                if (result.path.length === newRoomPath.length) {
                    return Promise.all(
                        result.rooms.map((room) =>
                            peer.open(room, { existing: "reuse" })
                        )
                    ).then((openRooms) => {
                        console.log("OPEN ROOMS?", openRooms);
                        maybeSetRooms(openRooms);
                        return openRooms;
                    });
                } else {
                    maybeSetRooms([]);
                }
            })
            .catch((e) => {
                console.error(e);
            })
            .finally(() => {
                setIsLoading(false);
                forceUpdate();
            });
    };

    useEffect(() => {
        if (!root) {
            forceUpdate();
            return;
        }
        updateRooms(false);

        // TODO remove when https://github.com/dao-xyz/peerbit/issues/151 is solved
        const listener = () => {
            updateRooms(false);
        };
        setTimeout(() => {
            updateRooms(false);
        }, 3000);
        root.elements.events.addEventListener("change", listener);
        return () => {
            root.elements.events.removeEventListener("change", listener);
        };
    }, [root?.address, rlocation]);

    useEffect(() => {
        if (root || !peer || loading.current) {
            return;
        }
        peer.open(
            new Room({
                seed: ROOM_ID_SEED,
                rootTrust: undefined,
            }),
            {
                existing: "reuse",
            }
        )
            .then(async (result) => {
                result.events.addEventListener("join", (e) => {
                    console.log(e);
                });
                setRoot(result);
            })
            .then(() => {
                loading.current = undefined;
            });
    }, [peer?.identity?.toString()]);

    return <RoomContext.Provider value={memo}>{children}</RoomContext.Provider>;
};
