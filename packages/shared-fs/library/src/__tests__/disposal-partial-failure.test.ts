import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistedDeliveryError } from "@peerbit/shared-log";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    openSharedFs,
    PrepareForDisposalError,
    type SharedFsHandle,
} from "../index.js";

const WAIT_TIMEOUT_MS = 30_000;
const decode = (bytes: Uint8Array | undefined) =>
    bytes ? new TextDecoder().decode(bytes) : undefined;

const localRefs = async (fs: SharedFsHandle) =>
    (
        await fs.program.entries.index
            .iterate(
                { query: [] },
                { local: true, remote: false, resolve: false }
            )
            .all()
    )
        .map((row) => ({
            id: row.id,
            kind: row.kind,
            hash: row.__context.head,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));

describe("shared fs partial disposal receipt failure", () => {
    const peers = new Set<Peerbit>();
    let directory: string | undefined;

    const createPeer = async (path: string) => {
        const peer = await Peerbit.create({ directory: path });
        peers.add(peer);
        return peer;
    };

    const stopPeer = async (peer: Peerbit) => {
        await peer.stop();
        peers.delete(peer);
    };

    afterEach(async () => {
        // Restore the receipt boundary before any real program/storage close.
        vi.restoreAllMocks();
        const stopped = await Promise.allSettled([...peers].map(stopPeer));
        const failures = stopped.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : []
        );
        if (failures.length) {
            // Retain disk state if an owner could still be using it.
            throw new AggregateError(
                failures,
                "partial disposal cleanup failed"
            );
        }
        if (directory) {
            await rm(directory, { recursive: true, force: true });
            directory = undefined;
        }
    });

    it("preserves a later receipt failure and only counts completed batches", async () => {
        directory = await mkdtemp(join(tmpdir(), "peerbit-partial-disposal-"));
        const sourceDirectory = join(directory, "source");
        const sourcePeer = await createPeer(sourceDirectory);
        const receiverPeer = await createPeer(join(directory, "receiver"));
        await sourcePeer.dial(receiverPeer);

        const source = await openSharedFs({
            peerbit: sourcePeer,
            machineLabel: "partial-disposal-source",
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });
        await openSharedFs({
            peerbit: receiverPeer,
            address: source.address,
            machineLabel: "partial-disposal-receiver",
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });
        const content = "aaaabbbb";
        await source.writeFile("/kept.txt", content, { chunkSize: 4 });

        const log = source.program.entries.log;
        const before = await localRefs(source);
        const chunkHashes = before
            .filter((row) => row.kind === "file-chunk")
            .map((row) => row.hash)
            .sort();
        const versionHashes = before
            .filter((row) => row.kind === "file-version")
            .map((row) => row.hash)
            .sort();
        const namingHashes = before
            .filter((row) => row.kind === "naming")
            .map((row) => row.hash)
            .sort();
        expect(chunkHashes).toHaveLength(2);
        expect(versionHashes).toHaveLength(1);
        expect(namingHashes).toHaveLength(1);
        const localEntries = await log.log.toArray();
        const beforeHashes = localEntries.map((entry) => entry.hash).sort();
        expect(beforeHashes).toEqual(before.map((row) => row.hash).sort());
        await log.waitForPersistedReceiptPeerReadiness(
            receiverPeer.identity.publicKey,
            {
                entries: localEntries,
                replicas: log.replicas.min.getValue(log),
                timeout: WAIT_TIMEOUT_MS,
            }
        );

        const originalDeliver = log.deliverPersistedEntries.bind(log);
        const attemptedHashes: string[][] = [];
        let completedChunkReceipt = false;
        let originalFailure: PersistedDeliveryError | undefined;
        let originalStack: string | undefined;
        const receiptCause = new Error("injected later receipt failure");
        const delivery = vi
            .spyOn(log, "deliverPersistedEntries")
            .mockImplementation(async (entries, options) => {
                const hashes = entries.map((entry) => entry.hash).sort();
                attemptedHashes.push(hashes);
                if (attemptedHashes.length === 1) {
                    expect(hashes).toEqual(chunkHashes);
                    // This is a REAL N=1 persisted receipt from the disk peer.
                    const result = await originalDeliver(entries, options);
                    completedChunkReceipt = true;
                    return result;
                }
                expect(attemptedHashes).toHaveLength(2);
                expect(completedChunkReceipt).toBe(true);
                expect(hashes).toEqual(versionHashes);
                // Only the second boundary is injected. These entries already
                // exist locally; this is not a live receipt-timeout reproducer.
                originalFailure = new PersistedDeliveryError(
                    receiptCause,
                    hashes
                );
                originalStack = originalFailure.stack;
                throw originalFailure;
            });

        let safeResultReturned = false;
        let failure: unknown;
        try {
            const result = await source.prepareForDisposal({
                minAcks: 1,
                timeout: WAIT_TIMEOUT_MS,
            });
            safeResultReturned = result.safeToDispose;
        } catch (error) {
            failure = error;
        } finally {
            delivery.mockRestore();
        }

        expect(completedChunkReceipt).toBe(true);
        expect(attemptedHashes).toEqual([chunkHashes, versionHashes]);
        expect(attemptedHashes.flat()).not.toContain(namingHashes[0]);
        expect(safeResultReturned).toBe(false);
        expect(failure).toBeInstanceOf(PrepareForDisposalError);
        const wrapped = failure as PrepareForDisposalError;
        expect(wrapped.safeToDispose).toBe(false);
        // Retrying this read-only barrier is distinct from retrying an append.
        expect(wrapped.retrySafe).toBe(true);
        expect(wrapped.confirmedEntries).toBe(chunkHashes.length);
        expect(wrapped.confirmedEntries).toBeGreaterThan(0);
        expect(wrapped.confirmedEntries).toBeLessThan(before.length);
        expect(wrapped.message).toContain("keep the source machine");
        expect(originalFailure).toBeInstanceOf(PersistedDeliveryError);
        expect(wrapped.cause).toBe(originalFailure);
        expect(originalFailure!.stack).toBe(originalStack);
        expect(originalStack).toContain("injected later receipt failure");
        expect(originalFailure!.cause).toBe(receiptCause);
        expect(originalFailure!.localCommitSucceeded).toBe(true);
        expect(originalFailure!.retrySafe).toBe(false);
        expect(originalFailure!.committedHashes).toEqual(versionHashes);
        expect(source.program.closed).toBe(false);
        expect(decode(await source.readFile("/kept.txt"))).toBe(content);
        expect(await localRefs(source)).toEqual(before);
        expect(
            (await log.log.toArray()).map((entry) => entry.hash).sort()
        ).toEqual(beforeHashes);

        // Preserve the source directory: a failed barrier never authorizes its
        // deletion. Reopen it after real graceful close, without remote reads.
        const sourceIdentity = sourcePeer.identity.publicKey.hashcode();
        const address = source.address;
        await stopPeer(receiverPeer);
        await stopPeer(sourcePeer);
        const reopenedPeer = await createPeer(sourceDirectory);
        expect(reopenedPeer.identity.publicKey.hashcode()).toBe(sourceIdentity);
        const reopened = await openSharedFs({
            peerbit: reopenedPeer,
            address,
            machineLabel: "preserved-partial-disposal-source",
            replicate: false,
            bootstrap: false,
            remoteChunkFetch: false,
            gc: false,
        });
        expect(reopenedPeer.libp2p.getConnections()).toHaveLength(0);
        expect(decode(await reopened.readFile("/kept.txt"))).toBe(content);
        // This checks retained source data, not remote crash/reopen durability.
    });
});
