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
import type {
    Documents,
    WithContext,
    WithIndexedContext,
} from "@peerbit/document";
import { useLocation, useSearchParams } from "react-router";
import { ALL_DEFAULT_FEED_SETTINGS as ALL_DEFAULT_SETTINGS } from "./defaultFeedSettings.js";
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

type QuerySlotConfig = {
    db: Documents<Canvas, IndexableCanvas> | undefined;
    query: any | undefined;
    reverse: boolean;
    batchSize: number;
    remote: any;
    debug: boolean | string;
    // When true, preserve the first-seen order in the UI and append new items.
    // This avoids jarring "best" re-ranks as cached reply totals update asynchronously.
    stableOrdering: boolean;
    pinningEnabled: boolean;
    pinResetKey: string;
};

type QuerySlotState = {
    items: WithIndexedContext<Canvas, IndexableCanvas>[];
    loadMore: (n?: number) => Promise<boolean>;
    isLoading: boolean;
    empty: boolean;
    id: string | undefined;
};

const MAX_STREAM_QUERY_SLOTS = 25;

type MinimalLocation = { key?: string; pathname: string; search: string };
const idxKey = () => {
    try {
        const idx = (window.history.state as any)?.idx;
        return typeof idx === "number" ? `idx:${idx}` : undefined;
    } catch {
        return undefined;
    }
};
const canonicalizeSearch = (search: string) => {
    const params = new URLSearchParams(search);
    // Treat the default view (`v=feed`) as absent so URL REPLACEs that only
    // add this param don't tear down cached stream iterators.
    if (params.get("v") === "feed") params.delete("v");

    const entries = Array.from(params.entries()).sort(([ak, av], [bk, bv]) => {
        const keyCmp = ak.localeCompare(bk);
        return keyCmp !== 0 ? keyCmp : av.localeCompare(bv);
    });
    const canonical = new URLSearchParams();
    for (const [k, v] of entries) canonical.append(k, v);

    const qs = canonical.toString();
    return qs ? `?${qs}` : "";
};
const urlKey = (loc: MinimalLocation) =>
    `url:${loc.pathname}${canonicalizeSearch(loc.search)}`;
const entryKeyForLocation = (loc: MinimalLocation) =>
    // Prefer `history.state.idx` because it is stable for a given history entry even across REPLACE.
    // `location.key` can change on REPLACE (and may be "default" on the initial entry), which would
    // accidentally tear down and recreate iterators.
    idxKey() ?? urlKey(loc);

const StreamQuerySlot = React.memo(function StreamQuerySlot({
    slotKey,
    config,
    report,
}: {
    slotKey: string;
    config?: QuerySlotConfig;
    report: (slotKey: string, state: QuerySlotState) => void;
}) {
    const { peer } = usePeer();

    // Stabilize ordering for "best"/ranked feeds to prevent large reorders on async reply-count updates.
    const stableOrderRef = useRef<string[]>([]);

    // Session-local pinning of newly created posts (per slot)
    const pinnedIdsRef = useRef(new Set<string>());
    const seenIdsRef = useRef(new Set<string>());
    const hydratedRef = useRef(false);
    const sessionStartRef = useRef<number>(Date.now());

    useEffect(() => {
        stableOrderRef.current = [];
        pinnedIdsRef.current.clear();
        seenIdsRef.current.clear();
        hydratedRef.current = false;
        sessionStartRef.current = Date.now();
    }, [config?.pinResetKey]);

    const registerPins = React.useCallback(
        (items: WithIndexedContext<Canvas, IndexableCanvas>[]) => {
            if (!config?.pinningEnabled || !peer?.identity) return;
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
        },
        [config?.pinningEnabled, peer?.identity?.toString()]
    );

    const fetchLocalReplies = React.useCallback(
        async (n: number) => {
            if (!config?.db || !config?.query) return [];
            const iter = config.db.index.iterate(config.query, {
                resolve: true,
                local: true,
                remote: false,
                closePolicy: "onEmpty",
            });
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
        [config?.db, config?.query]
    );

    const {
        items,
        loadMore,
        isLoading,
        empty,
        id: iteratorId,
    } = useQuery(config?.db, {
        query: config?.query,
        reverse: config?.reverse ?? false,
        batchSize: config?.batchSize ?? 10,
        debug: config?.debug ?? false,
        local: true,
        remote: config?.remote,

        updates: {
            merge: true,
            push: true,
        },
        applyResults: (_prev, _incoming, { defaultMerge }) => {
            const merged = defaultMerge();

            const applyStableOrdering = (
                items: WithIndexedContext<Canvas, IndexableCanvas>[]
            ) => {
                if (!config?.stableOrdering) {
                    stableOrderRef.current = items.map((x) => x.idString);
                    return items;
                }

                // First batch: commit the iterator's initial order.
                if (stableOrderRef.current.length === 0) {
                    stableOrderRef.current = items.map((x) => x.idString);
                    return items;
                }

                const byId = new Map<string, (typeof items)[number]>();
                for (const item of items) byId.set(item.idString, item);

                const next: typeof items = [];
                const nextOrder: string[] = [];
                const seen = new Set<string>();

                // Preserve previously committed order for any items still present.
                for (const id of stableOrderRef.current) {
                    const item = byId.get(id);
                    if (!item) continue;
                    next.push(item);
                    nextOrder.push(id);
                    seen.add(id);
                }

                // Append any newly discovered items.
                for (const item of items) {
                    const id = item.idString;
                    if (seen.has(id)) continue;
                    next.push(item);
                    nextOrder.push(id);
                    seen.add(id);
                }

                stableOrderRef.current = nextOrder;
                return next;
            };

            const stabilized = applyStableOrdering(merged);

            if (config?.pinningEnabled) {
                registerPins(stabilized);
                hydratedRef.current = true;

                if (pinnedIdsRef.current.size > 0) {
                    const pinned: typeof stabilized = [];
                    const rest: typeof stabilized = [];
                    for (const item of stabilized) {
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

            return stabilized;
        },
        onLateResults: async (evt, helpers) => {
            const amount = Math.max(evt?.amount ?? 1, config?.batchSize ?? 1);
            const before = helpers.items().length;
            let loaded = false;

            const pinAndReorder = () => {
                if (!config?.pinningEnabled) return;
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
                incoming: (
                    | WithIndexedContext<Canvas, IndexableCanvas>
                    | undefined
                )[]
            ) => {
                const clean = incoming.filter(Boolean) as WithIndexedContext<
                    Canvas,
                    IndexableCanvas
                >[];
                if (!clean.length) return;
                helpers.inject(clean, {
                    // In stable ordering mode, never prepend; it causes the visible list to "scramble"
                    // as late results arrive.
                    position:
                        config?.reverse || config?.stableOrdering
                            ? "end"
                            : "start",
                });
                loaded = true;
            };

            if (
                Array.isArray((evt as any)?.items) &&
                (evt as any).items.length
            ) {
                const asValues = (evt as any).items.map(
                    (it: any) => it?.value ?? it?.indexed ?? it
                );
                injectLate(asValues);
            } else {
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
        },
    });

    useEffect(() => {
        report(slotKey, {
            items,
            loadMore,
            isLoading,
            empty: empty(),
            id: iteratorId,
        });
    }, [slotKey, items, loadMore, isLoading, iteratorId, report]);

    return null;
});

function useStreamUiState() {
    const { path: canvases, loading: loadingCanvases, leaf } = useCanvases();
    const [feedRoot, setFeedRoot] = useState<
        WithIndexedContext<CanvasDB, IndexableCanvas> | undefined
    >(undefined);
    const visualization = useVisualizationContext().visualization;

    useEffect(() => {
        if (!leaf) return;
        setFeedRoot(leaf);
    }, [leaf]);

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

    // unified replies query
    const feedRootIdString = feedRoot?.idString;
    const feedRootPathDepth = feedRoot?.__indexed?.pathDepth;
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
    }, [
        feedRootIdString,
        feedRootPathDepth,
        filterModel,
        timeFilter?.key,
        typeFilter?.key,
        query,
    ]);

    // lazy loading of replies
    const [batchSize, setBatchSize] = useState(10);

    const remote = React.useMemo(
        () => ({
            reach: { eager: true },
            // Avoid blocking initial list hydration on remote joining; rely on link visibility
            wait: { timeout: 5e3 },
        }),
        []
    );
    const queryConfig: QuerySlotConfig = useMemo(
        () => ({
            db: feedRoot?.nearestScope.replies,
            query: canvasQuery,
            reverse:
                visualization?.view === ChildVisualization.CHAT ? true : false,
            batchSize,
            remote,
            debug: "useQuery REPLIES",
            stableOrdering: filterModel?.id === "best",
            pinningEnabled,
            pinResetKey: `${filterModel?.id ?? ""}|${feedRoot?.idString ?? ""}`,
        }),
        [
            feedRoot?.nearestScope?.replies,
            canvasQuery,
            visualization?.view,
            batchSize,
            remote,
            pinningEnabled,
            filterModel?.id,
            feedRoot?.idString,
        ]
    );

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

    return {
        feedRoot,
        pinToView, // from settings provider
        defaultViews: ALL_DEFAULT_SETTINGS.filter((x) => x.id !== "chat"),
        dynamicViews: dynamicViewItems, // from settings provider
        createSettings, // from settings provider
        filterModel,
        setView: changeSettings,
        setBatchSize,
        batchSize,
        loadingCanvases,
        timeFilter,
        typeFilter,
        setTimeFilter: setTimeFilterParam,
        setTypeFilter: setTypeFilterParam,
        setQueryParams,
        query,
        setQuery: setQueryParam,
        debouncedView,
        queryConfig,
    };
}

const CTX_KEY = "__STREAM_CONTEXT_SINGLETON__";
type StreamUiState = ReturnType<typeof useStreamUiState>;

const buildStreamValue = (
    ui: StreamUiState,
    queryState: QuerySlotState | undefined
) => {
    const sortedReplies = queryState?.items ?? [];
    const lastReply =
        sortedReplies.length > 0
            ? sortedReplies[sortedReplies.length - 1]
            : undefined;

    const processedReplies: any[] | undefined = (() => {
        if (!ui.feedRoot?.initialized) return undefined;
        if (
            ui.debouncedView === "chat" &&
            sortedReplies.length > 0 &&
            ui.feedRoot
        ) {
            // note: insertQuotes is not implemented; keep legacy behaviour
            return (sortedReplies as any).map((reply: any) => ({
                reply,
                type: "reply" as const,
                lineType: "none" as const,
                id: reply.idString,
            }));
        }
        return sortedReplies.map((reply) => ({
            reply,
            type: "reply" as const,
            lineType: "none" as const,
            id: reply.idString,
        }));
    })();

    return {
        feedRoot: ui.feedRoot,
        pinToView: ui.pinToView,
        defaultViews: ui.defaultViews,
        dynamicViews: ui.dynamicViews,
        createSettings: ui.createSettings,
        filterModel: ui.filterModel,
        setView: ui.setView,
        loadMore: queryState?.loadMore ?? (async () => false),
        loading:
            ui.loadingCanvases ||
            (queryState?.isLoading ?? false) ||
            // Avoid a misleading empty-state flash while the feed query config/iterator is still
            // being established (common on initial navigation and deep-link loads).
            !(ui.queryConfig?.db && ui.queryConfig?.query) ||
            // Even when the config is runnable, the underlying iterator ID can lag behind by a tick.
            // Treat that gap as loading so we show a spinner instead of "Nothing to see here".
            (!!(ui.queryConfig?.db && ui.queryConfig?.query) &&
                !queryState?.id),
        setBatchSize: ui.setBatchSize,
        batchSize: ui.batchSize,
        iteratorId: queryState?.id,
        lastReply,
        sortedReplies,
        processedReplies,

        timeFilter: ui.timeFilter,
        typeFilter: ui.typeFilter,
        setTimeFilter: ui.setTimeFilter,
        setTypeFilter: ui.setTypeFilter,
        setQueryParams: ui.setQueryParams,

        hasMore: () => !(queryState?.empty ?? true),

        query: ui.query,
        setQuery: ui.setQuery,
    };
};

type Ctx = ReturnType<typeof buildStreamValue> | undefined;

// (In dev, I recommend throwing to catch wiring issues early.)
const makeInitialStreamValue = (): ReturnType<typeof buildStreamValue> =>
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
    const ui = useStreamUiState();
    const location = useLocation();
    const activeUrl = urlKey(location);
    const activeKey = entryKeyForLocation(location);

    const configsRef = useRef(new Map<string, QuerySlotConfig>());
    const statesRef = useRef(new Map<string, QuerySlotState>());
    const urlsRef = useRef(new Map<string, string>());
    const [slotKeys, setSlotKeys] = useState<string[]>(() => [activeKey]);
    const activeKeyRef = useRef(activeKey);
    activeKeyRef.current = activeKey;
    const [, forceRender] = useState(0);

    // Keep config for the active entry only; cached entries stay frozen.
    // We only update the active entry's config when its URL changes (e.g. REPLACE param updates),
    // not when we simply re-activate a previous history entry via back/forward.
    const prevUrl = urlsRef.current.get(activeKey);
    const prevConfig = configsRef.current.get(activeKey);
    const nextConfig = ui.queryConfig;

    const prevRunnable = !!(prevConfig?.db && prevConfig?.query);
    const nextRunnable = !!(nextConfig?.db && nextConfig?.query);

    // Important: on initial load (or after navigating to a canvas route) the canvas leaf can lag
    // behind the URL while it loads/indexes. If we freeze an "empty" or "wrong-root" config for
    // the active entry, the iterator never starts and the feed appears blank. Allow the active
    // entry to hydrate its config while keeping inactive entries frozen for fast back/forward.
    if (prevUrl !== activeUrl || (nextRunnable && !prevRunnable)) {
        configsRef.current.set(activeKey, nextConfig);
        urlsRef.current.set(activeKey, activeUrl);
    }

    useEffect(() => {
        setSlotKeys((prev) => {
            const without = prev.filter((k) => k !== activeKey);
            const next = [...without, activeKey];
            const removed =
                next.length > MAX_STREAM_QUERY_SLOTS
                    ? next.splice(0, next.length - MAX_STREAM_QUERY_SLOTS)
                    : [];
            for (const k of removed) {
                configsRef.current.delete(k);
                statesRef.current.delete(k);
                urlsRef.current.delete(k);
            }
            return next;
        });
    }, [activeKey]);

    const report = React.useCallback(
        (slotKey: string, state: QuerySlotState) => {
            statesRef.current.set(slotKey, state);
            if (slotKey === activeKeyRef.current) {
                forceRender((x) => x + 1);
            }
        },
        []
    );

    const renderKeys = useMemo(() => {
        const base = slotKeys.includes(activeKey)
            ? slotKeys
            : [...slotKeys, activeKey];
        return base.slice(-MAX_STREAM_QUERY_SLOTS);
    }, [slotKeys, activeKey]);

    const slots = renderKeys.map((k) => (
        <StreamQuerySlot
            key={k}
            slotKey={k}
            config={configsRef.current.get(k)}
            report={report}
        />
    ));

    const activeState = statesRef.current.get(activeKey);
    const value = buildStreamValue(ui, activeState);
    return (
        <StreamContext.Provider value={value}>
            {slots}
            {children}
        </StreamContext.Provider>
    );
};

// Define the context type from the hook’s return type.
export type StreamContextType = ReturnType<typeof buildStreamValue>;

export const useStream = () => {
    const ctx = useContext(StreamContext);
    // Non-throwing behavior:
    if (!ctx) return makeInitialStreamValue();

    // If you prefer strict dev behavior:
    // if (!ctx) throw new Error("useStream must be used within <StreamProvider>");
    return ctx;
};
