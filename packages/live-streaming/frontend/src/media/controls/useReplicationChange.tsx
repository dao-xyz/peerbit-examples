import { useEffect, useState } from "react";
import { MediaStreamDB, Track } from "../database.js";
import { ReplicationRangeIndexable } from "@peerbit/shared-log";

export const useReplicationChange = (props: {
    mediaStreams?: MediaStreamDB;
}) => {
    const [replicationRanges, setReplicationRanges] = useState<
        ReplicationRangeIndexable<"u64">[]
    >([]);

    useEffect(() => {
        if (!props.mediaStreams) {
            return;
        }
        const changeListener = async (ev: { detail: { track: Track } }) => {
            const ranges =
                await ev.detail.track.source.chunks.log.replicationIndex
                    .iterate()
                    .all();
            setReplicationRanges(ranges.map((x) => x.value));
        };
        props.mediaStreams.events.addEventListener(
            "replicationChange",
            changeListener
        );

        return () => {
            return props.mediaStreams?.events.removeEventListener(
                "replicationChange",
                changeListener
            );
        };
    }, [props.mediaStreams?.address]);

    return replicationRanges;
};
