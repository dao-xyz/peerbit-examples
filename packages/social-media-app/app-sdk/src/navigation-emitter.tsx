import { useEffect, useRef } from "react";
import { AppClient } from "./client-host";

interface NavigationEmitterProps {
    targetOrigin: string;
}

export const IframeNavigationEmitter = ({
    targetOrigin,
}: NavigationEmitterProps) => {
    const clientRef = useRef<AppClient | null>(null);

    // Initialize AppClient once.
    useEffect(() => {
        clientRef.current = new AppClient({
            targetOrigin,
            onResize: (message) => {
                // Optionally handle resize events.
                console.log("Resize event received:", message.data);
            },
        });
        return () => {
            clientRef.current?.stop();
        };
    }, [targetOrigin]);

    // Use the custom hook to detect location changes.
    useLocationChange((pathname) => {
        if (clientRef.current) {
            clientRef.current.send({
                type: "navigate",
                to: pathname,
            });
        }
    });

    return null;
};

/**
 * A custom hook that calls the provided callback whenever the URL's pathname changes.
 * It patches history.pushState and history.replaceState and listens to popstate and hashchange events.
 */
function useLocationChange(callback: (pathname: string) => void) {
    useEffect(() => {
        const handleLocationChange = () => {
            callback(window.location.pathname);
        };

        // Save original history methods.
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;

        // Monkey-patch pushState.
        history.pushState = function (...args) {
            const result = originalPushState.apply(history, args);
            handleLocationChange();
            return result;
        };

        // Monkey-patch replaceState.
        history.replaceState = function (...args) {
            const result = originalReplaceState.apply(history, args);
            handleLocationChange();
            return result;
        };

        window.addEventListener("popstate", handleLocationChange);
        window.addEventListener("hashchange", handleLocationChange);

        // Call it once initially.
        handleLocationChange();

        return () => {
            // Restore original history methods.
            history.pushState = originalPushState;
            history.replaceState = originalReplaceState;
            window.removeEventListener("popstate", handleLocationChange);
            window.removeEventListener("hashchange", handleLocationChange);
        };
    }, [callback]);
}
