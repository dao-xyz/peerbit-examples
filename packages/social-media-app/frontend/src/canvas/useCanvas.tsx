import {
    createContext,
    useContext,
    useMemo,
    useState,
    JSX,
    useEffect,
    useRef,
} from "react";
import { usePeer } from "@peerbit/react";
import {
    Canvas,
    IndexableCanvas,
    Scope,
    createRoot,
    loadCanvasFromScopes,
} from "@giga-app/interface";
import { useLocation, useParams } from "react-router";
import { PrivateScope, PublicScope } from "./useScope";
import { WithIndexedContext } from "@peerbit/document";
import { base64url } from "multiformats/bases/base64";
import { getScopeAddrsFromSearch } from "../routes";

export interface ICanvasContext {
    scope?: Scope; // kept for compatibility
    root?: WithIndexedContext<Canvas, IndexableCanvas>;
    leaf?: WithIndexedContext<Canvas, IndexableCanvas>;
    path: WithIndexedContext<Canvas, IndexableCanvas>[];
    loading: boolean;
    createCanvasAtPath: () => Promise<WithIndexedContext<Canvas, IndexableCanvas>[]>;
    setRoot: (root: WithIndexedContext<Canvas, IndexableCanvas>) => void;
    viewRoot?: WithIndexedContext<Canvas, IndexableCanvas>;
    standalone?: Canvas[];
}

/** Decode the `:id` param (base64url) → bytes. Returns undefined if missing/malformed. */
const decodePathId = (idParam?: string): Uint8Array | undefined => {
    if (!idParam) return undefined;
    try {
        return base64url.decode(idParam);
    } catch {
        return undefined;
    }
};

export function createCanvasScope() {
    const initialCtx: ICanvasContext = {
        loading: true,
        path: [],
        createCanvasAtPath: async () => [],
        setRoot: () => { },
    };

    const Ctx = createContext<ICanvasContext>(initialCtx);
    const useCanvases = () => useContext(Ctx);

    const CanvasProvider = ({ children }: { children: JSX.Element }) => {
        const publicScope = PublicScope.useScope().scope;
        const privateScope = PrivateScope.useScope().scope;

        const { peer, loading: loadingPeer, persisted } = usePeer();
        const location = useLocation();

        const { id: idParam } = useParams(); // /c/:id
        const idBytes = decodePathId(idParam);

        const [root, _setRoot] =
            useState<WithIndexedContext<Canvas, IndexableCanvas> | undefined>();
        const [path, setPath] =
            useState<WithIndexedContext<Canvas, IndexableCanvas>[]>([]);
        const [isLoading, setIsLoading] = useState(true);
        const [standalone, setStandalone] = useState<WithIndexedContext<Canvas, IndexableCanvas>[] | undefined>();

        // avoid race-y path updates
        const reqToken = useRef(0);

        // choose candidate scopes from URL ?scopes=a,b (default: all available)
        const scopeAddrsFromUrl = useMemo(
            () => getScopeAddrsFromSearch(location.search),
            [location.search]
        );

        const availableScopes = useMemo(
            () => [publicScope, privateScope].filter(Boolean) as Scope[],
            [publicScope?.address, privateScope?.address]
        );

        const candidateScopes = useMemo(() => {
            if (!scopeAddrsFromUrl.length) return availableScopes;
            const set = new Set(scopeAddrsFromUrl);
            return availableScopes.filter((s) => set.has(s.address));
        }, [availableScopes, scopeAddrsFromUrl.join("|")]);

        const setRoot = (c: WithIndexedContext<Canvas, IndexableCanvas>) => {
            setPath([]);
            _setRoot(c);
        };

        const leaf = useMemo(
            () => (path.length ? path[path.length - 1] : undefined),
            [path]
        );

        const openAndIndex = async (canvases: Canvas[]) => {
            if (!root) return [];
            const opened = await Promise.all(
                canvases.map((c) =>
                    root.nearestScope
                        .openWithSameSettings(c)
                        .then((cc) => cc.getSelfIndexedCoerced())
                )
            );
            return opened;
        };

        const createCanvasAtPath = async () => {
            if (!root) throw new Error("Root not found");
            if (!candidateScopes.length) return [root];

            setIsLoading(true);
            const token = ++reqToken.current;
            try {
                const canvases =
                    !idBytes
                        ? [root as any as Canvas]
                        : await (async () => {
                            const current = await loadCanvasFromScopes(idBytes, candidateScopes, { local: true });
                            if (!current) return [root as any as Canvas];
                            return current.loadPath({ includeSelf: true });
                        })();

                const opened = await openAndIndex(canvases);
                if (token === reqToken.current) setPath(opened);
                return opened;
            } finally {
                if (token === reqToken.current) setIsLoading(false);
            }
        };

        // sync path with URL (id/scopes) and scope availability
        useEffect(() => {
            if (!root || !candidateScopes.length) return;
            const token = ++reqToken.current;
            setIsLoading(true);

            (async () => {
                const canvases =
                    !idBytes
                        ? [root as any as Canvas]
                        : await (async () => {
                            const current = await loadCanvasFromScopes(idBytes, candidateScopes, { local: true });
                            if (!current) return [root as any as Canvas];
                            return current.loadPath({ includeSelf: true });
                        })();

                const opened = await openAndIndex(canvases);
                if (token === reqToken.current) setPath(opened);
            })()
                .catch(console.error)
                .finally(() => {
                    if (token === reqToken.current) setIsLoading(false);
                });
        }, [
            root?.idString,
            idParam,                       // route id changes
            candidateScopes.map(s => s.address).join("|"), // scope filter changes
        ]);

        // ensure a root exists (public root by default)
        useEffect(() => {
            if (!peer || !publicScope) return;

            if (root) {
                if (!root.initialized) {
                    root
                        .load(peer, { args: { replicate: persisted } })
                        .then((c) => c.getSelfIndexedCoerced())
                        .then(setRoot)
                        .catch(console.error);
                }
                return;
            }

            createRoot(peer, {
                persisted,
                scope: publicScope,
                sections: ["About", "Help"],
            })
                .then((res) => res.canvas)
                .then(setRoot)
                .catch((e) => console.error("Error creating root canvas:", e));
        }, [peer?.identity?.toString(), publicScope?.address, persisted]);

        // ancestor chain (for breadcrumbs etc.)
        useEffect(() => {
            let cancelled = false;
            (async () => {
                if (!leaf) return setStandalone(undefined);
                const chain = await (leaf as any as Canvas).getStandaloneParent();
                if (!cancelled) setStandalone(chain || undefined);
            })();
            return () => {
                cancelled = true;
            };
        }, [leaf?.idString]);

        const value = useMemo<ICanvasContext>(
            () => ({
                scope: publicScope,
                root,
                leaf,
                setRoot,
                path,
                loading: isLoading || loadingPeer,
                createCanvasAtPath,
                standalone,
                viewRoot: standalone?.[0],
            }),
            [
                publicScope?.address,
                root?.idString,
                leaf?.idString,
                path.length,
                standalone,
                isLoading,
                loadingPeer,
            ]
        );

        return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
    };

    return { CanvasProvider, useCanvases };
}

export const PublicCanvasScope = createCanvasScope();
export const useCanvases = PublicCanvasScope.useCanvases;
