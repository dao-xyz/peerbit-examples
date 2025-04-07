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

function getMaxScrollTop() {
    const documentHeight = Math.max(
        document.body.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.clientHeight,
        document.documentElement.scrollHeight,
        document.documentElement.offsetHeight
    );
    return documentHeight - window.innerHeight;
}

const useHeaderVisibility = (
    threshold = 50,
    deltaThreshold = 200,
    slowScrollDelay = 100,
    bottomBounceTolerance = 50 // tolerance for bounce near bottom
) => {
    const [visible, setVisible] = useState(true);
    const prevScrollTopRef = useRef(getScrollTop());
    const scrollUpTimeout = useRef<number | null>(null);

    useEffect(() => {
        const handleScroll = () => {
            const currentScrollTop = getScrollTop();
            const maxScrollTop = getMaxScrollTop();

            // If content is not scrollable (maxScrollTop is very small),
            // always show the header.
            if (maxScrollTop < bottomBounceTolerance) {
                setVisible(true);
                if (scrollUpTimeout.current) {
                    clearTimeout(scrollUpTimeout.current);
                    scrollUpTimeout.current = null;
                }
                prevScrollTopRef.current = currentScrollTop;
                return;
            }

            // If we're near the bottom (i.e. in the bounce zone), hide the header.
            if (maxScrollTop - currentScrollTop < bottomBounceTolerance) {
                setVisible(false);
                if (scrollUpTimeout.current) {
                    clearTimeout(scrollUpTimeout.current);
                    scrollUpTimeout.current = null;
                }
                prevScrollTopRef.current = currentScrollTop;
                return;
            }

            const isAtTop = currentScrollTop < threshold;
            const delta = prevScrollTopRef.current - currentScrollTop;

            if (isAtTop) {
                // Always show header when near the top.
                setVisible(true);
                if (scrollUpTimeout.current) {
                    clearTimeout(scrollUpTimeout.current);
                    scrollUpTimeout.current = null;
                }
            } else if (delta > deltaThreshold) {
                // Significant upward scroll: show header immediately.
                setVisible(true);
                if (scrollUpTimeout.current) {
                    clearTimeout(scrollUpTimeout.current);
                    scrollUpTimeout.current = null;
                }
            } else if (delta > 0) {
                // Slow upward scroll: schedule header showing after a short delay.
                if (!scrollUpTimeout.current) {
                    scrollUpTimeout.current = window.setTimeout(() => {
                        setVisible(true);
                        scrollUpTimeout.current = null;
                    }, slowScrollDelay);
                }
            } else {
                // Scrolling down: cancel any pending timeout and hide header.
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
    }, [threshold, deltaThreshold, slowScrollDelay, bottomBounceTolerance]);

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
