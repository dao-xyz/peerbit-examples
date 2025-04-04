import { useEffect, useState } from "react";
import { Canvas as CanvasDB } from "@giga-app/interface";
import { Canvas as Canvas } from "../Canvas.js";
import { usePeer } from "@peerbit/react";
import { CanvasPreview } from "../Preview.js";
import { WithContext } from "@peerbit/document";
import { useNavigate } from "react-router-dom";
import { getCanvasPath } from "../../routes.js";
import { Header } from "../header/Header.js";
import { CanvasWrapper } from "../CanvasWrapper.js";
import { tw } from "../../utils/tailwind.js";
import { useAutoReply } from "../AutoReplyContext.js";

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

/**
 * Arrow svg for expanded breadcrumb view.
 */
const SvgArrowExpandedBreadcrumb = ({ hidden }: { hidden?: boolean }) => {
    return (
        <svg
            width="16"
            height="28"
            viewBox="0 0 16 28"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={tw(
                hidden ? "hidden" : "",
                "stroke-black dark:stroke-white"
            )}
        >
            <path d="M4 0V15.5C4 19.9211 6.5 20 9.5 20" strokeWidth="0.75" />
            <path d="M8 18L9.5 20L8 22" strokeWidth="0.75" />
        </svg>
    );
};

// Define a base type for common props.
type BaseReplyPropsType = {
    canvas: WithContext<CanvasDB>;
    index?: number;
    onClick?: () => void;
    hideHeader?: boolean;
    lineType?: "start" | "middle" | "end" | "end-and-start" | "none";
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
}: ReplyPropsType) => {
    const [showMore, setShowMore] = useState(false);
    const { peer } = usePeer();
    const navigate = useNavigate();
    const { replyTo } = useAutoReply();

    // Determine alignment for chat messages.
    const align = canvas.publicKey.equals(peer.identity.publicKey)
        ? "right"
        : "left";

    const isExpandedBreadcrumb = variant === "expanded-breadcrumb";
    const isChat = variant === "chat";
    const isThread = variant === "thread";

    const handleCanvasClick = () => {
        console.log("Clicked on canvas", canvas.publicKey.toString());
        navigate(getCanvasPath(canvas), {});
        onClick && onClick();
    };

    return (
        <div
            className={tw(
                "col-span-full grid grid-cols-subgrid group",
                replyTo?.idString === canvas.idString
                    ? "animated-border [--inner-bg:theme('colors.neutral.50')] dark:[--inner-bg:black]"
                    : ""
            )}
        >
            {/*
        Insert a dedicated grid cell in the first column that spans from
        row 1 (header) through row 2 (preview). This cell renders the vertical
        line behind everything. Its positioning uses a negative z-index so that
        the header and preview stay in front.
      */}
            {lineType && lineType !== "none" && (
                <div className="col-start-1 row-start-1 row-end-[3] relative pointer-events-none z-[-1]">
                    <div className="absolute right-0 w-px h-full bg-neutral-300 dark:bg-neutral-600" />
                </div>
            )}

            {/* Header section */}
            {!hideHeader && (
                <div
                    className={tw(
                        "flex items-end px-1",
                        isExpandedBreadcrumb ? "mb-1" : "mb-2.5",
                        isChat
                            ? "col-start-2 col-span-3"
                            : isThread
                            ? "col-start-2 col-span-1"
                            : "col-span-full",
                        // Preserve alignment for chat messages.
                        isChat &&
                            (align === "left"
                                ? "justify-self-start"
                                : "justify-self-end")
                    )}
                >
                    <SvgArrowExpandedBreadcrumb
                        hidden={!isExpandedBreadcrumb || index === 0}
                    />
                    <Header
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

            {/* Preview / Canvas section */}
            <div
                className={tw(
                    "p-0 overflow-hidden grid grid-cols-subgrid gap-y-4 col-span-full row-start-2",
                    isChat &&
                        (align === "left"
                            ? "justify-items-start"
                            : "justify-items-end")
                )}
            >
                <CanvasWrapper canvas={canvas}>
                    {isExpandedBreadcrumb ? (
                        <CanvasPreview
                            variant="expanded-breadcrumb"
                            onClick={handleCanvasClick}
                        />
                    ) : isChat ? (
                        <CanvasPreview
                            onClick={handleCanvasClick}
                            variant={isQuote ? "quote" : "chat-message"}
                            align={align}
                        />
                    ) : showMore ? (
                        <div className="col-span-full">
                            <Canvas bgBlur fitWidth draft={false} />
                        </div>
                    ) : (
                        <CanvasPreview
                            onClick={handleCanvasClick}
                            variant="post"
                        />
                    )}
                </CanvasWrapper>
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
