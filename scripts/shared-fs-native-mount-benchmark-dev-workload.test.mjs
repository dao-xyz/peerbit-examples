import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    buildDevWorkloadCorpus,
    createDevWorkloadFastImportStream,
    createDevWorkloadJsonlLines,
    devWorkloadCorpus,
    devWorkloadScenarioNames,
    generateDevWorkloadCorpus,
    probeDevWorkloadGit,
    probeDevWorkloadSqlite,
    verifyDevWorkloadCorpus,
} from "./shared-fs-native-mount-benchmark-dev-workload.mjs";
import {
    expectedNativeMountBenchmarkScenarioNames,
    formatNativeMountBenchmarkComparison,
    formatNativeMountBenchmarkSummary,
    parseNativeMountBenchmarkArguments,
    runNativeMountBenchmark,
    validateNativeMountBenchmarkReport,
} from "./shared-fs-native-mount-benchmark.mjs";
import {
    formatProfilingOverheadMarkdown,
    parseMountProfileText,
    summarizeMountProfile,
} from "./shared-fs-mount-profile-summary.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gitAvailable = spawnSync("git", ["--version"]).status === 0;
const posix = process.platform !== "win32";

// Windows checkouts may use CRLF (core.autocrlf); match on LF text.
const readLf = async (relative) =>
    (await readFile(new URL(relative, import.meta.url), "utf8")).replace(
        /\r\n/gu,
        "\n"
    );

const DEV_NAMES_4MIB = [
    "edit-save-20480",
    "jsonl-append-1024-at-4194304",
    "jsonl-append-1024-at-33554432",
    "sqlite-insert-txn-in-4194304",
    "git-clone-checkout-2000",
    "git-status-clean-2000",
    "git-status-porcelain-10-modified",
];
// The fixture runs below use a 4096-byte overwrite base.
const DEV_NAMES = DEV_NAMES_4MIB.map((name) =>
    name.replace("sqlite-insert-txn-in-4194304", "sqlite-insert-txn-in-4096")
);

const devArguments = (mount, ...extra) => [
    "--mount",
    mount,
    "--samples",
    "1",
    "--warmups",
    "0",
    "--small-files",
    "1",
    "--readdir-entries",
    "1",
    "--overwrite-base-bytes",
    "4096",
    "--timeout-ms",
    "120000",
    "--dev-workload",
    "--dev-git-samples",
    "1",
    "--dev-git-warmups",
    "0",
    ...extra,
];

const runInTemporaryMount = async (prefix, argv, prepare) => {
    const temporary = await mkdtemp(join(tmpdir(), prefix));
    const mount = join(temporary, "mount");
    await mkdir(mount);
    try {
        await prepare?.(temporary);
        const options = parseNativeMountBenchmarkArguments(
            argv(temporary, mount)
        );
        const report = await runNativeMountBenchmark(options);
        // The benchmark owns and removes only its unique child directory.
        assert.deepEqual(await readdir(mount), []);
        return { report, options };
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
};

let fullReport;
const withFullReport = () =>
    (fullReport ??= runInTemporaryMount(
        "peerbit-dev-workload-full-",
        (_, mount) => devArguments(mount)
    ));

let gitlessReport;
const withGitlessReport = () =>
    (gitlessReport ??= runInTemporaryMount(
        "peerbit-dev-workload-gitless-",
        (temporary, mount) =>
            devArguments(
                mount,
                "--dev-git-executable",
                join(temporary, "missing", "git")
            )
    ));

const devScenario = (report, prefix) =>
    report.scenarios.find(({ name }) => name.startsWith(prefix));

/** Mark a measured developer scenario as not measured, keeping order valid. */
const markNotMeasured = (report, entries) => {
    const copy = structuredClone(report);
    const names = new Set(entries.map(({ scenario }) => scenario));
    copy.scenarios = copy.scenarios.filter(({ name }) => !names.has(name));
    const order = devWorkloadScenarioNames({
        overwriteBaseBytes: copy.run.overwriteBaseBytes,
    });
    copy.devWorkload.notMeasured = [
        ...copy.devWorkload.notMeasured,
        ...entries,
    ].sort(
        (left, right) =>
            order.indexOf(left.scenario) - order.indexOf(right.scenario)
    );
    return copy;
};

test("developer-workload corpus is deterministic and matches its pinned digests", () => {
    const first = buildDevWorkloadCorpus();
    const second = buildDevWorkloadCorpus();
    assert.notEqual(first, second, "the builder must not return a cache");
    assert.equal(first.manifestSha256, second.manifestSha256);
    assert.equal(first.gitTreeSha1, second.gitTreeSha1);
    assert.deepEqual(
        first.files.map(({ path }) => path),
        second.files.map(({ path }) => path)
    );
    assert.equal(verifyDevWorkloadCorpus(first), first);
    assert.equal(generateDevWorkloadCorpus(), generateDevWorkloadCorpus());
    assert.deepEqual(
        {
            id: devWorkloadCorpus.id,
            seedUint32: devWorkloadCorpus.seedUint32,
            fileCount: devWorkloadCorpus.fileCount,
            directoryCount: devWorkloadCorpus.directoryCount,
            totalBytes: devWorkloadCorpus.totalBytes,
            manifestSha256: devWorkloadCorpus.manifestSha256,
            gitTreeSha1: devWorkloadCorpus.gitTreeSha1,
            gitCommitSha1: devWorkloadCorpus.gitCommitSha1,
        },
        {
            id: "synthetic-source-tree-v1",
            seedUint32: 0x5d2a91c7,
            fileCount: 2000,
            directoryCount: 135,
            totalBytes: 17_546_290,
            manifestSha256:
                "d33fd46678e09b85f80c682ded2bb055dbaa483fc5c9a8e04fde5e9e8c3e8597",
            gitTreeSha1: "728fb3e755f039c34d25bc2939bea4ff37ec1399",
            gitCommitSha1: "b26b584a39f7b29ed22a3ab875de86dff2ac3232",
        }
    );
    const paths = first.files.map(({ path }) => path);
    assert.equal(new Set(paths).size, 2000);
    assert.deepEqual(paths, [...paths].sort(), "files are in Git index order");
    const sizes = first.files
        .map(({ content }) => content.byteLength)
        .sort((left, right) => left - right);
    assert.ok(sizes[0] >= 64 && sizes.at(-1) < 65_536);
    // A source-tree-like distribution: many small files, a long tail.
    assert.ok(sizes[1000] >= 2048 && sizes[1000] <= 8192);
    assert.ok(Math.max(...paths.map((path) => path.split("/").length)) >= 5);
    for (const { content } of first.files) {
        assert.equal(content.at(-1), 0x0a);
        assert.ok(content.every((byte) => byte >= 0x0a && byte < 0x7f));
    }
    const pinned = first.files.find(
        ({ path }) => path === "packages/app/src/api/buffer-1182.ts"
    );
    assert.equal(
        sha256(pinned.content),
        "4df63992d651e8b8ae37f2c1bb02f7101041f81a17950be12fcec7245fc10bb4"
    );
    assert.equal(
        sha256(createDevWorkloadFastImportStream(first)),
        "634a0cbd53bfba131240d679641da06822090515daf8956d2558c22e0fdf3eb8"
    );
});

test("developer-workload corpus drift fails loudly", () => {
    const corpus = buildDevWorkloadCorpus();
    assert.throws(
        () =>
            verifyDevWorkloadCorpus({ ...corpus, gitTreeSha1: "0".repeat(40) }),
        /corpus gitTreeSha1 drifted/u
    );
    assert.throws(
        () =>
            verifyDevWorkloadCorpus({
                ...corpus,
                files: corpus.files.slice(1),
            }),
        /file count drifted/u
    );
});

test("developer-workload JSONL records are exact 1 KiB lines", () => {
    const lines = createDevWorkloadJsonlLines(0, 4096);
    assert.equal(lines.byteLength, 4 << 20);
    assert.equal(
        sha256(lines),
        "2dc163f0d65d7c3d8e175b8c9b567ff426099aac941b4f7c0bed4779a603028b"
    );
    assert.deepEqual(
        createDevWorkloadJsonlLines(4095, 1),
        lines.subarray(4095 * 1024)
    );
    for (const index of [0, 1, 4095]) {
        const line = lines.subarray(index * 1024, (index + 1) * 1024);
        assert.equal(line.at(-1), 0x0a);
        assert.equal(JSON.parse(line.toString("latin1")).seq, index);
    }
});

test(
    "git fast-import reproduces the pinned commit from the generated stream",
    { skip: !gitAvailable && "git is not installed" },
    async () => {
        const temporary = await mkdtemp(
            join(tmpdir(), "peerbit-dev-workload-origin-test-")
        );
        const env = {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            HOME: temporary,
            XDG_CONFIG_HOME: temporary,
        };
        try {
            const origin = join(temporary, "origin.git");
            const git = (args, options = {}) => {
                const result = spawnSync("git", args, { env, ...options });
                assert.equal(result.status, 0, result.stderr?.toString());
                return result.stdout.toString().trim();
            };
            git(["init", "--bare", "--quiet", origin]);
            git(["fast-import", "--quiet"], {
                cwd: origin,
                input: createDevWorkloadFastImportStream(
                    generateDevWorkloadCorpus()
                ),
            });
            assert.equal(
                git(
                    ["rev-parse", "refs/heads/main", "refs/heads/main^{tree}"],
                    {
                        cwd: origin,
                    }
                ),
                `${devWorkloadCorpus.gitCommitSha1}\n${devWorkloadCorpus.gitTreeSha1}`
            );
        } finally {
            await rm(temporary, { recursive: true, force: true });
        }
    }
);

test("developer-workload tool probes record why a tool is unavailable", async () => {
    const missing = await probeDevWorkloadGit({
        executable: join(tmpdir(), "peerbit-no-such-dir", "git"),
    });
    assert.equal(missing.available, false);
    assert.match(missing.reason, /^git executable not found: /u);

    const sqlite = await probeDevWorkloadSqlite(async () => {
        throw Object.assign(new Error("No such built-in module: node:sqlite"), {
            code: "ERR_UNKNOWN_BUILTIN_MODULE",
        });
    });
    assert.equal(sqlite.api, undefined);
    assert.equal(sqlite.tool.available, false);
    assert.equal(sqlite.tool.module, "node:sqlite");
    assert.match(
        sqlite.tool.reason,
        /node:sqlite is unavailable in Node v\d+.*ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module/u
    );

    if (gitAvailable) {
        const git = await probeDevWorkloadGit();
        assert.equal(git.available, true);
        assert.match(git.version, /^git version /u);
    }
});

test("developer-workload options are opt-in and bounded", () => {
    const defaults = parseNativeMountBenchmarkArguments(["--mount", "."]);
    assert.equal(defaults.devWorkload, false);
    assert.deepEqual(
        expectedNativeMountBenchmarkScenarioNames(defaults),
        expectedNativeMountBenchmarkScenarioNames({
            ...defaults,
            devWorkload: undefined,
        })
    );
    const enabled = parseNativeMountBenchmarkArguments([
        "--mount",
        ".",
        "--dev-workload",
        "--timeout-ms",
        "1800000",
    ]);
    assert.equal(enabled.devWorkload, true);
    assert.equal(enabled.devGitSamples, 3);
    assert.equal(enabled.devGitWarmups, 1);
    assert.equal(enabled.devGitExecutable, "git");
    assert.deepEqual(
        expectedNativeMountBenchmarkScenarioNames(enabled).slice(-7),
        DEV_NAMES_4MIB
    );
    assert.throws(
        () =>
            parseNativeMountBenchmarkArguments([
                "--mount",
                ".",
                "--dev-git-samples",
                "2",
            ]),
        /--dev-git-samples requires --dev-workload/u
    );
    assert.throws(
        () =>
            parseNativeMountBenchmarkArguments([
                "--mount",
                ".",
                "--dev-workload",
                "--dev-git-samples",
                "21",
            ]),
        /--dev-git-samples must be an integer from 1 through 20/u
    );
});

test("a missing git records tool-unavailable skips and still measures the rest", async () => {
    const { report, options } = await withGitlessReport();
    const names = report.scenarios.map(({ name }) => name);
    assert.deepEqual(names.slice(-4), DEV_NAMES.slice(0, 4));
    assert.equal(report.devWorkload.tools.git.available, false);
    assert.deepEqual(
        report.devWorkload.notMeasured.map(({ scenario, cause }) => [
            scenario,
            cause,
        ]),
        DEV_NAMES.slice(4).map((name) => [name, "tool-unavailable"])
    );
    for (const { reason } of report.devWorkload.notMeasured) {
        assert.match(reason, /^git executable not found: /u);
    }
    validateNativeMountBenchmarkReport(report, options);
    validateNativeMountBenchmarkReport(report);
    const summary = formatNativeMountBenchmarkSummary(report);
    assert.match(summary, /git: unavailable/u);
    assert.match(
        summary,
        /- git-clone-checkout-2000: tool-unavailable — git executable not found/u
    );

    // A tool-unavailable record must match the recorded tool state.
    const lying = structuredClone(report);
    lying.devWorkload.tools.git = {
        available: true,
        executable: "git",
        version: "git version 0.0.0",
    };
    assert.throws(
        () => validateNativeMountBenchmarkReport(lying),
        /inconsistent tool-unavailable record/u
    );
});

test(
    "the developer workload emits validated, attributable scenarios",
    { skip: !gitAvailable && "git is not installed" },
    async () => {
        const { report, options } = await withFullReport();
        assert.equal(report.schemaVersion, 4);
        assert.deepEqual(report.devWorkload.notMeasured, []);
        assert.deepEqual(
            report.scenarios.map(({ name }) => name).slice(-7),
            DEV_NAMES
        );
        assert.deepEqual(report.run.devWorkload, {
            enabled: true,
            gitSamplesPerScenario: 1,
            gitWarmupsPerScenario: 0,
            sampleCounts:
                "git scenarios use gitSamplesPerScenario/gitWarmupsPerScenario; other developer-workload scenarios use samplesPerScenario/warmupsPerScenario",
        });
        assert.equal(
            report.inputs.files.filter(({ path }) =>
                path.endsWith(
                    "shared-fs-native-mount-benchmark-dev-workload.mjs"
                )
            ).length,
            1
        );
        const clone = devScenario(report, "git-clone-checkout");
        assert.equal(clone.itemCount, 2000);
        assert.equal(clone.logicalBytes, devWorkloadCorpus.totalBytes);
        const sqlite = devScenario(report, "sqlite-insert-txn");
        assert.equal(sqlite.sqlite.journalMode, "delete");
        assert.ok(sqlite.sqlite.prefillBytes >= 4096);
        const save = devScenario(report, "edit-save");
        assert.ok(save.samples[0].renameNs >= 0);
        assert.ok(save.samples[0].fsyncNs >= 0);
        assert.equal(
            devScenario(report, "jsonl-append-1024-at-33554432").baseFileBytes,
            32 << 20
        );
        validateNativeMountBenchmarkReport(report, options);

        const summary = formatNativeMountBenchmarkSummary(report);
        assert.match(
            summary,
            /Developer workload: corpus synthetic-source-tree-v1 \(2000 files in 135 directories, 16\.7 MiB, commit b26b584a39f7\)/u
        );
        assert.match(summary, /\| git-status-clean-2000 \|/u);

        const control = structuredClone(report);
        control.target.kind = "local-filesystem-control";
        control.target.mountOptions = [];
        control.target.label = "local filesystem control (test)";
        const comparison = formatNativeMountBenchmarkComparison(
            report,
            control
        );
        assert.match(
            comparison,
            /## Shared FS mount vs local filesystem control \(same runner\)/u
        );
        assert.match(
            comparison,
            /\| git-clone-checkout-2000 \| .* \| 1\.0× \|/u
        );
        assert.match(comparison, /\| stat-1048576 \| .* \| 1\.0× \|/u);
        assert.throws(
            () => formatNativeMountBenchmarkComparison(control, report),
            /needs a shared-fs-mount report/u
        );

        // Not-measured git scenarios show in the comparison per target.
        const failedClone = markNotMeasured(report, [
            {
                scenario: "git-clone-checkout-2000",
                cause: "operation-failed",
                reason: "warmup 1: git clone exited with 128: simulated",
            },
            {
                scenario: "git-status-clean-2000",
                cause: "dependency-not-measured",
                reason: "requires a measured git-clone-checkout-2000 checkout",
            },
            {
                scenario: "git-status-porcelain-10-modified",
                cause: "dependency-not-measured",
                reason: "requires a measured git-clone-checkout-2000 checkout",
            },
        ]);
        validateNativeMountBenchmarkReport(failedClone);
        assert.match(
            formatNativeMountBenchmarkComparison(failedClone, control),
            /\| git-clone-checkout-2000 \| not measured \(operation-failed\) \| [0-9.]+ m?s \| — \|/u
        );
    }
);

test(
    "the report validator keeps developer-workload records consistent",
    { skip: !gitAvailable && "git is not installed" },
    async () => {
        const { report, options } = await withFullReport();
        const rejects = (mutate, pattern) => {
            const copy = structuredClone(report);
            mutate(copy);
            assert.throws(
                () => validateNativeMountBenchmarkReport(copy),
                pattern
            );
        };
        rejects((copy) => {
            copy.schemaVersion = 3;
        }, /envelope is invalid/u);
        rejects((copy) => {
            copy.run.devWorkload.gitSamplesPerScenario = 99;
        }, /developer-workload run options are invalid/u);
        rejects((copy) => {
            copy.devWorkload.corpus = {
                ...copy.devWorkload.corpus,
                fileCount: 1999,
            };
        }, /developer-workload section is invalid/u);
        rejects((copy) => {
            delete copy.devWorkload.tools.sqlite.version;
        }, /developer-workload section is invalid/u);
        rejects((copy) => {
            copy.run.devWorkload = { enabled: false };
        }, /developer-workload section requires --dev-workload/u);
        rejects((copy) => {
            const clone = copy.scenarios.find(({ name }) =>
                name.startsWith("git-clone")
            );
            clone.samples.push(structuredClone(clone.samples[0]));
        }, /incomplete sample set/u);
        rejects((copy) => {
            delete copy.scenarios.find(({ name }) => name === "edit-save-20480")
                .samples[0].renameNs;
        }, /invalid renameNs phase/u);
        rejects((copy) => {
            copy.scenarios.find(({ name }) =>
                name.startsWith("git-clone")
            ).itemCount = 10;
        }, /does not describe the pinned corpus|invalid .* summary/u);
        rejects((copy) => {
            copy.scenarios[0].suite = "developer-workload";
        }, /unexpected suite/u);
        rejects((copy) => {
            copy.scenarios.find(
                ({ name }) => name === "edit-save-20480"
            ).operation = "append";
        }, /is not a developer-workload scenario/u);

        // A tool-unavailable skip needs an unavailable tool.
        const wrongTool = markNotMeasured(report, [
            {
                scenario: "edit-save-20480",
                cause: "tool-unavailable",
                reason: "no editor",
            },
        ]);
        assert.throws(
            () => validateNativeMountBenchmarkReport(wrongTool),
            /inconsistent tool-unavailable record/u
        );
        // A status run cannot be measured without its checkout.
        const orphanStatus = markNotMeasured(report, [
            {
                scenario: "git-clone-checkout-2000",
                cause: "operation-failed",
                reason: "warmup 1: failed",
            },
        ]);
        assert.throws(
            () => validateNativeMountBenchmarkReport(orphanStatus),
            /cannot be measured without git-clone-checkout-2000/u
        );
        // A dependency skip needs a missing dependency.
        const falseDependency = markNotMeasured(report, [
            {
                scenario: "git-status-clean-2000",
                cause: "dependency-not-measured",
                reason: "requires a checkout",
            },
        ]);
        assert.throws(
            () => validateNativeMountBenchmarkReport(falseDependency),
            /invalid dependency record/u
        );
        // An operation failure on any developer scenario is a valid record.
        const failedSqlite = markNotMeasured(report, [
            {
                scenario: "sqlite-insert-txn-in-4096",
                cause: "operation-failed",
                reason: "sample 3: ERR_SQLITE_ERROR: disk I/O error",
            },
        ]);
        validateNativeMountBenchmarkReport(failedSqlite);
        const multiline = structuredClone(failedSqlite);
        multiline.devWorkload.notMeasured[0].reason = "line one\nline two";
        assert.throws(
            () => validateNativeMountBenchmarkReport(multiline),
            /not-measured entries are invalid/u
        );
        const reordered = markNotMeasured(report, [
            {
                scenario: "sqlite-insert-txn-in-4096",
                cause: "operation-failed",
                reason: "failed",
            },
            {
                scenario: "edit-save-20480",
                cause: "operation-failed",
                reason: "failed",
            },
        ]);
        reordered.devWorkload.notMeasured.reverse();
        assert.throws(
            () => validateNativeMountBenchmarkReport(reordered),
            /out of order/u
        );
        // Run options must match when the caller supplies them.
        assert.throws(
            () =>
                validateNativeMountBenchmarkReport(report, {
                    ...options,
                    devGitSamples: 2,
                }),
            /developer-workload run options are invalid/u
        );
    }
);

// A stand-in for git on a mount that rejects chmod: `git clone` fails the
// way a real clone fails when git cannot rewrite .git/config.
const writeFailingGit = async (path) => {
    await writeFile(
        path,
        [
            "#!/bin/sh",
            'if [ "$1" = "clone" ]; then',
            '  mkdir -p "$7/.git"',
            '  echo "error: chmod on $7/.git/config.lock failed: Function not implemented" >&2',
            "  echo \"fatal: could not set 'core.filemode' to 'false'\" >&2",
            "  exit 128",
            "fi",
            'exec git "$@"',
            "",
        ].join("\n")
    );
    await chmod(path, 0o755);
};

test(
    "a failing git operation is recorded with its dependency and the run continues",
    { skip: (!gitAvailable || !posix) && "needs git and a POSIX shell" },
    async () => {
        const { report, options } = await runInTemporaryMount(
            "peerbit-dev-workload-failing-git-",
            (temporary, mount) =>
                devArguments(
                    mount,
                    "--dev-git-executable",
                    join(temporary, "failing-git")
                ),
            (temporary) => writeFailingGit(join(temporary, "failing-git"))
        );
        validateNativeMountBenchmarkReport(report, options);
        assert.equal(report.devWorkload.tools.git.available, true);
        assert.deepEqual(
            report.scenarios.map(({ name }) => name).slice(-4),
            DEV_NAMES.slice(0, 4)
        );
        const [clone, status, porcelain] = report.devWorkload.notMeasured;
        assert.equal(clone.scenario, "git-clone-checkout-2000");
        assert.equal(clone.cause, "operation-failed");
        // The reason names the failing run and hides the benchmark root.
        assert.match(
            clone.reason,
            /^sample 1: git clone exited with 128: error: chmod on <root>\/dev-git\/clone-00\/\.git\/config\.lock failed: Function not implemented fatal: could not set 'core\.filemode' to 'false'$/u
        );
        for (const entry of [status, porcelain]) {
            assert.equal(entry.cause, "dependency-not-measured");
        }
        assert.match(
            formatNativeMountBenchmarkSummary(report),
            /- git-clone-checkout-2000: operation-failed — sample 1: git clone exited with 128/u
        );
    }
);

test("developer-workload windows attribute mount-profile records", async () => {
    const { report } = await withGitlessReport();
    const save = devScenario(report, "edit-save");
    const append = devScenario(report, "jsonl-append-1024-at-33554432");
    const at = (value, phase) =>
        JSON.stringify({
            schema: "peerbit.shared-fs.mount-profile",
            schemaVersion: 1,
            source: "native-adapter",
            phase,
            operation: "rename",
            startUnixNs: value,
            durationNs: 1000,
            ok: true,
        });
    const text = [
        at(save.samples[0].startedAtUnixNs, "native.callback"),
        at(save.samples[0].endedAtUnixNs, "native.callback"),
        at(append.samples[0].startedAtUnixNs, "native.callback"),
    ].join("\n");
    const summary = summarizeMountProfile({
        inputs: [parseMountProfileText(text, "profile")],
        benchmarks: [{ label: "B1", report }],
    });
    const [attribution] = summary.benchmark;
    assert.equal(attribution.unattributedRecords, 0);
    assert.equal(
        attribution.scenarios.find(({ name }) => name === save.name)
            .callbacksPerSample.maxNs,
        2
    );
    assert.equal(
        attribution.scenarios.find(({ name }) => name === append.name)
            .callbacksPerSample.maxNs,
        1
    );

    // Alternating passes may differ in which developer scenarios ran.
    const withoutSqlite = markNotMeasured(report, [
        {
            scenario: "sqlite-insert-txn-in-4096",
            cause: "operation-failed",
            reason: "sample 1: ERR_SQLITE_ERROR: disk I/O error",
        },
    ]);
    const markdown = formatProfilingOverheadMarkdown([
        { label: "A1", profiled: false, report },
        { label: "B1", profiled: true, report: withoutSqlite },
    ]);
    assert.match(
        markdown,
        /\| sqlite-insert-txn-in-4096 \| [0-9.]+ ms \| — \| — \|/u
    );
    assert.match(markdown, /\| edit-save-20480 \| .* \| 1\.000× \|/u);
});

test("native smoke wrappers and workflow plumb the opt-in developer workload", async () => {
    const [posixWrapper, powershell, workflow, ci] = await Promise.all([
        readLf("./shared-fs-external-native-smoke.sh"),
        readLf("./shared-fs-external-native-smoke.ps1"),
        readLf("../.github/workflows/shared-fs-native-smoke.yml"),
        readLf("../.github/workflows/shared-fs-ci.yml"),
    ]);
    for (const source of [posixWrapper, powershell]) {
        assert.match(
            source,
            /PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_DEV_WORKLOAD[\s\S]*--dev-workload/u
        );
        // The developer workload gets a longer default deadline only.
        assert.match(source, /1800000/u);
        assert.match(source, /600000/u);
        assert.match(source, /must be 1 or unset/u);
    }
    // Without the variable the benchmark argv is unchanged.
    assert.match(
        posixWrapper,
        /if \[ "\$\{PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_DEV_WORKLOAD:-\}" = "1" \]; then\n\s+benchmark_common_args\+=\(--dev-workload\)/u
    );
    assert.match(
        powershell,
        /if \(\$DevWorkload -eq "1"\) \{\n\s+\$BenchmarkCommonArgs \+= @\("--dev-workload"\)/u
    );
    assert.match(
        workflow,
        /dev_workload:\n(?:\s+[a-z]+: .*\n)*?\s+default: false\n\s+type: boolean/u
    );
    // Both the default benchmark step and the profiled passes carry it.
    assert.equal(
        workflow.match(
            /PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_DEV_WORKLOAD: \$\{\{ inputs\.dev_workload && '1' \|\| '' \}\}/gu
        )?.length,
        2
    );
    assert.match(
        workflow,
        /timeout-minutes: \$\{\{ inputs\.mount_profile && \(inputs\.dev_workload && 180 \|\| 120\) \|\| \(inputs\.dev_workload && 60 \|\| 30\) \}\}/u
    );
    assert.match(
        workflow,
        /PEERBIT_SHARED_FS_NATIVE_CONTROL_BENCH_OUTPUT: \$\{\{ \(inputs\.mounted_benchmark \|\| inputs\.dev_workload\) &&/u
    );
    assert.match(
        workflow,
        /reports\[0\]\.run\.devWorkload\.enabled[\s\S]*formatNativeMountBenchmarkComparison\(reports\[0\], reports\[1\]\)/u
    );
    assert.match(
        ci,
        /node --test scripts\/shared-fs-native-mount-benchmark\.test\.mjs scripts\/shared-fs-native-mount-benchmark-dev-workload\.test\.mjs/u
    );
    // CI path filters and the prettier glob already cover the new files.
    assert.match(ci, /"scripts\/shared-fs-native-mount-benchmark\*\.mjs"/u);
    assert.match(
        ci,
        /prettier --check [^\n]*scripts\/shared-fs-native-mount-benchmark\*\.mjs/u
    );
});
