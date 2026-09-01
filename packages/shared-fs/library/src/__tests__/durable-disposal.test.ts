import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    openSharedFs,
    PrepareForDisposalError,
    type SharedFsHandle,
} from "../index.js";
import { FileChunk, type NamingEvent } from "../model.js";

const WAIT_TIMEOUT_MS = process.env.CI ? 90_000 : 30_000;
// The capability is intentionally session-scoped. It is not currently
// exported from @peerbit/shared-log's package root, so mirror its wire bit in
// this integration test just as the upstream document integration test does.
const PERSISTED_ENTRY_RECEIPTS_CAPABILITY = 1 << 5;

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

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
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }
    throw lastError;
};

describe("shared fs durable machine disposal", () => {
    const peers = new Set<Peerbit>();
    const temporaryDirectories = new Set<string>();

    const trackPeer = async (
        options?: Parameters<typeof Peerbit.create>[0]
    ) => {
        const peer = await Peerbit.create(options);
        peers.add(peer);
        return peer;
    };

    const stopPeer = async (peer: Peerbit) => {
        peers.delete(peer);
        try {
            await peer.stop();
        } catch (error) {
            // Keep parity with the existing shared-fs integration cleanup:
            // this close race is benign after all asserted work completed.
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

    const waitForRemoteReceiptCapability = async (
        source: SharedFsHandle,
        remote: Peerbit,
        log: any = source.program.entries.log
    ) => {
        await log.waitForReplicator(remote.identity.publicKey, {
            roleAge: 0,
            timeout: WAIT_TIMEOUT_MS,
        });
        const remoteHash = remote.identity.publicKey.hashcode();
        await waitUntil(() => {
            const capabilities = (
                log as {
                    _peerSyncCapabilities: Map<string, number>;
                }
            )._peerSyncCapabilities.get(remoteHash);
            expect(
                (capabilities ?? 0) & PERSISTED_ENTRY_RECEIPTS_CAPABILITY
            ).toBe(PERSISTED_ENTRY_RECEIPTS_CAPABILITY);
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
        if (failure) {
            throw failure.reason;
        }
    });

    it("survives immediate source disposal and an offline durable-replica reopen", async () => {
        const root = await mkdtemp(
            join(tmpdir(), "peerbit-shared-fs-disposal-")
        );
        temporaryDirectories.add(root);
        const sourceDirectory = join(root, "source");
        const receiverDirectory = join(root, "receiver");

        const sourcePeer = await trackPeer({ directory: sourceDirectory });
        const receiverPeer = await trackPeer({
            directory: receiverDirectory,
        });
        await sourcePeer.dial(receiverPeer);

        const source = await openSharedFs({
            peerbit: sourcePeer,
            machineLabel: "disposable-source",
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });
        const address = source.address;
        expect(address).toBeDefined();
        await openSharedFs({
            peerbit: receiverPeer,
            address,
            machineLabel: "durable-receiver",
            replicate: { factor: 1 },
            bootstrap: false,
            remoteChunkFetch: false,
            gc: false,
        });
        await waitForRemoteReceiptCapability(source, receiverPeer);

        await source.mkdir("/workspace");
        await source.mkdir("/workspace/docs");
        const sharedContent = "aaaabbbbccccdddd";
        await source.writeFile("/workspace/docs/a.bin", sharedContent, {
            chunkSize: 4,
        });
        await source.writeFile("/workspace/docs/b.bin", sharedContent, {
            chunkSize: 4,
        });
        await source.writeFile("/workspace/docs/deleted.txt", "zzzz", {
            chunkSize: 4,
        });
        await source.rm("/workspace/docs/deleted.txt");

        const disposal = await source.prepareForDisposal({
            minAcks: 1,
            timeout: WAIT_TIMEOUT_MS,
        });

        expect(disposal).toMatchObject({
            safeToDispose: true,
            guarantee: "persisted-per-entry",
            minAcksPerEntry: 1,
            empty: false,
        });
        expect(disposal.entries.chunks).toBeGreaterThanOrEqual(4);
        // The two live files reference eight chunk positions but only four
        // distinct content-addressed chunks. A retained deleted version may
        // add its one distinct chunk to the disposal closure.
        expect(disposal.entries.chunks).toBeLessThan(9);
        expect(disposal.entries.versions).toBeGreaterThanOrEqual(2);
        expect(disposal.entries.naming).toBeGreaterThanOrEqual(5);
        expect(disposal.entryCount).toBe(
            disposal.entries.chunks +
                disposal.entries.versions +
                disposal.entries.naming +
                disposal.entries.trust
        );
        expect(disposal.receiptBatches).toBeGreaterThanOrEqual(1);

        // The acknowledgement is the machine-disposal gate: remove the only
        // source copy immediately after it returns.
        await stopPeer(sourcePeer);
        await rm(sourceDirectory, { recursive: true, force: true });

        // Gracefully close and reopen the acknowledged replica too, then open
        // it with no network and no remote chunk fallback. Every successful
        // read below is therefore served from the receiver's persisted local
        // state. Abrupt termination is covered by the process-crash harness.
        await stopPeer(receiverPeer);
        const reopenedPeer = await trackPeer({ directory: receiverDirectory });
        const reopened = await openSharedFs({
            peerbit: reopenedPeer,
            address,
            machineLabel: "offline-reopen",
            replicate: false,
            bootstrap: false,
            remoteChunkFetch: false,
            gc: false,
        });

        expect(decode(await reopened.readFile("/workspace/docs/a.bin"))).toBe(
            sharedContent
        );
        expect(decode(await reopened.readFile("/workspace/docs/b.bin"))).toBe(
            sharedContent
        );
        expect(
            await reopened.stat("/workspace/docs/deleted.txt")
        ).toBeUndefined();
        expect(
            (await reopened.list("/workspace/docs"))
                .map((entry) => entry.name)
                .sort()
        ).toEqual(["a.bin", "b.bin"]);
        expect(await reopened.namingConflicts()).toEqual([]);
    });

    it(
        "persists every content-conflict head on two independently reopenable replicas",
        { retry: 1, timeout: process.env.CI ? 180_000 : 90_000 },
        async () => {
            const root = await mkdtemp(
                join(tmpdir(), "peerbit-shared-fs-two-replica-disposal-")
            );
            temporaryDirectories.add(root);
            const receiverDirectories = [
                join(root, "receiver-one"),
                join(root, "receiver-two"),
            ];

            const sourcePeer = await trackPeer();
            const receiverPeers = await Promise.all(
                receiverDirectories.map((directory) => trackPeer({ directory }))
            );
            await Promise.all(
                receiverPeers.map((receiverPeer) =>
                    sourcePeer.dial(receiverPeer)
                )
            );

            const source = await openSharedFs({
                peerbit: sourcePeer,
                machineLabel: "two-replica-source",
                replicate: { factor: 1 },
                bootstrap: false,
                gc: false,
            });
            const address = source.address;
            expect(address).toBeDefined();
            await Promise.all(
                receiverPeers.map((receiverPeer, index) =>
                    openSharedFs({
                        peerbit: receiverPeer,
                        address,
                        machineLabel: `durable-receiver-${index + 1}`,
                        replicate: { factor: 1 },
                        bootstrap: false,
                        remoteChunkFetch: false,
                        gc: false,
                    })
                )
            );
            await Promise.all(
                receiverPeers.map((receiverPeer) =>
                    waitForRemoteReceiptCapability(source, receiverPeer)
                )
            );

            await source.writeFile("/contested.txt", "base");
            const baseVersionIds = (await source.versions("/contested.txt"))
                .filter((version) => version.head)
                .map((version) => version.id);
            const left = await source.writeFile("/contested.txt", "left", {
                baseVersionIds,
            });
            const right = await source.writeFile("/contested.txt", "right", {
                baseVersionIds,
            });
            const expectedHeadIds = [left.id, right.id].sort();
            expect(
                (await source.conflicts("/contested.txt"))[0].versions
                    .map((version) => version.id)
                    .sort()
            ).toEqual(expectedHeadIds);

            const disposal = await source.prepareForDisposal({
                minAcks: 2,
                timeout: WAIT_TIMEOUT_MS,
            });
            expect(disposal).toMatchObject({
                safeToDispose: true,
                guarantee: "persisted-per-entry",
                minAcksPerEntry: 2,
                empty: false,
            });
            expect(disposal.entries.versions).toBeGreaterThanOrEqual(2);

            await stopPeer(sourcePeer);
            await Promise.all(receiverPeers.map((peer) => stopPeer(peer)));

            // Reopen each acknowledged replica by itself. The other machines
            // remain stopped, so conflict metadata and both payloads can only
            // come from that receiver's crash-safe local store.
            for (const [index, directory] of receiverDirectories.entries()) {
                const reopenedPeer = await trackPeer({ directory });
                const reopened = await openSharedFs({
                    peerbit: reopenedPeer,
                    address,
                    machineLabel: `offline-reopen-${index + 1}`,
                    replicate: false,
                    bootstrap: false,
                    remoteChunkFetch: false,
                    gc: false,
                });

                const conflicts = await reopened.conflicts("/contested.txt");
                expect(conflicts).toHaveLength(1);
                expect(
                    conflicts[0].versions.map((version) => version.id).sort()
                ).toEqual(expectedHeadIds);
                expect(
                    decode(
                        await reopened.readVersion("/contested.txt", left.id)
                    )
                ).toBe("left");
                expect(
                    decode(
                        await reopened.readVersion("/contested.txt", right.id)
                    )
                ).toBe("right");
                expect(["left", "right"]).toContain(
                    decode(await reopened.readFile("/contested.txt"))
                );

                await stopPeer(reopenedPeer);
            }
        }
    );

    it(
        "preserves admitted naming-conflict heads and a tombstone after an access-controlled source is disposed",
        { retry: 1, timeout: process.env.CI ? 180_000 : 90_000 },
        async () => {
            const receiverDirectory = await mkdtemp(
                join(tmpdir(), "peerbit-shared-fs-auth-disposal-")
            );
            temporaryDirectories.add(receiverDirectory);

            const sourcePeer = await trackPeer();
            const writerPeer = await trackPeer();
            const receiverPeer = await trackPeer({
                directory: receiverDirectory,
            });
            const writerKey = writerPeer.identity.publicKey;
            await Promise.all([
                sourcePeer.dial(writerPeer),
                sourcePeer.dial(receiverPeer),
            ]);
            const source = await openSharedFs({
                peerbit: sourcePeer,
                machineLabel: "access-controlled-source",
                rootKey: sourcePeer.identity.publicKey,
                replicate: { factor: 1 },
                bootstrap: false,
                gc: false,
            });
            const writer = await openSharedFs({
                peerbit: writerPeer,
                address: source.address,
                machineLabel: "admitted-writer",
                replicate: { factor: 1 },
                bootstrap: false,
                gc: false,
                // The test intentionally lets a second writer act before an
                // initially empty namespace can yield readiness evidence.
                allowPartialWrites: true,
            });
            const receiver = await openSharedFs({
                peerbit: receiverPeer,
                address: source.address,
                machineLabel: "durable-access-controlled-receiver",
                replicate: { factor: 1 },
                bootstrap: false,
                remoteChunkFetch: false,
                gc: false,
            });
            await waitForRemoteReceiptCapability(source, receiverPeer);
            await waitForRemoteReceiptCapability(
                source,
                receiverPeer,
                source.program.trustGraph!.trustGraph.log
            );

            await source.authorizeWriter(writerKey);
            await waitUntil(async () => {
                expect(await writer.isTrustedWriter(writerKey)).toBe(true);
                expect(await receiver.isTrustedWriter(writerKey)).toBe(true);
            });
            await source.writeFile("/subject.txt", "shared subject");
            await writer.writeFile("/admitted.txt", "trusted writer data");
            await source.writeFile("/deleted.txt", "retained tombstone data");
            await source.rm("/deleted.txt");
            const expectedTombstone = (
                (await source.program.entries.index
                    .iterate(
                        { query: { kind: "naming" } },
                        { local: true, remote: false, resolve: true }
                    )
                    .all()) as NamingEvent[]
            ).find((event) => event.name === "deleted.txt" && event.deleted);
            expect(expectedTombstone).toBeDefined();
            await waitUntil(async () => {
                expect(decode(await writer.readFile("/subject.txt"))).toBe(
                    "shared subject"
                );
                expect(decode(await source.readFile("/admitted.txt"))).toBe(
                    "trusted writer data"
                );
            });

            // Partition the two admitted writers so both renames observe the
            // same naming head, deterministically creating a real multi-head
            // naming conflict rather than relying on scheduler timing.
            await sourcePeer.hangUp(writerPeer.identity.publicKey);
            await source.rename("/subject.txt", "/from-owner.txt");
            await writer.rename("/subject.txt", "/from-writer.txt");
            await sourcePeer.dial(writerPeer);

            let expectedConflict:
                | Awaited<ReturnType<SharedFsHandle["namingConflicts"]>>[number]
                | undefined;
            await waitUntil(async () => {
                expectedConflict = (await source.namingConflicts()).find(
                    (conflict) => conflict.type === "multi-head"
                );
                expect(expectedConflict).toBeDefined();
                expect(expectedConflict!.eventIds).toHaveLength(2);
            });
            const expectedEventIds = [...expectedConflict!.eventIds].sort();
            const expectedWinnerPath = expectedConflict!.path;
            expect(["/from-owner.txt", "/from-writer.txt"]).toContain(
                expectedWinnerPath
            );
            expect(decode(await source.readFile(expectedWinnerPath))).toBe(
                "shared subject"
            );

            // Take the in-memory writer offline after its admitted conflict
            // converges so it cannot own a replica range during the barrier.
            // The disk-backed receiver has been an eligible full replica for
            // every entry from the start. Fence the deliberate leadership
            // transition on both logs before asking for an exact persisted
            // receipt; otherwise a slow runner can still plan against the
            // stopped writer and correctly fail the barrier closed.
            await stopPeer(writerPeer);
            await sourcePeer.dial(receiverPeer);
            const receiverKey = receiverPeer.identity.publicKey;
            const receiverHash = receiverKey.hashcode();
            const writerHash = writerKey.hashcode();
            await Promise.all(
                [
                    source.program.entries.log,
                    source.program.trustGraph!.trustGraph.log,
                ].map(async (log) => {
                    await log.waitForReplicator(receiverKey, {
                        timeout: WAIT_TIMEOUT_MS,
                    });
                    await waitUntil(async () => {
                        const replicators = await log.getReplicators();
                        expect(replicators.has(receiverHash)).toBe(true);
                        expect(replicators.has(writerHash)).toBe(false);
                    });
                    await waitForRemoteReceiptCapability(
                        source,
                        receiverPeer,
                        log
                    );
                })
            );

            const disposal = await source.prepareForDisposal({
                minAcks: 1,
                timeout: WAIT_TIMEOUT_MS,
            });
            expect(disposal).toMatchObject({
                safeToDispose: true,
                minAcksPerEntry: 1,
                empty: false,
            });
            expect(disposal.entries.trust).toBeGreaterThanOrEqual(1);

            const address = source.address;
            await stopPeer(sourcePeer);
            await stopPeer(receiverPeer);

            const reopenedPeer = await trackPeer({
                directory: receiverDirectory,
            });
            const reopened = await openSharedFs({
                peerbit: reopenedPeer,
                address,
                machineLabel: "offline-access-controlled-reopen",
                replicate: false,
                bootstrap: false,
                remoteChunkFetch: false,
                gc: false,
            });

            expect(reopened.accessControlled).toBe(true);
            expect(await reopened.isTrustedWriter(writerKey)).toBe(true);
            expect(decode(await reopened.readFile("/admitted.txt"))).toBe(
                "trusted writer data"
            );
            expect(await reopened.stat("/deleted.txt")).toBeUndefined();
            const reopenedTombstone = (
                (await reopened.program.entries.index
                    .iterate(
                        { query: { kind: "naming" } },
                        { local: true, remote: false, resolve: true }
                    )
                    .all()) as NamingEvent[]
            ).find((event) => event.id === expectedTombstone!.id);
            expect(reopenedTombstone).toMatchObject({
                id: expectedTombstone!.id,
                deleted: true,
            });
            const reopenedConflict = (await reopened.namingConflicts()).find(
                (conflict) =>
                    conflict.type === "multi-head" &&
                    conflict.nodeId === expectedConflict!.nodeId
            );
            expect(reopenedConflict).toBeDefined();
            expect([...reopenedConflict!.eventIds].sort()).toEqual(
                expectedEventIds
            );
            expect(reopenedConflict!.path).toBe(expectedWinnerPath);
            expect(
                decode(await reopened.readFile(reopenedConflict!.path))
            ).toBe("shared subject");
        }
    );

    it("persists a revocation tombstone before the source is disposed", async () => {
        const receiverDirectory = await mkdtemp(
            join(tmpdir(), "peerbit-shared-fs-revocation-disposal-")
        );
        temporaryDirectories.add(receiverDirectory);
        const sourcePeer = await trackPeer();
        const writerPeer = await trackPeer();
        const receiverPeer = await trackPeer({ directory: receiverDirectory });
        await sourcePeer.dial(receiverPeer);

        const source = await openSharedFs({
            peerbit: sourcePeer,
            machineLabel: "revocation-source",
            rootKey: sourcePeer.identity.publicKey,
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });
        const address = source.address;
        expect(address).toBeDefined();
        const receiver = await openSharedFs({
            peerbit: receiverPeer,
            address,
            machineLabel: "revocation-receiver",
            replicate: { factor: 1 },
            bootstrap: false,
            remoteChunkFetch: false,
            gc: false,
        });
        const trustLog = source.program.trustGraph!.trustGraph.log;
        await waitForRemoteReceiptCapability(source, receiverPeer, trustLog);

        const writerKey = writerPeer.identity.publicKey;
        await source.authorizeWriter(writerKey);
        await waitUntil(async () => {
            expect(await receiver.isTrustedWriter(writerKey)).toBe(true);
        });
        await source.revokeWriter(writerKey);
        await waitUntil(async () => {
            expect(await receiver.isTrustedWriter(writerKey)).toBe(false);
        });

        const disposal = await source.prepareForDisposal({
            minAcks: 1,
            timeout: WAIT_TIMEOUT_MS,
        });
        expect(disposal).toMatchObject({
            safeToDispose: true,
            empty: false,
            entries: { chunks: 0, versions: 0, naming: 0 },
        });
        expect(disposal.entries.trust).toBeGreaterThanOrEqual(1);
        expect(disposal.entryCount).toBe(disposal.entries.trust);

        await stopPeer(sourcePeer);
        await stopPeer(receiverPeer);
        const reopenedPeer = await trackPeer({ directory: receiverDirectory });
        const reopened = await openSharedFs({
            peerbit: reopenedPeer,
            address,
            machineLabel: "offline-revocation-reopen",
            replicate: false,
            bootstrap: false,
            remoteChunkFetch: false,
            gc: false,
        });
        expect(await reopened.isTrustedWriter(writerKey)).toBe(false);
    });

    it("fails a moving disposal fence when trusted-writer state changes", async () => {
        const receiverDirectory = await mkdtemp(
            join(tmpdir(), "peerbit-shared-fs-moving-trust-disposal-")
        );
        temporaryDirectories.add(receiverDirectory);
        const sourcePeer = await trackPeer();
        const firstWriter = await trackPeer();
        const secondWriter = await trackPeer();
        const receiverPeer = await trackPeer({ directory: receiverDirectory });
        await sourcePeer.dial(receiverPeer);

        const source = await openSharedFs({
            peerbit: sourcePeer,
            machineLabel: "moving-trust-source",
            rootKey: sourcePeer.identity.publicKey,
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });
        await openSharedFs({
            peerbit: receiverPeer,
            address: source.address,
            machineLabel: "moving-trust-receiver",
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });
        const trustLog = source.program.trustGraph!.trustGraph.log as any;
        await waitForRemoteReceiptCapability(source, receiverPeer, trustLog);
        await source.authorizeWriter(firstWriter.identity.publicKey);

        const deliver = trustLog.deliverPersistedEntries.bind(trustLog);
        let injected = false;
        trustLog.deliverPersistedEntries = async (...args: any[]) => {
            await deliver(...args);
            if (!injected) {
                injected = true;
                await source.authorizeWriter(secondWriter.identity.publicKey);
            }
        };
        try {
            await expect(
                source.prepareForDisposal({
                    minAcks: 1,
                    timeout: WAIT_TIMEOUT_MS,
                })
            ).rejects.toMatchObject({
                name: "PrepareForDisposalError",
                safeToDispose: false,
                cause: {
                    name: "SharedFsError",
                    code: "EIO",
                    message: expect.stringContaining(
                        "authorization state changed during the disposal barrier"
                    ),
                },
            });
        } finally {
            trustLog.deliverPersistedEntries = deliver;
        }
        expect(injected).toBe(true);
        expect(
            await source.isTrustedWriter(secondWriter.identity.publicKey)
        ).toBe(true);
    });

    it("fails closed when the only remote leader cannot issue persisted receipts", async () => {
        const sourcePeer = await trackPeer();
        const memoryReceiver = await trackPeer();
        await sourcePeer.dial(memoryReceiver);

        const source = await openSharedFs({
            peerbit: sourcePeer,
            machineLabel: "source",
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });
        await openSharedFs({
            peerbit: memoryReceiver,
            address: source.address,
            machineLabel: "memory-receiver",
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });
        await source.program.entries.log.waitForReplicator(
            memoryReceiver.identity.publicKey,
            { roleAge: 0, timeout: WAIT_TIMEOUT_MS }
        );

        await source.writeFile("/not-durable.txt", "local commit survives");

        let failure: unknown;
        try {
            await source.prepareForDisposal({ minAcks: 1, timeout: 5_000 });
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(PrepareForDisposalError);
        expect(failure).toMatchObject({
            name: "PrepareForDisposalError",
            safeToDispose: false,
            retrySafe: true,
            confirmedEntries: 0,
        });
        expect((failure as PrepareForDisposalError).message).toContain(
            "keep the source machine"
        );
        expect((failure as PrepareForDisposalError).cause).toMatchObject({
            name: "PersistedDeliveryError",
            localCommitSucceeded: true,
            retrySafe: false,
        });
        expect(
            ((failure as PrepareForDisposalError).cause as Error).message
        ).toContain("persisted delivery failed");
        expect(decode(await source.readFile("/not-durable.txt"))).toBe(
            "local commit survives"
        );
    });

    it("fails closed when filesystem content changes during the barrier", async () => {
        const receiverDirectory = await mkdtemp(
            join(tmpdir(), "peerbit-shared-fs-moving-disposal-")
        );
        temporaryDirectories.add(receiverDirectory);
        const sourcePeer = await trackPeer();
        const receiverPeer = await trackPeer({
            directory: receiverDirectory,
        });
        await sourcePeer.dial(receiverPeer);

        const source = await openSharedFs({
            peerbit: sourcePeer,
            machineLabel: "moving-source",
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });
        await openSharedFs({
            peerbit: receiverPeer,
            address: source.address,
            machineLabel: "moving-receiver",
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });
        await waitForRemoteReceiptCapability(source, receiverPeer);
        await source.writeFile("/before.txt", "captured");

        const log = source.program.entries.log;
        const deliver = log.deliverPersistedEntries.bind(log);
        let injected = false;
        log.deliverPersistedEntries = (async (...args) => {
            await deliver(...args);
            if (!injected) {
                injected = true;
                await source.writeFile("/during.txt", "moving target");
            }
        }) as typeof log.deliverPersistedEntries;

        let failure: unknown;
        try {
            await source.prepareForDisposal({
                minAcks: 1,
                timeout: WAIT_TIMEOUT_MS,
            });
        } catch (error) {
            failure = error;
        } finally {
            log.deliverPersistedEntries = deliver;
        }

        expect(injected).toBe(true);
        expect(failure).toMatchObject({
            name: "PrepareForDisposalError",
            safeToDispose: false,
            retrySafe: true,
            cause: {
                name: "SharedFsError",
                code: "EIO",
                message: expect.stringContaining(
                    "filesystem content changed during the disposal barrier"
                ),
            },
        });
        expect(decode(await source.readFile("/during.txt"))).toBe(
            "moving target"
        );
    });

    it("fails closed while the resurrection guard owns a removed live head", async () => {
        const peer = await trackPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "guard-pending-source",
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });
        await fs.mkdir("/important");
        const namingRows = (await fs.program.entries.index
            .iterate(
                { query: { kind: "naming" } },
                { local: true, remote: false, resolve: true }
            )
            .all()) as Array<{ id: string }>;
        expect(namingRows).toHaveLength(1);

        // Simulate a remote collector removing the only live naming head.
        // Guard D still owns the removed value during its coalescing window,
        // so an empty index is not yet the replica's recoverable closure.
        await fs.program.entries.del(namingRows[0].id);

        await expect(
            fs.prepareForDisposal({ minAcks: 1 })
        ).rejects.toMatchObject({
            name: "PrepareForDisposalError",
            safeToDispose: false,
            retrySafe: true,
            cause: {
                name: "SharedFsError",
                code: "EIO",
                message: expect.stringContaining(
                    "resurrection guard is still settling"
                ),
            },
        });
        await waitUntil(async () => {
            expect(await fs.stat("/important")).toBeDefined();
        });
    });

    it("fails closed while the resurrection guard is ingesting a mixed removal batch", async () => {
        const peer = await trackPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "guard-ingest-source",
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });
        await fs.mkdir("/important");
        const naming = (
            (await fs.program.entries.index
                .iterate(
                    { query: { kind: "naming" } },
                    { local: true, remote: false, resolve: true }
                )
                .all()) as NamingEvent[]
        )[0];
        expect(naming).toBeDefined();

        const guardHost = fs.program as unknown as {
            gcSuppressed: Set<string>;
            guardAgainstLiveRemovals(values: unknown[]): Promise<void>;
            guardIngestBusy: number;
            pendingGuardNaming: Map<string, unknown>;
            pendingGuardVersions: Map<string, unknown>;
        };
        guardHost.gcSuppressed.add(naming.id);
        await fs.program.entries.del(naming.id);
        guardHost.gcSuppressed.delete(naming.id);
        expect(await fs.stat("/important")).toBeUndefined();

        let releaseChunkQuery!: (rows: unknown[]) => void;
        const stalledChunkQuery = new Promise<unknown[]>((resolve) => {
            releaseChunkQuery = resolve;
        });
        const iterateSpy = vi
            .spyOn(fs.program.entries.index, "iterate")
            .mockImplementationOnce(
                () =>
                    ({
                        next: () => stalledChunkQuery,
                        close: async () => {},
                    }) as any
            );
        const guardWork = guardHost.guardAgainstLiveRemovals([
            new FileChunk({ bytes: new Uint8Array([1, 2, 3]) }),
            naming,
        ]);
        iterateSpy.mockRestore();

        expect(guardHost.guardIngestBusy).toBe(1);
        expect(guardHost.pendingGuardNaming.size).toBe(0);
        expect(guardHost.pendingGuardVersions.size).toBe(0);
        try {
            await expect(
                fs.prepareForDisposal({ minAcks: 1 })
            ).rejects.toMatchObject({
                name: "PrepareForDisposalError",
                safeToDispose: false,
                retrySafe: true,
                cause: {
                    name: "SharedFsError",
                    code: "EIO",
                    message: expect.stringContaining(
                        "resurrection guard is still settling"
                    ),
                },
            });
        } finally {
            releaseChunkQuery([]);
            await guardWork;
        }
        await waitUntil(async () => {
            expect(await fs.stat("/important")).toBeDefined();
        });
    });

    it("does not treat an authorization-only filesystem as vacuously safe", async () => {
        const owner = await trackPeer();
        const writer = await trackPeer();
        const fs = await openSharedFs({
            peerbit: owner,
            machineLabel: "authorization-only-source",
            rootKey: owner.identity.publicKey,
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });
        await fs.authorizeWriter(writer.identity.publicKey);
        expect(
            await fs.program.trustGraph!.trustGraph.log.log.toArray()
        ).toHaveLength(1);

        await expect(
            fs.prepareForDisposal({ minAcks: 1, timeout: 1_000 })
        ).rejects.toMatchObject({
            name: "PrepareForDisposalError",
            safeToDispose: false,
            retrySafe: true,
        });
    });

    it("returns a vacuous success for a truly empty full replica without remotes", async () => {
        const peer = await trackPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "empty-source",
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });

        await expect(fs.prepareForDisposal({ minAcks: 1 })).resolves.toEqual({
            safeToDispose: true,
            guarantee: "persisted-per-entry",
            minAcksPerEntry: 1,
            empty: true,
            entries: { chunks: 0, versions: 0, naming: 0, trust: 0 },
            entryCount: 0,
            receiptBatches: 0,
        });
    });

    it("rejects a partial local replica before claiming disposal safety", async () => {
        const peer = await trackPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "partial-source",
            replicate: false,
            bootstrap: false,
            gc: false,
        });

        await expect(
            fs.prepareForDisposal({ minAcks: 1 })
        ).rejects.toMatchObject({
            name: "SharedFsError",
            code: "EINVAL",
            message: expect.stringContaining("requires a full replica"),
        });
    });

    it("waits for the bootstrap decision before judging the local view", async () => {
        const peer = await trackPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "bootstrap-race-source",
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });
        const program = fs.program as unknown as {
            bootstrapDecision: Promise<void>;
            bootstrapPhase: string;
            bootstrapVerified: boolean;
        };
        program.bootstrapPhase = "off";
        program.bootstrapVerified = false;
        program.bootstrapDecision = Promise.resolve().then(() => {
            program.bootstrapPhase = "unverified";
        });

        await expect(
            fs.prepareForDisposal({ minAcks: 1, timeout: 1_000 })
        ).rejects.toMatchObject({
            name: "PrepareForDisposalError",
            safeToDispose: false,
            cause: {
                name: "SharedFsError",
                code: "EINVAL",
                message: expect.stringContaining("fully verified local view"),
            },
        });
    });

    it("bounds a pending local barrier step by timeout and abort signal", async () => {
        const peer = await trackPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "bounded-barrier-source",
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });
        const program = fs.program as unknown as {
            bootstrapDecision: Promise<void>;
        };
        const originalBootstrapDecision = program.bootstrapDecision;
        program.bootstrapDecision = new Promise(() => {});
        try {
            const timeoutFailure = await fs
                .prepareForDisposal({ minAcks: 1, timeout: 25 })
                .then(
                    () => undefined,
                    (error: unknown) => error
                );
            expect(timeoutFailure).toMatchObject({
                name: "PrepareForDisposalError",
                safeToDispose: false,
                cause: {
                    name: "SharedFsError",
                    code: "ETIMEDOUT",
                },
            });

            const controller = new AbortController();
            const abortReason = new Error("operator cancelled disposal");
            const aborted = fs.prepareForDisposal({
                minAcks: 1,
                signal: controller.signal,
            });
            controller.abort(abortReason);
            const abortFailure = await aborted.then(
                () => undefined,
                (error: unknown) => error
            );
            expect(abortFailure).toMatchObject({
                name: "PrepareForDisposalError",
                safeToDispose: false,
            });
            expect((abortFailure as PrepareForDisposalError).cause).toBe(
                abortReason
            );
        } finally {
            // close() now correctly joins the real per-open bootstrap task;
            // do not leave this intentionally-never-settling test double
            // installed for teardown.
            program.bootstrapDecision = originalBootstrapDecision;
        }
    });

    it("rejects invalid acknowledgement and deadline options", async () => {
        const peer = await trackPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "validation-source",
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });

        for (const minAcks of [0, -1, 1.5, Number.NaN]) {
            await expect(
                fs.prepareForDisposal({ minAcks })
            ).rejects.toMatchObject({
                name: "SharedFsError",
                code: "EINVAL",
                message: expect.stringContaining("positive integer minAcks"),
            });
        }
        for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            await expect(
                fs.prepareForDisposal({ minAcks: 1, timeout })
            ).rejects.toMatchObject({
                name: "SharedFsError",
                code: "EINVAL",
                message: expect.stringContaining(
                    "timeout must be a positive number"
                ),
            });
        }
    });
});
