import { useEffect, useState } from "react";
import { Canvas as CanvasDB } from "@dao-xyz/social";
import { Canvas as Canvas } from "./Canvas.js";
import { usePeer } from "@peerbit/react";
import { CanvasPreview } from "./Preview";
import { WithContext } from "@peerbit/document";
import { useNavigate } from "react-router-dom";
import { getCanvasPath } from "../routes";
import { Header } from "./header/Header";
import { CanvasWrapper } from "./CanvasWrapper";
import { LuMessageSquare } from "react-icons/lu";
import { useView, ViewType } from "../view/View";
import { tw } from "../utils/tailwind";

// Debounce helper that triggers on the leading edge and then ignores calls for the next delay ms.
function debounceLeading(func: (...args: any[]) => void, delay: number) {
    let timeoutId: ReturnType<typeof setTimeout> | null;
    return function (...args: any[]) {
        if (!timeoutId) {
            func.apply(this, args);
        }
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        timeoutId = setTimeout(() => {
            timeoutId = null;
        }, delay);
    };
}

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
            className={hidden ? "hidden" : ""}
        >
            <path
                d="M4 0V15.5C4 19.9211 6.5 20 9.5 20"
                stroke="black"
                strokeWidth="0.75"
            />
            <path d="M8 18L9.5 20L8 22" stroke="black" strokeWidth="0.75" />
        </svg>
    );
};

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
 */
export const Reply = ({
    canvas,
    index,
    onClick,
    variant = "thread",
    hideHeader = false,
}: {
    canvas: WithContext<CanvasDB>;
    variant?: ViewType | "expanded-breadcrumb";
    index?: number;
    onClick?: () => void;
    hideHeader?: boolean;
}) => {
    const [replyCount, setReplyCount] = useState(0);
    const [showMore, setShowMore] = useState(false);
    const { peer } = usePeer();
    const navigate = useNavigate();

    const align =
        canvas.publicKey === peer.identity.publicKey ? "right" : "left";

    const isExpandedBreadcrumb = variant === "expanded-breadcrumb";

    useEffect(() => {
        const listener = async () => {
            if (canvas.closed) {
                await peer.open(canvas, { existing: "reuse" });
            }
            canvas.countReplies().then(async (count) => {
                setReplyCount(Number(count));
            });
        };

        // Create a debounced version of the listener that triggers immediately and then
        // won't trigger again until 3000ms have passed.
        const debouncedListener = debounceLeading(listener, 3000);

        // Call listener immediately for the first event (leading edge)
        listener();
        canvas.replies.events.addEventListener("change", debouncedListener);
        return () => {
            canvas.replies.events.removeEventListener(
                "change",
                debouncedListener
            );
        };
    }, [canvas, canvas.closed]);

    const handleCanvasClick = () => {
        navigate(getCanvasPath(canvas), {});
        onClick && onClick();
    };

    return (
        <>
            {/* gap in between grid elements */}
            <div
                className={tw(
                    "col-span-full",
                    variant === "chat" ? "h-4" : "h-10",
                    isExpandedBreadcrumb ? "hidden" : ""
                )}
            ></div>
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
                            variant === "chat"
                                ? align === "left"
                                    ? "justify-self-start"
                                    : "justify-self-end"
                                : ""
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
                            onClick={onClick}
                            reverseLayout={
                                variant === "chat" && align === "right"
                            }
                        />
                    </div>
                )}
                <div
                    className={tw(
                        "p-0 overflow-hidden grid grid-cols-subgrid gap-y-4 col-span-full row-start-2",
                        variant === "chat"
                            ? align === "left"
                                ? "justify-items-start"
                                : "justify-items-end"
                            : ""
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
                                variant="chat-message"
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
                            className="btn btn-secondary btn-xs h-full"
                            onClick={() => {
                                setShowMore((showMore) => !showMore);
                                onClick && onClick();
                            }}
                        >
                            {showMore ? "Show less" : "Show more"}
                        </ReplyButton>
                        <ReplyButton
                            className="ml-auto btn btn-secondary btn-xs h-full"
                            onClick={handleCanvasClick}
                        >
                            {`Open ${replyCount > 0 ? `(${replyCount})` : ""}`}
                        </ReplyButton>
                    </div>
                )}
            </div>
        </>
    );
};
