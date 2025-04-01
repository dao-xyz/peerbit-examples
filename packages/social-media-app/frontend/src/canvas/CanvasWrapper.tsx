import {
    useState,
    useEffect,
    useRef,
    useContext,
    createContext,
    useReducer,
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
} from "@giga-app/interface";
import { fromBase64, sha256Base64Sync, sha256Sync } from "@peerbit/crypto";
import { concat, equals } from "uint8arrays";
import { useApps } from "../content/useApps.js";
import { readFileAsImage } from "../content/native/image/utils.js";
import { useErrorDialog } from "../dialogs/useErrorDialog.js";
import { Sort } from "@peerbit/indexer-interface";
import {
    rectIsStaticMarkdownText,
    rectIsStaticPartialImage,
} from "./utils/rect.js";
import { useReplyProgress } from "./reply/useReplyProgress.js";
import { useAIReply } from "../ai/AIReployContext.js";

interface CanvasContextType {
    editMode: boolean;
    setEditMode: (value: boolean) => void;
    active: Set<Uint8Array>;
    setActive: (value: Set<Uint8Array>) => void;
    pendingRects: Element[];
    rects: Element[];
    insertDefault: (options?: {
        app?: SimpleWebManifest;
        increment?: boolean;
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
        rect: { id: Uint8Array },
        fn: (
            element: Element<ElementContent>,
            ix: number
        ) => Promise<boolean> | boolean
    ) => Promise<void>;

    // NEW: Grouping & filtering functions
    groupPartialImages: (rects: Element[]) => Element[];
    separateAndSortRects: (rects: Element[]) => {
        text: Element[];
        other: Element[];
    };
    text: string;
    setRequestAIReply: (boolean: boolean) => void;
    requestAIReply: boolean;
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
    onContentChange?: (element: Element[]) => void;
}

export const CanvasWrapper = ({
    children,
    canvas: canvasDB,
    draft,
    onSave,
    multiCanvas,
    onContentChange,
}: CanvasWrapperProps) => {
    const { peer } = usePeer();
    const { program: canvas } = useProgram(canvasDB, {
        existing: "reuse",
        id: canvasDB?.idString,
        keepOpenOnUnmount: true,
    });
    const { request: request } = useAIReply();
    const [requestAIReply, setRequestAIReply] = useState(false);

    const { getCuratedNativeApp: getNativeApp } = useApps();
    const { showError } = useErrorDialog();

    const [editMode, setEditMode] = useState(!!draft);
    const [isEmpty, setIsEmpty] = useState(true);
    const { announceReply } = useReplyProgress();

    const resizeSizes = useRef(
        new Map<number, { width: number; height: number }>()
    );
    const rects = useLocal(
        canvas?.loadedElements ? canvas?.elements : undefined,
        {
            id: canvas?.idString,
            query:
                !canvas || canvas.closed
                    ? undefined
                    : {
                          query: getOwnedElementsQuery(canvas),
                          sort: new Sort({ key: ["location", "y"] }),
                      },
            debug: canvas && canvas.path.length > 0,
        }
    );
    const [pendingRects, setPendingRects] = useState<Element[]>([]);
    const pendingCounter = useRef(0);
    const [active, setActive] = useState<Set<Uint8Array>>(new Set());
    const latestBreakpoint = useRef<"xxs" | "md">("md");
    const [text, setText] = useState<string | undefined>(); // this is a variable that holds the aggregated available text in the canvas

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

    const mutate = async (
        rect: { id: Uint8Array },
        fn: (
            element: Element<ElementContent>,
            ix: number
        ) => Promise<boolean> | boolean
    ) => {
        if (!canvas?.publicKey.equals(peer?.identity.publicKey)) {
            return;
        }
        const pending = pendingRects.find((pending) =>
            equals(pending.id, rect.id)
        );
        const index = rects.findIndex((pending) => equals(pending.id, rect.id));
        if (pending) {
            await fn(pending, index);
            return;
        }
        const existing = rects[index];
        if (!existing) {
            throw new Error(
                "Missing rects in existing and pending. Index: " +
                    index +
                    ". Rects: " +
                    rects.length
            );
        }
        const mutated = await fn(existing, index);
        if (mutated) {
            await canvas.elements.put(existing);
        }
    };

    // Overloaded addRect function:
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
                    const prevElement = prev.find((x) =>
                        equals(x.id, element.id)
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
                canvas.elements.put(element);
            }
            results.push(element);
        }
        return Array.isArray(contentOrContents) ? results : results[0];
    }

    // New function: Inserts an image element into the canvas using Uint8Array data.
    const insertImage = async (
        file: File,
        options?: { pending?: boolean; y?: number | "optimize" | "max" }
    ) => {
        try {
            const threshold = 3 * 1024 * 1024;
            const image = await readFileAsImage(file);
            console.log("FILE SIZE", file.size);
            if (file.size > threshold) {
                const fullData = image.data;
                const chunkSize = threshold;
                const parts: Uint8Array[] = [];
                for (let i = 0; i < fullData.length; i += chunkSize) {
                    parts.push(fullData.slice(i, i + chunkSize));
                }
                const totalParts = parts.length;
                const groupKey = sha256Base64Sync(fullData);
                const partialImages = parts.map(
                    (partialData, index) =>
                        new StaticPartialImage({
                            partialData,
                            partIndex: index,
                            totalParts,
                            mimeType: file.type,
                            width: image.width,
                            height: image.height,
                            alt: image.alt,
                            caption: image.caption,
                            groupKey,
                        })
                );
                const newElements: Element<ElementContent>[] = await addRect(
                    partialImages.map((x) => new StaticContent({ content: x })),
                    options
                );
                console.log({
                    newElements: newElements.map((x) =>
                        x.content["content"] instanceof StaticPartialImage
                            ? x.content["content"].partialData.length
                            : 0
                    ),
                });
                setIsEmpty(false);
                onContentChange?.(newElements);
            } else {
                const element = await addRect(
                    new StaticContent({
                        content: new StaticImage({
                            data: image.data,
                            mimeType: file.type,
                            width: image.width,
                            height: image.height,
                            alt: image.alt,
                            caption: image.caption,
                        }),
                    }),
                    options
                );
                setIsEmpty(false);
                onContentChange?.([element]);
            }
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
        console.log("savePending?", pendingRects);
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
        resizeSizes.current = new Map();
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
        if (!peer || !canvas) return;
        reset();
        if (canvas?.closed) {
            throw new Error("Expecting canvas to be open");
        }
        if (draft) {
            insertDefault();
        }
    }, [
        peer?.identity.publicKey.hashcode(),
        !canvas || canvas?.closed ? undefined : canvas.address,
    ]);

    const _onContentChange = async (element: Element) => {
        // we only have 1 element and the elemnt is a text element then set the aggregated text
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
    };

    // Group partial images: if all parts are present, combine them.
    const groupPartialImages = (rects: Element[]): Element[] => {
        const grouped = new Map<
            string,
            { rects: Element[]; parts: StaticPartialImage[] }
        >();
        const finalRects: Element[] = [];
        rects.forEach((rect) => {
            if (rectIsStaticPartialImage(rect)) {
                const partial = rect.content.content as StaticPartialImage;
                const key = partial.groupKey;
                if (!grouped.has(key)) {
                    grouped.set(key, { rects: [], parts: [] });
                }
                const group = grouped.get(key)!;
                group.rects.push(rect);
                group.parts.push(partial);
            } else {
                finalRects.push(rect);
            }
        });
        grouped.forEach((group) => {
            if (
                group.parts.length > 0 &&
                group.parts[0].totalParts === group.parts.length
            ) {
                const combinedImage = StaticPartialImage.combine(group.parts);
                const rep = group.rects[0];
                const combinedRect = new Element({
                    publicKey: rep.publicKey,
                    id: rep.id,
                    location: rep.location,
                    content: new StaticContent({ content: combinedImage }),
                    parent: canvas,
                });
                finalRects.push(combinedRect);
            } else {
                finalRects.push(...group.rects);
            }
        });
        finalRects.sort((a, b) => a.location.y - b.location.y);
        return finalRects;
    };

    // Separate rects into text and non‑text groups, and sort each by y.
    const separateAndSortRects = (
        rects: Element[]
    ): { text: Element[]; other: Element[] } => {
        const groupedRects = groupPartialImages(rects);
        const separated = { text: [] as Element[], other: [] as Element[] };
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

    const [update, forceUpdate] = useReducer((x) => x + 1, 0); // For triggering re‑renders if needed

    const contextValue: CanvasContextType = {
        editMode,
        setEditMode,
        active,
        isEmpty,
        setActive,
        pendingRects,
        rects,
        insertDefault,
        removePending,
        savePending,
        canvas,
        onContentChange: _onContentChange,
        insertImage,
        mutate,
        groupPartialImages,
        separateAndSortRects,
        text,
        requestAIReply,
        setRequestAIReply,
    };

    return (
        <CanvasContext.Provider value={contextValue}>
            {children}
        </CanvasContext.Provider>
    );
};
