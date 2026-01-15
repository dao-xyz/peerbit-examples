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
import { PrivateScope, PublicScope } from "./useScope";
import { WithIndexedContext } from "@peerbit/document";
import { getCanvasIdFromPart, getScopeAddrsFromSearch } from "../routes";
import { useLocation, useMatch } from "react-router";
import { publishStartupPerfSnapshot, startupMark } from "../debug/perf";

export interface ICanvasContext {
    scope?: Scope; // kept for compatibility
    root?: WithIndexedContext<Canvas, IndexableCanvas>;
    leaf?: WithIndexedContext<Canvas, IndexableCanvas>;
    path: WithIndexedContext<Canvas, IndexableCanvas>[];
    loading: boolean;
    /* createCanvasAtPath: () => Promise<WithIndexedContext<Canvas, IndexableCanvas>[]>; */
    setRoot: (root: WithIndexedContext<Canvas, IndexableCanvas>) => void;
    viewRoot?: WithIndexedContext<Canvas, IndexableCanvas>;
}

const initialCtx: ICanvasContext = {
    loading: true,
    path: [],
    /*  createCanvasAtPath: async () => [], */
    setRoot: () => {},
};

const Ctx = createContext<ICanvasContext>(initialCtx);
const useCanvases = () => useContext(Ctx);

const CanvasProvider = ({ children }: { children: JSX.Element }) => {
    const publicScope = PublicScope.useScope();
    const privateScope = PrivateScope.useScope();

    const { peer, loading: loadingPeer, persisted } = usePeer();
    const location = useLocation();

    const matchA = useMatch("/c/:id/*");
    const matchB = useMatch("/c/:id");
    const match = matchA || matchB;

    const idParam = match?.params?.id; // string | undefined
    const idBytes = getCanvasIdFromPart(idParam);

    const [root, _setRoot] = useState<
        WithIndexedContext<Canvas, IndexableCanvas> | undefined
    >();
    const [path, setPath] = useState<
        WithIndexedContext<Canvas, IndexableCanvas>[]
    >([]);
    const [isLoading, setIsLoading] = useState(true);
    const [standalone, setStandalone] = useState<
        WithIndexedContext<Canvas, IndexableCanvas>[] | undefined
    >();

    // avoid race-y path updates
    const reqToken = useRef(0);
    const creatingRootRef = useRef<Promise<void> | null>(null);

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

    useEffect(() => {
        if (!leaf) return setStandalone(undefined);

        const chain = [leaf]; // TODO: await leaf.getStandaloneParent();
        setStandalone(chain || undefined);
    }, [leaf?.idString]);

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

    /* TODO? const createCanvasAtPath = async () => {
         if (!root) throw new Error("Root not found");
         if (!candidateScopes.length) return [root];
 
         setIsLoading(true);
         const token = ++reqToken.current;
         try {
             console.log("loading starting canvases", idParam);
             const canvases =
                 !idBytes
                     ? [root]
                     : await (async () => {
                         const current = await loadCanvasFromScopes(idBytes, candidateScopes, {
                             local: true,
                         });
                         if (!current) return [root];
                         const path = current.loadPath({ includeSelf: true });
                         console.log("done loading starting canvases");
                         return path;
                     })();
 
             const opened = await openAndIndex(canvases);
             if (token === reqToken.current) setPath(opened);
             return opened;
         } finally {
             if (token === reqToken.current) setIsLoading(false);
         }
     };
  */
    // sync path with URL (id/scopes) and scope availability
    useEffect(() => {
        if (!root || !candidateScopes.length) {
            return;
        }

        const token = ++reqToken.current;
        setIsLoading(true);
        startupMark("canvas:path:sync:start", {
            idParam,
            scopes: candidateScopes.map((s) => s.address),
        });

        let cancelled = false;
        (async () => {
            const canvases = !idBytes
                ? [root]
                : await (async () => {
                      const current = await loadCanvasFromScopes(
                          idBytes,
                          candidateScopes,
                          {
                              local: true,
                          }
                      );
                      if (!current) return [root];
                      // `loadPath({ includeSelf: true })` requires the canvas to already be indexed.
                      // Right after publish, the document may exist while its indexed row is still
                      // being built, which can throw and break navigation. Build the ancestry
                      // without self, then index/open everything in `openAndIndex`.
                      const parents = await current.loadPath({
                          includeSelf: false,
                      });
                      const path = [...parents, current];
                      console.log("done loading path canvases", path);
                      return path;
                  })();

            if (cancelled) return;
            const opened = await openAndIndex(canvases);
            if (!cancelled && token === reqToken.current) setPath(opened);
        })()
            .catch(console.error)
            .finally(() => {
                startupMark("canvas:path:sync:end", {
                    idParam,
                });
                publishStartupPerfSnapshot("canvas:path:sync:end");
                if (!cancelled && token === reqToken.current)
                    setIsLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [
        root?.idString,
        idParam, // route id changes
        candidateScopes,
    ]);

    // ensure a root exists (public root by default)
    useEffect(() => {
        if (!peer || !publicScope) {
            return;
        }

        // Already have a root: ensure it's loaded/initialized
        if (root) {
            if (!root.initialized) {
                setIsLoading(true);
                startupMark("canvas:root:load:start", {
                    persisted,
                    peerHash: peer.identity.publicKey.hashcode(),
                });
                let cancelled = false;
                root.load(peer, { args: { replicate: persisted } })
                    .then((c) => c.getSelfIndexedCoerced())
                    .then((c) => {
                        if (!cancelled) setRoot(c);
                    })
                    .catch(console.error)
                    .finally(() => {
                        startupMark("canvas:root:load:end");
                        publishStartupPerfSnapshot("canvas:root:load:end");
                        if (!cancelled) setIsLoading(false);
                    });

                return () => {
                    cancelled = true;
                };
            }
            return;
        }

        // Guard: avoid launching multiple createRoot calls during HMR
        if (!creatingRootRef.current) {
            setIsLoading(true);
            startupMark("canvas:root:create:start", {
                persisted,
                peerHash: peer.identity.publicKey.hashcode(),
            });
            creatingRootRef.current = (async () => {
                const res = await createRoot(peer, {
                    persisted,
                    scope: publicScope,
                    sections: ["About", "Help"],
                });
                const ix = await res.canvas.getSelfIndexedCoerced();
                setRoot(ix);
            })()
                .catch((e) => console.error("Error creating root canvas:", e))
                .finally(() => {
                    startupMark("canvas:root:create:end");
                    publishStartupPerfSnapshot("canvas:root:create:end");
                    creatingRootRef.current = null;
                    setIsLoading(false);
                });
        }
    }, [peer?.identity?.toString(), publicScope, persisted, root?.idString]);

    useEffect(() => {
        if (!root?.idString) return;
        startupMark("canvas:root:ready", { idString: root.idString });
        publishStartupPerfSnapshot("canvas:root:ready");
    }, [root?.idString]);

    useEffect(() => {
        const viewRoot = standalone?.[0];
        if (!viewRoot?.idString) return;
        startupMark("canvas:viewRoot:ready", { idString: viewRoot.idString });
        publishStartupPerfSnapshot("canvas:viewRoot:ready");
    }, [standalone?.[0]?.idString]);

    // Compose loading: only block on usePeer while peer is actually missing.
    const loading = useMemo(
        () => isLoading || (loadingPeer && !peer),
        [isLoading, loadingPeer, peer]
    );

    const value = useMemo<ICanvasContext>(
        () => ({
            scope: publicScope,
            root,
            leaf,
            setRoot,
            path,
            loading,
            /* createCanvasAtPath, */
            viewRoot: standalone?.[0],
        }),
        [
            publicScope?.address,
            root?.idString,
            leaf?.idString,
            path.length,
            standalone,
            loading,
        ]
    );

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export { CanvasProvider, useCanvases };
