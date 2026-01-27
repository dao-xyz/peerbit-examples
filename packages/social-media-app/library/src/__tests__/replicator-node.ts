#!/usr/bin/env node

import { installProcessErrorFilter } from "../node/process-errors.js";
import { Peerbit } from "peerbit";
import { Canvas, Element, StaticContent } from "../content.js";
import { StaticMarkdownText } from "../static/text.js";
import { StaticPartialImage } from "../static/image.js";
import { createRoot } from "../root.js";

installProcessErrorFilter({
    mode: process.env.PEERBIT_TRANSIENT_ERRORS === "warn" ? "warn" : "silent",
    includeStack: process.env.PEERBIT_TRANSIENT_ERRORS_STACK === "1",
    failOnUnexpected: false,
});
console.log(
    Canvas,
    Element,
    StaticContent,
    StaticMarkdownText,
    StaticPartialImage
);
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

const { scope: capsule, canvas: root } = await createRoot(client, {
    persisted: true,
});

console.log(
    "Connected to scope: " +
        capsule.address +
        " with root canvas " +
        root.idString
);
