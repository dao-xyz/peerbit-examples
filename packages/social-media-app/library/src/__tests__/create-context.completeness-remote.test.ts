import { expect } from "chai";
import { TestSession } from "@peerbit/test-utils";
import {
    Canvas,
    Element,
    IndexableCanvas,
    Scope,
    StaticContent,
    LOWEST_QUALITY,
} from "../content.js";
import { StaticMarkdownText } from "../static/text.js";
import { sha256Sync } from "@peerbit/crypto";
import { Layout } from "../link.js";
import { describe, it, beforeEach, afterEach } from "vitest";

describe("createContext completeness with remote fallback", () => {
    let session: TestSession;
    beforeEach(async () => {
        session = await TestSession.connected(2);
    });
    afterEach(async () => {
        await session.stop();
    });

    it("uses remote fallback to satisfy expected element count when requireComplete is true", async () => {
        const client = session.peers[0]; // non-replicator
        const replicator = session.peers[1];

        // Open destination scope on the replicator with replication enabled
        const dest = await replicator.open(
            new Scope({ publicKey: replicator.identity.publicKey }),
            { args: { replicate: true } }
        );

        // Create a canvas and add two text elements in the replicator's scope (canonical home)
        const draft = new Canvas({
            publicKey: replicator.identity.publicKey,
            selfScope: dest,
        });
        await dest.replies.put(draft);

        const e1 = new Element({
            id: crypto.getRandomValues(new Uint8Array(32)),
            publicKey: replicator.identity.publicKey,
            content: new StaticContent({
                content: new StaticMarkdownText({ text: "Hello" }),
                quality: LOWEST_QUALITY,
                contentId: sha256Sync(new TextEncoder().encode("Hello")),
            }),
            location: new Layout({ x: 0, y: 0, w: 1, h: 1 }),
            canvasId: draft.id,
        });
        const e2 = new Element({
            id: crypto.getRandomValues(new Uint8Array(32)),
            publicKey: replicator.identity.publicKey,
            content: new StaticContent({
                content: new StaticMarkdownText({ text: "World" }),
                quality: LOWEST_QUALITY,
                contentId: sha256Sync(new TextEncoder().encode("World")),
            }),
            location: new Layout({ x: 0, y: 1, w: 1, h: 1 }),
            canvasId: draft.id,
        });
        await dest.elements.put(e1);
        await dest.elements.put(e2);

        // Build an index row on the replicator and keep the Canvas handle for remote fetch
        await dest.openWithSameSettings(draft);
        const idx = await IndexableCanvas.from(draft);
        expect(Number(idx.elements)).to.eq(2);

        // Client opens the same scope address without replication (so local has 0 elements)
        const destFromClient = await client.open<Scope>(dest.address, {
            existing: "reuse",
            args: { replicate: false },
        });
        // Warm up: discover replicators so remote fallback can query them
        await destFromClient.elements.log.waitForReplicators({
            waitForNewPeers: true,
        });

        // Sanity: local-only context should be empty (no local elements)
        const localOnly = await destFromClient.createContext(draft, {
            localOnly: true,
        });
        expect(localOnly).to.eq("");

        // Now require completeness; allow remote fallback with a bounded timeout
        const ctx = await destFromClient.createContext(draft, {
            timeoutMs: 3000,
        });
        const lines = ctx.split("\n").filter(Boolean).sort();
        expect(lines).to.deep.equal(["Hello", "World"].sort());
    });
});
