import { useEffect, useRef, useState } from "react";

/**
 * DetailedViewContainer
 *
 * This container wraps the <DetailedView /> and, when the user scrolls
 * past its bottom (thanks to extra padding in the page), it smoothly applies an upward
 * transform. When scrolled far enough, it translates by 100% of its height so that
 * the detailed view is completely hidden.
 *
 * @param {object} props
 * @param {React.ReactNode} props.children - The detailed view to render.
 * @param {function} [props.onMinimized] - Optional callback fired with a boolean value:
 *   true when the detailed view is fully minimized (translated 100%) and false otherwise.
 */
export const DetailedViewContainer = ({ children, onMinimized }) => {
    const containerRef = useRef(null);
    const [translateY, setTranslateY] = useState(0);
    const prevMinimizedRef = useRef(false);

    useEffect(() => {
        const handleScroll = () => {
            if (!containerRef.current) return;

            // Get the container's bounding rectangle relative to the viewport.
            const rect = containerRef.current.getBoundingClientRect();

            // Start the transformation once the bottom passes 50px above the viewport bottom.
            const threshold = 50;

            // Calculate the offset: how many pixels the bottom of the container is above
            // the bottom of the viewport.
            const offset = Math.max(window.innerHeight - rect.bottom, 0);

            // Get the container's full height (this is our "100%" translation target).
            const containerHeight = containerRef.current.offsetHeight;

            let newTranslate = 0;
            if (offset > threshold) {
                // Define an interpolation range. In this example, over the next 200px of offset
                // we go from 0 translation to a full container translation.
                const range = 200;
                const factor = containerHeight / range;
                newTranslate = Math.min(
                    (offset - threshold) * factor,
                    containerHeight
                );
            }
            setTranslateY(newTranslate);
        };

        window.addEventListener("scroll", handleScroll);
        return () => window.removeEventListener("scroll", handleScroll);
    }, []);

    // When translateY changes, determine if the view is fully minimized.
    useEffect(() => {
        if (!containerRef.current) return;
        const containerHeight = containerRef.current.offsetHeight;
        const minimized = translateY >= containerHeight;
        if (
            minimized !== prevMinimizedRef.current &&
            typeof onMinimized === "function"
        ) {
            /*   onMinimized(minimized); */
            prevMinimizedRef.current = minimized;
        }
    }, [translateY, onMinimized]);

    const containerStyle = {
        transform: `translateY(-${translateY}px)`,
        transition: "transform 0.2s ease-out",
    };

    return (
        <div
            ref={containerRef}
            style={containerStyle}
            className=" bg-neutral-50 dark:bg-neutral-950"
        >
            {children}
        </div>
    );
};
