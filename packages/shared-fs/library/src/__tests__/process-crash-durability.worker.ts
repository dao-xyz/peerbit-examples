import assert from "node:assert/strict";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Peerbit } from "peerbit";
import {
    createSharedFsMountBackend,
    encodePublicSignKey,
    openSharedFs,
    type SharedFsHandle,
    type WriteBatchResult,
} from "../index.js";
import {
    patternedBytes,
    type ExpectedFile,
    type ProcessCrashWorkerMessage,
} from "./process-crash-durability.protocol.js";

const WAIT_TIMEOUT_MS = process.env.CI ? 180_000 : 60_000;
const PERSISTED_ENTRY_RECEIPTS_CAPABILITY = 1 << 5;

const scenario = process.argv[2];
const root = process.argv[3];

if ((scenario !== "fsync" && scenario !== "multi-writer-disposal") || !root) {
    throw new Error(
        "Expected process-crash-durability.worker.ts <fsync|multi-writer-disposal> <root>"
    );
}

// The parent is the only lifecycle owner. Register this before any scenario
// work so losing the IPC channel can never orphan live Peerbit listeners or
// locked state directories, including immediately after a checkpoint send.
process.once("disconnect", () => process.exit(2));

const bytesEqual = (left: Uint8Array | undefined, right: Uint8Array) =>
    !!left && Buffer.from(left).equals(Buffer.from(right));

const expectedFile = (
    path: string,
    seed: number,
    length: number
): ExpectedFile => ({
    path,
    seed,
    length,
});

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
    throw lastError ?? new Error("Timed out waiting for crash-test condition");
};

const send = (message: ProcessCrashWorkerMessage) =>
    new Promise<void>((resolve, reject) => {
        if (!process.send) {
            reject(new Error("Crash worker requires a Node IPC channel"));
            return;
        }
        process.send(message, (error) => {
            if (error) reject(error);
            else resolve();
        });
    });

const parkForParentKill = () =>
    new Promise<never>(() => {
        // The parent deliberately kills this process after receiving the
        // checkpoint. Keep the event loop alive without introducing a timer as
        // a durability or readiness barrier.
        setInterval(() => undefined, 60_000);
    });

const mountedWriteAndFsync = async (
    fs: SharedFsHandle,
    path: string,
    content: Uint8Array
) => {
    const backend = createSharedFsMountBackend(fs);
    const handle = await backend.open(path, {
        write: true,
        create: true,
        truncate: true,
    });
    const split = Math.floor(content.byteLength / 3);
    await backend.write(handle, content.subarray(0, split), 0);
    await backend.write(handle, content.subarray(split), split);
    const startedAt = performance.now();
    await backend.fsync(handle);
    // Deliberately do not release the handle. The parent kills this process
    // immediately after the checkpoint, so recovery cannot depend on close.
    return performance.now() - startedAt;
};

const runFsyncScenario = async () => {
    const directory = join(root, "local-fsync");
    const peer = await Peerbit.create({ directory });
    const fs = await openSharedFs({
        peerbit: peer,
        machineLabel: "process-crash-fsync",
        rootKey: peer.identity.publicKey,
        replicate: { factor: 1 },
        bootstrap: false,
        remoteChunkFetch: false,
        gc: false,
    });
    assert.ok(fs.address);
    await fs.mkdir("/crash");
    const seed = 11;
    const length = 600_123;
    const content = patternedBytes(seed, length);
    const path = "/crash/fsync.bin";
    const fsyncMs = await mountedWriteAndFsync(fs, path, content);

    await send({
        type: "checkpoint",
        scenario: "fsync",
        address: fs.address,
        identity: peer.identity.publicKey.hashcode(),
        publicKey: encodePublicSignKey(peer.identity.publicKey),
        file: expectedFile(path, seed, length),
        fsyncMs,
    });
    await parkForParentKill();
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
            log as { _peerSyncCapabilities: Map<string, number> }
        )._peerSyncCapabilities.get(remoteHash);
        assert.equal(
            (capabilities ?? 0) & PERSISTED_ENTRY_RECEIPTS_CAPABILITY,
            PERSISTED_ENTRY_RECEIPTS_CAPABILITY
        );
    });
};

const expectManifestComplete = async (
    fs: SharedFsHandle,
    changesetId: string,
    result: WriteBatchResult
) => {
    assert.ok(result.manifest);
    const status = await fs.awaitChangeset(changesetId, {
        manifestId: result.manifest.manifestId,
        timeoutMs: WAIT_TIMEOUT_MS,
    });
    assert.equal(status.complete, true);
    assert.equal(status.verdict, "complete");
    assert.equal(status.expected, result.manifest.memberCount);
    assert.equal(status.arrived, result.manifest.memberCount);
};

const runMultiWriterDisposalScenario = async () => {
    const directories = [
        join(root, "owner"),
        join(root, "writer-two"),
        join(root, "disposable-writer"),
    ];
    const peers = await Promise.all(
        directories.map((directory) => Peerbit.create({ directory }))
    );
    await Promise.all([
        peers[0].dial(peers[1]),
        peers[0].dial(peers[2]),
        peers[1].dial(peers[2]),
    ]);

    const owner = await openSharedFs({
        peerbit: peers[0],
        machineLabel: "crash-owner",
        rootKey: peers[0].identity.publicKey,
        replicate: { factor: 1 },
        bootstrap: false,
        remoteChunkFetch: false,
        gc: false,
    });
    assert.ok(owner.address);
    const address = owner.address;
    await owner.authorizeWriter(peers[1].identity.publicKey);
    await owner.authorizeWriter(peers[2].identity.publicKey);
    await owner.mkdir("/rounds");
    await owner.mkdir("/rounds/writer-two");
    await owner.mkdir("/rounds/disposable-writer");

    const [writerTwo, disposableWriter] = await Promise.all(
        peers.slice(1).map((peer, index) =>
            openSharedFs({
                peerbit: peer,
                address,
                machineLabel:
                    index === 0 ? "crash-writer-two" : "crash-disposable",
                replicate: { factor: 1 },
                bootstrap: false,
                remoteChunkFetch: false,
                gc: false,
            })
        )
    );
    const handles = [owner, writerTwo, disposableWriter];
    await Promise.all(
        handles
            .slice(1)
            .map((fs) => fs.awaitWriteReady({ timeout: WAIT_TIMEOUT_MS }))
    );
    for (const fs of handles) {
        await waitUntil(async () => {
            assert.equal(
                await fs.isTrustedWriter(peers[1].identity.publicKey),
                true
            );
            assert.equal(
                await fs.isTrustedWriter(peers[2].identity.publicKey),
                true
            );
        });
    }

    const expectedFiles: ExpectedFile[] = [];
    const batchEntries = [0, 1].map((file) => {
        const path = `/rounds/writer-two/batch-${file}.bin`;
        const seed = 20 + file;
        const length = 4_000 + file * 173;
        const content = patternedBytes(seed, length);
        expectedFiles.push(expectedFile(path, seed, length));
        return { path, content, chunkSize: 1_024 };
    });
    const changesetId = "process-crash-writer-two-batch";
    const batchResult = await writerTwo.writeBatch(batchEntries, {
        changesetId,
        manifest: true,
    });
    await Promise.all(
        handles.map((fs) =>
            expectManifestComplete(fs, changesetId, batchResult)
        )
    );

    const mountedPath = "/rounds/disposable-writer/mounted.bin";
    const mountedContent = patternedBytes(31, 600_321);
    const mountedFsyncMs = await mountedWriteAndFsync(
        disposableWriter,
        mountedPath,
        mountedContent
    );
    expectedFiles.push(expectedFile(mountedPath, 31, 600_321));
    await waitUntil(async () => {
        for (const fs of handles) {
            assert.equal(
                bytesEqual(await fs.readFile(mountedPath), mountedContent),
                true
            );
        }
    });

    const conflictPath = "/rounds/contested.bin";
    const base = await owner.writeFile(conflictPath, "common base");
    await waitUntil(async () => {
        for (const fs of handles) {
            assert.equal(
                bytesEqual(
                    await fs.readVersion(conflictPath, base.id),
                    new TextEncoder().encode("common base")
                ),
                true
            );
        }
    });
    const conflictPayloads = handles.map((_, index) =>
        patternedBytes(40 + index, 3_500 + index * 137)
    );
    const conflictVersions = await Promise.all(
        handles.map((fs, index) =>
            fs.writeFile(conflictPath, conflictPayloads[index], {
                baseVersionIds: [base.id],
                chunkSize: 1_024,
            })
        )
    );
    const expectedHeadIds = conflictVersions
        .map((version) => version.id)
        .sort();
    await waitUntil(async () => {
        for (const fs of handles) {
            const conflicts = await fs.conflicts(conflictPath);
            assert.equal(conflicts.length, 1);
            assert.deepEqual(
                conflicts[0].versions.map((version) => version.id).sort(),
                expectedHeadIds
            );
        }
    });

    await Promise.all(
        [peers[0], peers[1]].flatMap((remote) => [
            waitForRemoteReceiptCapability(disposableWriter, remote),
            waitForRemoteReceiptCapability(
                disposableWriter,
                remote,
                disposableWriter.program.trustGraph!.trustGraph.log
            ),
        ])
    );
    const disposalStartedAt = performance.now();
    const disposal = await disposableWriter.prepareForDisposal({
        minAcks: 2,
        timeout: WAIT_TIMEOUT_MS,
    });
    const disposalBarrierMs = performance.now() - disposalStartedAt;
    assert.equal(disposal.safeToDispose, true);
    assert.equal(disposal.guarantee, "persisted-per-entry");
    assert.equal(disposal.minAcksPerEntry, 2);
    assert.equal(disposal.empty, false);

    await send({
        type: "checkpoint",
        scenario: "multi-writer-disposal",
        address,
        identities: peers.map((peer) => peer.identity.publicKey.hashcode()),
        publicKeys: peers.map((peer) =>
            encodePublicSignKey(peer.identity.publicKey)
        ),
        files: expectedFiles,
        changeset: {
            id: changesetId,
            manifestId: batchResult.manifest!.manifestId,
            memberCount: batchResult.manifest!.memberCount,
        },
        conflict: {
            path: conflictPath,
            heads: conflictVersions.map((version, index) => ({
                versionId: version.id,
                seed: 40 + index,
                length: 3_500 + index * 137,
            })),
        },
        disposal,
        timings: {
            mountedFsyncMs,
            disposalBarrierMs,
        },
    });
    await parkForParentKill();
};

const main = async () => {
    if (scenario === "fsync") {
        await runFsyncScenario();
    } else {
        await runMultiWriterDisposalScenario();
    }
};

main().catch(async (error: unknown) => {
    const normalized =
        error instanceof Error ? error : new Error(String(error));
    try {
        await send({
            type: "fatal",
            message: normalized.message,
            stack: normalized.stack,
        });
    } finally {
        process.exit(1);
    }
});
