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

const writeJsonLine = (socket: NodeJS.WritableStream, value: unknown) => {
    socket.write(`${JSON.stringify(value)}\n`);
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
    endpoint = defaultSharedFsIpcEndpoint()
): Promise<SharedFsIpcServer> => {
    const sockets = new Set<Socket>();
    const server: Server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        let buffered = "";
        // A client abort (ECONNRESET/EPIPE) must never take the mount daemon
        // down; drop the connection and keep serving the others.
        socket.on("error", () => {
            socket.destroy();
        });
        const respond = (value: IpcResponse) => {
            if (!socket.destroyed && socket.writable) {
                writeJsonLine(socket, value);
            }
        };
        socket.on("data", (chunk) => {
            buffered += chunk.toString("utf8");
            const lines = buffered.split("\n");
            buffered = lines.pop() ?? "";
            for (const line of lines) {
                if (line.length === 0) {
                    continue;
                }
                void (async () => {
                    let requestId = 0;
                    try {
                        const request = JSON.parse(line) as IpcRequest;
                        requestId = request.id;
                        if (!IPC_OPS.has(request.op)) {
                            throw new SharedFsBackendError(
                                "EINVAL",
                                `Unknown IPC operation: ${String(request.op)}`
                            );
                        }
                        const args = decodeBytes(request.args) as unknown[];
                        const method = backend[request.op] as (
                            ...args: unknown[]
                        ) => Promise<unknown>;
                        const result = await method.apply(backend, args);
                        respond({
                            id: request.id,
                            ok: true,
                            result: encodeResult(result),
                        } satisfies IpcResponse);
                    } catch (error) {
                        respond({
                            id: requestId,
                            ok: false,
                            error: {
                                code:
                                    error instanceof SharedFsBackendError
                                        ? error.code
                                        : undefined,
                                message:
                                    error instanceof Error
                                        ? error.message
                                        : String(error),
                            },
                        } satisfies IpcResponse);
                    }
                })();
            }
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
    endpoint: SharedFsIpcEndpoint
): SharedFsMountBackend => {
    let nextId = 1;

    const request = async (op: keyof SharedFsMountBackend, args: unknown[]) => {
        const id = nextId++;
        return new Promise<unknown>((resolve, reject) => {
            const socket = connectEndpoint(endpoint);
            let buffered = "";
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
            socket.on("connect", () => {
                writeJsonLine(socket, {
                    id,
                    op,
                    args: encodeResult(args) as unknown[],
                } satisfies IpcRequest);
            });
            socket.on("data", (chunk) => {
                buffered += chunk.toString("utf8");
                const newline = buffered.indexOf("\n");
                if (newline === -1) {
                    return;
                }
                const response = JSON.parse(
                    buffered.slice(0, newline)
                ) as IpcResponse;
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
