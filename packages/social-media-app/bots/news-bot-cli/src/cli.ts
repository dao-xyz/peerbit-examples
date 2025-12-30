import { Peerbit } from "peerbit";
import os from "os";
import path from "path";
import fs from "fs";
import select from "@inquirer/select";
import input from "@inquirer/input";
import events from "events";
import { fileURLToPath } from "url";
import { NewsBot, type NewsBotRunSummary } from "@giga-app/news-bot";
import { BOOTSTRAP_ADDRS, type BootstrapMode } from "@giga-app/network";

events.setMaxListeners(100);

type CliArgs = {
    directory: string;
    network: BootstrapMode;
    replicate: boolean;
    intervalMs?: number;
    intervalMinutes?: number;
    runOnStart: boolean;
    runOnce: boolean;
    dryRun: boolean;
    prefix?: string;

    scopeAddress?: string;
    parentCanvasId?: string;

    newsApiKey?: string;
    openaiApiKey?: string;
    openaiModel?: string;
    keyword?: string | string[];
    lang?: string | string[];
    categoryUri?: string;
    locationUri?: string;
    maxEventsPerRun?: number;
    maxArticlesPerEvent?: number;
    statePath?: string;

    recentActivityEventsMaxEventCount?: number;
    recentActivityEventsUpdatesAfterMinsAgo?: number;
    recentActivityEventsUpdatesAfterTm?: string;

    includeImages?: boolean;
    maxImageBytes?: number;
    maxImageCandidates?: number;
    imageTimeoutMs?: number;
    generateFeedSummary?: boolean;
};

const getFlag = (name: string) => process.argv.includes(name);
const getValue = (name: string) => {
    const idx = process.argv.indexOf(name);
    return idx === -1 ? undefined : process.argv[idx + 1];
};

const parseNumber = (value: string | undefined): number | undefined => {
    if (value == null) return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
};

const parseList = (
    value: string | undefined
): string | string[] | undefined => {
    if (!value) return undefined;
    const parts = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (!parts.length) return undefined;
    return parts.length === 1 ? parts[0] : parts;
};

const parseNetwork = (): BootstrapMode => {
    const explicit = (getValue("--network") ?? getValue("--net"))
        ?.trim()
        .toLowerCase();
    if (explicit === "local") return "local";
    if (explicit === "offline") return "offline";
    if (explicit === "prod" || explicit === "production") return "prod";

    if (getFlag("--offline")) return "offline";
    if (getFlag("--local")) return "local";
    if (getFlag("--prod")) return "prod";
    return "prod";
};

function truncate(value: string, max = 120): string {
    if (value.length <= max) return value;
    return value.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return `${ms}ms`;
    if (ms < 1_000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const rem = Math.round(s - m * 60);
    return `${m}m${rem}s`;
}

function printRunSummary(summary: NewsBotRunSummary) {
    const mode = summary.dryRun ? "dry-run" : "published";
    const streamSuffix = summary.stream.updatesAfterTm
        ? `after=${summary.stream.updatesAfterTm}`
        : `lookback=${summary.stream.updatesAfterMinsAgo ?? "?"}m`;

    console.log("\n--- News bot run summary ---");
    console.log(
        `Mode: ${mode} • Duration: ${formatDuration(
            summary.durationMs
        )} • Stream: max=${summary.stream.maxEventCount}, ${streamSuffix}`
    );
    console.log(
        `Events: fetched=${summary.eventsFetched}, pending=${summary.eventsPending}, selected=${summary.eventsSelected}, processed=${summary.eventsProcessed.length}`
    );

    for (const e of summary.eventsProcessed) {
        const title = e.title?.trim() || e.eventUri;
        const parts = [
            e.posted ? `posted=${e.postCanvasId}` : "posted=false",
            e.articlesUsed != null
                ? `articles=${e.articlesUsed}${
                      e.articlesFetched != null &&
                      e.articlesFetched !== e.articlesUsed
                          ? `/${e.articlesFetched}`
                          : ""
                  }`
                : undefined,
            e.leadImage ? "image=true" : "image=false",
            e.remote
                ? e.remote.ok
                    ? `remote=ok (${formatDuration(
                          e.remote.durationMs
                      )}, attempts=${e.remote.attempts}, elements=${e.remote.elementsFound ?? "?"})`
                    : `remote=FAIL (${formatDuration(
                          e.remote.durationMs
                      )}, attempts=${e.remote.attempts}, error=${truncate(
                          e.remote.error ?? "",
                          100
                      )})`
                : undefined,
            e.error ? `error=${truncate(e.error, 120)}` : undefined,
        ].filter(Boolean);
        console.log(
            `- ${truncate(title, 100)} (${e.eventUri}) • ${parts.join(" • ")}`
        );
    }
    console.log("----------------------------\n");
}

function loadDotEnvFileIfPresent(filePath: string) {
    if (!fs.existsSync(filePath)) return;

    try {
        const raw = fs.readFileSync(filePath, "utf8");
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
        // Ignore .env parsing failures (keys may already be set in process.env)
    }
}

function loadDotEnvIfPresent() {
    loadDotEnvFileIfPresent(path.join(process.cwd(), ".env"));

    const cliDir = path.dirname(fileURLToPath(import.meta.url));
    const repoNewsBotEnv = path.resolve(cliDir, "..", "..", "news-bot", ".env");
    loadDotEnvFileIfPresent(repoNewsBotEnv);
}

const parseArgs = (): CliArgs => {
    const directory =
        getValue("--directory") ??
        getValue("--dir") ??
        path.join(os.homedir(), "peerbit-giga-bots", "news-bot");

    const intervalMs = parseNumber(getValue("--intervalMs"));
    const intervalMinutes = parseNumber(getValue("--intervalMinutes"));

    return {
        directory,
        network: parseNetwork(),
        replicate: !getFlag("--no-replicate"),
        intervalMs,
        intervalMinutes,
        runOnStart: !getFlag("--no-runOnStart"),
        runOnce:
            getFlag("--runOnce") || getFlag("--once") || getFlag("--run-once"),
        dryRun: getFlag("--dryRun") || getFlag("--dry-run"),
        prefix: getValue("--prefix"),

        scopeAddress: getValue("--scopeAddress") ?? getValue("--scope"),
        parentCanvasId: getValue("--parentCanvasId") ?? getValue("--parent"),

        newsApiKey: getValue("--newsApiKey") ?? getValue("--news-api-key"),
        openaiApiKey:
            getValue("--openaiApiKey") ?? getValue("--openai-api-key"),
        openaiModel: getValue("--openaiModel") ?? getValue("--openai-model"),
        keyword: parseList(getValue("--keyword")),
        lang: parseList(getValue("--lang")),
        categoryUri: getValue("--categoryUri") ?? getValue("--category-uri"),
        locationUri: getValue("--locationUri") ?? getValue("--location-uri"),
        maxEventsPerRun: parseNumber(getValue("--maxEventsPerRun")),
        maxArticlesPerEvent: parseNumber(getValue("--maxArticlesPerEvent")),
        statePath: getValue("--statePath"),

        recentActivityEventsMaxEventCount: parseNumber(
            getValue("--recentActivityEventsMaxEventCount") ??
                getValue("--recent-activity-events-max-event-count")
        ),
        recentActivityEventsUpdatesAfterMinsAgo: parseNumber(
            getValue("--recentActivityEventsUpdatesAfterMinsAgo") ??
                getValue("--recent-activity-events-updates-after-mins-ago")
        ),
        recentActivityEventsUpdatesAfterTm:
            getValue("--recentActivityEventsUpdatesAfterTm") ??
            getValue("--recent-activity-events-updates-after-tm"),

        includeImages:
            !getFlag("--no-images") &&
            !getFlag("--noImages") &&
            !getFlag("--no-image"),
        maxImageBytes: parseNumber(
            getValue("--maxImageBytes") ?? getValue("--max-image-bytes")
        ),
        maxImageCandidates: parseNumber(
            getValue("--maxImageCandidates") ??
                getValue("--max-image-candidates")
        ),
        imageTimeoutMs: parseNumber(
            getValue("--imageTimeoutMs") ?? getValue("--image-timeout-ms")
        ),
        generateFeedSummary:
            !getFlag("--no-feed-summary") &&
            !getFlag("--noFeedSummary") &&
            !getFlag("--no-feedSummary"),
    };
};

const printHelp = () => {
    console.log(`
giga-app-news-bot

Usage:
  giga-app-news-bot [--runOnce] [--intervalMinutes <n>] [--dryRun]

Core options:
  --directory, --dir        Peerbit data directory (default: ~/peerbit-giga-bots/news-bot)
  --network                 prod | local | offline (default: prod)
  --prod                    Alias for --network prod
  --local                   Alias for --network local (dials http://localhost:8082/peer/id)
  --offline                 Alias for --network offline (no dial/bootstrap)
  --intervalMs              Poll interval in milliseconds (default: 600000)
  --intervalMinutes         Poll interval in minutes (overrides default)
  --no-replicate            Disable root replication
  --no-runOnStart           Do not run immediately on start (continuous mode)
  --runOnce, --once         Run one cycle and exit (posts up to maxEventsPerRun)
  --dryRun                  Print post markdown instead of publishing
  --prefix                  Optional header prefix (default: empty)

Target (optional):
  --scopeAddress, --scope   Post within a specific Scope address
  --parentCanvasId, --parent Post under a specific parent Canvas id (base64/base64url of canvas.id)

News query options:
  --keyword                 Comma-separated keywords
  --lang                    Comma-separated languages (default: eng)
  --categoryUri             Category URI (EventRegistry)
  --locationUri             Location URI (Wikipedia URI)
  --maxEventsPerRun         How many events to post per run (default: 1)
  --maxArticlesPerEvent     How many articles to fetch per event (default: 50)

Event stream (minuteStreamEvents):
  --recentActivityEventsMaxEventCount       Max events returned per poll (default: 50, max: 2000)
  --recentActivityEventsUpdatesAfterMinsAgo Return events updated in last N minutes (default: derived from interval, max: 240)
  --recentActivityEventsUpdatesAfterTm      Return events updated after UTC time (YYYY-MM-DDTHH:MM:SS, max 4h old)

Images:
  --no-images               Disable lead image fetch + embedding
  --maxImageBytes           Max bytes to download per image (default: 3145728)
  --maxImageCandidates      Max articles to probe for an image (default: 5)
  --imageTimeoutMs          Timeout per image/HTML fetch (default: 12000)

Variants:
  --no-feed-summary         Skip AI feed summary (medium variant uses a truncate fallback)

Keys:
  --newsApiKey              NewsAPI.ai/EventRegistry API key (or NEWS_API_KEY / NEWSAPI_AI_KEY / EVENTREGISTRY_API_KEY)
  --openaiApiKey            OpenAI API key (or OPENAI_API_KEY)
  --openaiModel             OpenAI model (default: gpt-4o)

State:
  --statePath               Optional JSON snapshot of posted event URIs
`);
};

async function promptIfInteractive(defaults: CliArgs): Promise<CliArgs> {
    const directoryInput = await input({
        message: "Peerbit data directory",
        default: defaults.directory,
    });

    const network = await select({
        message: "Network",
        choices: [
            { name: "Prod (giga servers)", value: "prod" as const },
            { name: "Local relay", value: "local" as const },
            { name: "Offline (no dial/bootstrap)", value: "offline" as const },
        ],
        default:
            defaults.network === "offline"
                ? 2
                : defaults.network === "local"
                  ? 1
                  : 0,
    });

    const mode = await select({
        message: "Mode",
        choices: [
            { name: "Run continuously", value: "continuous" as const },
            {
                name: "Run once (post up to 1 event and exit)",
                value: "once" as const,
            },
        ],
        default: defaults.runOnce ? 1 : 0,
    });

    const intervalMinutes =
        mode === "continuous"
            ? await input({
                  message: "Interval (minutes)",
                  default: String(defaults.intervalMinutes ?? 30),
                  validate: (value) =>
                      Number.isFinite(Number(value)) && Number(value) >= 0
                          ? true
                          : "Enter a non-negative number",
              }).then((value) => Number(value))
            : undefined;

    const dryRun = await select({
        message: "Publish mode",
        choices: [
            { name: "Dry-run (print markdown)", value: true },
            { name: "Publish to network", value: false },
        ],
        default: defaults.dryRun ? 0 : 1,
    });

    const prefix = await input({
        message: "Header prefix (optional)",
        default: defaults.prefix ?? "",
    });

    const keywordRaw = await input({
        message: "Keyword(s) (comma-separated, optional)",
        default: typeof defaults.keyword === "string" ? defaults.keyword : "",
    });
    const keyword = parseList(keywordRaw);

    const langRaw = await input({
        message: "Language(s) (comma-separated)",
        default:
            typeof defaults.lang === "string"
                ? defaults.lang
                : Array.isArray(defaults.lang)
                  ? defaults.lang.join(",")
                  : "eng",
    });
    const lang = parseList(langRaw) ?? "eng";

    const maxArticlesPerEvent = await input({
        message: "Max articles per event",
        default: String(defaults.maxArticlesPerEvent ?? 10),
        validate: (value) =>
            Number.isFinite(Number(value)) && Number(value) >= 1
                ? true
                : "Enter a positive number",
    }).then((value) => Number(value));

    const effectiveIntervalMinutes =
        intervalMinutes ??
        (defaults.intervalMs != null
            ? Math.max(0, Math.ceil(defaults.intervalMs / 60_000))
            : (defaults.intervalMinutes ?? 10));
    const computedAfterMinsAgo = Math.min(
        240,
        Math.max(1, effectiveIntervalMinutes + 1)
    );

    const recentActivityEventsMaxEventCount = await input({
        message: "Event stream: max events per poll (1-2000)",
        default: String(defaults.recentActivityEventsMaxEventCount ?? 50),
        validate: (value) => {
            const n = Number(value);
            if (!Number.isFinite(n) || !Number.isInteger(n))
                return "Enter an integer";
            if (n < 1) return "Must be at least 1";
            if (n > 2000) return "Max is 2000";
            return true;
        },
    }).then((value) => Number(value));

    const recentActivityEventsUpdatesAfterMinsAgo = await input({
        message: "Event stream: lookback window minutes (1-240)",
        default: String(
            defaults.recentActivityEventsUpdatesAfterMinsAgo ??
                computedAfterMinsAgo
        ),
        validate: (value) => {
            const n = Number(value);
            if (!Number.isFinite(n) || !Number.isInteger(n))
                return "Enter an integer";
            if (n < 1) return "Must be at least 1";
            if (n > 240) return "Max is 240";
            return true;
        },
    }).then((value) => Number(value));

    const targetMode = await select({
        message: "Post target",
        choices: [
            { name: "Public Giga root (default)", value: "default" as const },
            { name: "Custom scope/canvas", value: "custom" as const },
        ],
        default: defaults.scopeAddress || defaults.parentCanvasId ? 1 : 0,
    });

    const scopeAddress =
        targetMode === "custom"
            ? (
                  await input({
                      message: "Scope address (optional)",
                      default: defaults.scopeAddress ?? "",
                  })
              ).trim() || undefined
            : undefined;

    const parentCanvasId =
        targetMode === "custom"
            ? (
                  await input({
                      message: "Parent canvas id (optional)",
                      default: defaults.parentCanvasId ?? "",
                  })
              ).trim() || undefined
            : undefined;

    return {
        ...defaults,
        directory: directoryInput,
        network,
        runOnce: mode === "once",
        intervalMinutes,
        dryRun,
        prefix,
        keyword,
        lang,
        maxArticlesPerEvent,
        recentActivityEventsMaxEventCount,
        recentActivityEventsUpdatesAfterMinsAgo,
        scopeAddress,
        parentCanvasId,
    };
}

export const start = async () => {
    if (getFlag("--help") || getFlag("-h")) {
        printHelp();
        return;
    }

    loadDotEnvIfPresent();

    const defaults = parseArgs();
    const interactive = getFlag("--interactive") || process.argv.length <= 2;
    const args = interactive ? await promptIfInteractive(defaults) : defaults;

    const newsApiKey =
        args.newsApiKey ||
        process.env.NEWS_API_KEY ||
        process.env.NEWSAPI_AI_KEY ||
        process.env.EVENTREGISTRY_API_KEY;
    const openaiApiKey = args.openaiApiKey || process.env.OPENAI_API_KEY;

    if (!newsApiKey) {
        throw new Error(
            "Missing NewsAPI.ai api key. Set NEWS_API_KEY / NEWSAPI_AI_KEY / EVENTREGISTRY_API_KEY or pass --newsApiKey."
        );
    }
    if (!openaiApiKey) {
        throw new Error(
            "Missing OpenAI API key. Set OPENAI_API_KEY or pass --openaiApiKey."
        );
    }

    if (args.directory && !fs.existsSync(args.directory)) {
        fs.mkdirSync(args.directory, { recursive: true });
    }

    const client = await Peerbit.create({
        directory: args.directory ?? undefined,
    });

    if (args.network === "offline") {
        console.log("Offline mode: skipping dial/bootstrap");
    } else if (args.network === "local") {
        const localPeerId = await (
            await fetch("http://localhost:8082/peer/id")
        ).text();
        await client.dial("/ip4/127.0.0.1/tcp/8002/ws/p2p/" + localPeerId);
        console.log("Dialed local node", localPeerId);
    } else {
        await client.bootstrap([...BOOTSTRAP_ADDRS]);
    }

    const statePath =
        args.statePath ||
        (args.directory
            ? path.join(args.directory, "state", "news-bot.json")
            : undefined);

    const bot = new NewsBot();
    try {
        await client.open(bot, {
            existing: "reuse",
            args: {
                replicate: args.replicate,
                scopeAddress: args.scopeAddress,
                parentCanvasId: args.parentCanvasId,
                intervalMs: args.intervalMs,
                intervalMinutes: args.intervalMinutes,
                runOnStart: args.runOnStart,
                runOnce: args.runOnce,
                dryRun: args.dryRun,
                prefix: args.prefix ?? "",

                newsApiKey,
                openaiApiKey,
                openaiModel: args.openaiModel,
                keyword: args.keyword,
                lang: args.lang ?? "eng",
                categoryUri: args.categoryUri,
                locationUri: args.locationUri,
                maxEventsPerRun: args.runOnce
                    ? (args.maxEventsPerRun ?? 1)
                    : args.maxEventsPerRun,
                maxArticlesPerEvent: args.maxArticlesPerEvent,
                statePath,

                recentActivityEventsMaxEventCount:
                    args.recentActivityEventsMaxEventCount,
                recentActivityEventsUpdatesAfterMinsAgo:
                    args.recentActivityEventsUpdatesAfterMinsAgo,
                recentActivityEventsUpdatesAfterTm:
                    args.recentActivityEventsUpdatesAfterTm,

                includeImages: args.includeImages,
                maxImageBytes: args.maxImageBytes,
                maxImageCandidates: args.maxImageCandidates,
                imageTimeoutMs: args.imageTimeoutMs,
                generateFeedSummary: args.generateFeedSummary,
            },
        });

        if (args.runOnce) {
            const summary = bot.getLastRunSummary();
            if (summary) printRunSummary(summary);
            await client.stop();
            return;
        }
    } catch (e) {
        if (args.runOnce) {
            const summary = bot.getLastRunSummary();
            if (summary) printRunSummary(summary);
            await client.stop();
        }
        throw e;
    }

    console.log("News bot running. Press Ctrl+C to stop.");
    const stop = async () => {
        console.log("Stopping...");
        await client.stop();
        process.exit(0);
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
};
