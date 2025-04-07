// StickyHeader.tsx
import React, { useEffect, useRef, useState } from "react";
import { useHeaderVisibilityContext } from "../../HeaderVisibilitiyProvider";

export const StickyHeader = ({
    children,
    className,
}: {
    children: React.ReactNode;
    className?: string;
}) => {
    const headerVisible = useHeaderVisibilityContext();
    const [shouldOffsetSubheader, setShouldOffsetSubheader] = useState(true);
    const [isScrolled, setIsScrolled] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let animationFrame: number;
        const checkPosition = () => {
            if (ref.current) {
                const rect = ref.current.getBoundingClientRect();
                // When the header is within 100px of the top, animate it up and change style.
                let isClose = rect.top <= 100;
                setIsScrolled(isClose);
                const shouldMoveUpSubHeader = isClose && !headerVisible;
                setShouldOffsetSubheader(shouldMoveUpSubHeader);
            }
            animationFrame = requestAnimationFrame(checkPosition);
        };

        animationFrame = requestAnimationFrame(checkPosition);
        return () => cancelAnimationFrame(animationFrame);
    }, [headerVisible]);

    // Instead of changing the top value, we always fix the sticky header at top-14
    // then use transform to slide it up by 14 units when the main header is hidden.
    // This ensures both animations use the transform property.

    return (
        <div
            ref={ref}
            className={
                `sticky top-14 z-10 transition-transform duration-800 ease-in-out flex flex-row items-center justify-between py-1 px-2.5 ` +
                (className ?? "")
            }
            style={{
                transform: !shouldOffsetSubheader
                    ? "translateY(0)"
                    : "translateY(-3.5rem)", // 14 (rem/4=3.5rem if 1rem = 4 units)
            }}
        >
            {/* Base layer: gradient background */}
            <div
                className={`absolute inset-0 bg-white border-[#ccc] dark:border-none border-t-[1px] border-b-[1px] dark:bg-[radial-gradient(circle,rgba(57,57,57,1)_0%,rgba(10,10,10,1)_100%)] drop-shadow-lg ${
                    isScrolled ? "drop-shadow-md" : ""
                }`}
            ></div>
            {/* Overlay: fades in/out based on scroll */}
            <div
                className={`absolute inset-0 transition-opacity duration-700 ${
                    isScrolled ? "opacity-100" : "opacity-0"
                } bg-neutral-50 dark:bg-neutral-950`}
            ></div>
            {/* Content */}
            <div className="relative z-10 flex w-full justify-center">
                {children}
            </div>
        </div>
    );
};
