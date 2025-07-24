import React, { createContext, useContext, useMemo, useState, JSX, useEffect } from "react";
import { usePeer } from "@peerbit/react";
import { Canvas, createRoot } from "@giga-app/interface";
import { useLocation } from "react-router";
import { ProgramClient } from "@peerbit/program";
import { concat } from "uint8arrays"

export interface ICanvasContext {
    root?: Canvas;
    leaf?: Canvas;
    path: Canvas[];
    loading: boolean;
    createCanvasAtPath: () => Promise<Canvas[]>;
    setRoot: (root: Canvas) => void;
    viewRoot?: Canvas;
    standalone?: Canvas[];
}

function getCanvasAddressFromUrl(): string | undefined {
    if (!window.location.hash) return;
    const path = window.location.hash.split("#")[1].split("/").map(decodeURIComponent);
    path.splice(0, 2);
    if (path[0] === "") path.splice(0, 1);
    return path[0]?.split("?")[0];
}

async function getCanvasesPathFromURL(
    peer: ProgramClient,
    root: Canvas
): Promise<Canvas[]> {
    const canvasAddress = getCanvasAddressFromUrl();
    if (!canvasAddress) return [root];
    const current = await peer.open<Canvas>(canvasAddress, { existing: "reuse" });
    return current.loadPath({ includeSelf: true });
}

/**
 * Call this once per "root group" you want.
 * It returns a Provider and a hook bound to that root group.
 */
export function createCanvasScope(options?: { private?: boolean }) {
    const Ctx = createContext<ICanvasContext>(null as any);

    const useCanvases = () => useContext(Ctx);


    const CanvasProvider = ({ children }: { children: JSX.Element }) => {
        const { peer, loading: loadingPeer, persisted } = usePeer();
        const [root, _setRoot] = useState<Canvas | undefined>();


        const [path, setPath] = useState<Canvas[]>([]);
        const [isLoading, setIsLoading] = useState(true);
        const location = useLocation();

        const setRoot = (c: Canvas) => {
            setPath([]);
            _setRoot(c);
        };

        const leaf = useMemo(() => (path.length ? path[path.length - 1] : undefined), [path]);

        const createCanvasAtPath = async () => {
            if (!root) throw new Error("Root not found");
            setIsLoading(true);
            try {
                const canvases = await getCanvasesPathFromURL(peer, root);
                const opened = await Promise.all(canvases.map((c) => root.openWithSameSettings(c)));
                setPath(opened);
                return opened;
            } finally {
                setIsLoading(false);
            }
        };

        // keep path in sync with URL
        useEffect(() => {
            if (!root) return;
            let startHash = window.location.hash;
            const maybeSet = (c: Canvas[]) => {
                if (startHash === window.location.hash) {
                    setPath(c);
                    setIsLoading(false);
                }
            };
            setIsLoading(true);
            getCanvasesPathFromURL(peer, root)
                .then(maybeSet)
                .catch(console.error)
                .finally(() => setIsLoading(false));
        }, [root?.address, location]);

        // ensure we have a root
        useEffect(() => {
            if (!peer) { return; }

            if (options?.private) {
                const newRoot = new Canvas({ publicKey: peer.identity.publicKey, seed: concat([peer.identity.publicKey.bytes, new TextEncoder().encode("draft")]), path: [] });
                peer.open(newRoot, { existing: "reuse", args: { replicate: persisted } })
                    .then(setRoot);
                return;

            }

            if (root) {

                if (root.closed === true) {
                    peer
                        .open<Canvas>(root, { existing: "reuse", args: { replicate: persisted } })
                        .then(setRoot);
                }
                return;
            }
            createRoot(peer, { persisted/* , sections: ["Home", "About", "Help"] */ })
                .then(setRoot)
                .catch((e) => console.error("Error creating root canvas:", e));
        }, [peer?.identity?.toString()]);

        const [standalone, setStandalone] = useState<Canvas[] | undefined>(
            undefined
        );

        useEffect(() => {
            const fn = async () => {
                setStandalone(await leaf?.getStandaloneParent());
            };
            fn();
        }, [leaf]);

        const viewRoot = useMemo(() => standalone?.[0], [standalone]);


        const value = useMemo<ICanvasContext>(
            () => ({
                root,
                leaf,
                setRoot,
                path,
                loading: isLoading || loadingPeer,
                createCanvasAtPath,
                standalone,
                viewRoot
            }),
            [root?.id?.toString(), path.length, leaf?.idString, standalone, viewRoot, isLoading, loadingPeer]
        );

        return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
    };

    return { CanvasProvider, useCanvases };
}

export const PublicCanvasScope = createCanvasScope();
export const PrivateCanvasScope = createCanvasScope({ private: true });
const useCanvases = PublicCanvasScope.useCanvases;
export { useCanvases };