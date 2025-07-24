import { TestSession } from "@peerbit/test-utils";
import { Canvas, getImmediateRepliesQuery, getRepliesQuery } from "../content.js";
import { expect } from "chai";
import { Ed25519Keypair, randomBytes } from "@peerbit/crypto";
import { createAlbumTemplate, Template, Templates } from "../template.js";
import { delay } from "@peerbit/time";

describe("templates", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(2);
    });

    afterEach(async () => {
        await session.stop();
    });

    describe("insertInto", () => {

        const checkTemplate = async (properties: { from: Canvas, inserted: Canvas, expectedImmediatechildren: number, names: string[] }) => {
            const bChildren = await properties.from.replies.index
                .iterate({ query: getImmediateRepliesQuery(properties.from) })
                .all();

            expect(bChildren.length).to.equal(properties.expectedImmediatechildren);
            const insertedFoundInChildren = bChildren.find(
                (x) => x.idString === properties.inserted.idString
            );
            expect(insertedFoundInChildren).to.exist;
            expect(insertedFoundInChildren?.__indexed.context).to.equal(properties.names[0]);
            expect(insertedFoundInChildren?.__indexed.hasLayout).to.be.true;

            const insertedChildren =
                await insertedFoundInChildren!.replies.index
                    .iterate({
                        query: getImmediateRepliesQuery(
                            insertedFoundInChildren!
                        ),
                    })
                    .all();
            expect(insertedChildren.length).to.equal(1);
            expect(insertedChildren[0].__indexed.context).to.equal(properties.names[1]);
            expect(insertedChildren[0]?.__indexed.hasLayout).to.be.true;

        }

        it("root", async () => {
            const randomRootKey = (await Ed25519Keypair.create()).publicKey;
            const root = await session.peers[0].open(
                new Canvas({
                    publicKey: randomRootKey,
                    seed: new Uint8Array(),
                })
            );

            const [_a, b, _c] = await root.getCreateCanvasByPath([
                "a",
                "b",
                "c",
            ]);

            const templateRootKey = (await Ed25519Keypair.create()).publicKey;
            const templateRoot = await session.peers[0].open(
                new Canvas({
                    publicKey: templateRootKey,
                    seed: new Uint8Array([0, 1, 2]),
                })
            );

            const [t1, _t2] = await templateRoot.getCreateCanvasByPath([
                "t1",
                "t2"
            ]);

            // close the prototype origin so we can test that insertInto will re-open it
            await templateRoot.close();
            await t1.close();


            const template = new Template({
                name: "Test Template",
                description: "A test template",
                prototype: t1,
            });

            const inserted = await template.insertInto(root);
            await checkTemplate({
                from: root,
                inserted: inserted,
                expectedImmediatechildren: 2,
                names: ["t1", "t2"]
            });

        });

        it("middle", async () => {
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

            const templateRootKey = (await Ed25519Keypair.create()).publicKey;
            const templateRoot = await session.peers[0].open(
                new Canvas({
                    publicKey: templateRootKey,
                    seed: new Uint8Array([0, 1, 2]),
                })
            );

            const [t1, t2, t3] = await templateRoot.getCreateCanvasByPath([
                "t1",
                "t2",
                "t3",
            ]);

            // close the prototype origin so we can test that insertInto will re-open it
            await templateRoot.close();
            await t1.close();
            await t2.close();
            await t3.close();


            const template = new Template({
                name: "Test Template",
                description: "A test template",
                prototype: t2,
            });

            const inserted = await template.insertInto(b);

            // get b from a and check that b reply counter is 2 
            const aChildren = await a.replies.index.iterate({
                query: getImmediateRepliesQuery(a),
            }).all();
            expect(aChildren.length).to.equal(1);

            await checkTemplate({
                from: b,
                inserted: inserted,
                expectedImmediatechildren: 2,
                names: ["t2", "t3"]
            });
        });

        it("can insert multiple times", async () => {
            const randomRootKey = (await Ed25519Keypair.create()).publicKey;
            const root = await session.peers[0].open(
                new Canvas({
                    publicKey: randomRootKey,
                    seed: new Uint8Array(),
                })
            );

            const [a] = await root.getCreateCanvasByPath([
                "a",
            ]);

            const templateRootKey = (await Ed25519Keypair.create()).publicKey;
            const templateRoot = await session.peers[0].open(
                new Canvas({
                    publicKey: templateRootKey,
                    seed: new Uint8Array([0, 1, 2]),
                })
            );

            const [t1, _t2] = await templateRoot.getCreateCanvasByPath([
                "t1",
                "t2"
            ]);

            // close the prototype origin so we can test that insertInto will re-open it
            await templateRoot.close();
            await t1.close();


            const template = new Template({
                name: "Test Template",
                description: "A test template",
                prototype: t1,
            });

            const inserted = await template.insertInto(a);

            await checkTemplate({
                from: a,
                inserted: inserted,
                expectedImmediatechildren: 1,
                names: ["t1", "t2"]
            });

            const insertedAgain = await template.insertInto(a);

            await checkTemplate({
                from: a,
                inserted: insertedAgain,
                expectedImmediatechildren: 2,
                names: ["t1", "t2"]
            });

        })


    });

    describe("store", () => {
        it("deduplicate", async () => {
            const templates = await session.peers[0].open(
                new Templates(randomBytes(32))
            );
            const album = await createAlbumTemplate({
                peer: session.peers[0],
                description: "Create a photo album",
                name: "Photo Album",
            });

            await templates.templates.put(album);




            const allTemplates = await templates.templates.index
                .iterate({ query: {} })
                .all();
            expect(allTemplates.length).to.equal(1);

            // check that album template has expected amount of children
            let children = await allTemplates[0].prototype.replies.index
                .iterate({ query: getRepliesQuery(allTemplates[0].prototype) })
                .all();
            expect(children.length).to.equal(2);

            for (const child of children) {
                expect(child.__indexed.hasLayout).to.be.true;
            }


            // re-insert the same template
            await templates.templates.put(
                await createAlbumTemplate({
                    peer: session.peers[0],
                    description: "Create a photo album",
                    name: "Photo Album",
                })
            );

            const allTemplatesAfterReInsert = await templates.templates.index
                .iterate({ query: {} })
                .all();

            expect(allTemplatesAfterReInsert.length).to.equal(1);

            // check that album template has expected amount of children
            children = await allTemplatesAfterReInsert[0].prototype.replies.index
                .iterate({ query: getRepliesQuery(allTemplatesAfterReInsert[0].prototype) })
                .all();
            expect(children.length).to.equal(2);
        });
    });
});
