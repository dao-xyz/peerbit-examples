import { usePeer } from "@peerbit/react";
import { PrivateCanvasScope } from "../useCanvas"
import { useAllPosts } from "../feed/useCollection";
import { Canvas } from "@giga-app/interface";

export const useDrafts = () => {
    const { peer } = usePeer()
    const privateRoot = PrivateCanvasScope.useCanvases().root;
    const allPosts = useAllPosts({ canvas: privateRoot, type: 'narrative' });
    return {
        drafts: allPosts.posts,
        deleteDraft: async (draft: Canvas) => {
            await Canvas.delete(draft, peer);
        }
    }
}