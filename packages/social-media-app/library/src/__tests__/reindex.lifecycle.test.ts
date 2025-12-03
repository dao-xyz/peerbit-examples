import { TestSession } from "@peerbit/test-utils";
import { Canvas, IndexableCanvas } from "../content.js";
import { createRoot } from "../root.js";
import { afterEach, describe, expect, it } from "vitest";
import { delay } from "@peerbit/time";

describe("reindex lifecycle", () => {
    let session: TestSession | undefined;

    afterEach(async () => {
        if (session) {
            await session.stop();
            session = undefined;
        }
    });

    it("does not schedule reindex after restarting persisted scope", async () => {
        const fromIndexableCanvas = IndexableCanvas.from.bind(IndexableCanvas);
        let indexerCalls = 0;
        let targetId: string | undefined;
        IndexableCanvas.from = (canvas: Canvas) => {
            if (targetId && canvas.idString === targetId) {
                indexerCalls++;
            }
            return fromIndexableCanvas(canvas);
        };

        try {
            const directory = `./tmp/reindex-lifecycle-${Date.now()}`;
            session = await TestSession.connected(1, { directory });
            const peer = session.peers[0];

            const { scope, canvas: root } = await createRoot(peer, {
                persisted: true,
                sections: [],
            });

            const post = new Canvas({
                publicKey: peer.identity.publicKey,
                selfScope: scope,
            });
            targetId = post.idString;
            await post.load(peer, { args: { replicate: false } });
            await post.addTextElement("hello persistence");
            await root.upsertReply(post, { type: "link-only" });

            await scope._hierarchicalReindex!.flush();
            const runsBefore =
                scope._hierarchicalReindex!.stats?.().totalRuns ?? 0;
            expect(runsBefore).to.be.greaterThan(0);

            const rootId = root.id;
            const postId = post.id;
            const indexerCallsBefore = indexerCalls;
            expect(indexerCallsBefore).to.be.greaterThan(0); // at least one index pass happened
            expect(indexerCallsBefore).to.be.at.most(2); // transform + bounded reindex
            indexerCalls = 0;

            await session.stop(); // simulate node restart while keeping persisted data
            session = await TestSession.connected(1, { directory });
            const restarted = session.peers[0];
            const reopenedScope = await restarted.open(scope.clone(), {
                existing: "reuse",
                args: { replicate: { factor: 1 } },
            });

            const reopenedRoot = await reopenedScope.replies.index.get(rootId, {
                resolve: true,
            });
            const reopenedPost = await reopenedScope.replies.index.get(postId, {
                resolve: true,
            });
            expect(reopenedRoot?.idString).to.eq(root.idString);
            expect(reopenedPost?.idString).to.eq(post.idString);

            // Allow any deferred timers to tick and then flush to surface hidden work
            await delay(3e3);
            await reopenedScope._hierarchicalReindex!.flush();
            const afterRestartRuns =
                reopenedScope._hierarchicalReindex!.stats?.().totalRuns ?? 0;
            expect(afterRestartRuns).to.eq(0);
            expect(reopenedScope._hierarchicalReindex!.size()).to.eq(0);
            expect(indexerCalls).to.eq(0);
        } finally {
            IndexableCanvas.from = fromIndexableCanvas;
        }
    });

    it("awaited upsert indexes child and parent before resolving", async () => {
        const fromIndexableCanvas = IndexableCanvas.from.bind(IndexableCanvas);
        let fromCalls = 0;
        let targetId: string | undefined;
        IndexableCanvas.from = (canvas: Canvas) => {
            if (targetId && canvas.idString === targetId) {
                fromCalls++;
            }
            return fromIndexableCanvas(canvas);
        };

        try {
            session = await TestSession.connected(1);
            const peer = session.peers[0];
            const { scope, canvas: root } = await createRoot(peer, {
                persisted: false,
                sections: [],
            });

            const post = new Canvas({
                publicKey: peer.identity.publicKey,
                selfScope: scope,
            });
            targetId = post.idString;
            await post.load(peer, { args: { replicate: false } });
            await post.addTextElement("hello world");

            await root.upsertReply(post, { type: "link-only" });

            // The child should already be indexed when upsert resolves
            const indexed = await scope.replies.index.get(post.id, {
                resolve: true,
            });
            expect(indexed?.idString).to.eq(post.idString);

            // Give any trailing timers (e.g., element change listeners) a moment, then flush
            await delay(400);
            await scope._hierarchicalReindex!.flush();

            const stats = scope._hierarchicalReindex!.stats?.() || {
                totalRuns: 0,
                perCanvas: {},
            };
            const postRuns = stats.perCanvas[post.idString] || 0;
            const rootRuns = stats.perCanvas[root.idString] || 0;

            // Child may already be fully indexed via transform; if runs occur, keep them minimal
            expect(postRuns).to.be.at.most(1);
            expect(rootRuns).to.be.at.most(1);
            expect(postRuns + rootRuns).to.be.at.most(2);

            // IndexableCanvas.from should not blow up; allow transform + minimal reindex calls
            expect(fromCalls).to.be.at.most(3);
        } finally {
            IndexableCanvas.from = fromIndexableCanvas;
        }
    });

    it("does not reindex drafts before first upsert and bounds indexing on upsert", async () => {
        const original = IndexableCanvas.from.bind(IndexableCanvas);
        let fromCalls = 0;
        let targetId: string | undefined;
        IndexableCanvas.from = (canvas: Canvas) => {
            if (targetId && canvas.idString === targetId) {
                fromCalls++;
            }
            return original(canvas);
        };

        try {
            session = await TestSession.connected(1);
            const peer = session.peers[0];
            const { scope, canvas: root } = await createRoot(peer, {
                persisted: false,
                sections: [],
            });

            const draft = new Canvas({
                publicKey: peer.identity.publicKey,
                selfScope: scope,
            });
            targetId = draft.idString;
            await draft.load(peer, { args: { replicate: false } });
            await draft.addTextElement("pre-upsert text");

            // No indexing should happen before the draft is inserted into replies
            expect(fromCalls).to.eq(0);

            await root.upsertReply(draft, { type: "link-only" });
            await scope._hierarchicalReindex!.flush();

            // One transform (on insert) + limited reindex runs
            expect(fromCalls).to.be.at.most(3);
        } finally {
            IndexableCanvas.from = original;
        }
    });
});
