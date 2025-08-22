// ToolbarContext.tsx
import React, {
    useState,
    createContext,
    ReactNode,
    useContext,
} from "react";
import { CanvasWrapper, useCanvas } from "../CanvasWrapper";
import {
    PendingCanvasProvider,
    usePendingCanvas,
} from "./PendingCanvasContext";
import { AutoReplyProvider } from "../AutoReplyContext";
import { Canvas, ChildVisualization, Layout } from "@giga-app/interface";

interface ToolbarContextType {
    appSelectOpen: boolean;
    setAppSelectOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

// Create the context (using undefined as default to catch missing provider)
const ToolbarContext = createContext<ToolbarContextType | undefined>(undefined);

type ToolbarProviderProps = {
    children: ReactNode;
    pendingCanvas?: Canvas;
    placeholder?: string;
    type?: ChildVisualization;
    layout?: Layout;
    classNameContent?: string;
    autoSave?: boolean; // Optional prop to control auto-saving behavior
    autoReply?: boolean; // Optional prop to control auto-reply functionality
    onDraftCreated?: (draft: Canvas) => void; // Callback when a draft is created
};

const ToolbarProviderContextComponent = ({
    children,
}: { children: ReactNode; }) => {
    // This inner component is used to ensure the context is always available
    // even if fullscreenEditorActive is not provided.

    const [appSelectOpen, setAppSelectOpen] = useState(false);

    return (
        <ToolbarContext.Provider
            value={{
                appSelectOpen,
                setAppSelectOpen,
            }}
        >
            {children}
        </ToolbarContext.Provider>
    );
};

// This provider wraps children with your CanvasWrapper and AutoReplyProvider,
// and exposes both the fullscreen editor state and the app select state.
export const CanvasEditorProvider = ({
    children,
    pendingCanvas,
    placeholder,
    classNameContent,
    autoSave,
    replyTo,
    autoReply,
    onDraftCreated,
}: ToolbarProviderProps & { replyTo?: Canvas }) => {
    return (
        <PendingCanvasProvider
            pendingCanvas={pendingCanvas}
            onDraftCreated={onDraftCreated}
            replyTo={autoReply ? undefined : replyTo}
        >
            <CanvasWrapperComponent
                classNameContent={classNameContent}
                placeholder={placeholder}
                autoSave={autoSave}
                autoReply={autoReply}
            >
                {children}
            </CanvasWrapperComponent>
        </PendingCanvasProvider>
    );
};

const CanvasWrapperComponent = ({
    children,
    placeholder,
    classNameContent,
    autoSave,
    autoReply
}: ToolbarProviderProps) => {
    const { pendingCanvas, saveDraftDebounced } = usePendingCanvas();


    return (
        <CanvasWrapper
            canvas={pendingCanvas}
            draft={true}
            multiCanvas
            /* onSave={publish} */
            placeholder={placeholder}
            classNameContent={classNameContent}
            onContentChange={(e) => {
                if (!autoSave) {
                    return;
                }
                for (const change of e) {
                    if (!change.content.isEmpty) {
                        saveDraftDebounced();
                        return;
                    }
                }
            }}
        >
            <ToolbarProviderContextComponent >
                <AutoReplyProvider disabled={!autoReply}>
                    {children}
                </AutoReplyProvider>
            </ToolbarProviderContextComponent>
        </CanvasWrapper>
    );
};

// Custom hook so you can use the toolbar context anywhere in your app.
export const useEditTools = (): ToolbarContextType => {
    const context = useContext(ToolbarContext);
    if (!context) {
        throw new Error("useToolbar must be used within a ToolbarProvider");
    }
    return context;
};
