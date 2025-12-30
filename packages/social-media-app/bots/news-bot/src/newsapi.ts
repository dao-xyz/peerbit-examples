type JsonObject = Record<string, any>;

export type NewsApiClientOptions = {
    apiKey: string;
    baseUrl?: string; // default: https://eventregistry.org/api/v1
    timeoutMs?: number;
};

export type NewsApiEventQuery = {
    categoryUri?: string;
    locationUri?: string;
    keyword?: string | string[];
    keywordOper?: "or" | "and";
    lang?: string | string[];
    eventsCount?: number;
    eventsSortBy?: string;
};

export type NewsApiEventStreamQuery = {
    categoryUri?: string;
    locationUri?: string;
    keyword?: string | string[];
    keywordOper?: "or" | "and";
    lang?: string | string[];

    recentActivityEventsMaxEventCount?: number;
    recentActivityEventsUpdatesAfterMinsAgo?: number;
    recentActivityEventsUpdatesAfterTm?: string;
};

export type NewsApiArticleQuery = {
    eventUri?: string;
    keyword?: string | string[];
    keywordOper?: "or" | "and";
    conceptUri?: string | string[];
    lang?: string | string[];
    articlesCount?: number;
    articlesSortBy?: string;
    includeArticleBody?: boolean;
    includeArticleTitle?: boolean;
    includeArticleUrl?: boolean;
    includeArticleSource?: boolean;
    includeArticleDate?: boolean;
};

export type NewsApiEvent = {
    uri: string;
    title?: string;
    summary?: string;
    raw: any;
};

export type NewsApiArticle = {
    uri?: string;
    title?: string;
    body?: string;
    url?: string;
    dateTime?: string;
    sourceTitle?: string;
    raw: any;
};

const DEFAULT_BASE_URL = "https://eventregistry.org/api/v1";

function pickLangText(
    value: any,
    preferred: string = "eng"
): string | undefined {
    if (value == null) return undefined;
    if (typeof value === "string") return value;
    if (typeof value !== "object") return undefined;

    if (typeof value[preferred] === "string") return value[preferred];
    for (const v of Object.values(value)) {
        if (typeof v === "string" && v.trim()) return v;
    }
    return undefined;
}

function asString(value: any): string | undefined {
    if (typeof value === "string") return value;
    return undefined;
}

function asArray<T = any>(value: any): T[] | undefined {
    return Array.isArray(value) ? (value as T[]) : undefined;
}

function buildQuery(params: JsonObject): URLSearchParams {
    const out = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
        if (value == null) continue;

        if (Array.isArray(value)) {
            for (const item of value) {
                if (item == null) continue;
                out.append(key, String(item));
            }
            continue;
        }

        if (typeof value === "boolean") {
            out.append(key, value ? "true" : "false");
            continue;
        }

        out.append(key, String(value));
    }

    return out;
}

async function requestJson(options: {
    baseUrl: string;
    endpoint: string;
    apiKey: string;
    params: JsonObject;
    timeoutMs?: number;
}): Promise<any> {
    const url = new URL(options.baseUrl.replace(/\/$/, "") + options.endpoint);
    url.search = buildQuery({
        ...options.params,
        apiKey: options.apiKey,
    }).toString();

    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? 30_000
    );
    try {
        const res = await fetch(url.toString(), { signal: controller.signal });
        const text = await res.text();
        if (!res.ok) {
            throw new Error(
                `NewsAPI.ai request failed (${res.status} ${res.statusText}): ${text.slice(0, 500)}`
            );
        }
        try {
            return JSON.parse(text);
        } catch (e) {
            throw new Error(
                `NewsAPI.ai response was not JSON (first 500 chars): ${text.slice(0, 500)}`
            );
        }
    } finally {
        clearTimeout(timeout);
    }
}

function extractResultsArray(obj: any): any[] {
    if (!obj || typeof obj !== "object") return [];
    const direct = asArray(obj.results);
    if (direct) return direct;
    const maybe = asArray(obj);
    if (maybe) return maybe;
    return [];
}

function firstNonEmpty(...candidates: any[][]): any[] {
    for (const c of candidates) {
        if (Array.isArray(c) && c.length) return c;
    }
    return [];
}

export async function fetchEvents(
    client: NewsApiClientOptions,
    query: NewsApiEventQuery
): Promise<NewsApiEvent[]> {
    const baseUrl = client.baseUrl ?? DEFAULT_BASE_URL;
    const raw = await requestJson({
        baseUrl,
        endpoint: "/event/getEvents",
        apiKey: client.apiKey,
        timeoutMs: client.timeoutMs,
        params: {
            resultType: "events",
            eventsSortBy: query.eventsSortBy ?? "date",
            eventsCount: query.eventsCount ?? 10,
            ...(query.categoryUri ? { categoryUri: query.categoryUri } : {}),
            ...(query.locationUri ? { locationUri: query.locationUri } : {}),
            ...(query.keyword ? { keyword: query.keyword } : {}),
            ...(query.keywordOper ? { keywordOper: query.keywordOper } : {}),
            ...(query.lang ? { lang: query.lang } : {}),
        },
    });

    const results = firstNonEmpty(
        extractResultsArray(raw?.events),
        extractResultsArray(raw?.event),
        extractResultsArray(raw)
    );

    const out: NewsApiEvent[] = [];
    for (const e of results) {
        const uri = asString(e?.uri) ?? asString(e?.id);
        if (!uri) continue;

        const evt: NewsApiEvent = { uri, raw: e };
        const title = pickLangText(e?.title);
        if (title) evt.title = title;
        const summary =
            pickLangText(e?.summary) ?? pickLangText(e?.description);
        if (summary) evt.summary = summary;

        out.push(evt);
    }
    return out;
}

export async function fetchEventStream(
    client: NewsApiClientOptions,
    query: NewsApiEventStreamQuery
): Promise<NewsApiEvent[]> {
    const baseUrl = client.baseUrl ?? DEFAULT_BASE_URL;
    const raw = await requestJson({
        baseUrl,
        endpoint: "/minuteStreamEvents",
        apiKey: client.apiKey,
        timeoutMs: client.timeoutMs,
        params: {
            recentActivityEventsMaxEventCount:
                query.recentActivityEventsMaxEventCount ?? 50,
            ...(query.recentActivityEventsUpdatesAfterTm
                ? {
                      recentActivityEventsUpdatesAfterTm:
                          query.recentActivityEventsUpdatesAfterTm,
                  }
                : {}),
            ...(query.recentActivityEventsUpdatesAfterTm == null &&
            query.recentActivityEventsUpdatesAfterMinsAgo != null
                ? {
                      recentActivityEventsUpdatesAfterMinsAgo:
                          query.recentActivityEventsUpdatesAfterMinsAgo,
                  }
                : {}),
            ...(query.categoryUri ? { categoryUri: query.categoryUri } : {}),
            ...(query.locationUri ? { locationUri: query.locationUri } : {}),
            ...(query.keyword ? { keyword: query.keyword } : {}),
            ...(query.keywordOper ? { keywordOper: query.keywordOper } : {}),
            ...(query.lang ? { lang: query.lang } : {}),
        },
    });

    const recent = raw?.recentActivityEvents;
    const activity = asArray<string>(recent?.activity) ?? [];
    const eventInfo = recent?.eventInfo;

    const out: NewsApiEvent[] = [];
    const seen = new Set<string>();

    const pushEvent = (e: any, fallbackUri?: string) => {
        const uri = asString(e?.uri) ?? asString(e?.id) ?? fallbackUri;
        if (!uri) return;
        if (seen.has(uri)) return;
        seen.add(uri);

        const evt: NewsApiEvent = { uri, raw: e };
        const title = pickLangText(e?.title);
        if (title) evt.title = title;
        const summary =
            pickLangText(e?.summary) ?? pickLangText(e?.description);
        if (summary) evt.summary = summary;
        out.push(evt);
    };

    if (activity.length && eventInfo && typeof eventInfo === "object") {
        for (const id of activity) {
            const info = (eventInfo as any)[id];
            if (info) pushEvent(info, id);
        }
        return out;
    }

    // Fallbacks: tolerate schema changes / alternate wrappers.
    const results = firstNonEmpty(
        extractResultsArray(recent?.events),
        extractResultsArray(recent?.event),
        extractResultsArray(raw?.events),
        extractResultsArray(raw?.event),
        extractResultsArray(raw)
    );
    for (const e of results) pushEvent(e);
    return out;
}

export async function fetchArticles(
    client: NewsApiClientOptions,
    query: NewsApiArticleQuery
): Promise<NewsApiArticle[]> {
    const baseUrl = client.baseUrl ?? DEFAULT_BASE_URL;
    // Note: EventRegistry docs retrieve articles for a specific event via
    // https://eventregistry.org/api/v1/event/getEvent (eventUri + resultType=articles),
    // not via article/getArticles.
    const raw = query.eventUri
        ? await requestJson({
              baseUrl,
              endpoint: "/event/getEvent",
              apiKey: client.apiKey,
              timeoutMs: client.timeoutMs,
              params: {
                  eventUri: query.eventUri,
                  resultType: "articles",
                  articlesSortBy: query.articlesSortBy ?? "date",
                  articlesCount: query.articlesCount ?? 50,
                  ...(query.keyword ? { keyword: query.keyword } : {}),
                  ...(query.keywordOper
                      ? { keywordOper: query.keywordOper }
                      : {}),
                  ...(query.conceptUri ? { conceptUri: query.conceptUri } : {}),
                  ...(query.lang ? { articlesLang: query.lang } : {}),
                  includeArticleBody: query.includeArticleBody ?? true,
                  includeArticleTitle: query.includeArticleTitle ?? true,
                  includeArticleUrl: query.includeArticleUrl ?? true,
                  includeArticleSource: query.includeArticleSource ?? true,
                  includeArticleDate: query.includeArticleDate ?? true,
              },
          })
        : await requestJson({
              baseUrl,
              endpoint: "/article/getArticles",
              apiKey: client.apiKey,
              timeoutMs: client.timeoutMs,
              params: {
                  resultType: "articles",
                  articlesSortBy: query.articlesSortBy ?? "date",
                  articlesCount: query.articlesCount ?? 50,
                  ...(query.keyword ? { keyword: query.keyword } : {}),
                  ...(query.keywordOper
                      ? { keywordOper: query.keywordOper }
                      : {}),
                  ...(query.conceptUri ? { conceptUri: query.conceptUri } : {}),
                  ...(query.lang ? { lang: query.lang } : {}),
                  includeArticleBody: query.includeArticleBody ?? true,
                  includeArticleTitle: query.includeArticleTitle ?? true,
                  includeArticleUrl: query.includeArticleUrl ?? true,
                  includeArticleSource: query.includeArticleSource ?? true,
                  includeArticleDate: query.includeArticleDate ?? true,
              },
          });

    const results = query.eventUri
        ? firstNonEmpty(
              extractResultsArray(raw?.[query.eventUri]?.articles),
              extractResultsArray(raw?.articles),
              extractResultsArray(raw)
          )
        : firstNonEmpty(
              extractResultsArray(raw?.articles),
              extractResultsArray(raw?.article),
              extractResultsArray(raw)
          );

    return results.map((a: any) => {
        const sourceTitle =
            pickLangText(a?.source?.title) ??
            asString(a?.source?.title) ??
            asString(a?.source?.name);
        return {
            uri: asString(a?.uri),
            title: pickLangText(a?.title) ?? asString(a?.title),
            body:
                asString(a?.body) ??
                asString(a?.content) ??
                asString(a?.description) ??
                pickLangText(a?.body) ??
                pickLangText(a?.content) ??
                pickLangText(a?.description),
            url: asString(a?.url),
            dateTime:
                asString(a?.dateTime) ??
                asString(a?.date) ??
                asString(a?.publishedAt),
            sourceTitle,
            raw: a,
        } satisfies NewsApiArticle;
    });
}
