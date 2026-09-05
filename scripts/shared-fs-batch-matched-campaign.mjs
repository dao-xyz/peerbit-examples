import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
    createWriteStream,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(script));
const worker = path.join(root, "scripts/shared-fs-batch-matched-worker.mjs");
const prefix = "SHARED_FS_BATCH_MATCHED_RESULT ";
const timeoutMs = 240_000;
const sha = (data) => createHash("sha256").update(data).digest("hex");
const hashFile = (file) => sha(readFileSync(file));
const json = (file, value) =>
    writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });

export function campaignPlan() {
    const block = [
        ["baseline", "sequential-first"],
        ["candidate", "sequential-first"],
        ["candidate", "batch-first"],
        ["baseline", "batch-first"],
        ["candidate", "sequential-first"],
        ["baseline", "sequential-first"],
        ["baseline", "batch-first"],
        ["candidate", "batch-first"],
    ];
    return ["anonymous", "root-key"].flatMap((auth, group) =>
        block.map(([source, order], index) => ({
            id: group * 8 + index + 1,
            auth,
            source,
            order,
            pair: group * 4 + Math.floor(index / 2) + 1,
        }))
    );
}

function treeHashes(directory, relative = "") {
    return readdirSync(path.join(directory, relative), { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((entry) => {
            if (entry.name === "__tests__") return [];
            const name = path.join(relative, entry.name);
            return entry.isDirectory()
                ? treeHashes(directory, name)
                : [[name, hashFile(path.join(directory, name))]];
        });
}

function dependency(name, from) {
    const resolver = createRequire(from);
    let entry;
    // Peerbit packages intentionally expose import-only entries. Use the
    // supplied source's package search path, never this helper's import graph.
    for (const location of resolver.resolve.paths(name) ?? []) {
        const manifest = path.join(location, name, "package.json");
        if (!existsSync(manifest)) continue;
        const info = JSON.parse(readFileSync(manifest, "utf8"));
        if (info.name !== name)
            throw new Error(`Unexpected package: ${manifest}`);
        const exported = info.exports?.["."] ?? info.exports;
        const target =
            typeof exported === "string" ? exported : exported?.import;
        entry =
            typeof target === "string"
                ? path.resolve(path.dirname(manifest), target)
                : resolver.resolve(name);
        break;
    }
    if (!entry) throw new Error(`Dependency missing: ${name}`);
    let directory = path.dirname(realpathSync(entry));
    while (true) {
        const manifest = path.join(directory, "package.json");
        if (existsSync(manifest)) {
            const info = JSON.parse(readFileSync(manifest, "utf8"));
            if (info.name === name) {
                return {
                    name,
                    version: info.version,
                    entry: realpathSync(entry),
                    entrySha256: hashFile(entry),
                    manifest,
                    manifestSha256: hashFile(manifest),
                };
            }
        }
        const parent = path.dirname(directory);
        if (parent === directory) throw new Error(`Manifest missing: ${name}`);
        directory = parent;
    }
}

export function provenance(source) {
    const library = path.join(source, "packages/shared-fs/library");
    const manifest = path.join(library, "package.json");
    const deps = [
        "peerbit",
        "@peerbit/document",
        "@peerbit/program",
        "@peerbit/trusted-network",
        "@peerbit/crypto",
        "@dao-xyz/borsh",
        "tsx",
    ].map((name) => dependency(name, manifest));
    deps.push(
        dependency(
            "@peerbit/shared-log",
            deps.find((item) => item.name === "@peerbit/document").manifest
        )
    );
    return {
        source,
        library,
        productionFiles: treeHashes(path.join(library, "src")),
        lockSha256: hashFile(path.join(source, "pnpm-lock.yaml")),
        manifestSha256: hashFile(manifest),
        dependencies: deps,
    };
}

export function assertMatchedCohort(sources) {
    assert.equal(
        sources.baseline.lockSha256,
        sources.candidate.lockSha256,
        "Different lockfiles cannot enter this matched campaign"
    );
    assert.equal(
        sources.baseline.manifestSha256,
        sources.candidate.manifestSha256,
        "Different library manifests cannot enter this matched campaign"
    );
    assert.deepEqual(
        sources.baseline.dependencies,
        sources.candidate.dependencies,
        "Different resolved dependency cohorts cannot enter this matched campaign"
    );
}

function harnessHashes() {
    const scripts = readdirSync(path.dirname(script))
        .filter((name) => name.startsWith("shared-fs-batch-matched-"))
        .sort()
        .map((name) => [name, hashFile(path.join(path.dirname(script), name))]);
    return [
        ...scripts,
        [
            "BATCH_MATCHED_DESIGN.md",
            hashFile(
                path.join(root, "packages/shared-fs/BATCH_MATCHED_DESIGN.md")
            ),
        ],
    ];
}

async function runCell(cell, source, out) {
    const name = `${String(cell.id).padStart(2, "0")}-${cell.auth}-${cell.source}-${cell.order}`;
    const raw = path.join(out, `${name}.raw.log`);
    const rawStream = createWriteStream(raw, { flags: "wx" });
    const startedAt = new Date().toISOString();
    const start = performance.now();
    let timedOut = false;
    const child = spawn(
        process.execPath,
        [
            "--import",
            "tsx",
            worker,
            "--source-library",
            source.library,
            "--auth",
            cell.auth,
            "--order",
            cell.order,
        ],
        { cwd: source.library, stdio: ["ignore", "pipe", "pipe"] }
    );
    child.stdout.pipe(rawStream, { end: false });
    child.stderr.pipe(rawStream, { end: false });
    // Timeout is a retained failure, never a success exit substitute.
    const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
    }, timeoutMs);
    const exit = await new Promise((resolve) => {
        child.once("error", (error) => resolve({ error: String(error) }));
        child.once("close", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);
    await new Promise((resolve, reject) => {
        rawStream.once("error", reject);
        rawStream.end(resolve);
    });
    let report;
    let parseError;
    try {
        const records = readFileSync(raw, "utf8")
            .split("\n")
            .filter((line) => line.startsWith(prefix));
        if (records.length !== 1) {
            throw new Error(
                `Expected exactly one result; got ${records.length}`
            );
        }
        report = JSON.parse(records[0].slice(prefix.length));
        if (
            report.schemaVersion !== 1 ||
            report.ok !== true ||
            report.auth !== cell.auth ||
            report.order !== cell.order ||
            report.sourceLibrary !== source.library
        ) {
            throw new Error(
                "Worker result failed schema/identity/success contract"
            );
        }
    } catch (error) {
        parseError = String(error);
    }
    const result = {
        ...cell,
        startedAt,
        elapsedMs: performance.now() - start,
        pid: child.pid,
        exit,
        timedOut,
        success: exit.code === 0 && !timedOut && !parseError,
        raw,
        rawSha256: hashFile(raw),
        parseError,
        report,
    };
    json(path.join(out, `${name}.json`), result);
    console.log(
        JSON.stringify({
            event: "cell-complete",
            ...cell,
            success: result.success,
            elapsedMs: result.elapsedMs,
            pid: child.pid,
        })
    );
    return result;
}

async function main() {
    const [baseline, candidate, out] = process.argv.slice(2);
    if (
        ![baseline, candidate, out].every(
            (value) => value && path.isAbsolute(value)
        )
    ) {
        throw new Error(
            "Usage: node campaign.mjs ABS_BASELINE ABS_CANDIDATE ABS_NEW_OUTPUT_DIR"
        );
    }
    mkdirSync(out); // Refuse to overwrite or resume a prior campaign.
    const sources = {
        baseline: provenance(baseline),
        candidate: provenance(candidate),
    };
    assertMatchedCohort(sources);
    const before = { sources, harness: harnessHashes() };
    json(path.join(out, "predeclared.json"), {
        schema: 1,
        startedAt: new Date().toISOString(),
        runtime: {
            node: process.version,
            versions: process.versions,
            execPath: process.execPath,
            execArgv: process.execArgv,
            platform: os.platform(),
            release: os.release(),
            arch: os.arch(),
            cpus: os.cpus().map(({ model }) => model),
            memoryBytes: os.totalmem(),
            load: os.loadavg(),
        },
        timeoutMs,
        plan: campaignPlan(),
        before,
    });
    const results = [];
    for (const cell of campaignPlan())
        results.push(await runCell(cell, sources[cell.source], out));
    const after = {
        sources: {
            baseline: provenance(baseline),
            candidate: provenance(candidate),
        },
        harness: harnessHashes(),
    };
    const unchanged = JSON.stringify(before) === JSON.stringify(after);
    json(path.join(out, "completed.json"), {
        schema: 1,
        completedAt: new Date().toISOString(),
        unchanged,
        after,
        results,
    });
    console.log(
        JSON.stringify({
            event: "campaign-complete",
            unchanged,
            passed: results.filter((item) => item.success).length,
            planned: results.length,
        })
    );
    if (!unchanged || results.some((item) => !item.success))
        process.exitCode = 1;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    await main();
}
