// Replies.tsx
import React, {
    Fragment,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import debounce from "lodash.debounce";
import throttle from "lodash.throttle";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDownIcon } from "@radix-ui/react-icons";
import { Reply } from "./Reply"; // Your existing Reply component
import { tw } from "../../utils/tailwind";
import { OnlineProfilesDropdown } from "../../profile/OnlinePeersButton";
import { useView, ViewType } from "../../view/ViewContex";
import { useLocal, useOnline, usePeer } from "@peerbit/react";
import { SmoothReplyLine } from "./SmoothReplyLine";

// Assume you have a StickyHeader component defined elsewhere.
import { StickyHeader } from "./StickyHeader";

const readableView = (view: ViewType) => {
    if (view === "chat") {
        return "Chat view";
    }

    if (view === "new") {
        return "New stuff";
    }

    if (view === "old") {
        return "Old stuff";
    }

    if (view === "best") {
        return "Popular";
    }
};

export const Replies = () => {
    // Get view state and processed replies from your context.
    const { view, setView, processedReplies, viewRoot } = useView();
    const viewAsReadable = useMemo(() => {
        return readableView(view);
    }, [view]);

    const { peers } = useOnline(viewRoot);
    const repliesContainerRef = useRef<HTMLDivElement>(null);

    // (Scroll handling logic is assumed to be here, per your original code.)

    // Create a ref for each processed reply.
    const replyRefs = useMemo(() => {
        return processedReplies.map(() => React.createRef<HTMLDivElement>());
    }, [processedReplies]);

    return (
        <div className="flex flex-col mt-10 relative">
            {/* Sticky header with dropdown menu and online peers */}
            <StickyHeader>
                <div className="w-full max-w-[876px] mx-auto flex flex-row">
                    <DropdownMenu.Root>
                        <DropdownMenu.Trigger className="btn flex flex-row justify-center items-center ganja-font">
                            <span>{viewAsReadable}</span>
                            <ChevronDownIcon className="ml-2" />
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Content
                            sideOffset={5}
                            style={{ padding: "0.5rem", minWidth: "150px" }}
                            className="bg-neutral-50 dark:bg-neutral-950 rounded-md shadow-lg"
                        >
                            {(["new", "old", "best", "chat"] as const).map(
                                (sortType) => (
                                    <DropdownMenu.Item
                                        key={sortType}
                                        className="menu-item text-sm"
                                        onSelect={() => setView(sortType)}
                                    >
                                        {readableView(sortType)}
                                    </DropdownMenu.Item>
                                )
                            )}
                        </DropdownMenu.Content>
                    </DropdownMenu.Root>
                    <div className="ml-auto">
                        <OnlineProfilesDropdown peers={peers} />
                    </div>
                </div>
            </StickyHeader>
            {processedReplies && processedReplies.length > 0 ? (
                <div
                    ref={repliesContainerRef}
                    className={tw(
                        "mt-5 max-w-[876px] w-full mx-auto grid relative",
                        view === "chat"
                            ? "grid-cols-[2rem_2rem_1fr_2rem_1rem]"
                            : "grid-cols-[1rem_1fr_1rem]"
                    )}
                >
                    {/* Render the smooth, pencil-textured reply line behind the replies */}
                    <SmoothReplyLine
                        replyRefs={replyRefs}
                        containerRef={repliesContainerRef}
                        lineTypes={processedReplies.map(
                            (item) => item.lineType
                        )}
                    />
                    {processedReplies.map((item, i) => (
                        <Fragment key={i}>
                            <Reply
                                forwardedRef={replyRefs[i]}
                                canvas={item.reply}
                                variant={view === "chat" ? "chat" : "thread"}
                                isQuote={item.type === "quote"}
                                lineType={undefined}
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
        </div>
    );
};
