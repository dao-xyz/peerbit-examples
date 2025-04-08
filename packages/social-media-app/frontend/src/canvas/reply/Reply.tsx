import { useState } from "react";
import { Canvas as CanvasDB, MEDIUM_QUALITY } from "@giga-app/interface";
import { Canvas } from "../Canvas.js";
import { usePeer } from "@peerbit/react";
import { CanvasPreview } from "../Preview.js";
import { WithContext } from "@peerbit/document";
import { useNavigate } from "react-router-dom";
import { getCanvasPath } from "../../routes.js";
import { Header } from "../header/Header.js";
import { CanvasWrapper } from "../CanvasWrapper.js";
import { tw } from "../../utils/tailwind.js";
import { useAutoReply } from "../AutoReplyContext.js";
import { useView, ViewType } from "../../view/ViewContex.js";

const ReplyButton = ({
    children,
    ...rest
}: React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>) => {
    return (
        <button
            className="border border-black rounded-md px-1.5 py-1 bg-white dark:border-white dark:bg-black"
            {...rest}
        >
            {children}
        </button>
    );
};

/* const SvgArrowExpandedBreadcrumb = ({ hidden }: { hidden?: boolean }) => {
    return (
        <svg
            width="16"
            height="28"
            viewBox="0 0 16 28"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={tw(hidden ? "hidden" : "", "stroke-black dark:stroke-white")}
        >
            <path d="M4 0V15.5C4 19.9211 6.5 20 9.5 20" strokeWidth="0.75" />
            <path d="M8 18L9.5 20L8 22" strokeWidth="0.75" />
        </svg>
    );
}; */

type BaseReplyPropsType = {
    canvas: WithContext<CanvasDB>;
    index?: number;
    onClick?: () => void;
    hideHeader?: boolean;
    lineType?: "start" | "middle" | "end" | "end-and-start" | "none";
    forwardedRef?: React.Ref<HTMLDivElement>;
    isHighlighted?: boolean;
    className?: string;
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
    lineType,
    isQuote,
    forwardedRef,
    isHighlighted,
    className,
}: ReplyPropsType) => {
    const [showMore, setShowMore] = useState(false);
    const { peer } = usePeer();
    const navigate = useNavigate();
    const { view } = useView();

    // Determine alignment for chat messages.
    const align = canvas.publicKey.equals(peer.identity.publicKey)
        ? "right"
        : "left";

    const isExpandedBreadcrumb = variant === "expanded-breadcrumb";
    const isChat = variant === "chat";
    const isThread = variant === "thread";

    const handleCanvasClick = () => {
        console.log(
            "Clicked on canvas",
            canvas.publicKey.toString(),
            "view",
            view
        );
        navigate(getCanvasPath(canvas, view), {}); // navigate with the same view
        onClick && onClick();
    };

    const highlightStyle = isHighlighted
        ? "animated-border  border-3 p-0 [--inner-bg:theme('colors.neutral.50')] dark:[--inner-bg:black]"
        : "";

    // Determine grid classes for the content container based on the variant.
    let flexAlign = "";
    if (isChat) {
        // For chat, also adjust alignment: right for your posts, left for others.
        flexAlign = align === "right" ? "items-end" : "items-start";
    }

    return (
        // Outer wrapper: remains a grid item so that replies align in a column.
        <div className={"flex flex-col " + flexAlign + " " + className}>
            {/* Optional vertical line in the background */}
            {lineType && lineType !== "none" && (
                <div className="absolute left-0 top-0 bottom-0 pointer-events-none z-[-1]">
                    <div className="w-px h-full bg-neutral-300 dark:bg-neutral-600" />
                </div>
            )}
            {/* Inline-flex container that shrink-wraps the visible content */}
            <div
                className={`inline-flex flex-col  border-transparent hover:border-black dark:hover:border-white rounded-md p-2  ${highlightStyle}  ${
                    isThread ? "w-full" : ""
                }`}
            >
                {/* Header Section */}
                {!hideHeader && (
                    <div
                        className={
                            "flex items-center mb-2 " + align === "right"
                                ? "justify-end"
                                : "justify-start"
                        }
                    >
                        {/*  {isExpandedBreadcrumb && index !== 0 && (
                                <SvgArrowExpandedBreadcrumb hidden={false} />
                            )} */}
                        <Header
                            /*   className={"bg-neutral-50 dark:bg-neutral-950 "} */
                            variant={
                                isChat
                                    ? "medium"
                                    : isExpandedBreadcrumb
                                    ? "tiny"
                                    : "large"
                            }
                            canvas={canvas}
                            direction="row"
                            open={handleCanvasClick}
                            reverseLayout={isChat && align === "right"}
                        />
                    </div>
                )}
                {/* Preview / Canvas Section */}
                <div /* className="overflow-hidden" */>
                    <CanvasWrapper canvas={canvas} quality={MEDIUM_QUALITY}>
                        {isExpandedBreadcrumb ? (
                            <CanvasPreview
                                forwardRef={forwardedRef}
                                variant="expanded-breadcrumb"
                                onClick={handleCanvasClick}
                            />
                        ) : isChat ? (
                            <CanvasPreview
                                forwardRef={forwardedRef}
                                onClick={handleCanvasClick}
                                variant={isQuote ? "quote" : "chat-message"}
                                align={align}
                                className={
                                    "flex flex-col gap-2" +
                                    (align === "right"
                                        ? "flex flex-col justify-end items-end"
                                        : "")
                                }
                            />
                        ) : showMore ? (
                            <div ref={forwardedRef}>
                                <Canvas bgBlur fitWidth draft={false} />
                            </div>
                        ) : (
                            <CanvasPreview
                                forwardRef={forwardedRef}
                                onClick={handleCanvasClick}
                                variant="post"
                                className="w-full"
                            />
                        )}
                    </CanvasWrapper>
                </div>
            </div>
            {/* Reply button for thread variant */}
            {isThread && !isExpandedBreadcrumb && (
                <div className="col-start-2 col-span-1 flex gap-2.5 mt-4">
                    <ReplyButton
                        className="ml-auto btn btn-xs h-full ganja-font text-lg leading-3"
                        onClick={() => {
                            setShowMore((prev) => !prev);
                            onClick && onClick();
                        }}
                    >
                        {showMore ? "Show less" : "Show more"}
                    </ReplyButton>
                </div>
            )}
        </div>
    );
};
