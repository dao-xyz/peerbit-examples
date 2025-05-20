#!/usr/bin/env node

process.addListener("unhandledRejection", (reason, promise) => {
    console.log("Unhandled Rejection at: ", promise, "reason: ", reason);
    // Application specific logging, throwing an error, or other logic here
    // process.exit(1);
});

import { Peerbit } from "peerbit";
import { NamedItems, StoraOfLibraries } from "../index.js";
console.log(!!StoraOfLibraries, !!NamedItems); // effect import

const client = await Peerbit.create();
console.log("Client created: ", client.identity.publicKey.hashcode());
const localPeerId = await (await fetch("http://localhost:8082/peer/id")).text();
await client.dial("/ip4/127.0.0.1/tcp/8002/ws/p2p/" + localPeerId);
const streams = await client.open(new StoraOfLibraries(), {
    args: {
        replicate: true,
    },
});

const names = await client.open(new NamedItems(), {
    args: {
        replicate: true,
    },
});

console.log("Libraries root: " + streams.address);
console.log("Names root: " + names.address);
