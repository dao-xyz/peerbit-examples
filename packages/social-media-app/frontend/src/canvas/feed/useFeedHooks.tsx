import React, {
    Fragment,
    useRef,
    useState,
    useEffect,
    useLayoutEffect,
    useCallback,
    useMemo,
} from "react";
import { usePeer } from "@peerbit/react";
import { useAutoReply } from "../AutoReplyContext";
import { useAutoScroll, ScrollSettings } from "../main/useAutoScroll";
import {
    useLeaveSnapshot,
    useRestoreFeed,
    FeedSnapshot,
} from "./feedRestoration";
import { Canvas, ChildVisualization } from "@giga-app/interface";
import { useVisualizationContext } from "../custom/CustomizationProvider";
import { useCanvases } from "../useCanvas";
import { useStream } from "./StreamContext";

const LOAD_TIMEOUT = 3e3;

interface HiddenState {
    head: number; // hidden items at start
    tail: number; // hidden items at end
}

export const useFeedHooks = (props: {
    scrollSettings: ScrollSettings;
    parentRef: React.RefObject<HTMLDivElement>;
    viewRef: HTMLElement;
    onSnapshot: (snap: FeedSnapshot) => void;
    disableLoadMore?: boolean; // if true, will not load more items
    provider: typeof useStream;
}) => {
    const {
        loadMore: _loadMore,
        loading: isLoadingView,
        feedRoot,
        setView,
        processedReplies,
        batchSize,
        hasMore,
        iteratorId,
    } = props.provider();

    const { path } = useCanvases();
    const { peer } = usePeer();

    const repliesContainerRef = useRef<HTMLDivElement>(null);
    const { replyTo, typedOnce } = useAutoReply();
    const sentinelRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);

    const hiddenRef = useRef<HiddenState>({ head: 0, tail: 0 });
    const [hidden, setHidden] = useState<HiddenState>({ head: 0, tail: 0 });

    const committedIds = useRef<{
        firstId: string | null;
        lastId: string | null;
    }>({ firstId: null, lastId: null });
    const committedLengthRef = useRef(0);
    const hiddenToLoadRef = useRef<Set<string>>(new Set());
    const revealRef = useRef<(() => void) | null>(undefined);

    const restoredScrollPositionOnce = useRef(false);
    const alreadySeen = useRef(new Set<string>());
    const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const firstBatchHandled = useRef(false);
    const pendingScrollAdjust = useRef<{
        isWindow: boolean;
        sentinel: HTMLElement | null;
        prevScrollHeight: number | undefined;
    } | null>(null);

    const loadMore = () => {
        if (props.disableLoadMore) {
            return;
        }

        if (!firstBatchHandled.current) {
            pendingScrollAdjust.current = {
                isWindow: props.viewRef === document.body,
                sentinel: null,
                prevScrollHeight: undefined, // how can viewRef be null?
            };
        }

        return _loadMore();
    };

    /* ------------------------------------------------------------------ */
    /* Detect new items at either end                                     */
    /* ------------------------------------------------------------------ */
    useLayoutEffect(() => {
        const list = processedReplies;
        if (!list || list.length === 0) return;

        const oldFirst = committedIds.current.firstId;
        const oldLast = committedIds.current.lastId;

        let newHead = 0;
        let newTail = 0;

        if (oldFirst) {
            const idx = list.findIndex((r) => r.reply.idString === oldFirst);
            newHead = idx === -1 ? list.length : idx;
        } else {
            newHead = list.length; // first paint → hide all
        }
        if (oldLast) {
            const idx = list.findIndex((r) => r.reply.idString === oldLast);
            newTail = idx === -1 ? list.length : list.length - 1 - idx;
        } else {
            newTail = list.length;
        }

        if (newHead === 0 && newTail === 0) {
            return;
        }

        const nextHidden = {
            head: hiddenRef.current.head + newHead,
            tail: hiddenRef.current.tail + newTail,
        };
        hiddenRef.current = nextHidden; // ← sync update
        setHidden(nextHidden); // ← async render update

        // build set of all IDs that we need to wait for
        const hiddenIds = list
            .filter(
                (_, i) =>
                    i < nextHidden.head || i >= list.length - nextHidden.tail
            )
            .map((r) => r.reply.idString);

        hiddenToLoadRef.current = new Set(hiddenIds);

        // reveal function, (show pending messages)
        const reveal = () => {
            committedIds.current.firstId = list[0]?.reply.idString ?? null;
            committedIds.current.lastId = list.at(-1)?.reply.idString ?? null;
            committedLengthRef.current = list.length;

            hiddenRef.current = { head: 0, tail: 0 };
            setHidden({ head: 0, tail: 0 });

            loadTimeoutRef.current = null;
            hiddenToLoadRef.current.clear();
        };

        // stash it so handleLoad can call it
        revealRef.current = reveal;

        if (loadTimeoutRef.current) {
            clearTimeout(loadTimeoutRef.current);
        }

        loadTimeoutRef.current = setTimeout(() => {
            console.log("REVEAL AFTER TIMEOUT");
            reveal();
        }, LOAD_TIMEOUT);

        return () => {
            if (loadTimeoutRef.current) {
                clearTimeout(loadTimeoutRef.current);
                loadTimeoutRef.current = null;
            }
        };
    }, [processedReplies]);

    useEffect(() => {
        if (
            !firstBatchHandled.current &&
            committedLengthRef.current > 0 &&
            hidden.head === 0 &&
            hidden.tail === 0
        ) {
            firstBatchHandled.current = true;
            pendingScrollAdjust.current = null;
        }
    }, [hidden.head, hidden.tail]);

    const resetLazyState = () => {
        if (loadTimeoutRef.current) {
            clearTimeout(loadTimeoutRef.current);
            loadTimeoutRef.current = null;
        }
        setHidden({ head: 0, tail: 0 });
        hiddenRef.current = { head: 0, tail: 0 };
        committedIds.current = { firstId: null, lastId: null };
        committedLengthRef.current = 0;
        alreadySeen.current.clear();
        pendingScrollAdjust.current = null;
        firstBatchHandled.current = false;
        restoredScrollPositionOnce.current = false;
    };

    const visualization = useVisualizationContext().visualization;

    const prevView = useRef(visualization?.view);
    const prevRoot = useRef(feedRoot);

    useLayoutEffect(() => {
        // needs to be useLayoutEffect, else we might trigger unwanted scrolls
        if (
            prevView.current !== visualization?.view ||
            prevRoot.current !== feedRoot
        ) {
            resetLazyState();
            prevView.current = visualization?.view;
            prevRoot.current = feedRoot;
        }
    }, [visualization?.view, feedRoot]);

    const isLoadingAnything = isLoadingView || hidden.head + hidden.tail > 0;

    const scrollUpForMore =
        visualization?.view === ChildVisualization.CHAT;

    useEffect(() => {
        document.documentElement.style.setProperty(
            "--overflow-anchor",
            scrollUpForMore ? "none" : "auto"
        );
    }, [scrollUpForMore]);

    /* -------------------------- UI helpers --------------------------- */
    const [showNewMessagesToast, setShowNewMessagesToast] = useState(false);
    const prevRepliesCountRef = useRef(processedReplies?.length || 0);

    const lastSentinelForLoadingMore = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const sentinel = sentinelRef.current;
        if (!sentinel /*  || props.viewRef !== document.body */) return; // TODO second arg needed?
        if (props.disableLoadMore) {
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                const entry = entries[0];

                if (
                    entry.isIntersecting &&
                    lastSentinelForLoadingMore.current !== sentinel &&
                    !isLoadingAnything
                ) {
                    lastSentinelForLoadingMore.current = sentinel;

                    pendingScrollAdjust.current = {
                        isWindow: props.viewRef === document.body,
                        sentinel,
                        prevScrollHeight: props.viewRef.scrollHeight,
                    };
                    loadMore();

                    /* console.log("set cache scroll height", {
                        scrollHeight: props.viewRef.scrollHeight,
                        prevScrollHeight: props.viewRef.scrollHeight,
                        isWindow: props.viewRef === document.body,
                    }); */
                }
            },
            {
                root: props.viewRef === document.body ? null : props.viewRef,
                threshold: 0,
            }
        );

        observer.observe(sentinel);
        return () => {
            observer.disconnect();
            lastSentinelForLoadingMore.current = null;
            let isWindowNow = props.viewRef === document.body;
            if (pendingScrollAdjust.current?.isWindow !== isWindowNow) {
                pendingScrollAdjust.current = null; // reset pending scroll adjust. TODO should we set this to null? on focus change we might want to locate the sentinel and then set the height manually?
            }
        };
    }, [
        props.viewRef,
        props.disableLoadMore,
        isLoadingAnything,
        processedReplies,
    ]);

    useLayoutEffect(() => {
        if (!scrollUpForMore) return;
        if (!pendingScrollAdjust.current) return;
        if (hidden.head > 0) return;
        if (!props.viewRef) return;

        const isWindow = props.viewRef === document.body;
        const scroller = isWindow
            ? (document.scrollingElement as HTMLElement)
            : (props.viewRef as HTMLElement);

        const prevHeight = pendingScrollAdjust.current.prevScrollHeight;
        if (prevHeight == null) {
            // prevent scroll adjust on the first batch (where set the prevScrollHeight to undefined)
            return;
        }
        const newHeight = props.viewRef.scrollHeight;
        const diff = newHeight - prevHeight;

        if (diff > 0) {
            if (isWindow) {
                window.scrollBy({ top: diff, behavior: "instant" as any });
            } else {
                scroller.scrollTop += diff;
            }
        }
        pendingScrollAdjust.current = null;
    }, [hidden.head, scrollUpForMore, props.viewRef]);

    useEffect(() => {
        if (!contentRef.current || !props.viewRef) return;
        const viewObserver = new ResizeObserver(() => {
            if (
                scrollUpForMore &&
                pendingScrollAdjust.current &&
                hidden.head > 0
            ) {
                pendingScrollAdjust.current.prevScrollHeight =
                    props.viewRef.scrollHeight;
            }
        });
        viewObserver.observe(contentRef.current);
        viewObserver.observe(props.viewRef);
        return () => viewObserver.disconnect();
    }, [contentRef.current, props.viewRef, scrollUpForMore, hidden.head]);

    const sentinelIndexPadding = Math.floor(batchSize / 2);
    const sentinelIndex = scrollUpForMore
        ? sentinelIndexPadding
        : (processedReplies?.length || 0) - 1 - sentinelIndexPadding;

    const replyContentRefs = useRef<(HTMLDivElement | null)[]>([]);
    const processedRepliesLength = processedReplies?.length || 0;
    if (replyContentRefs.current.length !== processedRepliesLength) {
        replyContentRefs.current = new Array(processedRepliesLength).fill(null);
    }

    const indexIsReadyToRender = useCallback(
        (i: number) =>
            i >= hiddenRef.current.head &&
            i < (processedReplies?.length || 0) - hiddenRef.current.tail,
        [processedReplies?.length]
    );

    const isReplyVisible = useCallback(
        (id: string) => {
            const idx = processedReplies.findIndex(
                (r) => r.reply.idString === id
            );
            const isReady = idx === -1 ? false : indexIsReadyToRender(idx);
            // dbg and see if we can be ready even if head is 0
            return isReady;
        },
        [indexIsReadyToRender, hidden.head, hidden.tail, processedReplies]
    );

    const leaveSnapshot = useLeaveSnapshot({
        replies: processedReplies,
        replyRefs: replyContentRefs.current,
        feedRoot: feedRoot,
    });

    const handleLoad = useCallback((canvas: Canvas, index: number) => {
        const id = canvas.idString;
        const hiddenSet = hiddenToLoadRef.current;

        if (hiddenSet.has(id)) {
            hiddenSet.delete(id);

            // if that was the last one, reveal early
            if (hiddenSet.size === 0 && revealRef.current) {
                if (loadTimeoutRef.current) {
                    clearTimeout(loadTimeoutRef.current);
                    loadTimeoutRef.current = null;
                }
                revealRef.current();
            }
        }
    }, []);

    useRestoreFeed({
        hasMore,
        replies: processedReplies,
        loadMore,
        replyRefs: replyContentRefs.current,
        setView,
        setViewRootById: (id) => {
            if (feedRoot?.idString !== id) {
                const found = path.find((c) => c.idString === id);
                return found
            }
        },
        onSnapshot: props.onSnapshot,
        onRestore: () => {
            restoredScrollPositionOnce.current = true;
        },
        isReplyVisible,
        debug: false,
        enabled: true,
    });

    useEffect(() => {
        if (iteratorId) {
            loadMore?.();
        }
    }, [iteratorId]);

    const visibleReplies = useMemo(() => {
        if (!processedReplies) return [];
        return processedReplies.filter((_, i) => indexIsReadyToRender(i));
    }, [processedReplies, indexIsReadyToRender]);


    const { isAtBottom, scrollToBottom } = useAutoScroll({
        replies: visibleReplies,
        repliesContainerRef,
        parentRef: props.parentRef,
        setting: props.scrollSettings,
        scrollOnViewChange: !restoredScrollPositionOnce.current,
        enabled: true,
        debug: false,
        lastElementRef: () =>
            replyContentRefs.current[replyContentRefs.current.length - 1],
    });

    useEffect(() => {
        if (!processedReplies) {
            return;
        }
        const lastReply = processedReplies.at(-1);
        const fromSomeoneElse =
            lastReply &&
            !lastReply.reply.publicKey.equals(peer.identity.publicKey);

        if (
            scrollUpForMore &&
            processedReplies.length > prevRepliesCountRef.current &&
            !isAtBottom &&
            fromSomeoneElse &&
            lastReply &&
            !alreadySeen.current.has(lastReply.reply.idString)
        ) {
            setShowNewMessagesToast(true);
        }
        prevRepliesCountRef.current = processedReplies?.length || 0;
    }, [
        processedReplies,
        isAtBottom,
        scrollUpForMore,
        peer.identity.publicKey,
    ]);

    useEffect(() => {
        if (isAtBottom && processedReplies) {
            setShowNewMessagesToast(false);
            processedReplies.forEach((r) =>
                alreadySeen.current.add(r.reply.idString)
            );
        }
    }, [isAtBottom, processedReplies]);
    const isChat =
        visualization?.view === ChildVisualization.CHAT;

    return {
        repliesContainerRef,
        contentRef,
        replyTo,
        typedOnce,
        processedReplies: visibleReplies,
        loadMore,
        isLoadingAnything,
        isAtBottom,
        scrollToBottom,
        sentinelRef,
        sentinelIndex,
        replyContentRefs,
        indexIsReadyToRender,
        hidden,
        setHidden,
        isReplyVisible,
        leaveSnapshot,
        showNewMessagesToast,
        setShowNewMessagesToast,
        isChat,
        visualization,
        handleLoad,
    } as const;
};
