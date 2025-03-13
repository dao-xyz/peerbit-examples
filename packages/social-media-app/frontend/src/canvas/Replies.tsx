import { useEffect, useState } from "react";
import { Canvas as CanvasDB } from "@dao-xyz/social";
import { useLocal, usePeer } from "@peerbit/react";
import { Sort, SortDirection } from "@peerbit/indexer-interface";
import { SearchRequest } from "@peerbit/document-interface";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDownIcon } from "@radix-ui/react-icons";
import { Reply } from "./Reply";

type SortCriteria = "new" | "old" | "best";

export const Replies = (properties: { canvas?: CanvasDB }) => {
    const [sortCriteria, setSortCriteria] = useState<SortCriteria>("new");
    const [query, setQuery] = useState<
        { query: SearchRequest; id: string } | undefined
    >(undefined);

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
                id: sortCriteria,
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
                id: sortCriteria,
            });
        }
    }, [sortCriteria]);

    const sortedReplies = useLocal(properties.canvas?.replies, query);

    return (
        <div className="flex flex-col mt-10">
            <div className="sticky top-9 z-10 bg-neutral-50 dark:bg-neutral-950 flex flex-row items-center justify-between border-t-[1px] py-1 px-2.5">
                <span className="font-semibold">Replies:</span>
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
                <div className="flex flex-col gap-4 mt-5">
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
