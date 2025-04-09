import React, { useRef, useState } from "react";
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

const loadingTexts: string[] = [
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

export const CanvasAndReplies = () => {
    const scrollContainerRef = useRef(null);
    // This state will hold the measured toolbar height.
    const [toolbarHeight, setToolbarHeight] = useState(0);

    // Use the custom hook to get view-related state and actions.
    const { loading, canvases, viewRoot, lastReply } = useView();
    // Pass the scrollContainerRef if your hook uses it.
    const toolbarVisible = useToolbarVisibility(scrollContainerRef);

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

    return (
        <PendingCanvasProvider viewRoot={viewRoot}>
            <ToolbarProvider>
                {/* Reserve space at the bottom equal to the toolbar height */}
                <div
                    ref={scrollContainerRef}
                    className="h-fit min-h-full flex flex-col relative grow shrink-0"
                    style={{ paddingBottom: toolbarHeight }}
                >
                    <FullscreenEditor>
                        <div className="mt-6 max-w-[876px] mx-auto w-full">
                            <DetailedView />
                        </div>
                        <SubHeader />
                        <Replies />
                    </FullscreenEditor>
                </div>
                <div className="relative">
                    <div
                        className={`absolute right-1`}
                        style={{
                            bottom: toolbarHeight + "px",
                        }}
                    >
                        <ReplyingInProgress canvas={lastReply} />
                    </div>
                </div>

                {/* AnimatedStickyToolbar receives toolbarVisible and calls onHeightChange when its height changes */}
                <AnimatedStickyToolbar
                    toolbarVisible={toolbarVisible}
                    onHeightChange={setToolbarHeight}
                >
                    <Toolbar />
                </AnimatedStickyToolbar>
            </ToolbarProvider>
        </PendingCanvasProvider>
    );
};
