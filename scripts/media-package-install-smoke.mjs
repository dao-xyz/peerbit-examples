import assert from "node:assert/strict";
import { serialize } from "@dao-xyz/borsh";
import { Ed25519Keypair, PublicSignKey } from "@peerbit/crypto";
import {
    Chunk,
    MediaStreamDBs,
    MediaStreamInfo,
    VideoInfo,
} from "@peerbit/media-streaming";
import {
    ImageItems,
    NamedItems,
    PlayEvent,
    PlayStats,
    StoraOfLibraries,
} from "@peerbit/music-library-utils";

const keypair = await Ed25519Keypair.create();
assert.ok(keypair.publicKey instanceof PublicSignKey);

assert.ok(
    serialize(
        new Chunk({
            type: "key",
            chunk: Uint8Array.from([1, 2, 3, 4]),
            time: 42n,
        })
    ).byteLength > 0
);
assert.ok(
    serialize(
        new MediaStreamInfo({
            video: new VideoInfo({ width: 1920, height: 1080 }),
        })
    ).byteLength > 0
);

// This crosses the constructor-identity boundary that browser bundles and
// clean package consumers need to share with @peerbit/crypto.
assert.ok(
    serialize(new MediaStreamDBs({ owner: keypair.publicKey })).byteLength > 0
);

for (const program of [
    new StoraOfLibraries(),
    new NamedItems(),
    new ImageItems(),
    new PlayStats(),
]) {
    assert.ok(serialize(program).byteLength > 0);
}

assert.ok(
    serialize(
        new PlayEvent({
            duration: 1_000,
            source: new Uint8Array(32).fill(9),
        })
    ).byteLength > 0
);

console.log("Packed media package imports and serialization passed");
