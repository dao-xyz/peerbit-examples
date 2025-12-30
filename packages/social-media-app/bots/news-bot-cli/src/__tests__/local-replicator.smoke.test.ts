import { describe, it, expect } from "vitest";
import { TestSession } from "@peerbit/test-utils";
import { createHash } from "crypto";

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

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
    fn: () => Promise<T | undefined>,
    options: { timeoutMs: number; intervalMs?: number }
): Promise<T> {
    const deadline = Date.now() + Math.max(1_000, options.timeoutMs);
    const interval = Math.max(50, options.intervalMs ?? 250);
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

describe("news-bot-cli (local replicator smoke)", () => {
    it(
        "publishes a post and verifies it via remote-only queries to a second peer",
        { timeout: 120_000 },
        async () => {
            const session = await TestSession.connected(2);
            try {
                const publisher = session.peers[0];
                const replicator = session.peers[1];

                const { scope, canvas: root } = await createRoot(publisher, {
                    persisted: true,
                });
                await createRoot(replicator, { persisted: true });

                const draft = new Canvas({
                    publicKey: publisher.identity.publicKey,
                });
                const [, post] = await scope.getOrCreateReply(root, draft, {
                    kind: new ReplyKind(),
                    visibility: "both",
                });

                const text =
                    `# Local replicator smoke\n\n` +
                    `Created: ${new Date().toISOString()}\n\n` +
                    `Id: ${Math.random().toString(16).slice(2)}\n`;

                const contentId = createHash("sha256").update(text).digest();
                const loc = Layout.zero();
                loc.y = 0;

                await post.createElement(
                    new Element({
                        location: loc,
                        publicKey: publisher.identity.publicKey,
                        canvasId: post.id,
                        content: new StaticContent({
                            content: new StaticMarkdownText({ text }),
                            quality: MEDIUM_QUALITY,
                            contentId,
                        }),
                    })
                );

                const remotePeer = replicator.identity.publicKey.hashcode();

                // replies index via remote-only query
                const indexed = await waitFor(
                    async () => {
                        const row = await scope.replies.index.get(post.id, {
                            resolve: false,
                            local: false,
                            remote: {
                                from: [remotePeer],
                                reach: { eager: true },
                                strategy: "fallback",
                                timeout: 5_000,
                            },
                        });
                        return row ?? undefined;
                    },
                    { timeoutMs: 30_000, intervalMs: 400 }
                );
                expect(indexed).toBeTruthy();

                // elements index via remote-only query
                const elements = await waitFor(
                    async () => {
                        const rows = await scope.elements.index
                            .iterate(
                                {
                                    query: getOwnedElementsQuery({
                                        id: post.id,
                                    }),
                                },
                                {
                                    resolve: false,
                                    local: false,
                                    remote: {
                                        reach: {
                                            eager: true,
                                            discover: [
                                                replicator.identity.publicKey,
                                            ],
                                        },
                                        strategy: "fallback",
                                        timeout: 5_000,
                                    },
                                }
                            )
                            .all();
                        return rows.length ? rows : undefined;
                    },
                    { timeoutMs: 30_000, intervalMs: 400 }
                );
                expect(elements.length).toBeGreaterThanOrEqual(1);
            } finally {
                await session.stop();
            }
        }
    );
});
