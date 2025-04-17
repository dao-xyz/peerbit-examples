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
    LOWEST_QUALITY,
    StaticContent,
    StaticMarkdownText,
} from "@giga-app/interface";
import { useLocation } from "react-router";
import { Ed25519Keypair, sha256Sync } from "@peerbit/crypto";
import { ProgramClient } from "@peerbit/program";
import { deserialize } from "@dao-xyz/borsh";

interface ICanvasContext {
    // root canvas
    root?: Canvas;

    // leaf canvas
    leaf?: Canvas;

    // the current path
    path: Canvas[];
    loading: boolean;

    // create all canvases required for current path
    createCanvasAtPath: () => Promise<Canvas[]>;
    setRoot: (root: Canvas) => void;
}

export const getCanvasAdressFromUrl = (): string | undefined => {
    if (!window.location.hash) {
        return undefined;
    }
    const pathname = window.location.hash.split("#")[1];
    const path = pathname.split("/").map((x) => decodeURIComponent(x));
    path.splice(0, 2); // remove '' and 'c'
    if (path[0] === "") {
        path.splice(0, 1);
    }
    // Remove query parameters (e.g. ?view=new) if present
    const canvasAddress = path[0]?.split("?")[0];
    return canvasAddress;
};

const getCanvasesPathFromURL = async (
    peer: ProgramClient,
    root: Canvas
): Promise<Canvas[]> => {
    const canvasAddress = getCanvasAdressFromUrl();

    if (!canvasAddress) {
        return [root];
    }
    const current = await peer.open<Canvas>(canvasAddress, {
        existing: "reuse",
    });
    return current.loadPath(true);
};

const CanvasContext = React.createContext<ICanvasContext>({} as any);
export const useCanvases = () => useContext(CanvasContext);
const ROOM_ID_SEED = new TextEncoder().encode("giga | place");

const GIGA_ROOT_POST = `
# Welcome to Giga
**A *public* and *private* media platform owned by you**
`;

const ROOT_IDENTITY_DEVELOPMENT = deserialize(
    new Uint8Array([
        0, 0, 100, 171, 121, 177, 143, 132, 216, 160, 114, 206, 201, 210, 133,
        17, 161, 86, 242, 139, 211, 26, 91, 240, 38, 132, 155, 204, 167, 51, 69,
        114, 170, 211, 0, 4, 142, 151, 39, 126, 167, 96, 33, 175, 100, 38, 167,
        37, 133, 179, 14, 196, 158, 96, 228, 244, 241, 4, 115, 64, 172, 99, 30,
        2, 207, 129, 237,
    ]),
    Ed25519Keypair
);

export const CanvasProvider = ({ children }: { children: JSX.Element }) => {
    const { peer, loading: loadingPeer } = usePeer();
    const [root, _setRoot] = useState<Canvas>(undefined);
    const [leaf, setLeaf] = useState<Canvas>(undefined);

    const [canvases, setCanvases] = useState<Canvas[]>([]);
    const loadingPromise = useRef<Promise<void>>();
    const [isLoading, setIsLoading] = useState(true);
    const rlocation = useLocation();

    const setRoot = (canvas: Canvas) => {
        setCanvases([]);
        _setRoot(canvas);
    };

    useEffect(() => {
        setLeaf(canvases[canvases.length - 1]);
    }, [root?.closed || !root ? undefined : root.address, canvases]);

    const memo = React.useMemo<ICanvasContext>(
        () => ({
            root,
            leaf,
            setRoot,
            path: canvases,
            loading: isLoading || loadingPeer,
            createCanvasAtPath: async () => {
                setIsLoading(true);
                if (!root) {
                    throw new Error("Root not found");
                }
                return getCanvasesPathFromURL(peer, root)
                    .then((rooms) => {
                        return Promise.all(
                            rooms.map((room) =>
                                peer.open(room, { existing: "reuse" })
                            )
                        ).then((openRooms) => {
                            console.log("OPEN ROOMS", openRooms);
                            setCanvases(openRooms);
                            return openRooms;
                        });
                    })
                    .finally(() => {
                        setIsLoading(false);
                    });
            },
        }),
        [
            root?.id.toString(),
            canvases.length,
            canvases[canvases.length - 1]?.idString,
            rlocation,
            isLoading,
            leaf,
            loadingPeer,
        ]
    );

    const updateCanvasPath = async (reset = true) => {
        let startLocation = window.location.hash;
        const maybeSetCanvases = (canvases: Canvas[]) => {
            if (startLocation === window.location.hash) {
                setCanvases(canvases);
                setIsLoading(false);
            } else {
                console.log("SKIP SET", startLocation, window.location.hash);
            }
        };
        /* setCanvasPath(newRoomPath);
        document.title = newRoomPath.join(" / ") || "Giga"; */
        if (reset) {
            maybeSetCanvases(null);
            setIsLoading(true);
        }

        if (!root) {
            throw new Error("Root not found");
        }
        getCanvasesPathFromURL(peer, root)
            .then((result) => {
                maybeSetCanvases(result);
            })
            .catch((e) => {
                console.error(e);
            })
            .finally(() => {
                setIsLoading(false);
            });
    };

    useEffect(() => {
        if (!root) {
            return;
        }
        updateCanvasPath(false);
    }, [root?.address, rlocation]);

    useEffect(() => {
        if (root || !peer || loadingPromise.current) {
            return;
        }

        peer.open(
            new Canvas({
                seed: ROOM_ID_SEED,
                publicKey: ROOT_IDENTITY_DEVELOPMENT.publicKey,
            }),
            {
                existing: "reuse",
            }
        )
            .then(async (result) => {
                setRoot(result);
                await result.elements.put(
                    new Element({
                        location: Layout.zero(),
                        id: new Uint8Array(32),
                        publicKey: peer.identity.publicKey,
                        content: new StaticContent({
                            content: new StaticMarkdownText({
                                text: GIGA_ROOT_POST,
                            }),
                            quality: LOWEST_QUALITY,
                            contentId: sha256Sync(
                                new TextEncoder().encode(GIGA_ROOT_POST)
                            ),
                        }),
                        parent: result,
                    })
                );
                loadingPromise.current = undefined;
            })
            .catch((e) => {
                console.error("Failed to create root canvas", e);
            });
    }, [peer?.identity?.toString()]);

    return (
        <CanvasContext.Provider value={memo}>{children}</CanvasContext.Provider>
    );
};
