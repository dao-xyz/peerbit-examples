import { usePeer, useProgram } from "@peerbit/react";
import { useCanvases } from "./useCanvas.js";
import { useState, useEffect, useRef } from "react";
import { Canvas as Canvas } from "./Canvas.js";
import { CanvasWrapper } from "./CanvasWrapper.js";
import { Canvas as CanvasDB, CanvasAddressReference } from "@dao-xyz/social";
import { Replies } from "./Replies.js";
import { CreateNew } from "./CreateNew.js";
import { Spinner } from "../utils/Spinner.js";
import { Header } from "./header/Header.js";
import { Toolbar, ToolbarProvider } from "./toolbar/Toolbar.js";
import { FullscreenEditor } from "./toolbar/FullscreenEditor.js";

export const CanvasAndReplies = () => {
    const { peer } = usePeer();
    const { root, path: canvases, loading } = useCanvases();
    const [lastCanvas, setLastCanvas] = useState<CanvasDB>(undefined);
    const [sortCriteria, setSortCriteria] = useState<
        "new" | "old" | "best" | "chat"
    >("new");

    // Refs for header, toolbar, and scroll container
    const toolbarRef = useRef<HTMLDivElement>(null);
    const bottomScrollMarkerRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        setLastCanvas(canvases[canvases.length - 1]);
    }, [root?.closed || !root ? undefined : root.address, canvases]);

    useEffect(() => {
        if (!peer || !root) return;
        // Additional logic if needed
    }, [peer?.identity.publicKey.hashcode(), root]);

    const [pendingCanvasState, setPendingCanvasState] = useState<
        CanvasDB | undefined
    >(undefined);

    useEffect(() => {
        if (peer && lastCanvas)
            setPendingCanvasState(
                new CanvasDB({
                    publicKey: peer.identity.publicKey,
                    parent: lastCanvas,
                })
            );
    }, [lastCanvas?.idString, peer?.identity.publicKey.hashcode()]);

    const pendingCanvas = useProgram(pendingCanvasState, {
        id: pendingCanvasState?.idString,
        keepOpenOnUnmount: true,
        existing: "reuse",
    });

    // onSavePending remains largely the same.
    const onSavePending = () => {
        const scroll = () => {
            setTimeout(() => {
                if (
                    scrollContainerRef.current &&
                    bottomScrollMarkerRef.current
                ) {
                    const scrollContainer = scrollContainerRef.current;
                    const bottomScrollMarkerContainer =
                        bottomScrollMarkerRef.current;
                    if (sortCriteria === "old") {
                        scrollContainer.scrollTo({
                            top: 0,
                            behavior: "smooth",
                        });
                    } else if (sortCriteria === "best") {
                        setSortCriteria("new");
                        bottomScrollMarkerContainer.scrollIntoView({
                            block: "end",
                            inline: "nearest",
                            behavior: "smooth",
                        });
                    } else {
                        bottomScrollMarkerContainer.scrollIntoView({
                            block: "end",
                            inline: "nearest",
                            behavior: "smooth",
                        });
                    }
                }
            }, 100); // 100ms delay
        };
        setPendingCanvasState((prev) => {
            lastCanvas.replies.put(prev).then(scroll);
            return new CanvasDB({
                publicKey: peer.identity.publicKey,
                parent: lastCanvas,
            });
        });
    };

    if (!canvases || canvases.length === 0) {
        return (
            <div className="h-full flex flex-col justify-center">
                <div className="flex flex-col gap-4 items-center">
                    {loading ? (
                        <div className="flex flex-row gap-2">
                            <>Looking for spaces</>
                            <Spinner />
                        </div>
                    ) : (
                        <div className="flex flex-row gap-2">
                            Space not found
                        </div>
                    )}
                    <CreateNew />
                </div>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col">
            <ToolbarProvider
                pendingCanvas={pendingCanvas.program}
                onSavePending={onSavePending}
            >
                <div className="h-full flex flex-col relative">
                    <div
                        className="flex-grow  w-full mx-auto h-full"
                        ref={scrollContainerRef}
                    >
                        <FullscreenEditor>
                            {/* Set the scroll container height dynamically */}
                            <div className=" gap-2.5 w-full flex flex-col items-center">
                                <div className="mt-6 w-full h-full">
                                    <div className="max-w-[876px] mx-auto w-full">
                                        {/* dont show header on root post */}
                                        {canvases.length > 1 && (
                                            <Header
                                                variant="large"
                                                canvas={lastCanvas}
                                                className="mb-2  px-4"
                                            />
                                        )}
                                        <CanvasWrapper canvas={lastCanvas}>
                                            <Canvas
                                                bgBlur
                                                fitWidth
                                                draft={false}
                                            />
                                        </CanvasWrapper>
                                    </div>

                                    <Replies
                                        canvas={lastCanvas}
                                        sortCriteria={sortCriteria}
                                        setSortCriteria={setSortCriteria}
                                    />
                                </div>
                            </div>
                            <div
                                ref={bottomScrollMarkerRef}
                                className="h-0 w-full"
                            />
                        </FullscreenEditor>
                    </div>
                </div>
                <div className="sticky z-20 bottom-0 inset-x-0 bg-neutral-50 dark:bg-neutral-950">
                    <Toolbar ref={toolbarRef} />
                </div>
            </ToolbarProvider>
        </div>
    );
};
