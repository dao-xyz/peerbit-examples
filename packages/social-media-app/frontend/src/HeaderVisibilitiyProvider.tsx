// HeaderVisibilityContext.tsx
import React, {
    createContext,
    useContext,
    useState,
    useEffect,
    useRef,
} from "react";

function getScrollTop() {
    return window.scrollY || document.documentElement.scrollTop;
}

const useHeaderVisibility = (
    threshold = 50,
    deltaThreshold = 200,
    slowScrollDelay = 100
) => {
    const [visible, setVisible] = useState(true);
    const prevScrollTopRef = useRef(getScrollTop());
    const scrollUpTimeout = useRef<number | null>(null);

    useEffect(() => {
        const handleScroll = () => {
            const currentScrollTop = getScrollTop();
            const isAtTop = currentScrollTop < threshold;
            const delta = prevScrollTopRef.current - currentScrollTop;
            if (isAtTop) {
                // Always show the header when near the top.
                setVisible(true);
                if (scrollUpTimeout.current) {
                    clearTimeout(scrollUpTimeout.current);
                    scrollUpTimeout.current = null;
                }
            } else if (delta > deltaThreshold) {
                // Significant upward scroll: show header immediately.
                setVisible(true);
                console.log("Header visible immediate", delta);

                if (scrollUpTimeout.current) {
                    clearTimeout(scrollUpTimeout.current);
                    scrollUpTimeout.current = null;
                }
            } else if (delta > 0) {
                // Slow upward scroll: schedule showing header after a short delay.
                if (!scrollUpTimeout.current) {
                    scrollUpTimeout.current = window.setTimeout(() => {
                        console.log("Header visible slow", delta);

                        setVisible(true);
                        scrollUpTimeout.current = null;
                    }, slowScrollDelay);
                }
            } else {
                // Scrolling down: cancel any pending upward detection and hide header.
                if (scrollUpTimeout.current) {
                    clearTimeout(scrollUpTimeout.current);
                    scrollUpTimeout.current = null;
                }
                setVisible(false);
            }
            prevScrollTopRef.current = currentScrollTop;
        };
        window.addEventListener("scroll", handleScroll);
        return () => {
            window.removeEventListener("scroll", handleScroll);
            if (scrollUpTimeout.current) {
                clearTimeout(scrollUpTimeout.current);
            }
        };
    }, [threshold, deltaThreshold, slowScrollDelay]);

    return visible;
};

const HeaderVisibilityContext = createContext<boolean>(true);

export const HeaderVisibilityProvider = ({
    children,
}: {
    children: React.ReactNode;
}) => {
    const headerVisible = useHeaderVisibility();
    return (
        <HeaderVisibilityContext.Provider value={headerVisible}>
            {children}
        </HeaderVisibilityContext.Provider>
    );
};

export const useHeaderVisibilityContext = () =>
    useContext(HeaderVisibilityContext);
