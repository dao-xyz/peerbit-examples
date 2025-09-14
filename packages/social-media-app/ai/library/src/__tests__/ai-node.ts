#!/usr/bin/env node

process.addListener("unhandledRejection", (reason, promise) => {
    console.log("Unhandled Rejection at: ", promise, "reason: ", reason);
    // Application specific logging, throwing an error, or other logic here
    // process.exit(1);
});

import { Peerbit } from "peerbit";
import { CanvasAIReply } from "../ai-reply-program.js";
import { DEEP_SEEK_R1_1_5b } from "../model.js";
const client = await Peerbit.create();
console.log("Client created");
console.log("PeerId:", client.peerId.toString());
console.log(
    "Multiaddrs:",
    client
        .getMultiaddrs()
        .map((a) => a.toString())
        .join(", ")
);
// dial locally if env variable is set
const dial = process.env.DIAL_LOCAL === "true" || false;
if (dial) {
    const localPeerId = await (
        await fetch("http://localhost:8082/peer/id")
    ).text();
    await client.dial("/ip4/127.0.0.1/tcp/8002/ws/p2p/" + localPeerId);
}

const root = await client.open(new CanvasAIReply(), {
    args: { llm: "ollama", server: true, model: DEEP_SEEK_R1_1_5b },
    existing: "reuse",
});

console.log("Connected to scope: " + root.origin?.root.address);
