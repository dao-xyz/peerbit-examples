import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
    monitorEventLoopDelay,
    performance,
    PerformanceObserver,
} from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";

export const sha256 = (value) =>
    createHash("sha256").update(value).digest("hex");

export function parseMatchedArguments(args) {
    const allowed = new Set([
        "--source-library",
        "--auth",
        "--order",
        "--output",
    ]);
    const values = new Map();
    for (let i = 0; i < args.length; i += 2) {
        const flag = args[i];
        assert(allowed.has(flag), `Unknown argument: ${flag}`);
        assert(!values.has(flag), `Repeated argument: ${flag}`);
        assert(args[i + 1] && !args[i + 1].startsWith("--"), `Missing ${flag}`);
        values.set(flag, args[i + 1]);
    }
    const sourceLibrary = values.get("--source-library");
    const auth = values.get("--auth");
    const order = values.get("--order");
    const output = values.get("--output");
    assert(
        sourceLibrary && isAbsolute(sourceLibrary),
        "Absolute --source-library required"
    );
    assert(["anonymous", "root-key"].includes(auth), "Invalid --auth");
    assert(
        ["sequential-first", "batch-first"].includes(order),
        "Invalid --order"
    );
    assert(
        output === undefined || isAbsolute(output),
        "--output must be absolute"
    );
    return { sourceLibrary, auth, order, ...(output ? { output } : {}) };
}

/** The CLI always uses 100 files; smaller fixtures are for untimed helper tests. */
export function createMatchedFixture(fileCount = 100) {
    assert(
        Number.isSafeInteger(fileCount) && fileCount > 0 && fileCount <= 100
    );
    const directories = [
        "/project",
        ...["a", "b", "c", "d"].map((d) => `/project/${d}`),
    ];
    const rounds = Array.from({ length: 4 }, (_, round) =>
        Array.from({ length: fileCount }, (_, i) => ({
            path: `/project/${["a", "b", "c", "d"][i % 4]}/file-${i}.txt`,
            content: `round ${round} content ${i}`,
        }))
    );
    const measuredBytes = rounds[3].reduce(
        (sum, entry) => sum + Buffer.byteLength(entry.content),
        0
    );
    return {
        directories,
        rounds,
        metadata: {
            sha256: sha256(JSON.stringify({ directories, rounds })),
            fileCount,
            seedRounds: [0, 1, 2],
            measuredRound: 3,
            payloadFormula: "round ${round} content ${i}",
            pathFormula: "/project/${['a','b','c','d'][i%4]}/file-${i}.txt",
            measuredBytes,
            roundSha256: rounds.map((entries) =>
                sha256(JSON.stringify(entries))
            ),
        },
    };
}

export async function seedMatchedFixture(fs, fixture) {
    for (const path of fixture.directories) await fs.mkdir(path);
    const seeded = [];
    for (const entries of fixture.rounds.slice(0, 3)) {
        const results = [];
        for (const entry of entries)
            results.push(await fs.writeFile(entry.path, entry.content));
        seeded.push(results);
    }
    return seeded;
}

/** Minimal result accumulation only; verification and hashing stay outside. */
export async function applyMeasuredRound(fs, entries, method) {
    if (method === "batch") return fs.writeBatch(entries);
    if (method !== "sequential") throw new Error(`Invalid method: ${method}`);
    const results = [];
    for (const entry of entries)
        results.push(await fs.writeFile(entry.path, entry.content));
    return results;
}

export function normalizeMeasuredResults(value, method, count) {
    const results = method === "batch" ? value?.results : value;
    assert(Array.isArray(results), "Missing write results");
    assert.equal(results.length, count, "Wrong returned result count");
    assert(results.every(Boolean), "Unexpected skipped/no-op result");
    if (method === "batch") {
        assert(
            typeof value.changesetId === "string" &&
                value.changesetId.length > 0
        );
        assert.equal(value.manifest, undefined, "Unexpected manifest");
        assert.equal(
            value.skipped?.length ?? 0,
            0,
            "Unexpected ignored entries"
        );
    }
    return results;
}

const contentHash = (content) =>
    createHash("sha256").update(content).digest("base64");

export async function verifyMatchedFixture(
    fs,
    fixture,
    seeded,
    measured,
    method
) {
    const fileCount = fixture.metadata.fileCount;
    const finalResults = normalizeMeasuredResults(measured, method, fileCount);
    const histories = [...seeded, finalResults];
    assert.equal(histories.length, 4);
    const allIds = new Set();
    let heads = 0;
    const verified = [];
    for (let i = 0; i < fileCount; i++) {
        const { path, content } = fixture.rounds[3][i];
        const bytes = await fs.readFile(path);
        assert(bytes instanceof Uint8Array, `Missing bytes: ${path}`);
        assert.deepEqual(
            Buffer.from(bytes),
            Buffer.from(content),
            `Wrong bytes: ${path}`
        );
        const versions = await fs.versions(path);
        assert.equal(versions.length, 4, `Wrong history length: ${path}`);
        const byId = new Map(versions.map((version) => [version.id, version]));
        const nodeId = finalResults[i].nodeId;
        for (let round = 0; round < 4; round++) {
            const result = histories[round][i];
            assert(
                result && typeof result.id === "string" && result.id.length > 0
            );
            assert(!allIds.has(result.id), "Repeated returned version id");
            allIds.add(result.id);
            assert.equal(
                result.head,
                true,
                "Result was not a head when written"
            );
            const stored = byId.get(result.id);
            assert(stored, `Returned version missing from history: ${path}`);
            for (const key of ["authorKey", "machineLabel", "createdAt"])
                assert.equal(
                    result[key],
                    stored[key],
                    `Returned ${key} mismatch: ${path}`
                );
            assert(
                typeof result.authorKey === "string" &&
                    result.authorKey.length > 0
            );
            assert(typeof result.machineLabel === "string");
            assert(
                typeof result.createdAt === "bigint" && result.createdAt >= 0n
            );
            const expectedHash = contentHash(fixture.rounds[round][i].content);
            const parents = round ? [histories[round - 1][i].id] : [];
            for (const version of [result, stored]) {
                assert(
                    version,
                    `Returned version missing from history: ${path}`
                );
                assert.equal(version.path, path);
                assert.equal(version.nodeId, nodeId);
                assert.equal(
                    version.size,
                    BigInt(Buffer.byteLength(fixture.rounds[round][i].content))
                );
                assert.equal(version.contentHash, expectedHash);
                assert.equal(version.deleted, false);
                assert.deepEqual(version.parentVersionIds, parents);
            }
        }
        const currentHeads = versions.filter((version) => version.head);
        assert.deepEqual(
            currentHeads.map((version) => version.id),
            [finalResults[i].id]
        );
        heads += currentHeads.length;
        const stat = await fs.stat(path);
        assert.equal(stat?.kind, "file");
        assert.equal(stat.versionId, finalResults[i].id);
        assert.equal(stat.conflict, false);
        assert.notEqual(stat.namingConflict, true);
        verified.push({
            path,
            sha256: sha256(bytes),
            versions: versions.length,
        });
    }
    for (const directory of fixture.directories) {
        assert.equal((await fs.stat(directory))?.kind, "directory");
        const expected =
            directory === "/project"
                ? ["a", "b", "c", "d"]
                : fixture.rounds[3]
                      .filter((entry) => entry.path.startsWith(`${directory}/`))
                      .map((entry) => entry.path.split("/").at(-1));
        assert.deepEqual(
            (await fs.list(directory)).map((entry) => entry.name).sort(),
            expected.sort()
        );
    }
    assert.deepEqual(await fs.conflicts(), []);
    assert.deepEqual(await fs.namingConflicts(), []);
    const countRows = async (query) =>
        (
            await fs.program.entries.index
                .iterate(
                    { query },
                    { local: true, remote: false, resolve: false }
                )
                .all()
        ).length;
    const documents = await countRows([]);
    const chunks = await countRows({ kind: "file-chunk" });
    const versions = await countRows({ kind: "file-version" });
    const naming = await countRows({ kind: "naming" });
    assert.equal(chunks, fileCount * 4);
    assert.equal(versions, fileCount * 4);
    assert.equal(naming, fileCount + fixture.directories.length);
    assert.equal(documents, chunks + versions + naming);
    return {
        files: fileCount,
        returnedResults: finalResults.length,
        versions,
        chunks,
        naming,
        documents,
        heads,
        contentSha256: sha256(JSON.stringify(verified)),
        verifiedBytes: fixture.metadata.measuredBytes,
    };
}

/** Process-wide counters include asynchronous work, not only filesystem CPU. */
export async function measureMatchedOperation(operation) {
    let start = Infinity;
    let end = Infinity;
    const gc = { count: 0, sumMs: 0, maxMs: 0 };
    const collect = (entries) => {
        for (const entry of entries) {
            if (entry.startTime < start || entry.startTime > end) continue;
            gc.count++;
            gc.sumMs += entry.duration;
            gc.maxMs = Math.max(gc.maxMs, entry.duration);
        }
    };
    const observer = new PerformanceObserver((list) =>
        collect(list.getEntries())
    );
    observer.observe({ entryTypes: ["gc"] });
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    await setImmediate();
    delay.reset();
    const memoryBefore = process.memoryUsage();
    const cpuBefore = process.cpuUsage();
    const eluBefore = performance.eventLoopUtilization();
    start = performance.now();
    let value;
    let error;
    let ok = false;
    try {
        value = await operation();
        ok = true;
    } catch (caught) {
        error = caught;
    } finally {
        end = performance.now();
    }
    const cpu = process.cpuUsage(cpuBefore);
    const elu = performance.eventLoopUtilization(eluBefore);
    delay.disable();
    const memoryAfter = process.memoryUsage();
    await setImmediate();
    collect(observer.takeRecords());
    observer.disconnect();
    const delaySamples = Number(delay.count);
    return {
        ok,
        value,
        error,
        measurement: {
            wallMs: end - start,
            cpuUserMs: cpu.user / 1_000,
            cpuSystemMs: cpu.system / 1_000,
            eventLoopUtilization: elu,
            eventLoopDelay: {
                resolutionMs: 10,
                samples: delaySamples,
                meanMs: delaySamples ? delay.mean / 1e6 : null,
                maxMs: delaySamples ? delay.max / 1e6 : null,
            },
            gc,
            memoryBefore,
            memoryAfter,
        },
    };
}
