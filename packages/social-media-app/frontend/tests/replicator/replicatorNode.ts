import { Peerbit } from "peerbit";
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
    const client = await Peerbit.create({
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

    // Open public root scope and set to replicate all
    const scope: Scope = await client.open(createRootScope(), {
        args: { replicate: { factor: 1 } },
        existing: "reuse",
    });

    const addrs = client.getMultiaddrs();
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
        persisted: true,
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
