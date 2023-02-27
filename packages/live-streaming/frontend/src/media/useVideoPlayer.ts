import { useState, useEffect, MutableRefObject } from "react";

const useVideoPlayer = (videoElement?: HTMLVideoElement) => {
    const [isPlaying, setIsPlaying] = useState(!videoElement?.paused);
    const [progress, setProgress] = useState(0);
    const [speed, setSpeed] = useState(1);
    const [prevMuteVolume, setPrevMuteVolume] = useState(
        videoElement?.volume ?? 1
    );

    const togglePlay = () => {
        const isPlayingNow = !isPlaying;
        console.log("toggle play state!", isPlayingNow);
        isPlayingNow ? videoElement.play() : videoElement.pause();
    };

    useEffect(() => {
        if (videoElement) {
            setIsPlaying(!videoElement.paused);
        }
    }, [videoElement?.paused]);

    const duration = () =>
        videoElement.buffered.length > 0
            ? videoElement.buffered.end(videoElement.buffered.length - 1)
            : 0;
    const handleOnTimeUpdate = () => {
        const progress = (videoElement.currentTime / duration()) * 100;
        setProgress(progress);
    };

    const handleVideoProgress = (event) => {
        const manualChange = Number(event.target.value);
        videoElement.currentTime = (duration() / 100) * manualChange;
        setProgress(manualChange);
    };

    const handleVideoSpeed = (event) => {
        const speed = Number(event.target.value);
        videoElement.playbackRate = speed;
        setSpeed(speed);
    };

    const toggleMute = () => {
        if (!videoElement.muted) {
            setPrevMuteVolume(videoElement.volume);
            videoElement.volume = 0.0000001;
        } else {
            videoElement.volume = prevMuteVolume;
        }
        videoElement.muted = !videoElement.muted;
    };

    const setVolume = (value: number) => {
        setPrevMuteVolume(value);
        videoElement.volume = value;
    };

    return {
        isPlaying,
        setVolume,
        progress,
        speed,
        togglePlay,
        handleOnTimeUpdate,
        handleVideoProgress,
        handleVideoSpeed,
        toggleMute,
    };
};

export default useVideoPlayer;
