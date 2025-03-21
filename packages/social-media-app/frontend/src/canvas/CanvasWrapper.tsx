import { useState, useEffect, useRef, useContext, createContext } from "react";
import { usePeer, useProgram, useLocal } from "@peerbit/react";
import {
    Canvas as CanvasDB,
    Element,
    Layout,
    IFrameContent,
    ElementContent,
    StaticContent,
    StaticMarkdownText,
} from "@dao-xyz/social";
import { sha256Sync } from "@peerbit/crypto";
import { concat, equals } from "uint8arrays";
import { SimpleWebManifest } from "@dao-xyz/social";
import { useApps } from "../content/useApps.js";
import { readFileAsImage } from "../content/native/image/utils.js";
import { useError } from "../dialogs/useErrorDialog.js";
import { Sort } from "@peerbit/indexer-interface";
import { rectIsStaticMarkdownText } from "./utils/rect.js";

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
    }) => void;
    removePending: (id: Uint8Array) => void;
    savePending: () => Promise<Element[] | undefined>;
    canvas: CanvasDB;
    onContentChange: (element: Element) => void;
    isEmpty: boolean;
    // New: Function to insert an image into the canvas
    insertImage: (file: File, options?: { pending?: boolean }) => Promise<void>;
}

export const CanvasContext = createContext<CanvasContextType | undefined>(
    undefined
);

export const useCanvas = () => {
    const context = useContext(CanvasContext);
    if (!context) {
        throw new Error("useCanvas must be used within a CanvasProvider");
    }
    return context;
};

interface CanvasWrapperProps {
    children: React.ReactNode;
    canvas: CanvasDB;
    draft?: boolean;
    onSave?: () => void;
    multiCanvas?: boolean;
    onContentChange?: (element: Element) => void;
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

    const { getCuratedNativeApp: getNativeApp } = useApps();
    const { showError } = useError();

    const [editMode, setEditMode] = useState(!!draft);
    const [isEmpty, setIsEmpty] = useState(true);

    const resizeSizes = useRef(
        new Map<number, { width: number; height: number }>()
    );
    const rects = useLocal(canvas?.elements, {
        id: canvas?.idString,
        query: { sort: new Sort({ key: ["location", "y"] }) },
    });
    const [pendingRects, setPendingRects] = useState<Element[]>([]);
    const pendingCounter = useRef(0);
    const [active, setActive] = useState<Set<Uint8Array>>(new Set());
    const latestBreakpoint = useRef<"xxs" | "md">("md");

    const getOptimalInsertLocation = (content: ElementContent) => {
        if (rectIsStaticMarkdownText({ content })) {
            return 0;
        }
        const locationOfTopMostText = (): number | undefined => {
            return pendingRects
                .filter((x) => {
                    return (
                        x.content instanceof StaticContent &&
                        x.content.content instanceof StaticMarkdownText
                    );
                })
                .sort((x, y) => x.location.y - y.location.y)[0]?.location.y;
        };

        let insertionLocation = locationOfTopMostText();
        if (insertionLocation < 0) {
            insertionLocation = 0;
        }
        return insertionLocation;
    };

    const getMaxYPlus1 = (from: Element[]) => {
        const maxY = from
            .map((x) => x.location)
            .flat()
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

    const addRect = async (
        content: ElementContent,
        options: {
            id?: Uint8Array;
            pending?: boolean;
            y?: number | "optimize" | "max";
        } = { pending: false }
    ) => {
        const yStategy = options.y ?? "optimize";
        const allCurrentRects = await canvas.elements.index.search({});
        const allPending = pendingRects;
        const all = [...allCurrentRects, ...allPending];
        let y: number | undefined = undefined;
        if (typeof yStategy === "number") {
            y = yStategy;
        } else if (yStategy === "optimize") {
            y = getOptimalInsertLocation(content);
        } else if (yStategy === "max") {
            y = getMaxYPlus1(all);
        } else {
            throw new Error("Invalid y option");
        }
        // justify the y position of all affected elements
        for (const element of allPending.sort(
            (x, y) => x.location.y - y.location.y
        )) {
            if (element.location.y >= y) {
                element.location.y++;
            }
        }

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
        });

        if (options.pending) {
            setPendingRects((prev) => {
                const prevElement = prev.find((x) => equals(x.id, element.id));
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

        return element;
    };

    // New function: Inserts an image element into the canvas
    const insertImage = async (
        file: File,
        options?: { pending?: boolean; y?: number | "optimize" | "max" }
    ) => {
        // Create an object URL for immediate preview.
        try {
            const image = await readFileAsImage(file);
            const element = await addRect(
                new StaticContent({ content: image }),
                options
            );
            setIsEmpty(false);
            onContentChange(element);
        } catch (error) {
            showError("Failed to insert image", error);
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
                // if we are describing multiple canvases, dont try to replace some empty content
                // because one element might dissapear from one Canvas and appear in another
                !multiCanvas &&
                // check if the "last" element is empty
                last &&
                last.content instanceof StaticContent &&
                last.content.content.isEmpty
            ) {
                // Do not increment, instead replace it
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
        reduceYInPending(pending.location.y);
    };

    const savePending = async () => {
        if (!pendingRects) return;
        try {
            const pendingToSave = pendingRects.filter(
                (x) =>
                    x.content instanceof StaticContent === false ||
                    x.content.content.isEmpty === false
            );

            if (pendingToSave.length === 0) return;
            setPendingRects([]);
            pendingCounter.current += pendingToSave.length;
            await Promise.all(pendingToSave.map((x) => canvas.elements.put(x)));
            if (draft && onSave) {
                onSave();
            }
            setIsEmpty(true);
            return pendingToSave;
        } catch (error) {
            showError("Failed to save", error);
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

    const _onContentChange = (element: Element) => {
        if (!element.content.isEmpty) {
            setIsEmpty(false);
        } else {
            // TODO handle the oppoisite direcftion (isEmpty to true) better
            const allElements = [...pendingRects, ...rects];
            if (allElements.every((el) => el.content.isEmpty)) {
                setIsEmpty(true);
            }
        }

        if (onContentChange) {
            onContentChange(element);
        }
    };

    const contextValue = {
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
        insertImage, // <--- expose the new function
    };

    return (
        <CanvasContext.Provider value={contextValue}>
            {children}
        </CanvasContext.Provider>
    );
};
