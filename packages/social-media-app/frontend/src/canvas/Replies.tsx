import React, { useEffect, useMemo, useState } from "react";
import { Canvas as CanvasDB, CanvasValueReference } from "@dao-xyz/social";
import { useLocal, usePeer, useProgram } from "@peerbit/react";
import { CanvasPreview } from "./Preview";
import { Sort, SortDirection } from "@peerbit/indexer-interface";
import { SearchRequest } from "@peerbit/document-interface";

// Radix UI Dropdown components
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDownIcon } from "@radix-ui/react-icons";
type SortCriteria = "new" | "old";
export const Replies = (properties: { canvas?: CanvasDB }) => {
    const [sortCriteria, setSortCriteria] = useState<SortCriteria>("new");
    const [query, setQuery] = useState<{ query: SearchRequest } | undefined>(
        undefined
    );
    useEffect(() => {
        setQuery({
            query: new SearchRequest({
                sort: new Sort({
                    key: ["__context", "created"],
                    direction:
                        sortCriteria === "new"
                            ? SortDirection.DESC
                            : SortDirection.ASC,
                }),
            }),
        });
    }, [sortCriteria]);

    const sortedReplies = useLocal(properties.canvas?.replies, query);

    return (
        <div className="flex flex-col h-full">
            {/* Toolbar with Radix dropdown */}
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
                            disabled
                            className="menu-item"
                            /*  onSelect={() => setSortCriteria("best")} */
                        >
                            Best
                        </DropdownMenu.Item>
                    </DropdownMenu.Content>
                </DropdownMenu.Root>
            </div>

            {/* Replies list in a scrollable container */}
            {sortedReplies.length > 0 ? (
                <div className="flex flex-col gap-4">
                    {sortedReplies.map((reply) => (
                        <div key={reply.id.toString()}>
                            <CanvasPreview canvas={reply} />
                            <div className="flex w-full mt-1">
                                <span className="mr-auto text-sm underline">
                                    {`Replies (0)`}
                                </span>
                            </div>
                        </div>
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
