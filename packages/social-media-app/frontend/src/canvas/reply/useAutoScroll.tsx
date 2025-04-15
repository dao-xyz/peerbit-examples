import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useView } from "../../view/ViewContex";
import { Canvas } from "@giga-app/interface";
import { debounce, throttle } from "lodash";
import { usePeer } from "@peerbit/react";
import { getScrollTop } from "../../HeaderVisibilitiyProvider";

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

function getScrollBottomOffset(scrollPosition) {
    return (
        document.documentElement.scrollHeight -
        (scrollPosition + window.innerHeight)
    );
}

const DELAY_AFTER_RESIZER_CHANGE_SCROLL_UP_EVENTS_WILL_BE_CONSIDERED = 300;

export const useAutoScroll = (properties: {
    replies: { reply: Canvas }[];
    repliesContainerRef: React.RefObject<any>;
    lastElementRef?: HTMLElement;
    scrollRef?: React.RefObject<any>;

    enabled: boolean;
    debug?: boolean;
}) => {
    const { replies: processedReplies, repliesContainerRef } = properties;
    const { view } = useView();
    const { peer } = usePeer();

    const disableScrollUpEvents = useRef(false);
    const forceScrollToBottom = useRef(false);
    const scrollMode = useRef<"automatic" | "manual">("automatic");
    const [isAtBottom, setIsAtBottom] = useState(true);

    const viewIsShouldScrollToBottom = view === "chat" || view === "new";
    const triggerScroll = () => {
        if (view === "best" || view === "old") {
            scrollToTop();
        } else {
            scrollToBottom();
        }
    };
    useEffect(() => {
        if (!properties.enabled) {
            return;
        }
        // TODO is this needed?
        if (viewIsShouldScrollToBottom) {
            console.log(
                "view is chat or new, setting scroll mode to automatic"
            );
            scrollMode.current = "automatic";
            forceScrollToBottom.current = true;
        }
        // TODO is this needed?
        else {
            console.log("view is best or old, setting scroll mode to manual");
            scrollMode.current = "manual";
            forceScrollToBottom.current = false;
        }

        // trigger scroll to bottom when the view changes
        console.log("trigger scroll because the view changed");
        triggerScroll();
    }, [view, properties.enabled]);

    const lastScrollRef = useRef(properties.scrollRef?.current);
    const lastRepliesContainerRef = useRef(repliesContainerRef.current);

    useEffect(() => {
        if (!properties.enabled) {
            return;
        }
        /*  if (!properties.scrollRef?.current) {
             return;
         } */

        /*  if (!repliesContainerRef.current) {
             return;
         } */

        if (
            properties.scrollRef?.current !== lastScrollRef.current ||
            lastRepliesContainerRef.current !== repliesContainerRef.current
        ) {
            lastRepliesContainerRef.current = repliesContainerRef.current;
            lastScrollRef.current = properties.scrollRef?.current;

            // trigger scroll because the replies container has changed
            console.log(
                "trigger scroll because the replies container has changed"
            );
            triggerScroll();
        }
        return () => {
            lastScrollRef.current = undefined;
            lastRepliesContainerRef.current = undefined;
        };
    }, [properties.scrollRef, repliesContainerRef.current, properties.enabled]);

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
        if (!viewIsShouldScrollToBottom) {
            return;
        }
        if (!properties.enabled) {
            return;
        }
        if (processedReplies.length > 0) {
            latestReplyRef.current =
                processedReplies[processedReplies.length - 1];

            if (
                latestReplyRef.current.reply.publicKey.equals(
                    peer.identity.publicKey
                ) &&
                scrollMode.current === "automatic"
            ) {
                scrollToBottom();
            }
        }
        bodyResizeScrollPositionRef.current = getScrollTop();
    }, [processedReplies, properties.enabled]);

    // UPDATED scrollToBottom: scroll the container if available.
    const scrollToBottom = () => {
        if (properties.scrollRef?.current) {
            if (properties.lastElementRef) {
                properties.lastElementRef.scrollIntoView({
                    behavior: "instant",
                    block: "end",
                });
                return;
            }
            if (!repliesContainerRef.current) {
                properties.debug && console.log("No replies container ref");
                return;
            }

            properties.debug &&
                console.log(
                    "scroll to bottom!",
                    properties.scrollRef.current.getBoundingClientRect(),
                    repliesContainerRef.current.scrollHeight
                );
            properties.scrollRef.current.scrollTo({
                top: repliesContainerRef.current.scrollHeight,
                left: 0,
                behavior: "instant",
            });
        } else {
            properties.debug && console.log("scroll to bottom 2!");
            window.scrollTo({
                top: document.documentElement.scrollHeight,
                left: 0,
                behavior: "instant",
            });
        }
        console.log("setting automatic scroll mode on scroll to bottom");
        scrollMode.current = "automatic";
        forceScrollToBottom.current = false;
    };

    const scrollToTop = () => {
        properties.debug && console.log("scroll to top!");
        if (properties.scrollRef?.current) {
            properties.scrollRef.current.scrollTo({
                top: 0,
                left: 0,
                behavior: "instant",
            });
        } else {
            window.scrollTo({
                top: 0,
                left: 0,
                behavior: "instant",
            });
        }
        setIsAtBottom(false);
    };

    // Handle window resize for scroll adjustments (applies only in chat view).
    useEffect(() => {
        if (!viewIsShouldScrollToBottom) {
            return;
        }
        if (!properties.enabled) {
            return;
        }
        const cycleLength = 100;
        const handleResizeThrottled = throttle(
            () => {
                const scrollTop = getScrollTop();
                const maxScrollTop = getMaxScrollTop();
                const scrollBottom = resizeScrollBottomRef.current;
                if (scrollBottom <= bottomRegionSize) {
                    console.log("scroll to bottom on resize");
                    scrollToBottom();
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
    }, [view, properties.enabled]);

    // detect scroll up events to prevent automatic down scrolling to happen
    let lastScrollTop = useRef(-1);

    useEffect(() => {
        // New replies added: reset lastScrollTop to current scroll position
        lastScrollTop.current = -1;
    }, [processedReplies, properties.enabled]);

    const scrollUpTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(
        undefined
    );
    useEffect(() => {
        if (!viewIsShouldScrollToBottom) {
            return;
        }
        if (!properties.enabled) {
            return;
        }
        let listener = () => {
            const { scrollHeight, clientHeight } = document.documentElement;
            const scrollTop = getScrollTop();
            if (Math.abs(scrollHeight - clientHeight - scrollTop) < 1) {
                // scrolling to bottom, set scroll mode to automatic again (i.e. on new messages or resize scroll to bottom automatically)
                console.log("setting automatic scroll mode");
                scrollMode.current = "automatic";
                setIsAtBottom(true);
            }

            scrollUpTimeout.current = setTimeout(() => {
                var st =
                    window.pageYOffset || document.documentElement.scrollTop;

                if (st > lastScrollTop.current) {
                    // downscroll code
                } else if (st < lastScrollTop.current) {
                    // up scroll
                    if (disableScrollUpEvents.current) {
                        return;
                    }
                    console.log("scroll up detected");
                    scrollMode.current = "manual";
                    forceScrollToBottom.current = false;
                    setIsAtBottom(false);
                }
                lastScrollTop.current = st <= 0 ? 0 : st;
                scrollUpTimeout.current = undefined;
            }, DELAY_AFTER_RESIZER_CHANGE_SCROLL_UP_EVENTS_WILL_BE_CONSIDERED);
        };
        window.addEventListener("scroll", listener);
        return () => {
            window.removeEventListener("scroll", listener);
        };
    }, [view, lastScrollTop, properties.enabled]);

    // Handle body resize events due to new replies being inserted.
    useEffect(() => {
        if (!viewIsShouldScrollToBottom) {
            return;
        }

        if (!repliesContainerRef.current) {
            return;
        }

        if (!properties.enabled) {
            return;
        }
        const cycleLength = 50;
        const handleBodyResizeDebounced = debounce(
            () => {
                if (scrollMode.current === "automatic") {
                    console.log("scroll to bottom on body resize");
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
            disableScrollUpEvents.current = true;
            console.log("disable scroll up!");
            scrollUpTimeout.current = setTimeout(() => {
                lastScrollTop.current = -1;
                scrollUpTimeout.current = undefined;
                console.log("enable scroll up!");
                disableScrollUpEvents.current = false;
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
    }, [view, peer, repliesContainerRef.current, properties.enabled]);

    return {
        isAtBottom,
        scrollToBottom,
        scrollMode,
    };
};
