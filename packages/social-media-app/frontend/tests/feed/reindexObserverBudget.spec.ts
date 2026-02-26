import { test, expect } from "@playwright/test";
import { withSearchParams } from "../utils/url";
import { setupConsoleCapture } from "../utils/consoleCapture";
import {
    seedReplicatorPosts,
    startReplicator,
} from "../replicator/replicatorNode";

const BASE_HTTP = process.env.BASE_URL || "http://localhost:5190";
const SEED_COUNT = Number(process.env.PW_REINDEX_SEED_COUNT || "10");
const SETTLE_MS = Number(process.env.PW_REINDEX_SETTLE_MS || "2000");

test.describe("Feed observer reindex budget (replicator)", () => {
    test.setTimeout(240_000);

    let stop: (() => Promise<void>) | undefined;
    let bootstrap: string[] | undefined;
    let prefix: string | undefined;

    test.beforeAll(async () => {
        const { client, addrs, scope } = await startReplicator();
        bootstrap = addrs.map((a) => a.toString());
        prefix = `ReindexBudget ${Date.now()}:`;

        await seedReplicatorPosts({
            client,
            scope,
            count: SEED_COUNT,
            prefix,
        });

        stop = async () => {
            try {
                await client.stop();
            } catch {
                /* ignore */
            }
        };
    });

    test.afterAll(async () => {
        if (stop) await stop();
        stop = undefined;
        bootstrap = undefined;
        prefix = undefined;
    });

    test("non-replicating browser does not reindex remote feed canvases on initial load", async ({
        page,
    }, testInfo) => {
        setupConsoleCapture(page, testInfo, {
            printAll: false,
            capturePageErrors: true,
        });

        // Capture reindex scheduler + reIndex() debug events emitted from @giga-app/interface
        // (window.dispatchEvent(new CustomEvent("reindex:debug", { detail }))).
        await page.addInitScript(() => {
            const w: any = window as any;
            if (w.__PW_REINDEX_CAPTURED__) return;
            w.__PW_REINDEX_CAPTURED__ = true;
            w.__PW_REINDEX_EVENTS__ = [];
            w.__PW_REINDEX_COUNTS__ = {
                total: 0,
                runStart: 0,
                runStartFull: 0,
                runStartReplies: 0,
                fullBuildStart: 0,
                repliesUpdateStart: 0,
            };

            window.addEventListener(
                "reindex:debug",
                (evt: any) => {
                    const detail = evt?.detail;
                    if (!detail) return;
                    try {
                        const arr = w.__PW_REINDEX_EVENTS__;
                        if (Array.isArray(arr) && arr.length < 20_000) {
                            arr.push(detail);
                        }
                    } catch {
                        /* ignore */
                    }

                    const c = w.__PW_REINDEX_COUNTS__;
                    if (!c) return;
                    c.total += 1;
                    if (detail.phase === "run:start") {
                        c.runStart += 1;
                        if (detail.mode === "full") c.runStartFull += 1;
                        if (detail.mode === "replies") c.runStartReplies += 1;
                    }
                    if (detail.phase === "full:build:start") {
                        c.fullBuildStart += 1;
                    }
                    if (detail.phase === "replies:update:start") {
                        c.repliesUpdateStart += 1;
                    }
                },
                { passive: true }
            );
        });

        if (!prefix) throw new Error("Missing seed prefix");

        const url = withSearchParams(`${BASE_HTTP}#/?v=feed&s=best`, {
            ephemeral: true,
            bootstrap: (bootstrap || []).join(","),
        });
        await page.goto(url);

        // App ready
        await expect(page.getByTestId("toolbarcreatenew").first()).toBeVisible({
            timeout: 60_000,
        });

        const feed = page.getByTestId("feed");
        await expect(feed).toBeVisible({ timeout: 60_000 });
        // Ensure at least one seeded post is visible (connected to replicator source).
        await expect(feed).toContainText(prefix, { timeout: 180_000 });

        // Give the reindex scheduler time to flush any work triggered during initial sync.
        await page.waitForTimeout(SETTLE_MS);

        const stats = await page.evaluate(({ prefix }) => {
            const w: any = window as any;
            const events = (w.__PW_REINDEX_EVENTS__ || []) as any[];
            const counts = (w.__PW_REINDEX_COUNTS__ || {}) as any;

            const feed = document.querySelector(
                '[data-testid="feed"]'
            ) as HTMLElement | null;
            const nodes = feed
                ? Array.from(feed.querySelectorAll("[data-canvas-id-string]"))
                : [];
            const seededIds = Array.from(
                new Set(
                    nodes
                        .filter((el) =>
                            (el as HTMLElement).innerText.includes(prefix)
                        )
                        .map((el) => el.getAttribute("data-canvas-id-string"))
                        .filter((x): x is string => typeof x === "string" && x)
                )
            );

            const seededSet = new Set(seededIds);
            const runStarts = events.filter((e) => e?.phase === "run:start");

            const byCanvas: Record<
                string,
                { id: string; full: number; replies: number; total: number }
            > = {};
            for (const e of runStarts) {
                const id = e?.id;
                if (typeof id !== "string") continue;
                const entry =
                    byCanvas[id] ||
                    (byCanvas[id] = {
                        id,
                        full: 0,
                        replies: 0,
                        total: 0,
                    });
                entry.total += 1;
                if (e?.mode === "full") entry.full += 1;
                if (e?.mode === "replies") entry.replies += 1;
            }

            const seededRunStarts = runStarts.filter((e) =>
                seededSet.has(e?.id)
            );
            const seededRunsFull = seededRunStarts.filter(
                (e) => e?.mode === "full"
            ).length;
            const seededRunsReplies = seededRunStarts.filter(
                (e) => e?.mode === "replies"
            ).length;

            const top = Object.values(byCanvas)
                .sort((a, b) => b.total - a.total)
                .slice(0, 10);

            return {
                seededIds,
                seededRuns: {
                    total: seededRunStarts.length,
                    full: seededRunsFull,
                    replies: seededRunsReplies,
                },
                totals: {
                    runStart: Number(counts?.runStart || 0),
                    runStartFull: Number(counts?.runStartFull || 0),
                    runStartReplies: Number(counts?.runStartReplies || 0),
                    fullBuildStart: Number(counts?.fullBuildStart || 0),
                    repliesUpdateStart: Number(counts?.repliesUpdateStart || 0),
                    events: Number(counts?.total || 0),
                },
                top,
            };
        }, { prefix });

        await testInfo.attach("debug:reindexBudgetStats", {
            body: Buffer.from(JSON.stringify(stats, null, 2), "utf8"),
            contentType: "application/json",
        });

        // Assertion focus: the observer should not try to locally maintain indexes for remote feed canvases.
        // This is the "expensive" work we want to prevent/regress.
        expect(stats.seededRuns.full).toBe(0);
        expect(stats.seededRuns.replies).toBe(0);
    });
});

