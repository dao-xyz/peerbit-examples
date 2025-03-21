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

export const Reply = ({
    canvas,
    variant,
    index,
    onClick,
}: {
    canvas: WithContext<CanvasDB>;
    variant: "tiny" | "large";
    index?: number;
    onClick?: () => void;
}) => {
    const [replyCount, setReplyCount] = useState(0);
    const [showMore, setShowMore] = useState(false);
    const { peer } = usePeer();
    const navigate = useNavigate();

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
        <div className={variant === "large" ? "py-4" : ""}>
            <div
                className={`flex items-end px-1  ${
                    variant === "large" ? "mb-2.5" : "mb-1"
                }`}
            >
                <svg
                    width="16"
                    height="28"
                    viewBox="0 0 16 28"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className={
                        variant === "large" || index === 0 ? "hidden" : ""
                    }
                >
                    <path
                        d="M4 0V15.5C4 19.9211 6.5 20 9.5 20"
                        stroke="black"
                        strokeWidth="0.75"
                    />
                    <path
                        d="M8 18L9.5 20L8 22"
                        stroke="black"
                        strokeWidth="0.75"
                    />
                </svg>
                <Header
                    variant={variant}
                    canvas={canvas}
                    direction="row"
                    onClick={onClick}
                />
            </div>

            <button
                onClick={async () => {
                    navigate(getCanvasPath(canvas), {});
                    onClick && onClick();
                }}
                className="w-full flex flex-row p-0 overflow-hidden"
            >
                <CanvasWrapper canvas={canvas}>
                    {variant === "large" ? (
                        showMore ? (
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
            {variant === "large" && (
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
