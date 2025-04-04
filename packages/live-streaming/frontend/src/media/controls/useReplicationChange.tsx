import { useEffect, useState } from "react";
import { MediaStreamDB, Track } from "@peerbit/video-lib";
import { ReplicationRangeIndexable } from "@peerbit/shared-log";

export const useReplicationChange = (props: {
    mediaStreams?: MediaStreamDB;
}) => {
    const [replicationRanges, setReplicationRanges] = useState<
        Map<string, ReplicationRangeIndexable<"u64">[]>
    >(new Map());

    useEffect(() => {
        if (!props.mediaStreams || props.mediaStreams.closed) {
            return;
        }
        const changeListener = async (ev: { detail: { track: Track } }) => {
            if (ev.detail.track.source.chunks.log.closed) {
                return;
            }
            const ranges =
                await ev.detail.track.source.chunks.log.replicationIndex
                    .iterate()
                    .all();
            setReplicationRanges((prev) => {
                const newMap = new Map(prev);
                newMap.set(
                    ev.detail.track.idString,
                    ranges.map((x) => x.value)
                );
                return newMap;
            });
        };
        props.mediaStreams.tracks.index
            .iterate({}, { local: true, remote: false })
            .all()
            .then((tracks) => {
                for (const track of tracks) {
                    changeListener({ detail: { track } });
                }
            });

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
    }, [props.mediaStreams?.address, props.mediaStreams?.closed]);

    return replicationRanges;
};
