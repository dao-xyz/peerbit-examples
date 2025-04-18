import React, { Fragment, useRef, useState, useEffect } from "react";
import * as Toast from "@radix-ui/react-toast";
import { Reply } from "./Reply";
import { tw } from "../../utils/tailwind";
import { useView } from "../../view/ViewContex";
import { usePeer } from "@peerbit/react";
import { StraightReplyLine } from "./StraightReplyLine";
import { useAutoReply } from "../AutoReplyContext";
import { useAutoScroll } from "./useAutoScroll";
import { IoIosArrowDown } from "react-icons/io";
import { Spinner } from "../../utils/Spinner";

const LOAD_TIMEOUT = 5e2;
const SPINNNER_HEIGHT = 40;

export const Replies = (properties: {
    focused: boolean;
    scrollRef?: React.RefObject<any>;
    viewRef: HTMLElement;
}) => {
    const {
        view,
        processedReplies,
        loadMore: _loadMore,
        isLoading: isLoadingView,
    } = useView();
    const { peer } = usePeer();
    const repliesContainerRef = useRef<HTMLDivElement>(null);
    const { replyTo } = useAutoReply();
    const sentinelRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);

    const [pendingBatch, setPendingBatch] = useState<{
        nextBatchIndex: number;
    }>({
        nextBatchIndex: 0,
    });

    const loadedMoreOnce = useRef(true);
    const loadMore = async () => {
        loadedMoreOnce.current = true;
        await _loadMore();
    };

    const lastProcessedRepliesLength = useRef(processedReplies.length);
    useEffect(() => {
        if (processedReplies.length > 0) {
            setPendingBatch({
                nextBatchIndex: lastProcessedRepliesLength.current,
            });
            let length = processedReplies.length;
            lastProcessedRepliesLength.current = length;
            const timeout = setTimeout(() => {
                setPendingBatch((prev) => {
                    return {
                        nextBatchIndex: Math.max(prev.nextBatchIndex, length),
                    };
                });
            }, LOAD_TIMEOUT);
            return () => {
                clearTimeout(timeout);
            };
        }
    }, [processedReplies]);

    const isLoadingAnything =
        isLoadingView ||
        pendingBatch.nextBatchIndex !== processedReplies.length;

    // Track which replies have been seen for the "new messages" toast
    const alreadySeen = useRef(new Set<string>());

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
        scrollRef: properties.scrollRef,
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

    const pendingScrollAdjust = useRef<{
        sentinel: HTMLElement;
        prevScrollHeight: number;
    } | null>(null);

    // 3️⃣ After new replies render, adjust scroll by the exact delta
    useEffect(() => {
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
            console.log("ADJUST SCROLL", {
                DIFF: newScrollHeight - prevScrollHeight,
                "SCROLL HEIGHT": newScrollHeight,
                "PREV SCROLL HEIGHT": prevScrollHeight,
            });
            const spinnerOffset = first ? SPINNNER_HEIGHT : 0;
            const heightDiff =
                newScrollHeight -
                prevScrollHeight -
                spinnerOffset; /*  newTop - prevTop; */

            first = false;
            prevScrollHeight = newScrollHeight;

            if (heightDiff > 0) {
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
        let timeout = setTimeout(scrollEffect, 0);

        return () => {
            clearTimeout(timeout);
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

    // ─────────────────────────────────────────────────────
    // IntersectionObserver for infinite‐scroll trigger
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
                    console.log("LOAD MORE!");

                    lastSentintentForLoadingMore.current = sentinel;
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
        };
    }, [
        properties.viewRef,
        processedReplies,
        properties.focused,
        isLoadingAnything,
    ]);

    // Decide where the sentinel goes
    const insertAtStart = view === "chat" || view === "new";
    const sentinelIndex = insertAtStart ? 0 : processedReplies.length - 1;

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
                <div
                    className="w-full flex justify-center items-center overflow-hidden"
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
                                        isHighlighted={
                                            replyTo?.idString ===
                                            item.reply.idString
                                        }
                                        className={
                                            (pendingBatch &&
                                            indexIsReadyToRender(i)
                                                ? ""
                                                : "fixed top-[-500px]") +
                                            ` ${i === sentinelIndex ? "" : ""}`
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
                    className="w-full flex justify-center items-center overflow-hidden"
                    style={{ height: SPINNNER_HEIGHT }}
                >
                    <Spinner />
                </div>
            )}
        </>
    );
};
