import { useEffect, useState } from "react";
import { MediaStreamDB } from "@peerbit/video-lib";

export const useMaxTime = (props?: {
    mediaStreams?: MediaStreamDB;
    videoRef?: HTMLVideoElement;
}) => {
    const [maxTime, setMaxTime] = useState<number | undefined>(
        (props?.videoRef?.duration ?? 0) * 1e6
    );
    props?.videoRef &&
        console.log(!!props?.videoRef, maxTime, props.videoRef.duration * 1e6);

    const maybeUpdateMaxTime = (newMaxtime: number) => {
        setMaxTime((prev) =>
            prev == null || newMaxtime > prev ? newMaxtime : prev
        );
    };

    useEffect(() => {
        if (!props?.videoRef) {
            return;
        }

        maybeUpdateMaxTime(props.videoRef.duration * 1e6);
    }, [props?.videoRef, props?.videoRef?.duration]);

    useEffect(() => {
        if (!props.mediaStreams) {
            return;
        }
        const maxTimeListener = (ev: { detail: { maxTime: number } }) => {
            maybeUpdateMaxTime(ev.detail.maxTime);
        };
        if (props.mediaStreams.maxTime != null) {
            maxTimeListener({
                detail: { maxTime: props.mediaStreams.maxTime },
            });
        }
        props.mediaStreams.events.addEventListener("maxTime", maxTimeListener);

        return () => {
            return props.mediaStreams.events.removeEventListener(
                "maxTime",
                maxTimeListener
            );
        };
    }, [props.mediaStreams, props.mediaStreams?.address]);

    return { maxTime };
};
