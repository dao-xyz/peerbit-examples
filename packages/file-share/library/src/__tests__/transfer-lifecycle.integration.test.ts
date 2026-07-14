import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Files, TinyFile } from "../index.js";

const deferred = <Value = void>() => {
    let resolve!: (value: Value | PromiseLike<Value>) => void;
    const promise = new Promise<Value>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

describe("file transfer lifecycle", () => {
    let peer: Peerbit;

    beforeEach(async () => {
        peer = await Peerbit.create();
    });

    afterEach(async () => {
        await peer.stop();
    });

    it("shares one upload budget across 32 mixed tiny-file owners", async () => {
        const files = await peer.open(new Files());
        const originalPut = files.files.put.bind(files.files);
        let activeCount = 0;
        let activeBytes = 0;
        let peakCount = 0;
        let peakBytes = 0;

        (files.files as any).put = async (value: unknown, ...args: any[]) => {
            if (value instanceof TinyFile && value.parentId == null) {
                activeCount += 1;
                activeBytes += value.file.byteLength;
                peakCount = Math.max(peakCount, activeCount);
                peakBytes = Math.max(peakBytes, activeBytes);
                try {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                    return await (originalPut as any)(value, ...args);
                } finally {
                    activeCount -= 1;
                    activeBytes -= value.file.byteLength;
                }
            }
            return (originalPut as any)(value, ...args);
        };

        const uploads = Array.from({ length: 32 }, (_, index) => {
            const size = index < 8 ? 512 * 1024 : 64 * 1024;
            const bytes = new Uint8Array(size);
            bytes.fill(index);
            const transferId = `mixed-tiny-${index}`;
            if (index % 3 === 0) {
                return files.add(`mixed-${index}`, bytes, { transferId });
            }
            if (index % 3 === 1) {
                return files.addBlob(`mixed-${index}`, new Blob([bytes]), {
                    transferId,
                });
            }
            return files.addSource(
                `mixed-${index}`,
                {
                    size: BigInt(size),
                    readChunks: async function* () {
                        yield bytes;
                    },
                },
                { transferId }
            );
        });

        const ids = await Promise.all(uploads);
        expect(new Set(ids).size).toBe(32);
        expect(peakCount).toBe(8);
        expect(peakBytes).toBe(4 * 1024 * 1024);
        expect(activeCount).toBe(0);
        expect(activeBytes).toBe(0);
        expect(files.getActiveTransfers()).toEqual([]);
        expect(files.getTransferSchedulerDiagnostics().upload).toMatchObject({
            activeCount: 0,
            activeBytes: 0,
            queuedCount: 0,
            peakCount: 8,
            peakBytes: 4 * 1024 * 1024,
        });
        for (let index = 0; index < 32; index++) {
            expect(
                files.getUploadDiagnostics(`mixed-tiny-${index}`)
            ).toMatchObject({
                transferId: `mixed-tiny-${index}`,
                chunkPutCount: 1,
                failureMessage: null,
            });
        }

        await files.add("reuse-a", new Uint8Array([1]), {
            transferId: "reused-upload-transfer",
        });
        expect(files.getActiveTransfers()).toEqual([]);
        await files.add("reuse-b", new Uint8Array([2]), {
            transferId: "reused-upload-transfer",
        });
        expect(files.getActiveTransfers()).toEqual([]);
        expect(
            files.getUploadDiagnostics("reused-upload-transfer")?.fileName
        ).toBe("reuse-b");
    });

    it("bounds normalized source staging across 64 concurrent owners", async () => {
        const files = await peer.open(new Files());
        const sourceSize = 4n * 1024n * 1024n + 1n;
        const started: number[] = [];
        const uploads = Array.from({ length: 64 }, (_, index) =>
            files
                .addSource(
                    `staged-source-${index}`,
                    {
                        size: sourceSize,
                        readChunks: () => ({
                            [Symbol.asyncIterator]() {
                                return this;
                            },
                            next() {
                                started.push(index);
                                return new Promise<never>(() => {});
                            },
                            return() {
                                return Promise.resolve({
                                    done: true as const,
                                    value: undefined,
                                });
                            },
                        }),
                    },
                    { transferId: `staged-source-${index}` }
                )
                .then(
                    () => ({ status: "fulfilled" as const }),
                    (reason) => ({ status: "rejected" as const, reason })
                )
        );

        await vi.waitFor(
            () => {
                expect(started).toHaveLength(8);
                expect(
                    files.getTransferSchedulerDiagnostics().upload
                ).toMatchObject({
                    activeCount: 8,
                    activeBytes: 4 * 1024 * 1024,
                    queuedCount: 56,
                });
            },
            { timeout: 10_000, interval: 20 }
        );

        for (let index = 0; index < 64; index++) {
            expect(
                files.cancelTransfer(
                    `staged-source-${index}`,
                    new Error(`cancel staged source ${index}`)
                )
            ).toBe(true);
        }
        const settled = await Promise.all(uploads);
        expect(settled.every(({ status }) => status === "rejected")).toBe(true);
        expect(started).toHaveLength(8);
        expect(files.getActiveTransfers()).toEqual([]);
        expect(files.getTransferSchedulerDiagnostics().upload).toMatchObject({
            activeCount: 0,
            activeBytes: 0,
            queuedCount: 0,
            peakCount: 8,
            peakBytes: 4 * 1024 * 1024,
        });
    });

    it("keeps a cancelled Blob read charged until its original stream read settles", async () => {
        const files = await peer.open(new Files());
        const readStarted = deferred();
        const delayedRead = deferred<ReadableStreamReadResult<Uint8Array>>();
        let cancelCalls = 0;
        let releaseLockCalls = 0;
        class UncooperativeBlob extends Blob {
            stream(): ReadableStream<Uint8Array> {
                return {
                    getReader: () => ({
                        read: () => {
                            readStarted.resolve();
                            return delayedRead.promise;
                        },
                        cancel: () => {
                            cancelCalls += 1;
                            return Promise.resolve();
                        },
                        releaseLock: () => {
                            releaseLockCalls += 1;
                        },
                    }),
                } as unknown as ReadableStream<Uint8Array>;
            }
        }
        const transferId = "delayed-blob-read";
        const upload = files
            .addBlob(
                "delayed-blob.bin",
                new UncooperativeBlob([new Uint8Array(4 * 1024 * 1024 + 1)]),
                { transferId }
            )
            .then(
                () => ({ status: "fulfilled" as const }),
                (reason) => ({ status: "rejected" as const, reason })
            );
        await readStarted.promise;
        expect(files.getTransferSchedulerDiagnostics().upload).toMatchObject({
            activeCount: 1,
            activeBytes: 512 * 1024,
        });

        expect(
            files.cancelTransfer(transferId, new Error("cancel Blob read"))
        ).toBe(true);
        await expect(upload).resolves.toMatchObject({ status: "rejected" });
        expect(files.getActiveTransfers()).toEqual([]);
        expect(files.getTransferSchedulerDiagnostics().upload).toMatchObject({
            activeCount: 1,
            activeBytes: 512 * 1024,
        });

        await files.add("reuse after Blob cancellation", new Uint8Array([1]), {
            transferId,
        });
        expect(files.getTransferSchedulerDiagnostics().upload.activeBytes).toBe(
            512 * 1024
        );

        delayedRead.resolve({
            done: false,
            value: new Uint8Array(512 * 1024),
        });
        await vi.waitFor(() =>
            expect(
                files.getTransferSchedulerDiagnostics().upload.activeBytes
            ).toBe(0)
        );
        expect(cancelCalls).toBe(1);
        expect(releaseLockCalls).toBe(1);
    });

    it("cancels an uncooperative tiny Blob staging read without releasing its bytes early", async () => {
        const files = await peer.open(new Files());
        const readStarted = deferred();
        const delayedRead = deferred<ArrayBuffer>();
        class UncooperativeTinyBlob extends Blob {
            arrayBuffer(): Promise<ArrayBuffer> {
                readStarted.resolve();
                return delayedRead.promise;
            }
        }

        const transferId = "delayed-tiny-blob-read";
        const upload = files
            .addBlob(
                "delayed-tiny-blob.bin",
                new UncooperativeTinyBlob([new Uint8Array([1])]),
                { transferId }
            )
            .then(
                () => ({ status: "fulfilled" as const }),
                (reason) => ({ status: "rejected" as const, reason })
            );

        await readStarted.promise;
        expect(files.getTransferSchedulerDiagnostics().upload).toMatchObject({
            activeCount: 1,
            activeBytes: 1,
        });
        expect(
            files.cancelTransfer(
                transferId,
                new Error("cancel tiny Blob staging")
            )
        ).toBe(true);
        await expect(upload).resolves.toMatchObject({ status: "rejected" });
        expect(files.getActiveTransfers()).toEqual([]);
        expect(files.getTransferSchedulerDiagnostics().upload).toMatchObject({
            activeCount: 1,
            activeBytes: 1,
            queuedCount: 0,
        });

        await files.add(
            "reuse after tiny Blob cancellation",
            new Uint8Array([2]),
            {
                transferId,
            }
        );
        expect(files.getTransferSchedulerDiagnostics().upload.activeBytes).toBe(
            1
        );

        delayedRead.resolve(new ArrayBuffer(1));
        await vi.waitFor(() =>
            expect(
                files.getTransferSchedulerDiagnostics().upload.activeBytes
            ).toBe(0)
        );
    });

    it("closes while an uncooperative tiny Blob staging read remains detached", async () => {
        const files = await peer.open(new Files());
        const readStarted = deferred();
        const delayedRead = deferred<ArrayBuffer>();
        class UncooperativeTinyBlob extends Blob {
            arrayBuffer(): Promise<ArrayBuffer> {
                readStarted.resolve();
                return delayedRead.promise;
            }
        }

        const upload = files
            .addBlob(
                "closing-tiny-blob.bin",
                new UncooperativeTinyBlob([new Uint8Array([1, 2])]),
                { transferId: "closing-tiny-blob-read" }
            )
            .then(
                () => ({ status: "fulfilled" as const }),
                (reason) => ({ status: "rejected" as const, reason })
            );

        await readStarted.promise;
        await expect(files.close()).resolves.toBe(true);
        await expect(upload).resolves.toMatchObject({ status: "rejected" });
        expect(files.getActiveTransfers()).toEqual([]);
        expect(files.getTransferSchedulerDiagnostics().upload).toMatchObject({
            activeCount: 1,
            activeBytes: 2,
            queuedCount: 0,
        });

        delayedRead.resolve(new ArrayBuffer(2));
        await vi.waitFor(() =>
            expect(
                files.getTransferSchedulerDiagnostics().upload.activeBytes
            ).toBe(0)
        );
    });

    it("rejects a tiny Blob whose materialized size differs from its declaration", async () => {
        const files = await peer.open(new Files());
        class LyingTinyBlob extends Blob {
            arrayBuffer(): Promise<ArrayBuffer> {
                return Promise.resolve(new ArrayBuffer(8 * 1024 * 1024));
            }
        }

        const transferId = "lying-tiny-blob";
        await expect(
            files.addBlob(
                "lying-tiny-blob.bin",
                new LyingTinyBlob([new Uint8Array([1])]),
                { transferId }
            )
        ).rejects.toThrow(
            "Source size changed during upload. Expected 1 bytes, got 8388608"
        );
        expect(await files.list()).toEqual([]);
        expect(files.getUploadDiagnostics(transferId)).toMatchObject({
            chunkPutCount: 0,
            failureMessage:
                "Source size changed during upload. Expected 1 bytes, got 8388608",
        });
        expect(files.getActiveTransfers()).toEqual([]);
        expect(files.getTransferSchedulerDiagnostics().upload).toMatchObject({
            activeCount: 0,
            activeBytes: 0,
            queuedCount: 0,
            peakBytes: 1,
        });
    });

    it("isolates a failed tiny upload from a concurrent sibling", async () => {
        const files = await peer.open(new Files());
        const originalPut = files.files.put.bind(files.files);
        (files.files as any).put = async (value: unknown, ...args: any[]) => {
            if (value instanceof TinyFile && value.name === "fails") {
                throw new Error("injected owner failure");
            }
            return (originalPut as any)(value, ...args);
        };

        const [failed, healthy] = await Promise.allSettled([
            files.add("fails", new Uint8Array([1]), {
                transferId: "failed-owner",
            }),
            files.add("healthy", new Uint8Array([2]), {
                transferId: "healthy-owner",
            }),
        ]);

        expect(failed.status).toBe("rejected");
        expect(
            failed.status === "rejected" && (failed.reason as Error).message
        ).toBe("injected owner failure");
        expect(healthy.status).toBe("fulfilled");
        expect(files.getUploadDiagnostics("failed-owner")?.failureMessage).toBe(
            "injected owner failure"
        );
        expect(
            files.getUploadDiagnostics("healthy-owner")?.failureMessage
        ).toBe(null);
        expect(files.getActiveTransfers()).toEqual([]);
    });

    it.each(["close", "drop"] as const)(
        "%s drains an active write and rejects every later write",
        async (method) => {
            const files = await peer.open(new Files());
            const originalPut = files.files.put.bind(files.files);
            const putStarted = deferred();
            const releasePut = deferred();
            let putCalls = 0;
            let putCompletions = 0;
            let lifecycleResolved = false;

            (files.files as any).put = async (
                value: unknown,
                ...args: any[]
            ) => {
                if (value instanceof TinyFile && value.parentId == null) {
                    putCalls += 1;
                    putStarted.resolve();
                    await releasePut.promise;
                    const result = await (originalPut as any)(value, ...args);
                    putCompletions += 1;
                    return result;
                }
                return (originalPut as any)(value, ...args);
            };

            const upload = files.add("blocked", new Uint8Array([1, 2, 3]), {
                transferId: `${method}-blocked-upload`,
            });
            await putStarted.promise;
            const lifecycle = files[method]().then(() => {
                lifecycleResolved = true;
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(lifecycleResolved).toBe(false);
            expect(files.getActiveTransfers()).toEqual([
                { id: `${method}-blocked-upload`, kind: "upload" },
            ]);

            releasePut.resolve();
            const [uploadResult] = await Promise.all([
                Promise.allSettled([upload]),
                lifecycle,
            ]);
            expect(uploadResult[0]?.status).toBe("rejected");
            expect(lifecycleResolved).toBe(true);
            expect(putCalls).toBe(1);
            expect(putCompletions).toBe(1);
            expect(files.getActiveTransfers()).toEqual([]);

            await expect(
                files.add("after-lifecycle", new Uint8Array([4]))
            ).rejects.toThrow(/File store is (closed|being dropped)/);
            expect(putCalls).toBe(1);
        }
    );

    it.each(["close", "drop"] as const)(
        "%s does not wait forever for an uncooperative source next()",
        async (method) => {
            const files = await peer.open(new Files());
            const nextStarted = deferred();
            let iteratorReturned = false;
            const upload = files.addSource(
                "blocked-source",
                {
                    size: 1n,
                    readChunks: () => ({
                        [Symbol.asyncIterator]() {
                            return this;
                        },
                        next() {
                            nextStarted.resolve();
                            return new Promise<never>(() => {});
                        },
                        return() {
                            iteratorReturned = true;
                            return Promise.resolve({
                                done: true as const,
                                value: undefined,
                            });
                        },
                    }),
                },
                { transferId: `${method}-blocked-source` }
            );
            await nextStarted.promise;

            await expect(
                Promise.race([
                    files[method](),
                    new Promise<never>((_resolve, reject) =>
                        setTimeout(
                            () => reject(new Error("lifecycle timed out")),
                            1_000
                        )
                    ),
                ])
            ).resolves.toBe(true);
            await expect(upload).rejects.toThrow(
                method === "close"
                    ? "File store is closing"
                    : "File store is being dropped"
            );
            expect(iteratorReturned).toBe(true);
            expect(files.getActiveTransfers()).toEqual([]);
        }
    );

    it.each(["close", "drop"] as const)(
        "%s cancels an uncooperative initial file lookup",
        async (method) => {
            const files = await peer.open(new Files());
            const searchStarted = deferred();
            (files.files.index as any).search = async () => {
                searchStarted.resolve();
                return new Promise<never>(() => {});
            };

            const transferId = `${method}-blocked-initial-lookup`;
            const read = files.getById("missing", { transferId });
            await searchStarted.promise;
            expect(files.getActiveTransfers()).toEqual([
                { id: transferId, kind: "read" },
            ]);

            await expect(
                Promise.race([
                    files[method](),
                    new Promise<never>((_resolve, reject) =>
                        setTimeout(
                            () => reject(new Error("lifecycle timed out")),
                            1_000
                        )
                    ),
                ])
            ).resolves.toBe(true);
            await expect(read).rejects.toThrow(
                method === "close"
                    ? "File store is closing"
                    : "File store is being dropped"
            );
            expect(files.getActiveTransfers()).toEqual([]);
        }
    );
});
