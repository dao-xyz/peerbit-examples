import { usePeer } from "@peerbit/react";
import React, {
    useContext,
    useEffect,
    useRef,
    useState,
    useReducer,
} from "react";
import {
    Canvas,
    Element,
    Layout,
    StaticContent,
    StaticMarkdownText,
} from "@dao-xyz/social";
import { useLocation } from "react-router-dom";
import { Ed25519PublicKey, randomBytes } from "@peerbit/crypto";

interface IRoomContext {
    root?: Canvas;
    canvases: Canvas[];
    loading: boolean;
    path: string[];
    create: () => Promise<Canvas[]>;
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

export const SpaceContext = React.createContext<IRoomContext>({} as any);
export const useSpaces = () => useContext(SpaceContext);
const ROOM_ID_SEED = new TextEncoder().encode("dao | xyz");

const GIGA_ROOT_POST = `

# Welcome to giga.place

**The P2P Social Media Super App**

Discover a new era of social media where decentralization meets innovation. giga.place is designed to be the next evolution of Web 2.0—a dynamic, peer-to-peer social browsing experience that puts you in control.

---

## Why giga.place?

- **Decentralized & Secure:** Embrace a peer-to-peer network where your data is yours.
- **Innovative Social Browsing:** Seamlessly explore content, connect with friends, and join communities in real time.
- **Empowered Community:** Create, share, and interact in an environment designed for the next generation of social media.
- **Cutting-Edge Technology:** Experience the freedom of a platform built for modern connectivity and creativity.

---

## Get Started Today!

Join us and be a part of the future. Your social experience is about to change—step into a world where you lead the conversation and drive the innovation.

---
`;

export const SpaceProvider = ({ children }: { children: JSX.Element }) => {
    const { peer, loading: loadingPeer } = usePeer();
    const [root, setRoot] = useState<Canvas>(undefined);
    const [canvases, setRooms] = useState<Canvas[]>([]);
    const loading = useRef<Promise<void>>();
    const [isLoading, setIsLoading] = useState(false);
    const [update, forceUpdate] = useReducer((x) => x + 1, 0);
    const [roomPath, setRoomPath] = useState([]);
    const rlocation = useLocation();

    const memo = React.useMemo<IRoomContext>(
        () => ({
            root,
            canvases,
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
        const maybeSetRooms = (rooms: Canvas[]) => {
            if (startLocation === window.location.hash) {
                console.log("SET ROOMS", window.location.hash, startLocation);
                setRooms(rooms);
            }
        };
        const newRoomPath = getRoomPathFromURL();
        setRoomPath(newRoomPath);
        document.title = newRoomPath.join(" / ") || "Giga";
        if (reset) {
            maybeSetRooms([]);
            setIsLoading(true);
        }

        root.findRoomsByPath(newRoomPath)
            .then((result) => {
                if (result.path.length === newRoomPath.length) {
                    return Promise.all(
                        result.canvases.map((room) =>
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
            new Canvas({
                seed: ROOM_ID_SEED,
                publicKey: new Ed25519PublicKey({
                    publicKey: new Uint8Array(32),
                }), // TODO fix seed
            }),
            {
                existing: "reuse",
            }
        )
            .then(async (result) => {
                console.log("CREATED ROOT!", result);
                setRoot(result);

                console.log("SET ROOT", result?.address);
                await result.elements.put(
                    new Element({
                        location: [
                            new Layout({
                                breakpoint: "md",
                                x: 0,
                                y: 0,
                                z: 0,
                                w: 20,
                                h: 1000,
                            }),
                        ],
                        id: new Uint8Array(32),
                        publicKey: peer.identity.publicKey,
                        content: new StaticContent({
                            content: new StaticMarkdownText({
                                text: GIGA_ROOT_POST,
                            }),
                        }),
                    })
                );

                console.log("ROOT ELEMENT CREATED");

                loading.current = undefined;
            })
            .catch((e) => {
                console.error("Failed to create root canvas", e);
            });
    }, [peer?.identity?.toString()]);

    return (
        <SpaceContext.Provider value={memo}>{children}</SpaceContext.Provider>
    );
};
