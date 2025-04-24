#!/usr/bin/env node

process.addListener("unhandledRejection", (reason, promise) => {
    console.log("Unhandled Rejection at: ", promise, "reason: ", reason);
    // Application specific logging, throwing an error, or other logic here
    // process.exit(1);
});

import { Peerbit } from "peerbit";
import { rootDevelopment } from "../root.js";
import {
    Canvas,
    Element,
    getOwnedElementsQuery,
    StaticContent,
} from "../content.js";
import { StaticMarkdownText } from "../static/text.js";
import { StaticPartialImage } from "../static/image.js";
import { Sort, SortDirection } from "@peerbit/document";
console.log(
    Canvas,
    Element,
    StaticContent,
    StaticMarkdownText,
    StaticPartialImage
);
const client = await Peerbit.create();
await client.bootstrap();
const root = await client.open(rootDevelopment);

console.log("Connected to root: " + rootDevelopment.address);
await root.replies.log.waitForReplicators();
const iterator = root.replies.index.iterate({
    query: getOwnedElementsQuery(root),
    sort: new Sort({ key: "replies", direction: SortDirection.DESC }),
});
const tenMostCommented = await iterator.next(10);
console.log(
    "Ten most commented: ",
    tenMostCommented.map((e) => e.id.toString())
);
await iterator.close();
await client.stop();
