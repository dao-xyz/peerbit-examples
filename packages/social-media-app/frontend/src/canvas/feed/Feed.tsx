import React, {
    Fragment,
} from "react";
import * as Toast from "@radix-ui/react-toast";
import { Reply } from "./Reply";
import { ScrollSettings } from "../main/useAutoScroll";
import { IoIosArrowDown } from "react-icons/io";
import { Spinner } from "../../utils/Spinner";
import {
    LeaveSnapshotContext,
    FeedSnapshot,
} from "./feedRestoration";

import { useFeedHooks } from "./useFeedHooks";
import { useStream } from "./StreamContext";

const SPINNER_HEIGHT = 40;

export const Feed = (props: {
    scrollSettings: ScrollSettings;
    parentRef: React.RefObject<HTMLDivElement>;
    viewRef: HTMLElement;
    onSnapshot: (snap: FeedSnapshot) => void;
    disableLoadMore?: boolean; // if true, will not load more items
    provider: typeof useStream

}) => {
    const {
        contentRef,
        visualization,
        isChat,
        isLoadingAnything,
        leaveSnapshot,
        processedReplies,
        repliesContainerRef,
        replyContentRefs,
        replyTo,
        scrollToBottom,
        sentinelIndex,
        sentinelRef,
        setShowNewMessagesToast,
        showNewMessagesToast,
        typedOnce,
        handleLoad,
        indexIsReadyToRender,
    } = useFeedHooks(props);

    /* --------------------------- RENDER ------------------------------ */
    return (
        <LeaveSnapshotContext.Provider value={leaveSnapshot}>
            {isChat && isLoadingAnything && (
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
                {processedReplies?.length > 0 ? (
                    <div
                        ref={repliesContainerRef}
                        className={"max-w-[876px] w-full mx-auto flex relative"}
                    >
                        {/* TMP DISABLE  {view?.id === "chat" && (
                            <StraightReplyLine
                                replyRefs={replyContentRefs.current}
                                containerRef={repliesContainerRef}
                                lineTypes={processedReplies.map(
                                    (item) => item.lineType
                                )}
                            />
                        )}
 */}
                        <div
                            className={`${isChat ? "pl-[15px]" : ""
                                } flex flex-col gap-2 w-full ${
                                /* view.settings.classNameContainer */ ""
                                }`}
                        >
                            {processedReplies.map((item, i) => (
                                <Fragment key={item.id}>
                                    <Reply
                                        onLoad={() => handleLoad(item.reply, i)}
                                        hideHeader={
                                            !visualization.showAuthorInfo
                                        }
                                        forwardRef={(ref) => {
                                            replyContentRefs.current[i] = ref;
                                            if (i === sentinelIndex) {
                                                sentinelRef.current =
                                                    ref as HTMLDivElement | null;
                                            }
                                        }}
                                        canvas={item.reply}
                                        variant={isChat ? "chat" : "thread"}
                                        isQuote={item.type === "quote"}
                                        highlightType={
                                            replyTo?.idString ===
                                                item.reply.idString
                                                ? typedOnce === true
                                                    ? "selected"
                                                    : "pre-selected"
                                                : undefined
                                        }
                                        className={`${indexIsReadyToRender(i)
                                            ? "visible"
                                            : "hidden"
                                            } ${
                                            /* view.settings.classNameReply */ ""
                                            }`}
                                    />
                                </Fragment>
                            ))}
                        </div>
                    </div>
                ) : (
                    <div className="flex-grow flex items-center justify-center h-40 font font-ganja">
                        Nothing to see here
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
            {!isChat && isLoadingAnything && (
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
