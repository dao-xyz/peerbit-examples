import { useMemo } from "react";
import { usePeer, useQuery } from "@peerbit/react";
import {
    Canvas,
    IndexableCanvas,
    getImmediateRepliesQuery,
    getNarrativePostsQuery,
    getNavigationalPostQuery,
} from "@giga-app/interface";
import { type WithIndexedContext } from "@peerbit/document";

// Helper: ensure canvas address calculation before transform.
const calculateAddress = async (
    p: WithIndexedContext<Canvas, IndexableCanvas>
) => {
    await p.calculateAddress();
    return p;
};

export const useAllPosts = (properties: {
    canvas?: Canvas;
    type?: "navigational" | "narrative";
}) => {
    const { peer } = usePeer();
    const {
        items: posts,
        isLoading,
        empty,
        id: iteratorId,
    } = useQuery(
        properties?.canvas?.loadedReplies
            ? properties?.canvas.replies
            : undefined,
        {
            query: useMemo(() => {
                if (!properties.canvas) {
                    return undefined;
                }
                return {
                    query: [
                        ...getImmediateRepliesQuery(properties.canvas),
                        ...(properties.type != null
                            ? [
                                properties.type === "navigational"
                                    ? getNavigationalPostQuery()
                                    : getNarrativePostsQuery(),
                            ]
                            : []),
                    ],
                };
            }, [properties.canvas, properties.type]),
            transform: calculateAddress,
            batchSize: 100,
            debug: false, // { id: "replies" },
            local: true,
            remote: {
                joining: {
                    waitFor: 5e3,
                },
            },

            prefetch: true,
            onChange: {
                merge: async (e) => {
                    for (const change of e.added) {
                        const hash = change.__context.head;
                        const entry =
                            await properties!.canvas!.replies.log.log.get(hash);
                        for (const signer of await entry.getSignatures()) {
                            if (
                                signer.publicKey.equals(peer.identity.publicKey)
                            ) {
                                return e; // merge the change since it was made by me
                            }
                        }
                    }
                    return undefined;
                },
            },
        }
    );
    return {
        isLoading,
        iteratorId,
        posts,
        hasMore: () => !empty(),
    };
};
