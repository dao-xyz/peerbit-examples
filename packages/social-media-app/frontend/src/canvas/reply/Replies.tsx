import React, { Fragment, useMemo, useRef, useState, useEffect } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Toast from "@radix-ui/react-toast";
import { Reply } from "./Reply"; // Uses the updated Reply component
import { tw } from "../../utils/tailwind";
import { useView, ViewType } from "../../view/ViewContex";
import { useOnline, usePeer } from "@peerbit/react";
import { SmoothReplyLine } from "./SmoothReplyLine";
import { useAutoReply } from "../AutoReplyContext";
import { useScrollToBottom } from "./useScrollToBottom";
import { IoIosArrowDown } from "react-icons/io";

export const Replies = () => {
    const { view, processedReplies } = useView();
    const { peer } = usePeer();
    const repliesContainerRef = useRef<HTMLDivElement>(null);
    const { replyTo } = useAutoReply();

    const replyRefs = useMemo(
        () => processedReplies.map(() => React.createRef<HTMLDivElement>()),
        [processedReplies]
    );

    const { isAtBottom, scrollToBottom } = useScrollToBottom({
        replies: processedReplies,
        repliesContainerRef,
    });

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

    return (
        <div className="flex flex-col mt-10 relative w-full">
            {processedReplies && processedReplies.length > 0 ? (
                <div
                    ref={repliesContainerRef}
                    className={tw(
                        "mt-5 max-w-[876px] w-full mx-auto grid relative"
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
                    <div className="w-full h-4"></div>
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
                        <span>New Messages</span> <IoIosArrowDown />
                    </Toast.Title>
                </Toast.Root>
                <Toast.Viewport className="fixed bottom-[90px] left-1/2 transform -translate-x-1/2 flex flex-col p-2 gap-2 m-0 z-50 outline-none" />
            </Toast.Provider>
        </div>
    );
};
