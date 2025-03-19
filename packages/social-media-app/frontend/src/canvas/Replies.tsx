import { useEffect, useState } from "react";
import { Canvas as CanvasDB } from "@dao-xyz/social";
import { useLocal } from "@peerbit/react";
import { Sort, SortDirection } from "@peerbit/indexer-interface";
import { SearchRequest } from "@peerbit/document-interface";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDownIcon } from "@radix-ui/react-icons";
import { Reply } from "./Reply";
import { useView } from "../view/View";

type SortCriteria = "new" | "old" | "best" | "chat";

interface RepliesProps {
    canvas?: CanvasDB;
    sortCriteria: SortCriteria;
    setSortCriteria: (criteria: SortCriteria) => void;
}

export const Replies = (props: RepliesProps) => {
    const { canvas, sortCriteria, setSortCriteria } = props;
    const [query, setQuery] = useState<
        { query: SearchRequest; id: string } | undefined
    >(undefined);
    const { setView, view } = useView();

    useEffect(() => {
        // Set the view based on sortCriteria
        if (sortCriteria === "chat") {
            setView("chat");
        } else {
            setView("thread");
        }

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
    }, [sortCriteria, setView]);

    const sortedReplies = useLocal(canvas?.replies, query);

    return (
        <div className="flex flex-col mt-10">
            <div className="sticky top-0 z-10 bg-neutral-50 dark:bg-neutral-950 flex flex-row items-center justify-between border-t-[1px] py-1 px-2.5">
                <span className="ganja-font">Replies</span>
                <DropdownMenu.Root>
                    <DropdownMenu.Trigger className="btn flex flex-row justify-center items-center ganja-font">
                        <span>Sort by {sortCriteria}</span>
                        <ChevronDownIcon className="ml-2" />
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content
                        sideOffset={5}
                        style={{ padding: "0.5rem", minWidth: "150px" }}
                        className="bg-neutral-50 dark:bg-neutral-950 rounded-md shadow-lg"
                    >
                        {["new", "old", "best", "chat"].map(
                            (sortCriterium, index) => (
                                <DropdownMenu.Item
                                    key={index}
                                    className="menu-item"
                                    onSelect={() =>
                                        setSortCriteria(sortCriterium as any)
                                    }
                                >
                                    {sortCriterium.charAt(0).toUpperCase() +
                                        sortCriterium.slice(1)}
                                </DropdownMenu.Item>
                            )
                        )}
                    </DropdownMenu.Content>
                </DropdownMenu.Root>
            </div>
            {sortedReplies.length > 0 ? (
                <div className="flex flex-col gap-4 mt-5">
                    {sortedReplies.map((reply) => (
                        <Reply
                            key={reply.idString}
                            canvas={reply}
                            variant="large"
                            view={view}
                        />
                    ))}
                </div>
            ) : (
                <div className="flex-grow flex items-center justify-center font ganja-font">
                    No replies yet
                </div>
            )}
        </div>
    );
};
