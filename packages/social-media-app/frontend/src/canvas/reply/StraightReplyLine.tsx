import React, { useEffect, useRef, useState } from "react";
import debounce from "lodash/debounce";

type Point = { x: number; y: number };

export type LineType = "start" | "middle" | "end" | "end-and-start" | "none";

export type StraightReplyLineProps = {
    replyRefs: HTMLDivElement[];
    containerRef: React.RefObject<HTMLDivElement>;
    lineTypes: LineType[];
};

export const StraightReplyLine: React.FC<StraightReplyLineProps> = ({
    replyRefs,
    containerRef,
    lineTypes,
}) => {
    const [segments, setSegments] = useState<{ d: string; length: number }[]>(
        []
    );
    const [viewBox, setViewBox] = useState("");

    // runCalculations computes the left-aligned points and groups them.
    const runCalculations = () => {
        if (!containerRef.current) return;

        const containerRect = containerRef.current.getBoundingClientRect();
        setViewBox(`0 0 ${containerRect.width} ${containerRect.height}`);

        // Set a constant left margin for the x coordinate.
        const leftMargin = 5;
        let index = 0;

        // Calculate y coordinate for each reply element while keeping x fixed.
        // (We apply the same logic for "end" types to optionally adjust y.)
        const points: (Point | null)[] = replyRefs.map((ref, i) => {
            if (ref) {
                const rect = ref.getBoundingClientRect();
                const isLast =
                    lineTypes[index] === "end" ||
                    lineTypes[index] === "end-and-start";
                const y =
                    rect.top - containerRect.top + (isLast ? rect.height : 0);
                index++;
                return { x: leftMargin, y };
            }
            return null;
        });
        const validPoints = points.filter((p): p is Point => p !== null);

        if (validPoints.length < 2) {
            setSegments([]);
            return;
        }

        // Group points where the line should be drawn continuously.
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

        // For each group, connect the points with straight line segments.
        const groupSegments = groups
            .map((group) => {
                if (group.length < 2) return null;
                let d = `M ${group[0].x} ${group[0].y}`;
                let totalLength = 0;
                for (let i = 1; i < group.length; i++) {
                    d += ` L ${group[i].x} ${group[i].y}`;
                    totalLength += Math.hypot(
                        group[i].x - group[i - 1].x,
                        group[i].y - group[i - 1].y
                    );
                }
                return { d, length: totalLength };
            })
            .filter(
                (seg): seg is { d: string; length: number } => seg !== null
            );

        setSegments(groupSegments);
    };

    // Recalculate positions when dependencies change.
    useEffect(() => {
        if (!containerRef.current) return;
        const debouncedCalc = debounce(runCalculations, 50, {
            leading: false,
            trailing: true,
        });
        debouncedCalc();
        return () => debouncedCalc.cancel();
    }, [replyRefs, containerRef, lineTypes]);

    // Optionally, re-run calculations periodically for a short time in case the layout is still updating.
    const count = useRef(0);
    useEffect(() => {
        const interval = setInterval(() => {
            runCalculations();
            count.current++;
            if (count.current > 5) {
                clearInterval(interval);
            }
        }, 300);
        return () => clearInterval(interval);
    }, []);

    if (!viewBox) return null;

    return (
        <svg
            className="absolute inset-0 pointer-events-none"
            style={{ /* zIndex: 1, */ width: "100%", height: "100%" }}
            viewBox={viewBox}
        >
            <defs>
                {/*  <filter id="sketchyFilter">
                    <feTurbulence
                        type="fractalNoise"
                        baseFrequency="0.5" // Lower frequency for a subtler noise
                        numOctaves="1"
                        result="noise"
                    />
                    <feDisplacementMap
                        in="SourceGraphic"
                        in2="noise"
                        scale="2" // Adjust the scale to reduce the distortion
                        xChannelSelector="R"
                        yChannelSelector="G"
                    />
                </filter> */}
            </defs>
            {segments.map((seg, index) => (
                <path
                    key={index}
                    d={seg.d}
                    strokeWidth={3}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    stroke="black" /* 
                    style={{
                        filter: "url(#sketchyFilter)",
                    }} */
                    className="dark:stroke-neutral-500 stroke-neutral-600/30"
                />
            ))}
        </svg>
    );
};
