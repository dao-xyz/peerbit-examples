import {
    Fragment,
    ReactNode,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import debounce from "lodash.debounce";
import throttle from "lodash.throttle";
import {
    Canvas,
    Canvas as CanvasDB,
    getImmediateRepliesQuery,
    getRepliesQuery,
} from "@giga-app/interface";
import { useLocal, useOnline, usePeer } from "@peerbit/react";
import { Sort, SortDirection } from "@peerbit/indexer-interface";
import { SearchRequest } from "@peerbit/document-interface";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDownIcon } from "@radix-ui/react-icons";
import { Reply } from "./Reply";
import { useView } from "../view/View";
import { tw } from "../utils/tailwind";
import { OnlineProfilesDropdown } from "../profile/OnlinePeersButton";
import { useError } from "react-use";

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

function getScrollBottomOffset(scrollPosition: number) {
    return (
        document.documentElement.scrollHeight -
        (scrollPosition + window.innerHeight)
    );
}

function getMaxScrollTop() {
    const documentHeight = Math.max(
        document.body.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.clientHeight,
        document.documentElement.scrollHeight,
        document.documentElement.offsetHeight
    );
    const windowHeight = window.innerHeight;
    return documentHeight - window.innerHeight;
}

function getScrollTop() {
    return window.scrollY || document.documentElement.scrollTop;
}

export const Replies = (props: RepliesProps) => {
    const { peer } = usePeer();
    const { canvas: canvas, sortCriteria, setSortCriteria } = props;
    const [query, setQuery] = useState<
        { query: SearchRequest; id: string } | undefined
    >(undefined);
    const { setView, view } = useView();
    const { peers } = useOnline(canvas);

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

    const resizeScrollBottomRef = useRef(getScrollBottomOffset(getScrollTop()));
    // How close in pixels does the bottom have to be to consider a user as "he scrolled all the way down"
    const bottomRegionSize = 100;
    // Scroll adjustments due to window resize events
    // On mobile the retracting scroll bar will trigger this!
    useEffect(() => {
        // Only apply this in chat view
        if (view !== "chat") return;

        // Store scroll position at leading edge
        const cycleLength = 100;
        // Create throttled resize handler
        const handleResizeThrottled = throttle(
            () => {
                const scrollTop = getScrollTop();
                const maxScrollTop = getMaxScrollTop();
                // Get the former scroll position (from leading edge)
                const scrollBottom = resizeScrollBottomRef.current;

                // Check if user was within reach of the bottom when resize started
                if (scrollBottom <= bottomRegionSize) {
                    // If they were near bottom, scroll to bottom
                    window.scrollTo({
                        top: document.documentElement.scrollHeight,
                        left: 0,
                        behavior: "instant",
                    });
                }
                // set to new scroll position
                resizeScrollBottomRef.current = getScrollBottomOffset(
                    scrollBottom <= bottomRegionSize ? maxScrollTop : scrollTop
                );
            },
            cycleLength,
            { leading: true, trailing: true }
        ); // Execute on trailing edge only

        // Setup the scroll position only on the very first execution
        const setup = debounce(
            () => {
                resizeScrollBottomRef.current = getScrollBottomOffset(
                    getScrollTop()
                );
            },
            cycleLength,
            { leading: true, trailing: false }
        );

        // The actual resize handler captures the position at leading edge
        const handleResize = () => {
            // Store the current scroll position at the beginning of resize
            setup();
            handleResizeThrottled();
        };

        // Add event listener
        window.addEventListener("resize", handleResize);

        // Clean up
        return () => {
            window.removeEventListener("resize", handleResize);
            handleResizeThrottled.cancel();
        };
    }, [view]);

    // Add document body resize scroll position ref
    const bodyResizeScrollPositionRef = useRef(getScrollTop());

    // track first visit to chat view
    useEffect(() => {
        window.scrollTo({
            top: view === "chat" ? document.body.scrollHeight : 0,
            left: 0,
            behavior: "instant",
        });
        bodyResizeScrollPositionRef.current = getMaxScrollTop();
    }, [view]);

    const oldLatestReplyRef = useRef(
        sortedReplies.length > 0 && sortedReplies[sortedReplies.length - 1]
    );
    const latestReplyRef = useRef(
        sortedReplies.length > 0 && sortedReplies[sortedReplies.length - 1]
    );

    const repliesContainerRef = useRef<HTMLDivElement>(null);

    // Update latestReplyRef and scroll position on the first sign of a change on sortedReplies
    // even before layout changes (so before body resize triggers) - thats why useLayoutEffect.
    useLayoutEffect(() => {
        if (sortedReplies.length > 0) {
            latestReplyRef.current = sortedReplies[sortedReplies.length - 1];
        }
        bodyResizeScrollPositionRef.current = getScrollTop();
    }, [sortedReplies]);

    // Scroll adjustments on the body resize (batched by debounce)
    // triggers ONLY! due to new replies inserted.
    // so this neglects pure body resize events which were not triggerd through an inserted reply.
    useEffect(() => {
        // Only apply this in chat view
        if (view !== "chat") return;

        const cycleLength = 100;
        const handleBodyResizeDebounced = debounce(
            () => {
                // Get the former scroll position (from leading edge)
                const scrollPosition = resizeScrollBottomRef.current;

                // Check if user was within reach of the bottom when body size change started
                const wasNearBottom =
                    getScrollBottomOffset(scrollPosition) <= bottomRegionSize;

                // Check if the latest reply is from the current user or if there's a new reply
                const lastReplyIsFromUser =
                    oldLatestReplyRef.current.publicKey ===
                    peer.identity.publicKey;

                const isNewReply =
                    oldLatestReplyRef.current.idString !==
                    latestReplyRef.current.idString;

                // Scroll to bottom if:
                // 1. User was near bottom when resize started OR
                // 2. The latest reply is from the current user OR
                // 3. There's a new reply
                if (isNewReply) {
                    if (wasNearBottom || lastReplyIsFromUser) {
                        window.scrollTo({
                            top: document.documentElement.scrollHeight,
                            left: 0,
                            behavior: "instant",
                        });
                    }
                }
                bodyResizeScrollPositionRef.current = getMaxScrollTop();

                // Update the latest reply reference
                oldLatestReplyRef.current = latestReplyRef.current;
            },
            cycleLength,
            { leading: false, trailing: true }
        );

        // Create a ResizeObserver for the document body
        const resizeObserver = new ResizeObserver(() => {
            handleBodyResizeDebounced();
        });

        // Only observe if the ref is available
        if (repliesContainerRef.current) {
            // Start observing the replies container
            resizeObserver.observe(repliesContainerRef.current);
        }

        // Clean up
        return () => {
            resizeObserver.disconnect();
            handleBodyResizeDebounced.cancel();
        };
    }, [view, peer.identity.publicKey]);

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
                    ref={repliesContainerRef}
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
