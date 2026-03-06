import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Peerbit } from "peerbit";

export async function startBootstrapPeer() {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "file-share-e2e-bootstrap-")
    );

    const client = await Peerbit.create({
        directory,
        libp2p: {
            addresses: {
                listen: ["/ip4/127.0.0.1/tcp/0/ws"],
            },
            connectionManager: { maxConnections: 100 },
            connectionMonitor: { enabled: false },
        },
    });

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
        // Ignore optional tuning failures.
    }

    const stop = async () => {
        try {
            await client.stop();
        } finally {
            try {
                fs.rmSync(directory, { recursive: true, force: true });
            } catch {
                // Ignore best-effort cleanup failures.
            }
        }
    };

    return {
        addrs: client.getMultiaddrs().map((addr) => addr.toString()),
        client,
        stop,
    };
}
