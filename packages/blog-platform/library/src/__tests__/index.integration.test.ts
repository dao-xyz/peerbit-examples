import { Peerbit } from "peerbit";
import { Alias, BlogPosts, Post } from "../index.js";
import {
    SearchRequest,
    StringMatchMethod,
    StringMatch,
} from "@peerbit/document";
import { expect, describe, it, beforeEach, afterEach } from "vitest";

describe("index", () => {
    let peer: Peerbit, peer2: Peerbit;

    beforeEach(async () => {
        peer = await Peerbit.create();
        peer2 = await Peerbit.create();
        await peer.dial(peer2);
    });

    afterEach(async () => {
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

            const result = await platform.getPostAuthor(post.id);
            expect(result).to.eq(peer.identity.publicKey);
            const myPosts = await platform.getMyPosts();
            expect(myPosts).to.have.length(1);

            const viewer = await peer2.open<BlogPosts>(platform.address, {
                args: { replicate: false },
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
            expect(foundPost).to.have.length(1);
        });
    });

    describe("alias", () => {
        it("get set", async () => {
            const platform = await peer.open(new BlogPosts());
            const alias = await platform.getAlias(peer.identity.publicKey);
            expect(alias).to.be.undefined;

            await platform.alias.put(
                new Alias({
                    publicKey: peer.identity.publicKey,
                    name: "Peerbit",
                })
            );

            const alias2 = await platform.getAlias(peer.identity.publicKey);
            expect(alias2).to.equal("Peerbit");
        });
    });
});
