import { serialize } from "@dao-xyz/borsh";
import { DocumentBatchCommitError } from "@peerbit/document";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    FileVersion,
    encodePublicSignKey,
    openSharedFs,
    type SharedFsHandle,
} from "../index.js";

const decode = (bytes: Uint8Array | undefined) =>
    bytes ? new TextDecoder().decode(bytes) : undefined;

const forkVersion = (parent: FileVersion, index: number) =>
    new FileVersion({
        id: `version:required-batching-contract-${index}`,
        nodeId: parent.nodeId,
        parentVersionIds: [parent.id],
        causalDepth: parent.causalDepth + 1n,
        contentHash: parent.contentHash,
        size: parent.size,
        chunkIds: parent.chunkIds,
        createdAt: parent.createdAt + 1n,
        authorKey: parent.authorKey,
        machineLabel: parent.machineLabel,
    });

const localState = async (fs: SharedFsHandle) => ({
    indexedIds: (
        await fs.program.entries.index
            .iterate(
                { query: [] },
                { local: true, remote: false, resolve: false }
            )
            .all()
    )
        .map((row) => row.id)
        .sort(),
    logHashes: (await fs.program.entries.log.log.toArray())
        .map((entry) => entry.hash)
        .sort(),
});

/**
 * Released-consumer reproducer, not a successful required-batching integration.
 * Shared-fs retains its real custom canPerform callback in both modes. Explicit
 * target: "none" and the default target are distinct unsupported configurations;
 * their comparison alone does not establish which fast-path condition rejected.
 *
 * The fixture has already written chunks, versions and naming records. Empty
 * evidence and retrySafe below describe ONLY the subsequent Documents call,
 * not whole-filesystem atomicity, replay safety, or persisted remote receipts.
 */
describe.each(["anonymous", "root-key"] as const)(
    "shared fs released required-batching contract (%s)",
    (auth) => {
        let peer: Peerbit | undefined;

        afterEach(async () => {
            vi.restoreAllMocks();
            const closing = peer;
            peer = undefined;
            await closing?.stop();
        });

        it.each([
            {
                label: "explicit target none",
                targetOptions: { target: "none" as const },
            },
            { label: "default target", targetOptions: {} },
        ])(
            "rejects $label before append without a fallback",
            async ({ targetOptions }) => {
                peer = await Peerbit.create();
                const fs = await openSharedFs({
                    peerbit: peer,
                    machineLabel: "required-batching-contract",
                    ...(auth === "root-key"
                        ? { rootKey: peer.identity.publicKey }
                        : {}),
                });

                const assertAuthorization = async () => {
                    expect(fs.accessControlled).toBe(auth === "root-key");
                    expect(fs.rootKey).toBe(
                        auth === "root-key"
                            ? encodePublicSignKey(peer!.identity.publicKey)
                            : undefined
                    );
                    expect(
                        await fs.isTrustedWriter(peer!.identity.publicKey)
                    ).toBe(true);
                };
                await assertAuthorization();

                const paths = ["/a.txt", "/b.txt"];
                const docs: FileVersion[] = [];
                for (const [index, path] of paths.entries()) {
                    const written = await fs.writeFile(path, `seed ${index}`);
                    expect(written).toBeDefined();
                    const parent = await fs.program.entries.index.get(
                        written!.id,
                        {
                            local: true,
                            remote: false,
                            resolve: true,
                        }
                    );
                    expect(parent).toBeInstanceOf(FileVersion);
                    docs.push(
                        forkVersion(parent as unknown as FileVersion, index)
                    );
                }
                expect(docs).toHaveLength(2);
                expect(new Set(docs.map((doc) => doc.id)).size).toBe(2);

                // Test-only observation of the actual backend; no mock policy,
                // altered mode, append replacement, or simulated successful batch.
                const backend = fs.program.entries as unknown as {
                    _optionCanPerform: unknown;
                    putManySequential: (...args: unknown[]) => Promise<unknown>;
                };
                const canPerform = backend._optionCanPerform;
                expect(typeof canPerform).toBe("function");
                const sequential = vi.spyOn(backend, "putManySequential");
                const independent = vi.spyOn(
                    fs.program.entries.log as unknown as {
                        appendLocallyPreparedPayloadsManyIndependent: (
                            ...args: unknown[]
                        ) => Promise<unknown>;
                    },
                    "appendLocallyPreparedPayloadsManyIndependent"
                );
                const before = await localState(fs);
                expect(before.indexedIds.length).toBeGreaterThan(0);
                expect(before.logHashes.length).toBeGreaterThan(0);

                let failure: unknown;
                try {
                    await fs.program.entries.putMany(docs, {
                        unique: true,
                        ...targetOptions,
                        batching: "required",
                    });
                } catch (error) {
                    failure = error;
                }
                expect(failure).toBeInstanceOf(DocumentBatchCommitError);
                const error = failure as DocumentBatchCommitError;
                expect(error.name).toBe("DocumentBatchCommitError");
                expect(error.localCommit).toBe("not-started");
                expect(error.retrySafe).toBe(true);
                expect(error.recoveryRequired).toBe(false);
                expect(error.committedItems).toEqual([]);
                expect(Object.isFrozen(error)).toBe(true);
                expect(Object.isFrozen(error.committedItems)).toBe(true);
                expect(error.cause).toBeInstanceOf(Error);
                expect((error.cause as Error).message).toMatch(
                    /requires the independent batched document path/
                );
                expect(sequential).not.toHaveBeenCalled();
                expect(independent).not.toHaveBeenCalled();
                expect(backend._optionCanPerform).toBe(canPerform);
                expect(await localState(fs)).toEqual(before);
                for (const [index, path] of paths.entries()) {
                    expect(
                        await fs.program.entries.index.get(docs[index].id, {
                            local: true,
                            remote: false,
                            resolve: false,
                        })
                    ).toBeUndefined();
                    expect(decode(await fs.readFile(path))).toBe(
                        `seed ${index}`
                    );
                    expect(await fs.versions(path)).toHaveLength(1);
                }

                // The SAME nonempty, unique documents are valid under the real
                // callback. Omitting the requirement preserves sequential fallback.
                const legacy = await fs.program.entries.putMany(docs, {
                    unique: true,
                    ...targetOptions,
                });
                expect(legacy.entries).toHaveLength(docs.length);
                expect(sequential).toHaveBeenCalledTimes(1);
                expect(independent).not.toHaveBeenCalled();
                for (const doc of docs) {
                    const stored = await fs.program.entries.index.get(doc.id, {
                        local: true,
                        remote: false,
                        resolve: true,
                    });
                    expect(stored).toBeInstanceOf(FileVersion);
                    expect(serialize(stored!)).toEqual(serialize(doc));
                }
                sequential.mockRestore();
                independent.mockRestore();

                const batch = await fs.writeBatch(
                    paths.map((path, index) => ({
                        path,
                        content: `legacy ${index}`,
                    }))
                );
                expect(batch.results).toHaveLength(2);
                expect(
                    batch.results.every((result) => result?.head === true)
                ).toBe(true);
                for (const [index, path] of paths.entries()) {
                    expect(decode(await fs.readFile(path))).toBe(
                        `legacy ${index}`
                    );
                    expect(await fs.versions(path)).toHaveLength(3);
                }
                expect(backend._optionCanPerform).toBe(canPerform);
                await assertAuthorization();
            }
        );
    }
);
