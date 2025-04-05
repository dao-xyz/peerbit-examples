import path from "path";
import React, { useEffect, useState } from "react";

type Point = { x: number; y: number };

export type LineType = "start" | "middle" | "end" | "end-and-start" | "none";

export type SmoothReplyLineProps = {
    replyRefs: React.RefObject<HTMLDivElement>[];
    containerRef: React.RefObject<HTMLDivElement>;
    lineTypes: LineType[];
};

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
    const [paths, setPaths] = useState<string[]>([]);
    const [viewBox, setViewBox] = useState("");

    useEffect(() => {
        if (!containerRef.current) return;
        const containerRect = containerRef.current.getBoundingClientRect();
        setViewBox(`0 0 ${containerRect.width} ${containerRect.height}`);

        // Compute center points for each reply relative to the container.
        let pathCounter = 0;
        const points: (Point | null)[] = replyRefs.map((ref, ix) => {
            const el = ref.current;
            if (el) {
                pathCounter++;
                const rect = el.getBoundingClientRect();
                return {
                    x: rect.left + rect.width / 2 - containerRect.left,
                    y:
                        pathCounter === 1
                            ? 0
                            : rect.top + rect.height / 2 - containerRect.top,
                };
            }
            return null;
        });
        const validPoints = points.filter((p): p is Point => p !== null);

        // Ensure we have a matching number of lineTypes.
        if (validPoints.length < 2) {
            setPaths([]);
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

        // For each group, generate the smooth path string.
        const groupPaths = groups.map((group) => {
            const segs = createSmoothPathSegments(group, 0.7);
            return segs.map((seg) => seg.d).join(" ");
        });
        setPaths(groupPaths);
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
            {paths.map((pathData, index) => (
                <path
                    key={index}
                    d={pathData}
                    strokeWidth="4"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    stroke="black"
                    style={{
                        filter: "url(#sketchyFilter)",
                        strokeDasharray: "45, 45",
                    }}
                    className="dark:stroke-neutral-800 stroke-neutral-200 stroke-da"
                />
            ))}
        </svg>
    );
};
