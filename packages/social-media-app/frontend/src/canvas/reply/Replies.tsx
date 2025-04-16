import React, { Fragment, useMemo, useRef, useState, useEffect } from "react";
import * as Toast from "@radix-ui/react-toast";
import { Reply } from "./Reply"; // Uses the updated Reply component
import { tw } from "../../utils/tailwind";
import { useView } from "../../view/ViewContex";
import { usePeer } from "@peerbit/react";
import { StraightReplyLine } from "./StraightReplyLine";
import { useAutoReply } from "../AutoReplyContext";
import { useAutoScroll } from "./useAutoScroll";
import { IoIosArrowDown } from "react-icons/io";
export const Replies = (properties: {
    focused: boolean;
    scrollRef?: React.RefObject<any>;
    viewRef: HTMLElement;
}) => {
    const { view, processedReplies, loadMore, batchSize, isLoading } =
        useView();
    const { peer } = usePeer();
    const repliesContainerRef = useRef<HTMLDivElement>(null);
    const { replyTo } = useAutoReply();
    const sentinelRef = useRef<HTMLDivElement>(null);

    // Initialize a ref that holds an array of refs.
    const replyContentRefs = useRef<(HTMLDivElement | null)[]>([]);

    // If the current number of refs doesn't match processedReplies, update the array.
    if (replyContentRefs.current.length !== processedReplies.length) {
        replyContentRefs.current = new Array(processedReplies.length).fill(
            null
        );
    }

    const { isAtBottom, scrollToBottom } = useAutoScroll({
        replies: processedReplies,
        repliesContainerRef,
        scrollRef: properties.scrollRef,
        enabled: true, // always enabled in this example
        lastElementRef: () =>
            replyContentRefs.current[replyContentRefs.current.length - 1],
        /*  debug: true, */
    });

    const isTransitioning = useRef(false);
    const loadMoreCounter = useRef(0);

    // Radix Toast state for new messages.
    const [showNewMessagesToast, setShowNewMessagesToast] = useState(false);
    const prevRepliesCountRef = useRef(processedReplies.length);

    useEffect(() => {
        const shouldShowToastFromView = view === "chat" || view === "new";
        if (
            shouldShowToastFromView &&
            processedReplies.length > prevRepliesCountRef.current &&
            !isAtBottom &&
            !processedReplies[
                processedReplies.length - 1
            ].reply.publicKey.equals(peer.identity.publicKey)
        ) {
            setShowNewMessagesToast(true);
        }
        prevRepliesCountRef.current = processedReplies.length;
    }, [processedReplies, isAtBottom, view, peer.identity.publicKey]);

    useEffect(() => {
        setShowNewMessagesToast(false);
    }, [isAtBottom]);

    // ----------------------------
    // Use the sentinel element as anchor.
    // ----------------------------
    const handleLoadMore = () => {
        const container = properties.viewRef; // In your case, this is the scroll container element.
        const sentinel = sentinelRef.current as HTMLElement | null;
        if (!container || !sentinel) return;

        // Get positions relative to the container.
        const containerRect = container.getBoundingClientRect();
        const sentinelRect = sentinel.getBoundingClientRect();
        const previousSentinelOffset = sentinelRect.top - containerRect.top;

        // Call loadMore to prepend new messages.
        loadMore();

        // Wait for the next animation frame(s) so that the DOM updates with the new content.
        let attempts = 0;
        const maxAttempts = 5; // You can adjust based on your layout
        const adjustScroll = () => {
            attempts++;
            const newSentinelRect = sentinel.getBoundingClientRect();
            const newSentinelOffset = newSentinelRect.top - containerRect.top;
            const offsetDiff = newSentinelOffset - previousSentinelOffset;

            // Log for debugging.
            /* console.log({
                offsetDiff,
                // For body containers, container.scrollTop might be 0, so we log window.pageYOffset instead.
                containerScrollTop:
                    container.tagName === "BODY"
                        ? window.pageYOffset
                        : (container as HTMLElement).scrollTop,
                container,
            }); */

            // If there's a measurable difference, adjust the scroll.
            if (Math.abs(offsetDiff) > 1) {
                if (container.tagName === "BODY") {
                    // When using body as the scroll container, adjust the page scroll.
                    window.scrollBy(0, offsetDiff);
                } else {
                    (container as HTMLElement).scrollTop += offsetDiff;
                }
                // Continue adjusting until max attempts are reached.
                if (attempts < maxAttempts) {
                    requestAnimationFrame(adjustScroll);
                }
            }
        };
        requestAnimationFrame(adjustScroll);
    };

    // Adaptive content fetching using IntersectionObserver.
    const lastSentintentForLoadingMore = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!sentinelRef.current) {
            return;
        }

        if (properties.viewRef !== document.body) {
            return;
        }

        const fromViewRef = properties.viewRef;
        let observer: IntersectionObserver | null = null;

        if (!sentinelRef.current) {
            return;
        }

        let timeout = setTimeout(() => {
            observer = new IntersectionObserver(
                (entries) => {
                    const entry = entries[0];
                    if (
                        entry.isIntersecting &&
                        !isLoading &&
                        !isTransitioning.current &&
                        loadMoreCounter.current < 10
                    ) {
                        if (
                            lastSentintentForLoadingMore.current !==
                            entry.target
                        ) {
                            lastSentintentForLoadingMore.current =
                                entry.target as HTMLDivElement;
                        } else {
                            return;
                        }
                        // When the sentinel is visible, call our wrapped loadMore.
                        handleLoadMore();
                        /*   console.log(
                              "LOAD MORE",
                              lastSentintentForLoadingMore.current,
                              entry
                          ); */
                        loadMoreCounter.current++;
                    } else {
                        /*   console.log(
                              "NOT LOAD MORE",
                              entry.isIntersecting,
                              isLoading,
                              isTransitioning.current,
                              fromViewRef,
                              loadMoreCounter.current
                          ); */
                    }
                },
                {
                    root: fromViewRef === document.body ? null : fromViewRef, // the container element passed in props
                    threshold: 0, // 100% of the sentinel is visible
                    rootMargin: "0px",
                }
            );
            const currentSentinel = sentinelRef.current;
            observer.observe(currentSentinel);
        }, 1e3);
        return () => {
            timeout && clearTimeout(timeout);
            observer?.disconnect();
        };
    }, [properties.viewRef, sentinelRef.current, properties.focused]);

    // Choose where to place the sentinel based on view (if you want it at the top or bottom of the list).
    const sentinentBefore = view === "chat" || view === "new";
    // Example: if you want the sentinel to appear before the first item when in these views,
    // you could adjust the offset; here we simply choose index zero.
    const showSentinentAtIndex = sentinentBefore
        ? 0
        : processedReplies.length - 1;

    return (
        <div className="flex flex-col relative w-full mt-5 px-2">
            {processedReplies && processedReplies.length > 0 ? (
                <div
                    ref={repliesContainerRef}
                    className={tw(
                        "max-w-[876px] w-full mx-auto grid relative "
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
                            view === "chat" ? "pl-[10px]" : ""
                        } flex flex-col gap-2 w-full`}
                    >
                        {processedReplies.map((item, i) => {
                            const replyElement = (
                                <Fragment key={item.id}>
                                    <Reply
                                        forwardRef={(ref) => {
                                            replyContentRefs.current[i] = ref;
                                            if (i === showSentinentAtIndex) {
                                                sentinelRef.current = ref;
                                            }
                                        }}
                                        canvas={item.reply}
                                        variant={
                                            view === "chat" ? "chat" : "thread"
                                        }
                                        isQuote={item.type === "quote"}
                                        className={
                                            i === showSentinentAtIndex ? "" : ""
                                        }
                                        isHighlighted={
                                            replyTo?.idString ===
                                            item.reply.idString
                                        }
                                    />
                                </Fragment>
                            );

                            return replyElement;
                        })}
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
                    <Toast.Title className="flex flex-row justify-center items-center gap-2">
                        <span className="whitespace-nowrap">New Messages</span>{" "}
                        <IoIosArrowDown />
                    </Toast.Title>
                </Toast.Root>
                <Toast.Viewport className="fixed bottom-[90px] left-1/2 transform -translate-x-1/2 flex flex-col p-2 gap-2 m-0 z-50 outline-none" />
            </Toast.Provider>
        </div>
    );
};
