import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    SharedFsCreateParentMismatchError,
    SharedFsExpectedNodeMismatchError,
    openSharedFs,
    type SharedFsHandle,
} from "../index.js";

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
};

const captureMismatch = async (promise: Promise<unknown>) => {
    try {
        await promise;
        throw new Error("expected an expected-node mismatch");
    } catch (error) {
        expect(error).toBeInstanceOf(SharedFsExpectedNodeMismatchError);
        return error as SharedFsExpectedNodeMismatchError;
    }
};

describe("expected-node mismatch discriminator", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;

    beforeEach(async () => {
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "expected-node-test",
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await peer.stop();
    });

    it("identifies every expected-node guard checkpoint", async () => {
        const initial = await fs.writeFile("/initial.txt", "first");
        await fs.rm("/initial.txt");
        const initialWinner = await fs.writeFile("/initial.txt", "winner");
        expect(
            await captureMismatch(
                fs.writeFile("/initial.txt", "stale", {
                    expectedNodeId: initial.nodeId,
                })
            )
        ).toMatchObject({
            code: "EAGAIN",
            checkpoint: "initial",
            path: "/initial.txt",
            expectedNodeId: initial.nodeId,
            actualNodeId: initialWinner.nodeId,
        });

        const base = await fs.writeFile("/base.txt", "base");
        const other = await fs.writeFile("/other.txt", "other");
        expect(
            await captureMismatch(
                fs.writeFile("/base.txt", "changed", {
                    baseVersionIds: [other.id],
                    expectedNodeId: base.nodeId,
                })
            )
        ).toMatchObject({
            checkpoint: "base-version",
            expectedNodeId: base.nodeId,
            actualNodeId: other.nodeId,
        });

        const noOp = await fs.writeFile("/no-op.txt", "same");
        const noOpEntered = deferred();
        const noOpAllowed = deferred();
        const program = fs.program as any;
        const headsForNode = program.headsForNode.bind(program);
        const headsSpy = vi
            .spyOn(program, "headsForNode")
            .mockImplementationOnce(async (nodeId: string) => {
                const heads = await headsForNode(nodeId);
                noOpEntered.resolve();
                await noOpAllowed.promise;
                return heads;
            });
        const noOpWrite = fs.writeFile("/no-op.txt", "same", {
            expectedNodeId: noOp.nodeId,
        });
        await noOpEntered.promise;
        await fs.rm("/no-op.txt");
        const noOpWinner = await fs.writeFile("/no-op.txt", "winner");
        noOpAllowed.resolve();
        expect(await captureMismatch(noOpWrite)).toMatchObject({
            checkpoint: "no-op",
            expectedNodeId: noOp.nodeId,
            actualNodeId: noOpWinner.nodeId,
        });
        headsSpy.mockRestore();

        const beforeVersion = await fs.writeFile(
            "/before-version.txt",
            "first"
        );
        const versionEntered = deferred();
        const versionAllowed = deferred();
        const touchChunks = program.touchChunks.bind(program);
        const touchSpy = vi
            .spyOn(program, "touchChunks")
            .mockImplementationOnce(async (...args: unknown[]) => {
                versionEntered.resolve();
                await versionAllowed.promise;
                return touchChunks(...args);
            });
        const beforeVersionWrite = fs.writeFile(
            "/before-version.txt",
            "changed",
            {
                expectedNodeId: beforeVersion.nodeId,
                dedup: "off",
            }
        );
        await versionEntered.promise;
        await fs.rm("/before-version.txt");
        const beforeVersionWinner = await fs.writeFile(
            "/before-version.txt",
            "winner"
        );
        versionAllowed.resolve();
        expect(await captureMismatch(beforeVersionWrite)).toMatchObject({
            checkpoint: "before-version",
            expectedNodeId: beforeVersion.nodeId,
            actualNodeId: beforeVersionWinner.nodeId,
        });
        touchSpy.mockRestore();

        const gateVersionPut = () => {
            const entered = deferred();
            const allowed = deferred();
            const entriesPut = program.entries.put.bind(program.entries);
            let gate = true;
            const spy = vi
                .spyOn(program.entries, "put")
                .mockImplementation(
                    async (document: unknown, options: unknown) => {
                        const result = await entriesPut(document, options);
                        if (
                            gate &&
                            (document as { constructor?: { name?: string } })
                                .constructor?.name === "FileVersion"
                        ) {
                            gate = false;
                            entered.resolve();
                            await allowed.promise;
                        }
                        return result;
                    }
                );
            return { entered, allowed, spy };
        };

        const beforeNamingGate = gateVersionPut();
        const beforeNamingWrite = fs.writeFile("/before-naming.txt", "stale", {
            expectedNodeId: null,
            dedup: "off",
        });
        await beforeNamingGate.entered.promise;
        const namingWinner = await fs.writeFile("/before-naming.txt", "winner");
        beforeNamingGate.allowed.resolve();
        expect(await captureMismatch(beforeNamingWrite)).toMatchObject({
            checkpoint: "before-naming",
            expectedNodeId: null,
            actualNodeId: namingWinner.nodeId,
        });
        beforeNamingGate.spy.mockRestore();

        const afterVersion = await fs.writeFile("/after-version.txt", "first");
        const afterVersionGate = gateVersionPut();
        const afterVersionWrite = fs.writeFile(
            "/after-version.txt",
            "changed",
            {
                expectedNodeId: afterVersion.nodeId,
                dedup: "off",
            }
        );
        await afterVersionGate.entered.promise;
        await fs.rm("/after-version.txt");
        const afterVersionWinner = await fs.writeFile(
            "/after-version.txt",
            "winner"
        );
        afterVersionGate.allowed.resolve();
        expect(await captureMismatch(afterVersionWrite)).toMatchObject({
            checkpoint: "after-version",
            expectedNodeId: afterVersion.nodeId,
            actualNodeId: afterVersionWinner.nodeId,
        });
        afterVersionGate.spy.mockRestore();
    });

    it("classifies a missing or non-directory create parent atomically", async () => {
        const missing = await fs
            .writeFile("/missing/child.txt", "bytes", {
                expectedNodeId: null,
            })
            .catch((error: unknown) => error);
        expect(missing).toBeInstanceOf(SharedFsCreateParentMismatchError);
        expect(missing).toMatchObject({
            code: "ENOENT",
            path: "/missing/child.txt",
            parentPath: "/missing",
        });

        await fs.writeFile("/file-parent", "file");
        const notDirectory = await fs
            .writeFile("/file-parent/child.txt", "bytes", {
                expectedNodeId: null,
            })
            .catch((error: unknown) => error);
        expect(notDirectory).toBeInstanceOf(SharedFsCreateParentMismatchError);
        expect(notDirectory).toMatchObject({
            code: "ENOTDIR",
            path: "/file-parent/child.txt",
            parentPath: "/file-parent",
        });
    });

    it("binds a guarded nested create to the exact parent directory node", async () => {
        await fs.mkdir("/parent");
        const originalParent = await fs.stat("/parent");
        expect(originalParent?.kind).toBe("directory");
        await fs.rm("/parent");
        await fs.mkdir("/parent");
        const replacementParent = await fs.stat("/parent");
        expect(replacementParent?.kind).toBe("directory");

        const mismatch = await fs
            .writeFile("/parent/child.txt", "bytes", {
                expectedNodeId: null,
                expectedParentNodeId: originalParent?.nodeId,
            })
            .catch((error: unknown) => error);
        expect(mismatch).toBeInstanceOf(SharedFsCreateParentMismatchError);
        expect(mismatch).toMatchObject({
            code: "EAGAIN",
            mismatchCode: "EAGAIN",
            path: "/parent/child.txt",
            parentPath: "/parent",
            expectedParentNodeId: originalParent?.nodeId,
            actualParentNodeId: replacementParent?.nodeId,
        });
        expect(await fs.stat("/parent/child.txt")).toBeUndefined();
    });

    it("rejects malformed expected-parent guards", async () => {
        await expect(
            fs.writeFile("/missing-null-guard.txt", "bytes", {
                expectedParentNodeId: "dir:parent",
            })
        ).rejects.toMatchObject({ code: "EINVAL" });
        await expect(
            fs.writeFile("/empty-parent-guard.txt", "bytes", {
                expectedNodeId: null,
                expectedParentNodeId: "",
            })
        ).rejects.toMatchObject({ code: "EINVAL" });
        await expect(
            fs.writeFile("/non-string-parent-guard.txt", "bytes", {
                expectedNodeId: null,
                expectedParentNodeId: 7 as never,
            })
        ).rejects.toMatchObject({ code: "EINVAL" });
    });
});
