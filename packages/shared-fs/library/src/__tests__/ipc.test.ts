import { EventEmitter, once } from "node:events";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createConnection, createServer, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createSharedFsIpcClient, createSharedFsIpcServer } from "../ipc.js";
import { BoundedIpcByteReader } from "../ipc-byte-reader.js";
import {
    encodeIpcV2Frame,
    IpcV2FrameKind,
    readIpcV2Frame,
    SHARED_FS_IPC_NEGOTIATE_OP,
    SHARED_FS_IPC_PROTOCOL,
    SHARED_FS_IPC_V2_MAX_METADATA_BYTES,
    writeIpcV2Frame,
} from "../ipc-v2.js";
import type { SharedFsMountBackend } from "../mount-backend.js";

const backendWith = (
    methods: Partial<SharedFsMountBackend>
): SharedFsMountBackend => methods as SharedFsMountBackend;

const execFileAsync = promisify(execFile);

const connect = async (endpoint: string) => {
    const url = new URL(endpoint);
    const socket = createConnection({
        host: url.hostname,
        port: Number(url.port),
    });
    await once(socket, "connect");
    return socket;
};

const readJsonLines = (socket: Socket, count: number) =>
    new Promise<Record<string, unknown>[]>((resolve, reject) => {
        let buffered = Buffer.alloc(0);
        const responses: Record<string, unknown>[] = [];
        const cleanup = () => {
            socket.off("data", onData);
            socket.off("error", onError);
            socket.off("close", onClose);
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        const onClose = () => {
            cleanup();
            reject(new Error("IPC socket closed before all responses arrived"));
        };
        const onData = (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk]);
            for (;;) {
                const newline = buffered.indexOf(0x0a);
                if (newline === -1) {
                    break;
                }
                responses.push(
                    JSON.parse(buffered.subarray(0, newline).toString("utf8"))
                );
                buffered = buffered.subarray(newline + 1);
                if (responses.length === count) {
                    cleanup();
                    resolve(responses);
                    return;
                }
            }
        };
        socket.on("data", onData);
        socket.once("error", onError);
        socket.once("close", onClose);
    });

const closed = (socket: Socket) => {
    const result = new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
    });
    socket.on("error", () => {});
    return result;
};

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
};

const negotiateV2 = async (
    socket: Socket,
    offer: Record<string, unknown> = {}
) => {
    const reader = new BoundedIpcByteReader(socket, 64 * 1024 * 1024);
    const request = {
        id: 0,
        op: SHARED_FS_IPC_NEGOTIATE_OP,
        args: [
            {
                protocol: SHARED_FS_IPC_PROTOCOL,
                versions: [2, 1],
                nonce: "test-nonce",
                maxRequestFrameBytes: 64 * 1024 * 1024,
                maxResponseFrameBytes: 64 * 1024 * 1024,
                ...offer,
            },
        ],
    };
    socket.write(`${JSON.stringify(request)}\n`);
    const line = await reader.readLine();
    if (!line) throw new Error("IPC server omitted negotiation response");
    const response = JSON.parse(line.toString("utf8"));
    if (!response.ok || response.result?.version !== 2) {
        throw new Error(`IPC server rejected v2: ${line.toString("utf8")}`);
    }
    return {
        reader,
        limits: {
            maxRequestFrameBytes: response.result.maxRequestFrameBytes,
            maxResponseFrameBytes: response.result.maxResponseFrameBytes,
            maxMetadataBytes: response.result.maxMetadataBytes,
        },
    };
};

const decodeV2Response = async (
    reader: BoundedIpcByteReader,
    limits: {
        maxResponseFrameBytes: number;
        maxMetadataBytes: number;
    }
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

describe("shared-fs IPC framing", () => {
    it("keeps additive readdir options compatible with legacy backends", async () => {
        const readdir = vi.fn(async (_path: string) => [
            { name: "legacy.txt", kind: "file" as const },
        ]);
        const server = await createSharedFsIpcServer(
            backendWith({ readdir }),
            "tcp://127.0.0.1:0"
        );
        try {
            const client = createSharedFsIpcClient(server.endpoint);
            await expect(client.readdir("/")).resolves.toEqual([
                { name: "legacy.txt", kind: "file" },
            ]);
            await expect(
                client.readdir("/", { includeStats: true })
            ).resolves.toEqual([{ name: "legacy.txt", kind: "file" }]);

            expect(readdir.mock.calls[0]).toEqual(["/"]);
            // JavaScript legacy implementations ignore this extra argument.
            expect(readdir.mock.calls[1]).toEqual([
                "/",
                { includeStats: true },
            ]);
        } finally {
            await server.close();
        }
    });

    it("reassembles a UTF-8 request split inside a multibyte character", async () => {
        const getattr = vi.fn(async (path: string) => ({ path }));
        const backend = backendWith({ getattr });
        const payload = Buffer.from(
            JSON.stringify({ id: 1, op: "getattr", args: ["/😀.txt"] }),
            "utf8"
        );
        const server = await createSharedFsIpcServer(
            backend,
            "tcp://127.0.0.1:0",
            { maxRequestFrameBytes: payload.byteLength }
        );
        const socket = await connect(server.endpoint);
        try {
            const response = readJsonLines(socket, 1);
            const emoji = Buffer.from("😀", "utf8");
            const splitAt = payload.indexOf(emoji) + 1;
            socket.write(payload.subarray(0, splitAt));
            await new Promise<void>((resolve) => setImmediate(resolve));
            socket.write(
                Buffer.concat([payload.subarray(splitAt), Buffer.from("\n")])
            );

            await expect(response).resolves.toEqual([
                { id: 1, ok: true, result: { path: "/😀.txt" } },
            ]);
            expect(getattr).toHaveBeenCalledWith("/😀.txt");
        } finally {
            socket.destroy();
            await server.close();
        }
    });

    it("accepts default-size binary frames and enforces the exact encoded request limit", async () => {
        const write = vi.fn(
            async (_handle: number, data: Uint8Array) => data.byteLength
        );
        const data = Buffer.alloc(1024 * 1024, 0xa5);
        const read = vi.fn(async () => data);
        const backend = backendWith({ write, read });
        const payload = Buffer.from(
            JSON.stringify({
                id: 1,
                op: "write",
                args: [7, { $bytes: data.toString("base64") }, 0],
            })
        );
        const server = await createSharedFsIpcServer(
            backend,
            "tcp://127.0.0.1:0"
        );
        try {
            const defaultClient = createSharedFsIpcClient(server.endpoint);
            const roundTrip = await defaultClient.read(7, data.byteLength, 0);
            expect(roundTrip.byteLength).toBe(data.byteLength);
            expect(roundTrip[0]).toBe(0xa5);
            expect(roundTrip.at(-1)).toBe(0xa5);

            const exactClient = createSharedFsIpcClient(server.endpoint, {
                maxRequestFrameBytes: payload.byteLength,
            });
            await expect(exactClient.write(7, data, 0)).resolves.toBe(
                data.byteLength
            );

            const undersizedClient = createSharedFsIpcClient(server.endpoint, {
                maxRequestFrameBytes: payload.byteLength - 1,
            });
            await expect(undersizedClient.write(7, data, 0)).rejects.toThrow(
                `IPC request exceeds ${payload.byteLength - 1} byte limit`
            );
            expect(write).toHaveBeenCalledTimes(1);
            expect(read).toHaveBeenCalledTimes(1);
        } finally {
            await server.close();
        }
    });

    it("accepts an exact response limit and rejects one extra byte", async () => {
        const result = { path: "/😀.txt" };
        const payload = Buffer.from(
            JSON.stringify({ id: 1, ok: true, result }),
            "utf8"
        );
        const listener = createServer((socket) => {
            socket.once("data", () => {
                socket.write(Buffer.concat([payload, Buffer.from("\n")]));
            });
        });
        await new Promise<void>((resolve, reject) => {
            listener.once("error", reject);
            listener.listen(0, "127.0.0.1", () => resolve());
        });
        const address = listener.address();
        if (address == null || typeof address === "string") {
            throw new Error("test IPC server did not expose a TCP address");
        }
        const endpoint = `tcp://127.0.0.1:${address.port}`;
        try {
            const exactClient = createSharedFsIpcClient(endpoint, {
                maxResponseFrameBytes: payload.byteLength,
            });
            await expect(exactClient.getattr("/exact")).resolves.toEqual(
                result
            );

            const undersizedClient = createSharedFsIpcClient(endpoint, {
                maxResponseFrameBytes: payload.byteLength - 1,
            });
            await expect(
                undersizedClient.getattr("/oversized")
            ).rejects.toThrow(
                `IPC response exceeds ${payload.byteLength - 1} byte limit`
            );
        } finally {
            await new Promise<void>((resolve, reject) => {
                listener.close((error) => (error ? reject(error) : resolve()));
            });
        }
    });

    it("rejects trailing bytes in the response chunk", async () => {
        const listener = createServer((socket) => {
            socket.once("data", () => {
                socket.write(
                    `${JSON.stringify({ id: 1, ok: true, result: { path: "/" } })}\ntrailing`
                );
            });
        });
        await new Promise<void>((resolve, reject) => {
            listener.once("error", reject);
            listener.listen(0, "127.0.0.1", () => resolve());
        });
        const address = listener.address();
        if (address == null || typeof address === "string") {
            throw new Error("test IPC server did not expose a TCP address");
        }
        try {
            const client = createSharedFsIpcClient(
                `tcp://127.0.0.1:${address.port}`
            );
            await expect(client.getattr("/")).rejects.toThrow(
                "IPC server sent trailing bytes after its response"
            );
        } finally {
            await new Promise<void>((resolve, reject) => {
                listener.close((error) => (error ? reject(error) : resolve()));
            });
        }
    });

    it("executes pipelined requests serially and responds in order", async () => {
        const firstStarted = deferred();
        const releaseFirst = deferred();
        const calls: string[] = [];
        const backend = backendWith({
            getattr: async (path) => {
                calls.push(path);
                if (path === "/first") {
                    firstStarted.resolve();
                    await releaseFirst.promise;
                }
                return { path } as any;
            },
        });
        const server = await createSharedFsIpcServer(
            backend,
            "tcp://127.0.0.1:0"
        );
        const socket = await connect(server.endpoint);
        try {
            const responses = readJsonLines(socket, 2);
            socket.write(
                `${JSON.stringify({ id: 1, op: "getattr", args: ["/first"] })}\n${JSON.stringify({ id: 2, op: "getattr", args: ["/second"] })}\n`
            );
            await firstStarted.promise;
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(calls).toEqual(["/first"]);

            releaseFirst.resolve();
            await expect(responses).resolves.toEqual([
                { id: 1, ok: true, result: { path: "/first" } },
                { id: 2, ok: true, result: { path: "/second" } },
            ]);
            expect(calls).toEqual(["/first", "/second"]);
        } finally {
            socket.destroy();
            await server.close();
        }
    });

    it("closes an oversized unterminated peer while continuing to serve others", async () => {
        const getattr = vi.fn(async (path: string) => ({ path }));
        const backend = backendWith({ getattr });
        const server = await createSharedFsIpcServer(
            backend,
            "tcp://127.0.0.1:0",
            { maxRequestFrameBytes: 64 }
        );
        const offender = await connect(server.endpoint);
        try {
            const offenderClosed = closed(offender);
            offender.write(Buffer.alloc(65, 0x61));
            await offenderClosed;

            const client = createSharedFsIpcClient(server.endpoint);
            await expect(client.getattr("/healthy")).resolves.toEqual({
                path: "/healthy",
            });
            expect(getattr).toHaveBeenCalledTimes(1);
        } finally {
            offender.destroy();
            await server.close();
        }
    });

    it("drops malformed pipelines without executing a later mutation", async () => {
        const getattr = vi.fn(async (path: string) => ({ path }));
        const mkdir = vi.fn(async () => {});
        const backend = backendWith({ getattr, mkdir });
        const server = await createSharedFsIpcServer(
            backend,
            "tcp://127.0.0.1:0"
        );
        const offender = await connect(server.endpoint);
        try {
            const offenderClosed = closed(offender);
            offender.write(
                `${JSON.stringify({ id: "bad", op: "getattr", args: ["/"] })}\n${JSON.stringify({ id: 2, op: "mkdir", args: ["/must-not-run"] })}\n`
            );
            await offenderClosed;
            expect(mkdir).not.toHaveBeenCalled();

            const client = createSharedFsIpcClient(server.endpoint);
            await expect(client.getattr("/healthy")).resolves.toEqual({
                path: "/healthy",
            });
        } finally {
            offender.destroy();
            await server.close();
        }
    });

    it("replaces an oversized response with a bounded error frame", async () => {
        const backend = backendWith({
            getattr: async (path) =>
                path === "/large" ? { value: "x".repeat(1024) } : { path },
        });
        const maxResponseFrameBytes = 128;
        const server = await createSharedFsIpcServer(
            backend,
            "tcp://127.0.0.1:0",
            { maxResponseFrameBytes }
        );
        const socket = await connect(server.endpoint);
        try {
            const responses = readJsonLines(socket, 2);
            socket.write(
                `${JSON.stringify({ id: 1, op: "getattr", args: ["/large"] })}\n${JSON.stringify({ id: 2, op: "getattr", args: ["/small"] })}\n`
            );
            const [bounded, following] = await responses;
            expect(
                Buffer.byteLength(JSON.stringify(bounded))
            ).toBeLessThanOrEqual(maxResponseFrameBytes);
            expect(bounded).toMatchObject({
                id: 1,
                ok: false,
                error: { code: "EIO" },
            });
            expect(following).toEqual({
                id: 2,
                ok: true,
                result: { path: "/small" },
            });
        } finally {
            socket.destroy();
            await server.close();
        }
    });
});

describe("shared-fs negotiated IPC v2", () => {
    it("retains zero-copy frame bytes until the final socket write completes", async () => {
        const callbacks: Array<(error?: Error | null) => void> = [];
        const socket = Object.assign(new EventEmitter(), {
            destroyed: false,
            writable: true,
            cork: vi.fn(),
            uncork: vi.fn(),
            write: vi.fn(
                (
                    _chunk: Uint8Array,
                    callback?: (error?: Error | null) => void
                ) => {
                    if (callback) {
                        callbacks.push(callback);
                    }
                    return true;
                }
            ),
        }) as unknown as Socket;
        const frame = encodeIpcV2Frame(
            IpcV2FrameKind.Response,
            { id: 1, ok: true },
            Buffer.from("retained"),
            1024,
            1024
        );

        let resolved = false;
        const write = writeIpcV2Frame(socket, frame).then(() => {
            resolved = true;
        });
        await Promise.resolve();
        expect(socket.write).toHaveBeenCalledTimes(3);
        expect(callbacks).toHaveLength(1);
        expect(resolved).toBe(false);

        callbacks[0]();
        await write;
        expect(resolved).toBe(true);
        expect(socket.cork).toHaveBeenCalledOnce();
        expect(socket.uncork).toHaveBeenCalledOnce();
    });

    it("transfers exact binary bytes between the real Go client and Node server", async () => {
        const readPayload = Buffer.from([0, 10, 255, 1, 2, 3]);
        const expectedWrite = Buffer.from([3, 2, 1, 255, 10, 0]);
        const write = vi.fn(async (_handle: number, data: Uint8Array) => {
            expect(Buffer.from(data)).toEqual(expectedWrite);
            return data.byteLength;
        });
        const server = await createSharedFsIpcServer(
            backendWith({
                getattr: async (path) => ({ path }) as any,
                read: async () => readPayload,
                write,
            }),
            "tcp://127.0.0.1:0"
        );
        try {
            await execFileAsync(
                "go",
                [
                    "test",
                    "-run",
                    "^TestIPCClientNodeV2Interop$",
                    "-count=1",
                    ".",
                ],
                {
                    cwd: new URL("../../../native/", import.meta.url),
                    env: {
                        ...process.env,
                        PEERBIT_SHARED_FS_NODE_V2_TEST_ENDPOINT:
                            server.endpoint,
                    },
                }
            );
            expect(write).toHaveBeenCalledOnce();
        } finally {
            await server.close();
        }
    });

    it("consumes the shared request vectors across fragmented negotiation and coalesced binary frames", async () => {
        const vectors = JSON.parse(
            await readFile(
                new URL(
                    "../../../protocol/ipc-v2-vectors.json",
                    import.meta.url
                ),
                "utf8"
            )
        ) as {
            negotiation: { name: string; jsonLineHex: string }[];
            frames: {
                name: string;
                frameHex: string;
            }[];
        };
        const getattr = vi.fn(async (path: string) => ({ path }));
        const write = vi.fn(
            async (_handle: number, bytes: Uint8Array) => bytes.byteLength
        );
        const server = await createSharedFsIpcServer(
            backendWith({ getattr, write }),
            "tcp://127.0.0.1:0"
        );
        const socket = await connect(server.endpoint);
        const reader = new BoundedIpcByteReader(socket, 64 * 1024 * 1024);
        try {
            const negotiation = Buffer.from(
                vectors.negotiation.find(
                    ({ name }) => name === "version-offer"
                )!.jsonLineHex,
                "hex"
            );
            for (const byte of negotiation) {
                socket.write(Buffer.from([byte]));
            }
            const acknowledgement = await reader.readLine();
            expect(JSON.parse(acknowledgement!.toString("utf8"))).toEqual({
                id: 1,
                ok: true,
                result: {
                    protocol: SHARED_FS_IPC_PROTOCOL,
                    version: 2,
                    nonce: "AAAAAAAAAAAAAAAAAAAAAA",
                    maxRequestFrameBytes: 64 * 1024 * 1024,
                    maxResponseFrameBytes: 64 * 1024 * 1024,
                    maxMetadataBytes: SHARED_FS_IPC_V2_MAX_METADATA_BYTES,
                },
            });

            const requestWire = Buffer.concat(
                ["getattr-request", "write-request"].map((name) =>
                    Buffer.from(
                        vectors.frames.find((frame) => frame.name === name)!
                            .frameHex,
                        "hex"
                    )
                )
            );
            socket.write(requestWire);
            const limits = {
                maxResponseFrameBytes: 64 * 1024 * 1024,
                maxMetadataBytes: SHARED_FS_IPC_V2_MAX_METADATA_BYTES,
            };
            await expect(decodeV2Response(reader, limits)).resolves.toEqual({
                metadata: {
                    id: 1,
                    ok: true,
                    result: { path: "/" },
                },
                body: Buffer.alloc(0),
            });
            await expect(decodeV2Response(reader, limits)).resolves.toEqual({
                metadata: { id: 2, ok: true, result: 3 },
                body: Buffer.alloc(0),
            });
            expect(getattr).toHaveBeenCalledWith("/");
            expect(write).toHaveBeenCalledOnce();
            expect(Buffer.from(write.mock.calls[0][1])).toEqual(
                Buffer.from([0x00, 0x0a, 0xff])
            );
        } finally {
            socket.destroy();
            await server.close();
        }
    });

    it("returns successful read bytes only in the raw frame body", async () => {
        const payload = Buffer.from([0, 10, 255, 1, 2, 3]);
        const server = await createSharedFsIpcServer(
            backendWith({ read: vi.fn(async () => payload) }),
            "tcp://127.0.0.1:0"
        );
        const socket = await connect(server.endpoint);
        try {
            const { reader, limits } = await negotiateV2(socket);
            const request = encodeIpcV2Frame(
                IpcV2FrameKind.Request,
                { id: 7, op: "read", args: [1, payload.byteLength, 0] },
                Buffer.alloc(0),
                limits.maxRequestFrameBytes,
                limits.maxMetadataBytes
            );
            for (const byte of Buffer.concat([
                request.header,
                request.metadata,
            ])) {
                socket.write(Buffer.from([byte]));
            }
            await expect(decodeV2Response(reader, limits)).resolves.toEqual({
                metadata: {
                    id: 7,
                    ok: true,
                    result: { $bytes: null },
                },
                body: payload,
            });
        } finally {
            socket.destroy();
            await server.close();
        }
    });

    it("honors a version 1 preference and pins the connection to JSONL", async () => {
        const getattr = vi.fn(async (path: string) => ({ path }));
        const server = await createSharedFsIpcServer(
            backendWith({ getattr }),
            "tcp://127.0.0.1:0"
        );
        const socket = await connect(server.endpoint);
        try {
            const reader = new BoundedIpcByteReader(socket, 64 * 1024);
            socket.write(
                `${JSON.stringify({
                    id: 3,
                    op: SHARED_FS_IPC_NEGOTIATE_OP,
                    args: [
                        {
                            protocol: SHARED_FS_IPC_PROTOCOL,
                            versions: [1, 2],
                            nonce: "v1-only",
                            maxRequestFrameBytes: 64 * 1024 * 1024,
                            maxResponseFrameBytes: 64 * 1024 * 1024,
                        },
                    ],
                })}\n`
            );
            await expect(reader.readLine()).resolves.toEqual(
                Buffer.from(
                    JSON.stringify({
                        id: 3,
                        ok: true,
                        result: {
                            protocol: SHARED_FS_IPC_PROTOCOL,
                            version: 1,
                            nonce: "v1-only",
                        },
                    })
                )
            );
            socket.write(
                `${JSON.stringify({ id: 4, op: "getattr", args: ["/v1"] })}\n`
            );
            await expect(reader.readLine()).resolves.toEqual(
                Buffer.from(
                    JSON.stringify({
                        id: 4,
                        ok: true,
                        result: { path: "/v1" },
                    })
                )
            );
        } finally {
            socket.destroy();
            await server.close();
        }
    });

    it("rejects an unsupported offer without dispatching a filesystem operation", async () => {
        const getattr = vi.fn(async () => ({ path: "/" }));
        const server = await createSharedFsIpcServer(
            backendWith({ getattr }),
            "tcp://127.0.0.1:0"
        );
        const socket = await connect(server.endpoint);
        try {
            const response = readJsonLines(socket, 1);
            socket.write(
                `${JSON.stringify({
                    id: 9,
                    op: SHARED_FS_IPC_NEGOTIATE_OP,
                    args: [
                        {
                            protocol: SHARED_FS_IPC_PROTOCOL,
                            versions: [3],
                            nonce: "unsupported",
                        },
                    ],
                })}\n`
            );
            await expect(response).resolves.toEqual([
                {
                    id: 9,
                    ok: false,
                    error: {
                        code: "EPROTONOSUPPORT",
                        message: "No offered IPC protocol version is supported",
                    },
                },
            ]);
            expect(getattr).not.toHaveBeenCalled();
        } finally {
            socket.destroy();
            await server.close();
        }
    });

    it.each([
        {
            name: "bad magic before a coalesced mutation",
            build: (limits: {
                maxRequestFrameBytes: number;
                maxMetadataBytes: number;
            }) => {
                const malformed = encodeIpcV2Frame(
                    IpcV2FrameKind.Request,
                    { id: 1, op: "getattr", args: ["/"] },
                    Buffer.alloc(0),
                    limits.maxRequestFrameBytes,
                    limits.maxMetadataBytes
                );
                malformed.header[0] = 0x58;
                const later = encodeIpcV2Frame(
                    IpcV2FrameKind.Request,
                    { id: 2, op: "mkdir", args: ["/must-not-run"] },
                    Buffer.alloc(0),
                    limits.maxRequestFrameBytes,
                    limits.maxMetadataBytes
                );
                return Buffer.concat([
                    malformed.header,
                    malformed.metadata,
                    later.header,
                    later.metadata,
                ]);
            },
        },
        {
            name: "oversized lengths without a body",
            build: (limits: {
                maxRequestFrameBytes: number;
                maxMetadataBytes: number;
            }) => {
                const header = Buffer.alloc(16);
                header.write("PBFS", 0, "ascii");
                header[4] = 2;
                header[5] = 1;
                header.writeUInt32BE(limits.maxMetadataBytes + 1, 8);
                return header;
            },
        },
        {
            name: "v1 base64 bytes inside v2 metadata",
            build: (limits: {
                maxRequestFrameBytes: number;
                maxMetadataBytes: number;
            }) => {
                const frame = encodeIpcV2Frame(
                    IpcV2FrameKind.Request,
                    {
                        id: 1,
                        op: "write",
                        args: [1, { $bytes: "YWJj" }, 0],
                    },
                    Buffer.alloc(0),
                    limits.maxRequestFrameBytes,
                    limits.maxMetadataBytes
                );
                return Buffer.concat([frame.header, frame.metadata]);
            },
        },
        {
            name: "invalid UTF-8 metadata",
            build: () => {
                const header = Buffer.alloc(16);
                header.write("PBFS", 0, "ascii");
                header[4] = 2;
                header[5] = 1;
                header.writeUInt32BE(1, 8);
                return Buffer.concat([header, Buffer.from([0xff])]);
            },
        },
        {
            name: "body on a non-write request",
            build: (limits: {
                maxRequestFrameBytes: number;
                maxMetadataBytes: number;
            }) => {
                const frame = encodeIpcV2Frame(
                    IpcV2FrameKind.Request,
                    { id: 1, op: "getattr", args: ["/"] },
                    Buffer.from([1]),
                    limits.maxRequestFrameBytes,
                    limits.maxMetadataBytes
                );
                return Buffer.concat([
                    frame.header,
                    frame.metadata,
                    frame.body,
                ]);
            },
        },
    ])("closes $name", async ({ build }) => {
        const mkdir = vi.fn(async () => {});
        const write = vi.fn(async () => 3);
        const server = await createSharedFsIpcServer(
            backendWith({ mkdir, write }),
            "tcp://127.0.0.1:0"
        );
        const socket = await connect(server.endpoint);
        try {
            const { limits } = await negotiateV2(socket);
            const didClose = closed(socket);
            socket.write(build(limits));
            await didClose;
            expect(mkdir).not.toHaveBeenCalled();
            expect(write).not.toHaveBeenCalled();
        } finally {
            socket.destroy();
            await server.close();
        }
    });
});
