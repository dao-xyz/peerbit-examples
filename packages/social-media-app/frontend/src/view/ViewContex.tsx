import React, {
    createContext,
    useContext,
    useState,
    useEffect,
    useMemo,
    ReactNode,
} from "react";
import { usePeer, useQuery } from "@peerbit/react";
import {
    Canvas as CanvasDB,
    Canvas,
    getImmediateRepliesQuery,
    getRepliesQuery,
} from "@giga-app/interface";
import { useCanvases } from "../canvas/useCanvas";
import {
    SearchRequest,
    SearchRequestIndexed,
} from "@peerbit/document-interface";
import { Sort, SortDirection } from "@peerbit/indexer-interface";
import type { WithContext } from "@peerbit/document";
import { useSearchParams } from "react-router";
import { BodyStyler } from "./BodyStyler";

export type ViewType = "new" | "old" | "best" | "chat";
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
    const { root, path: canvases, loading } = useCanvases();
    const { peer } = usePeer();

    // Instead of separate view state, derive view from URL:
    const [searchParams, setSearchParams] = useSearchParams();
    const view: ViewType = (searchParams.get("view") as ViewType) || "best";

    // Whenever you need to change view, update the URL.
    const changeView = (newView: ViewType) => {
        if (newView !== view) {
            const newParams = new URLSearchParams(searchParams.toString());
            newParams.set("view", newView);
            setSearchParams(newParams, { replace: true });
        }
    };

    // View root state: latest canvas from the list of canvases.
    const [viewRoot, setViewRoot] = useState<CanvasDB | undefined>(undefined);
    useEffect(() => {
        if (canvases && canvases.length > 0) {
            setViewRoot(canvases[canvases.length - 1]);
        }
    }, [canvases, root?.closed, root?.address]);

    // --- Query & Reply Fetching Management ---
    const getQueryId = (canvas: CanvasDB, sortCriteria: ViewType) => {
        return canvas.idString + sortCriteria;
    };

    // Set the query based on view and viewRoot.
    const [query, setQuery] = useState<{
        query: SearchRequest | null;
        id: string;
        reverse?: boolean;
    }>({ query: null, id: "" });

    useEffect(() => {
        if (!viewRoot) return;
        if (view === "chat") {
            setQuery({
                query: new SearchRequest({
                    query: getRepliesQuery(viewRoot),
                    sort: [
                        new Sort({
                            key: ["__context", "created"],
                            direction: SortDirection.DESC,
                        }),
                    ],
                }),
                id: getQueryId(viewRoot, view),
                reverse: true,
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
                                ? SortDirection.DESC
                                : SortDirection.ASC,
                    }),
                }),
                id: getQueryId(viewRoot, view),
                reverse: view === "new",
            });
        }
    }, [view, viewRoot, calculateAddress]);

    // For lazy loading, we use a paginated hook.
    const [batchSize, setBatchSize] = useState(5); // Default batch size
    const {
        items: sortedReplies,
        loadMore,
        isLoading,
    } = useQuery(
        viewRoot && viewRoot.loadedReplies ? viewRoot.replies : undefined,
        {
            ...query,
            transform: calculateAddress,
            batchSize,
            /*    debug: { id: "replies" }, */
            local: true,
            remote: {
                eager: true,
            },
            onChange: {
                merge: async (e) => {
                    // filter only changes made by me
                    for (const change of e.added) {
                        const hash = change.__context.head;
                        const entry = await viewRoot.replies.log.log.get(hash);
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
                    view === "chat" || view === "new"
                        ? undefined
                        : (prev, e) => {
                              // insert at the top
                              prev.unshift(...e.added);
                              console.log("UPDATE", prev, e.added);
                              return prev;
                          },
            },
        }
    );

    /*   const { items: all } = useQuery(
          viewRoot && viewRoot.loadedReplies ? viewRoot.replies : undefined,
          {
  
              ...{
                  ...query,
                  query: new SearchRequestIndexed({
                      ...query.query
                  }),
  
              },
              id: viewRoot ? getQueryId(viewRoot, view) : "",
              transform: calculateAddress,
              batchSize,
              resolve: false,
              debug: { id: "replies" },
              onChange: {
                   merge: async (e) => {
                      // filter only changes made by me
                      for (const change of e.added) {
                          const hash = change.__context.head;
                          const entry = await viewRoot.replies.log.log.get(hash);
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
                      view === "chat" || view === "new"
                          ? undefined
                          : (prev, e) => {
                              // insert at the top
                              prev.unshift(...e.added);
                              console.log("UPDATE", prev, e.added);
                              return prev;
                          },
              },
          }
      ); */

    const lastReply = useMemo(() => {
        if (sortedReplies && sortedReplies.length > 0) {
            return sortedReplies[sortedReplies.length - 1];
        }
        return undefined;
    }, [sortedReplies]);
    /*  console.log({ sortedReplies, all }); */

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
        if (next === undefined || next.path.length === 0) return [];
        const lastElements = {
            next: next.path[next.path.length - 1],
            current:
                current.path?.length > 0
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
                  id: reply.idString,
              }))
            : [];
    }, [sortedReplies, view, viewRoot?.closed, viewRoot]);

    return {
        canvases,
        viewRoot,
        view,
        setView: changeView, // now changes update the URL
        loadMore,
        isLoading,
        query,
        lastReply,
        sortedReplies,
        processedReplies,
        loading,
        batchSize,
        setBatchSize,
    };
}

// Define the context type.
type ViewContextType = ReturnType<typeof useViewContextHook>;

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
