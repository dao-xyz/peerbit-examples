import React, { useRef, useState, useLayoutEffect } from "react";
import { useEditTools } from "./ToolbarContext";
import { useToolbarVisibilityContext } from "./ToolbarVisibilityProvider";

interface AnimatedStickyToolbarProps {
    children: React.ReactNode;
    onHeightChange?: (height: number) => void;
}

/**
 * This crap is made because we can not use `position: sticky` on the toolbar together with transform transitions, because on Safari the sticky container will not reserve the space for the toolbar when it is translated.
 */
export const AnimatedStickyToolbar = ({
    children,
    onHeightChange,
}: AnimatedStickyToolbarProps) => {
    const { visible: toolbarVisible } = useToolbarVisibilityContext();

    const innerRef = useRef<HTMLDivElement>(null);
    const [toolbarHeight, _setToolbarHeight] = useState(0);

    const updateToolbarHeight = (h: number) => {
        // 1. expose to CSS immediately – no React render needed
        document.documentElement.style.setProperty("--toolbar-h", `${h}px`);
        _setToolbarHeight(h); // (optional) still keep your local state
        onHeightChange?.(h); // keep existing API
    };

    useLayoutEffect(() => {
        if (innerRef.current) {
            updateToolbarHeight(innerRef.current.offsetHeight);
        }
        const resizeObserver = new ResizeObserver((entries) => {
            for (let entry of entries) {
                if (entry.target === innerRef.current) {
                    updateToolbarHeight(entry.contentRect.height);
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
            className={`fixed z-20 bottom-0 inset-x-0 ${
                toolbarVisible ? "" : "pointer-events-none"
            }`}
            style={{ height: toolbarHeight || "auto" }}
        >
            {/* The inner toolbar is animated with transform */}
            <div
                ref={innerRef}
                className="w-full duration-800 ease-in-out  "
                style={{ transform: `translateY(${translateY})` }}
            >
                {children}
            </div>
        </div>
    );
};
