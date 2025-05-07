import React, {
    Fragment,
    useRef,
    useState,
    useEffect,
    useLayoutEffect,
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

const LOAD_TIMEOUT = 5e2;
const SPINNNER_HEIGHT = 40;

export const Replies = (properties: {
    scrollSettings: ScrollSettings;
    parentRef: React.RefObject<HTMLDivElement>;
    viewRef: HTMLElement;
}) => {
    const {
        view,
        processedReplies,
        loadMore: _loadMore,
        isLoading: isLoadingView,
        viewRoot,
        batchSize,
    } = useView();

    const { peer } = usePeer();
    const repliesContainerRef = useRef<HTMLDivElement>(null);
    const { replyTo, typedOnce } = useAutoReply();
    const sentinelRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);

    const [pendingBatch, setPendingBatch] = useState<{
        nextBatchIndex: number;
    }>({
        nextBatchIndex: 0,
    });
    // Track which replies have been seen for the "new messages" toast
    const alreadySeen = useRef(new Set<string>());

    const loadedMoreOnce = useRef(true);
    const loadMore = async () => {
        loadedMoreOnce.current = true;
        await _loadMore();
    };
    const pendingScrollAdjust = useRef<{
        sentinel: HTMLElement;
        prevScrollHeight: number;
    } | null>(null);

    const lastProcessedRepliesLength = useRef(processedReplies.length);
    const lastProcessedRepliesRef = useRef<any>(null);

    const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    /* ------------------------------------------------------------------ */
    /* 1. effect – update pending batch whenever processedReplies changes */
    /* ------------------------------------------------------------------ */
    useEffect(() => {
        // always clear any previous timeout before scheduling a new one
        if (loadTimeoutRef.current) {
            clearTimeout(loadTimeoutRef.current);
            loadTimeoutRef.current = null;
        }

        if (lastProcessedRepliesRef.current !== processedReplies) {
            lastProcessedRepliesRef.current = processedReplies;

            if (processedReplies.length > 0) {
                setPendingBatch({
                    nextBatchIndex: lastProcessedRepliesLength.current,
                });

                const length = processedReplies.length;
                lastProcessedRepliesLength.current = length;

                loadTimeoutRef.current = setTimeout(() => {
                    setPendingBatch((prev) => ({
                        nextBatchIndex: Math.max(prev.nextBatchIndex, length),
                    }));
                    loadTimeoutRef.current = null; // finished
                }, LOAD_TIMEOUT);
            }
        }

        // extra cleanup if processedReplies updates again
        return () => {
            if (loadTimeoutRef.current) {
                clearTimeout(loadTimeoutRef.current);
                loadTimeoutRef.current = null;
            }
        };
    }, [processedReplies]);

    /* ------------------------------------------------------------------ */
    /* 2. effect – reset lazy‑loading state whenever the view changes     */
    /* ------------------------------------------------------------------ */
    const resetLazyState = () => {
        // kill any pending timeout from the previous view
        if (loadTimeoutRef.current) {
            clearTimeout(loadTimeoutRef.current);
            loadTimeoutRef.current = null;
        }

        lastProcessedRepliesLength.current = 0;
        loadedMoreOnce.current = false;
        alreadySeen.current.clear();
        pendingScrollAdjust.current = null;
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

    const isLoadingAnything =
        isLoadingView ||
        pendingBatch.nextBatchIndex !== processedReplies.length;

    /* console.log({
        isLoadingAnything,
        isLoadingView,
        diff: pendingBatch.nextBatchIndex !== processedReplies.length,
        pending: pendingBatch.nextBatchIndex,
        processLength: processedReplies.length
    }) */

    // Prepare refs array for each Reply
    const replyContentRefs = useRef<(HTMLDivElement | null)[]>([]);
    if (replyContentRefs.current.length !== processedReplies.length) {
        replyContentRefs.current = new Array(processedReplies.length).fill(
            null
        );
    }

    // Auto‑scroll when at bottom
    const { isAtBottom, scrollToBottom } = useAutoScroll({
        replies: processedReplies,
        repliesContainerRef,
        parentRef: properties.parentRef,
        setting: properties.scrollSettings,
        enabled: true,
        debug: false,
        lastElementRef: () =>
            replyContentRefs.current[replyContentRefs.current.length - 1],
    });

    // Toast for new messages
    const [showNewMessagesToast, setShowNewMessagesToast] = useState(false);
    const prevRepliesCountRef = useRef(processedReplies.length);

    const scrollUpForMore = view === "chat" || view === "new";

    useEffect(() => {
        let shouldShowFromView = scrollUpForMore;
        const last =
            processedReplies[processedReplies.length - 1]?.reply.publicKey;
        const lastId =
            processedReplies[processedReplies.length - 1]?.reply.idString;

        if (
            shouldShowFromView &&
            processedReplies.length > prevRepliesCountRef.current &&
            !isAtBottom &&
            last &&
            !last.equals(peer.identity.publicKey) &&
            lastId &&
            !alreadySeen.current.has(lastId)
        ) {
            setShowNewMessagesToast(true);
        }
        prevRepliesCountRef.current = processedReplies.length;
    }, [processedReplies, isAtBottom, view, peer.identity.publicKey]);

    useEffect(() => {
        if (isAtBottom) {
            setShowNewMessagesToast(false);
            processedReplies.forEach((r) =>
                alreadySeen.current.add(r.reply.idString)
            );
        }
    }, [isAtBottom, processedReplies]);

    useLayoutEffect(() => {
        if (
            pendingBatch.nextBatchIndex < processedReplies.length ||
            !pendingScrollAdjust.current
        ) {
            return;
        }

        if (!scrollUpForMore) {
            return;
        }

        const isWindow = properties.viewRef === document.body;
        const scroller = isWindow
            ? (document.scrollingElement as HTMLElement)
            : (properties.viewRef as HTMLElement);

        let prevScrollHeight = pendingScrollAdjust.current.prevScrollHeight;

        if (!pendingScrollAdjust.current) {
            return;
        }
        let first = true;
        const scrollEffect = () => {
            const newScrollHeight = properties.viewRef.scrollHeight;
            /*  console.log("ADJUST SCROLL", {
                 DIFF: newScrollHeight - prevScrollHeight,
                 "SCROLL HEIGHT": newScrollHeight,
                 "PREV SCROLL HEIGHT": prevScrollHeight,
             }); */
            const spinnerOffset = 0; /* first ? SPINNNER_HEIGHT : 0; TODO correctly */
            const heightDiff =
                newScrollHeight - prevScrollHeight - spinnerOffset;

            first = false;
            prevScrollHeight = newScrollHeight;

            if (heightDiff > 0) {
                //   console.log({ "scroll adjust": heightDiff });
                if (isWindow) {
                    window.scrollBy({
                        top: heightDiff,
                        behavior: "instant",
                    });
                } else {
                    scroller.scrollTop += heightDiff;
                }
            }

            pendingScrollAdjust.current = null;
        };
        scrollEffect();
        // let timeout = setTimeout(scrollEffect, 0);

        return () => {
            // clearTimeout(timeout);
        };
    }, [pendingBatch.nextBatchIndex]);

    useEffect(() => {
        if (!contentRef.current || !properties.viewRef) return;
        const viewObserver = new ResizeObserver(() => {
            // if the view has resized and there is a pending scroll adjust, we need to adjust the scroll target height
            if (
                pendingBatch.nextBatchIndex < processedReplies.length &&
                pendingScrollAdjust.current
            ) {
                pendingScrollAdjust.current.prevScrollHeight =
                    properties.viewRef.scrollHeight;
            }
        });
        viewObserver.observe(contentRef.current);
        viewObserver.observe(properties.viewRef);

        return () => {
            viewObserver.disconnect();
        };
    }, [contentRef.current, properties.viewRef]);

    const lastSentintentForLoadingMore = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const sentinel = sentinelRef.current;
        if (!sentinel || properties.viewRef !== document.body) return;

        const observer = new IntersectionObserver(
            (entries) => {
                const entry = entries[0];
                if (
                    entry.isIntersecting &&
                    lastSentintentForLoadingMore.current !== sentinel &&
                    !isLoadingAnything
                ) {
                    lastSentintentForLoadingMore.current = sentinel;
                    pendingScrollAdjust.current = {
                        sentinel,
                        prevScrollHeight: properties.viewRef.scrollHeight,
                    };
                    observer.unobserve(sentinel);
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
            lastSentintentForLoadingMore.current = null;
        };
    }, [
        properties.viewRef,
        processedReplies,
        properties.scrollSettings,
        isLoadingAnything,
    ]);

    // Decide where the sentinel goes
    const insertAtStart = view === "chat" || view === "new";

    const sentinalIndexPadding = Math.floor(batchSize / 2);
    const sentinelIndex = insertAtStart
        ? sentinalIndexPadding
        : processedReplies.length - (1 + sentinalIndexPadding);

    const indexIsReadyToRender = (i: number) => {
        if (scrollUpForMore) {
            if (i > processedReplies.length - 1 - pendingBatch.nextBatchIndex) {
                return true;
            }
        } else {
            if (i < pendingBatch.nextBatchIndex) {
                return true;
            }
        }
    };

    return (
        <>
            {scrollUpForMore && isLoadingAnything && (
                /*  We do absolute positioning here because the recalculations of the scroll positions becomes wrong the other way (TODO FIX) */
                <div
                    className="w-full flex absolute top-1 z-1 justify-center items-center overflow-hidden"
                    style={{ height: SPINNNER_HEIGHT }}
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
                                                sentinelRef.current = ref;
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
                                            pendingBatch &&
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
                    /*  We do absolute positioning here because the recalculations of the scroll positions becomes wrong the other way (TODO FIX) */
                    className="w-full flex absolute bottom-1 z-1 justify-center items-center overflow-hidden"
                    style={{ height: SPINNNER_HEIGHT }}
                >
                    <Spinner />
                </div>
            )}
        </>
    );
};
