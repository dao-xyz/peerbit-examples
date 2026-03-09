import { useCallback, useEffect, useRef, useState } from "react";
import {
    Canvas as CanvasDB,
    Element,
    ElementContent,
    IndexableCanvas,
    MEDIUM_QUALITY,
} from "@giga-app/interface";
import { Canvas } from "../render/detailed/Canvas.js";
import { usePeer } from "@peerbit/react";
import { CanvasPreview } from "../render/preview/Preview.js";
import { WithIndexedContext } from "@peerbit/document";
import { useNavigate } from "react-router";
import { toBase64URL } from "@peerbit/crypto";
import { getCanvasPath } from "../../routes.js";
import { Header } from "../header/Header.js";
import { CanvasWrapper } from "../CanvasWrapper.js";
import { rectIsStaticImage, rectIsStaticMarkdownText } from "../utils/rect.js";
import { rememberRouteCanvas, useCanvases } from "../useCanvas.js";
import { useIsActiveLayer } from "../../layers/ActiveLayerContext.js";

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
    onPointerDownCapture?: React.PointerEventHandler<HTMLDivElement>;
};

type ReplyPropsType = BaseReplyPropsType & {
    variant?: "chat" | "thread" | "expanded-breadcrumb";
    isQuote?: boolean;
};

export const Reply = ({
    canvas,
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
    onPointerDownCapture,
}: ReplyPropsType) => {
    const [showMore, setShowMore] = useState(false);
    const [isOverflowing] = useState(false);
    const [isPreviewReady, setIsPreviewReady] = useState(false);
    const previewContainerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const readyReportedRef = useRef(false);
    const readyCleanupRef = useRef<(() => void) | null>(null);
    const readyRafRef = useRef<number | null>(null);
    const readyRaf2Ref = useRef<number | null>(null);

    const { viewRoot } = useCanvases();
    const { peer } = usePeer();
    const isActiveLayer = useIsActiveLayer();

    const navigate = useNavigate();

    const previewLooksReady = useCallback(() => {
        const root = previewContainerRef.current;
        if (!root) return false;

        const preview =
            (root.querySelector(
                '[data-feed-preview="true"]'
            ) as HTMLElement | null) ?? root;

        const images = Array.from(
            preview.querySelectorAll("img")
        ) as HTMLImageElement[];
        if (
            images.some((img) => {
                return (
                    img.complete &&
                    img.naturalWidth > 0 &&
                    img.naturalHeight > 0
                );
            })
        ) {
            return true;
        }

        return (preview.textContent || "").trim().length > 0;
    }, []);

    const cleanupReadyWatch = useCallback(() => {
        readyCleanupRef.current?.();
        readyCleanupRef.current = null;
        if (readyRafRef.current != null) {
            window.cancelAnimationFrame(readyRafRef.current);
            readyRafRef.current = null;
        }
        if (readyRaf2Ref.current != null) {
            window.cancelAnimationFrame(readyRaf2Ref.current);
            readyRaf2Ref.current = null;
        }
    }, []);

    const markPreviewPending = useCallback(() => {
        readyReportedRef.current = false;
        setIsPreviewReady(false);
        if (readyRafRef.current != null) {
            window.cancelAnimationFrame(readyRafRef.current);
            readyRafRef.current = null;
        }
        if (readyRaf2Ref.current != null) {
            window.cancelAnimationFrame(readyRaf2Ref.current);
            readyRaf2Ref.current = null;
        }
    }, []);

    const reportReady = useCallback(() => {
        if (!previewLooksReady()) {
            markPreviewPending();
            return;
        }

        if (readyReportedRef.current) {
            setIsPreviewReady(true);
            return;
        }

        if (readyRafRef.current != null || readyRaf2Ref.current != null) {
            return;
        }

        readyRafRef.current = window.requestAnimationFrame(() => {
            readyRafRef.current = null;
            readyRaf2Ref.current = window.requestAnimationFrame(() => {
                readyRaf2Ref.current = null;
                if (!previewLooksReady()) {
                    markPreviewPending();
                    return;
                }
                if (readyReportedRef.current) {
                    setIsPreviewReady(true);
                    return;
                }
                readyReportedRef.current = true;
                setIsPreviewReady(true);
                onLoad?.();
            });
        });
    }, [markPreviewPending, onLoad, previewLooksReady]);

    const ensureReadyObserved = useCallback(() => {
        reportReady();

        cleanupReadyWatch();

        const root = previewContainerRef.current;
        if (!root) return;

        const mutationObserver = new MutationObserver(() => {
            reportReady();
        });
        mutationObserver.observe(root, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
        });

        const resizeObserver = new ResizeObserver(() => {
            reportReady();
        });
        resizeObserver.observe(root);

        const interval = window.setInterval(() => {
            reportReady();
        }, 100);

        readyCleanupRef.current = () => {
            mutationObserver.disconnect();
            resizeObserver.disconnect();
            window.clearInterval(interval);
        };
    }, [cleanupReadyWatch, reportReady]);

    useEffect(() => {
        if (!isActiveLayer) {
            cleanupReadyWatch();
            return;
        }
        readyReportedRef.current = false;
        setIsPreviewReady(false);
        cleanupReadyWatch();
        const raf = window.requestAnimationFrame(() => {
            ensureReadyObserved();
        });
        return () => {
            window.cancelAnimationFrame(raf);
            cleanupReadyWatch();
        };
    }, [
        canvas.idString,
        cleanupReadyWatch,
        ensureReadyObserved,
        isActiveLayer,
        showMore,
        variant,
    ]);

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
    const handleCanvasClick = async (e?: Element<ElementContent>) => {
        // if we click on an image, just make it fullscreen instead of navigating
        if (e && (rectIsStaticImage(e) || rectIsStaticMarkdownText(e))) {
            return;
        }

        let viewAfterNavigation = "chat";
        /*  canvas = canvas.closed
             ? await viewRoot.nearestScope.openWithSameSettings(canvas)
             : canvas;
         await canvas.load(); */
        const opened = await viewRoot.nearestScope.openWithSameSettings(canvas);
        rememberRouteCanvas(opened);
        const scopeAddrs = Array.from(
            new Set([
                viewRoot.nearestScope.address,
                opened.nearestScope.address,
                opened.selfScope?.address,
            ].filter((addr): addr is string => !!addr))
        );

        // Observers should not do background replication work, but an explicit
        // open is allowed to warm the direct thread so the detail view doesn't
        // depend on a later background mirror of child canvases.
        try {
            const children = await opened.getChildren({
                scopes: [opened.nearestScope],
            });
            await Promise.all(
                children.map(async (child) => {
                    try {
                        await opened.nearestScope.replies.put(child);
                    } catch {}
                })
            );
        } catch {}

        navigate(
            getCanvasPath(opened, {
                view: viewAfterNavigation,
                scopes: scopeAddrs,
            }),
            {}
        );
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
    let styleFromFromMode = isChat
        ? ""
        : "bg-neutral-50 dark:bg-neutral-800/60 shadow  rounded-lg p-2 " +
          (hideHeader ? "" : "pt-1");

    return (
        <div
            ref={forwardRef}
            onPointerDownCapture={onPointerDownCapture}
            className={`flex flex-col  ${
                isChat
                    ? align === "right"
                        ? " items-end ml-10"
                        : "items-start mr-10"
                    : ""
            } ${styleFromFromMode} ${className}`}
            data-canvas-id={toBase64URL(canvas.id)}
            data-canvas-id-string={canvas.idString}
            data-variant={variant}
            data-align={align}
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
                        className={`flex items-center mb-1 ${
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
                            showPath={!isChat}
                        />
                    </div>
                )}
                {/* Preview / Canvas Section*/}
                <div
                    ref={previewContainerRef}
                    data-feed-preview="true"
                    className={` relative overflow-y-scroll flex flex-col min-h-0 max-height-inherit-children ${
                        showMore ? "max-h-full" : "max-h-[40vh]"
                    } ${isPreviewReady ? "visible" : "invisible"}`}
                >
                    <CanvasWrapper canvas={canvas} quality={MEDIUM_QUALITY}>
                        {isExpandedBreadcrumb ? (
                            <CanvasPreview
                                forwardRef={contentRef}
                                variant="expanded-breadcrumb"
                                onClick={handleCanvasClick}
                                onLoad={ensureReadyObserved}
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
                                onLoad={ensureReadyObserved}
                            />
                        ) : showMore ? (
                            <div ref={contentRef}>
                                <Canvas
                                    bgBlur
                                    fitWidth
                                    draft={false}
                                    onLoad={ensureReadyObserved}
                                />
                            </div>
                        ) : (
                            <CanvasPreview
                                forwardRef={contentRef}
                                onClick={handleCanvasClick}
                                variant="post"
                                className="w-full "
                                onLoad={ensureReadyObserved}
                                whenEmpty={
                                    <div className="px-2">
                                        <div className="h-6 w-2/3 rounded bg-neutral-200/70 dark:bg-neutral-700/40 animate-pulse" />
                                    </div>
                                }
                            />
                        )}
                    </CanvasWrapper>
                    {/* Gradient overlay appears when collapsed and content is overflowing */}
                    {!showMore && isOverflowing && (
                        <div className="absolute bottom-0 left-0 right-0 h-[66px] pointer-events-none bg-gradient-to-t from-neutral-50 to-transparent dark:from-black dark:to-transparent" />
                    )}
                </div>

                {/* Styling corners */}
                {/* <div className="corner top-left">
                    <span className="arc"></span>
                </div> */}
                <div className="corner top-right">
                    <span className="arc"></span>
                </div>
                <div className="corner bottom-left">
                    <span className="arc"></span>
                </div>
                {/* <div className="corner bottom-right">
                    <span className="arc"></span>
                </div> */}
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
                            className="  btn btn-xs h-full font-ganja text-lg leading-3 "
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
