import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmod,
    mkdir,
    mkdtemp,
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
    devWorkloadSampleCounts,
} from "./shared-fs-native-mount-benchmark-dev-workload.mjs";
import {
    formatNativeMountBenchmarkComparison,
    formatNativeMountBenchmarkSummary,
    parseNativeMountBenchmarkArguments,
    runNativeMountBenchmark,
    validateNativeMountBenchmarkReport,
} from "./shared-fs-native-mount-benchmark.mjs";
import { formatProfilingOverheadMarkdown } from "./shared-fs-mount-profile-summary.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gitAvailable = spawnSync("git", ["--version"]).status === 0;
const sqliteAvailable = await import("node:sqlite").then(
    () => true,
    () => false
);
// A full run records a missing tool as not measured; these tests expect both.
const skipRun =
    (!gitAvailable && "git is not installed") ||
    (!sqliteAvailable && "node:sqlite is unavailable");

const DEV_NAMES = [
    "edit-save-20480",
    "jsonl-append-1024-at-4194304",
    "jsonl-append-1024-at-33554432",
    "sqlite-insert-txn-in-65536",
    "git-clone-checkout-2000",
    "git-status-2000",
];
const GIT_NAMES = DEV_NAMES.slice(-2);

// `prepare` may return extra benchmark arguments.
const runInTemporaryMount = async (prefix, prepare) => {
    const temporary = await mkdtemp(join(tmpdir(), prefix));
    const mount = join(temporary, "mount");
    await mkdir(mount);
    try {
        const extra = (await prepare?.(temporary)) ?? [];
        const options = parseNativeMountBenchmarkArguments([
            "--mount",
            mount,
            "--samples",
            "2",
            "--warmups",
            "1",
            "--small-files",
            "1",
            "--readdir-entries",
            "1",
            "--overwrite-base-bytes",
            "65536",
            "--timeout-ms",
            "120000",
            "--dev-workload",
            ...extra,
        ]);
        const report = await runNativeMountBenchmark(options);
        // The benchmark owns and removes only its unique child directory.
        assert.deepEqual(await readdir(mount), []);
        return { report, options };
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
};

/** Drop measured developer scenarios as if they had failed with `reason`. */
const markNotMeasured = (report, names, reason) => {
    const copy = structuredClone(report);
    copy.scenarios = copy.scenarios.filter(({ name }) => !names.includes(name));
    copy.devWorkload.notMeasured.push(
        ...names.map((scenario) => ({ scenario, reason }))
    );
    return copy;
};

test(
    "git fast-import reproduces the pinned commit from the generated corpus",
    { skip: !gitAvailable && "git is not installed" },
    async () => {
        const corpus = buildDevWorkloadCorpus();
        assert.equal(corpus.files.length, devWorkloadCorpus.fileCount);
        assert.equal(corpus.totalBytes, devWorkloadCorpus.totalBytes);
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
                input: createDevWorkloadFastImportStream(corpus),
            });
            assert.equal(
                git(["rev-parse", "refs/heads/main"], { cwd: origin }),
                devWorkloadCorpus.gitCommitSha1
            );
        } finally {
            await rm(temporary, { recursive: true, force: true });
        }
    }
);

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
    "the developer workload emits validated, comparable scenarios",
    { skip: skipRun },
    async () => {
        const { report, options } = await runInTemporaryMount(
            "peerbit-dev-workload-full-"
        );
        assert.equal(report.run.devWorkload, true);
        assert.deepEqual(report.devWorkload.notMeasured, []);
        assert.deepEqual(
            report.scenarios.map(({ name }) => name).slice(-6),
            DEV_NAMES
        );
        assert.equal(
            report.inputs.files.filter(({ path }) =>
                path.endsWith(
                    "shared-fs-native-mount-benchmark-dev-workload.mjs"
                )
            ).length,
            1
        );
        // CI's 30 samples after 3 warmups give git 3 samples after 1 warmup.
        assert.deepEqual(
            devWorkloadSampleCounts("git-status-2000", {
                samples: 30,
                warmups: 3,
            }),
            { samples: 3, warmups: 1 }
        );
        const sqlite = report.scenarios.find(({ name }) =>
            name.startsWith("sqlite-")
        ).sqlite;
        assert.equal(sqlite.journalMode, "delete");
        assert.ok(sqlite.prefillBytes >= options.overwriteBaseBytes);
        validateNativeMountBenchmarkReport(report, options);

        const summary = formatNativeMountBenchmarkSummary(report);
        assert.match(
            summary,
            /Developer workload: corpus synthetic-source-tree-v1 \(2000 files, 16\.7 MiB, commit 377d9ef85fb2\); git version .*; SQLite 3\.\S+, delete journal/u
        );
        assert.match(summary, /\| git-status-2000 \|/u);

        const rejects = (mutate, pattern) => {
            const copy = structuredClone(report);
            mutate(copy);
            assert.throws(
                () => validateNativeMountBenchmarkReport(copy),
                pattern
            );
        };
        rejects((copy) => {
            copy.devWorkload.notMeasured.push({
                scenario: "git-status-clean-2000",
                reason: "not a planned scenario",
            });
        }, /developer-workload section is invalid/u);
        // An awaited fsync always takes time: zero means it was skipped.
        rejects((copy) => {
            copy.scenarios.find(
                ({ name }) => name === "edit-save-20480"
            ).samples[0].fsyncNs = 0;
        }, /edit-save-20480 has an invalid fsync phase/u);

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
            /\| git-clone-checkout-2000 \| .* \| 1\.0× \|/u
        );
        assert.match(comparison, /\| stat-1048576 \| .* \| 1\.0× \|/u);
        assert.throws(
            () => formatNativeMountBenchmarkComparison(control, report),
            /needs a shared-fs-mount report/u
        );
        const failedClone = markNotMeasured(
            report,
            GIT_NAMES,
            "warmup 1: git clone exited with 128: simulated"
        );
        validateNativeMountBenchmarkReport(failedClone);
        assert.match(
            formatNativeMountBenchmarkComparison(failedClone, control),
            /\| git-status-2000 \| not measured \| [0-9.]+ m?s \| — \|/u
        );

        // Profiled and unprofiled passes may differ in what was measured.
        const markdown = formatProfilingOverheadMarkdown([
            { label: "A1", profiled: false, report },
            {
                label: "B1",
                profiled: true,
                report: markNotMeasured(
                    report,
                    ["sqlite-insert-txn-in-65536"],
                    "sample 1: disk I/O error"
                ),
            },
        ]);
        assert.match(
            markdown,
            /\| sqlite-insert-txn-in-65536 \| [0-9.]+ ms \| — \| — \|/u
        );
        assert.match(markdown, /\| edit-save-20480 \| .* \| 1\.000× \|/u);
    }
);

// A stand-in for git on a mount that rejects chmod: `git clone` fails the
// way a real clone fails when git cannot rewrite .git/config.
const withFailingGit = async (directory) => {
    const path = join(directory, "failing-git");
    await writeFile(
        path,
        [
            "#!/bin/sh",
            'if [ "$1" = "clone" ]; then',
            "  for destination; do :; done",
            '  mkdir -p "$destination/.git"',
            '  echo "error: chmod on $destination/.git/config.lock failed: Function not implemented" >&2',
            "  echo \"fatal: could not set 'core.filemode' to 'false'\" >&2",
            "  exit 128",
            "fi",
            'exec git "$@"',
            "",
        ].join("\n")
    );
    await chmod(path, 0o755);
    return ["--dev-git-executable", path];
};

test(
    "a failing git operation is recorded as not measured and the run continues",
    {
        skip:
            skipRun || (process.platform === "win32" && "needs a POSIX shell"),
    },
    async () => {
        const { report, options } = await runInTemporaryMount(
            "peerbit-dev-workload-failing-git-",
            withFailingGit
        );
        validateNativeMountBenchmarkReport(report, options);
        assert.deepEqual(
            report.scenarios.map(({ name }) => name).slice(-4),
            DEV_NAMES.slice(0, 4)
        );
        // The reason names the failing run and hides the benchmark root.
        const reason =
            "warmup 1: git clone exited with 128: error: chmod on <root>/dev-git/clone-0/.git/config.lock failed: Function not implemented fatal: could not set 'core.filemode' to 'false'";
        assert.deepEqual(
            report.devWorkload.notMeasured,
            GIT_NAMES.map((scenario) => ({ scenario, reason }))
        );
        assert.match(
            formatNativeMountBenchmarkSummary(report),
            /- git-status-2000: warmup 1: git clone exited with 128/u
        );
    }
);
