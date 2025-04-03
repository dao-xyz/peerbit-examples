import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import debounce from "lodash.debounce";
import throttle from "lodash.throttle";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDownIcon } from "@radix-ui/react-icons";
import { Reply } from "./Reply";
import { tw } from "../../utils/tailwind";
import { OnlineProfilesDropdown } from "../../profile/OnlinePeersButton";
import { useView } from "../../view/ViewContex"; // adjust path as needed
import { useOnline, usePeer } from "@peerbit/react";

export const StickyHeader = ({ children }) => {
    const headerRef = useRef<HTMLDivElement>(null);
    const [isScrolled, setIsScrolled] = useState(false);

    useEffect(() => {
        let animationFrame: number;
        const checkPosition = () => {
            if (headerRef.current) {
                const rect = headerRef.current.getBoundingClientRect();
                // When the header is within 130px of the top, reveal the overlay.
                setIsScrolled(rect.top <= 130);
            }
            animationFrame = requestAnimationFrame(checkPosition);
        };

        animationFrame = requestAnimationFrame(checkPosition);
        return () => cancelAnimationFrame(animationFrame);
    }, []);

    return (
        <div
            ref={headerRef}
            className="sticky top-14 z-10 flex flex-row items-center justify-between py-1 px-2.5"
        >
            {/* Base layer: gradient background */}
            <div className="absolute inset-0 bg-[#e5e5e5] border-[#ccc] dark:border-[#6e6e6e82] border-t-[1px] border-b-[1px] dark:bg-[radial-gradient(circle,rgba(57,57,57,1)_0%,rgba(10,10,10,1)_100%)] drop-shadow-md"></div>
            {/* Overlay: fades in/out based on scroll */}
            <div
                className={`absolute inset-0 transition-opacity duration-700 ${
                    isScrolled ? "opacity-100" : "opacity-0"
                } bg-neutral-50 dark:bg-neutral-950`}
            ></div>
            {/* Content */}
            <div className="relative z-10 flex w-full justify-center">
                {children}
            </div>
        </div>
    );
};

function getScrollBottomOffset(scrollPosition: number) {
    return (
        document.documentElement.scrollHeight -
        (scrollPosition + window.innerHeight)
    );
}

function getMaxScrollTop() {
    const documentHeight = Math.max(
        document.body.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.clientHeight,
        document.documentElement.scrollHeight,
        document.documentElement.offsetHeight
    );
    return documentHeight - window.innerHeight;
}

function getScrollTop() {
    return window.scrollY || document.documentElement.scrollTop;
}
const DELAY_AFTER_RESIZER_CHANGE_SCROLL_UP_EVENTS_WILL_BE_CONSIDERED = 100;
export const Replies = () => {
    // Get view state and processed replies from our context.
    const { view, setView, processedReplies, viewRoot } = useView();
    const { peers } = useOnline(viewRoot);
    const { peer } = usePeer();
    const repliesContainerRef = useRef<HTMLDivElement>(null);
    const forceScrollToBottom = useRef(false);
    const scrollMode = useRef<"automatic" | "manual">("automatic");

    useEffect(() => {
        if (view === "chat") {
            scrollMode.current = "automatic";
            forceScrollToBottom.current = true;
        } else {
            scrollMode.current = "manual";
            forceScrollToBottom.current = false;
        }
    }, [view]);

    // Refs for scroll adjustments.
    const resizeScrollBottomRef = useRef(getScrollBottomOffset(getScrollTop()));
    const bottomRegionSize = 100;
    const bodyResizeScrollPositionRef = useRef(getScrollTop());

    // Refs to track the latest reply for scroll adjustments.
    const oldLatestReplyRef = useRef(
        processedReplies.length > 0
            ? processedReplies[processedReplies.length - 1]
            : null
    );
    const latestReplyRef = useRef(
        processedReplies.length > 0
            ? processedReplies[processedReplies.length - 1]
            : null
    );

    // Update latest reply ref and scroll position before layout changes.
    useLayoutEffect(() => {
        if (processedReplies.length > 0) {
            latestReplyRef.current =
                processedReplies[processedReplies.length - 1];
        }
        bodyResizeScrollPositionRef.current = getScrollTop();
    }, [processedReplies]);

    const scrollToBottom = () => {
        window.scrollTo({
            top: document.documentElement.scrollHeight,
            left: 0,
            behavior: "instant",
        });
        scrollMode.current = "automatic";
        forceScrollToBottom.current = false;
    };

    // Handle window resize for scroll adjustments (applies only in chat view).
    useEffect(() => {
        if (view !== "chat") {
            return;
        }
        const cycleLength = 100;
        const handleResizeThrottled = throttle(
            () => {
                const scrollTop = getScrollTop();
                const maxScrollTop = getMaxScrollTop();
                const scrollBottom = resizeScrollBottomRef.current;
                if (scrollBottom <= bottomRegionSize) {
                    scrollToBottom();
                    console.log(
                        "scroll to bottom ",
                        document.documentElement.scrollHeight
                    );
                }
                resizeScrollBottomRef.current = getScrollBottomOffset(
                    scrollBottom <= bottomRegionSize ? maxScrollTop : scrollTop
                );
            },
            cycleLength,
            { leading: true, trailing: true }
        );

        const setup = debounce(
            () => {
                resizeScrollBottomRef.current = getScrollBottomOffset(
                    getScrollTop()
                );
            },
            cycleLength,
            { leading: true, trailing: false }
        );

        const handleResize = () => {
            setup();
            handleResizeThrottled();
        };

        window.addEventListener("resize", handleResize);
        return () => {
            window.removeEventListener("resize", handleResize);
            handleResizeThrottled.cancel();
            setup.cancel();
        };
    }, [view]);

    // detect scroll up events to prevent automatic down scrolling to happen
    let lastScrollTop = useRef(-1);

    useEffect(() => {
        // New replies added: reset lastScrollTop to current scroll position
        lastScrollTop.current = -1;
    }, [processedReplies]);

    const scrollUpTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(
        undefined
    );
    useEffect(() => {
        if (view !== "chat") {
            return;
        }
        let listener = () => {
            const { scrollHeight, clientHeight } = document.documentElement;
            const scrollTop = getScrollTop();
            if (Math.abs(scrollHeight - clientHeight - scrollTop) < 1) {
                // scrolling to bottom, set scroll mode to automatic again (i.e. on new messages or resize scroll to bottom automatically)
                scrollMode.current = "automatic";
            }

            scrollUpTimeout.current = setTimeout(() => {
                var st =
                    window.pageYOffset || document.documentElement.scrollTop; // Credits: "https://github.com/qeremy/so/blob/master/so.dom.js#L426"
                if (st > lastScrollTop.current) {
                    // downscroll code
                } else if (st < lastScrollTop.current) {
                    // up scroll
                    scrollMode.current = "manual";
                    forceScrollToBottom.current = false;
                } // else was horizontal scroll
                lastScrollTop.current = st <= 0 ? 0 : st; // For Mobile or negative scrollin

                scrollUpTimeout.current = undefined;
            }, DELAY_AFTER_RESIZER_CHANGE_SCROLL_UP_EVENTS_WILL_BE_CONSIDERED);
        };
        window.addEventListener("scroll", listener);
        return () => {
            window.removeEventListener("scroll", listener);
        };
    }, [view, lastScrollTop]);

    // Handle body resize events due to new replies being inserted.
    useEffect(() => {
        if (view !== "chat") {
            return;
        }

        if (!repliesContainerRef.current) {
            return;
        }
        const cycleLength = 100;
        const handleBodyResizeDebounced = debounce(
            () => {
                /*   const scrollPosition = resizeScrollBottomRef.current;
              const wasNearBottom =   getScrollBottomOffset(scrollPosition) <= bottomRegionSize;
              const lastReplyIsFromUser =
                  oldLatestReplyRef.current && peer && oldLatestReplyRef.current.reply.publicKey === peer.identity.publicKey;
              const isNewReply =
                  oldLatestReplyRef.current &&
                  latestReplyRef.current &&
                  oldLatestReplyRef.current.reply.idString !== latestReplyRef.current.reply.idString;
  
              console.log("SCROLL?", isNewReply, wasNearBottom || lastReplyIsFromUser, repliesContainerRef.current.getBoundingClientRect().height) */
                console.log(
                    "SCROLL?",
                    scrollMode.current,
                    repliesContainerRef.current.getBoundingClientRect().height
                );
                if (scrollMode.current === "automatic") {
                    scrollToBottom();
                }

                bodyResizeScrollPositionRef.current = getMaxScrollTop();
                oldLatestReplyRef.current = latestReplyRef.current;
            },
            cycleLength,
            { leading: false, trailing: true }
        );

        const resizeObserver = new ResizeObserver(() => {
            lastScrollTop.current = -1;
            scrollUpTimeout.current = setTimeout(() => {
                lastScrollTop.current = -1;
                scrollUpTimeout.current = undefined;
            }, DELAY_AFTER_RESIZER_CHANGE_SCROLL_UP_EVENTS_WILL_BE_CONSIDERED);
            handleBodyResizeDebounced();
        });
        handleBodyResizeDebounced();
        if (repliesContainerRef.current) {
            resizeObserver.observe(repliesContainerRef.current);
        }

        return () => {
            resizeObserver.disconnect();
            handleBodyResizeDebounced.cancel();
        };
    }, [view, peer, repliesContainerRef.current]);

    // Scroll to bottom when first entering chat view.
    useEffect(() => {
        window.scrollTo({
            top: view === "chat" ? document.body.scrollHeight : 0,
            left: 0,
            behavior: "instant",
        });
        bodyResizeScrollPositionRef.current = getMaxScrollTop();
    }, [view]);

    return (
        <div className="flex flex-col mt-10">
            <StickyHeader>
                <div className="w-full max-w-[876px] mx-auto flex flex-row">
                    <DropdownMenu.Root>
                        <DropdownMenu.Trigger className="btn flex flex-row justify-center items-center ganja-font">
                            <span>Replies sorted by {view}</span>
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
                                        className="menu-item"
                                        onSelect={() => setView(sortType)}
                                    >
                                        {sortType.charAt(0).toUpperCase() +
                                            sortType.slice(1)}
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
                        "mt-5 max-w-[876px] w-full mx-auto grid",
                        view === "chat"
                            ? "grid-cols-[2rem_2rem_1fr_2rem_1rem]"
                            : "grid-cols-[1rem_1fr_1rem]"
                    )}
                >
                    {processedReplies.map((item, i) => (
                        <Fragment key={i}>
                            <Reply
                                canvas={item.reply}
                                variant={view === "chat" ? "chat" : "thread"}
                                isQuote={item.type === "quote"}
                                lineType={item.lineType}
                                /* TODO?
                             hideHeader={
                                view === "chat" &&
                                i > 0 &&
                                processedReplies[
                                    i - 1
                                ]?.reply.publicKey.equals(
                                    item.reply.publicKey
                                )
                            } */
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
