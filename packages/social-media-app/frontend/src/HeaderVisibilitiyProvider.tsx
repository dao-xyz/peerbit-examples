import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import debounce from "lodash/debounce";

export const getViewportHeight = () =>
    window.visualViewport ? window.visualViewport.height : window.innerHeight;

export const keyboardIsOpen = (
    baseline: number,
    tolerance = 100 // px shrink before we call it “keyboard”
) =>
    window.visualViewport
        ? baseline - window.visualViewport.height > tolerance
        : false;

export const getScrollTop = () =>
    window.visualViewport?.pageTop ||
    window.scrollY ||
    document.documentElement.scrollTop;

export const getMaxScrollTop = () => {
    const documentHeight = Math.max(
        document.body.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.clientHeight,
        document.documentElement.scrollHeight,
        document.documentElement.offsetHeight
    );
    return documentHeight - window.innerHeight;
};

const useHeaderVisibility = (
    threshold = 50,
    downDeltaThreshold = 20,
    bottomBounceTolerance = 50,
    /** Delay (ms) used for lodash‑debounced scroll handler. */
    debounceDelay = 50
) => {
    const baseViewportHeightRef = useRef(getViewportHeight());
    const [disabled, setDisabled] = useState(false);
    const [visible, setVisible] = useState(true);

    const prevScrollTopRef = useRef(getScrollTop());
    const lastUpPositionRef = useRef(getScrollTop());

    /* -------------------------------------------------------------- */
    /*  Visual‑viewport resize (virtual keyboard detection)            */
    /* -------------------------------------------------------------- */
    useEffect(() => {
        const handleVpResize = () => {
            if (!keyboardIsOpen(baseViewportHeightRef.current)) {
                baseViewportHeightRef.current = getViewportHeight();
            }
        };

        window.visualViewport?.addEventListener("resize", handleVpResize);
        return () =>
            window.visualViewport?.removeEventListener(
                "resize",
                handleVpResize
            );
    }, []);

    /* -------------------------------------------------------------- */
    /*  Ensure header is shown when disabled is toggled                */
    /* -------------------------------------------------------------- */
    useEffect(() => {
        if (disabled) {
            setVisible(true);
        }
    }, [disabled]);

    /* -------------------------------------------------------------- */
    /*  Core visibility algorithm                                     */
    /* -------------------------------------------------------------- */
    const computeVisibility = useCallback(() => {
        if (disabled) return;
        if (keyboardIsOpen(baseViewportHeightRef.current)) return;

        const currentScrollTop = getScrollTop();
        const maxScrollTop = getMaxScrollTop();

        // Not scrollable ⇒ keep showing.
        if (maxScrollTop < bottomBounceTolerance) {
            setVisible(true);
            prevScrollTopRef.current = currentScrollTop;
            lastUpPositionRef.current = currentScrollTop;
            return;
        }

        // Bottom bounce tolerance ⇒ hide.
        if (maxScrollTop - currentScrollTop < bottomBounceTolerance) {
            setVisible(false);
            prevScrollTopRef.current = currentScrollTop;
            return;
        }

        if (currentScrollTop < threshold) {
            setVisible(true);
            lastUpPositionRef.current = currentScrollTop;
        } else {
            if (currentScrollTop < prevScrollTopRef.current) {
                // Scrolling up: show.
                setVisible(true);
                lastUpPositionRef.current = currentScrollTop;
            } else if (
                currentScrollTop - lastUpPositionRef.current >
                downDeltaThreshold
            ) {
                // Scrolling down enough: hide.
                setVisible(false);
            }
        }
        prevScrollTopRef.current = currentScrollTop;
    }, [disabled, threshold, downDeltaThreshold, bottomBounceTolerance]);

    /* -------------------------------------------------------------- */
    /*  Debounced scroll listener (lodash)                             */
    /* -------------------------------------------------------------- */
    const debouncedScroll = useMemo(
        () =>
            debounce(computeVisibility, debounceDelay, {
                leading: true,
                trailing: true,
            }),
        [computeVisibility, debounceDelay]
    );

    useEffect(() => {
        window.addEventListener("scroll", debouncedScroll, { passive: true });
        return () => {
            window.removeEventListener("scroll", debouncedScroll);
            debouncedScroll.cancel();
        };
    }, [debouncedScroll]);

    return { visible, setDisabled, disabled } as const;
};

/* ------------------------------------------------------------------ */
/*  Context helpers                                                   */
/* ------------------------------------------------------------------ */

type Ctx = {
    visible: boolean;
    disabled: boolean;
    setDisabled: (d: boolean) => void;
};

const HeaderVisibilityContext = React.createContext<Ctx | undefined>(undefined);

export const HeaderVisibilityProvider = ({
    children,
}: {
    children: React.ReactNode;
}) => {
    const ctx = useHeaderVisibility();
    return (
        <HeaderVisibilityContext.Provider value={ctx}>
            {children}
        </HeaderVisibilityContext.Provider>
    );
};

export const useHeaderVisibilityContext = () => {
    const ctx = useContext(HeaderVisibilityContext);
    if (!ctx) {
        throw new Error(
            "useHeaderVisibilityContext must be used within HeaderVisibilityProvider"
        );
    }
    return ctx;
};
