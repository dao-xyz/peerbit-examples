import { useEffect, useRef, useState } from "react";
import { MediaStreamDB } from "@peerbit/video-lib";

export const useMaxTime = (props?: { mediaStreams?: MediaStreamDB }) => {
    const [maxTime, setMaxTime] = useState<number | undefined>(undefined);
    useEffect(() => {
        if (!props.mediaStreams) {
            return;
        }
        const maxTimeListener = (ev: { detail: { maxTime: number } }) => {
            setMaxTime(ev.detail.maxTime);
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
