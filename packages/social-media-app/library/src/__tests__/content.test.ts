import { TestSession } from "@peerbit/test-utils";
import {
    Canvas,
    Scope,
    getImmediateRepliesQuery,
    getRepliesQuery,
    getOwnedElementsQuery,
    Element,
    StaticContent,
    getTextElementsQuery,
    getImagesQuery,
    LOWEST_QUALITY,
    IndexableCanvas,
    diffCanvases,
    getReplyKindQuery,
    AddressReference,
} from "../content.js";
import { Sort, SortDirection, WithIndexedContext } from "@peerbit/document";
import { expect } from "chai";
import { delay, waitForResolved } from "@peerbit/time";
import { sha256Base64Sync, sha256Sync, toBase64 } from "@peerbit/crypto";
import { StaticImage } from "../static/image.js";
import { deserialize, serialize } from "@dao-xyz/borsh";
import { orderKeyBetween } from "../order-key.js";
import { ensurePath } from "./utils.js";
import { Layout, ViewKind } from "../link.js";
import { randomBytes } from "@peerbit/crypto";

/* ----------------------- helpers (public APIs only) ----------------------- */

async function createOpenRootScope(
    session: TestSession,
    opts?: {
        seed?: Uint8Array | number[] | Scope;
        replicate?: boolean;
        replicas?: { min?: number };
    }
) {
    const peer = session.peers[0];
    return peer.open(
        opts?.seed instanceof Scope
            ? opts.seed
            : new Scope({
                  seed: opts?.seed
                      ? new Uint8Array(opts.seed as number[])
                      : undefined,
                  publicKey: peer.identity.publicKey,
              }),
        {
            args: {
                replicate: opts?.replicate ?? true,
                replicas: opts?.replicas,
            },
        }
    );
}

async function contextOf(
    scope: Scope,
    c: Canvas | WithIndexedContext<Canvas, IndexableCanvas>
) {
    const real =
        c instanceof Canvas
            ? c
            : (c as any as WithIndexedContext<Canvas, IndexableCanvas>);
    return scope.createContext(real as Canvas);
}

/* ------------------------------ tests ------------------------------ */

describe("canvas (updated)", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(2);
    });
    afterEach(async () => {
        await session.stop();
    });

    it("can serialize deserialize", () => {
        const clazz = new Canvas({
            publicKey: session.peers[0].identity.publicKey,
            selfScope: new AddressReference({ address: "abc123" }),
            id: randomBytes(32),
        });
        const serialized = serialize(clazz);
        const deserialized = deserialize(serialized, Canvas);
        expect(deserialized.idString).to.eq(clazz.idString);
        expect(deserialized.selfScope.address).to.eq(clazz.selfScope.address);
        expect(deserialized.publicKey.equals(clazz.publicKey)).to.be.true;
        expect(deserialized.idString).to.deep.eq(clazz.idString);
    });

    it("loadCanvasFromScopes replacement: can fetch from replies", async () => {
        const rootScope = await createOpenRootScope(session);
        const [_, root] = await rootScope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: rootScope,
            })
        );

        const [a] = await ensurePath(root, ["a"]);
        const again = await rootScope.replies.index.get(a.id, {
            resolve: true,
        });
        expect(again?.idString).to.eq(a.idString);
    });

    it("multiple canvases referencing same scope opens fine", async () => {
        const scope = await createOpenRootScope(session);
        const [_, r1] = await scope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: scope,
            })
        );
        const [__, r2] = await scope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: scope,
            })
        );
        expect(r1.nearestScope.address).to.eq(scope.address);
        expect(r2.nearestScope.address).to.eq(scope.address);
    });

    it("add + delete subtree (counts via indexed methods)", async () => {
        await session.stop();
        const directory = "./tmp/add-delete/" + +new Date();
        session = await TestSession.connected(1, { directory });

        const scope = await createOpenRootScope(session);
        const [_, root] = await scope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: scope,
            })
        );

        const [a, b, c] = await ensurePath(root, ["a", "b", "c"]);

        const rootIdx = await root.getSelfIndexed();
        const aIdx = await a.getSelfIndexed();
        const bIdx = await b.getSelfIndexed();
        expect(rootIdx && aIdx && bIdx).to.exist;
        expect(aIdx!.context).to.eq("a");

        // indexing is async
        await waitForResolved(async () => {
            expect(Number(await root.countRepliesIndexedDirect())).to.eq(3);
            expect(Number(await a.countRepliesIndexedDirect())).to.eq(2);
            expect(Number(await b.countRepliesIndexedDirect())).to.eq(1);

            // immediate counts
            expect(
                Number(
                    await root.countImmediateIndexedDirect(rootIdx!.pathDepth)
                )
            ).to.eq(1);
            expect(
                Number(await a.countImmediateIndexedDirect(aIdx!.pathDepth))
            ).to.eq(1);
            expect(
                Number(await b.countImmediateIndexedDirect(bIdx!.pathDepth))
            ).to.eq(1);
        });

        // index search helpers

        await waitForResolved(async () => {
            const allUnderRoot = await scope.replies.index
                .iterate({
                    query: getRepliesQuery(root),
                    sort: new Sort({
                        key: "replies",
                        direction: SortDirection.ASC,
                    }),
                })
                .all();

            expect(allUnderRoot).to.have.length(3);
            expect(
                allUnderRoot.map((x) => Number(x.__indexed.replies))
            ).to.deep.eq([0, 1, 2]);
            expect(allUnderRoot.map((x) => x.__indexed.context)).to.deep.eq([
                "c",
                "b",
                "a",
            ]);
        });

        // delete subtree at "a"
        await scope.remove(a);

        const repliesAfter = await scope.replies.index.iterate({}).all();
        expect(repliesAfter).to.have.length(1); // only root remains after removal

        // restart and check persistence
        await session.peers[0].stop();
        session = await TestSession.connected(1, { directory });
        const reopened = await session.peers[0].open(scope.clone(), {
            existing: "reuse",
            args: { replicate: true },
        });
        const all = await reopened.replies.index.iterate({}).all();
        expect(all).to.have.length(1);
    });

    it("loadPath with limit", async () => {
        const scope = await createOpenRootScope(session);
        const [_, root] = await scope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: scope,
            })
        );
        const [a, b, c] = await ensurePath(root, ["a", "b", "c"]);
        const path = await c.loadPath({ length: 2, includeSelf: true });
        expect(path.map((x) => x.idString)).to.deep.eq([
            a.idString,
            b.idString,
            c.idString,
        ]);
    });

    it("create + query immediate & deep replies", async () => {
        const scope = await createOpenRootScope(session);
        const [_, root] = await scope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: scope,
            })
        );

        await ensurePath(root, ["a", "b", "c"]);
        await ensurePath(root, ["a", "b", "d"]);
        const [a] = await ensurePath(root, ["a"]);
        const [__, b] = await ensurePath(root, ["a", "b"]);

        // indexing is async, so we need to wait for it
        await waitForResolved(async () => {
            const deep = await scope.replies.index
                .iterate({ query: getRepliesQuery(a) })
                .all();
            expect(deep).to.have.length(3);
            const titles = await Promise.all(
                deep.map((x) => contextOf(scope, x))
            );
            expect(titles.sort()).to.deep.eq(["b", "c", "d"]);
        });

        const bIdx = await b.getSelfIndexed();
        const immed = await scope.replies.index
            .iterate({ query: getImmediateRepliesQuery(bIdx!) })
            .all();
        const immedTitles = await Promise.all(
            immed.map((x) => contextOf(scope, x))
        );
        expect(immedTitles.sort()).to.deep.eq(["c", "d"]);
    });

    it("sort immediate children by replies (desc)", async () => {
        const scope = await createOpenRootScope(session);
        const [_, root] = await scope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: scope,
            })
        );
        await ensurePath(root, ["b", "b"]);
        await ensurePath(root, ["a", "b"]);
        await ensurePath(root, ["c"]);
        await ensurePath(root, ["a", "c"]);

        const rootIdx = await root.getSelfIndexed();
        await waitForResolved(async () => {
            const sorted = await scope.replies.index.search({
                query: getImmediateRepliesQuery(rootIdx!),
                sort: new Sort({
                    key: "replies",
                    direction: SortDirection.DESC,
                }),
            });
            expect(
                await Promise.all(sorted.map((x) => contextOf(scope, x)))
            ).to.deep.eq(["a", "b", "c"]);
        });
    });

    it("index/iterate works when viewer is non-replicator (remote warmup)", async () => {
        const replicating = await createOpenRootScope(session);
        const [_, root] = await replicating.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: replicating,
            })
        );

        await ensurePath(root, ["a", "b"]);
        await ensurePath(root, ["b", "b"]);
        await ensurePath(root, ["c"]);
        await ensurePath(root, ["a", "c"]);

        const viewer = await session.peers[1].open(replicating.clone(), {
            args: { replicate: false },
        });
        await viewer.replies.log.waitForReplicators({ waitForNewPeers: true });

        const rootIdx = await root.getSelfIndexed();
        const sorted = await viewer.replies.index
            .iterate({
                query: getImmediateRepliesQuery(rootIdx!),
                sort: new Sort({
                    key: "replies",
                    direction: SortDirection.DESC,
                }),
            })
            .all();

        await waitForResolved(async () => {
            expect(
                await Promise.all(sorted.map((x) => contextOf(viewer, x)))
            ).to.deep.eq(["a", "b", "c"]);
        });
    });

    it("elements: query by ownership and type", async () => {
        const scope = await createOpenRootScope(session);
        const [_, root] = await scope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
            })
        );

        const [a] = await ensurePath(root, ["a"]);
        const [__, withImage] = await ensurePath(a, ["img"]);

        await withImage.elements.put(
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
                canvasId: withImage.id,
                location: Layout.zero(),
                publicKey: scope.node.identity.publicKey,
            })
        );

        const ownedA = await a.elements.index
            .iterate({ query: getOwnedElementsQuery(a) })
            .all();
        expect(ownedA).to.have.length(1);

        const ownedTextA = await a.elements.index
            .iterate({
                query: [...getOwnedElementsQuery(a), getTextElementsQuery()],
            })
            .all();
        expect(ownedTextA).to.have.length(1);

        const ownedImages = await withImage.elements.index
            .iterate({
                query: [...getOwnedElementsQuery(withImage), getImagesQuery()],
            })
            .all();
        expect(ownedImages).to.have.length(1);
    });

    it("diffCanvases basic", async () => {
        const scope = await createOpenRootScope(session);
        const [_, root] = await scope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: scope,
            })
        );

        const [a] = await ensurePath(root, ["a"]);
        const aClone = deserialize(serialize(a), Canvas);
        const same = await diffCanvases(
            { canvas: a, scope },
            { canvas: aClone, scope }
        );
        expect(same).to.be.false;

        const [__, b] = await ensurePath(root, ["a", "b"]);
        const diff = await diffCanvases(
            { canvas: a, scope },
            { canvas: b, scope }
        );
        expect(diff).to.be.true;
    });

    it("removeAllReplies removes subtree", async () => {
        const scope = await createOpenRootScope(session);
        const [_, root] = await scope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: scope,
            })
        );

        const [a] = await ensurePath(root, ["a", "b"]);
        await a.removeAllReplies();

        await waitForResolved(async () => {
            const deepUnderRoot = await scope.replies.index
                .iterate({ query: getRepliesQuery(root) })
                .all();
            expect(deepUnderRoot).to.have.length(1); // only "a" remains
            const rootIdx = await root.getSelfIndexed();

            const immedUnderRoot = await scope.replies.index
                .iterate({ query: getImmediateRepliesQuery(rootIdx!) })
                .all();
            expect(immedUnderRoot).to.have.length(1);
        });
    });

    it("cross-scope: create in temp scope, then migrate+link under root scope", async () => {
        const rootScope = await createOpenRootScope(session);

        // Create a top-level parent in rootScope
        const [_, root] = await rootScope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: rootScope,
            })
        );

        // Temp/private scope
        const tempScope = await createOpenRootScope(session);

        // Draft lives in temp, add content there
        const draft = new Canvas({
            publicKey: session.peers[0].identity.publicKey,
            selfScope: tempScope,
        });
        await tempScope.getOrCreateReply(undefined, draft);
        await draft.addTextElement("hello");

        // Publish: sync (same id), migrate home → rootScope, and link under `root`
        const [createdNew, moved] = await root.upsertReply(draft, {
            type: "sync",
            targetScope: rootScope,
            updateHome: "set", // migrate the node's home to rootScope
            // visibility defaults to "both"
        });

        expect(createdNew).to.be.true;
        expect(sha256Base64Sync(moved.id)).to.eq(sha256Base64Sync(draft.id)); // id preserved
        expect(moved.selfScope.address).to.eq(rootScope.address); // home updated

        // Ensure indexes have flushed/settled in root
        await rootScope.reIndexDebouncer.flush();

        // Node should exist in rootScope.replies
        await waitForResolved(async () => {
            const maybe = await rootScope.replies.index.get(draft.id, {
                resolve: false,
                local: true,
                remote: { strategy: "fallback", timeout: 3_000 },
            });
            expect(!!maybe).to.be.true;
        });

        // Content should now be readable from rootScope (new home)
        expect(await moved.getText({ scope: rootScope })).to.eq("hello");

        // And content should be cleaned up from the old home (tempScope)
        const oldRows = await tempScope.elements.index
            .iterate(
                { query: getOwnedElementsQuery(moved) },
                { resolve: false }
            )
            .all();
        expect(oldRows.length).to.eq(0);

        // Old replies row should also be gone in tempScope
        const tempRow = await tempScope.replies.index.get(draft.id, {
            resolve: false,
            local: true,
            remote: { strategy: "fallback", timeout: 3_000 },
        });
        expect(tempRow).to.be.undefined;

        // Optional: verify link exists under `root` (child present)
        const kids = await root.getChildren();
        expect(kids.map((k) => k.idString)).to.include(moved.idString);
    });

    it("reply counting: indexed vs BFS (immediate=false) agree", async () => {
        const scope = await createOpenRootScope(session);
        const [_, root] = await scope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: scope,
            })
        );
        const [a, b, c] = await ensurePath(root, ["a", "b", "c"]);
        const [__, d] = await ensurePath(root, ["a", "d"]);

        // deep totals should match
        await waitForResolved(async () => {
            const idxA = await a.countRepliesIndexedDirect();
            const bfsA = await a.countRepliesBFS({ immediate: false });
            expect(Number(idxA)).to.eq(Number(bfsA));

            const idxRoot = await root.countRepliesIndexedDirect();
            const bfsRoot = await root.countRepliesBFS({ immediate: false });
            expect(Number(idxRoot)).to.eq(Number(bfsRoot));
        });
    });
});

describe("privacy / scope mixing", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(2);
    });
    afterEach(async () => {
        await session.stop();
    });

    it("private-only child is discoverable only if private scope is passed", async () => {
        const rootScope = await createOpenRootScope(session);
        const privateScope = await createOpenRootScope(session);

        const [_, root] = await rootScope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: rootScope,
            })
        );

        // child that only exists in privateScope (no mirror in rootScope)
        const privateChild = new Canvas({
            publicKey: session.peers[0].identity.publicKey,
            selfScope: privateScope,
        });
        await privateScope.getOrCreateReply(root, privateChild, {
            visibility: "child",
        });

        // only discoverable when privateScope is included
        const foundPublicOnly = await root.getChildren({ scopes: [rootScope] });
        expect(foundPublicOnly).to.have.length(0);

        const foundWithPrivate = await root.getChildren({
            scopes: [rootScope, privateScope],
        });
        expect(foundWithPrivate.map((c) => c.idString)).to.include(
            privateChild.idString
        );
    });

    it("both public + private mirror means child is discoverable everywhere", async () => {
        const rootScope = await createOpenRootScope(session);
        const privateScope = await createOpenRootScope(session);

        const [_, root] = await rootScope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: rootScope,
            })
        );

        // child has canonical home in privateScope; we link-only with a mirror in rootScope
        const child = new Canvas({
            publicKey: session.peers[0].identity.publicKey,
            selfScope: privateScope,
        });

        await root.upsertReply(child, {
            type: "link-only",
            visibility: "both",
        });

        await waitForResolved(async () => {
            const foundPublic = await root.getChildren({ scopes: [rootScope] });
            expect(foundPublic.map((c) => c.idString)).to.include(
                child.idString
            );

            const foundPrivate = await root.getChildren({
                scopes: [privateScope],
            });
            expect(foundPrivate.map((c) => c.idString)).to.include(
                child.idString
            );
        });
    });

    it("remove cleans up canonical + mirrors", async () => {
        const rootScope = await createOpenRootScope(session);
        const privateScope = await createOpenRootScope(session);

        const [_, root] = await rootScope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: rootScope,
            })
        );

        const privateChild = new Canvas({
            publicKey: session.peers[0].identity.publicKey,
            selfScope: privateScope,
        });

        // canonical in private, mirror in public
        await root.upsertReply(privateChild, {
            type: "link-only",
            visibility: "both",
        });

        await waitForResolved(async () => {
            const before = await root.getChildren({
                scopes: [rootScope, privateScope],
            });
            expect(before.map((c) => c.idString)).to.include(
                privateChild.idString
            );
        });

        expect(
            await rootScope.replies.index.get(privateChild.id, {
                resolve: false,
                local: true,
                remote: false,
            })
        ).to.be.undefined;
        expect(
            await privateScope.replies.index.get(privateChild.id, {
                resolve: false,
                local: true,
                remote: false,
            })
        ).to.not.be.undefined;

        // remove across both scopes (canonical + mirrors)
        await rootScope.remove(privateChild);

        await waitForResolved(async () => {
            const after = await root.getChildren({
                scopes: [rootScope, privateScope],
            });
            expect(after.map((c) => c.idString)).to.not.include(
                privateChild.idString
            );
        });
    });

    it("can remove concurrently ", async () => {
        const rootScope = await createOpenRootScope(session);
        const privateScope = await createOpenRootScope(session);

        const [_, root] = await rootScope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: rootScope,
            })
        );
        const privateChild = new Canvas({
            publicKey: session.peers[0].identity.publicKey,
            selfScope: privateScope,
        });

        const [created1, c1] = await root.upsertReply(privateChild, {
            type: "sync",
            updateHome: "set",
            visibility: "both",
        });

        const privateChild2 = new Canvas({
            publicKey: session.peers[0].identity.publicKey,
            selfScope: privateScope,
        });

        const [created2, c2] = await root.upsertReply(privateChild2, {
            type: "sync",
            updateHome: "set",
            visibility: "both",
        });

        expect(created1).to.be.true;
        expect(created2).to.be.true;

        const before = await root.getChildren({
            scopes: [rootScope, privateScope],
        });

        expect(before.map((c) => c.idString)).to.include(privateChild.idString);
        expect(before.map((c) => c.idString)).to.include(
            privateChild2.idString
        );

        await Promise.all([privateScope.remove(c1), privateScope.remove(c2)]);

        await waitForResolved(async () => {
            const after = await root.getChildren({
                scopes: [rootScope, privateScope],
            });
            expect(after.map((c) => c.idString)).to.not.include(
                privateChild.idString
            );
            expect(after.map((c) => c.idString)).to.not.include(
                privateChild2.idString
            );
        });
    });

    it("counts respect scopes (indexed vs BFS)", async () => {
        const rootScope = await createOpenRootScope(session);
        const privateScope = await createOpenRootScope(session);

        const [_, root] = await rootScope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: rootScope,
            })
        );

        const privateChild = new Canvas({
            publicKey: session.peers[0].identity.publicKey,
            selfScope: privateScope,
        });
        await privateScope.getOrCreateReply(root, privateChild, {
            visibility: "child",
        });

        // wait for indexes to catch up
        await waitForResolved(async () => {
            const countPublic = await root.countRepliesBFS({
                scopes: [rootScope],
            });
            expect(Number(countPublic)).to.eq(0);

            const countWithPrivate = await root.countRepliesBFS({
                scopes: [rootScope, privateScope],
            });
            expect(Number(countWithPrivate)).to.eq(1);
        });
    });

    it("persistence with private scopes", async () => {
        await session.stop();
        const directory = "./tmp/private-persist/" + +new Date();
        session = await TestSession.connected(1, { directory });

        const rootScope = await createOpenRootScope(session);
        const privateScope = await createOpenRootScope(session);

        const [_, root] = await rootScope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: rootScope,
            })
        );

        const privateChild = new Canvas({
            publicKey: session.peers[0].identity.publicKey,
            selfScope: privateScope,
        });
        await privateScope.getOrCreateReply(root, privateChild);

        // restart
        await session.peers[0].stop();
        session = await TestSession.connected(1, { directory });
        const reopenedRoot = await session.peers[0].open(rootScope.clone(), {
            existing: "reuse",
        });
        const reopenedPrivate = await session.peers[0].open(
            privateScope.clone(),
            { existing: "reuse" }
        );
        await root.load(session.peers[0]);

        const children = await root.getChildren({
            scopes: [reopenedRoot, reopenedPrivate],
        });
        expect(children.map((c) => c.idString)).to.include(
            privateChild.idString
        );
    });

    it("replication boundaries: peer without private scope cannot see private children", async () => {
        const rootScope = await createOpenRootScope(session);
        const privateScope = await createOpenRootScope(session);

        const [_, root] = await rootScope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: rootScope,
            })
        );

        const privateChild = new Canvas({
            publicKey: session.peers[0].identity.publicKey,
            selfScope: privateScope,
        });
        await privateScope.getOrCreateReply(root, privateChild, {
            visibility: "child",
        });

        // peer 1 only opens rootScope
        const peer1Root = await session.peers[1].open(rootScope.clone(), {
            args: { replicate: true },
        });

        const childrenPeer1 = await root.getChildren({ scopes: [peer1Root] });
        expect(childrenPeer1).to.have.length(0);

        // peer 1 opens privateScope too
        const peer1Private = await session.peers[1].open(privateScope.clone(), {
            args: { replicate: true },
        });
        const childrenPeer1WithPrivate = await root.getChildren({
            scopes: [peer1Root, peer1Private],
        });
        expect(childrenPeer1WithPrivate.map((c) => c.idString)).to.include(
            privateChild.idString
        );
    });

    it("nested draft under a public reply migrates to public and is visible with content", async () => {
        const rootScope = await createOpenRootScope(session); // public scope
        const privateScope = await createOpenRootScope(session); // private scope

        // root in public scope
        const [_, root] = await rootScope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: rootScope,
            })
        );

        // public reply 1 under root (also in public)
        const [__, publicReply1] = await rootScope.getOrCreateReply(
            root,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: rootScope,
            })
        );

        // draft1 in PRIVATE scope as a reply to publicReply1
        const draft1 = new Canvas({
            publicKey: session.peers[0].identity.publicKey,
            selfScope: privateScope,
        });
        await privateScope.getOrCreateReply(publicReply1, draft1);
        await draft1.addTextElement("hello-from-draft-1");

        // "Publish": convert/migrate draft1 to PUBLIC and keep it as a reply to publicReply1
        // Expectation: same id, selfScope becomes rootScope, content readable from rootScope
        await publicReply1.upsertReply(draft1, {
            type: "sync",
            targetScope: rootScope,
            updateHome: "set",
            visibility: "both",
        });

        // Let indexes settle in public
        await rootScope.reIndexDebouncer.flush();

        // It should appear as a child of publicReply1 from the PUBLIC scope
        await waitForResolved(async () => {
            const kidsPublic = await publicReply1.getChildren({
                scopes: [rootScope],
            });
            expect(kidsPublic.map((c) => c.idString)).to.include(
                draft1.idString
            );
        });

        // Its content should be directly readable from PUBLIC scope
        await waitForResolved(async () => {
            const textFromPublic = await draft1.getText({ scope: rootScope });
            expect(textFromPublic).to.eq("hello-from-draft-1"); // <-- currently fails; will pass after patch
        });

        // Optional: ensure elements are indexed in PUBLIC scope (and no longer present in PRIVATE)
        await waitForResolved(async () => {
            // public has elements
            const pubElems = await rootScope.elements.index
                .iterate({ query: getOwnedElementsQuery(draft1) })
                .all();
            expect(pubElems.length).to.be.greaterThan(0);

            // private no longer holds the rows for this draft
            const privElems = await privateScope.elements.index
                .iterate(
                    { query: getOwnedElementsQuery(draft1) },
                    { resolve: false }
                )
                .all();
            expect(privElems.length).to.eq(0);
        });
    });
});

describe("canvas (replies + ordering)", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(2);
    });
    afterEach(async () => {
        await session.stop();
    });

    describe("ordering / view links", () => {
        it("orders via ViewKind.orderKey and supports move/insert", async () => {
            const scope = await createOpenRootScope(session);
            const [_, root] = await scope.getOrCreateReply(
                undefined,
                new Canvas({
                    publicKey: session.peers[0].identity.publicKey,
                    selfScope: scope,
                })
            );

            const [a] = await ensurePath(root, ["a"]);
            const [b] = await ensurePath(root, ["b"]);
            const [c] = await ensurePath(root, ["c"]);
            const [d] = await ensurePath(root, ["d"]);

            await waitForResolved(async () => {
                let ordered0 = await root.getOrderedChildren();
                expect(
                    await Promise.all(
                        ordered0.map(async (x) => await scope.createContext(x))
                    )
                ).to.have.members(["a", "b", "c", "d"]);
            });

            const kB = orderKeyBetween(undefined, undefined);
            await root.upsertViewPlacement(b, kB);

            const kD = orderKeyBetween(kB, undefined);
            await root.upsertViewPlacement(d, kD);

            const kA = orderKeyBetween(kB, kD);
            await root.upsertViewPlacement(a, kA);

            await waitForResolved(async () => {
                let ordered1 = await root.getOrderedChildren();
                expect(
                    await Promise.all(
                        ordered1.map((x) => scope.createContext(x))
                    )
                ).to.deep.eq(["b", "a", "d", "c"]);
            });

            const nkC = await root.moveChildTo(c, 0);
            expect(nkC).to.be.a("string");

            await waitForResolved(async () => {
                let ordered2 = await root.getOrderedChildren();
                expect(
                    await Promise.all(
                        ordered2.map((x) => scope.createContext(x))
                    )
                ).to.deep.eq(["c", "b", "a", "d"]);
            });

            const keyB = await root.getChildOrderKey(b.id);
            const keyA2 = await root.getChildOrderKey(a.id);
            const keyBetween = orderKeyBetween(keyB!, keyA2!);

            const [x] = await ensurePath(root, ["x"]);
            await root.upsertViewPlacement(x, keyBetween);

            await waitForResolved(async () => {
                let ordered3 = await root.getOrderedChildren();
                expect(
                    await Promise.all(
                        ordered3.map((x) => scope.createContext(x))
                    )
                ).to.deep.eq(["c", "b", "x", "a", "d"]);
            });

            /// some indexing stuff
            // fetch all canvases that have a view placement
            await waitForResolved(async () => {
                const allCanvases = await scope.replies.index
                    .iterate({
                        query: [
                            ...getRepliesQuery(root),
                            getReplyKindQuery(ViewKind),
                        ],
                        sort: new Sort({
                            key: "replies",
                            direction: SortDirection.ASC,
                        }),
                    })
                    .all();

                expect(allCanvases.map((x) => x.idString)).to.have.members([
                    c.idString,
                    b.idString,
                    x.idString,
                    a.idString,
                    d.idString,
                ]);
            });
        });

        it("removeViewPlacement keeps semantic reply", async () => {
            const scope = await createOpenRootScope(session);
            const [_, root] = await scope.getOrCreateReply(
                undefined,
                new Canvas({
                    publicKey: session.peers[0].identity.publicKey,
                    selfScope: scope,
                })
            );

            const [a] = await ensurePath(root, ["a"]);
            await root.upsertViewPlacement(
                a,
                orderKeyBetween(undefined, undefined)
            );

            let ordered = await root.getOrderedChildren();
            expect(
                await Promise.all(ordered.map((x) => scope.createContext(x)))
            ).to.deep.eq(["a"]);

            await root.removeViewPlacement(a.id);

            await waitForResolved(async () => {
                const rootIdx = await root.getSelfIndexed();
                const immed = await scope.replies.index
                    .iterate({ query: getImmediateRepliesQuery(rootIdx!) })
                    .all();
                expect(
                    await Promise.all(immed.map((x) => scope.createContext(x)))
                ).to.deep.eq(["a"]);

                ordered = await root.getOrderedChildren();
                expect(
                    await Promise.all(
                        ordered.map((x) => scope.createContext(x))
                    )
                ).to.deep.eq(["a"]);
            });
        });

        it("upsertViewPlacement is added to right scope", async () => {
            const scope = await createOpenRootScope(session);
            const innerScope = await createOpenRootScope(session);

            const [_, root] = await scope.getOrCreateReply(
                undefined,
                new Canvas({
                    publicKey: session.peers[0].identity.publicKey,
                    selfScope: innerScope,
                })
            );
            const [a] = await ensurePath(root, ["a"]);
            await root.upsertViewPlacement(
                a,
                orderKeyBetween(undefined, undefined)
            );

            expect(a.selfScope!.address).to.eq(innerScope.address);
            expect(
                await scope.replies.index.get(a.id, {
                    resolve: false,
                    local: true,
                })
            ).to.be.undefined;
            expect(
                await innerScope.replies.index.get(a.id, {
                    resolve: false,
                    local: true,
                })
            ).to.not.be.undefined;
        });
    });

    it("reply counting immediate vs deep (indexed APIs)", async () => {
        const scope = await createOpenRootScope(session);
        const [_, root] = await scope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: scope,
            })
        );

        const [a, b, c] = await ensurePath(root, ["a", "b", "c"]);
        const [__, d] = await ensurePath(root, ["a", "d"]);

        const rootIdx = await root.getSelfIndexed();
        const aIdx = await a.getSelfIndexed();
        expect(rootIdx && aIdx).to.exist;

        await waitForResolved(async () => {
            // deep
            expect(Number(await root.countRepliesIndexedDirect())).to.eq(4);
            expect(Number(await a.countRepliesIndexedDirect())).to.eq(3);

            // immediate
            expect(
                Number(
                    await root.countImmediateIndexedDirect(rootIdx!.pathDepth)
                )
            ).to.eq(1);
            expect(
                Number(await a.countImmediateIndexedDirect(aIdx!.pathDepth))
            ).to.eq(2);
        });
    });
});
