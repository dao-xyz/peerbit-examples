// src/NavigationEffects.tsx
import { useEffect } from "react";
import { useLocation } from "react-router";

/**
 * Blurs any still-focused element every time the URL changes.
 * Fixes iOS “ghost focus” so your :has(input:focus-visible) rule
 * stops matching after navigation.
 */
export function NavigationEffects() {
    const location = useLocation();

    useEffect(() => {
        if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
        }
    }, [location]); // ← runs after every navigation

    return null; // nothing visual
}
