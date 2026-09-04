import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    openSharedFs,
    type SharedFsHandle,
    type WriteBatchResult,
} from "../index.js";

// Fixed across platforms so the portable job exposes the real durability tail.
const WAIT_TIMEOUT_MS = 45_000;
const TEST_TIMEOUT_MS = 150_000;

const bytesEqual = (left: Uint8Array | undefined, right: Uint8Array) =>
    !!left &&
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index]);

const patternedBytes = (writer: number, file: number) => {
    const bytes = new Uint8Array(3_000 + writer * 97 + file * 31);
    for (let index = 0; index < bytes.length; index++) {
        bytes[index] = (index * 17 + writer * 43 + file * 71) % 251;
    }
    return bytes;
};

const waitUntil = async (
    assertion: () => Promise<void> | void,
    timeoutMs = WAIT_TIMEOUT_MS
) => {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
    throw lastError;
};

describe("shared fs persistent multi-writer lifecycle", () => {
    const peers = new Set<Peerbit>();
    const temporaryDirectories = new Set<string>();

    const trackPeer = async (directory: string) => {
        const peer = await Peerbit.create({ directory });
        peers.add(peer);
        return peer;
    };

    const stopPeer = async (peer: Peerbit) => {
        peers.delete(peer);
        try {
            await peer.stop();
        } catch (error) {
            // Existing integration tests treat this document-index close race
            // as benign once every asserted operation has completed.
            if (
                !(
                    error instanceof TypeError &&
                    error.message.includes("clearAll")
                )
            ) {
                throw error;
            }
        }
    };

    const waitForRemoteReceiptReadiness = async (
        source: SharedFsHandle,
        remote: Peerbit | Peerbit[],
        log: any = source.program.entries.log
    ) => {
        const remotes = Array.isArray(remote) ? remote : [remote];
        const entries = await log.log.toArray();
        const replicas = log.replicas.min.getValue(log);
        await Promise.all(
            remotes.map((peer) =>
                log.waitForPersistedReceiptPeerReadiness(
                    peer.identity.publicKey,
                    {
                        entries,
                        replicas,
                        timeout: WAIT_TIMEOUT_MS,
                    }
                )
            )
        );
    };

    const openReplica = (
        peerbit: Peerbit,
        address: string,
        machineLabel: string
    ) =>
        openSharedFs({
            peerbit,
            address,
            machineLabel,
            replicate: { factor: 1 },
            bootstrap: false,
            remoteChunkFetch: false,
            gc: false,
        });

    const expectManifestComplete = async (
        fs: SharedFsHandle,
        changesetId: string,
        result: WriteBatchResult
    ) => {
        expect(result.manifest).toBeDefined();
        const status = await fs.awaitChangeset(changesetId, {
            manifestId: result.manifest!.manifestId,
            timeoutMs: WAIT_TIMEOUT_MS,
        });
        expect(status).toMatchObject({
            complete: true,
            verdict: "complete",
            expected: result.manifest!.memberCount,
            arrived: result.manifest!.memberCount,
        });
    };

    afterEach(async () => {
        const results = await Promise.allSettled(
            [...peers].map((peer) => stopPeer(peer))
        );
        peers.clear();
        await Promise.allSettled(
            [...temporaryDirectories].map((directory) =>
                rm(directory, { recursive: true, force: true })
            )
        );
        temporaryDirectories.clear();
        const failure = results.find(
            (result): result is PromiseRejectedResult =>
                result.status === "rejected"
        );
        if (failure) throw failure.reason;
    });

    it(
        "keeps three authenticated disk replicas converged through writes, restart, conflict, and disposal",
        { timeout: TEST_TIMEOUT_MS },
        async () => {
            const root = await mkdtemp(
                join(tmpdir(), "peerbit-shared-fs-persistent-writers-")
            );
            temporaryDirectories.add(root);
            const directories = [
                join(root, "owner"),
                join(root, "writer-two"),
                join(root, "writer-three"),
            ];
            const network = await Promise.all(directories.map(trackPeer));
            await Promise.all([
                network[0].dial(network[1]),
                network[0].dial(network[2]),
                network[1].dial(network[2]),
            ]);

            const identities = network.map((peer) =>
                peer.identity.publicKey.hashcode()
            );
            const owner = await openSharedFs({
                peerbit: network[0],
                machineLabel: "owner",
                rootKey: network[0].identity.publicKey,
                replicate: { factor: 1 },
                bootstrap: false,
                remoteChunkFetch: false,
                gc: false,
            });
            expect(owner.address).toBeDefined();
            const address = owner.address!;

            await owner.authorizeWriter(network[1].identity.publicKey);
            await owner.authorizeWriter(network[2].identity.publicKey);
            await owner.mkdir("/rounds");
            await owner.mkdir("/rounds/owner");
            await owner.mkdir("/rounds/writer-two");
            await owner.mkdir("/rounds/writer-three");
            await owner.writeFile("/seed.txt", "readiness evidence");

            const [writerTwo, writerThree] = await Promise.all([
                openReplica(network[1], address, "writer-two"),
                openReplica(network[2], address, "writer-three"),
            ]);
            let handles = [owner, writerTwo, writerThree];

            // These are genuine address-open readiness fences. The test never
            // enables allowPartialWrites, including on the later warm reopen.
            await Promise.all(
                handles
                    .slice(1)
                    .map((fs) =>
                        fs.awaitWriteReady({ timeout: WAIT_TIMEOUT_MS })
                    )
            );
            for (const fs of handles) {
                expect(fs.bootstrapStatus()).toMatchObject({
                    writeReady: true,
                    partialWriteOverride: false,
                });
                await waitUntil(async () => {
                    expect(
                        await fs.isTrustedWriter(network[1].identity.publicKey)
                    ).toBe(true);
                    expect(
                        await fs.isTrustedWriter(network[2].identity.publicKey)
                    ).toBe(true);
                });
            }

            const labels = ["owner", "writer-two", "writer-three"];
            const expectedFiles = new Map<string, Uint8Array>();
            const changesets = handles.map((_, writer) => {
                const entries = [0, 1].map((file) => {
                    const path = `/rounds/${labels[writer]}/file-${file}.bin`;
                    const content = patternedBytes(writer, file);
                    expectedFiles.set(path, content);
                    return { path, content, chunkSize: 1_024 };
                });
                return {
                    id: `writer-${writer + 1}-batch`,
                    entries,
                };
            });
            const batchStartedAt = performance.now();
            const batchCommits = await Promise.all(
                handles.map(async (fs, writer) => {
                    const startedAt = performance.now();
                    const result = await fs.writeBatch(
                        changesets[writer].entries,
                        {
                            changesetId: changesets[writer].id,
                            manifest: true,
                        }
                    );
                    return {
                        result,
                        durationMs: performance.now() - startedAt,
                    };
                })
            );
            const batchResults = batchCommits.map(({ result }) => result);
            await Promise.all(
                handles.flatMap((fs) =>
                    changesets.map((changeset, index) =>
                        expectManifestComplete(
                            fs,
                            changeset.id,
                            batchResults[index]
                        )
                    )
                )
            );
            const allChangesetsAdmittedMs = performance.now() - batchStartedAt;
            for (const fs of handles) {
                // A changeset manifest proves that its version and naming
                // members arrived; chunks replicate on their own log. Wait on
                // the invariant this campaign actually needs before disabling
                // remote fetch or restarting a replica: every referenced byte
                // is locally readable on every custodian.
                await waitUntil(async () => {
                    for (const [path, expected] of expectedFiles) {
                        expect(
                            bytesEqual(await fs.readFile(path), expected)
                        ).toBe(true);
                    }
                });
            }
            const allBatchBytesReadableMs = performance.now() - batchStartedAt;

            // Cleanly restart writer three and prove both its identity and its
            // write-readiness evidence survive in the same state directory.
            await stopPeer(network[2]);
            const warmPeerCreateStartedAt = performance.now();
            const reopenedPeer = await trackPeer(directories[2]);
            const warmPeerCreateMs =
                performance.now() - warmPeerCreateStartedAt;
            expect(reopenedPeer.identity.publicKey.hashcode()).toBe(
                identities[2]
            );
            const warmFsOpenStartedAt = performance.now();
            const reopenedWriter = await openReplica(
                reopenedPeer,
                address,
                "writer-three"
            );
            await reopenedWriter.awaitWriteReady({ timeout: WAIT_TIMEOUT_MS });
            const warmOfflineFsOpenToReadyMs =
                performance.now() - warmFsOpenStartedAt;
            expect(reopenedWriter.bootstrapStatus()).toMatchObject({
                writeReady: true,
                partialWriteOverride: false,
                writeReadinessSource: "remote-settled",
            });
            // No peer has been dialed yet: these reads and the ready state can
            // only come from the same directory's persisted local evidence.
            for (const [path, expected] of expectedFiles) {
                expect(
                    bytesEqual(await reopenedWriter.readFile(path), expected)
                ).toBe(true);
            }
            await Promise.all([
                reopenedPeer.dial(network[0]),
                reopenedPeer.dial(network[1]),
            ]);
            handles = [owner, writerTwo, reopenedWriter];

            const baseChangeset = "three-way-conflict-base";
            const baseResult = await owner.writeBatch(
                [{ path: "/contested.bin", content: "base" }],
                { changesetId: baseChangeset, manifest: true }
            );
            await Promise.all(
                handles.map((fs) =>
                    expectManifestComplete(fs, baseChangeset, baseResult)
                )
            );
            const baseVersion = baseResult.results[0];
            expect(baseVersion).toBeDefined();

            const conflictPayloads = handles.map((_, writer) =>
                patternedBytes(writer + 10, 0)
            );
            const conflictStartedAt = performance.now();
            const conflictVersions = await Promise.all(
                handles.map((fs, writer) =>
                    fs.writeFile("/contested.bin", conflictPayloads[writer], {
                        baseVersionIds: [baseVersion!.id],
                        chunkSize: 1_024,
                    })
                )
            );
            const expectedHeadIds = conflictVersions
                .map((version) => version.id)
                .sort();
            const payloadByVersion = new Map(
                conflictVersions.map((version, index) => [
                    version.id,
                    conflictPayloads[index],
                ])
            );

            await waitUntil(async () => {
                for (const fs of handles) {
                    const conflicts = await fs.conflicts("/contested.bin");
                    expect(conflicts).toHaveLength(1);
                    expect(
                        conflicts[0].versions
                            .map((version) => version.id)
                            .sort()
                    ).toEqual(expectedHeadIds);
                    for (const versionId of expectedHeadIds) {
                        expect(
                            bytesEqual(
                                await fs.readVersion(
                                    "/contested.bin",
                                    versionId
                                ),
                                payloadByVersion.get(versionId)!
                            )
                        ).toBe(true);
                    }
                }
            });
            const conflictConvergedMs = performance.now() - conflictStartedAt;

            // Dispose the machine that was just restarted. The two remaining
            // disk-backed writers must each acknowledge every data and trust
            // entry before its state directory is removed.
            await Promise.all([
                waitForRemoteReceiptReadiness(reopenedWriter, [
                    network[0],
                    network[1],
                ]),
                waitForRemoteReceiptReadiness(
                    reopenedWriter,
                    [network[0], network[1]],
                    reopenedWriter.program.trustGraph!.trustGraph.log
                ),
            ]);
            const disposalStartedAt = performance.now();
            const disposal = await reopenedWriter.prepareForDisposal({
                minAcks: 2,
                timeout: WAIT_TIMEOUT_MS,
            });
            const disposalBarrierMs = performance.now() - disposalStartedAt;
            expect(disposal).toMatchObject({
                safeToDispose: true,
                guarantee: "persisted-per-entry",
                minAcksPerEntry: 2,
                empty: false,
            });
            expect(disposal.entries.trust).toBeGreaterThanOrEqual(2);

            console.log(
                "persistent-multi-writer:",
                JSON.stringify(
                    {
                        batchLocalCommitMs: batchCommits.map(
                            ({ durationMs }) => durationMs
                        ),
                        allChangesetsAdmittedMs,
                        allBatchBytesReadableMs,
                        warmPeerCreateMs,
                        warmOfflineFsOpenToReadyMs,
                        conflictConvergedMs,
                        disposalBarrierMs,
                        disposalEntries: disposal.entryCount,
                    },
                    (_key, value) =>
                        typeof value === "number"
                            ? Number(value.toFixed(1))
                            : value
                )
            );

            await stopPeer(reopenedPeer);
            await rm(directories[2], { recursive: true, force: true });
            await Promise.all([stopPeer(network[0]), stopPeer(network[1])]);

            // Reopen each acknowledged custodian in isolation. With the other
            // machines stopped, remote fetch disabled, and the disposed source
            // directory gone, all metadata and bytes must come from that one
            // custodian's local store after a clean shutdown. Abrupt-process
            // crash testing is a separate harness.
            for (const custodian of [0, 1]) {
                const offlinePeer = await trackPeer(directories[custodian]);
                expect(offlinePeer.identity.publicKey.hashcode()).toBe(
                    identities[custodian]
                );
                const offline = await openSharedFs({
                    peerbit: offlinePeer,
                    address,
                    machineLabel: `offline-custodian-${custodian + 1}`,
                    replicate: false,
                    bootstrap: false,
                    remoteChunkFetch: false,
                    gc: false,
                });
                expect(offline.accessControlled).toBe(true);
                for (const identity of network.map(
                    (peer) => peer.identity.publicKey
                )) {
                    expect(await offline.isTrustedWriter(identity)).toBe(true);
                }
                for (const [path, expected] of expectedFiles) {
                    expect(
                        bytesEqual(await offline.readFile(path), expected)
                    ).toBe(true);
                }
                for (const [index, changeset] of changesets.entries()) {
                    await expectManifestComplete(
                        offline,
                        changeset.id,
                        batchResults[index]
                    );
                }
                const offlineConflicts =
                    await offline.conflicts("/contested.bin");
                expect(offlineConflicts).toHaveLength(1);
                expect(
                    offlineConflicts[0].versions
                        .map((version) => version.id)
                        .sort()
                ).toEqual(expectedHeadIds);
                for (const versionId of expectedHeadIds) {
                    expect(
                        bytesEqual(
                            await offline.readVersion(
                                "/contested.bin",
                                versionId
                            ),
                            payloadByVersion.get(versionId)!
                        )
                    ).toBe(true);
                }
                await stopPeer(offlinePeer);
            }
        }
    );
});
