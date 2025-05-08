import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useView, ViewType } from "../../view/ViewContex";
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

export type ScrollSettings = {
    scrollUsingWindow?: boolean;
    view: ViewType /*  we pass view here because scrollUsingWindow should be updated at the same time as view! */;
};

export const useAutoScroll = (properties: {
    replies: { reply: Canvas }[];
    repliesContainerRef: React.RefObject<any>;
    lastElementRef?: () => HTMLElement;
    parentRef: React.RefObject<any>;
    setting: ScrollSettings;
    enabled: boolean;
    debug?: boolean;
}) => {
    const {
        replies: processedReplies,
        repliesContainerRef,
        setting,
    } = properties;
    const { peer } = usePeer();
    const disableScrollUpEvents = useRef(false);
    const forceScrollToBottom = useRef(false);
    const scrollMode = useRef<"automatic" | "manual">("automatic");
    const [isAtBottom, setIsAtBottom] = useState(true);

    const viewIsShouldScrollToBottom =
        setting?.view === "chat" || setting?.view === "new";
    const triggerScroll = () => {
        if (!setting) {
            return;
        }
        if (setting.view === "best" || setting.view === "old") {
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
            properties.debug &&
                console.log(
                    "view is chat or new, setting scroll mode to automatic"
                );
            scrollMode.current = "automatic";
            forceScrollToBottom.current = true;
        }
        // TODO is this needed?
        else {
            properties.debug &&
                console.log(
                    "view is best or old, setting scroll mode to manual"
                );
            scrollMode.current = "manual";
            forceScrollToBottom.current = false;
        }

        // trigger scroll to bottom when the view changes
        properties.debug &&
            console.log("trigger scroll because the view changed", setting);
        triggerScroll();
    }, [setting, properties.enabled]);

    /* 
        useEffect(() => {
            if (!properties.enabled) {
                return;
            }
    
    
            if (
                lastRepliesContainerRef.current !== repliesContainerRef.current
            ) {
    
                // trigger scroll because the replies container has changed
                properties.debug &&
                    console.log(
                        "trigger scroll because the replies container has changed",
                        "from",
                        repliesContainerRef.current,
                        "to",
                        lastRepliesContainerRef.current
    
                    );
                lastRepliesContainerRef.current = repliesContainerRef.current;
    
                triggerScroll();
            }
            return () => {
                lastRepliesContainerRef.current = undefined;
            };
        }, [
    
            repliesContainerRef.current,
            properties.enabled,
        ]); */

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

    const lastScrollToSee = useRef<string>(null);

    // Update latest reply ref and scroll position before layout changes.
    // Scroll listener for useAutoScroll – immediate up‑scroll detection
    useEffect(() => {
        // Only active in chat & new views, and when the hook is enabled
        if (!viewIsShouldScrollToBottom) return;
        if (!properties.enabled) return;

        /* ------------------------------------------------------------------
         * Helper – switch to manual mode the moment the user scrolls up
         * ------------------------------------------------------------------ */
        const markManual = () => {
            if (disableScrollUpEvents.current) return; // temporarily blocked
            if (scrollMode.current !== "manual") {
                properties.debug &&
                    console.log("⇡  user scrolled up → manual mode");
                scrollMode.current = "manual";
                forceScrollToBottom.current = false;
                setIsAtBottom(false);
            }
        };

        /* ------------------------------------------------------------------
         * Main scroll listener
         * ------------------------------------------------------------------ */
        const listener = () => {
            const { scrollHeight, clientHeight } = document.documentElement;
            const scrollTop = getScrollTop();

            // When we hit the very bottom, flip back to automatic mode
            if (Math.abs(scrollHeight - clientHeight - scrollTop) < 1) {
                properties.debug &&
                    console.log("⇣  at bottom → automatic mode");
                scrollMode.current = "automatic";
                setIsAtBottom(true);
            }

            /* Detect up‑scroll immediately (no 300 ms delay) */
            if (
                lastScrollTop.current !== -1 &&
                scrollTop < lastScrollTop.current
            ) {
                markManual();
            }

            lastScrollTop.current = scrollTop;
        };

        window.addEventListener("scroll", listener);
        return () => {
            window.removeEventListener("scroll", listener);
        };
    }, [setting, properties.enabled]);

    useLayoutEffect(() => {
        if (!properties.enabled) {
            return;
        }
        if (processedReplies.length > 0) {
            if (viewIsShouldScrollToBottom) {
                let last = processedReplies[processedReplies.length - 1];
                latestReplyRef.current =
                    processedReplies[processedReplies.length - 1];

                /*  console.log(
                     "Reply change, should scroll to bottom?",
                     last.reply.idString !== lastScrollToSee?.current &&
                         latestReplyRef.current.reply.publicKey.equals(
                             peer.identity.publicKey
                         ) &&
                         scrollMode.current === "automatic"
                 ); */
                if (
                    last.reply.idString !== lastScrollToSee?.current &&
                    latestReplyRef.current.reply.publicKey.equals(
                        peer.identity.publicKey
                    ) &&
                    scrollMode.current === "automatic"
                ) {
                    scrollToBottom();
                    lastScrollToSee.current =
                        latestReplyRef.current.reply.idString;
                }
            } else {
                let first = processedReplies[0];
                if (
                    first.reply.idString !== lastScrollToSee?.current &&
                    first.reply.publicKey.equals(peer.identity.publicKey)
                ) {
                    scrollToTop();
                    lastScrollToSee.current = first.reply.idString;
                }
            }
        }

        bodyResizeScrollPositionRef.current = getScrollTop();
    }, [processedReplies, properties.enabled]);

    // UPDATED scrollToBottom: scroll the container if available.
    const scrollToBottom = () => {
        if (!setting.scrollUsingWindow) {
            if (!repliesContainerRef.current) {
                properties.debug && console.log("No replies container ref");
                return;
            }

            properties.debug &&
                console.log(
                    "scroll to bottom using scroll ref!",
                    properties.parentRef.current
                );
            properties.parentRef.current.scrollTo({
                top: properties.parentRef.current.scrollHeight,
                left: 0,
                behavior: "instant",
            });
        } else {
            properties.debug &&
                console.log("scroll to bottom using window: ", {
                    top: document.documentElement.scrollHeight,
                });
            window.scrollTo({
                top: document.documentElement.scrollHeight,
                left: 0,
                behavior: "instant",
            });
        }
        properties.debug &&
            console.log("setting automatic scroll mode on scroll to bottom");
        scrollMode.current = "automatic";
        forceScrollToBottom.current = false;
    };

    const scrollToTop = () => {
        properties.debug && console.log("scroll to top!");
        if (!setting.scrollUsingWindow) {
            properties.parentRef.current.scrollTo({
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
                    properties.debug &&
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
    }, [setting, properties.enabled]);

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
                properties.debug &&
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
                    properties.debug && console.log("scroll up detected");
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
    }, [setting, lastScrollTop, properties.enabled]);

    // Handle body resize events due to new replies being inserted.
    useEffect(() => {
        if (!viewIsShouldScrollToBottom) {
            return;
        }

        if (!properties.enabled) {
            return;
        }
        const cycleLength = 50;
        const handleBodyResizeDebounced = debounce(
            () => {
                if (scrollMode.current === "automatic") {
                    properties.debug &&
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
            properties.debug && console.log("disable scroll up!");
            scrollUpTimeout.current = setTimeout(() => {
                lastScrollTop.current = -1;
                scrollUpTimeout.current = undefined;
                properties.debug && console.log("enable scroll up!");
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
    }, [setting, peer, repliesContainerRef.current, properties.enabled]);

    return {
        isAtBottom,
        scrollToBottom,
        scrollMode,
    };
};
