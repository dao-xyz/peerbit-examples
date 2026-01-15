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
    getSnapshot,
    FeedSnapshot,
} from "./feedRestoration";
import { useDeveloperConfig } from "../../debug/DeveloperConfig";
import { Canvas, ChildVisualization } from "@giga-app/interface";
import { useVisualizationContext } from "../custom/CustomizationProvider";
import { useCanvases } from "../useCanvas";
import { useStream } from "./StreamContext";
import { useLocation } from "react-router";
import { debugLog, emitDebugEvent } from "../../debug/debug";

const DEFAULT_REVEAL_TIMEOUT = 5e3; // 5s

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
    const dev = useDeveloperConfig();
    const revealTimeout = dev.revealTimeoutMs ?? DEFAULT_REVEAL_TIMEOUT;
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
    const location = useLocation();
    const hasSnapshot = !!getSnapshot(location);

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
    const loadedIdsRef = useRef<Set<string>>(new Set());
    const revealRef = useRef<((reason?: string) => void) | null>(undefined);
    const revealCountRef = useRef(0);

    const restoredScrollPositionOnce = useRef(false);
    const alreadySeen = useRef(new Set<string>());
    const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const maxWaitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
        null
    );
    const firstBatchHandled = useRef(false);
    const pendingScrollAdjust = useRef<{
        isWindow: boolean;
        sentinel: HTMLElement | null;
        prevScrollHeight: number | undefined;
    } | null>(null);

    const loadMore = (n?: number) => {
        if (props.disableLoadMore) {
            return Promise.resolve(false);
        }

        if (!firstBatchHandled.current) {
            pendingScrollAdjust.current = {
                isWindow: props.viewRef === document.body,
                sentinel: null,
                prevScrollHeight: undefined, // how can viewRef be null?
            };
        }

        return _loadMore(n);
    };

    /* ------------------------------------------------------------------ */
    /* Detect new items at either end                                     */
    /* ------------------------------------------------------------------ */
    useLayoutEffect(() => {
        const list = processedReplies;
        if (!list || list.length === 0) return;

        const oldFirst = committedIds.current.firstId;
        const oldLast = committedIds.current.lastId;

        // First non-empty render after a reset: keep items hidden until they have
        // actually loaded, otherwise we can show blank shells that later expand
        // (breaking scroll stability + snapshot restoration assumptions).
        if (!oldFirst || !oldLast) {
            debugLog("feed:reveal:initial-hide", {
                listLength: list.length,
                iteratorId,
                url: window.location.href,
            });

            const nextHidden = { head: list.length, tail: 0 };
            hiddenRef.current = nextHidden;
            setHidden(nextHidden);

            // Avoid re-adding IDs that have already reported `onLoad` during incremental list growth.
            hiddenToLoadRef.current = new Set(
                list
                    .map((r) => r.reply.idString)
                    .filter((id) => !loadedIdsRef.current.has(id))
            );

            const reveal = (reason?: string) => {
                revealCountRef.current += 1;
                const count = revealCountRef.current;
                debugLog("feed:reveal:show", {
                    count,
                    reason: reason || "unknown",
                    listLength: list.length,
                    iteratorId,
                    url: window.location.href,
                });
                emitDebugEvent({
                    source: "feed",
                    name: "reveal:show",
                    count,
                    reason: reason || "unknown",
                    listLength: list.length,
                    iteratorId,
                });
                if (loadTimeoutRef.current) {
                    clearTimeout(loadTimeoutRef.current);
                    loadTimeoutRef.current = null;
                }
                if (maxWaitTimeoutRef.current) {
                    clearTimeout(maxWaitTimeoutRef.current);
                    maxWaitTimeoutRef.current = null;
                }
                committedIds.current.firstId = list[0]?.reply.idString ?? null;
                committedIds.current.lastId = list.at(-1)?.reply.idString ?? null;
                committedLengthRef.current = list.length;

                hiddenRef.current = { head: 0, tail: 0 };
                setHidden({ head: 0, tail: 0 });

                hiddenToLoadRef.current.clear();
                revealRef.current = null;
            };

            revealRef.current = reveal;

            if (hiddenToLoadRef.current.size === 0) {
                reveal("alreadyLoaded");
                return;
            }

            if (loadTimeoutRef.current) {
                clearTimeout(loadTimeoutRef.current);
                loadTimeoutRef.current = null;
            }
            loadTimeoutRef.current = setTimeout(() => {
                debugLog("feed:reveal:timeout", {
                    pendingCount: hiddenToLoadRef.current.size,
                    pendingIds: [...hiddenToLoadRef.current].slice(0, 10),
                    listLength: list.length,
                    iteratorId,
                    url: window.location.href,
                });
                const pendingCount = hiddenToLoadRef.current.size;
                if (pendingCount === 0) {
                    revealRef.current?.("timeout");
                }
                loadTimeoutRef.current = null;
            }, revealTimeout);

            if (maxWaitTimeoutRef.current) {
                clearTimeout(maxWaitTimeoutRef.current);
                maxWaitTimeoutRef.current = null;
            }
            const maxWaitMs = Math.max(revealTimeout * 2, revealTimeout);
            maxWaitTimeoutRef.current = setTimeout(() => {
                if (loadTimeoutRef.current) {
                    clearTimeout(loadTimeoutRef.current);
                    loadTimeoutRef.current = null;
                }
                debugLog("feed:reveal:max-wait", {
                    pendingCount: hiddenToLoadRef.current.size,
                    pendingIds: [...hiddenToLoadRef.current].slice(0, 10),
                    listLength: list.length,
                    iteratorId,
                    url: window.location.href,
                });
                revealRef.current?.("maxWait");
            }, maxWaitMs);

            return;
        }

        const firstIdx = list.findIndex((r) => r.reply.idString === oldFirst);
        const lastIdx = list.findIndex((r) => r.reply.idString === oldLast);

        // If our committed anchors disappeared or the order changed (e.g. dynamic "best" ranking),
        // don't try to compute "new head/tail" by index — it can hide everything.
        if (firstIdx === -1 || lastIdx === -1 || firstIdx > lastIdx) {
            debugLog("feed:reveal:reset-anchors", {
                listLength: list.length,
                iteratorId,
                oldFirst,
                oldLast,
                firstIdx,
                lastIdx,
                url: window.location.href,
            });
            committedIds.current.firstId = list[0]?.reply.idString ?? null;
            committedIds.current.lastId = list.at(-1)?.reply.idString ?? null;
            committedLengthRef.current = list.length;
            hiddenToLoadRef.current.clear();
            revealRef.current = null;
            if (loadTimeoutRef.current) {
                clearTimeout(loadTimeoutRef.current);
                loadTimeoutRef.current = null;
            }
            if (maxWaitTimeoutRef.current) {
                clearTimeout(maxWaitTimeoutRef.current);
                maxWaitTimeoutRef.current = null;
            }
            if (hiddenRef.current.head !== 0 || hiddenRef.current.tail !== 0) {
                hiddenRef.current = { head: 0, tail: 0 };
                setHidden({ head: 0, tail: 0 });
            }
            return;
        }

        const newHead = firstIdx;
        const newTail = list.length - 1 - lastIdx;

        if (newHead === 0 && newTail === 0) {
            if (hiddenRef.current.head !== 0 || hiddenRef.current.tail !== 0) {
                if (loadTimeoutRef.current) {
                    clearTimeout(loadTimeoutRef.current);
                    loadTimeoutRef.current = null;
                }
                if (maxWaitTimeoutRef.current) {
                    clearTimeout(maxWaitTimeoutRef.current);
                    maxWaitTimeoutRef.current = null;
                }
                hiddenToLoadRef.current.clear();
                revealRef.current = null;
                hiddenRef.current = { head: 0, tail: 0 };
                setHidden({ head: 0, tail: 0 });
            }
            return;
        }

        const nextHidden = {
            // `newHead/newTail` are computed relative to the committed anchors, so they already
            // represent the total "pending" items. Do not accumulate across updates.
            head: newHead,
            tail: newTail,
        };
        debugLog("feed:reveal:hide", {
            hidden: nextHidden,
            listLength: list.length,
            iteratorId,
            url: window.location.href,
        });
        emitDebugEvent({
            source: "feed",
            name: "reveal:hide",
            head: nextHidden.head,
            tail: nextHidden.tail,
            listLength: list.length,
            iteratorId,
        });
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
        // Do not block reveal on items we've already observed as loaded.
        for (const id of loadedIdsRef.current) {
            hiddenToLoadRef.current.delete(id);
        }

        // reveal function, (show pending messages)
        const reveal = (reason?: string) => {
            revealCountRef.current += 1;
            const count = revealCountRef.current;
            debugLog("feed:reveal:show", {
                count,
                reason: reason || "unknown",
                listLength: list.length,
                iteratorId,
                url: window.location.href,
            });
            emitDebugEvent({
                source: "feed",
                name: "reveal:show",
                count,
                reason: reason || "unknown",
                listLength: list.length,
                iteratorId,
            });
            if (loadTimeoutRef.current) {
                clearTimeout(loadTimeoutRef.current);
                loadTimeoutRef.current = null;
            }
            if (maxWaitTimeoutRef.current) {
                clearTimeout(maxWaitTimeoutRef.current);
                maxWaitTimeoutRef.current = null;
            }
            committedIds.current.firstId = list[0]?.reply.idString ?? null;
            committedIds.current.lastId = list.at(-1)?.reply.idString ?? null;
            committedLengthRef.current = list.length;

            hiddenRef.current = { head: 0, tail: 0 };
            setHidden({ head: 0, tail: 0 });

            hiddenToLoadRef.current.clear();
        };

        // stash it so handleLoad (and timeout) can call it
        revealRef.current = reveal;

        if (hiddenToLoadRef.current.size === 0) {
            reveal("alreadyLoaded");
            return;
        }

        // Debounce reveal so incremental head/tail growth collapses into a single reveal once the
        // stream quiets down, while still ensuring we eventually reveal.
        if (loadTimeoutRef.current) {
            clearTimeout(loadTimeoutRef.current);
            loadTimeoutRef.current = null;
        }
        loadTimeoutRef.current = setTimeout(() => {
            debugLog("feed:reveal:timeout", {
                pendingCount: hiddenToLoadRef.current.size,
                pendingIds: [...hiddenToLoadRef.current].slice(0, 10),
                listLength: list.length,
                iteratorId,
                url: window.location.href,
            });
            const pendingCount = hiddenToLoadRef.current.size;
            // Only reveal on this debounce timeout if everything is already loaded.
            // If items are still pending, keep them hidden and rely on:
            // - `handleLoad` (fast path) to reveal when all elements load, or
            // - `maxWait` (safety valve) to avoid hiding forever.
            if (pendingCount === 0) {
                revealRef.current?.("timeout");
            }
            loadTimeoutRef.current = null;
        }, revealTimeout);

        if (!maxWaitTimeoutRef.current) {
            const maxWaitMs = Math.max(revealTimeout * 2, revealTimeout);
            maxWaitTimeoutRef.current = setTimeout(() => {
                if (loadTimeoutRef.current) {
                    clearTimeout(loadTimeoutRef.current);
                    loadTimeoutRef.current = null;
                }
                debugLog("feed:reveal:max-wait", {
                    pendingCount: hiddenToLoadRef.current.size,
                    pendingIds: [...hiddenToLoadRef.current].slice(0, 10),
                    listLength: list.length,
                    iteratorId,
                    url: window.location.href,
                });
                revealRef.current?.("maxWait");
            }, maxWaitMs);
        }
    }, [processedReplies, hasSnapshot, revealTimeout]);

    // Ensure any pending reveal timeout is cleared on unmount.
    useEffect(() => {
        return () => {
            if (loadTimeoutRef.current) {
                clearTimeout(loadTimeoutRef.current);
                loadTimeoutRef.current = null;
            }
            if (maxWaitTimeoutRef.current) {
                clearTimeout(maxWaitTimeoutRef.current);
                maxWaitTimeoutRef.current = null;
            }
        };
    }, []);

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
        if (maxWaitTimeoutRef.current) {
            clearTimeout(maxWaitTimeoutRef.current);
            maxWaitTimeoutRef.current = null;
        }
        setHidden({ head: 0, tail: 0 });
        hiddenRef.current = { head: 0, tail: 0 };
        hiddenToLoadRef.current.clear();
        revealRef.current = null;
        revealCountRef.current = 0;
        committedIds.current = { firstId: null, lastId: null };
        committedLengthRef.current = 0;
        alreadySeen.current.clear();
        loadedIdsRef.current.clear();
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
    const [initialHydrated, setInitialHydrated] = useState(false);
    const hydrationIteratorRef = useRef<string | undefined>(undefined);

    useLayoutEffect(() => {
        if (hydrationIteratorRef.current !== iteratorId) {
            hydrationIteratorRef.current = iteratorId;
            setInitialHydrated(false);
        }
        if (!iteratorId) return;
        if (props.disableLoadMore) return;
        const myId = iteratorId;
        // Trigger the first batch ASAP so we don't flash the empty-state placeholder before results arrive.
        loadMore?.()
            .catch(() => { })
            .finally(() => {
                // Only mark hydrated if we're still on the same iterator.
                if (hydrationIteratorRef.current === myId) {
                    setInitialHydrated(true);
                }
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [iteratorId]);

    const scrollUpForMore = visualization?.view === ChildVisualization.CHAT;

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
        : (processedReplies?.length || 0) - 1;

    const replyContentRefs = useRef<(HTMLDivElement | null)[]>([]);
    const processedRepliesLength = processedReplies?.length || 0;
    if (replyContentRefs.current.length !== processedRepliesLength) {
        const current = replyContentRefs.current;
        if (current.length < processedRepliesLength) {
            current.push(
                ...new Array(processedRepliesLength - current.length).fill(null)
            );
        } else {
            current.length = processedRepliesLength;
        }
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
        loadedIdsRef.current.add(id);
        const hiddenSet = hiddenToLoadRef.current;

        if (hiddenSet.has(id)) {
            hiddenSet.delete(id);

            // if that was the last one, reveal early
            if (hiddenSet.size === 0 && revealRef.current) {
                if (loadTimeoutRef.current) {
                    clearTimeout(loadTimeoutRef.current);
                    loadTimeoutRef.current = null;
                }
                if (maxWaitTimeoutRef.current) {
                    clearTimeout(maxWaitTimeoutRef.current);
                    maxWaitTimeoutRef.current = null;
                }
                revealRef.current("allLoaded");
            }
        }
    }, []);

    useRestoreFeed({
        hasMore,
        replies: processedReplies,
        loadMore,
        iteratorId,
        replyRefs: replyContentRefs.current,
        setView,
        setViewRootById: (id) => {
            if (feedRoot?.idString !== id) {
                const found = path.find((c) => c.idString === id);
                return found;
            }
        },
        onSnapshot: props.onSnapshot,
        onRestore: () => {
            restoredScrollPositionOnce.current = true;
        },
        isReplyVisible,
        debug: dev.scrollRestoreDebug ?? false,
        enabled: true,
    });

    // Recompute when hidden window changes; `indexIsReadyToRender` reads from a ref so
    // it won't otherwise invalidate memoization when we reveal after timeout.
    const visibleReplies = useMemo(() => {
        if (!processedReplies) return [];
        return processedReplies.filter((_, i) => indexIsReadyToRender(i));
    }, [processedReplies, indexIsReadyToRender, hidden.head, hidden.tail]);

    const { isAtBottom, scrollToBottom } = useAutoScroll({
        replies: visibleReplies,
        repliesContainerRef,
        parentRef: props.parentRef,
        setting: props.scrollSettings,
        scrollOnViewChange: !restoredScrollPositionOnce.current,
        enabled: true,
        debug: false,
        suppressAutoScroll: hasSnapshot,
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
    const isChat = visualization?.view === ChildVisualization.CHAT;

    return {
        repliesContainerRef,
        contentRef,
        replyTo,
        typedOnce,
        processedReplies,
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
        initialHydrated,
    } as const;
};
