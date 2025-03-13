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

export const Reply = (properties: { canvas: WithContext<CanvasDB> }) => {
    const [replyCount, setReplyCount] = useState(0);
    const [showMore, setShowMore] = useState(false);
    const { peer } = usePeer();
    const navigate = useNavigate();

    useEffect(() => {
        const listener = async () => {
            if (properties.canvas.closed) {
                await peer.open(properties.canvas, { existing: "reuse" });
            }
            properties.canvas.countReplies().then(async (count) => {
                setReplyCount(Number(count));
            });
        };

        // Create a debounced version of the listener that triggers immediately and then
        // won't trigger again until 3000ms have passed.
        const debouncedListener = debounceLeading(listener, 3000);

        // Call listener immediately for the first event (leading edge)
        listener();
        properties.canvas.replies.events.addEventListener(
            "change",
            debouncedListener
        );
        return () => {
            properties.canvas.replies.events.removeEventListener(
                "change",
                debouncedListener
            );
        };
    }, [properties.canvas, properties.canvas.closed]);

    return (
        <div className="py-4">
            <div className="px-2.5 mb-2.5">
                <Header canvas={properties.canvas} direction="row" />
            </div>

            <button
                onClick={async () => {
                    navigate(getCanvasPath(properties.canvas), {});
                }}
                className="w-full flex flex-row p-0 overflow-hidden"
            >
                <CanvasWrapper canvas={properties.canvas}>
                    {showMore ? (
                        <Canvas draft={false} />
                    ) : (
                        <CanvasPreview variant="post" />
                    )}
                </CanvasWrapper>
            </button>
            <div className="flex gap-2.5 px-2.5 mt-4">
                <ReplyButton
                    onClick={() => setShowMore((showMore) => !showMore)}
                >
                    {showMore ? "Show less" : "Show more"}
                </ReplyButton>
                <ReplyButton
                    onClick={async () =>
                        navigate(getCanvasPath(properties.canvas), {})
                    }
                >{`Open | Reply (${replyCount})`}</ReplyButton>
            </div>
        </div>
    );
};
