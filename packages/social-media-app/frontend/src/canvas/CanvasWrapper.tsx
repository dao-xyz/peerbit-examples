// CanvasWrapper.tsx
import React, {
    useState,
    useEffect,
    useRef,
    useContext,
    createContext,
} from "react";
import { usePeer, useProgram, useLocal } from "@peerbit/react";
import {
    Canvas as CanvasDB,
    Element,
    Layout,
    IFrameContent,
    ElementContent,
    StaticContent,
    StaticMarkdownText,
    StaticPartialImage,
    StaticImage,
    SimpleWebManifest,
    getOwnedElementsQuery,
    getQualityLessThanOrEqualQuery,
    LOWEST_QUALITY,
    Quality,
} from "@giga-app/interface";
import { randomBytes, sha256Sync, toBase64 } from "@peerbit/crypto";
import { concat, equals } from "uint8arrays";
import { useApps } from "../content/useApps.js";
import { readFileAsImage } from "../content/native/image/utils.js";
import { useErrorDialog } from "../dialogs/useErrorDialog.js";
import { Sort, SortDirection } from "@peerbit/indexer-interface";
import {
    rectIsStaticMarkdownText,
    rectIsStaticPartialImage,
} from "./utils/rect.js";
import { useReplyProgress } from "./reply/useReplyProgress.js";
import { useAIReply } from "../ai/AIReployContext.js";
import { serialize, deserialize } from "@dao-xyz/borsh";

// Extend the context type to include a subscription function.
export interface CanvasContextType {
    editMode: boolean;
    setEditMode: (value: boolean) => void;
    active: Set<Uint8Array>;
    setActive: (value: Set<Uint8Array>) => void;
    pendingRects: Element[];
    setPendingRects: React.Dispatch<
        React.SetStateAction<Element<ElementContent>[]>
    >;
    rects: Element[];
    insertDefault: (options?: {
        app?: SimpleWebManifest;
        increment?: boolean;
        pending?: boolean;
        y?: number | "optimize" | "max";
    }) => Promise<Element | Element[]>;
    removePending: (id: Uint8Array) => void;
    savePending: () => Promise<Element[] | undefined>;
    canvas: CanvasDB;
    onContentChange: (element: Element) => void;
    isEmpty: boolean;
    insertImage: (
        file: File,
        options?: { pending?: boolean; y?: number | "optimize" | "max" }
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
    reduceElementsForViewing: (rects: Element[]) => Element[];
    separateAndSortRects: (rects: Element[]) => {
        text: Element<StaticContent<StaticMarkdownText>>[];
        other: Element[];
    };
    text: string;
    setRequestAIReply: (boolean: boolean) => void;
    requestAIReply: boolean;
    // <-- New subscription function!
    subscribeContentChange: (
        callback: (element: Element) => void
    ) => () => void;
}

export const CanvasContext = createContext<CanvasContextType | undefined>(
    undefined
);

export const useCanvas = () => {
    const context = useContext(CanvasContext);
    if (!context) {
        throw new Error("useCanvas must be used within a CanvasWrapper");
    }
    return context;
};

interface CanvasWrapperProps {
    children: React.ReactNode;
    canvas: CanvasDB;
    draft?: boolean;
    onSave?: () => void | Promise<void>;
    multiCanvas?: boolean;
    onContentChange?: (elements: Element[]) => void;
    quality?: Quality;
}

export const CanvasWrapper = ({
    children,
    canvas: canvasDB,
    draft,
    onSave,
    multiCanvas,
    onContentChange,
    quality,
}: CanvasWrapperProps) => {
    // Standard hooks & context from your existing code.
    const { peer } = usePeer();
    const { program: canvas } = useProgram(canvasDB, {
        existing: "reuse",
        id: canvasDB?.idString,
        keepOpenOnUnmount: true,
    });
    const setupForCanvasIdDone = useRef<string | undefined>(undefined);
    const { request } = useAIReply();
    const [requestAIReply, setRequestAIReply] = useState(false);
    const { getCuratedNativeApp: getNativeApp } = useApps();
    const { showError } = useErrorDialog();
    const [editMode, setEditMode] = useState(!!draft);
    const [isEmpty, setIsEmpty] = useState(true);
    const { announceReply } = useReplyProgress();
    const rects = useLocal(
        canvas?.loadedElements ? canvas?.elements : undefined,
        {
            id: canvas?.idString,
            query:
                !canvas || canvas.closed
                    ? { query: { id: new Uint8Array(0) } } // use local seems to be really flaky?? we need this to prevent loading all elements by mistake
                    : {
                          query: [
                              ...getOwnedElementsQuery(canvas),
                              ...getQualityLessThanOrEqualQuery(
                                  quality ?? LOWEST_QUALITY
                              ),
                          ],
                          sort: [
                              new Sort({
                                  key: ["quality"],
                                  direction: SortDirection.ASC,
                              }),
                              new Sort({ key: ["location", "y"] }),
                          ],
                      },
            debug: canvas && canvas.path.length > 0,
        }
    );
    const [pendingRects, setPendingRects] = useState<Element[]>([]);
    const pendingCounter = useRef(0);
    const [active, setActive] = useState<Set<Uint8Array>>(new Set());
    const latestBreakpoint = useRef<"xxs" | "md">("md");
    const [text, setText] = useState<string>("");

    // --- New: Set up a subscription mechanism for content changes ---
    const contentChangeSubscribers = useRef(
        new Set<(element: Element) => void>()
    );

    const subscribeContentChange = (callback: (element: Element) => void) => {
        contentChangeSubscribers.current.add(callback);
        // Return an unsubscribe function.
        return () => {
            contentChangeSubscribers.current.delete(callback);
        };
    };

    // --- The rest of your functions remain unchanged ---
    const getOptimalInsertLocation = (content: ElementContent) => {
        if (rectIsStaticMarkdownText({ content })) {
            return 0;
        }
        const locationOfTopMostText = (): number | undefined => {
            return pendingRects
                .filter((x) => rectIsStaticMarkdownText(x))
                .sort((x, y) => x.location.y - y.location.y)[0]?.location.y;
        };
        let insertionLocation = locationOfTopMostText();
        if (insertionLocation == null || insertionLocation < 0) {
            insertionLocation = 0;
        }
        return insertionLocation;
    };

    const getMaxYPlus1 = (from: Element[]) => {
        const maxY = from
            .map((x) => x.location)
            .filter((x) => x.breakpoint === latestBreakpoint.current)
            .reduce((prev, current) => Math.max(current.y, prev), -1);
        return maxY != null ? maxY + 1 : 0;
    };

    const reduceYInPending = (fromY: number) => {
        const allPending = pendingRects;
        for (const element of allPending.sort(
            (x, y) => x.location.y - y.location.y
        )) {
            if (element.location.y >= fromY) {
                element.location.y--;
            }
        }
    };

    const mutate = (
        fn: (element: Element<ElementContent>, ix: number) => boolean,
        options?: { filter: (rect: Element) => boolean }
    ): boolean => {
        if (!canvas?.publicKey.equals(peer?.identity.publicKey)) {
            return false;
        }
        let mutatedOnce = false;

        // Create a new array for pending mutations.
        let updatedPending = [...pendingRects];

        // Process already pending elements.
        for (let i = 0; i < updatedPending.length; i++) {
            const element = updatedPending[i];
            if (options?.filter && !options.filter(element)) {
                continue;
            }
            const mutated = fn(element, i);
            if (mutated) {
                // The element has been mutated; update it in the pending array.
                updatedPending[i] = element;
                mutatedOnce = true;
            }
        }

        // Process elements from rects that are not yet in pending.
        for (let i = 0; i < rects.length; i++) {
            const element = rects[i];
            // Skip if already in pending.
            if (updatedPending.some((e) => e.idString === element.idString)) {
                continue;
            }
            if (options?.filter && !options.filter(element)) {
                continue;
            }
            const mutated = fn(element, i);
            if (mutated) {
                // Add the mutated element to pending.
                updatedPending.push(element);
                mutatedOnce = true;
            }
        }
        // Update the state so that any useEffect dependent on pendingRects is notified.
        if (mutatedOnce) {
            setPendingRects(updatedPending);
        }
        return mutatedOnce;
    };

    // Overloaded addRect function.
    async function addRect(
        content: ElementContent,
        options?: {
            id?: Uint8Array;
            pending?: boolean;
            y?: number | "optimize" | "max";
        }
    ): Promise<Element>;
    async function addRect(
        contents: ElementContent[],
        options?: { pending?: boolean; y?: number | "optimize" | "max" }
    ): Promise<Element[]>;
    async function addRect(
        contentOrContents: ElementContent | ElementContent[],
        options: {
            id?: Uint8Array;
            pending?: boolean;
            y?: number | "optimize" | "max";
        } = { pending: false }
    ): Promise<Element | Element[]> {
        const oneContent = Array.isArray(contentOrContents)
            ? contentOrContents[0]
            : contentOrContents;
        if (!oneContent) {
            throw new Error("Missing content");
        }
        if (options?.id && Array.isArray(contentOrContents)) {
            throw new Error("Cannot set id when adding multiple elements");
        }
        const yStrategy = options.y ?? "optimize";
        await canvas.load();
        const allCurrentRects = await canvas.elements.index.search({
            query: getOwnedElementsQuery(canvas),
        });
        const allPending = pendingRects;
        const all = [...allCurrentRects, ...allPending];
        let y: number | undefined = undefined;
        if (typeof yStrategy === "number") {
            y = yStrategy;
        } else if (yStrategy === "optimize") {
            y = getOptimalInsertLocation(oneContent);
        } else if (yStrategy === "max") {
            y = getMaxYPlus1(all);
        } else {
            throw new Error("Invalid y option");
        }
        for (const element of allPending.sort(
            (a, b) => a.location.y - b.location.y
        )) {
            if (element.location.y >= y) {
                element.location.y++;
            }
        }
        const results: Element[] = [];
        const contents = Array.isArray(contentOrContents)
            ? contentOrContents
            : [contentOrContents];
        for (const content of contents) {
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
                parent: canvas,
            });
            if (options.pending) {
                setPendingRects((prev) => {
                    const prevElement = prev.find(
                        (x) => x.idString === element.idString
                    );
                    if (prevElement) {
                        if (
                            prevElement.content instanceof StaticContent &&
                            prevElement.content.content.isEmpty
                        ) {
                            prevElement.content = element.content;
                            return [...prev];
                        }
                        return prev;
                    }
                    return [...prev, element];
                });
            } else {
                console.log("Save pending into", canvas.elements);
                canvas.elements.put(element);
            }
            results.push(element);
        }
        return Array.isArray(contentOrContents) ? results : results[0];
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
        } catch (error) {
            showError({ message: "Failed to insert image", error });
        }
    };

    const insertDefault = (options?: {
        app?: SimpleWebManifest;
        increment?: boolean;
        pending?: boolean;
        y?: number | "optimize" | "max";
    }) => {
        if (options?.increment) {
            const last = pendingRects[pendingRects.length - 1];
            if (
                !multiCanvas &&
                last &&
                last.content instanceof StaticContent &&
                last.content.content.isEmpty
            ) {
                // Do not increment; instead, replace it.
            } else {
                pendingCounter.current++;
            }
            setIsEmpty(false);
        }
        const defaultId = sha256Sync(
            concat([
                canvas.id,
                peer.identity.publicKey.bytes,
                new Uint8Array([pendingCounter.current]),
            ])
        );
        let appToAdd: ElementContent;
        if (options?.app) {
            if (options.app.isNative) {
                const native = getNativeApp(options.app.url);
                if (!native) {
                    throw new Error(
                        "Missing native app for url: " + options.app.url
                    );
                }
                const defaultValue = native.default();
                appToAdd = new StaticContent({
                    content: defaultValue,
                    quality: LOWEST_QUALITY,
                    contentId: randomBytes(32),
                });
            } else {
                appToAdd = new IFrameContent({
                    resizer: false,
                    src: options.app.url,
                });
            }
        } else {
            appToAdd = new StaticContent({
                content: new StaticMarkdownText({ text: "" }),
                quality: LOWEST_QUALITY,
                contentId: sha256Sync(new TextEncoder().encode("")),
            });
        }
        return addRect(appToAdd, {
            id: defaultId,
            pending: true,
            y: options?.y,
        });
    };

    const removePending = (id: Uint8Array) => {
        const pending = pendingRects.find((x) => equals(x.id, id));
        setPendingRects((prev) => prev.filter((el) => !equals(id, el.id)));
        if (pending) {
            reduceYInPending(pending.location.y);
        }
    };

    const savePending = async () => {
        if (!pendingRects) return;
        try {
            const pendingToSave = pendingRects.filter(
                (x) =>
                    x.content instanceof StaticContent === false ||
                    x.content.content.isEmpty === false
            );
            if (pendingToSave.length === 0) {
                console.log("No pending to save", pendingRects);
                return;
            }
            setPendingRects([]);
            pendingCounter.current += pendingToSave.length;

            // re-assign parent to canvas (TODO - remove this, when we have eliminated flaky parent updatnig behaviour that happens during save)
            // (when update the path of a canvas while concurrently saving we might run into problems)
            for (const element of pendingToSave) {
                element.parent = canvas;
            }

            await Promise.all(pendingToSave.map((x) => canvas.elements.put(x)));
            if (draft && onSave) {
                await onSave();
            }
            if (requestAIReply) {
                request(canvas).catch((e) => {
                    console.error("Error requesting AI reply", e);
                });
            }
            setIsEmpty(true);
            return pendingToSave;
        } catch (error) {
            showError({ message: "Failed to save", error, severity: "error" });
        }
    };

    const reset = () => {
        setPendingRects([]);
    };

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            setActive(new Set());
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, []);

    useEffect(() => {
        if (!peer || !canvas || canvas.closed) return;

        if (canvas.idString === setupForCanvasIdDone.current) {
            return;
        }
        setupForCanvasIdDone.current = canvas.idString;
        reset();

        if (canvas?.closed) {
            throw new Error("Expecting canvas to be open");
        }
        if (draft) {
            insertDefault();
        }
    }, [peer?.identity.publicKey.hashcode(), canvas?.idString]);

    // Modified content change handler that notifies subscribers.
    const _onContentChange = async (element: Element) => {
        if (
            rects.length === 0 &&
            pendingRects.length === 1 &&
            rectIsStaticMarkdownText(element)
        ) {
            setText(element.content.content.text);
        }
        if (rectIsStaticMarkdownText(element)) {
            const parent = await canvas.loadParent();
            announceReply(parent);
        }
        if (!element.content.isEmpty) {
            setIsEmpty(false);
        } else {
            const allElements = [...pendingRects, ...rects];
            if (allElements.every((el) => el.content.isEmpty)) {
                setIsEmpty(true);
            }
        }
        if (onContentChange) {
            onContentChange([element]);
        }
        // Notify all subscribers about the change.
        contentChangeSubscribers.current.forEach((callback) =>
            callback(element)
        );
    };

    const reduceElementsForViewing = (rects: Element[]): Element[] => {
        // Group rects by their content source, identified by contentId (as Base64).
        const groups = new Map<string, Map<number, Element[]>>();
        rects.forEach((rect) => {
            const contentId = rect.content.contentIdString;
            if (!groups.has(contentId)) {
                groups.set(contentId, new Map());
            }
            const quality = rect.content.quality; // quality is already a number
            const qualityMap = groups.get(contentId)!;
            if (!qualityMap.has(quality)) {
                qualityMap.set(quality, []);
            }
            qualityMap.get(quality)!.push(rect);
        });

        const finalRects: Element[] = [];

        // For each content source, choose the candidate with the best available quality.
        groups.forEach((qualityMap) => {
            // Get the sorted quality keys in descending order.
            const qualityKeys = Array.from(qualityMap.keys()).sort(
                (a, b) => b - a
            );
            if (qualityKeys.length === 0) return;
            const bestQuality = qualityKeys[0];
            const candidates = qualityMap.get(bestQuality)!;

            // Separate candidates into full images and partial images.
            const fullImages = candidates.filter(
                (rect) => !rectIsStaticPartialImage(rect)
            );
            const partialImages = candidates.filter((rect) =>
                rectIsStaticPartialImage(rect)
            );

            let bestCandidate: Element | undefined = undefined;
            if (partialImages.length > 0) {
                // Check whether partial images are complete.
                const firstPartial = partialImages[0].content
                    .content as StaticPartialImage;
                if (firstPartial.totalParts === partialImages.length) {
                    // If complete, merge partial images into a single image.
                    const mergedImage = StaticPartialImage.combine(
                        partialImages.map(
                            (r) => r.content.content as StaticPartialImage
                        )
                    );
                    const rep = partialImages[0] as Element<StaticContent>;
                    bestCandidate = new Element({
                        publicKey: rep.publicKey,
                        id: rep.id,
                        location: rep.location,
                        content: new StaticContent({
                            quality: rep.content.quality,
                            content: mergedImage,
                            contentId: rep.content.contentId,
                        }),
                        parent: rep.parent,
                    });
                } else {
                    // Otherwise, use the first partial image (even though it may be incomplete).
                    bestCandidate = partialImages[0];
                }
            } else if (fullImages.length > 0) {
                // If no partial images, use the first full image.
                bestCandidate = fullImages[0];
            }
            if (bestCandidate) {
                finalRects.push(bestCandidate);
            }
        });

        // Sort the final elements by the y coordinate.
        finalRects.sort((a, b) => a.location.y - b.location.y);
        return finalRects;
    };

    const separateAndSortRects = (
        rects: Element[]
    ): {
        text: Element<StaticContent<StaticMarkdownText>>[];
        other: Element[];
    } => {
        const groupedRects = reduceElementsForViewing(rects);
        const separated = {
            text: [] as Element<StaticContent<StaticMarkdownText>>[],
            other: [] as Element[],
        };
        groupedRects.forEach((rect) => {
            if (rectIsStaticMarkdownText(rect)) {
                separated.text.push(rect);
            } else {
                separated.other.push(rect);
            }
        });
        separated.text.sort((a, b) => a.location.y - b.location.y);
        separated.other.sort((a, b) => a.location.y - b.location.y);
        return separated;
    };

    const contextValue: CanvasContextType = {
        editMode,
        setEditMode,
        active,
        isEmpty,
        setActive,
        pendingRects,
        setPendingRects,
        rects,
        insertDefault,
        removePending,
        savePending,
        canvas,
        onContentChange: _onContentChange,
        insertImage,
        mutate,
        reduceElementsForViewing,
        separateAndSortRects,
        text,
        requestAIReply,
        setRequestAIReply,
        subscribeContentChange,
    };

    return (
        <CanvasContext.Provider value={contextValue}>
            {children}
        </CanvasContext.Provider>
    );
};
