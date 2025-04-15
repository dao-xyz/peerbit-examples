import React, { useEffect, useRef, useState } from "react";
import debounce from "lodash/debounce";

type Point = { x: number; y: number };

export type LineType = "start" | "middle" | "end" | "end-and-start" | "none";

export type SmoothReplyLineProps = {
    replyRefs: HTMLDivElement[];
    containerRef: React.RefObject<HTMLDivElement>;
    lineTypes: LineType[];
    anchorPoints?: ("left" | "right" | "center")[];
};

// Helper: Smooths the x–coordinate of each point using a moving average over a given window.
// The smoothing factor (0–1) determines how much to blend the local average with the original value.
function smoothPoints(
    points: Point[],
    windowSize: number,
    factor: number
): Point[] {
    const n = points.length;
    return points.map((p, i) => {
        // Determine the window boundaries (clamped to valid indices)
        const start = Math.max(0, i - windowSize);
        const end = Math.min(n - 1, i + windowSize);
        let sum = 0;
        let count = 0;
        for (let j = start; j <= end; j++) {
            sum += points[j].x;
            count++;
        }
        const localAvg = sum / count;
        return {
            ...p,
            // Blend original x with the local average.
            x: p.x * (1 - factor) + localAvg * factor,
        };
    });
}

// Helper function to compute smooth path segments using Catmull-Rom-to-Bezier conversion.
function createSmoothPathSegments(
    points: Point[],
    tension = 0.5
): { d: string; length: number }[] {
    if (points.length < 2) return [];
    // Extend the points array by replicating the first and last points.
    const pts = [points[0], ...points, points[points.length - 1]];
    const segments: { d: string; length: number }[] = [];
    const minHorizontalDiff = 5; // Minimum horizontal difference (in pixels)

    for (let i = 1; i < pts.length - 2; i++) {
        const p0 = pts[i - 1];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[i + 2];

        // Calculate control points using Catmull-Rom to cubic Bezier conversion.
        let cp1x = p1.x + ((p2.x - p0.x) * tension) / 6;
        let cp1y = p1.y + ((p2.y - p0.y) * tension) / 6;
        let cp2x = p2.x - ((p3.x - p1.x) * tension) / 6;
        let cp2y = p2.y - ((p3.y - p1.y) * tension) / 6;

        // Check if the horizontal difference between p1 and p2 is too small.
        const horizontalDiff = p2.x - p1.x;
        if (Math.abs(horizontalDiff) < minHorizontalDiff) {
            // If exactly zero, choose a positive offset; otherwise use the sign of the difference.
            const offset =
                horizontalDiff === 0
                    ? minHorizontalDiff
                    : horizontalDiff > 0
                    ? minHorizontalDiff
                    : -minHorizontalDiff;
            cp1x = p1.x + offset;
            cp2x = p2.x + offset;
        }

        const d = `M ${p1.x} ${p1.y} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
        // Approximate the segment length using the Euclidean distance between p1 and p2.
        const length = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        segments.push({ d, length });
    }
    return segments;
}

export const SmoothReplyLine: React.FC<SmoothReplyLineProps> = ({
    replyRefs,
    containerRef,
    lineTypes,
    anchorPoints,
}) => {
    const [segments, setSegments] = useState<{ d: string; length: number }[]>(
        []
    );
    const [viewBox, setViewBox] = useState("");

    const runCalculations = () => {
        const containerRect = containerRef.current!.getBoundingClientRect();
        setViewBox(`0 0 ${containerRect.width} ${containerRect.height}`);

        let index = 0;
        const points: (Point | null)[] = replyRefs.map((ref) => {
            const el = ref;
            if (el) {
                const rect = el.getBoundingClientRect();
                let anchor = anchorPoints?.[index] ?? "center";

                let x: number;
                let margin = 20;
                // never make the line cross middle of the screen for left and right
                if (anchor === "left") {
                    x = rect.right - containerRect.left + margin;
                    if (x > containerRect.width / 2) {
                        x = containerRect.width / 2;
                    }
                } else if (anchor === "right") {
                    x = rect.left - containerRect.left - margin;
                    if (x < containerRect.width / 2) {
                        x = containerRect.width / 2;
                    }
                } else {
                    x = rect.left + rect.width / 2 - containerRect.left;
                }

                // For the first element, we originally set y so that it starts at the top.
                let y: number;
                /*  if (index === 0) {
                     y = rect.top - rect.height - containerRect.top;
                 } else {
                     y = rect.top + rect.height / 2 - containerRect.top;
                 } */
                y = rect.top - containerRect.top;
                index++;
                return { x, y };
            }
            return null;
        });
        const validPoints = points.filter((p): p is Point => p !== null);

        if (validPoints.length < 2) {
            setSegments([]);
            return;
        }

        const groups: Point[][] = [];
        let currentGroup: Point[] = [];
        for (let i = 0; i < validPoints.length; i++) {
            if (lineTypes[i] === "none") {
                if (currentGroup.length >= 2) {
                    groups.push(currentGroup);
                }
                currentGroup = [];
            } else {
                currentGroup.push(validPoints[i]);
            }
        }
        if (currentGroup.length >= 2) {
            groups.push(currentGroup);
        }

        const windowSize = 1; // Look at 10 neighbors on each side
        const smoothingFactor = 0.7; // Blend 30% with local average
        const tension = 0.7; // Tension for Catmull-Rom to Bezier conversion
        const smoothedGroups = groups.map((group) =>
            smoothPoints(group, windowSize, smoothingFactor)
        );

        const groupSegments = smoothedGroups.map((group) =>
            createSmoothPathSegments(group, tension)
        );
        const flatSegments = groupSegments.flat();
        setSegments(flatSegments);
    };

    useEffect(() => {
        if (!containerRef.current) return;

        // Create a debounced version of the calculation function.
        const debouncedCalc = debounce(runCalculations, 50, {
            leading: false,
            trailing: true,
        });
        debouncedCalc();

        // Cleanup by cancelling the debounced call if the effect re-runs.
        return () => debouncedCalc.cancel();
    }, [replyRefs, containerRef, lineTypes, anchorPoints]);

    const count = useRef(0);
    useEffect(() => {
        const interval = setInterval(() => {
            runCalculations();
            count.current++;
            if (count.current > 5) {
                clearInterval(interval);
            }
        }, 1000);
        return () => {
            clearInterval(interval);
        };
    }, []);

    if (!viewBox) return null;

    return (
        <svg
            className="absolute inset-0 pointer-events-none "
            style={{ zIndex: 0, width: "100%", height: "100%" }}
            viewBox={viewBox}
        >
            <defs>
                <filter id="sketchyFilter">
                    <feTurbulence
                        type="fractalNoise"
                        baseFrequency="0.3"
                        numOctaves="1"
                        result="noise"
                    />
                    <feDisplacementMap
                        in="SourceGraphic"
                        in2="noise"
                        scale="5"
                        xChannelSelector="R"
                        yChannelSelector="G"
                    />
                </filter>
            </defs>
            {segments.map((seg, index) => {
                const lengthThreshold = 400;
                const strokeDasharray = seg.length > 100 ? "35,35" : "35,35"; // Adjust as needed
                const strokeWidth = seg.length > lengthThreshold ? 3 : 3;
                return (
                    <path
                        key={index}
                        d={seg.d}
                        strokeWidth={strokeWidth}
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        stroke="black"
                        style={{
                            strokeDasharray,
                            filter: "url(#sketchyFilter)",
                        }}
                        className="dark:stroke-neutral-500 stroke-neutral-300/30 stroke-da"
                    />
                );
            })}
        </svg>
    );
};
