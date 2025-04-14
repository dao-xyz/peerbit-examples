import React, { Fragment, useMemo, useRef, useState, useEffect } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Toast from "@radix-ui/react-toast";
import { Reply } from "./Reply"; // Uses the updated Reply component
import { tw } from "../../utils/tailwind";
import { useView } from "../../view/ViewContex";
import { usePeer } from "@peerbit/react";
import { SmoothReplyLine } from "./SmoothReplyLine";
import { useAutoReply } from "../AutoReplyContext";
import { useAutoScroll } from "./useAutoScroll";
import { IoIosArrowDown } from "react-icons/io";

export const Replies = (properties: {
    focused: boolean;
    scrollRef?: React.RefObject<any>;
    viewRef: React.RefObject<any>;
}) => {
    const { view, processedReplies, loadMore, batchSize, isLoading } =
        useView();
    const { peer } = usePeer();
    const repliesContainerRef = useRef<HTMLDivElement>(null);
    const { replyTo } = useAutoReply();

    const replyRefs = useMemo(
        () => processedReplies.map(() => React.createRef<HTMLDivElement>()),
        [processedReplies.length]
    );
    const sentinelRef = useRef<HTMLDivElement>(null);

    const { isAtBottom, scrollToBottom } = useAutoScroll({
        replies: processedReplies,
        repliesContainerRef,
        scrollRef: properties.scrollRef,
        enabled: true,
        lastElementRef: replyRefs[replyRefs.length - 1],
    });

    const isTransitioning = useRef(false);

    useEffect(() => {
        if (!properties.focused) {
            return;
        }
        isTransitioning.current = true;
        let timeout = setTimeout(() => {
            isTransitioning.current = false;
        }, 300);
        return () => {
            isTransitioning.current = false;
            clearTimeout(timeout);
        };
    }, [properties.focused]);

    // State for managing the Radix Toast notification.
    const [showNewMessagesToast, setShowNewMessagesToast] = useState(false);
    const prevRepliesCountRef = useRef(processedReplies.length);

    useEffect(() => {
        // When new messages are added and the user isn't at the bottom, show the toast.
        const shouldShowToastFromView = view === "chat" || view === "new";
        if (
            shouldShowToastFromView &&
            processedReplies.length > prevRepliesCountRef.current &&
            !isAtBottom &&
            !processedReplies[
                processedReplies.length - 1
            ].reply.publicKey.equals(peer.identity.publicKey) // only show messages from other users
        ) {
            setShowNewMessagesToast(true);
        }
        prevRepliesCountRef.current = processedReplies.length;
    }, [processedReplies, isAtBottom]);

    useEffect(() => {
        setShowNewMessagesToast(false);
    }, [isAtBottom]);

    const loadMoreCounter = useRef(0);
    // --- Adaptive content fetching using IntersectionObserver ---
    useEffect(() => {
        // Create an observer that loads more content when the sentinel is visible.
        const observer = new IntersectionObserver(
            (entries) => {
                const entry = entries[0];
                if (
                    entry.isIntersecting &&
                    !isLoading &&
                    !isTransitioning.current
                ) {
                    /*  console.log("Load more please!", isTransitioning, entry) */
                    loadMore();
                }
            },
            {
                root: properties.viewRef.current, // you can also set root to null if you want viewport-based scrolling
                threshold: 0.1, // adjust threshold as needed
            }
        );
        const currentSentinel = sentinelRef.current;
        if (currentSentinel) observer.observe(currentSentinel);
        return () => {
            if (currentSentinel) observer.unobserve(currentSentinel);
        };
    }, [isLoading, properties.viewRef, loadMore]);

    const [sentinelVisible, setSentinelVisible] = useState(true);
    /*  useEffect(() => {
         let timeout = setTimeout(() => {
             if (processedReplies.length === batchSize) {
                 setSentinelVisible(true);
             }
         }, 3000);
         return () => {
             clearTimeout(timeout);
             setSentinelVisible(false);
         };
     }, [processedReplies.length]); */

    let sentinentBefore = view === "chat" || view === "new" ? true : false;

    const sentinent = () => {
        return (
            <div
                id="sentinel"
                className={`w-full h-[1px] transparent ${
                    sentinelVisible ? "" : "hidden"
                }`}
                ref={sentinelRef}
            >
                {/* This sentinel div is observed for infinite scrolling */}
                {isLoading && (
                    <div className="text-center py-2">Loading more...</div>
                )}
            </div>
        );
    };
    return (
        <div
            className="flex flex-col relative w-full mt-5"
            ref={repliesContainerRef}
        >
            {processedReplies && processedReplies.length > 0 ? (
                <div
                    className={tw(
                        " max-w-[876px] w-full mx-auto grid relative"
                    )}
                >
                    <SmoothReplyLine
                        replyRefs={replyRefs}
                        containerRef={repliesContainerRef}
                        lineTypes={processedReplies.map(
                            (item) => item.lineType
                        )}
                        anchorPoints={processedReplies.map((item) =>
                            item.reply.publicKey.equals(peer.identity.publicKey)
                                ? "left"
                                : "right"
                        )}
                    />
                    {sentinentBefore && sentinent()}
                    {processedReplies.map((item, i) => (
                        <Fragment key={i}>
                            <Reply
                                forwardedRef={replyRefs[i]}
                                canvas={item.reply}
                                variant={view === "chat" ? "chat" : "thread"}
                                isQuote={item.type === "quote"}
                                isHighlighted={
                                    replyTo?.idString === item.reply.idString
                                }
                            />
                        </Fragment>
                    ))}

                    {/*  <div className="w-full h-4"></div>  */}
                    {!sentinentBefore && sentinent()}
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
                    className="bg-primary-200 dark:bg-primary-800 hover:bg-primary-500  text-black dark:text-white rounded-full px-4 py-2 shadow cursor-pointer"
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
