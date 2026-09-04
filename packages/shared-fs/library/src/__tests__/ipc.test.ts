import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createSharedFsIpcClient, createSharedFsIpcServer } from "../ipc.js";
import type { SharedFsMountBackend } from "../mount-backend.js";

const backendWith = (
    methods: Partial<SharedFsMountBackend>
): SharedFsMountBackend => methods as SharedFsMountBackend;

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

describe("shared-fs IPC framing", () => {
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
