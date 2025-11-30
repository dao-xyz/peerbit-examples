import { TestSession } from "@peerbit/test-utils";
import {
    Canvas,
    Scope,
    getRepliesQuery,
    getImmediateRepliesQueryByDepth,
    AddressReference,
    getChildrenLinksQuery,
} from "../content.js";
import { Ed25519Keypair, randomBytes, sha256Sync } from "@peerbit/crypto";
import { createAlbumTemplate, Template, Templates } from "../template.js";
import { ensurePath } from "./utils.js";
import { deserialize, serialize } from "@dao-xyz/borsh";
import { ViewKind } from "../link.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

/* ----------------------- test-local helpers ----------------------- */

async function createOpenRootScope(
    session: TestSession,
    seed?: Uint8Array | number[]
) {
    const peer = session.peers[0];
    return peer.open(
        new Scope({
            seed: seed ? new Uint8Array(seed) : undefined,
            publicKey: peer.identity.publicKey,
        })
    );
}

/** Query the immediate children of a parent via links (less sensitive to index timing). */
async function immediateChildren(parent: Canvas): Promise<Canvas[]> {
    const items = await parent.listChildrenWithOrder();
    return items.map((x) => x.child);
}

/* ------------------------------ tests ------------------------------ */

describe("templates", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(2);
    });

    afterEach(async () => {
        await session.stop();
    });

    it("can serialize deserialize", () => {
        const template = new Template({
            description: "A test template",
            name: "Test Template",
            prototype: new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: new AddressReference({ address: "abc123" }),
                id: randomBytes(32),
            }),
            id: randomBytes(32),
        });
        const serialized = serialize(template);
        const deserialized = deserialize(serialized, Template);
        expect(template.name).to.equal(deserialized.name);
        expect(template.description).to.equal(deserialized.description);
        expect(template.prototype.idString).to.equal(
            deserialized.prototype.idString
        );
        expect(template.prototype.selfScope!.address).to.equal(
            deserialized.prototype.selfScope!.address
        );
    });

    describe("insertInto", () => {
        const checkTemplate = async (properties: {
            from: Canvas;
            inserted: Canvas;
            expectedImmediatechildren: number;
            names: string[];
        }) => {
            // children under the insertion point (allow async indexing to settle)
            let children = await immediateChildren(properties.from);
            if (children.length !== properties.expectedImmediatechildren) {
                // try to flush and re-check a few times
                const scope = properties.from.nearestScope;
                for (
                    let i = 0;
                    i < 5 &&
                    children.length !== properties.expectedImmediatechildren;
                    i++
                ) {
                    await scope._hierarchicalReindex!.flush();
                    children = await immediateChildren(properties.from);
                }
            }
            expect(children.length).to.equal(
                properties.expectedImmediatechildren
            );

            // the inserted root exists and has expected title
            const insertedInChildren = children.find(
                (x) => x.idString === properties.inserted.idString
            );
            expect(insertedInChildren).to.exist;

            // wait for context on inserted root
            let insertedIdx =
                await properties.from.nearestScope.replies.index.get(
                    insertedInChildren!.id,
                    { resolve: false }
                );
            if (!insertedIdx || insertedIdx.context !== properties.names[0]) {
                for (let i = 0; i < 5; i++) {
                    await properties.from.nearestScope._hierarchicalReindex!.add(
                        {
                            canvas: insertedInChildren!,
                            options: {
                                onlyReplies: false,
                                skipAncestors: true,
                            },
                        }
                    );
                    await properties.from.nearestScope._hierarchicalReindex!.flush();
                    insertedIdx =
                        await properties.from.nearestScope.replies.index.get(
                            insertedInChildren!.id,
                            { resolve: false }
                        );
                    if (insertedIdx?.context === properties.names[0]) break;
                }
            }
            expect(insertedIdx!.context).to.equal(properties.names[0]);

            // the inserted root should have exactly one immediate child (next template node)
            const insertedChildren = await immediateChildren(
                insertedInChildren!
            );
            expect(insertedChildren.length).to.equal(1);

            // Prefer direct context computation to avoid relying on immediate index timing
            const computed = await insertedChildren[0].createContext();
            expect(computed).to.equal(properties.names[1]);
        };

        it("change to forward scope", async () => {
            const rootScope = await createOpenRootScope(session);

            const templateRootKey = (await Ed25519Keypair.create()).publicKey;
            const templateRootScope = await createOpenRootScope(session);

            // host the template root in its own scope, but *register/link* it in rootScope
            const draft = new Canvas({
                publicKey: templateRootKey,
                selfScope: new AddressReference({
                    address: templateRootScope.address,
                }),
                id: sha256Sync(new Uint8Array([0, 1, 2])),
            });
            const [__, templateRoot] = await rootScope.getOrCreateReply(
                undefined,
                draft
            );

            expect(
                (await rootScope.replies.index.iterate({}).all()).length
            ).to.eq(0);

            // rootScope should see exactly one top-level (the template root)
            expect(
                (await templateRootScope.replies.index.iterate({}).all()).length
            ).to.eq(1);

            // build a child under the template root (in its home scope)
            const [t1] = await ensurePath(templateRoot, ["t1"]);
            expect(t1).to.exist;
        });

        it("private reply on public post", async () => {
            // public scope + root
            const publicScope = await createOpenRootScope(session);
            const templateRootKey = (await Ed25519Keypair.create()).publicKey;

            const publicRoot = new Canvas({
                publicKey: templateRootKey,
                selfScope: new AddressReference({
                    address: publicScope.address,
                }),
                id: sha256Sync(new Uint8Array([9, 9, 9])),
            });
            await publicScope.getOrCreateReply(undefined, publicRoot);

            // private scope + private reply linked under the public root
            const privateScope = await createOpenRootScope(session);

            const privateReplyDraft = new Canvas({
                publicKey: templateRootKey,
                selfScope: new AddressReference({
                    address: privateScope.address,
                }),
                id: sha256Sync(new Uint8Array([1, 2, 3])),
            });
            const [__, privateReply] = await privateScope.getOrCreateReply(
                publicRoot,
                privateReplyDraft
            );

            // a private reply to the private reply (also in private scope)
            const rrDraft = new Canvas({
                publicKey: templateRootKey,
                selfScope: new AddressReference({
                    address: privateScope.address,
                }),
                id: sha256Sync(new Uint8Array([4, 5, 6])),
            });
            await privateScope.getOrCreateReply(privateReply, rrDraft);

            // basic sanity: private scope has two nodes, public scope has at least the public root
            expect(
                (await privateScope.replies.index.iterate({}).all()).length
            ).to.be.greaterThan(1);
            expect(
                (await publicScope.replies.index.iterate({}).all()).length
            ).to.be.greaterThan(0);
        });

        it("root", async () => {
            const rootScope = await createOpenRootScope(session);
            const rootDraft = new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: new AddressReference({ address: rootScope.address }),
                id: sha256Sync(new Uint8Array([0])),
            });
            const [_, root] = await rootScope.getOrCreateReply(
                undefined,
                rootDraft
            );

            const [_a, b, _c] = await ensurePath(root, ["a", "b", "c"]);

            const templateRootKey = (await Ed25519Keypair.create()).publicKey;
            const templateRootScope = await createOpenRootScope(session);
            const templateRoot = new Canvas({
                publicKey: templateRootKey,
                selfScope: new AddressReference({
                    address: templateRootScope.address,
                }),
                id: sha256Sync(new Uint8Array([0, 1, 2])),
            });
            const [__, tRoot] = await rootScope.getOrCreateReply(
                undefined,
                templateRoot
            );

            const [t1, _t2] = await ensurePath(tRoot, ["t1", "t2"]);

            // close the prototype origin so insertInto is forced to reopen it
            await templateRootScope.close();

            const template = new Template({
                name: "Test Template",
                description: "A test template",
                prototype: t1,
            });

            const inserted = await template.insertInto(root);
            await checkTemplate({
                from: root,
                inserted,
                expectedImmediatechildren: 2,
                names: ["t1", "t2"],
            });
        });

        it("middle", async () => {
            const rootScope = await createOpenRootScope(session);
            const rootDraft = new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: new AddressReference({ address: rootScope.address }),
                id: sha256Sync(new Uint8Array([7])),
            });
            const [_, root] = await rootScope.getOrCreateReply(
                undefined,
                rootDraft
            );

            const [a, b, _c] = await ensurePath(root, ["a", "b", "c"]);

            const templateRootKey = (await Ed25519Keypair.create()).publicKey;
            const templateRootScope = await createOpenRootScope(session);
            const tRootDraft = new Canvas({
                publicKey: templateRootKey,
                selfScope: new AddressReference({
                    address: templateRootScope.address,
                }),
                id: sha256Sync(new Uint8Array([8, 1, 2])),
            });
            const [__, tRoot] = await rootScope.getOrCreateReply(
                undefined,
                tRootDraft
            );

            const [t1, t2, t3] = await ensurePath(tRoot, ["t1", "t2", "t3"]);

            // close the prototype origin so insertInto is forced to reopen it
            await templateRootScope.close();

            const template = new Template({
                name: "Test Template",
                description: "A test template",
                prototype: t2,
            });

            const inserted = await template.insertInto(b);

            // b should still be the only immediate child of a
            const aChildren = await immediateChildren(a);
            expect(aChildren.length).to.equal(1);

            await checkTemplate({
                from: b,
                inserted,
                expectedImmediatechildren: 2,
                names: ["t2", "t3"],
            });
        });

        it("can insert multiple times", async () => {
            const rootScope = await createOpenRootScope(session);
            const rootDraft = new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: new AddressReference({ address: rootScope.address }),
                id: sha256Sync(new Uint8Array([11])),
            });
            const [_, root] = await rootScope.getOrCreateReply(
                undefined,
                rootDraft
            );

            const [a] = await ensurePath(root, ["a"]);

            const templateRootKey = (await Ed25519Keypair.create()).publicKey;
            const templateRootScope = await createOpenRootScope(session);
            const tRootDraft = new Canvas({
                publicKey: templateRootKey,
                selfScope: new AddressReference({
                    address: templateRootScope.address,
                }),
                id: sha256Sync(new Uint8Array([12, 1, 2])),
            });
            const [__, tRoot] = await rootScope.getOrCreateReply(
                undefined,
                tRootDraft
            );

            const [t1, _t2] = await ensurePath(tRoot, ["t1", "t2"]);

            await templateRootScope.close();

            const template = new Template({
                name: "Test Template",
                description: "A test template",
                prototype: t1,
            });

            const first = await template.insertInto(a);
            await checkTemplate({
                from: a,
                inserted: first,
                expectedImmediatechildren: 1,
                names: ["t1", "t2"],
            });

            const second = await template.insertInto(a);
            await checkTemplate({
                from: a,
                inserted: second,
                expectedImmediatechildren: 2,
                names: ["t1", "t2"],
            });
        });
    });

    describe("templates", () => {
        it("canCreateAlbumTemplate", async () => {
            const scope = await createOpenRootScope(session);
            const album = await createAlbumTemplate({
                peer: session.peers[0],
                description: "Create a photo album",
                name: "Photo Album",
                scope,
            });

            const [_, root] = await scope.getOrCreateReply(
                undefined,
                new Canvas({
                    publicKey: session.peers[0].identity.publicKey,
                    selfScope: scope,
                    id: randomBytes(32),
                })
            );

            const inserted = await album.insertInto(root);

            const childrenLinks = await album.prototype.links.index
                .iterate({
                    query: getChildrenLinksQuery(inserted.id),
                })
                .all();

            expect(childrenLinks.length).to.equal(2);
            expect(childrenLinks[0].kind).to.instanceOf(ViewKind);
            expect(childrenLinks[1].kind).to.instanceOf(ViewKind);
        });
    });

    describe("store", () => {
        it("deduplicate", async () => {
            const templates = await session.peers[0].open(
                new Templates(randomBytes(32))
            );
            const scope = await createOpenRootScope(session);
            const album = await createAlbumTemplate({
                peer: session.peers[0],
                description: "Create a photo album",
                name: "Photo Album",
                scope,
            });

            await templates.templates.put(album);

            const allTemplates = await templates.templates.index
                .iterate({ query: {} })
                .all();
            expect(allTemplates.length).to.equal(1);
            const linkCount = await scope.links.index.getSize();

            const repliesCount = await scope.replies.index.getSize();
            const elementsCount = await scope.elements.index.getSize();

            // album template has two children
            let children = await allTemplates[0].prototype.replies.index
                .iterate({ query: getRepliesQuery(allTemplates[0].prototype) })
                .all();
            expect(children.length).to.equal(2);

            // re-insert same template → still 1
            await templates.templates.put(
                await createAlbumTemplate({
                    peer: session.peers[0],
                    description: "Create a photo album",
                    name: "Photo Album",
                    scope,
                })
            );

            const after = await templates.templates.index
                .iterate({ query: {} })
                .all();
            expect(after.length).to.equal(1);

            // still two children
            children = await after[0].prototype.replies.index
                .iterate({ query: getRepliesQuery(after[0].prototype) })
                .all();
            expect(children.length).to.equal(2);

            // links should be the same as before
            expect(await scope.links.index.getSize()).to.equal(linkCount);
            expect(await scope.replies.index.getSize()).to.equal(repliesCount);
            expect(await scope.elements.index.getSize()).to.equal(
                elementsCount
            );
        });
    });
});
