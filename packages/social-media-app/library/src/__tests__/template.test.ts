import { TestSession } from "@peerbit/test-utils";
import { Canvas, getImmediateRepliesQuery } from "../content.js";
import { expect } from "chai";
import { Ed25519Keypair, randomBytes } from "@peerbit/crypto";
import { createAlbumTemplate, Template, Templates } from "../template.js";

describe("templates", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(2);
    });

    afterEach(async () => {
        await session.stop();
    });

    describe("insertInto", () => {
        it("single", async () => {
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
                    seed: new Uint8Array(),
                })
            );

            const [_t1, t2, _t3] = await templateRoot.getCreateCanvasByPath([
                "t1",
                "t2",
                "t3",
            ]);
            const template = new Template({
                name: "Test Template",
                description: "A test template",
                prototype: t2,
            });

            const inserted = await template.insertInto(b);

            const bChildren = await b.replies.index
                .iterate({ query: getImmediateRepliesQuery(b) })
                .all();
            expect(bChildren.length).to.equal(2);
            const insertedFoundInChildren = bChildren.find(
                (x) => x.idString === inserted.idString
            );
            expect(insertedFoundInChildren).to.exist;
            expect(insertedFoundInChildren?.__indexed.context).to.equal("t2");

            const insertedChildren =
                await insertedFoundInChildren!.replies.index
                    .iterate({
                        query: getImmediateRepliesQuery(
                            insertedFoundInChildren!
                        ),
                    })
                    .all();
            expect(insertedChildren.length).to.equal(1);
            expect(insertedChildren[0].__indexed.context).to.equal("t3");
        });
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
        });
    });
});
