#!/usr/bin/env node
/**
 * Hosted mount smoke for the local overlay: an npm project installs into a
 * real mount (Linux FUSE, Windows WinFsp, macOS macFUSE) while its
 * node_modules never reaches the filesystem's other replica.
 *
 *     node scripts/shared-fs-local-overlay-npm-smoke.mjs
 *
 * Needs the built packages and Go. A witness replica W runs in this process,
 * and each mount session of the CLI dials only W:
 *   1. seed: package.json and package-lock.json go into /npm-app, and W reads
 *      them back;
 *   2. npm: ci, ls, the install checks, the bin scripts, renames across the
 *      overlay (EXDEV), install --no-save of an older package, ci again and
 *      an unlink-while-open probe;
 *   3. remount: the install still loads and runs.
 * After sessions 2 and 3, W holds exactly what it held after the seed (its
 * bootstrap manifests aside) and counted no other change, and each mount
 * exited 0 with nothing to persist. No session's adapter may say that it
 * reported ready without seeing its mount attach (on Windows, without
 * hearing its drive letter arrive). Evidence goes to
 * $RUNNER_TEMP/shared-fs-npm-smoke. Every deadline is a give-up bound,
 * never a performance gate.
 *
 * Session 1 runs the adapter with debug output: its own lines and the FUSE
 * layer's log of each request and its result (libfuse's operations on Linux,
 * WinFsp's file system requests on Windows). A failure prints the error's
 * code, errno, syscall and path, and for the last session and any still
 * running whether its mountpoint is mounted then and, once cleanup stopped
 * it, the end of its output.
 */
import { spawn, spawnSync } from "node:child_process";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    fillNpmCache,
    fixturePaths,
    generateNpmFixture,
    runChecks,
    runCommand,
    runNpm,
} from "./shared-fs-npm-fixture.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharedFs = path.join(repo, "packages", "shared-fs");
const libraryDirectory = path.join(sharedFs, "library");
const cliBin = path.join(sharedFs, "cli", "lib", "esm", "bin.js");
const windows = process.platform === "win32";
const linux = process.platform === "linux";

/** Give-up bounds: a step still running after its bound fails the run. */
const GIVE_UP_MS = {
    goBuild: 10 * 60_000,
    cacheAdd: 5 * 60_000,
    mounted: 180_000,
    exit: 180_000,
    shutdownGrace: 60_000,
    seedRead: 120_000,
    npmCi: 15 * 60_000,
    npm: 10 * 60_000,
    node: 5 * 60_000,
    witnessClose: 60_000,
};

/** The one persist-on-exit line a session that wrote nothing may print. */
const PERSIST_NOTHING =
    "persist-on-exit: no other replica seen; not waiting (0 entries only here)";
/**
 * What the adapter prints when it did not see its mount attach: the drive
 * letter was defined but its arrival never reached the adapter, so it
 * reported ready only at its time limit, or it could not confirm the mount.
 */
const ATTACH_UNSEEN = [
    "no arrival notice reached the adapter",
    "could not confirm the mount is attached",
];
/** Document kinds a mount writes for a shared change. */
const SHARED_KINDS = ["naming", "version", "chunk", "changeset-manifest"];
const BIN_LINES = ["ov-pkg-002", "ov-pkg-009", "ov-pkg-030"].map(
    (name) => `${name}@1.0.0 bin ok`
);

const evidence = path.join(
    process.env.RUNNER_TEMP || os.tmpdir(),
    "shared-fs-npm-smoke"
);

const log = (line) => {
    const text = `[${new Date().toISOString()}] ${line}`;
    console.log(text);
    appendFileSync(path.join(evidence, "driver.log"), `${text}\n`);
};

class SmokeFailure extends Error {}

const expect = (ok, message) => {
    if (!ok) throw new SmokeFailure(message);
};

/** `promise`, or a rejection naming `label` once `ms` pass. */
const within = async (promise, ms, label) => {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`gave up after ${ms} ms: ${label}`)),
                    ms
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

const steps = [];
const step = async (label, run) => {
    const started = Date.now();
    log(`start: ${label}`);
    try {
        const result = await run();
        steps.push({ label, ms: Date.now() - started, ok: true });
        log(`done: ${label} (${Date.now() - started} ms)`);
        return result;
    } catch (error) {
        steps.push({
            label,
            ms: Date.now() - started,
            ok: false,
            error: String(error?.message ?? error),
        });
        throw error;
    }
};

let commandCount = 0;
/** Keep a finished command's output in the evidence directory. */
const keep = (run, cwd) => {
    const name = `${String(++commandCount).padStart(2, "0")}-${run.label
        .replace(/[^a-zA-Z0-9.-]+/g, "-")
        .slice(0, 60)}.log`;
    writeFileSync(
        path.join(evidence, name),
        [
            `$ ${run.label}`,
            `cwd: ${cwd}`,
            `exit: ${run.code}${run.signal ? ` (${run.signal})` : ""} after ${run.ms} ms`,
            "--- stdout",
            run.stdout,
            "--- stderr",
            run.stderr,
        ].join("\n")
    );
    return run;
};

const succeeded = (run, cwd) => {
    keep(run, cwd);
    expect(
        run.code === 0,
        `${run.label} exited ${run.code ?? run.signal}:\n${run.stderr.slice(-4000)}`
    );
    return run;
};

// ---- the witness ---------------------------------------------------------

const loadRuntime = async () => {
    const library = await import(
        pathToFileURL(path.join(libraryDirectory, "lib", "esm", "index.js"))
            .href
    );
    // peerbit exports only an import condition, which createRequire cannot
    // resolve: load the library's own dependency, the copy it uses itself.
    const peerbitDirectory = realpathSync(
        path.join(libraryDirectory, "node_modules", "peerbit")
    );
    const manifest = JSON.parse(
        readFileSync(path.join(peerbitDirectory, "package.json"), "utf8")
    );
    const entry = manifest.exports?.["."]?.import;
    if (typeof entry !== "string") {
        throw new Error(`peerbit ${manifest.version} has no import entry`);
    }
    const { Peerbit } = await import(
        pathToFileURL(path.join(peerbitDirectory, entry)).href
    );
    return { library, Peerbit };
};

const kindOf = (id) => id.slice(0, id.indexOf(":"));
const countByKind = (ids) => {
    const counts = {};
    for (const id of ids) counts[kindOf(id)] = (counts[kindOf(id)] ?? 0) + 1;
    return counts;
};

/**
 * W: a full replica in this process that creates the filesystem, counts
 * every document its log adds or removes (from its document store's change
 * events) and records which peers connect.
 */
const openWitness = async ({ library, Peerbit }, directory) => {
    const peer = await Peerbit.create({
        directory,
        libp2p: { addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] } },
    });
    let fs;
    try {
        fs = await library.openSharedFs({
            peerbit: peer,
            machineLabel: "witness",
            replicate: { factor: 1 },
            snapshot: { disabled: true },
            gc: false,
        });
    } catch (error) {
        await peer.stop();
        throw error;
    }
    let changes = { added: [], removed: [] };
    const listeners = new Set();
    fs.program.entries.events.addEventListener("change", (event) => {
        for (const doc of event.detail?.added ?? []) changes.added.push(doc.id);
        for (const doc of event.detail?.removed ?? []) {
            changes.removed.push(doc.id);
        }
        for (const listener of [...listeners]) listener();
    });
    const connects = [];
    peer.libp2p.addEventListener("peer:connect", (event) =>
        connects.push({ at: Date.now(), peer: event.detail.toString() })
    );
    const multiaddr = peer
        .getMultiaddrs()
        .map(String)
        .find(
            (address) =>
                address.startsWith("/ip4/127.0.0.1/tcp/") &&
                address.includes("/p2p/")
        );
    if (!multiaddr) throw new Error("the witness has no loopback TCP address");
    return {
        fs,
        address: fs.address,
        multiaddr,
        connects,
        /** Start counting afresh. */
        reset: () => {
            changes = { added: [], removed: [] };
        },
        changes: () => ({
            added: [...changes.added],
            removed: [...changes.removed],
        }),
        connectedTo: (peerId) =>
            peer.libp2p
                .getConnections()
                .some(
                    (connection) => connection.remotePeer.toString() === peerId
                ),
        ids: async () =>
            (
                await fs.program.entries.index
                    .iterate(
                        { query: [] },
                        { local: true, remote: false, resolve: false }
                    )
                    .all()
            )
                .map((row) => row.id)
                .sort(),
        onChange: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        close: () => peer.stop(),
    };
};

/** Resolves once W reads every one of `files` with the expected bytes. */
const untilWitnessReads = (witness, files) => {
    let stop = () => {};
    const read = new Promise((resolve) => {
        let checking = false;
        let again = false;
        const check = async () => {
            if (checking) {
                again = true;
                return;
            }
            checking = true;
            try {
                do {
                    again = false;
                    let all = true;
                    for (const [file, bytes] of Object.entries(files)) {
                        const held = await witness.fs
                            .readFile(file)
                            .catch(() => undefined);
                        if (!held || !Buffer.from(held).equals(bytes)) {
                            all = false;
                            break;
                        }
                    }
                    if (all) return resolve();
                } while (again);
            } finally {
                checking = false;
            }
        };
        stop = witness.onChange(() => void check());
        void check();
    });
    return within(
        read,
        GIVE_UP_MS.seedRead,
        "W reads the seeded files"
    ).finally(() => stop());
};

// ---- mounts --------------------------------------------------------------

const unescapeMountinfo = (field) =>
    field.replace(/\\([0-7]{3})/g, (_, octal) =>
        String.fromCharCode(parseInt(octal, 8))
    );

/** Whether `mountpoint` (a real path, or a drive like P:) is mounted. */
const mountedAt = (mountpoint) => {
    if (windows) return existsSync(`${mountpoint}\\`);
    if (linux) {
        return readFileSync("/proc/self/mountinfo", "utf8")
            .split("\n")
            .some(
                (line) =>
                    line && unescapeMountinfo(line.split(" ")[4]) === mountpoint
            );
    }
    const listing = spawnSync("mount", [], { encoding: "utf8" }).stdout ?? "";
    return listing
        .split("\n")
        .some((line) => line.includes(` on ${mountpoint} (`));
};

const unmountSync = (mountpoint) => {
    if (windows) return;
    const attempts = linux
        ? [
              ["fusermount3", ["-u", "-z", mountpoint]],
              ["fusermount", ["-u", "-z", mountpoint]],
          ]
        : [
              ["umount", [mountpoint]],
              ["umount", ["-f", mountpoint]],
          ];
    for (const [command, args] of attempts) {
        if (!mountedAt(mountpoint)) return;
        spawnSync(command, args, { stdio: "ignore" });
    }
};

const sessions = new Set();
/** Every session started, in order. */
const startedSessions = [];
/** Every mountpoint a session used: a directory, or a drive on Windows. */
const mountpoints = [];

/** The CLI process and the adapter it spawned, at once. */
const killTree = (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (windows) {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
        });
    } else {
        try {
            // Its own process group (detached): the adapter is in it too.
            process.kill(-child.pid, "SIGKILL");
        } catch {
            // Already gone.
        }
    }
};

/**
 * Spawn `peerbit-fs mount` and resolve once it printed its `Mounted ` line,
 * with what it printed about its local overlay.
 */
const startSession = async (
    number,
    { witness, mountpoint, state, adapter, env = {} }
) => {
    const label = `session ${number}`;
    const stdoutFile = path.join(evidence, `session-${number}.stdout.log`);
    const stderrFile = path.join(evidence, `session-${number}.stderr.log`);
    writeFileSync(stdoutFile, "");
    writeFileSync(stderrFile, "");
    const child = spawn(
        process.execPath,
        [
            cliBin,
            "mount",
            witness.address,
            mountpoint,
            "--directory",
            state,
            "--peer",
            witness.multiaddr,
            "--native-adapter",
            adapter,
        ],
        {
            cwd: repo,
            env: { ...process.env, FORCE_COLOR: "0", ...env },
            stdio: ["pipe", "pipe", "pipe"],
            // A process group, so a forced stop reaches the adapter too.
            detached: !windows,
            windowsHide: true,
        }
    );
    const session = {
        number,
        mountpoint,
        child,
        started: Date.now(),
        stdout: "",
        stderr: "",
        overlayLines: [],
    };
    sessions.add(session);
    startedSessions.push(session);
    let partial = "";
    let mounted;
    const mountedLine = new Promise((resolve) => (mounted = resolve));
    child.stdout.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        session.stdout += text;
        appendFileSync(stdoutFile, text);
        const lines = (partial + text).split(/\r?\n/);
        partial = lines.pop();
        for (const line of lines) {
            if (line.startsWith("Local overlay: ")) {
                session.overlayLines.push(line);
            }
            if (line.startsWith("Mounted ")) {
                session.mountedLineAt ??= Date.now();
                mounted(line);
            }
        }
    });
    child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        session.stderr += text;
        appendFileSync(stderrFile, text);
    });
    session.closed = new Promise((resolve) =>
        child.on("close", (code, signal) => resolve({ code, signal }))
    );
    child.stdin.on("error", () => {});
    const early = session.closed.then(({ code, signal }) => {
        throw new SmokeFailure(
            `${label} exited ${code ?? signal} before it mounted:\n${session.stderr.slice(-4000)}`
        );
    });
    early.catch(() => {});
    session.mountedLine = await within(
        Promise.race([mountedLine, early]),
        GIVE_UP_MS.mounted,
        `${label} prints its Mounted line`
    );
    // Checked where it is used, so a mount without one fails at npm.
    session.overlayDirectory = session.overlayLines[0]?.slice(
        "Local overlay: ".length
    );
    log(`${label}: ${session.mountedLine}`);
    for (const line of session.overlayLines) log(`${label}: ${line}`);
    return session;
};

/**
 * Ask the mount to stop (a `shutdown` line) and wait for its exit. Its output
 * is complete then, so this is where it must not say that the adapter missed
 * its mount attaching.
 */
const stopSession = async (session) => {
    session.child.stdin.write("shutdown\n");
    const { code, signal } = await within(
        session.closed,
        GIVE_UP_MS.exit,
        `session ${session.number} exits after shutdown`
    );
    sessions.delete(session);
    session.exit = { code, signal, ms: Date.now() - session.started };
    log(`session ${session.number}: exit ${code ?? signal}`);
    const unseen = session.stderr
        .split(/\r?\n/)
        .filter((line) => ATTACH_UNSEEN.some((note) => line.includes(note)));
    expect(
        unseen.length === 0,
        `session ${session.number}'s adapter did not see its mount attach:\n${unseen.join("\n")}`
    );
    return session.exit;
};

/** A still-running mount gets a shutdown line and a grace period, then is killed. */
const forceStop = async (session) => {
    if (session.child.exitCode === null && session.child.signalCode === null) {
        session.child.stdin.write("shutdown\n");
        const stopped = await within(
            session.closed,
            GIVE_UP_MS.shutdownGrace,
            `session ${session.number} exits during cleanup`
        ).catch(() => false);
        if (stopped === false) {
            killTree(session.child);
            await within(session.closed, 30_000, "killed mount exits").catch(
                () => {}
            );
        }
    }
    sessions.delete(session);
};

const persistLines = (session) =>
    session.stderr
        .split(/\r?\n/)
        .filter((line) => line.startsWith("persist-on-exit:"));

/** A Node system error's code, errno, syscall and paths, when it has them. */
const errorFields = (error) => {
    const fields = {};
    for (const key of ["code", "errno", "syscall", "path", "dest"]) {
        if (error?.[key] !== undefined) fields[key] = error[key];
    }
    return Object.keys(fields).length ? fields : undefined;
};

/**
 * Whether `mountpoint` is mounted, for a failure report. On Windows that
 * opens the drive's root, which a hung mount answers only when WinFsp cancels
 * the request minutes later, so the look runs off the event loop and is
 * given up on.
 */
const describeMounted = async (mountpoint) => {
    if (!windows) return mountedAt(mountpoint) ? "mounted" : "not mounted";
    return within(
        stat(`${mountpoint}\\`).then(
            () => "mounted",
            (error) =>
                error.code === "ENOENT"
                    ? "not mounted"
                    : `unknown (${error.code ?? error.message})`
        ),
        10_000,
        `a look at ${mountpoint}`
    );
};

/**
 * Log what a failure leaves to read at once: the error's fields and, for the
 * last session and any still running, whether it runs and its mountpoint is
 * mounted (looked at once). Returns those sessions for describeOutput.
 */
const describeFailure = async (error) => {
    const failedAt = Date.now();
    const fields = errorFields(error);
    if (fields) log(`failure: ${JSON.stringify(fields)}`);
    const described = new Set([...sessions, startedSessions.at(-1)]);
    described.delete(undefined);
    for (const session of described) {
        const exit = session.child.exitCode ?? session.child.signalCode;
        const state = exit === null ? "running" : `exited ${exit}`;
        let mounted;
        try {
            mounted = await describeMounted(session.mountpoint);
        } catch (lookError) {
            mounted = `unknown (${lookError.message})`;
        }
        const since =
            session.mountedLineAt === undefined
                ? "before its Mounted line"
                : `${failedAt - session.mountedLineAt} ms after its Mounted line`;
        log(
            `session ${session.number} (${state}): ${session.mountpoint} is ${mounted} at the failure, ${since}`
        );
    }
    return { fields, sessions: [...described] };
};

/**
 * Log the end of each session's output once the session closed it: the lines
 * a mount writes about the failing operation, such as the adapter's debug
 * line for it, can reach this process after the failure.
 */
const describeOutput = async (described) => {
    for (const session of described) {
        await within(
            session.closed,
            30_000,
            `session ${session.number} closes its output`
        ).catch((error) => log(`cleanup: ${error.message}`));
        const exit = session.child.exitCode ?? session.child.signalCode;
        const state = exit === null ? "still running" : `exited ${exit}`;
        log(
            `session ${session.number} (${state}) stdout, last 4000 characters:\n${session.stdout.slice(-4000)}`
        );
        log(
            `session ${session.number} (${state}) stderr, last 8000 characters:\n${session.stderr.slice(-8000)}`
        );
    }
};

// ---- the run -------------------------------------------------------------

const main = async () => {
    rmSync(evidence, { recursive: true, force: true });
    mkdirSync(evidence, { recursive: true });
    const work = mkdtempSync(
        path.join(
            process.env.RUNNER_TEMP || os.tmpdir(),
            "shared-fs-npm-smoke-"
        )
    );
    const fixture = path.join(work, "fixture");
    const cache = path.join(work, "npm-cache");
    const stateA = path.join(work, "state-a");
    const stateW = path.join(work, "state-w");
    const adapter = path.join(work, windows ? "adapter.exe" : "adapter");
    mkdirSync(stateA);
    mkdirSync(stateW);
    const drives = windows ? [..."PQRSTUVWXYZ"] : [];
    const nextMountpoint = () => {
        if (!windows) {
            if (!mountpoints.length) {
                mkdirSync(path.join(work, "mnt"));
                mountpoints.push(realpathSync(path.join(work, "mnt")));
            }
            return { mountpoint: mountpoints[0], root: mountpoints[0] };
        }
        // A fresh drive letter per session.
        while (drives.length) {
            const drive = `${drives.shift()}:`;
            if (!existsSync(`${drive}\\`)) {
                mountpoints.push(drive);
                return { mountpoint: drive, root: `${drive}\\` };
            }
        }
        throw new SmokeFailure("no free drive letter from P to Z");
    };
    let witness;
    /** The sessions a failure names, whose output cleanup prints. */
    let described = [];
    const result = { platform: process.platform, node: process.version };
    try {
        result.fixture = await step("generate the npm fixture", () =>
            generateNpmFixture(fixture)
        );
        const { app: fixtureApp, tarballs } = fixturePaths(fixture);
        await step("fill the npm cache", async () =>
            succeeded(
                await fillNpmCache(fixture, {
                    cache,
                    giveUpMs: GIVE_UP_MS.cacheAdd,
                }),
                tarballs
            )
        );
        await step("build the native adapter", async () =>
            succeeded(
                await runCommand(
                    "go",
                    [
                        "build",
                        "-tags",
                        linux ? "native_mount fuse3" : "native_mount",
                        "-o",
                        adapter,
                        ".",
                    ],
                    {
                        cwd: path.join(sharedFs, "native"),
                        // The release build: cgofuse's pure-Go WinFsp binding.
                        env: windows
                            ? { ...process.env, CGO_ENABLED: "0" }
                            : process.env,
                        giveUpMs: GIVE_UP_MS.goBuild,
                        label: "go build adapter",
                    }
                ),
                path.join(sharedFs, "native")
            )
        );
        witness = await step("open the witness", async () =>
            openWitness(await loadRuntime(), stateW)
        );
        log(`witness: ${witness.address} at ${witness.multiaddr}`);
        const options = () => ({ witness, state: stateA, adapter });
        const npm = async (cwd, args, giveUpMs = GIVE_UP_MS.npm) =>
            succeeded(
                await runNpm(fixture, args, { cwd, cache, giveUpMs }),
                cwd
            );
        const checks = async (cwd, mode) => {
            const run = succeeded(
                await runChecks(fixture, mode, {
                    cwd,
                    giveUpMs: GIVE_UP_MS.node,
                }),
                cwd
            );
            expect(run.result?.ok === true, `checks ${mode}: ${run.stdout}`);
            return run.result;
        };
        const binCheck = async (cwd) => {
            const run = await npm(cwd, ["run", "bin-check"]);
            for (const line of BIN_LINES) {
                expect(
                    run.stdout.includes(line),
                    `npm run bin-check did not print ${line}`
                );
            }
        };
        const overlayDirectories = [];
        result.sessions = [];

        // Session 1: seed the shared project files.
        const seedFiles = Object.fromEntries(
            ["package.json", "package-lock.json"].map((name) => [
                `/npm-app/${name}`,
                readFileSync(path.join(fixtureApp, name)),
            ])
        );
        let peerA;
        let before;
        await step("session 1: seed /npm-app", async () => {
            const { mountpoint, root } = nextMountpoint();
            const session = await startSession(1, {
                ...options(),
                mountpoint,
                // A few operations, so the adapter's debug log stays short.
                env: { PEERBIT_SHARED_FS_NATIVE_ADAPTER_DEBUG: "1" },
            });
            overlayDirectories.push(session.overlayDirectory);
            // Asynchronous, so this process keeps reading the session's debug
            // output meanwhile: on Windows the CLI writes it to a blocking
            // pipe, and a full one would stall the mount under a synchronous
            // call made here.
            await mkdir(path.join(root, "npm-app"));
            for (const [file, bytes] of Object.entries(seedFiles)) {
                await writeFile(path.join(root, file), bytes);
            }
            await untilWitnessReads(witness, seedFiles);
            const exit = await stopSession(session);
            result.sessions.push({
                number: 1,
                exit,
                persist: persistLines(session),
            });
            expect(
                exit.code === 0,
                `session 1 exited ${exit.code ?? exit.signal}`
            );
            expect(
                !mountedAt(mountpoint),
                `${mountpoint} is still mounted after session 1 exited`
            );
            const peers = [...new Set(witness.connects.map((c) => c.peer))];
            expect(
                peers.length === 1,
                `W should have one peer, the mount; it saw ${JSON.stringify(peers)}`
            );
            peerA = peers[0];
            before = await witness.ids();
            log(
                `W0: ${before.length} documents, ${JSON.stringify(countByKind(before))}`
            );
        });

        /** What W must hold after a session that wrote nothing shared. */
        const witnessUnchanged = async (session, number) => {
            const exit = await stopSession(session);
            const persist = persistLines(session);
            const changes = witness.changes();
            const counts = {
                added: countByKind(changes.added),
                removed: countByKind(changes.removed),
            };
            const unshared = (ids) =>
                ids.filter((id) => kindOf(id) !== "bootstrap");
            const after = await witness.ids();
            result.sessions.push({ number, exit, persist, witness: counts });
            log(`session ${number}: W counted ${JSON.stringify(counts)}`);
            expect(
                exit.code === 0,
                `session ${number} exited ${exit.code ?? exit.signal}`
            );
            expect(
                persist.every((line) => line === PERSIST_NOTHING),
                `session ${number} had something to persist:\n${persist.join("\n")}`
            );
            const shared = [...changes.added, ...changes.removed].filter((id) =>
                SHARED_KINDS.includes(kindOf(id))
            );
            expect(
                shared.length === 0,
                `W counted shared changes in session ${number}:\n${shared
                    .map((id) => `${kindOf(id)} ${id}`)
                    .join("\n")}`
            );
            expect(
                JSON.stringify(unshared(after)) ===
                    JSON.stringify(unshared(before)),
                `W's documents changed in session ${number}: added ${JSON.stringify(
                    unshared(after).filter((id) => !before.includes(id))
                )}, removed ${JSON.stringify(
                    unshared(before).filter((id) => !after.includes(id))
                )}`
            );
            for (const id of changes.added.filter(
                (id) => kindOf(id) === "bootstrap"
            )) {
                log(
                    `session ${number}: W added ${id} (a replica's bootstrap manifest)`
                );
            }
        };
        const connectedDuring = (session) =>
            witness.connects.some(
                (c) => c.peer === peerA && c.at >= session.started
            ) || witness.connectedTo(peerA);

        // Session 2: npm in the mount.
        await step("session 2: npm in /npm-app", async () => {
            witness.reset();
            const { mountpoint, root } = nextMountpoint();
            const session = await startSession(2, { ...options(), mountpoint });
            overlayDirectories.push(session.overlayDirectory);
            const app = path.join(root, "npm-app");
            await npm(app, ["ci"], GIVE_UP_MS.npmCi);
            await npm(app, ["ls", "--all"]);
            await checks(app, "installed");
            await binCheck(app);
            await checks(app, "exdev");
            await npm(app, [
                "install",
                "--no-save",
                path.join(tarballs, "ov-shared-1.0.0.tgz"),
            ]);
            await checks(app, "swapped");
            await npm(app, ["ci"], GIVE_UP_MS.npmCi);
            await checks(app, "installed");
            result.probe = await checks(app, "probe");
            log(`probe: ${JSON.stringify(result.probe)}`);
            // White box: the install is in the overlay, under /npm-app's node.
            expect(
                session.overlayDirectory !== undefined,
                "session 2 printed no Local overlay line"
            );
            const anchors = readdirSync(
                path.join(session.overlayDirectory, "n")
            );
            expect(
                anchors.length === 1 &&
                    existsSync(
                        path.join(
                            session.overlayDirectory,
                            "n",
                            anchors[0],
                            "node_modules",
                            ".package-lock.json"
                        )
                    ),
                `the overlay does not hold node_modules/.package-lock.json under one directory: ${JSON.stringify(anchors)}`
            );
            expect(connectedDuring(session), "session 2 never connected to W");
            await witnessUnchanged(session, 2);
            expect(
                !mountedAt(mountpoint),
                `${mountpoint} is still mounted after session 2 exited`
            );
        });

        // Session 3: the install survives a remount.
        await step("session 3: remount and run", async () => {
            witness.reset();
            const { mountpoint, root } = nextMountpoint();
            const session = await startSession(3, { ...options(), mountpoint });
            overlayDirectories.push(session.overlayDirectory);
            const app = path.join(root, "npm-app");
            const loaded = succeeded(
                await runCommand(
                    process.execPath,
                    [
                        "-e",
                        "console.log(require('ov-pkg-000').deps['ov-pkg-001'])",
                    ],
                    {
                        cwd: app,
                        env: process.env,
                        giveUpMs: GIVE_UP_MS.node,
                        label: "node -e require('ov-pkg-000')",
                    }
                ),
                app
            );
            expect(
                loaded.stdout.trim() === "1.0.0",
                `ov-pkg-000 did not reach ov-pkg-001: ${loaded.stdout}`
            );
            await binCheck(app);
            await checks(app, "installed");
            expect(connectedDuring(session), "session 3 never connected to W");
            await witnessUnchanged(session, 3);
            expect(
                !mountedAt(mountpoint),
                `${mountpoint} is still mounted after session 3 exited`
            );
        });

        expect(
            overlayDirectories[0] !== undefined &&
                new Set(overlayDirectories).size === 1,
            `the overlay moved between sessions: ${JSON.stringify(overlayDirectories)}`
        );
        result.overlayDirectory = overlayDirectories[0];
        const names = async (directory) =>
            (await witness.fs.list(directory))
                .map((entry) => entry.name)
                .sort();
        expect(
            JSON.stringify(await names("/npm-app")) ===
                JSON.stringify(["package-lock.json", "package.json"]),
            `W lists /npm-app as ${JSON.stringify(await names("/npm-app"))}`
        );
        expect(
            JSON.stringify(await names("/")) === JSON.stringify(["npm-app"]),
            `W lists / as ${JSON.stringify(await names("/"))}`
        );
        result.ok = true;
    } catch (error) {
        result.ok = false;
        result.error = String(error?.stack ?? error);
        const failure = await describeFailure(error);
        result.errorFields = failure.fields;
        described = failure.sessions;
        throw error;
    } finally {
        for (const session of [...sessions]) await forceStop(session);
        for (const mountpoint of mountpoints) unmountSync(mountpoint);
        await describeOutput(described);
        if (witness) {
            await within(
                witness.close(),
                GIVE_UP_MS.witnessClose,
                "the witness stops"
            ).catch((error) => log(`cleanup: ${error.message}`));
        }
        const stillMounted = mountpoints.filter((mountpoint) =>
            mountedAt(mountpoint)
        );
        result.steps = steps;
        writeFileSync(
            path.join(evidence, "result.json"),
            JSON.stringify(result, null, 2)
        );
        if (stillMounted.length) {
            // Never remove a directory holding a live mount: that deletes
            // shared data through it.
            log(
                `cleanup: still mounted, keeping ${work}: ${stillMounted.join(", ")}`
            );
            process.exitCode = 1;
        } else {
            rmSync(work, {
                recursive: true,
                force: true,
                maxRetries: 10,
                retryDelay: 200,
            });
        }
    }
};

// A run that dies still takes its mounts down.
const takeDown = () => {
    for (const session of sessions) killTree(session.child);
    for (const mountpoint of mountpoints) unmountSync(mountpoint);
};
process.on("exit", takeDown);
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        takeDown();
        process.exit(130);
    });
}

main().then(
    () => {
        log("npm overlay smoke passed");
        process.exit(process.exitCode ?? 0);
    },
    (error) => {
        log(`npm overlay smoke failed: ${error?.stack ?? error}`);
        process.exit(1);
    }
);
