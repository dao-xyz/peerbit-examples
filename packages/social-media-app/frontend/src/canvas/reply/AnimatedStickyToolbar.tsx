import React, { useRef, useState, useLayoutEffect } from "react";

interface AnimatedStickyToolbarProps {
    toolbarVisible: boolean;
    children: React.ReactNode;
    onHeightChange?: (height: number) => void;
}

/**
 * This crap is made because we can not use `position: sticky` on the toolbar together with transform transitions, because on Safari the sticky container will not reserve the space for the toolbar when it is translated.
 */
export const AnimatedStickyToolbar = ({
    toolbarVisible,
    children,
    onHeightChange,
}: AnimatedStickyToolbarProps) => {
    const innerRef = useRef<HTMLDivElement>(null);
    const [toolbarHeight, _setToolbarHeight] = useState(0);

    const setToolbarHeight = (height: number) => {
        _setToolbarHeight(height);
        if (onHeightChange) {
            onHeightChange(height);
        }
    };

    useLayoutEffect(() => {
        if (innerRef.current) {
            setToolbarHeight(innerRef.current.offsetHeight);
        }
        const resizeObserver = new ResizeObserver((entries) => {
            for (let entry of entries) {
                if (entry.target === innerRef.current) {
                    setToolbarHeight(entry.contentRect.height);
                }
            }
        });
        if (innerRef.current) {
            resizeObserver.observe(innerRef.current);
        }
        return () => {
            resizeObserver.disconnect();
        };
    }, []);

    // When hidden, move the toolbar down by its measured height.
    const translateY = toolbarVisible ? "0" : `${toolbarHeight}px`;

    return (
        // This outer container is sticky and always reserves the toolbar height.
        <div
            className="fixed z-20 bottom-0 inset-x-0"
            style={{ height: toolbarHeight || "auto" }}
        >
            {/* The inner toolbar is animated with transform */}
            <div
                ref={innerRef}
                className="w-full bg-neutral-50 dark:bg-neutral-950 duration-800 ease-in-out"
                style={{ transform: `translateY(${translateY})` }}
            >
                {children}
            </div>
        </div>
    );
};
