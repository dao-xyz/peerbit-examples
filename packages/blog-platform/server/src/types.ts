// this is a JSON representation of the Post class for demonstration purposes
// ideally you would not use JSON serialization but just use serialize and deserialize from the borsh library directly

import { BlogPosts, Post } from "@peerbit/blog-sdk";

// we do this here for readability
export class PostJSON {
    id?: string;
    author?: string;
    title: string;
    content: string;
    static async from(platform: BlogPosts, post: Post): Promise<PostJSON> {
        return {
            id: post.id,
            author: (
                await (await platform.getPostAuthor(post.id)).toPeerId()
            ).toString(), // convert to IPFS id for readability
            title: post.title,
            content: post.content,
        };
    }
}
