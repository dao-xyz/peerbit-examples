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
                new Error("save failed", { cause: hostError("EDQUOT") }),
                "EDQUOT",
            ],
            // Unchanged: an ignore rejection is EACCES; errors with no errno,
            // and host errors other than these two, are EIO.
            [new SharedFsError("EIGNORED", "/f.txt is ignored"), "EACCES"],
            [new SharedFsError("ETIMEDOUT", "timed out"), "EIO"],
            [hostError("EMFILE"), "EIO"],
            [hostError("EPERM"), "EIO"],
            [new Error("save failed", { cause: hostError("EMFILE") }), "EIO"],
            [new Error("untyped"), "EIO"],
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
});
