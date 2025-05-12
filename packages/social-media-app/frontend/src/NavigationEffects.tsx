// src/NavigationEffects.tsx
import { useEffect } from "react";
import { useLocation } from "react-router";

/**
 * Blurs any still-focused element every time the URL changes.
 * Fixes iOS “ghost focus” so your :has(input:focus-visible) rule
 * stops matching after navigation.
 */
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
export function NavigationEffects() {
    const location = useLocation();

    useEffect(() => {
        if (isIOS) {
            // TODO test other devices if this is necessary
            if (document.activeElement instanceof HTMLElement) {
                document.activeElement.blur();
                console.log("BLUR!");
            }
        }
    }, [location]); // ← runs after every navigation

    return null; // nothing visual
}
