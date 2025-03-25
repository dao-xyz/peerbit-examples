import { TestSession } from "@peerbit/test-utils";
import {
    Canvas,
    getImmediateRepliesQuery,
    getRepliesQuery,
} from "../content.js";
import { SearchRequest, Sort, SortDirection } from "@peerbit/document";
import { expect } from "chai";
import { waitForResolved } from "@peerbit/time";

describe("content", () => {
    describe("canvas", () => {
        let session: TestSession;

        beforeEach(async () => {
            session = await TestSession.connected(2);
        });

        afterEach(async () => {
            await session.stop();
        });
        it("can make path", async () => {
            const root = await session.peers[0].open(
                new Canvas({
                    publicKey: session.peers[0].identity.publicKey,
                    seed: new Uint8Array(),
                })
            );
            const abc = await root.getCreateRoomByPath(["a", "b", "c"]);
            expect(abc).to.have.length(1);
            expect(await abc[0].createTitle()).to.eq("c");
            expect((await abc[0].loadPath(true)).length).to.eq(4);
            expect((await abc[0].loadPath(true))[3]).to.eq(abc[0]);

            const abd = await root.getCreateRoomByPath(["a", "b", "d"]);
            expect(abd).to.have.length(1);
            expect(await abd[0].createTitle()).to.eq("d");
            expect((await abd[0].loadPath(true)).length).to.eq(4);
            expect((await abd[0].loadPath(true))[3]).to.eq(abd[0]);

            const childrenFromRoot = await root.replies.index.index
                .iterate({ query: getImmediateRepliesQuery(root) })
                .all();
            expect(childrenFromRoot).to.have.length(1); // both paths start at "a"

            const ab = await root.findCanvasesByPath(["a", "b"]);
            expect(
                await Promise.all(ab.canvases.map((x) => x.createTitle()))
            ).to.deep.eq(["b"]);

            const elementsInB = await ab.canvases[0].replies.index.search(
                new SearchRequest({
                    query: getImmediateRepliesQuery(ab.canvases[0]),
                })
            );

            const titlesFromB = await Promise.all(
                elementsInB.map((x) => x.createTitle())
            );
            expect(titlesFromB.sort()).to.deep.eq(["c", "d"]);

            const rootFromAnotherNode = await session.peers[1].open(
                new Canvas({
                    publicKey: session.peers[0].identity.publicKey,
                    seed: new Uint8Array(),
                })
            );

            // the root will contain all posts eventually because of the flattening
            await waitForResolved(() =>
                expect(rootFromAnotherNode.replies.log.log.length).to.eq(4)
            );
        });

        it("can sort by replies", async () => {
            const root = await session.peers[0].open(
                new Canvas({
                    publicKey: session.peers[0].identity.publicKey,
                    seed: new Uint8Array(),
                })
            );
            await root.getCreateRoomByPath(["b", "b"]);
            await root.getCreateRoomByPath(["a", "b"]);
            await root.getCreateRoomByPath(["c"]);
            await root.getCreateRoomByPath(["a", "c"]);

            await waitForResolved(async () => {
                const sortedByReplies = await root.replies.index.search({
                    query: getImmediateRepliesQuery(root),
                    sort: new Sort({
                        key: "replies",
                        direction: SortDirection.DESC,
                    }),
                });
                expect(
                    await Promise.all(
                        sortedByReplies.map((x) => x.createTitle())
                    )
                ).to.deep.eq(["a", "b", "c"]);
            });
        });

        describe("replies", () => {
            it("index 1 reply", async () => {
                const root = await session.peers[0].open(
                    new Canvas({
                        publicKey: session.peers[0].identity.publicKey,
                        seed: new Uint8Array(),
                    })
                );
                const [ab] = await root.getCreateRoomByPath(["a", "b"]);
                expect(ab.path).to.have.length(2);

                // index updates are not immediate, so we do checks until it's updated
                await waitForResolved(async () => {
                    const countedAllRepliesFromRoot = await root.countReplies();
                    expect(countedAllRepliesFromRoot).to.eq(2n); // a immediate child of root, b immediate child of a

                    const countedImmediateRepliesFromRoot =
                        await root.countReplies({ onlyImmediate: true });
                    expect(countedImmediateRepliesFromRoot).to.eq(1n); // a immediate child of root

                    const replies = await root.replies.index
                        .iterate(
                            { query: getImmediateRepliesQuery(root) },
                            { resolve: false }
                        )
                        .all();
                    expect(replies).to.have.length(1);
                    expect(replies[0].content).to.eq("a");
                    expect(replies[0].replies).to.eq(1n); // one reply (b)
                });
            });

            it("getRepliesQuery", async () => {
                const root = await session.peers[0].open(
                    new Canvas({
                        publicKey: session.peers[0].identity.publicKey,
                        seed: new Uint8Array(),
                    })
                );
                await root.getCreateRoomByPath(["a", "b", "c"]);
                await root.getCreateRoomByPath(["a", "b", "d"]);
                const a = (await root.getCreateRoomByPath(["a"]))[0];
                expect(await a.createTitle()).to.eq("a");

                const all = await a.replies.index
                    .iterate({
                        query: getRepliesQuery(a),
                    })
                    .all();
                // should return all children
                // b, c, d
                expect(all).to.have.length(3);
                const allTitles = await Promise.all(
                    all.map((x) => x.createTitle())
                );
                expect(allTitles.sort()).to.deep.eq(["b", "c", "d"]);
            });

            it("getImmediateRepliesQuery", async () => {
                const root = await session.peers[0].open(
                    new Canvas({
                        publicKey: session.peers[0].identity.publicKey,
                        seed: new Uint8Array(),
                    })
                );
                await root.getCreateRoomByPath(["a", "b", "c"]);
                await root.getCreateRoomByPath(["a", "b", "d"]);
                const b = (await root.getCreateRoomByPath(["a", "b"]))[0];
                expect(await b.createTitle()).to.eq("b");

                const all = await b.replies.index
                    .iterate({
                        query: getImmediateRepliesQuery(b),
                    })
                    .all();

                const allTitles = await Promise.all(
                    all.map((x) => x.createTitle())
                );
                expect(allTitles.sort()).to.deep.eq(["c", "d"]);
            });
        });

        /*  it("determinstic with seed", async () => {
             let seed = new Uint8Array([0, 1, 2]);
             const rootA = await session.peers[0].open(
                 new Canvas({
                     seed,
                     rootTrust: session.peers[0].identity.publicKey,
                 })
             );
             const pathA = await rootA.getCreateRoomByPath(["a", "b", "c"]);
 
             await session.peers[0].stop();
             await session.peers[0].start();
 
             const rootB = await session.peers[0].open(
                 new Canvas({
                     seed,
                     rootTrust: session.peers[0].identity.publicKey,
                 })
             );
 
             expect(rootA.address).to.eq(rootB.address);
 
             const pathB = await rootB.getCreateRoomByPath(["a", "b", "c"]);
             for (const room of pathB) {
                 await session.peers[0].open(room);
             }
 
             expect(typeof pathA[pathA.length - 1].address).to.eq("string");
             expect(pathA[pathA.length - 1].address).to.eq(
                 pathB[pathB.length - 1].address
             );
         }); */
    });
});
