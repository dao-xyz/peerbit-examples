import { useLayoutEffect, useRef } from "react";

/**
 * Keep the element’s height stored in a CSS custom property.
 *
 * @param cssVar   The custom property name – e.g. `"--header-h"`.
 * @param root     The element on which to set the variable (defaults to <html>).
 * @returns        A ref you attach to the element you want to measure.
 */
export function useCssVarHeight<T extends HTMLElement>(properties?: {
    cssVar: string;
    root?: HTMLElement;
    onChange?: (height: number) => void;
}) {
    const ref = useRef<T | null>(null);
    const {
        cssVar,
        root = document.documentElement,
        onChange,
    } = properties || {};

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;

        const set = (h: number) => {
            root.style.setProperty(cssVar, `${h}px`);
            onChange?.(h);
        };

        // Initial measure
        set(el.offsetHeight);

        // Keep it in-sync on resize
        const ro = new ResizeObserver(([entry]) => {
            if (entry.target === el) set(entry.contentRect.height);
        });
        ro.observe(el);

        return () => ro.disconnect();
    }, [cssVar, root]);

    return ref;
}
