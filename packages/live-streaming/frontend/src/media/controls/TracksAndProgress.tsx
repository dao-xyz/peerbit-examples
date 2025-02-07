import { useEffect, useState } from "react";
import { Track, MediaStreamDB } from "../database.js";
import { useLocal } from "@peerbit/react";
import * as Slider from "@radix-ui/react-slider";
import { ReplicationRangeVisualization } from "./ReplicatorDensity.js";
import { ReplicationRangeIndexable } from "@peerbit/shared-log";

export const Tracks = (props: {
    mediaStreams?: MediaStreamDB;
    progress?: number | "live";
    currentTime: number;
    setProgress: (value: number | "live") => void;
}) => {
    // Subscribe to local tracks from the database
    const tracks = useLocal(props.mediaStreams?.tracks);
    const [maxTime, setMaxTime] = useState<undefined | number>(undefined);
    const [ranges, setRanges] = useState<ReplicationRangeIndexable<any>[]>([]);

    useEffect(() => {
        if (!props.mediaStreams) {
            return;
        }
        const stopMaxTime = props.mediaStreams.subscribeForMaxTime(
            (time) => setMaxTime(time),
            true
        ).stop;
        const stopReplicationInfo =
            props.mediaStreams.subscribeForReplicationInfo(
                async ({ track }) => {
                    const localRanges =
                        await track.source.chunks.log.replicationIndex
                            .iterate({})
                            .all();
                    setRanges(localRanges.map((x) => x.value));
                }
            ).stop;

        return () => {
            stopMaxTime();
            stopReplicationInfo();
        };
    }, [props.mediaStreams?.address]);

    // Calculate the horizontal positioning (assuming times are in microseconds)
    const getLocation = (track: Track) => {
        if (maxTime === undefined) {
            return {
                left: "0%",
                width: "100%",
            };
        }

        const endDefined = track.endTime != null ? track.endTime : maxTime;

        const leftPercent = (track.startTime / maxTime) * 100;
        const widthPercent = ((endDefined - track.startTime) / maxTime) * 100;

        return {
            left: `${leftPercent}%`,
            width: `${widthPercent}%`,
        };
    };

    // Each track row will have a fixed height.
    const rowHeight = 40; // pixels; adjust as needed
    // Compute container height based on the number of tracks (if there are none, give it a minimal height)
    const containerHeight =
        tracks && tracks.length > 0 ? tracks.length * rowHeight : rowHeight;

    return (
        <div>
            // Container with relative positioning, flexible height, and a
            transparent background.
            <div
                className="relative w-full bg-transparent mt-2 mb-2"
                style={{ height: `${containerHeight}px` }}
            >
                {!tracks || tracks.length === 0 ? (
                    <p className="text-gray-400 p-4">No tracks available.</p>
                ) : (
                    tracks
                        .sort((a, b) => a.startTime - b.startTime)
                        .map((track, index) => {
                            const { left, width } = getLocation(track);
                            console.log("track", {
                                left,
                                width,
                                index,
                                maxTime,
                                track: track.toString(),
                            });
                            return (
                                <div
                                    key={index}
                                    // Position each track absolutely to allow horizontal placement via left and width.
                                    className="absolute bg-gray-800 bg-opacity-70 text-white p-2 rounded"
                                    style={{
                                        left,
                                        width,
                                        top: `${index * rowHeight}px`,
                                        height: `${rowHeight - 8}px`, // account for padding if needed
                                        overflow: "hidden",
                                    }}
                                >
                                    <div className="flex items-center">
                                        <p className="text-sm">
                                            {track.source.mediaType}
                                        </p>
                                    </div>
                                </div>
                            );
                        })
                )}
            </div>
            {/* Progress Bar */}
            <div
                className="flex justify-center w-full"
                style={{ marginTop: "-3px" }} // Adjust as needed to align with top of control bar
            >
                <Slider.Root
                    className="relative flex items-center select-none touch-none w-full h-1 group"
                    value={[
                        props.progress === "live"
                            ? 1
                            : props.currentTime / maxTime || 0,
                    ]}
                    min={0}
                    max={1}
                    step={0.001}
                    onValueChange={(value) => {
                        const p = value[0];
                        props.setProgress(p);
                    }}
                >
                    <ReplicationRangeVisualization
                        maxTime={maxTime}
                        ranges={ranges}
                        publicKey={props.mediaStreams?.node.identity.publicKey}
                    />

                    <Slider.Track className="bg-gray-200 opacity-50 relative flex-grow rounded-full h-full group-hover:h-2 group-hover:opacity-80 transition-all">
                        <Slider.Range className="absolute bg-primary-500 rounded-full h-full" />
                    </Slider.Track>
                    <Slider.Thumb className="block w-3 h-3 bg-primary-500 rounded-full group-hover:scale-125 transition-transform" />
                </Slider.Root>
            </div>
        </div>
    );
};
