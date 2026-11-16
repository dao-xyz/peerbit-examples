import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import {
    FileVersion,
    Peerbit,
    createSharedFsMountBackend,
    openSharedFs,
    type SharedFsHandle,
    type SharedFsMountBackend,
} from "@peerbit/shared-fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    persistOnExit,
    runCli,
    stopMountSession,
    waitForTermination,
    type MountShutdown,
} from "../index.js";

/**
 * mount --persist-on-exit (roadmap N2), through the mount's shutdown seams:
 * waitForTermination (signals and the stdin `shutdown` line), stopMountSession
 * (unmount, drain, persist, stop) and persistOnExit, with the library's mount
 * backend driven as the native adapter drives it. Real Peerbit peers over
 * real TCP on loopback, no FUSE. Every wait resolves on an event and only
 * gives up at its deadline.
 */

/**
 * Give-up bounds: a step that is not under test (a join, a reconnect), and
 * the fence of a test that expects it to finish. A test's bounds sum below
 * vitest's 120 s, so a stuck step fails with its own label.
 */
const STEP_MS = 20_000;
const FENCE_MS = 30_000;

const text = (bytes: Uint8Array | undefined) =>
    bytes ? new TextDecoder().decode(bytes) : undefined;

const content = (i: number) => `file ${i}: ${"x".repeat(64)}\n`;

/** Rejects with `label` once `ms` pass; never resolves anything itself. */
const giveUpAfter = (ms: number, label: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`gave up after ${ms} ms: ${label}`)),
            ms
        );
    });
    return { expired, clear: () => clearTimeout(timer) };
};

/** `promise`, or a rejection naming `label` once `ms` pass. */
const within = async <T>(promise: Promise<T>, label: string, ms = STEP_MS) => {
    const deadline = giveUpAfter(ms, label);
    try {
        return await Promise.race([promise, deadline.expired]);
    } finally {
        deadline.clear();
    }
};

/** Resolves once `check()` holds, checking on each `type` event. */
const untilEvent = async (
    target: EventTarget,
    type: string,
    check: () => boolean,
    label: string
) => {
    const deadline = giveUpAfter(STEP_MS, label);
    let listener: (() => void) | undefined;
    try {
        await Promise.race([
            new Promise<void>((resolve) => {
                listener = () => check() && resolve();
                target.addEventListener(type, listener);
                listener();
            }),
            deadline.expired,
        ]);
    } finally {
        deadline.clear();
        if (listener) target.removeEventListener(type, listener);
    }
};

/** A shutdown host: the process's signal events and exit, without a process. */
const fakeHost = () =>
    Object.assign(new EventEmitter(), { exit: vi.fn() }) as EventEmitter & {
        exit: ReturnType<typeof vi.fn>;
    };

/** persist-on-exit lines, as a script reading stderr sees them. */
const persistLines = (lines: string[]) =>
    lines.filter((line) => line.startsWith("persist-on-exit: "));

const unacknowledged = (lines: string[]) =>
    persistLines(lines)
        .filter((line) => line.startsWith("persist-on-exit: unacknowledged "))
        .map(
            (line) =>
                JSON.parse(
                    line.slice("persist-on-exit: unacknowledged ".length)
                ) as { path: string | null; ids: string[] }
        );

describe("mount shutdown requests", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        process.exitCode = undefined;
    });

    /** A stop that runs until released, and the shutdown it was given. */
    const pendingStop = (
        host: ReturnType<typeof fakeHost>,
        input = new PassThrough()
    ) => {
        const state: { shutdown?: MountShutdown; release(): void } = {
            release: () => {},
        };
        const stopped = waitForTermination(
            (shutdown) => {
                state.shutdown = shutdown;
                return new Promise<void>(
                    (resolve) => (state.release = resolve)
                );
            },
            host as any,
            input
        );
        return Object.assign(state, { stopped, input });
    };

    it("ignores a wrapper's copy of a request, aborts only a wait under way, and exits at once otherwise", async () => {
        const host = fakeHost();
        const stop = pendingStop(host);
        expect(stop.shutdown).toBeUndefined();

        // npm, pnpm and npx pass one Ctrl-C on as a second SIGINT.
        host.emit("SIGINT");
        host.emit("SIGINT");
        expect(stop.shutdown?.signal.aborted).toBe(false);
        expect(host.exit).not.toHaveBeenCalled();
        // The wait is under way: a request aborts it, its copy does nothing.
        stop.shutdown!.phase = 1;
        host.emit("SIGTERM");
        host.emit("SIGTERM");
        expect(stop.shutdown!.signal.aborted).toBe(true);
        expect(host.exit).not.toHaveBeenCalled();
        // A closed terminal (SIGHUP) is a request too: this one exits.
        host.emit("SIGHUP");
        expect(host.exit).toHaveBeenCalledWith(130);

        stop.release();
        await stop.stopped;
        for (const name of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
            expect(host.listenerCount(name), name).toBe(0);
        }
        expect(stop.input.listenerCount("data")).toBe(0);
        expect(stop.input.isPaused()).toBe(true);
    });

    it("exits at once on a third request before the wait, and on any after it, with the exit code set", async () => {
        const host = fakeHost();
        const stop = pendingStop(host);
        host.emit("SIGHUP");
        expect(stop.shutdown).toBeDefined();
        host.emit("SIGHUP");
        expect(host.exit).not.toHaveBeenCalled();
        host.emit("SIGBREAK");
        expect(host.exit).toHaveBeenLastCalledWith(130);
        // The wait gave up (75): Peerbit is stopping.
        stop.shutdown!.phase = 2;
        process.exitCode = 75;
        host.emit("SIGINT");
        expect(host.exit).toHaveBeenLastCalledWith(75);
        expect(host.exit).toHaveBeenCalledTimes(2);
        stop.release();
        await stop.stopped;
    });

    it("takes a shutdown line on a piped stdin, but never reads a terminal", async () => {
        let stops = 0;
        const stop = async () => void stops++;

        // Another line, then EOF (a `< /dev/null` stdin): no stop.
        const ignoring = new PassThrough();
        const ignoringHost = fakeHost();
        const ignored = waitForTermination(stop, ignoringHost as any, ignoring);
        ignoring.write("status\n");
        ignoring.end();
        await new Promise((resolve) => ignoring.once("end", resolve));
        expect(stops).toBe(0);
        ignoringHost.emit("SIGINT");
        await ignored;
        expect(stops).toBe(1);

        // A Windows CRLF line.
        const piped = new PassThrough();
        const stoppedByLine = waitForTermination(
            stop,
            fakeHost() as any,
            piped
        );
        piped.write("shutdown\r\n");
        await stoppedByLine;
        expect(stops).toBe(2);

        const terminal = Object.assign(new PassThrough(), { isTTY: true });
        const host = fakeHost();
        const stoppedBySignal = waitForTermination(stop, host as any, terminal);
        expect(terminal.listenerCount("data")).toBe(0);
        host.emit("SIGINT");
        await stoppedBySignal;
        expect(stops).toBe(3);
    });

    it("drains open files and persists before Peerbit stops; a second request aborts the fence with 130", async () => {
        const order: string[] = [];
        const lines: string[] = [];
        vi.spyOn(console, "error").mockImplementation((...args) => {
            lines.push(args.join(" "));
        });
        let fence: { timeout?: number; signal?: AbortSignal } | undefined;
        let fenceStarted!: () => void;
        const fenceRunning = new Promise<void>((resolve) => {
            fenceStarted = resolve;
        });
        const fsHandle = {
            pendingLocalWrites: () => ({ entries: 3, remoteReplicaSeen: true }),
            persistLocalWrites: vi.fn(
                async (options?: {
                    timeout?: number;
                    signal?: AbortSignal;
                }) => {
                    order.push("persist");
                    fence = options;
                    fenceStarted();
                    await new Promise((resolve) =>
                        options?.signal?.addEventListener("abort", resolve)
                    );
                    throw Object.assign(new Error("aborted"), {
                        unacknowledged: [
                            { id: "chunk:a", path: "/a.txt" },
                            { id: "version:a", path: "/a.txt" },
                            { id: "manifest:b" },
                        ],
                    });
                }
            ),
        };
        const backend: Pick<SharedFsMountBackend, "dispose" | "drain"> = {
            drain: async () => {
                order.push("drain");
                return { failed: [] };
            },
            dispose: () => order.push("dispose"),
        };
        const host = fakeHost();
        host.exit.mockImplementation(() => void order.push("exit"));
        const stopped = waitForTermination(
            (shutdown) =>
                stopMountSession({
                    mounted: {
                        unmount: async () => void order.push("unmount"),
                    },
                    ipc: { close: async () => void order.push("ipc") },
                    backend,
                    persist: () =>
                        persistOnExit(
                            fsHandle as any,
                            { persistOnExit: true, persistTimeoutMs: 30_000 },
                            shutdown
                        ),
                    stopPeerbit: async () => void order.push("peerbit"),
                }),
            host as any,
            new PassThrough()
        );
        host.emit("SIGINT");
        host.emit("SIGINT");
        await fenceRunning;
        expect(fence?.timeout).toBe(30_000);
        expect(fence?.signal?.aborted).toBe(false);
        host.emit("SIGTERM");
        await stopped;

        // Out right after the list: Peerbit is not stopped first.
        expect(order).toEqual([
            "unmount",
            "ipc",
            "drain",
            "dispose",
            "persist",
            "exit",
            "peerbit",
        ]);
        expect(host.exit).toHaveBeenCalledWith(130);
        expect(process.exitCode).toBe(130);
        expect(unacknowledged(lines)).toEqual([
            { path: "/a.txt", ids: ["chunk:a", "version:a"] },
            { path: null, ids: ["manifest:b"] },
        ]);
        expect(persistLines(lines).at(-1)).toBe(
            "persist-on-exit: gave up: aborted"
        );
    });

    /** A fence that gives up, leaving `paths` unacknowledged. */
    const givingUp = (paths: number, order: string[] = []) => ({
        pendingLocalWrites: () => ({ entries: paths, remoteReplicaSeen: true }),
        persistLocalWrites: async () => {
            order.push("persist");
            throw Object.assign(new Error("Timed out"), {
                unacknowledged: Array.from({ length: paths }, (_, i) => ({
                    id: `version:${i}`,
                    path: `/f${i}.txt`,
                })),
            });
        },
    });

    it("exits 1 when an open file's bytes cannot be saved, still fences and stops, and keeps 1 when the fence gives up", async () => {
        const lines: string[] = [];
        vi.spyOn(console, "error").mockImplementation((...args) => {
            lines.push(args.join(" "));
        });
        const order: string[] = [];
        await stopMountSession({
            backend: {
                drain: async () => ({
                    failed: [{ path: "/open.txt", error: new Error("EIO") }],
                }),
                dispose: () => order.push("dispose"),
            },
            persist: () =>
                persistOnExit(givingUp(1, order) as any, {
                    persistOnExit: true,
                    persistTimeoutMs: 1,
                }),
            stopPeerbit: async () => void order.push("peerbit"),
        });
        expect(persistLines(lines)[0]).toBe(
            'persist-on-exit: unsaved {"path":"/open.txt","error":"Error: EIO"}'
        );
        expect(persistLines(lines).at(-1)).toBe(
            "persist-on-exit: gave up: Timed out"
        );
        expect(process.exitCode).toBe(1);
        expect(order).toEqual(["dispose", "persist", "peerbit"]);
    });

    it("lists 200 unacknowledged paths, then counts the rest on one line", async () => {
        const lines: string[] = [];
        vi.spyOn(console, "error").mockImplementation((...args) => {
            lines.push(args.join(" "));
        });
        await persistOnExit(givingUp(250) as any, {
            persistOnExit: true,
            persistTimeoutMs: 1,
        });
        expect(unacknowledged(lines)).toHaveLength(200);
        expect(unacknowledged(lines).at(-1)).toEqual({
            path: "/f199.txt",
            ids: ["version:199"],
        });
        expect(persistLines(lines).slice(-2)).toEqual([
            'persist-on-exit: unlisted {"paths":50}',
            "persist-on-exit: gave up: Timed out",
        ]);
        expect(process.exitCode).toBe(75);
    });

    it("documents the flags in mount --help and checks them before Peerbit starts", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
            throw new Error(`process.exit(${code})`);
        }) as never);
        await runCli(["mount", "--help"]).catch(() => {});
        // yargs wraps the description column inside words.
        const help = log.mock.calls
            .flat()
            .map(String)
            .join("")
            .replace(/\s+/g, "");
        expect(help).toMatch(
            /--persist-on-exit[^[]*\[boolean\]\[default:true\]/
        );
        expect(help).toMatch(
            /--persist-timeout-ms[^[]*\[number\]\[default:30000\]/
        );

        const reached = new Error("Peerbit.create reached");
        const create = vi.spyOn(Peerbit, "create").mockRejectedValue(reached);
        for (const [value, got] of [
            ["0", "0"],
            ["2147483648", "2147483648"],
            ["1.5", "1.5"],
            ["abc", "NaN"],
        ]) {
            await expect(
                runCli([
                    "mount",
                    "zb2rh-not-opened",
                    "/tmp/peerbit-shared-fs-not-mounted",
                    "--no-persist-on-exit",
                    `--persist-timeout-ms=${value}`,
                    "--directory",
                    "",
                ])
            ).rejects.toThrow(
                `--persist-timeout-ms must be an integer from 1 to 2147483647 (milliseconds); got ${got}`
            );
        }
        // yargs would read it as --no-persist-on-exit.
        await expect(
            runCli([
                "mount",
                "zb2rh-not-opened",
                "/tmp/peerbit-shared-fs-not-mounted",
                "--persist-on-exit=30000",
                "--directory",
                "",
            ])
        ).rejects.toThrow(
            "--persist-on-exit=30000: --persist-on-exit takes no value; set the wait with --persist-timeout-ms"
        );
        expect(create).not.toHaveBeenCalled();
    });
});

describe("mount --persist-on-exit over real TCP", () => {
    const live = new Set<Peerbit>();
    const directories: string[] = [];
    let lines: Array<{ line: string; at: number }> = [];
    let lineWaiters: Array<() => void> = [];

    beforeEach(() => {
        lines = [];
        lineWaiters = [];
        vi.spyOn(console, "error").mockImplementation((...args) => {
            lines.push({ line: args.join(" "), at: performance.now() });
            for (const wake of lineWaiters.splice(0)) wake();
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        process.exitCode = undefined;
        await Promise.allSettled([...live].map((peer) => stop(peer)));
        for (const directory of directories.splice(0)) {
            // Windows may still hold a just-closed store for a moment.
            await fs.rm(directory, {
                recursive: true,
                force: true,
                maxRetries: 10,
                retryDelay: 200,
            });
        }
    });

    const stop = async (peer: Peerbit) => {
        if (!live.delete(peer)) return;
        await peer.stop();
        await peer.services.blocks.stop();
    };

    const stderr = () => lines.map(({ line }) => line);

    const findLine = (pattern: RegExp) =>
        lines.find(({ line }) => pattern.test(line));

    /** Resolves with the first stderr line matching `pattern`. */
    const untilLine = async (pattern: RegExp) => {
        for (;;) {
            const hit = lines.find(({ line }) => pattern.test(line));
            if (hit) return hit;
            await new Promise<void>((resolve) => lineWaiters.push(resolve));
        }
    };

    /** A peer listening on loopback TCP only; durable unless `memory`. */
    const createPeer = async (label: string, memory = false) => {
        const directory = memory
            ? undefined
            : await fs.mkdtemp(
                  path.join(os.tmpdir(), `peerbit-shared-fs-persist-${label}-`)
              );
        if (directory) directories.push(directory);
        const peer = await Peerbit.create({
            directory,
            libp2p: { addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] } },
        });
        live.add(peer);
        return { peer, directory: directory! };
    };

    const open = (peer: Peerbit, label: string, address?: string) =>
        openSharedFs({
            peerbit: peer,
            ...(address
                ? { address, remoteChunkFetch: false, allowPartialWrites: true }
                : {}),
            machineLabel: label,
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });

    /** Resolves once `handle` saw another replica join, on join events. */
    const untilReplicaSeen = (handle: SharedFsHandle) =>
        untilEvent(
            handle.program.entries.log.events as unknown as EventTarget,
            "replicator:join",
            () => handle.pendingLocalWrites().remoteReplicaSeen,
            "another replica joins"
        );

    /** Write files as the adapter does: open, write, release. */
    const writeThroughMount = async (
        backend: SharedFsMountBackend,
        count: number,
        options: { prefix?: string; leaveLastOpen?: boolean } = {}
    ) => {
        const prefix = options.prefix ?? "/f";
        for (let i = 0; i < count; i++) {
            const handle = await backend.open(`${prefix}${i}.txt`, {
                write: true,
                create: true,
                truncate: true,
            });
            await backend.write(
                handle,
                new TextEncoder().encode(content(i)),
                0
            );
            if (!(options.leaveLastOpen && i === count - 1)) {
                await backend.release(handle);
            }
        }
    };

    /** The mount's shutdown: drain, persist-on-exit, stop Peerbit. */
    const shutdownOnRequest = (
        writer: { peer: Peerbit; handle: SharedFsHandle },
        backend: SharedFsMountBackend,
        options: { persistOnExit: boolean; persistTimeoutMs: number },
        host = fakeHost(),
        input = new PassThrough()
    ) => {
        const stopped = waitForTermination(
            (shutdown) =>
                stopMountSession({
                    backend,
                    persist: () =>
                        persistOnExit(writer.handle, options, shutdown),
                    stopPeerbit: () => stop(writer.peer),
                }),
            host as any,
            input
        );
        return {
            // The fence, then Peerbit stops.
            stopped: within(stopped, "the writer stops", FENCE_MS + STEP_MS),
            host,
            input,
        };
    };

    /** Start a stopped replica again from its directory; it dials `to`. */
    const rejoin = async (directory: string, address: string, to: Peerbit) => {
        const peer = await Peerbit.create({
            directory,
            libp2p: { addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] } },
        });
        live.add(peer);
        await peer.dial(to.getMultiaddrs());
        await open(peer, "receiver", address);
        return peer;
    };

    /** Reopen a stopped replica alone, offline, from its own directory. */
    const reopenOffline = async (directory: string, address: string) => {
        const peer = await Peerbit.create({ directory });
        live.add(peer);
        return openSharedFs({
            peerbit: peer,
            address,
            machineLabel: "offline-reopen",
            replicate: false,
            bootstrap: false,
            remoteChunkFetch: false,
            gc: false,
        });
    };

    it("exits 0 only once another replica holds all 500 files, read there after the writer is gone", async () => {
        const writer = await createPeer("writer");
        const receiver = await createPeer("receiver");
        await writer.peer.dial(receiver.peer.getMultiaddrs());
        const writerFs = await open(writer.peer, "writer");
        const address = writerFs.address;
        await open(receiver.peer, "receiver", address);
        await untilReplicaSeen(writerFs);
        // The receiver is away while the files are written: without the
        // fence none of them would reach it before the writer stops.
        await stop(receiver.peer);

        const backend = createSharedFsMountBackend(writerFs);
        const writeStarted = performance.now();
        // The last file stays open with its bytes buffered: the drain
        // commits it, the fence then delivers it.
        await writeThroughMount(backend, 500, { leaveLastOpen: true });
        const writeMs = performance.now() - writeStarted;

        // The Windows path: a `shutdown` line on stdin.
        const { stopped, input } = shutdownOnRequest(
            { peer: writer.peer, handle: writerFs },
            backend,
            { persistOnExit: true, persistTimeoutMs: FENCE_MS }
        );
        input.write("shutdown\n");
        let writerStopped = false;
        void stopped.then(
            () => (writerStopped = true),
            () => {}
        );
        await Promise.race([untilLine(/waiting up to/), stopped]);
        // The receiver comes back while the writer waits for it. A fence
        // that gives up stops the writer under the dial: report its exit.
        const back = writerStopped
            ? undefined
            : await within(
                  rejoin(receiver.directory, address, writer.peer),
                  "the receiver rejoins"
              ).catch((error: Error) => error);
        await stopped;
        expect(process.exitCode ?? 0, stderr().join("\n")).toBe(0);
        if (back instanceof Error) throw back;
        expect(live.has(writer.peer)).toBe(false);
        await fs.rm(writer.directory, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 200,
        });

        if (back) await stop(back);
        const reopened = await reopenOffline(receiver.directory, address);
        for (let i = 0; i < 500; i++) {
            expect(
                text(await reopened.readFile(`/f${i}.txt`)),
                `/f${i}.txt`
            ).toBe(content(i));
        }
        const waiting = findLine(/waiting up to/);
        const done = findLine(/entries acknowledged in \d+ ms$/);
        expect(waiting).toBeDefined();
        expect(done?.line).toMatch(
            /^persist-on-exit: \d+ entries acknowledged in \d+ ms$/
        );
        console.log(
            "persist-on-exit 500 files:",
            JSON.stringify({
                writeMs: Math.round(writeMs),
                fenceMs: Math.round(done!.at - waiting!.at),
                line: done!.line,
            })
        );
    });

    it("is not failed by another writer adding a file a second while it waits", async () => {
        const writer = await createPeer("writer");
        const receiver = await createPeer("receiver");
        // In memory: a replica that writes, but can issue no persisted
        // receipt, so the fence waits for the receiver.
        const remote = await createPeer("remote", true);
        await writer.peer.dial(receiver.peer.getMultiaddrs());
        await remote.peer.dial(writer.peer.getMultiaddrs());
        const writerFs = await open(writer.peer, "writer");
        const address = writerFs.address;
        await open(receiver.peer, "receiver", address);
        const remoteFs = await open(remote.peer, "remote", address);
        await untilReplicaSeen(writerFs);
        await stop(receiver.peer);

        const backend = createSharedFsMountBackend(writerFs);
        await writeThroughMount(backend, 20);

        // Arrivals at the writer from the remote writer.
        const arrivals: number[] = [];
        const arrivalWaiters: Array<() => void> = [];
        writerFs.program.entries.events.addEventListener(
            "change",
            (event: any) => {
                for (const value of event.detail.added) {
                    if (
                        value instanceof FileVersion &&
                        value.machineLabel === "remote"
                    ) {
                        arrivals.push(performance.now());
                    }
                }
                for (const wake of arrivalWaiters.splice(0)) wake();
            }
        );
        let writing = true;
        const remoteWrites = (async () => {
            for (let n = 0; writing; n++) {
                await remoteFs.writeFile(`/remote-${n}.txt`, `remote ${n}`);
                await new Promise((resolve) => setTimeout(resolve, 1_000));
            }
        })();

        const { stopped, host } = shutdownOnRequest(
            { peer: writer.peer, handle: writerFs },
            backend,
            { persistOnExit: true, persistTimeoutMs: FENCE_MS }
        );
        host.emit("SIGTERM");
        let writerStopped = false;
        void stopped.then(
            () => (writerStopped = true),
            () => {}
        );
        await Promise.race([untilLine(/waiting up to/), stopped]);
        const fenceStarted = performance.now();
        // Three remote files arrive while the fence waits, then the
        // receiver comes back.
        const during = () => arrivals.filter((at) => at > fenceStarted).length;
        const deadline = giveUpAfter(STEP_MS, "three remote files arrive");
        try {
            while (!writerStopped && during() < 3) {
                await Promise.race([
                    new Promise<void>((resolve) =>
                        arrivalWaiters.push(resolve)
                    ),
                    stopped,
                    deadline.expired,
                ]);
            }
        } finally {
            deadline.clear();
        }
        expect(writerStopped, "the fence waited for the receiver").toBe(false);
        const back = await within(
            rejoin(receiver.directory, address, writer.peer),
            "the receiver rejoins"
        );
        await stopped;
        writing = false;
        await remoteWrites.catch(() => {});

        expect(during()).toBeGreaterThanOrEqual(3);
        expect(process.exitCode ?? 0).toBe(0);
        expect(persistLines(stderr()).at(-1)).toMatch(
            /^persist-on-exit: \d+ entries acknowledged in \d+ ms$/
        );
        await stop(remote.peer);
        await stop(back);
        const reopened = await reopenOffline(receiver.directory, address);
        for (let i = 0; i < 20; i++) {
            expect(text(await reopened.readFile(`/f${i}.txt`))).toBe(
                content(i)
            );
        }
    });

    it("exits 75 at its deadline and lists each unacknowledged file when the only replica is gone", async () => {
        const writer = await createPeer("writer");
        const receiver = await createPeer("receiver");
        await writer.peer.dial(receiver.peer.getMultiaddrs());
        const writerFs = await open(writer.peer, "writer");
        await open(receiver.peer, "receiver", writerFs.address);
        await untilReplicaSeen(writerFs);
        // Seen, then gone for good.
        await stop(receiver.peer);

        const backend = createSharedFsMountBackend(writerFs);
        await writeThroughMount(backend, 5);
        const persistTimeoutMs = 3_000;
        const { stopped, host } = shutdownOnRequest(
            { peer: writer.peer, handle: writerFs },
            backend,
            { persistOnExit: true, persistTimeoutMs }
        );
        host.emit("SIGTERM");
        await stopped;

        expect(process.exitCode).toBe(75);
        const listed = unacknowledged(stderr());
        const files = listed.filter(({ path }) => path !== null);
        expect(files.map(({ path }) => path).sort()).toEqual(
            [0, 1, 2, 3, 4].map((i) => `/f${i}.txt`)
        );
        // Only this replica's manifests have no path: listed by id.
        for (const { ids } of listed.filter(({ path }) => path === null)) {
            for (const id of ids) expect(id).toMatch(/^(bootstrap|changeset)/);
        }
        for (const { ids } of files) {
            // At least its chunk, its version and its name.
            expect(ids.length).toBeGreaterThanOrEqual(3);
        }
        const waiting = findLine(/waiting up to 3000 ms/)!;
        const gaveUp = findLine(/gave up: /)!;
        expect(gaveUp.line).toContain(
            "Timed out persisting this replica's writes"
        );
        // It waited for the replica until the deadline, and not much longer.
        expect(gaveUp.at - waiting.at).toBeGreaterThanOrEqual(
            persistTimeoutMs - 50
        );
        expect(gaveUp.at - waiting.at).toBeLessThan(persistTimeoutMs + 10_000);
    });

    it("--no-persist-on-exit stops at once, as before: the writes stay only on the writer", async () => {
        const writer = await createPeer("writer");
        const receiver = await createPeer("receiver");
        await writer.peer.dial(receiver.peer.getMultiaddrs());
        const writerFs = await open(writer.peer, "writer");
        const address = writerFs.address;
        await open(receiver.peer, "receiver", address);
        await untilReplicaSeen(writerFs);
        await stop(receiver.peer);

        const backend = createSharedFsMountBackend(writerFs);
        await writeThroughMount(backend, 5);
        const fence = vi.spyOn(writerFs, "persistLocalWrites");
        const { stopped, host } = shutdownOnRequest(
            { peer: writer.peer, handle: writerFs },
            backend,
            { persistOnExit: false, persistTimeoutMs: FENCE_MS }
        );
        host.emit("SIGINT");
        await stopped;

        expect(fence).not.toHaveBeenCalled();
        expect(persistLines(stderr())).toEqual([]);
        expect(process.exitCode ?? 0).toBe(0);
        const reopened = await reopenOffline(receiver.directory, address);
        expect(await reopened.readFile("/f0.txt")).toBeUndefined();
    });

    it("does not wait when no other replica was seen, and says so", async () => {
        const writer = await createPeer("writer");
        const writerFs = await open(writer.peer, "alone");
        const backend = createSharedFsMountBackend(writerFs);
        await writeThroughMount(backend, 5);
        const fence = vi.spyOn(writerFs, "persistLocalWrites");
        const { stopped, host } = shutdownOnRequest(
            { peer: writer.peer, handle: writerFs },
            backend,
            { persistOnExit: true, persistTimeoutMs: FENCE_MS }
        );
        const requested = performance.now();
        host.emit("SIGTERM");
        await stopped;

        expect(fence).not.toHaveBeenCalled();
        expect(process.exitCode ?? 0).toBe(0);
        expect(persistLines(stderr())).toEqual([
            expect.stringMatching(
                /^persist-on-exit: no other replica seen; not waiting \(\d+ entries only here\)$/
            ),
        ]);
        expect(performance.now() - requested).toBeLessThan(FENCE_MS);
    });
});
