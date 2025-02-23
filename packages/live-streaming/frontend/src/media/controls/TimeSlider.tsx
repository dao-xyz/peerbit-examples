import * as RadixSlider from "@radix-ui/react-slider";
import { ReplicationRangeVisualization } from "./ReplicatorDensity";
import { MediaStreamDB } from "@peerbit/video-lib";

export const TimeSlider = (props: {
    mediaStreamsDB: MediaStreamDB;
    videoRef?: HTMLVideoElement;
    progress: number | "live";
    currentTime: number;
    setProgress: (progress: number | "live") => void;
    maxTime: number;
}) => {
    /* console.log("SLIDER", props.progress === "live"
        ? 1
        : props.currentTime / props.maxTime || 0, {
        maxTime: props.maxTime,
        currnetTime: props.currentTime
    }) */
    return (
        <div
            className="flex justify-center w-full"
            style={{
                marginTop: "-3px",
                zIndex: 100,
            }} // Adjust as needed to align with top of control bar
        >
            <RadixSlider.Root
                className="relative flex items-center select-none touch-none w-full h-1 group "
                value={[
                    props.progress === "live"
                        ? 1
                        : props.currentTime / props.maxTime || 0,
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
                    mediaStreams={props.mediaStreamsDB}
                    videoRef={props.videoRef}
                />

                <RadixSlider.Track className="bg-gray-200 opacity-0 relative flex-grow rounded-full h-full group-hover:h-2 group-hover:opacity-50 transition-all">
                    <RadixSlider.Range className="absolute bg-primary-500 opacity-90 rounded-full h-full" />
                </RadixSlider.Track>
                <RadixSlider.Thumb className="block w-3 h-3 bg-gray-200 rounded-full group-hover:scale-125 transition-transform" />
            </RadixSlider.Root>
        </div>
    );
};
