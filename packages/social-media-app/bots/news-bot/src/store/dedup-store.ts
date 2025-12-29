import { field, fixedArray, vec, variant } from "@dao-xyz/borsh";
import { Documents, id, toId } from "@peerbit/document";
import { Program } from "@peerbit/program";
import { PublicSignKey, sha256Sync } from "@peerbit/crypto";
import { concat } from "uint8arrays";

type Args = {
    replicate?: boolean;
};

const encode = (value: string) => new TextEncoder().encode(value);

function stableId(prefix: string, value: string): Uint8Array {
    return sha256Sync(concat([encode(prefix), encode(value)]));
}

@variant(0)
export class PostedEvent {
    @id({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: "string" })
    eventUri: string;

    @field({ type: fixedArray("u8", 32) })
    postCanvasId: Uint8Array;

    @field({ type: vec("string") })
    articleKeys: string[];

    @field({ type: "string" })
    createdAt: string;

    constructor(properties: {
        eventUri: string;
        postCanvasId: Uint8Array;
        articleKeys: string[];
        createdAt?: string;
    }) {
        this.id = stableId("eventUri:", properties.eventUri);
        this.eventUri = properties.eventUri;
        this.postCanvasId = properties.postCanvasId;
        this.articleKeys = properties.articleKeys;
        this.createdAt = properties.createdAt ?? new Date().toISOString();
    }
}

@variant(0)
export class PostedEventIndexed {
    @id({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: "string" })
    eventUri: string;

    @field({ type: fixedArray("u8", 32) })
    postCanvasId: Uint8Array;

    @field({ type: "string" })
    createdAt: string;

    constructor(post: PostedEvent) {
        this.id = post.id;
        this.eventUri = post.eventUri;
        this.postCanvasId = post.postCanvasId;
        this.createdAt = post.createdAt;
    }
}

@variant(0)
export class UsedArticle {
    @id({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: "string" })
    key: string;

    @field({ type: "string" })
    eventUri: string;

    @field({ type: fixedArray("u8", 32) })
    postCanvasId: Uint8Array;

    @field({ type: "string" })
    createdAt: string;

    constructor(properties: {
        key: string;
        eventUri: string;
        postCanvasId: Uint8Array;
        createdAt?: string;
    }) {
        this.id = stableId("articleKey:", properties.key);
        this.key = properties.key;
        this.eventUri = properties.eventUri;
        this.postCanvasId = properties.postCanvasId;
        this.createdAt = properties.createdAt ?? new Date().toISOString();
    }
}

@variant(0)
export class UsedArticleIndexed {
    @id({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: "string" })
    key: string;

    @field({ type: "string" })
    eventUri: string;

    constructor(article: UsedArticle) {
        this.id = article.id;
        this.key = article.key;
        this.eventUri = article.eventUri;
    }
}

@variant("dedup-store")
export class DedupStore extends Program<Args> {
    @field({ type: Documents })
    posts: Documents<PostedEvent, PostedEventIndexed>;

    @field({ type: Documents })
    usedArticles: Documents<UsedArticle, UsedArticleIndexed>;

    constructor(properties: { id: Uint8Array }) {
        super();
        const base = properties.id;
        this.posts = new Documents({
            id: sha256Sync(concat([base, encode("posts")])),
        });
        this.usedArticles = new Documents({
            id: sha256Sync(concat([base, encode("used-articles")])),
        });
    }

    static idFor(publicKey: PublicSignKey): Uint8Array {
        return sha256Sync(
            concat([encode("giga-news-dedup-store:"), publicKey.bytes])
        );
    }

    async open(args?: Args): Promise<void> {
        const replicate = args?.replicate ? { factor: 1 } : false;

        await this.posts.open({
            type: PostedEvent,
            replicate,
            canPerform: async () => true,
            keep: "self",
            canOpen: () => false,
            index: { type: PostedEventIndexed, prefetch: { strict: false } },
        });

        await this.usedArticles.open({
            type: UsedArticle,
            replicate,
            canPerform: async () => true,
            keep: "self",
            canOpen: () => false,
            index: { type: UsedArticleIndexed, prefetch: { strict: false } },
        });
    }

    async getPostByEventUri(
        eventUri: string
    ): Promise<PostedEvent | undefined> {
        const idBytes = stableId("eventUri:", eventUri);
        return this.posts.index.get(toId(idBytes), {
            local: true,
            remote: false,
        });
    }

    async isEventPosted(eventUri: string): Promise<boolean> {
        return (await this.getPostByEventUri(eventUri)) != null;
    }

    async getUsedArticle(key: string): Promise<UsedArticle | undefined> {
        const idBytes = stableId("articleKey:", key);
        return this.usedArticles.index.get(toId(idBytes), {
            local: true,
            remote: false,
        });
    }

    async isArticleUsed(key: string): Promise<boolean> {
        return (await this.getUsedArticle(key)) != null;
    }

    async recordPostedEvent(properties: {
        eventUri: string;
        postCanvasId: Uint8Array;
        articleKeys: string[];
        createdAt?: string;
    }): Promise<PostedEvent> {
        const existing = await this.getPostByEventUri(properties.eventUri);
        if (existing) return existing;

        const uniqueArticleKeys = Array.from(
            new Set(properties.articleKeys.map((k) => k.trim()).filter(Boolean))
        );

        const post = new PostedEvent({
            eventUri: properties.eventUri,
            postCanvasId: properties.postCanvasId,
            articleKeys: uniqueArticleKeys,
            createdAt: properties.createdAt,
        });

        await this.posts.put(post);

        await Promise.all(
            uniqueArticleKeys.map(async (key) => {
                const existingUsed = await this.getUsedArticle(key);
                if (existingUsed) return;
                const used = new UsedArticle({
                    key,
                    eventUri: properties.eventUri,
                    postCanvasId: properties.postCanvasId,
                    createdAt: properties.createdAt,
                });
                await this.usedArticles.put(used);
            })
        );

        return post;
    }
}
