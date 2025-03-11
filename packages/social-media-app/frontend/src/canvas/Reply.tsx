import { useEffect, useState } from "react";
import { Canvas as CanvasDB } from "@dao-xyz/social";
import { usePeer } from "@peerbit/react";
import { CanvasPreview } from "./Preview";
import { WithContext } from "@peerbit/document";
import RelativeTimestamp from "./header/RelativeTimestamp";
import { useNavigate } from "react-router-dom";
import { getCanvasPath } from "../routes";
import { Header } from "./header/Header";

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

export const Reply = (properties: { canvas: WithContext<CanvasDB> }) => {
    const [replyCount, setReplyCount] = useState(0);
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
        <div>
            <button
                className="btn w-full flex flex-row p-0 border  border-solid max-h-[40vh] overflow-hidden"
                onClick={async () => {
                    navigate(getCanvasPath(properties.canvas), {});
                }}
            >
                <Header
                    publicKey={properties.canvas.publicKey}
                    direction="col"
                />

                <CanvasPreview canvas={properties.canvas} />
            </button>

            <div className="flex w-full mt-1">
                <span className="mr-auto text-sm underline">
                    {`Replies (${replyCount})`}
                </span>
                <RelativeTimestamp
                    timestamp={
                        new Date(
                            Number(
                                properties.canvas.__context.created /
                                    BigInt(1000000)
                            )
                        )
                    }
                    className="ml-auto text-sm"
                />
            </div>
        </div>
    );
};
