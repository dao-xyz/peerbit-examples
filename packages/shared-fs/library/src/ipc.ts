import { createServer, createConnection, type Server } from "node:net";
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
    $bytes: Buffer.from(bytes).toString("base64"),
});

const decodeBytes = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map(decodeBytes);
    }
    if (value && typeof value === "object") {
        const maybeBytes = value as { $bytes?: unknown };
        if (typeof maybeBytes.$bytes === "string") {
            return new Uint8Array(Buffer.from(maybeBytes.$bytes, "base64"));
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

export const createSharedFsIpcServer = async (
    backend: SharedFsMountBackend,
    endpoint = defaultSharedFsIpcEndpoint()
): Promise<SharedFsIpcServer> => {
    const server: Server = createServer((socket) => {
        let buffered = "";
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
                        const args = decodeBytes(request.args) as unknown[];
                        const method = backend[request.op] as (
                            ...args: unknown[]
                        ) => Promise<unknown>;
                        const result = await method(...args);
                        writeJsonLine(socket, {
                            id: request.id,
                            ok: true,
                            result: encodeResult(result),
                        } satisfies IpcResponse);
                    } catch (error) {
                        writeJsonLine(socket, {
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

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        if (process.platform !== "win32" && existsSync(endpoint)) {
            unlinkSync(endpoint);
        }
        server.listen(endpoint, () => {
            server.off("error", reject);
            resolve();
        });
    });

    return {
        endpoint,
        close() {
            return new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });
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
            const socket = createConnection(endpoint);
            let buffered = "";
            socket.on("error", reject);
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
        flush: (handle) => request("flush", [handle]) as Promise<void>,
        fsync: (handle) => request("fsync", [handle]) as Promise<void>,
        release: (handle) => request("release", [handle]) as Promise<void>,
        mkdir: (path) => request("mkdir", [path]) as Promise<void>,
        rmdir: (path) => request("rmdir", [path]) as Promise<void>,
        rename: (from, to) => request("rename", [from, to]) as Promise<void>,
        unlink: (path) => request("unlink", [path]) as Promise<void>,
    };
};
