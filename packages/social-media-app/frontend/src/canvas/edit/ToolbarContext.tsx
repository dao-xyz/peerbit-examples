// ToolbarContext.tsx
import React, { useState, createContext, ReactNode, useContext } from "react";
import { CanvasWrapper } from "../CanvasWrapper";
import {
    PendingCanvasProvider,
    usePendingCanvas,
} from "./PendingCanvasContext";
import { AutoReplyProvider } from "../AutoReplyContext";
import { useView } from "../view/ViewContext";
import { Canvas } from "@giga-app/interface";

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
    type?: "navigation" | "narrative";
    classNameContent?: string;
    parent: Canvas;
};

const ToolbarProviderContextComponent = ({
    children,
}: ToolbarProviderProps) => {
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
            <AutoReplyProvider>{children}</AutoReplyProvider>
        </ToolbarContext.Provider>
    );
};

const CanvasWrapperComponent = ({
    children,
    placeholder,
    classNameContent,
    parent,
}: ToolbarProviderProps) => {
    const { pendingCanvas, savePending: onSavePending } = usePendingCanvas();
    return (
        <CanvasWrapper
            canvas={pendingCanvas}
            draft={true}
            multiCanvas
            onSave={onSavePending}
            placeholder={placeholder}
            classNameContent={classNameContent}
        >
            <ToolbarProviderContextComponent parent={parent}>
                {children}
            </ToolbarProviderContextComponent>
        </CanvasWrapper>
    );
};

// This provider wraps children with your CanvasWrapper and AutoReplyProvider,
// and exposes both the fullscreen editor state and the app select state.
export const CanvasEditorProvider = ({
    children,
    pendingCanvas,
    placeholder,
    classNameContent,
    parent,
    type,
}: ToolbarProviderProps) => {
    return (
        <PendingCanvasProvider
            type={type}
            pendingCanvas={pendingCanvas}
            parent={parent}
        >
            <CanvasWrapperComponent
                classNameContent={classNameContent}
                placeholder={placeholder}
                parent={parent}
            >
                {children}
            </CanvasWrapperComponent>
        </PendingCanvasProvider>
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
