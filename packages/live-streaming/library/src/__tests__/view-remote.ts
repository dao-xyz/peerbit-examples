#!/usr/bin/env node
import { waitForResolved } from "@peerbit/time";
import { expect } from "chai";
process.addListener("unhandledRejection", (reason, promise) => {
    console.log("Unhandled Rejection at: ", promise, "reason: ", reason);
    // Application specific logging, throwing an error, or other logic here
    // process.exit(1);
});

import { Peerbit } from "peerbit";
import { MediaStreamDB, MediaStreamDBs } from "../index.js";
console.log(MediaStreamDBs, MediaStreamDB);

globalThis.requestAnimationFrame = (callback) => {
    return setTimeout(callback, 0);
};

const client = await Peerbit.create();
await client.bootstrap();
const videoStream = await client.open<MediaStreamDB>(
    "zb2rhXbUQc3A28nKNuB3povT1NgMcHV39gZd1uyLcvMzLWEnY"
);
await videoStream.tracks.log.waitForReplicators();

let chunks = 0;
let waitForChunks = 1;
let t0 = Date.now();
let t1 = 0;
console.log("Start iterating");
videoStream.iterate(0, {
    keepTracksOpen: true,
    debug: true,
    replicate: true,
    onProgress: (progress) => {
        console.log(
            "Progress: ",
            progress.track.startTime + progress.chunk.time
        );
        chunks++;
    },
    onTracksChange(tracks) {
        console.log("Tracks changed");
    },
});

try {
    await waitForResolved(() =>
        expect(chunks).to.be.greaterThanOrEqual(waitForChunks)
    );
    t1 = Date.now();
    console.log("Time taken: ", t1 - t0);
} finally {
    await client.stop();
}
