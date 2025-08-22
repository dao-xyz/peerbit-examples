import React, {
    useState,
    useEffect,
    useRef,
    useContext,
    createContext,
    useMemo,
    useImperativeHandle,
    forwardRef,
} from "react";
import { usePeer, useProgram, useQuery } from "@peerbit/react";
import {
    Canvas as CanvasDB,
    Element,
    Layout,
    IFrameContent,
    ElementContent,
    StaticContent,
    StaticMarkdownText,
    StaticPartialImage,
    SimpleWebManifest,
    getOwnedElementsQuery,
    getQualityLessThanOrEqualQuery,
    LOWEST_QUALITY,
    Quality,
    IndexableElement,
    Scope,
    IndexableCanvas,
} from "@giga-app/interface";
import { randomBytes, sha256Sync } from "@peerbit/crypto";
import { concat, equals } from "uint8arrays";
import { useApps } from "../content/useApps.js";
import { readFileAsImage } from "../content/native/image/utils.js";
import { useErrorDialog } from "../dialogs/useErrorDialog.js";
import { Sort, SortDirection } from "@peerbit/indexer-interface";
import {
    rectIsStaticMarkdownText,
    rectIsStaticPartialImage,
} from "./utils/rect.js";
import { useReplyProgress } from "./main/useReplyProgress.js";
import { useAIReply } from "../ai/AIReployContext.js";
import { waitFor } from "@peerbit/time";
import { DocumentsChange, WithIndexedContext } from "@peerbit/document";
import { useStream } from "./feed/StreamContext.js";
import { useRegisterCanvasHandle } from "./edit/CanvasHandleRegistry.js";
import { PrivateScope, PublicScope } from "./useScope.js";
import { useInitializeCanvas } from "./useInitializedCanvas.js";

export interface CanvasHandle {
    /** Flush pending rects to the DB (same semantics as before) */
    savePending: (scope: Scope) => Promise<Element[] | undefined>;
    /** Everything else you may want to reach from the outside */
    insertDefault: CanvasContextType["insertDefault"];
    insertImage: CanvasContextType["insertImage"];
    mutate: CanvasContextType["mutate"];
    savedOnce: boolean | undefined;
    isEmpty: boolean | undefined
}

// ---------------------------------------------------------------------
//  Context definitions
// ---------------------------------------------------------------------
export interface CanvasContextType {
    active: Set<Uint8Array>;
    setActive: (value: Set<Uint8Array>) => void;
    pendingRects: Element[];
    setPendingRects: React.Dispatch<
        React.SetStateAction<Element<ElementContent>[]>
    >;
    rects: Element[]; // ► now the deduplicated, user-visible list
    insertDefault: (options?: {
        app?: SimpleWebManifest;
        scope?: Scope;
        increment?: boolean;
        pending?: boolean;
        once?: boolean;
        y?: number | "optimize" | "max";
    }) => Promise<Element | Element[]>;
    removePending: (id: Uint8Array) => void;

    canvas: WithIndexedContext<CanvasDB, IndexableCanvas>
    onContentChange: (element: Element) => void;
    isEmpty: boolean;
    insertImage: (
        file: File,
        options?: { scope?: Scope, pending?: boolean; y?: number | "optimize" | "max" }
    ) => Promise<void>;
    mutate: (
        fn: (
            element: Element<ElementContent>,
            ix: number
        ) => Promise<boolean> | boolean,
        options?: {
            filter: (rect: Element) => boolean;
        }
    ) => boolean;
    reduceElementsForViewing: (rects?: Element[]) => Element[];
    separateAndSortRects: (rects?: Element[]) => {
        text: Element<StaticContent<StaticMarkdownText>>[];
        other: Element[];
    };
    text: string;
    setRequestAIReply: (boolean: boolean) => void;
    requestAIReply: boolean;
    subscribeContentChange: (
        callback: (element: Element) => void
    ) => () => void;
    isLoading: boolean;
    isSaving: boolean;
    placeholder?: string;
    classNameContent?: string | ((el: Element<ElementContent>) => string);
}

export const CanvasContext = createContext<CanvasContextType | undefined>(
    undefined
);

export const useCanvas = () => {
    const ctx = useContext(CanvasContext);
    if (!ctx) throw new Error("useCanvas must be used within a CanvasWrapper");
    return ctx;
};

interface CanvasWrapperProps {
    key?: string;
    children: React.ReactNode;
    canvas: CanvasDB | WithIndexedContext<CanvasDB, IndexableCanvas>;
    draft?: boolean;
    onSave?: () => void | Promise<void>;
    multiCanvas?: boolean;
    onContentChange?: (elements: Element[]) => void;
    quality?: Quality;
    onLoad?: () => void;
    placeholder?: string;
    classNameContent?: string | ((el: Element<ElementContent>) => string);
    debug?: boolean; // for debugging purposes, not used in production
}

const _CanvasWrapper = (
    {
        children,
        canvas: canvasDBMaybeIndexed,
        multiCanvas,
        onContentChange,
        quality,
        placeholder,
        classNameContent,
        key,
        debug,
    }: CanvasWrapperProps,
    ref: React.Ref<CanvasHandle>
) => {
    // -------------------------------------------------- basic hooks ----
    const { peer } = usePeer();

    const privateScope = PrivateScope.useScope().scope;
    const publicScope = PublicScope.useScope().scope;

    const { getCuratedNativeApp: getNativeApp } = useApps();
    const { showError } = useErrorDialog();
    const { announceReply } = useReplyProgress();
    const { typeFilter } = useStream();

    const canvasDB = useInitializeCanvas(canvasDBMaybeIndexed);

    // -------------------------------------------------- local state ----
    const [pendingRects, setPendingRects] = useState<(Element & { placeholder?: boolean })[]>([]);
    const [active, setActive] = useState<Set<Uint8Array>>(new Set());
    const [isSaving, setIsSaving] = useState(false);
    const [savedOnce, setSavedOnce] = useState<boolean | undefined>(undefined);
    const [isEmpty, setIsEmpty] = useState<boolean | undefined>(undefined);
    const [requestAIReply, setRequestAIReply] = useState(false);
    const [text, setText] = useState<string>("");
    const insertedDefault = useRef(false);

    const pendingCounter = useRef(0);
    const latestBreakpoint = useRef<"xxs" | "md">("md");
    const setupForCanvasIdDone = useRef<string>(undefined);

    // -------------------------------------------------- query ---------
    const query = useMemo(() => {
        insertedDefault.current = false;
        if (!canvasDB?.initialized) return null;
        return {
            query: [
                ...getOwnedElementsQuery(canvasDB),
                ...getQualityLessThanOrEqualQuery(quality ?? LOWEST_QUALITY),
            ],
            sort: [
                new Sort({
                    key: ["quality"],
                    direction: SortDirection.ASC,
                }),
                new Sort({ key: ["location", "y"] }),
            ],
        };
    }, [canvasDB?.idString, canvasDB?.initialized, quality, typeFilter.key]);

    const { items: rects, isLoading } = useQuery(
        [privateScope.elements, publicScope.elements],
        {
            debounce: 123,
            local: true,
            prefetch: true,
            debug,
            remote: {
                eager: true,
                joining: { waitFor: 5e3 },
            },
            onChange: {
                merge: (change) => {
                    const filtered: DocumentsChange<
                        Element<ElementContent>,
                        IndexableElement
                    > = {
                        added: change.added.filter((x) => canvasDB.isOwning(x)),
                        removed: []/*  TODO change.removed.filter((x) =>
                            canvas.isOwning(x)
                        ), */
                    };

                    return filtered;
                },
            },
            query,
        }
    );

    // effect to determin if the canvas is empty
    useEffect(() => {
        if (rects.length > 0) {
            setIsEmpty(false);
        }
        else if (pendingRects.length > 0) {
            setIsEmpty(false);
        }
        else {
            setIsEmpty(true);
        }
    }, [rects, pendingRects])

    // Remove an empty pending rect if rects already contain something, and the rect was inserted automatically to make a placeholder
    useEffect(() => {
        if (rects.length > 0 && pendingRects.length > 0) {
            const emptyPending = pendingRects.find(
                (r) =>
                    r.content instanceof StaticContent &&
                    r.content.content.isEmpty && r.placeholder == true
            );
            if (emptyPending) {
                console.log("Remove pending!")
                setPendingRects((prev) =>
                    prev.filter((p) => {
                        if (!p.placeholder) {
                            return true;
                        }
                        if (p.placeholder && p.content instanceof StaticContent && p.content.content.isEmpty) {
                            return false;
                        }
                        return true
                    })
                );
            }
        }
    }, [rects, pendingRects])


    // View calculations
    // ------------------------------------------------------------------
    // 1.  Deduplicated union for rendering (prevents flash)
    // ------------------------------------------------------------------
    const visibleRects = useMemo<Element[]>(() => {
        const idsInQuery = new Set(rects.map((r) => r.idString));
        const stillPending = pendingRects.filter(
            (p) => !idsInQuery.has(p.idString)
        );

        return [...rects, ...stillPending];
    }, [rects, pendingRects]);



    // ------------------------------------------------------------------
    // 2.  Incremental pruning of pendingRects
    // ------------------------------------------------------------------
    useEffect(() => {
        if (pendingRects.length === 0) return;
        const idsInQuery = new Set(rects.map((r) => r.idString));
        if (idsInQuery.size === 0) return; // nothing new yet
        setPendingRects((prev) =>
            prev.filter((p) => !idsInQuery.has(p.idString))
        );
    }, [rects]); // NOTE: intentionally *not* depending on pendingRects

    // ------------------------------------------------------------------
    //  Subscription machinery
    // ------------------------------------------------------------------
    const contentChangeSubscribers = useRef(
        new Set<(element: Element) => void>()
    );
    const subscribeContentChange = (cb: (e: Element) => void) => {
        contentChangeSubscribers.current.add(cb);
        return () => contentChangeSubscribers.current.delete(cb);
    };

    // ------------------------------------------------------------------
    //  Utilities (reduce / separate) – default to visibleRects
    // ------------------------------------------------------------------
    const reduceElementsForViewing = (
        elems: Element[] = visibleRects
    ): Element[] => {
        const groups = new Map<string, Map<number, Element[]>>();
        elems.forEach((rect) => {
            const cid = rect.content.contentIdString;
            if (!groups.has(cid)) groups.set(cid, new Map());
            const q = rect.content.quality;
            const qm = groups.get(cid)!;
            if (!qm.has(q)) qm.set(q, []);
            qm.get(q)!.push(rect);
        });

        const finalRects: Element[] = [];

        groups.forEach((qm) => {
            const qualities = Array.from(qm.keys()).sort((a, b) => b - a);
            if (qualities.length === 0) return;
            const bestQ = qualities[0];
            const candidates = qm.get(bestQ)!;

            const full = candidates.filter((r) => !rectIsStaticPartialImage(r));
            const partial = candidates.filter((r) =>
                rectIsStaticPartialImage(r)
            );

            let best: Element | undefined = undefined;
            if (partial.length > 0) {
                const first = partial[0].content.content as StaticPartialImage;
                if (first.totalParts === partial.length) {
                    const merged = StaticPartialImage.combine(
                        partial.map(
                            (r) => r.content.content as StaticPartialImage
                        )
                    );
                    const rep = partial[0] as Element<StaticContent>;
                    best = new Element({
                        publicKey: rep.publicKey,
                        id: rep.id,
                        location: rep.location,
                        content: new StaticContent({
                            quality: rep.content.quality,
                            content: merged,
                            contentId: rep.content.contentId,
                        }),
                        canvasId: rep.parent.id,
                    });
                } else {
                    best = partial[0];
                }
            } else if (full.length > 0) {
                best = full[0];
            }
            if (best) finalRects.push(best);
        });

        finalRects.sort((a, b) => a.location.y - b.location.y);
        return finalRects;
    };

    const separateAndSortRects = (
        elems: Element[] = visibleRects
    ): {
        text: Element<StaticContent<StaticMarkdownText>>[];
        other: Element[];
    } => {
        const grouped = reduceElementsForViewing(elems);
        const out = {
            text: [] as Element<StaticContent<StaticMarkdownText>>[],
            other: [] as Element[],
        };
        grouped.forEach((r) => {
            if (rectIsStaticMarkdownText(r)) out.text.push(r);
            else out.other.push(r);
        });
        out.text.sort((a, b) => a.location.y - b.location.y);
        out.other.sort((a, b) => a.location.y - b.location.y);
        return out;
    };

    // ------------------------------------------------------------------
    //  addRect, mutate, insertImage, insertDefault, removePending
    //  –– original implementations below (unchanged except where noted)
    // ------------------------------------------------------------------
    const getOptimalInsertLocation = (content: ElementContent) => {
        if (rectIsStaticMarkdownText({ content })) {
            return 0;
        }
        const topMostTextY = () =>
            pendingRects
                .filter((x) => rectIsStaticMarkdownText(x))
                .sort((x, y) => x.location.y - y.location.y)[0]?.location.y;

        let y: number | undefined = topMostTextY();
        if (y == null || y < 0) y = 0;
        return y;
    };

    const getMaxYPlus1 = (from: Element[]) => {
        const maxY = from
            .map((x) => x.location)
            .filter((x) => x.breakpoint === latestBreakpoint.current)
            .reduce((prev, curr) => Math.max(curr.y, prev), -1);
        return maxY != null ? maxY + 1 : 0;
    };

    const reduceYInPending = (fromY: number) => {
        for (const el of [...pendingRects].sort(
            (a, b) => a.location.y - b.location.y
        )) {
            if (el.location.y >= fromY) el.location.y--;
        }
    };

    const mutate = (
        fn: (element: Element<ElementContent>, ix: number) => boolean,
        options?: { filter: (rect: Element) => boolean }
    ): boolean => {
        if (!canvasDB?.publicKey.equals(peer?.identity.publicKey)) return false;

        let mutated = false;
        let updated = [...pendingRects];

        // mutate pending
        for (let i = 0; i < updated.length; i++) {
            const el = updated[i];
            if (options?.filter && !options.filter(el)) continue;
            if (fn(el, i)) {
                updated[i] = el;
                mutated = true;
            }
        }

        // mutate committed rects (copy into pending if needed)
        for (let i = 0; i < rects.length; i++) {
            const el = rects[i];
            if (updated.some((e) => e.idString === el.idString)) continue;
            if (options?.filter && !options.filter(el)) continue;
            if (fn(el, i)) {
                updated.push(el);
                mutated = true;
            }
        }

        if (mutated) {
            setPendingRects(updated);
        }

        return mutated;
    };

    async function addRect(
        content: ElementContent,
        options?: {
            id?: Uint8Array;
            scope?: Scope,
            pending?: boolean | { placeholder: boolean };
            y?: number | "optimize" | "max";
        }
    ): Promise<Element>;
    async function addRect(
        contents: ElementContent[],
        options?: { scope?: Scope, pending?: boolean | { placeholder: boolean }; y?: number | "optimize" | "max" }
    ): Promise<Element[]>;

    async function addRect(
        contents: ElementContent | ElementContent[],
        options: {
            scope?: Scope,
            id?: Uint8Array;
            pending?: boolean | { placeholder: boolean };
            y?: number | "optimize" | "max";
        } = { pending: false }
    ): Promise<Element | Element[]> {
        const firstContent = Array.isArray(contents) ? contents[0] : contents;
        if (!firstContent) throw new Error("Missing content");
        if (options?.id && Array.isArray(contents))
            throw new Error("Cannot set id when adding multiple");

        const yStrategy = options.y ?? "optimize";
        await waitFor(() => publicScope).catch(() => new Error("Canvas not ready"));
        /*  await canvas.load(); */

        const current = await publicScope.elements.index.search({
            query: getOwnedElementsQuery(canvasDB),
        });
        const all = [...current, ...pendingRects];

        let y: number;
        if (typeof yStrategy === "number") y = yStrategy;
        else if (yStrategy === "optimize")
            y = getOptimalInsertLocation(firstContent);
        else if (yStrategy === "max") y = getMaxYPlus1(all);
        else throw new Error("Invalid y option");

        for (const el of [...pendingRects].sort(
            (a, b) => a.location.y - b.location.y
        )) {
            if (el.location.y >= y) el.location.y++;
        }

        const result: Element[] = [];
        const list = Array.isArray(contents) ? contents : [contents];
        for (const content of list) {
            const element = new Element({
                publicKey: peer.identity.publicKey,
                id: options.id,
                location: new Layout({
                    breakpoint: latestBreakpoint.current,
                    x: 0,
                    y,
                    z: 0,
                    w: 1,
                    h: 1,
                }),
                content,
                canvasId: canvasDB.id,
            });
            if (options.pending) {
                setPendingRects((prev) => {
                    const already = prev.find(
                        (x) => x.idString === element.idString
                    );
                    if (already) {
                        if (
                            already.content instanceof StaticContent &&
                            already.content.content.isEmpty
                        ) {
                            already.placeholder = true
                            already.content = element.content;
                            return [...prev];
                        }
                        return prev;
                    }
                    (element as unknown as { placeholder: boolean }).placeholder = true;
                    return [...prev, element];
                });
            } else {
                await canvasDB.createElement(element);
            }
            result.push(element);
        }
        return Array.isArray(contents) ? result : result[0];
    }

    const insertImage = async (
        file: File,
        options?: { pending?: boolean; y?: number | "optimize" | "max" }
    ) => {
        try {
            const images = await readFileAsImage(file);
            const newElements: Element[] = await addRect(images, options);
            setIsEmpty(false);
            onContentChange?.(newElements);
        } catch (e) {
            showError({ message: "Failed to insert image", error: e });
        }
    };

    const insertDefault = (options?: {
        app?: SimpleWebManifest;
        increment?: boolean;
        pending?: boolean;
        once?: boolean;
        placeHolderForEmpty?: boolean;
        scope?: Scope
        y?: number | "optimize" | "max";
    }) => {
        /*  console.trace("insert default") */
        if (options?.once) {
            if (
                pendingRects.length > 0 ||
                rects.length > 0 ||
                insertedDefault.current
            ) {
                return;
            }
        }
        insertedDefault.current = true;
        if (options?.increment) {
            const last = pendingRects[pendingRects.length - 1];
            if (
                !multiCanvas &&
                last &&
                last.content instanceof StaticContent &&
                last.content.content.isEmpty
            ) {
                /* replace last */
            } else {
                pendingCounter.current++;
            }
            setIsEmpty(false);
        }
        const defaultId = sha256Sync(
            concat([
                canvasDB.id,
                peer.identity.publicKey.bytes,
                new Uint8Array([pendingCounter.current]),
            ])
        );

        let appContent: ElementContent;
        if (options?.app) {
            if (options.app.isNative) {
                const native = getNativeApp(options.app.url);
                if (!native) {
                    throw new Error(
                        "Missing native app for url: " + options.app.url
                    );
                }
                const v = native.default();
                appContent = new StaticContent({
                    content: v,
                    quality: LOWEST_QUALITY,
                    contentId: randomBytes(32),
                });
            } else {
                appContent = new IFrameContent({
                    resizer: false,
                    src: options.app.url,
                });
            }
        } else {
            appContent = new StaticContent({
                content: new StaticMarkdownText({ text: "" }),
                quality: LOWEST_QUALITY,
                contentId: sha256Sync(new TextEncoder().encode("")),
            });
        }
        return addRect(appContent, {
            id: defaultId,
            pending: true,
            y: options?.y,
            scope: options?.scope || privateScope
        });
    };

    const removePending = (id: Uint8Array) => {
        const pending = pendingRects.find((x) => equals(x.id, id));
        setPendingRects((prev) => prev.filter((el) => !equals(id, el.id)));
        if (pending) reduceYInPending(pending.location.y);
    };
    const savePending = async (scope: Scope) => {
        if (!pendingRects.length) { return; }
        setIsSaving(true);
        setSavedOnce(true);
        try {
            const toSave = pendingRects.filter(
                (x) =>
                    !(x.content instanceof StaticContent) ||
                    x.content.content.isEmpty === false
            );
            if (toSave.length === 0) { return; }

            pendingCounter.current += toSave.length;
            for (const el of toSave) {
                el.parent = canvasDB; // see original comment
            }
            await Promise.all(toSave.map((x) => { x.placeholder = false; return scope.elements.put(x) }));
            /* if (requestAIReply) request(canvas).catch(console.error); */
            return toSave;
        } catch (error) {
            showError({ message: "Failed to save", error, severity: "error" });
        } finally {
            setIsSaving(false);
        }
    };

    // ------------------------------------------------------------------
    //  reset & effects
    // ------------------------------------------------------------------
    const reset = () => {
        setPendingRects([]);
        setSavedOnce(undefined);
    };

    useEffect(() => {
        const handleClickOutside = () => setActive(new Set());
        document.addEventListener("mousedown", handleClickOutside);
        return () =>
            document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    useEffect(() => {
        if (!peer || !canvasDB || !canvasDB.initialized) return;
        if (canvasDB.idString === setupForCanvasIdDone.current) return;
        setupForCanvasIdDone.current = canvasDB.idString;
        reset();
        if (!canvasDB.initialized) throw new Error("Expecting canvas to be open");
    }, [peer?.identity.publicKey.hashcode(), canvasDB?.idString, publicScope?.idString]);

    // ------------------------------------------------------------------
    //  Content-change hook (unchanged except still uses pendingRects)
    // ------------------------------------------------------------------
    const _onContentChange = async (el: Element) => {
        if (
            rects.length === 0 &&
            pendingRects.length === 1 &&
            rectIsStaticMarkdownText(el)
        ) {
            setText(el.content.content.text);
        }
        if (rectIsStaticMarkdownText(el)) {
            const parent = await canvasDB.loadParent();
            announceReply(parent);
        }
        if (!el.content.isEmpty) {
            setIsEmpty(false);
        } else {
            const all = [...pendingRects, ...rects];
            if (all.every((r) => r.content.isEmpty)) setIsEmpty(true);
        }
        onContentChange?.([el]);
        contentChangeSubscribers.current.forEach((cb) => cb(el));
    };

    useImperativeHandle(
        ref,
        () => ({
            isEmpty,
            savedOnce,
            savePending,
            insertDefault,
            insertImage,
            mutate,
        }),
        [savePending, isEmpty, insertDefault, insertImage, mutate]
    );

    /* tell any ancestor provider about this handle */
    const register = useRegisterCanvasHandle();
    useEffect(
        () =>
            register?.(
                // safe even if no provider above us
                { savedOnce, isEmpty, savePending, insertDefault, insertImage, mutate }
            ),
        [register, savePending, insertDefault, insertImage, mutate]
    );

    // ------------------------------------------------------------------
    //  Provide context
    // ------------------------------------------------------------------
    const contextValue: CanvasContextType = {
        active,
        setActive,
        pendingRects,
        setPendingRects,
        rects: visibleRects, // ◄ expose deduplicated list
        insertDefault,
        removePending,
        canvas: canvasDB,
        onContentChange: _onContentChange,
        isEmpty,
        insertImage,
        mutate,
        reduceElementsForViewing,
        separateAndSortRects,
        text,
        setRequestAIReply,
        requestAIReply,
        subscribeContentChange,
        isLoading,
        isSaving,
        placeholder,
        classNameContent,
    };

    return (
        <CanvasContext.Provider value={contextValue}>
            {children}
        </CanvasContext.Provider>
    );
};

export const CanvasWrapper = forwardRef<CanvasHandle, CanvasWrapperProps>(
    _CanvasWrapper
);
