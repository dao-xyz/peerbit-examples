import { Peerbit } from "peerbit";
import { Alias, BlogPosts, Post } from "..";
import {
    SearchRequest,
    StringMatchMethod,
    StringMatch,
} from "@peerbit/document";

describe("index", () => {
    let peer: Peerbit, peer2: Peerbit;

    beforeAll(async () => {
        peer = await Peerbit.create();
        peer2 = await Peerbit.create();
        await peer.dial(peer2);
    });

    afterAll(async () => {
        await peer.stop();
        await peer2.stop();
    });

    describe("post", () => {
        it("put delete", async () => {
            // Peer 1 is subscribing to a replication topic (to start helping the network)
            const platform = await peer.open(new BlogPosts());

            const post = new Post({
                title: "My first  post",
                content: "hello world",
            });
            await platform.posts.put(post);

            await expect(platform.getPostAuthor(post.id)).resolves.toEqual(
                peer.identity.publicKey
            );
            const myPosts = await platform.getMyPosts();
            expect(myPosts).toHaveLength(1);

            const viewer = await peer2.open<BlogPosts>(platform.address, {
                args: { role: "observer" },
            });

            // wait for viewer knows that peer is replicating the posts
            await viewer.posts.log.waitForReplicator(peer.identity.publicKey);

            const foundPost = await viewer.posts.index.search(
                new SearchRequest({
                    query: [
                        new StringMatch({
                            key: "content",
                            value: "hello",
                            method: StringMatchMethod.contains,
                            caseInsensitive: false,
                        }),
                    ],
                })
            );
            expect(foundPost).toHaveLength(1);
        });
    });

    describe("alias", () => {
        it("get set", async () => {
            const platform = await peer.open(new BlogPosts());
            const alias = await platform.getAlias(peer.identity.publicKey);
            expect(alias).toBeUndefined();

            await platform.alias.put(
                new Alias({
                    publicKey: peer.identity.publicKey,
                    name: "Peerbit",
                })
            );

            const alias2 = await platform.getAlias(peer.identity.publicKey);
            expect(alias2).toBe("Peerbit");
        });
    });
});
