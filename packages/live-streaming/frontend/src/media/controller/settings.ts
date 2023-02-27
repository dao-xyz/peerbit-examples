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

export type Resolution = 360 | 480 | 720 | 1080;
export const RESOLUTIONS: Resolution[] = [360, 480, 720, 1080];
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
                bitrate: 5 * 1e6,
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
                bitrate: 8e6,
                height: 1080,
            },
        };
    }

    throw new Error("Unsupported resolution: " + resolution);
};
