import { ReplicationRangeIndexable } from "@peerbit/shared-log";
import { PublicSignKey } from "@peerbit/crypto";
import { MediaStreamDB } from "@peerbit/video-lib";
import { useMaxTime } from "./useMaxTime";
import { useReplicationChange } from "./useReplicationChange.js";

const getBarsFromRanges = (props: {
    publicKey?: PublicSignKey;
    maxTime: number;
    ranges?: ReplicationRangeIndexable<"u64">[];
    resolution: number;
}): { count: number }[] => {
    const { resolution, maxTime, ranges } = props;
    // Create an array of bars with an initial count of 0
    let bars = Array.from({ length: resolution }, () => ({ count: 0 }));

    if (!ranges || ranges.length === 0) {
        return bars;
    }

    for (let range of ranges) {
        const startRange =
            range.start1 !== range.start2 ? range.start2 : range.start1;
        const endRange =
            range.start1 !== range.start2 ? range.end2 : range.end1;

        let start = Math.round(
            (Number(startRange) / 1000 / maxTime) * resolution
        );
        let end = Math.min(
            Math.round((Number(endRange) / 1000 / maxTime) * resolution),
            resolution
        );

        for (let x = start; x < end; x++) {
            bars[x].count += 1;
        }
    }
    return bars;
};

// -- Helper functions for color interpolation --

function hexToRgb(hex: string) {
    hex = hex.replace("#", "");
    if (hex.length === 3) {
        hex = hex
            .split("")
            .map((x) => x + x)
            .join("");
    }
    const num = parseInt(hex, 16);
    return {
        r: (num >> 16) & 255,
        g: (num >> 8) & 255,
        b: num & 255,
    };
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }) {
    const toHex = (c: number) => {
        const hex = c.toString(16);
        return hex.length === 1 ? "0" + hex : hex;
    };
    // Fix: use backticks for template literal
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Linearly interpolate between two hex colors given a t in [0, 1]
const interpolateColor = (
    t: number,
    color1: string,
    color2: string
): string => {
    const c1 = hexToRgb(color1);
    const c2 = hexToRgb(color2);
    const r = Math.round(c1.r + (c2.r - c1.r) * t);
    const g = Math.round(c1.g + (c2.g - c1.g) * t);
    const b = Math.round(c1.b + (c2.b - c1.b) * t);
    return rgbToHex({ r, g, b });
};

// Map a replication count to either an inline style (for an interpolated color)
// or a Tailwind class when fully replicated.
const getBarStyle = (
    count: number
): { style?: React.CSSProperties; className?: string } => {
    const replicationThreshold = 5; // Adjust this threshold as needed.
    const red = "#ff0000"; // Unreplicated color
    const primaryHex = "#3b82f6"; // Hex value matching bg-primary-500

    // Compute a normalized value (t) where:
    // count === 1 results in t = 0 (red),
    // count >= replicationThreshold results in t = 1 (primary)
    const t = Math.max(
        0,
        Math.min(1, (count - 1) / (replicationThreshold - 1))
    );
    const color = interpolateColor(t, red, primaryHex);

    // If the bar is fully replicated, return the Tailwind class.
    if (t >= 1) {
        return { className: "bg-primary-500" };
    } else {
        return { style: { backgroundColor: color } };
    }
};

export const ReplicationRangeVisualization = (props: {
    mediaStreams?: MediaStreamDB;
}) => {
    const resolution = 100;
    const { maxTime } = useMaxTime({ mediaStreams: props.mediaStreams });
    const ranges = useReplicationChange({ mediaStreams: props.mediaStreams });
    const bars = ranges
        ? getBarsFromRanges({
              maxTime,
              publicKey: props.mediaStreams?.node.identity.publicKey,
              resolution,
              ranges,
          })
        : Array.from({ length: resolution }, () => ({ count: 0 }));

    // Normalize: use the highest count (or 10, if counts are low) as the denominator
    const maxCount = bars.reduce((max, bar) => Math.max(max, bar.count), 0);
    const normalizationDenom = Math.max(maxCount, 10);

    return (
        <>
            {ranges && (
                <div className="absolute inset-0 pointer-events-none">
                    {bars.map((bar, x) => {
                        const { style, className } = getBarStyle(bar.count);
                        return (
                            <div
                                key={x}
                                style={{
                                    position: "absolute",
                                    left: `${(x / resolution) * 100}%`,
                                    bottom: 0,
                                    width: `${100 / resolution}%`,
                                    height: `${Math.round(
                                        (bar.count / normalizationDenom) * 30
                                    )}px`,
                                    ...style,
                                }}
                                className={className}
                            />
                        );
                    })}
                </div>
            )}
        </>
    );
};
