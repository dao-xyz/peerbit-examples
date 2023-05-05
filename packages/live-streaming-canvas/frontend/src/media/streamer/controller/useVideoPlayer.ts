import { useEffect, useState } from "react";
import { ControlInterface } from "./controls";

const useVideoPlayer = (videoElement?: HTMLVideoElement): ControlInterface => {
    const [isPlaying, setIsPlaying] = useState(!videoElement?.paused);
    const [progress, setProgress] = useState(0);

    useEffect(() => {
        if (videoElement) {
            console.log("SET IS PLAYING ? ", !videoElement.paused);

            setIsPlaying(!videoElement.paused);
        }
    }, [videoElement?.paused]);

    const duration = () =>
        videoElement.buffered.length > 0
            ? videoElement.buffered.end(videoElement.buffered.length - 1)
            : 0;

    const setVideoProgress = (value: number) => {
        videoElement.currentTime = (duration() / 100) * value;
        setProgress(value);
    };

    const setVolume = (value: number) => {
        videoElement.volume = value;
    };

    const handleOnTimeUpdate = () => {
        const progress = (videoElement.currentTime / duration()) * 100;
        setProgress(progress);
    };

    useEffect(() => {
        if (!videoElement) {
            return;
        }
        videoElement.ontimeupdate = handleOnTimeUpdate;
    }, [videoElement]);

    return {
        setVolume,
        isPlaying,
        mute: () => (videoElement.muted = true),
        unmute: () => (videoElement.muted = false),
        play: () => {
            videoElement?.play();
            setIsPlaying(true);
        },
        pause: () => {
            console.log("pause", videoElement);
            videoElement?.pause();
            setIsPlaying(false);
        },
    };
};

export default useVideoPlayer;
