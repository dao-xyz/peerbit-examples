import { Track, MediaStreamDB } from "@peerbit/media-streaming";
import { useLocal } from "@peerbit/react";
import { useEffect, useRef, useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { FaLeaf, FaSeedling } from "react-icons/fa";

export const ReplicatorCoverage = (props: { mediaStreams?: MediaStreamDB }) => {
    const tracks = useLocal(props.mediaStreams?.tracks);
    const trackCoveragesRef = useRef<Map<string, number>>(new Map());
    const maxTime = props.mediaStreams?.maxTime;
    const [minCoverage, setMinCoverage] = useState<number>(0);

    useEffect(() => {
        if (!props.mediaStreams) return;
        const changeListener = async (track: any) => {
            try {
                if (!maxTime) return;
                const trackCoverage =
                    await track.source.chunks.log.calculateCoverage({
                        start: 0n,
                        end: BigInt(maxTime * 1e3),
                    });
                trackCoveragesRef.current.set(track.address, trackCoverage);
                let newMin = Number.MAX_VALUE;
                for (const cover of trackCoveragesRef.current.values()) {
                    newMin = Math.min(newMin, cover);
                }
                setMinCoverage(newMin);
            } catch (err) {
                console.error(
                    "Error calculating coverage for track:",
                    track,
                    err
                );
            }
        };

        const cleanupListeners: (() => void)[] = [];
        for (const track of tracks) {
            trackCoveragesRef.current.delete(track.address);
            const listener = () => changeListener(track);
            listener();
            track.source.chunks.log.events.addEventListener(
                "replication:change",
                listener
            );
            cleanupListeners.push(() =>
                track.source.chunks.log.events.removeEventListener(
                    "replication:change",
                    listener
                )
            );
        }
        return () => {
            cleanupListeners.forEach((removeListener) => removeListener());
        };
    }, [tracks, props.mediaStreams, maxTime]);

    return (
        <div className="replicator-coverage">
            <Tooltip.Provider>
                <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "4px",
                            }}
                            className="ml-1"
                        >
                            <div className={`flex flex-row`}>
                                <FaSeedling
                                    className="text-green-400"
                                    size={20}
                                />

                                {minCoverage > 0 && (
                                    <div className="ml-[-5px] mt-[-10px]">
                                        <span className="text-xs bg-green-400 rounded-full p-[2px] leading-[5px] !text-black">
                                            {minCoverage}x
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                        <Tooltip.Content className="tooltip">
                            This value represents how many times the video is
                            completely stored somewhere in the world.
                            <br />
                            1x means the video is fully replicated once, 2x
                            means twice, etc.
                            <br />
                            <Tooltip.Arrow />
                        </Tooltip.Content>
                    </Tooltip.Portal>
                </Tooltip.Root>
            </Tooltip.Provider>
        </div>
    );
};
