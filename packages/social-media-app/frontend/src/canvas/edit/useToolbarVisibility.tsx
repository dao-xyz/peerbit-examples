import { useState, useEffect, useCallback, useMemo } from "react";
import debounce from "lodash/debounce";
import {
    getScrollTop,
    useHeaderVisibilityContext,
} from "../../HeaderVisibilitiyProvider";

/**
 * Remaining distance (px) from the bottom of the document.
 */
function getScrollBottomOffset(): number {
    return (
        document.documentElement.scrollHeight -
        (getScrollTop() + window.innerHeight)
    );
}

export const useToolbarVisibility = (
    scrollThreshold = 50,
    /** Delay (ms) used for lodash‑debounced scroll handler. */
    debounceDelay = 100,
    /** Distance (px) from the top for “close to top” checks – kept for future extension. */
    _topThreshold = 100
) => {
    const [visible, setVisible] = useState(true);
    const { visible: headerIsShowing } = useHeaderVisibilityContext();

    const [isAtBottom, setIsAtBottom] = useState(false);
    const [isEmpty, setIsEmpty] = useState(true);
    const [disabled, setDisabled] = useState(false);

    const show = useCallback(() => setVisible(true), []);
    const hide = useCallback(() => setVisible(false), []);

    /* ------------------------------------------------------------------ */
    /*  Sync with header + disabled flags                                  */
    /* ------------------------------------------------------------------ */
    useEffect(() => {
        if (disabled) {
            show(); // todo hide ?
            return;
        }

        if (headerIsShowing) {
            show();
        } else if (!isAtBottom && isEmpty) {
            hide();
        }
    }, [headerIsShowing, disabled, isAtBottom, isEmpty, show, hide]);

    /* ------------------------------------------------------------------ */
    /*  Scroll listener (lodash‑debounced)                                 */
    /* ------------------------------------------------------------------ */
    const handleScroll = useCallback(() => {
        if (disabled) return;

        const bottomOffset = getScrollBottomOffset();
        const reachedBottom = bottomOffset < scrollThreshold;
        setIsAtBottom(reachedBottom);

        if (reachedBottom) {
            show();
        }
    }, [disabled, scrollThreshold, show]);

    // Create a stable lodash‑debounced handler.
    const debouncedScroll = useMemo(
        () => debounce(handleScroll, debounceDelay),
        [handleScroll, debounceDelay]
    );

    useEffect(() => {
        // Attach once.
        window.addEventListener("scroll", debouncedScroll, { passive: true });

        return () => {
            window.removeEventListener("scroll", debouncedScroll);
            // Cancel any pending executions on unmount.
            debouncedScroll.cancel();
        };
    }, [debouncedScroll]);

    return {
        visible,
        setDisabled,
        disabled,
        show,
        hide,
        isAtBottom,
        setIsEmpty,
        isEmpty,
    } as const;
};
