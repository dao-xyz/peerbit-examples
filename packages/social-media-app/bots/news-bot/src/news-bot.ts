import { variant } from "@dao-xyz/borsh";
import { Program } from "@peerbit/program";
import {
    BotRunner,
    type BotJob,
    type BotJobContext,
    resolveBotTarget,
    parseBooleanArg,
    parseIntervalMs,
    parseNumberArg,
    readJsonFile,
    writeJsonFile,
} from "@giga-app/bot-kit";
import { queryChatGPT } from "@giga-app/llm";
import {
    Canvas,
    Element,
    Layout,
    LOWEST_QUALITY,
    HIGH_QUALITY,
    MEDIUM_QUALITY,
    ReplyKind,
    StaticContent,
    StaticImage,
    StaticMarkdownText,
    getOwnedElementsQuery,
} from "@giga-app/interface";
import { sha256Sync, toBase64URL } from "@peerbit/crypto";
import {
    fetchArticles,
    fetchEventStream,
    type NewsApiArticle,
} from "./newsapi.js";
import { DedupStore, NewsApiStore, newsApiArticleKey } from "./store/index.js";
import {
    DEFAULT_IMAGE_TIMEOUT_MS,
    DEFAULT_MAX_IMAGE_BYTES,
    findLeadImage,
    gigaImageUrlFromContentId,
    sha256ContentId,
} from "./images.js";

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a === b) return true;
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

async function waitForScopeReplicators(options: {
    scope: any;
    timeoutMs: number;
}): Promise<void> {
    const timeout = Math.max(1_000, options.timeoutMs);
    const wait = (log: any) =>
        log?.waitForReplicators?.({
            waitForNewPeers: true,
            timeout,
        });

    await Promise.all([
        wait(options.scope?.elements?.log),
        wait(options.scope?.replies?.log),
        wait(options.scope?.links?.log),
    ]);
}

async function resolveRemoteQueryPeers(log: any): Promise<string[]> {
    const peers: string[] = [];
    const seen = new Set<string>();
    const selfHash: string | undefined =
        typeof log?.node?.identity?.publicKey?.hashcode === "function"
            ? log.node.identity.publicKey.hashcode()
            : undefined;
    const selfPeerId: string | undefined =
        typeof log?.node?.peerId?.toString === "function"
            ? log.node.peerId.toString()
            : undefined;

    const add = (value: any) => {
        const key =
            typeof value?.hashcode === "function"
                ? value.hashcode()
                : typeof value === "string"
                  ? value
                  : typeof value?.toString === "function"
                    ? value.toString()
                    : String(value);
        if (!key) return;
        if (selfHash && key === selfHash) return;
        if (selfPeerId && key === selfPeerId) return;
        if (seen.has(key)) return;
        seen.add(key);
        peers.push(key);
    };

    try {
        const cover = await log?.getCover?.(
            { args: undefined },
            { eager: true, reachableOnly: false }
        );
        if (Array.isArray(cover)) cover.forEach(add);
    } catch {}

    try {
        const topic = log?.rpc?.topic;
        const subs = topic
            ? await log?.node?.services?.pubsub?.getSubscribers?.(topic)
            : [];
        if (Array.isArray(subs)) subs.forEach(add);
    } catch {}

    return peers;
}

async function verifyRemotePost(options: {
    scope: any;
    parentCanvasId: Uint8Array;
    postCanvasId: Uint8Array;
    expectedMinElements: number;
    timeoutMs: number;
}): Promise<
    | { ok: true; attempts: number; elementsFound: number }
    | { ok: false; attempts: number; error: string }
> {
    const deadline = Date.now() + Math.max(1_000, options.timeoutMs);
    let attempts = 0;
    let lastError = "unknown error";
    let remoteRepliesPeers: string[] = [];
    let remoteElementsPeers: string[] = [];

    while (Date.now() < deadline) {
        attempts++;
        const remaining = deadline - Date.now();
        const perAttemptTimeout = Math.max(500, Math.min(5_000, remaining));

        try {
            if (!remoteRepliesPeers.length) {
                remoteRepliesPeers = await resolveRemoteQueryPeers(
                    options.scope?.replies?.log
                );
            }
            if (!remoteElementsPeers.length) {
                remoteElementsPeers = await resolveRemoteQueryPeers(
                    options.scope?.elements?.log
                );
            }

            // Ensure the post is present on remote replicators and indexed as a child of the parent.
            if (!remoteRepliesPeers.length) {
                throw new Error(
                    "No remote peers available for replies log (is the node bootstrapped?)"
                );
            }
            const indexed = await options.scope!.replies!.index!.get(
                options.postCanvasId,
                {
                    resolve: false,
                    local: false,
                    remote: {
                        from: remoteRepliesPeers,
                        reach: { eager: true },
                        strategy: "fallback",
                        timeout: perAttemptTimeout,
                    },
                }
            );
            if (!indexed) {
                throw new Error(
                    `Post not found on remote replies index (queried ${remoteRepliesPeers.length} peer(s))`
                );
            }

            const indexedAny = indexed as any;
            const path: Uint8Array[] = Array.isArray(indexedAny.path)
                ? (indexedAny.path as Uint8Array[])
                : Array.isArray(indexedAny.__indexed?.path)
                  ? (indexedAny.__indexed.path as Uint8Array[])
                  : [];
            const hasParentInPath = path.some((p) =>
                bytesEqual(p, options.parentCanvasId)
            );
            if (!hasParentInPath) {
                throw new Error("Post not yet indexed under parent path");
            }

            if (!remoteElementsPeers.length) {
                throw new Error(
                    "No remote peers available for elements log (is the node bootstrapped?)"
                );
            }
            const elements = await options.scope?.elements?.index
                ?.iterate(
                    {
                        query: getOwnedElementsQuery({
                            id: options.postCanvasId,
                        }),
                    },
                    {
                        resolve: false,
                        local: false,
                        remote: {
                            from: remoteElementsPeers,
                            reach: { eager: true },
                            strategy: "fallback",
                            timeout: perAttemptTimeout,
                        },
                    }
                )
                .all();

            const count = Array.isArray(elements) ? elements.length : 0;
            if (count < Math.max(1, options.expectedMinElements)) {
                throw new Error(
                    `Too few elements on remote (${count} < ${options.expectedMinElements})`
                );
            }

            return { ok: true, attempts, elementsFound: count };
        } catch (e) {
            lastError =
                e instanceof Error
                    ? e.message
                    : typeof e === "string"
                      ? e
                      : (() => {
                            try {
                                return JSON.stringify(e);
                            } catch {
                                return String(e);
                            }
                        })();
        }

        await new Promise((r) => setTimeout(r, 250));
    }

    return { ok: false, attempts, error: lastError };
}

export type NewsBotRunSummaryEvent = {
    eventUri: string;
    title?: string;
    articlesFetched?: number;
    articlesUsed?: number;
    leadImage?: {
        url: string;
        mimeType: string;
        bytes: number;
        width: number;
        height: number;
        ref: string;
    };
    posted: boolean;
    // base64url of the 32-byte `Canvas.id` (matches --parentCanvasId CLI convention)
    postCanvasId?: string;
    remote?: {
        ok: boolean;
        attempts: number;
        durationMs: number;
        elementsFound?: number;
        error?: string;
    };
    error?: string;
};

export type NewsBotRunSummary = {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    dryRun: boolean;
    stream: {
        maxEventCount: number;
        updatesAfterMinsAgo?: number;
        updatesAfterTm?: string;
    };
    target: {
        scopeAddress: string;
        parentCanvasId: string;
    };
    filters: {
        keyword?: string | string[];
        lang?: string | string[];
        categoryUri?: string;
        locationUri?: string;
    };
    eventsFetched: number;
    eventsPending: number;
    eventsSelected: number;
    eventsProcessed: NewsBotRunSummaryEvent[];
};

type Args = {
    replicate?: boolean | string;
    scopeAddress?: string;
    parentCanvasId?: string;
    intervalMs?: number | string;
    intervalMinutes?: number | string;
    runOnStart?: boolean | string;
    runOnce?: boolean | string;
    dryRun?: boolean | string;

    newsApiKey?: string;
    categoryUri?: string;
    locationUri?: string;
    keyword?: string | string[];
    lang?: string | string[];

    maxEventsPerRun?: number | string;
    maxArticlesPerEvent?: number | string;
    statePath?: string;

    openaiApiKey?: string;
    openaiModel?: string;

    prefix?: string;

    recentActivityEventsMaxEventCount?: number | string;
    recentActivityEventsUpdatesAfterMinsAgo?: number | string;
    recentActivityEventsUpdatesAfterTm?: string;

    includeImages?: boolean | string;
    maxImageBytes?: number | string;
    maxImageCandidates?: number | string;
    imageTimeoutMs?: number | string;

    generateFeedSummary?: boolean | string;
};

type NewsBotState = {
    postedEventUris: string[];
    updatedAt?: string;
};

const defaultState = (): NewsBotState => ({ postedEventUris: [] });

function truncateText(text: string, maxChars: number) {
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

function dedupeArticles(articles: NewsApiArticle[]): NewsApiArticle[] {
    const seen = new Set<string>();
    const out: NewsApiArticle[] = [];
    for (const a of articles) {
        const key = a.url || a.uri || JSON.stringify(a.raw);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(a);
    }
    return out;
}

function formatReferences(articles: NewsApiArticle[]): string {
    if (!articles.length) return "_No references returned by NewsAPI.ai._";

    return articles
        .map((a, i) => {
            const title = a.title?.trim() || a.url || a.uri || "Source";
            const url = a.url?.trim();
            const source = a.sourceTitle?.trim();
            const date = a.dateTime?.trim();

            const meta = [source, date].filter(Boolean).join(" • ");
            const label = url ? `[${title}](${url})` : title;
            return `${i + 1}. ${label}${meta ? ` — ${meta}` : ""}`;
        })
        .join("\n");
}

async function buildMasterArticle(options: {
    eventTitle: string;
    eventSummary?: string;
    articles: NewsApiArticle[];
    openaiApiKey: string;
    openaiModel?: string;
}): Promise<string> {
    const summary = options.eventSummary?.trim();
    const sources = options.articles
        .map((a, i) => {
            const title = a.title?.trim() || a.url || a.uri || "Source";
            const url = a.url?.trim() || "";
            const source = a.sourceTitle?.trim() || "";
            const date = a.dateTime?.trim() || "";
            const excerpt = a.body?.trim()
                ? truncateText(a.body.trim(), 1200)
                : "";

            const header = `[${i + 1}] ${title}${
                source || date
                    ? ` (${[source, date].filter(Boolean).join(" • ")})`
                    : ""
            }${url ? `\nURL: ${url}` : ""}`;

            return `${header}${excerpt ? `\nExcerpt:\n${excerpt}` : ""}`;
        })
        .join("\n\n");

    const prompt =
        `Write a single coherent news article about the event below.\n` +
        `- Use ONLY information from the provided sources.\n` +
        `- When stating facts, cite sources like [1], [2], etc.\n` +
        `- Do not invent details.\n` +
        `- Output markdown only.\n\n` +
        `Event title: ${options.eventTitle}\n` +
        (summary ? `Event summary: ${summary}\n\n` : "\n") +
        `Sources:\n${sources}\n`;

    const story = await queryChatGPT(prompt, options.openaiApiKey, {
        model: options.openaiModel,
        system: "You are a careful journalist. Prefer accuracy over speculation. Keep it readable and concise.",
    });

    return story.trim();
}

async function buildFeedSummary(options: {
    eventTitle: string;
    eventSummary?: string;
    storyMarkdown: string;
    openaiApiKey: string;
    openaiModel?: string;
}): Promise<string> {
    const summary = options.eventSummary?.trim();
    const prompt =
        `Write a short social feed summary for the news event below.\n` +
        `- Use ONLY information from the provided article.\n` +
        `- Keep it brief, like a tweet.\n` +
        `- Do not use headings.\n` +
        `- Output markdown only.\n\n` +
        `Event title: ${options.eventTitle}\n` +
        (summary ? `Event summary: ${summary}\n\n` : "\n") +
        `Article markdown:\n${options.storyMarkdown}\n`;

    const out = await queryChatGPT(prompt, options.openaiApiKey, {
        model: options.openaiModel,
        system: "You are a social media editor. Be accurate and concise.",
    });
    return out.trim();
}

@variant("news-bot")
export class NewsBot extends Program<Args> {
    private runner?: BotRunner;
    private newsApiStore?: NewsApiStore;
    private dedupStore?: DedupStore;
    private lastRunSummary?: NewsBotRunSummary;

    getLastRunSummary(): NewsBotRunSummary | undefined {
        return this.lastRunSummary;
    }

    async open(args?: Args): Promise<void> {
        if (this.runner) return;

        const replicate = parseBooleanArg(args?.replicate, true);
        const { scope, parent: root } = await resolveBotTarget(this.node, {
            replicate,
            scopeAddress: args?.scopeAddress,
            parentCanvasId: args?.parentCanvasId,
        });

        this.newsApiStore = await this.node.open(
            new NewsApiStore({
                id: NewsApiStore.idFor(this.node.identity.publicKey),
            }),
            { existing: "reuse", args: { replicate: false } }
        );

        this.dedupStore = await this.node.open(
            new DedupStore({
                id: DedupStore.idFor(this.node.identity.publicKey),
            }),
            { existing: "reuse", args: { replicate: false } }
        );

        const intervalMs = parseIntervalMs({
            intervalMs: args?.intervalMs,
            intervalMinutes: args?.intervalMinutes,
            defaultMs: 10 * 60_000,
        });
        const runOnStart = parseBooleanArg(args?.runOnStart, true);
        const runOnce = parseBooleanArg(args?.runOnce, false);
        const dryRun = parseBooleanArg(args?.dryRun, false);

        const newsApiKey =
            args?.newsApiKey ||
            process.env.NEWS_API_KEY ||
            process.env.NEWSAPI_AI_KEY ||
            process.env.EVENTREGISTRY_API_KEY;
        if (!newsApiKey) {
            throw new Error(
                "Missing NewsAPI.ai api key. Pass args.newsApiKey or set NEWS_API_KEY / NEWSAPI_AI_KEY / EVENTREGISTRY_API_KEY."
            );
        }

        const openaiApiKey = args?.openaiApiKey || process.env.OPENAI_API_KEY;
        if (!openaiApiKey) {
            throw new Error(
                "Missing OpenAI API key. Pass args.openaiApiKey or set OPENAI_API_KEY."
            );
        }

        const statePath = args?.statePath?.trim();

        const maxEventsPerRun = Math.max(
            1,
            parseNumberArg(args?.maxEventsPerRun) ?? 1
        );
        const maxArticlesPerEvent = Math.max(
            1,
            parseNumberArg(args?.maxArticlesPerEvent) ?? 50
        );

        const openaiModel = args?.openaiModel;
        const prefix =
            args?.prefix === undefined ? "News bot" : args.prefix.trim();

        const recentActivityEventsMaxEventCount = Math.min(
            2000,
            Math.max(
                1,
                parseNumberArg(args?.recentActivityEventsMaxEventCount) ?? 50
            )
        );

        const computedAfterMinsAgo = Math.min(
            240,
            Math.max(1, Math.ceil(intervalMs / 60_000) + 1)
        );
        const recentActivityEventsUpdatesAfterMinsAgo = Math.min(
            240,
            Math.max(
                1,
                parseNumberArg(args?.recentActivityEventsUpdatesAfterMinsAgo) ??
                    computedAfterMinsAgo
            )
        );

        const recentActivityEventsUpdatesAfterTm =
            args?.recentActivityEventsUpdatesAfterTm?.trim() || undefined;

        const includeImages = parseBooleanArg(args?.includeImages, true);
        const maxImageBytes = Math.max(
            64 * 1024,
            parseNumberArg(args?.maxImageBytes) ?? DEFAULT_MAX_IMAGE_BYTES
        );
        const maxImageCandidates = Math.max(
            1,
            parseNumberArg(args?.maxImageCandidates) ?? 5
        );
        const imageTimeoutMs = Math.max(
            1_000,
            parseNumberArg(args?.imageTimeoutMs) ?? DEFAULT_IMAGE_TIMEOUT_MS
        );

        const generateFeedSummary = parseBooleanArg(
            args?.generateFeedSummary,
            true
        );

        const ctx: BotJobContext = {
            node: this.node,
            scope,
            root,
            log: (...a: any[]) => console.log("[NewsBot]", ...a),
            error: (...a: any[]) => console.error("[NewsBot]", ...a),
        };

        const job: BotJob = {
            id: "news",
            intervalMs,
            run: async ({ log }) => {
                const startedAtMs = Date.now();
                const summary: NewsBotRunSummary = {
                    startedAt: new Date().toISOString(),
                    finishedAt: "",
                    durationMs: 0,
                    dryRun,
                    stream: {
                        maxEventCount: recentActivityEventsMaxEventCount,
                        ...(recentActivityEventsUpdatesAfterTm
                            ? {
                                  updatesAfterTm:
                                      recentActivityEventsUpdatesAfterTm,
                              }
                            : {
                                  updatesAfterMinsAgo:
                                      recentActivityEventsUpdatesAfterMinsAgo,
                              }),
                    },
                    target: {
                        scopeAddress: scope.address,
                        parentCanvasId: toBase64URL(root.id),
                    },
                    filters: {
                        keyword: args?.keyword,
                        lang: args?.lang ?? "eng",
                        categoryUri: args?.categoryUri,
                        locationUri: args?.locationUri,
                    },
                    eventsFetched: 0,
                    eventsPending: 0,
                    eventsSelected: 0,
                    eventsProcessed: [],
                };
                try {
                    if (runOnce && !dryRun && replicate) {
                        await waitForScopeReplicators({
                            scope,
                            timeoutMs: 15_000,
                        });
                    }

                    const events = await fetchEventStream(
                        { apiKey: newsApiKey },
                        {
                            categoryUri: args?.categoryUri,
                            locationUri: args?.locationUri,
                            keyword: args?.keyword,
                            lang: args?.lang ?? "eng",
                            recentActivityEventsMaxEventCount,
                            ...(recentActivityEventsUpdatesAfterTm
                                ? {
                                      recentActivityEventsUpdatesAfterTm,
                                  }
                                : {
                                      recentActivityEventsUpdatesAfterMinsAgo,
                                  }),
                        }
                    );
                    summary.eventsFetched = events.length;

                    await this.newsApiStore!.upsertEvents(events);

                    const pending = (
                        await Promise.all(
                            events.map(async (e) => ({
                                event: e,
                                posted: await this.dedupStore!.isEventPosted(
                                    e.uri
                                ),
                            }))
                        )
                    )
                        .filter((x) => !x.posted)
                        .map((x) => x.event);
                    summary.eventsPending = pending.length;
                    if (!pending.length) {
                        log("[NewsBot] no new events");
                        return;
                    }

                    const toPost = pending.slice(0, maxEventsPerRun);
                    summary.eventsSelected = toPost.length;

                    for (const event of toPost) {
                        const eventSummary: NewsBotRunSummaryEvent = {
                            eventUri: event.uri,
                            title: event.title,
                            posted: false,
                        };
                        summary.eventsProcessed.push(eventSummary);

                        try {
                            const articlesRaw = await fetchArticles(
                                { apiKey: newsApiKey },
                                {
                                    eventUri: event.uri,
                                    lang: args?.lang ?? "eng",
                                    articlesCount: maxArticlesPerEvent,
                                    articlesSortBy: "date",
                                    includeArticleBody: true,
                                    includeArticleTitle: true,
                                    includeArticleUrl: true,
                                    includeArticleSource: true,
                                    includeArticleDate: true,
                                }
                            );
                            eventSummary.articlesFetched = articlesRaw.length;

                            await this.newsApiStore!.upsertArticles(
                                articlesRaw,
                                {
                                    eventUri: event.uri,
                                }
                            );

                            const articles = dedupeArticles(articlesRaw).slice(
                                0,
                                maxArticlesPerEvent
                            );
                            eventSummary.articlesUsed = articles.length;

                            const eventTitle =
                                event.title?.trim() ||
                                articles
                                    .find((a) => a.title?.trim())
                                    ?.title?.trim() ||
                                "News event";
                            eventSummary.title = eventTitle;

                            const story = await buildMasterArticle({
                                eventTitle,
                                eventSummary: event.summary,
                                articles,
                                openaiApiKey,
                                openaiModel,
                            });

                            const feedSummary = generateFeedSummary
                                ? await buildFeedSummary({
                                      eventTitle,
                                      eventSummary: event.summary,
                                      storyMarkdown: story,
                                      openaiApiKey,
                                      openaiModel,
                                  }).catch(() => "")
                                : "";

                            const leadImage = includeImages
                                ? await findLeadImage({
                                      articles,
                                      maxCandidates: maxImageCandidates,
                                      maxImageBytes,
                                      timeoutMs: imageTimeoutMs,
                                  })
                                : undefined;

                            const leadImageContentId = leadImage
                                ? sha256ContentId(leadImage.bytes)
                                : undefined;
                            const leadImageRef = leadImageContentId
                                ? gigaImageUrlFromContentId(leadImageContentId)
                                : undefined;

                            if (leadImage && leadImageRef) {
                                eventSummary.leadImage = {
                                    url: leadImage.url,
                                    mimeType: leadImage.mimeType,
                                    bytes: leadImage.bytes.length,
                                    width: leadImage.width,
                                    height: leadImage.height,
                                    ref: leadImageRef,
                                };
                            }

                            const references = formatReferences(articles);
                            const referencesShort = formatReferences(
                                articles.slice(0, 5)
                            );
                            const header = prefix ? `### ${prefix}\n\n` : "";
                            const imageMarkdown = leadImageRef
                                ? `![${eventTitle}](${leadImageRef})\n\n`
                                : "";

                            const markdownHigh =
                                header +
                                `# ${eventTitle}\n\n` +
                                imageMarkdown +
                                `${story}\n\n` +
                                `## References\n${references}\n\n` +
                                `_Event URI: ${event.uri}_\n`;

                            const markdownMedium =
                                header +
                                `# ${eventTitle}\n\n` +
                                imageMarkdown +
                                (feedSummary.trim()
                                    ? `${feedSummary.trim()}\n\n`
                                    : `${truncateText(story, 700)}\n\n`) +
                                `## References\n${referencesShort}\n\n` +
                                `_Event URI: ${event.uri}_\n`;

                            const markdownLow = (() => {
                                const oneLiner = event.summary?.trim()
                                    ? truncateText(event.summary.trim(), 180)
                                    : "";
                                return (
                                    `# ${eventTitle}\n` +
                                    (oneLiner ? `\n${oneLiner}\n` : "")
                                );
                            })();

                            if (dryRun) {
                                if (leadImage) {
                                    log(
                                        `[NewsBot] lead image: ${leadImage.url} (${leadImage.mimeType}, ${leadImage.bytes.length} bytes)`
                                    );
                                }
                                log("[NewsBot] markdown variants:", {
                                    low: markdownLow.length,
                                    medium: markdownMedium.length,
                                    high: markdownHigh.length,
                                });
                                log(markdownHigh);
                            } else {
                                const draft = new Canvas({
                                    publicKey: this.node.identity.publicKey,
                                });

                                const [, post] = await scope.getOrCreateReply(
                                    root,
                                    draft,
                                    {
                                        kind: new ReplyKind(),
                                        visibility: "both",
                                    }
                                );

                                post.beginBulk();
                                try {
                                    let nextY = 0;

                                    if (leadImage) {
                                        const loc = Layout.zero();
                                        loc.y = nextY++;

                                        const contentId = leadImageContentId!;
                                        await post.createElement(
                                            new Element({
                                                location: loc,
                                                publicKey:
                                                    this.node.identity
                                                        .publicKey,
                                                canvasId: post.id,
                                                content: new StaticContent({
                                                    content: new StaticImage({
                                                        data: leadImage.bytes,
                                                        mimeType:
                                                            leadImage.mimeType,
                                                        width: leadImage.width,
                                                        height: leadImage.height,
                                                        alt: eventTitle,
                                                        caption: "",
                                                    }),
                                                    quality: MEDIUM_QUALITY,
                                                    contentId,
                                                }),
                                            })
                                        );
                                    }

                                    const textY = nextY++;
                                    const textContentId = sha256Sync(
                                        new TextEncoder().encode(
                                            `news-bot:event:${event.uri}:markdown`
                                        )
                                    );
                                    const loc = () => {
                                        const l = Layout.zero();
                                        l.y = textY;
                                        return l;
                                    };

                                    await post.createElement(
                                        new Element({
                                            location: loc(),
                                            publicKey:
                                                this.node.identity.publicKey,
                                            canvasId: post.id,
                                            content: new StaticContent({
                                                content: new StaticMarkdownText(
                                                    {
                                                        text: markdownLow,
                                                    }
                                                ),
                                                quality: LOWEST_QUALITY,
                                                contentId: textContentId,
                                            }),
                                        })
                                    );
                                    await post.createElement(
                                        new Element({
                                            location: loc(),
                                            publicKey:
                                                this.node.identity.publicKey,
                                            canvasId: post.id,
                                            content: new StaticContent({
                                                content: new StaticMarkdownText(
                                                    {
                                                        text: markdownMedium,
                                                    }
                                                ),
                                                quality: MEDIUM_QUALITY,
                                                contentId: textContentId,
                                            }),
                                        })
                                    );
                                    await post.createElement(
                                        new Element({
                                            location: loc(),
                                            publicKey:
                                                this.node.identity.publicKey,
                                            canvasId: post.id,
                                            content: new StaticContent({
                                                content: new StaticMarkdownText(
                                                    {
                                                        text: markdownHigh,
                                                    }
                                                ),
                                                quality: HIGH_QUALITY,
                                                contentId: textContentId,
                                            }),
                                        })
                                    );
                                } finally {
                                    await post.endBulk();
                                }

                                try {
                                    await post.nearestScope._hierarchicalReindex?.flush(
                                        post.idString
                                    );
                                } catch {}
                                try {
                                    await root.nearestScope._hierarchicalReindex?.flush(
                                        root.idString
                                    );
                                } catch {}

                                const articleKeys = articles.map((a) =>
                                    newsApiArticleKey(a)
                                );
                                await this.dedupStore!.recordPostedEvent({
                                    eventUri: event.uri,
                                    postCanvasId: post.id,
                                    articleKeys,
                                });

                                if (statePath) {
                                    const state = await readJsonFile(
                                        statePath,
                                        defaultState()
                                    );
                                    if (
                                        !state.postedEventUris.includes(
                                            event.uri
                                        )
                                    ) {
                                        state.postedEventUris.push(event.uri);
                                    }
                                    state.postedEventUris =
                                        state.postedEventUris
                                            .slice(-500)
                                            .sort();
                                    state.updatedAt = new Date().toISOString();
                                    await writeJsonFile(statePath, state);
                                }

                                eventSummary.posted = true;
                                eventSummary.postCanvasId = toBase64URL(
                                    post.id
                                );

                                if (runOnce && replicate) {
                                    const startedVerifyAt = Date.now();
                                    const expectedMinElements =
                                        3 + (leadImage ? 1 : 0);
                                    const verification = await verifyRemotePost(
                                        {
                                            scope,
                                            parentCanvasId: root.id,
                                            postCanvasId: post.id,
                                            expectedMinElements,
                                            timeoutMs: 25_000,
                                        }
                                    );

                                    eventSummary.remote = {
                                        ok: verification.ok,
                                        attempts: verification.attempts,
                                        durationMs:
                                            Date.now() - startedVerifyAt,
                                        ...(verification.ok
                                            ? {
                                                  elementsFound:
                                                      verification.elementsFound,
                                              }
                                            : {
                                                  error: verification.error,
                                              }),
                                    };

                                    if (!verification.ok) {
                                        throw new Error(
                                            `Remote verification failed: ${verification.error}`
                                        );
                                    }
                                }
                            }
                        } catch (e) {
                            eventSummary.error =
                                e instanceof Error
                                    ? e.message
                                    : typeof e === "string"
                                      ? e
                                      : (() => {
                                            try {
                                                return JSON.stringify(e);
                                            } catch {
                                                return String(e);
                                            }
                                        })();
                            throw e;
                        }
                    }
                } finally {
                    summary.finishedAt = new Date().toISOString();
                    summary.durationMs = Date.now() - startedAtMs;
                    this.lastRunSummary = summary;
                }
            },
        };

        if (runOnce) {
            await job.run(ctx);
            console.log(`[NewsBot] runOnce finished (dryRun=${dryRun})`);
            return;
        }

        this.runner = new BotRunner({ runOnStart, jobs: [job], ctx });
        this.runner.start();
        console.log(
            `[NewsBot] started (intervalMs=${intervalMs}, replicate=${replicate}, dryRun=${dryRun})`
        );
    }
}
