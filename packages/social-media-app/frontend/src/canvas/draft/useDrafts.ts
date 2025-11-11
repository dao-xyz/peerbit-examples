import { useEffect } from "react";
import { useCanvases } from "../useCanvas";
import { useAllPosts } from "../feed/useCollection";
import { Canvas } from "@giga-app/interface";
import { PrivateScope } from "../useScope";

export const useDrafts = () => {
    const publicRoot = useCanvases().viewRoot;
    const privateRoot = PrivateScope.useScope();
    const allPosts = useAllPosts({
        scope: privateRoot,
        parent: publicRoot,
        type: undefined,
    });

    const deleteDraft = async (draft: Canvas) => {
        await privateRoot.remove(draft);
    };
    const deleteAllDrafts = async () => {
        return Promise.all(allPosts.posts.map((draft) => deleteDraft(draft)));
    };

    useEffect(() => {
        if (process.env.NODE_ENV === "production") return;
        if (typeof window === "undefined") return;
        let cancelled = false;
        (async () => {
            try {
                const summary = await Promise.all(
                    allPosts.posts.map(async (draft) => ({
                        id: draft.idString,
                        empty: await draft.isEmpty(),
                    }))
                );
                if (!cancelled) {
                    (window as any).__PENDING_DRAFT_SUMMARY = summary;
                }
            } catch {
                if (!cancelled) {
                    (window as any).__PENDING_DRAFT_SUMMARY = [];
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [allPosts.posts]);

    return {
        drafts: allPosts.posts,
        deleteDraft,
        deleteAllDrafts,
    };
};
