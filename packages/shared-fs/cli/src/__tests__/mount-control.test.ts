import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { Peerbit, encodePublicSignKey, openSharedFs } from "@peerbit/shared-fs";
import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { runCli } from "../index.js";
import {
    MOUNT_CONTROL_FILE,
    MOUNT_CONTROL_SOCKET_DIRECTORY,
    MountRunningError,
    callMountControl,
    readMountControl,
    runPowerShell,
    startMountControl,
    type MountControlPrint,
    type MountControlRecord,
} from "../mount-control.js";

/**
 * A running mount's control endpoint: the endpoint itself (its owner-only
 * socket or pipe, token and record), then `peerbit-fs mount` processes with
 * a stand-in native adapter (no FUSE) and peerbit-fs commands run in this
 * process against their state directory. Every wait resolves on an event
 * and only gives up at its deadline.
 */

/** Give-up bounds: a step, and a mount process's start or stop. */
const STEP_MS = 20_000;
const FENCE_MS = 30_000;

const windows = process.platform === "win32";
const CLI = "1.2.3-test";
const OUTPUT = { color: 0, stderr: { isTTY: false } } as const;

/** Rejects with `label` once `ms` pass; never resolves anything itself. */
const within = async <T>(promise: Promise<T>, label: string, ms = STEP_MS) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
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

const request = (command: string, argv: Record<string, unknown> = {}) => ({
    cli: CLI,
    command,
    argv,
    output: OUTPUT,
});

const ignore = () => {};

/** A state directory whose socket path fits a socket address. */
const stateDirectory = () => fsp.mkdtemp(path.join(os.tmpdir(), "pbfs-"));

const removeDirectory = (directory: string) =>
    fsp.rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
    });

/** The owner and permission bits of a file, a directory or a socket. */
const access = (file: string) => {
    const stat = fs.lstatSync(file);
    return { file, uid: stat.uid, mode: stat.mode & 0o777 };
};

/** The command's rejection, which must be a MountRunningError. */
const runningError = async (outcome: Promise<unknown>) => {
    const error = await outcome.then(
        () => undefined,
        (error: unknown) => error
    );
    expect(error).toBeInstanceOf(MountRunningError);
    return (error as Error).message;
};

/** The JSON lines a raw request line is answered with. */
const exchange = (endpoint: string, line: string) =>
    new Promise<unknown[]>((resolve, reject) => {
        let text = "";
        const socket = net.createConnection(endpoint, () => socket.write(line));
        socket
            .setEncoding("utf8")
            .on("data", (chunk: string) => (text += chunk))
            .on("error", reject)
            .on("close", () =>
                resolve(
                    text
                        .split("\n")
                        .filter(Boolean)
                        .map((answer) => JSON.parse(answer))
                )
            );
    });

/**
 * The named pipe's DACL as Windows PowerShell reads it: whether it is
 * protected from inheritance, each access rule, and the current user.
 */
const PIPE_DACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$rights = [System.IO.Pipes.PipeAccessRights]'ReadData, ReadPermissions'
$pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', $env:PEERBIT_FS_TEST_PIPE, $rights, [System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::None, [System.IO.HandleInheritability]::None)
$pipe.Connect(10000)
try {
    $security = $pipe.GetAccessControl()
    [Console]::Out.WriteLine('protected ' + $security.AreAccessRulesProtected)
    foreach ($rule in $security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        [Console]::Out.WriteLine('rule ' + $rule.IdentityReference.Value + ' ' + $rule.AccessControlType)
    }
    [Console]::Out.WriteLine('user ' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
} finally {
    $pipe.Dispose()
}
`;

/**
 * Checks that only this user can reach the endpoint: on POSIX a socket of
 * this user's, mode 0600, in a directory of this user's, mode 0700 (other
 * users can neither enter it nor connect), and a 0600 record; on Windows a
 * named pipe whose DACL, protected from inheritance, admits only this user.
 */
const expectOwnerOnly = async (directory: string, endpoint: string) => {
    if (windows) {
        expect(endpoint).toMatch(
            /^\\\\\.\\pipe\\peerbit-fs-control-[0-9a-f]{32}$/
        );
        const lines = (
            await runPowerShell(PIPE_DACL_SCRIPT, {
                PEERBIT_FS_TEST_PIPE: endpoint.slice("\\\\.\\pipe\\".length),
            })
        )
            .split(/\r?\n/)
            .filter(Boolean);
        const user = lines.find((line) => line.startsWith("user "))!.slice(5);
        expect(lines).toEqual([
            "protected True",
            `rule ${user} Allow`,
            `user ${user}`,
        ]);
        return;
    }
    const uid = process.getuid!();
    expect(fs.lstatSync(endpoint).isSocket()).toBe(true);
    expect([
        access(path.join(directory, MOUNT_CONTROL_FILE)),
        access(path.dirname(endpoint)),
        access(endpoint),
    ]).toEqual([
        { file: path.join(directory, MOUNT_CONTROL_FILE), uid, mode: 0o600 },
        { file: path.dirname(endpoint), uid, mode: 0o700 },
        { file: endpoint, uid, mode: 0o600 },
    ]);
};

describe("mount control endpoint", () => {
    it("serves a command on an owner-only endpoint with a token from an owner-only record, and removes both when it closes", async () => {
        const directory = await stateDirectory();
        const requests: unknown[] = [];
        const control = await startMountControl({
            directory,
            cliVersion: CLI,
            handle: async (request, print) => {
                requests.push(request);
                print({ type: "console", method: "log", text: "first" });
                print({ type: "stderr", text: "progress\n" });
                print({ type: "console", method: "warn", text: "100%s" });
                return 3;
            },
        });
        try {
            const record = readMountControl(directory)!;
            expect(record).toEqual({
                protocol: 1,
                pid: process.pid,
                endpoint: control.endpoint,
                token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
            });
            if (!windows) {
                expect(control.endpoint).toBe(
                    path.join(
                        directory,
                        MOUNT_CONTROL_SOCKET_DIRECTORY,
                        "socket"
                    )
                );
            }
            await expectOwnerOnly(directory, control.endpoint!);

            const printed: MountControlPrint[] = [];
            expect(
                await callMountControl(
                    record,
                    request("status", { address: "an-address" }),
                    (message) => printed.push(message)
                )
            ).toEqual({ reached: true, exitCode: 3 });
            expect(printed).toEqual([
                { type: "console", method: "log", text: "first" },
                { type: "stderr", text: "progress\n" },
                { type: "console", method: "warn", text: "100%s" },
            ]);
            expect(requests).toEqual([
                {
                    command: "status",
                    argv: { address: "an-address" },
                    output: OUTPUT,
                },
            ]);

            await control.close();
            expect(
                fs.existsSync(path.join(directory, MOUNT_CONTROL_FILE))
            ).toBe(false);
            if (!windows) {
                expect(fs.existsSync(path.dirname(control.endpoint!))).toBe(
                    false
                );
            }
            expect(
                await callMountControl(record, request("status"), ignore)
            ).toEqual({ reached: false, reason: "ENOENT" });
        } finally {
            await control.close();
            await removeDirectory(directory);
        }
    });

    it("refuses a wrong token, another CLI version, another control protocol and a request that is not JSON, without running it", async () => {
        const directory = await stateDirectory();
        const handle = vi.fn(async () => 0);
        const control = await startMountControl({
            directory,
            cliVersion: CLI,
            handle,
        });
        try {
            const record = readMountControl(directory)!;
            const refused = (command: string, reason: string) =>
                `a mount is running for this directory (pid ${process.pid}); it refused peerbit-fs ${command}: ${reason}`;
            const token = record.token!;
            // The same length with one character changed, empty, and long.
            for (const wrong of [
                `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`,
                "",
                token.repeat(100),
            ]) {
                expect(
                    await runningError(
                        callMountControl(
                            { ...record, token: wrong },
                            request("status"),
                            ignore
                        )
                    )
                ).toBe(
                    refused(
                        "status",
                        "the token does not match the one in mount-control.json"
                    )
                );
            }
            expect(
                await runningError(
                    callMountControl(
                        record,
                        { ...request("trust"), cli: "0.0.1" },
                        ignore
                    )
                )
            ).toBe(
                refused(
                    "trust",
                    `it runs peerbit-fs ${CLI} and this is 0.0.1: run that version, or restart the mount`
                )
            );
            expect(
                await exchange(
                    control.endpoint!,
                    `${JSON.stringify({ ...request("status"), protocol: 2, token })}\n`
                )
            ).toEqual([
                {
                    type: "refused",
                    reason: "it speaks control protocol 1, not 2",
                },
            ]);
            expect(await exchange(control.endpoint!, "status\n")).toEqual([
                { type: "refused", reason: "the request is not JSON" },
            ]);
            expect(handle).not.toHaveBeenCalled();
        } finally {
            await control.close();
            await removeDirectory(directory);
        }
    });

    it("runs a command beside a slow one, refuses commands once its mount stops, and cuts off one under way, aborting it", async () => {
        const directory = await stateDirectory();
        let started!: () => void;
        const running = new Promise<void>((resolve) => (started = resolve));
        let aborted: unknown;
        const control = await startMountControl({
            directory,
            cliVersion: CLI,
            // gc runs until its client goes away; status answers at once.
            handle: (request, _print, signal) =>
                request.command !== "gc"
                    ? Promise.resolve(7)
                    : new Promise((resolve) => {
                          signal.addEventListener("abort", () => {
                              aborted = signal.reason;
                              resolve(0);
                          });
                          started();
                      }),
        });
        try {
            const record = readMountControl(directory)!;
            const cutOff = runningError(
                callMountControl(record, request("gc"), ignore)
            );
            await within(running, "the command runs");
            expect(
                await within(
                    callMountControl(record, request("status"), ignore),
                    "a command beside it"
                )
            ).toEqual({ reached: true, exitCode: 7 });
            control.stopServing();
            expect(
                await within(cutOff, "the client hears it was cut off")
            ).toBe(
                `a mount is running for this directory (pid ${process.pid}); its control endpoint closed before peerbit-fs gc finished`
            );
            expect(aborted).toEqual(new Error("the control connection closed"));
            expect(
                await runningError(
                    callMountControl(record, request("status"), ignore)
                )
            ).toBe(
                `a mount is running for this directory (pid ${process.pid}); it refused peerbit-fs status: it is stopping`
            );
        } finally {
            await control.close();
            await removeDirectory(directory);
        }
    });

    it.skipIf(windows)(
        "puts the socket of a state directory whose path does not fit a socket address in an owner-only directory under /tmp, and removes it",
        async () => {
            const base = await stateDirectory();
            const directory = path.join(base, "d".repeat(120));
            await fsp.mkdir(directory);
            const control = await startMountControl({
                directory,
                cliVersion: CLI,
                handle: async () => 0,
            });
            try {
                const socketDirectory = path.dirname(control.endpoint!);
                expect(socketDirectory).toMatch(/^\/tmp\/pbfs-ctl-[^/]+$/);
                expect(
                    fs.existsSync(
                        path.join(directory, MOUNT_CONTROL_SOCKET_DIRECTORY)
                    )
                ).toBe(false);
                await expectOwnerOnly(directory, control.endpoint!);
                expect(
                    await callMountControl(
                        readMountControl(directory)!,
                        request("status"),
                        ignore
                    )
                ).toEqual({ reached: true, exitCode: 0 });
                await control.close();
                expect(fs.existsSync(socketDirectory)).toBe(false);
            } finally {
                await control.close();
                await removeDirectory(base);
            }
        }
    );

    it.skipIf(windows)(
        "does not connect to a socket in a directory another user could enter, nor read a record others could read or that is a link",
        async () => {
            const base = await stateDirectory();
            const server = net.createServer();
            const connections = vi.fn();
            server.on("connection", connections);
            try {
                const open = path.join(base, "open");
                await fsp.mkdir(open);
                await fsp.chmod(open, 0o755);
                const endpoint = path.join(open, "socket");
                await new Promise<void>((resolve) =>
                    server.listen(endpoint, resolve)
                );
                expect(
                    await callMountControl(
                        {
                            protocol: 1,
                            pid: process.pid,
                            endpoint,
                            token: "a-token",
                        },
                        request("status"),
                        ignore
                    )
                ).toEqual({
                    reached: false,
                    reason: "its socket's directory is not this user's own",
                });
                expect(connections).not.toHaveBeenCalled();

                const record: MountControlRecord = {
                    protocol: 1,
                    pid: process.pid,
                    endpoint,
                    token: "a-token",
                };
                const file = path.join(base, MOUNT_CONTROL_FILE);
                await fsp.writeFile(file, JSON.stringify(record));
                await fsp.chmod(file, 0o644);
                expect(readMountControl(base)).toBeUndefined();
                await fsp.chmod(file, 0o600);
                expect(readMountControl(base)).toEqual(record);
                const linked = path.join(base, "linked");
                await fsp.mkdir(linked);
                await fsp.symlink(file, path.join(linked, MOUNT_CONTROL_FILE));
                expect(readMountControl(linked)).toBeUndefined();
            } finally {
                await new Promise((resolve) => server.close(resolve));
                await removeDirectory(base);
            }
        }
    );

    describe("in a process that ends", () => {
        const cliDirectory = fileURLToPath(new URL("../../", import.meta.url));
        const controlModule = new URL("../mount-control.ts", import.meta.url);
        // Serves on the state directory it is given, says where, and exits
        // (process.exit, no close()) on an `exit` line.
        const holder = `
            const { startMountControl } = await import(${JSON.stringify(controlModule.href)});
            const control = await startMountControl({
                directory: process.argv[2],
                cliVersion: "holder",
                handle: async () => 0,
            });
            process.stdout.write("serving " + control.endpoint + "\\n");
            process.stdin.on("data", (data) => {
                if (String(data).includes("exit")) process.exit(0);
            });
        `;

        /** Starts a holder on `directory`; resolves with it once it serves. */
        const startHolder = async (directory: string, script: string) => {
            const child = spawn(
                process.execPath,
                ["--no-warnings", "--import", "tsx", script, directory],
                { cwd: cliDirectory }
            );
            const exited = new Promise<number | null>((resolve) =>
                child.once("exit", resolve)
            );
            let errors = "";
            child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
                errors += chunk;
            });
            const endpoint = await within(
                new Promise<string>((resolve, reject) => {
                    let text = "";
                    child.stdout!.setEncoding("utf8").on("data", (chunk) => {
                        text += chunk;
                        const line = /^serving (.*)\r?\n/m.exec(text);
                        if (line) resolve(line[1]);
                    });
                    void exited.then((code) =>
                        reject(
                            new Error(`the holder exited ${code}: ${errors}`)
                        )
                    );
                }),
                "the holder serves"
            );
            return { child, exited, endpoint };
        };

        it("removes its socket and record when its process exits without closing it", async () => {
            const base = await stateDirectory();
            const script = path.join(base, "holder.mjs");
            await fsp.writeFile(script, holder);
            const directory = path.join(base, "state");
            await fsp.mkdir(directory);
            try {
                const { child, exited, endpoint } = await startHolder(
                    directory,
                    script
                );
                expect(readMountControl(directory)?.pid).toBe(child.pid);
                child.stdin!.write("exit\n");
                expect(await within(exited, "the holder exits")).toBe(0);
                expect(
                    fs.existsSync(path.join(directory, MOUNT_CONTROL_FILE))
                ).toBe(false);
                if (!windows) {
                    expect(fs.existsSync(path.dirname(endpoint))).toBe(false);
                }
            } finally {
                await removeDirectory(base);
            }
        });

        // A short state directory keeps its socket; a long one's is under /tmp.
        for (const long of windows ? [false] : [false, true]) {
            it(`never lets what a killed one left block the next${long ? ", also its socket directory under /tmp" : ""}`, async () => {
                const base = await stateDirectory();
                const script = path.join(base, "holder.mjs");
                await fsp.writeFile(script, holder);
                const directory = path.join(
                    base,
                    long ? "d".repeat(120) : "state"
                );
                await fsp.mkdir(directory);
                let control: Awaited<ReturnType<typeof startMountControl>>;
                let killedEndpoint: string | undefined;
                try {
                    const killed = await startHolder(directory, script);
                    killedEndpoint = killed.endpoint;
                    killed.child.kill("SIGKILL");
                    await within(killed.exited, "the holder is killed");
                    // Left behind: no exit handler runs on SIGKILL.
                    const stale = readMountControl(directory)!;
                    expect(stale.pid).toBe(killed.child.pid);
                    expect(stale.endpoint).toBe(killed.endpoint);
                    if (!windows) {
                        expect(fs.lstatSync(killed.endpoint).isSocket()).toBe(
                            true
                        );
                    }
                    expect(
                        await callMountControl(stale, request("status"), ignore)
                    ).toEqual({
                        reached: false,
                        reason: windows ? "ENOENT" : "ECONNREFUSED",
                    });

                    control = await startMountControl({
                        directory,
                        cliVersion: CLI,
                        handle: async () => 5,
                    });
                    try {
                        const record = readMountControl(directory)!;
                        expect(record.pid).toBe(process.pid);
                        expect(record.token).not.toBe(stale.token);
                        expect(
                            await callMountControl(
                                record,
                                request("status"),
                                ignore
                            )
                        ).toEqual({ reached: true, exitCode: 5 });
                        if (long) {
                            expect(
                                fs.existsSync(path.dirname(killed.endpoint))
                            ).toBe(false);
                        }
                        await expectOwnerOnly(directory, control.endpoint!);
                    } finally {
                        await control.close();
                    }
                } finally {
                    // Under /tmp: left behind only when the next did not
                    // remove it.
                    if (long && killedEndpoint !== undefined) {
                        await removeDirectory(path.dirname(killedEndpoint));
                    }
                    await removeDirectory(base);
                }
            });
        }
    });
});

/** Stops a peer as index.test.ts does: its block store too. */
const stopPeer = async (peer: Peerbit) => {
    await peer.stop();
    await peer.services.blocks.stop();
};

/**
 * Counts the Peerbits this process creates, and keeps those off the public
 * bootstrap network: a command run on its own state directory connects.
 */
const countPeerbits = () => {
    const create = Peerbit.create.bind(Peerbit);
    return vi.spyOn(Peerbit, "create").mockImplementation(async (options) => {
        const peer = await create(options);
        vi.spyOn(peer, "bootstrap").mockResolvedValue({
            connectedPeerIds: [],
            failures: [],
        });
        return peer;
    });
};

type Printed = { method: "log" | "warn" | "error"; text: string };

/** What Peerbit itself may print around any command: not the command's. */
const PEERBIT_NOTICE =
    /^(Peer shutdown |Peerbit emitted a known |Peerbit fanout bootstrap )/;

/** Runs a peerbit-fs command in this process: what it printed, and its exit code. */
const run = async (...args: string[]) => {
    const printed: Printed[] = [];
    const spies = (["log", "warn", "error"] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation((...values) => {
            const text = stripVTControlCharacters(values.map(String).join(" "));
            if (!PEERBIT_NOTICE.test(text)) printed.push({ method, text });
        })
    );
    const saved = process.exitCode;
    process.exitCode = undefined;
    try {
        await runCli(args);
        return { printed, exitCode: Number(process.exitCode ?? 0) };
    } finally {
        for (const spy of spies) spy.mockRestore();
        process.exitCode = saved;
    }
};

/** The one line a command printed, parsed. */
const json = (result: { printed: Printed[] }) => {
    expect(result.printed.map(({ method }) => method)).toEqual(["log"]);
    return JSON.parse(result.printed[0].text);
};

describe("peerbit-fs commands for a directory a running mount holds", () => {
    const cliEntry = fileURLToPath(new URL("../bin.ts", import.meta.url));
    const cliDirectory = fileURLToPath(new URL("../../", import.meta.url));
    const libraryEsm = new URL(
        "../../node_modules/@peerbit/shared-fs/lib/esm/",
        import.meta.url
    );
    // Windows cannot spawn a script: the mount starts a .mjs adapter with node.
    const scriptAdapters = `data:text/javascript,${encodeURIComponent(`
        import childProcess from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";
        const spawn = childProcess.spawn;
        childProcess.spawn = (command, args, options) =>
            command.endsWith(".mjs")
                ? spawn(process.execPath, [command, ...args], options)
                : spawn(command, args, options);
        syncBuiltinESMExports();
    `)}`;
    // A stand-in for the native adapter, no FUSE: it joins the mount's IPC,
    // says its pid and that it is ready, and is gone with the mount. As the
    // adapter, it exits 0 on SIGINT (it unmounted), and clears what it left.
    const standInAdapter = `
        import { once } from "node:events";
        import { createConnection } from "node:net";
        const option = (name) => process.argv[process.argv.indexOf(name) + 1];
        if (process.argv.includes("--clear-dead-mount")) {
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
        socket.on("error", () => {}).on("close", () => process.exit(0));
        const limit = 1 << 26;
        const reader = new BoundedIpcByteReader(socket, limit);
        socket.write(JSON.stringify({ id: 0, op: v2.SHARED_FS_IPC_NEGOTIATE_OP, args: [{
            protocol: v2.SHARED_FS_IPC_PROTOCOL, versions: [2], nonce: "stand-in",
            token: process.env.PEERBIT_SHARED_FS_IPC_TOKEN,
            maxRequestFrameBytes: limit, maxResponseFrameBytes: limit,
        }] }) + "\\n");
        await reader.readLine();
        process.stdout.write("stand-in adapter pid " + process.pid + "\\n");
        process.stdout.write("peerbit-shared-fs-native ready\\n");
        setInterval(() => {}, 1 << 30);
    `;

    type MountProcess = {
        child: ChildProcess;
        output: string[];
        errors: string[];
        exited: Promise<number | null>;
        /** The first line of `lines` that matches, once there is one. */
        line(
            lines: string[],
            match: (line: string) => boolean,
            label: string
        ): Promise<string>;
    };

    /** A machine: a state directory, a peer for --peer and the adapter. */
    type Machine = {
        base: string;
        directory: string;
        address: string;
        peer: Peerbit;
        mounts: MountProcess[];
    };

    const createMachine = async (): Promise<Machine> => {
        const base = await fsp.mkdtemp(path.join(os.tmpdir(), "pbfs-mc-"));
        const directory = path.join(base, "state");
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        let address: string;
        try {
            await runCli(["create", "--directory", directory]);
            address = String(log.mock.calls.at(-1)?.[0]);
        } finally {
            log.mockRestore();
        }
        await fsp.writeFile(path.join(base, "adapter.mjs"), standInAdapter);
        await fsp.mkdir(path.join(base, "mnt"));
        const peer = await Peerbit.create({
            libp2p: { addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] } },
        });
        return { base, directory, address, peer, mounts: [] };
    };

    /** `peerbit-fs mount` of the machine's filesystem, with `args` added. */
    const startMount = (machine: Machine, ...args: string[]) => {
        const child = spawn(
            process.execPath,
            [
                "--no-warnings",
                "--import",
                "tsx",
                "--import",
                scriptAdapters,
                cliEntry,
                "mount",
                machine.address,
                path.join(machine.base, "mnt"),
                "--directory",
                machine.directory,
                "--peer",
                machine.peer.getMultiaddrs()[0].toString(),
                "--native-adapter",
                path.join(machine.base, "adapter.mjs"),
                ...args,
            ],
            { cwd: cliDirectory, env: { ...process.env, FORCE_COLOR: "0" } }
        );
        const output: string[] = [];
        const errors: string[] = [];
        const waiters = new Set<() => void>();
        const wake = () => waiters.forEach((waiter) => waiter());
        for (const [stream, lines] of [
            [child.stdout!, output],
            [child.stderr!, errors],
        ] as const) {
            let rest = "";
            stream.setEncoding("utf8").on("data", (chunk: string) => {
                const parts = (rest + chunk).split(/\r?\n/);
                rest = parts.pop()!;
                lines.push(...parts);
                wake();
            });
        }
        let code: number | null | undefined;
        const exited = new Promise<number | null>((resolve) =>
            child.once("exit", (value) => {
                code = value;
                resolve(value);
                wake();
            })
        );
        const mount: MountProcess = {
            child,
            output,
            errors,
            exited,
            line: (lines, match, label) => {
                let check = () => {};
                return within(
                    new Promise<string>((resolve, reject) => {
                        check = () => {
                            const found = lines.find(match);
                            if (found !== undefined) resolve(found);
                            else if (code !== undefined)
                                reject(
                                    new Error(
                                        `${label}: the mount exited ${code}\n${errors.join("\n")}`
                                    )
                                );
                        };
                        waiters.add(check);
                        check();
                    }),
                    label,
                    FENCE_MS
                ).finally(() => waiters.delete(check));
            },
        };
        machine.mounts.push(mount);
        return mount;
    };

    /** Starts a mount; resolves with its control endpoint once it serves. */
    const serving = async (mount: MountProcess) => {
        // A mount prints its control endpoint before its gc schedule, the
        // last line of its start.
        await mount.line(
            mount.output,
            (line) => line.startsWith("gc schedule: "),
            "the mount is up"
        );
        const line = mount.output.find((line) =>
            line.startsWith("Control endpoint: ")
        );
        expect(line, mount.errors.join("\n")).toBeDefined();
        return line!.slice("Control endpoint: ".length);
    };

    /** Kills the machine's mounts that still run. */
    const killMounts = async (machine: Machine) => {
        for (const mount of machine.mounts) {
            mount.child.kill("SIGKILL");
            await within(mount.exited, "the mount is gone").catch(ignore);
        }
    };

    const stopMachine = async (machine: Machine) => {
        await killMounts(machine);
        await machine.peer.stop();
        await removeDirectory(machine.base);
    };

    /** Nothing of a control endpoint is left in the state directory. */
    const expectNoEndpoint = (directory: string, endpoint: string) => {
        expect(fs.existsSync(path.join(directory, MOUNT_CONTROL_FILE))).toBe(
            false
        );
        if (!windows) {
            expect(fs.existsSync(path.dirname(endpoint))).toBe(false);
        }
    };

    describe("while it runs", () => {
        let machine: Machine;
        let mount: MountProcess;
        let endpoint: string;
        let seeded: { left: string; right: string };
        /** The commands' outcomes on the stopped directory, before the mount. */
        const stopped: Record<string, unknown> = {};

        /** A command's outcome: what it printed and exited with, or threw. */
        const outcome = (...args: string[]) =>
            run(...args, "--directory", machine.directory).then(
                (result) => result,
                (error: Error) => ({ threw: error.message })
            );

        /** What each command prints: the gate, the listing, a refusal. */
        const commands = () => ({
            gate: ["conflicts", machine.address, "--fail-if-any"],
            listing: ["conflicts", machine.address, "--json"],
            naming: ["naming-conflicts", machine.address],
            wrongHead: [
                "resolve-conflict",
                machine.address,
                "/content.txt",
                "version:not-a-head",
            ],
        });

        beforeAll(async () => {
            machine = await createMachine();
            // A content conflict, written as the filesystem's creator.
            const peer = await Peerbit.create({ directory: machine.directory });
            try {
                const shared = await openSharedFs({
                    peerbit: peer,
                    address: machine.address,
                    machineLabel: "seed",
                    replicate: { factor: 1 },
                    bootstrap: false,
                    gc: false,
                });
                await shared.awaitWriteReady({ timeout: STEP_MS });
                await shared.writeFile("/content.txt", "base");
                const baseVersionIds = (await shared.versions("/content.txt"))
                    .filter((version) => version.head)
                    .map((version) => version.id);
                const left = await shared.writeFile("/content.txt", "left", {
                    baseVersionIds,
                });
                const right = await shared.writeFile("/content.txt", "right", {
                    baseVersionIds,
                });
                seeded = { left: left.id, right: right.id };
            } finally {
                await stopPeer(peer);
            }
            const created = countPeerbits();
            try {
                for (const [name, args] of Object.entries(commands())) {
                    stopped[name] = await outcome(...args);
                }
            } finally {
                created.mockRestore();
            }
            mount = startMount(machine);
            endpoint = await serving(mount);
        });

        afterAll(async () => {
            if (machine) await stopMachine(machine);
        });

        it("runs status --json, conflicts --fail-if-any, trust and resolve-conflict on the mount's filesystem, printing and exiting as on the stopped directory, without a Peerbit of their own", async () => {
            expect(readMountControl(machine.directory)).toEqual({
                protocol: 1,
                pid: mount.child.pid,
                endpoint,
                token: expect.any(String),
            });
            await expectOwnerOnly(machine.directory, endpoint);
            const created = countPeerbits();
            try {
                const status = await outcome(
                    "status",
                    machine.address,
                    "--json"
                );
                expect(status).toMatchObject({ exitCode: 0 });
                const report = json(status as Awaited<ReturnType<typeof run>>);
                expect(report.filesystem).toMatchObject({
                    address: machine.address,
                    accessControlled: true,
                    rootEntries: 1,
                    bootstrap: { writeReady: true },
                });
                // Read where the command runs, as without a mount.
                expect(report.nativeMount).toEqual(
                    json(await run("status", "--json")).nativeMount
                );

                for (const [name, args] of Object.entries(commands())) {
                    expect({ [name]: await outcome(...args) }).toEqual({
                        [name]: stopped[name],
                    });
                }
                expect(stopped.gate).toMatchObject({ exitCode: 3 });
                const gate = stopped.gate as Awaited<ReturnType<typeof run>>;
                expect(gate.printed).toContainEqual({
                    method: "log",
                    text: "/content.txt",
                });
                const listed = gate.printed.map(({ text }) => text).join("\n");
                expect(listed).toContain(seeded.left);
                expect(listed).toContain(seeded.right);
                expect(
                    json(stopped.listing as Awaited<ReturnType<typeof run>>)
                        .conflicts
                ).toEqual([expect.objectContaining({ path: "/content.txt" })]);
                expect(stopped.wrongHead).toEqual({
                    threw: "Version version:not-a-head is not a current conflict head for /content.txt; rerun peerbit-fs conflicts before retrying",
                });

                expect(
                    await outcome(
                        "trust",
                        machine.address,
                        encodePublicSignKey(machine.peer.identity.publicKey)
                    )
                ).toEqual({
                    printed: [{ method: "log", text: "Writer trusted" }],
                    exitCode: 0,
                });
                const resolved = await outcome(
                    "resolve-conflict",
                    machine.address,
                    "/content.txt",
                    seeded.left
                );
                expect(resolved).toMatchObject({ exitCode: 0 });
                expect(
                    (resolved as Awaited<ReturnType<typeof run>>).printed.slice(
                        0,
                        2
                    )
                ).toEqual([
                    {
                        method: "log",
                        text: "Published content resolution for /content.txt",
                    },
                    { method: "log", text: `selected version: ${seeded.left}` },
                ]);

                expect(created).not.toHaveBeenCalled();
            } finally {
                created.mockRestore();
            }
        });

        it("names the mount instead of failing on the lock: for a command it does not run, another filesystem, a wrong token, an endpoint that does not answer", async () => {
            const running = `a mount is running for this directory (pid ${mount.child.pid});`;
            const failed = (text: string) => ({
                printed: [{ method: "error", text: `${running} ${text}` }],
                exitCode: 1,
            });
            const created = countPeerbits();
            const file = path.join(machine.directory, MOUNT_CONTROL_FILE);
            const original = await fsp.readFile(file, "utf8");
            const rewrite = (changes: Partial<MountControlRecord>) =>
                fsp.writeFile(
                    file,
                    JSON.stringify({ ...JSON.parse(original), ...changes })
                );
            try {
                expect(await outcome("whoami")).toEqual(
                    failed(
                        "peerbit-fs whoami does not run through it: stop the mount first"
                    )
                );
                // whoami found the directory locked.
                expect(created).toHaveBeenCalledTimes(1);

                expect(
                    await outcome(
                        "status",
                        "zb2rhOtherFilesystemAddress",
                        "--json"
                    )
                ).toEqual(
                    failed(
                        `it refused peerbit-fs status: it serves ${machine.address}, not zb2rhOtherFilesystemAddress`
                    )
                );

                await rewrite({ token: "not-the-token" });
                expect(await outcome("conflicts", machine.address)).toEqual(
                    failed(
                        "it refused peerbit-fs conflicts: the token does not match the one in mount-control.json"
                    )
                );

                const gone = path.join(machine.base, "gone");
                await fsp.mkdir(gone, { mode: 0o700 });
                await rewrite({
                    endpoint: windows
                        ? "\\\\.\\pipe\\peerbit-fs-control-gone"
                        : path.join(gone, "socket"),
                });
                expect(
                    await outcome("status", machine.address, "--json")
                ).toEqual(
                    failed(
                        "peerbit-fs status could not reach it (ENOENT): stop the mount to run the command here"
                    )
                );
                // Only the commands that could not go through the mount
                // tried the directory.
                expect(created).toHaveBeenCalledTimes(2);
            } finally {
                created.mockRestore();
                await fsp.writeFile(file, original);
            }
        });

        it("goes away when the mount stops, which leaves what the commands changed", async () => {
            mount.child.stdin!.write("shutdown\n");
            expect(
                await within(mount.exited, "the mount exits", FENCE_MS),
                mount.errors.join("\n")
            ).toBe(0);
            expectNoEndpoint(machine.directory, endpoint);

            // The conflict the mount resolved: none is left, in a view this
            // creator's directory cannot verify complete.
            const created = countPeerbits();
            try {
                const gate = await outcome(
                    "conflicts",
                    machine.address,
                    "--fail-if-any"
                );
                expect(gate).toMatchObject({ exitCode: 4 });
                expect(
                    (gate as Awaited<ReturnType<typeof run>>).printed
                ).toContainEqual({ method: "log", text: "No conflicts" });
                expect(created).toHaveBeenCalledTimes(1);
            } finally {
                created.mockRestore();
            }
            // The writer trusted through the mount is trusted here too.
            const peer = await Peerbit.create({ directory: machine.directory });
            try {
                const shared = await openSharedFs({
                    peerbit: peer,
                    address: machine.address,
                    machineLabel: "check",
                    replicate: { factor: 1 },
                    bootstrap: false,
                    gc: false,
                });
                expect(
                    await shared.isTrustedWriter(
                        machine.peer.identity.publicKey
                    )
                ).toBe(true);
            } finally {
                await stopPeer(peer);
            }
        });
    });

    describe("when it ends otherwise", () => {
        let machine: Machine | undefined;

        // A test that failed leaves no mount to hold the directory.
        afterEach(async () => {
            if (machine) await killMounts(machine);
        });

        afterAll(async () => {
            if (machine) await stopMachine(machine);
        });

        it("goes away when the mount ends because its adapter was killed (exit 70)", async () => {
            machine = await createMachine();
            const mount = startMount(machine);
            const endpoint = await serving(mount);
            expect(readMountControl(machine.directory)?.pid).toBe(
                mount.child.pid
            );
            const adapterPid = Number(
                (
                    await mount.line(
                        mount.output,
                        (line) => line.startsWith("stand-in adapter pid "),
                        "the adapter says its pid"
                    )
                ).slice("stand-in adapter pid ".length)
            );
            process.kill(adapterPid, "SIGKILL");
            expect(
                await within(mount.exited, "the mount exits", FENCE_MS),
                mount.errors.join("\n")
            ).toBe(70);
            expectNoEndpoint(machine.directory, endpoint);
        });

        it("never lets a killed mount's endpoint stop a command or the next mount, which replaces it", async () => {
            const killed = startMount(machine!);
            const staleEndpoint = await serving(killed);
            killed.child.kill("SIGKILL");
            await within(killed.exited, "the killed mount is gone");
            const stale = readMountControl(machine!.directory)!;
            expect(stale.pid).toBe(killed.child.pid);

            // The directory is free: the command runs on it as always.
            const created = countPeerbits();
            try {
                const status = await run(
                    "status",
                    machine!.address,
                    "--json",
                    "--directory",
                    machine!.directory
                );
                expect(status.exitCode).toBe(0);
                expect(json(status).filesystem.address).toBe(machine!.address);
                expect(created).toHaveBeenCalledTimes(1);
            } finally {
                created.mockRestore();
            }

            const next = startMount(machine!);
            const endpoint = await serving(next);
            const record = readMountControl(machine!.directory)!;
            expect(record.pid).toBe(next.child.pid);
            expect(record.token).not.toBe(stale.token);
            if (!windows && endpoint !== staleEndpoint) {
                expect(fs.existsSync(path.dirname(staleEndpoint))).toBe(false);
            }
            const through = countPeerbits();
            try {
                expect(
                    json(
                        await run(
                            "status",
                            machine!.address,
                            "--json",
                            "--directory",
                            machine!.directory
                        )
                    ).filesystem.address
                ).toBe(machine!.address);
                expect(through).not.toHaveBeenCalled();
            } finally {
                through.mockRestore();
            }
            next.child.stdin!.write("shutdown\n");
            expect(
                await within(next.exited, "the next mount exits", FENCE_MS),
                next.errors.join("\n")
            ).toBe(0);
            expectNoEndpoint(machine!.directory, endpoint);
        });

        it("removes what a mount that was killed left, and its own, when it fails to start", async () => {
            // What a killed mount leaves: its record, naming a pid that has
            // exited, and on POSIX its socket directories (a named pipe goes
            // with its process).
            const exited = spawn(process.execPath, ["-e", ""]);
            await within(
                new Promise((resolve) => exited.once("exit", resolve)),
                "a process exits"
            );
            const socketDirectory = path.join(
                machine!.directory,
                MOUNT_CONTROL_SOCKET_DIRECTORY
            );
            const staleTmp = windows
                ? undefined
                : fs.mkdtempSync("/tmp/pbfs-ctl-");
            try {
                if (!windows) {
                    await fsp.mkdir(socketDirectory, { mode: 0o700 });
                    await fsp.writeFile(
                        path.join(socketDirectory, "socket"),
                        ""
                    );
                }
                await fsp.writeFile(
                    path.join(machine!.directory, MOUNT_CONTROL_FILE),
                    JSON.stringify({
                        protocol: 1,
                        pid: exited.pid,
                        endpoint: staleTmp
                            ? path.join(staleTmp, "socket")
                            : "\\\\.\\pipe\\peerbit-fs-control-stale",
                        token: "stale",
                    }),
                    { mode: 0o600 }
                );
                // Fails after its endpoint started: the profile output exists.
                const profile = path.join(machine!.base, "profile");
                await fsp.mkdir(profile);
                await fsp.writeFile(
                    path.join(profile, "node-daemon.ndjson"),
                    ""
                );
                const failing = startMount(
                    machine!,
                    "--mount-profile",
                    profile
                );
                expect(
                    await within(failing.exited, "the mount fails", FENCE_MS),
                    failing.errors.join("\n")
                ).toBe(1);
                expect(failing.errors.join("\n")).toContain(
                    "--mount-profile output already exists"
                );
                expect(
                    fs.existsSync(
                        path.join(machine!.directory, MOUNT_CONTROL_FILE)
                    )
                ).toBe(false);
                expect(fs.existsSync(socketDirectory)).toBe(false);
                if (staleTmp) expect(fs.existsSync(staleTmp)).toBe(false);
            } finally {
                // Left behind only when the mount did not remove it.
                if (staleTmp) await removeDirectory(staleTmp);
            }
        });
    });
});
