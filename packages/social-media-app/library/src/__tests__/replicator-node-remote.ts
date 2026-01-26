#!/usr/bin/env node

import { installProcessErrorFilter } from "../node/process-errors.js";
import { Peerbit } from "peerbit";
import {
    Canvas,
    Element,
    getRepliesQuery,
    IndexableCanvas,
    IndexableElement,
    StaticContent,
} from "../content.js";
import { StaticMarkdownText } from "../static/text.js";
import { StaticPartialImage } from "../static/image.js";
import { Sort, SortDirection } from "@peerbit/document";
import { createRoot } from "../root.js";

installProcessErrorFilter({
    mode: process.env.PEERBIT_TRANSIENT_ERRORS === "warn" ? "warn" : "silent",
    includeStack: process.env.PEERBIT_TRANSIENT_ERRORS_STACK === "1",
    failOnUnexpected: false,
});
console.log(
    Canvas,
    IndexableCanvas,
    IndexableElement,
    Element,
    StaticContent,
    StaticMarkdownText,
    StaticPartialImage
);
const client = await Peerbit.create();
await client.bootstrap();
const { canvas: root, scope: capsule } = await createRoot(client, {
    persisted: true,
});

console.log(
    "Connected to scope: " +
    capsule.address +
    " with root canvas " +
    root.idString
);
await root.replies.log.waitForReplicators();
const iterator = root.replies.index.iterate({
    query: getRepliesQuery(root),
    sort: new Sort({ key: "replies", direction: SortDirection.DESC }),
});
const tenMostCommented = await iterator.next(10);
console.log(
    "Ten most commented: ",
    tenMostCommented.map((e) => e.id.toString())
);
await iterator.close();
await client.stop();
