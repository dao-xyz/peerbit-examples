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
import { ViewType } from "../../view/View.js";
import { tw } from "../../utils/tailwind.js";

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
 * @param props - Component props
 * @param props.hidden - Whether the arrow should be hidden
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

// Define a base type for common props
type BaseReplyPropsType = {
    canvas: WithContext<CanvasDB>;
    index?: number;
    onClick?: () => void;
    hideHeader?: boolean;
    lineType?: "start" | "end" | "end-and-start" | "none" | "middle";
};

// Define specific types for different variants
type ThreadReplyPropsType = BaseReplyPropsType & {
    variant?: Exclude<ViewType, "chat"> | "expanded-breadcrumb";
    isQuote?: undefined;
};

type ChatReplyPropsType = BaseReplyPropsType & {
    variant: "chat";
    isQuote?: boolean;
};

// Union type for all possible prop combinations
type ReplyPropsType = BaseReplyPropsType & {
    variant?: ViewType | "expanded-breadcrumb";
    isQuote?: boolean;
};
//ThreadReplyPropsType | ChatReplyPropsType;

/**
 * Reply component for displaying a Canvas reply.
 * @param props - Component props
 * @param props.canvas - The canvas data object to display
 * @param props.variant - type for displaying the reply
 *   - "chat": Optimized for chat-like display
 *   - "thread": Standard threaded variant
 *   - "expanded-breadcrumb": Compact display for breadcrumbs or nested variant
 * @param props.index - Optional index of the reply in a list
 * @param props.onClick - Optional click handler for the reply
 * @param props.hideHeader - Whether to hide the header section
 * @param props.lineType - Only available on variant = "thread". Which lines to draw for relationships between messages.
 */
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

    const align =
        canvas.publicKey === peer.identity.publicKey ? "right" : "left";

    const isExpandedBreadcrumb = variant === "expanded-breadcrumb";

    const handleCanvasClick = () => {
        console.log("Clicked on canvas", canvas.publicKey.toString());
        navigate(getCanvasPath(canvas), {});
        onClick && onClick();
    };

    return (
        <>
            {/* gap in between grid elements */}
            <div className={tw("col-span-full grid grid-cols-subgrid group")}>
                {!hideHeader && (
                    <div
                        className={tw(
                            "flex items-end px-1",
                            isExpandedBreadcrumb ? "mb-1" : "mb-2.5",
                            variant === "chat"
                                ? "col-start-2 col-span-3"
                                : variant === "thread"
                                ? "col-start-2 col-span-1"
                                : "col-span-full",
                            variant === "chat" &&
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
                                variant === "chat"
                                    ? "medium"
                                    : isExpandedBreadcrumb
                                    ? "tiny"
                                    : "large"
                            }
                            canvas={canvas}
                            direction="row"
                            open={handleCanvasClick}
                            reverseLayout={
                                variant === "chat" && align === "right"
                            }
                        />
                    </div>
                )}
                {!hideHeader && variant === "chat" && (
                    <div className={tw("col-span-1 row-start-1 relative")}>
                        {(lineType === "middle" || lineType === "end") && (
                            <div className="absolute right-0 w-4 h-full border-l-4 dark:border-neutral-600 border-neutral-300"></div>
                        )}
                    </div>
                )}
                <div
                    className={tw(
                        "col-span-1 col-start-1 row-start-2 row-span-1 relative"
                    )}
                >
                    {lineType === "middle" && (
                        <div className="absolute right-0 w-4 h-full border-l-4 dark:border-neutral-600 border-neutral-300"></div>
                    )}
                    {lineType === "end" && (
                        <div className="absolute right-0 w-4 h-4 border-l-4 border-b-4 rounded-bl-full dark:border-neutral-600 border-neutral-300"></div>
                    )}
                    {lineType === "start" && (
                        <div className="absolute right-0 bottom-0 w-4 h-4 border-l-4 border-t-4 rounded-tl-full dark:border-neutral-600 border-neutral-300"></div>
                    )}
                </div>
                <div
                    className={tw(
                        "p-0 overflow-hidden grid grid-cols-subgrid gap-y-4 col-span-full row-start-2",
                        variant === "chat" &&
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
                        ) : variant === "chat" ? (
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
                {/* Gap between header and reply content */}
                {variant === "thread" && !isExpandedBreadcrumb && (
                    <div className={"col-start-2 col-span-1 flex gap-2.5 mt-4"}>
                        <ReplyButton
                            className="ml-auto btn btn-xs h-full ganja-font text-lg leading-3  "
                            onClick={() => {
                                setShowMore((showMore) => !showMore);
                                onClick && onClick();
                            }}
                        >
                            {showMore ? "Show less" : "Show more"}
                        </ReplyButton>
                        {/*   <ReplyButton
                            className="ml-auto btn btn-xs h-full"
                            onClick={handleCanvasClick}
                        >
                            {`Open ${replyCount > 0 ? `(${replyCount})` : ""}`}
                        </ReplyButton> */}
                    </div>
                )}
            </div>
        </>
    );
};
