// ViewContext.tsx
import React, {
    createContext,
    useContext,
    useState,
    useEffect,
    useMemo,
    ReactNode,
} from "react";
import { useLocal } from "@peerbit/react";
import {
    Canvas as CanvasDB,
    Canvas,
    getImmediateRepliesQuery,
    getRepliesQuery,
} from "@giga-app/interface";
import { useCanvases } from "../canvas/useCanvas";
import { SearchRequest } from "@peerbit/document-interface";
import { Sort, SortDirection } from "@peerbit/indexer-interface";
import type { WithContext } from "@peerbit/document";
import { useSearchParams } from "react-router-dom";

export type ViewType = "new" | "old" | "best" | "chat";
export type LineType = "start" | "end" | "end-and-start" | "none" | "middle";

/**
 * Custom hook that encapsulates view–related logic,
 * including query management and fetching of replies.
 */

function getParentAddress(msg: WithContext<Canvas>): string | undefined {
    return msg.path.length ? msg.path[msg.path.length - 1].address : undefined;
}

const calculateAddress = async (p: WithContext<Canvas>) => {
    await p.calculateAddress();
    return p;
};
function useViewContextHook() {
    const { root, path: canvases, loading } = useCanvases();
    // Sorting / view type state
    const [view, setView] = useState<ViewType | undefined>(undefined);

    // View root state: latest canvas from the list of canvases
    const [viewRoot, setViewRoot] = useState<CanvasDB | undefined>(undefined);
    useEffect(() => {
        if (canvases && canvases.length > 0) {
            setViewRoot(canvases[canvases.length - 1]);
        }
    }, [canvases, root?.closed, root?.address]);

    // --- Query & Reply Fetching Management ---

    // State to hold our query (a SearchRequest and a unique id)
    const [query, setQuery] = useState<
        { query: SearchRequest; id: string } | undefined
    >(undefined);

    // Helper to create a unique query id based on the canvas and view type.
    const getQueryId = (canvas: CanvasDB, sortCriteria: ViewType) => {
        return canvas.idString + sortCriteria;
    };

    // Inside your hook:
    const [searchParams, setSearchParams] = useSearchParams();

    // On mount, read the "view" parameter from the URL:
    useEffect(() => {
        const urlView = searchParams.get("view");
        if (urlView && ["new", "old", "best", "chat"].includes(urlView)) {
            setView(urlView as ViewType);
        } else if (!view) {
            setView("new");
        }
    }, [searchParams]);

    // Whenever the view changes, update the URL query parameter:
    useEffect(() => {
        if (view) {
            if (searchParams.get("view") !== view) {
                searchParams.set("view", view);
                setSearchParams(searchParams, { replace: true });
            }
        }
    }, [view, searchParams, setSearchParams]);

    // When the view type or viewRoot changes, set the appropriate query.
    useEffect(() => {
        if (!viewRoot) return;
        if (view === "chat") {
            setQuery({
                query: new SearchRequest({
                    query: getRepliesQuery(viewRoot),
                    sort: [
                        new Sort({
                            key: ["replies"],
                            direction: SortDirection.DESC,
                        }),
                        new Sort({
                            key: ["__context", "created"],
                            direction: SortDirection.ASC,
                        }),
                    ],
                }),
                id: getQueryId(viewRoot, view),
            });
        } else if (view === "best") {
            setQuery({
                query: new SearchRequest({
                    query: getImmediateRepliesQuery(viewRoot),
                    sort: [
                        new Sort({
                            key: ["replies"],
                            direction: SortDirection.DESC,
                        }),
                        new Sort({
                            key: ["__context", "created"],
                            direction: SortDirection.DESC,
                        }),
                    ],
                }),
                id: getQueryId(viewRoot, view),
            });
        } else {
            // "new" or "old"
            setQuery({
                query: new SearchRequest({
                    query: getImmediateRepliesQuery(viewRoot),
                    sort: new Sort({
                        key: ["__context", "created"],
                        direction:
                            view === "new"
                                ? SortDirection.ASC
                                : SortDirection.DESC,
                    }),
                }),
                id: getQueryId(viewRoot, view),
            });
        }
    }, [view, viewRoot, calculateAddress]);

    // Use the query (if available) to fetch sorted replies from the viewRoot.
    const sortedReplies = useLocal(
        viewRoot && viewRoot.loadedReplies ? viewRoot.replies : undefined,
        { ...query, transform: calculateAddress } // for some reason if we set the transform function in the setQuery it does not work, propagate to useLocal?
    );

    // --- Reply Processing for "chat" view (inserting quotes) ---
    function replyLineTypes({
        prev,
        current,
        next,
        context,
    }: {
        prev?: WithContext<Canvas>;
        current: WithContext<Canvas>;
        next?: WithContext<Canvas>;
        context: CanvasDB;
    }): LineType {
        // Get parent addresses.
        const currentParent = getParentAddress(current);
        const nextParent = next ? getParentAddress(next) : undefined;
        const prevParent = prev ? getParentAddress(prev) : undefined;

        // Determine whether the current reply is the first in its chain.
        // (If there is no previous reply or if the previous reply’s parent is different, current is first.)
        const isFirstInChain = !prev || (prev && prevParent !== currentParent);

        // Check whether the next reply is a direct child of current.
        const nextIsDirectChild = nextParent === current.address;

        // Also, check if the next reply is a sibling (same parent as current).
        const nextIsSibling =
            nextParent && currentParent && nextParent === currentParent;

        // If there is no next reply:
        if (!next) {
            // If current is nested (its parent is not the context) and is not the first in its chain,
            // we mark it as the end of a chain.
            return currentParent &&
                currentParent !== context.address &&
                !isFirstInChain
                ? "end"
                : "none";
        }

        // If the next reply is a direct child of current, then we are in a parent–child chain.
        if (nextIsDirectChild) {
            return isFirstInChain ? "start" : "end-and-start";
        }

        // If the next reply is a sibling (i.e. both share the same parent) then no vertical line should be drawn.
        if (nextIsSibling) {
            return "none";
        }

        // Otherwise, if current was in a chain (direct child of its parent) but the next reply does not continue the chain, mark current as ending the chain.
        if (currentParent && currentParent !== context.address) {
            return "end";
        }

        return "none";
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
        if (next === undefined || next.path.length === 0) return [];
        const lastElements = {
            next: next.path[next.path.length - 1],
            current:
                current.path.length > 0
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
        reply: WithContext<Canvas>;
        type: "reply" | "quote";
        lineType: LineType;
    }[] {
        const repliesAndQuotes: {
            reply: WithContext<Canvas>;
            type: "reply" | "quote";
        }[] = replies.map((reply) => ({ reply, type: "reply" }));
        for (let i = 0; i < repliesAndQuotes.length - 1; i++) {
            const current = repliesAndQuotes[i];
            const next = repliesAndQuotes[i + 1];
            const quotes = quotesToInsert({
                current: current.reply,
                next: next.reply,
                replies,
            });
            if (quotes.length > 0) {
                repliesAndQuotes.splice(
                    i + 1,
                    0,
                    ...quotes.map((quote) => ({
                        type: "quote" as const,
                        reply: quote,
                    }))
                );
                i += quotes.length;
            }
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

    // Compute processed replies: if in chat view, process with quote insertion.
    const processedReplies = useMemo(() => {
        if (!viewRoot || viewRoot.closed) {
            return [];
        }

        if (
            view === "chat" &&
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
              }))
            : [];
    }, [sortedReplies, view, viewRoot?.closed, viewRoot]);

    return {
        canvases,
        viewRoot,
        view,
        setView,
        query,
        sortedReplies,
        processedReplies,
        loading,
    };
}

// Define the context type from our hook’s return value.
type ViewContextType = ReturnType<typeof useViewContextHook>;

// Create the context (initially undefined)
const ViewContext = createContext<ViewContextType | undefined>(undefined);

// Provider component wrapping children with the view context.
export const ViewProvider: React.FC<{ children: ReactNode }> = ({
    children,
}) => {
    const view = useViewContextHook();
    return <ViewContext.Provider value={view}>{children}</ViewContext.Provider>;
};

// Custom hook for child components to access view context.
export const useView = (): ViewContextType => {
    const context = useContext(ViewContext);
    if (!context) {
        throw new Error("useView must be used within a ViewProvider");
    }
    return context;
};
