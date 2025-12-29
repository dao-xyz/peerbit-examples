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
} from "@giga-app/interface";
import { sha256Sync } from "@peerbit/crypto";
import { fetchArticles, fetchEvents, type NewsApiArticle } from "./newsapi.js";
import { DedupStore, NewsApiStore, newsApiArticleKey } from "./store/index.js";
import {
    DEFAULT_IMAGE_TIMEOUT_MS,
    DEFAULT_MAX_IMAGE_BYTES,
    findLeadImage,
    gigaImageUrlFromContentId,
    sha256ContentId,
} from "./images.js";

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
        `- Keep it brief (max ~600 characters).\n` +
        `- Prefer 3-5 bullet points.\n` +
        `- Preserve citations like [1], [2] when possible.\n` +
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
                const events = await fetchEvents(
                    { apiKey: newsApiKey },
                    {
                        categoryUri: args?.categoryUri,
                        locationUri: args?.locationUri,
                        keyword: args?.keyword,
                        lang: args?.lang ?? "eng",
                        eventsCount: Math.max(10, maxEventsPerRun * 5),
                        eventsSortBy: "date",
                    }
                );

                await this.newsApiStore!.upsertEvents(events);

                const pending = (
                    await Promise.all(
                        events.map(async (e) => ({
                            event: e,
                            posted: await this.dedupStore!.isEventPosted(e.uri),
                        }))
                    )
                )
                    .filter((x) => !x.posted)
                    .map((x) => x.event);
                if (!pending.length) {
                    log("[NewsBot] no new events");
                    return;
                }

                const toPost = pending.slice(0, maxEventsPerRun);

                for (const event of toPost) {
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

                    await this.newsApiStore!.upsertArticles(articlesRaw, {
                        eventUri: event.uri,
                    });

                    const articles = dedupeArticles(articlesRaw).slice(
                        0,
                        maxArticlesPerEvent
                    );

                    const eventTitle =
                        event.title?.trim() ||
                        articles.find((a) => a.title?.trim())?.title?.trim() ||
                        "News event";

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

                    const references = formatReferences(articles);
                    const referencesShort = formatReferences(articles.slice(0, 5));
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
                                            this.node.identity.publicKey,
                                        canvasId: post.id,
                                        content: new StaticContent({
                                            content: new StaticImage({
                                                data: leadImage.bytes,
                                                mimeType: leadImage.mimeType,
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
                                    publicKey: this.node.identity.publicKey,
                                    canvasId: post.id,
                                    content: new StaticContent({
                                        content: new StaticMarkdownText({
                                            text: markdownLow,
                                        }),
                                        quality: LOWEST_QUALITY,
                                        contentId: textContentId,
                                    }),
                                })
                            );
                            await post.createElement(
                                new Element({
                                    location: loc(),
                                    publicKey: this.node.identity.publicKey,
                                    canvasId: post.id,
                                    content: new StaticContent({
                                        content: new StaticMarkdownText({
                                            text: markdownMedium,
                                        }),
                                        quality: MEDIUM_QUALITY,
                                        contentId: textContentId,
                                    }),
                                })
                            );
                            await post.createElement(
                                new Element({
                                    location: loc(),
                                    publicKey: this.node.identity.publicKey,
                                    canvasId: post.id,
                                    content: new StaticContent({
                                        content: new StaticMarkdownText({
                                            text: markdownHigh,
                                        }),
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
                            if (!state.postedEventUris.includes(event.uri)) {
                                state.postedEventUris.push(event.uri);
                            }
                            state.postedEventUris = state.postedEventUris
                                .slice(-500)
                                .sort();
                            state.updatedAt = new Date().toISOString();
                            await writeJsonFile(statePath, state);
                        }
                    }
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
