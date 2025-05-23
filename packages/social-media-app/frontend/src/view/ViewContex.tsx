import React, {
    createContext,
    useContext,
    useState,
    useEffect,
    useMemo,
    ReactNode,
    useRef,
} from "react";
import { usePeer, useProgram, useQuery } from "@peerbit/react";
import {
    Canvas as CanvasDB,
    Canvas,
    Views,
    View,
    CanvasAddressReference,
} from "@giga-app/interface";
import { useCanvases } from "../canvas/useCanvas";
import type { WithContext } from "@peerbit/document";
import { useSearchParams } from "react-router";
import { BodyStyler } from "./BodyStyler";
import { ALL_DEFAULT_VIEWS } from "./defaultViews";
/**
 * Debounce any primitive or reference value *together* so React effects that depend on multiple
 * pieces of state run **once** instead of once‑per‑piece. The update is flushed after `delay` ms.
 */
function useCombinedDebounced<A, B>(a: A, b: B, delay: number): { a: A; b: B } {
    const [debounced, setDebounced] = useState<{ a: A; b: B }>({
        a,
        b,
    });
    const timeout = useRef<ReturnType<typeof setTimeout>>();

    useEffect(() => {
        clearTimeout(timeout.current);
        timeout.current = setTimeout(
            () =>
                setDebounced({
                    a,
                    b,
                }),
            delay
        );
        return () => clearTimeout(timeout.current);
    }, [a, b, delay]);

    return debounced;
}

export type LineType = "start" | "end" | "end-and-start" | "none" | "middle";

// Helper: retrieves parent's address from a canvas message.
function getParentAddress(msg: WithContext<Canvas>): string | undefined {
    return msg.path.length ? msg.path[msg.path.length - 1].address : undefined;
}

// Helper: ensure canvas address calculation before transform.
const calculateAddress = async (p: WithContext<Canvas>) => {
    await p.calculateAddress();
    return p;
};

function useViewContextHook() {
    const { path: canvases, loading } = useCanvases();

    const { peer } = usePeer();

    // Instead of separate view state, derive view from URL:
    const [searchParams, setSearchParams] = useSearchParams();
    const view: string = (searchParams.get("view") as string) || "best";

    // Whenever you need to change view, update the URL.
    const changeView = (newView: string) => {
        if (newView !== view) {
            const newParams = new URLSearchParams(searchParams.toString());
            newParams.set("view", newView);
            setSearchParams(newParams, { replace: true });
        }
    };

    /* =====================================================================================
     *  🚀 Debounce *both* values together so the next effect fires only once per change‑set.
     * ===================================================================================== */
    const { a: debouncedView, b: debouncedCanvases } = useCombinedDebounced(
        view,
        canvases,
        123
    );

    const viewRoot = React.useMemo<CanvasDB | undefined>(
        () =>
            debouncedCanvases?.length
                ? debouncedCanvases[debouncedCanvases.length - 1]
                : undefined,
        [debouncedCanvases]
    );

    const views = useProgram(
        useMemo(
            () => (viewRoot ? new Views({ canvasId: viewRoot.id }) : undefined),
            [viewRoot]
        ),
        { existing: "reuse" }
    );

    const { items: dynamicViewItems } = useQuery(views.program?.views, {
        query: useMemo(() => {
            return {};
        }, []),
        onChange: {
            merge: true,
        },
        prefetch: true,
        local: true,

        remote: {
            eager: true,
        },
    });

    const dynamicViews = useMemo(() => {
        if (!dynamicViewItems) {
            return [];
        }
        return dynamicViewItems.map((item) => item.toViewModel());
    }, [dynamicViewItems]);

    const createView = async (
        name: string,
        description?: CanvasAddressReference /* filter */
    ) => {
        const view = new View({
            id: name,
            canvas: new CanvasAddressReference({ canvas: viewRoot }),
            description: description,
        });
        await views.program.views.put(view);
        return view;
    };

    // Set the query based on view and viewRoot.
    const viewModel = useMemo(() => {
        return (
            dynamicViews.find((x) => x.id === debouncedView) ||
            ALL_DEFAULT_VIEWS.find((x) => x.id == debouncedView)
        );
    }, [debouncedView, dynamicViews]);

    const query = useMemo(() => {
        if (!viewRoot) {
            return undefined;
        }
        if (!viewModel) {
            return undefined;
        }
        if (!viewModel?.query) {
            return undefined;
        }
        return viewModel?.query(viewRoot);
    }, [viewRoot, viewModel]);

    // For lazy loading, we use a paginated hook.
    const [batchSize, setBatchSize] = useState(10); // Default batch size

    const {
        items: sortedReplies,
        loadMore,
        isLoading,
        empty,
        id: iteratorId,
    } = useQuery(
        viewRoot && viewRoot.loadedReplies ? viewRoot.replies : undefined,
        {
            query,
            reverse: viewModel?.settings.focus === "last" ? true : false,
            transform: calculateAddress,
            batchSize,
            debug: false, // { id: "replies" },
            local: true,
            remote: {
                eager: true,
                warmup: 5e3,
            },
            onChange: {
                merge: async (e) => {
                    for (const change of e.added) {
                        const hash = change.__context.head;
                        const entry = await viewRoot!.replies.log.log.get(hash);
                        for (const signer of await entry.getSignatures()) {
                            if (
                                signer.publicKey.equals(peer.identity.publicKey)
                            ) {
                                return e; // merge the change since it was made by me
                            }
                        }
                    }
                    return undefined;
                },
                update:
                    viewModel?.settings.focus === "last"
                        ? undefined
                        : (prev, e) => {
                              prev.unshift(...e.added);
                              return prev;
                          },
            },
        }
    );

    const lastReply = useMemo(() => {
        if (sortedReplies && sortedReplies.length > 0) {
            return sortedReplies[sortedReplies.length - 1];
        }
        return undefined;
    }, [sortedReplies]);

    // --- Reply Processing for "chat" view, inserting quotes ---
    function replyLineTypes({
        current,
        next,
        context,
    }: {
        current: WithContext<Canvas>;
        next?: WithContext<Canvas>;
        context: CanvasDB;
    }): LineType {
        const currentParent = getParentAddress(current);
        const nextParent = next ? getParentAddress(next) : undefined;
        const directChild = !!(next && nextParent === current.address);

        if (currentParent === context.address) {
            return directChild ? "start" : "none";
        } else {
            return directChild ? "middle" : "end";
        }
    }

    function quotesToInsert({
        replies,
        current,
        next,
    }: {
        replies: WithContext<Canvas>[];
        current: WithContext<Canvas>;
        next?: Canvas;
    }): WithContext<Canvas>[] {
        if (!next || next.path.length === 0) return [];
        const lastElements = {
            next: next.path[next.path.length - 1],
            current: current.path?.length
                ? current.path[current.path.length - 1]
                : undefined,
        };
        return lastElements.next.address !== lastElements.current?.address &&
            current.address !== lastElements.next.address
            ? replies.filter(
                  (reply) => reply.address === lastElements.next.address
              )
            : [];
    }

    function insertQuotes(
        replies: WithContext<Canvas>[],
        context: CanvasDB
    ): {
        id: string;
        reply: WithContext<Canvas>;
        type: "reply" | "quote";
        lineType: LineType;
    }[] {
        const repliesAndQuotes: {
            id: string;
            reply: WithContext<Canvas>;
            type: "reply" | "quote";
        }[] = replies.map((reply) => ({
            id: reply.idString,
            reply,
            type: "reply" as const,
        }));
        for (let i = 0; i < repliesAndQuotes.length - 1; i++) {
            const current = repliesAndQuotes[i];
            const next = repliesAndQuotes[i + 1];
            const quotes = quotesToInsert({
                current: current.reply,
                next: next.reply,
                replies,
            });
            /* TODO 
            if (quotes.length > 0) {
                repliesAndQuotes.splice(
                    i + 1,
                    0,
                    ...quotes.map((quote) => ({
                        type: "quote" as const,
                        reply: quote,
                        id: current.reply.idString + "-" + quote.idString,
                    }))
                );
                i += quotes.length;
            } */
        }
        return repliesAndQuotes.map((item, i, arr) => {
            const current = item.reply;
            const next = i < arr.length - 1 ? arr[i + 1].reply : undefined;
            return {
                ...item,
                lineType: replyLineTypes({ current, next, context }),
            };
        });
    }

    const processedReplies = useMemo(() => {
        if (!viewRoot || viewRoot.closed) {
            return [];
        }
        if (
            debouncedView === "chat" &&
            sortedReplies &&
            sortedReplies.length > 0 &&
            viewRoot
        ) {
            return insertQuotes(sortedReplies, viewRoot);
        }
        return sortedReplies
            ? sortedReplies.map((reply) => ({
                  reply,
                  type: "reply" as const,
                  lineType: "none" as const,
                  id: reply.idString,
              }))
            : [];
    }, [sortedReplies, debouncedView, viewRoot?.closed, viewRoot]);

    return {
        canvases: debouncedCanvases,
        viewRoot,
        defaultViews: ALL_DEFAULT_VIEWS,
        dynamicViews,
        createView,
        view: viewModel,
        setView: changeView, // now changes update the URL
        loadMore,
        hasMore: () => !empty(),
        isLoading,
        iteratorId,
        lastReply,
        sortedReplies,
        processedReplies,
        loading,
        batchSize,
        setBatchSize,
    };
}

// Define the context type.
export type ViewContextType = ReturnType<typeof useViewContextHook>;

// Create the context.
const ViewContext = createContext<ViewContextType | undefined>(undefined);

// Provider component wrapping children.
export const ViewProvider: React.FC<{ children: ReactNode }> = ({
    children,
}) => {
    const view = useViewContextHook();
    return (
        <ViewContext.Provider value={view}>
            <BodyStyler />
            {children}
        </ViewContext.Provider>
    );
};

// Custom hook for consumers.
export const useView = (): ViewContextType => {
    const context = useContext(ViewContext);
    if (!context) {
        throw new Error("useView must be used within a ViewProvider");
    }
    return context;
};
