import { useLocal } from "@peerbit/react";
import { Tracks } from "../controls/Tracks";
import { MediaStreamDB } from "../database";
import { View } from "../viewer/View";
import { Renderer } from "./Renderer";
import { Share } from "../controls/Share";

export const Editor = (props: { stream: MediaStreamDB }) => {
    const tracks = useLocal(props.stream?.tracks);

    return (
        <div className="flex flex-col">
            <div className="flex flex-row">
                <div className="ml-auto mr-2">
                    <Share size={24} />
                </div>
            </div>
            {/*  {tracks.length > 0 && <View stream={props.stream} />} */}
            <Renderer stream={props.stream} />
            <Tracks
                mediaStreams={props.stream}
                currentTime={0}
                setProgress={() => {}}
            />
        </div>
    );
};
