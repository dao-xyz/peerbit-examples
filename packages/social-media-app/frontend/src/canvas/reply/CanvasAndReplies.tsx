import React, { useRef, useState } from "react";
import { ToolbarProvider } from "../toolbar/Toolbar.js";
import { FullscreenEditor } from "../toolbar/FullscreenEditor.js";
import { Spinner } from "../../utils/Spinner.js";
import { Header } from "../header/Header.js";
import { CanvasWrapper } from "../CanvasWrapper.js";
import { Canvas } from "../Canvas.js";
import { Replies } from "./Replies.js";
import { ReplyingInProgress } from "./ReplyingInProgress.js";
import { Toolbar } from "../toolbar/Toolbar.js";
import { useView } from "../../view/ViewContex.js";
import { PendingCanvasProvider } from "../PendingCanvasContext.js";

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
    const toolbarRef = useRef(null);
    const scrollContainerRef = useRef(null);

    // Use the custom hook to get view-related state and actions
    const { loading, canvases, viewRoot, lastReply } = useView();

    if (!canvases || canvases.length === 0) {
        return (
            <div className="h-full flex flex-col justify-center">
                <div className="flex flex-col gap-4 items-center">
                    {loading ? (
                        <div className="flex flex-row gap-2">
                            <>{textToLoad}</>
                            <Spinner />
                        </div>
                    ) : (
                        canvases.length === 0 && (
                            <div className="flex flex-row gap-2">
                                Space not found
                            </div>
                        )
                    )}
                </div>
            </div>
        );
    }

    return (
        <PendingCanvasProvider viewRoot={viewRoot}>
            <ToolbarProvider>
                <div
                    className="h-fit flex flex-col relative grow shrink-0"
                    ref={scrollContainerRef}
                >
                    <FullscreenEditor>
                        <div className="gap-2.5 w-full flex flex-col items-center">
                            <div className="mt-6 w-full h-full">
                                <div className="max-w-[876px] mx-auto w-full">
                                    {canvases.length > 1 && (
                                        <Header
                                            variant="large"
                                            canvas={viewRoot}
                                            className="mb-2 px-4"
                                        />
                                    )}
                                    <CanvasWrapper canvas={viewRoot}>
                                        <Canvas bgBlur fitWidth draft={false} />
                                    </CanvasWrapper>
                                </div>
                                <Replies />
                            </div>
                        </div>
                    </FullscreenEditor>
                </div>
                <ReplyingInProgress canvas={lastReply} />

                <div className="sticky z-20 bottom-0 inset-x-0 bg-neutral-50 dark:bg-neutral-950">
                    <Toolbar ref={toolbarRef} />
                </div>
            </ToolbarProvider>
        </PendingCanvasProvider>
    );
};
