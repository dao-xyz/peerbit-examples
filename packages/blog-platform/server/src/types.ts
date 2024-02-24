// this is a JSON representation of the Post class for demonstration purposes
// ideally you would not use JSON serialization but just use serialize and deserialize from the borsh library directly

import { BlogPosts, Post } from "@peerbit/blog-sdk";
import { Ed25519PublicKey } from "@peerbit/crypto";

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
                (await platform.getPostAuthor(post.id)) as Ed25519PublicKey
            )
                .toPeerId()
                .toString(), // convert to IPFS id for readability
            title: post.title,
            content: post.content,
        };
    }
}
