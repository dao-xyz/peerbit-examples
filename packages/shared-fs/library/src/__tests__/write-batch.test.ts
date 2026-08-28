import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const waitUntil = async (
    assertion: () => Promise<void> | void,
    options: { timeoutMs?: number; intervalMs?: number } = {}
) => {
    const timeoutMs = options.timeoutMs ?? (process.env.CI ? 90_000 : 30_000);
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

describe("shared fs write batches", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;

    beforeEach(async () => {
        peer = await Peerbit.create();
        fs = await openSharedFs({ peerbit: peer, machineLabel: "batch" });
    });

    afterEach(async () => {
        try {
            await peer.stop();
        } catch (error) {
            if (
                !(
                    error instanceof TypeError &&
                    error.message.includes("clearAll")
                )
            ) {
                throw error;
            }
        }
    });

    it("applies a multi-file change set, creating missing directories", async () => {
        const batch = await fs.writeBatch([
            { path: "/src/lib/util.ts", content: "export const a = 1;" },
            { path: "/src/lib/other.ts", content: "export const b = 2;" },
            { path: "/src/main.ts", content: "import './lib/util.js';" },
            { path: "/docs/readme.md", content: "# hello" },
        ]);
        expect(batch.changesetId).toMatch(/^changeset:/);
        expect(batch.results.filter(Boolean)).toHaveLength(4);

        expect(decode(await fs.readFile("/src/lib/util.ts"))).toBe(
            "export const a = 1;"
        );
        expect(decode(await fs.readFile("/docs/readme.md"))).toBe("# hello");
        expect(
            (await fs.list("/src")).map((entry) => entry.name).sort()
        ).toEqual(["lib", "main.ts"]);
        expect((await fs.stat("/src/lib"))?.kind).toBe("directory");
        expect(await fs.namingConflicts()).toEqual([]);
    });

    it("records a queryable changeset over writes, edits and deletes", async () => {
        await fs.writeBatch([
            { path: "/a.txt", content: "one" },
            { path: "/b.txt", content: "two" },
        ]);
        const second = await fs.writeBatch(
            [
                { path: "/a.txt", content: "one edited" },
                { path: "/c.txt", content: "three" },
                { path: "/b.txt", delete: true },
            ],
            { changesetId: "turn-42" }
        );
        expect(second.changesetId).toBe("turn-42");
        // a edited + c created; delete contributes no version.
        expect(second.results.filter(Boolean)).toHaveLength(2);

        const recorded = await fs.versionsByChangeset("turn-42");
        expect(recorded.versions.map((v) => v.path).sort()).toEqual([
            "/a.txt",
            "/c.txt",
        ]);
        // c's create naming event + b's delete naming event.
        expect(recorded.namingEventIds.length).toBe(2);

        expect(await fs.stat("/b.txt")).toBeUndefined();
        expect(decode(await fs.readFile("/a.txt"))).toBe("one edited");
        // b's delete is recoverable through the normal version machinery.
        expect((await fs.versionsByChangeset("turn-42")).versions[0].head).toBe(
            true
        );
    });

    it("skips unchanged content and dedupes shared chunks across the batch", async () => {
        await fs.writeFile("/same.txt", "identical");
        const countChunks = async () =>
            (
                await fs.program.entries.index
                    .iterate(
                        { query: { kind: "file-chunk" } },
                        { local: true, remote: false, resolve: false }
                    )
                    .all()
            ).length;
        const before = await countChunks();
        const batch = await fs.writeBatch([
            { path: "/same.txt", content: "identical" }, // no-op
            { path: "/copy1.txt", content: "identical" }, // shares the chunk
            { path: "/copy2.txt", content: "identical" },
        ]);
        expect(batch.results[0]).toBeUndefined();
        expect(batch.results[1]).toBeDefined();
        expect(await countChunks()).toBe(before);
        expect(decode(await fs.readFile("/copy2.txt"))).toBe("identical");
        // The no-op left /same.txt at a single head.
        expect(await fs.versions("/same.txt")).toHaveLength(1);
    });

    it("rejects duplicate paths and root writes", async () => {
        await expect(
            fs.writeBatch([
                { path: "/x.txt", content: "1" },
                { path: "/x.txt", content: "2" },
            ])
        ).rejects.toThrow(/Duplicate path/);
        await expect(
            fs.writeBatch([{ path: "/", content: "nope" }])
        ).rejects.toThrow(/root/);
    });

    it("rejects batches where one path lies under another", async () => {
        // A single batch may not claim a path both as a file and as a
        // directory segment — either order, and via deletes too.
        await expect(
            fs.writeBatch([
                { path: "/a", content: "file" },
                { path: "/a/b.txt", content: "child" },
            ])
        ).rejects.toThrow(/Conflicting paths/);
        await expect(
            fs.writeBatch([
                { path: "/a/b.txt", content: "child" },
                { path: "/a", content: "file" },
            ])
        ).rejects.toThrow(/Conflicting paths/);
        await expect(
            fs.writeBatch([
                { path: "/a/b.txt", content: "child" },
                { path: "/a", delete: true },
            ])
        ).rejects.toThrow(/Conflicting paths/);
        // Nothing from the rejected batches leaked into the tree.
        expect(await fs.stat("/a")).toBeUndefined();
        expect(await fs.namingConflicts()).toEqual([]);
    });

    it("throws EISDIR on directory deletes; missing-path deletes no-op", async () => {
        await fs.mkdir("/dir");
        await expect(
            fs.writeBatch([{ path: "/dir", delete: true }])
        ).rejects.toThrow(/file-only/);
        const batch = await fs.writeBatch([
            { path: "/not-there.txt", delete: true },
            { path: "/created.txt", content: "kept" },
        ]);
        expect(batch.results[0]).toBeUndefined();
        expect(batch.results[1]).toBeDefined();
        expect(decode(await fs.readFile("/created.txt"))).toBe("kept");
    });

    it("bounds changesetId and per-file chunk counts", async () => {
        await expect(
            fs.writeBatch([{ path: "/x.txt", content: "1" }], {
                changesetId: "",
            })
        ).rejects.toThrow(/changesetId/);
        await expect(
            fs.writeBatch([{ path: "/x.txt", content: "1" }], {
                changesetId: "c".repeat(257),
            })
        ).rejects.toThrow(/changesetId/);
        // 8001 distinct 2-byte chunks in ONE file exceeds the per-version
        // indexer bound; the batch-wide chunk total is unbounded.
        const bytes = new Uint8Array(2 * 8001);
        for (let i = 0; i < 8001; i++) {
            bytes[2 * i] = i >> 8;
            bytes[2 * i + 1] = i & 255;
        }
        await expect(
            fs.writeBatch([{ path: "/big.bin", content: bytes, chunkSize: 2 }])
        ).rejects.toThrow(/unique chunks/);
    });

    it("serializes concurrent batches creating the same new directory", async () => {
        const [first, second] = await Promise.all([
            fs.writeBatch([{ path: "/shared/one.txt", content: "1" }]),
            fs.writeBatch([{ path: "/shared/two.txt", content: "2" }]),
        ]);
        expect(first.results[0]).toBeDefined();
        expect(second.results[0]).toBeDefined();
        expect(
            (await fs.list("/shared")).map((entry) => entry.name).sort()
        ).toEqual(["one.txt", "two.txt"]);
        // One directory node — not two claimants racing for the slot.
        expect(await fs.namingConflicts()).toEqual([]);
    });

    it("replicates a batch as a unit that converges on other parties", async () => {
        const other = await Peerbit.create();
        try {
            await peer.dial(other);
            const remote = await openSharedFs({
                peerbit: other,
                address: fs.address,
                machineLabel: "remote",
            });
            const batch = await fs.writeBatch(
                Array.from({ length: 60 }, (_, i) => ({
                    path: `/pkg/mod-${i % 6}/file-${i}.txt`,
                    content: `content ${i}`,
                })),
                { changesetId: "turn-remote" }
            );
            expect(batch.results.filter(Boolean)).toHaveLength(60);
            await waitUntil(async () => {
                expect((await remote.list("/pkg")).length).toBe(6);
                expect(
                    decode(await remote.readFile("/pkg/mod-5/file-59.txt"))
                ).toBe("content 59");
                const recorded =
                    await remote.versionsByChangeset("turn-remote");
                expect(recorded.versions).toHaveLength(60);
            });
        } finally {
            await other.stop().catch(() => {});
        }
    });
});
