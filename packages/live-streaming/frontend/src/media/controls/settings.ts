export interface SourceSetting {
    video: { height: number; bitrate: number };
    audio: { bitrate?: number };
}

interface CameraStream {
    type: "camera";
}

interface ScreenShare {
    type: "screen";
}

interface UploadMedia {
    type: "upload-media";
    src: string;
}

interface NoiseType {
    type: "noise";
}

interface DemoType {
    type: "demo"; // a short video
}

export type StreamType =
    | UploadMedia
    | DemoType
    | CameraStream
    | ScreenShare
    | NoiseType;

export type Resolution = 360 | 480 | 720 | 1080 | 1440 | 2160;
export const RESOLUTIONS: Resolution[] = [360, 480, 720, 1080, 1440, 2160];
export const resolutionToSourceSetting = (resolution: Resolution) => {
    if (resolution === 360) {
        return {
            audio: {
                bitrate: 1e5,
            },
            video: {
                bitrate: 1e5,
                height: 360,
            },
        };
    }

    if (resolution === 480) {
        return {
            audio: {
                bitrate: 1e5,
            },
            video: {
                bitrate: 2.5 * 1e5,
                height: 480,
            },
        };
    }

    if (resolution === 720) {
        return {
            audio: {
                bitrate: 1e5,
            },
            video: {
                bitrate: 3 * 1e6,
                height: 720,
            },
        };
    }

    if (resolution === 1080) {
        return {
            audio: {
                bitrate: 1e5,
            },
            video: {
                bitrate: 4.5 * 1e6,
                height: 1080,
            },
        };
    }

    if (resolution === 1440) {
        return {
            audio: {
                bitrate: 1e5,
            },
            video: {
                bitrate: 5.5 * 1e6,
                height: 1440,
            },
        };
    }
    if (resolution === 2160) {
        return {
            audio: {
                bitrate: 1e5,
            },
            video: {
                bitrate: 6.5 * 1e6,
                height: 1440,
            },
        };
    }

    throw new Error("Unsupported resolution: " + resolution);
};
