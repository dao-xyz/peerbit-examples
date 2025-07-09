import { useRef, useState, useEffect, useMemo } from "react";
import { InlineEditor } from "../edit/InlineEditor.js";
import { Spinner } from "../../utils/Spinner.js";
import { ReplyingInProgress } from "../feed/ReplyingInProgress.js";
import { CloseableAppPane } from "../edit/CloseableAppPane.js";
import { useView } from "../view/ViewContext.js";
import { DetailedView } from "../preview/DetailedPreview.js";
import { SubHeader } from "../navigation/SubHeader.js";
import { AnimatedStickyToolbar } from "../edit/AnimatedStickyToolbar.js";
import { CanvasEditorProvider } from "../edit/ToolbarContext.js";
import { ScrollSettings } from "./useAutoScroll.js";
import { getSnapshot } from "../feed/feedRestoration.js";
import { useLocation } from "react-router";
import { ViewModel } from "@giga-app/interface";
import { Feed } from "../feed/Feed.js";
import { ToolbarCreateNew } from "../edit/ToolbarCreateNew.js";
import { ToolbarVisibilityProvider } from "../edit/ToolbarVisibilityProvider.js";
import { EditModeProvider } from "../edit/EditModeProvider.js";
import { useHeaderVisibilityContext } from "../../HeaderVisibilitiyProvider.js";
import { useFeed } from "../feed/FeedContext.js";
import { useOnScrollToTop, useFocusProvider } from "../../FocusProvider.js";
import { CreatePostTitle } from "../edit/CreatePostTitle.js";
import { ToolbarInline } from "../edit/ToolbarInline.js";
import { set } from "lodash";

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
const EXTRA_PADDING_BOTTOM = 15;

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
    // Ref for the overall container (used for toolbar height calculations)
    const scrollContainerRef = useRef(null);

    const [collapsed, setCollapsed] = useState(false);

    const { loading, feedRoot, lastReply, view } = useFeed();
    const { viewRoot } = useView();

    const lastScrollTopRef = useRef(-1);
    const lastHeightTopRef = useRef(-1);
    const repliesScrollRef = useRef<HTMLDivElement>(null);

    const postRef = useRef<HTMLDivElement>(null);
    const [spacerHeight, setSpacerHeight] = useState(0);
    const scrollToSnapEnabled = useRef(true);
    const [showInlineEditor, setShowInlineEditor] = useState(false);
    const [navType, setNavType] = useState<"tabs" | "rows">("tabs");

    // on navigation we want to unshow inline editor
    useEffect(() => {
        setShowInlineEditor(false);
    }, [useLocation().pathname]);

    // Set up a ResizeObserver to and make the spacer height equal to postRef height - 50vh
    useEffect(() => {
        if (!postRef.current || !repliesScrollRef.current) {
            return;
        }
        const checkHeight = () => {
            if (!repliesScrollRef.current) {
                return;
            }
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

    useOnScrollToTop(() => {
        // Scroll to the top of the page
        scrollToSnapEnabled.current = false;
        lastScrollTopRef.current = -1;
        setRepliesFocused(shouldFocusRepliesByDefault(view));
        setTimeout(() => {
            scrollToSnapEnabled.current = true;
        }, 100); // This seems to be necessary on IOS Safari to avoid down scrolls to trigger focus again immediately
    });

    // When using the new behavior, initially the Replies area is unfocused.
    const hasSnap = !!getSnapshot(useLocation().key);

    const { focused: repliesFocused, setFocused: _setRepliesFocused } =
        useFocusProvider();

    useEffect(() => {
        _setRepliesFocused(hasSnap || shouldFocusRepliesByDefault(view)); // reset focused state on mount
    }, []);

    const { setDisabled } = useHeaderVisibilityContext();
    const collapsable = useMemo(
        () => !shouldFocusRepliesByDefault(view),
        [view]
    );

    const hidePost = useMemo(
        () => repliesFocused && collapsable && view.settings.focus === "last",
        [repliesFocused, collapsable, view.settings.focus]
    );

    useEffect(() => {
        if (hidePost) {
            setDisabled(true); // disable header show/hide effects
        } else {
            setDisabled(false);
        }
    }, [hidePost]);

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
    }, [feedRoot?.idString]);

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

    if (!viewRoot) {
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

    /*     const bottomPadding = fullscreenEditorActive
            ? EXTRA_PADDING_BOTTOM
            : EXTRA_PADDING_BOTTOM + toolbarHeight; */

    return (
        <>
            {/* 
          Main container takes full viewport height.
          Header (DetailedView + SubHeader) is shrink-to-fit.
          Replies area fills the remaining space.
        */}

            <ToolbarVisibilityProvider>
                <EditModeProvider>
                    <CanvasEditorProvider parent={feedRoot}>
                        <div
                            ref={scrollContainerRef}
                            className={`${
                                repliesFocused ? "h-fit" : "h-full"
                            } flex flex-col relative grow shrink-0`} // some extra height so that we can trigger downscroll
                            style={{
                                paddingBottom: !showInlineEditor
                                    ? `calc(var(--toolbar-h, 0px) + ${EXTRA_PADDING_BOTTOM}px)`
                                    : "2rem", // we use a --toolbar-h var because this will reduce glitchyness from re-rendering
                                height: repliesFocused
                                    ? "fit-content"
                                    : `calc(100vh - var(--toolbar-h, 0px) + ${
                                          spacerHeight +
                                          EXTRA_PADDING_BOTTOM +
                                          SNAP_TO_REPLIES_EXTRA_SCROLL_HEIGHT
                                      }px)`,
                            }}
                        >
                            {/* Header section */}
                            {!hidePost && (
                                <div
                                    ref={postRef}
                                    className={`transition-all duration-300 ${
                                        collapsed
                                            ? "blur-3xl opacity-0"
                                            : "blur-0 opacity-100"
                                    }`}
                                >
                                    <div className="z-5 flex-shrink-0   ">
                                        <div className="max-w-[876px] mx-auto w-full bg-neutral-50 dark:bg-neutral-900 shadow-md">
                                            {/*  special code to run in the root {!viewRoot || canvases.length === 1 ? (
                                  TODO 
                            ) */}
                                            <DetailedView />
                                        </div>
                                    </div>
                                </div>
                            )}

                            <SubHeader
                                collapsable={collapsable}
                                onCollapse={setCollapsed}
                                onViewChange={() => {
                                    // a manual change in view is an indication of that the user is interested in the replies
                                    setRepliesFocused(true);
                                }}
                                onNavTypeChange={(res) => {
                                    setNavType(res);
                                }}
                            />

                            {/* Replies section */}
                            {navType !== "rows" && (
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
                                                ? "absolute inset-0 w-full cursor-pointer "
                                                : "relative"
                                        }`}
                                    >
                                        {/* When unfocused, wrap Replies in an absolutely positioned, scrollable container.
        When focused, no extra wrapper is applied so the Replies render inline. */}
                                        <div
                                            id="replies-container"
                                            className={`box pt-12  ${
                                                !repliesFocused
                                                    ? "absolute inset-0 overflow-y-auto hide-scrollbar "
                                                    : ""
                                            } `}
                                            ref={repliesScrollRef}
                                            style={
                                                {
                                                    /*   paddingBottom: `${repliesFocused ? 0 : toolbarHeight
                                                      }px` */
                                                    /* For some reason we need this for focused view??? */
                                                }
                                            }
                                        >
                                            <>
                                                <Feed
                                                    // viewRef is body if focused, otherwise the scrollRef
                                                    viewRef={
                                                        repliesFocused
                                                            ? document.body
                                                            : repliesScrollRef.current
                                                    }
                                                    scrollSettings={
                                                        scrollSettings
                                                    }
                                                    parentRef={repliesScrollRef}
                                                    onSnapshot={(_snap) => {
                                                        setRepliesFocused(true);
                                                    }}
                                                    disableLoadMore={
                                                        showInlineEditor
                                                    } /* when showing inline editor we want to scroll up and down to perhaps read content so we disable the load more. TODO add a button so we still can trigger load more */
                                                />
                                                {feedRoot && (
                                                    <AnimatedStickyToolbar>
                                                        <CloseableAppPane>
                                                            <ToolbarCreateNew
                                                                parent={
                                                                    feedRoot
                                                                }
                                                                inlineEditorActive={
                                                                    showInlineEditor
                                                                }
                                                                setInlineEditorActive={
                                                                    setShowInlineEditor
                                                                }
                                                            />
                                                        </CloseableAppPane>
                                                    </AnimatedStickyToolbar>
                                                )}
                                            </>
                                        </div>
                                        {/* Render the gradient overlay only when unfocused.
        This overlay is absolutely positioned over the container and does not receive pointer events. */}
                                        {!repliesFocused && (
                                            <div
                                                /*   style={{
                                                  background: "linear-gradient(bottom top, transparent, rgba(255, 255, 255, 0.8))",
                                              }} */
                                                className="absolute  top-10 inset-0 z-3 cursor-pointer flex flex-col justify-start items-center overflow-container-guide "
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
                            )}
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
                        <div className="max-w-[876px] mx-auto w-full ">
                            {showInlineEditor && (
                                <>
                                    <div className="text-secondary-500/50 mb-8">
                                        <svg
                                            width="100%"
                                            height="40"
                                            viewBox="0 0 100 10"
                                            preserveAspectRatio="none"
                                            xmlns="http://www.w3.org/2000/svg"
                                        >
                                            <path
                                                d="M0 5 Q 22 0, 20 5 T 40 5 T 60 5 T 80 5 T 100 5"
                                                fill="transparent"
                                                stroke="currentColor"
                                                strokeWidth="1"
                                            />
                                        </svg>
                                    </div>
                                    <div className="m-2 bg-neutral-100 dark:bg-neutral-900 rounded-t-xl shadow-sm">
                                        <div className="flex flex-col">
                                            <div className="flex flex-col px-2">
                                                <CreatePostTitle className="px-2 mb-0" />
                                                <ToolbarInline />
                                            </div>
                                            <InlineEditor className="min-h-[calc(100vh-10rem)] pb-12" />
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>
                    </CanvasEditorProvider>
                </EditModeProvider>
            </ToolbarVisibilityProvider>
        </>
    );
};
