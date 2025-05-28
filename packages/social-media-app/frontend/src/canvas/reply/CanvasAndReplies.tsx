import { useRef, useState, useEffect } from "react";
import { FullscreenEditor } from "../toolbar/FullscreenEditor.js";
import { Spinner } from "../../utils/Spinner.js";
import { Replies } from "./Replies.js";
import { ReplyingInProgress } from "./ReplyingInProgress.js";
import { Toolbar } from "../toolbar/Toolbar.js";
import { useView } from "./view/ViewContex.js";
import { PendingCanvasProvider } from "../PendingCanvasContext.js";
import { useToolbarVisibility } from "./useToolbarVisibility.js";
import { DetailedView } from "../detailed/DetailedView.js";
import { SubHeader } from "./SubHeaderUnified.js";
import { AnimatedStickyToolbar } from "./AnimatedStickyToolbar.js";
import { ToolbarProvider, useToolbar } from "../toolbar/ToolbarContext.js";
import { ScrollSettings } from "./useAutoScroll.js";
import { getSnapshot } from "./feedRestoration.js";
import { useLocation } from "react-router";
import { ViewModel } from "@giga-app/interface";

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

const SNAP_TO_REPLIES_EXTRA_SCROLL_HEIGHT = 15;

const shouldFocusRepliesByDefault = (view?: ViewModel) => {
    // For view types other than "best" or "old", we want the new scroll-based effect.
    if (!view) {
        return false;
    }
    return view.settings.focus === "first"; // because then we scroll down to see more and hence we can make the replies to be focused by default (because for "chat" style reply sections we scroll up to see more)
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
    const { viewRoot } = useView();
    return (
        <PendingCanvasProvider viewRoot={viewRoot}>
            <ToolbarProvider>
                <CanvasAndRepliesInner />
            </ToolbarProvider>
        </PendingCanvasProvider>
    );
};

export const CanvasAndRepliesInner = () => {
    // Ref for the overall container (used for toolbar height calculations)
    const scrollContainerRef = useRef(null);

    const [toolbarHeight, _setToolbarHeight] = useState(0);

    const [collapsed, setCollapsed] = useState(false);

    const { loading, canvases, viewRoot, lastReply, view } = useView();

    const lastScrollTopRef = useRef(-1);
    const lastHeightTopRef = useRef(-1);
    const repliesScrollRef = useRef<HTMLDivElement>(null);

    const postRef = useRef<HTMLDivElement>(null);
    const [spacerHeight, setSpacerHeight] = useState(0);
    const scrollToSnapEnabled = useRef(true);
    const { fullscreenEditorActive } = useToolbar();

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

    // When using the new behavior, initially the Replies area is unfocused.
    const hasSnap = !!getSnapshot(useLocation().key);

    const [repliesFocused, _setRepliesFocused] = useState(
        hasSnap || shouldFocusRepliesByDefault(view)
    );

    const [scrollSettings, setScrollSettings] =
        useState<ScrollSettings>(undefined);
    const setRepliesFocused = (focused: boolean) => {
        _setRepliesFocused(focused);
        return setScrollSettings((prev) => {
            return {
                ...prev,
                view,
                scrollUsingWindow: focused,
            };
        });
    };

    useEffect(() => {
        if (view) {
            setRepliesFocused(shouldFocusRepliesByDefault(view));
            setScrollSettings((prev) => {
                return {
                    ...prev,
                    scrollUsingWindow: shouldFocusRepliesByDefault(view),
                    view,
                };
            });
        }
        return () => {
            // setRepliesFocused(false); // we can't have this unmount it seems. Feed restoration does not work (i.e. focus can not be set autmatically, because this will cancel it)
        };
    }, [view]);

    useEffect(() => {
        lastScrollTopRef.current = -1;
        setCollapsed(false);
    }, [viewRoot?.idString]);

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
                const repliesScrollRect =
                    repliesScrollRef.current.getBoundingClientRect();

                // If the scroll position is greater than the last scroll position, we are scrolling down
                // If we are scrolling down and the replies area is not focused, we want to focus it
                let lastScrollTop = lastScrollTopRef.current;
                let downscroll = false;
                if (lastScrollTop > 0) {
                    if (
                        lastScrollTop > repliesScrollRect.top &&
                        lastHeightTopRef.current >= repliesScrollRect.height
                    ) {
                        // the last condition is because if the rect get larger it can be so that we falsely identify a scroll down event
                        // Scrolling down
                        downscroll = true;
                    } else if (lastScrollTop < repliesScrollRect.top) {
                        // Scrolling up
                        downscroll = false;
                    }
                }

                lastScrollTopRef.current = repliesScrollRect.top;

                if (
                    repliesScrollRect.top < getSnapToRepliesViewThreshold(0) &&
                    downscroll
                ) {
                    /*  console.log(
                         "snap to focus replies!",
                         repliesScrollRect.top <
                             getSnapToRepliesViewThreshold(0) && downscroll,
                         repliesScrollRect.top,
                         getSnapToRepliesViewThreshold(0),
                         downscroll
                     ); */
                    setRepliesFocused(true);
                }
                lastHeightTopRef.current = repliesScrollRect.height;
            }
        };

        window.addEventListener("scroll", handleScroll);
        return () => {
            window.removeEventListener("scroll", handleScroll);
        };
    }, [repliesScrollRef.current, postRef.current, repliesFocused]);

    // Set up a ResizeObserver on the fixed Replies container to check for overflow.
    /*  useEffect(() => {
         if (!repliesScrollRef.current || repliesFocused) {
             // Only observe when Replies are unfocused.
             setShowClickToSeeMore(false);
             return;
         }
         const container = repliesScrollRef.current;
         // https://css-tip.com/overflow-detection/  do something like this instead
         const checkOverflow = () => {
             // Compare scrollHeight and clientHeight.
             console.log("CHECK OVERFLOW", {
                 scrollHeight: container.scrollHeight,
                 clientHeight: container.clientHeight,
                 offsetHeight: container.offsetHeight,
                 container
             })
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
     }, [repliesFocused, repliesScrollRef.current]); */

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

        console.log(
            "SET REPLEIS FOCUSEED BY GO TO TOP ",
            shouldFocusRepliesByDefault(view)
        );
        setRepliesFocused(shouldFocusRepliesByDefault(view));

        window.scrollTo({
            top: 0,
            behavior: "instant",
        });
        setTimeout(() => {
            scrollToSnapEnabled.current = true;
        }, 100); // This seems to be necessary on IOS Safari to avoid down scrolls to trigger focus again immediately
    };

    const EXTRA_PADDING_BOTTOM = 10;
    const bottomPadding = fullscreenEditorActive
        ? EXTRA_PADDING_BOTTOM
        : EXTRA_PADDING_BOTTOM + toolbarHeight;

    return (
        <>
            {/* 
          Main container takes full viewport height.
          Header (DetailedView + SubHeader) is shrink-to-fit.
          Replies area fills the remaining space.
        */}

            <div
                ref={scrollContainerRef}
                className={`${
                    repliesFocused ? "h-fit" : "h-full"
                } flex flex-col relative grow shrink-0`} // some extra height so that we can trigger downscroll
                style={{
                    paddingBottom: bottomPadding,
                    height: repliesFocused
                        ? "fit-content"
                        : `calc(100% + ${
                              spacerHeight -
                              toolbarHeight +
                              EXTRA_PADDING_BOTTOM +
                              SNAP_TO_REPLIES_EXTRA_SCROLL_HEIGHT
                          }px)`,
                }}
            >
                {/* Header section */}
                <div
                    ref={postRef}
                    className={`transition-all duration-300 ${
                        collapsed ? "blur-3xl opacity-0" : "blur-0 opacity-100"
                    }`}
                >
                    <div className="z-5 flex-shrink-0 bg-neutral-50 dark:bg-neutral-900">
                        <div className="max-w-[876px] mx-auto w-full">
                            {/*  special code to run in the root {!viewRoot || canvases.length === 1 ? (
                                <div>
                                    <div className="flex flex-row">
                                        <button className="btn btn-icon btn-icon-md gap-2">
                                            <TbBuildingCommunity />
                                            Places
                                        </button>
                                        <button className="btn btn-icon  btn-icon-md gap-2">
                                            <FaUserFriends />
                                            Friends
                                        </button>
                                        <button className="btn btn-icon btn-icon-md gap-2">
                                            <IoIosNotifications />
                                            Notifications
                                        </button>
                                    </div>
                                </div>
                            ) */}

                            <div className="py-6">
                                <DetailedView />
                            </div>
                        </div>
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
                            className={`box pt-4  ${
                                !repliesFocused
                                    ? "absolute inset-0 overflow-y-auto hide-scrollbar "
                                    : ""
                            }`}
                            ref={repliesScrollRef}
                            style={
                                {
                                    /*   paddingBottom: `${repliesFocused ? 0 : toolbarHeight
                                          }px` */
                                    /* For some reason we need this for focused view??? */
                                }
                            }
                        >
                            <Replies
                                // viewRef is body if focused, otherwise the scrollRef
                                viewRef={
                                    repliesFocused
                                        ? document.body
                                        : repliesScrollRef.current
                                }
                                scrollSettings={scrollSettings}
                                parentRef={repliesScrollRef}
                                onSnapshot={(_snap) => {
                                    setRepliesFocused(true);
                                }}
                            />
                        </div>
                        {/* Render the gradient overlay only when unfocused.
        This overlay is absolutely positioned over the container and does not receive pointer events. */}
                        {!repliesFocused && (
                            <div
                                className="absolute inset-0 z-3 cursor-pointer flex flex-col justify-start items-center overflow-container-guide"
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
                                    setRepliesFocused(true);
                                    e.preventDefault();
                                    e.stopPropagation();
                                }}
                            >
                                <span className="p-2 m-2 z-2 bg-white/50 dark:bg-black/50 text-neutral-950 dark:text-neutral-50 rounded text-sm font-semibold shadow-md backdrop-blur-xs">
                                    Click to see more
                                </span>
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
            <div className="max-w-[876px] mx-auto w-full">
                <FullscreenEditor>
                    <></>
                </FullscreenEditor>
            </div>
            <AnimatedStickyToolbar
                toolbarVisible={toolbarVisible}
                onHeightChange={(setHeight) => {
                    _setToolbarHeight(setHeight);
                }}
            >
                <Toolbar />
            </AnimatedStickyToolbar>
        </>
    );
};
