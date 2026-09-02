import assert from "node:assert/strict";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Peerbit } from "peerbit";
import {
    createSharedFsMountBackend,
    decodePublicSignKey,
    encodePublicSignKey,
    openSharedFs,
    type SharedFsHandle,
} from "../index.js";
import type {
    ProcessSoakBatchResult,
    ProcessSoakContentExpectation,
    ProcessSoakConflictWriteResult,
    ProcessSoakEditorResult,
    ProcessSoakGcResult,
    ProcessSoakMetrics,
    ProcessSoakOpenResult,
    ProcessSoakTreeExpectation,
    ProcessSoakVerifyResult,
    ProcessSoakWorkerCommand,
    ProcessSoakWorkerMessage,
} from "./process-isolated-soak.bench.protocol.js";
import { processSoakContentHash } from "./process-isolated-soak.bench.payload.js";

const worker = Number(process.argv[2]);
const directory = process.argv[3];
const offline = process.argv[4] === "offline";

if (!Number.isInteger(worker) || worker < 0 || !directory) {
    throw new Error(
        "Expected process-isolated-soak.bench.worker.ts <worker> <directory>"
    );
}

process.once("disconnect", () => {
    process.exit(2);
});

const send = (message: ProcessSoakWorkerMessage) =>
    new Promise<void>((resolve, reject) => {
        if (!process.send) {
            reject(
                new Error("Process soak worker requires a Node IPC channel")
            );
            return;
        }
        process.send(message, (error) => {
            if (error) reject(error);
            else resolve();
        });
    });

const directoryBytes = async (path: string): Promise<number> => {
    let entries;
    try {
        entries = await readdir(path, { withFileTypes: true });
    } catch (error: any) {
        if (error?.code === "ENOENT") return 0;
        throw error;
    }
    let bytes = 0;
    for (const entry of entries) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) {
            bytes += await directoryBytes(child);
            continue;
        }
        try {
            bytes += (await lstat(child)).size;
        } catch (error: any) {
            if (error?.code !== "ENOENT") throw error;
        }
    }
    return bytes;
};

const metrics = async (): Promise<ProcessSoakMetrics> => {
    const memory = process.memoryUsage();
    const resources = process.resourceUsage();
    return {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
        userCpuMicros: resources.userCPUTime,
        systemCpuMicros: resources.systemCPUTime,
        fsReadOps: resources.fsRead,
        fsWriteOps: resources.fsWrite,
        storageBytes: await directoryBytes(directory),
    };
};

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const assertExpectedContent = (
    actual: Uint8Array | undefined,
    expected: ProcessSoakContentExpectation
) => {
    assert(actual, "Expected file content to exist");
    if (typeof expected === "string") {
        assert.equal(decode(actual), expected);
        return;
    }
    assert.equal(
        actual.byteLength,
        Buffer.byteLength(expected.prefix) + expected.bytes
    );
    assert.equal(processSoakContentHash(actual), expected.sha256);
};

const expectedContentHash = (expected: ProcessSoakContentExpectation) =>
    typeof expected === "string"
        ? processSoakContentHash(expected)
        : expected.sha256;

const exactTree = async (fs: SharedFsHandle) => {
    const entries: ProcessSoakTreeExpectation[] = [];
    const visit = async (path: string): Promise<void> => {
        for (const entry of await fs.list(path)) {
            entries.push({ path: entry.path, kind: entry.kind });
            if (entry.kind === "directory") await visit(entry.path);
        }
    };
    await visit("/");
    return entries.sort((left, right) => left.path.localeCompare(right.path));
};

const waitUntil = async (assertion: () => Promise<void>, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }
    throw lastError ?? new Error("Timed out waiting for process soak state");
};

const main = async () => {
    const peerCreateStartedAt = performance.now();
    const peer = await Peerbit.create({
        directory,
        ...(offline ? { libp2p: { addresses: { listen: [] } } } : {}),
    });
    const peerCreateMs = performance.now() - peerCreateStartedAt;
    let fs: SharedFsHandle | undefined;

    const requireFs = () => {
        if (!fs) throw new Error("Shared FS is not open in this worker");
        return fs;
    };

    const handle = async (command: ProcessSoakWorkerCommand) => {
        if (command.type === "dial") {
            await Promise.all(
                command.addresses.map((address) => peer.dial(address))
            );
            return { connected: command.addresses.length };
        }
        if (command.type === "open") {
            if (fs) throw new Error("Shared FS is already open in this worker");
            const deadline = Date.now() + command.timeoutMs;
            const openStartedAt = performance.now();
            fs = await openSharedFs({
                peerbit: peer,
                ...(command.address
                    ? { address: command.address }
                    : { rootKey: peer.identity.publicKey }),
                machineLabel: command.machineLabel,
                replicate: { factor: 1 },
                bootstrap: false,
                remoteChunkFetch: false,
                gc: { schedule: true },
            });
            const openMs = performance.now() - openStartedAt;
            const readyStartedAt = performance.now();
            if (command.address) {
                const remaining = deadline - Date.now();
                if (remaining <= 0) {
                    throw new Error(
                        "Process soak filesystem open exhausted its total timeout before write readiness"
                    );
                }
                await fs.awaitWriteReady({ timeout: remaining });
            }
            const writeReadyMs = performance.now() - readyStartedAt;
            const status = fs.bootstrapStatus();
            return {
                address: fs.address!,
                identity: peer.identity.publicKey.hashcode(),
                openMs,
                writeReadyMs,
                writeReadinessSource: status.writeReadinessSource,
                gcScheduled: fs.gcStatus().scheduled,
            } satisfies ProcessSoakOpenResult;
        }
        if (command.type === "authorize") {
            const current = requireFs();
            const startedAt = performance.now();
            for (const publicKey of command.publicKeys) {
                await current.authorizeWriter(decodePublicSignKey(publicKey));
            }
            return { durationMs: performance.now() - startedAt };
        }
        if (command.type === "write-batch") {
            const current = requireFs();
            const startedAt = performance.now();
            const result = await current.writeBatch(command.entries, {
                changesetId: command.changesetId,
                manifest: true,
            });
            assert(result.manifest, "Manifested write returned no manifest");
            return {
                localCommitMs: performance.now() - startedAt,
                changeset: {
                    id: command.changesetId,
                    manifestId: result.manifest.manifestId,
                    memberCount: result.manifest.memberCount,
                },
                versionIds: result.results.map((version) => version?.id),
            } satisfies ProcessSoakBatchResult;
        }
        if (command.type === "editor-save") {
            const current = requireFs();
            const backend = createSharedFsMountBackend(current);
            const bytes = new TextEncoder().encode(command.content);
            const replaced = await current.stat(command.path);
            assert.equal(replaced?.kind, "file");
            const totalStartedAt = performance.now();
            const file = await backend.open(command.tempPath, {
                write: true,
                create: true,
                truncate: true,
            });
            const split = Math.max(1, Math.floor(bytes.byteLength / 3));
            await backend.write(file, bytes.subarray(0, split), 0);
            await backend.write(file, bytes.subarray(split), split);
            const fsyncStartedAt = performance.now();
            await backend.fsync(file);
            const fsyncMs = performance.now() - fsyncStartedAt;
            const fsyncedTemp = await current.stat(command.tempPath);
            assert.equal(fsyncedTemp?.kind, "file");
            assert.notEqual(fsyncedTemp.nodeId, replaced.nodeId);
            assert.equal(
                decode(await current.readFile(command.tempPath)),
                command.content
            );
            const releaseStartedAt = performance.now();
            await backend.release(file);
            const releaseMs = performance.now() - releaseStartedAt;
            const renameStartedAt = performance.now();
            await backend.rename(command.tempPath, command.path);
            const renameMs = performance.now() - renameStartedAt;
            assert.equal(
                decode(await current.readFile(command.path)),
                command.content
            );
            assert.equal(await current.stat(command.tempPath), undefined);
            const target = await current.stat(command.path);
            assert.equal(target?.nodeId, fsyncedTemp.nodeId);
            assert.notEqual(target.nodeId, replaced.nodeId);
            return {
                fsyncMs,
                releaseMs,
                renameMs,
                totalMs: performance.now() - totalStartedAt,
                replacedNodeId: replaced.nodeId,
                tempNodeId: fsyncedTemp.nodeId,
                targetNodeId: target.nodeId,
            } satisfies ProcessSoakEditorResult;
        }
        if (command.type === "write-conflict") {
            const current = requireFs();
            const startedAt = performance.now();
            const version = await current.writeFile(
                command.path,
                command.content,
                {
                    baseVersionIds: command.baseVersionIds,
                }
            );
            return {
                versionId: version.id,
                localCommitMs: performance.now() - startedAt,
            } satisfies ProcessSoakConflictWriteResult;
        }
        if (command.type === "resolve-conflict") {
            const startedAt = performance.now();
            await requireFs().resolveConflict(command.path, command.versionId);
            return { localCommitMs: performance.now() - startedAt };
        }
        if (command.type === "verify") {
            const current = requireFs();
            const startedAt = performance.now();
            const deadline = Date.now() + command.timeoutMs;
            const remainingMs = (phase: string) => {
                const remaining = deadline - Date.now();
                if (remaining <= 0) {
                    throw new Error(
                        `Process soak verification timed out during ${phase}`
                    );
                }
                return remaining;
            };
            for (const changeset of command.changesets ?? []) {
                const status = await current.awaitChangeset(changeset.id, {
                    manifestId: changeset.manifestId,
                    timeoutMs: remainingMs(
                        `changeset ${changeset.id} admission`
                    ),
                });
                assert.equal(status.complete, true);
                assert.equal(status.verdict, "complete");
                assert.equal(status.expected, changeset.memberCount);
                assert.equal(status.arrived, changeset.memberCount);
            }
            await waitUntil(async () => {
                for (const file of command.files ?? []) {
                    assertExpectedContent(
                        await current.readFile(file.path),
                        file.content
                    );
                }
                for (const path of command.absentPaths ?? []) {
                    assert.equal(await current.stat(path), undefined);
                }
                for (const publicKey of command.trustedPublicKeys ?? []) {
                    assert.equal(
                        await current.isTrustedWriter(
                            decodePublicSignKey(publicKey)
                        ),
                        true
                    );
                }
                for (const path of command.noNamingConflicts ?? []) {
                    assert.deepEqual(await current.namingConflicts(path), []);
                }
                if (command.exactTree) {
                    assert.deepEqual(
                        await exactTree(current),
                        command.exactTree
                    );
                }
                if (command.conflict?.mode === "heads") {
                    const conflicts = await current.conflicts(
                        command.conflict.path
                    );
                    assert.equal(conflicts.length, 1);
                    const actual = conflicts[0].versions
                        .map((version) => version.id)
                        .sort();
                    const expected = command.conflict.heads
                        .map((head) => head.versionId)
                        .sort();
                    assert.deepEqual(actual, expected);
                    for (const head of command.conflict.heads) {
                        assertExpectedContent(
                            await current.readVersion(
                                command.conflict.path,
                                head.versionId
                            ),
                            head.content
                        );
                    }
                } else if (command.conflict?.mode === "resolved") {
                    assert.deepEqual(
                        await current.conflicts(command.conflict.path),
                        []
                    );
                }
            }, remainingMs("exact state verification"));
            let visibleConflictHash: string | undefined;
            if (command.conflict?.mode === "heads") {
                const visibleConflict = await current.readFile(
                    command.conflict.path
                );
                assert(visibleConflict, "Expected a visible conflict head");
                visibleConflictHash = processSoakContentHash(visibleConflict);
                assert(
                    command.conflict.heads.some(
                        (head) =>
                            expectedContentHash(head.content) ===
                            visibleConflictHash
                    ),
                    "Visible conflict head did not match any exact version"
                );
            }
            return {
                durationMs: performance.now() - startedAt,
                visibleConflictHash,
            } satisfies ProcessSoakVerifyResult;
        }
        if (command.type === "collect-garbage") {
            const startedAt = performance.now();
            const report = await requireFs().collectGarbage({ settleMs: 0 });
            return {
                durationMs: performance.now() - startedAt,
                report: {
                    ...report,
                    reclaimedChunkBytes: report.reclaimedChunkBytes.toString(),
                    reclaimedSegmentBytes:
                        report.reclaimedSegmentBytes.toString(),
                },
            } satisfies ProcessSoakGcResult;
        }
        if (command.type === "metrics") return metrics();
        if (command.type === "shutdown") {
            fs?.close();
            await peer.stop();
            return { stopped: true };
        }
        command satisfies never;
    };

    await send({
        type: "ready",
        worker,
        identity: peer.identity.publicKey.hashcode(),
        publicKey: encodePublicSignKey(peer.identity.publicKey),
        addresses: peer.getMultiaddrs().map((address) => address.toString()),
        peerCreateMs,
    });

    let commandChain = Promise.resolve();
    process.on("message", (raw: unknown) => {
        commandChain = commandChain.then(async () => {
            const command = raw as ProcessSoakWorkerCommand;
            if (!command || typeof command.requestId !== "string") return;
            try {
                const value = await handle(command);
                await send({
                    type: "response",
                    requestId: command.requestId,
                    ok: true,
                    value,
                });
                if (command.type === "shutdown") process.exit(0);
            } catch (error: any) {
                await send({
                    type: "response",
                    requestId: command.requestId,
                    ok: false,
                    error: {
                        message: error?.message ?? String(error),
                        stack: error?.stack,
                    },
                });
            }
        });
    });
};

main().catch(async (error: any) => {
    await send({
        type: "fatal",
        message: error?.message ?? String(error),
        stack: error?.stack,
    }).catch(() => {});
    process.exit(1);
});
