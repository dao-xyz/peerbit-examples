import { useState, useEffect, useRef } from "react";
import {
    getScrollTop,
    useHeaderVisibilityContext,
} from "../../HeaderVisibilitiyProvider";
import { useToolbar } from "../toolbar/ToolbarContext";

function getScrollBottomOffset() {
    return (
        document.documentElement.scrollHeight -
        (getScrollTop() + window.innerHeight)
    );
}

export const useToolbarVisibility = (
    elementRef: React.RefObject<HTMLElement>,
    scrollThreshold = 50,
    topThreshold = 100 // distance (in pixels) from the top of the viewport for the element to be considered "close"
) => {
    const [visible, setVisible] = useState(true);
    const prevScrollTopRef = useRef(getScrollTop());
    const headerIsShowing = useHeaderVisibilityContext();
    const { setAppSelectOpen } = useToolbar();
    const isAtBottom = useRef(false);

    const show = () => {
        setVisible(true);
    };

    const unshow = () => {
        setVisible(false);
        setAppSelectOpen(false);
    };

    useEffect(() => {
        if (headerIsShowing) {
            show();
        } else {
            if (!isAtBottom.current) {
                unshow();
            }
        }
    }, [headerIsShowing]);

    useEffect(() => {
        const handleScroll = () => {
            const currentScrollTop = getScrollTop();
            const scrollBottomOffset = getScrollBottomOffset();

            // Determine if user is scrolling up
            // Check if near the bottom of the page
            isAtBottom.current = scrollBottomOffset < scrollThreshold;

            /*  // Check if the element (e.g., subheader/toolbar) is actually close to the top of the viewport.
             let isElementCloseToTop = false;
             if (elementRef.current) {
                 const { top } = elementRef.current.getBoundingClientRect();
                 console.log(top, elementRef.current.getBoundingClientRect())
                 isElementCloseToTop = top < topThreshold;
 
             } */

            // Only animate upward if either at the bottom OR scrolling up while the element is near the top.

            if (isAtBottom.current) {
                show();
            }

            prevScrollTopRef.current = currentScrollTop;
        };

        window.addEventListener("scroll", handleScroll);
        return () => window.removeEventListener("scroll", handleScroll);
    }, [elementRef, scrollThreshold, topThreshold]);

    return visible;
};
