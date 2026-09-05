import assert from "node:assert/strict";
import { test } from "node:test";
import {
    merkleBenchmarkBytes,
    parseMerkleBenchmarkArguments,
    runMerkleBenchmark,
    summarizeMerkleBenchmark,
    verifyMerkleBenchmarkFile,
} from "./shared-fs-merkle-benchmark.mjs";

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
