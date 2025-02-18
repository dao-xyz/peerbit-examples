import { Track, MediaStreamDB } from "@peerbit/video-lib";
import { useLocal } from "@peerbit/react";
import { useMaxTime } from "./useMaxTime.js";
import { useMemo } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";

export const Tracks = (props: {
    mediaStreams?: MediaStreamDB;
    progress?: number | "live";
    videoRef: HTMLVideoElement;
    currentTime: number;
    setProgress: (value: number | "live") => void;
}) => {
    // Subscribe to local tracks from the database
    const tracks = useLocal(props.mediaStreams?.tracks);
    const { maxTime } = useMaxTime({
        mediaStreams: props.mediaStreams,
        videoRef: props.videoRef,
    });

    // Calculate the horizontal positioning (assuming times are in microseconds)
    const getLocation = useMemo(
        () => (track: Track) => {
            if (maxTime === undefined || (true as any)) {
                return {
                    left: "0%",
                    width: "100%",
                };
            }

            const endDefined = track.endTime != null ? track.endTime : maxTime;
            const leftPercent = (track.startTime / maxTime) * 100;
            const widthPercent =
                ((endDefined - track.startTime) / maxTime) * 100;

            return {
                left: `${leftPercent}%`,
                width: `${widthPercent}%`,
            };
        },
        [maxTime]
    );

    // Each track row will have a fixed height.
    const rowHeight = 40; // pixels; adjust as needed
    // Compute container height based on the number of tracks (if there are none, give it a minimal height)
    const containerHeight =
        tracks && tracks.length > 0 ? tracks.length * rowHeight : rowHeight;

    return (
        <div className="relative w-full bg-transparent mt-2 mb-2 flex flex-col">
            {/* show 0:00 to the left and maxTime to the right */}
            <div className="flex flex-row">
                <div className=" text-white p-2 rounded">
                    <p className="text-sm">0:00</p>
                </div>
                <div
                    className="ml-auto  text-white p-2 rounded"
                    style={{ right: 0 }}
                >
                    <p className="text-sm">
                        {maxTime
                            ? new Date(maxTime / 1000)
                                  .toISOString()
                                  .substr(11, 8)
                            : "-:--"}
                    </p>
                </div>
            </div>
            <div
                className="relative"
                style={{ height: `${containerHeight}px` }}
            >
                {!tracks || tracks.length === 0 ? (
                    <p className="text-gray-400 p-4">No media provided.</p>
                ) : (
                    tracks
                        .sort((a, b) => a.startTime - b.startTime)
                        .map((track, index) => {
                            const { left, width } = getLocation(track);
                            return (
                                <div
                                    key={index}
                                    className="absolute bg-gray-800 bg-opacity-70 text-white p-2 rounded"
                                    style={{
                                        left,
                                        width,
                                        top: `${index * rowHeight}px`,
                                        height: `${rowHeight - 8}px`,
                                        overflow: "hidden",
                                    }}
                                >
                                    <div className="flex items-center">
                                        <Tooltip.Provider>
                                            <Tooltip.Root>
                                                <Tooltip.Trigger asChild>
                                                    <p className="text-xs truncate">
                                                        {
                                                            track.source
                                                                .description
                                                        }
                                                    </p>
                                                </Tooltip.Trigger>
                                                <Tooltip.Content
                                                    side="top"
                                                    className="tooltip break-all"
                                                >
                                                    {track.source.description}
                                                    <Tooltip.Arrow className="fill-current text-gray-900" />
                                                </Tooltip.Content>
                                            </Tooltip.Root>
                                        </Tooltip.Provider>
                                    </div>
                                </div>
                            );
                        })
                )}
            </div>
        </div>
    );
};
