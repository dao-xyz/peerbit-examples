import { useState, useEffect, useRef } from "react";
import { getScrollTop } from "../../HeaderVisibilitiyProvider";
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

    const { setAppSelectOpen } = useToolbar();

    useEffect(() => {
        const handleScroll = () => {
            const currentScrollTop = getScrollTop();
            const scrollBottomOffset = getScrollBottomOffset();

            // Determine if user is scrolling up
            const isScrollingUp = currentScrollTop < prevScrollTopRef.current;
            // Check if near the bottom of the page
            const isAtBottom = scrollBottomOffset < scrollThreshold;

            /*  // Check if the element (e.g., subheader/toolbar) is actually close to the top of the viewport.
             let isElementCloseToTop = false;
             if (elementRef.current) {
                 const { top } = elementRef.current.getBoundingClientRect();
                 console.log(top, elementRef.current.getBoundingClientRect())
                 isElementCloseToTop = top < topThreshold;
 
             } */

            // Only animate upward if either at the bottom OR scrolling up while the element is near the top.
            const shouldShow =
                isAtBottom || isScrollingUp; /* && isElementCloseToTop */

            if (!shouldShow) {
                setAppSelectOpen(false);
            }
            setVisible(shouldShow);

            prevScrollTopRef.current = currentScrollTop;
        };

        window.addEventListener("scroll", handleScroll);
        return () => window.removeEventListener("scroll", handleScroll);
    }, [elementRef, scrollThreshold, topThreshold]);

    return visible;
};
