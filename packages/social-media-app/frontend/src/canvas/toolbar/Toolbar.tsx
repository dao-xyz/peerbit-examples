import {
    useState,
    forwardRef,
    useRef,
    useEffect,
    createContext,
    ReactNode,
    useContext,
} from "react";
import { Canvas as CanvasDB } from "@giga-app/interface";
import { CanvasWrapper, useCanvas } from "../CanvasWrapper";
import ToolbarContent from "./ToolbarContent";
import { AppSelectPaneInline } from "./AppSelectPaneInline";
import { SimpleWebManifest } from "@giga-app/interface";
import { usePendingCanvas } from "../PendingCanvasContext";

interface ToolbarContextType {
    fullscreenEditorActive: boolean;
    setFullscreenEditorActive: React.Dispatch<React.SetStateAction<boolean>>;
}

// Create the context with a default value
const ToolbarContext = createContext<ToolbarContextType>({
    fullscreenEditorActive: false,
    setFullscreenEditorActive: () => {},
});

// Create a provider component
type ToolbarProviderProps = {
    children: ReactNode;
};

export const ToolbarProvider = ({ children }: ToolbarProviderProps) => {
    const [fullscreenEditor, setFullscreenEditor] = useState(false);
    const { pendingCanvas, onSavePending } = usePendingCanvas();

    return (
        <ToolbarContext.Provider
            value={{
                fullscreenEditorActive: fullscreenEditor,
                setFullscreenEditorActive: setFullscreenEditor,
            }}
        >
            <CanvasWrapper
                canvas={pendingCanvas}
                draft={true}
                multiCanvas
                onSave={onSavePending}
            >
                {children}
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

// A simple media query hook to detect desktop screens.
function useMediaQuery(query: string) {
    const [matches, setMatches] = useState(false);
    useEffect(() => {
        const media = window.matchMedia(query);
        setMatches(media.matches);
        const listener = () => setMatches(media.matches);
        media.addEventListener("change", listener);
        return () => media.removeEventListener("change", listener);
    }, [query]);
    return matches;
}

// Wrap ToolbarContainer with forwardRef so that if a parent passes a ref, it is forwarded.
export const Toolbar = forwardRef<HTMLDivElement>((props, ref) => {
    return <ToolbarInner ref={ref} />;
});

interface ToolbarInnerProps {}

const ToolbarInner = forwardRef<HTMLDivElement, ToolbarInnerProps>(
    (_props, ref) => {
        const [appSelectOpen, setAppSelectOpen] = useState(false);
        const appSelectRef = useRef<HTMLDivElement>(null);

        const handleAppSelected = (app: SimpleWebManifest) => {
            setAppSelectOpen(false);
        };

        useEffect(() => {
            const handleClickOutside = (event: MouseEvent) => {
                if (
                    appSelectOpen &&
                    appSelectRef.current &&
                    !appSelectRef.current.contains(event.target as Node)
                ) {
                    console.log("UNMOUNTING");
                    setAppSelectOpen(false);
                }
            };

            document.addEventListener("mousedown", handleClickOutside);
            return () =>
                document.removeEventListener("mousedown", handleClickOutside);
        }, [appSelectOpen]);

        // Determine if we're on a desktop screen (min-width: 640px).
        /*  const isDesktop = useMediaQuery("(min-width: 640px)"); */

        return (
            <div ref={ref} className="w-full flex justify-center">
                <div className="flex flex-col w-full items-center max-w-[876px]">
                    <ToolbarContent
                        onToggleAppSelect={() => setAppSelectOpen(true)}
                        appSelectOpen={appSelectOpen}
                    />
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
    }
);
