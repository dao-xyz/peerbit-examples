import React, { useEffect, useState } from "react";

type Point = { x: number; y: number };

export type LineType = "start" | "middle" | "end" | "end-and-start" | "none";

export type SmoothReplyLineProps = {
    replyRefs: React.RefObject<HTMLDivElement>[];
    containerRef: React.RefObject<HTMLDivElement>;
    lineTypes: LineType[];
};

// Helper: Dampens the x–coordinate of points toward the group's average x.
// factor of 0.5 pulls each point halfway toward the average.
function dampenPoints(points: Point[], factor: number): Point[] {
    const avgX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    return points.map((p) => ({
        ...p,
        x: avgX + (p.x - avgX) * factor,
    }));
}

// Helper function to compute smooth path segments using Catmull-Rom-to-Bezier conversion.
// Returns an array of segment objects with a path string and an approximate length.
function createSmoothPathSegments(
    points: Point[],
    tension = 0.5
): { d: string; length: number }[] {
    if (points.length < 2) return [];
    // Extend the points array by replicating the first and last points.
    const pts = [points[0], ...points, points[points.length - 1]];
    const segments: { d: string; length: number }[] = [];
    for (let i = 1; i < pts.length - 2; i++) {
        const p0 = pts[i - 1];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[i + 2];

        // Calculate control points using Catmull-Rom to cubic Bezier conversion.
        const cp1x = p1.x + ((p2.x - p0.x) * tension) / 6;
        const cp1y = p1.y + ((p2.y - p0.y) * tension) / 6;
        const cp2x = p2.x - ((p3.x - p1.x) * tension) / 6;
        const cp2y = p2.y - ((p3.y - p1.y) * tension) / 6;

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
}) => {
    const [segments, setSegments] = useState<{ d: string; length: number }[]>(
        []
    );
    const [viewBox, setViewBox] = useState("");

    useEffect(() => {
        if (!containerRef.current) return;
        const containerRect = containerRef.current.getBoundingClientRect();
        setViewBox(`0 0 ${containerRect.width} ${containerRect.height}`);

        // Compute center points for each reply relative to the container.
        const points: (Point | null)[] = replyRefs.map((ref) => {
            const el = ref.current;
            if (el) {
                const rect = el.getBoundingClientRect();
                return {
                    x: rect.left + rect.width / 2 - containerRect.left,
                    y: rect.top + rect.height / 2 - containerRect.top,
                };
            }
            return null;
        });
        const validPoints = points.filter((p): p is Point => p !== null);

        // Ensure we have a matching number of lineTypes.
        if (validPoints.length < 2 || validPoints.length !== lineTypes.length) {
            setSegments([]);
            return;
        }

        // Group points into continuous segments.
        // Break the chain whenever the corresponding lineType is "none".
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

        // Dampening factor: lower values pull points closer to the group average.
        const dampeningFactor = 0.3;
        const dampenedGroups = groups.map((group) =>
            dampenPoints(group, dampeningFactor)
        );

        // For each group, compute the smooth segments.
        const groupSegments = dampenedGroups.map((group) =>
            createSmoothPathSegments(group, 1.4)
        );
        const flatSegments = groupSegments.flat();
        setSegments(flatSegments);
    }, [replyRefs, containerRef, lineTypes]);

    if (!viewBox) return null;

    return (
        <svg
            className="absolute inset-0 pointer-events-none"
            style={{ zIndex: -1, width: "100%", height: "100%" }}
            viewBox={viewBox}
        >
            <defs>
                {/* Define a filter that gives the stroke a sketchy, hand-drawn look. */}
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
                // Use a threshold for length to determine dash pattern and stroke thickness.
                const lengthThreshold = 400;
                const strokeDasharray = seg.length > 100 ? "35,35" : "15,15";
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
                        className="dark:stroke-neutral-700 stroke-neutral-500/30"
                    />
                );
            })}
        </svg>
    );
};
