import { MediaStreamDB } from "@peerbit/video-lib";
import { Renderer } from "./Renderer";

export const Editor = (props: { stream: MediaStreamDB }) => {
    return (
        <div className="flex flex-col">
            {/*  {tracks.length > 0 && <View stream={props.stream} />} */}
            <Renderer stream={props.stream} />
        </div>
    );
};
