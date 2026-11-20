import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
    FileVersion,
    Peerbit,
    createSharedFsMountBackend,
    localOverlayDirectory,
    openMountLocalOverlay,
    openSharedFs,
    type SharedFsHandle,
    type SharedFsMountBackend,
} from "@peerbit/shared-fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportAdapterExit } from "../external-native-adapter.js";
import {
    exitAfterStop,
    exitOnceFlushed,
    guardMountStart,
    persistOnExit,
    runCli,
    stopMountSession,
    waitForTermination,
    type MountShutdown,
} from "../index.js";
import { openMountLocalOverlayForCli } from "../local-overlay.js";

/**
 * mount --persist-on-exit, through the mount's shutdown seams:
 * waitForTermination (signals and the stdin `shutdown` line), stopMountSession
 * (unmount, drain, persist, stop) and persistOnExit, with the library's mount
 * backend driven as the native adapter drives it. Real Peerbit peers over
 * real TCP on loopback, no FUSE. Every wait resolves on an event and only
 * gives up at its deadline.
 */

/**
 * Give-up bounds: a step that is not under test (a join, a reconnect), and
 * a fence (on Windows, a fence that must deliver everything uses
 * SUCCESS_FENCE_MS instead). A test's bounds sum below its vitest timeout,
 * so a stuck step fails with its own label.
 */
const STEP_MS = 20_000;
const FENCE_MS = 30_000;

/**
 * The fence of a test that expects it to succeed (exit 0), with the
 * receiver rejoining inside it. Until it has the receipts, the writer
 * sends the receiver all the unconfirmed heads again about every 0.3 s,
 * and the receiver writes the coordinate row of every head in every copy,
 * also of heads it already holds, mostly one durable commit per row.
 * Those commits are synchronous: they hold the event loop, which writer
 * and receiver share here, timers included, and no receipt goes out until
 * they end. Windows CI took 25 s of a 30 s fence for 300 entries, and once
 * gave up before the first batch of 100 was fully confirmed. Linux and
 * macOS CI took 8 to 13 s for 1,500.
 *
 * 120 s on Windows is interim, until that duplicate work goes away; then
 * back to FENCE_MS. Emulated on macOS, with fsyncs slowed so the writes
 * take as long as Windows CI's slowest (38.6 s), the fence took 40 to
 * 96 s, and it passed with writes about 1.25 times as slow. At about 1.55
 * times, the receiver held the event loop for about 5 minutes and the
 * test failed after about 395 s: no fence covers that.
 */
const SUCCESS_FENCE_MS = process.platform === "win32" ? 120_000 : FENCE_MS;

/** vitest's 120 s, plus what a success fence adds to FENCE_MS. */
const SUCCESS_TEST_MS = 120_000 + SUCCESS_FENCE_MS - FENCE_MS;

/**
 * Files in the many-files fence test. Windows CI saves to durable stores
 * several times slower than Linux and macOS: with 500 files that test ran
 * past vitest's 120 s there, its fence still waiting. 100 files take the
 * same path.
 */
const MANY_FILES = process.platform === "win32" ? 100 : 500;

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

/**
 * A shutdown host: the process's signal events, exit and clock, without a
 * process. Its clock moves only when a test moves `ms`: a request less than
 * 100 ms after the last one acted on is a wrapper's copy.
 */
const fakeHost = () => {
    const host = Object.assign(new EventEmitter(), {
        exit: vi.fn(),
        ms: 0,
        uptime: (): number => host.ms / 1000,
    });
    return host;
};

const HINT = "shutdown: already stopping; request again to exit now";

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
        input = new PassThrough(),
        ended?: Promise<unknown>
    ) => {
        const state: {
            shutdown?: MountShutdown;
            stops: number;
            release(): void;
        } = { stops: 0, release: () => {} };
        const stopped = waitForTermination(
            (shutdown) => {
                state.shutdown = shutdown;
                state.stops++;
                return new Promise<void>(
                    (resolve) => (state.release = resolve)
                );
            },
            host as any,
            input,
            ended
        );
        return Object.assign(state, { stopped, input });
    };

    /** Runs what a settled promise scheduled. */
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    it("stops when the mount ends on its own (its adapter exited) as on a first request, and not again during a stop under way", async () => {
        const lines: string[] = [];
        vi.spyOn(console, "error").mockImplementation((...args) => {
            lines.push(args.join(" "));
        });
        let adapterExited!: () => void;
        const host = fakeHost();
        const stop = pendingStop(
            host,
            new PassThrough(),
            new Promise<void>((resolve) => (adapterExited = resolve))
        );
        await settle();
        expect(stop.stops).toBe(0);
        adapterExited();
        await settle();
        expect(stop.stops).toBe(1);
        expect(host.exit).not.toHaveBeenCalled();
        // A Ctrl-C now is a second request: out at once, with the status the
        // adapter's exit set.
        process.exitCode = 70;
        host.ms += 1_000;
        host.emit("SIGINT");
        expect(host.exit).toHaveBeenCalledWith(70);
        stop.release();
        await stop.stopped;
        expect(stop.stops).toBe(1);

        // An exit reported while a stop runs (the adapter died just before
        // the request) is not a second request, nor a copy of the first: its
        // report can come a second later, after the adapter's stderr closed.
        let lateExit!: () => void;
        const busyHost = fakeHost();
        const busy = pendingStop(
            busyHost,
            new PassThrough(),
            new Promise<void>((resolve) => (lateExit = resolve))
        );
        busyHost.emit("SIGTERM");
        expect(busy.stops).toBe(1);
        busyHost.ms += 1_000;
        lateExit();
        await settle();
        expect(busy.stops).toBe(1);
        expect(busyHost.exit).not.toHaveBeenCalled();
        busy.release();
        await busy.stopped;
        expect(lines).toEqual([]);
    });

    it("exits at once with 130 on a shutdown signal while the mount starts, until the stop takes over", () => {
        const host = fakeHost();
        const handOver = guardMountStart(host as any);
        for (const name of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
            host.emit(name);
            expect(host.exit, name).toHaveBeenLastCalledWith(130);
        }
        expect(host.exit).toHaveBeenCalledTimes(4);
        // An exit code already set, such as 1, is kept.
        process.exitCode = 1;
        host.emit("SIGINT");
        expect(host.exit).toHaveBeenLastCalledWith(1);
        handOver();
        for (const name of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
            expect(host.listenerCount(name), name).toBe(0);
        }
    });

    it("hands the shutdown signals to the stop without a moment in which none is listened for", () => {
        const host = fakeHost();
        const handOver = guardMountStart(host as any);
        const names = ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"];
        const stop = vi.fn();
        const before: number[] = [];
        expect(
            handOver(() => {
                for (const name of names) {
                    before.push(host.listenerCount(name));
                    host.on(name, stop);
                }
                return "stopped";
            })
        ).toBe("stopped");
        // The start's listeners were still there when the stop's came.
        expect(before).toEqual([1, 1, 1, 1]);
        for (const name of names) {
            expect(host.listeners(name), name).toEqual([stop]);
            host.emit(name);
        }
        expect(stop).toHaveBeenCalledTimes(4);
        expect(host.exit).not.toHaveBeenCalled();
    });

    it("keeps an adapter failure's 70 over 75 and 130, and a failed step's 1 over 70", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        reportAdapterExit(
            { code: null, signal: "SIGKILL", stderr: [] },
            () => {}
        );
        expect(process.exitCode).toBe(70);
        // persist-on-exit gives up: 75 is not set over it.
        await persistOnExit(givingUp(1) as any, {
            persistOnExit: true,
            persistTimeoutMs: 1,
        });
        expect(process.exitCode).toBe(70);
        // A second request exits with it, not 130.
        const host = fakeHost();
        const stop = pendingStop(host);
        host.emit("SIGINT");
        host.ms += 1_000;
        host.emit("SIGINT");
        expect(host.exit).toHaveBeenCalledWith(70);
        stop.release();
        await stop.stopped;
        // A stop step that fails exits 1 over it; every step still runs.
        const order: string[] = [];
        await expect(
            stopMountSession({
                ipc: {
                    close: async () => {
                        throw new Error("close failed");
                    },
                },
                stopPeerbit: async () => void order.push("peerbit"),
            })
        ).rejects.toThrow("close failed");
        expect(order).toEqual(["peerbit"]);
        expect(process.exitCode).toBe(1);
    });

    it("ignores a wrapper's copy of a request with a hint, aborts a wait under way, and exits at once otherwise", async () => {
        const lines: string[] = [];
        vi.spyOn(console, "error").mockImplementation((...args) => {
            lines.push(args.join(" "));
        });
        const host = fakeHost();
        const stop = pendingStop(host);
        expect(stop.shutdown).toBeUndefined();

        // npm, pnpm and npx pass one Ctrl-C on as a second SIGINT, at once.
        host.emit("SIGINT");
        host.ms += 99;
        host.emit("SIGINT");
        expect(stop.shutdown?.signal.aborted).toBe(false);
        expect(host.exit).not.toHaveBeenCalled();
        expect(lines).toEqual([HINT]);
        // The wait is under way: a request aborts it, its copy does nothing.
        stop.shutdown!.waiting = true;
        host.ms += 2_000;
        host.emit("SIGTERM");
        host.emit("SIGTERM");
        expect(stop.shutdown!.signal.aborted).toBe(true);
        expect(host.exit).not.toHaveBeenCalled();
        expect(lines).toEqual([HINT, HINT]);
        // A closed terminal (SIGHUP) is a request too: the wait is already
        // aborted, so this one exits.
        host.ms += 100;
        host.emit("SIGHUP");
        expect(host.exit).toHaveBeenCalledWith(130);

        stop.release();
        await stop.stopped;
        // The signal listeners stay, for a request after the stop; stdin is
        // let go.
        for (const name of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
            expect(host.listenerCount(name), name).toBe(1);
        }
        expect(stop.input.listenerCount("data")).toBe(0);
        expect(stop.input.isPaused()).toBe(true);
    });

    it("exits at once on a request after the stop settled, with the exit code set", async () => {
        // An adapter's exit set 70 and the stop is done, but timers the stop
        // left keep the process: a Ctrl-C then exits with 70, not by SIGINT.
        const host = fakeHost();
        const stop = pendingStop(host);
        host.emit("SIGTERM");
        process.exitCode = 70;
        stop.release();
        await stop.stopped;
        expect(host.exit).not.toHaveBeenCalled();
        host.ms += 1_000;
        host.emit("SIGINT");
        expect(host.exit).toHaveBeenLastCalledWith(70);
        // A stop that failed: exit 1.
        const failing = fakeHost();
        const failed = waitForTermination(
            async () => {
                process.exitCode = 1;
                throw new Error("close failed");
            },
            failing as any,
            new PassThrough()
        );
        failing.emit("SIGHUP");
        await expect(failed).rejects.toThrow("close failed");
        failing.ms += 1_000;
        failing.emit("SIGTERM");
        expect(failing.exit).toHaveBeenLastCalledWith(1);
    });

    it("exits with the exit code set once stdout and stderr have written what they hold", async () => {
        const host = fakeHost();
        const held: (() => void)[] = [];
        const slow = () =>
            new Writable({
                write: (_chunk, _encoding, done) => void held.push(done),
            });
        const [stdout, stderr] = [slow(), slow()];
        stdout.write("persist-on-exit: 5 entries acknowledged in 3 ms\n");
        process.exitCode = 75;
        exitOnceFlushed(host as any, [stdout, stderr]);
        await settle();
        // The line, then each stream's empty write.
        let writes = 0;
        while (held.length) {
            expect(host.exit, `after ${writes} writes`).not.toHaveBeenCalled();
            held.shift()!();
            writes++;
            await settle();
        }
        expect(writes).toBe(3);
        expect(host.exit).toHaveBeenCalledExactlyOnceWith(75);
    });

    it("prints a failed stop's error as one line and exits 1 over 70 once stdout and stderr have written it", async () => {
        const lines: string[] = [];
        vi.spyOn(console, "error").mockImplementation((...args) => {
            lines.push(stripVTControlCharacters(args.join(" ")));
        });
        const held: (() => void)[] = [];
        const slow = () =>
            new Writable({
                write: (_chunk, _encoding, done) => void held.push(done),
            });
        // The adapter's exit set 70, then clearing the mount it left failed;
        // the other steps still ran.
        process.exitCode = 70;
        const order: string[] = [];
        const host = fakeHost();
        const stopped = waitForTermination(
            () =>
                stopMountSession({
                    mounted: {
                        unmount: async () => {
                            throw new Error("Could not clear /mnt: not ours");
                        },
                    },
                    stopPeerbit: async () => void order.push("peerbit"),
                }),
            host as any,
            new PassThrough()
        );
        host.emit("SIGTERM");
        // Settles: nothing is thrown on to yargs.
        await exitAfterStop(stopped, host as any, [slow(), slow()]);
        expect(order).toEqual(["peerbit"]);
        expect(lines).toEqual(["Could not clear /mnt: not ours"]);
        expect(process.exitCode).toBe(1);
        expect(held).toHaveLength(2);
        held.shift()!();
        await settle();
        expect(host.exit).not.toHaveBeenCalled();
        held.shift()!();
        await settle();
        expect(host.exit).toHaveBeenCalledExactlyOnceWith(1);

        // A stop that succeeded prints nothing and exits with the code set.
        process.exitCode = 70;
        const done = fakeHost();
        const flushed = () =>
            new Writable({ write: (_chunk, _encoding, next) => next() });
        const succeeded = waitForTermination(
            async () => {},
            done as any,
            new PassThrough()
        );
        done.emit("SIGINT");
        await exitAfterStop(succeeded, done as any, [flushed(), flushed()]);
        await settle();
        expect(lines).toHaveLength(1);
        expect(done.exit).toHaveBeenCalledExactlyOnceWith(70);
    });

    it("exits at once on a second request outside the wait, with the exit code set", async () => {
        const host = fakeHost();
        const stop = pendingStop(host);
        host.emit("SIGHUP");
        expect(stop.shutdown).toBeDefined();
        // Run directly, a second Ctrl-C while the mount unmounts: out at
        // once, as before persist-on-exit.
        host.ms += 500;
        host.emit("SIGINT");
        expect(host.exit).toHaveBeenLastCalledWith(130);
        // The wait gave up (75): Peerbit is stopping.
        process.exitCode = 75;
        host.ms += 500;
        host.emit("SIGBREAK");
        expect(host.exit).toHaveBeenLastCalledWith(75);
        expect(host.exit).toHaveBeenCalledTimes(2);
        stop.release();
        await stop.stopped;
    });

    it.each([
        ["--no-persist-on-exit", false, 5, true],
        ["no other replica seen", true, 5, false],
        ["nothing to wait for", true, 0, true],
        ["a wait that succeeded", true, 5, true],
    ])(
        "exits at once on a second request while Peerbit stops: %s",
        async (_, persistOnExitOption, entries, remoteReplicaSeen) => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            const order: string[] = [];
            const fsHandle = {
                pendingLocalWrites: () => ({ entries, remoteReplicaSeen }),
                persistLocalWrites: async () => entries,
            };
            const host = fakeHost();
            host.exit.mockImplementation(() => void order.push("exit"));
            let peerbitStopping!: () => void;
            let releasePeerbit!: () => void;
            const atPeerbit = new Promise<void>((resolve) => {
                peerbitStopping = resolve;
            });
            const stopped = waitForTermination(
                (shutdown) =>
                    stopMountSession({
                        persist: () =>
                            persistOnExit(
                                fsHandle as any,
                                {
                                    persistOnExit: persistOnExitOption,
                                    persistTimeoutMs: 30_000,
                                },
                                shutdown
                            ),
                        stopPeerbit: () =>
                            new Promise<void>((resolve) => {
                                order.push("peerbit");
                                releasePeerbit = resolve;
                                peerbitStopping();
                            }),
                    }),
                host as any,
                new PassThrough()
            );
            host.emit("SIGINT");
            await atPeerbit;
            // A slow Peerbit stop (up to 10 s), and a second Ctrl-C.
            host.ms += 1_000;
            host.emit("SIGINT");
            expect(order).toEqual(["peerbit", "exit"]);
            expect(host.exit).toHaveBeenCalledWith(130);
            releasePeerbit();
            await stopped;
        }
    );

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
        host.ms += 1_000;
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
        // The copy of the first Ctrl-C.
        expect(lines.filter((line) => line === HINT)).toHaveLength(1);
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
        // yargs would read it as --no-persist-on-exit: a usage error instead,
        // the command's usage and then the refusal.
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        for (const flag of ["--persist-on-exit", "--persistOnExit"]) {
            error.mockClear();
            await expect(
                runCli([
                    "mount",
                    "zb2rh-not-opened",
                    "/tmp/peerbit-shared-fs-not-mounted",
                    `${flag}=30000`,
                    "--directory",
                    "",
                ])
            ).rejects.toBeInstanceOf(Error);
            const output = error.mock.calls.map((call) => call.join(" "));
            expect(output[0]).toMatch(
                /^peerbit-fs mount <address> <mountpoint>\n/
            );
            expect(output.at(-1)).toBe(
                `${flag}=30000: ${flag} takes no value; set the wait with --persist-timeout-ms`
            );
        }
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
            stopped: within(
                stopped,
                "the writer stops",
                Math.max(options.persistTimeoutMs, FENCE_MS) + STEP_MS
            ),
            host,
            input,
        };
    };

    /** Entries in `handle`'s log, or null once it is closed. */
    const logLength = (handle: SharedFsHandle) => {
        try {
            return handle.program.entries.log.log.length;
        } catch {
            return null;
        }
    };

    /** When a rejoin started and each of its steps ended. */
    type RejoinTimes = {
        started?: number;
        created?: number;
        dialed?: number;
        opened?: number;
    };

    /**
     * Start a stopped replica again from its directory; it dials `to`.
     * Its steps' times go to `at`.
     */
    const rejoin = async (
        directory: string,
        address: string,
        to: Peerbit,
        at: RejoinTimes = {}
    ) => {
        at.started = performance.now();
        const peer = await Peerbit.create({
            directory,
            libp2p: { addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] } },
        });
        live.add(peer);
        at.created = performance.now();
        await peer.dial(to.getMultiaddrs());
        at.dialed = performance.now();
        const handle = await open(peer, "receiver", address);
        at.opened = performance.now();
        return { peer, handle };
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

    it(
        `exits 0 only once another replica holds all ${MANY_FILES} files, read there after the writer is gone`,
        { timeout: SUCCESS_TEST_MS },
        async ({ signal }) => {
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
            await writeThroughMount(backend, MANY_FILES, {
                leaveLastOpen: true,
            });
            const writeMs = performance.now() - writeStarted;
            // Printed before the fence, so a run that times out still says how
            // long the writes took.
            console.log(
                `persist-on-exit ${MANY_FILES} files written in ${Math.round(writeMs)} ms`
            );

            // The Windows path: a `shutdown` line on stdin.
            const { stopped, input } = shutdownOnRequest(
                { peer: writer.peer, handle: writerFs },
                backend,
                { persistOnExit: true, persistTimeoutMs: SUCCESS_FENCE_MS }
            );
            input.write("shutdown\n");
            let writerStopped = false;
            void stopped.then(
                () => (writerStopped = true),
                () => {}
            );
            const rejoinAt: RejoinTimes = {};
            let back:
                | { peer: Peerbit; handle: SharedFsHandle }
                | Error
                | undefined;
            // Printed once, as soon as the writer's stop settles and before
            // anything is checked: when the receiver was back (ms from the
            // "waiting up to" line), when the fence ended and how much of the
            // store the receiver held. A stop past its bound and a test past
            // its timeout skip the exit-code check, which prints stderr, so
            // they print the persist-on-exit lines too.
            let reported = false;
            const report = (withPersistLines: boolean) => {
                if (reported) return;
                reported = true;
                const waiting = findLine(/waiting up to/);
                const since = (at?: number) =>
                    at === undefined || !waiting
                        ? null
                        : Math.round(at - waiting.at);
                console.log(
                    `persist-on-exit fence: ${JSON.stringify({
                        rejoinStartedAt: since(rejoinAt.started),
                        rejoinCreatedAt: since(rejoinAt.created),
                        rejoinDialedAt: since(rejoinAt.dialed),
                        rejoinResolvedAt: since(rejoinAt.opened),
                        rejoinMs:
                            rejoinAt.opened === undefined
                                ? null
                                : Math.round(
                                      rejoinAt.opened - rejoinAt.started!
                                  ),
                        rejoinError:
                            back instanceof Error ? back.message : null,
                        fenceEndedAt: since(
                            findLine(
                                /entries acknowledged in \d+ ms$|gave up: /
                            )?.at
                        ),
                        receiverEntries:
                            back && !(back instanceof Error)
                                ? logLength(back.handle)
                                : null,
                    })}`
                );
                const persist = persistLines(stderr());
                if (withPersistLines && persist.length) {
                    console.log(persist.join("\n"));
                }
            };
            // Vitest aborts the signal when the test times out.
            signal.addEventListener("abort", () => report(true));
            try {
                await Promise.race([untilLine(/waiting up to/), stopped]);
                // The receiver comes back while the writer waits for it. A
                // fence that gives up stops the writer under the dial: report
                // its exit.
                back = writerStopped
                    ? undefined
                    : await within(
                          rejoin(
                              receiver.directory,
                              address,
                              writer.peer,
                              rejoinAt
                          ),
                          "the receiver rejoins"
                      ).catch((error: Error) => error);
                await stopped;
            } catch (error) {
                report(true);
                throw error;
            }
            report(false);
            expect(process.exitCode ?? 0, stderr().join("\n")).toBe(0);
            if (back instanceof Error) throw back;
            expect(live.has(writer.peer)).toBe(false);
            await fs.rm(writer.directory, {
                recursive: true,
                force: true,
                maxRetries: 10,
                retryDelay: 200,
            });

            if (back) await stop(back.peer);
            const reopened = await reopenOffline(receiver.directory, address);
            for (let i = 0; i < MANY_FILES; i++) {
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
                `persist-on-exit ${MANY_FILES} files:`,
                JSON.stringify({
                    writeMs: Math.round(writeMs),
                    fenceMs: Math.round(done!.at - waiting!.at),
                    line: done!.line,
                })
            );
        }
    );

    it(
        "is not failed by another writer adding a file a second while it waits",
        { timeout: SUCCESS_TEST_MS },
        async () => {
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
                { persistOnExit: true, persistTimeoutMs: SUCCESS_FENCE_MS }
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
            const during = () =>
                arrivals.filter((at) => at > fenceStarted).length;
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
            expect(writerStopped, "the fence waited for the receiver").toBe(
                false
            );
            const back = await within(
                rejoin(receiver.directory, address, writer.peer),
                "the receiver rejoins"
            );
            await stopped;
            writing = false;
            await remoteWrites.catch(() => {});

            expect(during()).toBeGreaterThanOrEqual(3);
            expect(process.exitCode ?? 0, stderr().join("\n")).toBe(0);
            expect(persistLines(stderr()).at(-1)).toMatch(
                /^persist-on-exit: \d+ entries acknowledged in \d+ ms$/
            );
            await stop(remote.peer);
            await stop(back.peer);
            const reopened = await reopenOffline(receiver.directory, address);
            for (let i = 0; i < 20; i++) {
                expect(text(await reopened.readFile(`/f${i}.txt`))).toBe(
                    content(i)
                );
            }
        }
    );

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

    it("--no-persist-on-exit skips the wait: the writes stay only on the writer", async () => {
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

    it("prints nothing when every write stayed in node_modules, and deletes an in-memory mount's overlay", async () => {
        const writer = await createPeer("writer", true);
        const receiver = await createPeer("receiver");
        await writer.peer.dial(receiver.peer.getMultiaddrs());
        const writerFs = await open(writer.peer, "writer");
        await open(receiver.peer, "receiver", writerFs.address);
        await untilReplicaSeen(writerFs);

        // As `mount --directory ""` opens it: a temporary directory.
        const localOverlay = await openMountLocalOverlayForCli(
            { localOverlayDirectory, openMountLocalOverlay },
            {
                stateDirectory: undefined,
                address: writerFs.address,
                sealedNames: writerFs.program.sealedIgnoredNames,
            }
        );
        directories.push(localOverlay.directory);
        const backend = createSharedFsMountBackend(writerFs, {
            localOverlay: localOverlay.overlay,
        });
        await backend.mkdir("/node_modules");
        // The last file stays open: the drain closes it, unreported.
        await writeThroughMount(backend, 20, {
            prefix: "/node_modules/f",
            leaveLastOpen: true,
        });
        expect(writerFs.pendingLocalWrites()).toEqual({
            entries: 0,
            remoteReplicaSeen: true,
        });
        const fence = vi.spyOn(writerFs, "persistLocalWrites");
        const host = fakeHost();
        const stopped = waitForTermination(
            (shutdown) =>
                stopMountSession({
                    backend,
                    localOverlay,
                    persist: () =>
                        persistOnExit(
                            writerFs,
                            { persistOnExit: true, persistTimeoutMs: FENCE_MS },
                            shutdown
                        ),
                    stopPeerbit: () => stop(writer.peer),
                }),
            host as any,
            new PassThrough()
        );
        host.emit("SIGTERM");
        await within(stopped, "the writer stops", FENCE_MS + STEP_MS);

        expect(fence).not.toHaveBeenCalled();
        expect(persistLines(stderr())).toEqual([]);
        expect(process.exitCode ?? 0).toBe(0);
        await expect(fs.stat(localOverlay.directory)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("deletes an in-memory mount's overlay when the mount fails after opening it", async () => {
        const writer = await createPeer("writer", true);
        const writerFs = await open(writer.peer, "writer");
        const base = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-persist-failed-mount-")
        );
        directories.push(base);
        // Each overlay the mount printed, and whether it was there then.
        const printed: Array<{ directory: string; existed: boolean }> = [];
        vi.spyOn(console, "log").mockImplementation((...args) => {
            const line = args.join(" ");
            if (!line.startsWith("Local overlay: ")) return;
            const directory = line.slice("Local overlay: ".length);
            directories.push(directory);
            printed.push({ directory, existed: existsSync(directory) });
        });

        // `mount --directory ""` through the CLI, writable at once as this
        // block's joins are. Its adapter cannot start, so the mount fails
        // after it opened the overlay, and the failed start stops what it
        // set up.
        const adapter = path.join(base, "adapter-never-started");
        const failure = await within(
            runCli([
                "mount",
                writerFs.address,
                path.join(base, "not-mounted"),
                "--directory",
                "",
                "--peer",
                writer.peer.getMultiaddrs()[0].toString(),
                "--native-adapter",
                adapter,
                "--allow-partial-writes",
            ]).then(
                () => undefined,
                (error: unknown) => error
            ),
            "the mount fails at its adapter"
        );

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain(adapter);
        expect(printed).toEqual([
            { directory: expect.any(String), existed: true },
        ]);
        const [{ directory }] = printed;
        expect(path.dirname(directory)).toBe(path.resolve(os.tmpdir()));
        expect(path.basename(directory)).toMatch(
            /^peerbit-shared-fs-local-overlay-/
        );
        await expect(fs.stat(directory)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });
});

describe("peerbit-fs mount as a process", () => {
    const cliEntry = fileURLToPath(new URL("../bin.ts", import.meta.url));
    const cliDirectory = fileURLToPath(new URL("../../", import.meta.url));
    const libraryEsm = new URL(
        "../../node_modules/@peerbit/shared-fs/lib/esm/",
        import.meta.url
    );
    // Windows cannot spawn a script: the mount starts a .mjs adapter with node.
    // A timer that outlives the stop, as one libp2p's stop starts does (1 s):
    // mount exits once the stop is done, without waiting for it.
    const scriptAdapters = `data:text/javascript,${encodeURIComponent(`
        import childProcess from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";
        const spawn = childProcess.spawn;
        childProcess.spawn = (command, args, options) =>
            command.endsWith(".mjs")
                ? spawn(process.execPath, [command, ...args], options)
                : spawn(command, args, options);
        syncBuiltinESMExports();
        setTimeout(() => {}, 10 * 60_000);
    `)}`;
    // A stand-in for the native adapter, no FUSE: it writes through the
    // mount's IPC as an adapter does, leaves /open.txt open, then is ready.
    // As the adapter, it exits 0 on SIGINT (it unmounted), and its
    // --clear-dead-mount says what it was asked to clear or, with
    // STAND_IN_REFUSES_CLEAR set, refuses as at a mount it may not clear.
    const standInAdapter = `
        import { once } from "node:events";
        import { createConnection } from "node:net";
        const option = (name) => process.argv[process.argv.indexOf(name) + 1];
        if (process.argv.includes("--clear-dead-mount")) {
            if (process.env.STAND_IN_REFUSES_CLEAR) {
                process.stderr.write(option("--mountpoint") + " is not a mount this stand-in left\\n");
                process.exit(1);
            }
            process.stderr.write("stand-in adapter cleared " + option("--mountpoint") + "\\n");
            process.exit(0);
        }
        process.on("SIGINT", () => process.exit(0));
        const ipc = (name) => import(new URL(name, ${JSON.stringify(libraryEsm.href)}).href);
        const { BoundedIpcByteReader } = await ipc("ipc-byte-reader.js");
        const v2 = await ipc("ipc-v2.js");
        const endpoint = option("--endpoint");
        const tcp = endpoint.startsWith("tcp://") && new URL(endpoint);
        const socket = tcp
            ? createConnection({ host: tcp.hostname, port: Number(tcp.port) })
            : createConnection(endpoint);
        await once(socket, "connect");
        // Gone with the mount, also when the mount is killed.
        socket.on("error", () => {}).on("close", () => process.exit(0));
        const limit = 1 << 26;
        const reader = new BoundedIpcByteReader(socket, limit);
        socket.write(JSON.stringify({ id: 0, op: v2.SHARED_FS_IPC_NEGOTIATE_OP, args: [{
            protocol: v2.SHARED_FS_IPC_PROTOCOL, versions: [2], nonce: "stand-in",
            token: process.env.PEERBIT_SHARED_FS_IPC_TOKEN,
            maxRequestFrameBytes: limit, maxResponseFrameBytes: limit,
        }] }) + "\\n");
        const limits = JSON.parse(String(await reader.readLine())).result;
        let id = 1;
        const call = async (op, args, body = new Uint8Array(0)) => {
            await v2.writeIpcV2Frame(socket, v2.encodeIpcV2Frame(
                v2.IpcV2FrameKind.Request, { id: id++, op, args }, body,
                limits.maxRequestFrameBytes, limits.maxMetadataBytes));
            const frame = await v2.readIpcV2Frame(reader, v2.IpcV2FrameKind.Response,
                limits.maxResponseFrameBytes, limits.maxMetadataBytes);
            const response = JSON.parse(String(frame.metadata));
            if (!response.ok) throw new Error(op + ": " + response.error?.message);
            return response.result;
        };
        for (const name of ["/closed.txt", "/open.txt"]) {
            const flags = { write: true, create: true, truncate: true };
            const handle = await call("open", [name, flags]);
            const bytes = new TextEncoder().encode(name);
            await call("write", [handle, { $bytes: null }, 0], bytes);
            if (name === "/closed.txt") await call("release", [handle]);
        }
        process.stdout.write("stand-in adapter pid " + process.pid + "\\n");
        process.stderr.write("stand-in adapter " + process.pid + " serving\\n");
        process.stdout.write("peerbit-shared-fs-native ready\\n");
        setInterval(() => {}, 1 << 30);
    `;

    /**
     * Runs `test` against a mount process with the stand-in adapter, once
     * its receiver replica holds /closed.txt; then kills what is left. `env`
     * is added to the mount's environment, which its adapter inherits.
     */
    const withMountProcess = async (
        test: (mount: {
            child: ReturnType<typeof spawn>;
            errors: string[];
            exited: Promise<number | null>;
            receiver: SharedFsHandle;
            adapterPid: number;
            mountpoint: string;
        }) => Promise<void>,
        env: NodeJS.ProcessEnv = {}
    ) => {
        const base = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-mount-process-")
        );
        let receiverPeer: Peerbit | undefined;
        let child: ReturnType<typeof spawn> | undefined;
        let exited: Promise<number | null> = Promise.resolve(null);
        try {
            const log = vi.spyOn(console, "log").mockImplementation(() => {});
            await runCli(["create", "--directory", path.join(base, "writer")]);
            const address = String(log.mock.calls.at(-1)?.[0]);
            log.mockRestore();
            receiverPeer = await Peerbit.create({
                directory: path.join(base, "receiver"),
                libp2p: { addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] } },
            });
            const adapter = path.join(base, "adapter.mjs");
            await fs.writeFile(adapter, standInAdapter);
            await fs.mkdir(path.join(base, "mnt"));

            child = spawn(
                process.execPath,
                [
                    "--no-warnings",
                    "--import",
                    "tsx",
                    "--import",
                    scriptAdapters,
                    cliEntry,
                    "mount",
                    address,
                    path.join(base, "mnt"),
                    "--directory",
                    path.join(base, "writer"),
                    "--peer",
                    receiverPeer.getMultiaddrs()[0].toString(),
                    "--native-adapter",
                    adapter,
                    "--persist-timeout-ms",
                    String(STEP_MS),
                ],
                {
                    cwd: cliDirectory,
                    env: { ...process.env, FORCE_COLOR: "0", ...env },
                }
            );
            const output: string[] = [];
            const errors: string[] = [];
            let wake = () => {};
            for (const [stream, lines] of [
                [child.stdout!, output],
                [child.stderr!, errors],
            ] as const) {
                let rest = "";
                stream.on("data", (chunk) => {
                    const parts = (rest + chunk).split(/\r?\n/);
                    rest = parts.pop()!;
                    lines.push(...parts);
                    wake();
                });
            }
            let code: number | null | undefined;
            exited = new Promise((resolve) =>
                child!.once("exit", (value) => {
                    resolve((code = value));
                    wake();
                })
            );
            await within(
                (async () => {
                    while (!output.some((line) => line.startsWith("Mounted ")))
                        await new Promise<void>((resolve) => {
                            if (code !== undefined)
                                throw new Error(errors.join("\n"));
                            wake = resolve;
                        });
                })(),
                "the mount is up",
                FENCE_MS
            );

            // The receiver holds /closed.txt: the writer saw it join.
            const receiver = await within(
                (async () => {
                    const receiver = await openSharedFs({
                        peerbit: receiverPeer!,
                        address,
                        allowPartialWrites: true,
                        remoteChunkFetch: false,
                        machineLabel: "receiver",
                        replicate: { factor: 1 },
                        bootstrap: false,
                        gc: false,
                    });
                    await new Promise<void>((resolve) => {
                        const events = receiver.program.entries.events;
                        const check = async () => {
                            if (await receiver.readFile("/closed.txt")) {
                                events.removeEventListener("change", check);
                                resolve();
                            }
                        };
                        events.addEventListener("change", check);
                        void check();
                    });
                    return receiver;
                })(),
                "the receiver opens and holds /closed.txt"
            );
            const adapterPid = Number(
                output
                    .find((line) => line.startsWith("stand-in adapter pid "))
                    ?.slice("stand-in adapter pid ".length)
            );
            await test({
                child,
                errors,
                exited,
                receiver,
                adapterPid,
                mountpoint: path.join(base, "mnt"),
            });
        } finally {
            child?.kill("SIGKILL");
            await within(exited, "the mount is gone").catch(() => {});
            await receiverPeer?.stop();
            await fs.rm(base, {
                recursive: true,
                force: true,
                maxRetries: 10,
                retryDelay: 200,
            });
        }
    };

    const cleared = (line: string) =>
        line.startsWith("stand-in adapter cleared ");

    const fenced = [
        expect.stringMatching(
            /^persist-on-exit: waiting up to 20000 ms for receipts for \d+ entries$/
        ),
        expect.stringMatching(
            /^persist-on-exit: \d+ entries acknowledged in \d+ ms$/
        ),
    ];

    it("stops on a `shutdown` line on its stdin: saves the open file, waits for the replica, exits 0", () =>
        withMountProcess(async ({ child, errors, exited, receiver }) => {
            // As a supervisor on Windows asks; the pipe stays open.
            child.stdin!.write("shutdown\r\n");
            expect(
                await within(exited, "the mount exits", FENCE_MS),
                errors.join("\n")
            ).toBe(0);
            expect(persistLines(errors)).toEqual(fenced);
            // Drained at the stop and fenced: here with the writer gone.
            expect(text(await receiver.readFile("/open.txt"))).toBe(
                "/open.txt"
            );
            // The adapter unmounted: nothing to clear.
            expect(errors.filter(cleared)).toEqual([]);
        }));

    it("ends when its adapter is killed after readiness: reports it, saves the open file, waits for the replica, exits 70", () =>
        withMountProcess(
            async ({ errors, exited, receiver, adapterPid, mountpoint }) => {
                expect(adapterPid).toBeGreaterThan(0);
                const killed = performance.now();
                // kill -9 on POSIX, TerminateProcess on Windows.
                process.kill(adapterPid, "SIGKILL");
                expect(
                    await within(exited, "the mount exits", FENCE_MS),
                    errors.join("\n")
                ).toBe(70);
                // Reported only: the 2 s bound is the Linux smoke's.
                console.info(
                    `mount exited ${Math.round(performance.now() - killed)} ms after its adapter was killed`
                );
                expect(errors).toEqual(
                    expect.arrayContaining([
                        expect.stringMatching(
                            /^Native adapter exited after mount readiness: (code=null signal=SIGKILL|code=1 signal=null); stopping the mount \(exit status 70\)\.$/
                        ),
                        `native adapter stderr: stand-in adapter ${adapterPid} serving`,
                    ])
                );
                // The same stop as a shutdown request: drained and fenced.
                expect(persistLines(errors)).toEqual(fenced);
                expect(text(await receiver.readFile("/open.txt"))).toBe(
                    "/open.txt"
                );
                // It cleared the mount the adapter left, except on Windows,
                // where WinFsp removes the drive.
                expect(errors.filter(cleared)).toEqual(
                    process.platform === "win32"
                        ? []
                        : [`stand-in adapter cleared ${mountpoint}`]
                );
            }
        ));

    // Windows has no clear step: WinFsp removes the drive.
    it.skipIf(process.platform === "win32")(
        "exits 1 once its stop is done when it may not clear what its killed adapter left: every step runs, and only that error is printed",
        () =>
            withMountProcess(
                async ({
                    errors,
                    exited,
                    receiver,
                    adapterPid,
                    mountpoint,
                }) => {
                    process.kill(adapterPid, "SIGKILL");
                    // 1 is kept over 70. The mount process's 10-minute timer
                    // is not waited for.
                    expect(
                        await within(exited, "the mount exits", FENCE_MS),
                        errors.join("\n")
                    ).toBe(1);
                    expect(errors).toContainEqual(
                        expect.stringMatching(
                            /^Native adapter exited after mount readiness: .*\(exit status 70\)\.$/
                        )
                    );
                    // The steps after the failed one: drained and fenced.
                    expect(persistLines(errors)).toEqual(fenced);
                    expect(text(await receiver.readFile("/open.txt"))).toBe(
                        "/open.txt"
                    );
                    // No `mount` help and no stack trace: the error, once, on
                    // one line with the adapter's reason.
                    expect(
                        errors.filter((line) =>
                            /^(Positionals|Options):$|^\s+at /.test(line)
                        )
                    ).toEqual([]);
                    expect(
                        errors.filter((line) =>
                            line.includes("Could not clear")
                        )
                    ).toEqual([
                        `Could not clear ${mountpoint}, which the native adapter left disconnected: ${mountpoint} is not a mount this stand-in left`,
                    ]);
                },
                { STAND_IN_REFUSES_CLEAR: "1" }
            )
    );
});
