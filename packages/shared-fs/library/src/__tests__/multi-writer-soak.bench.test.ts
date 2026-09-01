import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";

const enabled = process.env.PEERBIT_SHARED_FS_MULTI_WRITER_BENCH === "1";
const manualDescribe = enabled ? describe : describe.skip;
const waitTimeoutMs = process.env.CI ? 120_000 : 60_000;

type WriterSample = {
    round: number;
    writer: number;
    operations: number;
    bytes: number;
    localCommitMs: number;
    allPeersAdmittedMs: number;
    allPeersReadableMs: number;
};

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const percentile = (values: number[], ratio: number) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
};

const distribution = (values: number[]) => ({
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
});

const configuredRounds = () => {
    const rounds = Number(
        process.env.PEERBIT_SHARED_FS_MULTI_WRITER_ROUNDS ?? 30
    );
    if (!Number.isInteger(rounds) || rounds < 10 || rounds > 200) {
        throw new Error(
            "PEERBIT_SHARED_FS_MULTI_WRITER_ROUNDS must be an integer from 10 through 200"
        );
    }
    return rounds;
};

const waitUntil = async (assertion: () => Promise<void> | void) => {
    const deadline = Date.now() + waitTimeoutMs;
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
    throw lastError;
};

manualDescribe("persistent multi-writer benchmark (manual)", () => {
    const peers = new Set<Peerbit>();
    const roots = new Set<string>();

    const stopPeer = async (peer: Peerbit) => {
        peers.delete(peer);
        try {
            await peer.stop();
        } catch (error) {
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

    afterEach(async () => {
        const stopResults = await Promise.allSettled(
            [...peers].map((peer) => stopPeer(peer))
        );
        peers.clear();
        const stopFailure = stopResults.find(
            (result): result is PromiseRejectedResult =>
                result.status === "rejected"
        );
        if (stopFailure) {
            // Preserve directories when a peer may still own storage handles;
            // the failure makes the benchmark result invalid.
            roots.clear();
            throw stopFailure.reason;
        }
        await Promise.all(
            [...roots].map((root) => rm(root, { recursive: true, force: true }))
        );
        roots.clear();
    });

    it(
        "measures concurrent manifested batches from three durable writers",
        // The explicit 10-200 round range includes multi-hour soak runs. Each
        // completed round prints immediately, and this outer cap still bounds
        // a healthy maximum-sized run under the per-stage deadlines.
        { timeout: 28_800_000 },
        async () => {
            const rounds = configuredRounds();
            const root = await mkdtemp(
                join(tmpdir(), "peerbit-shared-fs-multi-writer-bench-")
            );
            roots.add(root);
            const peerList = await Promise.all(
                Array.from({ length: 3 }, (_, index) =>
                    Peerbit.create({ directory: join(root, `peer-${index}`) })
                )
            );
            peerList.forEach((peer) => peers.add(peer));
            await Promise.all([
                peerList[0].dial(peerList[1]),
                peerList[0].dial(peerList[2]),
                peerList[1].dial(peerList[2]),
            ]);

            const owner = await openSharedFs({
                peerbit: peerList[0],
                machineLabel: "multi-writer-bench-0",
                rootKey: peerList[0].identity.publicKey,
                replicate: { factor: 1 },
                bootstrap: false,
                remoteChunkFetch: false,
                gc: false,
            });
            const handles: SharedFsHandle[] = [owner];
            handles.push(
                ...(await Promise.all(
                    peerList.slice(1).map((peer, index) =>
                        openSharedFs({
                            peerbit: peer,
                            address: owner.address,
                            machineLabel: `multi-writer-bench-${index + 1}`,
                            replicate: { factor: 1 },
                            bootstrap: false,
                            remoteChunkFetch: false,
                            gc: false,
                        })
                    )
                ))
            );

            await Promise.all(
                peerList
                    .slice(1)
                    .map((peer) =>
                        owner.authorizeWriter(peer.identity.publicKey)
                    )
            );
            await waitUntil(async () => {
                for (const handle of handles) {
                    for (const peer of peerList) {
                        expect(
                            await handle.isTrustedWriter(
                                peer.identity.publicKey
                            )
                        ).toBe(true);
                    }
                }
            });

            // This post-open namespace arrival is the positive remote evidence
            // used by the normal write-readiness fence. No partial-write
            // override participates in the benchmark.
            const seed = await owner.writeBatch(
                [
                    { path: "/writers/seed.txt", content: "ready" },
                    ...Array.from({ length: 3 }, (_, writer) => ({
                        path: `/writers/writer-${writer}/seed.txt`,
                        content: `writer ${writer}`,
                    })),
                ],
                { changesetId: "multi-writer-bench-seed", manifest: true }
            );
            expect(seed.manifest).toBeDefined();
            await Promise.all(
                handles.map((handle) =>
                    handle.awaitChangeset(seed.changesetId, {
                        manifestId: seed.manifest!.manifestId,
                        timeoutMs: waitTimeoutMs,
                    })
                )
            );
            await Promise.all(
                handles
                    .slice(1)
                    .map((handle) =>
                        handle.awaitWriteReady({ timeout: waitTimeoutMs })
                    )
            );

            const samples: WriterSample[] = [];
            const payload = "x".repeat(4_096);
            const benchmarkStartedAt = performance.now();
            for (let round = 0; round < rounds; round++) {
                const roundSamples = await Promise.all(
                    handles.map(async (writer, writerIndex) => {
                        const changesetId = `multi-writer-${round}-${writerIndex}`;
                        const hotContent = `round=${round};writer=${writerIndex};${payload}`;
                        const immutableContent = `history=${round};writer=${writerIndex};${payload}`;
                        const scratchContent = `scratch=${round};writer=${writerIndex}`;
                        const entries: Parameters<
                            SharedFsHandle["writeBatch"]
                        >[0] = [
                            {
                                path: `/writers/writer-${writerIndex}/hot.bin`,
                                content: hotContent,
                            },
                            {
                                path: `/writers/writer-${writerIndex}/history/round-${round}.bin`,
                                content: immutableContent,
                            },
                            {
                                path: `/writers/writer-${writerIndex}/scratch-${round}.txt`,
                                content: scratchContent,
                            },
                        ];
                        if (round > 0) {
                            entries.push({
                                path: `/writers/writer-${writerIndex}/scratch-${round - 1}.txt`,
                                delete: true,
                            });
                        }

                        const startedAt = performance.now();
                        const result = await writer.writeBatch(entries, {
                            changesetId,
                            manifest: true,
                        });
                        const localCommitMs = performance.now() - startedAt;
                        expect(result.manifest).toBeDefined();
                        const statuses = await Promise.all(
                            handles.map((handle) =>
                                handle.awaitChangeset(changesetId, {
                                    manifestId: result.manifest!.manifestId,
                                    timeoutMs: waitTimeoutMs,
                                })
                            )
                        );
                        const allPeersAdmittedMs =
                            performance.now() - startedAt;
                        for (const status of statuses) {
                            expect(status).toMatchObject({
                                complete: true,
                                verdict: "complete",
                            });
                            expect(status.arrived).toBe(status.expected);
                        }
                        await waitUntil(async () => {
                            for (const handle of handles) {
                                expect(
                                    decode(
                                        await handle.readFile(
                                            `/writers/writer-${writerIndex}/hot.bin`
                                        )
                                    )
                                ).toBe(hotContent);
                                expect(
                                    decode(
                                        await handle.readFile(
                                            `/writers/writer-${writerIndex}/history/round-${round}.bin`
                                        )
                                    )
                                ).toBe(immutableContent);
                                expect(
                                    decode(
                                        await handle.readFile(
                                            `/writers/writer-${writerIndex}/scratch-${round}.txt`
                                        )
                                    )
                                ).toBe(scratchContent);
                                if (round > 0) {
                                    expect(
                                        await handle.stat(
                                            `/writers/writer-${writerIndex}/scratch-${round - 1}.txt`
                                        )
                                    ).toBeUndefined();
                                }
                            }
                        });
                        return {
                            round: round + 1,
                            writer: writerIndex,
                            operations: entries.length,
                            bytes:
                                hotContent.length +
                                immutableContent.length +
                                scratchContent.length,
                            localCommitMs,
                            allPeersAdmittedMs,
                            allPeersReadableMs: performance.now() - startedAt,
                        } satisfies WriterSample;
                    })
                );
                samples.push(...roundSamples);
                console.log(
                    "multi-writer-bench-round:",
                    JSON.stringify(roundSamples, (_key, value) =>
                        typeof value === "number"
                            ? Number(value.toFixed(1))
                            : value
                    )
                );
            }
            const elapsedMs = performance.now() - benchmarkStartedAt;
            const operations = samples.reduce(
                (total, sample) => total + sample.operations,
                0
            );
            const bytes = samples.reduce(
                (total, sample) => total + sample.bytes,
                0
            );
            console.log(
                "multi-writer-bench:",
                JSON.stringify(
                    {
                        rounds,
                        writers: handles.length,
                        samples: samples.length,
                        localCommitMs: distribution(
                            samples.map((sample) => sample.localCommitMs)
                        ),
                        allPeersAdmittedMs: distribution(
                            samples.map((sample) => sample.allPeersAdmittedMs)
                        ),
                        allPeersReadableMs: distribution(
                            samples.map((sample) => sample.allPeersReadableMs)
                        ),
                        operationsPerSecond: (operations * 1_000) / elapsedMs,
                        mebibytesPerSecond:
                            (bytes * 1_000) / elapsedMs / (1024 * 1024),
                        elapsedMs,
                        raw: samples,
                    },
                    (_key, value) =>
                        typeof value === "number"
                            ? Number(value.toFixed(1))
                            : value
                )
            );
        }
    );
});
