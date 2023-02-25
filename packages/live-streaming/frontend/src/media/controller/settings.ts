import { MediaStreamInfo } from "../database";

export interface SourceSetting {

    video: { bitrate: number; width?: number; height?: number };
    audio: { bitrate: number };

}

interface CameraStream {
    type: "camera";
}

interface ScreenShare {
    type: "screen";
}

interface MediaType {
    type: "media";
    src: string;
}

interface NoiseType {
    type: "noise";
}

export type StreamType = MediaType | CameraStream | ScreenShare | NoiseType;
