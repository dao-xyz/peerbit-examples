import { usePeer } from "@peerbit/react";
import React, { JSX, useContext, useEffect, useState } from "react";
import { Canvas, createRoot } from "@giga-app/interface";
import { useLocation } from "react-router";
import { sha256Sync } from "@peerbit/crypto";
import { ProgramClient } from "@peerbit/program";
import { toId } from "@peerbit/indexer-interface";
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
    return current.loadPath({ includeSelf: true });
};

const CanvasContext = React.createContext<ICanvasContext>({} as any);
export const useCanvases = () => useContext(CanvasContext);

export const CanvasProvider = ({ children }: { children: JSX.Element }) => {
    const { peer, loading: loadingPeer, persisted } = usePeer();
    const [root, _setRoot] = useState<Canvas>(undefined);

    const [canvases, setCanvases] = useState<Canvas[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const rlocation = useLocation();

    const setRoot = (canvas: Canvas) => {
        setCanvases([]);
        _setRoot(canvas);
    };

    const leaf = React.useMemo<Canvas | undefined>(
        () => (canvases?.length ? canvases[canvases.length - 1] : undefined),
        [canvases]
    );

    const [viewContext, setViewContext] = useState<Canvas[] | undefined>(
        undefined
    );

    useEffect(() => {
        const fn = async () => {
            setViewContext(await leaf?.getViewContext());
        };
        fn();
    }, [leaf]);

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
                    .then((canvases) => {
                        return Promise.all(
                            canvases.map((canvas) =>
                                root.openWithSameSettings(canvas)
                            )
                        ).then((openCanvases) => {
                            console.log("OPEN CANVASES", openCanvases);
                            setCanvases(openCanvases);
                            return openCanvases;
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
        if (root || !peer) {
            return;
        }
        createRoot(peer, persisted)
            .then((result) => {
                setRoot(result);
            })
            .catch((e) => {
                console.error("Error creating root canvas:", e);
            });
    }, [peer?.identity?.toString()]);

    return (
        <CanvasContext.Provider value={memo}>{children}</CanvasContext.Provider>
    );
};
