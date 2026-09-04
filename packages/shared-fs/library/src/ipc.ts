import {
    createServer,
    createConnection,
    type Server,
    type Socket,
} from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
    SharedFsBackendError,
    type SharedFsMountBackend,
    type SharedFsOpenFlags,
} from "./mount-backend.js";
import {
    BoundedIpcByteReader,
    IpcFrameTooLargeError,
    IpcUnexpectedEofError,
} from "./ipc-byte-reader.js";

export type SharedFsIpcEndpoint = string;

export type SharedFsIpcServer = {
    endpoint: SharedFsIpcEndpoint;
    close(): Promise<void>;
};

type IpcRequest = {
    id: number;
    op: keyof SharedFsMountBackend;
    args: unknown[];
};

/**
 * JSONL frame limits are measured in encoded UTF-8 bytes, excluding the
 * trailing newline. The default leaves ample room for base64 expansion of
 * normal mount reads and writes while bounding a malformed or runaway frame.
 */
export const DEFAULT_SHARED_FS_IPC_MAX_FRAME_BYTES = 64 * 1024 * 1024;

export type SharedFsIpcOptions = {
    maxRequestFrameBytes?: number;
    maxResponseFrameBytes?: number;
};

type ResolvedSharedFsIpcOptions = {
    maxRequestFrameBytes: number;
    maxResponseFrameBytes: number;
};

const IPC_OPS: ReadonlySet<string> = new Set([
    "getattr",
    "readdir",
    "open",
    "read",
    "write",
    "truncate",
    "flush",
    "fsync",
    "release",
    "mkdir",
    "rmdir",
    "rename",
    "unlink",
] satisfies (keyof SharedFsMountBackend)[]);

type IpcResponse =
    | {
          id: number;
          ok: true;
          result: unknown;
      }
    | {
          id: number;
          ok: false;
          error: {
              code?: string;
              message: string;
          };
      };

class IpcProtocolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "IpcProtocolError";
    }
}

const resolveFrameLimit = (name: string, value: number | undefined) => {
    const resolved = value ?? DEFAULT_SHARED_FS_IPC_MAX_FRAME_BYTES;
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
        throw new TypeError(`${name} must be a positive safe integer`);
    }
    return resolved;
};

const resolveIpcOptions = (
    options: SharedFsIpcOptions
): ResolvedSharedFsIpcOptions => ({
    maxRequestFrameBytes: resolveFrameLimit(
        "maxRequestFrameBytes",
        options.maxRequestFrameBytes
    ),
    maxResponseFrameBytes: resolveFrameLimit(
        "maxResponseFrameBytes",
        options.maxResponseFrameBytes
    ),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value != null && typeof value === "object" && !Array.isArray(value);

const parseJsonFrame = (frame: Buffer): unknown => {
    try {
        return JSON.parse(frame.toString("utf8"));
    } catch {
        throw new IpcProtocolError("IPC frame is not valid JSON");
    }
};

const parseRequest = (frame: Buffer): IpcRequest => {
    const value = parseJsonFrame(frame);
    if (!isRecord(value)) {
        throw new IpcProtocolError("IPC request must be an object");
    }
    if (
        !Number.isSafeInteger(value.id) ||
        (value.id as number) < 0 ||
        typeof value.op !== "string" ||
        !IPC_OPS.has(value.op) ||
        !Array.isArray(value.args)
    ) {
        throw new IpcProtocolError("IPC request envelope is invalid");
    }
    return value as IpcRequest;
};

const parseResponse = (frame: Buffer, requestId: number): IpcResponse => {
    const value = parseJsonFrame(frame);
    if (
        !isRecord(value) ||
        !Number.isSafeInteger(value.id) ||
        value.id !== requestId ||
        typeof value.ok !== "boolean"
    ) {
        throw new IpcProtocolError("IPC response envelope is invalid");
    }
    if (value.ok) {
        return value as IpcResponse;
    }
    if (
        !isRecord(value.error) ||
        typeof value.error.message !== "string" ||
        (value.error.code !== undefined && typeof value.error.code !== "string")
    ) {
        throw new IpcProtocolError("IPC error response envelope is invalid");
    }
    return value as IpcResponse;
};

const serializeJsonFrame = (value: unknown, maxBytes: number) => {
    const json = JSON.stringify(value);
    if (json === undefined) {
        throw new IpcProtocolError("IPC frame is not JSON serializable");
    }
    const payloadBytes = Buffer.byteLength(json, "utf8");
    if (payloadBytes > maxBytes) {
        return undefined;
    }
    const frame = Buffer.allocUnsafe(payloadBytes + 1);
    const written = frame.write(json, 0, payloadBytes, "utf8");
    if (written !== payloadBytes) {
        throw new IpcProtocolError("IPC frame encoding was incomplete");
    }
    frame[payloadBytes] = 0x0a;
    return frame;
};

const writeFrame = async (socket: Socket, frame: Buffer) => {
    if (socket.destroyed || !socket.writable) {
        throw new Error("IPC socket is not writable");
    }

    let cleanup = () => {};
    const drained = new Promise<void>((resolve, reject) => {
        const onDrain = () => {
            cleanup();
            resolve();
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        const onClose = () => {
            cleanup();
            reject(new Error("IPC socket closed before draining"));
        };
        cleanup = () => {
            socket.off("drain", onDrain);
            socket.off("error", onError);
            socket.off("close", onClose);
        };
        socket.once("drain", onDrain);
        socket.once("error", onError);
        socket.once("close", onClose);
    });

    let accepted: boolean;
    try {
        accepted = socket.write(frame);
    } catch (error) {
        cleanup();
        throw error;
    }
    if (accepted) {
        cleanup();
        return;
    }
    await drained;
};

const encodeBytes = (bytes: Uint8Array) => ({
    // Buffer.from(Uint8Array) copies. A bounded view avoids that redundant
    // allocation while still respecting subarray offsets and lengths.
    $bytes: Buffer.from(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength
    ).toString("base64"),
});

const decodeBytes = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map(decodeBytes);
    }
    if (value && typeof value === "object") {
        const maybeBytes = value as { $bytes?: unknown };
        if (typeof maybeBytes.$bytes === "string") {
            // Buffer is a Uint8Array. Return the decoder-owned allocation
            // directly instead of copying it into a second Uint8Array.
            return Buffer.from(maybeBytes.$bytes, "base64");
        }
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [
                key,
                decodeBytes(entry),
            ])
        );
    }
    return value;
};

const encodeResult = (value: unknown): unknown => {
    if (value instanceof Uint8Array) {
        return encodeBytes(value);
    }
    if (Array.isArray(value)) {
        return value.map(encodeResult);
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [
                key,
                encodeResult(entry),
            ])
        );
    }
    return value;
};

export const defaultSharedFsIpcEndpoint = (name = randomUUID()) => {
    if (process.platform === "win32") {
        return `\\\\.\\pipe\\peerbit-shared-fs-${name}`;
    }
    return join("/tmp", `pbfs-${name.slice(0, 8)}.sock`);
};

const parseTcpEndpoint = (endpoint: string) => {
    if (!endpoint.startsWith("tcp://")) {
        return undefined;
    }
    const url = new URL(endpoint);
    return {
        host: url.hostname || "127.0.0.1",
        port: Number(url.port || 0),
    };
};

const listenServer = async (server: Server, endpoint: string) => {
    const tcp = parseTcpEndpoint(endpoint);
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        if (tcp) {
            server.listen(tcp.port, tcp.host, () => {
                server.off("error", reject);
                resolve();
            });
            return;
        }
        if (process.platform !== "win32" && existsSync(endpoint)) {
            unlinkSync(endpoint);
        }
        server.listen(endpoint, () => {
            server.off("error", reject);
            resolve();
        });
    });

    if (!tcp) {
        return endpoint;
    }
    const address = server.address();
    if (typeof address !== "object" || address == null) {
        return endpoint;
    }
    return `tcp://${address.address}:${address.port}`;
};

const connectEndpoint = (endpoint: string): Socket => {
    const tcp = parseTcpEndpoint(endpoint);
    if (tcp) {
        return createConnection({ host: tcp.host, port: tcp.port });
    }
    return createConnection(endpoint);
};

export const createSharedFsIpcServer = async (
    backend: SharedFsMountBackend,
    endpoint = defaultSharedFsIpcEndpoint(),
    options: SharedFsIpcOptions = {}
): Promise<SharedFsIpcServer> => {
    const limits = resolveIpcOptions(options);
    const sockets = new Set<Socket>();
    const server: Server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        void serveSocket(socket, backend, limits).catch(() => {
            // A client abort (ECONNRESET/EPIPE), malformed frame, or local
            // response failure must never take the mount daemon down.
            socket.destroy();
        });
    });

    const resolvedEndpoint = await listenServer(server, endpoint);
    let closing: Promise<void> | undefined;

    return {
        endpoint: resolvedEndpoint,
        close() {
            closing ??= new Promise<void>((resolve, reject) => {
                // Stop admission first, then terminate retained adapter
                // sessions. Otherwise net.Server.close() waits indefinitely
                // for a persistent client that survived mount teardown.
                server.close((error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
                for (const socket of sockets) {
                    socket.destroy();
                }
            });
            return closing;
        },
    };
};

export const createSharedFsIpcClient = (
    endpoint: SharedFsIpcEndpoint,
    options: SharedFsIpcOptions = {}
): SharedFsMountBackend => {
    const limits = resolveIpcOptions(options);
    let nextId = 1;

    const request = async (op: keyof SharedFsMountBackend, args: unknown[]) => {
        const id = nextId++;
        const requestFrame = serializeJsonFrame(
            {
                id,
                op,
                args: encodeResult(args) as unknown[],
            } satisfies IpcRequest,
            limits.maxRequestFrameBytes
        );
        if (!requestFrame) {
            throw new SharedFsBackendError(
                "EIO",
                `IPC request exceeds ${limits.maxRequestFrameBytes} byte limit`
            );
        }
        return new Promise<unknown>((resolve, reject) => {
            const socket = connectEndpoint(endpoint);
            const reader = new BoundedIpcByteReader(
                socket,
                limits.maxResponseFrameBytes
            );
            let settled = false;
            const fail = (error: Error) => {
                if (!settled) {
                    settled = true;
                    reject(error);
                }
                socket.destroy();
            };
            socket.on("error", fail);
            socket.on("close", () => {
                // A dropped connection must not hang the FUSE op forever.
                fail(
                    new SharedFsBackendError(
                        "EIO",
                        `IPC connection closed before a response for ${op}`
                    )
                );
            });
            socket.once("connect", () => {
                void (async () => {
                    try {
                        await writeFrame(socket, requestFrame);
                    } catch (error) {
                        fail(
                            error instanceof Error
                                ? error
                                : new Error(String(error))
                        );
                        return;
                    }

                    let frame: Buffer | undefined;
                    try {
                        frame = await reader.readLine();
                    } catch (error) {
                        if (error instanceof IpcFrameTooLargeError) {
                            fail(
                                new SharedFsBackendError(
                                    "EIO",
                                    `IPC response exceeds ${limits.maxResponseFrameBytes} byte limit`
                                )
                            );
                            return;
                        }
                        if (error instanceof IpcUnexpectedEofError) {
                            fail(
                                new SharedFsBackendError(
                                    "EIO",
                                    `IPC connection closed before a response for ${op}`
                                )
                            );
                            return;
                        }
                        fail(
                            error instanceof Error
                                ? error
                                : new Error(String(error))
                        );
                        return;
                    }
                    if (frame === undefined) {
                        fail(
                            new SharedFsBackendError(
                                "EIO",
                                `IPC connection closed before a response for ${op}`
                            )
                        );
                        return;
                    }
                    if (reader.bufferedByteLength > 0) {
                        fail(
                            new SharedFsBackendError(
                                "EIO",
                                "IPC server sent trailing bytes after its response"
                            )
                        );
                        return;
                    }

                    try {
                        const response = parseResponse(frame, id);
                        settled = true;
                        socket.end();
                        if (response.ok) {
                            resolve(decodeBytes(response.result));
                        } else {
                            reject(
                                new SharedFsBackendError(
                                    (response.error.code as any) ?? "EIO",
                                    response.error.message
                                )
                            );
                        }
                    } catch (error) {
                        fail(
                            new SharedFsBackendError(
                                "EIO",
                                error instanceof Error
                                    ? error.message
                                    : String(error)
                            )
                        );
                    }
                })();
            });
        });
    };

    return {
        getattr: (path) => request("getattr", [path]) as Promise<any>,
        readdir: (path) => request("readdir", [path]) as Promise<any>,
        open: (path, flags?: SharedFsOpenFlags) =>
            request("open", [path, flags]) as Promise<number>,
        read: (handle, size, offset) =>
            request("read", [handle, size, offset]) as Promise<Uint8Array>,
        write: (handle, data, offset) =>
            request("write", [handle, data, offset]) as Promise<number>,
        truncate: (target, size) =>
            request("truncate", [target, size]) as Promise<void>,
        flush: (handle) => request("flush", [handle]) as Promise<void>,
        fsync: (handle) => request("fsync", [handle]) as Promise<void>,
        release: (handle) => request("release", [handle]) as Promise<void>,
        mkdir: (path) => request("mkdir", [path]) as Promise<void>,
        rmdir: (path) => request("rmdir", [path]) as Promise<void>,
        rename: (from, to) => request("rename", [from, to]) as Promise<void>,
        unlink: (path) => request("unlink", [path]) as Promise<void>,
    };
};

const serveSocket = async (
    socket: Socket,
    backend: SharedFsMountBackend,
    limits: ResolvedSharedFsIpcOptions
) => {
    const reader = new BoundedIpcByteReader(
        socket,
        limits.maxRequestFrameBytes
    );

    for (;;) {
        const frame = await reader.readLine();
        if (frame === undefined) {
            return;
        }
        if (frame.byteLength === 0) {
            continue;
        }

        let request: IpcRequest;
        try {
            request = parseRequest(frame);
        } catch {
            socket.destroy();
            return;
        }

        let response: IpcResponse;
        try {
            const args = decodeBytes(request.args) as unknown[];
            const method = backend[request.op] as (
                ...args: unknown[]
            ) => Promise<unknown>;
            const result = await method.apply(backend, args);
            response = {
                id: request.id,
                ok: true,
                result: encodeResult(result),
            };
        } catch (error) {
            response = {
                id: request.id,
                ok: false,
                error: {
                    code:
                        error instanceof SharedFsBackendError
                            ? error.code
                            : undefined,
                    message:
                        error instanceof Error ? error.message : String(error),
                },
            };
        }

        let responseFrame = serializeJsonFrame(
            response,
            limits.maxResponseFrameBytes
        );
        if (!responseFrame) {
            responseFrame = serializeJsonFrame(
                {
                    id: request.id,
                    ok: false,
                    error: {
                        code: "EIO",
                        message: `IPC response exceeds ${limits.maxResponseFrameBytes} byte limit`,
                    },
                } satisfies IpcResponse,
                limits.maxResponseFrameBytes
            );
        }
        if (!responseFrame) {
            socket.destroy();
            return;
        }
        await writeFrame(socket, responseFrame);
    }
};
