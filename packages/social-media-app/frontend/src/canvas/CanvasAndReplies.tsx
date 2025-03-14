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
    const [sortCriteria, setSortCriteria] = useState<"new" | "old" | "best">(
        "new"
    );

    // States for dynamic element heights
    const [headerHeight, setHeaderHeight] = useState(40);
    const [toolbarHeight, setToolbarHeight] = useState(60);

    // Refs for header, toolbar, and scroll container
    const toolbarRef = useRef<HTMLDivElement>(null);
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

    // Use ResizeObserver to update header and toolbar heights dynamically.
    useEffect(() => {
        if (typeof ResizeObserver === "undefined") return;

        const toolbarObserver = new ResizeObserver((entries) => {
            for (let entry of entries) {
                setToolbarHeight(entry.target.getBoundingClientRect().height);
            }
        });
        if (toolbarRef.current) {
            toolbarObserver.observe(toolbarRef.current);
            setToolbarHeight(toolbarRef.current.getBoundingClientRect().height);
        }

        return () => {
            toolbarObserver.disconnect();
        };
    }, [toolbarRef.current]); // we seem to need this dependency

    console.log({
        headerHeight,
        toolbarHeight,
    });

    // onSavePending remains largely the same.
    const onSavePending = () => {
        const scroll = () => {
            if (scrollContainerRef.current) {
                const scrollContainer = scrollContainerRef.current;
                // Calculate effective scroll height (content below header)
                const effectiveScrollHeight =
                    scrollContainer.scrollHeight - headerHeight;
                const effectiveContainerHeight =
                    scrollContainer.clientHeight - headerHeight;
                const maxScrollTop =
                    effectiveScrollHeight - effectiveContainerHeight;
                if (sortCriteria === "old") {
                    scrollContainer.scrollTo({ top: 0, behavior: "smooth" });
                } else if (sortCriteria === "best") {
                    setSortCriteria("new");
                    scrollContainer.scrollTo({
                        top: maxScrollTop,
                        behavior: "smooth",
                    });
                } else {
                    scrollContainer.scrollTo({
                        top: maxScrollTop,
                        behavior: "smooth",
                    });
                }
            }
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
            <div className="flex-grow  w-full mx-auto">
                {/* Set the scroll container height dynamically */}
                <div
                    id="content-scroll-root"
                    ref={scrollContainerRef}
                    className=" gap-2.5 overflow-y-auto w-full flex flex-col items-center"
                    style={{
                        height: `calc(100vh - ${
                            headerHeight + toolbarHeight
                        }px)`,
                    }}
                >
                    <div className="max-w-[876px] w-full h-full">
                        {/* dont show header on root post */}
                        {canvases.length > 1 && (
                            <Header canvas={lastCanvas} className="mb-2" />
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
            </div>
            <Toolbar
                ref={toolbarRef}
                pendingCanvas={pendingCanvas.program}
                onSavePending={onSavePending}
            />
        </div>
    );
};
