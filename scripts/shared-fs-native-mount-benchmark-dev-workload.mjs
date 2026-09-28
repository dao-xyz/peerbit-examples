// Opt-in, report-only "developer machine" scenarios for the mounted-path
// benchmark: an editor-style atomic save, fsync'd JSONL appends to growing
// logs, small SQLite transactions in a large database, and a git clone and
// status of a pinned synthetic source tree.
//
// Every input is generated locally from a fixed seed; nothing is downloaded.
// The git origin is a local bare repository built with `git fast-import`
// outside the target, so only the clone and checkout write into the target.

import { execFile } from "node:child_process";
import {
    mkdir,
    mkdtemp,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mixUint32 } from "./shared-fs-native-mount-benchmark.mjs";

export const DEV_WORKLOAD_MODULE_PATH = fileURLToPath(import.meta.url);

const SEED_UINT32 = 0x5d2a91c7;
const WORD_STEP_UINT32 = 0x9e3779b9;
const COMMIT_SIGNATURE =
    "Peerbit Benchmark <benchmark@peerbit.invalid> 1700000000 +0000";
const COMMIT_MESSAGE = "synthetic-source-tree-v1\n";
const EDIT_SAVE_BYTES = 20 << 10;
const JSONL_LINE_BYTES = 1024;
// The two base sizes offered by the workflow's overwrite_base_bytes input, so
// the append scenarios cover both regardless of which one a run selected.
const JSONL_CHECKPOINT_BYTES = [4 << 20, 32 << 20];
const SQLITE_PAYLOAD_BYTES = 256;
const STATUS_MODIFIED_FILES = 10;
const CHECKOUT_SPOT_CHECKS = 16;

/**
 * The pinned synthetic source tree. The local origin must reproduce this
 * commit before any git scenario runs.
 */
export const devWorkloadCorpus = Object.freeze({
    id: "synthetic-source-tree-v1",
    fileCount: 2000,
    totalBytes: 17_546_290,
    gitCommitSha1: "377d9ef85fb246e4573fed889937a344efdefa85",
});

const GIT_SCENARIOS = [
    `git-clone-checkout-${devWorkloadCorpus.fileCount}`,
    `git-status-${devWorkloadCorpus.fileCount}`,
];

export const devWorkloadScenarioNames = (options) => [
    `edit-save-${EDIT_SAVE_BYTES}`,
    ...JSONL_CHECKPOINT_BYTES.map(
        (bytes) => `jsonl-append-${JSONL_LINE_BYTES}-at-${bytes}`
    ),
    `sqlite-insert-txn-in-${options.overwriteBaseBytes}`,
    ...GIT_SCENARIOS,
];

/** Git scenarios are heavy: at most 3 samples after at most 1 warmup. */
export const devWorkloadSampleCounts = (name, { samples, warmups }) =>
    GIT_SCENARIOS.includes(name)
        ? { samples: Math.min(3, samples), warmups: Math.min(1, warmups) }
        : { samples, warmups };

/** Counter-based stream: value n depends only on (seed, stream, n). */
const createRandom = (stream) => {
    const base =
        (SEED_UINT32 ^ mixUint32(Math.imul(stream + 1, 0x85ebca6b))) >>> 0;
    let counter = 0;
    return (bound) =>
        mixUint32(base + Math.imul(counter++, WORD_STEP_UINT32)) % bound;
};

const pick = (values, below) => values[below(values.length)];

const [PACKAGES, AREAS, LEAVES, WORDS] = [
    "app auth cli client config core network server shared storage testing ui",
    "api hooks model service store types util view",
    "adapters components fixtures handlers helpers internal",
    "account adapter alpha array batch buffer cache channel chunk client commit config context cursor delta digest entry event field filter frame handle header index input key layer limit local merge model node offset option output packet page parent path peer range reader record remote request result route schema segment session signal state status stream target timer token update value version view window writer",
].map((list) => list.split(" "));
// [weight percent, minimum bytes, maximum bytes (exclusive)]
const SIZE_BUCKETS = [
    [12, 64, 512],
    [28, 512, 2048],
    [36, 2048, 8192],
    [19, 8192, 32768],
    [5, 32768, 65536],
];

const pickSize = (below) => {
    let roll = below(100);
    for (const [weight, minimum, maximum] of SIZE_BUCKETS) {
        if (roll < weight) return minimum + below(maximum - minimum);
        roll -= weight;
    }
};

/** Exactly `size` ASCII bytes: `header`, then source-like lines. */
const renderText = (header, size, below) => {
    let text = header;
    while (text.length < size) {
        text += `${"    ".repeat(below(4))}${pick(WORDS, below)}.${pick(WORDS, below)}(${pick(WORDS, below)}, ${below(4096)});\n`;
    }
    return Buffer.from(`${text.slice(0, size - 1)}\n`, "latin1");
};

const planCorpusPaths = () => {
    const below = createRandom(0);
    const paths = [];
    for (
        let index = 0;
        paths.length < devWorkloadCorpus.fileCount;
        index += 1
    ) {
        const name = PACKAGES[index % PACKAGES.length];
        const layout = below(10);
        const parent =
            layout < 2
                ? `packages/${name}/test`
                : layout < 6
                  ? `packages/${name}/src/${pick(AREAS, below)}`
                  : layout < 9
                    ? `packages/${name}/src/${pick(AREAS, below)}/${pick(LEAVES, below)}`
                    : `docs/${pick(PACKAGES, below)}`;
        const count = Math.min(
            devWorkloadCorpus.fileCount - paths.length,
            4 + below(21)
        );
        for (let file = 0; file < count; file += 1) {
            const suffix = String(paths.length).padStart(4, "0");
            paths.push(`${parent}/${pick(WORDS, below)}-${suffix}.ts`);
        }
    }
    return paths;
};

/** The synthetic tree in path order, which is also Git's index order. */
export const buildDevWorkloadCorpus = () => {
    const sizes = createRandom(1);
    const files = planCorpusPaths()
        .map((path, index) => ({
            path,
            content: renderText(
                `// ${path}\n`,
                pickSize(sizes),
                createRandom(1000 + index)
            ),
        }))
        .sort((left, right) => (left.path < right.path ? -1 : 1));
    return {
        files,
        totalBytes: files.reduce((sum, file) => sum + file.content.length, 0),
    };
};

/** A git fast-import stream that recreates the pinned commit exactly. */
export const createDevWorkloadFastImportStream = ({ files }) =>
    Buffer.concat([
        ...files.flatMap(({ content }, index) => [
            Buffer.from(`blob\nmark :${index + 1}\ndata ${content.length}\n`),
            content,
            Buffer.from("\n"),
        ]),
        Buffer.from(
            `commit refs/heads/main\nauthor ${COMMIT_SIGNATURE}\ncommitter ${COMMIT_SIGNATURE}\ndata ${COMMIT_MESSAGE.length}\n${COMMIT_MESSAGE}${files
                .map(({ path }, index) => `M 100644 :${index + 1} ${path}\n`)
                .join("")}\n`
        ),
    ]);

/** One exactly-1 KiB JSONL record per sequence number. */
export const createDevWorkloadJsonlLines = (first, count) => {
    const bytes = Buffer.alloc(count * JSONL_LINE_BYTES);
    const alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (let line = 0; line < count; line += 1) {
        const sequence = first + line;
        const below = createRandom(200_000 + sequence);
        const head = `{"seq":${sequence},"ts":"2026-01-01T00:00:00.${String(sequence % 1000).padStart(3, "0")}Z","type":"tool_result","session":"dev-workload","text":"`;
        const tail = `"}\n`;
        const offset = line * JSONL_LINE_BYTES;
        bytes.write(head, offset, "latin1");
        const padEnd = offset + JSONL_LINE_BYTES - tail.length;
        for (let index = offset + head.length; index < padEnd; index += 1) {
            bytes[index] = alphabet.charCodeAt(below(64));
        }
        bytes.write(tail, padEnd, "latin1");
    }
    return bytes;
};

const execFileAsync = promisify(execFile);

class DevWorkloadOperationError extends Error {}

// safe.directory: FUSE and WinFsp mounts may report another owner.
// gc/maintenance: no background work after a clone may leak into a later
// sample window.
const GIT_GLOBAL_CONFIG = `[safe]
\tdirectory = *
[init]
\tdefaultBranch = main
[core]
\tautocrlf = false
[gc]
\tauto = 0
[maintenance]
\tauto = false
`;

/**
 * Run git with an isolated configuration. Each call resolves with its stdout
 * and the sample window from spawn until the process exits.
 */
const createGitRunner = async (workspace, executable, signal, harness) => {
    const home = join(workspace, "home");
    await mkdir(home);
    await writeFile(join(home, ".gitconfig"), GIT_GLOBAL_CONFIG);
    const env = {
        ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key))
        ),
        HOME: home,
        XDG_CONFIG_HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
        LC_ALL: "C",
    };
    return async (args, { cwd = workspace, input } = {}) => {
        const started = harness.now();
        const pending = execFileAsync(executable, args, {
            cwd,
            env,
            signal,
            maxBuffer: 8 << 20,
            windowsHide: true,
        });
        pending.child.stdin.on("error", () => {}).end(input);
        try {
            const { stdout } = await pending;
            return {
                stdout,
                window: harness.sampleWindow(started, harness.now()),
            };
        } catch (error) {
            harness.throwIfAborted(signal);
            throw new DevWorkloadOperationError(
                `git ${args[0]} exited with ${error.code ?? error.signal}: ${error.stderr || error.message}`
            );
        }
    };
};

// A failed git command, a filesystem error code, a SQLite error or a missing
// node:sqlite is recorded as not measured; anything else fails the run.
const isOperationFailure = (error) =>
    error instanceof DevWorkloadOperationError ||
    /^(E[A-Z0-9]+|ERR_SQLITE_ERROR|ERR_UNKNOWN_BUILTIN_MODULE)$/u.test(
        error?.code ?? ""
    );

const measureEditSave = async ({ root, harness, measure, runs }, name) => {
    const directory = join(root, "dev-edit-save");
    const target = join(directory, "module.ts");
    const temporary = join(directory, ".module.ts.save-tmp");
    const versions = Array.from({ length: runs(name) + 1 }, (_, version) =>
        renderText(
            `// module.ts version ${version}\n`,
            EDIT_SAVE_BYTES,
            createRandom(100_000 + version)
        )
    );
    await mkdir(directory);
    await harness.durableWrite(target, versions[0]);
    await measure(
        name,
        {
            operation: "atomic-save",
            logicalBytes: EDIT_SAVE_BYTES,
            semantics:
                "open-temp-exclusive/write/fsync/close/rename-over-original",
        },
        async (index) => {
            const bytes = versions[index + 1];
            const started = harness.now();
            const phases = await harness.timedHandleOperation({
                path: temporary,
                flags: "wx",
                sync: true,
                io: (handle) => harness.writeAll(handle, bytes),
            });
            const renameStarted = harness.now();
            await rename(temporary, target);
            const renameNs = harness.elapsed(renameStarted);
            const sample = {
                ...phases,
                ...harness.sampleWindow(started, harness.now()),
                renameNs,
            };
            harness.assertBytes(await readFile(target), bytes, name);
            return sample;
        },
        () => rm(directory, { recursive: true, force: true })
    );
};

const measureJsonl = async (
    { root, harness, measure, runs },
    name,
    checkpoint
) => {
    const directory = join(root, `dev-jsonl-${checkpoint}`);
    const path = join(directory, "session.jsonl");
    // The whole expected log: the untimed base, then one line per run.
    const expected = createDevWorkloadJsonlLines(
        0,
        checkpoint / JSONL_LINE_BYTES + runs(name)
    );
    await mkdir(directory);
    await harness.durableWrite(path, expected.subarray(0, checkpoint));
    await measure(
        name,
        {
            operation: "append",
            logicalBytes: JSONL_LINE_BYTES,
            baseFileBytes: checkpoint,
            semantics: "open-append/write/fsync/close",
        },
        async (index) => {
            const end = checkpoint + (index + 1) * JSONL_LINE_BYTES;
            const bytes = expected.subarray(end - JSONL_LINE_BYTES, end);
            const sample = await harness.timedHandleOperation({
                path,
                flags: "a",
                sync: true,
                io: (handle) => handle.appendFile(bytes),
            });
            // The log grows from the requested base by one line per run.
            const { size } = await stat(path);
            if (size !== end) {
                throw new Error(`${name}: log is ${size} bytes, not ${end}`);
            }
            return sample;
        },
        async () => {
            harness.assertBytes(await readFile(path), expected, name);
            await rm(directory, { recursive: true, force: true });
        }
    );
};

const measureSqlite = async (
    { root, options, harness, measure, runs },
    name
) => {
    const { DatabaseSync } = await import("node:sqlite");
    const directory = join(root, "dev-sqlite");
    const path = join(directory, "app.db");
    const payloads = Array.from({ length: runs(name) }, (_, index) =>
        createDevWorkloadJsonlLines(300_000 + index, 1).subarray(
            0,
            SQLITE_PAYLOAD_BYTES
        )
    );
    await mkdir(directory);
    let database = new DatabaseSync(path);
    let rows = 0;
    try {
        const value = (sql, connection = database) =>
            Object.values(connection.prepare(sql).get())[0];
        const databaseBytes = () =>
            value("PRAGMA page_count") * value("PRAGMA page_size");
        database.exec(
            "CREATE TABLE events (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, kind TEXT NOT NULL, payload BLOB NOT NULL); CREATE INDEX events_kind_created ON events (kind, created_at);"
        );
        const insert = database.prepare(
            "INSERT INTO events (created_at, kind, payload) VALUES (?, ?, ?)"
        );
        // Untimed: grow the database to the overwrite base size in one
        // transaction, so each timed commit rewrites pages of a large file.
        const prefill = createDevWorkloadJsonlLines(400_000, 1);
        database.exec("BEGIN");
        while (databaseBytes() < options.overwriteBaseBytes) {
            for (let batch = 0; batch < 64; batch += 1) {
                insert.run(rows, WORDS[rows % WORDS.length], prefill);
                rows += 1;
            }
        }
        database.exec("COMMIT");
        await measure(
            name,
            {
                operation: "sqlite-transaction",
                itemCount: 1,
                baseFileBytes: options.overwriteBaseBytes,
                semantics:
                    "BEGIN/INSERT one row/COMMIT through node:sqlite with the default rollback journal and synchronous level",
                sqlite: {
                    version: value("SELECT sqlite_version()"),
                    journalMode: value("PRAGMA journal_mode"),
                    prefillBytes: databaseBytes(),
                },
            },
            (index) => {
                const started = harness.now();
                database.exec("BEGIN");
                insert.run(rows, "event", payloads[index]);
                database.exec("COMMIT");
                const sample = harness.sampleWindow(started, harness.now());
                rows += 1;
                return sample;
            },
            async () => {
                database.close();
                database = undefined;
                const reopened = new DatabaseSync(path);
                try {
                    const integrity = value("PRAGMA integrity_check", reopened);
                    const count = value(
                        "SELECT count(*) FROM events",
                        reopened
                    );
                    if (integrity !== "ok" || count !== rows) {
                        throw new Error(
                            `${name}: reopened database failed validation (${integrity}, ${count}/${rows} rows)`
                        );
                    }
                } finally {
                    reopened.close();
                }
                await rm(directory, { recursive: true, force: true });
            }
        );
    } finally {
        database?.close();
    }
};

const measureGit = async (context, cloneName, statusName) => {
    const { root, workspace, options, signal, harness, measure, section } =
        context;
    const git = await createGitRunner(
        workspace,
        options.devGitExecutable,
        signal,
        harness
    );
    section.gitVersion = (await git(["--version"])).stdout.trim();
    const corpus = buildDevWorkloadCorpus();
    const origin = join(workspace, "origin.git");
    await git(["init", "--bare", "--quiet", origin]);
    await git(["fast-import", "--quiet"], {
        cwd: origin,
        input: createDevWorkloadFastImportStream(corpus),
    });
    const commit = (
        await git(["rev-parse", "refs/heads/main"], { cwd: origin })
    ).stdout.trim();
    if (commit !== devWorkloadCorpus.gitCommitSha1) {
        throw new Error(
            `git fast-import produced ${commit}, expected ${devWorkloadCorpus.gitCommitSha1}`
        );
    }
    const directory = join(root, "dev-git");
    await mkdir(directory);
    let checkout;
    let cloneEndedMs;
    const at = (fraction) =>
        corpus.files[Math.floor(fraction * corpus.files.length)];
    const pathOf = (file) => join(checkout, ...file.path.split("/"));
    await measure(
        cloneName,
        {
            operation: "git-clone",
            itemCount: devWorkloadCorpus.fileCount,
            logicalBytes: devWorkloadCorpus.totalBytes,
            semantics:
                "spawn git clone --no-local --quiet --template= from a local bare origin: pack transfer, index-pack and a full checkout into the target, until the process exits",
        },
        async (index) => {
            // Untimed: keep one checkout in the target. The last one stays
            // for the status scenario.
            if (checkout) await rm(checkout, { recursive: true, force: true });
            checkout = join(directory, `clone-${index}`);
            const { window } = await git(
                [
                    "clone",
                    "--no-local",
                    "--quiet",
                    "--template=",
                    "--",
                    origin,
                    checkout,
                ],
                { cwd: directory }
            );
            cloneEndedMs = Date.now();
            for (let spot = 0; spot < CHECKOUT_SPOT_CHECKS; spot += 1) {
                const file = at(spot / CHECKOUT_SPOT_CHECKS);
                harness.assertBytes(
                    await readFile(pathOf(file)),
                    file.content,
                    `${cloneName} ${file.path}`
                );
            }
            return window;
        }
    );
    // Untimed: Git compares file and index mtimes in whole seconds, and each
    // status re-hashes every file written in the index's second until an
    // index write lands in a later one. Leave the last clone's second once,
    // then refresh the index, so both targets time a steady-state status.
    await sleep(
        (Math.floor(cloneEndedMs / 1000) + 1) * 1000 + 50 - Date.now(),
        undefined,
        { signal }
    );
    await git(["update-index", "-q", "--refresh"], { cwd: checkout });
    // Untimed: the developer's edits before the status runs. Each grows its
    // file, so Git reports it by size without hashing.
    const edited = Array.from({ length: STATUS_MODIFIED_FILES }, (_, index) =>
        at((index + 0.5) / STATUS_MODIFIED_FILES)
    );
    for (const file of edited) {
        await writeFile(pathOf(file), `${file.content}// edited\n`);
    }
    const expected = edited.map(({ path }) => ` M ${path}\n`).join("");
    await measure(
        statusName,
        {
            operation: "git-status",
            itemCount: devWorkloadCorpus.fileCount,
            semantics: `spawn git status --porcelain after untimed edits to ${STATUS_MODIFIED_FILES} tracked files, until the process exits`,
        },
        async () => {
            const { stdout, window } = await git(["status", "--porcelain"], {
                cwd: checkout,
            });
            if (stdout !== expected) {
                throw new Error(`${statusName}: unexpected status: ${stdout}`);
            }
            return window;
        }
    );
};

/**
 * Run the developer workload below `root`. `harness` supplies the core
 * benchmark's clock, sample collection and file primitives.
 */
export const executeDevWorkload = async (root, options, signal, harness) => {
    const names = devWorkloadScenarioNames(options);
    const scenarios = [];
    const section = { corpus: devWorkloadCorpus, notMeasured: [] };
    let stage;
    const counts = (name) => devWorkloadSampleCounts(name, options);
    const workspace = await mkdtemp(join(tmpdir(), "peerbit-dev-workload-"));
    const context = {
        root,
        options,
        signal,
        harness,
        section,
        workspace,
        runs: (name) => counts(name).samples + counts(name).warmups,
        // Collect one scenario, run `finish` (validation and cleanup), then
        // add its record.
        measure: async (name, record, sample, finish) => {
            const { warmups } = counts(name);
            const runs = await harness.collect(
                counts(name),
                signal,
                (index) => {
                    stage =
                        index < warmups
                            ? `warmup ${index + 1}`
                            : `sample ${index + 1 - warmups}`;
                    return sample(index);
                }
            );
            stage = "validation";
            await finish?.();
            stage = "setup";
            scenarios.push({
                name,
                ...record,
                ...runs,
                summary: harness.summarize(
                    runs.samples,
                    record.logicalBytes,
                    record.itemCount
                ),
            });
        },
    };
    // An operation failure lists each of `scenarioNames` not yet measured,
    // with the failing warmup, sample or stage; anything else fails the run.
    const attempt = async (scenarioNames, run) => {
        harness.throwIfAborted(signal);
        stage = "setup";
        try {
            await run();
        } catch (error) {
            harness.throwIfAborted(signal);
            if (!isOperationFailure(error)) throw error;
            const reason = `${stage}: ${error.message}`
                .replaceAll(root, "<root>")
                .replace(/\s+/gu, " ")
                .trim()
                .slice(0, 400);
            for (const scenario of scenarioNames) {
                if (!scenarios.some(({ name }) => name === scenario)) {
                    section.notMeasured.push({ scenario, reason });
                }
            }
        }
    };
    try {
        const [editSave, jsonlSmall, jsonlLarge, sqlite, ...git] = names;
        await attempt([editSave], () => measureEditSave(context, editSave));
        await attempt([jsonlSmall], () =>
            measureJsonl(context, jsonlSmall, JSONL_CHECKPOINT_BYTES[0])
        );
        await attempt([jsonlLarge], () =>
            measureJsonl(context, jsonlLarge, JSONL_CHECKPOINT_BYTES[1])
        );
        await attempt([sqlite], () => measureSqlite(context, sqlite));
        await attempt(git, () => measureGit(context, ...git));
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
    return { scenarios, section };
};

const mebibytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

export const formatDevWorkloadSummaryLines = (report) => {
    const section = report.devWorkload;
    if (!section) return [];
    const { corpus, gitVersion, notMeasured } = section;
    const sqlite = report.scenarios.find(({ name }) =>
        name.startsWith("sqlite-")
    )?.sqlite;
    return [
        "",
        `Developer workload: corpus ${corpus.id} (${corpus.fileCount} files, ${mebibytes(corpus.totalBytes)}, commit ${corpus.gitCommitSha1.slice(0, 12)}); ${gitVersion ?? "git unavailable"}; ${sqlite ? `SQLite ${sqlite.version}, ${sqlite.journalMode} journal, ${mebibytes(sqlite.prefillBytes)} database` : "SQLite not measured"}`,
        ...(notMeasured.length > 0 ? ["", "Not measured:"] : []),
        ...notMeasured.map(
            ({ scenario, reason }) => `- ${scenario}: ${reason}`
        ),
    ];
};
