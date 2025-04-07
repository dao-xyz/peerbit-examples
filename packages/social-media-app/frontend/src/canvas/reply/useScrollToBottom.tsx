import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useView } from "../../view/ViewContex";
import { Canvas } from "@giga-app/interface";
import { debounce, throttle } from "lodash";
import { usePeer } from "@peerbit/react";

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

function getScrollBottomOffset(scrollPosition: number) {
    return (
        document.documentElement.scrollHeight -
        (scrollPosition + window.innerHeight)
    );
}

const DELAY_AFTER_RESIZER_CHANGE_SCROLL_UP_EVENTS_WILL_BE_CONSIDERED = 100;

export const useScrollToBottom = (properties: {
    replies: { reply: Canvas }[];
    repliesContainerRef: React.RefObject<any>;
}) => {
    const { replies: processedReplies, repliesContainerRef } = properties;
    const { view } = useView();
    const { peer } = usePeer();

    const forceScrollToBottom = useRef(false);
    const scrollMode = useRef<"automatic" | "manual">("automatic");
    const [isAtBottom, setIsAtBottom] = useState(true);

    const viewIsShouldScrollToBottom = view === "chat" || view === "new";

    useEffect(() => {
        if (viewIsShouldScrollToBottom) {
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
        if (!viewIsShouldScrollToBottom) {
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
        if (!viewIsShouldScrollToBottom) {
            return;
        }
        let listener = () => {
            const { scrollHeight, clientHeight } = document.documentElement;
            const scrollTop = getScrollTop();
            if (Math.abs(scrollHeight - clientHeight - scrollTop) < 1) {
                // scrolling to bottom, set scroll mode to automatic again (i.e. on new messages or resize scroll to bottom automatically)
                scrollMode.current = "automatic";
                setIsAtBottom(true);
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
                    setIsAtBottom(false);
                    console.log("manual scroll mode");
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
        if (!viewIsShouldScrollToBottom) {
            return;
        }

        if (!repliesContainerRef.current) {
            return;
        }
        const cycleLength = 100;
        const handleBodyResizeDebounced = debounce(
            () => {
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

    return {
        isAtBottom,
        scrollToBottom,
    };
};
