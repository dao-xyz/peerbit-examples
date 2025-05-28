// StickyHeader.tsx
import React, { useEffect, useRef, useState } from "react";
import { useHeaderVisibilityContext } from "../../HeaderVisibilitiyProvider";
import { useView } from "./view/ViewContex";

export const StickyHeader = ({
    children,
    className,
    onStateChange,
}: {
    children: React.ReactNode;
    className?: string;
    onStateChange?: (collapsed: boolean) => void;
}) => {
    const headerVisible = useHeaderVisibilityContext();
    const [shouldOffsetSubheader, setShouldOffsetSubheader] = useState(true);
    const [isScrolled, setIsScrolled] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const { view } = useView();

    useEffect(() => {
        let animationFrame: number;
        const checkPosition = () => {
            if (ref.current) {
                const rect = ref.current.getBoundingClientRect();
                // When the header is within 100px of the top, animate it up and change style.
                let isClose = rect.top <= 60;

                setIsScrolled(isClose);

                const updateShouldMoveUpSubHeader = isClose && !headerVisible;
                if (updateShouldMoveUpSubHeader !== shouldOffsetSubheader) {
                    setShouldOffsetSubheader(updateShouldMoveUpSubHeader);
                    onStateChange?.(updateShouldMoveUpSubHeader);
                }
            }
            animationFrame = requestAnimationFrame(checkPosition);
        };

        animationFrame = requestAnimationFrame(checkPosition);
        return () => cancelAnimationFrame(animationFrame);
    }, [headerVisible]);

    // Instead of changing the top value, we always fix the sticky header at top-14
    // then use transform to slide it up by 14 units when the main header is hidden.
    // This ensures both animations use the transform property.
    const defaultBG = `bg-neutral-50 ${
        view?.id === "chat" ? "dark:bg-neutral-700" : "dark:bg-neutral-900"
    }`;
    return (
        <div
            ref={ref}
            className={
                `sticky top-14 z-2 transition-transform duration-800 ease-in-out flex flex-row items-center justify-between  px-2.5   ` +
                (className ?? "")
            }
            style={{
                transform: !shouldOffsetSubheader
                    ? "translateY(0)"
                    : "translateY(-3.5rem)", // 14 (rem/4=3.5rem if 1rem = 4 units)
            }}
        >
            {/* Base layer: gradient background */}
            {
                /*  background-image: linear-gradient(15deg, rgba(23, 23, 23, 1), rgb(46 34 34)) */
                <div
                    className={`absolute inset-0 ${defaultBG} bg-white border-[#ccc] dark:border-none border-t-[1px] border-b-[1px] dark:bg-[linear-gradient(15deg,rgba(23,23,23,1),rgba(45,45,45,1))] drop-shadow-lg ${
                        isScrolled ? "drop-shadow-md" : ""
                    }`}
                ></div>
            }
            {/* Overlay: fades in/out based on scroll */}
            <div
                className={`absolute inset-0 transition-opacity duration-700 ${
                    isScrolled ? "opacity-100" : "opacity-0"
                } ${defaultBG}`}
            ></div>
            {/* Content */}
            <div className="relative flex w-full justify-center">
                {children}
            </div>
        </div>
    );
};
