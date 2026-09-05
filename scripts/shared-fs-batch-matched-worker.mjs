import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import {
    applyMeasuredRound,
    createMatchedFixture,
    measureMatchedOperation,
    parseMatchedArguments,
    seedMatchedFixture,
    sha256,
    verifyMatchedFixture,
} from "./shared-fs-batch-matched-helper.mjs";

export const RESULT_PREFIX = "SHARED_FS_BATCH_MATCHED_RESULT ";

function errorInfo(error, depth = 0) {
    if (depth >= 4)
        return { name: "TruncatedError", message: "Nested error limit" };
    return {
        name:
            typeof error?.name === "string"
                ? error.name.slice(0, 128)
                : "Error",
        message: String(error?.message ?? error).slice(0, 4_096),
        ...(typeof error?.stack === "string"
            ? { stack: error.stack.slice(0, 12_288) }
            : {}),
        ...(error?.cause ? { cause: errorInfo(error.cause, depth + 1) } : {}),
    };
}

/** Resolve from the selected library's dependency search paths, never this script. */
async function resolvePeerbit(sourceLibrary) {
    const require = createRequire(join(sourceLibrary, "package.json"));
    for (const searchPath of require.resolve.paths("peerbit") ?? []) {
        const packagePath = join(searchPath, "peerbit", "package.json");
        let text;
        try {
            text = await readFile(packagePath, "utf8");
        } catch (error) {
            if (error.code === "ENOENT") continue;
            throw error;
        }
        const pkg = JSON.parse(text);
        assert.equal(pkg.name, "peerbit");
        // Peerbit's package is import-only, so require.resolve("peerbit")
        // itself fails. Read its explicit import export from this exact edge.
        const relativeEntry = pkg.exports?.["."]?.import;
        assert(
            typeof relativeEntry === "string" && relativeEntry.startsWith("./")
        );
        const entry = await realpath(
            resolve(dirname(packagePath), relativeEntry)
        );
        return {
            entry,
            version: pkg.version,
            packagePath: await realpath(packagePath),
            packageSha256: sha256(text),
            entrySha256: sha256(await readFile(entry)),
        };
    }
    throw new Error(`Cannot resolve peerbit from ${sourceLibrary}`);
}

export async function runMatchedWorker(
    options,
    fixture = createMatchedFixture()
) {
    const started = performance.now();
    const sourceLibrary = await realpath(options.sourceLibrary);
    const sourceIndex = join(sourceLibrary, "src", "index.ts");
    const sourceModel = join(sourceLibrary, "src", "model.ts");
    const sourcePackage = await readFile(
        join(sourceLibrary, "package.json"),
        "utf8"
    );
    assert.equal(JSON.parse(sourcePackage).name, "@peerbit/shared-fs");
    assert(["anonymous", "root-key"].includes(options.auth));
    assert(["sequential-first", "batch-first"].includes(options.order));
    const peerbit = await resolvePeerbit(sourceLibrary);
    const { Peerbit } = await import(pathToFileURL(peerbit.entry).href);
    const { openSharedFs, encodePublicSignKey } = await import(
        pathToFileURL(sourceIndex).href
    );
    const report = {
        schemaVersion: 1,
        benchmark: "shared-fs-batch-matched",
        ok: false,
        sourceLibrary,
        auth: options.auth,
        order: options.order,
        fixture: fixture.metadata,
        provenance: {
            sourceIndex,
            sourceIndexSha256: sha256(await readFile(sourceIndex)),
            sourceModelSha256: sha256(await readFile(sourceModel)),
            sourcePackageSha256: sha256(sourcePackage),
            peerbit,
            workerSha256: sha256(
                await readFile(fileURLToPath(import.meta.url))
            ),
            helperSha256: sha256(
                await readFile(
                    new URL(
                        "./shared-fs-batch-matched-helper.mjs",
                        import.meta.url
                    )
                )
            ),
        },
        runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            pid: process.pid,
        },
        scope: {
            storage:
                "independent directory-less local peers; no durability claim",
            network:
                "default Peerbit.create transports/listeners; no dialing, zero connections required",
            seeding:
                "three prior sequential writeFile rounds on each independent filesystem",
            measured:
                "round 3 only; sequential writeFile loop versus one default writeBatch",
            excludes: [
                "seeding",
                "verification",
                "peer startup/stop",
                "remote replication",
                "persisted acknowledgements",
                "mount I/O",
            ],
        },
        runs: [],
        errors: [],
        caveats: [
            "Methods use independent peers/stores but share one worker process, JIT, heap and host; method order must be counterbalanced.",
            "No forced GC; process CPU/ELU/GC include background work and are not filesystem-only attribution.",
            "GC sums are full spans whose start falls inside the measured interval; spans can cross interval end.",
            "Event-loop delay uses a 10ms sampler; zero samples means unknown, not zero delay.",
            "Minimal observers and counter boundary calls add overhead; no per-write hooks or marks are installed.",
            "Random identities, IDs and timestamps differ; fixture hashes and logical histories match.",
            "Authenticated preflight covers a warm own-root verdict only, not trust-graph traversal or revocation.",
            "An ok report means peer.stop resolved; the campaign must also require natural worker exit code zero.",
        ],
    };
    const methods =
        options.order === "sequential-first"
            ? ["sequential", "batch"]
            : ["batch", "sequential"];
    for (const [ordinal, method] of methods.entries()) {
        const result = {
            method,
            ordinal,
            ok: false,
            phase: "create",
            cleanup: { stopped: false },
        };
        report.runs.push(result);
        let peer;
        try {
            peer = await Peerbit.create();
            result.identity = peer.identity.publicKey.hashcode();
            result.phase = "open";
            const fs = await openSharedFs({
                peerbit: peer,
                machineLabel: "matched-batch",
                ...(options.auth === "root-key"
                    ? { rootKey: peer.identity.publicKey }
                    : {}),
            });
            assert.equal(peer.libp2p.getConnections().length, 0);
            result.phase = "seed";
            const seeded = await seedMatchedFixture(fs, fixture);
            const trustGraphPresent = Boolean(fs.program.trustGraph);
            const rootVerdictWarm =
                fs.program.trustVerdicts.get(result.identity)?.ok === true;
            assert.equal(trustGraphPresent, options.auth === "root-key");
            assert.equal(fs.accessControlled, options.auth === "root-key");
            const expectedRoot =
                options.auth === "root-key"
                    ? encodePublicSignKey(peer.identity.publicKey)
                    : undefined;
            assert.equal(fs.rootKey, expectedRoot);
            if (options.auth === "root-key")
                assert.equal(rootVerdictWarm, true);
            result.authPreflight = {
                trustGraphPresent,
                rootVerdictWarm,
                accessControlled: fs.accessControlled,
                rootKeyMatchesIdentity:
                    options.auth === "root-key"
                        ? fs.rootKey === expectedRoot
                        : null,
            };
            assert(["sequential", "batch"].includes(method));
            result.phase = "measure";
            const measured = await measureMatchedOperation(() =>
                applyMeasuredRound(fs, fixture.rounds[3], method)
            );
            result.measurement = measured.measurement;
            if (!measured.ok) throw measured.error;
            result.phase = "verify";
            result.verification = await verifyMatchedFixture(
                fs,
                fixture,
                seeded,
                measured.value,
                method
            );
            assert.equal(peer.libp2p.getConnections().length, 0);
            result.connections = 0;
            result.ok = true;
        } catch (error) {
            const failure = {
                method,
                phase: result.phase,
                error: errorInfo(error),
            };
            result.failure = failure;
            report.errors.push(failure);
        } finally {
            if (peer) {
                const stopStarted = performance.now();
                try {
                    await peer.stop();
                    result.cleanup.stopped = true;
                } catch (error) {
                    result.ok = false;
                    const failure = {
                        method,
                        phase: "stop",
                        error: errorInfo(error),
                    };
                    result.cleanup.failure = failure;
                    report.errors.push(failure);
                }
                result.cleanup.stopMs = performance.now() - stopStarted;
            }
        }
        if (!result.ok) break;
        result.phase = "complete";
    }
    report.ok =
        report.runs.length === 2 &&
        report.runs.every((run) => run.ok && run.cleanup.stopped);
    report.totalWallMs = performance.now() - started;
    report.activeResourcesAfterStops = process.getActiveResourcesInfo();
    if (report.ok) {
        assert.notEqual(
            report.runs[0].identity,
            report.runs[1].identity,
            "Peer identities were reused"
        );
        assert.deepEqual(
            report.runs[0].verification,
            report.runs[1].verification,
            "Method fixtures differ"
        );
    }
    return report;
}

async function emitReport(report, output) {
    const json = JSON.stringify(report);
    if (output) await writeFile(output, `${json}\n`, { flag: "wx" });
    await new Promise((resolve, reject) =>
        process.stdout.write(`${RESULT_PREFIX}${json}\n`, (error) =>
            error ? reject(error) : resolve()
        )
    );
}

if (
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    try {
        const options = parseMatchedArguments(process.argv.slice(2));
        const report = await runMatchedWorker(options);
        await emitReport(report, options.output);
        if (!report.ok) process.exitCode = 1;
    } catch (error) {
        process.exitCode = 1;
        await emitReport({
            schemaVersion: 1,
            benchmark: "shared-fs-batch-matched",
            ok: false,
            errors: [{ phase: "worker", error: errorInfo(error) }],
        });
    }
}
