import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

/**
 * A running mount's control endpoint. The mount holds its state directory
 * locked, so a peerbit-fs command for that directory sends its request here
 * and the mount runs it on its live filesystem, instead of the command
 * opening the directory.
 *
 * Wire: the client sends one JSON line, `MountControlRequest`; the mount
 * answers with JSON lines, the command's output and then one of `done`,
 * `failed` or `refused`, and closes the connection. One request per
 * connection.
 */

/** The wire format's version. A request of another version is refused. */
export const MOUNT_CONTROL_PROTOCOL = 1;

/**
 * In the state directory, mode 0600: the mount's pid, endpoint and token.
 * Written once the endpoint listens, removed when the mount stops.
 */
export const MOUNT_CONTROL_FILE = "mount-control.json";

/** In the state directory, mode 0700: the directory of the mount's socket. */
export const MOUNT_CONTROL_SOCKET_DIRECTORY = "mount-control";

const SOCKET_NAME = "socket";

/**
 * A socket path must fit sun_path (104 bytes on macOS, 108 on Linux) with
 * its terminating NUL. A longer one goes into a new owner-only directory
 * under /tmp instead, where the mount's IPC socket is on Linux.
 */
const SUN_PATH_BYTES = process.platform === "linux" ? 108 : 104;
const SHORT_SOCKET_PREFIX = "/tmp/pbfs-ctl-";

/** The endpoint's bounds. Tests shorten them. */
export type MountControlLimits = {
    /** A request line longer than this many bytes closes its connection. */
    requestBytes: number;
    /**
     * So does one not complete this long after the connection opened,
     * however steadily its bytes come.
     */
    requestMs: number;
    /** A stop waits this long for the commands that began a change. */
    stopWaitMs: number;
};

/** The bounds of a mount's endpoint. */
export const MOUNT_CONTROL_LIMITS: Readonly<MountControlLimits> = {
    requestBytes: 1 << 20,
    requestMs: 30_000,
    stopWaitMs: 10_000,
};

/** Windows PowerShell gets this long to restrict the named pipe. */
const RESTRICT_PIPE_TIMEOUT_MS = 30_000;

export type MountControlRecord = {
    protocol: number;
    pid: number;
    /**
     * The state directory's device and inode. A copy of the record in
     * another directory (a copy of the state directory, or one restored from
     * a backup) does not match that directory: it names no mount there.
     */
    directory: string;
    /** Absent when the mount could not serve an endpoint. */
    endpoint?: string;
    token?: string;
};

/** How the client's terminal shows output, for chalk and progress lines. */
export type MountControlOutput = {
    /** chalk's color level, 0 to 3. */
    color: 0 | 1 | 2 | 3;
    stderr: { isTTY: boolean; columns?: number };
};

export type MountControlRequest = {
    protocol: number;
    token: string;
    /** The client's CLI version: the mount refuses another one. */
    cli: string;
    command: string;
    /** The command's parsed arguments. */
    argv: Record<string, unknown>;
    output: MountControlOutput;
};

/** A line of a command's output, as console prints it or raw on stderr. */
export type MountControlPrint =
    | { type: "console"; method: "log" | "warn" | "error"; text: string }
    | { type: "stderr"; text: string };

export type MountControlResponse =
    | MountControlPrint
    | { type: "done"; exitCode: number | null }
    | {
          type: "failed";
          error: {
              name: string;
              message: string;
              code?: string;
              stack?: string;
          };
      }
    | { type: "refused"; reason: string };

/** Thrown by a handler: the command did not run, and why. */
export class MountControlRefusal extends Error {}

/**
 * Runs one request on the mount and resolves with the exit code it set.
 * `signal` aborts once the client went away or the mount began to stop.
 * The handler calls `beginChange()` just before it changes the filesystem:
 * it throws once `signal` aborted, and from then on a stop waits for the
 * request (up to its limit) instead of cutting it off, also once its client
 * went away.
 */
export type MountControlHandler = (
    request: Pick<MountControlRequest, "command" | "argv" | "output">,
    print: (message: MountControlPrint) => void,
    signal: AbortSignal,
    beginChange: () => void
) => Promise<number | undefined>;

/** What a command prints when a running mount holds its state directory. */
export class MountRunningError extends Error {
    constructor(pid: number, detail: string) {
        super(`a mount is running for this directory (pid ${pid}); ${detail}`);
        this.name = "MountRunningError";
    }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();

const isOwnPrivate = (stat: fs.Stats) =>
    stat.uid === process.getuid!() && (stat.mode & 0o077) === 0;

const errorCode = (error: unknown) =>
    (error as NodeJS.ErrnoException)?.code ??
    (error instanceof Error ? error.message : String(error));

/** A directory's device and inode, which a copy of it does not share. */
const directoryIdentity = (directory: string) => {
    const { dev, ino } = fs.statSync(directory, { bigint: true });
    return `${dev}:${ino}`;
};

/**
 * The mount record of `directory`, or undefined if there is none or it is
 * not one a mount of this user wrote for this directory: on POSIX a regular
 * file of this user that no one else may read, and never one copied from
 * another directory.
 */
export const readMountControl = (
    directory: string
): MountControlRecord | undefined => {
    let text: string;
    let identity: string;
    try {
        identity = directoryIdentity(directory);
        const fd = fs.openSync(
            path.join(directory, MOUNT_CONTROL_FILE),
            fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
        );
        try {
            const stat = fs.fstatSync(fd);
            if (
                !stat.isFile() ||
                (process.platform !== "win32" && !isOwnPrivate(stat))
            )
                return undefined;
            text = fs.readFileSync(fd, "utf8");
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return undefined;
    }
    try {
        const {
            protocol,
            pid,
            directory: owner,
            endpoint,
            token,
        } = JSON.parse(text);
        if (!Number.isSafeInteger(pid) || pid <= 0 || owner !== identity) {
            return undefined;
        }
        return {
            protocol,
            pid,
            directory: identity,
            ...(typeof endpoint === "string" && typeof token === "string"
                ? { endpoint, token }
                : {}),
        };
    } catch {
        return undefined;
    }
};

/** Whether a process with this id exists (EPERM: it does, as another user). */
export const processAlive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === "EPERM";
    }
};

/**
 * Windows: Node creates a named pipe with Windows' default security
 * descriptor, which also lets every user, and anonymous ones, open it for
 * reading. Windows PowerShell opens the pipe once, as its owner may, with
 * WRITE_DAC, and replaces that with a protected DACL that grants only the
 * current user.
 */
const RESTRICT_PIPE_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
    $rights = [System.IO.Pipes.PipeAccessRights]'ReadData, ChangePermissions'
    $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', $env:PEERBIT_FS_CONTROL_PIPE, $rights, [System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::None, [System.IO.HandleInheritability]::None)
    $pipe.Connect(10000)
    try {
        $security = [System.IO.Pipes.PipeSecurity]::new()
        $security.SetAccessRuleProtection($true, $false)
        $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $security.AddAccessRule([System.IO.Pipes.PipeAccessRule]::new($user, [System.IO.Pipes.PipeAccessRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow))
        $pipe.SetAccessControl($security)
    } finally {
        $pipe.Dispose()
    }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
`;

/** Runs a Windows PowerShell script with `env` added; resolves its stdout. */
export const runPowerShell = (
    script: string,
    env: NodeJS.ProcessEnv,
    timeoutMs = RESTRICT_PIPE_TIMEOUT_MS
) =>
    new Promise<string>((resolve, reject) => {
        const child = spawn(
            "powershell.exe",
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                Buffer.from(script, "utf16le").toString("base64"),
            ],
            {
                env: { ...process.env, ...env },
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            }
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`PowerShell did not finish in ${timeoutMs} ms`));
        }, timeoutMs);
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(stdout);
            else
                reject(
                    new Error(
                        `PowerShell exited ${code}: ${stderr.trim() || "no output"}`
                    )
                );
        });
    });

const listen = (server: net.Server, endpoint: string) =>
    new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, () => {
            server.off("error", reject);
            resolve();
        });
    });

/** Checks that `directory`, just made, is a directory only this user owns. */
const assertPrivateDirectory = (directory: string) => {
    fs.chmodSync(directory, 0o700);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || !isOwnPrivate(stat)) {
        throw new Error(`${directory} is not a directory only this user owns`);
    }
};

/** A socket directory under /tmp, as the record of a killed mount names it. */
const isShortSocketDirectory = (directory: string) =>
    directory.startsWith(SHORT_SOCKET_PREFIX) &&
    !directory.slice(SHORT_SOCKET_PREFIX.length).includes("/");

/**
 * Removes what a mount of this directory left that did not stop cleanly:
 * the socket directory in the state directory, and the one under /tmp its
 * record names, unless that record's process still runs (another process
 * that got its pid). Never throws.
 */
const removeStale = (stateDirectory: string) => {
    const stale = readMountControl(stateDirectory);
    const named =
        stale?.endpoint === undefined || processAlive(stale.pid)
            ? undefined
            : path.dirname(stale.endpoint);
    const candidates = [
        path.join(stateDirectory, MOUNT_CONTROL_SOCKET_DIRECTORY),
        ...(named !== undefined && isShortSocketDirectory(named)
            ? [named]
            : []),
    ];
    for (const directory of candidates) {
        try {
            // Only one this user owns: another's is not this mount's to remove.
            if (fs.lstatSync(directory).uid !== process.getuid!()) continue;
            fs.rmSync(directory, { recursive: true, force: true });
        } catch {
            // Gone already, or not removable: bind() makes a new one.
        }
    }
};

type Bound = { endpoint: string; directory?: string };

/**
 * Listens on an owner-only endpoint. POSIX: a 0600 socket in a new 0700
 * directory, in the state directory if its path fits sun_path, otherwise or
 * if that fails under /tmp. Windows: a named pipe with a random name whose
 * DACL then admits only this user.
 */
const bind = async (server: () => net.Server, stateDirectory: string) => {
    if (process.platform === "win32") {
        const name = `peerbit-fs-control-${randomBytes(16).toString("hex")}`;
        const listening = server();
        await listen(listening, `\\\\.\\pipe\\${name}`);
        try {
            await runPowerShell(RESTRICT_PIPE_SCRIPT, {
                PEERBIT_FS_CONTROL_PIPE: name,
            });
        } catch (error) {
            listening.close();
            throw error;
        }
        return { listening, bound: { endpoint: `\\\\.\\pipe\\${name}` } };
    }
    const inState = path.join(
        path.resolve(stateDirectory),
        MOUNT_CONTROL_SOCKET_DIRECTORY
    );
    // Each makes a new directory, or throws.
    const candidates = [
        ...(Buffer.byteLength(path.join(inState, SOCKET_NAME)) < SUN_PATH_BYTES
            ? [() => (fs.mkdirSync(inState, { mode: 0o700 }), inState)]
            : []),
        () => fs.mkdtempSync(SHORT_SOCKET_PREFIX),
    ];
    let failure: unknown;
    for (const candidate of candidates) {
        let directory: string | undefined;
        let listening: net.Server | undefined;
        try {
            directory = candidate();
            assertPrivateDirectory(directory);
            const endpoint = path.join(directory, SOCKET_NAME);
            listening = server();
            await listen(listening, endpoint);
            // Before this, only this user could enter the directory anyway.
            fs.chmodSync(endpoint, 0o600);
            return { listening, bound: { endpoint, directory } as Bound };
        } catch (error) {
            failure = error;
            listening?.close();
            try {
                if (directory !== undefined) {
                    fs.rmSync(directory, { recursive: true, force: true });
                }
            } catch {
                // The next mount removes it.
            }
        }
    }
    throw failure;
};

const describeError = (error: unknown) => {
    const value = error instanceof Error ? error : new Error(String(error));
    const code = (value as NodeJS.ErrnoException).code;
    return {
        name: value.name,
        message: value.message,
        ...(typeof code === "string" ? { code } : {}),
        ...(typeof value.stack === "string" ? { stack: value.stack } : {}),
    };
};

/** The request line, up to `maxBytes` bytes; each chunk is searched once. */
const readRequestLine = (socket: net.Socket, maxBytes: number) =>
    new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        const cleanup = () => {
            socket.off("data", onData).off("end", onEnd).off("close", onEnd);
        };
        const onData = (chunk: Buffer) => {
            const end = chunk.indexOf(0x0a);
            const length = bytes + (end >= 0 ? end : chunk.length);
            if (length > maxBytes) {
                cleanup();
                reject(new Error("request line too long"));
            } else if (end < 0) {
                chunks.push(chunk);
                bytes = length;
            } else {
                cleanup();
                chunks.push(chunk.subarray(0, end));
                resolve(Buffer.concat(chunks, length).toString("utf8"));
            }
        };
        const onEnd = () => {
            cleanup();
            reject(new Error("no request line"));
        };
        socket.on("data", onData).once("end", onEnd).once("close", onEnd);
    });

const OUTPUT_COLORS = [0, 1, 2, 3] as const;

const outputOf = (value: any): MountControlOutput => ({
    color: OUTPUT_COLORS.includes(value?.color) ? value.color : 0,
    stderr: {
        isTTY: value?.stderr?.isTTY === true,
        ...(Number.isSafeInteger(value?.stderr?.columns) &&
        value.stderr.columns > 0
            ? { columns: value.stderr.columns }
            : {}),
    },
});

export type MountControl = {
    /** The socket path or pipe name, or undefined if none could be served. */
    endpoint?: string;
    /** Why no endpoint is served. */
    failure?: string;
    /**
     * Refuses new requests ("it is stopping") and cuts off those that have
     * not begun a change. Resolves once those that have are done, also
     * those whose client went away, or once the stop's wait is over; it
     * then cuts them off too.
     */
    stopServing(): Promise<void>;
    /**
     * Cuts off every request, stops listening and removes the socket and
     * the record.
     */
    close(): Promise<void>;
};

/** A connection's request, as a stop sees it. */
type Served = {
    abort: AbortController;
    /**
     * It was refused or its handler is done, and a client still connected
     * has its answer.
     */
    answered: boolean;
    /** Settles once it is answered; from when its request line arrived. */
    answering?: Promise<void>;
};

/**
 * Serves `handle` on an owner-only endpoint and records it in the state
 * directory. Call it only while this process holds the directory (its
 * Peerbit is open): what a mount left that was killed is stale then, and is
 * replaced. A process that exits without close() still removes the socket
 * and the record; a killed one leaves them for the next mount to replace.
 * An endpoint that cannot be served is reported in `failure`, and the
 * record still names this pid.
 */
export const startMountControl = async (options: {
    directory: string;
    cliVersion: string;
    handle: MountControlHandler;
    limits?: Partial<MountControlLimits>;
}): Promise<MountControl> => {
    const limits = { ...MOUNT_CONTROL_LIMITS, ...options.limits };
    const record = path.join(options.directory, MOUNT_CONTROL_FILE);
    const token = randomBytes(32).toString("base64url");
    const tokenDigest = sha256(token);
    const connections = new Map<net.Socket, Served>();
    /**
     * The requests that began a change, until they are answered: a stop
     * waits for them, also for one whose connection closed, since its
     * change goes on without its client.
     */
    const changes = new Set<Served>();
    let stopping = false;

    /** Ends a request: its signal aborts at once, before any change. */
    const cutOff = (socket: net.Socket, served: Served, reason: string) => {
        served.abort.abort(new Error(reason));
        socket.destroy();
    };

    const serve = (socket: net.Socket) => {
        const served: Served = {
            abort: new AbortController(),
            answered: false,
        };
        connections.set(socket, served);
        // The whole request line by then, however slowly it comes.
        const deadline = setTimeout(() => socket.destroy(), limits.requestMs);
        socket.on("error", () => socket.destroy());
        socket.once("close", () => {
            clearTimeout(deadline);
            connections.delete(socket);
            served.abort.abort(new Error("the control connection closed"));
        });
        const send = (message: MountControlResponse) => {
            if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
        };
        const finish = (message: MountControlResponse) => {
            served.answered = true;
            changes.delete(served);
            send(message);
            socket.end();
        };
        const refuse = (reason: string) => finish({ type: "refused", reason });
        const beginChange = () => {
            served.abort.signal.throwIfAborted();
            changes.add(served);
        };
        const answer = async (line: string) => {
            let request: Partial<MountControlRequest>;
            try {
                request = JSON.parse(line);
            } catch {
                return refuse("the request is not JSON");
            }
            if (request?.protocol !== MOUNT_CONTROL_PROTOCOL) {
                return refuse(
                    `it speaks control protocol ${MOUNT_CONTROL_PROTOCOL}, not ${String(request?.protocol)}`
                );
            }
            if (
                typeof request.token !== "string" ||
                !timingSafeEqual(sha256(request.token), tokenDigest)
            ) {
                return refuse(
                    `the token does not match the one in ${MOUNT_CONTROL_FILE}`
                );
            }
            if (stopping) return refuse("it is stopping");
            if (request.cli !== options.cliVersion) {
                return refuse(
                    `it runs peerbit-fs ${options.cliVersion} and this is ${String(request.cli)}: run that version, or restart the mount`
                );
            }
            if (
                typeof request.command !== "string" ||
                typeof request.argv !== "object" ||
                request.argv === null
            ) {
                return refuse("the request names no command");
            }
            try {
                const exitCode = await options.handle(
                    {
                        command: request.command,
                        argv: request.argv,
                        output: outputOf(request.output),
                    },
                    send,
                    served.abort.signal,
                    beginChange
                );
                finish({ type: "done", exitCode: exitCode ?? null });
            } catch (error) {
                if (error instanceof MountControlRefusal) {
                    refuse(error.message);
                } else {
                    finish({ type: "failed", error: describeError(error) });
                }
            }
        };
        void readRequestLine(socket, limits.requestBytes).then(
            (line) => {
                clearTimeout(deadline);
                served.answering = answer(line);
            },
            () => socket.destroy()
        );
    };

    let listening: net.Server | undefined;
    let bound: Bound | undefined;
    let failure: string | undefined;
    const temporary = `${record}.${randomBytes(6).toString("hex")}`;
    // Removes what this endpoint created, also from an exit handler: only
    // while this process holds the directory, so never another mount's.
    const remove = () => {
        for (const file of [temporary, record]) {
            try {
                fs.rmSync(file, { force: true });
            } catch {
                // Not removable: the next mount replaces it.
            }
        }
        if (bound?.directory !== undefined) {
            try {
                fs.rmSync(bound.directory, { recursive: true, force: true });
            } catch {
                // As above.
            }
        }
    };
    process.on("exit", remove);
    try {
        // This process holds the directory: what a mount left there is stale.
        if (process.platform !== "win32") removeStale(options.directory);
        try {
            ({ listening, bound } = await bind(
                () => net.createServer(serve),
                options.directory
            ));
        } catch (error) {
            failure = errorCode(error);
        }
        fs.writeFileSync(
            temporary,
            `${JSON.stringify({
                protocol: MOUNT_CONTROL_PROTOCOL,
                pid: process.pid,
                directory: directoryIdentity(options.directory),
                ...(bound ? { endpoint: bound.endpoint, token } : {}),
            } satisfies MountControlRecord)}\n`,
            { mode: 0o600, flag: "wx" }
        );
        fs.renameSync(temporary, record);
    } catch (error) {
        process.off("exit", remove);
        listening?.close();
        remove();
        throw error;
    }

    const stopServing = async () => {
        stopping = true;
        for (const [socket, served] of connections) {
            if (!served.answered && !changes.has(served)) {
                cutOff(socket, served, "the mount is stopping");
            }
        }
        // From here on no other request can begin a change: new ones are
        // refused, and the signal of every other one under way has aborted.
        if (changes.size > 0) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
                Promise.allSettled(
                    // Set in the turn its handler began, so set by now.
                    [...changes].map((served) => served.answering!)
                ),
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, limits.stopWaitMs);
                }),
            ]);
            clearTimeout(timer);
        }
        // Changes still under way are not waited for any longer.
        for (const [socket, served] of connections) {
            if (!served.answered) {
                cutOff(socket, served, "the mount is stopping");
            }
        }
    };
    let closed: Promise<void> | undefined;
    return {
        endpoint: bound?.endpoint,
        failure,
        stopServing,
        close: () =>
            (closed ??= (async () => {
                stopping = true;
                for (const [socket, served] of connections) {
                    cutOff(socket, served, "the mount is stopping");
                }
                process.off("exit", remove);
                remove();
                await new Promise<void>((resolve) =>
                    listening ? listening.close(() => resolve()) : resolve()
                );
            })()),
    };
};

/** Where the client prints what the command prints. */
export type MountControlSink = (message: MountControlPrint) => void;

const CONSOLE_METHODS: unknown[] = ["log", "warn", "error"];

export type MountControlOutcome =
    | { reached: false; reason: string }
    | { reached: true; exitCode: number | null };

/** The error of a command that failed in the mount, as it was thrown there. */
const rebuildError = (error: any) => {
    const rebuilt = new Error(String(error?.message ?? "the command failed"));
    if (typeof error?.name === "string") rebuilt.name = error.name;
    if (typeof error?.code === "string")
        Object.assign(rebuilt, { code: error.code });
    if (typeof error?.stack === "string") rebuilt.stack = error.stack;
    return rebuilt;
};

/**
 * Runs a command through the mount `record` names. Resolves `reached: false`
 * with the reason when its endpoint cannot be reached; otherwise with the
 * exit code the command set, once `sink` got its output. A command that
 * failed in the mount rejects with its error; a refused or cut off one with
 * a MountRunningError.
 */
export const callMountControl = (
    record: MountControlRecord,
    request: Pick<MountControlRequest, "cli" | "command" | "argv" | "output">,
    sink: MountControlSink
) =>
    new Promise<MountControlOutcome>((resolve, reject) => {
        const { endpoint, token } = record;
        if (endpoint === undefined || token === undefined) {
            return resolve({
                reached: false,
                reason: "it serves no control endpoint",
            });
        }
        if (process.platform !== "win32") {
            // Only a directory this user alone owns holds the mount's socket.
            try {
                if (!isOwnPrivate(fs.lstatSync(path.dirname(endpoint)))) {
                    return resolve({
                        reached: false,
                        reason: "its socket's directory is not this user's own",
                    });
                }
            } catch (error) {
                return resolve({ reached: false, reason: errorCode(error) });
            }
        }
        const command = `peerbit-fs ${request.command}`;
        let connected = false;
        let settled = false;
        const settle = (settleWith: () => void) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            settleWith();
        };
        const socket = net.createConnection(endpoint, () => {
            connected = true;
            socket.write(
                `${JSON.stringify({
                    protocol: MOUNT_CONTROL_PROTOCOL,
                    token,
                    ...request,
                } satisfies MountControlRequest)}\n`
            );
        });
        socket.on("error", (error) => {
            if (!connected) {
                settle(() =>
                    resolve({ reached: false, reason: errorCode(error) })
                );
            }
        });
        socket.once("close", () =>
            settle(() =>
                reject(
                    new MountRunningError(
                        record.pid,
                        `its control endpoint closed before ${command} finished`
                    )
                )
            )
        );
        let buffered = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
            buffered += chunk;
            for (
                let end = buffered.indexOf("\n");
                end >= 0 && !settled;
                end = buffered.indexOf("\n")
            ) {
                const line = buffered.slice(0, end);
                buffered = buffered.slice(end + 1);
                let message: MountControlResponse;
                try {
                    message = JSON.parse(line);
                } catch {
                    settle(() =>
                        reject(
                            new MountRunningError(
                                record.pid,
                                `its control endpoint answered ${command} with something other than JSON`
                            )
                        )
                    );
                    return;
                }
                // Anything else is from a later version: skipped.
                if (
                    message?.type === "console" &&
                    CONSOLE_METHODS.includes(message.method) &&
                    typeof message.text === "string"
                ) {
                    sink(message);
                } else if (
                    message?.type === "stderr" &&
                    typeof message.text === "string"
                ) {
                    sink(message);
                } else if (message?.type === "done") {
                    const { exitCode } = message;
                    settle(() =>
                        resolve({
                            reached: true,
                            exitCode: Number.isSafeInteger(exitCode)
                                ? exitCode
                                : null,
                        })
                    );
                } else if (message?.type === "failed") {
                    settle(() => reject(rebuildError(message.error)));
                } else if (message?.type === "refused") {
                    settle(() =>
                        reject(
                            new MountRunningError(
                                record.pid,
                                `it refused ${command}: ${String(message.reason)}`
                            )
                        )
                    );
                }
            }
        });
    });
