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
    type SharedFsReaddirOptions,
} from "./mount-backend.js";
import {
    BoundedIpcByteReader,
    IpcFrameTooLargeError,
    IpcUnexpectedEofError,
} from "./ipc-byte-reader.js";
import {
    encodeIpcV2Frame,
    IpcV2FrameKind,
    IpcV2FrameTooLargeError,
    readIpcV2Frame,
    SHARED_FS_IPC_NEGOTIATE_OP,
    SHARED_FS_IPC_NEGOTIATION_MAX_BYTES,
    SHARED_FS_IPC_PROTOCOL,
    SHARED_FS_IPC_V2_MAX_METADATA_BYTES,
    writeIpcV2Frame,
} from "./ipc-v2.js";
import {
    profileSharedFsMountOperation,
    type SharedFsMountProfileSink,
} from "./mount-profile.js";

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

type IpcNegotiationOffer = {
    protocol: string;
    versions: number[];
    nonce: string;
    maxRequestFrameBytes?: number;
    maxResponseFrameBytes?: number;
};

type IpcNegotiationRequest = {
    id: number;
    op: typeof SHARED_FS_IPC_NEGOTIATE_OP;
    args: [IpcNegotiationOffer];
};

type IpcV2Limits = ResolvedSharedFsIpcOptions & {
    maxMetadataBytes: number;
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

export type SharedFsIpcServerOptions = SharedFsIpcOptions & {
    /** Time backend service only; framing and socket writes are excluded. */
    profile?: SharedFsMountProfileSink;
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

const parseUtf8JsonFrame = (frame: Buffer): unknown => {
    let json: string;
    try {
        json = new TextDecoder("utf-8", { fatal: true }).decode(frame);
    } catch {
        throw new IpcProtocolError("IPC frame is not valid UTF-8");
    }
    try {
        return JSON.parse(json);
    } catch {
        throw new IpcProtocolError("IPC frame is not valid JSON");
    }
};

const parseRequest = (frame: Buffer): IpcRequest => {
    return parseRequestValue(parseJsonFrame(frame));
};

const parseRequestValue = (value: unknown): IpcRequest => {
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

const isUint32 = (value: unknown): value is number =>
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 0xffff_ffff;

const parseNegotiationRequest = (
    value: unknown
): IpcNegotiationRequest | undefined => {
    if (!isRecord(value) || value.op !== SHARED_FS_IPC_NEGOTIATE_OP) {
        return undefined;
    }
    if (
        !Number.isSafeInteger(value.id) ||
        (value.id as number) < 0 ||
        !Array.isArray(value.args) ||
        value.args.length !== 1 ||
        !isRecord(value.args[0])
    ) {
        throw new IpcProtocolError("IPC negotiation envelope is invalid");
    }
    const offer = value.args[0];
    if (
        offer.protocol !== SHARED_FS_IPC_PROTOCOL ||
        typeof offer.nonce !== "string" ||
        !Array.isArray(offer.versions) ||
        offer.versions.length === 0 ||
        !offer.versions.every(
            (version) =>
                Number.isInteger(version) && version >= 1 && version <= 255
        ) ||
        new Set(offer.versions).size !== offer.versions.length
    ) {
        throw new IpcProtocolError("IPC negotiation offer is invalid");
    }
    if (
        offer.versions.includes(2) &&
        (!isUint32(offer.maxRequestFrameBytes) ||
            !isUint32(offer.maxResponseFrameBytes))
    ) {
        throw new IpcProtocolError("IPC v2 negotiation limits are invalid");
    }
    return value as IpcNegotiationRequest;
};

const containsBytesMember = (value: unknown): boolean => {
    if (value instanceof Uint8Array) {
        return true;
    }
    if (Array.isArray(value)) {
        return value.some(containsBytesMember);
    }
    if (isRecord(value)) {
        return (
            Object.prototype.hasOwnProperty.call(value, "$bytes") ||
            Object.values(value).some(containsBytesMember)
        );
    }
    return false;
};

const isBytesSentinel = (value: unknown) =>
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    Object.prototype.hasOwnProperty.call(value, "$bytes") &&
    value.$bytes === null;

const parseV2Request = (metadata: Buffer, body: Buffer): IpcRequest => {
    const value = parseUtf8JsonFrame(metadata);
    const request = parseRequestValue(value);
    if (request.op === "write") {
        if (request.args.length !== 3 || !isBytesSentinel(request.args[1])) {
            throw new IpcProtocolError(
                "IPC v2 write request requires the raw-bytes sentinel"
            );
        }
        // Remove the one permitted sentinel before checking the rest of the
        // decoded envelope for nested or out-of-position byte markers.
        request.args[1] = null;
        if (containsBytesMember(value)) {
            throw new IpcProtocolError(
                "IPC v2 write request has an unexpected bytes sentinel"
            );
        }
        request.args[1] = body;
        return request;
    }
    if (body.byteLength !== 0 || containsBytesMember(value)) {
        throw new IpcProtocolError(
            "IPC v2 request has an unexpected body or bytes sentinel"
        );
    }
    return request;
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
    let settled = false;
    const drained = new Promise<void>((resolve, reject) => {
        const onDrain = () => {
            settled = true;
            cleanup();
            resolve();
        };
        const onError = (error: Error) => {
            settled = true;
            cleanup();
            reject(error);
        };
        const onClose = () => {
            settled = true;
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
    if (accepted && !settled) {
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
    options: SharedFsIpcServerOptions = {}
): Promise<SharedFsIpcServer> => {
    const limits = resolveIpcOptions(options);
    const profile = options.profile;
    const sockets = new Set<Socket>();
    const server: Server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        void serveSocket(socket, backend, limits, profile).catch(() => {
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
        readdir: (path, readdirOptions?: SharedFsReaddirOptions) =>
            request(
                "readdir",
                readdirOptions === undefined ? [path] : [path, readdirOptions]
            ) as Promise<any>,
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
    limits: ResolvedSharedFsIpcOptions,
    profile?: SharedFsMountProfileSink
) => {
    const reader = new BoundedIpcByteReader(
        socket,
        limits.maxRequestFrameBytes
    );

    let firstFrame: Buffer | undefined;
    for (;;) {
        firstFrame = await reader.readLine();
        if (firstFrame === undefined) {
            return;
        }
        if (firstFrame.byteLength !== 0) {
            break;
        }
    }

    let initialValue: unknown;
    try {
        initialValue = parseJsonFrame(firstFrame);
    } catch {
        socket.destroy();
        return;
    }

    let negotiation: IpcNegotiationRequest | undefined;
    try {
        negotiation = parseNegotiationRequest(initialValue);
    } catch {
        socket.destroy();
        return;
    }

    if (!negotiation) {
        if (firstFrame.byteLength > limits.maxRequestFrameBytes) {
            socket.destroy();
            return;
        }
        let request: IpcRequest;
        try {
            request = parseRequestValue(initialValue);
        } catch {
            socket.destroy();
            return;
        }
        await serveV1Requests(
            socket,
            reader,
            backend,
            limits,
            profile,
            request
        );
        return;
    }

    if (firstFrame.byteLength > SHARED_FS_IPC_NEGOTIATION_MAX_BYTES) {
        socket.destroy();
        return;
    }
    if (reader.bufferedByteLength !== 0) {
        // The peer must wait for the selected-version acknowledgement before
        // writing bytes whose framing depends on that selection.
        socket.destroy();
        return;
    }

    const selectedVersion = negotiation.args[0].versions.find(
        (version) => version === 2 || version === 1
    );
    if (selectedVersion === 2) {
        const offer = negotiation.args[0];
        const v2Limits: IpcV2Limits = {
            maxRequestFrameBytes: Math.min(
                limits.maxRequestFrameBytes,
                offer.maxRequestFrameBytes!
            ),
            maxResponseFrameBytes: Math.min(
                limits.maxResponseFrameBytes,
                offer.maxResponseFrameBytes!
            ),
            maxMetadataBytes: 1,
        };
        v2Limits.maxMetadataBytes = Math.min(
            SHARED_FS_IPC_V2_MAX_METADATA_BYTES,
            v2Limits.maxRequestFrameBytes,
            v2Limits.maxResponseFrameBytes
        );
        const acknowledgement = serializeJsonFrame(
            {
                id: negotiation.id,
                ok: true,
                result: {
                    protocol: SHARED_FS_IPC_PROTOCOL,
                    version: 2,
                    nonce: offer.nonce,
                    ...v2Limits,
                },
            },
            SHARED_FS_IPC_NEGOTIATION_MAX_BYTES
        );
        if (!acknowledgement) {
            socket.destroy();
            return;
        }
        await writeFrame(socket, acknowledgement);
        await serveV2Requests(socket, reader, backend, v2Limits, profile);
        return;
    }

    if (selectedVersion === 1) {
        const acknowledgement = serializeJsonFrame(
            {
                id: negotiation.id,
                ok: true,
                result: {
                    protocol: SHARED_FS_IPC_PROTOCOL,
                    version: 1,
                    nonce: negotiation.args[0].nonce,
                },
            },
            SHARED_FS_IPC_NEGOTIATION_MAX_BYTES
        );
        if (!acknowledgement) {
            socket.destroy();
            return;
        }
        await writeFrame(socket, acknowledgement);
        await serveV1Requests(socket, reader, backend, limits, profile);
        return;
    }

    const unsupported = serializeJsonFrame(
        {
            id: negotiation.id,
            ok: false,
            error: {
                code: "EPROTONOSUPPORT",
                message: "No offered IPC protocol version is supported",
            },
        },
        SHARED_FS_IPC_NEGOTIATION_MAX_BYTES
    );
    if (unsupported) {
        await writeFrame(socket, unsupported);
    }
    socket.end();
};

const invokeBackend = async (
    backend: SharedFsMountBackend,
    request: IpcRequest,
    profile: SharedFsMountProfileSink | undefined,
    protocol: "v1" | "v2"
) => {
    const method = backend[request.op] as (
        ...args: unknown[]
    ) => Promise<unknown>;
    if (!profile) return method.apply(backend, request.args);
    return profileSharedFsMountOperation(
        profile,
        {
            source: "node-daemon",
            phase: "ipc.service",
            operation: request.op,
            detail: { requestId: request.id, protocol },
        },
        () => method.apply(backend, request.args)
    );
};

const errorResponse = (id: number, error: unknown): IpcResponse => ({
    id,
    ok: false,
    error: {
        code: error instanceof SharedFsBackendError ? error.code : undefined,
        message: error instanceof Error ? error.message : String(error),
    },
});

const serveV1Requests = async (
    socket: Socket,
    reader: BoundedIpcByteReader,
    backend: SharedFsMountBackend,
    limits: ResolvedSharedFsIpcOptions,
    profile?: SharedFsMountProfileSink,
    initialRequest?: IpcRequest
) => {
    let nextRequest = initialRequest;
    for (;;) {
        let request: IpcRequest;
        if (nextRequest) {
            request = nextRequest;
            nextRequest = undefined;
        } else {
            const frame = await reader.readLine();
            if (frame === undefined) {
                return;
            }
            if (frame.byteLength === 0) {
                continue;
            }
            if (frame.byteLength > limits.maxRequestFrameBytes) {
                socket.destroy();
                return;
            }
            try {
                request = parseRequest(frame);
            } catch {
                socket.destroy();
                return;
            }
        }

        let response: IpcResponse;
        try {
            const args = decodeBytes(request.args) as unknown[];
            const result = await invokeBackend(
                backend,
                { ...request, args },
                profile,
                "v1"
            );
            response = {
                id: request.id,
                ok: true,
                result: encodeResult(result),
            };
        } catch (error) {
            response = errorResponse(request.id, error);
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

const serveV2Requests = async (
    socket: Socket,
    reader: BoundedIpcByteReader,
    backend: SharedFsMountBackend,
    limits: IpcV2Limits,
    profile?: SharedFsMountProfileSink
) => {
    for (;;) {
        const frame = await readIpcV2Frame(
            reader,
            IpcV2FrameKind.Request,
            limits.maxRequestFrameBytes,
            limits.maxMetadataBytes
        );
        let request: IpcRequest;
        try {
            request = parseV2Request(frame.metadata, frame.body);
        } catch {
            socket.destroy();
            return;
        }

        let response: IpcResponse;
        let responseBody: Uint8Array = Buffer.alloc(0);
        try {
            const result = await invokeBackend(backend, request, profile, "v2");
            if (request.op === "read") {
                if (!(result instanceof Uint8Array)) {
                    throw new Error("IPC read backend did not return bytes");
                }
                responseBody = Buffer.isBuffer(result)
                    ? result
                    : Buffer.from(
                          result.buffer,
                          result.byteOffset,
                          result.byteLength
                      );
                response = {
                    id: request.id,
                    ok: true,
                    result: { $bytes: null },
                };
            } else {
                if (
                    containsBytesMember(result) ||
                    result instanceof Uint8Array
                ) {
                    throw new Error(
                        "IPC v2 only permits byte results from read"
                    );
                }
                response = {
                    id: request.id,
                    ok: true,
                    result: result === undefined ? null : result,
                };
            }
        } catch (error) {
            response = errorResponse(request.id, error);
            responseBody = Buffer.alloc(0);
        }

        let responseFrame;
        try {
            responseFrame = encodeIpcV2Frame(
                IpcV2FrameKind.Response,
                response,
                responseBody,
                limits.maxResponseFrameBytes,
                limits.maxMetadataBytes
            );
        } catch (error) {
            if (!(error instanceof IpcV2FrameTooLargeError)) {
                throw error;
            }
            try {
                responseFrame = encodeIpcV2Frame(
                    IpcV2FrameKind.Response,
                    errorResponse(
                        request.id,
                        new SharedFsBackendError(
                            "EIO",
                            `IPC response exceeds ${limits.maxResponseFrameBytes} byte limit`
                        )
                    ),
                    Buffer.alloc(0),
                    limits.maxResponseFrameBytes,
                    limits.maxMetadataBytes
                );
            } catch {
                socket.destroy();
                return;
            }
        }
        await writeIpcV2Frame(socket, responseFrame);
    }
};
