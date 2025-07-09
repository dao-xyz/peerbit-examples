import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";

/**
 * The context value combines:
 *  • `scrollToTop` – imperative call to scroll the main window to the very top.
 *  • `onScrollToTop` – subscribe-to-event helper that returns an `unsubscribe` fn.
 */
export type ScrollContextValue = {
    scrollToTop: () => void;
    onScrollToTop: (listener: () => void) => () => void;
    focused: boolean;
    setFocused: (focused: boolean) => void;
};

const ScrollProviderContext = createContext<ScrollContextValue | undefined>(
    undefined
);

/* const isAtTopMeasure = (delta = 0) => {
    if (typeof window === "undefined") {
        return true; // Assume at top in SSR
    }
    return window.scrollY <= delta;
} */

export const FocusProvider: React.FC<{ children: React.ReactNode }> = ({
    children,
}) => {
    /**
     * Store listeners in a Set so we can add / remove efficiently without duplicates.
     * Using a ref guarantees the same Set instance between renders.
     */
    const listenersRef = useRef(new Set<() => void>());

    /**
     * Imperative scroll function that also notifies listeners.
     */
    const scrollToTop = useCallback(() => {
        if (typeof window !== "undefined") {
            window.scrollTo({
                top: 0,
                behavior: "instant",
            });
        }

        // Notify subscribers safely.
        listenersRef.current.forEach((listener) => {
            try {
                listener();
            } catch (err) {
                // Fail-soft: don’t break other listeners if one errors.
                // eslint-disable-next-line no-console
                console.error("onScrollToTop listener failed", err);
            }
        });
    }, []);

    /* const [isAtTop, setIsAtTop] = useState(true);

    useEffect(() => {

        // Add event listener to scroll to top when header becomes visible
        const handleScroll = debounce(() => {
            const atTop = isAtTopMeasure(100);
            setIsAtTop(atTop);

        }, 100, { leading: true, trailing: true });

        window.addEventListener("scroll", handleScroll);
        return () => {
            window.removeEventListener("scroll", handleScroll);
        };
    }, []); */

    const [focused, setFocused] = useState(false);

    /**
     * Subscribe helper returns an unsubscribe fn to remove the listener.
     */
    const onScrollToTop = useCallback((listener: () => void) => {
        listenersRef.current.add(listener);
        return () => {
            listenersRef.current.delete(listener);
        };
    }, []);

    const value = useMemo(
        () => ({ scrollToTop, onScrollToTop, focused, setFocused }),
        [scrollToTop, onScrollToTop, focused, setFocused]
    );

    return (
        <ScrollProviderContext.Provider value={value}>
            {children}
        </ScrollProviderContext.Provider>
    );
};

/**
 * Main hook – returns the full context value with both helpers.
 */
export const useFocusProvider = () => {
    const ctx = useContext(ScrollProviderContext);
    if (!ctx) {
        throw new Error(
            "useScrollProvider must be used inside a <ScrollProvider> component"
        );
    }
    return ctx;
};

/**
 * Convenience hook for just the imperative helper.
 */
export const useScrollToTop = () => useFocusProvider().scrollToTop;

/**
 * Hook to register a side-effect whenever `scrollToTop` is called.
 */
export const useOnScrollToTop = (handler: () => void) => {
    const { onScrollToTop } = useFocusProvider();
    useEffect(() => {
        const unsubscribe = onScrollToTop(handler);
        return unsubscribe;
    }, [onScrollToTop, handler]);
};
