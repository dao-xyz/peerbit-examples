import { EventEmitter, once } from "node:events";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createConnection, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createSharedFsIpcServer } from "../ipc.js";
import { BoundedIpcByteReader } from "../ipc-byte-reader.js";
import {
    encodeIpcV2Frame,
    IpcV2FrameKind,
    SHARED_FS_IPC_NEGOTIATE_OP,
    SHARED_FS_IPC_NEGOTIATION_MAX_BYTES,
    SHARED_FS_IPC_PROTOCOL,
    SHARED_FS_IPC_V2_MAX_METADATA_BYTES,
    writeIpcV2Frame,
} from "../ipc-v2.js";
import {
    createIpcV2TestClient,
    negotiateIpcV2 as negotiateV2,
    readIpcV2Response as decodeV2Response,
} from "./ipc-v2-test-client.js";
import {
    SharedFsBackendError,
    type SharedFsMountBackend,
} from "../mount-backend.js";
import {
    openSharedFsMountProfileFile,
    type SharedFsMountProfileEvent,
} from "../mount-profile.js";

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

const requestFrame = (
    limits: { maxRequestFrameBytes: number; maxMetadataBytes: number },
    metadata: Record<string, unknown>,
    body: Uint8Array = Buffer.alloc(0)
) => {
    const frame = encodeIpcV2Frame(
        IpcV2FrameKind.Request,
        metadata,
        body,
        limits.maxRequestFrameBytes,
        limits.maxMetadataBytes
    );
    return Buffer.concat([frame.header, frame.metadata, frame.body]);
};

describe("shared-fs IPC v2 server", () => {
    it("profiles failed service calls with the code the adapter receives", async () => {
        const events: SharedFsMountProfileEvent[] = [];
        const server = await createSharedFsIpcServer(
            backendWith({
                getattr: async (path) => {
                    if (path === "/absent") {
                        throw new SharedFsBackendError("ENOENT", "absent");
                    }
                    if (path === "/settling") {
                        throw new SharedFsBackendError("EAGAIN", "settling");
                    }
                    throw Object.assign(new Error("uncoded"), {
                        code: "ENOENT",
                    });
                },
            }),
            "tcp://127.0.0.1:0",
            { profile: (event) => events.push(event) }
        );
        const client = createIpcV2TestClient(server.endpoint);
        try {
            for (const path of ["/absent", "/settling", "/uncoded"]) {
                await expect(client.getattr(path)).rejects.toBeDefined();
            }
            expect(
                events.map((event) => [event.ok, event.detail?.code])
            ).toEqual([
                [false, "ENOENT"],
                [false, "EAGAIN"],
                // The wire carries no code for non-backend errors, so the
                // adapter surfaces EIO; the profile reports the same.
                [false, "EIO"],
            ]);
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("passes additive readdir options to backends that ignore them", async () => {
        const readdir = vi.fn(async (_path: string) => [
            { name: "compact.txt", kind: "file" as const },
        ]);
        const server = await createSharedFsIpcServer(
            backendWith({ readdir }),
            "tcp://127.0.0.1:0"
        );
        const client = createIpcV2TestClient(server.endpoint);
        try {
            await expect(client.readdir("/")).resolves.toEqual([
                { name: "compact.txt", kind: "file" },
            ]);
            await expect(
                client.readdir("/", { includeStats: true })
            ).resolves.toEqual([{ name: "compact.txt", kind: "file" }]);

            expect(readdir.mock.calls[0]).toEqual(["/"]);
            // A custom backend without stat support ignores this argument.
            expect(readdir.mock.calls[1]).toEqual([
                "/",
                { includeStats: true },
            ]);
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("round-trips the metadata and symlink ops and open's create mode", async () => {
        const open = vi.fn(async () => 7);
        const setattr = vi.fn(async () => {});
        const symlink = vi.fn(async () => {});
        const readlink = vi.fn(async () => "../lib/tool.js");
        const server = await createSharedFsIpcServer(
            backendWith({ open, setattr, symlink, readlink }),
            "tcp://127.0.0.1:0"
        );
        const client = createIpcV2TestClient(server.endpoint);
        try {
            await expect(client.open("/a.sh", 0o1101, 0o755)).resolves.toBe(7);
            await expect(
                client.setattr("/a.sh", { mode: 0o644, mtimeMs: 1000 })
            ).resolves.toBeNull();
            await expect(
                client.symlink("../lib/tool.js", "/bin/tool")
            ).resolves.toBeNull();
            await expect(client.readlink("/bin/tool")).resolves.toBe(
                "../lib/tool.js"
            );
            expect(open.mock.calls).toEqual([["/a.sh", 0o1101, 0o755]]);
            expect(setattr.mock.calls).toEqual([
                ["/a.sh", { mode: 0o644, mtimeMs: 1000 }],
            ]);
            expect(symlink.mock.calls).toEqual([
                ["../lib/tool.js", "/bin/tool"],
            ]);
            expect(readlink.mock.calls).toEqual([["/bin/tool"]]);
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("reassembles metadata split inside a multibyte UTF-8 character", async () => {
        const getattr = vi.fn(async (path: string) => ({ path }));
        const server = await createSharedFsIpcServer(
            backendWith({ getattr }),
            "tcp://127.0.0.1:0"
        );
        const socket = await connect(server.endpoint);
        try {
            const { reader, limits } = await negotiateV2(socket);
            const frame = requestFrame(limits, {
                id: 1,
                op: "getattr",
                args: ["/😀.txt"],
            });
            const splitAt = frame.indexOf(Buffer.from("😀", "utf8")) + 1;
            socket.write(frame.subarray(0, splitAt));
            await new Promise<void>((resolve) => setImmediate(resolve));
            socket.write(frame.subarray(splitAt));

            await expect(decodeV2Response(reader, limits)).resolves.toEqual({
                metadata: { id: 1, ok: true, result: { path: "/😀.txt" } },
                body: Buffer.alloc(0),
            });
            expect(getattr).toHaveBeenCalledWith("/😀.txt");
        } finally {
            socket.destroy();
            await server.close();
        }
    });

    it("round-trips default-size bodies and enforces the exact negotiated request limit", async () => {
        const write = vi.fn(
            async (_handle: number, data: Uint8Array) => data.byteLength
        );
        const data = Buffer.alloc(1024 * 1024, 0xa5);
        const read = vi.fn(async () => data);
        const metadata = { id: 1, op: "write", args: [7, { $bytes: null }, 0] };
        const exactFrameBytes =
            Buffer.byteLength(JSON.stringify(metadata)) + data.byteLength;

        const defaults = await createSharedFsIpcServer(
            backendWith({ read }),
            "tcp://127.0.0.1:0"
        );
        const client = createIpcV2TestClient(defaults.endpoint);
        try {
            const roundTrip = await client.read(7, data.byteLength, 0);
            expect(roundTrip.byteLength).toBe(data.byteLength);
            expect(roundTrip[0]).toBe(0xa5);
            expect(roundTrip.at(-1)).toBe(0xa5);
        } finally {
            await client.close();
            await defaults.close();
        }

        const server = await createSharedFsIpcServer(
            backendWith({ write }),
            "tcp://127.0.0.1:0",
            { maxRequestFrameBytes: exactFrameBytes }
        );
        const exact = await connect(server.endpoint);
        const oversized = await connect(server.endpoint);
        try {
            const { reader, limits } = await negotiateV2(exact);
            expect(limits.maxRequestFrameBytes).toBe(exactFrameBytes);
            exact.write(requestFrame(limits, metadata, data));
            await expect(decodeV2Response(reader, limits)).resolves.toEqual({
                metadata: { id: 1, ok: true, result: data.byteLength },
                body: Buffer.alloc(0),
            });

            const negotiated = await negotiateV2(oversized);
            const didClose = closed(oversized);
            const header = Buffer.alloc(16);
            header.write("PBFS", 0, "ascii");
            header[4] = 2;
            header[5] = IpcV2FrameKind.Request;
            header.writeUInt32BE(
                Buffer.byteLength(JSON.stringify(metadata)),
                8
            );
            header.writeUInt32BE(data.byteLength + 1, 12);
            expect(negotiated.limits.maxRequestFrameBytes).toBe(
                exactFrameBytes
            );
            oversized.write(header);
            await didClose;
            expect(write).toHaveBeenCalledTimes(1);
        } finally {
            exact.destroy();
            oversized.destroy();
            await server.close();
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
            const { reader, limits } = await negotiateV2(socket);
            socket.write(
                Buffer.concat([
                    requestFrame(limits, {
                        id: 1,
                        op: "getattr",
                        args: ["/first"],
                    }),
                    requestFrame(limits, {
                        id: 2,
                        op: "getattr",
                        args: ["/second"],
                    }),
                ])
            );
            await firstStarted.promise;
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(calls).toEqual(["/first"]);

            releaseFirst.resolve();
            await expect(decodeV2Response(reader, limits)).resolves.toEqual({
                metadata: { id: 1, ok: true, result: { path: "/first" } },
                body: Buffer.alloc(0),
            });
            await expect(decodeV2Response(reader, limits)).resolves.toEqual({
                metadata: { id: 2, ok: true, result: { path: "/second" } },
                body: Buffer.alloc(0),
            });
            expect(calls).toEqual(["/first", "/second"]);
        } finally {
            socket.destroy();
            await server.close();
        }
    });

    it("bounds the handshake line independently of the frame limits", async () => {
        const getattr = vi.fn(async (path: string) => ({ path }));
        // A request limit far below the negotiation offer still negotiates:
        // the handshake has its own fixed bound.
        const server = await createSharedFsIpcServer(
            backendWith({ getattr }),
            "tcp://127.0.0.1:0",
            { maxRequestFrameBytes: 64 }
        );
        const offender = await connect(server.endpoint);
        const client = createIpcV2TestClient(server.endpoint);
        try {
            const offenderClosed = closed(offender);
            offender.write(
                Buffer.alloc(SHARED_FS_IPC_NEGOTIATION_MAX_BYTES + 1, 0x61)
            );
            await offenderClosed;
            expect(getattr).not.toHaveBeenCalled();

            await expect(client.getattr("/healthy")).resolves.toEqual({
                path: "/healthy",
            });
            expect(getattr).toHaveBeenCalledTimes(1);
        } finally {
            offender.destroy();
            await client.close();
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
            const { reader, limits } = await negotiateV2(socket);
            expect(limits.maxResponseFrameBytes).toBe(maxResponseFrameBytes);
            socket.write(
                Buffer.concat([
                    requestFrame(limits, {
                        id: 1,
                        op: "getattr",
                        args: ["/large"],
                    }),
                    requestFrame(limits, {
                        id: 2,
                        op: "getattr",
                        args: ["/small"],
                    }),
                ])
            );
            // decodeV2Response enforces the negotiated response limit.
            const bounded = await decodeV2Response(reader, limits);
            expect(bounded.metadata).toMatchObject({
                id: 1,
                ok: false,
                error: {
                    code: "EIO",
                    message: `IPC response exceeds ${maxResponseFrameBytes} byte limit`,
                },
            });
            await expect(decodeV2Response(reader, limits)).resolves.toEqual({
                metadata: { id: 2, ok: true, result: { path: "/small" } },
                body: Buffer.alloc(0),
            });
        } finally {
            socket.destroy();
            await server.close();
        }
    });

    it("rejects an un-negotiated IPC v1 operation with an upgrade hint and never dispatches it", async () => {
        const mkdir = vi.fn(async () => {});
        const server = await createSharedFsIpcServer(
            backendWith({ mkdir }),
            "tcp://127.0.0.1:0"
        );
        const socket = await connect(server.endpoint);
        try {
            const didClose = closed(socket);
            const response = readJsonLines(socket, 1);
            // What an adapter built before IPC v2 sends: base64 JSONL ops.
            socket.write(
                `${JSON.stringify({ id: 4, op: "mkdir", args: ["/must-not-run"] })}\n${JSON.stringify({ id: 5, op: "write", args: [1, { $bytes: "YWJj" }, 0] })}\n`
            );
            const [rejection] = await response;
            expect(rejection).toMatchObject({
                id: 4,
                ok: false,
                error: { code: "EPROTONOSUPPORT" },
            });
            const message = (rejection.error as { message: string }).message;
            expect(message).toContain("IPC v1 is retired");
            expect(message).toContain("peerbit-fs install-adapter --force");
            expect(message).toContain("--native-adapter");
            await didClose;
            expect(mkdir).not.toHaveBeenCalled();
        } finally {
            socket.destroy();
            await server.close();
        }
    });

    it("closes a malformed handshake line without a response", async () => {
        const server = await createSharedFsIpcServer(
            backendWith({}),
            "tcp://127.0.0.1:0"
        );
        const socket = await connect(server.endpoint);
        try {
            let received = 0;
            socket.on("data", (chunk) => {
                received += chunk.byteLength;
            });
            const didClose = closed(socket);
            socket.write("not json\n");
            await didClose;
            expect(received).toBe(0);
        } finally {
            socket.destroy();
            await server.close();
        }
    });
});

describe("shared-fs negotiated IPC v2", () => {
    it("profiles the v2 backend service with its wire request id", async () => {
        const events: SharedFsMountProfileEvent[] = [];
        const server = await createSharedFsIpcServer(
            backendWith({ getattr: async (path) => ({ path }) as any }),
            "tcp://127.0.0.1:0",
            { profile: (event) => events.push(event) }
        );
        const socket = await connect(server.endpoint);
        try {
            const { reader, limits } = await negotiateV2(socket);
            const request = encodeIpcV2Frame(
                IpcV2FrameKind.Request,
                { id: 37, op: "getattr", args: ["/profiled-v2"] },
                Buffer.alloc(0),
                limits.maxRequestFrameBytes,
                limits.maxMetadataBytes
            );
            await writeIpcV2Frame(socket, request);
            await expect(decodeV2Response(reader, limits)).resolves.toEqual({
                metadata: {
                    id: 37,
                    ok: true,
                    result: { path: "/profiled-v2" },
                },
                body: Buffer.alloc(0),
            });
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({
                phase: "ipc.service",
                operation: "getattr",
                ok: true,
                detail: {
                    requestId: 37,
                    protocol: "v2",
                    remotePort: socket.localPort,
                },
            });
            expect(events[0].startUnixNs).toMatch(/^[1-9][0-9]{0,18}$/u);
            expect(events[0].detail).not.toHaveProperty("framingNs");
            expect(events[0].detail).not.toHaveProperty("code");
        } finally {
            socket.destroy();
            await server.close();
        }
    });

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
        // The default endpoint is the one the CLI mounts with.
        const server = await createSharedFsIpcServer(
            backendWith({
                getattr: async (path) => ({ path }) as any,
                read: async () => readPayload,
                write,
            })
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

    it.skipIf(process.platform !== "linux")(
        "listens by default in an owner-only directory that close removes",
        async () => {
            // Under this TMPDIR the socket path would exceed sun_path (108
            // bytes), and bind would create a truncated name instead.
            const longTmpdir = await mkdtemp(join(tmpdir(), "t".repeat(100)));
            vi.stubEnv("TMPDIR", longTmpdir);
            try {
                const server = await createSharedFsIpcServer(backendWith({}));
                const directory = dirname(server.endpoint);
                try {
                    expect((await stat(directory)).mode & 0o777).toBe(0o700);
                    expect((await stat(server.endpoint)).isSocket()).toBe(true);
                } finally {
                    await server.close();
                }
                await expect(stat(directory)).rejects.toMatchObject({
                    code: "ENOENT",
                });
            } finally {
                vi.unstubAllEnvs();
                await rm(longTmpdir, { recursive: true, force: true });
            }
        }
    );

    it("joins real Go adapter and Node daemon profiles by connection and request id", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "peerbit-profile-join-")
        );
        const nodeProfile = join(directory, "node-daemon.ndjson");
        const nativeProfile = join(directory, "native-adapter.ndjson");
        const writer = await openSharedFsMountProfileFile(nodeProfile);
        const server = await createSharedFsIpcServer(
            backendWith({
                getattr: async (path) => {
                    if (path === "/absent") {
                        throw new SharedFsBackendError("ENOENT", "absent");
                    }
                    return { path } as any;
                },
                read: async () => Buffer.from([1, 2, 3]),
            }),
            "tcp://127.0.0.1:0",
            { profile: writer.sink }
        );
        try {
            await execFileAsync(
                "go",
                [
                    "test",
                    "-run",
                    "^TestMountProfileNodeInterop$",
                    "-count=1",
                    ".",
                ],
                {
                    cwd: new URL("../../../native/", import.meta.url),
                    env: {
                        ...process.env,
                        PEERBIT_SHARED_FS_NODE_PROFILE_TEST_ENDPOINT:
                            server.endpoint,
                        PEERBIT_SHARED_FS_NATIVE_PROFILE_FILE: nativeProfile,
                    },
                }
            );
        } finally {
            await server.close();
        }
        await writer.close();
        const records = async (path: string) =>
            (await readFile(path, "utf8"))
                .trimEnd()
                .split("\n")
                .map((line) => JSON.parse(line) as SharedFsMountProfileEvent);
        try {
            const adapter = await records(nativeProfile);
            const daemon = await records(nodeProfile);
            for (const profile of [adapter, daemon]) {
                expect(profile[0].phase).toBe("profile.start");
                expect(profile.at(-1)).toMatchObject({
                    phase: "profile.summary",
                    detail: { dropped: 0 },
                });
            }
            const roundTrips = adapter.filter(
                (record) => record.phase === "ipc.roundTrip"
            );
            const services = daemon.filter(
                (record) => record.phase === "ipc.service"
            );
            expect(roundTrips.map((record) => record.operation)).toEqual([
                "getattr",
                "getattr",
                "read",
            ]);
            expect(services).toHaveLength(3);
            expect(roundTrips[0].detail?.connected).toBe(true);
            expect(roundTrips[1].detail?.connected).toBeUndefined();
            for (const service of services) {
                const matches = roundTrips.filter(
                    (roundTrip) =>
                        roundTrip.detail?.localPort ===
                            service.detail?.remotePort &&
                        roundTrip.detail?.requestId ===
                            service.detail?.requestId
                );
                expect(matches).toHaveLength(1);
                expect(matches[0].operation).toBe(service.operation);
                expect(matches[0].ok).toBe(service.ok);
                expect(matches[0].detail?.code).toBe(service.detail?.code);
            }
            expect(
                services.map((service) => service.detail?.code ?? null)
            ).toEqual([null, "ENOENT", null]);
        } finally {
            await rm(directory, { recursive: true, force: true });
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

    it("selects v2 even when an offer prefers a retired version", async () => {
        const getattr = vi.fn(async (path: string) => ({ path }));
        const server = await createSharedFsIpcServer(
            backendWith({ getattr }),
            "tcp://127.0.0.1:0"
        );
        const socket = await connect(server.endpoint);
        try {
            // Released 0.13.16-0.13.18 adapters offer [2, 1]; order is only
            // a preference, and this server speaks v2 alone.
            const { reader, limits } = await negotiateV2(socket, {
                versions: [1, 2],
            });
            socket.write(
                requestFrame(limits, { id: 4, op: "getattr", args: ["/v2"] })
            );
            await expect(decodeV2Response(reader, limits)).resolves.toEqual({
                metadata: { id: 4, ok: true, result: { path: "/v2" } },
                body: Buffer.alloc(0),
            });
        } finally {
            socket.destroy();
            await server.close();
        }
    });

    it.each([
        { name: "a future version", versions: [3] },
        { name: "only retired v1", versions: [1] },
    ])(
        "rejects an offer of $name without dispatching a filesystem operation",
        async ({ versions }) => {
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
                                versions,
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
                            message:
                                "No offered IPC protocol version is supported",
                        },
                    },
                ]);
                expect(getattr).not.toHaveBeenCalled();
            } finally {
                socket.destroy();
                await server.close();
            }
        }
    );

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
            name: "base64 byte objects inside v2 metadata",
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
