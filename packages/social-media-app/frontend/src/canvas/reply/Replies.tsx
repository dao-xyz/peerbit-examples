import React, {
    Fragment,
    useRef,
    useState,
    useEffect,
    useLayoutEffect,
    useCallback,
} from "react";
import * as Toast from "@radix-ui/react-toast";
import { Reply } from "./Reply";
import { tw } from "../../utils/tailwind";
import { useView } from "../../view/ViewContex";
import { usePeer } from "@peerbit/react";
import { StraightReplyLine } from "./StraightReplyLine";
import { useAutoReply } from "../AutoReplyContext";
import { useAutoScroll, ScrollSettings } from "./useAutoScroll";
import { IoIosArrowDown } from "react-icons/io";
import { Spinner } from "../../utils/Spinner";
import {
    useLeaveSnapshot,
    useRestoreFeed,
    LeaveSnapshotContext,
    FeedSnapshot,
} from "./feedRestoration";

/** How long we keep newly-fetched replies hidden (ms) */
const LOAD_TIMEOUT = 100;
const SPINNER_HEIGHT = 40;

/**
 * Replies
 * -------
 * Handles lazy-rendering, infinite scroll and auto-scroll behaviour while
 * ensuring we never reveal a half-loaded batch when `processedReplies`
 * arrives in several rapid chunks.
 */
export const Replies = (properties: {
    scrollSettings: ScrollSettings;
    parentRef: React.RefObject<HTMLDivElement>;
    viewRef: HTMLElement;
    onSnapshot: (snap: FeedSnapshot) => void;
}) => {
    /* ------------------------------------------------------------------ */
    /* Context & state                                                    */
    /* ------------------------------------------------------------------ */
    const {
        view,
        processedReplies,
        loadMore: _loadMore,
        isLoading: isLoadingView,
        viewRoot,
        batchSize,
        setView,
        canvases,
        hasMore,
        iteratorId,
    } = useView();

    const { peer } = usePeer();
    const repliesContainerRef = useRef<HTMLDivElement>(null);
    const { replyTo, typedOnce } = useAutoReply();
    const sentinelRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);

    const restoredScrollPositionOnce = useRef(false);

    /**
     * `pendingBatch.nextBatchIndex` is *how many* replies we are allowed to
     * show. It always grows monotonically.
     */
    const [pendingBatch, setPendingBatch] = useState<{
        nextBatchIndex: number;
    }>({
        nextBatchIndex: 0,
    });

    /** Keeps track of how many replies are already visible */
    const committedLengthRef = useRef(0);

    /** For the “new messages” toast */
    const alreadySeen = useRef(new Set<string>());

    /* Imperative refs --------------------------------------------------- */
    const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastProcessedRepliesRef = useRef<typeof processedReplies | null>(
        null
    );
    /*  flag: have we already shown at least one batch? */
    const firstBatchHandled = useRef(false);

    const loadMore = () => {
        /* If restore requested more pages, mimic sentinel behaviour so
     the ‘hide-freshly-fetched’ effect treats it as a prepend batch */
        if (!firstBatchHandled.current) {
            /* pretend we’re in lazy-load mode so the effect waits LOAD_TIMEOUT */
            pendingScrollAdjust.current = {
                sentinel: null as any,
                prevScrollHeight: properties.viewRef.scrollHeight,
            };
        }

        return _loadMore();
    };

    /* once the Hide-Until-Timeout effect actually reveals that batch,
   mark it as handled so subsequent fetches use normal logic */
    useEffect(() => {
        if (
            !firstBatchHandled.current &&
            committedLengthRef.current > 0 && // something rendered
            pendingBatch.nextBatchIndex >= committedLengthRef.current
        ) {
            firstBatchHandled.current = true;
            pendingScrollAdjust.current = null; // clean up for future
        }
    }, [pendingBatch.nextBatchIndex]);

    /**
     * During pagination (scroll-up-for-more) we need to maintain scroll
     * position so the user doesn’t lose context. We remember how tall the
     * scroll container was *before* loading more, then after the new batch
     * becomes visible we nudge the scrollTop by exactly that delta.
     */
    const pendingScrollAdjust = useRef<{
        sentinel: HTMLElement;
        prevScrollHeight: number;
    } | null>(null);

    /* ------------------------------------------------------------------ */
    /* 1. Hide freshly-fetched replies for a short while                   */
    /* ------------------------------------------------------------------ */
    useEffect(() => {
        /* ------------------------------------------------------------------
         *  Early exits / bookkeeping
         * ------------------------------------------------------------------ */
        if (lastProcessedRepliesRef.current === processedReplies) return;
        lastProcessedRepliesRef.current = processedReplies;

        const newLength = processedReplies.length;
        const oldLength = committedLengthRef.current;
        if (newLength <= oldLength) return; // no growth → nothing to do

        /* ------------------------------------------------------------------
         *  Helper that actually reveals the new items
         * ------------------------------------------------------------------ */
        const reveal = () => {
            setPendingBatch((prev) => ({
                nextBatchIndex: Math.max(prev.nextBatchIndex, newLength),
            }));
            committedLengthRef.current = newLength; // mark as visible
            loadTimeoutRef.current = null;
        };

        /* ------------------------------------------------------------------
         *  Decide if we wait (top-prepend) or reveal immediately (bottom-append)
         * ------------------------------------------------------------------ */
        const isLazyLoadBatch = pendingScrollAdjust.current !== null;

        if (isLazyLoadBatch) {
            if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current);
            loadTimeoutRef.current = setTimeout(reveal, LOAD_TIMEOUT);
        } else {
            // New item at the tail: show it right away
            reveal();
        }

        /* ------------------------------------------------------------------
         *  Cleanup when the effect re-runs or unmounts
         * ------------------------------------------------------------------ */
        return () => {
            if (loadTimeoutRef.current) {
                clearTimeout(loadTimeoutRef.current);
                loadTimeoutRef.current = null;
            }
        };
    }, [processedReplies]);

    /* ------------------------------------------------------------------ */
    /* 2. Reset lazy-state whenever the view changes                      */
    /* ------------------------------------------------------------------ */
    const resetLazyState = () => {
        if (loadTimeoutRef.current) {
            clearTimeout(loadTimeoutRef.current);
            loadTimeoutRef.current = null;
        }
        restoredScrollPositionOnce.current = false;
        committedLengthRef.current = 0;
        alreadySeen.current.clear();
        pendingScrollAdjust.current = null;
        firstBatchHandled.current = false;
        setPendingBatch({ nextBatchIndex: 0 });
    };

    const prevView = useRef(view);
    const prevRoot = useRef(viewRoot);
    useEffect(() => {
        if (prevView.current !== view || prevRoot.current !== viewRoot) {
            resetLazyState();
            prevView.current = view;
            prevRoot.current = viewRoot;
        }
    }, [view, viewRoot]);

    /* ------------------------------------------------------------------ */
    /* 3. Loading flags & helpers                                         */
    /* ------------------------------------------------------------------ */
    const isLoadingAnything =
        isLoadingView ||
        pendingBatch.nextBatchIndex !== processedReplies.length;

    // Stable array of refs (same length as processedReplies)
    const replyContentRefs = useRef<(HTMLDivElement | null)[]>([]);
    if (replyContentRefs.current.length !== processedReplies.length) {
        replyContentRefs.current = new Array(processedReplies.length).fill(
            null
        );
    }

    const scrollUpForMore = view === "chat" || view === "new";

    const indexIsReadyToRender = useCallback(
        (i: number) => {
            if (scrollUpForMore) {
                return (
                    i >= processedReplies.length - pendingBatch.nextBatchIndex
                );
            }
            return i < pendingBatch.nextBatchIndex;
        },
        [scrollUpForMore, processedReplies.length, pendingBatch.nextBatchIndex]
    );

    const isReplyVisible = useCallback(
        (id: string) => {
            const idx = processedReplies.findIndex(
                (x) => x.reply.idString == id
            );
            return idx === undefined ? false : indexIsReadyToRender(idx);
        },
        [indexIsReadyToRender, processedReplies.length]
    );

    const { restoring } = useRestoreFeed({
        hasMore,
        replies: processedReplies,
        loadMore,
        replyRefs: replyContentRefs.current,
        setView: setView, // from useView()
        setViewRootById: (id) => {
            if (viewRoot?.idString !== id) {
                const found = canvases.find((c) => c.idString === id);
                found && found.load();
            }
        },
        onSnapshot: (snap) => {
            properties.onSnapshot(snap);
        },
        onRestore: (snap) => {
            restoredScrollPositionOnce.current = true;
        },
        isReplyVisible,
    });

    /* Auto-scroll behaviour */
    const { isAtBottom, scrollToBottom } = useAutoScroll({
        replies: processedReplies,
        repliesContainerRef,
        parentRef: properties.parentRef,
        setting: properties.scrollSettings,
        scrollOnViewChange: !restoredScrollPositionOnce.current,
        enabled: false,
        debug: true,
        lastElementRef: () =>
            replyContentRefs.current[replyContentRefs.current.length - 1],
    });

    /* ------------------------------------------------------------------ */
    /* 4. Toast for new messages                                          */
    /* ------------------------------------------------------------------ */
    const [showNewMessagesToast, setShowNewMessagesToast] = useState(false);
    const prevRepliesCountRef = useRef(processedReplies.length);

    useEffect(() => {
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
        prevRepliesCountRef.current = processedReplies.length;
    }, [
        processedReplies,
        isAtBottom,
        scrollUpForMore,
        peer.identity.publicKey,
    ]);

    useEffect(() => {
        if (isAtBottom) {
            setShowNewMessagesToast(false);
            processedReplies.forEach((r) =>
                alreadySeen.current.add(r.reply.idString)
            );
        }
    }, [isAtBottom, processedReplies]);

    /* ------------------------------------------------------------------ */
    /* 5. Sentinel & infinite scroll (load older)                          */
    /* ------------------------------------------------------------------ */

    const leaveSnapshot = useLeaveSnapshot({
        replies: processedReplies,
        replyRefs: replyContentRefs.current,
        view,
        viewRoot,
    });

    const lastSentinelForLoadingMore = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const sentinel = sentinelRef.current;
        if (!sentinel || properties.viewRef !== document.body) return;

        const observer = new IntersectionObserver(
            (entries) => {
                const entry = entries[0];
                if (
                    entry.isIntersecting &&
                    lastSentinelForLoadingMore.current !== sentinel &&
                    !isLoadingAnything
                ) {
                    lastSentinelForLoadingMore.current = sentinel;
                    // remember scroll height *before* fetching more so we can adjust later
                    pendingScrollAdjust.current = {
                        sentinel,
                        prevScrollHeight: properties.viewRef.scrollHeight,
                    };
                    loadMore();
                }
            },
            {
                root:
                    properties.viewRef === document.body
                        ? null
                        : properties.viewRef,
                threshold: 0,
            }
        );

        observer.observe(sentinel);
        return () => {
            observer.disconnect();
            lastSentinelForLoadingMore.current = null;
        };
    }, [properties.viewRef, isLoadingAnything, processedReplies]);

    /* ------------------------------------------------------------------ */
    /* 6. Maintain scroll position after older batch becomes visible       */
    /* ------------------------------------------------------------------ */
    useLayoutEffect(() => {
        if (!scrollUpForMore) return;
        if (!pendingScrollAdjust.current) return;
        if (pendingBatch.nextBatchIndex < processedReplies.length) return; // still hidden

        const isWindow = properties.viewRef === document.body;
        const scroller = isWindow
            ? (document.scrollingElement as HTMLElement)
            : (properties.viewRef as HTMLElement);

        let prevHeight = pendingScrollAdjust.current.prevScrollHeight;
        const newHeight = properties.viewRef.scrollHeight;
        const spinnerOffset = 0; // could tweak if spinner overlays content
        const diff = newHeight - prevHeight - spinnerOffset;

        if (diff > 0) {
            if (isWindow) {
                window.scrollBy({
                    top: diff,
                    behavior: "instant" as ScrollBehavior,
                });
            } else {
                scroller.scrollTop += diff;
            }
        }

        pendingScrollAdjust.current = null;
    }, [pendingBatch.nextBatchIndex, processedReplies.length, scrollUpForMore]);

    /* If the view resizes before the batch is revealed we need to update
       the stored height so the adjustment is accurate. */
    useEffect(() => {
        if (!contentRef.current || !properties.viewRef) return;
        const viewObserver = new ResizeObserver(() => {
            if (
                scrollUpForMore &&
                pendingScrollAdjust.current &&
                pendingBatch.nextBatchIndex < processedReplies.length
            ) {
                pendingScrollAdjust.current.prevScrollHeight =
                    properties.viewRef.scrollHeight;
            }
        });
        viewObserver.observe(contentRef.current);
        viewObserver.observe(properties.viewRef);
        return () => viewObserver.disconnect();
    }, [contentRef.current, properties.viewRef, scrollUpForMore]);

    /* ------------------------------------------------------------------ */
    /* 7. Helpers                                                         */
    /* ------------------------------------------------------------------ */

    const insertAtStart = scrollUpForMore;
    const sentinelIndexPadding = Math.floor(batchSize / 2);
    const sentinelIndex = insertAtStart
        ? sentinelIndexPadding
        : processedReplies.length - (1 + sentinelIndexPadding);

    /* ------------------------------------------------------------------ */
    /* 9. Render                                                          */
    /* ------------------------------------------------------------------ */

    useEffect(() => {
        if (!iteratorId) {
            return;
        }
        loadMore?.();
    }, [iteratorId]);

    /* ------------------------------------------------------------------ */
    /* 10. Render                                                          */
    /* ------------------------------------------------------------------ */
    return (
        <LeaveSnapshotContext.Provider value={leaveSnapshot}>
            {scrollUpForMore && isLoadingAnything && (
                <div
                    className="w-full flex absolute top-1 z-1 justify-center items-center overflow-hidden"
                    style={{ height: SPINNER_HEIGHT }}
                >
                    <Spinner />
                </div>
            )}

            <div
                className="flex flex-col relative w-full mt-0 px-2"
                ref={contentRef}
            >
                {processedReplies.length > 0 ? (
                    <div
                        ref={repliesContainerRef}
                        className={tw(
                            "max-w-[876px] w-full mx-auto grid relative"
                        )}
                    >
                        {view === "chat" && (
                            <StraightReplyLine
                                replyRefs={replyContentRefs.current}
                                containerRef={repliesContainerRef}
                                lineTypes={processedReplies.map(
                                    (item) => item.lineType
                                )}
                            />
                        )}

                        <div
                            className={`${
                                view === "chat" ? "pl-[15px]" : ""
                            } flex flex-col gap-4 w-full`}
                        >
                            {processedReplies.map((item, i) => (
                                <Fragment key={item.id}>
                                    <Reply
                                        forwardRef={(ref) => {
                                            replyContentRefs.current[i] = ref;
                                            if (i === sentinelIndex) {
                                                sentinelRef.current =
                                                    ref as HTMLDivElement | null;
                                            }
                                        }}
                                        canvas={item.reply}
                                        variant={
                                            view === "chat" ? "chat" : "thread"
                                        }
                                        isQuote={item.type === "quote"}
                                        highlightType={
                                            replyTo?.idString ===
                                            item.reply.idString
                                                ? typedOnce === true
                                                    ? "selected"
                                                    : "pre-selected"
                                                : undefined
                                        }
                                        className={
                                            indexIsReadyToRender(i)
                                                ? "visible"
                                                : "hidden"
                                        }
                                    />
                                </Fragment>
                            ))}
                        </div>
                    </div>
                ) : (
                    <div className="flex-grow flex items-center justify-center h-40 font ganja-font">
                        No replies yet
                    </div>
                )}

                {/* Radix Toast for new messages */}
                <Toast.Provider swipeDirection="right">
                    <Toast.Root
                        open={showNewMessagesToast}
                        onOpenChange={setShowNewMessagesToast}
                        duration={3000}
                        className="bg-primary-200 dark:bg-primary-800 hover:bg-primary-500 text-black dark:text-white rounded-full px-4 py-2 shadow cursor-pointer"
                        onClick={() => {
                            scrollToBottom();
                            setShowNewMessagesToast(false);
                        }}
                    >
                        <Toast.Title className="flex items-center gap-2">
                            <span className="whitespace-nowrap">
                                New Messages
                            </span>
                            <IoIosArrowDown />
                        </Toast.Title>
                    </Toast.Root>
                    <Toast.Viewport className="fixed bottom-[90px] left-1/2 transform -translate-x-1/2 flex flex-col p-2 gap-2 m-0 z-50 outline-none" />
                </Toast.Provider>
            </div>

            {!scrollUpForMore && isLoadingAnything && (
                <div
                    className="w-full flex absolute bottom-1 z-1 justify-center items-center overflow-hidden"
                    style={{ height: SPINNER_HEIGHT }}
                >
                    <Spinner />
                </div>
            )}
        </LeaveSnapshotContext.Provider>
    );
};
