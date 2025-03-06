/**
 * Canvas context and wrapper component for managing canvas state and operations
 */

import { useState, useEffect, useRef, useReducer } from "react";
import { inIframe, useLocal, usePeer, useProgram } from "@peerbit/react";
import {
    Canvas as CanvasDB,
    Element,
    Layout,
    IFrameContent,
    ElementContent,
    StaticContent,
    StaticMarkdownText,
    AbstractStaticContent,
} from "@dao-xyz/social";
import { sha256Sync } from "@peerbit/crypto";
import { concat, equals } from "uint8arrays";
import { SimpleWebManifest } from "@dao-xyz/app-service";
import { createContext, useContext } from "react";
import { useApps } from "../content/useApps.js";

/**
 * Type definition for canvas context values and methods
 */
interface CanvasContextType {
    editMode: boolean; // Whether canvas is in edit mode
    setEditMode: (value: boolean) => void;
    active: Set<number>; // Set of active element indices
    setActive: (value: Set<number>) => void;
    pendingRects: Element[]; // Elements pending save
    rects: Element[]; // Saved elements
    insertDefault: (options?: {
        app?: SimpleWebManifest;
        increment?: boolean;
    }) => void; // Insert default element
    removePending: (ix: number) => void; // Remove pending element
    savePending: () => Promise<Element[] | undefined>; // Save pending elements
    canvas: CanvasDB; // Canvas database instance
}

// Create context for canvas state
export const CanvasContext = createContext<CanvasContextType | undefined>(
    undefined
);

/**
 * Hook to access canvas context
 */
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
}

/**
 * Wrapper component that provides canvas context and state management
 */
export const CanvasWrapper = ({
    children,
    canvas: canvasDB,
    draft,
    onSave,
}: CanvasWrapperProps) => {
    const { peer } = usePeer();
    const { program: canvas } = useProgram(canvasDB, {
        existing: "reuse",
        id: canvasDB?.idString,
        keepOpenOnUnmount: true,
    });
    const { getNativeApp } = useApps();

    // State management
    const [editMode, setEditMode] = useState(draft);
    const resizeSizes = useRef<Map<number, { width: number; height: number }>>(
        new Map()
    );
    const rects = useLocal(canvas?.elements);
    const [pendingRects, setPendingRects] = useState<Element[]>([]);
    const pendingCounter = useRef(0);
    const [active, setActive] = useState<Set<number>>(new Set());
    const latestBreakpoint = useRef<"xxs" | "md">("md");

    /**
     * Adds a new rectangle element to the canvas
     */
    const addRect = async (
        content: ElementContent,
        options: { id?: Uint8Array; pending: boolean } = { pending: false }
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

    /**
     * Saves pending elements to the canvas
     */
    const savePending = async () => {
        if (!pendingRects) return;
        const pendingToSave = pendingRects.filter(
            (x) =>
                x.content instanceof StaticContent === false ||
                x.content.content.isEmpty === false
        );
        if (pendingToSave.length === 0) return;
        setPendingRects([]);
        pendingCounter.current += pendingToSave.length;
        await Promise.all(pendingToSave.map((x) => canvas.elements.put(x)));
        if (draft) {
            onSave();
        }
        return pendingToSave;
    };

    /**
     * Resets canvas state
     */
    const reset = () => {
        setPendingRects([]);
        resizeSizes.current = new Map();
    };

    /**
     * Inserts a default element into the canvas, that is a StaticContent (text) element
     */
    const insertDefault = (options?: {
        app?: SimpleWebManifest;
        increment?: boolean;
    }) => {
        if (options?.increment) {
            const last = pendingRects[pendingRects.length - 1];
            if (
                last &&
                last.content instanceof StaticContent &&
                last.content.content.isEmpty
            ) {
                // Do not increment
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

    /**
     * Removes a pending element
     */
    const removePending = (ix: number) => {
        setPendingRects((prev) => prev.filter((_, i) => i !== ix));
    };

    // Clear active elements when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            setActive(new Set());
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, []);

    // Initialize canvas state
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
    };

    return (
        <CanvasContext.Provider value={contextValue}>
            {children}
        </CanvasContext.Provider>
    );
};
