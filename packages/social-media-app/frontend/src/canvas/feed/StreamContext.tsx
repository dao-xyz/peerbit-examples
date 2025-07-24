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
    StreamSettings,
    StreamSetting,
    CanvasAddressReference,
    IndexableCanvas,
    PinnedPosts,
    getTimeQuery,
    getCanvasWithContentQuery,
    getCanvasWithContentTypesQuery,
    getNarrativePostsQuery,
    ChildVisualization,
} from "@giga-app/interface";
import { PrivateCanvasScope, useCanvases } from "../useCanvas";
import type { WithContext } from "@peerbit/document";
import { useSearchParams } from "react-router";
import { ALL_DEFAULT_FILTERS } from "./defaultViews.js";
import { type WithIndexedContext } from "@peerbit/document";
import {
    DEFAULT_TIME_FILTER,
    DEFAULT_TYPE_FILTER,
    TIME_FILTERS,
    TimeFilter,
    TimeFilterType,
    TYPE_FILTERS,
    TypeFilter,
    TypeFilterType,
} from "./filters.js";
import { useHeaderVisibilityContext } from "../../HeaderVisibilitiyProvider";
import { useVisualizationContext } from "../custom/CustomizationProvider";

/**
 * Debounce any primitive or reference value *together* so React effects that depend on multiple
 * pieces of state run **once** instead of once‑per‑piece. The update is flushed after `delay` ms.
 */
function useCombinedDebounced<A, B>(a: A, b: B, delay: number): { a: A; b: B } {
    const [debounced, setDebounced] = useState<{ a: A; b: B }>({
        a,
        b,
    });
    const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);

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
export const STREAM_QUERY_PARAM_KEY = "r"; // the query parameter key for the stream view
// Helper: retrieves parent's address from a canvas message.
function getParentAddress(msg: WithContext<Canvas>): string | undefined {
    return msg.path.length ? msg.path[msg.path.length - 1].address : undefined;
}

// Helper: ensure canvas address calculation before transform.
const calculateAddress = async (
    p: WithIndexedContext<Canvas, IndexableCanvas>
) => {
    await p.calculateAddress();
    return p;
};

function useStreamContextHook(options?: { private?: boolean }) {
    const { path: canvases, loading, leaf } = options?.private ? PrivateCanvasScope.useCanvases() : useCanvases();
    const [feedRoot, setFeedRoot] = useState<CanvasDB | undefined>(undefined);
    const visualization = useVisualizationContext().visualization;

    useEffect(() => {
        const fn = async () => {
            if (!leaf) {
                return;
            }
            /*    if (leaf.path.length === 0) {
                   return;
               } */
            /* const feedRoot = await leaf.getFeedContext();
            console.log("FEED ROOT", feedRoot);
            setFeedRoot(feedRoot); */
            /*     const type = await leaf.getType();
                if (type instanceof Navigation) {
                    return;
                } */
            setFeedRoot(leaf);
        };
        fn();
    }, [leaf]);

    const { peer } = usePeer();

    // Instead of separate view state, derive view from URL:
    const [searchParams, setSearchParams] = useSearchParams();
    const settingsQuery: string = (searchParams.get(STREAM_QUERY_PARAM_KEY) as string);

    const timeFilter: TimeFilter = TIME_FILTERS.get(
        (searchParams.get("t") as TimeFilterType) || DEFAULT_TIME_FILTER
    );

    const typeFilter: TypeFilter = TYPE_FILTERS.get(
        (searchParams.get("c") as TypeFilterType) || DEFAULT_TYPE_FILTER
    );

    const query: string = (searchParams.get("q") as string) || undefined;

    // ------------ helper that always starts from latest URL -------------
    const mutateParams = React.useCallback(
        (mutator: (p: URLSearchParams) => void) =>
            setSearchParams(
                (prev) => {
                    const p = new URLSearchParams(prev);
                    mutator(p);
                    return p;
                },
                { replace: true }
            ),
        [setSearchParams]
    );

    // ------------ *public* api ------------------------------------------
    const setQueryParams = React.useCallback(
        (opts: {
            view?: string; // undefined = ignore
            time?: TimeFilterType; // 'all'  ⇢ delete 't'
            type?: TypeFilterType; // 'all'  ⇢ delete 'c'
            query?: string; // ''     ⇢ delete 'q'
        }) =>
            mutateParams((p) => {
                if (opts.view !== undefined) p.set(STREAM_QUERY_PARAM_KEY, opts.view);
                if (opts.time !== undefined)
                    opts.time === "all" ? p.delete("t") : p.set("t", opts.time);
                if (opts.type !== undefined)
                    opts.type === "all" ? p.delete("c") : p.set("c", opts.type);
                if (opts.query !== undefined)
                    opts.query ? p.set("q", opts.query) : p.delete("q");
            }),
        [mutateParams]
    );

    // ------------ keep old wrappers for convenience ---------------------
    const changeView = (v: string) =>
        v !== settingsQuery && setQueryParams({ view: v });
    const setTimeFilter = (t: TimeFilterType) =>
        t !== timeFilter.key && setQueryParams({ time: t });
    const setTypeFilter = (t: TypeFilterType) =>
        t !== typeFilter.key && setQueryParams({ type: t });
    const setQuery = (q: string) => q !== query && setQueryParams({ query: q });

    /* =====================================================================================
     *  Debounce *both* values together so the next effect fires only once per change‑set.
     * ===================================================================================== */
    const { a: debouncedView } = useCombinedDebounced(
        settingsQuery,
        canvases,
        123
    );

    const streamSettings = useProgram(
        useMemo(
            () =>
                feedRoot
                    ? new StreamSettings({ canvasId: feedRoot.id })
                    : undefined,
            [feedRoot]
        ),
        { existing: "reuse", keepOpenOnUnmount: true } // don't keep open? (exescissive open closing) or make view a global db isch?
    );

    const { items: dynamicViewItems } = useQuery(
        streamSettings.program?.settings,
        {
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
                joining: {
                    waitFor: 5e3,
                },
            },
        }
    );

    const createSettings = async (
        name: string,
        description?: CanvasAddressReference /* filter */
    ) => {
        const setting = new StreamSetting({
            id: name,
            canvas: new CanvasAddressReference({ canvas: feedRoot }),
            description: description,
        });
        await streamSettings.program.settings.put(setting);
        return setting;
    };

    const pinToView = async (view: StreamSetting, canvas: Canvas) => {
        if (!view.filter) {
            view.filter = new PinnedPosts({ pinned: [] });
        } else if (view.filter instanceof PinnedPosts === false) {
            throw new Error(
                "View filter is not a PinnedPosts filter, cannot pin to view"
            );
        }
        const pinnedPosts = view.filter as PinnedPosts;
        // Check if the canvas is already pinned
        if (pinnedPosts.pinned.some((p) => p.address === canvas.address)) {
            return; // Already pinned, no action needed
        }

        // Pin the canvas to the view
        pinnedPosts.pinned.push(new CanvasAddressReference({ canvas }));
        await streamSettings.program.settings.put(view);
    };

    const headerVisibility = useHeaderVisibilityContext();

    // Set the query based on view and viewRoot.
    const filterModel = useMemo(() => {
        if (visualization?.childrenVisualization === ChildVisualization.CHAT) {
            headerVisibility.setDisabled(true); // scrolling direction is different in chat so we disable hiding of headers by sroll
            return ALL_DEFAULT_FILTERS.find(x => x.id === "chat");
        } else {
            headerVisibility.setDisabled(false);
            let viewToFind = debouncedView || "best"; // default to "best" if no view is set
            const newView =
                dynamicViewItems
                    .find((x) => x.id === viewToFind)
                    ?.toFilterModel() ||
                ALL_DEFAULT_FILTERS.find((x) => x.id == viewToFind);
            return newView;

        }
    }, [debouncedView, dynamicViewItems, visualization]);

    const canvasQuery = useMemo(() => {
        if (!feedRoot) {
            return undefined;
        }
        if (!filterModel) {
            return undefined;
        }
        if (!filterModel?.query) {
            return undefined;
        }
        const queryObject = filterModel?.query(feedRoot);
        if (timeFilter) {
            if (timeFilter.key !== "all") {
                let delta = 0;
                if (timeFilter.key === "24h") {
                    delta = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
                } else if (timeFilter.key === "7d") {
                    delta = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
                } else if (timeFilter.key === "30d") {
                    delta = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
                } else {
                    throw new Error(
                        `Unknown time filter type: ${timeFilter.key}`
                    );
                }
                queryObject.query.push(getTimeQuery(delta));
            }
        }
        if (typeFilter) {
            if (typeFilter.types?.length > 0) {
                queryObject.query.push(
                    getCanvasWithContentTypesQuery(typeFilter.types)
                );
            }
        }

        // add narrative type filter
        queryObject.query.push(getNarrativePostsQuery());
        if (query?.length > 0) {
            queryObject.query.push(getCanvasWithContentQuery(query));
        }
        return queryObject;
    }, [feedRoot, filterModel, timeFilter, typeFilter?.key, query]);

    // For lazy loading, we use a paginated hook.
    const [batchSize, setBatchSize] = useState(3); // Default batch size
    const {
        items: sortedReplies,
        loadMore,
        isLoading,
        empty,
        id: iteratorId,
    } = useQuery(
        feedRoot && feedRoot.loadedReplies ? feedRoot.replies : undefined,
        {
            query: canvasQuery,
            reverse:
                visualization?.childrenVisualization === ChildVisualization.CHAT
                    ? true
                    : false,
            transform: calculateAddress,
            batchSize,
            debug: false /* { id: "replies" }, */,
            local: true,
            remote: {
                joining: {
                    waitFor: 5e3,
                },
            },
            onChange: {
                merge: async (e) => {
                    for (const change of e.added) {
                        const hash = change.__context.head;
                        const entry = await feedRoot!.replies.log.log.get(hash);
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
                update: async (prev, filtered) => {
                    const merged = await feedRoot.replies.index.updateResults(
                        prev,
                        filtered,
                        canvasQuery,
                        true
                    );
                    if (
                        visualization?.childrenVisualization !==
                        ChildVisualization.CHAT
                    ) {
                        // put added at the top
                        for (const added of filtered.added) {
                            const index = merged.findIndex(
                                (item) => item.idString === added.idString
                            );
                            if (index !== -1) {
                                merged.splice(index, 1);
                                merged.unshift(added);
                            }
                        }
                    }
                    return merged;
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
        replies: WithIndexedContext<Canvas, IndexableCanvas>[],
        context: CanvasDB
    ): {
        id: string;
        reply: WithIndexedContext<Canvas, IndexableCanvas>;
        type: "reply" | "quote";
        lineType: LineType;
    }[] {
        const repliesAndQuotes: {
            id: string;
            reply: WithIndexedContext<Canvas, IndexableCanvas>;
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

    const processedReplies: ReturnType<typeof insertQuotes> | undefined =
        useMemo(() => {
            if (!feedRoot || feedRoot.closed) {
                return undefined;
            }
            if (
                debouncedView === "chat" &&
                sortedReplies &&
                sortedReplies.length > 0 &&
                feedRoot
            ) {
                return insertQuotes(sortedReplies, feedRoot);
            }
            return sortedReplies
                ? sortedReplies.map((reply) => ({
                    reply,
                    type: "reply" as const,
                    lineType: "none" as const,
                    id: reply.idString,
                }))
                : [];
        }, [sortedReplies, debouncedView, feedRoot?.closed, feedRoot]);

    return {
        feedRoot,
        pinToView,
        defaultViews: ALL_DEFAULT_FILTERS.filter(x => x.id !== "chat"), // chat is not a default view, it is a special view used when the mode is "chat". TODO do this code less ugly
        dynamicViews: dynamicViewItems,
        createSettings,
        filterModel,
        setView: changeView, // now changes update the URL
        loadMore,
        isLoading,

        loading,
        setBatchSize,
        batchSize,
        iteratorId,
        lastReply,
        sortedReplies,
        processedReplies,

        timeFilter,
        typeFilter,
        setTimeFilter,
        setTypeFilter,
        setQueryParams,

        hasMore: () => !empty(),

        query,
        setQuery,
    };
}

// Define the context type.
export type StreamContextType = ReturnType<typeof useStreamContextHook>;

// Create the context.
const StreamContext = createContext<StreamContextType | undefined>(undefined);

// Provider component wrapping children.
const createStreamProvider = (properties?: { private: boolean }) => {

    const StreamProvider: React.FC<{ children: ReactNode }> = (options) => {
        const view = useStreamContextHook({ private: properties?.private });
        return (
            <StreamContext.Provider value={view}>
                {options.children}
            </StreamContext.Provider>
        );
    };

    // Custom hook for consumers.
    const useStream = (): StreamContextType => {
        const context = useContext(StreamContext);
        if (!context) {
            throw new Error("useStream must be used within a FeedContext");
        }
        return context;
    };

    return { StreamProvider, useStream };

}

export const PublicStreamScope = createStreamProvider();
export const PrivateStreamScope = createStreamProvider({ private: true });
export const useStream = PublicStreamScope.useStream;
