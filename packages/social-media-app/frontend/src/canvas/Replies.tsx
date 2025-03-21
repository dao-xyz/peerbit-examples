import { Fragment, useEffect, useRef, useState } from "react";
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

export const StickyHeader = ({ children }) => {
    const headerRef = useRef(null);
    const [isScrolled, setIsScrolled] = useState(false);

    useEffect(() => {
        let animationFrame;

        const checkPosition = () => {
            if (headerRef.current) {
                const rect = headerRef.current.getBoundingClientRect();
                // If the header is within 50px of the top of the viewport, trigger the transition.
                setIsScrolled(rect.top <= 150);
            }
            // Continue checking on the next animation frame.
            animationFrame = requestAnimationFrame(checkPosition);
        };

        // Start the loop.
        animationFrame = requestAnimationFrame(checkPosition);

        return () => {
            cancelAnimationFrame(animationFrame);
        };
    }, []);

    return (
        <div
            ref={headerRef}
            className="sticky top-14 z-10 flex flex-row items-center justify-between py-1 px-2.5 "
        >
            {/* Base layer: gradient background */}
            <div
                className="absolute inset-0 bg-[linear-gradient(rgb(211,211,211)_0%,rgb(200,200,200)_100%)]
                     dark:bg-[radial-gradient(circle,rgba(57,57,57,1)_0%,rgba(10,10,10,1)_100%)]"
            ></div>
            {/* Overlay: default background that fades in/out */}
            <div
                className={`absolute inset-0 transition-opacity duration-700 ${
                    isScrolled ? "opacity-100" : "opacity-0"
                } bg-neutral-50 dark:bg-neutral-950`}
            ></div>
            {/* Content */}
            <div className="relative z-10 flex w-full justify-center">
                {children}
            </div>
        </div>
    );
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
        <div className="flex flex-col mt-10 ">
            <StickyHeader>
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
            </StickyHeader>
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
