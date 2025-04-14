import { useRef, useState, useEffect } from "react";
import { ToolbarProvider } from "../toolbar/Toolbar.js";
import { FullscreenEditor } from "../toolbar/FullscreenEditor.js";
import { Spinner } from "../../utils/Spinner.js";
import { Replies } from "./Replies.js";
import { ReplyingInProgress } from "./ReplyingInProgress.js";
import { Toolbar } from "../toolbar/Toolbar.js";
import { useView, ViewType } from "../../view/ViewContex.js";
import { PendingCanvasProvider } from "../PendingCanvasContext.js";
import { useToolbarVisibility } from "./useToolbarVisibility.js";
import { DetailedView } from "../detailed/DetailedView.js";
import { SubHeader } from "./SubHeader.js";
import { AnimatedStickyToolbar } from "./AnimatedStickyToolbar.js";

const loadingTexts = [
    "Just a moment, we're getting things ready…",
    "A little magic is coming your way…",
    "Warming up the good vibes…",
    "Setting the stage for something special…",
    "Hold tight, creativity is on its way…",
    "Bringing your experience to life…",
    "Inspiring moments loading…",
    "Almost ready—your journey begins soon…",
    "A spark of creativity is being kindled…",
    "Stay tuned, something beautiful is near…",
    "Hold on—your fun factory is booting up…",
    "Spinning some cheeky mischief…",
    "Just a sec, stirring the silly pot…",
    "Loading playful pixels… almost here!",
    "Hang tight—the giggle train is coming…",
    "Warming up our quirky circuits…",
    "Your playground is nearly unlocked…",
    "Hold up—whipping up some lighthearted chaos…",
    "Tick tock… fun is nearly on deck!",
    "Just a moment, we’re prepping the playful parade…",
    "Loading a sprinkle of silliness…",
    "Almost there—get ready for a fun burst!",
    "Hang on, the laugh factory is starting…",
    "Just a sec, lining up some cheeky antics…",
    "Your playful portal is nearly open…",
    "Waiting on the fun bus to roll in…",
    "Almost set—time to unleash the quirky vibes!",
    "Hold on, assembling a cocktail of fun…",
    "Just a moment, we're shaking up some laughs…",
    "Get ready—silly surprises loading…",
    "Hold tight, playful chaos is just around the corner…",
    "Almost there—your fun zone is warming up…",
    "Tick tock… a dash of mischief is incoming!",
    "Just a moment, we're cranking up the playful meter…",
    "Loading a bundle of quirky delights…",
    "Hang on, funny moments are lining up…",
    "Almost ready—prepare for a quirky ride!",
    "Just a sec, we're mixing in some silliness…",
    "Hold on, playful pixels are assembling…",
    "Almost there—your lighthearted escape is almost live!",
];

const textToLoad =
    loadingTexts[Math.floor(Math.random() * loadingTexts.length)];

const SNAP_TO_REPLIES_EXTRA_SCROLL_HEIGHT = 5;

const shouldFocusRepliesByDefault = (view: ViewType) => {
    // For view types other than "best" or "old", we want the new scroll-based effect.
    return view === "best" || view === "old";
};
/**
 * CanvasAndReplies component.
 *
 * When the Replies area is unfocused, it will cover the space between the SubHeader
 * (immediately above) and the Toolbar below. In this state the Replies area is rendered in a fixed
 * container (its scrollbar is hidden) so it doesn't affect the body scrollbar.
 * When focused, Replies are rendered in-line.
 */

const getSnapToRepliesViewThreshold = (offset: number) =>
    offset + window.innerHeight / 3;

export const CanvasAndReplies = () => {
    // Ref for the overall container (used for toolbar height calculations)
    const scrollContainerRef = useRef(null);

    const [toolbarHeight, _setToolbarHeight] = useState(0);

    const [collapsed, setCollapsed] = useState(false);

    const { loading, canvases, viewRoot, lastReply, view, processedReplies } =
        useView();

    const lastScrollTopRef = useRef(-1);
    const repliesScrollRef = useRef<HTMLDivElement>(null);

    const postRef = useRef<HTMLDivElement>(null);
    const [spacerHeight, setSpacerHeight] = useState(0);
    const scrollToSnapEnabled = useRef(true);

    // Set up a ResizeObserver to and make the spacer height equal to postRef height - 50vh
    useEffect(() => {
        if (!postRef.current || !repliesScrollRef.current) {
            return;
        }
        const checkHeight = () => {
            const repliesRect =
                repliesScrollRef.current.getBoundingClientRect();
            let snapIntoViewThreshold = getSnapToRepliesViewThreshold(0); // window.innerHeight / 3;
            if (repliesRect.top < snapIntoViewThreshold) {
                // If the top of the container is above the middle of the window, we want to set the spacer height to 0
                setSpacerHeight(SNAP_TO_REPLIES_EXTRA_SCROLL_HEIGHT);
                return;
            }
            let diffToBottom = repliesRect.top - snapIntoViewThreshold;
            let newSpacerHeight =
                diffToBottom + SNAP_TO_REPLIES_EXTRA_SCROLL_HEIGHT;
            setSpacerHeight(newSpacerHeight);
        };
        checkHeight();
        const observer = new ResizeObserver(() => {
            checkHeight();
        });
        observer.observe(postRef.current);
        return () => {
            observer.disconnect();
        };
    }, [postRef.current, repliesScrollRef.current]);

    const toolbarVisible = useToolbarVisibility(scrollContainerRef);

    // For view types other than "best" or "old", we want the new scroll-based effect.

    // When using the new behavior, initially the Replies area is unfocused.
    const [repliesFocused, setRepliesFocused] = useState(
        shouldFocusRepliesByDefault(view)
    );

    const [showClickToSeeMore, setShowClickToSeeMore] = useState(false);

    useEffect(() => {
        if (view) {
            if (!repliesFocused) {
                setRepliesFocused(shouldFocusRepliesByDefault(view));
            }
        }
    }, [view]);

    useEffect(() => {
        lastScrollTopRef.current = -1;
        setCollapsed(false);
    }, [viewRoot]);

    // catch scroll events, and if the replies scroll ref top is above 50vh, go into focused mode
    useEffect(() => {
        if (!repliesScrollRef.current || !postRef.current || repliesFocused) {
            return;
        }

        const handleScroll = () => {
            if (!scrollToSnapEnabled.current) {
                return;
            }
            if (repliesScrollRef.current) {
                const rect = repliesScrollRef.current.getBoundingClientRect();

                // If the scroll position is greater than the last scroll position, we are scrolling down
                // If we are scrolling down and the replies area is not focused, we want to focus it
                let lastScrollTop = lastScrollTopRef.current;
                let downscroll = false;
                if (lastScrollTop > 0) {
                    if (lastScrollTop > rect.top) {
                        // Scrolling down
                        downscroll = true;
                    } else if (lastScrollTop < rect.top) {
                        // Scrolling up
                        downscroll = false;
                    }
                }
                //    console.log("downscroll", downscroll, rect.top, window.innerHeight, { split1: window.innerHeight / 3 - threshold, bbb: rect.top < window.innerHeight / 3 - threshold });

                lastScrollTopRef.current = rect.top;
                if (rect.top < getSnapToRepliesViewThreshold(0) && downscroll) {
                    setRepliesFocused(true);
                }
            }
        };

        window.addEventListener("scroll", handleScroll);
        return () => {
            window.removeEventListener("scroll", handleScroll);
        };
    }, [repliesScrollRef.current, postRef.current, repliesFocused]);

    // Set up a ResizeObserver on the fixed Replies container to check for overflow.
    useEffect(() => {
        if (!repliesScrollRef.current || repliesFocused) {
            // Only observe when Replies are unfocused.
            setShowClickToSeeMore(false);
            return;
        }
        const container = repliesScrollRef.current;
        const checkOverflow = () => {
            // Compare scrollHeight and clientHeight.
            setShowClickToSeeMore(
                container.scrollHeight > container.clientHeight
            );
        };
        checkOverflow();
        const observer = new ResizeObserver(() => {
            checkOverflow();
        });
        observer.observe(container);
        return () => {
            observer.disconnect();
        };
    }, [repliesFocused, repliesScrollRef.current]);

    if (!canvases || canvases.length === 0) {
        return (
            <div className="h-full flex flex-col justify-center">
                <div className="flex flex-col gap-4 items-center m-2">
                    {loading ? (
                        <div className="flex flex-row gap-2">
                            {textToLoad}
                            <Spinner />
                        </div>
                    ) : (
                        <div className="flex flex-row gap-2">
                            Space not found
                        </div>
                    )}
                </div>
            </div>
        );
    }

    const goToTop = () => {
        // Scroll to the top of the page
        scrollToSnapEnabled.current = false;
        lastScrollTopRef.current = -1;

        setRepliesFocused(shouldFocusRepliesByDefault(view));

        window.scrollTo({
            top: 0,
            behavior: "instant",
        });
        setTimeout(() => {
            scrollToSnapEnabled.current = true;
        }, 100); // This seems to be necessary on IOS Safari to avoid down scrolls to trigger focus again immediately
    };

    return (
        <PendingCanvasProvider viewRoot={viewRoot}>
            <ToolbarProvider>
                {/* 
          Main container takes full viewport height.
          Header (DetailedView + SubHeader) is shrink-to-fit.
          Replies area fills the remaining space.
        */}

                <div
                    ref={scrollContainerRef}
                    className={`${
                        view === "chat"
                            ? "dark:bg-neutral-800"
                            : "dark:bg-neutral-950"
                    } ${
                        repliesFocused ? "h-fit" : "h-full"
                    } flex flex-col relative grow shrink-0`} // some extra height so that we can trigger downscroll
                    style={{
                        paddingBottom: toolbarHeight,
                        height: repliesFocused
                            ? "fit-content"
                            : `calc(100% + ${spacerHeight}px)`,
                    }}
                >
                    {/* Header section */}
                    <div
                        ref={postRef}
                        className={`transition-all duration-300 ${
                            collapsed
                                ? "blur-3xl opacity-0"
                                : "blur-0 opacity-100"
                        }`}
                    >
                        <div className="flex-shrink-0 bg-neutral-50 dark:bg-neutral-900">
                            <FullscreenEditor>
                                <div className="pt-6 max-w-[876px] mx-auto w-full">
                                    <DetailedView />
                                </div>
                            </FullscreenEditor>
                        </div>
                    </div>

                    <SubHeader
                        onCollapse={setCollapsed}
                        onBackToTop={goToTop}
                        onViewChange={() => {
                            // a manual change in view is an indication of that the user is interested in the replies
                            setRepliesFocused(true);
                        }}
                    />

                    {/* Replies section */}
                    <div
                        className="relative flex-1 h-full"
                        /*    style={{
height: `${spacerHeight}px`,
}} */
                    >
                        <div
                            // When not focused, make the container fill the available area and show a pointer cursor.
                            // When focused, render it inline (relative) and remove the click handler.

                            className={`${
                                !repliesFocused
                                    ? "absolute inset-0 w-full cursor-pointer"
                                    : "relative"
                            }`}
                        >
                            {/* When unfocused, wrap Replies in an absolutely positioned, scrollable container.
        When focused, no extra wrapper is applied so the Replies render inline. */}
                            <div
                                id="replies-container"
                                className={`${
                                    !repliesFocused
                                        ? "absolute inset-0 overflow-y-auto hide-scrollbar "
                                        : ""
                                }`}
                                ref={repliesScrollRef}
                                style={
                                    {
                                        /*   paddingBottom: `${!repliesFocused ? 0 : toolbarHeight
                                          }px` */
                                        /* For some reason we need this for focused view??? */
                                    }
                                }
                            >
                                <Replies
                                    viewRef={scrollContainerRef}
                                    focused={repliesFocused}
                                    scrollRef={
                                        repliesFocused
                                            ? undefined
                                            : repliesScrollRef
                                    }
                                />
                            </div>
                            {/* Render the gradient overlay only when unfocused.
        This overlay is absolutely positioned over the container and does not receive pointer events. */}
                            {!repliesFocused && (
                                <div
                                    className="absolute inset-0 cursor-pointer flex flex-col justify-start items-center " /* bg-gradient-to-t from-transparent to-neutral-50 dark:from-transparent dark:to-black */
                                    onClick={(e) => {
                                        if (repliesFocused) {
                                            return;
                                        }
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setRepliesFocused(true);
                                    }}
                                    onTouchStart={(e) => {
                                        if (repliesFocused) {
                                            return;
                                        }
                                        e.stopPropagation();
                                        setRepliesFocused(true);
                                    }}
                                >
                                    {showClickToSeeMore && (
                                        <span className="p-2 m-2 bg-white/50 dark:bg-black/50 text-neutral-950 dark:text-neutral-50 rounded text-sm font-semibold shadow-md backdrop-blur-xs">
                                            Click to see more
                                        </span>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                    {/* Spacer to ensure the container is always tall enough for scrolling */}
                    {/* {!repliesFocused && <div id="spacer" style={{
                        height: `${spacerHeight}px`,
                    }} />} */}
                </div>

                <div className="relative">
                    <div className="absolute right-1 bottom-0">
                        <ReplyingInProgress canvas={lastReply} />
                    </div>
                </div>
                <AnimatedStickyToolbar
                    toolbarVisible={toolbarVisible}
                    onHeightChange={(setHeight) => {
                        _setToolbarHeight(setHeight);
                    }}
                >
                    <Toolbar />
                </AnimatedStickyToolbar>
            </ToolbarProvider>
        </PendingCanvasProvider>
    );
};
