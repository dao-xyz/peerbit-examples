import { Peerbit } from "peerbit";
import {
    Canvas,
    createRoot,
    createRootScope,
    ReplyKind,
    Scope,
} from "@giga-app/interface";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";

export async function startReplicator() {
    const client = await Peerbit.create({
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
}) {
    const { client, count, prefix } = options;
    const { scope, canvas } = await createRoot(client, {
        scope: options.scope,
        persisted: true,
    });

    const root = await scope.openWithSameSettings(canvas);
    const messages: string[] = [];
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
        }
    });

    return { scope, root, messages };
}
