import { describe, it, expect } from "vitest";
import { Peerbit } from "peerbit";
import os from "os";
import path from "path";
import fs from "fs";
import { createHash } from "crypto";
import { BOOTSTRAP_ADDRS } from "@giga-app/network";
import { peerIdFromString } from "@libp2p/peer-id";
import { getPublicKeyFromPeerId } from "@peerbit/crypto";
import {
    Canvas,
    Element,
    Layout,
    MEDIUM_QUALITY,
    ReplyKind,
    StaticContent,
    StaticMarkdownText,
    createRoot,
    getOwnedElementsQuery,
} from "../../../../library/src/index.js";

function peerIdFromMultiaddr(addr: string): string | undefined {
    const marker = "/p2p/";
    const idx = addr.lastIndexOf(marker);
    if (idx === -1) return undefined;
    const after = addr.slice(idx + marker.length);
    const peerId = after.split("/")[0]?.trim();
    return peerId || undefined;
}

function peerHashFromMultiaddr(addr: string): string | undefined {
    const id = peerIdFromMultiaddr(addr);
    if (!id) return undefined;
    try {
        const peerId = peerIdFromString(id);
        return getPublicKeyFromPeerId(peerId).hashcode();
    } catch {
        return undefined;
    }
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withAbortTimeout<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number
): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(),
        Math.max(1_000, timeoutMs)
    );
    try {
        return await fn(controller.signal);
    } finally {
        clearTimeout(timeout);
    }
}

async function waitFor<T>(
    fn: () => Promise<T | undefined>,
    options: {
        timeoutMs: number;
        intervalMs?: number;
    }
): Promise<T> {
    const deadline = Date.now() + Math.max(1_000, options.timeoutMs);
    const interval = Math.max(50, options.intervalMs ?? 400);
    let lastError: unknown;

    while (Date.now() < deadline) {
        try {
            const out = await fn();
            if (out !== undefined) return out;
        } catch (e) {
            lastError = e;
        }
        await sleep(interval);
    }

    const suffix =
        lastError instanceof Error
            ? ` Last error: ${lastError.message}`
            : lastError
              ? ` Last error: ${String(lastError)}`
              : "";
    throw new Error(`Timed out after ${options.timeoutMs}ms.${suffix}`);
}

const itIfSmoke = process.env.NEWS_BOT_SMOKE_PROD === "1" ? it : it.skip;

describe("news-bot-cli (prod smoke)", () => {
    itIfSmoke(
        "publishes a simple post and confirms bootstrap can read it",
        { timeout: 240_000 },
        async () => {
            const bootstrapPeers = BOOTSTRAP_ADDRS.map(
                peerHashFromMultiaddr
            ).filter((x): x is string => !!x);
            expect(bootstrapPeers.length).toBeGreaterThan(0);

            const dir = path.join(
                os.tmpdir(),
                "giga-news-bot-cli-smoke",
                `${Date.now()}-${Math.random().toString(16).slice(2)}`
            );
            fs.mkdirSync(dir, { recursive: true });

            const client = await Peerbit.create({ directory: dir });
            try {
                await client.bootstrap([...BOOTSTRAP_ADDRS]);

                const { scope, canvas: root } = await createRoot(client, {
                    persisted: true,
                });

                await Promise.all([
                    scope.replies?.log?.waitForReplicators?.({
                        waitForNewPeers: true,
                        timeout: 20_000,
                    }),
                    scope.elements?.log?.waitForReplicators?.({
                        waitForNewPeers: true,
                        timeout: 20_000,
                    }),
                    scope.links?.log?.waitForReplicators?.({
                        waitForNewPeers: true,
                        timeout: 20_000,
                    }),
                ]);

                const selfHash = client.identity.publicKey.hashcode();
                let repliesPeers: string[] = [];
                let elementsPeers: string[] = [];

                const draft = new Canvas({
                    publicKey: client.identity.publicKey,
                });

                const [, post] = await scope.getOrCreateReply(root, draft, {
                    kind: new ReplyKind(),
                    visibility: "both",
                });

                const text =
                    `# Smoke test (news-bot-cli)\n\n` +
                    `Created: ${new Date().toISOString()}\n\n` +
                    `Id: ${Math.random().toString(16).slice(2)}\n`;
                const contentId = createHash("sha256").update(text).digest();

                const loc = Layout.zero();
                loc.y = 0;

                await post.createElement(
                    new Element({
                        location: loc,
                        publicKey: client.identity.publicKey,
                        canvasId: post.id,
                        content: new StaticContent({
                            content: new StaticMarkdownText({ text }),
                            quality: MEDIUM_QUALITY,
                            contentId,
                        }),
                    })
                );

                // Verify: post is discoverable on at least one remote replicator via remote-only query.
                await waitFor(
                    async () => {
                        if (!repliesPeers.length) {
                            try {
                                const cover =
                                    await scope.replies?.log?.getCover?.(
                                        { args: undefined },
                                        { eager: true, reachableOnly: true }
                                    );
                                repliesPeers = Array.isArray(cover)
                                    ? cover.filter((p) => p !== selfHash)
                                    : [];
                            } catch {
                                repliesPeers = [];
                            }
                            if (!repliesPeers.length)
                                repliesPeers = bootstrapPeers;
                        }

                        const indexed = await withAbortTimeout(
                            (signal) =>
                                scope.replies.index.get(post.id, {
                                    resolve: false,
                                    local: false,
                                    signal,
                                    remote: {
                                        from: repliesPeers,
                                        reach: { eager: true },
                                        strategy: "fallback",
                                        timeout: 10_000,
                                    },
                                }),
                            12_000
                        );
                        return indexed ?? undefined;
                    },
                    { timeoutMs: 90_000, intervalMs: 750 }
                );

                const elements = await waitFor(
                    async () => {
                        if (!elementsPeers.length) {
                            try {
                                const cover =
                                    await scope.elements?.log?.getCover?.(
                                        { args: undefined },
                                        { eager: true, reachableOnly: true }
                                    );
                                elementsPeers = Array.isArray(cover)
                                    ? cover.filter((p) => p !== selfHash)
                                    : [];
                            } catch {
                                elementsPeers = [];
                            }
                            if (!elementsPeers.length)
                                elementsPeers = bootstrapPeers;
                        }

                        const results = await withAbortTimeout(
                            (signal) =>
                                scope.elements.index
                                    .iterate(
                                        {
                                            query: getOwnedElementsQuery({
                                                id: post.id,
                                            }),
                                        },
                                        {
                                            resolve: false,
                                            local: false,
                                            signal,
                                            remote: {
                                                from: elementsPeers,
                                                reach: { eager: true },
                                                strategy: "fallback",
                                                timeout: 10_000,
                                            },
                                        }
                                    )
                                    .all(),
                            12_000
                        );
                        return results.length ? results : undefined;
                    },
                    { timeoutMs: 90_000, intervalMs: 750 }
                );
                expect(elements.length).toBeGreaterThanOrEqual(1);
            } finally {
                await client.stop();
            }
        }
    );
});
