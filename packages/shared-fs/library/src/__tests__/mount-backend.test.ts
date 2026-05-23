import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    CONFLICTS_DIR,
    createSharedFsIpcClient,
    createSharedFsIpcServer,
    createSharedFsMountBackend,
    encodeConflictPathName,
    openSharedFs,
    type SharedFsHandle,
} from "../index.js";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

describe("shared fs mount backend", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;

    beforeEach(async () => {
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "mount-test",
        });
    });

    afterEach(async () => {
        await peer.stop();
    });

    it("commits buffered writes on release", async () => {
        const backend = createSharedFsMountBackend(fs);
        await backend.mkdir("/docs");
        const handle = await backend.open("/docs/file.txt", {
            write: true,
            create: true,
            truncate: true,
        });

        expect(
            (await backend.readdir("/docs")).map((entry) => entry.name)
        ).toContain("file.txt");
        await backend.write(handle, encode("hello"), 0);
        expect((await backend.getattr("/docs/file.txt")).size).toBe(
            "hello".length
        );
        expect(await fs.readFile("/docs/file.txt")).toBeUndefined();

        await backend.release(handle);
        expect(decode(await fs.readFile("/docs/file.txt"))).toBe("hello");
    });

    it("exposes conflicts through the metadata namespace", async () => {
        const backend = createSharedFsMountBackend(fs);
        await fs.writeFile("/note.txt", "base");
        const base = (await fs.versions("/note.txt"))
            .filter((version) => version.head)
            .map((version) => version.id);
        const left = await fs.writeFile("/note.txt", "left", {
            baseVersionIds: base,
        });
        const right = await fs.writeFile("/note.txt", "right", {
            baseVersionIds: base,
        });

        expect(
            (await backend.readdir("/")).map((entry) => entry.name)
        ).toContain(CONFLICTS_DIR);
        const conflictName = encodeConflictPathName("/note.txt");
        expect(
            (await backend.readdir(`/${CONFLICTS_DIR}`)).map(
                (entry) => entry.name
            )
        ).toEqual([conflictName]);
        expect(
            (await backend.readdir(`/${CONFLICTS_DIR}/${conflictName}`))
                .map((entry) => entry.name)
                .sort()
        ).toEqual([left.id, right.id].sort());

        const handle = await backend.open(
            `/${CONFLICTS_DIR}/${conflictName}/${right.id}`
        );
        expect(decode(await backend.read(handle, 1024, 0))).toBe("right");
        await backend.release(handle);
    });

    it("round-trips backend calls through local IPC", async () => {
        const backend = createSharedFsMountBackend(fs);
        const server = await createSharedFsIpcServer(backend);
        try {
            const client = createSharedFsIpcClient(server.endpoint);
            await client.mkdir("/ipc");
            const handle = await client.open("/ipc/file.txt", {
                write: true,
                create: true,
                truncate: true,
            });
            await client.write(handle, encode("over ipc"), 0);
            await client.release(handle);

            const stat = await client.getattr("/ipc/file.txt");
            expect(stat.kind).toBe("file");
            expect(stat.size).toBe("over ipc".length);
            expect(decode(await fs.readFile("/ipc/file.txt"))).toBe("over ipc");
        } finally {
            await server.close();
        }
    });

    it("round-trips backend calls through TCP IPC for external adapters", async () => {
        const backend = createSharedFsMountBackend(fs);
        const server = await createSharedFsIpcServer(
            backend,
            "tcp://127.0.0.1:0"
        );
        try {
            expect(server.endpoint).toMatch(/^tcp:\/\/127\.0\.0\.1:\d+$/);
            const client = createSharedFsIpcClient(server.endpoint);
            await client.mkdir("/tcp");
            const handle = await client.open("/tcp/file.txt", {
                write: true,
                create: true,
                truncate: true,
            });
            await client.write(handle, encode("over tcp"), 0);
            await client.release(handle);

            expect(decode(await fs.readFile("/tcp/file.txt"))).toBe("over tcp");
        } finally {
            await server.close();
        }
    });
});
