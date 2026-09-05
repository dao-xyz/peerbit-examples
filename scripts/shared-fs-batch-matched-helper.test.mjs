import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
    applyMeasuredRound,
    createMatchedFixture,
    measureMatchedOperation,
    normalizeMeasuredResults,
    parseMatchedArguments,
    seedMatchedFixture,
    verifyMatchedFixture,
} from "./shared-fs-batch-matched-helper.mjs";

const hash = (content) => createHash("sha256").update(content).digest("base64");

function fakeFs() {
    const dirs = new Set();
    const files = new Map();
    const calls = [];
    const fs = {
        dirs,
        files,
        calls,
        async mkdir(path) {
            dirs.add(path);
            calls.push(["mkdir", path]);
        },
        async writeFile(path, content) {
            calls.push(["writeFile", path, content]);
            const versions = files.get(path) ?? [];
            const result = {
                id: `${path}:${versions.length}`,
                nodeId: path,
                path,
                size: BigInt(Buffer.byteLength(content)),
                contentHash: hash(content),
                parentVersionIds: versions.length ? [versions.at(-1).id] : [],
                head: true,
                deleted: false,
                authorKey: "test-author",
                machineLabel: "matched-batch",
                createdAt: BigInt(versions.length),
            };
            versions.push({ ...result, content });
            files.set(path, versions);
            return result;
        },
        async writeBatch(entries) {
            calls.push(["writeBatch"]);
            const results = [];
            for (const entry of entries)
                results.push(await fs.writeFile(entry.path, entry.content));
            return { changesetId: "test-batch", results };
        },
        async readFile(path) {
            return Buffer.from(files.get(path).at(-1).content);
        },
        async versions(path) {
            return files.get(path).map((value, index, array) => ({
                ...value,
                head: index === array.length - 1,
            }));
        },
        async stat(path) {
            if (dirs.has(path)) return { kind: "directory" };
            return {
                kind: "file",
                versionId: files.get(path)?.at(-1).id,
                conflict: false,
                namingConflict: false,
            };
        },
        async list(path) {
            return [...dirs, ...files.keys()]
                .filter((item) => item.slice(0, item.lastIndexOf("/")) === path)
                .map((item) => ({ name: item.split("/").at(-1) }));
        },
        async conflicts() {
            return [];
        },
        async namingConflicts() {
            return [];
        },
        program: {
            entries: {
                index: {
                    iterate({ query }, options) {
                        assert.deepEqual(options, {
                            local: true,
                            remote: false,
                            resolve: false,
                        });
                        const versions = [...files.values()].reduce(
                            (sum, history) => sum + history.length,
                            0
                        );
                        const counts = {
                            "file-chunk": versions,
                            "file-version": versions,
                            naming: dirs.size + files.size,
                        };
                        return {
                            all: async () =>
                                Array(
                                    query.kind
                                        ? counts[query.kind]
                                        : Object.values(counts).reduce(
                                              (sum, count) => sum + count,
                                              0
                                          )
                                ).fill({}),
                        };
                    },
                },
            },
        },
    };
    return fs;
}

test("matched CLI is explicit, bounded and rejects ambiguous arguments", () => {
    assert.deepEqual(
        parseMatchedArguments([
            "--source-library",
            "/source/lib",
            "--auth",
            "root-key",
            "--order",
            "batch-first",
        ]),
        {
            sourceLibrary: "/source/lib",
            auth: "root-key",
            order: "batch-first",
        }
    );
    const valid = [
        "--source-library",
        "/source/lib",
        "--auth",
        "anonymous",
        "--order",
        "sequential-first",
    ];
    for (const args of [
        [],
        [...valid, "--files", "1"],
        [...valid, "--auth", "root-key"],
        [...valid, "--output"],
        [...valid, "--output", "relative.json"],
        ["--source-library", "relative", ...valid.slice(2)],
    ])
        assert.throws(() => parseMatchedArguments(args));
});

test("fixture preserves original payload and independent identical histories", () => {
    const fixture = createMatchedFixture();
    assert.equal(fixture.metadata.fileCount, 100);
    assert.equal(fixture.metadata.measuredBytes, 1_790);
    assert.equal(fixture.rounds[3][99].content, "round 3 content 99");
    assert.equal(fixture.rounds[0][0].path, "/project/a/file-0.txt");
    assert.equal(
        new Set(fixture.rounds.flat().map((entry) => entry.content)).size,
        400
    );
    assert.deepEqual(fixture, createMatchedFixture());
    fixture.rounds[0][0].content = "changed";
    assert.equal(
        createMatchedFixture().rounds[0][0].content,
        "round 0 content 0"
    );
    for (const count of [0, -1, 1.5, 101, NaN])
        assert.throws(() => createMatchedFixture(count));
});

test("both methods seed sequentially then verify complete tiny histories and counts", async () => {
    const fixture = createMatchedFixture(4);
    const outputs = [];
    for (const method of ["sequential", "batch"]) {
        const fs = fakeFs();
        const seeded = await seedMatchedFixture(fs, fixture);
        assert.equal(
            fs.calls.filter(([name]) => name === "writeFile").length,
            12
        );
        assert.equal(
            fs.calls.filter(([name]) => name === "writeBatch").length,
            0
        );
        assert.deepEqual(
            fs.calls
                .filter(([name]) => name === "writeFile")
                .map((call) => call[2]),
            fixture.rounds
                .slice(0, 3)
                .flat()
                .map((entry) => entry.content)
        );
        const measured = await applyMeasuredRound(
            fs,
            fixture.rounds[3],
            method
        );
        const result = await verifyMatchedFixture(
            fs,
            fixture,
            seeded,
            measured,
            method
        );
        assert.deepEqual(
            { ...result, contentSha256: undefined },
            {
                files: 4,
                returnedResults: 4,
                versions: 16,
                chunks: 16,
                naming: 9,
                documents: 41,
                heads: 4,
                contentSha256: undefined,
                verifiedBytes: 68,
            }
        );
        outputs.push(result);
    }
    assert.deepEqual(outputs[0], outputs[1]);
});

test("verification fails closed on wrong bytes, heads, or missing results", async () => {
    const fixture = createMatchedFixture(1);
    const fs = fakeFs();
    const seeded = await seedMatchedFixture(fs, fixture);
    const measured = await applyMeasuredRound(fs, fixture.rounds[3], "batch");
    const readFile = fs.readFile;
    fs.readFile = async () => Buffer.from("wrong");
    await assert.rejects(
        verifyMatchedFixture(fs, fixture, seeded, measured, "batch"),
        /Wrong bytes/
    );
    fs.readFile = readFile;
    const versions = fs.versions;
    fs.versions = async (path) =>
        (await versions(path)).map((version) => ({ ...version, head: true }));
    await assert.rejects(
        verifyMatchedFixture(fs, fixture, seeded, measured, "batch")
    );
    assert.throws(() =>
        normalizeMeasuredResults(
            { changesetId: "x", results: [undefined] },
            "batch",
            1
        )
    );
    assert.throws(() => normalizeMeasuredResults([], "sequential", 1));
});

test("measurement retains rejected operations and reports unavailable delay honestly", async () => {
    const cause = new Error("first failure");
    const result = await measureMatchedOperation(async () => {
        throw cause;
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, cause);
    assert(result.measurement.wallMs >= 0);
    assert(result.measurement.cpuUserMs >= 0);
    assert(result.measurement.cpuSystemMs >= 0);
    if (!result.measurement.eventLoopDelay.samples) {
        assert.equal(result.measurement.eventLoopDelay.meanMs, null);
        assert.equal(result.measurement.eventLoopDelay.maxMs, null);
    }
    assert.doesNotThrow(() => JSON.stringify(result.measurement));
});

test("verification rejects incorrect returned head, deletion, or provenance fields", async () => {
    const fixture = createMatchedFixture(1);
    const fs = fakeFs();
    const seeded = await seedMatchedFixture(fs, fixture);
    const measured = await applyMeasuredRound(fs, fixture.rounds[3], "batch");
    for (const [key, value] of [
        ["head", false],
        ["deleted", true],
        ["authorKey", "wrong"],
        ["machineLabel", "wrong"],
        ["createdAt", 999n],
    ]) {
        const invalid = {
            ...measured,
            results: [{ ...measured.results[0], [key]: value }],
        };
        await assert.rejects(
            verifyMatchedFixture(fs, fixture, seeded, invalid, "batch")
        );
    }
});
