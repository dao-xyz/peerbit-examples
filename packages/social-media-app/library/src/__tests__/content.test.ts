import { TestSession } from "@peerbit/test-utils";
import {
    Canvas,
    getImmediateRepliesQuery,
    getOwnedAndSubownedElementsQuery,
    getRepliesQuery,
    getOwnedElementsQuery,
    Element,
    StaticContent,
    Layout,
    getTextElementsQuery,
    getImagesQuery,
    getSubownedElementsQuery,
    LOWEST_QUALITY,
} from "../content.js";
import { SearchRequest, Sort, SortDirection } from "@peerbit/document";
import { expect } from "chai";
import { waitForResolved } from "@peerbit/time";
import { Ed25519Keypair, sha256Sync } from "@peerbit/crypto";
import { StaticImage } from "../static/image.js";

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
            const randomRootKey = (await Ed25519Keypair.create()).publicKey;
            const root = await session.peers[0].open(
                new Canvas({
                    publicKey: randomRootKey,
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
                    publicKey: randomRootKey,
                    seed: new Uint8Array(),
                })
            );

            // the root will contain all posts eventually because of the flattening
            await waitForResolved(async () => {
                expect(rootFromAnotherNode.replies.log.log.length).to.eq(4);

                const allReplies = await rootFromAnotherNode.replies.index
                    .iterate({ query: [] }, { local: true })
                    .all();
                expect(allReplies).to.have.length(4);
                for (const x of allReplies) {
                    const title = await x.createTitle();
                    expect(title.length > 0).to.be.true;
                }
            });
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

        it("can reload", async () => {
            let root = await session.peers[0].open(
                new Canvas({
                    publicKey: session.peers[0].identity.publicKey,
                    seed: new Uint8Array(),
                })
            );
            let [a] = await root.getCreateRoomByPath(["a"]);
            await root.getCreateRoomByPath(["a", "b"]);
            await root.getCreateRoomByPath(["a", "c"]);

            const allReplies = await a.replies.index
                .iterate({ query: getImmediateRepliesQuery(a) })
                .all();
            expect(allReplies).to.have.length(2);

            const elements = await a.elements.index
                .iterate({ query: getOwnedElementsQuery(a) })
                .all();
            expect(elements).to.have.length(1);

            await root.close();
            root = await session.peers[0].open(root.clone());

            const allRepliesAfterReload = await root.replies.index
                .iterate({ query: getImmediateRepliesQuery(root) })
                .all();

            expect(allRepliesAfterReload).to.have.length(1);
            const aReopen = await session.peers[0].open(a.clone(), {
                existing: "reuse",
            });
            await aReopen.load();
            const elementsAfterReload = await aReopen.elements.index
                .iterate({ query: getOwnedElementsQuery(a) })
                .all();
            expect(elementsAfterReload).to.have.length(1);
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

        describe("elements", async () => {
            it("can query by ownership", async () => {
                const root = await session.peers[0].open(
                    new Canvas({
                        publicKey: session.peers[0].identity.publicKey,
                        seed: new Uint8Array(),
                    })
                );
                const [a] = await root.getCreateRoomByPath(["a"]);
                await root.getCreateRoomByPath(["a", "b1"]);
                await root.getCreateRoomByPath(["a", "b2"]);

                expect(await a.createTitle()).to.eq("a");

                const allSubElements = await a.elements.index
                    .iterate({
                        query: getOwnedAndSubownedElementsQuery(a),
                    })
                    .all();
                expect(allSubElements).to.have.length(3);

                const ownedElements = await a.elements.index
                    .iterate({
                        query: getOwnedElementsQuery(a),
                    })
                    .all();

                expect(ownedElements).to.have.length(1);

                const subOwnedElements = await a.elements.index
                    .iterate({
                        query: getSubownedElementsQuery(a),
                    })
                    .all();

                expect(subOwnedElements).to.have.length(2);
            });

            it("can query by type", async () => {
                const root = await session.peers[0].open(
                    new Canvas({
                        publicKey: session.peers[0].identity.publicKey,
                        seed: new Uint8Array(),
                    })
                );
                const [a] = await root.getCreateRoomByPath(["a"]);
                await root.getCreateRoomByPath(["a", "b1"]);

                const subcanvasWithImage = await session.peers[0].open(
                    new Canvas({
                        parent: a,
                        publicKey: session.peers[0].identity.publicKey,
                    })
                );
                await subcanvasWithImage.load();
                await subcanvasWithImage.elements.put(
                    new Element({
                        content: new StaticContent({
                            content: new StaticImage({
                                data: new Uint8Array([1, 2, 3, 4]),
                                height: 100,
                                width: 100,
                                mimeType: "image/png",
                            }),
                            contentId: sha256Sync(new Uint8Array([1, 2, 3, 4])),
                            quality: LOWEST_QUALITY,
                        }),
                        parent: subcanvasWithImage,
                        location: Layout.zero(),
                        publicKey: session.peers[0].identity.publicKey,
                    })
                );

                await a.load();
                await a.replies.put(subcanvasWithImage);

                const ownedElements = await a.elements.index
                    .iterate({
                        query: getOwnedAndSubownedElementsQuery(a),
                    })
                    .all();

                expect(ownedElements).to.have.length(3); // self + (text reply + image reply)

                const ownedTextElements = await a.elements.index
                    .iterate({
                        query: [
                            ...getOwnedAndSubownedElementsQuery(a),
                            getTextElementsQuery(),
                        ],
                    })
                    .all();

                expect(ownedTextElements).to.have.length(2); // self + text reply

                const ownedImageElements = await a.elements.index
                    .iterate({
                        query: [
                            ...getOwnedAndSubownedElementsQuery(a),
                            getImagesQuery(),
                        ],
                    })
                    .all();

                expect(ownedImageElements).to.have.length(1); // image reply
            });
        });

        describe("path", () => {
            it("setParent", async () => {
                let root = await session.peers[0].open(
                    new Canvas({
                        publicKey: session.peers[0].identity.publicKey,
                        seed: new Uint8Array(),
                    })
                );
                const [c] = await root.getCreateRoomByPath(["a", "b", "c"]);
                const [a] = await root.getCreateRoomByPath(["a"]);
                const [b] = await root.getCreateRoomByPath(["a", "b"]);
                expect(a.path).to.have.length(1);
                expect(b.path).to.have.length(2);
                expect(c.path).to.have.length(3);
                expect(c.path[0].address).to.eq(root.address);
                expect(c.path[1].address).to.eq(a.address);
                expect(c.path[2].address).to.eq(b.address);

                let cElements = await c.elements.index
                    .iterate({ query: getOwnedElementsQuery(c) })
                    .all();
                expect(cElements).to.have.length(1);
                expect(cElements[0].path).to.have.length(4); // root + a + b + c

                await c.setParent(a);
                expect(c.path).to.have.length(2);
                expect(c.path[0].address).to.eq(root.address);
                expect(c.path[1].address).to.eq(a.address);

                cElements = await c.elements.index
                    .iterate({ query: getOwnedElementsQuery(c) })
                    .all();
                expect(cElements).to.have.length(1);
                expect(cElements[0].path).to.have.length(3); // root + a + c
            });

            // TODO implement sub elements move
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
