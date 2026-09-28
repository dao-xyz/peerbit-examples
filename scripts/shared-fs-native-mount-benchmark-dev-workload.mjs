// Opt-in, report-only "developer machine" scenarios for the mounted-path
// benchmark: a git clone/checkout of a deterministic synthetic source tree,
// `git status` metadata storms, editor-style atomic saves, fsync'd JSONL
// appends to growing logs, and small SQLite transactions in a large database.
//
// Every input is generated locally from a fixed seed; nothing is downloaded.
// The git origin is a local bare repository built with `git fast-import`
// outside the target, so only the clone and checkout write into the target.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
    lstat,
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
import { fileURLToPath } from "node:url";

export const DEV_WORKLOAD_MODULE_PATH = fileURLToPath(import.meta.url);

export const DEV_WORKLOAD_SUITE = "developer-workload";

const CORPUS_SEED_UINT32 = 0x5d2a91c7;
const WORD_STEP_UINT32 = 0x9e3779b9;
const CORPUS_FILE_COUNT = 2000;
const COMMIT_IDENTITY = "Peerbit Benchmark <benchmark@peerbit.invalid>";
const COMMIT_TIME = "1700000000 +0000";
const COMMIT_MESSAGE = "synthetic-source-tree-v1\n";
const EDIT_SAVE_BYTES = 20 << 10;
const JSONL_LINE_BYTES = 1024;
// The two base sizes offered by the workflow's overwrite_base_bytes input, so
// the append scenarios cover both regardless of which one a run selected.
const JSONL_CHECKPOINT_BYTES = [4 << 20, 32 << 20];
const SQLITE_PAYLOAD_BYTES = 256;
const SQLITE_PREFILL_PAYLOAD_BYTES = 1024;
const STATUS_MODIFIED_FILES = 10;
const CHECKOUT_SPOT_CHECKS = 16;
const MAX_CAPTURE_BYTES = 8 << 20;
const MAX_REASON_LENGTH = 400;

/**
 * The pinned synthetic source tree. The generator is verified against these
 * values before every use, so a run can never silently measure another tree.
 */
export const devWorkloadCorpus = Object.freeze({
    id: "synthetic-source-tree-v1",
    seedUint32: CORPUS_SEED_UINT32,
    wordStepUint32: WORD_STEP_UINT32,
    fileCount: CORPUS_FILE_COUNT,
    directoryCount: 135,
    totalBytes: 17_546_290,
    manifestSha256:
        "d33fd46678e09b85f80c682ded2bb055dbaa483fc5c9a8e04fde5e9e8c3e8597",
    gitTreeSha1: "728fb3e755f039c34d25bc2939bea4ff37ec1399",
    gitCommitSha1: "b26b584a39f7b29ed22a3ab875de86dff2ac3232",
    commit: Object.freeze({
        identity: COMMIT_IDENTITY,
        time: COMMIT_TIME,
        message: COMMIT_MESSAGE.trimEnd(),
    }),
    generation:
        "counter-mix32 PRNG; integer size buckets (12% 64 B-512 B, 28% 512 B-2 KiB, 36% 2-8 KiB, 19% 8-32 KiB, 5% 32-64 KiB); ASCII source-like text; imported into a local bare origin with git fast-import",
});

export const devWorkloadScenarioNames = (options) => [
    `edit-save-${EDIT_SAVE_BYTES}`,
    ...JSONL_CHECKPOINT_BYTES.map(
        (bytes) => `jsonl-append-${JSONL_LINE_BYTES}-at-${bytes}`
    ),
    `sqlite-insert-txn-in-${options.overwriteBaseBytes}`,
    `git-clone-checkout-${CORPUS_FILE_COUNT}`,
    `git-status-clean-${CORPUS_FILE_COUNT}`,
    `git-status-porcelain-${STATUS_MODIFIED_FILES}-modified`,
];

const GIT_SCENARIO_PATTERN = /^git-/u;
const SQLITE_SCENARIO_PATTERN = /^sqlite-/u;
const GIT_CLONE_SCENARIO = `git-clone-checkout-${CORPUS_FILE_COUNT}`;

/** Git scenarios are heavy, so they have their own sample counts. */
export const isDevWorkloadGitScenario = (name) =>
    GIT_SCENARIO_PATTERN.test(name);

const NOT_MEASURED_CAUSES = new Set([
    "tool-unavailable",
    "operation-failed",
    "dependency-not-measured",
]);

// ---------------------------------------------------------------------------
// Deterministic corpus
// ---------------------------------------------------------------------------

const mixUint32 = (input) => {
    let value = input >>> 0;
    value ^= value >>> 16;
    value = Math.imul(value, 0x7feb352d);
    value ^= value >>> 15;
    value = Math.imul(value, 0x846ca68b);
    value ^= value >>> 16;
    return value >>> 0;
};

/** Counter-based stream: word n depends only on (seed, stream, n). */
const createRandom = (stream) => {
    const base =
        (CORPUS_SEED_UINT32 ^ mixUint32(Math.imul(stream + 1, 0x85ebca6b))) >>>
        0;
    let counter = 0;
    const next = () => mixUint32(base + Math.imul(counter++, WORD_STEP_UINT32));
    return { next, below: (bound) => next() % bound };
};

const PACKAGE_NAMES = [
    "app",
    "auth",
    "cli",
    "client",
    "config",
    "core",
    "network",
    "server",
    "shared",
    "storage",
    "testing",
    "ui",
];
const AREA_NAMES = [
    "api",
    "hooks",
    "model",
    "service",
    "store",
    "types",
    "util",
    "view",
];
const LEAF_NAMES = [
    "adapters",
    "components",
    "fixtures",
    "handlers",
    "helpers",
    "internal",
];
const STEMS = [
    "buffer",
    "cache",
    "client",
    "codec",
    "config",
    "format",
    "graph",
    "index",
    "parser",
    "queue",
    "reader",
    "router",
    "schema",
    "server",
    "session",
    "store",
    "stream",
    "token",
    "worker",
    "writer",
];
const WORDS = [
    "account",
    "adapter",
    "alpha",
    "array",
    "batch",
    "beta",
    "buffer",
    "cache",
    "channel",
    "chunk",
    "client",
    "commit",
    "config",
    "context",
    "cursor",
    "delta",
    "digest",
    "entry",
    "event",
    "field",
    "filter",
    "frame",
    "handle",
    "header",
    "index",
    "input",
    "key",
    "layer",
    "limit",
    "local",
    "merge",
    "model",
    "node",
    "offset",
    "option",
    "output",
    "packet",
    "page",
    "parent",
    "path",
    "peer",
    "range",
    "reader",
    "record",
    "remote",
    "request",
    "result",
    "route",
    "schema",
    "segment",
    "session",
    "signal",
    "state",
    "status",
    "stream",
    "target",
    "timer",
    "token",
    "update",
    "value",
    "version",
    "view",
    "window",
    "writer",
];
const ROOT_FILES = [
    ".editorconfig",
    ".gitignore",
    "LICENSE",
    "README.md",
    "package.json",
    "tsconfig.json",
];
// [weight percent, minimum bytes, maximum bytes (exclusive)]
const SIZE_BUCKETS = [
    [12, 64, 512],
    [28, 512, 2048],
    [36, 2048, 8192],
    [19, 8192, 32768],
    [5, 32768, 65536],
];
// [weight percent, extension]
const SOURCE_EXTENSIONS = [
    [70, ".ts"],
    [10, ".tsx"],
    [8, ".json"],
    [6, ".css"],
    [6, ".js"],
];

const pickWeighted = (entries, random) => {
    let roll = random.below(100);
    for (const [weight, ...value] of entries) {
        if (roll < weight) return value;
        roll -= weight;
    }
    return entries.at(-1).slice(1);
};

const pick = (values, random) => values[random.below(values.length)];
const capitalize = (word) => word[0].toUpperCase() + word.slice(1);

const codeLine = (random) => {
    const indent = "    ".repeat(random.below(4));
    const a = pick(WORDS, random);
    const b = pick(WORDS, random);
    const c = pick(WORDS, random);
    switch (random.below(8)) {
        case 0:
            return `${indent}const ${a}${capitalize(b)} = ${c}(${pick(WORDS, random)}, ${random.below(4096)});\n`;
        case 1:
            return `${indent}if (${a}.${b} !== ${c}) {\n`;
        case 2:
            return `${indent}}\n`;
        case 3:
            return `${indent}return ${a}.${b}(${c});\n`;
        case 4:
            return `${indent}// ${a} ${b} ${c} ${pick(WORDS, random)} ${pick(WORDS, random)}\n`;
        case 5:
            return `${indent}export function ${a}${capitalize(b)}(${c}: ${capitalize(pick(WORDS, random))}): void {\n`;
        case 6:
            return `${indent}${a}.${b} = await ${c}.${pick(WORDS, random)}();\n`;
        default:
            return `${indent}import { ${a}, ${b} } from "./${c}";\n`;
    }
};

const proseLine = (random) => {
    const words = Array.from({ length: 6 + random.below(10) }, () =>
        pick(WORDS, random)
    );
    return random.below(6) === 0
        ? `## ${capitalize(words.slice(0, 3).join(" "))}\n\n`
        : `${capitalize(words.join(" "))}.\n`;
};

const jsonLine = (random) =>
    `    "${pick(WORDS, random)}${capitalize(pick(WORDS, random))}": "${pick(WORDS, random)}-${random.below(65536)}",\n`;

/** Exactly `size` ASCII bytes of source-like text starting with `header`. */
const renderText = (header, size, random, line) => {
    const parts = [header];
    let length = header.length;
    while (length < size) {
        const next = line(random);
        parts.push(next);
        length += next.length;
    }
    const text = parts.join("").slice(0, Math.max(0, size - 1));
    return Buffer.from(size > 0 ? `${text}\n` : "", "latin1");
};

const renderFile = (path, size, random) => {
    if (path.endsWith(".md") || path === "LICENSE") {
        return renderText(`# ${path}\n\n`, size, random, proseLine);
    }
    if (path.endsWith(".json")) {
        return renderText(`{\n    "//": "${path}",\n`, size, random, jsonLine);
    }
    return renderText(`// ${path}\n`, size, random, codeLine);
};

const sha1 = (...parts) => {
    const hash = createHash("sha1");
    for (const part of parts) hash.update(part);
    return hash.digest();
};

const gitObjectId = (type, body) =>
    sha1(Buffer.from(`${type} ${body.byteLength}\0`, "latin1"), body);

// Git orders tree entries by name, comparing directory names as if they had
// a trailing slash. Every generated name is ASCII, so UTF-16 order is bytewise.
const treeEntryKey = (name, directory) => (directory ? `${name}/` : name);

const hashTree = (node) => {
    const entries = [...node.entries()].map(([name, value]) => {
        const directory = value instanceof Map;
        return {
            key: treeEntryKey(name, directory),
            name,
            mode: directory ? "40000" : "100644",
            id: directory ? hashTree(value) : value,
        };
    });
    entries.sort((left, right) =>
        left.key < right.key ? -1 : left.key > right.key ? 1 : 0
    );
    const body = Buffer.concat(
        entries.flatMap(({ mode, name, id }) => [
            Buffer.from(`${mode} ${name}\0`, "latin1"),
            id,
        ])
    );
    return gitObjectId("tree", body);
};

const planCorpusPaths = () => {
    const random = createRandom(0);
    const paths = [...ROOT_FILES];
    for (let directory = 0; paths.length < CORPUS_FILE_COUNT; directory += 1) {
        const packageName = PACKAGE_NAMES[directory % PACKAGE_NAMES.length];
        const layout = random.below(10);
        let parent;
        let extensions = SOURCE_EXTENSIONS;
        if (layout < 2) {
            parent = `packages/${packageName}/test`;
            extensions = [[100, ".test.ts"]];
        } else if (layout < 6) {
            parent = `packages/${packageName}/src/${pick(AREA_NAMES, random)}`;
        } else if (layout < 9) {
            parent = `packages/${packageName}/src/${pick(AREA_NAMES, random)}/${pick(LEAF_NAMES, random)}`;
        } else {
            parent = `docs/${pick(PACKAGE_NAMES, random)}`;
            extensions = [[100, ".md"]];
        }
        const count = Math.min(
            CORPUS_FILE_COUNT - paths.length,
            4 + random.below(21)
        );
        for (let file = 0; file < count; file += 1) {
            const [extension] = pickWeighted(extensions, random);
            const index = String(paths.length).padStart(4, "0");
            paths.push(`${parent}/${pick(STEMS, random)}-${index}${extension}`);
        }
    }
    return paths;
};

/**
 * Build the synthetic source tree in memory. Returns the files (sorted by
 * path, which is also Git's index order for these names) and their digests.
 */
export const buildDevWorkloadCorpus = () => {
    const sizeRandom = createRandom(1);
    const files = planCorpusPaths().map((path, index) => {
        const [minimum, maximum] = pickWeighted(SIZE_BUCKETS, sizeRandom);
        const size = minimum + sizeRandom.below(maximum - minimum);
        const content = renderFile(path, size, createRandom(1000 + index));
        return { path, content };
    });
    files.sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
    const root = new Map();
    const directories = new Set();
    const manifest = createHash("sha256");
    let totalBytes = 0;
    for (const file of files) {
        const segments = file.path.split("/");
        let node = root;
        for (const [depth, segment] of segments.slice(0, -1).entries()) {
            directories.add(segments.slice(0, depth + 1).join("/"));
            if (!node.has(segment)) node.set(segment, new Map());
            node = node.get(segment);
        }
        file.blobId = gitObjectId("blob", file.content);
        node.set(segments.at(-1), file.blobId);
        manifest.update(
            `${file.path}\0${file.content.byteLength}\0${createHash("sha256").update(file.content).digest("hex")}\n`
        );
        totalBytes += file.content.byteLength;
    }
    const gitTreeSha1 = hashTree(root).toString("hex");
    const commitBody = Buffer.from(
        `tree ${gitTreeSha1}\nauthor ${COMMIT_IDENTITY} ${COMMIT_TIME}\ncommitter ${COMMIT_IDENTITY} ${COMMIT_TIME}\n\n${COMMIT_MESSAGE}`,
        "utf8"
    );
    return Object.freeze({
        files,
        directoryCount: directories.size,
        totalBytes,
        manifestSha256: manifest.digest("hex"),
        gitTreeSha1,
        gitCommitSha1: gitObjectId("commit", commitBody).toString("hex"),
    });
};

let corpusCache;
/** The corpus, built once per process (about 17 MiB in memory). */
export const generateDevWorkloadCorpus = () =>
    (corpusCache ??= buildDevWorkloadCorpus());

class DevWorkloadValidationError extends Error {}
class DevWorkloadOperationError extends Error {}

/** Fail loudly if the generator no longer reproduces the pinned tree. */
export const verifyDevWorkloadCorpus = (
    corpus = generateDevWorkloadCorpus()
) => {
    for (const key of [
        "directoryCount",
        "totalBytes",
        "manifestSha256",
        "gitTreeSha1",
        "gitCommitSha1",
    ]) {
        if (corpus[key] !== devWorkloadCorpus[key]) {
            throw new DevWorkloadValidationError(
                `developer-workload corpus ${key} drifted: ${corpus[key]} !== ${devWorkloadCorpus[key]}`
            );
        }
    }
    if (corpus.files.length !== devWorkloadCorpus.fileCount) {
        throw new DevWorkloadValidationError(
            "developer-workload corpus file count drifted"
        );
    }
    return corpus;
};

/** A git fast-import stream that recreates the pinned commit exactly. */
export const createDevWorkloadFastImportStream = (corpus) => {
    const parts = [];
    for (const [index, file] of corpus.files.entries()) {
        parts.push(
            Buffer.from(
                `blob\nmark :${index + 1}\ndata ${file.content.byteLength}\n`,
                "latin1"
            ),
            file.content,
            Buffer.from("\n", "latin1")
        );
    }
    const message = Buffer.from(COMMIT_MESSAGE, "utf8");
    parts.push(
        Buffer.from(
            `commit refs/heads/main\nauthor ${COMMIT_IDENTITY} ${COMMIT_TIME}\ncommitter ${COMMIT_IDENTITY} ${COMMIT_TIME}\ndata ${message.byteLength}\n`,
            "utf8"
        ),
        message,
        Buffer.from(
            corpus.files
                .map(({ path }, index) => `M 100644 :${index + 1} ${path}\n`)
                .join("") + "\n",
            "latin1"
        )
    );
    return Buffer.concat(parts);
};

/** One exactly-1 KiB JSONL record per sequence number. */
export const createDevWorkloadJsonlLines = (first, count) => {
    const bytes = Buffer.alloc(count * JSONL_LINE_BYTES);
    const alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (let line = 0; line < count; line += 1) {
        const sequence = first + line;
        const random = createRandom(200_000 + sequence);
        const head = `{"seq":${sequence},"ts":"2026-01-01T00:00:00.${String(sequence % 1000).padStart(3, "0")}Z","type":"tool_result","session":"dev-workload","text":"`;
        const tail = `"}\n`;
        const offset = line * JSONL_LINE_BYTES;
        bytes.write(head, offset, "latin1");
        const padEnd = offset + JSONL_LINE_BYTES - tail.length;
        for (let index = offset + head.length; index < padEnd; index += 1) {
            bytes[index] = alphabet.charCodeAt(random.below(64));
        }
        bytes.write(tail, padEnd, "latin1");
    }
    return bytes;
};

const editSaveVersion = (version) =>
    renderFile(
        `edit-save/module.ts (version ${version})`,
        EDIT_SAVE_BYTES,
        createRandom(100_000 + version)
    );

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const singleLine = (text, limit = MAX_REASON_LENGTH) => {
    const value = String(text).replace(/\s+/gu, " ").trim();
    return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
};

const errorText = (error) =>
    error instanceof Error
        ? `${typeof error.code === "string" && !error.message.includes(error.code) ? `${error.code}: ` : ""}${error.message}`
        : String(error);

const runProcess = (executable, args, { cwd, env, signal, input, now }) =>
    new Promise((resolvePromise, reject) => {
        let settled = false;
        const settle = (callback, value) => {
            if (settled) return;
            settled = true;
            callback(value);
        };
        const startedAt = now();
        let child;
        try {
            child = spawn(executable, args, {
                cwd,
                env,
                signal,
                stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
                windowsHide: true,
            });
        } catch (error) {
            settle(reject, error);
            return;
        }
        const capture = () => {
            const chunks = [];
            let bytes = 0;
            return {
                push(chunk) {
                    if (bytes < MAX_CAPTURE_BYTES) chunks.push(chunk);
                    bytes += chunk.byteLength;
                },
                text: () => Buffer.concat(chunks).toString("utf8"),
                truncated: () => bytes > MAX_CAPTURE_BYTES,
            };
        };
        const stdout = capture();
        const stderr = capture();
        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));
        child.once("error", (error) => settle(reject, error));
        child.once("close", (code, signalName) => {
            const endedAt = now();
            settle(resolvePromise, {
                code,
                signal: signalName,
                stdout: stdout.text(),
                stderr: stderr.text(),
                stdoutTruncated: stdout.truncated(),
                startedAt,
                endedAt,
            });
        });
        if (input) {
            child.stdin.once("error", () => {});
            child.stdin.end(input);
        }
    });

const createGitRunner = ({ executable, env, signal, now, root }) => {
    const run = async (args, { cwd, input } = {}) => {
        const result = await runProcess(executable, args, {
            cwd,
            env,
            signal,
            input,
            now,
        });
        if (result.code !== 0) {
            const subcommand =
                args.find((argument) => !argument.startsWith("-")) ?? "";
            const detail = singleLine(
                `${result.stderr} ${result.stdout}`.replaceAll(root, "<root>")
            );
            throw new DevWorkloadOperationError(
                `git ${subcommand} exited with ${result.code ?? result.signal}: ${detail || "no output"}`
            );
        }
        if (result.stdoutTruncated) {
            throw new DevWorkloadValidationError(
                `git ${args[0]} produced more than ${MAX_CAPTURE_BYTES} bytes`
            );
        }
        return result;
    };
    return run;
};

const isolatedGitEnvironment = (home) => {
    const environment = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (!/^GIT_/iu.test(key)) environment[key] = value;
    }
    return {
        ...environment,
        HOME: home,
        XDG_CONFIG_HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
        LANG: "C",
        LANGUAGE: "C",
    };
};

// safe.directory: FUSE and WinFsp mounts may report another owner.
// gc/maintenance: no background work after a clone may leak into a later
// sample window.
const GIT_GLOBAL_CONFIG = `[safe]
\tdirectory = *
[init]
\tdefaultBranch = main
[core]
\tautocrlf = false
[commit]
\tgpgSign = false
[gc]
\tauto = 0
[maintenance]
\tauto = false
[color]
\tui = false
`;

export const probeDevWorkloadGit = async ({
    executable = "git",
    env = process.env,
    signal,
    now = process.hrtime.bigint,
} = {}) => {
    try {
        const result = await runProcess(executable, ["--version"], {
            env,
            signal,
            now,
        });
        if (result.code !== 0) {
            return {
                available: false,
                executable,
                reason: singleLine(
                    `git --version exited with ${result.code ?? result.signal}: ${result.stderr}`
                ),
            };
        }
        return {
            available: true,
            executable,
            version: singleLine(result.stdout, 256),
        };
    } catch (error) {
        if (signal?.aborted) throw error;
        return {
            available: false,
            executable,
            reason:
                error?.code === "ENOENT"
                    ? `git executable not found: ${executable}`
                    : singleLine(`git --version failed: ${errorText(error)}`),
        };
    }
};

export const probeDevWorkloadSqlite = async (
    load = () => import("node:sqlite")
) => {
    try {
        const sqlite = await load();
        const database = new sqlite.DatabaseSync(":memory:");
        try {
            const { version } = database
                .prepare("SELECT sqlite_version() AS version")
                .get();
            return {
                tool: {
                    available: true,
                    module: "node:sqlite",
                    version: String(version),
                },
                api: sqlite,
            };
        } finally {
            database.close();
        }
    } catch (error) {
        return {
            tool: {
                available: false,
                module: "node:sqlite",
                reason: singleLine(
                    `node:sqlite is unavailable in Node ${process.version} (unflagged from Node 22.13): ${errorText(error)}`
                ),
            },
        };
    }
};

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const isOperationFailure = (error) =>
    error instanceof DevWorkloadOperationError ||
    error?.code === "ERR_SQLITE_ERROR" ||
    (typeof error?.code === "string" && /^E[A-Z0-9]+$/u.test(error.code));

const pathIn = (directory, relativePath) =>
    join(directory, ...relativePath.split("/"));

const absent = async (path) => {
    try {
        await lstat(path);
        return false;
    } catch (error) {
        if (error?.code === "ENOENT") return true;
        throw error;
    }
};

const appendAll = async (handle, bytes) => {
    let written = 0;
    while (written < bytes.byteLength) {
        const result = await handle.write(
            bytes,
            written,
            bytes.byteLength - written,
            null
        );
        if (result.bytesWritten <= 0)
            throw new Error("append made no progress");
        written += result.bytesWritten;
    }
};

// Each measure* function returns one scenario record. A thrown operation
// failure (a failed git command, a filesystem error code or a SQLite error)
// is recorded as not measured; a validation failure fails the whole run.

const measureEditSave = async (context, name, setStage) => {
    const { root, signal, light, lightRuns, harness } = context;
    const { now, elapsed, sampleWindow, collect, summarize } = harness;
    const directory = join(root, "dev-edit-save");
    const target = join(directory, "module.ts");
    const temporary = join(directory, ".module.ts.save-tmp");
    const versions = Array.from({ length: lightRuns + 1 }, (_, index) =>
        editSaveVersion(index)
    );
    await mkdir(directory);
    await harness.durableWrite(target, versions[0]);
    const runs = await collect(
        light,
        signal,
        context.staged(setStage, light.warmups, async (index) => {
            const bytes = versions[index + 1];
            const started = now();
            const phases = await harness.timedHandleOperation({
                path: temporary,
                flags: "wx",
                sync: true,
                io: (handle) => harness.writeAll(handle, bytes),
            });
            const renameStarted = now();
            await rename(temporary, target);
            const renameNs = elapsed(renameStarted);
            const sample = {
                ...sampleWindow(started, now()),
                openNs: phases.openNs,
                ioNs: phases.ioNs,
                fsyncNs: phases.fsyncNs,
                closeNs: phases.closeNs,
                renameNs,
            };
            harness.throwIfAborted(signal);
            harness.assertBytes(await readFile(target), bytes, name);
            if (!(await absent(temporary))) {
                throw new DevWorkloadValidationError(
                    `${name} left its temporary file behind`
                );
            }
            return sample;
        })
    );
    setStage("cleanup");
    await rm(directory, { recursive: true, force: true });
    return {
        name,
        suite: DEV_WORKLOAD_SUITE,
        operation: "atomic-save",
        logicalBytes: EDIT_SAVE_BYTES,
        semantics: "open-temp-exclusive/write/fsync/close/rename-over-original",
        ...runs,
        summary: summarize(runs.samples, EDIT_SAVE_BYTES),
    };
};

const measureJsonlAppend = async (context, name, setStage, checkpoint) => {
    const { root, signal, light, lightRuns, harness } = context;
    const directory = join(root, `dev-jsonl-${checkpoint}`);
    const path = join(directory, "session.jsonl");
    let lines = checkpoint / JSONL_LINE_BYTES;
    await mkdir(directory);
    await harness.durableWrite(path, createDevWorkloadJsonlLines(0, lines));
    const appended = createDevWorkloadJsonlLines(lines, lightRuns);
    const runs = await harness.collect(
        light,
        signal,
        context.staged(setStage, light.warmups, async (index) => {
            const bytes = appended.subarray(
                index * JSONL_LINE_BYTES,
                (index + 1) * JSONL_LINE_BYTES
            );
            const sample = await harness.timedHandleOperation({
                path,
                flags: "a",
                sync: true,
                io: (handle) => appendAll(handle, bytes),
            });
            lines += 1;
            harness.throwIfAborted(signal);
            const { size } = await stat(path);
            if (size !== lines * JSONL_LINE_BYTES) {
                throw new DevWorkloadValidationError(
                    `${name}: log is ${size} bytes after ${lines} lines`
                );
            }
            return sample;
        })
    );
    setStage("validation");
    harness.assertBytes(
        await readFile(path),
        createDevWorkloadJsonlLines(0, lines),
        name
    );
    setStage("cleanup");
    await rm(directory, { recursive: true, force: true });
    return {
        name,
        suite: DEV_WORKLOAD_SUITE,
        operation: "append",
        logicalBytes: JSONL_LINE_BYTES,
        baseFileBytes: checkpoint,
        semantics: "open-append/write/fsync/close",
        ...runs,
        summary: harness.summarize(runs.samples, JSONL_LINE_BYTES),
    };
};

const sqliteValue = (database, sql) =>
    Object.values(database.prepare(sql).get())[0];

const measureSqlite = async (context, name, setStage) => {
    const { root, options, signal, light, lightRuns, harness, sqlite } =
        context;
    const directory = join(root, "dev-sqlite");
    const path = join(directory, "app.db");
    const payloads = Array.from({ length: lightRuns }, (_, index) =>
        createDevWorkloadJsonlLines(300_000 + index, 1).subarray(
            0,
            SQLITE_PAYLOAD_BYTES
        )
    );
    const prefillPayload = createDevWorkloadJsonlLines(400_000, 1).subarray(
        0,
        SQLITE_PREFILL_PAYLOAD_BYTES
    );
    await mkdir(directory);
    let rows = 0;
    let details;
    let runs;
    const database = new sqlite.api.DatabaseSync(path);
    try {
        database.exec(
            "CREATE TABLE events (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, kind TEXT NOT NULL, payload BLOB NOT NULL); CREATE INDEX events_kind_created ON events (kind, created_at);"
        );
        const insert = database.prepare(
            "INSERT INTO events (created_at, kind, payload) VALUES (?, ?, ?)"
        );
        const count = database.prepare("SELECT count(*) AS count FROM events");
        const databaseBytes = () =>
            Number(sqliteValue(database, "PRAGMA page_count")) *
            Number(sqliteValue(database, "PRAGMA page_size"));
        // Untimed: grow the database to the overwrite base size in one
        // transaction, so each timed commit rewrites pages of a large file.
        setStage("prefill");
        database.exec("BEGIN");
        while (databaseBytes() < options.overwriteBaseBytes) {
            for (let batch = 0; batch < 64; batch += 1) {
                insert.run(
                    1_700_000_000 + rows,
                    WORDS[rows % WORDS.length],
                    prefillPayload
                );
                rows += 1;
            }
        }
        database.exec("COMMIT");
        details = {
            version: sqlite.tool.version,
            journalMode: String(sqliteValue(database, "PRAGMA journal_mode")),
            synchronous: Number(sqliteValue(database, "PRAGMA synchronous")),
            pageSize: Number(sqliteValue(database, "PRAGMA page_size")),
            prefillRows: rows,
            prefillBytes: databaseBytes(),
            rowsPerTransaction: 1,
            payloadBytes: SQLITE_PAYLOAD_BYTES,
        };
        if (details.journalMode !== "delete") {
            throw new DevWorkloadValidationError(
                `${name}: the default journal mode is ${details.journalMode}, expected delete`
            );
        }
        runs = await harness.collect(
            light,
            signal,
            context.staged(setStage, light.warmups, async (index) => {
                const started = harness.now();
                database.exec("BEGIN");
                insert.run(
                    1_800_000_000 + index,
                    WORDS[index % WORDS.length],
                    payloads[index]
                );
                database.exec("COMMIT");
                const sample = harness.sampleWindow(started, harness.now());
                rows += 1;
                if (Number(count.get().count) !== rows) {
                    throw new DevWorkloadValidationError(
                        `${name}: row count diverged`
                    );
                }
                return sample;
            })
        );
    } finally {
        database.close();
    }
    setStage("validation");
    const reopened = new sqlite.api.DatabaseSync(path);
    try {
        const integrity = sqliteValue(reopened, "PRAGMA integrity_check");
        const count = Number(
            sqliteValue(reopened, "SELECT count(*) AS count FROM events")
        );
        if (integrity !== "ok" || count !== rows) {
            throw new DevWorkloadValidationError(
                `${name}: reopened database failed validation (${integrity}, ${count}/${rows} rows)`
            );
        }
    } finally {
        reopened.close();
    }
    if (!(await absent(`${path}-journal`))) {
        throw new DevWorkloadValidationError(
            `${name}: the rollback journal remained after COMMIT`
        );
    }
    setStage("cleanup");
    await rm(directory, { recursive: true, force: true });
    return {
        name,
        suite: DEV_WORKLOAD_SUITE,
        operation: "sqlite-transaction",
        itemCount: 1,
        baseFileBytes: options.overwriteBaseBytes,
        semantics:
            "BEGIN/INSERT one row/COMMIT through node:sqlite with the default rollback journal and synchronous level",
        sqlite: details,
        ...runs,
        summary: harness.summarize(runs.samples, 0, 1),
    };
};

/** Build the pinned commit in a local bare origin, outside the target. */
const prepareGitOrigin = async (context) => {
    const { runGit, workspace, corpus } = context;
    const origin = join(workspace, "origin.git");
    await runGit(["init", "--bare", "--quiet", origin], { cwd: workspace });
    await runGit(["fast-import", "--quiet"], {
        cwd: origin,
        input: createDevWorkloadFastImportStream(corpus),
    });
    await runGit(["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: origin });
    const ids = (
        await runGit(
            ["rev-parse", "refs/heads/main", "refs/heads/main^{tree}"],
            {
                cwd: origin,
            }
        )
    ).stdout
        .trim()
        .split(/\s+/u);
    if (ids[0] !== corpus.gitCommitSha1 || ids[1] !== corpus.gitTreeSha1) {
        throw new DevWorkloadValidationError(
            `git fast-import produced ${ids.join(" ")}, expected ${corpus.gitCommitSha1} ${corpus.gitTreeSha1}`
        );
    }
    return origin;
};

const measureGitClone = async (context, name, setStage) => {
    const { root, signal, heavy, harness, runGit, corpus } = context;
    setStage("local origin setup");
    const origin = await prepareGitOrigin(context);
    const directory = join(root, "dev-git");
    await mkdir(directory);
    const expectedPaths = corpus.files.map(({ path }) => path);
    const spotChecks = Array.from(
        { length: CHECKOUT_SPOT_CHECKS },
        (_, index) =>
            corpus.files[
                Math.floor((index * corpus.files.length) / CHECKOUT_SPOT_CHECKS)
            ]
    );
    let previous;
    const runs = await harness.collect(
        heavy,
        signal,
        context.staged(setStage, heavy.warmups, async (index) => {
            if (previous) {
                // Untimed: keep the target's file count stable across
                // samples. The last checkout stays for the status scenarios.
                await rm(previous, { recursive: true, force: true });
                previous = undefined;
            }
            const destination = join(
                directory,
                `clone-${String(index).padStart(2, "0")}`
            );
            const result = await runGit(
                [
                    "clone",
                    "--no-local",
                    "--quiet",
                    "--template=",
                    "--",
                    origin,
                    destination,
                ],
                { cwd: directory }
            );
            const sample = harness.sampleWindow(
                result.startedAt,
                result.endedAt
            );
            previous = destination;
            harness.throwIfAborted(signal);
            const head = (
                await runGit(["rev-parse", "HEAD"], { cwd: destination })
            ).stdout.trim();
            const listed = (
                await runGit(["ls-files", "-z"], { cwd: destination })
            ).stdout
                .split("\0")
                .filter(Boolean);
            if (
                head !== corpus.gitCommitSha1 ||
                JSON.stringify(listed) !== JSON.stringify(expectedPaths)
            ) {
                throw new DevWorkloadValidationError(
                    `${name}: checkout has HEAD ${head} and ${listed.length} index entries`
                );
            }
            for (const file of spotChecks) {
                harness.assertBytes(
                    await readFile(pathIn(destination, file.path)),
                    file.content,
                    `${name} ${file.path}`
                );
            }
            return sample;
        })
    );
    context.checkout = previous;
    return {
        name,
        suite: DEV_WORKLOAD_SUITE,
        operation: "git-clone",
        itemCount: corpus.files.length,
        logicalBytes: corpus.totalBytes,
        semantics:
            "spawn git clone --no-local --quiet --template= from a local bare origin: pack transfer, index-pack and a full checkout into the target, until the process exits",
        ...runs,
        summary: harness.summarize(
            runs.samples,
            corpus.totalBytes,
            corpus.files.length
        ),
    };
};

const measureGitStatusClean = async (context, name, setStage) => {
    const { signal, heavy, harness, runGit, corpus, checkout } = context;
    const runs = await harness.collect(
        heavy,
        signal,
        context.staged(setStage, heavy.warmups, async () => {
            const result = await runGit(["status"], { cwd: checkout });
            if (!/nothing to commit, working tree clean/u.test(result.stdout)) {
                throw new DevWorkloadValidationError(
                    `${name}: the checkout is not clean: ${singleLine(result.stdout)}`
                );
            }
            return harness.sampleWindow(result.startedAt, result.endedAt);
        })
    );
    return {
        name,
        suite: DEV_WORKLOAD_SUITE,
        operation: "git-status",
        itemCount: corpus.files.length,
        semantics:
            "spawn git status (long format, default untracked scan) in the clean checkout, until the process exits",
        ...runs,
        summary: harness.summarize(runs.samples, 0, corpus.files.length),
    };
};

const measureGitStatusPorcelain = async (context, name, setStage) => {
    const { signal, heavy, harness, runGit, corpus, checkout } = context;
    const edited = Array.from(
        { length: STATUS_MODIFIED_FILES },
        (_, index) =>
            corpus.files[
                Math.floor(
                    ((index + 0.5) * corpus.files.length) /
                        STATUS_MODIFIED_FILES
                )
            ]
    );
    const expected = edited.map(({ path }) => ` M ${path}`).sort();
    const runs = await harness.collect(
        heavy,
        signal,
        context.staged(setStage, heavy.warmups, async (index) => {
            // Untimed: the developer's edits before the status run.
            const suffix = Buffer.from(
                `// edited before status run ${String(index).padStart(4, "0")}\n`,
                "latin1"
            );
            for (const file of edited) {
                await writeFile(
                    pathIn(checkout, file.path),
                    Buffer.concat([file.content, suffix])
                );
            }
            harness.throwIfAborted(signal);
            const result = await runGit(["status", "--porcelain"], {
                cwd: checkout,
            });
            const lines = result.stdout.split("\n").filter(Boolean).sort();
            if (JSON.stringify(lines) !== JSON.stringify(expected)) {
                throw new DevWorkloadValidationError(
                    `${name}: unexpected status: ${singleLine(lines.join("; "))}`
                );
            }
            return harness.sampleWindow(result.startedAt, result.endedAt);
        })
    );
    return {
        name,
        suite: DEV_WORKLOAD_SUITE,
        operation: "git-status",
        itemCount: corpus.files.length,
        modifiedFiles: STATUS_MODIFIED_FILES,
        semantics: `spawn git status --porcelain after untimed content edits to ${STATUS_MODIFIED_FILES} tracked files, until the process exits`,
        ...runs,
        summary: harness.summarize(runs.samples, 0, corpus.files.length),
    };
};

/**
 * Run the developer workload below `root`. `harness` supplies the core
 * benchmark's clock, sample collection and file primitives.
 */
export const executeDevWorkload = async (root, options, signal, harness) => {
    const names = devWorkloadScenarioNames(options);
    const [
        editSaveName,
        jsonlSmallName,
        jsonlLargeName,
        sqliteName,
        cloneName,
        statusName,
        porcelainName,
    ] = names;
    const scenarios = [];
    const notMeasured = [];
    const skip = (scenario, cause, reason) =>
        notMeasured.push({ scenario, cause, reason });
    const attempt = async (name, measure, ...rest) => {
        harness.throwIfAborted(signal);
        let stage = "setup";
        const setStage = (next) => {
            stage = next;
        };
        try {
            scenarios.push(await measure(context, name, setStage, ...rest));
        } catch (error) {
            if (signal?.aborted || !isOperationFailure(error)) throw error;
            skip(
                name,
                "operation-failed",
                singleLine(
                    `${stage}: ${errorText(error).replaceAll(root, "<root>")}`
                )
            );
        }
    };
    const workspace = await mkdtemp(join(tmpdir(), "peerbit-dev-workload-"));
    const context = {
        root,
        options,
        signal,
        harness,
        workspace,
        light: { samples: options.samples, warmups: options.warmups },
        lightRuns: options.samples + options.warmups,
        heavy: {
            samples: options.devGitSamples,
            warmups: options.devGitWarmups,
        },
        // Name the failing run (warmup or sample) in a not-measured reason.
        staged: (setStage, warmups, run) => async (index) => {
            setStage(
                index < warmups
                    ? `warmup ${index + 1}`
                    : `sample ${index - warmups + 1}`
            );
            return run(index);
        },
    };
    let tools;
    try {
        const home = join(workspace, "home");
        await mkdir(home);
        await writeFile(join(home, ".gitconfig"), GIT_GLOBAL_CONFIG);
        const env = isolatedGitEnvironment(home);
        const git = await probeDevWorkloadGit({
            executable: options.devGitExecutable ?? "git",
            env,
            signal,
            now: harness.now,
        });
        const sqlite = await probeDevWorkloadSqlite();
        tools = { git, sqlite: sqlite.tool };

        await attempt(editSaveName, measureEditSave);
        await attempt(
            jsonlSmallName,
            measureJsonlAppend,
            JSONL_CHECKPOINT_BYTES[0]
        );
        await attempt(
            jsonlLargeName,
            measureJsonlAppend,
            JSONL_CHECKPOINT_BYTES[1]
        );
        if (sqlite.api) {
            context.sqlite = sqlite;
            await attempt(sqliteName, measureSqlite);
        } else {
            skip(sqliteName, "tool-unavailable", sqlite.tool.reason);
        }
        if (!git.available) {
            for (const name of [cloneName, statusName, porcelainName]) {
                skip(name, "tool-unavailable", git.reason);
            }
        } else {
            context.corpus = verifyDevWorkloadCorpus();
            context.runGit = createGitRunner({
                executable: git.executable,
                env,
                signal,
                now: harness.now,
                root,
            });
            await attempt(cloneName, measureGitClone);
            if (context.checkout) {
                await attempt(statusName, measureGitStatusClean);
                await attempt(porcelainName, measureGitStatusPorcelain);
            } else {
                for (const name of [statusName, porcelainName]) {
                    skip(
                        name,
                        "dependency-not-measured",
                        `requires a measured ${cloneName} checkout`
                    );
                }
            }
        }
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
    return {
        scenarios,
        section: {
            boundary:
                "git child processes, node:sqlite and Node file APIs through the supplied path; the git origin is a local bare repository outside the target, so only the clone writes into it",
            corpus: devWorkloadCorpus,
            tools,
            // Recorded in canonical order: every skip follows the order above.
            notMeasured,
        },
    };
};

// ---------------------------------------------------------------------------
// Report validation and formatting
// ---------------------------------------------------------------------------

const isSingleLine = (value, limit) =>
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= limit &&
    !/[\r\n]/u.test(value);

/**
 * Validate the developer-workload section and return the measured scenario
 * names in canonical order.
 */
export const validateDevWorkloadSection = (report, options) => {
    const section = report.devWorkload;
    const names = devWorkloadScenarioNames(options);
    const { git, sqlite } = section?.tools ?? {};
    if (
        !section ||
        typeof section.boundary !== "string" ||
        JSON.stringify(section.corpus) !== JSON.stringify(devWorkloadCorpus) ||
        !Array.isArray(section.notMeasured) ||
        typeof git?.available !== "boolean" ||
        !isSingleLine(git.executable, 1024) ||
        !isSingleLine(git.available ? git.version : git.reason, 512) ||
        typeof sqlite?.available !== "boolean" ||
        sqlite.module !== "node:sqlite" ||
        !isSingleLine(sqlite.available ? sqlite.version : sqlite.reason, 512)
    ) {
        throw new Error("native-mount developer-workload section is invalid");
    }
    const skipped = new Map();
    for (const entry of section.notMeasured) {
        if (
            !names.includes(entry?.scenario) ||
            skipped.has(entry.scenario) ||
            !NOT_MEASURED_CAUSES.has(entry.cause) ||
            !isSingleLine(entry.reason, 512)
        ) {
            throw new Error(
                "native-mount developer-workload not-measured entries are invalid"
            );
        }
        skipped.set(entry.scenario, entry.cause);
    }
    const listed = section.notMeasured.map(({ scenario }) => scenario);
    if (
        JSON.stringify(listed) !==
        JSON.stringify(names.filter((name) => skipped.has(name)))
    ) {
        throw new Error(
            "native-mount developer-workload not-measured entries are out of order"
        );
    }
    for (const name of names) {
        const cause = skipped.get(name);
        const tool = GIT_SCENARIO_PATTERN.test(name)
            ? git
            : SQLITE_SCENARIO_PATTERN.test(name)
              ? sqlite
              : undefined;
        // A missing tool skips exactly the scenarios that need it.
        if ((cause === "tool-unavailable") !== (tool?.available === false)) {
            throw new Error(
                `${name} has an inconsistent tool-unavailable record`
            );
        }
        const dependsOnCheckout = /^git-status-/u.test(name);
        if (
            cause === "dependency-not-measured" &&
            (!dependsOnCheckout || !skipped.has(GIT_CLONE_SCENARIO))
        ) {
            throw new Error(`${name} has an invalid dependency record`);
        }
        if (
            dependsOnCheckout &&
            skipped.has(GIT_CLONE_SCENARIO) &&
            cause !== "dependency-not-measured" &&
            cause !== "tool-unavailable"
        ) {
            throw new Error(
                `${name} cannot be measured without ${GIT_CLONE_SCENARIO}`
            );
        }
    }
    return names.filter((name) => !skipped.has(name));
};

const SCENARIO_OPERATIONS = [
    [/^edit-save-/u, "atomic-save"],
    [/^jsonl-append-/u, "append"],
    [SQLITE_SCENARIO_PATTERN, "sqlite-transaction"],
    [/^git-clone-/u, "git-clone"],
    [/^git-status-/u, "git-status"],
];

/** Scenario-specific checks beyond the shared sample and summary rules. */
export const validateDevWorkloadScenario = (scenario) => {
    const operation = SCENARIO_OPERATIONS.find(([pattern]) =>
        pattern.test(scenario.name)
    )?.[1];
    if (
        scenario.suite !== DEV_WORKLOAD_SUITE ||
        scenario.operation !== operation
    ) {
        throw new Error(
            `${scenario.name} is not a developer-workload scenario`
        );
    }
    if (scenario.operation === "atomic-save") {
        for (const sample of [...scenario.warmupSamples, ...scenario.samples]) {
            if (!Number.isSafeInteger(sample.renameNs) || sample.renameNs < 0) {
                throw new Error(
                    `${scenario.name} has an invalid renameNs phase`
                );
            }
        }
    }
    if (
        scenario.operation === "git-clone" &&
        (scenario.itemCount !== devWorkloadCorpus.fileCount ||
            scenario.logicalBytes !== devWorkloadCorpus.totalBytes)
    ) {
        throw new Error(`${scenario.name} does not describe the pinned corpus`);
    }
    if (
        scenario.operation === "sqlite-transaction" &&
        (typeof scenario.sqlite?.journalMode !== "string" ||
            !Number.isSafeInteger(scenario.sqlite?.prefillBytes))
    ) {
        throw new Error(`${scenario.name} has invalid SQLite details`);
    }
};

const mebibytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

export const formatDevWorkloadSummaryLines = (report) => {
    const section = report.devWorkload;
    if (!section) return [];
    const { git, sqlite } = section.tools;
    const lines = [
        "",
        `Developer workload: corpus ${section.corpus.id} (${section.corpus.fileCount} files in ${section.corpus.directoryCount} directories, ${mebibytes(section.corpus.totalBytes)}, commit ${section.corpus.gitCommitSha1.slice(0, 12)}); git: ${git.available ? git.version : "unavailable"}; sqlite: ${sqlite.available ? `node:sqlite ${sqlite.version}` : "unavailable"}; git scenarios: ${report.run.devWorkload.gitSamplesPerScenario} samples after ${report.run.devWorkload.gitWarmupsPerScenario} warmup(s)`,
    ];
    if (section.notMeasured.length > 0) {
        lines.push("", "Not measured:");
        for (const { scenario, cause, reason } of section.notMeasured) {
            lines.push(`- ${scenario}: ${cause} — ${reason}`);
        }
    }
    return lines;
};
