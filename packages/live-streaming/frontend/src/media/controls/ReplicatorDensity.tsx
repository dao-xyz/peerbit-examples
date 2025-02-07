import { ReplicationRangeIndexable } from "@peerbit/shared-log";
import { PublicSignKey } from "@peerbit/crypto";

const getBarsFromRanges = (props: {
    publicKey: PublicSignKey;
    maxTime: number;
    ranges?: ReplicationRangeIndexable<"u64">[];
    resolution: number;
}): { y: number; owned?: boolean }[] => {
    let resolution = props.resolution;
    let counters = new Array<{ y: number; owned: boolean }>(resolution);
    if (!props.ranges || props.ranges.length === 0) {
        return counters.map((x) => {
            return { y: 0, owned: false };
        });
    }
    for (let range of props.ranges) {
        let startRange =
            range.start1 !== range.start2 ? range.start2 : range.start1;
        let endRange = range.start1 !== range.start2 ? range.end2 : range.end1;

        let start = Math.round(
            (Number(startRange / 1000000n) / props.maxTime) * resolution
        );
        let end = Math.min(
            Math.round(
                (Number(endRange / 1000000n) / props.maxTime) * resolution
            ),
            resolution
        );
        for (let x = start; x < end; x++) {
            let counter = counters[x];
            if (!counter) {
                counter = {
                    y: 0,
                    owned: false,
                };
                counters[x] = counter;
            }
            counter.y += 1;
            counter.owned =
                counter.owned || range.hash === props.publicKey.hashcode();
        }
    }
    return counters;
};
export const ReplicationRangeVisualization = (props: {
    maxTime: number;
    ranges?: ReplicationRangeIndexable<"u64">[];
    publicKey: PublicSignKey;
}) => {
    let resolution = 1000;
    return (
        <>
            {/* 
          === Replicator Density Overlay ===
          This is a container that spans the full width of the Slider.Track 
          and shows your “popularity” or “heatmap” data.
        */}
            {props.ranges && (
                <div className="absolute inset-0 pointer-events-none">
                    {/**
                     * For demonstration, assume:
                     *   - props.maxTime is the total length in ms
                     *   - each entry in props.replicatorDensity has
                     *       { time: number; density: number }
                     *     where time is in ms and density is in [0..1].
                     */}

                    {/* {props.ranges.map((range, idx) => {
                        // Convert the time to a % of total duration
                        const leftPercent = (Number(range.start1 / 1000000n) / props.maxTime) * 100;
                        const widthPercent = (Number(range.width / 1000000n) / props.maxTime) * 100;

                        //  console.log("range", range, leftPercent, widthPercent, props.maxTime);

                        // Convert density to a vertical height or color strength, etc.
                        const barHeight = 5;
                        return (
                            <div
                                key={idx}
                                // Position the bar in the timeline
                                style={{
                                    position: "absolute",
                                    left: `${leftPercent}%`,
                                    bottom: 2,
                                    width: widthPercent + "%",
                                    height: `${barHeight}px`,

                                }}
                                className="bg-primary-500"
                            />
                        );
                    })} */}
                    {getBarsFromRanges({
                        maxTime: props.maxTime,
                        publicKey: props.publicKey,
                        resolution,
                        ranges: props.ranges,
                    }).map((bar, x) => {
                        return (
                            <div
                                key={x}
                                // Position the bar in the timeline
                                style={{
                                    position: "absolute",
                                    left: `${(x / resolution) * 100}%`,
                                    bottom: 2,
                                    width: 100 / resolution + "%",
                                    height: `${bar.y * 5}px`,
                                }}
                                className={
                                    bar.owned
                                        ? "bg-primary-500"
                                        : "bg-primary-500"
                                }
                            />
                        );
                    })}
                </div>
            )}
        </>
    );
};
