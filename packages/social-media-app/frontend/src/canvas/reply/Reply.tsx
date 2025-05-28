import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
    Canvas as CanvasDB,
    getOwnedAndSubownedElementsQuery,
    getOwnedElementsQuery,
    IndexableCanvas,
    MEDIUM_QUALITY,
} from "@giga-app/interface";
import { Canvas } from "../Canvas.js";
import { usePeer } from "@peerbit/react";
import { CanvasPreview } from "../Preview.js";
import { WithIndexedContext } from "@peerbit/document";
import { useNavigate } from "react-router";
import { getCanvasPath } from "../../routes.js";
import { Header } from "../header/Header.js";
import { CanvasWrapper } from "../CanvasWrapper.js";
import { useView } from "./view/ViewContex.js";
import { rectIsStaticMarkdownText } from "../utils/rect.js";
import { useLeaveSnapshotFn } from "./feedRestoration.js";

const ReplyButton = ({
    children,
    ...rest
}: React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>) => {
    return (
        <button
            {...rest}
            className={
                "border border-black rounded-md px-1.5 py-1 bg-white dark:bg-black dark:border-white  " +
                rest?.className
            }
        >
            {children}
        </button>
    );
};

type BaseReplyPropsType = {
    canvas: WithIndexedContext<CanvasDB, IndexableCanvas>;
    index?: number;
    onClick?: () => void;
    hideHeader?: boolean;
    lineType?: "start" | "middle" | "end" | "end-and-start" | "none";
    headerRef?: React.Ref<HTMLDivElement>;
    forwardRef?: React.Ref<HTMLDivElement>;
    highlightType?: "pre-selected" | "selected";
    classNameHighlight?: string;
    className?: string;
    onLoad?: () => void;
};

type ReplyPropsType = BaseReplyPropsType & {
    variant?: "chat" | "thread" | "expanded-breadcrumb";
    isQuote?: boolean;
};

export const Reply = ({
    canvas,
    index,
    onClick,
    variant = "thread",
    hideHeader = false,
    isQuote,
    headerRef: headerRef,
    forwardRef: forwardRef,
    highlightType,
    className,
    classNameHighlight,
    onLoad,
}: ReplyPropsType) => {
    const [showMore, setShowMore] = useState(false);
    const [isOverflowing, setIsOverflowing] = useState(false);
    const previewContainerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);

    const { viewRoot } = useView();
    const { peer } = usePeer();

    const navigate = useNavigate();
    const leaveSnapshot = useLeaveSnapshotFn();

    // Use useLayoutEffect with a ResizeObserver to measure the container after the layout
    /* Rework this to handle text + image, text, image, overflow correctly 
    // problem is that images should shrink to fit, and text should overflow, and this means we neede h-full on images, and h-auto on text (but we can't have both)  
    useLayoutEffect(() => {
         const container = contentRef.current;
 
         if (!container) return;
         let errorMargin = 10; // Adjust this value as needed
         // Create an observer that watches for resize changes.
         const observer = new ResizeObserver((entries) => {
             for (const entry of entries) {
                 const currentHeight = entry.contentRect.height;
                 const computedStyle = window.getComputedStyle(previewContainerRef.current);
                 // Get the computed max-height (assumes it's in a valid px value)
                 // If max-height is "none", we'll assume there's no limit.
                 const maxHeightStr = computedStyle.maxHeight;
                 const maxHeight =
                     maxHeightStr === "none"
                         ? Infinity
                         : parseFloat(maxHeightStr);
                 console.log("maxHeight", currentHeight, maxHeight);
                 if (currentHeight >= maxHeight + errorMargin) {
                     setIsOverflowing(true);
                 } else {
                     setIsOverflowing(false);
                 }
             }
         });
 
         // Start observing the container.
         observer.observe(container);
 
         // Run an initial measure
         const rect = container.getBoundingClientRect();
         const computedStyle = window.getComputedStyle(previewContainerRef.current);
         const maxHeightStr = computedStyle.maxHeight;
         const maxHeight =
             maxHeightStr === "none" ? Infinity : parseFloat(maxHeightStr);
 
         if (rect.height >= maxHeight + errorMargin) {
             setIsOverflowing(true);
         } else {
             setIsOverflowing(false);
         }
 
         // Cleanup the observer on unmount
         return () => observer.disconnect();
     }, [canvas, showMore, contentRef.current, previewContainerRef.current]); // Re-run if canvas content or showMore toggles
  */
    const handleCanvasClick = async (e?: any) => {
        leaveSnapshot(canvas);
        let viewAfterNavigation = "chat";
        canvas = canvas.closed
            ? await viewRoot.openWithSameSettings(canvas)
            : canvas;
        await canvas.load();

        const totalReplies = await canvas.replies.count({
            query: getOwnedAndSubownedElementsQuery(canvas),
            approximate: true,
        });
        const immediateReplies = await canvas.replies.count({
            query: getOwnedElementsQuery(canvas),
            approximate: true,
        });
        if (
            totalReplies > immediateReplies * 3 ||
            totalReplies > 100 // this means that replies are very nested, and we should open the thread
        ) {
            viewAfterNavigation = "best";
        }
        viewAfterNavigation = "chat";

        navigate(getCanvasPath(canvas, viewAfterNavigation), {});
        onClick && onClick();
    };

    const align = canvas.publicKey.equals(peer.identity.publicKey)
        ? "right"
        : "left";
    const isExpandedBreadcrumb = variant === "expanded-breadcrumb";
    const isChat = variant === "chat";
    const isThread = variant === "thread";

    const highlightStyle =
        (highlightType
            ? "animated-border p-0 " +
              (highlightType === "pre-selected" ? "unfocused" : "focused")
            : "") +
        " " +
        (classNameHighlight ?? "");
    const styleFromFromMode = isChat
        ? ""
        : "bg-neutral-50 dark:bg-neutral-800 shadow  rounded-lg p-2";

    return (
        <div
            ref={forwardRef}
            className={`flex flex-col  ${
                isChat
                    ? align === "right"
                        ? " items-end ml-10"
                        : "items-start mr-10"
                    : ""
            } ${styleFromFromMode} ${className}`}
        >
            {/* {lineType && lineType !== "none" && (
                <div className="absolute left-0 top-0 bottom-0 pointer-events-none z-[-1]">
                    <div className="w-px h-full bg-neutral-300 dark:bg-neutral-600" />
                </div>
            )} */}
            <div
                className={`inline-flex h-full flex-col border-transparent hover:border-black dark:hover:border-white ${highlightStyle} ${
                    isThread ? "w-full" : ""
                }`}
            >
                {!hideHeader && (
                    <div
                        className={`flex items-center mb-2 ${
                            align === "right" ? "justify-end" : "justify-start"
                        }`}
                    >
                        <Header
                            variant={
                                isChat
                                    ? "medium"
                                    : isExpandedBreadcrumb
                                    ? "tiny"
                                    : "large"
                            }
                            forwardRef={headerRef}
                            canvas={canvas}
                            direction="row"
                            open={handleCanvasClick}
                            reverseLayout={isChat && align === "right"}
                        />
                    </div>
                )}
                {/* Preview / Canvas Section*/}
                <div
                    ref={previewContainerRef}
                    className={` relative overflow-hidden flex flex-col min-h-0 max-height-inherit-children ${
                        showMore ? "max-h-full" : "max-h-[40vh]"
                    }`}
                >
                    <CanvasWrapper canvas={canvas} quality={MEDIUM_QUALITY}>
                        {isExpandedBreadcrumb ? (
                            <CanvasPreview
                                forwardRef={contentRef}
                                variant="expanded-breadcrumb"
                                onClick={handleCanvasClick}
                                onLoad={onLoad}
                            />
                        ) : isChat ? (
                            <CanvasPreview
                                forwardRef={contentRef}
                                onClick={handleCanvasClick}
                                variant={isQuote ? "quote" : "chat-message"}
                                align={align}
                                className={`flex flex-col gap-2  ${
                                    align === "right"
                                        ? "flex flex-col justify-end items-end"
                                        : ""
                                }`}
                                classNameContent={
                                    align === "right"
                                        ? (element) =>
                                              "bg-neutral-200 dark:bg-neutral-700 rounded " +
                                              (rectIsStaticMarkdownText(element)
                                                  ? "p-2"
                                                  : "")
                                        : ""
                                }
                                onLoad={onLoad}
                            />
                        ) : showMore ? (
                            <div ref={contentRef}>
                                <Canvas
                                    bgBlur
                                    fitWidth
                                    draft={false}
                                    onLoad={onLoad}
                                />
                            </div>
                        ) : (
                            <CanvasPreview
                                forwardRef={contentRef}
                                onClick={handleCanvasClick}
                                variant="post"
                                className="w-full "
                                onLoad={onLoad}
                            />
                        )}
                    </CanvasWrapper>
                    {/* Gradient overlay appears when collapsed and content is overflowing */}
                    {!showMore && isOverflowing && (
                        <div className="absolute bottom-0 left-0 right-0 h-[66px] pointer-events-none bg-gradient-to-t from-neutral-50 to-transparent dark:from-black dark:to-transparent" />
                    )}
                </div>

                {/* Styling corners */}
                <div className="corner top-left">
                    <span className="arc"></span>
                </div>
                <div className="corner top-right">
                    <span className="arc"></span>
                </div>
                <div className="corner bottom-left">
                    <span className="arc"></span>
                </div>
                <div className="corner bottom-right">
                    <span className="arc"></span>
                </div>
            </div>
            {!isExpandedBreadcrumb && isOverflowing && (
                /* Show more button, overlay with content, if contracted */
                <div
                    className={`flex gap-2.5 w-full ${
                        !showMore ? "-translate-y-full" : ""
                    }`}
                >
                    <div className="ml-auto p-2">
                        <ReplyButton
                            className="  btn btn-xs h-full ganja-font text-lg leading-3 "
                            onClick={() => {
                                setShowMore((prev) => !prev);
                                onClick && onClick();
                            }}
                        >
                            {showMore ? "Show less" : "Show more"}
                        </ReplyButton>
                    </div>
                </div>
            )}
        </div>
    );
};
