import {
    useState,
    forwardRef,
    useRef,
    useEffect,
    createContext,
    ReactNode,
    useContext,
} from "react";
import { CanvasWrapper, useCanvas } from "../CanvasWrapper";
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

// Create the context with a default value
const ToolbarContext = createContext<ToolbarContextType>({
    fullscreenEditorActive: false,
    setFullscreenEditorActive: () => {},
    appSelectOpen: false,
    setAppSelectOpen: () => {},
});

// Create a provider component
type ToolbarProviderProps = {
    children: ReactNode;
};

export const ToolbarProvider = ({ children }: ToolbarProviderProps) => {
    const [fullscreenEditor, setFullscreenEditor] = useState(false);
    const [appSelectOpen, setAppSelectOpen] = useState(false);

    const { pendingCanvas, savePending: onSavePending } = usePendingCanvas();

    return (
        <ToolbarContext.Provider
            value={{
                fullscreenEditorActive: fullscreenEditor,
                setFullscreenEditorActive: setFullscreenEditor,
                appSelectOpen: appSelectOpen,
                setAppSelectOpen: setAppSelectOpen,
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

// Create a custom hook to use the toolbar context
export const useToolbar = () => {
    const context = useContext(ToolbarContext);
    if (context === undefined) {
        throw new Error("useToolbar must be used within a ToolbarProvider");
    }
    return context;
};

// Wrap ToolbarContainer with forwardRef so that if a parent passes a ref, it is forwarded.
export const Toolbar = (props?: { className?: string }) => {
    return <ToolbarInner className={props?.className} />;
};

const ToolbarInner = (props?: { className?: string }) => {
    const { appSelectOpen, setAppSelectOpen } = useToolbar();
    const appSelectRef = useRef<HTMLDivElement>(null);
    const toolbarRef = useRef<HTMLDivElement>(null);

    const handleAppSelected = (app: SimpleWebManifest) => {
        setAppSelectOpen(false);
    };

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (
                appSelectOpen &&
                toolbarRef.current &&
                !toolbarRef.current.contains(event.target as Node)
            ) {
                event.preventDefault();
                event.stopImmediatePropagation();
                event.stopPropagation();
                setAppSelectOpen(false);
            }
        };

        document.addEventListener("click", handleClickOutside, true);
        return () =>
            document.removeEventListener("click", handleClickOutside, true);
    }, [appSelectOpen]);

    // Determine if we're on a desktop screen (min-width: 640px).
    /*  const isDesktop = useMediaQuery("(min-width: 640px)"); */

    return (
        <div
            ref={toolbarRef}
            className={"w-full flex justify-center " + props.className}
        >
            {/* blur above the toolbar to the top of the screen */}
            <div
                className="absolute top-0 left-0 right-0 h-14 to-transparent pointer-events-none"
                style={{
                    zIndex: -1,
                }}
            ></div>
            <div className="flex flex-col w-full rounded-t-lg items-center max-w-[876px] bg-neutral-100 dark:bg-neutral-900">
                <ToolbarContent />
                <div
                    ref={appSelectRef}
                    className="overflow-hidden w-full"
                    style={
                        appSelectOpen
                            ? {
                                  height: `100%`,
                                  pointerEvents: "auto",
                              }
                            : {
                                  height: "0px",
                                  pointerEvents: "none",
                              }
                    }
                >
                    <AppSelectPaneInline
                        className="p-4 pt-2"
                        onSelected={handleAppSelected}
                    />
                </div>
            </div>
        </div>
    );
};
