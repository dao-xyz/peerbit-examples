import { useEffect, useRef, useState } from "react";

export const StickyHeader = ({ children }) => {
    const headerRef = useRef<HTMLDivElement>(null);
    const [isScrolled, setIsScrolled] = useState(false);

    useEffect(() => {
        let animationFrame: number;
        const checkPosition = () => {
            if (headerRef.current) {
                const rect = headerRef.current.getBoundingClientRect();
                // When the header is within 130px of the top, reveal the overlay.
                setIsScrolled(rect.top <= 130);
            }
            animationFrame = requestAnimationFrame(checkPosition);
        };

        animationFrame = requestAnimationFrame(checkPosition);
        return () => cancelAnimationFrame(animationFrame);
    }, []);

    return (
        <div
            ref={headerRef}
            className="sticky top-14 z-10 flex flex-row items-center justify-between py-1 px-2.5"
        >
            {/* Base layer: gradient background */}
            <div className="absolute inset-0 bg-[#e5e5e5] border-[#ccc] dark:border-[#6e6e6e82] border-t-[1px] border-b-[1px] dark:bg-[radial-gradient(circle,rgba(57,57,57,1)_0%,rgba(10,10,10,1)_100%)] drop-shadow-md"></div>
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
