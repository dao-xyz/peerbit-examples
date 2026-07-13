import assert from "node:assert/strict";
import test from "node:test";
import worker from "./cached-static-assets.mjs";

const media = Uint8Array.from({ length: 32 }, (_, index) => index);
const createEnv = () => {
    let assetRequest;
    return {
        get assetRequest() {
            return assetRequest;
        },
        ASSETS: {
            async fetch(request) {
                assetRequest = request;
                return new Response(media, {
                    headers: {
                        "Content-Length": String(media.byteLength),
                        "Content-Type": "video/mp4",
                        ETag: '"fixture"',
                    },
                });
            },
        },
        RANGE_MEDIA_PATHS: JSON.stringify(["/noise.mp4"]),
    };
};

test("returns a cacheable full representation for media range requests", async () => {
    const env = createEnv();
    const response = await worker.fetch(
        new Request("https://stream.example.invalid/noise.mp4", {
            headers: {
                Range: "bytes=4-7",
                "If-Range": '"fixture"',
            },
        }),
        env
    );

    assert.equal(env.assetRequest.headers.get("range"), null);
    assert.equal(env.assetRequest.headers.get("if-range"), null);
    assert.equal(env.assetRequest.headers.get("accept-encoding"), "identity");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.match(response.headers.get("cache-control"), /s-maxage=86400/);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), media);
});

test("leaves unrelated asset requests unchanged", async () => {
    const env = createEnv();
    const request = new Request("https://stream.example.invalid/index.html", {
        headers: { Range: "bytes=0-1" },
    });
    await worker.fetch(request, env);

    assert.equal(env.assetRequest.headers.get("range"), "bytes=0-1");
});
