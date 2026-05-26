import nodeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    DEFAULT_FILE_CHUNK_SIZE,
    encodePublicSignKey,
    openSharedFs,
    runSharedFsBenchmark,
    type SharedFsHandle,
} from "../index.js";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const stopPeer = async (peer: Peerbit) => {
    try {
        await peer.stop();
    } catch (error) {
        if (
            !(
                error instanceof TypeError &&
                error.message.includes("clearAll") &&
                error.stack?.includes("DocumentIndex.close")
            )
        ) {
            throw error;
        }
    }
};

const patternedBytes = (size: number) => {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < bytes.byteLength; i++) {
        bytes[i] = i % 251;
    }
    return bytes;
};

const waitUntil = async (
    assertion: () => Promise<void> | void,
    options: { timeoutMs?: number; intervalMs?: number } = {}
) => {
    const timeoutMs = options.timeoutMs ?? 20_000;
    const intervalMs = options.intervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }
    throw lastError;
};

describe("shared fs library", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;

    beforeEach(async () => {
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "test-machine",
        });
    });

    afterEach(async () => {
        await stopPeer(peer);
    });

    it("creates, lists, reads, renames, deletes directories and files", async () => {
        await fs.mkdir("/docs");
        await fs.writeFile("/docs/hello.txt", "hello");

        expect(decode(await fs.readFile("/docs/hello.txt"))).toBe("hello");
        expect((await fs.list("/docs")).map((entry) => entry.name)).toEqual([
            "hello.txt",
        ]);

        await fs.rename("/docs/hello.txt", "/docs/greeting.txt");
        expect(await fs.readFile("/docs/hello.txt")).toBeUndefined();
        expect(decode(await fs.readFile("/docs/greeting.txt"))).toBe("hello");

        await fs.rm("/docs/greeting.txt");
        expect(await fs.readFile("/docs/greeting.txt")).toBeUndefined();

        await fs.rm("/docs");
        expect((await fs.list("/")).map((entry) => entry.name)).toEqual([]);
    });

    it("chunks and reads large files", async () => {
        const bytes = patternedBytes(DEFAULT_FILE_CHUNK_SIZE * 2 + 17);
        await fs.writeFile("/large.bin", bytes);

        expect(await fs.readFile("/large.bin")).toEqual(bytes);
        const [version] = await fs.versions("/large.bin");
        expect(version.size).toBe(BigInt(bytes.byteLength));
        expect(version.machineLabel).toBe("test-machine");
        expect(version.authorKey.length).toBeGreaterThan(0);
    });

    it("preserves concurrent versions and resolves conflicts explicitly", async () => {
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

        const conflicts = await fs.conflicts();
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].path).toBe("/note.txt");
        expect(
            conflicts[0].versions.map((version) => version.id).sort()
        ).toEqual([left.id, right.id].sort());
        expect(decode(await fs.readVersion("/note.txt", right.id))).toBe(
            "right"
        );

        await fs.resolveConflict("/note.txt", left.id);

        expect(await fs.conflicts()).toEqual([]);
        expect(decode(await fs.readFile("/note.txt"))).toBe("left");
        expect(decode(await fs.readVersion("/note.txt", right.id))).toBe(
            "right"
        );
    });

    it("runs the baseline benchmark workload", async () => {
        const result = await runSharedFsBenchmark(fs, {
            root: "/benchmark",
            largeFileSize: 1024,
            smallFileCount: 3,
            smallFileSize: 16,
            cleanup: true,
        });

        expect(result.largeFile.bytes).toBe(1024);
        expect(result.smallFiles.count).toBe(3);
        expect(result.smallFiles.bytesPerFile).toBe(16);
    });

    it("keeps filesystem projections local-only", async () => {
        const originalSearch = fs.program.entries.index.search.bind(
            fs.program.entries.index
        );
        const remoteOptions: unknown[] = [];
        fs.program.entries.index.search = ((request: unknown, options: any) => {
            remoteOptions.push(options?.remote);
            return originalSearch(request as never, options);
        }) as typeof fs.program.entries.index.search;

        await fs.writeFile("/local.txt", "fast local write");
        expect(decode(await fs.readFile("/local.txt"))).toBe(
            "fast local write"
        );
        expect((await fs.list("/")).map((entry) => entry.name)).toEqual([
            "local.txt",
        ]);

        expect(remoteOptions.length).toBeGreaterThan(0);
        expect(remoteOptions.every((remote) => remote === false)).toBe(true);
    });

    it("reopens from a persisted state directory", async () => {
        const directory = await nodeFs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-library-")
        );
        let address = "";

        try {
            const firstPeer = await Peerbit.create({ directory });
            try {
                const firstFs = await openSharedFs({
                    peerbit: firstPeer,
                    machineLabel: "persistent-writer",
                    replicate: false,
                });
                address = firstFs.address;
                await firstFs.mkdir("/docs");
                await firstFs.writeFile("/docs/hello.txt", "persisted");
            } finally {
                await stopPeer(firstPeer);
            }

            const secondPeer = await Peerbit.create({ directory });
            try {
                const secondFs = await openSharedFs({
                    peerbit: secondPeer,
                    address,
                    machineLabel: "persistent-reader",
                    replicate: false,
                });
                expect(decode(await secondFs.readFile("/docs/hello.txt"))).toBe(
                    "persisted"
                );
            } finally {
                await stopPeer(secondPeer);
            }
        } finally {
            await nodeFs.rm(directory, { recursive: true, force: true });
        }
    });
});

describe("shared fs replication", () => {
    const peers: Peerbit[] = [];

    const createPeer = async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        return peer;
    };

    afterEach(async () => {
        await Promise.all(peers.splice(0).map((peer) => stopPeer(peer)));
    });

    it("syncs a local-first write after peers reconnect", async () => {
        const writerPeer = await createPeer();
        const readerPeer = await createPeer();
        const writer = await openSharedFs({
            peerbit: writerPeer,
            machineLabel: "writer-machine",
        });
        await writer.writeFile("/offline.txt", "local-first");
        expect(decode(await writer.readFile("/offline.txt"))).toBe(
            "local-first"
        );

        await writerPeer.dial(readerPeer);
        const reader = await openSharedFs({
            peerbit: readerPeer,
            address: writer.address,
            machineLabel: "reader-machine",
        });

        await waitUntil(async () => {
            expect(decode(await reader.readFile("/offline.txt"))).toBe(
                "local-first"
            );
        });
    });

    it("preserves signed conflict heads from two peers", async () => {
        const peerA = await createPeer();
        const peerB = await createPeer();
        await peerA.dial(peerB);

        const fsA = await openSharedFs({
            peerbit: peerA,
            machineLabel: "peer-a",
        });
        const fsB = await openSharedFs({
            peerbit: peerB,
            address: fsA.address,
            machineLabel: "peer-b",
        });

        await fsA.writeFile("/shared.txt", "base");
        await waitUntil(async () => {
            expect(decode(await fsB.readFile("/shared.txt"))).toBe("base");
        });

        const base = (await fsA.versions("/shared.txt"))
            .filter((version) => version.head)
            .map((version) => version.id);
        await fsA.writeFile("/shared.txt", "from-a", {
            baseVersionIds: base,
        });
        await fsB.writeFile("/shared.txt", "from-b", {
            baseVersionIds: base,
        });

        await waitUntil(async () => {
            const conflicts = await fsA.conflicts("/shared.txt");
            expect(conflicts).toHaveLength(1);
            expect(
                conflicts[0].versions
                    .map((version) => version.machineLabel)
                    .sort()
            ).toEqual(["peer-a", "peer-b"]);
        });
        await waitUntil(async () => {
            const conflicts = await fsB.conflicts("/shared.txt");
            expect(conflicts).toHaveLength(1);
            expect(
                conflicts[0].versions
                    .map((version) => version.machineLabel)
                    .sort()
            ).toEqual(["peer-a", "peer-b"]);
        });
    });

    it("requires trusted writer signatures for access-controlled filesystems", async () => {
        const ownerPeer = await createPeer();
        const writerPeer = await createPeer();
        await ownerPeer.dial(writerPeer);

        const ownerFs = await openSharedFs({
            peerbit: ownerPeer,
            machineLabel: "owner-machine",
            rootKey: ownerPeer.identity.publicKey,
        });
        const writerFs = await openSharedFs({
            peerbit: writerPeer,
            address: ownerFs.address,
            machineLabel: "writer-machine",
        });

        expect(ownerFs.accessControlled).toBe(true);
        expect(writerFs.accessControlled).toBe(true);
        await expect(
            writerFs.writeFile("/blocked.txt", "untrusted")
        ).rejects.toThrow();
        expect(await ownerFs.readFile("/blocked.txt")).toBeUndefined();

        await ownerFs.authorizeWriter(writerPeer.identity.publicKey);
        await waitUntil(async () => {
            expect(
                await writerFs.isTrustedWriter(writerPeer.identity.publicKey)
            ).toBe(true);
        });

        const version = await writerFs.writeFile("/trusted.txt", "trusted");
        expect(version.authorKey).toBe(
            encodePublicSignKey(writerPeer.identity.publicKey)
        );

        await waitUntil(async () => {
            expect(decode(await ownerFs.readFile("/trusted.txt"))).toBe(
                "trusted"
            );
        });
    });
});
