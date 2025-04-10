import { useRef, useState, useEffect } from "react";
import { ToolbarProvider } from "../toolbar/Toolbar.js";
import { FullscreenEditor } from "../toolbar/FullscreenEditor.js";
import { Spinner } from "../../utils/Spinner.js";
import { Replies } from "./Replies.js";
import { ReplyingInProgress } from "./ReplyingInProgress.js";
import { Toolbar } from "../toolbar/Toolbar.js";
import { useView } from "../../view/ViewContex.js";
import { PendingCanvasProvider } from "../PendingCanvasContext.js";
import { useToolbarVisibility } from "./useToolbarVisibility.js";
import { DetailedView } from "../detailed/DetailedView.js";
import { SubHeader } from "./SubHeader.js";
import { AnimatedStickyToolbar } from "./AnimatedStickyToolbar.js";
import { DetailedViewContainer } from "../detailed/DetailedViewContainer.js";

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

/**
 * CanvasAndReplies component.
 *
 * When the Replies area is unfocused, it will cover the space between the SubHeader
 * (immediately above) and the Toolbar below. In this state the Replies area is rendered in a fixed
 * container (its scrollbar is hidden) so it doesn't affect the body scrollbar.
 * When focused, Replies are rendered in-line.
 */
export const CanvasAndReplies = () => {
    // Ref for the overall container (used for toolbar height calculations)
    const scrollContainerRef = useRef(null);

    const [toolbarHeight, _setToolbarHeight] = useState(0);

    const { loading, canvases, viewRoot, lastReply, view } = useView();
    const toolbarVisible = useToolbarVisibility(scrollContainerRef);

    // For view types other than "best" or "old", we want the new scroll-based effect.
    const normalScrollBehaviour = view === "best" || view === "old";

    // When using the new behavior, initially the Replies area is unfocused.
    const [repliesFocused, setRepliesFocused] = useState(normalScrollBehaviour);

    const repliesScrollRef = useRef<HTMLDivElement>(null);

    if (!canvases || canvases.length === 0) {
        return (
            <div className="h-full flex flex-col justify-center">
                <div className="flex flex-col gap-4 items-center">
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
        setRepliesFocused(false);
        window.scrollTo({
            top: 0,
            behavior: "instant",
        });
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
                    className="h-fit min-h-full flex flex-col relative grow shrink-0"
                    style={{ paddingBottom: toolbarHeight }}
                >
                    {/* Header section */}
                    <div className="flex-shrink-0">
                        <FullscreenEditor>
                            <div className="mt-6 max-w-[876px] mx-auto w-full">
                                {/*  {!repliesFocused ? (
                                    <DetailedViewContainer
                                        onMinimized={() => {
                                            // When the DetailedView is minimized, keep Replies unfocused.
                                            setRepliesFocused(false);
                                        }}
                                    >
                                        <DetailedView />
                                    </DetailedViewContainer>
                                ) : (
                                    <DetailedView />
                                )} */}
                                <DetailedView />
                            </div>
                        </FullscreenEditor>
                    </div>
                    <SubHeader
                        onBackToTop={goToTop}
                        onViewChange={() => {
                            // a manual change in view is an indication of that the user is interested in the replies
                            setRepliesFocused(true);
                        }}
                    />

                    {/* Replies section */}
                    <div className="relative flex-1 overflow-hidden">
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
                                className={`${
                                    !repliesFocused
                                        ? "absolute inset-0 overflow-y-auto hide-scrollbar"
                                        : ""
                                }`}
                                ref={repliesScrollRef}
                            >
                                <Replies
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
                                    className="absolute inset-0 cursor-pointer backdrop-blur-[1px] bg-gradient-to-t from-transparent to-neutral-50 dark:from-transparent dark:to-black"
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
                                />
                            )}
                        </div>
                    </div>
                </div>

                {/* Optionally, you can also include a fixed AnimatedStickyToolbar or ReplyingInProgress
            as needed. For example, to display a ReplyingInProgress indicator: */}
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
