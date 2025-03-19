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
 * @param props.variant - Display size variant
 *   - "tiny": Compact display for breadcrumbs or nested view
 *   - "large": Full-sized display with more controls, e.g. used in post in threaded view
 * @param props.view - Optional view type (defaults to "threaded" if not supplied)
 *   - "chat": Optimized for chat-like display
 *   - "threaded": Standard threaded view
 * @param props.index - Optional index of the reply in a list
 * @param props.onClick - Optional click handler for the reply
 */
export const Reply = ({
    canvas,
    variant,
    index,
    onClick,
    view,
}: {
    canvas: WithContext<CanvasDB>;
    variant: "tiny" | "large";
    view?: ViewType;
    index?: number;
    onClick?: () => void;
}) => {
    const [replyCount, setReplyCount] = useState(0);
    const [showMore, setShowMore] = useState(false);
    const { peer } = usePeer();
    const navigate = useNavigate();

    const align =
        canvas.publicKey === peer.identity.publicKey ? "right" : "left";

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

    return (
        <div
            className={`flex flex-col ${
                view === "chat" ? "max-w-prose w-[calc(100%-2rem)]" : ""
            } ${
                view === "chat"
                    ? align === "left"
                        ? "mr-auto"
                        : "ml-auto items-end"
                    : ""
            } ${variant === "large" ? "py-4" : ""}`}
        >
            <div
                className={`flex items-end px-1  ${
                    variant === "large" ? "mb-2.5" : "mb-1"
                }`}
            >
                <SvgArrowExpandedBreadcrumb
                    hidden={variant === "large" || index === 0}
                />
                <Header
                    variant={view === "chat" ? "medium" : variant}
                    canvas={canvas}
                    direction="row"
                    onClick={onClick}
                    reverseLayout={view === "chat" && align === "right"}
                />
            </div>

            <button
                onClick={async () => {
                    navigate(getCanvasPath(canvas), {});
                    onClick && onClick();
                }}
                className={`flex flex-row p-0 overflow-hidden ${
                    view === "chat" ? "border rounded-md w-fit" : "w-full"
                }`}
            >
                <CanvasWrapper canvas={canvas}>
                    {variant === "large" ? (
                        /* chat view */
                        view === "chat" ? (
                            showMore ? (
                                <Canvas bgBlur fitWidth draft={false} />
                            ) : (
                                <CanvasPreview
                                    onClick={onClick}
                                    variant="chat-message"
                                />
                            )
                        ) : /* thread view */ showMore ? (
                            <Canvas bgBlur fitWidth draft={false} />
                        ) : (
                            <CanvasPreview onClick={onClick} variant="post" />
                        )
                    ) : (
                        <CanvasPreview
                            variant="expanded-breadcrumb"
                            onClick={onClick}
                        />
                    )}
                </CanvasWrapper>
            </button>
            {view === "thread" && variant === "large" && (
                <div className="flex gap-2.5 mt-4 mx-2">
                    <ReplyButton
                        className="btn btn-secondary btn-xs  h-full "
                        onClick={() => {
                            setShowMore((showMore) => !showMore);
                            onClick && onClick();
                        }}
                    >
                        {showMore ? "Show less" : "Show more"}
                    </ReplyButton>
                    <ReplyButton
                        className="ml-auto btn btn-secondary  btn-xs h-full"
                        onClick={async () => {
                            navigate(getCanvasPath(canvas), {});
                            onClick && onClick();
                        }}
                    >{`Open ${
                        replyCount > 0 ? `(${replyCount})` : ""
                    }`}</ReplyButton>
                </div>
            )}
        </div>
    );
};
