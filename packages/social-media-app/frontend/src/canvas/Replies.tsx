import { useEffect, useState } from "react";
import { Canvas as CanvasDB } from "@dao-xyz/social";
import { useLocal, usePeer } from "@peerbit/react";
import { CanvasPreview } from "./Preview";
import { Sort, SortDirection } from "@peerbit/indexer-interface";
import { SearchRequest } from "@peerbit/document-interface";
import { WithContext } from "@peerbit/document";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDownIcon } from "@radix-ui/react-icons";
import RelativeTimestamp from "./header/RelativeTimestamp";

type SortCriteria = "new" | "old" | "best";

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

const Reply = (properties: { canvas: WithContext<CanvasDB> }) => {
    const [replyCount, setReplyCount] = useState(0);
    const { peer } = usePeer();

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
            <CanvasPreview canvas={properties.canvas} />
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

export const Replies = (properties: { canvas?: CanvasDB }) => {
    const [sortCriteria, setSortCriteria] = useState<SortCriteria>("new");
    const [query, setQuery] = useState<{ query: SearchRequest } | undefined>(
        undefined
    );

    useEffect(() => {
        if (sortCriteria === "best") {
            setQuery({
                query: new SearchRequest({
                    sort: [
                        // sort by most replies
                        new Sort({
                            key: ["replies"],
                            direction: SortDirection.DESC,
                        }),
                        // in tie cases, sort by newest
                        new Sort({
                            key: ["__context", "created"],
                            direction: SortDirection.DESC,
                        }),
                    ],
                }),
            });
        } else {
            setQuery({
                query: new SearchRequest({
                    sort: new Sort({
                        key: ["__context", "created"],
                        direction:
                            sortCriteria === "new"
                                ? SortDirection.ASC
                                : SortDirection.DESC,
                    }),
                }),
            });
        }
    }, [sortCriteria]);

    const sortedReplies = useLocal(properties.canvas?.replies, query);

    return (
        <div className="flex flex-col h-full">
            <div className="flex flex-row items-center gap-4 mb-4">
                <DropdownMenu.Root>
                    <DropdownMenu.Trigger className="btn flex flex-row justify-center items-center">
                        <span>Sort by: {sortCriteria}</span>
                        <ChevronDownIcon className="ml-2" />
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content
                        sideOffset={5}
                        style={{
                            padding: "0.5rem",
                            minWidth: "150px",
                        }}
                        className="bg-neutral-50 dark:bg-neutral-950 rounded-md shadow-lg"
                    >
                        <DropdownMenu.Item
                            className="menu-item"
                            onSelect={() => setSortCriteria("new")}
                        >
                            New
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                            className="menu-item"
                            onSelect={() => setSortCriteria("old")}
                        >
                            Old
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                            className="menu-item"
                            onSelect={() => setSortCriteria("best")}
                        >
                            Best
                        </DropdownMenu.Item>
                    </DropdownMenu.Content>
                </DropdownMenu.Root>
            </div>

            {sortedReplies.length > 0 ? (
                <div className="flex flex-col gap-4">
                    {sortedReplies.map((reply) => (
                        <Reply key={reply.idString} canvas={reply} />
                    ))}
                </div>
            ) : (
                <div className="flex-grow flex items-center justify-center">
                    No replies yet
                </div>
            )}
        </div>
    );
};
