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

const LOAD_TIMEOUT = 2e2;
const SPINNER_HEIGHT = 40;

interface HiddenState {
    head: number; // hidden items at start
    tail: number; // hidden items at end
}

export const Replies = (props: {
    scrollSettings: ScrollSettings;
    parentRef: React.RefObject<HTMLDivElement>;
    viewRef: HTMLElement;
    onSnapshot: (snap: FeedSnapshot) => void;
}) => {
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

    const hiddenRef = useRef<HiddenState>({ head: 0, tail: 0 });
    const [hidden, setHidden] = useState<HiddenState>({ head: 0, tail: 0 });

    const committedIds = useRef<{
        firstId: string | null;
        lastId: string | null;
    }>({ firstId: null, lastId: null });
    const committedLengthRef = useRef(0);

    const restoredScrollPositionOnce = useRef(false);
    const alreadySeen = useRef(new Set<string>());
    const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const firstBatchHandled = useRef(false);
    const pendingScrollAdjust = useRef<{
        sentinel: HTMLElement | null;
        prevScrollHeight: number | undefined;
    } | null>(null);

    const loadMore = () => {
        if (!firstBatchHandled.current) {
            pendingScrollAdjust.current = {
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
        if (list.length === 0) return;

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

        const reveal = () => {
            committedIds.current.firstId = list[0]?.reply.idString ?? null;
            committedIds.current.lastId = list.at(-1)?.reply.idString ?? null;
            committedLengthRef.current = list.length;

            hiddenRef.current = { head: 0, tail: 0 };
            setHidden({ head: 0, tail: 0 });

            loadTimeoutRef.current = null;
        };
        if (loadTimeoutRef.current) {
            clearTimeout(loadTimeoutRef.current);
        }
        loadTimeoutRef.current = setTimeout(reveal, LOAD_TIMEOUT);

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

    const prevView = useRef(view);
    const prevRoot = useRef(viewRoot);

    useLayoutEffect(() => {
        // needs to be useLayoutEffect, else we might trigger unwanted scrolls
        if (prevView.current !== view || prevRoot.current !== viewRoot) {
            resetLazyState();
            prevView.current = view;
            prevRoot.current = viewRoot;
        }
    }, [view, viewRoot]);

    const isLoadingAnything = isLoadingView || hidden.head + hidden.tail > 0;

    const scrollUpForMore = view?.settings.focus === "last";

    const { isAtBottom, scrollToBottom } = useAutoScroll({
        replies: processedReplies,
        repliesContainerRef,
        parentRef: props.parentRef,
        setting: props.scrollSettings,
        scrollOnViewChange: !restoredScrollPositionOnce.current,
        enabled: true,
        debug: false,
        lastElementRef: () =>
            replyContentRefs.current[replyContentRefs.current.length - 1],
    });

    /* -------------------------- UI helpers --------------------------- */
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

    const lastSentinelForLoadingMore = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const sentinel = sentinelRef.current;
        if (!sentinel || props.viewRef !== document.body) return;

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
                        sentinel,
                        prevScrollHeight: props.viewRef.scrollHeight,
                    };
                    loadMore();
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
        };
    }, [props.viewRef, isLoadingAnything, processedReplies]);

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
        if (prevHeight != null) {
            // prevent scroll adjust on the first batch (where set the prevScrollHeight to undefined)
            return;
        }
        const newHeight = props.viewRef.scrollHeight;
        const diff = newHeight - prevHeight;

        if (diff > 0) {
            console.log("scroll diff", { isWindow, scrollUpForMore, diff });
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
        : processedReplies.length - 1 - sentinelIndexPadding;

    const replyContentRefs = useRef<(HTMLDivElement | null)[]>([]);
    if (replyContentRefs.current.length !== processedReplies.length) {
        replyContentRefs.current = new Array(processedReplies.length).fill(
            null
        );
    }

    const indexIsReadyToRender = useCallback(
        (i: number) =>
            i >= hiddenRef.current.head &&
            i < processedReplies.length - hiddenRef.current.tail,
        [processedReplies.length]
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
        view: view?.id,
        viewRoot,
    });

    useRestoreFeed({
        hasMore,
        replies: processedReplies,
        loadMore,
        replyRefs: replyContentRefs.current,
        setView,
        setViewRootById: (id) => {
            if (viewRoot?.idString !== id) {
                const found = canvases.find((c) => c.idString === id);
                found && found.load();
            }
        },
        onSnapshot: props.onSnapshot,
        onRestore: () => {
            restoredScrollPositionOnce.current = true;
        },
        isReplyVisible,
        debug: false,
    });

    useEffect(() => {
        if (iteratorId) {
            loadMore?.();
        }
    }, [iteratorId]);

    /* --------------------------- RENDER ------------------------------ */
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
                        {view.id === "chat" && (
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
                                view.id === "chat" ? "pl-[15px]" : ""
                            } flex flex-col gap-4 w-full ${
                                view.settings.classNameContainer
                            }`}
                        >
                            {processedReplies.map((item, i) => (
                                <Fragment key={item.id}>
                                    <Reply
                                        hideHeader={
                                            !view.settings.showAuthorInfo
                                        }
                                        forwardRef={(ref) => {
                                            replyContentRefs.current[i] = ref;
                                            if (i === sentinelIndex) {
                                                sentinelRef.current =
                                                    ref as HTMLDivElement | null;
                                            }
                                        }}
                                        canvas={item.reply}
                                        variant={
                                            view.id === "chat"
                                                ? "chat"
                                                : "thread"
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
                                        className={`${
                                            indexIsReadyToRender(i)
                                                ? "visible"
                                                : "hidden"
                                        } ${view.settings.classNameReply}`}
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

            {/* Spinner at bottom (append lazy-load) */}
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
