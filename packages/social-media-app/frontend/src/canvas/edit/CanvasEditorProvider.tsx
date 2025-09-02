// edit/CanvasEditorProvider.tsx  (wrapper that owns the toolbar context)
import React, { useState, createContext, useContext } from "react";
import type { Canvas, IndexableCanvas } from "@giga-app/interface";
import type { WithIndexedContext } from "@peerbit/document";
import { DraftEditor } from "./draft/DraftEditor";
import { CanvasWrapper } from "../CanvasWrapper";
import { AutoReplyProvider } from "../AutoReplyContext";
import { DraftSessionProvider } from "./draft/DraftSession";

/* ────────────────────────────────────────────────────────────────────────────
 * Toolbar UI state
 * ──────────────────────────────────────────────────────────────────────────── */

interface ToolbarContextType {
    appSelectOpen: boolean;
    setAppSelectOpen: React.Dispatch<React.SetStateAction<boolean>>;
}
const ToolbarContext = createContext<ToolbarContextType | undefined>(undefined);

const ToolbarProviderContextComponent: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [appSelectOpen, setAppSelectOpen] = useState(false);
    return (
        <ToolbarContext.Provider value={{ appSelectOpen, setAppSelectOpen }}>
            {children}
        </ToolbarContext.Provider>
    );
};

export const useEditTools = () => {
    const ctx = useContext(ToolbarContext);
    if (!ctx) throw new Error("useToolbar must be used within a ToolbarProvider");
    return ctx;
};

/* ────────────────────────────────────────────────────────────────────────────
 * ExistingCanvasEditor — edits an existing canvas (no draft session)
 * ──────────────────────────────────────────────────────────────────────────── */

const ExistingCanvasEditor: React.FC<{
    children: React.ReactNode;
    canvas: WithIndexedContext<Canvas, IndexableCanvas>;
    placeholder?: string;
    classNameContent?: string;
}> = ({ children, canvas, placeholder, classNameContent }) => {
    return (
        <CanvasWrapper
            canvas={canvas}
            draft={false}
            multiCanvas
            placeholder={placeholder}
            classNameContent={classNameContent}
        >
            {/* No auto-reply logic for the viewRoot editor */}
            {children}
        </CanvasWrapper>
    );
};

/* ────────────────────────────────────────────────────────────────────────────
 * CanvasEditorProvider
 * - If `replyTo` provided -> mount a DraftSession (drafting flow)
 * - Else if `canvas` provided -> edit that canvas directly (no draft created)
 * ──────────────────────────────────────────────────────────────────────────── */

export const CanvasEditorProvider: React.FC<{
    children: React.ReactNode;

    // Use exactly one of these:
    canvas?: WithIndexedContext<Canvas, IndexableCanvas>;
    replyTo?: WithIndexedContext<Canvas, IndexableCanvas>;

    // Optional knobs
    sessionKey?: Uint8Array;         // share one draft across multiple toolbars (draft mode only)
    autoSave?: boolean;              // draft mode: enable debounced saves on content changes
    autoReply?: boolean;             // draft mode: enable auto-reply targeting
    placeholder?: string;
    classNameContent?: string;
    debug?: boolean;               // log if neither canvas nor replyTo provided
}> = ({
    children,
    canvas,
    replyTo,
    sessionKey,
    autoSave,
    autoReply,
    placeholder,
    classNameContent,
    debug
}) => {
        // Drafting path (reply composer etc.)
        if (replyTo) {
            return (
                <DraftSessionProvider replyTo={replyTo} keyish={sessionKey} >
                    <DraftEditor
                        autoSave={autoSave}
                        autoReply={autoReply}
                        placeholder={placeholder}
                        classNameContent={classNameContent}
                        debug={debug}
                    >
                        <ToolbarProviderContextComponent>{children}</ToolbarProviderContextComponent>
                    </DraftEditor>
                </DraftSessionProvider>
            );
        }

        // Existing canvas path (outer editor for viewRoot)
        if (canvas) {
            return (
                <ExistingCanvasEditor canvas={canvas} placeholder={placeholder} classNameContent={classNameContent}>

                    <ToolbarProviderContextComponent>{children}</ToolbarProviderContextComponent>
                </ExistingCanvasEditor>
            );
        }

        // Nothing to edit — render nothing but log for visibility
        if (process.env.NODE_ENV !== "production") {
            console.error(
                "[CanvasEditorProvider] You must provide either `replyTo` (draft mode) or `canvas` (existing)."
            );
        }
        return null;
    };