import { Peerbit } from "peerbit";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    Canvas,
    createRoot,
    createRootScope,
    ReplyKind,
    Scope,
} from "@giga-app/interface";
import { create as createSimpleIndexer } from "@peerbit/indexer-simple";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";

export async function startReplicator() {
    // Important for e2e determinism: never use the default Peerbit directory, which can
    // leak state across local test runs and cause "missing message" seek failures.
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "giga-e2e-replicator-")
    );

    const client = await Peerbit.create({
        directory,
        // The node replicator doesn't need sqlite indexes; use the in-memory indexer
        // to drastically speed up bulk seeding in bench specs.
        indexer: createSimpleIndexer,
        libp2p: {
            connectionEncrypters: [noise()],
            addresses: {
                listen: ["/ip4/127.0.0.1/tcp/0/ws"],
            },
            transports: [webSockets({})],
            connectionManager: { maxConnections: 100 },
            connectionMonitor: { enabled: false },
        },
    });

    // Reduce flakiness: on cold starts the browser peer can take >10s before it starts
    // acknowledging seek-delivery messages. Bump timeouts so the node relay doesn't
    // emit unhandled DeliveryErrors during that window.
    try {
        const services: any = (client as any).services;
        const seekTimeoutMs = 60_000;
        if (typeof services?.pubsub?.seekTimeout === "number") {
            services.pubsub.seekTimeout = seekTimeoutMs;
        }
        if (typeof services?.blocks?.seekTimeout === "number") {
            services.blocks.seekTimeout = seekTimeoutMs;
        }
    } catch {
        /* ignore */
    }

    // Ensure temp directories are always cleaned up when the test shuts down.
    const originalStop = client.stop.bind(client);
    const isBenignStopError = (error: any): boolean => {
        const name = error?.name ?? error?.constructor?.name;
        const message = String(error?.message ?? "").toLowerCase();
        if (
            name === "AbortError" ||
            message === "aborterror" ||
            message.includes("operation was aborted") ||
            message.includes("fanout channel closed")
        ) {
            return true;
        }
        if (
            typeof AggregateError !== "undefined" &&
            error instanceof AggregateError &&
            Array.isArray((error as any).errors)
        ) {
            return (error as any).errors.every(isBenignStopError);
        }
        return false;
    };
    client.stop = (async (...args: any[]) => {
        try {
            await originalStop(...args);
        } catch (error: any) {
            if (!isBenignStopError(error)) {
                throw error;
            }
        } finally {
            try {
                fs.rmSync(directory, { recursive: true, force: true });
            } catch {
                /* ignore */
            }
        }
    }) as any;

    // Open public root scope and set to replicate all
    const scope: Scope = await client.open(createRootScope(), {
        // Use adaptive replication (replicate: true) so the node relay works with ephemeral browser
        // peers and doesn't require a fixed replica-set to acknowledge every delivery.
        args: { replicate: true },
        existing: "reuse",
    });

    const addrs = client.getMultiaddrs();
    try {
        const bootstrapAddrs = addrs.map((addr) => addr.toString());
        const services: any = (client as any).services;
        services?.fanout?.setBootstraps?.(bootstrapAddrs);
        services?.pubsub?.fanout?.setBootstraps?.(bootstrapAddrs);

        const selfHash = services?.pubsub?.publicKeyHash;
        if (selfHash) {
            services?.pubsub?.setTopicRootCandidates?.([selfHash]);
            services?.fanout?.topicRootControlPlane?.setTopicRootCandidates?.([
                selfHash,
            ]);
            services?.pubsub?.topicRootControlPlane?.setTopicRootCandidates?.([
                selfHash,
            ]);
            await services?.pubsub?.hostShardRootsNow?.();
        }
    } catch {
        // Best-effort bootstrap-root configuration for relay e2e only.
    }
    return { client, addrs, scope };
}

export async function seedReplicatorPosts(options: {
    client: Peerbit;
    scope?: Scope;
    count: number;
    prefix?: string;
    delayMs?: number;
}) {
    const { client, count, prefix, delayMs } = options;
    const { scope, canvas } = await createRoot(client, {
        scope: options.scope,
        replicate: true,
    });

    const root = await scope.openWithSameSettings(canvas);
    const messages: string[] = [];
    const posts: Canvas[] = [];
    await scope.suppressReindex(async () => {
        for (let i = 0; i < count; i++) {
            const msg = `${prefix ?? "E2E post"} ${i}`;
            const draft = new Canvas({
                publicKey: client.identity.publicKey,
                selfScope: scope,
            });
            const post = await scope.openWithSameSettings(draft);
            // Insert content first; indexing for the post happens when it is registered in replies.
            await post.addTextElement(msg, { skipReindex: true });
            // Ensure parent link exists before the first replies.put so the indexed row includes correct path/kind.
            await root.addReply(post, new ReplyKind(), "both");
            await scope.replies.put(post);
            messages.push(msg);
            posts.push(post);

            if (delayMs && i < count - 1) {
                await new Promise((r) => setTimeout(r, delayMs));
            }
        }
    });

    return { scope, root, messages, posts };
}

export async function addReplicatorReply(options: {
    client: Peerbit;
    scope: Scope;
    parent: Canvas;
    message: string;
    reindexParent?: boolean;
}) {
    const { client, scope, message } = options;
    const parent = await scope.openWithSameSettings(options.parent);

    const draft = new Canvas({
        publicKey: client.identity.publicKey,
        selfScope: scope,
    });
    const reply = await scope.openWithSameSettings(draft);
    await reply.addTextElement(message, { skipReindex: true });

    // Ensure parent link exists before the first replies.put so the indexed row includes correct path/kind.
    await parent.addReply(reply, new ReplyKind(), "both");
    await scope.replies.put(reply);

    if (options.reindexParent) {
        // Force an indexed reply-count refresh for the parent so UI peers can observe the update.
        // (Some listeners intentionally skip scheduling parent replies-only reindex on link changes.)
        await scope.reIndex(parent, { onlyReplies: true });
    }

    return { parent, reply };
}
