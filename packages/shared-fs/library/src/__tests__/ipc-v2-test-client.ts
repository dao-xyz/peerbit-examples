import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { BoundedIpcByteReader } from "../ipc-byte-reader.js";
import {
    encodeIpcV2Frame,
    IpcV2FrameKind,
    readIpcV2Frame,
    SHARED_FS_IPC_NEGOTIATE_OP,
    SHARED_FS_IPC_PROTOCOL,
    writeIpcV2Frame,
} from "../ipc-v2.js";
import type { SharedFsIpcServer } from "../ipc.js";
import {
    SharedFsBackendError,
    type SharedFsMountBackend,
} from "../mount-backend.js";

const DEFAULT_LIMIT = 64 * 1024 * 1024;

export type IpcV2Limits = {
    maxRequestFrameBytes: number;
    maxResponseFrameBytes: number;
    maxMetadataBytes: number;
};

export const connectIpcEndpoint = async (endpoint: string) => {
    const socket = endpoint.startsWith("tcp://")
        ? (() => {
              const url = new URL(endpoint);
              return createConnection({
                  host: url.hostname,
                  port: Number(url.port),
              });
          })()
        : createConnection(endpoint);
    await once(socket, "connect");
    return socket;
};

/**
 * Send the v2 offer, presenting the server's token, on a fresh socket and
 * return the negotiated limits.
 */
export const negotiateIpcV2 = async (
    socket: Socket,
    token: string,
    offer: Record<string, unknown> = {}
) => {
    const reader = new BoundedIpcByteReader(socket, DEFAULT_LIMIT);
    socket.write(
        `${JSON.stringify({
            id: 0,
            op: SHARED_FS_IPC_NEGOTIATE_OP,
            args: [
                {
                    protocol: SHARED_FS_IPC_PROTOCOL,
                    versions: [2],
                    nonce: "test-nonce",
                    token,
                    maxRequestFrameBytes: DEFAULT_LIMIT,
                    maxResponseFrameBytes: DEFAULT_LIMIT,
                    ...offer,
                },
            ],
        })}\n`
    );
    const line = await reader.readLine();
    if (!line) throw new Error("IPC server omitted negotiation response");
    const response = JSON.parse(line.toString("utf8"));
    if (!response.ok || response.result?.version !== 2) {
        throw new Error(`IPC server rejected v2: ${line.toString("utf8")}`);
    }
    const limits: IpcV2Limits = {
        maxRequestFrameBytes: response.result.maxRequestFrameBytes,
        maxResponseFrameBytes: response.result.maxResponseFrameBytes,
        maxMetadataBytes: response.result.maxMetadataBytes,
    };
    return { reader, limits };
};

export const readIpcV2Response = async (
    reader: BoundedIpcByteReader,
    limits: Pick<IpcV2Limits, "maxResponseFrameBytes" | "maxMetadataBytes">
) => {
    const response = await readIpcV2Frame(
        reader,
        IpcV2FrameKind.Response,
        limits.maxResponseFrameBytes,
        limits.maxMetadataBytes
    );
    return {
        metadata: JSON.parse(response.metadata.toString("utf8")),
        body: response.body,
    };
};

/**
 * Minimal test-only backend client over one negotiated IPC v2 connection. It
 * mirrors the Go adapter's wire behavior (serialized requests, raw write and
 * read bodies, backend error codes) so tests can drive a real server.
 */
export const createIpcV2TestClient = ({
    endpoint,
    token,
}: Pick<SharedFsIpcServer, "endpoint" | "token">) => {
    let nextId = 1;
    let session:
        | Promise<{
              socket: Socket;
              reader: BoundedIpcByteReader;
              limits: IpcV2Limits;
          }>
        | undefined;
    let lane: Promise<unknown> = Promise.resolve();

    const connect = () =>
        (session ??= (async () => {
            const socket = await connectIpcEndpoint(endpoint);
            socket.on("error", () => {});
            return { socket, ...(await negotiateIpcV2(socket, token)) };
        })());

    const call = async (
        op: keyof SharedFsMountBackend,
        args: unknown[],
        body: Uint8Array = new Uint8Array(0)
    ) => {
        const { socket, reader, limits } = await connect();
        const id = nextId++;
        await writeIpcV2Frame(
            socket,
            encodeIpcV2Frame(
                IpcV2FrameKind.Request,
                { id, op, args },
                body,
                limits.maxRequestFrameBytes,
                limits.maxMetadataBytes
            )
        );
        const response = await readIpcV2Response(reader, limits);
        if (response.metadata.id !== id) {
            throw new Error(
                `IPC response id ${response.metadata.id} for request ${id}`
            );
        }
        if (!response.metadata.ok) {
            throw new SharedFsBackendError(
                response.metadata.error.code ?? "EIO",
                response.metadata.error.message
            );
        }
        return op === "read" ? response.body : response.metadata.result;
    };

    const request = (
        op: keyof SharedFsMountBackend,
        args: unknown[],
        body?: Uint8Array
    ) => {
        const result = lane.then(() => call(op, args, body));
        lane = result.catch(() => {});
        return result as Promise<any>;
    };

    const backend: SharedFsMountBackend = {
        getattr: (path) => request("getattr", [path]),
        readdir: (path, options) =>
            request(
                "readdir",
                options === undefined ? [path] : [path, options]
            ),
        open: (path, flags, createMode) =>
            request(
                "open",
                createMode === undefined
                    ? [path, flags]
                    : [path, flags, createMode]
            ),
        read: (handle, size, offset) => request("read", [handle, size, offset]),
        write: (handle, data, offset) =>
            request("write", [handle, { $bytes: null }, offset], data),
        truncate: (target, size) => request("truncate", [target, size]),
        flush: (handle) => request("flush", [handle]),
        fsync: (handle) => request("fsync", [handle]),
        release: (handle) => request("release", [handle]),
        mkdir: (path) => request("mkdir", [path]),
        rmdir: (path) => request("rmdir", [path]),
        rename: (from, to) => request("rename", [from, to]),
        unlink: (path) => request("unlink", [path]),
        setattr: (path, attrs) => request("setattr", [path, attrs]),
        symlink: (target, path) => request("symlink", [target, path]),
        readlink: (path) => request("readlink", [path]),
    };
    return Object.assign(backend, {
        async close() {
            const current = session;
            session = undefined;
            if (current) {
                (await current).socket.destroy();
            }
        },
    });
};
