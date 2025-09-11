import React, {
    useState,
    useEffect,
    useRef,
    useContext,
    createContext,
    useMemo,
    useImperativeHandle,
    forwardRef,
    useCallback,
} from "react";
import { usePeer, useQuery } from "@peerbit/react";
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
import { waitFor } from "@peerbit/time";
import { DocumentsChange, WithIndexedContext } from "@peerbit/document";
import { useStream } from "./feed/StreamContext.js";
import { useRegisterCanvasHandle } from "./edit/CanvasHandleRegistry.js";
import { PrivateScope, PublicScope } from "./useScope.js";
import { useInitializeCanvas } from "./useInitializedCanvas.js";
import { useSyncedStateRef } from "../utils/useSyncedStateRef.js";
import { emitDebugEvent } from "../debug/debug.js";

/* ────────────────────────────────────────────────────────────────────────────
 * Public types
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CanvasHandle {
    /** Flush pending rects to the DB (same semantics as before) */
    savePending: (scope: Scope) => Promise<Element[] | undefined>;
    /** Everything else you may want to reach from the outside */
    insertDefault: CanvasContextType["insertDefault"];
    insertImage: CanvasContextType["insertImage"];
    mutate: CanvasContextType["mutate"];
}

export interface CanvasContextType {
    active: Set<Uint8Array>;
    setActive: (value: Set<Uint8Array>) => void;
    pendingRects: Element[];
    setPendingRects: React.Dispatch<
        React.SetStateAction<Element<ElementContent>[]>
    >;
    /** Stable function that always saves the latest pendings */
    savePending: (scope: Scope) => Promise<Element[] | undefined>;
    rects: Element[]; // deduped, user-visible list
    insertDefault: (options?: {
        app?: SimpleWebManifest;
        scope?: Scope;
        increment?: boolean;
        pending?: boolean;
        once?: boolean;
        y?: number | "optimize" | "max";
    }) => Promise<Element | Element[]>;
    removePending: (id: Uint8Array) => void;

    canvas: WithIndexedContext<CanvasDB, IndexableCanvas>;
    onContentChange: (element: Element) => void;
    isEmpty: boolean;
    hasTextElement: boolean;
    insertImage: (
        file: File,
        options?: {
            scope?: Scope;
            pending?: boolean;
            y?: number | "optimize" | "max";
        }
    ) => Promise<void>;
    mutate: (
        fn: (
            element: Element<ElementContent>,
            ix: number
        ) => Promise<boolean> | boolean,
        options?: { filter: (rect: Element) => boolean }
    ) => boolean;
    reduceElementsForViewing: (rects?: Element[]) => Element[];
    separateAndSortRects: (rects?: Element[]) => {
        text: Element<StaticContent<StaticMarkdownText>>[];
        other: Element[];
    };
    text: string;
    setRequestAIReply: (v: boolean) => void;
    requestAIReply: boolean;
    subscribeContentChange: (
        callback: (element: Element) => void
    ) => () => void;
    isLoading: boolean;
    isSaving: boolean;
    placeholder?: string;
    classNameContent?: string | ((el: Element<ElementContent>) => string);
    debug?: boolean;
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
    debug?: boolean; // debug console logs
}

/* ────────────────────────────────────────────────────────────────────────────
 * Component
 * ──────────────────────────────────────────────────────────────────────────── */

const _CanvasWrapper = (
    {
        children,
        canvas: canvasDBMaybeIndexed,
        multiCanvas,
        onContentChange,
        quality,
        placeholder,
        classNameContent,
        debug,
    }: CanvasWrapperProps,
    ref: React.Ref<CanvasHandle>
) => {
    // -------------------------------------------------- basic hooks ----
    const { peer } = usePeer();
    const debugLog = useMemo(
        () =>
            debug
                ? (...args: any[]) => console.log("[Canvas]", ...args)
                : () => {},
        [debug]
    );

    const privateScope = PrivateScope.useScope();
    const publicScope = PublicScope.useScope();

    const { getCuratedNativeApp: getNativeApp } = useApps();
    const { showError } = useErrorDialog();
    const { announceReply } = useReplyProgress();
    const { typeFilter } = useStream();

    const canvasDB = useInitializeCanvas(canvasDBMaybeIndexed);

    // -------------------------------------------------- local state ----
    const {
        ref: pendingRectsRef,
        state: pendingRects,
        set: setPendingRects,
    } = useSyncedStateRef<(Element & { placeholder?: boolean })[]>([]);
    // Debug helper: log diffs for pendingRects updates
    const logPendingDiff = useCallback(
        (before: Element[], after: Element[], reason: string) => {
            if (!debug) return;
            try {
                const toInfo = (e: Element) => ({
                    id: e.idString,
                    y: e.location?.y,
                    type: (e.content as any)?.constructor?.name,
                    empty:
                        e.content instanceof StaticContent &&
                        e.content.content.isEmpty === true,
                    placeholder: (e as any).placeholder === true,
                });
                const bIds = new Set(before.map((e) => e.idString));
                const aIds = new Set(after.map((e) => e.idString));
                const added = after.filter((e) => !bIds.has(e.idString));
                const removed = before.filter((e) => !aIds.has(e.idString));
                console.log("[CanvasWrapper][pendingRects diff]", {
                    reason,
                    added: added.map(toInfo),
                    removed: removed.map(toInfo),
                    before: before.map(toInfo),
                    after: after.map(toInfo),
                });
            } catch {}
        },
        [debug]
    );
    const [active, setActive] = useState<Set<Uint8Array>>(new Set());
    const [isSaving, setIsSaving] = useState(false);
    const [savedOnce, setSavedOnce] = useState<boolean | undefined>(undefined);

    const [requestAIReply, setRequestAIReply] = useState(false);
    const [text, setText] = useState<string>("");

    const insertedDefault = useRef(false);
    const pendingCounter = useRef(0);
    const latestBreakpoint = useRef<"xxs" | "md">("md");
    const setupForCanvasIdDone = useRef<string | undefined>(undefined);

    const canvasRef = useRef(canvasDB);
    useEffect(() => {
        canvasRef.current = canvasDB;
    }, [canvasDB]);

    const savingRef = useRef(false);

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
                new Sort({ key: ["quality"], direction: SortDirection.ASC }),
                new Sort({ key: ["location", "y"] }),
            ],
        };
    }, [canvasDB?.idString, canvasDB?.initialized, quality, typeFilter.key]);

    const { items: rawRects, isLoading } = useQuery(
        privateScope && publicScope
            ? [privateScope?.elements, publicScope?.elements]
            : undefined,
        {
            query,
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
                        removed: [], // TODO: implement if you need removal merging
                    };
                    return filtered;
                },
            },
        }
    );

    // Defensive: only expose rects that belong to this canvas
    const rects = useMemo(() => {
        try {
            return rawRects.filter((r) => canvasDB.isOwning(r));
        } catch {
            return rawRects;
        }
    }, [rawRects, canvasDB?.idString]);

    // 1) helper: what counts as “empty”?
    const isElementEmpty = (el: Element) => {
        // text: empty when StaticMarkdownText.isEmpty === true
        if (el.content instanceof StaticContent) {
            return el.content.content.isEmpty === true;
        }
        // images/iframes/native content are considered non-empty by default
        return false;
    };

    const hasTextElement = (el: Element) => {
        if (el.content instanceof StaticContent) {
            return el.content.content instanceof StaticMarkdownText;
        }
        return false;
    };

    // 2) derived emptiness (no state, no effects)
    const derivedIsEmpty = useMemo(() => {
        // any non-empty pending?
        if (pendingRects.some((el) => !isElementEmpty(el))) return false;
        // any non-empty committed rects?
        if (rects.some((el) => !isElementEmpty(el))) return false;
        return true;
    }, [rects, pendingRects]);

    // Instrumentation: log emptiness changes
    useEffect(() => {
        try {
            console.log("[CanvasWrapper] derivedIsEmpty=", derivedIsEmpty, {
                pendingCount: pendingRects.length,
                rectsCount: rects.length,
                pendingKinds: pendingRects.map(
                    (r) => r.content?.constructor?.name
                ),
                rectKinds: rects.map((r) => r.content?.constructor?.name),
            });
        } catch {}
    }, [derivedIsEmpty, pendingRects, rects]);

    // 2b). derived hasTextElement (used to figure out whether to insert a default text box)
    const derivedHasTextElement = useMemo(() => {
        // any text in pending?
        if (pendingRects.some((el) => hasTextElement(el))) return true;
        // any text in committed rects?
        if (rects.some((el) => hasTextElement(el))) return true;
        return false;
    }, [rects, pendingRects]);

    // Note: we intentionally keep an empty text placeholder pending even if other rects arrive
    // so the textarea remains available before send. Any saved placeholders will be pruned by
    // the id-based prune effect below once they exist in rects.

    // View calculations
    const visibleRects = useMemo<Element[]>(() => {
        const idsInQuery = new Set(rects.map((r) => r.idString));
        const stillPending = pendingRects.filter(
            (p) => !idsInQuery.has(p.idString)
        );
        return [...rects, ...stillPending];
    }, [rects, pendingRects]);

    // prune pending that made it into the index
    useEffect(() => {
        if (pendingRects.length === 0) return;
        const idsInQuery = new Set(rects.map((r) => r.idString));
        if (idsInQuery.size === 0) return;
        setPendingRects((prev) => {
            const next = prev.filter((p) => !idsInQuery.has(p.idString));
            if (next.length === prev.length) return prev; // avoid no-op updates
            logPendingDiff(
                prev as any,
                next as any,
                "prune-pending-that-exist-in-rects"
            );
            return next;
        });
    }, [rects]);

    // If a non-empty text rect exists (recovered or pending), drop any empty pending text placeholders
    useEffect(() => {
        if (pendingRects.length === 0) return;
        const hasNonEmptyText =
            rects.some(
                (r) =>
                    r.content instanceof StaticContent &&
                    r.content.content instanceof StaticMarkdownText &&
                    r.content.content.isEmpty === false
            ) ||
            pendingRects.some(
                (p) =>
                    p.content instanceof StaticContent &&
                    p.content.content instanceof StaticMarkdownText &&
                    p.content.content.isEmpty === false
            );

        if (!hasNonEmptyText) return;

        setPendingRects((prev) => {
            const next = prev.filter(
                (p) =>
                    !(
                        p.content instanceof StaticContent &&
                        p.content.content instanceof StaticMarkdownText &&
                        p.content.content.isEmpty === true
                    )
            );
            if (next.length === prev.length) return prev; // avoid no-op updates
            logPendingDiff(
                prev as any,
                next as any,
                "remove-empty-text-placeholder-because-non-empty-exists"
            );
            return next;
        });
    }, [rects, pendingRects]);

    // subscription registry
    const contentChangeSubscribers = useRef(
        new Set<(element: Element) => void>()
    );
    const subscribeContentChange = (cb: (e: Element) => void) => {
        contentChangeSubscribers.current.add(cb);
        return () => contentChangeSubscribers.current.delete(cb);
    };

    // utils
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

            let best: Element | undefined;
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

    const separateAndSortRects = (elems: Element[] = visibleRects) => {
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

    const getOptimalInsertLocation = (content: ElementContent) => {
        if (rectIsStaticMarkdownText({ content })) return 0;
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
        const updated: (Element & { _changed?: boolean })[] = [...pendingRects];

        // mutate pending
        for (let i = 0; i < updated.length; i++) {
            const el = updated[i];
            if (options?.filter && !options.filter(el)) continue;
            if (fn(el, i)) {
                updated[i] = el;
                updated[i]._changed = true;
                mutated = true;
            }
        }

        // mutate committed rects (copy into pending if needed)
        for (let i = 0; i < rects.length; i++) {
            const el = rects[i];
            if (updated.some((e) => e.idString === el.idString)) continue;
            if (options?.filter && !options.filter(el)) continue;
            if (fn(el, i)) {
                const clone = el; // same reference is fine; we keep it in pending to stage edits
                (clone as any)._changed = true;
                updated.push(clone);
                mutated = true;
            }
        }

        if (mutated) {
            // fire content change for the ones actually changed
            updated.forEach((e) => {
                if ((e as any)._changed) _onContentChange(e as Element);
            });

            setPendingRects((prev) => {
                const next = updated.map((e) => {
                    e._changed = undefined;
                    return e;
                });
                logPendingDiff(prev as any, next as any, "mutate");
                return next;
            });
            console.log("mutate: updating pending rects", updated.length);
        }

        return mutated;
    };

    async function addRect(
        content: ElementContent,
        options?: {
            id?: Uint8Array;
            scope?: Scope;
            pending?: boolean | { placeholder: boolean };
            y?: number | "optimize" | "max";
        }
    ): Promise<Element>;
    async function addRect(
        contents: ElementContent[],
        options?: {
            scope?: Scope;
            pending?: boolean | { placeholder: boolean };
            y?: number | "optimize" | "max";
        }
    ): Promise<Element[]>;

    async function addRect(
        contents: ElementContent | ElementContent[],
        options: {
            scope?: Scope;
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
        await waitFor(() => publicScope).catch(
            () => new Error("Canvas not ready")
        );

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
                debugLog(
                    "Adding pending rect",
                    canvasDB.idString,
                    element.idString
                );
                setPendingRects((prev) => {
                    const already = prev.find(
                        (x) => x.idString === element.idString
                    );
                    if (already) {
                        if (
                            already.content instanceof StaticContent &&
                            already.content.content.isEmpty
                        ) {
                            already.placeholder = true;
                            already.content = element.content;
                            const next = [...prev];
                            logPendingDiff(
                                prev as any,
                                next as any,
                                "addRect.pending:replace-placeholder"
                            );
                            console.log(
                                "[CanvasWrapper] replaced placeholder with new pending content",
                                { pendingCount: next.length }
                            );
                            return next;
                        }
                        console.log(
                            "[CanvasWrapper] pending already existed; skipping",
                            { pendingCount: prev.length }
                        );
                        return prev;
                    }
                    (element as any).placeholder = true;
                    const next = [...prev, element];
                    logPendingDiff(
                        prev as any,
                        next as any,
                        "addRect.pending:add"
                    );
                    console.log("[CanvasWrapper] added pending rect", {
                        type: element.content?.constructor?.name,
                        pendingCount: next.length,
                    });
                    return next;
                });
            } else {
                debugLog(
                    "Adding committed rect",
                    canvasDB.idString,
                    element.idString
                );
                await canvasDB.createElement(element);
            }
            await _onContentChange(element);
            result.push(element);
        }
        return Array.isArray(contents) ? result : result[0];
    }

    const insertImage = async (
        file: File,
        options?: { pending?: boolean; y?: number | "optimize" | "max" }
    ) => {
        try {
            console.log("[CanvasWrapper] insertImage:start", {
                pending: options?.pending,
                y: options?.y,
            });
            const images = await readFileAsImage(file);
            const newElements: Element[] = await addRect(images, options);
            console.log("[CanvasWrapper] insertImage:added", {
                added: newElements.length,
                kinds: newElements.map((e) => e.content?.constructor?.name),
            });
            // Persist immediately if drafted pending
            try {
                if (options?.pending) {
                    await savePending(privateScope ?? canvasDB.nearestScope);
                }
            } catch (e) {
                console.error("insertImage: immediate save failed", e);
            }
            onContentChange?.(newElements);
        } catch (e) {
            showError({ message: "Failed to insert image", error: e });
        }
    };

    const insertDefault = useCallback(
        async (options?: {
            app?: SimpleWebManifest;
            increment?: boolean;
            pending?: boolean;
            once?: boolean;
            placeHolderForEmpty?: boolean;
            scope?: Scope;
            y?: number | "optimize" | "max";
        }) => {
            debugLog("insert default into", canvasDB.idString);
            if (options?.once) {
                if (
                    pendingRectsRef.current.length > 0 ||
                    rects.length > 0 ||
                    insertedDefault.current
                ) {
                    debugLog("Skipping insert default", {
                        idString: canvasDB.idString,
                        id: canvasDB.id,
                        pendingRects: pendingRectsRef.current.length,
                        rects: rects,
                        insertedDefault: insertedDefault.current,
                    });
                    return;
                }
            }
            insertedDefault.current = true;

            if (options?.increment) {
                const last =
                    pendingRectsRef.current[pendingRectsRef.current.length - 1];
                if (
                    !multiCanvas &&
                    last &&
                    last.content instanceof StaticContent &&
                    last.content.content.isEmpty
                ) {
                    // replace last
                } else {
                    pendingCounter.current++;
                }
            }

            // Use undefined id for pending default to avoid accidental collisions
            const defaultId = undefined;

            let appContent: ElementContent;
            if (options?.app) {
                if (options.app.isNative) {
                    const native = getNativeApp(options.app.url);
                    if (!native)
                        throw new Error(
                            "Missing native app for url: " + options.app.url
                        );
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
                id: defaultId as any,
                pending: true,
                y: options?.y,
                scope: options?.scope || privateScope,
            });
        },
        [canvasDB, peer, multiCanvas, privateScope]
    );

    const removePending = (id: Uint8Array) => {
        const pending = pendingRects.find((x) => equals(x.id, id));
        console.log("remove pending");
        setPendingRects((prev) => {
            const next = prev.filter((el) => !equals(id, el.id));
            logPendingDiff(prev as any, next as any, "removePending");
            return next;
        });
        if (pending) {
            reduceYInPending(pending.location.y);
        }
    };

    // ── stable savePending that reads latest values via refs
    const savePending = useCallback(
        async (_scope: Scope) => {
            const canvas = canvasRef.current;
            const pendings = pendingRectsRef.current;
            debugLog(
                "Saving pending rects",
                pendings.length,
                pendingRects.length,
                "in canvas",
                canvas.idString
            );
            console.log("Saving pending rects", {
                count: pendings.length,
                count2: pendingRects.length,
                canvas: canvas.idString,
            });
            if (!pendings.length) {
                console.log("No pending rects to save");
                debugLog("No pending rects to save");
                return;
            }
            if (savingRef.current) {
                console.log("Save already in-flight, skipping");
                debugLog("Save already in-flight, skipping");
                return;
            }

            savingRef.current = true;
            setIsSaving(true);
            setSavedOnce(true);

            try {
                const toSave = pendings.filter(
                    (x) =>
                        !(x.content instanceof StaticContent) ||
                        x.content.content.isEmpty === false
                );
                console.log("Non-empty rects to save", {
                    total: pendings.length,
                    toSave: toSave.length,
                    canvas: canvas.idString,
                });
                if (toSave.length === 0) {
                    debugLog("No non-empty rects to save");
                    return;
                }

                pendingCounter.current += toSave.length;
                for (const el of toSave) {
                    el.parent = canvas;
                    (el as any).placeholder = false;
                }

                // Optionally: optimistic clear to avoid double-saving on quick subsequent calls
                // setPendingRects((prev) => prev.filter(p => !toSave.some(s => s.idString === p.idString)));
                const t0 = performance.now();
                emitDebugEvent({
                    source: "CanvasWrapper",
                    name: "save:start",
                    canvasId: canvas.idString,
                    count: toSave.length,
                });
                // Persist through the Canvas DB so ownership/indexing is correct
                for (const el of toSave) {
                    await canvas.createElement(el);
                }
                // Ensure indexes are up to date before navigation/reload
                try {
                    await canvas.nearestScope._hierarchicalReindex!.flush();
                } catch {}
                // No local snapshotting: rely solely on private scope persistence
                const t1 = performance.now();
                emitDebugEvent({
                    source: "CanvasWrapper",
                    name: "save:done",
                    canvasId: canvas.idString,
                    count: toSave.length,
                    ms: Math.round(t1 - t0),
                });
                debugLog("Saved", toSave.length, "rects");
                return toSave;
            } catch (error) {
                debugLog("Failed to save", error);
                showError({
                    message: "Failed to save",
                    error,
                    severity: "error",
                });
            } finally {
                savingRef.current = false;
                setIsSaving(false);
            }
        },
        [debugLog]
    ); // stable, uses refs

    // ------------------------------------------------------------------
    //  reset & effects
    // ------------------------------------------------------------------
    const reset = () => {
        if (savingRef.current) {
            return;
        }
        debugLog("reset pending rects", pendingRects.length);
        setPendingRects((prev) => {
            const next: Element[] = [] as any;
            logPendingDiff(prev as any, next as any, "reset");
            return next;
        });
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
        if (!canvasDB.initialized)
            throw new Error("Expecting canvas to be open");
    }, [
        peer?.identity.publicKey.hashcode(),
        canvasDB?.idString,
        publicScope?.idString,
    ]);

    // No local hydration; empty UI will be decided by TextCanvas once queries are ready

    const _onContentChange = async (el: Element) => {
        if (
            rects.length === 0 &&
            pendingRectsRef.current.length === 1 &&
            rectIsStaticMarkdownText(el)
        ) {
            setText(el.content.content.text);
        }
        if (rectIsStaticMarkdownText(el)) {
            const parent = await canvasDB.loadParent();
            if (!parent) {
                console.warn(
                    "Canvas parent not found for element",
                    el.idString
                );
            } else {
                announceReply(parent);
            }
        }

        onContentChange?.([el]);
        contentChangeSubscribers.current.forEach((cb) => cb(el));
    };

    // expose handle
    useImperativeHandle(
        ref,
        () => ({
            savePending, // stable
            insertDefault,
            insertImage,
            mutate,
        }),
        [savePending, insertDefault, insertImage, mutate]
    );

    // register handle (optional external consumers)
    const register = useRegisterCanvasHandle();
    useEffect(() => {
        if (!canvasDB) {
            return;
        }
        const unregister = register?.(
            { savePending, insertDefault, insertImage, mutate },
            { canvasId: canvasDB?.idString }
        );
        return unregister;
    }, [canvasDB, register, savePending, insertDefault, insertImage, mutate]);

    // context value
    const contextValue = useMemo<CanvasContextType>(
        () => ({
            active,
            setActive,
            pendingRects,
            setPendingRects,
            savePending, // stable
            rects: visibleRects,
            isEmpty: derivedIsEmpty,
            hasTextElement: derivedHasTextElement,
            insertDefault,
            removePending,
            canvas: canvasDB,
            onContentChange: _onContentChange,
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
            debug,
        }),
        [
            active,
            pendingRects,
            visibleRects,
            derivedHasTextElement,
            insertDefault,
            removePending,
            canvasDB,
            _onContentChange,
            derivedIsEmpty,
            insertImage,
            mutate,
            text,
            requestAIReply,
            isLoading,
            isSaving,
            placeholder,
            classNameContent,
            debug,
        ]
    );

    return (
        <CanvasContext.Provider value={contextValue}>
            {children}
        </CanvasContext.Provider>
    );
};

export const CanvasWrapper = forwardRef<CanvasHandle, CanvasWrapperProps>(
    _CanvasWrapper
);
