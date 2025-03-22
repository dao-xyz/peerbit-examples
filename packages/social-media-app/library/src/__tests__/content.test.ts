import { TestSession } from "@peerbit/test-utils";
import {
    Canvas,
    getImmediateRepliesQuery,
    getRepliesQuery,
} from "../content.js";
import { SearchRequest, Sort, SortDirection } from "@peerbit/document";
import { expect } from "chai";

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
            expect((await abc[0].getCanvasPath()).length).to.eq(4);
            expect((await abc[0].getCanvasPath())[3]).to.eq(abc[0]);

            const abd = await root.getCreateRoomByPath(["a", "b", "d"]);
            expect(abd).to.have.length(1);
            expect(await abd[0].createTitle()).to.eq("d");
            expect((await abd[0].getCanvasPath()).length).to.eq(4);
            expect((await abd[0].getCanvasPath())[3]).to.eq(abd[0]);

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

            const sortedByReplies = await root.replies.index.search({
                query: getImmediateRepliesQuery(root),
                sort: new Sort({
                    key: "replies",
                    direction: SortDirection.DESC,
                }),
            });

            expect(
                await Promise.all(sortedByReplies.map((x) => x.createTitle()))
            ).to.deep.eq(["a", "b", "c"]);
        });

        describe("replies", () => {
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
