import { useEffect, useState } from "react";
import { MediaStreamDB, Track } from "@peerbit/media-streaming";
import { ReplicationRangeIndexable } from "@peerbit/shared-log";
import {
    createRetryableResourceDrain,
    durableCleanupPendingCount,
    retryDurableCleanup,
} from "@peerbit/media-streaming-web";

const REPLICATION_LISTENER_CLEANUP_OWNER = {};
const reportReplicationListenerCleanup = (error: unknown) =>
    console.error("Failed to stop replication listener", error);

export const useReplicationChange = (props: {
    mediaStreams?: MediaStreamDB;
}) => {
    const [replicationRanges, setReplicationRanges] = useState<
        Map<string, ReplicationRangeIndexable<"u64">[]>
    >(new Map());

    useEffect(() => {
        const mediaStreams = props.mediaStreams;
        if (!mediaStreams || mediaStreams.closed) {
            return;
        }
        let active = true;
        let retiredSubscription:
            | {
                  cleanup: ReturnType<typeof createRetryableResourceDrain>;
                  resource: { close: () => void | Promise<void> };
              }
            | undefined;
        const refreshVersions = new Map<string, number>();
        const refreshTrack = async ({ track }: { track: Track }) => {
            if (!active || track.source.chunks.log.closed) {
                return;
            }
            const version = (refreshVersions.get(track.idString) ?? 0) + 1;
            refreshVersions.set(track.idString, version);
            const ranges = await track.source.chunks.log.replicationIndex
                .iterate()
                .all();
            if (!active || refreshVersions.get(track.idString) !== version) {
                return;
            }
            setReplicationRanges((prev) => {
                const newMap = new Map(prev);
                newMap.set(
                    track.idString,
                    ranges.map((x) => x.value)
                );
                return newMap;
            });
        };

        void (async () => {
            await retryDurableCleanup(REPLICATION_LISTENER_CLEANUP_OWNER);
            if (!active) {
                return;
            }
            if (
                durableCleanupPendingCount(REPLICATION_LISTENER_CLEANUP_OWNER) >
                0
            ) {
                throw new Error(
                    "Previous replication listener cleanup is still pending"
                );
            }

            const subscription = mediaStreams.listenForReplicationInfo(
                (change) => refreshTrack(change)
            );
            const cleanup = createRetryableResourceDrain({
                onError: reportReplicationListenerCleanup,
                autoRetry: {},
                durableOwner: REPLICATION_LISTENER_CLEANUP_OWNER,
            });
            retiredSubscription = {
                cleanup,
                resource: {
                    close: () => subscription.stop(),
                },
            };
            await subscription.ready;
        })().catch((error) => {
            if (active) {
                console.error("Failed to start replication listener", error);
            }
        });

        return () => {
            active = false;
            refreshVersions.clear();
            // Keep this exact subscription through a finite backoff window,
            // then transfer it to the quiet module registry. A permanent stop
            // failure must not create an immortal retry timer.
            if (retiredSubscription) {
                void retiredSubscription.cleanup.enqueue([
                    retiredSubscription.resource,
                ]);
            }
        };
    }, [props.mediaStreams?.address, props.mediaStreams?.closed]);

    return replicationRanges;
};
