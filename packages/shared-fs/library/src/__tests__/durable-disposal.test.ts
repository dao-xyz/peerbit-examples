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
import { FileChunk, FileVersion, NamingEvent } from "../model.js";

const WAIT_TIMEOUT_MS = process.env.CI ? 90_000 : 30_000;

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
        remote: Peerbit | Peerbit[],
        log: any = source.program.entries.log
    ) => {
        const remotes = Array.isArray(remote) ? remote : [remote];
        const remoteHashes = remotes.map((peer) =>
            peer.identity.publicKey.hashcode()
        );
        await waitUntil(async () => {
            // A same-identity stop/reopen can miss one quiet replication-info
            // exchange. Retry this readiness probe; no filesystem commit or
            // disposal delivery has started yet.
            await Promise.all(
                remotes.map((peer) =>
                    log.waitForReplicator(peer.identity.publicKey, {
                        timeout: Math.min(15_000, WAIT_TIMEOUT_MS),
                    })
                )
            );
            // Match persisted delivery's actual admission facts. A capability
            // bit by itself may belong to an old transport session, and an
            // eager role can precede the rebalance that assigns exact entries.
            for (const remoteHash of remoteHashes) {
                expect(
                    log.persistedReceiptPeerSession(remoteHash)
                ).toBeDefined();
            }
            const entries = await log.log.toArray();
            const replicas = log.replicas.min.getValue(log);
            for (const entry of entries) {
                const leaders = await log.findLeadersFromEntry(
                    entry,
                    replicas,
                    { freshLeaderPlan: true }
                );
                for (const remoteHash of remoteHashes) {
                    expect(leaders.has(remoteHash)).toBe(true);
                }
            }
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
        await waitForRemoteReceiptCapability(source, receiverPeer);

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
            await waitForRemoteReceiptCapability(source, receiverPeers);

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
                    await waitForRemoteReceiptCapability(
                        source,
                        receiverPeer,
                        log
                    );
                    await waitUntil(async () => {
                        const replicators = await log.getReplicators();
                        expect(replicators.has(receiverHash)).toBe(true);
                        expect(replicators.has(writerHash)).toBe(false);
                    });
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

        const writerKey = writerPeer.identity.publicKey;
        await source.authorizeWriter(writerKey);
        await waitUntil(async () => {
            expect(await receiver.isTrustedWriter(writerKey)).toBe(true);
        });
        await source.revokeWriter(writerKey);
        await waitUntil(async () => {
            expect(await receiver.isTrustedWriter(writerKey)).toBe(false);
        });
        await waitForRemoteReceiptCapability(source, receiverPeer, trustLog);

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
        await source.authorizeWriter(firstWriter.identity.publicKey);
        await waitForRemoteReceiptCapability(source, receiverPeer, trustLog);

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
        await source.writeFile("/not-durable.txt", "local commit survives");
        const memoryLog = source.program.entries.log as any;
        const memoryReceiverHash = memoryReceiver.identity.publicKey.hashcode();
        await waitUntil(async () => {
            await memoryLog.waitForReplicator(
                memoryReceiver.identity.publicKey,
                { timeout: Math.min(15_000, WAIT_TIMEOUT_MS) }
            );
            const entries = await memoryLog.log.toArray();
            expect(entries.length).toBeGreaterThan(0);
            const replicas = memoryLog.replicas.min.getValue(memoryLog);
            for (const entry of entries) {
                const leaders = await memoryLog.findLeadersFromEntry(
                    entry,
                    replicas,
                    { freshLeaderPlan: true }
                );
                expect(leaders.has(memoryReceiverHash)).toBe(true);
            }
            expect(
                memoryLog.persistedReceiptPeerSession(memoryReceiverHash)
            ).toBeUndefined();
        });

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
        await source.writeFile("/before.txt", "captured");
        await waitForRemoteReceiptCapability(source, receiverPeer);

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

    it("aborts and drains a disposal barrier across close without poisoning reopen", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "peerbit-shared-fs-disposal-lifecycle-")
        );
        temporaryDirectories.add(directory);
        const peer = await trackPeer({ directory });
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "disposal-lifecycle-source",
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });
        await fs.writeFile("/preserved.txt", "close must not certify disposal");

        const program = fs.program as any;
        const log = program.entries.log;
        const originalDeliver = log.deliverPersistedEntries;
        let deliverySignal: AbortSignal | undefined;
        let deliveryCalls = 0;
        let deliveryTailFinished = false;
        let barrierFinished = false;
        const completionOrder: string[] = [];
        let releaseDeliveryDrain!: () => void;
        const deliveryDrain = new Promise<void>((resolve) => {
            releaseDeliveryDrain = resolve;
        });
        let forceDeliveryExit!: () => void;
        const forcedExit = new Promise<void>((resolve) => {
            forceDeliveryExit = resolve;
        });

        log.deliverPersistedEntries = (async (...args) => {
            deliveryCalls++;
            const delivery = args[1] as {
                delivery?: { signal?: AbortSignal };
            };
            deliverySignal = delivery.delivery?.signal;
            if (!deliverySignal) {
                throw new Error("disposal delivery did not receive a signal");
            }
            await Promise.race([
                new Promise<void>((resolve) => {
                    if (deliverySignal!.aborted) {
                        resolve();
                        return;
                    }
                    deliverySignal!.addEventListener("abort", () => resolve(), {
                        once: true,
                    });
                }),
                forcedExit,
            ]);
            await deliveryDrain;
            deliveryTailFinished = true;
            completionOrder.push("delivery-tail");
            throw (
                deliverySignal.reason ??
                new Error("test released disposal delivery without an abort")
            );
        }) as typeof log.deliverPersistedEntries;

        const caller = new AbortController();
        let staleSafeResultReturned = false;
        const barrierOutcome = fs
            .prepareForDisposal({
                minAcks: 1,
                timeout: WAIT_TIMEOUT_MS,
                signal: caller.signal,
            })
            .then(
                (value) => {
                    barrierFinished = true;
                    completionOrder.push("barrier");
                    staleSafeResultReturned = value.safeToDispose;
                    return { status: "fulfilled" as const, value };
                },
                (error: unknown) => {
                    barrierFinished = true;
                    completionOrder.push("barrier");
                    return { status: "rejected" as const, error };
                }
            );
        let closing: Promise<unknown> | undefined;

        try {
            await waitUntil(
                () => {
                    expect(deliveryCalls).toBe(1);
                    expect(deliverySignal).toBeDefined();
                },
                Math.min(WAIT_TIMEOUT_MS, 5_000)
            );
            expect(deliveryCalls).toBe(1);
            expect(deliverySignal).toBeDefined();
            expect(deliverySignal).not.toBe(caller.signal);
            expect(deliverySignal!.aborted).toBe(false);
            expect(caller.signal.aborted).toBe(false);

            let closeSettled = false;
            closing = program.close().then(() => {
                expect(deliveryTailFinished).toBe(true);
                expect(barrierFinished).toBe(true);
                completionOrder.push("close");
                closeSettled = true;
            });
            await waitUntil(
                () => expect(deliverySignal!.aborted).toBe(true),
                Math.min(WAIT_TIMEOUT_MS, 5_000)
            );
            expect(caller.signal.aborted).toBe(false);

            // The delivery observed lifecycle cancellation but deliberately
            // holds its cleanup tail. close() must join that tail rather than
            // returning while an old disposal task can still mutate state.
            expect(closeSettled).toBe(false);

            releaseDeliveryDrain();
            const outcome = await barrierOutcome;
            expect(outcome.status).toBe("rejected");
            if (outcome.status !== "rejected") {
                throw new Error(
                    "stale disposal barrier unexpectedly succeeded"
                );
            }
            expect(outcome.error).toBeInstanceOf(PrepareForDisposalError);
            expect(outcome.error).toMatchObject({
                name: "PrepareForDisposalError",
                safeToDispose: false,
            });
            expect(staleSafeResultReturned).toBe(false);
            await closing;
            expect(closeSettled).toBe(true);
            expect(completionOrder).toEqual([
                "delivery-tail",
                "barrier",
                "close",
            ]);
        } finally {
            forceDeliveryExit();
            releaseDeliveryDrain();
            await Promise.allSettled(
                [barrierOutcome, closing].filter(
                    (task): task is Promise<unknown> => task !== undefined
                )
            );
            log.deliverPersistedEntries = originalDeliver;
        }

        const reopened = await (peer as any).open(program, {
            existing: "reuse",
            args: {
                machineLabel: "disposal-lifecycle-reopen",
                addressOpen: true,
                bootstrap: false,
                gc: false,
            },
        });
        expect(reopened).toBe(program);
        expect(fs.bootstrapStatus().writeReady).toBe(true);

        const reopenedLog = program.entries.log;
        const reopenedOriginalDeliver = reopenedLog.deliverPersistedEntries;
        const freshCaller = new AbortController();
        let freshDeliveryCalls = 0;
        reopenedLog.deliverPersistedEntries = (async (...args) => {
            freshDeliveryCalls++;
            const delivery = args[1] as {
                delivery?: { signal?: AbortSignal };
            };
            expect(delivery.delivery?.signal).toBeDefined();
            expect(delivery.delivery!.signal).not.toBe(deliverySignal);
            expect(delivery.delivery!.signal).not.toBe(freshCaller.signal);
            expect(delivery.delivery!.signal!.aborted).toBe(false);
        }) as typeof reopenedLog.deliverPersistedEntries;
        try {
            const fresh = await fs.prepareForDisposal({
                minAcks: 1,
                timeout: WAIT_TIMEOUT_MS,
                signal: freshCaller.signal,
            });
            expect(fresh).toMatchObject({
                safeToDispose: true,
                guarantee: "persisted-per-entry",
                minAcksPerEntry: 1,
                empty: false,
            });
            expect(fresh.entryCount).toBeGreaterThan(0);
            expect(freshDeliveryCalls).toBeGreaterThan(0);
            expect(fresh.receiptBatches).toBe(freshDeliveryCalls);
            expect(freshCaller.signal.aborted).toBe(false);
        } finally {
            reopenedLog.deliverPersistedEntries = reopenedOriginalDeliver;
        }
    });

    it("rejects a second open without disturbing an admitted namespace mutation", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "peerbit-shared-fs-second-open-")
        );
        temporaryDirectories.add(directory);
        const peer = await trackPeer({ directory });
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "second-open-namespace-source",
            replicate: { factor: 1 },
            bootstrap: false,
            snapshot: { disabled: true },
            gc: false,
        });
        await fs.writeFile("/existing.txt", "before rejected open");

        const program = fs.program as any;
        const entries = program.entries as any;
        const originalPut = entries.put;
        let releaseNamingPut!: () => void;
        const namingPutAllowed = new Promise<void>((resolve) => {
            releaseNamingPut = resolve;
        });
        let namingPutEntered!: () => void;
        const namingPutStarted = new Promise<void>((resolve) => {
            namingPutEntered = resolve;
        });
        let gateNamingPut = true;
        entries.put = async (value: unknown, ...args: unknown[]) => {
            if (
                gateNamingPut &&
                value instanceof NamingEvent &&
                value.name === "held"
            ) {
                gateNamingPut = false;
                namingPutEntered();
                await namingPutAllowed;
            }
            return originalPut.call(entries, value, ...args);
        };

        let admittedMutation: Promise<unknown> | undefined;
        try {
            admittedMutation = fs.mkdir("/held");
            await namingPutStarted;
            expect(program.ordinaryNamingAppendsInFlight).toBe(1);

            await expect(
                program.open({
                    machineLabel: "invalid-second-open",
                    addressOpen: true,
                    bootstrap: false,
                    snapshot: { disabled: true },
                    gc: false,
                })
            ).rejects.toMatchObject({
                name: "SharedFsError",
                code: "EINVAL",
                message: expect.stringContaining("already open"),
            });

            // Rejection happens before lifecycle invalidation: the admitted
            // append still owns its old counter/fence and the active handle
            // remains writable.
            expect(program.ordinaryNamingAppendsInFlight).toBe(1);
            expect(fs.bootstrapStatus().writeReady).toBe(true);
            releaseNamingPut();
            await admittedMutation;
            expect(program.ordinaryNamingAppendsInFlight).toBe(0);
            expect((await fs.stat("/held"))?.kind).toBe("directory");

            await fs.writeFile("/existing.txt", "active lifecycle survived");
            await fs.mkdir("/after-rejected-open");
            expect(decode(await fs.readFile("/existing.txt"))).toBe(
                "active lifecycle survived"
            );
        } finally {
            releaseNamingPut();
            await Promise.allSettled(
                [admittedMutation].filter(
                    (task): task is Promise<unknown> => task !== undefined
                )
            );
            entries.put = originalPut;
        }

        await program.close();
        const reopened = await (peer as any).open(program, {
            existing: "reuse",
            args: {
                machineLabel: "second-open-namespace-reopen",
                addressOpen: true,
                bootstrap: false,
                snapshot: { disabled: true },
                gc: false,
            },
        });
        expect(reopened).toBe(program);
        await fs.mkdir("/fresh-lifecycle");
        expect((await fs.stat("/fresh-lifecycle"))?.kind).toBe("directory");
    });

    it("rejects a queued open when close cannot drain required guard work", async () => {
        const peer = await trackPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "failed-close-queued-open-source",
            replicate: { factor: 1 },
            bootstrap: false,
            snapshot: { disabled: true },
            gc: false,
        });
        await fs.mkdir("/important");

        const program = fs.program as any;
        const important = (await fs.stat("/important"))!;
        const naming = (
            (await program.entries.index
                .iterate(
                    { query: { kind: "naming" } },
                    { local: true, remote: false, resolve: true }
                )
                .all()) as NamingEvent[]
        ).find((event) => event.nodeId === important.nodeId)!;
        expect(naming).toBeInstanceOf(NamingEvent);
        program.pendingGuardNaming.set(
            important.nodeId,
            new Map([[naming.id, naming]])
        );

        const originalStartGuardFlush = program.startGuardFlush;
        let guardFlushCalls = 0;
        program.startGuardFlush = async () => {
            guardFlushCalls++;
            // Preserve the required batch to force the pre-super.close
            // fail-closed branch deterministically.
        };
        const openEvents: Event[] = [];
        const onOpen = (event: Event) => {
            if ((event as CustomEvent).detail === program) {
                openEvents.push(event);
            }
        };
        program.events.addEventListener("open", onOpen);
        let queuedGcArmCalls = 0;
        let closing:
            | Promise<
                  | { status: "fulfilled"; value: boolean }
                  | { status: "rejected"; error: unknown }
              >
            | undefined;
        let queuedOpen:
            | Promise<
                  | { status: "fulfilled"; value: unknown }
                  | { status: "rejected"; error: unknown }
              >
            | undefined;
        try {
            closing = program.close().then(
                (value: boolean) => ({ status: "fulfilled" as const, value }),
                (error: unknown) => ({ status: "rejected" as const, error })
            );
            queuedOpen = program
                .open({
                    machineLabel: "must-not-open-after-failed-close",
                    addressOpen: true,
                    bootstrap: false,
                    snapshot: { disabled: true },
                    gc: {
                        intervalMs: WAIT_TIMEOUT_MS * 10,
                        initialDelayMs: WAIT_TIMEOUT_MS * 10,
                        jitterRatio: 0,
                        testOverrides: { noFloors: true },
                    },
                    gcRng: () => {
                        queuedGcArmCalls++;
                        return 0.5;
                    },
                })
                .then(
                    (value: unknown) => ({
                        status: "fulfilled" as const,
                        value,
                    }),
                    (error: unknown) => ({
                        status: "rejected" as const,
                        error,
                    })
                );

            const closeOutcome = await closing;
            expect(closeOutcome.status).toBe("rejected");
            if (closeOutcome.status !== "rejected") {
                throw new Error("close unexpectedly discarded guard work");
            }
            expect(closeOutcome.error).toMatchObject({
                name: "SharedFsError",
                code: "EIO",
                message: expect.stringContaining("resurrection guard"),
            });

            const openOutcome = await queuedOpen;
            expect(openOutcome.status).toBe("rejected");
            if (openOutcome.status !== "rejected") {
                throw new Error("queued open ran after a failed close");
            }
            expect(openOutcome.error).toBe(closeOutcome.error);
            expect(guardFlushCalls).toBe(1);
            expect(
                program.pendingGuardNaming.get(important.nodeId)?.has(naming.id)
            ).toBe(true);
            expect(openEvents).toHaveLength(0);
            expect(queuedGcArmCalls).toBe(0);
            expect(program.gcStatus()).toMatchObject({
                scheduled: false,
                nextRunAtMs: undefined,
            });
        } finally {
            program.startGuardFlush = originalStartGuardFlush;
            program.events.removeEventListener("open", onOpen);
            await Promise.allSettled(
                [closing, queuedOpen].filter(
                    (task): task is Promise<unknown> => task !== undefined
                )
            );
            // The assertions above prove failed-close ownership. Clear the
            // synthetic batch so teardown can perform the required retry.
            program.pendingGuardNaming.clear();
            await program.close().catch(() => {});
        }
    });

    it("serializes a close requested inside an awaited same-instance reopen", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "peerbit-shared-fs-open-close-transition-")
        );
        temporaryDirectories.add(directory);
        const peer = await trackPeer({ directory });
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "open-close-transition-source",
            replicate: { factor: 1 },
            bootstrap: false,
            snapshot: { disabled: true },
            gc: false,
        });
        await fs.writeFile("/preserved.txt", "fresh lifecycle owns this state");

        const program = fs.program as any;
        const classClose = Object.getPrototypeOf(program).close as (
            this: typeof program
        ) => Promise<boolean>;
        await program.close();

        const entries = program.entries as any;
        const originalEntriesOpen = entries.open;
        const originalProgramOpen = program.open;
        let releaseOpenStage!: () => void;
        const openStageGate = new Promise<void>((resolve) => {
            releaseOpenStage = resolve;
        });
        let openStageEntered = false;
        const completionOrder: string[] = [];
        entries.open = async (...args: any[]) => {
            openStageEntered = true;
            completionOrder.push("open-stage-entered");
            await openStageGate;
            return originalEntriesOpen.apply(entries, args);
        };

        const lifecycleEvents: string[] = [];
        const onOpen = (event: Event) => {
            if ((event as CustomEvent).detail === program) {
                lifecycleEvents.push("open");
            }
        };
        const onClose = (event: Event) => {
            if ((event as CustomEvent).detail === program) {
                lifecycleEvents.push("close");
            }
        };
        program.events.addEventListener("open", onOpen);
        program.events.addEventListener("close", onClose);

        let staleGcArmCalls = 0;
        let localOpenTask:
            | Promise<
                  | { status: "fulfilled"; value: unknown }
                  | { status: "rejected"; error: unknown }
              >
            | undefined;
        program.open = (...args: any[]) => {
            const task = originalProgramOpen.apply(
                program,
                args
            ) as Promise<unknown>;
            localOpenTask = task.then(
                (value) => {
                    completionOrder.push("stale-open-fulfilled");
                    return { status: "fulfilled" as const, value };
                },
                (error: unknown) => {
                    completionOrder.push("stale-open-rejected");
                    return { status: "rejected" as const, error };
                }
            );
            return task;
        };
        let staleOpenTask:
            | Promise<
                  | { status: "fulfilled"; value: unknown }
                  | { status: "rejected"; error: unknown }
              >
            | undefined;
        let closeTask: Promise<boolean> | undefined;
        try {
            staleOpenTask = (peer as any)
                .open(program, {
                    existing: "reuse",
                    args: {
                        machineLabel: "superseded-same-instance-open",
                        addressOpen: true,
                        bootstrap: false,
                        snapshot: { disabled: true },
                        gc: {
                            intervalMs: WAIT_TIMEOUT_MS * 10,
                            initialDelayMs: WAIT_TIMEOUT_MS * 10,
                            jitterRatio: 0,
                            testOverrides: { noFloors: true },
                        },
                        gcRng: () => {
                            staleGcArmCalls++;
                            return 0.5;
                        },
                    },
                })
                .then(
                    (value: unknown) => {
                        return { status: "fulfilled" as const, value };
                    },
                    (error: unknown) => {
                        return { status: "rejected" as const, error };
                    }
                );
            await waitUntil(
                () => expect(openStageEntered).toBe(true),
                Math.min(WAIT_TIMEOUT_MS, 5_000)
            );

            // The Peerbit handler correctly refuses an external terminal call
            // while its managed open owns the address. Invoke this class's
            // public implementation directly to exercise its independent
            // same-instance transition queue and ownership token.
            closeTask = classClose.call(program).then((closed: boolean) => {
                completionOrder.push("close");
                return closed;
            });
            completionOrder.push("close-requested");

            // close() closes admission synchronously, even while the prior open
            // still owns an awaited Documents.open stage.
            await expect(
                fs.writeFile("/must-stay-blocked.txt", "stale")
            ).rejects.toMatchObject({
                name: "SharedFsWritePendingError",
                code: "EAGAIN",
            });
            expect(staleGcArmCalls).toBe(0);

            completionOrder.push("open-stage-released");
            releaseOpenStage();
            if (!localOpenTask) {
                throw new Error(
                    "managed reopen never invoked the program open"
                );
            }
            const staleLocalOpen = await localOpenTask;
            expect(staleLocalOpen.status).toBe("rejected");
            if (staleLocalOpen.status !== "rejected") {
                throw new Error("superseded open unexpectedly completed");
            }
            expect(staleLocalOpen.error).toMatchObject({
                name: "SharedFsError",
                code: "ECLOSED",
                message: expect.stringContaining("superseded"),
            });

            // The stale continuation must not reopen admission in the interval
            // before its queued close transition finishes.
            await expect(
                fs.writeFile("/must-stay-blocked.txt", "still stale")
            ).rejects.toMatchObject({
                name: "SharedFsWritePendingError",
                code: "EAGAIN",
            });
            expect(await closeTask).toBe(true);
            expect(staleGcArmCalls).toBe(0);
            expect(program.gcStatus()).toMatchObject({
                scheduled: false,
                nextRunAtMs: undefined,
            });
            expect(lifecycleEvents).toEqual(["close"]);
            expect(completionOrder).toEqual([
                "open-stage-entered",
                "close-requested",
                "open-stage-released",
                "stale-open-rejected",
                "close",
            ]);
            const staleManagedOpen = await staleOpenTask;
            expect(staleManagedOpen.status).toBe("rejected");

            entries.open = originalEntriesOpen;
            program.open = originalProgramOpen;
            let freshGcArmCalls = 0;
            const reopened = await (peer as any).open(program, {
                existing: "reuse",
                args: {
                    machineLabel: "fresh-same-instance-open",
                    addressOpen: true,
                    bootstrap: false,
                    snapshot: { disabled: true },
                    gc: {
                        intervalMs: WAIT_TIMEOUT_MS * 10,
                        initialDelayMs: WAIT_TIMEOUT_MS * 10,
                        jitterRatio: 0,
                        testOverrides: { noFloors: true },
                    },
                    gcRng: () => {
                        freshGcArmCalls++;
                        return 0.5;
                    },
                },
            });
            expect(reopened).toBe(program);
            expect(freshGcArmCalls).toBe(1);
            expect(program.gcStatus()).toMatchObject({ scheduled: true });
            expect(program.gcStatus().nextRunAtMs).toBeDefined();
            expect(lifecycleEvents).toEqual(["close", "open"]);
            expect(decode(await fs.readFile("/preserved.txt"))).toBe(
                "fresh lifecycle owns this state"
            );
            expect(await fs.stat("/must-stay-blocked.txt")).toBeUndefined();
            await fs.writeFile("/fresh.txt", "fresh open is writable");
            expect(decode(await fs.readFile("/fresh.txt"))).toBe(
                "fresh open is writable"
            );
        } finally {
            releaseOpenStage();
            await Promise.allSettled(
                [localOpenTask, staleOpenTask, closeTask].filter(
                    (task): task is Promise<unknown> => task !== undefined
                )
            );
            entries.open = originalEntriesOpen;
            program.open = originalProgramOpen;
            program.events.removeEventListener("open", onOpen);
            program.events.removeEventListener("close", onClose);
        }
    });

    it("drains admitted file-version writes and conflict resolution before close and reopen", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "peerbit-shared-fs-foreground-drain-")
        );
        temporaryDirectories.add(directory);
        const peer = await trackPeer({ directory });
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "foreground-mutation-drain-source",
            replicate: { factor: 1 },
            bootstrap: false,
            snapshot: { disabled: true },
            gc: false,
        });
        await fs.writeFile("/file.txt", "base");
        const program = fs.program as any;
        const entries = program.entries as any;

        const closeWhileVersionPutIsGated = async (
            predicate: (value: FileVersion) => boolean,
            mutate: () => Promise<unknown>
        ) => {
            const originalPut = entries.put;
            let releasePut!: () => void;
            const putAllowed = new Promise<void>((resolve) => {
                releasePut = resolve;
            });
            let putEntered!: () => void;
            const putStarted = new Promise<void>((resolve) => {
                putEntered = resolve;
            });
            let gate = true;
            let putFinished = false;
            entries.put = async (value: unknown, ...args: unknown[]) => {
                if (gate && value instanceof FileVersion && predicate(value)) {
                    gate = false;
                    putEntered();
                    await putAllowed;
                    const result = await originalPut.call(
                        entries,
                        value,
                        ...args
                    );
                    putFinished = true;
                    return result;
                }
                return originalPut.call(entries, value, ...args);
            };

            const completionOrder: string[] = [];
            let mutationFinished = false;
            let mutation: Promise<unknown> | undefined;
            let closing: Promise<boolean> | undefined;
            try {
                mutation = mutate().then((value) => {
                    expect(putFinished).toBe(true);
                    mutationFinished = true;
                    completionOrder.push("mutation");
                    return value;
                });
                await putStarted;
                closing = program.close().then((value: boolean) => {
                    expect(mutationFinished).toBe(true);
                    completionOrder.push("close");
                    return value;
                });

                // Admission closes synchronously, while the already-admitted
                // operation retains ownership through its post-put tail.
                await expect(
                    fs.writeFile("/must-not-cross-close.txt", "blocked")
                ).rejects.toMatchObject({ code: "EAGAIN" });
                releasePut();
                await mutation;
                await closing;
                expect(completionOrder).toEqual(["mutation", "close"]);
            } finally {
                releasePut();
                await Promise.allSettled(
                    [mutation, closing].filter(
                        (task): task is Promise<unknown> => task !== undefined
                    )
                );
                entries.put = originalPut;
            }
        };

        const reopen = async (machineLabel: string) => {
            const reopened = await (peer as any).open(program, {
                existing: "reuse",
                args: {
                    machineLabel,
                    addressOpen: true,
                    bootstrap: false,
                    snapshot: { disabled: true },
                    gc: false,
                },
            });
            expect(reopened).toBe(program);
        };

        const nodeId = (await fs.stat("/file.txt"))!.nodeId;
        await closeWhileVersionPutIsGated(
            (value) =>
                value.nodeId === nodeId && value.conflictResolution !== true,
            () => fs.writeFile("/file.txt", "old generation completed")
        );
        await reopen("foreground-write-reopen");
        expect(decode(await fs.readFile("/file.txt"))).toBe(
            "old generation completed"
        );
        expect(await fs.stat("/must-not-cross-close.txt")).toBeUndefined();

        const base = (await fs.versions("/file.txt"))[0];
        await fs.writeFile("/file.txt", "branch a", {
            baseVersionIds: [base.id],
        });
        await fs.writeFile("/file.txt", "branch b", {
            baseVersionIds: [base.id],
        });
        const conflicts = await fs.conflicts("/file.txt");
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].versions).toHaveLength(2);
        const selectedVersionId = conflicts[0].versions[0].id;
        const selectedBytes = decode(
            await fs.readVersion("/file.txt", selectedVersionId)
        );

        await closeWhileVersionPutIsGated(
            (value) =>
                value.nodeId === nodeId && value.conflictResolution === true,
            () => fs.resolveConflict("/file.txt", selectedVersionId)
        );
        await reopen("foreground-conflict-reopen");
        expect(await fs.conflicts("/file.txt")).toEqual([]);
        expect(decode(await fs.readFile("/file.txt"))).toBe(selectedBytes);
        await fs.writeFile("/fresh-after-conflict.txt", "fresh lifecycle");
        expect(decode(await fs.readFile("/fresh-after-conflict.txt"))).toBe(
            "fresh lifecycle"
        );
    });

    it("ignores a queued quiescence callback from an older open generation", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "peerbit-shared-fs-quiescence-callback-")
        );
        temporaryDirectories.add(directory);
        const peer = await trackPeer({ directory });
        const fakeNow = Date.now() + 24 * 60 * 60 * 1000;
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "quiescence-callback-source",
            replicate: { factor: 1 },
            bootstrap: false,
            snapshot: { disabled: true },
            gc: false,
            clock: () => fakeNow,
        });
        const program = fs.program as any;
        const originalSetInterval = globalThis.setInterval;
        const timerHandles: Array<ReturnType<typeof setInterval>> = [];
        const captureQuiescenceCallback = () => {
            let callback: (() => void) | undefined;
            const timer = originalSetInterval(
                () => undefined,
                WAIT_TIMEOUT_MS * 10
            );
            (timer as any).unref?.();
            timerHandles.push(timer);
            const intervalSpy = vi
                .spyOn(globalThis, "setInterval")
                .mockImplementationOnce(((
                    handler: (...args: unknown[]) => void
                ) => {
                    callback = () => handler();
                    return timer;
                }) as typeof setInterval);
            try {
                program.startQuiescenceChecker();
            } finally {
                intervalSpy.mockRestore();
            }
            if (!callback) {
                throw new Error("quiescence callback was not captured");
            }
            return { callback, timer };
        };

        let clearIntervalSpy: ReturnType<typeof vi.spyOn> | undefined;
        try {
            program.bootstrapPhase = "unverified";
            program.lastArrivalMs = 0;
            program.setGuardArmed(false);
            const stale = captureQuiescenceCallback();

            await program.close();
            const reopened = await (peer as any).open(program, {
                existing: "reuse",
                args: {
                    machineLabel: "quiescence-callback-reopen",
                    addressOpen: true,
                    bootstrap: false,
                    snapshot: { disabled: true },
                    gc: false,
                    clock: () => fakeNow,
                },
            });
            expect(reopened).toBe(program);

            program.bootstrapPhase = "unverified";
            program.lastArrivalMs = 0;
            program.setGuardArmed(false);
            const fresh = captureQuiescenceCallback();
            clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

            stale.callback();
            stale.callback();
            expect(program.quiescentChecks).toBe(0);
            expect(fs.bootstrapStatus()).toMatchObject({
                phase: "unverified",
                guardArmed: false,
            });
            expect(clearIntervalSpy).not.toHaveBeenCalledWith(fresh.timer);

            fresh.callback();
            expect(program.quiescentChecks).toBe(1);
            expect(fs.bootstrapStatus()).toMatchObject({
                phase: "unverified",
                guardArmed: false,
            });
            fresh.callback();
            expect(fs.bootstrapStatus()).toMatchObject({
                phase: "converged",
                guardArmed: true,
            });
            expect(clearIntervalSpy).toHaveBeenCalledWith(fresh.timer);
            expect(program.quiescenceTimer).toBeUndefined();
        } finally {
            clearIntervalSpy?.mockRestore();
            for (const timer of timerHandles) {
                clearInterval(timer);
            }
        }
    });

    it("cancels a disposal waiter promptly while close drains its bootstrap tail", async () => {
        const peer = await trackPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "disposal-bootstrap-close-source",
            replicate: { factor: 1 },
            bootstrap: false,
            snapshot: { disabled: true },
            gc: false,
        });
        const program = fs.program as any;
        const originalBootstrapDecision = program.bootstrapDecision;
        let releaseBootstrapTail!: () => void;
        const bootstrapTailGate = new Promise<void>((resolve) => {
            releaseBootstrapTail = resolve;
        });
        const completionOrder: string[] = [];
        program.bootstrapDecision = bootstrapTailGate.then(() => {
            completionOrder.push("bootstrap-tail");
        });

        let barrier:
            | Promise<
                  | { status: "fulfilled"; value: unknown }
                  | { status: "rejected"; error: unknown }
              >
            | undefined;
        let closing: Promise<boolean> | undefined;
        try {
            barrier = fs.prepareForDisposal({ minAcks: 1 }).then(
                (value) => ({ status: "fulfilled" as const, value }),
                (error: unknown) => {
                    completionOrder.push("barrier");
                    return { status: "rejected" as const, error };
                }
            );
            await waitUntil(
                () => {
                    expect(program.disposalPreparationRunning).toBe(true);
                    expect(program.maintenanceTasks.size).toBeGreaterThan(0);
                },
                Math.min(WAIT_TIMEOUT_MS, 5_000)
            );

            let closeSettled = false;
            closing = program.close().then((value: boolean) => {
                closeSettled = true;
                completionOrder.push("close");
                return value;
            });

            const barrierOutcome = await barrier;
            expect(barrierOutcome.status).toBe("rejected");
            if (barrierOutcome.status !== "rejected") {
                throw new Error("disposal barrier survived lifecycle close");
            }
            expect(barrierOutcome.error).toBeInstanceOf(
                PrepareForDisposalError
            );
            expect(barrierOutcome.error).toMatchObject({
                name: "PrepareForDisposalError",
                safeToDispose: false,
                cause: {
                    name: "SharedFsError",
                    code: "ECLOSED",
                },
            });
            expect(closeSettled).toBe(false);
            expect(completionOrder).toEqual(["barrier"]);

            releaseBootstrapTail();
            await closing;
            expect(completionOrder).toEqual([
                "barrier",
                "bootstrap-tail",
                "close",
            ]);
        } finally {
            releaseBootstrapTail();
            await Promise.allSettled(
                [barrier, closing].filter(
                    (task): task is Promise<unknown> => task !== undefined
                )
            );
            program.bootstrapDecision = originalBootstrapDecision;
        }
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
        let resolveBootstrapDecision!: () => void;
        const pendingBootstrapDecision = new Promise<void>((resolve) => {
            resolveBootstrapDecision = resolve;
        });
        program.bootstrapDecision = pendingBootstrapDecision;
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
            // settle every admitted reference to this test double before
            // restoring it so teardown cannot wait forever.
            resolveBootstrapDecision();
            await pendingBootstrapDecision;
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
