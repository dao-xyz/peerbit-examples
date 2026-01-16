import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { NavigationType, UNSAFE_LocationContext, useLocation, useNavigationType } from "react-router";
import clsx from "clsx";
import { inIframe } from "@peerbit/react";
import { Header } from "./Header";
import { BaseRoutes } from "./routes";
import { useHeaderVisibilityContext } from "./HeaderVisibilitiyProvider";
import { CanvasProvider } from "./canvas/useCanvas";
import { CustomizationProvider } from "./canvas/custom/CustomizationProvider";
import { CustomizedBackground } from "./canvas/custom/applyVisualization";
import { StreamProvider } from "./canvas/feed/StreamContext";
import { ActiveLayerProvider } from "./layers/ActiveLayerContext";
import { LayerEntryProvider } from "./layers/LayerEntryContext";

const DEFAULT_STACK_DEPTH = 5;
const HEADER_EXPANDED_HEIGHT = 12;
const heightStyle: { [expanded: string]: string } = {
    true: `min-h-${HEADER_EXPANDED_HEIGHT}`,
    false: `min-h-${HEADER_EXPANDED_HEIGHT}`,
};

type StackEntry = { idx: number; location: any };

const historyIdx = () => {
    try {
        const idx = (window.history.state as any)?.idx;
        return typeof idx === "number" ? idx : 0;
    } catch {
        return 0;
    }
};

const isStackablePath = (pathname: string) =>
    pathname === "/" || pathname.startsWith("/c/");

const cloneLocation = (loc: any) => ({
    pathname: loc.pathname,
    search: loc.search,
    hash: loc.hash,
    state: loc.state,
    key: loc.key,
});

function LayerFrame({ active }: { active: boolean }) {
    const { visible: headerVisible } = useHeaderVisibilityContext();

    return (
        <>
            {active && (
                <div
                    className={clsx(
                        "sticky top-0 inset-x-0 z-30",
                        heightStyle[String(headerVisible)]
                    )}
                >
                    <Header fullscreen={inIframe()} />
                </div>
            )}

            <BaseRoutes enableEffects={active} />
        </>
    );
}

function StackLayer({
    entry,
    active,
    navigationType,
}: {
    entry: StackEntry;
    active: boolean;
    navigationType: NavigationType;
}) {
    const locationContextValue = useMemo(
        () => ({
            location: entry.location,
            navigationType,
        }),
        [entry.location, navigationType]
    );

    return (
        <div style={{ display: active ? "block" : "none" }}>
            <UNSAFE_LocationContext.Provider value={locationContextValue}>
                <ActiveLayerProvider active={active}>
                    <LayerEntryProvider idx={entry.idx}>
                        <CanvasProvider>
                            <CustomizationProvider>
                                <CustomizedBackground className="h-full">
                                    <StreamProvider>
                                        <LayerFrame active={active} />
                                    </StreamProvider>
                                </CustomizedBackground>
                            </CustomizationProvider>
                        </CanvasProvider>
                    </LayerEntryProvider>
                </ActiveLayerProvider>
            </UNSAFE_LocationContext.Provider>
        </div>
    );
}

export function LayeredContent(props?: { depth?: number }) {
    const depth = props?.depth ?? DEFAULT_STACK_DEPTH;
    const location = useLocation();
    const navigationType = useNavigationType();
    const idx = useMemo(() => historyIdx(), [location.key]);

    const [entries, setEntries] = useState<StackEntry[]>(() => [
        { idx, location: cloneLocation(location) },
    ]);

    const scrollByIdxRef = useRef(new Map<number, number>());

    useLayoutEffect(() => {
        const saved = scrollByIdxRef.current.get(idx);
        if (typeof saved === "number") {
            window.scrollTo({ top: saved, behavior: "instant" as any });
        } else if (navigationType === NavigationType.Push) {
            window.scrollTo({ top: 0, behavior: "instant" as any });
        }

        return () => {
            try {
                scrollByIdxRef.current.set(idx, window.scrollY);
            } catch {}
        };
    }, [idx, navigationType]);

    useEffect(() => {
        const entry = { idx, location: cloneLocation(location) };
        const stackable = isStackablePath(location.pathname);

        setEntries((prev) => {
            if (!stackable) {
                return [entry];
            }

            let next = prev.filter((e) => e.idx <= idx);
            const existing = next.findIndex((e) => e.idx === idx);
            if (existing === -1) {
                next.push(entry);
            } else {
                next[existing] = entry;
            }

            next.sort((a, b) => a.idx - b.idx);
            const minIdx = idx - Math.max(depth - 1, 0);
            next = next.filter((e) => e.idx >= minIdx);
            return next;
        });
    }, [idx, depth, location.key, location.pathname, location.search, location.hash]);

    return (
        <>
            {entries.map((entry) => (
                <StackLayer
                    key={entry.idx}
                    entry={entry}
                    active={entry.idx === idx}
                    navigationType={navigationType}
                />
            ))}
        </>
    );
}
