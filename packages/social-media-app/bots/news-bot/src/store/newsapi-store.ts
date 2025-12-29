import { field, fixedArray, option, variant } from "@dao-xyz/borsh";
import { Documents, id, toId } from "@peerbit/document";
import { Program } from "@peerbit/program";
import { PublicSignKey, sha256Sync, toBase64URL } from "@peerbit/crypto";
import { concat } from "uint8arrays";
import type { NewsApiArticle, NewsApiEvent } from "../newsapi.js";

type Args = {
    replicate?: boolean;
};

const encode = (value: string) => new TextEncoder().encode(value);

function stableId(prefix: string, value: string): Uint8Array {
    return sha256Sync(concat([encode(prefix), encode(value)]));
}

@variant(0)
export class StoredEvent {
    @id({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: "string" })
    uri: string;

    @field({ type: option("string") })
    title?: string;

    @field({ type: option("string") })
    summary?: string;

    @field({ type: "string" })
    fetchedAt: string;

    @field({ type: option("string") })
    rawJson?: string;

    constructor(properties: {
        uri: string;
        title?: string;
        summary?: string;
        fetchedAt?: string;
        rawJson?: string;
    }) {
        this.id = stableId("eventUri:", properties.uri);
        this.uri = properties.uri;
        this.title = properties.title;
        this.summary = properties.summary;
        this.fetchedAt = properties.fetchedAt ?? new Date().toISOString();
        this.rawJson = properties.rawJson;
    }
}

@variant(0)
export class StoredEventIndexed {
    @id({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: "string" })
    uri: string;

    @field({ type: option("string") })
    title?: string;

    @field({ type: "string" })
    fetchedAt: string;

    constructor(event: StoredEvent) {
        this.id = event.id;
        this.uri = event.uri;
        this.title = event.title;
        this.fetchedAt = event.fetchedAt;
    }
}

@variant(0)
export class StoredArticle {
    @id({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: "string" })
    key: string;

    @field({ type: option("string") })
    uri?: string;

    @field({ type: option("string") })
    url?: string;

    @field({ type: option("string") })
    eventUri?: string;

    @field({ type: option("string") })
    title?: string;

    @field({ type: option("string") })
    body?: string;

    @field({ type: option("string") })
    dateTime?: string;

    @field({ type: option("string") })
    sourceTitle?: string;

    @field({ type: "string" })
    fetchedAt: string;

    @field({ type: option("string") })
    rawJson?: string;

    constructor(properties: {
        key: string;
        uri?: string;
        url?: string;
        eventUri?: string;
        title?: string;
        body?: string;
        dateTime?: string;
        sourceTitle?: string;
        fetchedAt?: string;
        rawJson?: string;
    }) {
        this.id = stableId("articleKey:", properties.key);
        this.key = properties.key;
        this.uri = properties.uri;
        this.url = properties.url;
        this.eventUri = properties.eventUri;
        this.title = properties.title;
        this.body = properties.body;
        this.dateTime = properties.dateTime;
        this.sourceTitle = properties.sourceTitle;
        this.fetchedAt = properties.fetchedAt ?? new Date().toISOString();
        this.rawJson = properties.rawJson;
    }
}

@variant(0)
export class StoredArticleIndexed {
    @id({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: "string" })
    key: string;

    @field({ type: option("string") })
    eventUri?: string;

    @field({ type: option("string") })
    title?: string;

    @field({ type: "string" })
    fetchedAt: string;

    constructor(article: StoredArticle) {
        this.id = article.id;
        this.key = article.key;
        this.eventUri = article.eventUri;
        this.title = article.title;
        this.fetchedAt = article.fetchedAt;
    }
}

export function newsApiArticleKey(article: NewsApiArticle): string {
    return (
        article.uri?.trim() ||
        article.url?.trim() ||
        `raw:${toBase64URL(
            stableId("articleRaw:", JSON.stringify(article.raw))
        )}`
    );
}

@variant("newsapi-store")
export class NewsApiStore extends Program<Args> {
    @field({ type: Documents })
    eventsDb: Documents<StoredEvent, StoredEventIndexed>;

    @field({ type: Documents })
    articles: Documents<StoredArticle, StoredArticleIndexed>;

    constructor(properties: { id: Uint8Array }) {
        super();
        const base = properties.id;
        this.eventsDb = new Documents({
            id: sha256Sync(concat([base, encode("events")])),
        });
        this.articles = new Documents({
            id: sha256Sync(concat([base, encode("articles")])),
        });
    }

    static idFor(publicKey: PublicSignKey): Uint8Array {
        return sha256Sync(
            concat([encode("giga-newsapi-store:"), publicKey.bytes])
        );
    }

    async open(args?: Args): Promise<void> {
        const replicate = args?.replicate ? { factor: 1 } : false;

        await this.eventsDb.open({
            type: StoredEvent,
            replicate,
            canPerform: async () => true,
            keep: "self",
            canOpen: () => false,
            index: {
                type: StoredEventIndexed,
                prefetch: { strict: false },
            },
        });

        await this.articles.open({
            type: StoredArticle,
            replicate,
            canPerform: async () => true,
            keep: "self",
            canOpen: () => false,
            index: {
                type: StoredArticleIndexed,
                prefetch: { strict: false },
            },
        });
    }

    async upsertEvent(event: NewsApiEvent): Promise<StoredEvent> {
        const stored = new StoredEvent({
            uri: event.uri,
            title: event.title,
            summary: event.summary,
            rawJson: JSON.stringify(event.raw),
        });
        await this.eventsDb.put(stored);
        return stored;
    }

    async upsertEvents(events: NewsApiEvent[]): Promise<void> {
        await Promise.all(events.map((e) => this.upsertEvent(e)));
    }

    async upsertArticle(
        article: NewsApiArticle,
        options?: { eventUri?: string }
    ): Promise<StoredArticle> {
        const key = newsApiArticleKey(article);
        const stored = new StoredArticle({
            key,
            uri: article.uri,
            url: article.url,
            eventUri: options?.eventUri,
            title: article.title,
            body: article.body,
            dateTime: article.dateTime,
            sourceTitle: article.sourceTitle,
            rawJson: JSON.stringify(article.raw),
        });
        await this.articles.put(stored);
        return stored;
    }

    async upsertArticles(
        articles: NewsApiArticle[],
        options?: { eventUri?: string }
    ): Promise<void> {
        await Promise.all(articles.map((a) => this.upsertArticle(a, options)));
    }

    async getEventByUri(eventUri: string): Promise<StoredEvent | undefined> {
        const idBytes = stableId("eventUri:", eventUri);
        return this.eventsDb.index.get(toId(idBytes), {
            local: true,
            remote: false,
        });
    }

    async getArticleByKey(key: string): Promise<StoredArticle | undefined> {
        const idBytes = stableId("articleKey:", key);
        return this.articles.index.get(toId(idBytes), {
            local: true,
            remote: false,
        });
    }
}
