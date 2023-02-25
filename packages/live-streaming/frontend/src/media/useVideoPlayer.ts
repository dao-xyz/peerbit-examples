import { useState, useEffect, MutableRefObject } from "react";

const useVideoPlayer = (videoElement: MutableRefObject<HTMLVideoElement>) => {
    const [isPlaying, setIsPlaying] = useState(!videoElement.current?.paused);
    const [isMuted, setIsMuted] = useState(videoElement.current?.muted);
    const [progress, setProgress] = useState(0);
    const [speed, setSpeed] = useState(1);

    const togglePlay = () => {
        const isPlayingNow = !isPlaying;
        console.log("toggle play state!", isPlayingNow);
        setIsPlaying(isPlayingNow);
        isPlayingNow
            ? videoElement.current.play()
            : videoElement.current.pause();
    };

    const handleOnTimeUpdate = () => {
        const progress =
            (videoElement.current.currentTime / videoElement.current.duration) *
            100;
        setProgress(progress);
    };

    const handleVideoProgress = (event) => {
        const manualChange = Number(event.target.value);
        videoElement.current.currentTime =
            (videoElement.current.duration / 100) * manualChange;
        setProgress(manualChange);
    };

    const handleVideoSpeed = (event) => {
        const speed = Number(event.target.value);
        videoElement.current.playbackRate = speed;
        setSpeed(speed);
    };

    const toggleMute = () => {
        setIsMuted(!isMuted);
    };

    useEffect(() => {
        if (isMuted == null || isMuted === videoElement.current.muted) {
            return;
        }
        isMuted
            ? (videoElement.current.muted = true)
            : (videoElement.current.muted = false);
    }, [isMuted, videoElement]);

    return {
        isPlaying,
        isMuted,
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
