import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
    Canvas,
    Canvas as CanvasDB,
    getImmediateRepliesQuery,
    getRepliesQuery,
} from "@dao-xyz/social";
import { useLocal, useOnline, usePeer } from "@peerbit/react";
import { Sort, SortDirection } from "@peerbit/indexer-interface";
import { SearchRequest } from "@peerbit/document-interface";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDownIcon } from "@radix-ui/react-icons";
import { Reply } from "./Reply";
import { useView } from "../view/View";
import { tw } from "../utils/tailwind";
import { OnlineProfilesDropdown } from "../profile/OnlinePeersButton";

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
                setIsScrolled(rect.top <= 130);
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
            <div className="absolute inset-0 bg-[#e5e5e5] border-[#ccc] dark:border-[#6e6e6e82]  border-t-[1px] border-b-[1px] dark:bg-[radial-gradient(circle,rgba(57,57,57,1)_0%,rgba(10,10,10,1)_100%)]  drop-shadow-md "></div>
            {/* Overlay: default background that fades in/out */}
            <div
                className={`absolute inset-0 transition-opacity duration-700 ${
                    isScrolled ? "opacity-100" : "opacity-0"
                } bg-neutral-50 dark:bg-neutral-950 `}
            ></div>
            {/* Content */}
            <div className="relative z-10 flex w-full justify-center">
                {children}
            </div>
        </div>
    );
};

function refIsInView(ref: React.MutableRefObject<HTMLDivElement>) {
    if (ref.current) {
        const boundingClientRect = ref.current.getBoundingClientRect();
        if (
            boundingClientRect.bottom <=
                (window.innerHeight || document.documentElement.clientHeight) &&
            boundingClientRect.top >= 0
        ) {
            return true;
        }
    }
    return false;
}

export const Replies = (props: RepliesProps) => {
    const { peer } = usePeer();
    const { canvas: canvas, sortCriteria, setSortCriteria } = props;
    const [query, setQuery] = useState<
        { query: SearchRequest; id: string } | undefined
    >(undefined);
    const { setView, view } = useView();
    const { peers } = useOnline(canvas);
    const lastReplyTopRef = useRef<HTMLDivElement>(null);

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
        canvas.load();
    }, [canvas]);

    const sortedReplies = useLocal(
        canvas?.loadedReplies ? canvas?.replies : undefined,
        query
    );

    const [freshToChatView, setFreshToChatView] = useState(false);

    // track first visit to chat view
    useEffect(() => {
        if (view === "chat") setFreshToChatView(true);
    }, [view]);

    // scroll bottom into View, but only when
    // (we are in chat view)
    //  && (
    //      I just switched to chat-view (useEffect on view)
    //      || (the new message is from me)
    //      || (the last element is partly in view or exactly at bottom with d = 0 <-> I had scrolled down before)
    // )
    useLayoutEffect(() => {
        setTimeout(() => {
            // fresh to chat view
            if (freshToChatView) {
                window.scrollTo({
                    top: document.body.scrollHeight,
                    left: 0,
                    behavior: "smooth",
                });
                setFreshToChatView(false);
            } else if (
                view === "chat" &&
                sortedReplies.length > 0 &&
                (sortedReplies[sortedReplies.length - 1].publicKey ===
                    peer.identity.publicKey || // last message is from me
                    refIsInView(lastReplyTopRef)) // the top edge of last message is in view
            )
                window.scrollTo({
                    top: document.body.scrollHeight,
                    left: 0,
                    behavior: "smooth",
                });
        }, 200);
    }, [sortedReplies, lastReplyTopRef]);

    return (
        <div className="flex flex-col mt-10 ">
            <StickyHeader>
                <div className="w-full max-w-[876px] mx-auto flex flex-row">
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
                    <div className="ml-auto">
                        <OnlineProfilesDropdown peers={peers || []} />
                    </div>
                </div>
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
                            {/* Marker before last message */}
                            {i === sortedReplies.length - 1 && (
                                <div
                                    ref={lastReplyTopRef}
                                    className="w-full h-0"
                                ></div>
                            )}
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
                    <div className="w-full h-4"></div>
                </div>
            ) : (
                <div className="flex-grow flex items-center justify-center h-40 font ganja-font">
                    No replies yet
                </div>
            )}
        </div>
    );
};
