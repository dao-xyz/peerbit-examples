/* BlurOnOutsidePointerProvider.tsx */
import {
    createContext,
    PropsWithChildren,
    useContext,
    useEffect,
    useRef,
} from "react";

type Ctx = { enabled: boolean; toggle: (on: boolean) => void };

const BlurCtx = createContext<Ctx | undefined>(undefined);

export interface ProviderProps {
    /** start with the behaviour active? (default true) */
    defaultEnabled?: boolean;
}

export function BlurOnOutsidePointerProvider({
    children,
    defaultEnabled = true,
}: PropsWithChildren<ProviderProps>) {
    const enabledRef = useRef(defaultEnabled);

    useEffect(() => {
        if (typeof window === "undefined") return; // SSR guard

        function handlePointerDown(ev: PointerEvent) {
            if (!enabledRef.current) return;

            const active = document.activeElement as HTMLElement | null;
            if (
                active &&
                active.matches("input, textarea, [contenteditable]") &&
                // if the pointer target is *not* the focused element
                // and *not* a descendant of it (important for datalists, etc.)
                !active.contains(ev.target as Node)
            ) {
                active.blur();
            }
        }

        // Capture phase guarantees we run before React’s synthetic events
        window.addEventListener("pointerdown", handlePointerDown, true);

        return () =>
            window.removeEventListener("pointerdown", handlePointerDown, true);
    }, []);

    const ctx: Ctx = {
        enabled: enabledRef.current,
        toggle: (on) => {
            enabledRef.current = on;
        },
    };

    return <BlurCtx.Provider value={ctx}>{children}</BlurCtx.Provider>;
}

/* handy hook, optional */
export function useBlurOnOutsidePointer() {
    const ctx = useContext(BlurCtx);
    if (!ctx)
        throw new Error(
            "`useBlurOnOutsidePointer` must be used inside the provider"
        );
    return ctx;
}
