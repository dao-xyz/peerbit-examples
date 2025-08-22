import { useCallback, useEffect, useMemo, useState } from "react";
import { CanvasWrapper, useCanvas } from "../CanvasWrapper";
import { CanvasPreview } from "../preview/Preview";
import { useAllPosts } from "../feed/useCollection";
import {
    Canvas,
    ChildVisualization,
    IndexableCanvas,
    LOWEST_QUALITY,
} from "@giga-app/interface";
import { FaChevronRight, FaList, FaPlus } from "react-icons/fa";
import { PiTabs } from "react-icons/pi";
import { BiSolidChevronsUp } from "react-icons/bi";

import { CanvasEditorProvider } from "../edit/ToolbarContext";
import { InlineEditor } from "../edit/InlineEditor";
import { CloseableAppPane } from "../edit/CloseableAppPane";
import { ToolbarEdit } from "../edit/ToolbarEdit";
import { EditModeProvider } from "../edit/EditModeProvider";
import { useCanvases } from "../useCanvas";
import { useNavigate } from "react-router";
import { getCanvasPath } from "../../routes";
import { CanvasSettingsButton } from "../header/CanvasSettingsButton";
import { usePeer } from "@peerbit/react";
import { usePendingCanvas } from "../edit/PendingCanvasContext";
import { WithIndexedContext } from "@peerbit/document"
export const TabsOrList = (properties?: {
    className?: string;
    canvas?: WithIndexedContext<Canvas, IndexableCanvas>;
    view: "tabs" | "rows";
    setView?: (view: "tabs" | "rows") => void;
    onBackToTop?: () => void;
}) => {
    const { view, setView } = properties;
    const toggleView = () => {
        let newView = (view === "tabs" ? "rows" : "tabs") as "tabs" | "rows";
        setView?.(newView);
    };
    const { posts } = useAllPosts({
        scope: properties?.canvas.nearestScope,
        parent: properties?.canvas,
        type: "navigational",
    });
    const { peer } = usePeer();
    const showToolbar = useMemo(() => {
        const canEdit = properties.canvas?.publicKey.equals(
            peer?.identity.publicKey
        );
        return canEdit || posts.length > 0;
    }, [peer, properties?.canvas, posts.length]);

    return (
        <>
            {" "}
            {showToolbar && (
                <EditModeProvider>
                    <div
                        className={
                            "flex flex-col gap-2 z-30 min-h-8 rounded-b-xl " +
                            (properties?.className ?? "")
                        }
                    >
                        <div className="flex flex-row gap-2 h-full align-middle items-center h-min-8 px-2">
                            {view === "tabs" && (
                                <Tabs
                                    canvas={properties?.canvas}
                                    toggleView={toggleView}
                                    posts={posts}
                                />
                            )}
                            {view === "rows" && (
                                <span className="text-sm dark:text-neutral-400 text-neutral-600 ">
                                    Places
                                </span>
                            )}
                            <div className="ml-auto   flex flex-row h-full align-middle justify-between  items-start">
                                {view === "tabs" && (
                                    <button
                                        className="btn btn-icon btn-sm h-full"
                                        onClick={() => {
                                            // change view to list if it is not already
                                            toggleView();
                                        }}
                                    >
                                        <FaPlus className="w-4 h-4" />
                                    </button>
                                )}
                                {setView && (
                                    <button
                                        className="btn btn-icon btn-sm  h-full flex flex-row  align-middle justify-center items-center gap-1 text-sm "
                                        onClick={toggleView}
                                    >
                                        {view === "tabs" ? (
                                            <FaList className="w-4 h-4" />
                                        ) : (
                                            <PiTabs
                                                className="w-5 h-5"
                                                size={24}
                                            />
                                        )}
                                    </button>
                                )}
                                {properties?.onBackToTop && (
                                    <button
                                        className="btn btn-icon btn-sm h-full flex flex-row gap-1"
                                        onClick={properties?.onBackToTop}
                                    >
                                        Back
                                        <BiSolidChevronsUp size={20} />
                                    </button>
                                )}
                            </div>
                        </div>
                        {view === "rows" && (
                            <Rows
                                canvas={properties?.canvas}
                                posts={posts}
                                toggleView={toggleView}
                            />
                        )}
                    </div>
                </EditModeProvider>
            )}
        </>
    );
};
export const Tabs = (properties: {
    canvas?: Canvas;
    toggleView: () => void;
    posts: Canvas[];
}) => {
    const { posts } = properties;

    const navigate = useNavigate();

    const { path } = useCanvases();

    const isSelected = useCallback(
        (post: Canvas) => {
            if (!post) return false;
            if (!path || !path.length) return false;
            return path.find((x) => x.idString === post.idString);
        },
        [path]
    );

    /* --------------------------- Render as tabs ------------------------------ */
    return (
        <div className="flex flex-wrap w-full  h-full ">
            {posts.map((post, index) => (
                <button
                    key={index}
                    className={"btn  "}
                    onClick={() => {
                        navigate(getCanvasPath(post));
                    }}
                >
                    <CanvasWrapper
                        canvas={post}
                        quality={LOWEST_QUALITY}
                        classNameContent={
                            "hover:text-neutral-50 dark:hover:text-neutral-50 !whitespace-nowrap text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 " +
                            (isSelected(post)
                                ? "text-secondary-600 dark:text-secondary-300 underline underline-offset-4  "
                                : "text-neutral-500 dark:text-neutral-400")
                        }
                    >
                        <CanvasPreview variant="row" />
                    </CanvasWrapper>
                </button>
            ))}
        </div>
    );
};

export const Rows = (properties: {
    canvas?: Canvas;
    toggleView: () => void;
    posts: Canvas[];
}) => {
    const { posts } = properties;
    const navigate = useNavigate();

    /* --------------------------- Render as rows ------------------------------ */

    return (
        <div className="flex flex-col gap-2">
            {posts.map((post, index) => (
                <div
                    onClick={() => {
                        navigate(getCanvasPath(post));
                        properties?.toggleView?.();
                    }}
                    key={index}
                    className="btn shadow-sm  flex flex-row gap-2 border-1 mx-2 px-2 py-1 border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 bg-neutral-100 dark:bg-neutral-900"
                >
                    <CanvasWrapper canvas={post} quality={LOWEST_QUALITY}>
                        <CanvasPreview
                            className="w-full"
                            variant="row"
                        ></CanvasPreview>
                    </CanvasWrapper>
                    <CanvasSettingsButton canvas={post} />
                    <FaChevronRight size={14} />
                </div>
            ))}
            <CanvasEditorProvider
                type={ChildVisualization.OUTLINE}
                replyTo={properties.canvas}
                placeholder="Give your new space a name..."
            >
                <NewSection />
            </CanvasEditorProvider>
        </div>
    );
};

const NewSection = () => {
    const { isEmpty, insertDefault, canvas, pendingRects } =
        useCanvas();
    const { savedOnce } = usePendingCanvas();

    useEffect(() => {
        if (
            savedOnce === false &&
            /*  !isSavingCanvas && !isSavingElements &&  */ pendingRects.length ===
            0 &&
            canvas
        ) {
            insertDefault();
        }
    }, [
        isEmpty,
        savedOnce,
        /* isSavingCanvas, isSavingElements, */ canvas?.idString,
        pendingRects,
    ]);

    return (
        <div className="flex flex-col gap-2">
            <InlineEditor />
            <CloseableAppPane>
                {!isEmpty && (
                    <ToolbarEdit className="bg-transparent dark:bg-transparent" />
                )}
            </CloseableAppPane>
        </div>
    );
};
