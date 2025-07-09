import React, {
    createContext,
    useContext,
    useState,
    useEffect,
    useMemo,
    ReactNode,
    useRef,
} from "react";
import { Canvas as CanvasDB } from "@giga-app/interface";
import { useCanvases } from "../useCanvas";
/**
 * Debounce any primitive or reference value *together* so React effects that depend on multiple
 * pieces of state run **once** instead of once‑per‑piece. The update is flushed after `delay` ms.
 */
function useCombinedDebounced<A, B>(a: A, b: B, delay: number): { a: A; b: B } {
    const [debounced, setDebounced] = useState<{ a: A; b: B }>({
        a,
        b,
    });
    const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);

    useEffect(() => {
        clearTimeout(timeout.current);
        timeout.current = setTimeout(
            () =>
                setDebounced({
                    a,
                    b,
                }),
            delay
        );
        return () => clearTimeout(timeout.current);
    }, [a, b, delay]);

    return debounced;
}

function useViewContextHook() {
    const { path: canvases, leaf, loading } = useCanvases();

    const [viewContext, setViewContext] = useState<CanvasDB[] | undefined>(
        undefined
    );

    useEffect(() => {
        const fn = async () => {
            setViewContext(await leaf?.getViewContext());
        };
        fn();
    }, [leaf]);

    const viewRoot = useMemo(() => viewContext?.[0], [viewContext]);

    return {
        canvases,
        viewRoot,
        viewContext,
        loading,
    };
}

// Define the context type.
export type ViewContextType = ReturnType<typeof useViewContextHook>;

// Create the context.
const ViewContext = createContext<ViewContextType | undefined>(undefined);

// Provider component wrapping children.
export const ViewProvider: React.FC<{ children: ReactNode }> = ({
    children,
}) => {
    const view = useViewContextHook();
    return <ViewContext.Provider value={view}>{children}</ViewContext.Provider>;
};

// Custom hook for consumers.
export const useView = (): ViewContextType => {
    const context = useContext(ViewContext);
    if (!context) {
        throw new Error("useView must be used within a ViewProvider");
    }
    return context;
};
