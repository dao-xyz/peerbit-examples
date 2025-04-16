// ToolbarContext.tsx
import React, {
    useState,
    useRef,
    useEffect,
    createContext,
    ReactNode,
    useContext,
} from "react";
import { CanvasWrapper } from "../CanvasWrapper";
import ToolbarContent from "./ToolbarContent";
import { AppSelectPaneInline } from "./AppSelectPaneInline";
import { SimpleWebManifest } from "@giga-app/interface";
import { usePendingCanvas } from "../PendingCanvasContext";
import { AutoReplyProvider } from "../AutoReplyContext";

interface ToolbarContextType {
    fullscreenEditorActive: boolean;
    setFullscreenEditorActive: React.Dispatch<React.SetStateAction<boolean>>;
    appSelectOpen: boolean;
    setAppSelectOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

// Create the context (using undefined as default to catch missing provider)
const ToolbarContext = createContext<ToolbarContextType | undefined>(undefined);

type ToolbarProviderProps = {
    children: ReactNode;
};

// This provider wraps children with your CanvasWrapper and AutoReplyProvider,
// and exposes both the fullscreen editor state and the app select state.
export const ToolbarProvider = ({ children }: ToolbarProviderProps) => {
    const [fullscreenEditor, setFullscreenEditor] = useState(false);
    const [appSelectOpen, setAppSelectOpen] = useState(false);

    const { pendingCanvas, savePending: onSavePending } = usePendingCanvas();

    return (
        <ToolbarContext.Provider
            value={{
                fullscreenEditorActive: fullscreenEditor,
                setFullscreenEditorActive: setFullscreenEditor,
                appSelectOpen,
                setAppSelectOpen,
            }}
        >
            <CanvasWrapper
                canvas={pendingCanvas}
                draft={true}
                multiCanvas
                onSave={onSavePending}
            >
                <AutoReplyProvider>{children}</AutoReplyProvider>
            </CanvasWrapper>
        </ToolbarContext.Provider>
    );
};

// Custom hook so you can use the toolbar context anywhere in your app.
export const useToolbar = (): ToolbarContextType => {
    const context = useContext(ToolbarContext);
    if (!context) {
        throw new Error("useToolbar must be used within a ToolbarProvider");
    }
    return context;
};
