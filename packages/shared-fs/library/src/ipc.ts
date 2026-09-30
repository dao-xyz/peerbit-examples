import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
    SharedFsBackendError,
    type SharedFsMountBackend,
} from "./mount-backend.js";
import { BoundedIpcByteReader } from "./ipc-byte-reader.js";
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
    /**
     * The secret each connection must present in its negotiation offer. Pass
     * it to the adapter in its environment, as `peerbit-fs mount` does in
     * PEERBIT_SHARED_FS_IPC_TOKEN, never in its arguments, which other local
     * users can list.
     */
    token: string;
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
    token?: unknown;
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
 * Default per-direction IPC v2 frame limit (metadata plus raw body bytes). It
 * leaves ample room for normal mount reads and writes while bounding a
 * malformed or runaway frame. Each connection negotiates the lower of this
 * server's and the client's offered limit.
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
    "setattr",
    "symlink",
    "readlink",
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

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/**
 * Compares digests, so the time taken reveals nothing about the token,
 * whatever the length of the presented value.
 */
const presentsToken = (offer: IpcNegotiationOffer, tokenDigest: Buffer) =>
    typeof offer.token === "string" &&
    timingSafeEqual(sha256(offer.token), tokenDigest);

/**
 * Without an endpoint the server listens where the native adapter connects:
 * on Linux a Unix socket in a new owner-only directory that close() removes,
 * elsewhere (macOS and Windows) TCP loopback, which any local user can reach.
 * On every endpoint a connection must present the server's `token` before it
 * can run an operation. The directory is made under /tmp, not os.tmpdir(): a
 * longer TMPDIR can push the path past sun_path's 108 bytes, and bind would
 * silently truncate it.
 * macOS stays on TCP: its Unix sockets buffer 8 KiB per direction, which Node
 * cannot raise, and a 128 KiB read took 1.7 times as long as over TCP.
 */
export const createSharedFsIpcServer = async (
    backend: SharedFsMountBackend,
    endpoint?: SharedFsIpcEndpoint,
    options: SharedFsIpcServerOptions = {}
): Promise<SharedFsIpcServer> => {
    const limits = resolveIpcOptions(options);
    const token = randomBytes(32).toString("base64url");
    const tokenDigest = sha256(token);
    const privateDirectory =
        endpoint === undefined && process.platform === "linux"
            ? await mkdtemp("/tmp/pbfs-")
            : undefined;
    endpoint ??= privateDirectory
        ? join(privateDirectory, "ipc.sock")
        : "tcp://127.0.0.1:0";
    const removePrivateDirectory = async () => {
        if (privateDirectory) {
            await rm(privateDirectory, { recursive: true, force: true });
        }
    };
    const profile = options.profile;
    const sockets = new Set<Socket>();
    const server: Server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        void serveSocket(socket, backend, limits, tokenDigest, profile).catch(
            () => {
                // A client abort (ECONNRESET/EPIPE), malformed frame, or local
                // response failure must never take the mount daemon down.
                socket.destroy();
            }
        );
    });

    const resolvedEndpoint = await listenServer(server, endpoint).catch(
        async (error: unknown) => {
            await removePrivateDirectory();
            throw error;
        }
    );
    let closing: Promise<void> | undefined;

    return {
        endpoint: resolvedEndpoint,
        token,
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
            }).finally(removePrivateDirectory);
            return closing;
        },
    };
};

const serveSocket = async (
    socket: Socket,
    backend: SharedFsMountBackend,
    limits: ResolvedSharedFsIpcOptions,
    tokenDigest: Buffer,
    profile?: SharedFsMountProfileSink
) => {
    const reader = new BoundedIpcByteReader(
        socket,
        limits.maxRequestFrameBytes
    );
    // The adapter reports its TCP local port; the pair is the cross-process
    // connection key for joining `ipc.service` with `ipc.roundTrip` records.
    const serviceProfile: IpcServiceProfile | undefined = profile
        ? { sink: profile, remotePort: socket.remotePort }
        : undefined;

    // The handshake line has its own fixed bound, independent of the binary
    // frame limits it negotiates.
    let firstFrame: Buffer | undefined;
    for (;;) {
        firstFrame = await reader.readLine(SHARED_FS_IPC_NEGOTIATION_MAX_BYTES);
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
        if (!isRecord(initialValue)) {
            socket.destroy();
            return;
        }
        // IPC v1 is retired. An un-negotiated first operation comes from an
        // adapter built before IPC v2; it is never dispatched. Answer with an
        // ordinary JSONL error, which such an adapter surfaces, then close.
        await rejectConnection(
            socket,
            Number.isSafeInteger(initialValue.id) &&
                (initialValue.id as number) >= 0
                ? (initialValue.id as number)
                : 0,
            "EPROTONOSUPPORT",
            SHARED_FS_IPC_V1_RETIRED_MESSAGE
        );
        return;
    }

    if (reader.bufferedByteLength !== 0) {
        // The peer must wait for the selected-version acknowledgement before
        // writing bytes whose framing depends on that selection.
        socket.destroy();
        return;
    }

    const offer = negotiation.args[0];
    if (!presentsToken(offer, tokenDigest)) {
        await rejectConnection(
            socket,
            negotiation.id,
            "EACCES",
            SHARED_FS_IPC_TOKEN_REJECTED_MESSAGE
        );
        return;
    }
    if (!offer.versions.includes(2)) {
        await rejectConnection(
            socket,
            negotiation.id,
            "EPROTONOSUPPORT",
            "No offered IPC protocol version is supported"
        );
        return;
    }

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
    await serveV2Requests(socket, reader, backend, v2Limits, serviceProfile);
};

/**
 * Sent, as a JSONL error, to a peer whose first line is an ordinary operation
 * instead of the IPC v2 negotiation.
 */
const SHARED_FS_IPC_V1_RETIRED_MESSAGE =
    "IPC v1 is retired: this server requires the IPC v2 negotiation before any filesystem operation. The native adapter is too old (shared-fs-native 0.13.15 or earlier); install the adapter release matching this CLI with `peerbit-fs install-adapter --force`, and stop passing an older adapter with --native-adapter or PEERBIT_SHARED_FS_NATIVE_ADAPTER.";

/** Sent, as a JSONL error, to a peer whose offer lacks the server's token. */
const SHARED_FS_IPC_TOKEN_REJECTED_MESSAGE =
    "IPC authentication failed: the negotiation did not present this server's token. `peerbit-fs mount` passes it to the native adapter it starts in PEERBIT_SHARED_FS_IPC_TOKEN, and an adapter from an older release does not send it; install the adapter release matching this CLI with `peerbit-fs install-adapter --force`, and stop passing an older adapter with --native-adapter or PEERBIT_SHARED_FS_NATIVE_ADAPTER.";

const rejectConnection = async (
    socket: Socket,
    id: number,
    code: "EACCES" | "EPROTONOSUPPORT",
    message: string
) => {
    const rejection = serializeJsonFrame(
        {
            id,
            ok: false,
            error: { code, message },
        } satisfies IpcResponse,
        SHARED_FS_IPC_NEGOTIATION_MAX_BYTES
    );
    if (rejection) {
        await writeFrame(socket, rejection);
    }
    socket.end();
};

type IpcServiceProfile = {
    sink: SharedFsMountProfileSink;
    remotePort?: number;
};

/** The code the adapter receives for a failed request (see errorResponse). */
const ipcServiceErrorCode = (error: unknown) =>
    error instanceof SharedFsBackendError ? error.code : "EIO";

const invokeBackend = async (
    backend: SharedFsMountBackend,
    request: IpcRequest,
    profile: IpcServiceProfile | undefined
) => {
    const protocol = "v2";
    const method = backend[request.op] as (
        ...args: unknown[]
    ) => Promise<unknown>;
    if (!profile) return method.apply(backend, request.args);
    return profileSharedFsMountOperation(
        profile.sink,
        {
            source: "node-daemon",
            phase: "ipc.service",
            operation: request.op,
            detail:
                profile.remotePort === undefined
                    ? { requestId: request.id, protocol }
                    : {
                          requestId: request.id,
                          protocol,
                          remotePort: profile.remotePort,
                      },
        },
        () => method.apply(backend, request.args),
        ipcServiceErrorCode
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

const serveV2Requests = async (
    socket: Socket,
    reader: BoundedIpcByteReader,
    backend: SharedFsMountBackend,
    limits: IpcV2Limits,
    profile?: IpcServiceProfile
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
            const result = await invokeBackend(backend, request, profile);
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
