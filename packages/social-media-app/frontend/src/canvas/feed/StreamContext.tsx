import React, {
    createContext,
    useContext,
    useState,
    useEffect,
    useMemo,
    ReactNode,
    useRef,
} from "react";
import { useQuery } from "@peerbit/document-react";
import { usePeer } from "@peerbit/react";
import {
    Canvas as CanvasDB,
    Canvas,
    IndexableCanvas,
    getTimeQuery,
    getCanvasWithContentQuery,
    getCanvasWithContentTypesQuery,
    ChildVisualization,
    getReplyKindQuery,
    ReplyKind,
} from "@giga-app/interface";
import { useCanvases } from "../useCanvas";
import type { WithContext } from "@peerbit/document";
import { useSearchParams } from "react-router";
import { ALL_DEFAULT_FEED_SETTINGS as ALL_DEFAULT_SETTINGS } from "./defaultFeedSettings.js";
import type { WithIndexedContext } from "@peerbit/document";
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
import { equals } from "uint8arrays";
import { useStreamSettings } from "./StreamSettingsContext";

export const STREAM_QUERY_PARAMS = {
    SETTINGS: "s", // stream view
    TIME: "t", // time filter
    TYPE: "c", // type/content filter
    QUERY: "q", // free-text search
} as const;

export type StreamQueryParamKey =
    (typeof STREAM_QUERY_PARAMS)[keyof typeof STREAM_QUERY_PARAMS];

/** Debounce any primitive or reference value *together* so effects run once per change-set. */
function useCombinedDebounced<A, B>(a: A, b: B, delay: number): { a: A; b: B } {
    const [debounced, setDebounced] = useState<{ a: A; b: B }>({ a, b });
    const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);

    useEffect(() => {
        clearTimeout(timeout.current);
        timeout.current = setTimeout(() => setDebounced({ a, b }), delay);
        return () => clearTimeout(timeout.current);
    }, [a, b, delay]);

    return debounced;
}

export type LineType = "start" | "end" | "end-and-start" | "none" | "middle";

// Helper: retrieves parent's address from a canvas message.
function getParentId(
    msg: WithIndexedContext<Canvas, IndexableCanvas>
): Uint8Array | undefined {
    return msg.__indexed.path.length
        ? msg.__indexed.path[msg.__indexed.path.length - 1]
        : undefined;
}

function useStreamContextHook() {
    const { path: canvases, loading: loadingCanvases, leaf } = useCanvases();
    const [feedRoot, setFeedRoot] = useState<
        WithIndexedContext<CanvasDB, IndexableCanvas> | undefined
    >(undefined);
    const visualization = useVisualizationContext().visualization;

    useEffect(() => {
        if (!leaf) return;
        setFeedRoot(leaf);
    }, [leaf]);

    const { peer } = usePeer();

    // Session-local pinning of newly created posts (cleared on refresh/view change)
    const pinnedIdsRef = useRef(new Set<string>());
    const seenIdsRef = useRef(new Set<string>());
    const hydratedRef = useRef(false);
    const sessionStartRef = useRef<number>(Date.now());

    // URL-derived view state
    const [searchParams, setSearchParams] = useSearchParams();
    const settingsQuery: string = searchParams.get(
        STREAM_QUERY_PARAMS.SETTINGS
    ) as string;

    const timeFilter: TimeFilter = TIME_FILTERS.get(
        (searchParams.get(STREAM_QUERY_PARAMS.TIME) as TimeFilterType) ||
            DEFAULT_TIME_FILTER
    );

    const typeFilter: TypeFilter = TYPE_FILTERS.get(
        (searchParams.get(STREAM_QUERY_PARAMS.TYPE) as TypeFilterType) ||
            DEFAULT_TYPE_FILTER
    );

    const query: string =
        (searchParams.get(STREAM_QUERY_PARAMS.QUERY) as string) || undefined;

    // helper to safely mutate latest URL params
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

    // public api to set params
    const setQueryParams = React.useCallback(
        (opts: {
            settings?: string;
            time?: TimeFilterType; // 'all' → delete 't'
            type?: TypeFilterType; // 'all' → delete 'c'
            query?: string; // ''    → delete 'q'
        }) =>
            mutateParams((p) => {
                if (opts.settings !== undefined)
                    p.set(STREAM_QUERY_PARAMS.SETTINGS, opts.settings);
                if (opts.time !== undefined)
                    opts.time === "all" ? p.delete("t") : p.set("t", opts.time);
                if (opts.type !== undefined)
                    opts.type === "all" ? p.delete("c") : p.set("c", opts.type);
                if (opts.query !== undefined)
                    opts.query
                        ? p.set(STREAM_QUERY_PARAMS.QUERY, opts.query)
                        : p.delete(STREAM_QUERY_PARAMS.QUERY);
            }),
        [mutateParams]
    );

    // convenience wrappers
    const changeSettings = (v: string) =>
        v !== settingsQuery && setQueryParams({ settings: v });
    const setTimeFilterParam = (t: TimeFilterType) =>
        t !== timeFilter.key && setQueryParams({ time: t });
    const setTypeFilterParam = (t: TypeFilterType) =>
        t !== typeFilter.key && setQueryParams({ type: t });
    const setQueryParam = (q: string) =>
        q !== query && setQueryParams({ query: q });

    // Debounce *both* the current view and the canvases path to avoid duplicate effects
    const { a: debouncedView } = useCombinedDebounced(
        settingsQuery,
        canvases,
        123
    );

    // settings (custom views) come from the dedicated provider
    const { dynamicViewItems, createSettings, pinToView } = useStreamSettings();

    const headerVisibility = useHeaderVisibilityContext();
    const wantsHeaderDisabled = visualization?.view === ChildVisualization.CHAT;

    useEffect(() => {
        headerVisibility.setDisabled(!!wantsHeaderDisabled);
    }, [wantsHeaderDisabled, headerVisibility]);

    // --- filter model (pure; no side-effects in render)
    const filterModel = useMemo(() => {
        if (wantsHeaderDisabled) {
            // chat mode uses special 'chat' filter
            return ALL_DEFAULT_SETTINGS.find((x) => x.id === "chat");
        }

        const viewToFind = debouncedView || "best";
        return (
            dynamicViewItems
                .find((x) => x.id === viewToFind)
                ?.toFilterModel() ||
            ALL_DEFAULT_SETTINGS.find((x) => x.id === viewToFind)
        );
    }, [wantsHeaderDisabled, debouncedView, dynamicViewItems]);

    // Only pin on non-chronological feeds (e.g., Best/Top/custom), never on chat.
    const pinningEnabled = useMemo(() => {
        if (!filterModel?.id) return false;
        if (visualization?.view === ChildVisualization.CHAT) return false;
        return filterModel.id !== "new" && filterModel.id !== "recent";
    }, [filterModel?.id, visualization?.view]);

    // Reset pinning state when switching views/roots.
    useEffect(() => {
        pinnedIdsRef.current.clear();
        seenIdsRef.current.clear();
        hydratedRef.current = false;
        sessionStartRef.current = Date.now();
    }, [filterModel?.id, feedRoot?.idString]);

    const registerPins = (
        items: WithIndexedContext<Canvas, IndexableCanvas>[]
    ) => {
        if (!pinningEnabled || !peer?.identity) return;
        const myKey = peer.identity.publicKey.bytes;
        for (const item of items) {
            if (!item?.idString) continue;

            // Skip anything we already evaluated
            if (seenIdsRef.current.has(item.idString)) continue;
            seenIdsRef.current.add(item.idString);

            // Do not pin during the initial hydration pass
            if (!hydratedRef.current) continue;

            const author = item.__indexed?.publicKey;
            if (!author || !equals(author, myKey)) continue;

            const created = item.__context?.created;
            const createdMs =
                typeof created === "bigint"
                    ? Number(created)
                    : typeof created === "number"
                      ? created
                      : undefined;
            if (createdMs == null) continue;
            if (createdMs < sessionStartRef.current) continue;

            pinnedIdsRef.current.add(item.idString);
        }
    };

    // unified replies query
    const canvasQuery = useMemo(() => {
        if (!feedRoot || !filterModel || !filterModel?.query) return undefined;
        const queryObject = filterModel.query(feedRoot);

        if (timeFilter && timeFilter.key !== "all") {
            let delta = 0;
            if (timeFilter.key === "24h") delta = 24 * 60 * 60 * 1000;
            else if (timeFilter.key === "7d") delta = 7 * 24 * 60 * 60 * 1000;
            else if (timeFilter.key === "30d") delta = 30 * 24 * 60 * 60 * 1000;
            else throw new Error(`Unknown time filter type: ${timeFilter.key}`);
            queryObject.query.push(getTimeQuery(delta));
        }

        if (typeFilter && typeFilter.types?.length > 0) {
            queryObject.query.push(
                getCanvasWithContentTypesQuery(typeFilter.types)
            );
        }

        queryObject.query.push(getReplyKindQuery(ReplyKind));

        if (query?.length > 0) {
            queryObject.query.push(getCanvasWithContentQuery(query));
        }

        return queryObject;
    }, [feedRoot, filterModel, timeFilter, typeFilter?.key, query]);

    // Helper to grab latest local results even if the live iterator thinks it's done.
    const fetchLocalReplies = React.useCallback(
        async (n: number) => {
            if (!feedRoot || !canvasQuery) return [];
            const iter = feedRoot.nearestScope.replies.index.iterate(
                canvasQuery,
                {
                    resolve: true,
                    local: true,
                    remote: false,
                    closePolicy: "immediate",
                }
            );
            try {
                return (await iter.next(n)) as WithIndexedContext<
                    Canvas,
                    IndexableCanvas
                >[];
            } catch (error) {
                console.warn("fetchLocalReplies failed", error);
                return [];
            } finally {
                try {
                    await iter.close();
                } catch {
                    /* ignore */
                }
            }
        },
        [feedRoot, canvasQuery]
    );

    // lazy loading of replies
    const [batchSize, setBatchSize] = useState(3);
    const {
        items: sortedReplies,
        loadMore,
        isLoading: isLoadingQuery,
        empty,
        id: iteratorId,
    } = useQuery(feedRoot?.nearestScope.replies, {
        query: canvasQuery,
        reverse: visualization?.view === ChildVisualization.CHAT ? false : true,
        batchSize,
        debug: "useQuery REPLIES",
        local: true,
        remote: {
            reach: { eager: true },
            // Avoid blocking initial list hydration on remote joining; rely on link visibility
            wait: { timeout: 5e3 },
        },
        updates: {
            merge: true,
            // Stream live updates so freshly created posts appear without a manual fetch.
            push: true,
        },
        applyResults: (_prev, _incoming, { defaultMerge }) => {
            const merged = defaultMerge();

            if (pinningEnabled) {
                registerPins(merged);
                hydratedRef.current = true;

                if (pinnedIdsRef.current.size > 0) {
                    const pinned: typeof merged = [];
                    const rest: typeof merged = [];
                    for (const item of merged) {
                        (pinnedIdsRef.current.has(item.idString)
                            ? pinned
                            : rest
                        ).push(item);
                    }
                    return [...pinned, ...rest];
                }
            } else {
                // Ensure stale state does not leak across views
                pinnedIdsRef.current.clear();
                seenIdsRef.current.clear();
                hydratedRef.current = true;
            }

            return merged;
        },
        // Late results: iterator now reports concrete items via outOfOrder queue.
        onLateResults: async (evt, helpers) => {
            const amount = Math.max(evt?.amount ?? 1, batchSize ?? 1);
            const before = helpers.items().length;
            let loaded = false;

            const pinAndReorder = () => {
                if (!pinningEnabled) return;
                hydratedRef.current = true;
                registerPins(helpers.items());
                if (pinnedIdsRef.current.size === 0) return;

                const current = helpers.items();
                const pinned: WithIndexedContext<Canvas, IndexableCanvas>[] =
                    [];
                const rest: WithIndexedContext<Canvas, IndexableCanvas>[] = [];
                for (const item of current) {
                    (pinnedIdsRef.current.has(item.idString)
                        ? pinned
                        : rest
                    ).push(item);
                }
                helpers.inject([...pinned, ...rest]);
            };

            const injectLate = (
                items: (
                    | WithIndexedContext<Canvas, IndexableCanvas>
                    | undefined
                )[]
            ) => {
                const clean = items.filter(Boolean) as WithIndexedContext<
                    Canvas,
                    IndexableCanvas
                >[];
                if (!clean.length) return;
                helpers.inject(clean, { position: "start" });
                loaded = true;
            };

            // Prefer concrete late items (new iterator queue mode).
            if (
                Array.isArray((evt as any)?.items) &&
                (evt as any).items.length
            ) {
                const asValues = (evt as any).items.map(
                    (it: any) => it?.value ?? it?.indexed ?? it
                );
                injectLate(asValues);
            } else {
                // Fallback: force a fetch; if nothing arrives, try local-only read.
                loaded = await helpers.loadMore(amount, {
                    force: true,
                    reason: "late",
                });
                if (helpers.items().length === before) {
                    const local = await fetchLocalReplies(amount);
                    injectLate(local);
                }
            }

            pinAndReorder();
            return loaded;
        },
        /* onChange: {
            merge: async (e) => {
                // merge optimistic updates signed by me
                for (const change of e.added) {
                    const hash = change.__context.head;
                    const entry = await feedRoot!.replies.log.log.get(hash);
                    for (const signer of await entry.getSignatures()) {
                        if (signer.publicKey.equals(peer.identity.publicKey)) {
                            return e;
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
                if (visualization?.view !== ChildVisualization.CHAT) {
                    // Put added to the top (non-chat)
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
        }, */
    });

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
        current: WithIndexedContext<Canvas, IndexableCanvas>;
        next?: WithIndexedContext<Canvas, IndexableCanvas>;
        context: CanvasDB;
    }): LineType {
        const currentParent = getParentId(current);
        const nextParent = next ? getParentId(next) : undefined;
        const directChild = !!(next && equals(nextParent, current.id));

        if (equals(currentParent, context.id)) {
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
        replies: WithIndexedContext<Canvas, IndexableCanvas>[];
        current: WithIndexedContext<Canvas, IndexableCanvas>;
        next?: WithIndexedContext<Canvas, IndexableCanvas>;
    }): WithContext<Canvas>[] {
        if (!next || next.__indexed.path.length === 0) return [];
        const lastElements = {
            next: next.__indexed.path[next.__indexed.path.length - 1],
            current: current.__indexed.path?.length
                ? current.__indexed.path[current.__indexed.path.length - 1]
                : undefined,
        };
        return !equals(lastElements.next, lastElements.current) &&
            !equals(current.id, lastElements.next)
            ? replies.filter((reply) => equals(reply.id, lastElements.next))
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

        /* (future) insert quotes between replies
           for (let i = 0; i < repliesAndQuotes.length - 1; i++) {
             const current = repliesAndQuotes[i];
             const next = repliesAndQuotes[i + 1];
             const quotes = quotesToInsert({ current: current.reply, next: next.reply, replies });
             ...
           } */
        if (true as any) {
            throw new Error("Not implemented");
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
            if (!feedRoot?.initialized) return undefined;
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
        }, [sortedReplies, debouncedView, feedRoot, feedRoot?.initialized]);

    return {
        feedRoot,
        pinToView, // from settings provider
        defaultViews: ALL_DEFAULT_SETTINGS.filter((x) => x.id !== "chat"),
        dynamicViews: dynamicViewItems, // from settings provider
        createSettings, // from settings provider
        filterModel,
        setView: changeSettings,
        loadMore,
        loading: loadingCanvases || isLoadingQuery,
        setBatchSize,
        batchSize,
        iteratorId,
        lastReply,
        sortedReplies,
        processedReplies,

        timeFilter,
        typeFilter,
        setTimeFilter: setTimeFilterParam,
        setTypeFilter: setTypeFilterParam,
        setQueryParams,

        hasMore: () => !empty(),

        query,
        setQuery: setQueryParam,
    };
}

const CTX_KEY = "__STREAM_CONTEXT_SINGLETON__";
type Ctx = ReturnType<typeof useStreamContextHook> | undefined;

// (In dev, I recommend throwing to catch wiring issues early.)
const makeInitialStreamValue = (): ReturnType<typeof useStreamContextHook> =>
    ({
        feedRoot: undefined,
        pinToView: async () => {},
        defaultViews: [],
        dynamicViews: [],
        createSettings: async () => undefined as any,
        filterModel: undefined,
        setView: () => {},
        loadMore: async () => {},
        isLoading: false,
        loading: false,
        setBatchSize: () => {},
        batchSize: 3,
        iteratorId: undefined,
        lastReply: undefined,
        sortedReplies: [],
        processedReplies: [],
        timeFilter: TIME_FILTERS.get(DEFAULT_TIME_FILTER)!,
        typeFilter: TYPE_FILTERS.get(DEFAULT_TYPE_FILTER)!,
        setTimeFilter: () => {},
        setTypeFilter: () => {},
        setQueryParams: () => {},
        hasMore: () => false,
        query: "",
        setQuery: () => {},
    }) as any;

const StreamContext: React.Context<Ctx> =
    (globalThis as any)[CTX_KEY] ??
    ((globalThis as any)[CTX_KEY] = createContext<Ctx>(undefined));

export const StreamProvider: React.FC<{ children: ReactNode }> = ({
    children,
}) => {
    const value = useStreamContextHook();
    return (
        <StreamContext.Provider value={value}>
            {children}
        </StreamContext.Provider>
    );
};

// Define the context type from the hook’s return type.
export type StreamContextType = ReturnType<typeof useStreamContextHook>;

export const useStream = () => {
    const ctx = useContext(StreamContext);
    // Non-throwing behavior:
    if (!ctx) return makeInitialStreamValue();

    // If you prefer strict dev behavior:
    // if (!ctx) throw new Error("useStream must be used within <StreamProvider>");
    return ctx;
};
