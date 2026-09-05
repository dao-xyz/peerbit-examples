import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import {
    merkleBenchmarkBytes,
    parseMerkleBenchmarkArguments,
    runMerkleBenchmark,
    summarizeMerkleBenchmark,
    verifyMerkleBenchmarkFile,
} from "./shared-fs-merkle-benchmark.mjs";

test("awaits crypto initialization before constructing the first fixture", async () => {
    // A separate process guarantees crypto has not already initialized in a
    // preceding test. Hold Wasm until the event loop becomes idle: this makes
    // readiness necessary without relying on a wall-clock delay.
    const script = `
        import assert from "node:assert/strict";
        const instantiate = WebAssembly.instantiate;
        let release;
        let keepAlive;
        let blockedCalls = 0;
        let releasedOnIdle = false;
        const gate = new Promise(resolve => { release = resolve; });
        const onIdle = () => {
            releasedOnIdle = true;
            // Wasm compilation alone does not keep Node's event loop alive.
            keepAlive = setInterval(() => {}, 100);
            release();
        };
        process.once("beforeExit", onIdle);
        WebAssembly.instantiate = async (...args) => {
            blockedCalls++;
            await gate;
            return instantiate(...args);
        };
        try {
            const { runMerkleBenchmark, parseMerkleBenchmarkArguments } =
                await import(${JSON.stringify(new URL("./shared-fs-merkle-benchmark.mjs", import.meta.url).href)});
            const events = [];
            await runMerkleBenchmark(parseMerkleBenchmarkArguments([
                "--sizes-mib", "1", "--leaves-kib", "64",
                "--cases", "random-overwrite-4096",
                "--samples", "1", "--warmups", "0"
            ]), event => events.push(event));
            assert(blockedCalls > 0);
            assert.equal(releasedOnIdle, true);
            assert.equal(events[0].type, "header");
            assert.equal(events.at(-1).type, "complete");
            assert.equal(events.at(-1).measuredSamples, 1);
            process.stdout.write("ready\\n");
        } finally {
            release();
            clearInterval(keepAlive);
            WebAssembly.instantiate = instantiate;
            process.removeListener("beforeExit", onIdle);
        }
    `;
    const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--input-type=module", "-e", script],
        { timeout: 15_000, maxBuffer: 1024 * 1024 }
    );
    assert.equal(stdout, "ready\n");
});

test("bounds large Map fixtures and rejects ambiguous matrix options", () => {
    assert.throws(
        () => parseMerkleBenchmarkArguments(["--sizes-mib", "1024"]),
        /Map fixtures/u
    );
    assert.equal(
        parseMerkleBenchmarkArguments([
            "--sizes-mib",
            "1024",
            "--store",
            "disk",
        ]).sizesMiB[0],
        1024
    );
    for (const argv of [
        ["--sizes-mib", "0"],
        ["--sizes-mib", "4,4"],
        ["--leaves-kib", "128"],
        ["--samples", "0"],
        ["--samples", "1", "--samples", "2"],
        ["--cases", "unknown"],
        ["--store", "filesystem"],
        ["--warmups", "1e2"],
    ])
        assert.throws(() => parseMerkleBenchmarkArguments(argv));
});

test("streamed oracle rejects corrupt bytes, incomplete reads and incorrect EOF", async () => {
    const size = 1024 * 1024 + 17;
    const expected = (offset, length) => merkleBenchmarkBytes(offset, length);
    const read = async (offset, length) =>
        expected(offset, Math.min(length, size - offset));
    const verified = await verifyMerkleBenchmarkFile(read, size, expected);
    assert.equal(verified.verifiedBytes, size);
    await assert.rejects(
        verifyMerkleBenchmarkFile(
            async (offset, length) => {
                const bytes = await read(offset, length);
                if (offset === 1024 * 1024) bytes[0] ^= 1;
                return bytes;
            },
            size,
            expected
        ),
        /wrong bytes/u
    );
    await assert.rejects(
        verifyMerkleBenchmarkFile(
            async (offset, length) => (await read(offset, length)).subarray(1),
            size,
            expected
        ),
        /short read/u
    );
    await assert.rejects(
        verifyMerkleBenchmarkFile(
            async (offset, length) =>
                offset === size ? Uint8Array.of(1) : read(offset, length),
            size,
            expected
        ),
        /beyond EOF/u
    );
});

test("Map and buffered disk produce equal complete outputs for every scenario", async () => {
    const options = parseMerkleBenchmarkArguments([
        "--sizes-mib",
        "1",
        "--leaves-kib",
        "64",
        "--samples",
        "1",
        "--warmups",
        "0",
    ]);
    const events = [];
    await runMerkleBenchmark(options, (event) => events.push(event));
    assert.equal(events.at(-1).type, "complete");
    const mapSamples = events.filter((event) => event.type === "sample");
    const diskEvents = [];
    await runMerkleBenchmark({ ...options, store: "disk" }, (event) =>
        diskEvents.push(event)
    );
    const diskSamples = diskEvents.filter((event) => event.type === "sample");
    assert.deepEqual(
        diskSamples.map(({ scenario, rootHash, verification }) => ({
            scenario,
            rootHash,
            verification,
        })),
        mapSamples.map(({ scenario, rootHash, verification }) => ({
            scenario,
            rootHash,
            verification,
        }))
    );
    assert.equal(
        events.find((event) => event.type === "fixture").storeCounts.dataBlocks,
        16
    );
    assert.notEqual(
        mapSamples.find((event) => event.scenario === "regrow-zero")
            .verification.sha256,
        mapSamples.find((event) => event.scenario === "sequential-read")
            .verification.sha256
    );
    assert.throws(
        () => summarizeMerkleBenchmark(options, mapSamples.slice(1)),
        /sample count/u
    );
    assert.throws(
        () =>
            summarizeMerkleBenchmark(options, [
                ...mapSamples.slice(1),
                mapSamples[1],
            ]),
        /incomplete cell/u
    );
    assert.throws(
        () =>
            summarizeMerkleBenchmark(
                options,
                mapSamples.map((sample, index) =>
                    index === 0
                        ? {
                              ...sample,
                              verification: {
                                  ...sample.verification,
                                  verifiedBytes: 0,
                              },
                          }
                        : sample
                )
            ),
        /unverified bytes/u
    );
});
