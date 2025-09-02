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

    return {
        drafts: allPosts.posts,
        deleteDraft,
        deleteAllDrafts,
    };
};
