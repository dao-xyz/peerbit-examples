import { randomFillSync } from "node:crypto";
import {
    mkdtemp,
    rm,
    statfs,
    writeFile as writeHostFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    createSharedFsIpcServer,
    createSharedFsMountBackend,
    openSharedFs,
    SharedFsError,
    type SharedFsHandle,
    type SharedFsMountBackendTarget,
} from "../index.js";
import { createIpcV2TestClient } from "./ipc-v2-test-client.js";

/**
 * The error codes a mount backend reports for its target's failures, and
 * that its IPC server sends the adapter: a rename across an ignore boundary
 * is EXDEV, a full or over-quota disk under the store ENOSPC or EDQUOT, an
 * ignore rejection EACCES, and errors with no errno EIO.
 */

const encode = (value: string) => new TextEncoder().encode(value);

/**
 * A directory on a small filesystem the full-disk test may fill: CI mounts a
 * 64 MiB tmpfs there on Linux. Unset, that test is skipped.
 */
const smallDisk = process.env.SHARED_FS_TEST_SMALL_DISK || undefined;
/** The full-disk test refuses to fill a larger filesystem. */
const SMALL_DISK_MAX_BYTES = 256 * 1024 * 1024;

/** `fs` as a mount target, with some methods replaced. */
const targetOf = (
    fs: SharedFsHandle,
    overrides: Partial<SharedFsMountBackendTarget> = {}
): SharedFsMountBackendTarget => ({
    readVersionForMount: (path, versionId) =>
        fs.readVersionForMount(path, versionId),
    writeFile: (path, source, options) => fs.writeFile(path, source, options),
    writeNodeForMount: (nodeId, path, source, options) =>
        fs.writeNodeForMount(nodeId, path, source, options),
    setMetadata: (path, patch, options) => fs.setMetadata(path, patch, options),
    mkdir: (path) => fs.mkdir(path),
    mutateNamespaceForMount: (mutation) => fs.mutateNamespaceForMount(mutation),
    list: (path) => fs.list(path),
    versions: (path) => fs.versions(path),
    conflicts: (path, options) => fs.conflicts(path, options),
    stat: (path) => fs.stat(path),
    onNamespaceChange: (listener) => fs.onNamespaceChange(listener),
    ...overrides,
});

/** An error as Node's fs reports one, with `code`. */
const hostError = (code: string) =>
    Object.assign(new Error(`${code}: host failure`), { code });

/** An IO error as the store's LevelDB (classic-level) throws one. */
const levelIoError = (detail: string) =>
    Object.assign(new Error(`IO error: ${detail}`), {
        code: "LEVEL_IO_ERROR",
    });

describe("mount backend error codes", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;

    beforeEach(async () => {
        peer = await Peerbit.create();
        fs = await openSharedFs({ peerbit: peer, machineLabel: "codes" });
    });

    afterEach(async () => {
        await peer.stop();
    });

    /** Create /f.txt through `backend` and close it: the commit's error. */
    const saveThrough = async (target: SharedFsMountBackendTarget) => {
        const backend = createSharedFsMountBackend(target);
        const handle = await backend.open("/f.txt", {
            write: true,
            create: true,
        });
        await backend.write(handle, encode("bytes"), 0);
        return backend.release(handle);
    };

    it("reports a rename the target refuses as crossing devices as EXDEV, also over IPC", async () => {
        await fs.writeFile("/a.txt", "a");
        const mutate = vi.fn(async () => {
            throw new SharedFsError(
                "EXDEV",
                "rename crosses an artifact-ignore boundary"
            );
        });
        const backend = createSharedFsMountBackend(
            targetOf(fs, { mutateNamespaceForMount: mutate })
        );
        await expect(backend.rename("/a.txt", "/b.txt")).rejects.toMatchObject({
            code: "EXDEV",
        });

        const server = await createSharedFsIpcServer(
            backend,
            "tcp://127.0.0.1:0"
        );
        const client = createIpcV2TestClient(server);
        try {
            await expect(
                client.rename("/a.txt", "/b.txt")
            ).rejects.toMatchObject({ code: "EXDEV" });
        } finally {
            await client.close();
            await server.close();
        }
        expect(mutate).toHaveBeenCalledTimes(2);
        expect(await fs.stat("/b.txt")).toBeUndefined();
    });

    it("reports a rename across an ignore boundary as EXDEV, so tools copy instead", async () => {
        const ignoring = await openSharedFs({
            peerbit: peer,
            machineLabel: "codes",
            ignore: { patterns: ["*.tmp"] },
        });
        await ignoring.writeFile("/main.js", "main");
        const backend = createSharedFsMountBackend(ignoring);
        await expect(
            backend.rename("/main.js", "/main.tmp")
        ).rejects.toMatchObject({ code: "EXDEV" });
        expect(await ignoring.stat("/main.js")).toBeDefined();
    });

    it("reports a full disk under the store as ENOSPC and an exhausted quota as EDQUOT, and nothing else", async () => {
        for (const [thrown, code] of [
            [hostError("ENOSPC"), "ENOSPC"],
            [hostError("EDQUOT"), "EDQUOT"],
            [
                new Error("save failed", { cause: hostError("ENOSPC") }),
                "ENOSPC",
            ],
            [
                new Error("save failed", {
                    cause: new Error("append failed", {
                        cause: hostError("EDQUOT"),
                    }),
                }),
                "EDQUOT",
            ],
            // The store's own errors, as it throws them: LevelDB's carry
            // the operating system's text and no errno (Linux and macOS,
            // then Windows), SQLite's a code of its own.
            [
                levelIoError(
                    "/state/cache/000015.ldb: No space left on device"
                ),
                "ENOSPC",
            ],
            [
                levelIoError("/state/cache/000003.log: Disk quota exceeded"),
                "EDQUOT",
            ],
            [
                levelIoError("/state/cache/000003.log: Disc quota exceeded"),
                "EDQUOT",
            ],
            [levelIoError("/state/cache/000003.log: Quota exceeded"), "EDQUOT"],
            [
                levelIoError(
                    "C:\\state\\cache\\000003.logAppend: cannot write: There is not enough space on the disk.\r\n"
                ),
                "ENOSPC",
            ],
            [
                levelIoError(
                    "C:\\state\\cache\\000005.ldb: The disk is full.\r\n"
                ),
                "ENOSPC",
            ],
            [
                new Error("append failed", {
                    cause: levelIoError(
                        "/state/cache/000015.ldb: No space left on device"
                    ),
                }),
                "ENOSPC",
            ],
            [
                Object.assign(new Error("database or disk is full"), {
                    code: "SQLITE_FULL",
                }),
                "ENOSPC",
            ],
            // Unchanged: an ignore rejection is EACCES; errors with no errno,
            // and host errors other than these two, are EIO.
            [new SharedFsError("EIGNORED", "/f.txt is ignored"), "EACCES"],
            [new SharedFsError("ETIMEDOUT", "timed out"), "EIO"],
            [hostError("EMFILE"), "EIO"],
            [hostError("EPERM"), "EIO"],
            [new Error("save failed", { cause: hostError("EMFILE") }), "EIO"],
            [new Error("untyped"), "EIO"],
            [
                levelIoError("/state/cache/000015.ldb: Input/output error"),
                "EIO",
            ],
            // The text counts only as the operating system's, at the end.
            [
                levelIoError(
                    "/No space left on device/cache/000003.log: Permission denied"
                ),
                "EIO",
            ],
            [new Error("IO error: x: No space left on device"), "EIO"],
        ] as const) {
            const writeFile = vi.fn(async () => {
                throw thrown;
            });
            await expect(
                saveThrough(targetOf(fs, { writeFile }))
            ).rejects.toMatchObject({ code });
            expect(writeFile).toHaveBeenCalledOnce();
        }
        expect(await fs.stat("/f.txt")).toBeUndefined();
    });

    it.runIf(smallDisk)(
        "reports a store whose disk filled up as ENOSPC",
        async () => {
            const { bsize, blocks } = await statfs(smallDisk!);
            const size = bsize * blocks;
            expect(
                size,
                `refusing to fill ${smallDisk}, a filesystem of ${size} bytes`
            ).toBeLessThanOrEqual(SMALL_DISK_MAX_BYTES);
            const directory = await mkdtemp(join(smallDisk!, "store-"));
            // Space the peer gets back before it stops: stopping writes too.
            const ballast = join(directory, "ballast");
            await writeHostFile(ballast, new Uint8Array(4 << 20));
            const full = await Peerbit.create({
                directory: join(directory, "peer"),
            });
            try {
                const fullFs = await openSharedFs({
                    peerbit: full,
                    machineLabel: "full",
                    gc: false,
                    snapshot: { disabled: true },
                });
                const backend = createSharedFsMountBackend(fullFs);
                // Incompressible (the store compresses), 1 MiB per file: the
                // disk is full long before twice its size is written.
                const bytes = new Uint8Array(1 << 20);
                const files = Math.ceil(size / bytes.length) * 2;
                let failure: unknown;
                for (let i = 0; i < files && failure === undefined; i++) {
                    randomFillSync(bytes);
                    try {
                        const handle = await backend.open(`/f${i}.bin`, {
                            write: true,
                            create: true,
                        });
                        await backend.write(handle, bytes, 0);
                        await backend.release(handle);
                    } catch (error) {
                        failure = error;
                    }
                }
                expect(failure).toMatchObject({ code: "ENOSPC" });
                backend.dispose();
            } finally {
                await rm(ballast, { force: true });
                try {
                    await full.stop();
                } finally {
                    await rm(directory, { recursive: true, force: true });
                }
            }
        }
    );
});
