import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@peerbit/document-react";
import {
    Canvas,
    IndexableCanvas,
    ReplyKind,
    Scope,
    ViewKind,
    getImmediateRepliesQuery,
    getReplyKindQuery,
} from "@giga-app/interface";
import { Documents, type WithIndexedContext } from "@peerbit/document";

const FEED_REMOTE_POLL_MS = 5000;

export const useAllPosts = (properties: {
    scope: Scope;
    parent?: WithIndexedContext<Canvas, IndexableCanvas>;
    replies?: Documents<Canvas, IndexableCanvas>;
    type?: "navigational" | "narrative";
    debug?: boolean;
}) => {
    const replies = properties.scope?.replies;
    const parent = properties.parent;

    const compileTimeDebug =
        typeof process !== "undefined" &&
        Boolean(
            process.env?.PEERBIT_DEBUG_ITERATORS ||
            process.env?.PEERBIT_DEBUG_FEED ||
            process.env?.DEBUG_FEED
        );
    const runtimeDebug =
        typeof window !== "undefined" &&
        Boolean((window as any).__PEERBIT_DEBUG__);
    const searchDebug =
        typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).has("debugfeed");
    const debugEnabled =
        properties.debug !== undefined
            ? properties.debug
            : compileTimeDebug || searchDebug || runtimeDebug;
    if (debugEnabled && typeof window !== "undefined") {
        (window as any).__PEERBIT_DEBUG__ = true;
    }

    const remote = useMemo(
        () => ({
            // Keep remote iterators alive longer so relay-only peers (ephemeral sessions)
            // don't get their subscriptions GC'd by the server before updates arrive.
            wait: { timeout: 60000 },
        }),
        []
    );

    const {
        items: posts,
        isLoading,
        empty,
        id: iteratorId,
        loadMore,
    } = useQuery(replies, {
        query: useMemo(() => {
            if (!parent) {
                return undefined;
            }
            return {
                query: [
                    ...getImmediateRepliesQuery(parent),
                    ...(properties.type != null
                        ? [
                              properties.type === "navigational"
                                  ? getReplyKindQuery(ViewKind)
                                  : getReplyKindQuery(ReplyKind),
                          ]
                        : []),
                ],
            };
        }, [properties.scope, properties.type, properties.replies, parent]),

        batchSize: 100,
        debug: debugEnabled ? "feed" : false, // { id: "replies" },
        local: true,
        remote,

        prefetch: true,
        updates: {
            merge: true,
            push: true,
        },
    });

    const loadMoreRef = useRef(loadMore);
    useEffect(() => {
        loadMoreRef.current = loadMore;
    }, [loadMore]);

    useEffect(() => {
        if (!replies) return;
        let stopped = false;
        if (debugEnabled && typeof window !== "undefined") {
            console.log("feed manual poll init", {
                intervalMs: FEED_REMOTE_POLL_MS,
            });
        }
        const id = setInterval(() => {
            if (stopped) return;
            if (debugEnabled && typeof window !== "undefined") {
                console.log("feed manual poll tick");
            }
            loadMoreRef.current?.().catch(() => undefined);
        }, FEED_REMOTE_POLL_MS);
        return () => {
            stopped = true;
            clearInterval(id);
        };
    }, [replies, iteratorId, debugEnabled]);
    return {
        isLoading,
        iteratorId,
        posts,
        hasMore: () => !empty(),
    };
};
