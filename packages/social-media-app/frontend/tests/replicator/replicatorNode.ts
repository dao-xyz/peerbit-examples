import { Peerbit } from "peerbit";
import { createRootScope, Scope } from "@giga-app/interface";

export async function startReplicator() {
    const client = await Peerbit.create();

    // Open public root scope and set to replicate all
    const scope: Scope = await client.open(createRootScope(), {
        args: { replicate: { factor: 1 } },
        existing: "reuse",
    });

    const addrs = client.getMultiaddrs();
    return { client, addrs, scope };
}
