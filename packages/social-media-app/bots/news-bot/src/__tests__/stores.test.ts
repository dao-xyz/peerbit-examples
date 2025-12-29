import { TestSession } from "@peerbit/test-utils";
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "vitest";
import { randomBytes } from "@peerbit/crypto";
import { DedupStore, NewsApiStore, newsApiArticleKey } from "../store/index.js";

describe("NewsBot stores", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(1);
    });

    afterEach(async () => {
        await session.stop();
    });

    it("stores fetched events and articles", async () => {
        const peer = session.peers[0];

        const store = await peer.open(
            new NewsApiStore({
                id: NewsApiStore.idFor(peer.identity.publicKey),
            }),
            { existing: "reuse", args: { replicate: false } }
        );

        const event = {
            uri: "eng-123",
            title: "Test event",
            summary: "Something happened",
            raw: { uri: "eng-123", title: { eng: "Test event" } },
        };

        await store.upsertEvent(event);
        const storedEvent = await store.getEventByUri(event.uri);
        expect(storedEvent?.uri).to.equal(event.uri);
        expect(storedEvent?.rawJson).to.be.a("string");

        const article = {
            uri: "2025-01-abc",
            title: "Article 1",
            body: "Body",
            url: "https://example.com/a1",
            dateTime: new Date().toISOString(),
            sourceTitle: "Example",
            raw: { uri: "2025-01-abc", url: "https://example.com/a1" },
        };

        await store.upsertArticle(article, { eventUri: event.uri });
        const key = newsApiArticleKey(article);
        const storedArticle = await store.getArticleByKey(key);
        expect(storedArticle?.key).to.equal(key);
        expect(storedArticle?.eventUri).to.equal(event.uri);
        expect(storedArticle?.url).to.equal(article.url);
    });

    it("dedupes posted events and tracks used articles", async () => {
        const peer = session.peers[0];

        const dedupe = await peer.open(
            new DedupStore({ id: DedupStore.idFor(peer.identity.publicKey) }),
            { existing: "reuse", args: { replicate: false } }
        );

        const eventUri = "eng-123";
        const postCanvasId = randomBytes(32);
        const articleKeys = ["2025-01-abc", "2025-01-def"];

        const record = await dedupe.recordPostedEvent({
            eventUri,
            postCanvasId,
            articleKeys,
        });

        expect(record.eventUri).to.equal(eventUri);
        expect(record.articleKeys).to.deep.equal(articleKeys);

        expect(await dedupe.isEventPosted(eventUri)).to.equal(true);
        expect(await dedupe.isArticleUsed(articleKeys[0])).to.equal(true);

        const used = await dedupe.getUsedArticle(articleKeys[0]);
        expect(used?.eventUri).to.equal(eventUri);
    });
});
