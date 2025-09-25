import { useMemo } from "react";
import { useQuery } from "@peerbit/react";
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

export const useAllPosts = (properties: {
    scope: Scope;
    parent?: WithIndexedContext<Canvas, IndexableCanvas>;
    replies?: Documents<Canvas, IndexableCanvas>;
    type?: "navigational" | "narrative";
    debug?: boolean;
}) => {
    const replies = properties.scope?.replies;
    const parent = properties.parent;

    const {
        items: posts,
        isLoading,
        empty,
        id: iteratorId,
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
        debug: properties?.debug ?? false, // { id: "replies" },
        local: true,
        remote: {
            wait: { timeout: 5000 },
        },

        prefetch: true,
        updates: {
            merge: true,
        },
    });
    return {
        isLoading,
        iteratorId,
        posts,
        hasMore: () => !empty(),
    };
};
