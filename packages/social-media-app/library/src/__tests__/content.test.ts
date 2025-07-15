import { TestSession } from "@peerbit/test-utils";
import {
    Canvas,
    getImmediateRepliesQuery,
    getRepliesQuery,
    getOwnedElementsQuery,
    Element,
    StaticContent,
    Layout,
    getTextElementsQuery,
    getImagesQuery,
    LOWEST_QUALITY,
    Purpose,
    Navigation,
    Narrative,
    getNarrativePostsQuery,
} from "../content.js";
import { SearchRequest, Sort, SortDirection } from "@peerbit/document";
import { expect } from "chai";
import { delay, waitForResolved } from "@peerbit/time";
import { Ed25519Keypair, sha256Sync } from "@peerbit/crypto";
import { StaticImage } from "../static/image.js";
import { Peerbit } from "peerbit";
import { createRoot } from "../root.js";

describe("canvas", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(2);
    });

    afterEach(async () => {
        await session.stop();
    });

    const checkContent = async (canvas: Canvas, content: string) => {
        const elements = await canvas.elements.index
            .iterate({ query: getOwnedElementsQuery(canvas) })
            .all();
        expect(elements).to.have.length(1);
        expect(elements[0].__indexed.content).to.eq(content);
    };

    it("can make path", async () => {
        const randomRootKey = (await Ed25519Keypair.create()).publicKey;
        const root = await session.peers[0].open(
            new Canvas({
                publicKey: randomRootKey,
                seed: new Uint8Array(),
            })
        );
        const [_a, _b, c] = await root.getCreateCanvasByPath(["a", "b", "c"]);
        expect(await c.createContext()).to.eq("c");
        expect((await c.loadPath({ includeSelf: true })).length).to.eq(4);

        expect((await c.loadPath({ includeSelf: true }))[3]).to.eq(c);

        const [__a, __b, d] = await root.getCreateCanvasByPath(["a", "b", "d"]);
        expect(await d.createContext()).to.eq("d");
        expect((await d.loadPath({ includeSelf: true })).length).to.eq(4);

        expect((await d.loadPath({ includeSelf: true }))[3]).to.eq(d);

        const childrenFromRoot = await root.replies.index.index
            .iterate({ query: getImmediateRepliesQuery(root) })
            .all();
        expect(childrenFromRoot).to.have.length(1); // both paths start at "a"

        const ab = await root.findCanvasesByPath(["a", "b"]);
        expect(
            await Promise.all(ab.canvases.map((x) => x.createContext()))
        ).to.deep.eq(["b"]);

        const elementsInB = await ab.canvases[0].replies.index.search(
            new SearchRequest({
                query: getImmediateRepliesQuery(ab.canvases[0]),
            })
        );

        const titlesFromB = await Promise.all(
            elementsInB.map((x) => x.createContext())
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
                const title = await x.createContext();
                expect(title.length > 0).to.be.true;
            }
        });
    });

    describe("loadPath", () => {
        it("can load path with length", async () => {
            const randomRootKey = (await Ed25519Keypair.create()).publicKey;
            const root = await session.peers[0].open(
                new Canvas({
                    publicKey: randomRootKey,
                })
            );
            const [a, b, c] = await root.getCreateCanvasByPath(["a", "b", "c"]);
            const path = await c.loadPath({ length: 2, includeSelf: true });
            expect(path).to.have.length(3);
            expect(path.map((x) => x.idString)).to.deep.eq([
                a.idString,
                b.idString,
                c.idString,
            ]);
        });
    });
    describe("createRoot", () => {
        it("can create", async () => {
            let sections = ["About", "Help"];
            const root = await createRoot(session.peers[0], {
                persisted: true,
                sections,
            });
            expect(root).to.exist;

            const repliesCount = await root.replies.index.getSize();

            expect(repliesCount).to.eq(2);
            const replies = await root.replies.index
                .iterate({ query: getRepliesQuery(root) })
                .all();
            replies.sort((a, b) =>
                a.__indexed.context.localeCompare(b.__indexed.context)
            );
            const [first, second] = replies;

            await checkContent(first, "About");
            await checkContent(second, "Help");

            const type = await root.getType();
            expect(type).to.not.exist;

            const feedType = await first.getType();
            expect(feedType).to.exist;
            expect(feedType?.type).to.be.instanceOf(Navigation);

            // creating again should resolve in the same address
            const root2 = await createRoot(session.peers[1], {
                persisted: true,
                sections,
            });
            expect(root2.address).to.eq(root.address);

            await root2.replies.log.waitForReplicator(
                session.peers[0].identity.publicKey
            );
            const replies2 = await root2.replies.index
                .iterate({ query: getRepliesQuery(root) })
                .all();
            const [first2] = replies2;
            expect(first2.address).to.eq(first.address);
        });
    });

    describe("getViewContext", () => {
        it("view context from root", async () => {
            const root = await createRoot(session.peers[0], {
                persisted: true,
            });
            expect((await root.getType())?.type).to.be.undefined;
            const [feed] = await root.getCreateCanvasByPath(["Feed"]);
            expect((await feed.getType())?.type).to.be.instanceOf(Navigation);

            const path = await feed.getCreateCanvasByPath(["a"]);
            const a = path[path.length - 1];
            const rootFromA = await a.getViewContext();
            expect(rootFromA![0].idString).to.eq(a.idString);

            const rootFromFeed = await feed.getViewContext();
            expect(rootFromFeed![0].idString).to.eq(root.idString);

            const rootFromRoot = await root.getViewContext();
            expect(rootFromRoot![0].idString).to.eq(root.idString);
        });

        it("root as navigation", async () => {
            const randomRootKey = (await Ed25519Keypair.create()).publicKey;
            const root = await session.peers[0].open(
                new Canvas({
                    publicKey: randomRootKey,
                    seed: new Uint8Array(),
                })
            );

            const [a] = await root.getCreateCanvasByPath(["a"]);
            await root.setType(
                new Purpose({
                    canvasId: root.id,
                    type: new Navigation(),
                })
            );

            await a.setType(
                new Purpose({
                    canvasId: a.id,
                    type: new Navigation(),
                })
            );

            expect(await root.getType()).to.exist;
            expect(await a.getType()).to.exist;
            const rootFromC = await a.getViewContext();
            expect(rootFromC?.map((x) => x.idString)).to.deep.eq([
                root.idString,
                a.idString,
            ]);
        });

        it("skips tab visualization", async () => {
            const randomRootKey = (await Ed25519Keypair.create()).publicKey;
            const root = await session.peers[0].open(
                new Canvas({
                    publicKey: randomRootKey,
                    seed: new Uint8Array(),
                })
            );

            const [a, b, c] = await root.getCreateCanvasByPath(["a", "b", "c"]);

            await a.setType(
                new Purpose({
                    canvasId: a.id,
                    type: new Narrative(),
                })
            );

            await b.setType(
                new Purpose({
                    canvasId: b.id,
                    type: new Navigation(),
                })
            );

            await c.setType(
                new Purpose({
                    canvasId: c.id,
                    type: new Navigation(),
                })
            );

            expect(await a.getType()).to.exist;
            expect(await b.getType()).to.exist;
            expect(await c.getType()).to.exist;

            const rootFromC = await c.getViewContext();
            expect(rootFromC?.map((x) => x.idString)).to.deep.eq([
                a.idString,
                b.idString,
                c.idString,
            ]);
        });

        it("root returns root", async () => {
            const randomRootKey = (await Ed25519Keypair.create()).publicKey;
            const root = await session.peers[0].open(
                new Canvas({
                    publicKey: randomRootKey,
                    seed: new Uint8Array(),
                })
            );

            const rootFromRoot = await root.getViewContext();
            expect(rootFromRoot?.map((x) => x.idString)).to.deep.eq([
                root.idString,
            ]);
        });
    });

    describe("getFeedContext", () => {
        it("feed context from root", async () => {
            const root = await createRoot(session.peers[0], {
                persisted: true,
            });
            const [feed] = await root.getCreateCanvasByPath(["Feed"]);
            const path = await feed.getCreateCanvasByPath(["a"]);
            const a = path[path.length - 1];
            const feedFromA = await a.getFeedContext();
            expect(feedFromA!.idString).to.eq(a.idString);

            const feedFromRoot = await root.getFeedContext();
            expect(feedFromRoot!.idString).to.eq(feed.idString);
        });

        it("narrative at root", async () => {
            const randomRootKey = (await Ed25519Keypair.create()).publicKey;
            const root = await session.peers[0].open(
                new Canvas({
                    publicKey: randomRootKey,
                    seed: new Uint8Array(),
                })
            );

            const [a, b, c] = await root.getCreateCanvasByPath(["a", "b", "c"]);

            await a.setType(
                new Purpose({
                    canvasId: a.id,
                    type: new Narrative(),
                })
            );

            await b.setType(
                new Purpose({
                    canvasId: b.id,
                    type: new Navigation(),
                })
            );
            expect(await a.getType()).to.exist;
            expect(await b.getType()).to.exist;
            const feedFromA = await a.getFeedContext();
            expect(feedFromA?.idString).to.deep.eq(a.idString);
        });

        it("narrative at middle", async () => {
            const randomRootKey = (await Ed25519Keypair.create()).publicKey;
            const root = await session.peers[0].open(
                new Canvas({
                    publicKey: randomRootKey,
                    seed: new Uint8Array(),
                })
            );

            const [a, b, _c] = await root.getCreateCanvasByPath([
                "a",
                "b",
                "c",
            ]);

            await a.setType(
                new Purpose({
                    canvasId: a.id,
                    type: new Navigation(),
                })
            );

            await b.setType(
                new Purpose({
                    canvasId: b.id,
                    type: new Narrative(),
                })
            );

            expect(await a.getType()).to.exist;
            expect(await b.getType()).to.exist;
            const feedFromA = await a.getFeedContext();
            expect(feedFromA?.idString).to.deep.eq(b.idString);
        });
    });

    it("index once", async () => {
        const randomRootKey = (await Ed25519Keypair.create()).publicKey;
        const root = await session.peers[0].open(
            new Canvas({
                publicKey: randomRootKey,
                seed: new Uint8Array(),
            })
        );

        let putIndexCalls = root.replies.index.putWithContext.bind(
            root.replies.index
        );

        let putCount = 0;
        root.replies.index.putWithContext = async (a, b, c) => {
            putCount++;
            return putIndexCalls(a, b, c);
        };

        await root.getCreateCanvasByPath(["a"]);
        expect(putCount).to.eq(1);
    });

    it("indexes replies", async () => {
        const randomRootKey = (await Ed25519Keypair.create()).publicKey;
        const root1 = await session.peers[0].open(
            new Canvas({
                publicKey: randomRootKey,
                seed: new Uint8Array(),
            })
        );
        const [a, b] = await root1.getCreateCanvasByPath(["a", "b"]);

        expect(Number(a.__indexed.replies)).to.eq(1); // a has one reply (b)
        expect(Number(b.__indexed.replies)).to.eq(0); // b has no replies
    });

    it("indexes replies ignores navigational posts", async () => {
        const randomRootKey = (await Ed25519Keypair.create()).publicKey;
        const root1 = await session.peers[0].open(
            new Canvas({
                publicKey: randomRootKey,
                seed: new Uint8Array(),
            })
        );
        let [a, b, c] = await root1.getCreateCanvasByPath(["a", "b", "c"]);

        expect(Number(a.__indexed.replies)).to.eq(2);
        expect(Number(b.__indexed.replies)).to.eq(1);
        expect(Number(c.__indexed.replies)).to.eq(0);

        // await delay(2e3)

        await b.setType(
            new Purpose({
                canvasId: b.id,
                type: new Navigation({}),
            })
        );

        await delay(5e3);
        const iterator = root1.replies.index.iterate({
            query: getNarrativePostsQuery(),
        });
        const all = await iterator.all();
        expect(all).to.have.length(2);

        let [aMod, bMod, cMod] = await root1.getCreateCanvasByPath([
            "a",
            "b",
            "c",
        ]);

        expect(Number(aMod.__indexed.replies)).to.eq(1);
        expect(Number(bMod.__indexed.replies)).to.eq(1);
        expect(Number(cMod.__indexed.replies)).to.eq(0);
    });

    /*
    //  TODO for keep: 'self' property is used and a remote not is modifying the same document, updates will not be propagate
    // this will lead to issues when working with indexed data and fetching stuff "local first"
    
    it("will not re-index parents if not replicating", async () => {
         const randomRootKey = (await Ed25519Keypair.create()).publicKey;
         const root1 = await session.peers[0].open(
             new Canvas({
                 publicKey: randomRootKey,
                 seed: new Uint8Array(),
             })
         );
         const [a1] = await root1.getCreateCanvasByPath(["a"]);
 
         const root2 = await session.peers[1].open(root1.clone(), {
             args: {
                 replicate: false,
             },
         });
 
         await root2.replies.log.waitForReplicators({ waitForNewPeers: true });
 
         let putIndexCalls = root2.replies.index.putWithContext.bind(
             root2.replies.index
         );
 
         let putCount = 0;
         await root2.load();
         root2.replies.index.putWithContext = async (a, b, c) => {
             putCount++;
             return putIndexCalls(a, b, c);
         };
 
         const [a2, b2] = await root2.getCreateCanvasByPath(["a", "b"]);
         await waitForResolved(async () => expect(Number(await a1.countReplies({ onlyImmediate: true }))).to.eq(1))
 
         expect(putCount).to.eq(1);
 
         const checkReplies = async (root: Canvas) => {
             const a = await root.getCreateCanvasByPath(["a"])
             expect(a).to.have.length(1);
             const asIndexed = a[0] as WithIndexedContext<Canvas, IndexableCanvas>;
 
             expect(asIndexed.__indexed).to.exist; // root + a
             expect(Number(await a1.countReplies({ onlyImmediate: true }))).to.eq(1);
             expect(Number(asIndexed.__indexed.replies)).to.eq(1); // a has one reply (b)
         }
 
         await checkReplies(root1);
         await checkReplies(root2);
 
 
 
     }); */
    it("same path", async () => {
        const randomRootKey = (await Ed25519Keypair.create()).publicKey;
        const root1 = await session.peers[0].open(
            new Canvas({
                publicKey: randomRootKey,
                seed: new Uint8Array(),
            })
        );

        const indexSize = await root1.replies.index.getSize();
        expect(indexSize).to.eq(0);

        const [a1] = await root1.getCreateCanvasByPath(["a"]);

        const indexSize1 = await root1.replies.index.getSize();
        expect(indexSize1).to.eq(1);

        const [a2, b2] = await root1.getCreateCanvasByPath(["a", "b"]);

        const indexSize2 = await root1.replies.index.getSize();
        expect(indexSize2).to.eq(2);
    });

    it("can reload", async () => {
        let root = await session.peers[0].open(
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                seed: new Uint8Array(),
            })
        );
        let [a] = await root.getCreateCanvasByPath(["a"]);
        await root.getCreateCanvasByPath(["a", "b"]);
        await root.getCreateCanvasByPath(["a", "c"]);

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

    it("can reload subpath only ", async () => {
        await session.stop();

        let directory = "./tmp/can reload subpath only/" + +new Date();
        session = await TestSession.connected(1, { directory });
        let peer = session.peers[0];

        let root = await peer.open(
            new Canvas({
                publicKey: peer.identity.publicKey,
                seed: new Uint8Array(),
            })
        );
        const [a, b] = await root.getCreateCanvasByPath(["a", "b"]);
        const experience = await peer.services.blocks.get(b.address);
        expect(experience).to.exist;

        await peer.stop();

        // session = await TestSession.connected(1, { directory });
        // peer = session.peers[0] as any;
        peer = await Peerbit.create({ directory });

        const experienceAgain = await peer.services.blocks.get(b.address);
        expect(experienceAgain).to.exist;
    });

    describe("replies", () => {
        it("index 1 reply", async () => {
            const root = await session.peers[0].open(
                new Canvas({
                    publicKey: session.peers[0].identity.publicKey,
                    seed: new Uint8Array(),
                })
            );

            const [a, b] = await root.getCreateCanvasByPath(["a", "b"]);
            expect(a).to.exist;
            expect(b).to.exist;

            // index updates are not immediate, so we do checks until it's updated
            await waitForResolved(async () => {
                const countedAllRepliesFromRoot = await root.countReplies();
                expect(countedAllRepliesFromRoot).to.eq(2n); // a immediate child of root, b immediate child of a

                const countedImmediateRepliesFromRoot = await root.countReplies(
                    { onlyImmediate: true }
                );
                expect(countedImmediateRepliesFromRoot).to.eq(1n); // a immediate child of root

                const replies = await root.replies.index
                    .iterate(
                        { query: getImmediateRepliesQuery(root) },
                        { resolve: false }
                    )
                    .all();
                expect(replies).to.have.length(1);
                expect(replies[0].context).to.eq("a");
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
            await root.getCreateCanvasByPath(["a", "b", "c"]);
            await root.getCreateCanvasByPath(["a", "b", "d"]);
            const a = (await root.getCreateCanvasByPath(["a"]))[0];
            expect(await a.createContext()).to.eq("a");

            const all = await a.replies.index
                .iterate({
                    query: getRepliesQuery(a),
                })
                .all();
            // should return all children
            // b, c, d
            expect(all).to.have.length(3);
            const allTitles = await Promise.all(
                all.map((x) => x.createContext())
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
            await root.getCreateCanvasByPath(["a", "b", "c"]);
            await root.getCreateCanvasByPath(["a", "b", "d"]);
            const [_a, b] = await root.getCreateCanvasByPath(["a", "b"]);
            expect(await b.createContext()).to.eq("b");

            const all = await b.replies.index
                .iterate({
                    query: getImmediateRepliesQuery(b),
                })
                .all();

            const allTitles = await Promise.all(
                all.map((x) => x.createContext())
            );
            expect(allTitles.sort()).to.deep.eq(["c", "d"]);
        });

        it("can sort by replies", async () => {
            const root = await session.peers[0].open(
                new Canvas({
                    publicKey: session.peers[0].identity.publicKey,
                    seed: new Uint8Array(),
                })
            );
            await root.getCreateCanvasByPath(["b", "b"]);
            await root.getCreateCanvasByPath(["a", "b"]);
            await root.getCreateCanvasByPath(["c"]);
            await root.getCreateCanvasByPath(["a", "c"]);

            const sortedByReplies = await root.replies.index.search({
                query: getImmediateRepliesQuery(root),
                sort: new Sort({
                    key: "replies",
                    direction: SortDirection.DESC,
                }),
            });
            expect(
                await Promise.all(sortedByReplies.map((x) => x.createContext()))
            ).to.deep.eq(["a", "b", "c"]);
        });

        it("will use remote for sorting during warmup", async () => {
            const rootA = await session.peers[0].open(
                new Canvas({
                    publicKey: session.peers[0].identity.publicKey,
                    seed: new Uint8Array(),
                })
            );

            let childrenCount = {
                a: 1,
                b: 2,
                c: 3,
            };

            for (const [key, count] of Object.entries(childrenCount)) {
                for (let i = 0; i < count; i++) {
                    // console.log("key: " + key + "key", "i", i)
                    await rootA.getCreateCanvasByPath([key, i.toString()]);
                }
            }

            // a has 1 reply
            // b has 2 replies
            // c has 3 replies

            // so sorting by replies will be c, b, a
            const results = async (root: Canvas) => {
                const sorted = await root.replies.index
                    .iterate({
                        query: getImmediateRepliesQuery(root),
                        sort: new Sort({
                            key: "replies",
                            direction: SortDirection.DESC,
                        }),
                    })
                    .all();

                for (const [i, r] of sorted.entries()) {
                    if (r.closed) {
                        sorted[i] = await root.node.open(r, {
                            existing: "reuse",
                        });
                    }
                }
                const titles = await Promise.all(
                    sorted.map((x) => x.createContext())
                );
                expect(titles).to.deep.eq(["c", "b", "a"]);
            };
            await results(rootA);

            const rootB = await session.peers[1].open(rootA.clone(), {
                args: {
                    replicate: false,
                },
            });
            await rootB.replies.log.waitForReplicators();
            await results(rootB);
        });

        it("will use remote for sorting during warmup when not replicating", async () => {
            const rootA = await session.peers[0].open(
                new Canvas({
                    publicKey: session.peers[0].identity.publicKey,
                    seed: new Uint8Array(),
                })
            );

            let childrenCount = {
                a: 1,
                b: 2,
                c: 3,
            };

            for (const [key, count] of Object.entries(childrenCount)) {
                for (let i = 0; i < count; i++) {
                    // console.log("key: " + key + "key", "i", i)
                    await rootA.getCreateCanvasByPath([key, i.toString()]);
                }
            }

            // a has 1 reply
            // b has 2 replies
            // c has 3 replies

            // so sorting by replies will be c, b, a
            const results = async (root: Canvas) => {
                const sorted = await root.replies.index
                    .iterate({
                        query: getImmediateRepliesQuery(root),
                        sort: new Sort({
                            key: "replies",
                            direction: SortDirection.DESC,
                        }),
                    })
                    .all();

                for (const [i, r] of sorted.entries()) {
                    if (r.closed) {
                        sorted[i] = await root.node.open(r, {
                            existing: "reuse",
                            args: {
                                replicate: false,
                            },
                        });
                    }
                }

                await delay(3e3);
                const titles = await Promise.all(
                    sorted.map((x) => x.createContext())
                );
                expect(titles).to.deep.eq(["c", "b", "a"]);
            };
            await results(rootA);

            const rootB = await session.peers[1].open(rootA.clone(), {
                args: {
                    replicate: false,
                },
            });
            await rootB.replies.log.waitForReplicators({ roleAge: 5e3 });
            await results(rootB);
        });

        it("can sort by replies after restart", async () => {
            await session.stop();

            session = await TestSession.connected(1, {
                directory: "./tmp/can-sort-after-restart/" + +new Date(),
            });

            let root = await session.peers[0].open(
                new Canvas({
                    publicKey: session.peers[0].identity.publicKey,
                    seed: new Uint8Array(),
                })
            );
            await root.getCreateCanvasByPath(["b", "b"]);
            await root.getCreateCanvasByPath(["a", "b"]);
            await root.getCreateCanvasByPath(["c"]);
            await root.getCreateCanvasByPath(["a", "c"]);

            const checkSort = async () => {
                const sortedByReplies = await root.replies.index.search({
                    query: getImmediateRepliesQuery(root),
                    sort: new Sort({
                        key: "replies",
                        direction: SortDirection.DESC,
                    }),
                });
                for (const [i, r] of sortedByReplies.entries()) {
                    if (r.closed) {
                        sortedByReplies[i] = await root.node.open(r, {
                            existing: "reuse",
                        });
                        await sortedByReplies[i].load(); // TODO why is this needed?
                    }
                }
                expect(
                    await Promise.all(
                        sortedByReplies.map((x) => x.createContext())
                    )
                ).to.deep.eq(["a", "b", "c"]);
            };

            await checkSort();
            await root.close();
            root = await session.peers[0].open(root.clone(), {
                existing: "reject",
            });
            await checkSort();
        });

        it("can sort by replies as non replicator", async () => {
            let root = await session.peers[0].open(
                new Canvas({
                    publicKey: session.peers[0].identity.publicKey,
                    seed: new Uint8Array(),
                }),
                {
                    args: {
                        replicate: false,
                    },
                }
            );
            let replicator = await session.peers[1].open(root.clone());

            await root.getCreateCanvasByPath(["b", "b"]);
            await root.getCreateCanvasByPath(["a", "b"]);
            await root.getCreateCanvasByPath(["c"]);
            await root.getCreateCanvasByPath(["a", "c"]);

            await waitForResolved(() =>
                expect(replicator.replies.log.log.length).to.eq(6)
            );

            const checkSort = async () => {
                const sortedByReplies = await root.replies.index.search({
                    query: getImmediateRepliesQuery(root),
                    sort: new Sort({
                        key: "replies",
                        direction: SortDirection.DESC,
                    }),
                });
                for (const [i, r] of sortedByReplies.entries()) {
                    if (r.closed) {
                        sortedByReplies[i] = await root.node.open(r, {
                            existing: "reuse",
                        });
                        await sortedByReplies[i].load(); // TODO why is this needed?
                    }
                }
                expect(
                    await Promise.all(
                        sortedByReplies.map((x) => x.createContext())
                    )
                ).to.deep.eq(["a", "b", "c"]);
            };

            await checkSort();
            await root.close();
            root = await session.peers[0].open(root.clone(), {
                existing: "reject",
                args: {
                    replicate: false,
                },
            });
            await checkSort();
        });

        it("can index partially", async () => {
            let viewer = await session.peers[0].open(
                new Canvas({
                    publicKey: session.peers[0].identity.publicKey,
                    seed: new Uint8Array(),
                }),
                {
                    args: {
                        replicate: false,
                        replicas: {
                            min: 1,
                        },
                    },
                }
            );
            let replicator = await session.peers[1].open(viewer.clone(), {
                args: {
                    replicas: {
                        min: 1,
                    },
                },
            });
            await replicator.getCreateCanvasByPath(["a", "b"]);

            const all = await viewer.replies.index.search({
                sort: new Sort({
                    key: "replies",
                    direction: SortDirection.DESC,
                }),
            });
            const first = await viewer.node.open(all[0], {
                existing: "reuse",
                args: {
                    replicate: false,
                },
            });
            expect(await first.createContext()).to.eq("a");

            const entry = await replicator.replies.log.log.get(
                first.__context.head
            );
            await viewer.replies.log.replicate(entry);

            await delay(2e3);
            await waitForResolved(() =>
                expect(viewer.replies.log.log.length).to.eq(1)
            );
            expect(await viewer.replies.log.isReplicating()).to.be.true;
        });

        it("two way replication", async () => {
            let first = await session.peers[0].open(
                new Canvas({
                    publicKey: session.peers[0].identity.publicKey,
                    seed: new Uint8Array(),
                }),
                {
                    args: {
                        replicate: true,
                    },
                }
            );
            await first.getCreateCanvasByPath(["a", "b"]);

            let second = await session.peers[1].open(first.clone(), {
                args: {
                    replicate: true,
                },
            });

            await waitForResolved(() =>
                expect(second.replies.log.log.length).to.eq(2)
            );

            await first.close();

            first = await session.peers[0].open(second.clone(), {
                existing: "reuse",
                args: {
                    replicate: true,
                },
            });
            await waitForResolved(() =>
                expect(first.replies.log.log.length).to.eq(2)
            );
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
            const [a] = await root.getCreateCanvasByPath(["a"]);
            await root.getCreateCanvasByPath(["a", "b1"]);
            await root.getCreateCanvasByPath(["a", "b2"]);

            expect(await a.createContext()).to.eq("a");

            const ownedElements = await a.elements.index
                .iterate({
                    query: getOwnedElementsQuery(a),
                })
                .all();

            expect(ownedElements).to.have.length(1);
        });

        it("can query by type", async () => {
            const root = await session.peers[0].open(
                new Canvas({
                    publicKey: session.peers[0].identity.publicKey,
                    seed: new Uint8Array(),
                })
            );
            const [a] = await root.getCreateCanvasByPath(["a"]);
            await root.getCreateCanvasByPath(["a", "b1"]);

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
                    canvasId: subcanvasWithImage.id,
                    location: Layout.zero(),
                    publicKey: session.peers[0].identity.publicKey,
                })
            );

            await a.load();
            await a.createReply(subcanvasWithImage);

            const ownedElements = await a.elements.index
                .iterate({
                    query: getOwnedElementsQuery(a),
                })
                .all();

            expect(ownedElements).to.have.length(1); // self

            const ownedTextElements = await a.elements.index
                .iterate({
                    query: [
                        ...getOwnedElementsQuery(a),
                        getTextElementsQuery(),
                    ],
                })
                .all();

            expect(ownedTextElements).to.have.length(1); // self + text reply

            const ownedImageElements = await subcanvasWithImage.elements.index
                .iterate({
                    query: [
                        ...getOwnedElementsQuery(subcanvasWithImage),
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
            const [_a, _b, c] = await root.getCreateCanvasByPath([
                "a",
                "b",
                "c",
            ]);
            const [a] = await root.getCreateCanvasByPath(["a"]);
            const [__a, b] = await root.getCreateCanvasByPath(["a", "b"]);
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
            expect(cElements[0].canvasId).to.deep.eq(c.id);

            await c.setParent(a);
            const checkCanvas = async (c: Canvas) => {
                expect(c.path).to.have.length(2);
                expect(c.path[0].address).to.eq(root.address);
                expect(c.path[1].address).to.eq(a.address);

                cElements = await c.elements.index
                    .iterate({ query: getOwnedElementsQuery(c) })
                    .all();
                expect(cElements).to.have.length(1);
                expect(cElements[0].canvasId).to.deep.eq(c.id);
            };
            await checkCanvas(c);

            // also check c from another peer that is querying the canvas
            const root2 = await session.peers[1].open(root.clone(), {
                existing: "reuse",
                args: {
                    replicate: false,
                },
            });

            await root2.replies.log.waitForReplicators({
                waitForNewPeers: true,
            });
            const [_a2, c2] = await root2.getCreateCanvasByPath(["a", "c"]);
            await checkCanvas(c2);
        });

        // TODO implement sub elements move
    });

    describe("visualization", () => {
        it("can set visualization", () => {});
    });
    /*  it("determinstic with seed", async () => {
         let seed = new Uint8Array([0, 1, 2]);
         const rootA = await session.peers[0].open(
             new Canvas({
                 seed,
                 rootTrust: session.peers[0].identity.publicKey,
             })
         );
         const pathA = await rootA.getCreateCanvasByPath(["a", "b", "c"]);
 
         await session.peers[0].stop();
         await session.peers[0].start();
 
         const rootB = await session.peers[0].open(
             new Canvas({
                 seed,
                 rootTrust: session.peers[0].identity.publicKey,
             })
         );
 
         expect(rootA.address).to.eq(rootB.address);
 
         const pathB = await rootB.getCreateCanvasByPath(["a", "b", "c"]);
         for (const room of pathB) {
             await session.peers[0].open(room);
         }
 
         expect(typeof pathA[pathA.length - 1].address).to.eq("string");
         expect(pathA[pathA.length - 1].address).to.eq(
             pathB[pathB.length - 1].address
         );
     }); */
});
