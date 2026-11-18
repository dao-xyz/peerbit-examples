import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    localOverlayDirectory,
    openMountLocalOverlay,
    type SharedFsMountLocalOverlay,
} from "@peerbit/shared-fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopMountSession } from "../index.js";
import {
    localOverlayLines,
    openMountLocalOverlayForCli,
} from "../local-overlay.js";

/**
 * Where a CLI mount keeps node_modules: under its state directory, or in a
 * temporary directory that the mount's shutdown deletes. No Peerbit, no
 * FUSE: the overlay only needs a directory and an address.
 */

const runtime = { localOverlayDirectory, openMountLocalOverlay };
const address = "zb2rhLocalOverlayTestAddress";
const sealedNames = ["node_modules"];

const exists = (directory: string) =>
    fs.stat(directory).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
        }
    );

describe("mount local overlay (CLI)", () => {
    const directories: string[] = [];

    const temporaryDirectory = async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-cli-overlay-test-")
        );
        directories.push(directory);
        return directory;
    };

    afterEach(async () => {
        vi.restoreAllMocks();
        for (const directory of directories.splice(0)) {
            await fs.rm(directory, {
                recursive: true,
                force: true,
                maxRetries: 10,
                retryDelay: 200,
            });
        }
    });

    it("keeps a durable mount's overlay under its state directory, across stops", async () => {
        const state = await temporaryDirectory();
        const local = await openMountLocalOverlayForCli(runtime, {
            stateDirectory: state,
            address,
            sealedNames,
        });
        const expected = path.join(
            state,
            "shared-fs-local-overlay",
            createHash("sha256").update(address).digest("hex").slice(0, 32)
        );
        expect(local.directory).toBe(expected);
        expect(local.temporary).toBe(false);
        await fs.writeFile(path.join(expected, "kept"), "kept");
        await local.remove();
        expect(await fs.readFile(path.join(expected, "kept"), "utf8")).toBe(
            "kept"
        );
        // The next mount opens the same directory.
        const again = await openMountLocalOverlayForCli(runtime, {
            stateDirectory: state,
            address,
            sealedNames,
        });
        expect(again.directory).toBe(expected);
    });

    it("gives an in-memory mount a temporary overlay that remove() deletes", async () => {
        const local = await openMountLocalOverlayForCli(runtime, {
            stateDirectory: undefined,
            address,
            sealedNames,
        });
        directories.push(local.directory);
        expect(local.temporary).toBe(true);
        expect(path.dirname(local.directory)).toBe(path.resolve(os.tmpdir()));
        expect(path.basename(local.directory)).toMatch(
            /^peerbit-shared-fs-local-overlay-/
        );
        expect(
            JSON.parse(
                await fs.readFile(
                    path.join(local.directory, "meta.json"),
                    "utf8"
                )
            )
        ).toEqual({ format: 1, address });
        await local.remove();
        expect(await exists(local.directory)).toBe(false);
    });

    it("deletes the temporary directory when the overlay cannot open, and reports why", async () => {
        let tried: string | undefined;
        const refusal = Object.assign(new Error("refused"), {
            code: "EINVAL",
        });
        await expect(
            openMountLocalOverlayForCli(
                {
                    localOverlayDirectory,
                    openMountLocalOverlay: async (options) => {
                        tried = options.directory;
                        throw refusal;
                    },
                },
                { stateDirectory: undefined, address, sealedNames }
            )
        ).rejects.toBe(refusal);
        expect(tried).toBeDefined();
        expect(await exists(tried!)).toBe(false);
    });

    it("refuses another filesystem's overlay directory", async () => {
        const state = await temporaryDirectory();
        await openMountLocalOverlayForCli(runtime, {
            stateDirectory: state,
            address,
            sealedNames,
        });
        // Same id only if the hashes collide: plant another address's meta.
        const directory = localOverlayDirectory(state, address);
        await fs.writeFile(
            path.join(directory, "meta.json"),
            JSON.stringify({ format: 1, address: "another" })
        );
        await expect(
            openMountLocalOverlayForCli(runtime, {
                stateDirectory: state,
                address,
                sealedNames,
            })
        ).rejects.toMatchObject({
            code: "EINVAL",
            message: expect.stringContaining(`move or delete ${directory}`),
        });
        // A durable overlay is never deleted for it.
        expect(await exists(directory)).toBe(true);
    });

    it("deletes a temporary overlay after the backend at shutdown, also when a step failed", async () => {
        for (const ignoreErrors of [false, true]) {
            const local = await openMountLocalOverlayForCli(runtime, {
                stateDirectory: undefined,
                address,
                sealedNames,
            });
            directories.push(local.directory);
            const order: string[] = [];
            const disposedWhileThere: boolean[] = [];
            const stopped = stopMountSession(
                {
                    mounted: {
                        unmount: async () => {
                            order.push("unmount");
                            if (ignoreErrors) throw new Error("unmount failed");
                        },
                    },
                    backend: {
                        drain: async () => {
                            order.push("drain");
                            return { failed: [] };
                        },
                        dispose: () => {
                            order.push("dispose");
                            disposedWhileThere.push(
                                existsSync(local.directory)
                            );
                        },
                    },
                    localOverlay: {
                        remove: async () => {
                            order.push("remove");
                            await local.remove();
                        },
                    },
                    stopPeerbit: async () => {
                        order.push("stop");
                    },
                },
                { ignoreErrors }
            );
            await stopped;
            expect(order).toEqual([
                "unmount",
                "drain",
                "dispose",
                "remove",
                "stop",
            ]);
            expect(disposedWhileThere).toEqual([true]);
            expect(await exists(local.directory)).toBe(false);
        }
        process.exitCode = undefined;
    });

    it("prints where the overlay is, and how many directories with local entries another writer removed", async () => {
        const target = { nodeForMount: vi.fn(async () => undefined) };
        const lines = async (count: number) => {
            const overlay: SharedFsMountLocalOverlay = {
                directory: "/state/shared-fs-local-overlay/0123",
                detached: vi.fn(async (given) => {
                    expect(given).toBe(target);
                    return count;
                }),
            };
            return localOverlayLines(
                { overlay, directory: overlay.directory },
                target
            );
        };
        expect(await lines(0)).toEqual([
            "Local overlay: /state/shared-fs-local-overlay/0123",
        ]);
        expect(await lines(1)).toEqual([
            "Local overlay: /state/shared-fs-local-overlay/0123",
            "Local overlay: 1 directory with local entries was removed from the filesystem; its entries stay under /state/shared-fs-local-overlay/0123 until you delete them",
        ]);
        expect(await lines(3)).toEqual([
            "Local overlay: /state/shared-fs-local-overlay/0123",
            "Local overlay: 3 directories with local entries were removed from the filesystem; their entries stay under /state/shared-fs-local-overlay/0123 until you delete them",
        ]);
    });
});
