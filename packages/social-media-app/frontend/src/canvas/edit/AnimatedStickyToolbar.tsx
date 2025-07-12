import React, { useRef, useState, useLayoutEffect } from "react";
import { useToolbarVisibilityContext } from "./ToolbarVisibilityProvider";
import { useCssVarHeight } from "../../utils/useCssVarHeight";

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

    const [toolbarHeight, _setToolbarHeight] = useState(0);
    const ref = useCssVarHeight<HTMLDivElement>({
        cssVar: "--toolbar-h",
        onChange: (height) => {
            _setToolbarHeight(height);
            onHeightChange?.(height);
        },
    });

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
                ref={ref}
                className="w-full duration-800 ease-in-out  "
                style={{ transform: `translateY(${translateY})` }}
            >
                {children}
            </div>
        </div>
    );
};
