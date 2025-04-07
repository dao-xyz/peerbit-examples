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
    downDeltaThreshold = 20, // amount to scroll down from last upward position to hide header
    bottomBounceTolerance = 50 // tolerance for bounce near bottom
) => {
    const [visible, setVisible] = useState(true);
    const prevScrollTopRef = useRef(getScrollTop());
    const lastUpPositionRef = useRef(getScrollTop());

    useEffect(() => {
        const handleScroll = () => {
            const currentScrollTop = getScrollTop();
            const maxScrollTop = getMaxScrollTop();

            // If content isn't scrollable, always show the header.
            if (maxScrollTop < bottomBounceTolerance) {
                setVisible(true);
                prevScrollTopRef.current = currentScrollTop;
                lastUpPositionRef.current = currentScrollTop;
                return;
            }

            // If we're near the bottom (bounce zone), hide the header.
            if (maxScrollTop - currentScrollTop < bottomBounceTolerance) {
                setVisible(false);
                prevScrollTopRef.current = currentScrollTop;
                return;
            }

            if (currentScrollTop < threshold) {
                // Near top, always show.
                setVisible(true);
                lastUpPositionRef.current = currentScrollTop;
            } else {
                if (currentScrollTop < prevScrollTopRef.current) {
                    // Scrolling up (even slowly): lock the header visible and record this upward position.
                    setVisible(true);
                    lastUpPositionRef.current = currentScrollTop;
                } else if (currentScrollTop > prevScrollTopRef.current) {
                    // Scrolling down: only hide header if we've gone down enough from the last upward position.
                    if (
                        currentScrollTop - lastUpPositionRef.current >
                        downDeltaThreshold
                    ) {
                        setVisible(false);
                    }
                }
            }
            prevScrollTopRef.current = currentScrollTop;
        };

        window.addEventListener("scroll", handleScroll);
        return () => {
            window.removeEventListener("scroll", handleScroll);
        };
    }, [threshold, downDeltaThreshold, bottomBounceTolerance]);

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
