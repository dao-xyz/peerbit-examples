import {
    lstat,
    mkdtemp,
    mkdir,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    aggregateProcessSoakStorageSnapshots,
    aggregateProcessSoakStorageUsage,
    scanProcessSoakStateDirectory,
} from "./process-isolated-soak-storage.js";

describe("process soak state-directory accounting", () => {
    const temporaryDirectories = new Set<string>();

    afterEach(async () => {
        await Promise.all(
            [...temporaryDirectories].map((path) =>
                rm(path, { recursive: true, force: true })
            )
        );
        temporaryDirectories.clear();
    });

    const temporaryDirectory = async () => {
        const path = await mkdtemp(join(tmpdir(), "peerbit-storage-scan-"));
        temporaryDirectories.add(path);
        return path;
    };

    it("recurses and partitions usage by dynamic top-level component", async () => {
        const root = await temporaryDirectory();
        await mkdir(join(root, "blocks", "nested"), { recursive: true });
        await mkdir(join(root, "keys"), { recursive: true });
        await writeFile(join(root, "blocks", "a"), "abcd");
        await writeFile(join(root, "blocks", "nested", "b"), "123456");
        await writeFile(join(root, "keys", "identity"), "xyz");
        await writeFile(join(root, "root-file"), "12");

        const snapshot = await scanProcessSoakStateDirectory(root);

        expect(snapshot.apparentRegularFileBytes).toBe(15);
        expect(snapshot.regularFileCount).toBe(4);
        expect(snapshot.directoryCount).toBe(3);
        expect(Object.keys(snapshot.topLevel)).toEqual([
            "blocks",
            "keys",
            "root-file",
        ]);
        expect(snapshot.topLevel.blocks).toMatchObject({
            apparentRegularFileBytes: 10,
            regularFileCount: 2,
            directoryCount: 2,
        });
        expect(snapshot.topLevel.keys).toMatchObject({
            apparentRegularFileBytes: 3,
            regularFileCount: 1,
            directoryCount: 1,
        });
        expect(snapshot.topLevel["root-file"]).toMatchObject({
            apparentRegularFileBytes: 2,
            regularFileCount: 1,
            directoryCount: 0,
        });
        expect(
            aggregateProcessSoakStorageUsage(Object.values(snapshot.topLevel))
        ).toEqual({
            apparentRegularFileBytes: snapshot.apparentRegularFileBytes,
            allocatedBytes: snapshot.allocatedBytes,
            regularFileCount: snapshot.regularFileCount,
            directoryCount: snapshot.directoryCount,
        });
        expect(
            snapshot.allocatedBytes === null || snapshot.allocatedBytes >= 0
        ).toBe(true);
        const fileStats = await Promise.all(
            [
                join(root, "blocks", "a"),
                join(root, "blocks", "nested", "b"),
                join(root, "keys", "identity"),
                join(root, "root-file"),
            ].map((path) => lstat(path))
        );
        expect(snapshot.allocatedBytes).toBe(
            fileStats.every(
                (stat) =>
                    typeof stat.blocks === "number" &&
                    Number.isFinite(stat.blocks) &&
                    stat.blocks >= 0
            )
                ? fileStats.reduce((sum, stat) => sum + stat.blocks * 512, 0)
                : null
        );
    });

    it("returns zero usage when the state directory does not exist", async () => {
        const root = await temporaryDirectory();
        await rm(root, { recursive: true, force: true });
        temporaryDirectories.delete(root);

        await expect(scanProcessSoakStateDirectory(root)).resolves.toEqual({
            apparentRegularFileBytes: 0,
            allocatedBytes: 0,
            regularFileCount: 0,
            directoryCount: 0,
            topLevel: {},
        });
    });

    it("does not follow a linked state root or linked descendants", async () => {
        const root = await temporaryDirectory();
        const outside = await temporaryDirectory();
        await mkdir(join(outside, "nested"));
        await writeFile(join(outside, "nested", "outside"), "not-state");
        const linked = join(root, "linked");
        await symlink(
            outside,
            linked,
            process.platform === "win32" ? "junction" : "dir"
        );

        await expect(scanProcessSoakStateDirectory(root)).resolves.toEqual({
            apparentRegularFileBytes: 0,
            allocatedBytes: 0,
            regularFileCount: 0,
            directoryCount: 0,
            topLevel: {},
        });
        await expect(scanProcessSoakStateDirectory(linked)).resolves.toEqual({
            apparentRegularFileBytes: 0,
            allocatedBytes: 0,
            regularFileCount: 0,
            directoryCount: 0,
            topLevel: {},
        });
    });

    it("reconciles fleet totals and propagates unknown allocation", () => {
        expect(
            aggregateProcessSoakStorageUsage([
                {
                    apparentRegularFileBytes: 10,
                    allocatedBytes: 4096,
                    regularFileCount: 1,
                    directoryCount: 2,
                },
                {
                    apparentRegularFileBytes: 7,
                    allocatedBytes: null,
                    regularFileCount: 3,
                    directoryCount: 1,
                },
            ])
        ).toEqual({
            apparentRegularFileBytes: 17,
            allocatedBytes: null,
            regularFileCount: 4,
            directoryCount: 3,
        });
        expect(
            aggregateProcessSoakStorageSnapshots([
                {
                    apparentRegularFileBytes: 10,
                    allocatedBytes: 4096,
                    regularFileCount: 1,
                    directoryCount: 1,
                    topLevel: {
                        blocks: {
                            apparentRegularFileBytes: 10,
                            allocatedBytes: 4096,
                            regularFileCount: 1,
                            directoryCount: 1,
                        },
                    },
                },
                {
                    apparentRegularFileBytes: 7,
                    allocatedBytes: null,
                    regularFileCount: 2,
                    directoryCount: 2,
                    topLevel: {
                        blocks: {
                            apparentRegularFileBytes: 3,
                            allocatedBytes: null,
                            regularFileCount: 1,
                            directoryCount: 1,
                        },
                        keys: {
                            apparentRegularFileBytes: 4,
                            allocatedBytes: 4096,
                            regularFileCount: 1,
                            directoryCount: 1,
                        },
                    },
                },
            ])
        ).toEqual({
            apparentRegularFileBytes: 17,
            allocatedBytes: null,
            regularFileCount: 3,
            directoryCount: 3,
            topLevel: {
                blocks: {
                    apparentRegularFileBytes: 13,
                    allocatedBytes: null,
                    regularFileCount: 2,
                    directoryCount: 2,
                },
                keys: {
                    apparentRegularFileBytes: 4,
                    allocatedBytes: 4096,
                    regularFileCount: 1,
                    directoryCount: 1,
                },
            },
        });
    });
});
