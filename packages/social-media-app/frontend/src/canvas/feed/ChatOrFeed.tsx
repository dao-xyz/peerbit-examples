import { useRef, useState, useEffect, useMemo } from "react";
import { InlineEditor } from "../edit/InlineEditor";
import { ReplyingInProgress } from "./ReplyingInProgress";
import { CloseableAppPane } from "../edit/CloseableAppPane";
import { DetailedView } from "../render/preview/DetailedPreview";
import { BottomControls, SubHeader } from "./StreamControls";
import { AnimatedStickyToolbar } from "../edit/AnimatedStickyToolbar";
import { CanvasEditorProvider } from "../edit/CanvasEditorProvider"; // wraps Toolbar UI + delegates to CanvasEditorSessionProvider
import { ScrollSettings } from "../main/useAutoScroll";
import { getSnapshot } from "./feedRestoration";
import { useLocation } from "react-router";
import { Feed } from "./Feed";
import { ToolbarCreateNew } from "../edit/ToolbarCreateNew";
import { useHeaderVisibilityContext } from "../../HeaderVisibilitiyProvider";
import { useStream } from "./StreamContext";
import { useOnScrollToTop, useFocusProvider } from "../../FocusProvider";
import { CreatePostTitle } from "../edit/CreatePostTitle";
import { ToolbarInline } from "../edit/ToolbarInline";
import { BasicVisualization, ChildVisualization } from "@giga-app/interface";
import { useVisualizationContext } from "../custom/CustomizationProvider";
import { useCanvases } from "../useCanvas";
import { useDrafts } from "../draft/useDrafts";
import { TopEditBar } from "../edit/TopEditBar";
import { EditModeProvider } from "../edit/EditModeProvider";
import { DraftsRow } from "../draft/DraftsRow";
import { WaitingForFeed } from "./WaitingForFeed";
import { useActiveDraftIds } from "../draft/useActiveDraftIds";

const EXTRA_PADDING_BOTTOM = 15;
const SNAP_TO_REPLIES_EXTRA_SCROLL_HEIGHT = 15;

const shouldFocusRepliesByDefault = (visualization?: BasicVisualization) => {
    if (!visualization) return true;
    return visualization.view !== ChildVisualization.CHAT;
};

const getSnapToRepliesViewThreshold = (offset: number) =>
    offset + window.innerHeight / 3;

export const CanvasAndReplies = () => {
    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const [collapsed, setCollapsed] = useState(false);

    const { loading, feedRoot, lastReply } = useStream();
    const { viewRoot } = useCanvases();

    const lastScrollTopRef = useRef(-1);
    const lastHeightTopRef = useRef(-1);
    const repliesScrollRef = useRef<HTMLDivElement>(null);

    const postRef = useRef<HTMLDivElement>(null);
    const [spacerHeight, setSpacerHeight] = useState(0);
    const scrollToSnapEnabled = useRef(true);
    const [showInlineEditor, setShowInlineEditor] = useState(false);
    const [navType, setNavType] = useState<"tabs" | "rows">("tabs");

    const { pathname, key } = useLocation();

    useEffect(() => {
        setShowInlineEditor(false);
    }, [pathname]);

    useEffect(() => {
        if (!postRef.current || !repliesScrollRef.current) return;
        const checkHeight = () => {
            if (!repliesScrollRef.current) return;
            const repliesRect = repliesScrollRef.current.getBoundingClientRect();
            const snap = getSnapToRepliesViewThreshold(0);
            if (repliesRect.top < snap) {
                setSpacerHeight(SNAP_TO_REPLIES_EXTRA_SCROLL_HEIGHT);
                return;
            }
            const diffToBottom = repliesRect.top - snap;
            setSpacerHeight(diffToBottom + SNAP_TO_REPLIES_EXTRA_SCROLL_HEIGHT);
        };
        checkHeight();
        const obs = new ResizeObserver(checkHeight);
        obs.observe(postRef.current);
        return () => obs.disconnect();
    }, [postRef.current, repliesScrollRef.current]);


    /* 

     useEffect(() => {
        const postEl = postRef.current;
        const repliesEl = repliesScrollRef.current;
        if (!postEl || !repliesEl) return;

        let rafId = 0;

        const measureAndUpdate = () => {
            // READS — safe inside rAF
            const repliesRect = repliesEl.getBoundingClientRect();
            const snap = getSnapToRepliesViewThreshold(0);

            let next: number;
            if (repliesRect.top < snap) {
                next = SNAP_TO_REPLIES_EXTRA_SCROLL_HEIGHT;
            } else {
                const diffToBottom = repliesRect.top - snap;
                next = diffToBottom + SNAP_TO_REPLIES_EXTRA_SCROLL_HEIGHT;
            }

            // WRITE (state) — only if changed to avoid loops
            setSpacerHeight(prev => (prev !== next ? next : prev));
        };

        const scheduleMeasure = () => {
            if (rafId) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(measureAndUpdate);
        };

        // initial run (deferred to a frame for consistency)
        scheduleMeasure();

        const ro = new ResizeObserver(() => {
            // coalesce multiple resize notifications into one rAF
            scheduleMeasure();
        });

        // Observe the post block (border-box cuts down noisy notifications)
        try {
            // @ts-ignore older TS lib might not know about this option
            ro.observe(postEl, { box: "border-box" });
        } catch {
            ro.observe(postEl);
        }

        // Also react to viewport size changes (affects snap threshold)
        window.addEventListener("resize", scheduleMeasure);

        return () => {
            if (rafId) cancelAnimationFrame(rafId);
            ro.disconnect();
            window.removeEventListener("resize", scheduleMeasure);
        };
        // Only rebind if the actual elements change:
    }, [postRef.current, repliesScrollRef.current]);
    */

    const visualization = useVisualizationContext().visualization;

    useOnScrollToTop(() => {
        scrollToSnapEnabled.current = false;
        lastScrollTopRef.current = -1;
        setRepliesFocused(shouldFocusRepliesByDefault(visualization));
        setTimeout(() => (scrollToSnapEnabled.current = true), 100);
    });

    const hasSnap = !!getSnapshot(key);
    const { focused: repliesFocused, setFocused: _setRepliesFocused } =
        useFocusProvider();

    useEffect(() => {
        _setRepliesFocused(hasSnap || shouldFocusRepliesByDefault(visualization));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const { setDisabled: setToolbarVisibilityDisabled } = useHeaderVisibilityContext();
    const collapsable = useMemo(
        () => !shouldFocusRepliesByDefault(visualization),
        [visualization]
    );

    const hidePost = useMemo(
        () =>
            repliesFocused &&
            collapsable &&
            visualization?.view === ChildVisualization.CHAT,
        [repliesFocused, collapsable, visualization]
    );

    useEffect(() => {
        setToolbarVisibilityDisabled(!!hidePost);
    }, [hidePost, setToolbarVisibilityDisabled]);

    const [scrollSettings, setScrollSettings] = useState<ScrollSettings>(
        undefined
    );

    const setRepliesFocused = (focused: boolean) => {
        _setRepliesFocused(focused);
        setScrollSettings((prev) => ({
            ...prev,
            scrollDirection:
                visualization?.view === ChildVisualization.CHAT ? "down" : "up",
            scrollUsingWindow: focused,
        }));
    };

    useEffect(() => {
        setRepliesFocused(shouldFocusRepliesByDefault(visualization));
        setScrollSettings((prev) => ({
            ...prev,
            scrollDirection:
                visualization?.view === ChildVisualization.CHAT ? "down" : "up",
            scrollUsingWindow: shouldFocusRepliesByDefault(visualization),
        }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visualization]);

    useEffect(() => {
        lastScrollTopRef.current = -1;
        setCollapsed(false);
    }, [feedRoot?.idString]);

    useEffect(() => {
        if (!repliesScrollRef.current || !postRef.current || repliesFocused) return;

        const handleScroll = () => {
            if (!scrollToSnapEnabled.current) return;
            const el = repliesScrollRef.current;
            if (!el) return;

            const rect = el.getBoundingClientRect();
            let lastTop = lastScrollTopRef.current;
            let down = false;

            if (lastTop > 0) {
                if (lastTop > rect.top && lastHeightTopRef.current >= rect.height) {
                    down = true;
                } else if (lastTop < rect.top) {
                    down = false;
                }
            }
            lastScrollTopRef.current = rect.top;

            if (rect.top < getSnapToRepliesViewThreshold(0) && down) {
                setRepliesFocused(true);
            }
            lastHeightTopRef.current = rect.height;
        };

        window.addEventListener("scroll", handleScroll);
        return () => window.removeEventListener("scroll", handleScroll);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [repliesScrollRef.current, postRef.current, repliesFocused]);

    // draft recovery row (unchanged)
    const { drafts } = useDrafts();
    const activeIds = useActiveDraftIds();

    const draftsFiltered = useMemo(() => {
        // if your draft objects are WithIndexedContext<Canvas,...>, they have 
        return drafts.filter(d => !activeIds.has(d.idString));
    }, [drafts, activeIds]);


    if (!viewRoot) {
        return <WaitingForFeed loading={loading} />;
    }

    const isChat = visualization?.view === ChildVisualization.CHAT;

    return (
        <>
            {/* OUTER provider: edit the viewRoot itself */}
            <CanvasEditorProvider canvas={viewRoot}>
                <div className="flex flex-row justify-center">
                    <TopEditBar className="max-w-[876px]" />
                </div>

                <div
                    ref={scrollContainerRef}
                    className={`${repliesFocused ? "h-fit" : "h-full"
                        } flex flex-col relative grow shrink-0`}
                    style={{
                        paddingBottom: !showInlineEditor
                            ? `calc(var(--toolbar-h, 0px) + ${EXTRA_PADDING_BOTTOM}px)`
                            : "2rem",
                        height: repliesFocused
                            ? "fit-content"
                            : `calc(100vh - var(--toolbar-h, 0px) + ${spacerHeight +
                            EXTRA_PADDING_BOTTOM +
                            SNAP_TO_REPLIES_EXTRA_SCROLL_HEIGHT
                            }px)`,
                    }}
                >
                    {!hidePost && (
                        <div
                            ref={postRef}
                            className={`transition-all duration-300 ${collapsed ? "blur-3xl opacity-0" : "blur-0 opacity-100"
                                }`}
                        >
                            <div className="z-5 flex-shrink-0">
                                <div className="max-w-[876px] mx-auto w-full bg-neutral-50 dark:bg-neutral-900 shadow-md">
                                    {!viewRoot || viewRoot?.__indexed.path.length === 0 ? (
                                        <></>
                                    ) : (
                                        <DetailedView />
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {!isChat && (
                        <SubHeader
                            collapsable={collapsable}
                            onCollapse={setCollapsed}
                            onViewChange={() => setRepliesFocused(true)}
                            onNavTypeChange={(res) => setNavType(res)}
                        />
                    )}

                    {navType !== "rows" && (
                        <div className="relative flex-1 h-full">
                            <div
                                className={`${!repliesFocused ? "absolute inset-0 w-full cursor-pointer" : "relative"
                                    }`}
                            >
                                <div
                                    id="replies-container"
                                    className={`box flex flex-col items-center  ${!repliesFocused ? "absolute inset-0 overflow-y-auto hide-scrollbar" : ""
                                        }`}
                                    ref={repliesScrollRef}
                                >
                                    <div className="flex flex-col w-full gap-2 max-w-[876px] items-center ">

                                        {/* INNER provider: single shared draft for all composers */}
                                        <CanvasEditorProvider
                                            replyTo={feedRoot}
                                            autoSave
                                            autoReply={isChat}
                                            debug
                                        >
                                            {/* Top composer (non-chat) */}
                                            {feedRoot && !isChat && !showInlineEditor && (
                                                <div className="px-2 pt-2 w-full">
                                                    {draftsFiltered.length > 0 && (
                                                        <div className="flex flex-col w-full ">
                                                            <DraftsRow drafts={draftsFiltered} />
                                                            <hr className="my-4 text-neutral-300 dark:text-neutral-700" />
                                                        </div>
                                                    )}
                                                    <div className="w-full">
                                                        <EditModeProvider editable>
                                                            <ToolbarCreateNew
                                                                showProfile
                                                                className="rounded-lg bg-neutral-50 dark:bg-neutral-800/60"
                                                                parent={feedRoot}
                                                                inlineEditorActive={showInlineEditor}
                                                                setInlineEditorActive={setShowInlineEditor}
                                                            />
                                                        </EditModeProvider>
                                                        <CloseableAppPane className="rounded-xl mt-2" />
                                                    </div>
                                                </div>
                                            )}

                                            {/* Expanded inline editor */}
                                            {showInlineEditor && (
                                                <div className="w-full">
                                                    <div className="m-2 bg-neutral-100 dark:bg-neutral-800 rounded-xl shadow-sm">
                                                        <div className="flex flex-col">
                                                            <div className="flex flex-col px-2">
                                                                <CreatePostTitle className="px-2 mb-0" />
                                                                <EditModeProvider editable>
                                                                    <ToolbarInline close={() => setShowInlineEditor(false)} />
                                                                </EditModeProvider>
                                                            </div>
                                                            <InlineEditor className="min-h-[calc(70vh-10rem)] pb-12" />
                                                        </div>
                                                    </div>
                                                    <CloseableAppPane className="fixed z-30 bottom-0 shadow-t-lg" />
                                                </div>
                                            )}

                                            {/* Sticky chat composer */}
                                            {feedRoot && isChat && (
                                                <AnimatedStickyToolbar>
                                                    <CloseableAppPane>

                                                        <EditModeProvider editable >
                                                            <ToolbarCreateNew
                                                                /* className="rounded-t-lg px-2" */
                                                                className="rounded-lg bg-neutral-50 dark:bg-neutral-800/60"

                                                                parent={feedRoot}
                                                                inlineEditorActive={showInlineEditor}
                                                                setInlineEditorActive={setShowInlineEditor}
                                                            />
                                                        </EditModeProvider>
                                                    </CloseableAppPane>
                                                </AnimatedStickyToolbar>
                                            )}

                                            {/* Sticky controls and feed , we place this inside CanvasEditorProvider because feed depends on the AutoReply functionality which is part of the CanvasEditorProvider component */}
                                            <div
                                                className="w-full px-2 sticky"
                                                style={{
                                                    top: repliesFocused
                                                        ? "calc(var(--header-h,0px) + var(--sticky-header-h,0px))"
                                                        : "10px",
                                                    willChange: "transform",
                                                    backfaceVisibility: "hidden",
                                                    zIndex: 2,
                                                }}
                                            >
                                                {!isChat && (
                                                    <div className="rounded-b-xl h-8 shadow-sm bg-neutral-100 dark:bg-neutral-800 transition-transform duration-800 ease-in-out w-full">
                                                        <BottomControls />
                                                    </div>
                                                )}
                                            </div>

                                            <Feed
                                                type="settings"
                                                viewRef={repliesFocused ? document.body : repliesScrollRef.current}
                                                scrollSettings={scrollSettings}
                                                parentRef={repliesScrollRef}
                                                onSnapshot={() => setRepliesFocused(true)}
                                                provider={useStream}
                                                disableLoadMore={showInlineEditor}
                                            />

                                        </CanvasEditorProvider>


                                    </div>
                                </div>

                                {!repliesFocused && isChat && (
                                    <div
                                        className="absolute top-0 inset-0 z-3 cursor-pointer flex flex-col justify-start items-center overflow-container-guide"
                                        onClick={(e) => {
                                            if (repliesFocused) return;
                                            e.preventDefault();
                                            e.stopPropagation();
                                            setRepliesFocused(true);
                                        }}
                                        onTouchStart={(e) => {
                                            if (repliesFocused) return;
                                            setRepliesFocused(true);
                                            e.preventDefault();
                                            e.stopPropagation();
                                        }}
                                    >
                                        <span className="p-2 m-2 z-2 bg-white/50 dark:bg-black/50 text-neutral-950 dark:text-neutral-50 rounded text-sm font-semibold shadow-md backdrop-blur-xs">
                                            Click to see more
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                <div className="relative">
                    <div className="absolute right-1 bottom-0">
                        <ReplyingInProgress canvas={lastReply} />
                    </div>
                </div>
            </CanvasEditorProvider>
        </>
    );
};