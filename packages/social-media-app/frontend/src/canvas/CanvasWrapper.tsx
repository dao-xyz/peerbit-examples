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
    AbstractStaticContent,
    StaticImage,
} from "@dao-xyz/social";
import { sha256Sync } from "@peerbit/crypto";
import { concat, equals } from "uint8arrays";
import { SimpleWebManifest } from "@dao-xyz/app-service";
import { useApps } from "../content/useApps.js";
import { readFileAsImage } from "../content/native/image/utils.js";
import { useError } from "../dialogs/useErrorDialog.js";

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

    const { getNativeApp } = useApps();
    const { showError } = useError();

    const [editMode, setEditMode] = useState(!!draft);
    const resizeSizes = useRef(
        new Map<number, { width: number; height: number }>()
    );
    const rects = useLocal(canvas?.elements);
    const [pendingRects, setPendingRects] = useState<Element[]>([]);
    const pendingCounter = useRef(0);
    const [active, setActive] = useState<Set<Uint8Array>>(new Set());
    const latestBreakpoint = useRef<"xxs" | "md">("md");

    const addRect = async (
        content: ElementContent,
        options: { id?: Uint8Array; pending?: boolean } = { pending: false }
    ) => {
        const allCurrentRects = await canvas.elements.index.search({});
        const allPending = pendingRects;
        const maxY = [...allCurrentRects, ...allPending]
            .map((x) => x.location)
            .flat()
            .filter((x) => x.breakpoint === latestBreakpoint.current)
            .reduce(
                (prev, current) => Math.max(current.y + current.h, prev),
                -1
            );

        const element = new Element({
            publicKey: peer.identity.publicKey,
            id: options.id,
            location: [
                new Layout({
                    breakpoint: latestBreakpoint.current,
                    x: 0,
                    y: maxY != null ? maxY + 1 : 0,
                    z: 0,
                    w: 1,
                    h: 1,
                }),
            ],
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
    };

    // New function: Inserts an image element into the canvas
    const insertImage = async (file: File, options?: { pending?: boolean }) => {
        // Create an object URL for immediate preview.

        try {
            const image = await readFileAsImage(file);
            await addRect(new StaticContent({ content: image }), options);
        } catch (error) {
            showError("Failed to insert image", error);
        }
    };

    const insertDefault = (options?: {
        app?: SimpleWebManifest;
        increment?: boolean;
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
        }
        const defaultId = sha256Sync(
            concat([
                canvas.id,
                peer.identity.publicKey.bytes,
                new Uint8Array([pendingCounter.current]),
            ])
        );
        let appToAdd: AbstractStaticContent;
        if (options?.app) {
            const native = getNativeApp(options.app.url);
            if (!native) {
                throw new Error("Missing native app");
            }
            const defaultValue = native.default();
            appToAdd = defaultValue;
        } else {
            appToAdd = new StaticMarkdownText({ text: "" });
        }
        return addRect(
            new StaticContent({
                content: appToAdd,
            }),
            { id: defaultId, pending: true }
        );
    };

    const removePending = (id: Uint8Array) => {
        setPendingRects((prev) => prev.filter((el) => !equals(id, el.id)));
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

    const contextValue = {
        editMode,
        setEditMode,
        active,
        setActive,
        pendingRects,
        rects,
        insertDefault,
        removePending,
        savePending,
        canvas,
        onContentChange,
        insertImage, // <--- expose the new function
    };

    return (
        <CanvasContext.Provider value={contextValue}>
            {children}
        </CanvasContext.Provider>
    );
};
