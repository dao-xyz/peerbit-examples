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
import { Toolbar } from "./toolbar/Toolbar.js";

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
                    parent: new CanvasAddressReference({ canvas: lastCanvas }),
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
                parent: new CanvasAddressReference({ canvas: lastCanvas }),
            });
        });
    };

    if (canvases.length === 0) {
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
        <div className="flex flex-col h-full">
            <div
                className="flex-grow  w-full mx-auto h-full overflow-auto"
                ref={scrollContainerRef}
            >
                {/* Set the scroll container height dynamically */}
                <div className=" gap-2.5 w-full flex flex-col items-center">
                    <div className="max-w-[876px] w-full h-full">
                        {/* dont show header on root post */}
                        {canvases.length > 1 && (
                            <Header
                                variant="large"
                                canvas={lastCanvas}
                                className="mb-2"
                            />
                        )}
                        <CanvasWrapper canvas={lastCanvas}>
                            <Canvas bgBlur fitWidth draft={false} />
                        </CanvasWrapper>
                        <Replies
                            canvas={lastCanvas}
                            sortCriteria={sortCriteria}
                            setSortCriteria={setSortCriteria}
                        />
                    </div>
                </div>
                <div ref={bottomScrollMarkerRef} className="h-0 w-full" />
            </div>
            <Toolbar
                ref={toolbarRef}
                pendingCanvas={pendingCanvas.program}
                onSavePending={onSavePending}
            />
        </div>
    );
};
