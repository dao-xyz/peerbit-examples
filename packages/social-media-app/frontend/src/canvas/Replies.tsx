import { Fragment, useEffect, useState } from "react";
import {
    Canvas,
    Canvas as CanvasDB,
    getImmediateRepliesQuery,
    getRepliesQuery,
} from "@dao-xyz/social";
import { useLocal, useOnline } from "@peerbit/react";
import { Sort, SortDirection } from "@peerbit/indexer-interface";
import {
    SearchRequest,
    SearchRequestIndexed,
} from "@peerbit/document-interface";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDownIcon } from "@radix-ui/react-icons";
import { Reply } from "./Reply";
import { useView } from "../view/View";
import { tw } from "../utils/tailwind";

type SortCriteria = "new" | "old" | "best" | "chat";

interface RepliesProps {
    canvas?: CanvasDB;
    sortCriteria: SortCriteria;
    setSortCriteria: (criteria: SortCriteria) => void;
}

const getQueryId = (canvas: Canvas, sortCriteria: SortCriteria) => {
    return canvas.idString + sortCriteria;
};

export const Replies = (props: RepliesProps) => {
    const { canvas: canvas, sortCriteria, setSortCriteria } = props;
    const [query, setQuery] = useState<
        { query: SearchRequest; id: string } | undefined
    >(undefined);
    const { setView, view } = useView();

    useEffect(() => {
        if (!canvas) {
            return;
        }
        // Set the view based on sortCriteria
        if (sortCriteria === "chat") {
            setView("chat");
            setQuery({
                query: new SearchRequest({
                    query: getRepliesQuery(canvas), // fetch all replies, even children
                    sort: [
                        // sort by most replies
                        new Sort({
                            key: ["replies"],
                            direction: SortDirection.DESC,
                        }),
                        // in tie cases, sort by newest
                        new Sort({
                            key: ["__context", "created"],
                            direction: SortDirection.ASC,
                        }),
                    ],
                }),
                id: getQueryId(canvas, sortCriteria),
            });
        } else {
            setView("thread");

            if (sortCriteria === "best") {
                setQuery({
                    query: new SearchRequest({
                        query: getImmediateRepliesQuery(canvas), // fetch only immediate replies (feed)
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
                    id: getQueryId(canvas, sortCriteria),
                });
            } else {
                setQuery({
                    query: new SearchRequest({
                        query: getImmediateRepliesQuery(canvas), // fetch only immediate replies (feed)
                        sort: new Sort({
                            key: ["__context", "created"],
                            direction:
                                sortCriteria === "new"
                                    ? SortDirection.ASC
                                    : SortDirection.DESC,
                        }),
                    }),
                    id: getQueryId(canvas, sortCriteria),
                });
            }
        }
    }, [sortCriteria, setView, canvas?.idString]);

    useEffect(() => {
        if (!canvas || canvas?.closed) {
            return;
        }
        canvas.loadReplies();
    }, [canvas]);

    const sortedReplies = useLocal(
        canvas?.loadedReplies ? canvas?.replies : undefined,
        query
    );

    return (
        <div className="flex flex-col mt-10">
            <div className="sticky top-14 z-10 dark:bg-neutral-800 flex flex-row items-center justify-between border-y-[1px] bg-neutral-100 py-1 px-2.5">
                <div className="w-full max-w-[876px] mx-auto">
                    <DropdownMenu.Root>
                        <DropdownMenu.Trigger className="btn flex flex-row justify-center items-center ganja-font">
                            <span>Replies sorted by {sortCriteria}</span>
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
                                            setSortCriteria(
                                                sortCriterium as any
                                            )
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
                {/*  <OnlineProfilesDropdown peers={peers || []} /> */}
            </div>
            {sortedReplies.length > 0 ? (
                <div
                    className={tw(
                        "mt-5 max-w-[876px] w-full mx-auto grid",
                        view === "chat"
                            ? "grid-cols-[2rem_2rem_1fr_2rem_1rem]"
                            : "grid-cols-[1rem_1fr_1rem]"
                    )}
                >
                    {sortedReplies.map((reply, i) => (
                        <Fragment key={i}>
                            <div
                                className={tw(
                                    "col-span-full",
                                    view === "chat"
                                        ? "h-4"
                                        : i === 0
                                        ? "h-6"
                                        : "h-10"
                                )}
                            ></div>
                            <Reply
                                key={reply.idString}
                                canvas={reply}
                                variant={view}
                                hideHeader={
                                    view === "chat" &&
                                    sortedReplies[i - 1]?.publicKey ===
                                        reply.publicKey
                                }
                            />
                        </Fragment>
                    ))}
                </div>
            ) : (
                <div className="flex-grow flex items-center justify-center h-40 font ganja-font">
                    No replies yet
                </div>
            )}
        </div>
    );
};
