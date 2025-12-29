import { TestSession } from "@peerbit/test-utils";
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "vitest";
import { waitForResolved } from "@peerbit/time";
import os from "os";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { fileURLToPath } from "url";
import { NewsBot } from "../news-bot.js";
import { fetchEvents } from "../newsapi.js";

function loadDotEnvIfPresent() {
    const envPath = fileURLToPath(new URL("../../.env", import.meta.url));
    if (!fs.existsSync(envPath)) return;

    try {
        const raw = fs.readFileSync(envPath, "utf8");
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;

            const eq = trimmed.indexOf("=");
            if (eq === -1) continue;

            const key = trimmed.slice(0, eq).trim();
            let value = trimmed.slice(eq + 1).trim();

            if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
            ) {
                value = value.slice(1, -1);
            }

            if (!key || process.env[key] != null) continue;
            process.env[key] = value;
        }
    } catch {
        // Ignore .env parsing failures in tests; test will be skipped if keys are missing.
    }
}

loadDotEnvIfPresent();

const NEWS_API_KEY =
    process.env.NEWS_API_KEY ||
    process.env.NEWSAPI_AI_KEY ||
    process.env.EVENTREGISTRY_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const itIfKeys = NEWS_API_KEY && OPENAI_API_KEY ? it : it.skip;

console.log("NewsBot e2e test:", {
    NEWS_API_KEY: NEWS_API_KEY ? "provided" : "MISSING",
    OPENAI_API_KEY: OPENAI_API_KEY ? "provided" : "MISSING",
});

function looksLikeOpenAiKey(value: string | undefined) {
    return typeof value === "string" && value.startsWith("sk-");
}

function looksLikeUuid(value: string | undefined) {
    return (
        typeof value === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            value
        )
    );
}

async function assertOpenAiKeyValid(apiKey: string) {
    const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) return;
    throw new Error(
        `OpenAI key rejected (${res.status} ${res.statusText}). Make sure OPENAI_API_KEY is a valid OpenAI key.`
    );
}

async function assertNewsApiKeyValid(apiKey: string) {
    try {
        await fetchEvents(
            { apiKey, timeoutMs: 15_000 },
            {
                keyword: "Bitcoin",
                eventsCount: 1,
                eventsSortBy: "date",
                lang: "eng",
            }
        );
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (
            message.includes("401") ||
            message.toLowerCase().includes("unauthorized")
        ) {
            throw new Error(
                `NewsAPI.ai rejected NEWS_API_KEY (401). Make sure NEWS_API_KEY is your NewsAPI.ai/EventRegistry key (not your OpenAI key).`
            );
        }
        throw e;
    }
}

describe("NewsBot (e2e)", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(1);
    });

    afterEach(async () => {
        await session.stop();
    });

    itIfKeys(
        "generates a master article from NewsAPI.ai + OpenAI",
        async () => {
            if (
                looksLikeOpenAiKey(NEWS_API_KEY) &&
                looksLikeUuid(OPENAI_API_KEY)
            ) {
                throw new Error(
                    "Env looks swapped: NEWS_API_KEY looks like an OpenAI key (sk-...), while OPENAI_API_KEY looks like a UUID. Put your OpenAI key in OPENAI_API_KEY and your NewsAPI.ai key in NEWS_API_KEY."
                );
            }

            await assertOpenAiKeyValid(OPENAI_API_KEY!);
            await assertNewsApiKeyValid(NEWS_API_KEY!);

            const peer = session.peers[0];

            const statePath = path.join(
                os.tmpdir(),
                "peerbit-news-bot-e2e",
                `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                "state.json"
            );

            await peer.open(new NewsBot(), {
                existing: "reuse",
                args: {
                    replicate: false,
                    intervalMs: 60_000,
                    runOnStart: true,
                    dryRun: false,
                    prefix: "News bot e2e",

                    newsApiKey: NEWS_API_KEY!,
                    openaiApiKey: OPENAI_API_KEY!,
                    openaiModel: "gpt-5.1",
                    /*  keyword: "Bitcoin", */
                    lang: "eng",

                    maxEventsPerRun: 1,
                    maxArticlesPerEvent: 3,
                    statePath,
                },
            });

            await waitForResolved(
                async () => {
                    const raw = await fsp.readFile(statePath, "utf8");
                    const state = JSON.parse(raw) as {
                        postedEventUris?: unknown;
                    };
                    expect(state.postedEventUris).to.be.an("array");
                    expect(
                        (state.postedEventUris as any[]).length
                    ).to.be.greaterThan(0);
                },
                { timeout: 120_000, delayInterval: 500 }
            );
        }
    );
});
