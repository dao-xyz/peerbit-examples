import { useState, useEffect, useRef } from "react";
import {
    getScrollTop,
    useHeaderVisibilityContext,
} from "../../HeaderVisibilitiyProvider";
import { useCanvas } from "../CanvasWrapper";
import { useView } from "../reply/view/ViewContex";

function getScrollBottomOffset() {
    return (
        document.documentElement.scrollHeight -
        (getScrollTop() + window.innerHeight)
    );
}

export const useToolbarVisibility = (
    scrollThreshold = 50,
    topThreshold = 100 // distance (in pixels) from the top of the viewport for the element to be considered "close"
) => {
    const [visible, setVisible] = useState(true);
    const prevScrollTopRef = useRef(getScrollTop());
    const { view } = useView();
    const { visible: headerIsShowing, setDisabled: x } =
        useHeaderVisibilityContext();
    const isAtBottom = useRef(false);
    const [isEmpty, setIsEmpty] = useState(true);
    const [disabled, setDisabled] = useState(false);

    const show = () => {
        setVisible(true);
    };

    const unshow = () => {
        setVisible(false);
    };

    /* useEffect(() => {
        console.log(view.id)
        if (view.settings.focus === 'last') {
            x(true)
            setDisabled(true); // disable toolbar for chat view
        }
        else {
            setDisabled(false); // enable toolbar for other views
        }
    }, [view.id]) */
    useEffect(() => {
        if (disabled) {
            unshow();
            return;
        }

        if (headerIsShowing) {
            show();
        } else {
            // if header is not showing and the toolbar has no content, then we should hide it (TODO add manual hide mode)
            if (!isAtBottom.current && isEmpty) {
                unshow();
            }
        }
    }, [headerIsShowing, disabled]);

    useEffect(() => {
        if (disabled) {
            return;
        }
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
    }, [/* elementRef,  */ scrollThreshold, topThreshold, disabled]);

    return {
        visible,
        setDisabled,
        disabled,
        show,
        unshow,
        isAtBottom: isAtBottom.current,
        setIsEmpty,
        isEmpty,
    };
};
