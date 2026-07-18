import { describe, expect, it, vi } from "vitest";
import { deserialize, serialize } from "@dao-xyz/borsh";
import { PutOperation } from "@peerbit/document";
import vm from "node:vm";
import v8 from "node:v8";
import { concat } from "uint8arrays";
import { AbstractFile, Files, LargeFile, TinyFile } from "../index.js";
import {
    adaptRemotePersistedReadAhead,
    getRemotePersistedReadAheadLimit,
    ManifestHeadBatchCircuit,
} from "../read-scheduling.js";
import {
    FairTransferOwner,
    FairTransferScheduler,
} from "../transfer-scheduling.js";

const createDeferred = <Value>() => {
    let resolve!: (value: Value | PromiseLike<Value>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
};

const forceGarbageCollection = () => {
    v8.setFlagsFromString("--expose_gc");
    return vm.runInNewContext("gc") as () => void;
};

const createLookupSignal = (onWait?: () => void) => {
    let closed = false;
    const controller = new AbortController();
    return {
        get isClosed() {
            return closed;
        },
        get abortSignal() {
            return controller.signal;
        },
        snapshot: () => 0,
        throwIfClosed: () => {
            if (closed) {
                throw new Error("File read cancelled");
            }
        },
        waitForChangeAfter: async () => {
            onWait?.();
            return true;
        },
        close: () => {
            closed = true;
            controller.abort();
        },
    };
};

const resolveSingleChunk = (
    file: LargeFile,
    files: Files,
    signal: ReturnType<typeof createLookupSignal>,
    debug: Record<string, any>
) =>
    (file as any).resolveChunk(files, 0, new Map(), {}, signal, {
        timeout: 30_000,
        debug,
        persist: files.persistChunkReads,
        decodeGuard: {
            run: <Value>(operation: () => Promise<Value>) => operation(),
            settle: () => undefined,
        },
    }) as Promise<TinyFile>;

const withHead = <T extends object>(value: T, head: string) => {
    Object.defineProperty(value, "__context", {
        configurable: true,
        value: { head },
    });
    return value;
};

const createPutEntry = (file: TinyFile | LargeFile, hash: string) => ({
    hash,
    getPayloadValue: async () =>
        new PutOperation({
            data: serialize(file),
        }),
});

const createStreamHarness = (size: bigint, chunks: Uint8Array[]) => {
    const files = new Files();
    files.persistChunkReads = false;
    const file = new LargeFile({
        id: "stream-size-file",
        name: "stream-size-file.bin",
        size,
        chunkCount: chunks.length,
        ready: true,
    });
    const chunkFiles = chunks.map(
        (bytes, index) =>
            new TinyFile({
                id: `${file.id}:${index}`,
                name: `${file.name}/${index}`,
                file: bytes,
                parentId: file.id,
                index,
            })
    );
    (files as any).getReadPeerHints = async () => undefined;
    (files.files.index as any).search = async () => [];
    (file as any).waitUntilReady = async () => file;
    (file as any).resolveChunk = async (_files: Files, index: number) =>
        chunkFiles[index];
    return { file, files };
};

const createPersistedManifestStreamHarness = (chunks: Uint8Array[]) => {
    const files = new Files();
    const file = new LargeFile({
        id: "persisted-manifest-stream",
        name: "persisted-manifest-stream.bin",
        size: BigInt(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)),
        chunkCount: chunks.length,
        ready: true,
    });
    const chunkFiles = chunks.map(
        (bytes, index) =>
            new TinyFile({
                id: `${file.id}:${index}`,
                name: `${file.name}/${index}`,
                file: bytes,
                parentId: file.id,
                index,
            })
    );
    const heads = chunkFiles.map((_, index) => `chunk-head-${index}`);
    const entriesByHead = new Map(
        heads.map((head, index) => [
            head,
            createPutEntry(chunkFiles[index]!, head),
        ])
    );
    const fallbackIndices = new Set<number>();
    const perIndexGets: number[] = [];
    const persistedHeads = new Set<string>();
    const rawEntriesByHead = new Map<string, any>();
    const log = files.files.log.log as any;
    let getImplementation: (
        head: string,
        options?: any
    ) => Promise<any> = async () => {
        throw new Error("unexpected single manifest-head fallback");
    };
    let getManyImplementation:
        | ((heads: string[], options: any) => Promise<any[]>)
        | undefined;
    const replicatedGet = async (head: string, options?: any) => {
        if (options?.remote === false && rawEntriesByHead.has(head)) {
            return rawEntriesByHead.get(head);
        }
        const entry = await getImplementation(head, options);
        if (
            entry &&
            (options?.remote === false || options?.remote?.replicate === true)
        ) {
            persistedHeads.add(head);
            rawEntriesByHead.set(head, entry);
        }
        return entry;
    };
    const replicatedGetMany = async (
        requestedHeads: string[],
        options: any
    ) => {
        const entries = await getManyImplementation!(requestedHeads, options);
        if (options?.remote === false || options?.remote?.replicate === true) {
            for (const [index, entry] of entries.entries()) {
                if (entry) {
                    const head = requestedHeads[index]!;
                    persistedHeads.add(head);
                    rawEntriesByHead.set(head, entry);
                }
            }
        }
        return entries;
    };

    (file as any).chunkEntryHeads = heads;
    (files as any).countLocalChunks = async () => 0;
    (files as any).getReadPeerHints = async () => ["writer-peer"];
    Object.defineProperty(files.files.index, "valueEncoding", {
        configurable: true,
        value: {
            decoder: (bytes: Uint8Array) => deserialize(bytes, AbstractFile),
        },
    });
    (files.files.index as any).get = async (id: string) => {
        const prefix = `${file.id}:`;
        if (!id.startsWith(prefix)) {
            throw new Error(`unexpected index get: ${id}`);
        }
        const index = Number(id.slice(prefix.length));
        perIndexGets.push(index);
        if (!fallbackIndices.has(index)) {
            throw new Error(`unexpected per-index fallback: ${index}`);
        }
        return chunkFiles[index];
    };
    (files.files.index as any).search = async () => {
        throw new Error("unexpected indexed fallback");
    };
    Object.defineProperty(log, "get", {
        configurable: true,
        get: () => replicatedGet,
        set: (implementation) => {
            getImplementation = implementation;
        },
    });
    Object.defineProperty(log, "getMany", {
        configurable: true,
        get: () =>
            getManyImplementation == null ? undefined : replicatedGetMany,
        set: (implementation) => {
            getManyImplementation = implementation;
        },
    });
    Object.defineProperty(log, "blocks", {
        configurable: true,
        value: {
            // The harness stubs replicated log reads rather than exercising a
            // real blockstore. Model their durable side effect so production's
            // final exact-head presence gate remains meaningful in unit tests.
            hasMany: async (requestedHeads: string[]) =>
                requestedHeads.map((head) => persistedHeads.has(head)),
            has: async (head: string) => persistedHeads.has(head),
            get: async (head: string, options: any) => {
                const entry = await getImplementation(head, options);
                if (!entry) {
                    return undefined;
                }
                if (
                    options?.remote === false ||
                    options?.remote?.replicate === true
                ) {
                    persistedHeads.add(head);
                    rawEntriesByHead.set(head, entry);
                }
                return new Uint8Array([1]);
            },
        },
    });

    return {
        entriesByHead,
        fallbackIndices,
        file,
        files,
        heads,
        chunkFiles,
        persistedHeads,
        perIndexGets,
    };
};

describe("large-file read scheduling", () => {
    it("clears completed reads before allowing an immediate transfer-id reuse", async () => {
        const files = new Files();
        const tiny = new TinyFile({
            name: "reused-read.bin",
            file: new Uint8Array([1, 2, 3]),
        });

        for (let attempt = 0; attempt < 2; attempt++) {
            await expect(
                tiny.getFile(files, {
                    as: "joined",
                    transferId: "reused-read-transfer",
                })
            ).resolves.toEqual(new Uint8Array([1, 2, 3]));
            expect(files.getActiveTransfers()).toEqual([]);
            expect(
                files.getReadDiagnostics("reused-read-transfer")?.transferId
            ).toBe("reused-read-transfer");
        }
    });

    it.each(["manual", "signal"] as const)(
        "finalizes a %s-cancelled suspended read without iterator.return()",
        async (mode) => {
            const files = new Files();
            const tiny = new TinyFile({
                name: `suspended-${mode}.bin`,
                file: new Uint8Array([1, 2, 3]),
            });
            const controller = new AbortController();
            const transferId = `suspended-${mode}`;
            const iterator = tiny
                .streamFile(files, {
                    signal: controller.signal,
                    transferId,
                })
                [Symbol.asyncIterator]();

            expect(await iterator.next()).toMatchObject({ done: false });
            if (mode === "manual") {
                expect(
                    files.cancelTransfer(transferId, new Error("manual stop"))
                ).toBe(true);
            } else {
                controller.abort(new Error("signal stop"));
            }

            expect(files.getActiveTransfers()).toEqual([]);
            expect(
                files.getTransferSchedulerDiagnostics().download
            ).toMatchObject({
                activeCount: 0,
                activeBytes: 0,
                queuedCount: 0,
            });
            await expect(
                tiny.getFile(files, {
                    as: "joined",
                    transferId,
                })
            ).resolves.toEqual(new Uint8Array([1, 2, 3]));

            // Cleanup the deliberately abandoned generator only after proving
            // cancellation itself released the runtime identity.
            await iterator.return?.();
        }
    );

    it("charges TinyFile writeFile payloads to the shared download budget", async () => {
        const files = new Files();
        const bytes = new Uint8Array(1024 * 1024);
        const tiny = new TinyFile({ name: "charged-write.bin", file: bytes });
        let releaseWrite!: () => void;
        let markWriteStarted!: () => void;
        const writeStarted = new Promise<void>((resolve) => {
            markWriteStarted = resolve;
        });
        const writeReleased = new Promise<void>((resolve) => {
            releaseWrite = resolve;
        });

        const writing = tiny.writeFile(files, {
            write: async () => {
                markWriteStarted();
                await writeReleased;
            },
        });
        await writeStarted;

        expect(files.getTransferSchedulerDiagnostics().download).toMatchObject({
            activeCount: 1,
            activeBytes: bytes.byteLength,
        });
        releaseWrite();
        await writing;
        expect(files.getActiveTransfers()).toEqual([]);
    });

    it("keeps a cancelled write active until original sink work drains", async () => {
        const files = new Files();
        const tiny = new TinyFile({
            name: "blocked-sink.bin",
            file: new Uint8Array([1]),
        });
        let markWriteStarted!: () => void;
        let releaseWrite!: () => void;
        let markAbortStarted!: () => void;
        let releaseAbort!: () => void;
        const writeStarted = new Promise<void>((resolve) => {
            markWriteStarted = resolve;
        });
        const blockedWrite = new Promise<void>((resolve) => {
            releaseWrite = resolve;
        });
        const abortStarted = new Promise<void>((resolve) => {
            markAbortStarted = resolve;
        });
        const blockedAbort = new Promise<void>((resolve) => {
            releaseAbort = resolve;
        });
        let settled = false;
        const pending = tiny
            .writeFile(
                files,
                {
                    write: () => {
                        markWriteStarted();
                        return blockedWrite;
                    },
                    abort: () => {
                        markAbortStarted();
                        return blockedAbort;
                    },
                },
                { transferId: "blocked-sink-write" }
            )
            .finally(() => {
                settled = true;
            });

        await writeStarted;
        expect(
            files.cancelTransfer(
                "blocked-sink-write",
                new Error("cancel blocked sink")
            )
        ).toBe(true);
        await abortStarted;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(settled).toBe(false);
        expect(files.getActiveTransfers()).toEqual([
            { id: "blocked-sink-write", kind: "read" },
        ]);

        releaseWrite();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(settled).toBe(false);
        releaseAbort();
        await expect(pending).rejects.toThrow("cancel blocked sink");
        expect(files.getActiveTransfers()).toEqual([]);
    });

    it("retains all blocked sink credits until each cancelled write drains", async () => {
        const files = new Files();
        const sinkBytes = 4 * 1024 * 1024;
        const releases = new Map<number, () => void>();
        const started: number[] = [];
        const writes = Array.from({ length: 8 }, (_, index) => {
            const blocked = createDeferred<void>();
            releases.set(index, () => blocked.resolve());
            return new TinyFile({
                name: `blocked-four-mib-${index}.bin`,
                file: new Uint8Array(sinkBytes),
            })
                .writeFile(
                    files,
                    {
                        write: async () => {
                            started.push(index);
                            await blocked.promise;
                        },
                    },
                    { transferId: `blocked-four-mib-${index}` }
                )
                .then(
                    () => ({ status: "fulfilled" as const }),
                    (reason) => ({ status: "rejected" as const, reason })
                );
        });

        await vi.waitFor(() => {
            expect(started).toHaveLength(4);
            expect(
                files.getTransferSchedulerDiagnostics().download
            ).toMatchObject({
                activeCount: 4,
                activeBytes: 4 * sinkBytes,
                queuedCount: 4,
            });
        });

        const firstWave = [...started];
        for (const index of firstWave) {
            expect(
                files.cancelTransfer(
                    `blocked-four-mib-${index}`,
                    new Error(`cancel blocked sink ${index}`)
                )
            ).toBe(true);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(files.getTransferSchedulerDiagnostics().download).toMatchObject({
            activeCount: 4,
            activeBytes: 4 * sinkBytes,
            queuedCount: 4,
        });

        for (const index of firstWave) {
            releases.get(index)!();
        }
        await vi.waitFor(() => expect(started).toHaveLength(8));

        const secondWave = started.filter(
            (index) => !firstWave.includes(index)
        );
        for (const index of secondWave) {
            expect(
                files.cancelTransfer(
                    `blocked-four-mib-${index}`,
                    new Error(`cancel blocked sink ${index}`)
                )
            ).toBe(true);
            releases.get(index)!();
        }

        const settled = await Promise.all(writes);
        expect(settled.every(({ status }) => status === "rejected")).toBe(true);
        expect(files.getActiveTransfers()).toEqual([]);
        expect(files.getTransferSchedulerDiagnostics().download).toMatchObject({
            activeCount: 0,
            activeBytes: 0,
            queuedCount: 0,
            peakCount: 4,
            peakBytes: 4 * sinkBytes,
        });
    });

    it("shares download bytes across 32 suspended file consumers", async () => {
        const files = new Files();
        const chunkSize = 1024 * 1024;
        const iterators = Array.from({ length: 32 }, (_, index) =>
            new TinyFile({
                name: `aggregate-read-${index}.bin`,
                file: new Uint8Array(chunkSize),
            })
                .streamFile(files, { transferId: `aggregate-read-${index}` })
                [Symbol.asyncIterator]()
        );
        const firstReads = iterators.map((iterator) => iterator.next());

        await vi.waitFor(() => {
            const snapshot = files.getTransferSchedulerDiagnostics().download;
            expect(snapshot.activeCount).toBe(16);
            expect(snapshot.activeBytes).toBe(16 * chunkSize);
            expect(snapshot.queuedCount).toBe(16);
        });

        const firstWave = await Promise.all(firstReads.slice(0, 16));
        expect(firstWave.every(({ done }) => done === false)).toBe(true);
        // A yielded chunk retains its lease; the second wave cannot resolve
        // until demand resumes the first wave's generators.
        expect(
            files.getTransferSchedulerDiagnostics().download.queuedCount
        ).toBe(16);

        const firstWaveFinished = Promise.all(
            iterators.slice(0, 16).map((iterator) => iterator.next())
        );
        const secondWave = await Promise.all(firstReads.slice(16));
        expect(secondWave.every(({ done }) => done === false)).toBe(true);
        expect(
            files.getTransferSchedulerDiagnostics().download.activeBytes
        ).toBe(16 * chunkSize);

        await firstWaveFinished;
        await Promise.all(
            iterators.slice(16).map((iterator) => iterator.next())
        );
        expect(files.getActiveTransfers()).toEqual([]);
        expect(files.getTransferSchedulerDiagnostics().download).toMatchObject({
            activeCount: 0,
            activeBytes: 0,
            queuedCount: 0,
            peakCount: 16,
            peakBytes: 16 * chunkSize,
        });
    });

    it.each(["getById", "getByName"] as const)(
        "races cancellation through an uncooperative initial %s search",
        async (method) => {
            const files = new Files();
            let observedSignal: AbortSignal | undefined;
            let markSearchStarted!: () => void;
            const searchStarted = new Promise<void>((resolve) => {
                markSearchStarted = resolve;
            });
            (files.files.index as any).search = vi.fn(
                async (
                    _request: unknown,
                    options: { signal?: AbortSignal }
                ) => {
                    observedSignal = options.signal;
                    markSearchStarted();
                    return await new Promise<never>(() => {});
                }
            );
            const controller = new AbortController();
            const pending = files[method]("cancelled-search", {
                as: "joined",
                signal: controller.signal,
                transferId: `cancelled-${method}`,
            });
            await searchStarted;
            controller.abort(new Error("cancel initial search"));

            await expect(pending).rejects.toThrow("cancel initial search");
            expect(observedSignal).toBeInstanceOf(AbortSignal);
            expect(observedSignal).not.toBe(controller.signal);
            expect(observedSignal?.aborted).toBe(true);
            expect(observedSignal?.reason).toBe(controller.signal.reason);
            expect(files.getActiveTransfers()).toEqual([]);
        }
    );

    it.each(["getById", "getByName"] as const)(
        "cancels the initial %s search by transferId and permits reuse",
        async (method) => {
            const files = new Files();
            let markSearchStarted!: () => void;
            const searchStarted = new Promise<void>((resolve) => {
                markSearchStarted = resolve;
            });
            (files.files.index as any).search = vi.fn(async () => {
                markSearchStarted();
                return await new Promise<never>(() => {});
            });
            const transferId = `lookup-${method}`;
            const pending = files[method]("blocked-search", {
                as: "joined",
                transferId,
            });
            await searchStarted;

            expect(files.getActiveTransfers()).toEqual([
                { id: transferId, kind: "read" },
            ]);
            expect(
                files.cancelTransfer(transferId, new Error("cancel lookup"))
            ).toBe(true);
            await expect(pending).rejects.toThrow("cancel lookup");
            expect(files.getActiveTransfers()).toEqual([]);

            (files.files.index as any).search = vi.fn(async () => []);
            await expect(
                files[method]("missing", {
                    as: "joined",
                    transferId,
                })
            ).resolves.toBeUndefined();
        }
    );

    it("cancels a never-settling readiness search and immediately reuses its transfer id", async () => {
        const files = new Files();
        const pending = new LargeFile({
            id: "never-ready",
            name: "never-ready.bin",
            size: 1n,
            chunkCount: 1,
            ready: false,
        });
        const searchStarted = createDeferred<void>();
        (files as any).getReadPeerHints = async () => undefined;
        (files.files.index as any).search = async () => {
            searchStarted.resolve();
            return await new Promise<never>(() => {});
        };
        const transferId = "never-ready-transfer";
        const iterator = pending
            .streamFile(files, { transferId })
            [Symbol.asyncIterator]();
        const next = iterator.next();
        await searchStarted.promise;

        expect(files.getTransferSchedulerDiagnostics().download).toMatchObject({
            activeCount: 1,
            activeBytes: 5_000_000,
        });
        expect(
            files.cancelTransfer(transferId, new Error("cancel ready probe"))
        ).toBe(true);
        await expect(next).rejects.toThrow("cancel ready probe");
        expect(files.getActiveTransfers()).toEqual([]);

        await expect(
            new TinyFile({
                name: "ready-id-reuse.bin",
                file: new Uint8Array([1]),
            }).getFile(files, { as: "joined", transferId })
        ).resolves.toEqual(new Uint8Array([1]));
        // The uncooperative decoder still owns its pessimistic reservation,
        // even though the cancelled runtime identity is already reusable.
        expect(
            files.getTransferSchedulerDiagnostics().download.activeBytes
        ).toBe(5_000_000);
    });

    it("keeps a cancelled chunk lookup charged until its delayed oversized result settles", async () => {
        const files = new Files();
        files.persistChunkReads = false;
        const file = new LargeFile({
            id: "delayed-chunk",
            name: "delayed-chunk.bin",
            size: 1n,
            chunkCount: 1,
            ready: true,
        });
        (file as any).waitUntilReady = async () => file;
        (files as any).getReadPeerHints = async () => undefined;
        (files.files.index as any).search = async () => [];
        const getStarted = createDeferred<void>();
        const delayedGet = createDeferred<TinyFile | undefined>();
        (files.files.index as any).get = async () => {
            getStarted.resolve();
            return delayedGet.promise;
        };

        const transferId = "delayed-chunk-transfer";
        const iterator = file
            .streamFile(files, { transferId })
            [Symbol.asyncIterator]();
        const next = iterator.next();
        await getStarted.promise;
        expect(files.getTransferSchedulerDiagnostics().download).toMatchObject({
            activeCount: 1,
            activeBytes: 5_000_000,
        });

        expect(
            files.cancelTransfer(transferId, new Error("cancel delayed chunk"))
        ).toBe(true);
        await expect(next).rejects.toThrow("cancel delayed chunk");
        expect(files.getActiveTransfers()).toEqual([]);
        expect(
            files.getTransferSchedulerDiagnostics().download.activeBytes
        ).toBe(5_000_000);

        await expect(
            new TinyFile({
                name: "delayed-id-reuse.bin",
                file: new Uint8Array([9]),
            }).getFile(files, { as: "joined", transferId })
        ).resolves.toEqual(new Uint8Array([9]));
        delayedGet.resolve(
            new TinyFile({
                id: `${file.id}:0`,
                name: `${file.name}/0`,
                file: new Uint8Array(5_000_000),
                parentId: file.id,
                index: 0,
            })
        );
        await vi.waitFor(() =>
            expect(
                files.getTransferSchedulerDiagnostics().download.activeBytes
            ).toBe(0)
        );
        expect(files.getActiveTransfers()).toEqual([]);
    });

    it("admits at most three concurrent legacy-sized decoded chunk candidates", async () => {
        const files = new Files();
        files.persistChunkReads = false;
        const largeFiles = Array.from(
            { length: 8 },
            (_, index) =>
                new LargeFile({
                    id: `adversarial-candidate-${index}`,
                    name: `adversarial-candidate-${index}.bin`,
                    size: 512n * 1024n,
                    chunkCount: 1,
                    ready: true,
                })
        );
        for (const file of largeFiles) {
            (file as any).waitUntilReady = async () => file;
        }
        const filesByChunkId = new Map(
            largeFiles.map((file) => [`${file.id}:0`, file])
        );
        const lookupGate = createDeferred<void>();
        let activeLookups = 0;
        let peakLookups = 0;
        let searchCalls = 0;
        const queryValues = (query: any): string[] => {
            if (Array.isArray(query)) {
                return query.flatMap(queryValues);
            }
            if (Array.isArray(query?.or)) {
                return query.or.flatMap(queryValues);
            }
            const value = query?.value?.value ?? query?.value;
            return typeof value === "string" ? [value] : [];
        };
        (files as any).getReadPeerHints = async () => undefined;
        (files.files.index as any).search = async (request: any) => {
            const chunkId = queryValues(request.query).find((value) =>
                filesByChunkId.has(value)
            );
            if (!chunkId) {
                throw new Error("missing exact adversarial chunk query");
            }
            searchCalls += 1;
            activeLookups += 1;
            peakLookups = Math.max(peakLookups, activeLookups);
            await lookupGate.promise;
            const parent = filesByChunkId.get(chunkId)!;
            try {
                return [
                    new TinyFile({
                        id: chunkId,
                        name: `${parent.name}/0`,
                        file: new Uint8Array(5_000_000),
                        parentId: parent.id,
                        index: 0,
                    }),
                ];
            } finally {
                activeLookups -= 1;
            }
        };

        const reads = largeFiles.map((file, index) =>
            file
                .streamFile(files, {
                    transferId: `adversarial-candidate-${index}`,
                })
                [Symbol.asyncIterator]()
                .next()
        );
        await vi.waitFor(() => {
            expect(searchCalls).toBe(3);
            expect(
                files.getTransferSchedulerDiagnostics().download
            ).toMatchObject({
                activeCount: 3,
                activeBytes: 15_000_000,
                queuedCount: 5,
            });
        });
        lookupGate.resolve();

        const settled = await Promise.allSettled(reads);
        expect(settled.every(({ status }) => status === "rejected")).toBe(true);
        expect(searchCalls).toBe(8);
        expect(peakLookups).toBe(3);
        expect(files.getActiveTransfers()).toEqual([]);
        expect(files.getTransferSchedulerDiagnostics().download).toMatchObject({
            activeCount: 0,
            activeBytes: 0,
            queuedCount: 0,
            peakCount: 3,
            peakBytes: 15_000_000,
        });
    });

    it("drops transfer-owned payload references when a large iterator is abandoned", async () => {
        const files = new Files();
        files.persistChunkReads = false;
        const file = new LargeFile({
            id: "abandoned-large-iterator",
            name: "abandoned-large-iterator.bin",
            size: 512n * 1024n,
            chunkCount: 1,
            ready: true,
        });
        (file as any).waitUntilReady = async () => file;
        (files as any).getReadPeerHints = async () => undefined;
        (files.files.index as any).search = async () => [];
        let payloadReference: WeakRef<Uint8Array> | undefined;
        (file as any).resolveChunk = async () => {
            const payload = new Uint8Array(512 * 1024);
            payload[0] = 1;
            payloadReference = new WeakRef(payload);
            return new TinyFile({
                id: `${file.id}:0`,
                name: `${file.name}/0`,
                file: payload,
                parentId: file.id,
                index: 0,
            });
        };

        const transferId = "abandoned-large-transfer";
        const iterator = file
            .streamFile(files, { transferId })
            [Symbol.asyncIterator]();
        await iterator.next();
        expect(payloadReference?.deref()).toBeInstanceOf(Uint8Array);
        expect(
            files.cancelTransfer(transferId, new Error("abandon iterator"))
        ).toBe(true);
        expect(files.getActiveTransfers()).toEqual([]);
        expect(files.getTransferSchedulerDiagnostics().download).toMatchObject({
            activeCount: 0,
            activeBytes: 0,
            queuedCount: 0,
        });

        const gc = forceGarbageCollection();
        for (let attempt = 0; attempt < 20; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            gc();
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (payloadReference?.deref() == null) {
                break;
            }
        }
        expect(payloadReference?.deref()).toBeUndefined();

        // Deliberately do not invoke iterator.return(): cancellation must be
        // sufficient for identity, permit, and payload cleanup.
        await expect(
            new TinyFile({
                name: "abandoned-id-reuse.bin",
                file: new Uint8Array([2]),
            }).getFile(files, { as: "joined", transferId })
        ).resolves.toEqual(new Uint8Array([2]));
        void iterator;
    });

    it("rejects oversized large-file chunks while retaining legacy TinyFile reads", async () => {
        const legacyBytes = new Uint8Array(5_000_000);
        const legacyTiny = new TinyFile({
            name: "legacy-tiny.bin",
            file: legacyBytes,
        });
        const files = new Files();
        await expect(
            legacyTiny.getFile(files, { as: "joined" })
        ).resolves.toHaveLength(legacyBytes.byteLength);

        const { file, files: chunkFiles } = createStreamHarness(
            BigInt(legacyBytes.byteLength),
            [legacyBytes]
        );
        const iterator = file.streamFile(chunkFiles)[Symbol.asyncIterator]();
        await expect(iterator.next()).rejects.toThrow(
            "exceeding its 524288-byte transfer reservation"
        );
        expect(
            chunkFiles.getTransferSchedulerDiagnostics().download.peakBytes
        ).toBe(5_000_000);
    });

    it("rejects a short stream even when no final hash is declared", async () => {
        const { file, files } = createStreamHarness(3n, [
            new Uint8Array([1, 2]),
        ]);
        const iterator = file.streamFile(files)[Symbol.asyncIterator]();

        expect((await iterator.next()).value).toEqual(new Uint8Array([1, 2]));
        await expect(iterator.next()).rejects.toThrow(
            "Expected 3 bytes, got 2"
        );
    });

    it("rejects an oversized chunk before yielding it", async () => {
        const { file, files } = createStreamHarness(1n, [
            new Uint8Array([1, 2]),
        ]);
        const iterator = file.streamFile(files)[Symbol.asyncIterator]();

        await expect(iterator.next()).rejects.toThrow(
            "exceeding its 1-byte transfer reservation"
        );
    });

    it("rejects a positive-size manifest with zero chunks", async () => {
        const { file, files } = createStreamHarness(1n, []);
        const iterator = file.streamFile(files)[Symbol.asyncIterator]();

        await expect(iterator.next()).rejects.toThrow(
            "impossible size/chunk-count geometry"
        );
    });

    it("keeps concurrent write diagnostics scoped to their own streams", async () => {
        const files = new Files();
        files.persistChunkReads = false;
        (files as any).getReadPeerHints = async () => undefined;
        (files.files.index as any).search = async () => [];

        const fileA = new LargeFile({
            id: "concurrent-write-a",
            name: "concurrent-write-a.bin",
            size: 1n,
            chunkCount: 1,
            ready: true,
        });
        const fileB = new LargeFile({
            id: "concurrent-write-b",
            name: "concurrent-write-b.bin",
            size: 1n,
            chunkCount: 1,
            ready: true,
        });
        const chunkA = new TinyFile({
            id: `${fileA.id}:0`,
            name: `${fileA.name}/0`,
            file: new Uint8Array([1]),
            parentId: fileA.id,
            index: 0,
        });
        const chunkB = new TinyFile({
            id: `${fileB.id}:0`,
            name: `${fileB.name}/0`,
            file: new Uint8Array([2]),
            parentId: fileB.id,
            index: 0,
        });
        let markAResolving: () => void = () => {};
        let releaseA: () => void = () => {};
        const aResolving = new Promise<void>((resolve) => {
            markAResolving = resolve;
        });
        const aReleased = new Promise<void>((resolve) => {
            releaseA = resolve;
        });
        (fileA as any).waitUntilReady = async () => fileA;
        (fileB as any).waitUntilReady = async () => fileB;
        (fileA as any).resolveChunk = async () => {
            markAResolving();
            await aReleased;
            return chunkA;
        };
        (fileB as any).resolveChunk = async () => chunkB;

        const writableA = {
            write: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        };
        const writableB = {
            write: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        };

        const writingA = fileA.writeFile(files, writableA);
        await aResolving;
        const diagnosticsA = files.lastReadDiagnostics!;

        await fileB.writeFile(files, writableB);
        const diagnosticsB = files.lastReadDiagnostics!;
        expect(diagnosticsB).not.toBe(diagnosticsA);

        releaseA();
        await writingA;

        expect(diagnosticsA.fileId).toBe(fileA.id);
        expect(diagnosticsA.chunkWriteStartedAt[0]).toEqual(expect.any(Number));
        expect(diagnosticsA.chunkWriteFinishedAt[0]).toEqual(
            expect.any(Number)
        );
        expect(diagnosticsB.fileId).toBe(fileB.id);
        expect(diagnosticsB.chunkWriteStartedAt[0]).toEqual(expect.any(Number));
        expect(diagnosticsB.chunkWriteFinishedAt[0]).toEqual(
            expect.any(Number)
        );
        expect(files.lastReadDiagnostics).toBe(diagnosticsB);
        expect(writableA.write).toHaveBeenCalledOnce();
        expect(writableB.write).toHaveBeenCalledOnce();
    });

    it("does not append TinyFile sink timings to prior large-file diagnostics", async () => {
        const { file, files } = createStreamHarness(1n, [new Uint8Array([1])]);
        await file.getFile(files, { as: "joined" });
        const largeDiagnostics = files.lastReadDiagnostics!;
        expect(largeDiagnostics.chunkWriteStartedAt).toEqual({});
        expect(largeDiagnostics.chunkWriteFinishedAt).toEqual({});

        const tiny = new TinyFile({
            name: "tiny-followup.bin",
            file: new Uint8Array([2]),
        });
        const writes: Uint8Array[] = [];
        await tiny.writeFile(files, {
            write: (chunk) => {
                writes.push(chunk);
            },
        });

        expect(writes).toEqual([new Uint8Array([2])]);
        expect(files.lastReadDiagnostics).toBe(largeDiagnostics);
        expect(largeDiagnostics.chunkWriteStartedAt).toEqual({});
        expect(largeDiagnostics.chunkWriteFinishedAt).toEqual({});
    });

    it("keeps single-write diagnostics benchmark-compatible", async () => {
        const { file, files } = createStreamHarness(1n, [new Uint8Array([1])]);

        await file.writeFile(files, {
            write: async () => {},
            close: async () => {},
        });

        expect(files.lastReadDiagnostics).toMatchObject({
            fileId: file.id,
            fileName: file.name,
            startedAt: expect.any(Number),
            finishedAt: expect.any(Number),
            chunkByteLength: { 0: 1 },
            chunkDemandWaitMs: { 0: expect.any(Number) },
            chunkMaterializeStartedAt: { 0: expect.any(Number) },
            chunkMaterializeFinishedAt: { 0: expect.any(Number) },
            chunkHashStartedAt: { 0: expect.any(Number) },
            chunkHashFinishedAt: { 0: expect.any(Number) },
            chunkWriteStartedAt: { 0: expect.any(Number) },
            chunkWriteFinishedAt: { 0: expect.any(Number) },
            computedFinalHash: null,
        });
    });

    it("wakes on matching document events and removes its listener", async () => {
        const files = new Files();
        const signal = files.createFileChangeSignal(
            (file) => file.id === "upload:0"
        );
        const waiting = signal.waitForChangeAfter(signal.snapshot(), 10_000);

        files.files.events.dispatchEvent(
            new CustomEvent("change", {
                detail: {
                    added: [
                        new TinyFile({
                            id: "upload:0",
                            name: "chunk-0",
                            file: new Uint8Array([1]),
                            parentId: "upload",
                            index: 0,
                        }),
                    ],
                    removed: [],
                },
            })
        );

        expect(await waiting).toBe(true);
        signal.close();
        expect((files as any).activeFileChangeSignals.size).toBe(0);
    });

    it("does not register an already-aborted file-change signal", () => {
        const files = new Files();
        const controller = new AbortController();
        controller.abort(new Error("already cancelled"));

        const signal = files.createFileChangeSignal(
            () => true,
            controller.signal
        );

        expect(signal.isClosed).toBe(true);
        expect((files as any).activeFileChangeSignals.size).toBe(0);
        signal.close();
        expect((files as any).activeFileChangeSignals.size).toBe(0);
    });

    it("bounds, grows, and backs off persisted remote read-ahead", () => {
        expect(getRemotePersistedReadAheadLimit(512 * 1024 * 512, 512)).toBe(8);
        expect(getRemotePersistedReadAheadLimit(2 * 1024 * 1024 * 10, 10)).toBe(
            2
        );
        expect(getRemotePersistedReadAheadLimit(5 * 1024 * 1024 * 10, 10)).toBe(
            1
        );

        expect(
            adaptRemotePersistedReadAhead(2, 8, {
                demandWaitMs: 25,
                attempts: 1,
            })
        ).toBe(3);
        expect(
            adaptRemotePersistedReadAhead(6, 8, {
                demandWaitMs: 100,
                attempts: 2,
            })
        ).toBe(3);
    });

    it("does not let recovery success overwrite a terminal overlapping-batch error", async () => {
        const circuit = new ManifestHeadBatchCircuit();
        const zeroAttempt = circuit.tryStart(0, true)!;
        const olderErrorAttempt = circuit.tryStart(3, true)!;
        expect(circuit.observeZero(zeroAttempt, 2)).toBe("opened");
        expect(circuit.noteManifestHeadResolution(2)).toBe("armed");
        const recoveryAttempt = circuit.tryStart(6, true)!;
        expect(recoveryAttempt.kind).toBe("recovery");

        const terminalError = createDeferred<void>();
        const recoverySuccess = createDeferred<void>();
        const terminalOutcome = terminalError.promise.then(() =>
            circuit.observeError(olderErrorAttempt)
        );
        const recoveryOutcome = recoverySuccess.promise.then(() =>
            circuit.observeRecoverySuccess(recoveryAttempt)
        );

        terminalError.resolve();
        await terminalOutcome;
        expect(circuit.state).toBe("permanent-error");
        recoverySuccess.resolve();
        expect(await recoveryOutcome).toBe(false);
        expect(circuit.state).toBe("permanent-error");
        expect(circuit.epoch).toBeGreaterThan(recoveryAttempt.epoch);
    });

    it("ignores a pre-recovery zero that settles after probe success", async () => {
        const circuit = new ManifestHeadBatchCircuit();
        const zeroAttempt = circuit.tryStart(0, true)!;
        const staleZeroAttempt = circuit.tryStart(3, true)!;
        expect(circuit.observeZero(zeroAttempt, 2)).toBe("opened");
        expect(circuit.noteManifestHeadResolution(2)).toBe("armed");
        const recoveryAttempt = circuit.tryStart(6, true)!;
        expect(recoveryAttempt.kind).toBe("recovery");

        const recoverySuccess = createDeferred<void>();
        const staleZero = createDeferred<void>();
        const recoveryOutcome = recoverySuccess.promise.then(() =>
            circuit.observeRecoverySuccess(recoveryAttempt)
        );
        const staleZeroOutcome = staleZero.promise.then(() =>
            circuit.observeZero(staleZeroAttempt, 5)
        );

        recoverySuccess.resolve();
        expect(await recoveryOutcome).toBe(true);
        expect(circuit.state).toBe("enabled");
        staleZero.resolve();
        expect(await staleZeroOutcome).toBe("stale");
        expect(circuit.state).toBe("enabled");
        expect(circuit.epoch).toBe(recoveryAttempt.epoch);
    });

    it("recovers two independently proven transient zero cycles", () => {
        const circuit = new ManifestHeadBatchCircuit();

        for (const startIndex of [0, 9]) {
            const zeroAttempt = circuit.tryStart(startIndex, true)!;
            expect(zeroAttempt.kind).toBe("normal");
            expect(circuit.observeZero(zeroAttempt, startIndex + 2)).toBe(
                "opened"
            );
            expect(circuit.noteManifestHeadResolution(startIndex + 1)).toBe(
                "armed"
            );
            const recoveryAttempt = circuit.tryStart(startIndex + 3, true)!;
            expect(recoveryAttempt.kind).toBe("recovery");
            expect(circuit.observeRecoverySuccess(recoveryAttempt)).toBe(true);
            expect(circuit.state).toBe("enabled");
        }
    });

    it("starts complete persisted manifest reads at the bounded memory-derived limit", async () => {
        const chunks = Array.from(
            { length: 9 },
            (_, index) => new Uint8Array([index])
        );
        const { entriesByHead, file, files, perIndexGets } =
            createPersistedManifestStreamHarness(chunks);
        const getMany = vi.fn(
            async (requestedHeads: string[], options: any): Promise<any[]> => {
                if (options.remote === false) {
                    return requestedHeads.map(() => undefined);
                }
                return requestedHeads.map((head) => entriesByHead.get(head));
            }
        );
        (files.files.log.log as any).getMany = getMany;

        const roundTrip = await file.getFile(files, { as: "joined" });

        expect(roundTrip).toEqual(concat(chunks));
        expect(perIndexGets).toEqual([]);
        expect(getMany).toHaveBeenCalledTimes(6);
        expect(getMany.mock.calls.every(([heads]) => heads.length <= 3)).toBe(
            true
        );
        const diagnostics = files.lastReadDiagnostics!;
        expect(diagnostics.readAheadInitial).toBe(8);
        expect(diagnostics.readAheadLimit).toBe(8);
        expect(diagnostics.readAheadPeak).toBe(8);
        expect(diagnostics.maxInFlightChunks).toBe(8);
        expect(diagnostics.maxManifestHeadBatchSize).toBe(3);
        expect(diagnostics.chunkManifestHeadBatchAcceptedCount).toBe(9);
        expect(diagnostics.chunkManifestEntryRawFetchAttemptCount).toBe(0);
    });

    it("prefetches aligned persisted manifest heads through one bounded local and remote phase", async () => {
        const { entriesByHead, file, files, heads, perIndexGets } =
            createPersistedManifestStreamHarness([
                new Uint8Array([1, 2]),
                new Uint8Array([3, 4]),
            ]);
        const getMany = vi.fn(
            async (requestedHeads: string[], options: any): Promise<any[]> => {
                if (options.remote === false) {
                    return requestedHeads.map((head) =>
                        head === heads[0] ? entriesByHead.get(head) : undefined
                    );
                }
                return requestedHeads.map((head) => entriesByHead.get(head));
            }
        );
        (files.files.log.log as any).getMany = getMany;

        const roundTrip = await file.getFile(files, { as: "joined" });

        expect(roundTrip).toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(perIndexGets).toEqual([]);
        expect(getMany).toHaveBeenCalledTimes(2);
        const [localHeads, localOptions] = getMany.mock.calls[0]!;
        const [remoteHeads, remoteOptions] = getMany.mock.calls[1]!;
        expect(localHeads).toEqual(heads);
        expect(localOptions.remote).toBe(false);
        expect(remoteHeads).toEqual([heads[1]]);
        expect(remoteOptions.remote).toMatchObject({
            timeout: 1_500,
            replicate: true,
            from: ["writer-peer"],
        });
        expect(remoteOptions.remote.signal).toBeInstanceOf(AbortSignal);
        expect(
            Math.max(...getMany.mock.calls.map(([batch]) => batch.length))
        ).toBeLessThanOrEqual(8);

        const diagnostics = files.lastReadDiagnostics!;
        expect(diagnostics.chunkManifestHeadBatchQueryCount).toBe(1);
        expect(diagnostics.chunkManifestHeadLocalBatchQueryCount).toBe(1);
        expect(diagnostics.chunkManifestHeadRemoteBatchQueryCount).toBe(1);
        expect(diagnostics.chunkManifestHeadBatchRequestedIndexCount).toBe(2);
        expect(diagnostics.chunkManifestHeadLocalBatchAcceptedCount).toBe(1);
        expect(diagnostics.chunkManifestHeadRemoteBatchAcceptedCount).toBe(1);
        expect(diagnostics.chunkManifestHeadBatchAcceptedCount).toBe(2);
        expect(diagnostics.chunkManifestHeadBatchMissingCount).toBe(0);
        expect(diagnostics.chunkManifestHeadBatchInvalidCount).toBe(0);
        expect(diagnostics.chunkManifestHeadBatchPartialCount).toBe(0);
        expect(diagnostics.chunkManifestHeadBatchErrorCount).toBe(0);
        expect(diagnostics.chunkManifestHeadBatchDisabled).toBe(false);
        expect(diagnostics.maxManifestHeadBatchSize).toBeLessThanOrEqual(8);
        expect(diagnostics.maxConcurrentManifestHeadBatches).toBe(1);
        expect(diagnostics.chunkBatchResolverFallbackCount).toBe(0);
        expect(diagnostics.finalKnownChunkCount).toBe(0);
        expect((files as any).retainedChunkEntryHeads).toEqual(new Set(heads));
    });

    it("uses aligned entry-index batches when public log getMany is unavailable", async () => {
        const {
            entriesByHead,
            file,
            files,
            heads,
            perIndexGets,
            persistedHeads,
        } = createPersistedManifestStreamHarness([
            new Uint8Array([1]),
            new Uint8Array([2]),
        ]);
        const entryIndexGetMany = vi.fn(
            async (requestedHeads: string[], options: any): Promise<any[]> => {
                const entries =
                    options.remote === false
                        ? requestedHeads.map((head) =>
                              head === heads[0]
                                  ? entriesByHead.get(head)
                                  : undefined
                          )
                        : requestedHeads.map((head) => entriesByHead.get(head));
                if (
                    options.remote === false ||
                    options.remote?.replicate === true
                ) {
                    for (const [index, entry] of entries.entries()) {
                        if (entry) {
                            persistedHeads.add(requestedHeads[index]!);
                        }
                    }
                }
                return entries;
            }
        );
        const log = files.files.log.log as any;
        Object.defineProperty(log, "getMany", {
            configurable: true,
            value: undefined,
        });
        Object.defineProperty(log, "entryIndex", {
            configurable: true,
            value: { getMany: entryIndexGetMany },
        });

        const roundTrip = await file.getFile(files, { as: "joined" });

        expect(roundTrip).toEqual(new Uint8Array([1, 2]));
        expect(perIndexGets).toEqual([]);
        expect(entryIndexGetMany).toHaveBeenCalledTimes(2);
        const [localHeads, localOptions] = entryIndexGetMany.mock.calls[0]!;
        const [remoteHeads, remoteOptions] = entryIndexGetMany.mock.calls[1]!;
        expect(localHeads).toEqual(heads);
        expect(localOptions).toMatchObject({
            type: "full",
            ignoreMissing: true,
            remote: false,
        });
        expect(remoteHeads).toEqual([heads[1]]);
        expect(remoteOptions).toMatchObject({
            type: "full",
            ignoreMissing: true,
            remote: {
                timeout: 1_500,
                replicate: true,
                from: ["writer-peer"],
            },
        });
        expect(remoteOptions.remote.signal).toBeInstanceOf(AbortSignal);
        expect(
            files.lastReadDiagnostics?.chunkManifestHeadBatchAcceptedCount
        ).toBe(2);
    });

    it("uses bounded aligned per-head gets when neither batch API is available", async () => {
        const { entriesByHead, file, files, heads, perIndexGets } =
            createPersistedManifestStreamHarness([
                new Uint8Array([1]),
                new Uint8Array([2]),
            ]);
        const log = files.files.log.log as any;
        Object.defineProperty(log, "getMany", {
            configurable: true,
            value: undefined,
        });
        Object.defineProperty(log, "entryIndex", {
            configurable: true,
            value: {},
        });
        let activeGets = 0;
        let maxActiveGets = 0;
        const get = vi.fn(async (head: string, options: any): Promise<any> => {
            activeGets += 1;
            maxActiveGets = Math.max(maxActiveGets, activeGets);
            try {
                await Promise.resolve();
                if (options.remote === false && head !== heads[0]) {
                    return undefined;
                }
                return entriesByHead.get(head);
            } finally {
                activeGets -= 1;
            }
        });
        log.get = get;

        const roundTrip = await file.getFile(files, { as: "joined" });

        expect(roundTrip).toEqual(new Uint8Array([1, 2]));
        expect(perIndexGets).toEqual([]);
        expect(get).toHaveBeenCalledTimes(3);
        expect(get.mock.calls.map(([head]) => head)).toEqual([
            heads[0],
            heads[1],
            heads[1],
        ]);
        expect(get.mock.calls[0]![1].remote).toBe(false);
        expect(get.mock.calls[1]![1].remote).toBe(false);
        expect(get.mock.calls[2]![1].remote).toMatchObject({
            timeout: 1_500,
            replicate: true,
            from: ["writer-peer"],
        });
        expect(get.mock.calls[2]![1].remote.signal).toBeInstanceOf(AbortSignal);
        expect(maxActiveGets).toBeLessThanOrEqual(8);
    });

    it.each([
        ["empty", [""]],
        ["whitespace", [" chunk-head-0"]],
        ["control character", ["chunk-head-\u0001"]],
        ["duplicate", ["duplicate-head", "duplicate-head"]],
    ] as const)(
        "keeps legacy replicating fallbacks for %s manifest evidence",
        async (_case, malformedHeads) => {
            const chunks = malformedHeads.map(
                (_, index) => new Uint8Array([index + 1])
            );
            const { chunkFiles, file, files, persistedHeads } =
                createPersistedManifestStreamHarness(chunks);
            (file as any).chunkEntryHeads = [...malformedHeads];
            const exactGet = vi.fn(async () => {
                throw new Error("invalid manifest evidence was used");
            });
            const replicateFlags: boolean[] = [];
            (files.files.log.log as any).get = exactGet;
            (files.files.index as any).get = async (
                id: string,
                options: any
            ) => {
                if (options.remote === false) {
                    return undefined;
                }
                replicateFlags.push(options.remote.replicate);
                const index = Number(id.slice(id.lastIndexOf(":") + 1));
                return chunkFiles[index];
            };

            await expect(
                file.getFile(files, { as: "joined" })
            ).resolves.toEqual(concat(chunks));

            expect(exactGet).not.toHaveBeenCalled();
            expect(replicateFlags).toEqual(malformedHeads.map(() => true));
            expect(persistedHeads).toEqual(new Set());
            expect(
                files.lastReadDiagnostics
                    ?.chunkManifestEntryPersistenceStartedCount
            ).toBe(0);
        }
    );

    it("falls back only for missing persisted manifest-head batch results", async () => {
        const {
            entriesByHead,
            fallbackIndices,
            file,
            files,
            heads,
            perIndexGets,
            persistedHeads,
        } = createPersistedManifestStreamHarness([
            new Uint8Array([1]),
            new Uint8Array([2]),
        ]);
        fallbackIndices.add(1);
        const getMany = vi.fn(
            async (requestedHeads: string[], options: any): Promise<any[]> => {
                if (options.remote === false) {
                    return requestedHeads.map(() => undefined);
                }
                return requestedHeads.map((head) =>
                    head === heads[0] ? entriesByHead.get(head) : undefined
                );
            }
        );
        (files.files.log.log as any).getMany = getMany;
        let persistenceAttempts = 0;
        const persistenceAttemptStartedAt: number[] = [];
        const persistenceAttemptTimeouts: number[] = [];
        (files.files.log.log as any).get = async (
            head: string,
            options: any
        ) => {
            if (head === heads[1]) {
                persistenceAttemptStartedAt.push(Date.now());
                persistenceAttemptTimeouts.push(options.remote.timeout);
            }
            if (head === heads[1] && persistenceAttempts++ < 2) {
                return undefined;
            }
            const entry = entriesByHead.get(head);
            if (entry) {
                persistedHeads.add(head);
            }
            return entry;
        };

        const roundTrip = await file.getFile(files, { as: "joined" });

        expect(roundTrip).toEqual(new Uint8Array([1, 2]));
        expect(perIndexGets).toEqual([1]);
        expect(getMany).toHaveBeenCalledTimes(2);
        expect(getMany.mock.calls[1]![0]).toEqual(heads);
        const diagnostics = files.lastReadDiagnostics!;
        expect(diagnostics.chunkManifestHeadBatchAcceptedCount).toBe(1);
        expect(diagnostics.chunkManifestHeadLocalBatchAcceptedCount).toBe(0);
        expect(diagnostics.chunkManifestHeadRemoteBatchAcceptedCount).toBe(1);
        expect(diagnostics.chunkManifestHeadBatchMissingCount).toBe(1);
        expect(diagnostics.chunkManifestHeadBatchPartialCount).toBe(1);
        expect(diagnostics.chunkManifestHeadBatchDisabled).toBe(false);
        expect(persistenceAttempts).toBe(3);
        expect(
            persistenceAttemptStartedAt.at(-1)! -
                persistenceAttemptStartedAt[0]!
        ).toBeGreaterThanOrEqual(60);
        expect(
            persistenceAttemptTimeouts.every((timeout) => timeout >= 4_900)
        ).toBe(true);
        expect(diagnostics.chunkManifestEntryPersistenceSucceededCount).toBe(1);
        expect(diagnostics.chunkManifestEntryRawFetchAttemptCount).toBe(3);
        expect((files as any).retainedChunkEntryHeads).toEqual(new Set(heads));
    });

    it("fails persistent finalization when an exact manifest head stays unavailable", async () => {
        const { chunkFiles, file, files, heads, persistedHeads } =
            createPersistedManifestStreamHarness([new Uint8Array([1])]);
        (files.files.log.log as any).getMany = async (
            requestedHeads: string[]
        ) => requestedHeads.map(() => undefined);
        (files.files.log.log as any).get = async () => undefined;
        (files.files.index as any).get = async (_id: string, options: any) =>
            options.remote === false ? undefined : chunkFiles[0];

        const iterator = file
            .streamFile(files, { timeout: 100 })
            [Symbol.asyncIterator]();
        await expect(iterator.next()).resolves.toEqual({
            done: false,
            value: new Uint8Array([1]),
        });
        await expect(iterator.next()).rejects.toThrow(
            "Failed to persist exact manifest entry"
        );

        expect(persistedHeads).toEqual(new Set());
        expect(
            files.lastReadDiagnostics?.chunkManifestEntryPersistenceFailedCount
        ).toBe(1);
        expect((files as any).retainedChunkEntryHeads).not.toContain(heads[0]);
    });

    it("keeps manifest-backed demand reads ahead of causal replication after a zero batch", async () => {
        const chunks = [
            new Uint8Array([1]),
            new Uint8Array([2]),
            new Uint8Array([3]),
        ];
        const {
            chunkFiles,
            entriesByHead,
            file,
            files,
            heads,
            persistedHeads,
        } = createPersistedManifestStreamHarness(chunks);
        const entryImports = new Map(
            heads.map((head) => [head, createDeferred<any>()])
        );
        const getMany = vi.fn(
            async (requestedHeads: string[]): Promise<any[]> =>
                requestedHeads.map(() => undefined)
        );
        const get = vi.fn(async (head: string) => {
            const pending = entryImports.get(head);
            if (!pending) {
                throw new Error(`unexpected entry head: ${head}`);
            }
            return pending.promise;
        });
        const directGet = vi.fn(async () => undefined);
        const search = vi.fn(async (_request: unknown, options: any) => {
            if (options.remote.replicate) {
                throw new Error("simulated causal catch-up barrier");
            }
            return chunkFiles.map((chunk, index) =>
                withHead(chunk, heads[index]!)
            );
        });
        (files.files.log.log as any).getMany = getMany;
        (files.files.log.log as any).get = get;
        (files.files.index as any).get = directGet;
        (files.files.index as any).search = search;

        let firstReadSettled = false;
        const firstRead = file
            .getFile(files, { as: "joined" })
            .finally(() => (firstReadSettled = true));

        await vi.waitFor(() => {
            expect(get).toHaveBeenCalledTimes(chunks.length);
            expect(search).toHaveBeenCalled();
        });

        // Demand bytes are queried while every exact signed-entry import is
        // still pending. The full persistent read cannot finalize until those
        // imports settle, but first-byte work is no longer behind that gate.
        expect(firstReadSettled).toBe(false);
        expect(persistedHeads).toEqual(new Set());
        expect(
            search.mock.calls.every(
                ([, options]) => options.remote.replicate === false
            )
        ).toBe(true);
        for (const head of heads) {
            entryImports.get(head)!.resolve(entriesByHead.get(head));
        }

        const roundTrip = await firstRead;

        expect(roundTrip).toEqual(concat(chunks));
        expect(getMany).toHaveBeenCalledTimes(2);
        expect(get).toHaveBeenCalled();
        expect(
            get.mock.calls.every(([, options]) => options.remote.replicate)
        ).toBe(true);
        expect(
            directGet.mock.calls
                .filter(([, options]) => options.remote !== false)
                .every(([, options]) => options.remote.replicate === false)
        ).toBe(true);
        const diagnostics = files.lastReadDiagnostics!;
        expect(diagnostics.chunkManifestHeadBatchDisabledReason).toBe(
            "zero-accepted"
        );
        expect(diagnostics.chunkManifestHeadBatchCircuitState).toBe(
            "half-open-ready"
        );
        expect(
            diagnostics.chunkManifestHeadBatchRecoveryProofCount
        ).toBeGreaterThan(0);
        expect(diagnostics.chunkAttempts).toEqual({ 0: 1, 1: 1, 2: 1 });
        expect(diagnostics.readAheadChanges).toEqual([]);
        expect(diagnostics.chunkManifestEntryPersistenceSucceededCount).toBe(
            chunks.length
        );
        expect(persistedHeads).toEqual(new Set(heads));

        // Remove every remote demand seam and prove the next read resolves
        // solely from the exact entry blocks imported by the first read.
        const remoteGetCallCount = get.mock.calls.length;
        (files.files.log.log as any).getMany = vi.fn(
            async (requestedHeads: string[], options: any) => {
                if (options.remote !== false) {
                    throw new Error("offline reader attempted a remote batch");
                }
                return requestedHeads.map((head) =>
                    persistedHeads.has(head)
                        ? entriesByHead.get(head)
                        : undefined
                );
            }
        );
        (files.files.index as any).search = vi.fn(async () => {
            throw new Error("offline reader attempted a Documents search");
        });

        const offlineRoundTrip = await file.getFile(files, { as: "joined" });

        expect(offlineRoundTrip).toEqual(concat(chunks));
        expect(get).toHaveBeenCalledTimes(remoteGetCallCount);
        expect(
            files.lastReadDiagnostics?.chunkManifestHeadRemoteBatchQueryCount
        ).toBe(0);
        expect(
            files.lastReadDiagnostics?.chunkManifestHeadLocalBatchAcceptedCount
        ).toBe(chunks.length);
    });

    it("keeps retryable demand fallbacks ahead of a deferred raw import", async () => {
        const { chunkFiles, entriesByHead, file, files, heads } =
            createPersistedManifestStreamHarness([new Uint8Array([1])]);
        const rawImport = createDeferred<any>();
        const exactGet = vi.fn(async () => rawImport.promise);
        const directGet = vi.fn(async (_id: string, options: any) => {
            if (options.remote === false) {
                return undefined;
            }
            throw Object.assign(new Error("direct request timed out"), {
                name: "TimeoutError",
            });
        });
        const indexedSearch = vi.fn(async (_request: unknown, options: any) => {
            expect(options.remote.replicate).toBe(false);
            return [chunkFiles[0]];
        });
        (files.files.log.log as any).getMany = async (
            requestedHeads: string[]
        ) => requestedHeads.map(() => undefined);
        (files.files.log.log as any).get = exactGet;
        (files.files.index as any).get = directGet;
        (files.files.index as any).search = indexedSearch;

        const iterator = file.streamFile(files)[Symbol.asyncIterator]();
        const first = await iterator.next();

        expect(first).toEqual({ done: false, value: new Uint8Array([1]) });
        expect(directGet).toHaveBeenCalled();
        expect(indexedSearch).toHaveBeenCalledOnce();
        expect(exactGet).toHaveBeenCalledOnce();

        let finalizationSettled = false;
        const finalization = iterator
            .next()
            .finally(() => (finalizationSettled = true));
        await Promise.resolve();
        expect(finalizationSettled).toBe(false);

        rawImport.resolve(entriesByHead.get(heads[0]!));
        await expect(finalization).resolves.toEqual({
            done: true,
            value: undefined,
        });
        expect(
            files.lastReadDiagnostics
                ?.chunkManifestEntryPersistenceSucceededCount
        ).toBe(1);
    });

    it("retains only the authoritative head for a transient Documents batch hit", async () => {
        const {
            chunkFiles,
            entriesByHead,
            file,
            files,
            heads,
            persistedHeads,
        } = createPersistedManifestStreamHarness([new Uint8Array([1])]);
        const authoritativeHead = heads[0]!;
        const transientHead = "transient-documents-entry";
        const deliveryChunk = withHead(chunkFiles[0]!, transientHead);
        const rawImport = createDeferred<any>();
        const exactGet = vi.fn(async () => rawImport.promise);
        const localBatchSearch = vi.fn(
            async (_request: unknown, options: any) => {
                expect(options.remote).toBe(false);
                return [deliveryChunk];
            }
        );
        (files as any).countLocalChunks = async () => 1;
        (files as any).countLocalChunkBlocks = async () => 0;
        (files.files.log.log as any).get = exactGet;
        (files.files.index as any).search = localBatchSearch;

        const iterator = file.streamFile(files)[Symbol.asyncIterator]();
        await expect(iterator.next()).resolves.toEqual({
            done: false,
            value: new Uint8Array([1]),
        });

        expect(localBatchSearch).toHaveBeenCalledOnce();
        expect(exactGet).toHaveBeenCalledOnce();
        expect(persistedHeads).toEqual(new Set());
        expect(
            (files as any).retainedChunkEntryHeads ?? new Set()
        ).not.toContain(transientHead);
        expect((files as any).retainedChunkIds).toContain(deliveryChunk.id);

        const finalization = iterator.next();
        rawImport.resolve(entriesByHead.get(authoritativeHead));
        await expect(finalization).resolves.toEqual({
            done: true,
            value: undefined,
        });

        expect(persistedHeads).toEqual(new Set([authoritativeHead]));
        expect((files as any).retainedChunkEntryHeads).toEqual(
            new Set([authoritativeHead])
        );
    });

    it("rejects hashless persistent reads when transient bytes differ from the exact entry", async () => {
        const { entriesByHead, file, files, heads, persistedHeads } =
            createPersistedManifestStreamHarness([new Uint8Array([1])]);
        expect(file.finalHash).toBeUndefined();
        const authoritativeHead = heads[0]!;
        const transientChunk = new TinyFile({
            id: `${file.id}:0`,
            name: `${file.name}/0`,
            file: new Uint8Array([2]),
            parentId: file.id,
            index: 0,
        });
        const rawImport = createDeferred<any>();
        const exactGet = vi.fn(async () => rawImport.promise);
        const localBatchSearch = vi.fn(
            async (_request: unknown, options: any) => {
                expect(options.remote).toBe(false);
                return [transientChunk];
            }
        );
        (files as any).countLocalChunks = async () => 1;
        (files as any).countLocalChunkBlocks = async () => 0;
        (files.files.log.log as any).get = exactGet;
        (files.files.index as any).search = localBatchSearch;

        const iterator = file.streamFile(files)[Symbol.asyncIterator]();
        await expect(iterator.next()).resolves.toEqual({
            done: false,
            value: new Uint8Array([2]),
        });
        const finalization = iterator.next();
        rawImport.resolve(entriesByHead.get(authoritativeHead));

        await expect(finalization).rejects.toThrow(
            "Persistent file read content did not match exact manifest entries for chunks 1"
        );

        expect(exactGet).toHaveBeenCalledOnce();
        expect(persistedHeads).toEqual(new Set([authoritativeHead]));
        expect(
            files.lastReadDiagnostics?.chunkManifestEntryContentMismatchIndices
        ).toEqual([0]);
        expect(files.lastReadDiagnostics?.finishedAt).toBeNull();
    });

    it("rejects persistent finalization when an imported head has an invalid payload", async () => {
        const { chunkFiles, file, files, heads } =
            createPersistedManifestStreamHarness([new Uint8Array([1])]);
        const invalidChunk = new TinyFile({
            id: chunkFiles[0]!.id,
            name: chunkFiles[0]!.name,
            file: chunkFiles[0]!.file,
            parentId: "wrong-parent",
            index: 0,
        });
        (files.files.log.log as any).getMany = async (
            requestedHeads: string[]
        ) => requestedHeads.map(() => undefined);
        (files.files.log.log as any).get = async (head: string) =>
            createPutEntry(invalidChunk, head);
        let invalidEntryBlockStored = false;
        Object.defineProperty(files.files.log.log, "blocks", {
            configurable: true,
            value: {
                hasMany: async () => [invalidEntryBlockStored],
                has: async () => invalidEntryBlockStored,
                get: async () => {
                    invalidEntryBlockStored = true;
                    return new Uint8Array([1]);
                },
            },
        });
        (files.files.index as any).get = async (_id: string, options: any) =>
            options.remote === false ? undefined : chunkFiles[0];

        await expect(file.getFile(files, { as: "joined" })).rejects.toThrow(
            "Manifest entry payload mismatch"
        );

        expect(
            files.lastReadDiagnostics?.chunkManifestEntryPersistenceFailedCount
        ).toBe(1);
        expect((files as any).retainedChunkEntryHeads).not.toContain(heads[0]);
    });

    it("imports the raw signed block when an observer cache entry is not durable", async () => {
        const { chunkFiles, entriesByHead, file, files, heads } =
            createPersistedManifestStreamHarness([new Uint8Array([1])]);
        const head = heads[0]!;
        const cachedEntry = entriesByHead.get(head)!;
        let rawBlockStored = false;
        const rawGet = vi.fn(async (_head: string, options: any) => {
            expect(options.remote).toMatchObject({
                replicate: true,
                from: ["writer-peer"],
            });
            rawBlockStored = true;
            return new Uint8Array([1]);
        });
        const cachedGetMany = vi.fn(async () => [cachedEntry]);
        const localDecode = vi.fn(async () => cachedEntry);
        const log = files.files.log.log as any;
        Object.defineProperty(log, "getMany", {
            configurable: true,
            value: cachedGetMany,
        });
        Object.defineProperty(log, "get", {
            configurable: true,
            value: localDecode,
        });
        Object.defineProperty(log, "blocks", {
            configurable: true,
            value: {
                hasMany: async () => [rawBlockStored],
                has: async () => rawBlockStored,
                get: rawGet,
            },
        });
        (files.files.index as any).get = async (_id: string, options: any) =>
            options.remote === false ? undefined : chunkFiles[0];

        await expect(file.getFile(files, { as: "joined" })).resolves.toEqual(
            new Uint8Array([1])
        );

        expect(cachedGetMany).toHaveBeenCalledTimes(2);
        expect(rawGet).toHaveBeenCalledOnce();
        expect(localDecode).toHaveBeenCalledWith(head, { remote: false });
        expect(rawBlockStored).toBe(true);
        expect(
            files.lastReadDiagnostics?.chunkManifestHeadBatchCacheOnlyCount
        ).toBe(2);
        expect(
            files.lastReadDiagnostics
                ?.chunkManifestEntryPersistenceSucceededCount
        ).toBe(1);
        expect(
            files.lastReadDiagnostics?.chunkManifestEntryRawFetchAttemptCount
        ).toBe(1);
    });

    it("continues local exact-head batches before the remote circuit recovers", async () => {
        const chunks = Array.from(
            { length: 6 },
            (_, index) => new Uint8Array([index + 1])
        );
        const {
            entriesByHead,
            fallbackIndices,
            file,
            files,
            heads,
            perIndexGets,
        } = createPersistedManifestStreamHarness(chunks);
        fallbackIndices.add(0);
        fallbackIndices.add(1);
        fallbackIndices.add(2);
        fallbackIndices.add(4);
        fallbackIndices.add(5);
        const remoteBatchStarts: number[] = [];
        const localBatchStarts: number[] = [];
        const getMany = vi.fn(
            async (requestedHeads: string[], options: any): Promise<any[]> => {
                const firstIndex = heads.indexOf(requestedHeads[0]!);
                if (options.remote === false) {
                    localBatchStarts.push(firstIndex);
                    return firstIndex >= 3
                        ? requestedHeads.map((head, offset) =>
                              offset === 0 ? entriesByHead.get(head) : undefined
                          )
                        : requestedHeads.map(() => undefined);
                }
                remoteBatchStarts.push(firstIndex);
                return requestedHeads.map(() => undefined);
            }
        );
        (files.files.log.log as any).getMany = getMany;
        (files.files.log.log as any).get = async (head: string) =>
            entriesByHead.get(head);

        const roundTrip = await file.getFile(files, { as: "joined" });

        expect(roundTrip).toEqual(concat(chunks));
        expect(perIndexGets).toEqual([0, 1, 2, 4, 5]);
        expect(remoteBatchStarts).toEqual([0, 4]);
        expect(localBatchStarts).toEqual([0, 3]);
        const diagnostics = files.lastReadDiagnostics!;
        expect(diagnostics.chunkManifestHeadBatchCircuitState).toBe("enabled");
        expect(diagnostics.chunkManifestHeadLocalBatchAcceptedCount).toBe(1);
        expect(diagnostics.chunkManifestHeadRemoteBatchAcceptedCount).toBe(0);
        expect(diagnostics.chunkManifestHeadBatchDisabledSkipCount).toBe(0);
        expect(
            diagnostics.chunkManifestHeadBatchDisabledSkippedIndexCount
        ).toBe(0);
        expect(diagnostics.chunkManifestHeadBatchMissingCount).toBe(5);
        expect(diagnostics.chunkManifestHeadBatchPartialCount).toBe(1);
        expect(diagnostics.chunkManifestHeadBatchRecoveryProofCount).toBe(3);
        expect(diagnostics.chunkManifestHeadBatchRecoveryProbeCount).toBe(1);
        expect(diagnostics.chunkManifestHeadBatchRecoverySuccessCount).toBe(1);
    });

    for (const mode of ["error", "zero-accepted"] as const) {
        it(`disables later persisted manifest-head probes after a ${mode} batch`, async () => {
            const {
                entriesByHead,
                fallbackIndices,
                file,
                files,
                heads,
                perIndexGets,
            } = createPersistedManifestStreamHarness([
                new Uint8Array([1]),
                new Uint8Array([2]),
                new Uint8Array([3]),
                new Uint8Array([4]),
                new Uint8Array([5]),
                new Uint8Array([6]),
                new Uint8Array([7]),
                new Uint8Array([8]),
                new Uint8Array([9]),
                new Uint8Array([10]),
            ]);
            for (let index = 0; index < 10; index++) {
                fallbackIndices.add(index);
            }
            const getMany = vi.fn(
                async (
                    requestedHeads: string[],
                    options: any
                ): Promise<any[]> => {
                    if (options.remote === false) {
                        return requestedHeads.map((head) =>
                            mode === "error" && head === heads[0]
                                ? entriesByHead.get(head)
                                : undefined
                        );
                    }
                    if (mode === "error") {
                        throw new Error("speculative manifest-head failure");
                    }
                    return requestedHeads.map(() => undefined);
                }
            );
            (files.files.log.log as any).getMany = getMany;
            (files.files.log.log as any).get = async (head: string) =>
                entriesByHead.get(head);

            const roundTrip = await file.getFile(files, { as: "joined" });

            expect(roundTrip).toEqual(
                new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
            );
            expect(perIndexGets).toEqual(
                mode === "error"
                    ? [1, 2, 3, 4, 5, 6, 7, 8, 9]
                    : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
            );
            const localBatchCalls = getMany.mock.calls.filter(
                ([, options]) => options.remote === false
            );
            const remoteBatchCalls = getMany.mock.calls.filter(
                ([, options]) => options.remote !== false
            );
            expect(localBatchCalls.map(([batch]) => batch)).toEqual([
                heads.slice(0, 3),
                heads.slice(3, 6),
                heads.slice(6, 9),
                heads.slice(9, 10),
            ]);
            expect(remoteBatchCalls.map(([batch]) => batch)).toEqual(
                mode === "error"
                    ? [heads.slice(1, 3)]
                    : [heads.slice(0, 3), heads.slice(3, 6)]
            );
            expect(
                remoteBatchCalls.every(
                    ([, options]) => options.remote.replicate === true
                )
            ).toBe(true);

            const diagnostics = files.lastReadDiagnostics!;
            expect(diagnostics.chunkManifestHeadBatchQueryCount).toBe(4);
            expect(diagnostics.chunkManifestHeadLocalBatchQueryCount).toBe(4);
            expect(diagnostics.chunkManifestHeadRemoteBatchQueryCount).toBe(
                mode === "error" ? 1 : 2
            );
            expect(diagnostics.chunkManifestHeadBatchDisabled).toBe(true);
            expect(diagnostics.chunkManifestHeadBatchDisabledReason).toBe(mode);
            expect(diagnostics.chunkManifestHeadBatchCircuitState).toBe(
                mode === "error" ? "permanent-error" : "permanent-zero"
            );
            expect(
                diagnostics.chunkManifestHeadBatchFirstDisabledStartIndex
            ).toBe(0);
            expect(diagnostics.chunkManifestHeadBatchRecoveryProofCount).toBe(
                mode === "error" ? 0 : 3
            );
            expect(diagnostics.chunkManifestHeadBatchRecoveryProbeCount).toBe(
                mode === "error" ? 0 : 1
            );
            expect(diagnostics.chunkManifestHeadBatchRecoverySuccessCount).toBe(
                0
            );
            expect(
                diagnostics.chunkManifestHeadBatchPermanentDisableReason
            ).toBe(mode === "error" ? "error" : "zero-accepted");
            // The pessimistic decoder reservation caps the speculative batch
            // at three chunks. Once the
            // consumer resumes, three bounded scheduling windows record all
            // seven disabled tail probes before fallback completes.
            expect(diagnostics.chunkManifestHeadBatchDisabledSkipCount).toBe(
                mode === "error" ? 3 : 2
            );
            expect(
                diagnostics.chunkManifestHeadBatchDisabledSkippedIndexCount
            ).toBe(mode === "error" ? 7 : 4);
            expect(diagnostics.chunkManifestHeadBatchErrorCount).toBe(
                mode === "error" ? 1 : 0
            );
            expect(diagnostics.chunkManifestHeadBatchAcceptedCount).toBe(
                mode === "error" ? 1 : 0
            );
            expect(diagnostics.chunkManifestHeadLocalBatchAcceptedCount).toBe(
                mode === "error" ? 1 : 0
            );
            expect(diagnostics.chunkManifestHeadRemoteBatchAcceptedCount).toBe(
                0
            );
            expect(diagnostics.prefetchedChunkCount).toBe(
                mode === "error" ? 1 : 0
            );
            expect(diagnostics.chunkManifestHeadBatchMissingCount).toBe(
                mode === "zero-accepted" ? 10 : 9
            );
        });
    }

    it("admits one half-open batch after a per-index manifest-head proof", async () => {
        const chunks = Array.from(
            { length: 12 },
            (_, index) => new Uint8Array([index + 1])
        );
        const { chunkFiles, entriesByHead, file, files, heads, perIndexGets } =
            createPersistedManifestStreamHarness(chunks);
        const remoteBatchStarts: number[] = [];
        const getMany = vi.fn(
            async (requestedHeads: string[], options: any): Promise<any[]> => {
                if (options.remote === false) {
                    return requestedHeads.map(() => undefined);
                }
                const firstIndex = heads.indexOf(requestedHeads[0]!);
                remoteBatchStarts.push(firstIndex);
                if (firstIndex === 3) {
                    return requestedHeads.map(() => undefined);
                }
                return requestedHeads.map((head) => entriesByHead.get(head));
            }
        );
        const get = vi.fn(async (head: string) => entriesByHead.get(head));
        (files.files.log.log as any).getMany = getMany;
        (files.files.log.log as any).get = get;
        (files.files.index as any).get = async () => undefined;
        const indexedSearch = vi.fn(async (_request: unknown, options: any) => {
            expect(options.remote.replicate).toBe(false);
            return chunkFiles;
        });
        (files.files.index as any).search = indexedSearch;

        const roundTrip = await file.getFile(files, { as: "joined" });

        expect(roundTrip).toEqual(concat(chunks));
        expect(perIndexGets).toEqual([]);
        expect(remoteBatchStarts).toContain(0);
        expect(remoteBatchStarts).toContain(3);
        expect(remoteBatchStarts.some((index) => index > 5)).toBe(true);
        expect(get).toHaveBeenCalled();
        expect(indexedSearch).toHaveBeenCalled();
        const diagnostics = files.lastReadDiagnostics!;
        expect(diagnostics.chunkManifestHeadBatchDisabled).toBe(true);
        expect(diagnostics.chunkManifestHeadBatchDisabledReason).toBe(
            "zero-accepted"
        );
        expect(diagnostics.chunkManifestHeadBatchCircuitState).toBe("enabled");
        expect(diagnostics.chunkManifestHeadBatchFirstDisabledStartIndex).toBe(
            3
        );
        expect(
            diagnostics.chunkManifestHeadBatchRecoveryEligibleAfterIndex
        ).toBe(5);
        expect(
            diagnostics.chunkManifestHeadBatchRecoveryProofCount
        ).toBeGreaterThan(0);
        expect(diagnostics.chunkManifestHeadBatchRecoveryProbeCount).toBe(1);
        expect(
            diagnostics.chunkManifestHeadBatchRecoveryProbeStartIndex
        ).toBeGreaterThan(5);
        expect(diagnostics.chunkManifestHeadBatchRecoverySuccessCount).toBe(1);
        expect(
            diagnostics.chunkManifestHeadBatchPermanentDisableReason
        ).toBeNull();
        expect(diagnostics.maxManifestHeadBatchSize).toBe(3);
    });

    it("recovers persisted batching after two transient zero batches", async () => {
        const chunks = Array.from(
            { length: 21 },
            (_, index) => new Uint8Array([index + 1])
        );
        const { chunkFiles, entriesByHead, file, files, heads, perIndexGets } =
            createPersistedManifestStreamHarness(chunks);
        const remoteBatchStarts: number[] = [];
        const transientZeroStarts = new Set([3, 12]);
        const getMany = vi.fn(
            async (requestedHeads: string[], options: any): Promise<any[]> => {
                if (options.remote === false) {
                    return requestedHeads.map(() => undefined);
                }
                const firstIndex = heads.indexOf(requestedHeads[0]!);
                remoteBatchStarts.push(firstIndex);
                return transientZeroStarts.has(firstIndex)
                    ? requestedHeads.map(() => undefined)
                    : requestedHeads.map((head) => entriesByHead.get(head));
            }
        );
        const get = vi.fn(async (head: string) => entriesByHead.get(head));
        (files.files.log.log as any).getMany = getMany;
        (files.files.log.log as any).get = get;
        (files.files.index as any).get = async () => undefined;
        const indexedSearch = vi.fn(async (_request: unknown, options: any) => {
            expect(options.remote.replicate).toBe(false);
            return chunkFiles;
        });
        (files.files.index as any).search = indexedSearch;

        const roundTrip = await file.getFile(files, { as: "joined" });

        expect(roundTrip).toEqual(concat(chunks));
        expect(perIndexGets).toEqual([]);
        expect(remoteBatchStarts).toContain(3);
        expect(remoteBatchStarts).toContain(12);
        expect(get).toHaveBeenCalled();
        expect(indexedSearch).toHaveBeenCalled();
        const diagnostics = files.lastReadDiagnostics!;
        expect(diagnostics.chunkManifestHeadBatchCircuitState).toBe("enabled");
        expect(
            diagnostics.chunkManifestHeadBatchRecoveryProofCount
        ).toBeGreaterThanOrEqual(2);
        expect(diagnostics.chunkManifestHeadBatchRecoveryProbeCount).toBe(2);
        expect(diagnostics.chunkManifestHeadBatchRecoverySuccessCount).toBe(2);
        expect(
            diagnostics.chunkManifestHeadBatchPermanentDisableReason
        ).toBeNull();
        expect(diagnostics.maxManifestHeadBatchSize).toBe(3);
    });

    it("permanently opens after the one half-open batch also accepts zero entries", async () => {
        const chunks = Array.from(
            { length: 15 },
            (_, index) => new Uint8Array([index + 1])
        );
        const { chunkFiles, entriesByHead, file, files, heads, perIndexGets } =
            createPersistedManifestStreamHarness(chunks);
        const remoteBatchStarts: number[] = [];
        const getMany = vi.fn(
            async (requestedHeads: string[], options: any): Promise<any[]> => {
                if (options.remote === false) {
                    return requestedHeads.map(() => undefined);
                }
                const firstIndex = heads.indexOf(requestedHeads[0]!);
                remoteBatchStarts.push(firstIndex);
                return firstIndex === 0
                    ? requestedHeads.map((head) => entriesByHead.get(head))
                    : requestedHeads.map(() => undefined);
            }
        );
        const get = vi.fn(async (head: string) => entriesByHead.get(head));
        (files.files.log.log as any).getMany = getMany;
        (files.files.log.log as any).get = get;
        (files.files.index as any).get = async () => undefined;
        const indexedSearch = vi.fn(async (_request: unknown, options: any) => {
            expect(options.remote.replicate).toBe(false);
            return chunkFiles;
        });
        (files.files.index as any).search = indexedSearch;

        const roundTrip = await file.getFile(files, { as: "joined" });

        expect(roundTrip).toEqual(concat(chunks));
        expect(perIndexGets).toEqual([]);
        expect(remoteBatchStarts).toHaveLength(3);
        expect(remoteBatchStarts.slice(0, 2)).toEqual([0, 3]);
        expect(remoteBatchStarts[2]).toBeGreaterThan(5);
        expect(get).toHaveBeenCalled();
        expect(indexedSearch).toHaveBeenCalled();
        const diagnostics = files.lastReadDiagnostics!;
        expect(diagnostics.chunkManifestHeadBatchDisabled).toBe(true);
        expect(diagnostics.chunkManifestHeadBatchDisabledReason).toBe(
            "zero-accepted"
        );
        expect(diagnostics.chunkManifestHeadBatchCircuitState).toBe(
            "permanent-zero"
        );
        expect(
            diagnostics.chunkManifestHeadBatchRecoveryProofCount
        ).toBeGreaterThan(0);
        expect(diagnostics.chunkManifestHeadBatchRecoveryProbeCount).toBe(1);
        expect(diagnostics.chunkManifestHeadBatchRecoverySuccessCount).toBe(0);
        expect(diagnostics.chunkManifestHeadBatchPermanentDisableReason).toBe(
            "zero-accepted"
        );
        expect(
            diagnostics.chunkManifestHeadBatchDisabledSkipCount
        ).toBeGreaterThan(0);
        expect(diagnostics.maxManifestHeadBatchSize).toBe(3);
    });

    it("keeps batch errors terminal after per-index manifest-head successes", async () => {
        const chunks = Array.from(
            { length: 10 },
            (_, index) => new Uint8Array([index + 1])
        );
        const { chunkFiles, entriesByHead, file, files, perIndexGets } =
            createPersistedManifestStreamHarness(chunks);
        let remoteBatchCalls = 0;
        const getMany = vi.fn(
            async (requestedHeads: string[], options: any): Promise<any[]> => {
                if (options.remote === false) {
                    return requestedHeads.map(() => undefined);
                }
                remoteBatchCalls += 1;
                throw new Error("terminal manifest-head batch failure");
            }
        );
        const get = vi.fn(async (head: string) => entriesByHead.get(head));
        (files.files.log.log as any).getMany = getMany;
        (files.files.log.log as any).get = get;
        (files.files.index as any).get = async () => undefined;
        const indexedSearch = vi.fn(async (_request: unknown, options: any) => {
            expect(options.remote.replicate).toBe(false);
            return chunkFiles;
        });
        (files.files.index as any).search = indexedSearch;

        const roundTrip = await file.getFile(files, { as: "joined" });

        expect(roundTrip).toEqual(concat(chunks));
        expect(perIndexGets).toEqual([]);
        expect(remoteBatchCalls).toBe(1);
        expect(get).toHaveBeenCalled();
        expect(indexedSearch).toHaveBeenCalled();
        const diagnostics = files.lastReadDiagnostics!;
        expect(diagnostics.chunkManifestHeadBatchCircuitState).toBe(
            "permanent-error"
        );
        expect(diagnostics.chunkManifestHeadBatchDisabledReason).toBe("error");
        expect(diagnostics.chunkManifestHeadBatchRecoveryProofCount).toBe(0);
        expect(diagnostics.chunkManifestHeadBatchRecoveryProbeCount).toBe(0);
        expect(diagnostics.chunkManifestHeadBatchPermanentDisableReason).toBe(
            "error"
        );
    });

    it("fails closed when authoritative heads decode to invalid chunks", async () => {
        const {
            entriesByHead,
            fallbackIndices,
            file,
            files,
            heads,
            perIndexGets,
        } = createPersistedManifestStreamHarness([
            new Uint8Array([1]),
            new Uint8Array([2]),
            new Uint8Array([3]),
            new Uint8Array([4]),
        ]);
        fallbackIndices.add(0);
        fallbackIndices.add(2);
        const invalidParent = new TinyFile({
            id: `${file.id}:0`,
            name: `${file.name}/0`,
            file: new Uint8Array([9]),
            parentId: "different-parent",
            index: 0,
        });
        const invalidIndex = new TinyFile({
            id: `${file.id}:2`,
            name: `${file.name}/2`,
            file: new Uint8Array([9]),
            parentId: file.id,
            index: 99,
        });
        const invalidEntries = new Map([
            [heads[0], createPutEntry(invalidParent, heads[0]!)],
            [heads[2], createPutEntry(invalidIndex, heads[2]!)],
        ]);
        const getMany = vi.fn(
            async (requestedHeads: string[], options: any): Promise<any[]> => {
                expect(options.remote).toBe(false);
                return requestedHeads.map(
                    (head) =>
                        invalidEntries.get(head) ?? entriesByHead.get(head)
                );
            }
        );
        (files.files.log.log as any).getMany = getMany;

        await expect(file.getFile(files, { as: "joined" })).rejects.toThrow(
            "Manifest entry payload mismatch"
        );

        expect(perIndexGets).toEqual([0, 2]);
        expect(
            getMany.mock.calls.every(([, options]) => options.remote === false)
        ).toBe(true);
        const diagnostics = files.lastReadDiagnostics!;
        expect(diagnostics.chunkManifestHeadBatchAcceptedCount).toBe(2);
        expect(diagnostics.chunkManifestHeadBatchInvalidCount).toBe(2);
        expect(diagnostics.chunkManifestHeadBatchPartialCount).toBe(1);
        expect(diagnostics.chunkManifestHeadBatchDisabled).toBe(false);
        expect(diagnostics.chunkManifestEntryPersistenceFailedCount).toBe(2);
        expect((files as any).retainedChunkEntryHeads).not.toContain(heads[0]);
        expect((files as any).retainedChunkEntryHeads).not.toContain(heads[2]);
    });

    it("yields a locally accepted batch index before a remote sibling settles", async () => {
        const { entriesByHead, file, files, heads, perIndexGets } =
            createPersistedManifestStreamHarness([
                new Uint8Array([1]),
                new Uint8Array([2]),
                new Uint8Array([3]),
            ]);
        const remoteStarted = createDeferred<void>();
        const remoteGate = createDeferred<void>();
        let remoteSettled = false;
        let remoteSignal: AbortSignal | undefined;
        const getMany = vi.fn(
            async (requestedHeads: string[], options: any): Promise<any[]> => {
                if (options.remote === false) {
                    return requestedHeads.map((head) =>
                        head === heads[0] ? entriesByHead.get(head) : undefined
                    );
                }
                remoteSignal = options.remote.signal;
                remoteStarted.resolve();
                await remoteGate.promise;
                remoteSettled = true;
                return requestedHeads.map((head) => entriesByHead.get(head));
            }
        );
        (files.files.log.log as any).getMany = getMany;

        const iterator = file.streamFile(files)[Symbol.asyncIterator]();
        const firstRead = iterator.next();
        try {
            await remoteStarted.promise;
            let firstReadTimeout!: ReturnType<typeof setTimeout>;
            const first = await Promise.race([
                firstRead,
                new Promise<never>((_, reject) => {
                    firstReadTimeout = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    "local batch index waited for remote sibling"
                                )
                            ),
                        1_000
                    );
                }),
            ]).finally(() => clearTimeout(firstReadTimeout));
            expect(first).toEqual({
                done: false,
                value: new Uint8Array([1]),
            });
            expect(remoteSettled).toBe(false);
            expect(remoteSignal?.aborted).toBe(false);

            remoteGate.resolve();
            expect(await iterator.next()).toEqual({
                done: false,
                value: new Uint8Array([2]),
            });
            expect(await iterator.next()).toEqual({
                done: false,
                value: new Uint8Array([3]),
            });
            expect(await iterator.next()).toEqual({
                done: true,
                value: undefined,
            });

            expect(remoteSettled).toBe(true);
            expect(perIndexGets).toEqual([]);
            const diagnostics = files.lastReadDiagnostics!;
            expect(diagnostics.chunkPersistedRemoteBatchSkippedIndexCount).toBe(
                0
            );
            expect(diagnostics.chunkManifestHeadBatchMissingCount).toBe(0);
            expect(diagnostics.activeManifestHeadBatches).toBe(0);
            expect(diagnostics.finalKnownChunkCount).toBe(0);
            expect(files.getActiveTransfers()).toEqual([]);
            expect(
                files.getTransferSchedulerDiagnostics().download
            ).toMatchObject({
                activeCount: 0,
                activeBytes: 0,
                queuedCount: 0,
            });
            expect((files as any).activeFileChangeSignals.size).toBe(0);
        } finally {
            remoteGate.resolve();
            await iterator.return?.();
        }
    });

    it("does not re-request a consumed local hit while stale index rows reclassify the batch", async () => {
        const { chunkFiles, entriesByHead, file, files, heads, perIndexGets } =
            createPersistedManifestStreamHarness([
                new Uint8Array([1]),
                new Uint8Array([2]),
                new Uint8Array([3]),
            ]);
        (files as any).countLocalChunks = async () => file.chunkCount;
        (files as any).countLocalChunkBlocks = async () => 0;

        const indexedLookupStarted = createDeferred<void>();
        const indexedLookupGate = createDeferred<void>();
        let searchCalls = 0;
        (files.files.index as any).search = vi.fn(async () => {
            searchCalls += 1;
            if (searchCalls === 1) {
                return [chunkFiles[0]];
            }
            indexedLookupStarted.resolve();
            await indexedLookupGate.promise;
            return [];
        });

        const requestedHeadBatches: string[][] = [];
        const getMany = vi.fn(
            async (requestedHeads: string[], options: any): Promise<any[]> => {
                requestedHeadBatches.push(requestedHeads);
                if (options.remote === false) {
                    return requestedHeads.map(() => undefined);
                }
                return requestedHeads.map((head) => entriesByHead.get(head));
            }
        );
        (files.files.log.log as any).getMany = getMany;
        (files.files.log.log as any).get = async (head: string) =>
            entriesByHead.get(head);

        const iterator = file.streamFile(files)[Symbol.asyncIterator]();
        const firstRead = iterator.next();
        try {
            await indexedLookupStarted.promise;
            expect(await firstRead).toEqual({
                done: false,
                value: new Uint8Array([1]),
            });
            expect(getMany).not.toHaveBeenCalled();

            indexedLookupGate.resolve();
            expect(await iterator.next()).toEqual({
                done: false,
                value: new Uint8Array([2]),
            });
            expect(await iterator.next()).toEqual({
                done: false,
                value: new Uint8Array([3]),
            });
            expect(await iterator.next()).toEqual({
                done: true,
                value: undefined,
            });

            expect(requestedHeadBatches.flat()).not.toContain(heads[0]);
            expect(
                requestedHeadBatches.flat().filter((head) => head === heads[1])
            ).toHaveLength(2);
            expect(
                requestedHeadBatches.flat().filter((head) => head === heads[2])
            ).toHaveLength(2);
            expect(perIndexGets).toEqual([]);
            const diagnostics = files.lastReadDiagnostics!;
            expect(diagnostics.chunkBatchRemoteReclassificationCount).toBe(1);
            expect(diagnostics.chunkPersistedRemoteBatchSkippedIndexCount).toBe(
                0
            );
            expect(diagnostics.chunkManifestHeadBatchMissingCount).toBe(0);
            expect(diagnostics.activeManifestHeadBatches).toBe(0);
            expect(diagnostics.finalKnownChunkCount).toBe(0);
            expect(files.getActiveTransfers()).toEqual([]);
            expect((files as any).activeFileChangeSignals.size).toBe(0);
        } finally {
            indexedLookupGate.resolve();
            await iterator.return?.();
        }
    });

    it("keeps optimistic deferred-hit counters source-correct during reclassification", async () => {
        const chunks = Array.from(
            { length: 12 },
            (_, index) => new Uint8Array([index + 1])
        );
        const { entriesByHead, fallbackIndices, file, files, heads } =
            createPersistedManifestStreamHarness(chunks);
        for (let index = 0; index < file.chunkCount; index++) {
            fallbackIndices.add(index);
        }
        (files as any).countLocalChunks = async () => file.chunkCount;
        (files as any).countLocalChunkBlocks = async () => file.chunkCount;

        const requestedChunkIds: string[][] = [];
        (files.files.index as any).search = vi.fn(
            async (request: any): Promise<any[]> => {
                requestedChunkIds.push(
                    request.query.flatMap((query: any) =>
                        (query.or ?? [query]).map(
                            (candidate: any) => candidate.value
                        )
                    )
                );
                return [];
            }
        );
        const getMany = vi.fn(
            async (requestedHeads: string[], options: any): Promise<any[]> => {
                if (options.remote === false) {
                    return requestedHeads.map((head) =>
                        head === heads[3] ? undefined : entriesByHead.get(head)
                    );
                }
                return requestedHeads.map((head) => entriesByHead.get(head));
            }
        );
        (files.files.log.log as any).getMany = getMany;

        expect(await file.getFile(files, { as: "joined" })).toEqual(
            concat(chunks)
        );

        expect(requestedChunkIds.flat()).toEqual([`${file.id}:3`]);
        expect(getMany).toHaveBeenCalled();
        const diagnostics = files.lastReadDiagnostics!;
        expect(diagnostics.chunkBatchRemoteReclassificationCount).toBe(1);
        expect(diagnostics.chunkBatchResultCount).toBe(0);
        expect(diagnostics.prefetchedChunkCount).toBe(file.chunkCount);
        expect(diagnostics.chunkPersistedRemoteBatchSkippedIndexCount).toBe(0);
        expect(diagnostics.chunkManifestHeadBatchMissingCount).toBe(1);
        expect(diagnostics.chunkManifestHeadBatchPartialCount).toBe(1);
        expect(diagnostics.activeManifestHeadBatches).toBe(0);
        expect(diagnostics.finalKnownChunkCount).toBe(0);
        expect(files.getActiveTransfers()).toEqual([]);
        expect((files as any).activeFileChangeSignals.size).toBe(0);
    });

    it("aborts a pending remote manifest-head batch and releases listeners when the stream closes", async () => {
        const { entriesByHead, file, files, heads, perIndexGets } =
            createPersistedManifestStreamHarness([
                new Uint8Array([1]),
                new Uint8Array([2]),
                new Uint8Array([3]),
                new Uint8Array([4]),
                new Uint8Array([5]),
                new Uint8Array([6]),
                new Uint8Array([7]),
                new Uint8Array([8]),
                new Uint8Array([9]),
                new Uint8Array([10]),
            ]);
        let remoteSignal: AbortSignal | undefined;
        let remoteAborted = false;
        let markRemoteStarted!: () => void;
        const remoteStarted = new Promise<void>((resolve) => {
            markRemoteStarted = resolve;
        });
        const getMany = vi.fn(
            async (requestedHeads: string[], options: any): Promise<any[]> => {
                if (options.remote === false) {
                    if (requestedHeads.includes(heads[0]!)) {
                        return requestedHeads.map((head) =>
                            entriesByHead.get(head)
                        );
                    }
                    return requestedHeads.map(() => undefined);
                }

                remoteSignal = options.remote.signal;
                markRemoteStarted();
                return await new Promise<any[]>((_, reject) => {
                    const abort = () => {
                        remoteAborted = true;
                        reject(
                            remoteSignal?.reason ??
                                new Error("manifest-head batch aborted")
                        );
                    };
                    if (remoteSignal?.aborted) {
                        abort();
                    } else {
                        remoteSignal?.addEventListener("abort", abort, {
                            once: true,
                        });
                    }
                });
            }
        );
        (files.files.log.log as any).getMany = getMany;

        const controller = new AbortController();
        const iterator = file
            .streamFile(files, { signal: controller.signal })
            [Symbol.asyncIterator]();
        try {
            const first = await iterator.next();
            expect(first).toEqual({ done: false, value: new Uint8Array([1]) });
            // The first pessimistically bounded window can start the next
            // remote manifest lookup while its accepted chunk is suspended.
            await Promise.race([
                remoteStarted,
                new Promise((_, reject) =>
                    setTimeout(
                        () =>
                            reject(
                                new Error("remote head batch did not start")
                            ),
                        1_000
                    )
                ),
            ]);

            const returnStartedAt = Date.now();
            controller.abort(new Error("cancel pending remote read"));
            await iterator.return?.();
            expect(Date.now() - returnStartedAt).toBeLessThan(500);
            expect(remoteSignal).toBeInstanceOf(AbortSignal);
            expect(remoteSignal?.aborted).toBe(true);
            expect(remoteAborted).toBe(true);
            expect((files as any).activeFileChangeSignals.size).toBe(0);
            expect(perIndexGets).toEqual([]);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(files.lastReadDiagnostics?.activeManifestHeadBatches).toBe(
                0
            );
            expect(files.lastReadDiagnostics?.finalKnownChunkCount).toBe(0);
        } finally {
            await iterator.return?.();
        }
    });

    it("caps slow fallbacks to one lookup-round budget and rotates strategy", async () => {
        let now = 10_000;
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
        const files = new Files();
        const file = new LargeFile({
            id: "round-budget",
            name: "round-budget.bin",
            size: 512n * 1024n,
            chunkCount: 1,
            ready: true,
        });
        (file as any).chunkEntryHeads = ["round-budget-head"];
        const chunk = new TinyFile({
            id: `${file.id}:0`,
            name: `${file.name}/0`,
            file: new Uint8Array([1]),
            parentId: file.id,
            index: 0,
        });
        const operations: string[] = [];
        let waits = 0;
        (files as any).getReadPeerHints = async () => ["writer"];
        (files.files.log.log as any).get = async (
            _head: string,
            options: { remote: { timeout: number } }
        ) => {
            operations.push(`manifest:${options.remote.timeout}`);
            now += options.remote.timeout;
            return undefined;
        };
        (files.files.index as any).get = async (
            _id: string,
            options: { remote: false | { timeout: number } }
        ) => {
            if (options.remote === false) {
                return undefined;
            }
            operations.push(`direct:${options.remote.timeout}`);
            now += 25;
            return chunk;
        };
        (files.files.index as any).search = async () => {
            throw new Error("indexed fallback should not run");
        };
        const signal = createLookupSignal(() => {
            waits += 1;
        });
        const debug: Record<string, any> = {};

        try {
            expect(await resolveSingleChunk(file, files, signal, debug)).toBe(
                chunk
            );
        } finally {
            nowSpy.mockRestore();
        }

        expect(operations).toEqual(["manifest:5000", "direct:5000"]);
        expect(waits).toBe(1);
        expect(debug.chunkAttempts[0]).toBe(2);
        expect(now - 10_000).toBe(5_025);
    });

    it("rechecks local state after a slow round before another remote lookup", async () => {
        let now = 20_000;
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
        const files = new Files();
        const file = new LargeFile({
            id: "round-event",
            name: "round-event.bin",
            size: 512n * 1024n,
            chunkCount: 1,
            ready: true,
        });
        (file as any).chunkEntryHeads = ["round-event-head"];
        const chunk = new TinyFile({
            id: `${file.id}:0`,
            name: `${file.name}/0`,
            file: new Uint8Array([2]),
            parentId: file.id,
            index: 0,
        });
        let localAvailable = false;
        let remoteCalls = 0;
        (files as any).getReadPeerHints = async () => ["writer"];
        (files.files.log.log as any).get = async (
            _head: string,
            options: { remote: { timeout: number } }
        ) => {
            remoteCalls += 1;
            now += options.remote.timeout;
            return undefined;
        };
        (files.files.index as any).get = async (
            _id: string,
            options: { remote: false | { timeout: number } }
        ) => {
            if (options.remote === false) {
                return localAvailable ? chunk : undefined;
            }
            throw new Error("remote get should not run after local recovery");
        };
        const signal = createLookupSignal(() => {
            localAvailable = true;
        });
        const debug: Record<string, any> = {};

        try {
            expect(await resolveSingleChunk(file, files, signal, debug)).toBe(
                chunk
            );
        } finally {
            nowSpy.mockRestore();
        }

        expect(remoteCalls).toBe(1);
        expect(debug.chunkAttempts[0]).toBe(2);
        expect(debug.chunkResolved[0]).toBe("local");
    });

    it("rotates from a slow deterministic miss to legacy indexed fields", async () => {
        let now = 30_000;
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
        const files = new Files();
        const file = new LargeFile({
            id: "legacy-round",
            name: "legacy-round.bin",
            size: 512n * 1024n,
            chunkCount: 1,
            ready: true,
        });
        const chunk = new TinyFile({
            id: "legacy-random-id",
            name: `${file.name}/0`,
            file: new Uint8Array([3]),
            parentId: file.id,
            index: 0,
        });
        const operations: string[] = [];
        (files as any).getReadPeerHints = async () => ["writer"];
        (files.files.log.log as any).get = async () => {
            throw new Error("a headless legacy file must not fetch a head");
        };
        (files.files.index as any).get = async (
            _id: string,
            options: { remote: false | { timeout: number } }
        ) => {
            if (options.remote === false) {
                return undefined;
            }
            operations.push(`direct:${options.remote.timeout}`);
            now += options.remote.timeout;
            return undefined;
        };
        (files.files.index as any).search = async (
            _request: unknown,
            options: {
                remote: {
                    timeout: number;
                    from?: string[];
                    replicate: boolean;
                };
            }
        ) => {
            expect(options.remote.replicate).toBe(true);
            operations.push(
                `indexed:${options.remote.from ? "hinted" : "unhinted"}:${options.remote.timeout}`
            );
            now += 25;
            return [chunk];
        };
        const signal = createLookupSignal();
        const debug: Record<string, any> = {};

        try {
            expect(await resolveSingleChunk(file, files, signal, debug)).toBe(
                chunk
            );
        } finally {
            nowSpy.mockRestore();
        }

        expect(operations).toEqual(["direct:5000", "indexed:hinted:5000"]);
        expect(debug.chunkAttempts[0]).toBe(2);
        expect(debug.chunkResolved[0]).toBe("indexed-search");
    });

    it("propagates cancellation without starting the next fallback", async () => {
        const files = new Files();
        const file = new LargeFile({
            id: "cancel-round",
            name: "cancel-round.bin",
            size: 512n * 1024n,
            chunkCount: 1,
            ready: true,
        });
        (file as any).chunkEntryHeads = ["cancel-round-head"];
        const signal = createLookupSignal();
        let directCalls = 0;
        (files as any).getReadPeerHints = async () => ["writer"];
        (files.files.index as any).get = async (
            _id: string,
            options: { remote: false | object }
        ) => {
            if (options.remote === false) {
                return undefined;
            }
            directCalls += 1;
            return undefined;
        };
        (files.files.log.log as any).get = async () => {
            signal.close();
            return undefined;
        };

        await expect(
            resolveSingleChunk(file, files, signal, {})
        ).rejects.toThrow("File read cancelled");
        expect(directCalls).toBe(0);
    });

    it("checks cancellation before classifying a rejected abort error", async () => {
        const files = new Files();
        const file = new LargeFile({
            id: "cancelled-abort-round",
            name: "cancelled-abort-round.bin",
            size: 512n * 1024n,
            chunkCount: 1,
            ready: true,
        });
        (file as any).chunkEntryHeads = ["cancelled-abort-head"];
        const signal = createLookupSignal();
        const lifecycle: string[] = [];
        const originalThrowIfClosed = signal.throwIfClosed;
        signal.throwIfClosed = () => {
            lifecycle.push("throwIfClosed");
            originalThrowIfClosed();
        };
        const abortError = new Error("lookup aborted");
        Object.defineProperty(abortError, "name", {
            get: () => {
                lifecycle.push("classify");
                return "AbortError";
            },
        });
        let directCalls = 0;
        (files as any).getReadPeerHints = async () => ["writer"];
        (files.files.index as any).get = async (
            _id: string,
            options: { remote: false | object }
        ) => {
            if (options.remote === false) {
                return undefined;
            }
            directCalls += 1;
            return undefined;
        };
        (files.files.log.log as any).get = async () => {
            lifecycle.length = 0;
            signal.close();
            throw abortError;
        };

        await expect(
            resolveSingleChunk(file, files, signal, {})
        ).rejects.toThrow("File read cancelled");
        expect(lifecycle).toEqual(["throwIfClosed"]);
        expect(directCalls).toBe(0);
    });

    it.each([
        [
            "nested aggregate",
            new AggregateError(
                [
                    Object.assign(new Error("delivery failed"), {
                        name: "DeliveryError",
                    }),
                    Object.assign(new Error("fanout channel closed"), {
                        name: "AbortError",
                    }),
                ],
                "All promises were rejected"
            ),
        ],
        [
            "empty aggregate",
            new AggregateError([], "All promises were rejected"),
        ],
        [
            "timeout",
            Object.assign(new Error("request timed out"), {
                name: "TimeoutError",
            }),
        ],
        [
            "not found name",
            Object.assign(new Error("entry not found"), {
                name: "NotFoundError",
            }),
        ],
        [
            "not found code",
            Object.assign(new Error("entry not found"), {
                code: "ERR_NOT_FOUND",
            }),
        ],
    ])("retries a %s remote lookup failure", async (_label, retryableError) => {
        const files = new Files();
        const file = new LargeFile({
            id: "aggregate-retry-round",
            name: "aggregate-retry-round.bin",
            size: 1n,
            chunkCount: 1,
            ready: true,
        });
        const chunk = new TinyFile({
            id: `${file.id}:0`,
            name: `${file.name}/0`,
            file: new Uint8Array([7]),
            parentId: file.id,
            index: 0,
        });
        let indexedSearchCalls = 0;
        (files as any).getReadPeerHints = async () => ["writer"];
        (files.files.index as any).get = async (
            _id: string,
            options: { remote: false | object }
        ) => {
            if (options.remote === false) {
                return undefined;
            }
            throw retryableError;
        };
        (files.files.index as any).search = async () => {
            indexedSearchCalls += 1;
            return [chunk];
        };

        await expect(
            resolveSingleChunk(file, files, createLookupSignal(), {})
        ).resolves.toBe(chunk);
        expect(indexedSearchCalls).toBe(1);
    });

    it("does not retry a mixed aggregate containing a validation failure", async () => {
        const files = new Files();
        const file = new LargeFile({
            id: "mixed-aggregate-round",
            name: "mixed-aggregate-round.bin",
            size: 1n,
            chunkCount: 1,
            ready: true,
        });
        const mixed = new AggregateError(
            [
                Object.assign(new Error("request timed out"), {
                    name: "TimeoutError",
                }),
                new Error("invalid signed chunk payload"),
            ],
            "All promises were rejected"
        );
        const indexedSearch = vi.fn(async () => []);
        (files as any).getReadPeerHints = async () => ["writer"];
        (files.files.index as any).get = async (
            _id: string,
            options: { remote: false | object }
        ) => {
            if (options.remote === false) {
                return undefined;
            }
            throw mixed;
        };
        (files.files.index as any).search = indexedSearch;

        await expect(
            resolveSingleChunk(file, files, createLookupSignal(), {})
        ).rejects.toBe(mixed);
        expect(indexedSearch).not.toHaveBeenCalled();
    });

    it("shares one deadline between pending-manifest search and direct get", async () => {
        const startedAt = 40_000;
        vi.useFakeTimers({ now: startedAt });
        const files = new Files();
        const pending = new LargeFile({
            id: "pending-deadline",
            name: "pending-deadline.bin",
            size: 512n * 1024n,
            chunkCount: 1,
            ready: false,
        });
        const ready = new LargeFile({
            id: pending.id,
            name: pending.name,
            size: pending.size,
            chunkCount: pending.chunkCount,
            ready: true,
        });
        (ready as any).chunkEntryHeads = ["pending-deadline-head"];
        const operations: Array<{ operation: string; timeout: number }> = [];
        const signal = createLookupSignal();
        (files as any).getReadPeerHints = async () => ["writer"];
        (files.files.index as any).search = async (
            _request: unknown,
            options: { remote: false | { timeout: number } }
        ) => {
            if (options.remote === false) {
                return [];
            }
            operations.push({
                operation: "search",
                timeout: options.remote.timeout,
            });
            vi.advanceTimersByTime(4_000);
            return [];
        };
        (files.files.index as any).get = async (
            _id: string,
            options: { remote: { timeout: number } }
        ) => {
            operations.push({
                operation: "get",
                timeout: options.remote.timeout,
            });
            return ready;
        };

        const diagnostics = { waitUntilReadyAttempts: 0 };
        const owner = new FairTransferOwner(
            new FairTransferScheduler(8, 16 * 1024 * 1024),
            "pending-deadline",
            signal.abortSignal
        );
        try {
            expect(
                await (pending as any).waitUntilReadyWithSignal(
                    files,
                    signal,
                    {
                        timeout: 30_000,
                        persist: true,
                        owner,
                    },
                    diagnostics
                )
            ).toBe(ready);
        } finally {
            owner.finish();
            vi.useRealTimers();
        }

        expect(operations).toEqual([
            { operation: "search", timeout: 5_000 },
            { operation: "get", timeout: 1_000 },
        ]);
        expect(diagnostics.waitUntilReadyAttempts).toBe(1);
    });

    it("releases only the retained state associated with a deleted file", () => {
        const files = new Files();
        files.retainChunkRead("deleted:0");
        files.retainChunkRead("kept:0");
        files.retainChunkEntryHead("deleted-head", "deleted");
        files.retainChunkEntryHead("kept-head", "kept");

        files.releaseLargeFileRetention({ id: "deleted", chunkCount: 1 });

        expect((files as any).retainedChunkIds).toEqual(new Set(["kept:0"]));
        expect((files as any).retainedChunkEntryHeads).toEqual(
            new Set(["kept-head"])
        );
    });

    it("tracks huge claimed files in constant space and releases only seen ids", () => {
        const files = new Files();
        class GuardedSet extends Set<string> {
            addCalls = 0;
            deleteCalls = 0;

            add(value: string) {
                this.addCalls += 1;
                if (this.addCalls > 2) {
                    throw new Error("retention expanded claimed chunkCount");
                }
                return super.add(value);
            }

            delete(value: string) {
                this.deleteCalls += 1;
                if (this.deleteCalls > 2) {
                    throw new Error("release looped over claimed chunkCount");
                }
                return super.delete(value);
            }
        }
        const retainedIds = new GuardedSet();
        (files as any).retainedChunkIds = retainedIds;
        const file = new LargeFile({
            id: "untrusted-huge",
            name: "untrusted-huge.bin",
            size: 1n,
            chunkCount: 0xffffffff,
            ready: true,
        });

        files.retainFileRead(file);
        expect(retainedIds.addCalls).toBe(0);
        expect((files as any).retainedLargeFileChunkCounts.get(file.id)).toBe(
            file.chunkCount
        );

        files.retainChunkRead(`${file.id}:0`, file.id);
        files.retainChunkRead("legacy-actual-id", file.id);
        files.releaseLargeFileRetention(file);

        expect(retainedIds.addCalls).toBe(2);
        expect(retainedIds.deleteCalls).toBe(2);
        expect(retainedIds.size).toBe(0);
        expect((files as any).retainedLargeFileChunkCounts.size).toBe(0);
        expect((files as any).retainedChunkIdsByFileId.size).toBe(0);
    });

    it("keeps TinyFile.delete as a no-op compatibility API", async () => {
        const files = new Files();
        const file = new TinyFile({
            id: "retained-tiny-root",
            name: "retained-tiny-root.bin",
            file: new Uint8Array([1]),
        });
        files.retainChunkEntryHead("retained-tiny-head", file.id);

        await file.delete();

        expect((files as any).retainedChunkEntryHeads).toEqual(
            new Set(["retained-tiny-head"])
        );
    });

    it("commits a tiny root deletion before releasing its retention", async () => {
        const files = new Files();
        const file = new TinyFile({
            id: "transactional-tiny-root",
            name: "transactional-tiny-root.bin",
            file: new Uint8Array([1]),
        });
        files.retainChunkEntryHead("transactional-tiny-head", file.id, file.id);
        (files.files.index as any).get = async () => file;
        let deleteCommitted = false;
        (files.files as any).del = async () => {
            expect((files as any).retainedChunkEntryHeads).toContain(
                "transactional-tiny-head"
            );
            deleteCommitted = true;
        };

        await files.removeById(file.id);

        expect(deleteCommitted).toBe(true);
        expect((files as any).retainedChunkEntryHeads.size).toBe(0);
    });

    it("rejects an unknown remote deletion when no read peer is available", async () => {
        const files = new Files();
        (files.files.index as any).get = async () => undefined;
        (files as any).getReadPeerHints = async () => undefined;

        await expect(files.removeById("unknown-remote-root")).rejects.toThrow(
            "no remote read peers are available"
        );
    });

    it("propagates incomplete exact remote deletion confirmation", async () => {
        const files = new Files();
        (files.files.index as any).get = async () => undefined;
        (files as any).getReadPeerHints = async () => ["writer-peer"];
        (files.files.index as any).search = async (
            _request: unknown,
            options: any
        ) => {
            expect(options.remote.throwOnMissing).toBe(true);
            throw new Error("missing selected peer response");
        };

        await expect(
            files.removeById("unconfirmed-remote-root")
        ).rejects.toThrow("missing selected peer response");
    });

    it("accepts an all-peer exact miss as an already-absent deletion", async () => {
        const files = new Files();
        (files.files.index as any).get = async () => undefined;
        (files as any).getReadPeerHints = async () => ["writer-peer"];
        (files.files.index as any).search = async () => [];

        await expect(
            files.removeById("confirmed-absent-remote-root")
        ).resolves.toBeUndefined();
    });

    it("rejects when a confirmed remote root is not materialized locally", async () => {
        const files = new Files();
        const remoteRoot = new TinyFile({
            id: "unmaterialized-remote-root",
            name: "unmaterialized-remote-root.bin",
            file: new Uint8Array([1]),
        });
        (files.files.index as any).get = async () => undefined;
        (files as any).getReadPeerHints = async () => ["writer-peer"];
        (files.files.index as any).search = async () => [remoteRoot];

        await expect(files.removeById(remoteRoot.id)).rejects.toThrow(
            "Failed to materialize current remote file"
        );
    });

    it("preserves root retention when the target deletion fails", async () => {
        const files = new Files();
        const file = new LargeFile({
            id: "failed-root-transaction",
            name: "failed-root-transaction.bin",
            size: 1n,
            chunkCount: 1,
            ready: true,
        });
        files.retainFileRead(file);
        files.retainChunkRead(`${file.id}:0`, file.id);
        files.retainChunkEntryHead("failed-root-head", file.id, file.id);
        (files.files.index as any).get = async () => file;
        (files.files as any).del = async () => {
            throw new Error("root delete failed");
        };
        const fetchChunks = vi.spyOn(file, "fetchChunks").mockResolvedValue([]);

        await expect(files.removeById(file.id)).rejects.toThrow(
            "root delete failed"
        );

        expect(fetchChunks).not.toHaveBeenCalled();
        expect((files as any).retainedLargeFileChunkCounts.get(file.id)).toBe(
            1
        );
        expect((files as any).retainedChunkIds).toContain(`${file.id}:0`);
        expect((files as any).retainedChunkEntryHeads).toContain(
            "failed-root-head"
        );
    });

    it("finishes cleanup when a rejected root deletion committed locally", async () => {
        const files = new Files();
        const file = withHead(
            new LargeFile({
                id: "postcommit-root-transaction",
                name: "postcommit-root-transaction.bin",
                size: 1n,
                chunkCount: 1,
                ready: true,
            }),
            "postcommit-root-head"
        );
        let current: LargeFile | undefined = file;
        (files.files.index as any).get = async () => current;
        (files.files as any).del = async () => {
            current = undefined;
            throw new Error("delivery failed after local delete");
        };
        vi.spyOn(file, "fetchChunks").mockResolvedValue([]);
        files.retainFileRead(file);
        files.retainChunkRead(`${file.id}:0`, file.id);
        files.retainChunkEntryHead("postcommit-root-head", file.id, file.id);

        await files.removeById(file.id);

        expect((files as any).retainedLargeFileChunkCounts.size).toBe(0);
        expect((files as any).retainedChunkIds.size).toBe(0);
        expect((files as any).retainedChunkEntryHeads.size).toBe(0);
    });

    it("does not clean a concurrent replacement after a rejected deletion", async () => {
        const files = new Files();
        const target = withHead(
            new LargeFile({
                id: "replaced-root-transaction",
                name: "old-root.bin",
                size: 1n,
                chunkCount: 1,
                ready: true,
            }),
            "old-root-head"
        );
        const replacement = withHead(
            new LargeFile({
                id: target.id,
                name: "replacement-root.bin",
                size: 2n,
                chunkCount: 2,
                ready: true,
            }),
            "replacement-root-head"
        );
        let current: LargeFile = target;
        (files.files.index as any).get = async () => current;
        (files.files as any).del = async () => {
            current = replacement;
            throw new Error("delivery failed while replacement won");
        };
        const fetchChunks = vi
            .spyOn(target, "fetchChunks")
            .mockResolvedValue([]);
        files.retainFileRead(target);
        files.retainChunkRead(`${target.id}:0`, target.id);
        files.retainChunkEntryHead("old-root-head", target.id, target.id);

        await expect(files.removeById(target.id)).rejects.toThrow(
            "delivery failed while replacement won"
        );

        expect(fetchChunks).not.toHaveBeenCalled();
        expect((files as any).retainedLargeFileChunkCounts.get(target.id)).toBe(
            1
        );
        expect((files as any).retainedChunkIds).toContain(`${target.id}:0`);
        expect((files as any).retainedChunkEntryHeads).toContain(
            "old-root-head"
        );
    });

    it("allows a current hash to acquire new ownership after release", () => {
        const files = new Files();
        files.retainChunkEntryHead("released-head", "first", "first:0");

        files.releaseChunkRetention("first", "first:0", "released-head");
        files.retainChunkEntryHead("released-head", "second", "second:0");

        expect((files as any).retainedChunkEntryHeads).toContain(
            "released-head"
        );
        expect(
            (files as any).retainedChunkEntryHeadOwners
                .get("released-head")
                .has("second")
        ).toBe(true);
    });

    it("validates retained heads against the current local document head", async () => {
        const files = new Files();
        const currentByDocument = new Map<string, string | Error>([
            ["current-doc", "current-head"],
            ["stale-doc", "replacement-head"],
            ["unknown-doc", new Error("local index unavailable")],
        ]);
        (files.files.index as any).get = async (documentId: string) => {
            const result = currentByDocument.get(documentId);
            if (result instanceof Error) {
                throw result;
            }
            return result ? { __context: { head: result } } : undefined;
        };
        files.retainChunkEntryHead(
            "current-head",
            "current-group",
            "current-doc"
        );
        files.retainChunkEntryHead("stale-head", "stale-group", "stale-doc");
        // A legacy unscoped retain must not override a known stale document.
        files.retainChunkEntryHead("stale-head");
        files.retainChunkEntryHead(
            "unknown-head",
            "unknown-group",
            "unknown-doc"
        );

        expect(
            await (files as any).shouldKeepFileEntry({ hash: "current-head" })
        ).toBe(true);
        expect(
            await (files as any).shouldKeepFileEntry({ hash: "unknown-head" })
        ).toBe(true);
        expect(
            await (files as any).shouldKeepFileEntry({ hash: "stale-head" })
        ).toBe(false);
        expect((files as any).retainedChunkEntryHeads).not.toContain(
            "stale-head"
        );
        expect((files as any).unscopedRetainedChunkEntryHeads).not.toContain(
            "stale-head"
        );
    });

    it("rebuilds child retention when a current child is evaluated before its parent", async () => {
        const files = new Files();
        const parent = withHead(
            new LargeFile({
                id: "child-first-parent",
                name: "child-first-parent.bin",
                size: 1n,
                chunkCount: 1,
                ready: true,
            }),
            "child-first-parent-head"
        );
        const child = withHead(
            new TinyFile({
                id: `${parent.id}:0`,
                name: `${parent.name}/0`,
                file: new Uint8Array([1]),
                parentId: parent.id,
                index: 0,
            }),
            "child-first-head"
        );
        (files.files.index as any).get = async (id: string) =>
            id === child.id ? child : id === parent.id ? parent : undefined;
        Object.defineProperty(files.files.index, "valueEncoding", {
            configurable: true,
            value: { decoder: () => child },
        });

        expect(
            await (files as any).shouldKeepFileEntry(
                createPutEntry(child, "child-first-head")
            )
        ).toBe(true);
        expect((files as any).retainedLargeFileChunkCounts.get(parent.id)).toBe(
            1
        );
        expect((files as any).retainedChunkIds).toContain(child.id);
        expect((files as any).retainedChunkEntryHeads).toContain(
            "child-first-head"
        );
    });

    it("keeps a current persisted child while its parent lookup fails transiently", async () => {
        const files = new Files();
        const parentId = "transient-parent-lookup";
        const child = withHead(
            new TinyFile({
                id: `${parentId}:0`,
                name: "transient-parent-lookup.bin/0",
                file: new Uint8Array([1]),
                parentId,
                index: 0,
            }),
            "transient-parent-child-head"
        );
        (files.files.index as any).get = async (id: string) => {
            if (id === child.id) {
                return child;
            }
            if (id === parentId) {
                throw new Error("parent index temporarily unavailable");
            }
            return undefined;
        };
        Object.defineProperty(files.files.index, "valueEncoding", {
            configurable: true,
            value: { decoder: () => child },
        });

        expect(
            await (files as any).shouldKeepFileEntry(
                createPutEntry(child, "transient-parent-child-head")
            )
        ).toBe(true);
    });

    it("invalidates retained children after their parent is deleted or replaced", async () => {
        for (const replacement of [
            undefined,
            new LargeFile({
                id: "invalidated-parent",
                name: "replacement-name.bin",
                size: 1n,
                chunkCount: 1,
                ready: true,
            }),
        ]) {
            const files = new Files();
            const parent = new LargeFile({
                id: "invalidated-parent",
                name: "original-name.bin",
                size: 1n,
                chunkCount: 1,
                ready: true,
            });
            const child = withHead(
                new TinyFile({
                    id: `${parent.id}:0`,
                    name: `${parent.name}/0`,
                    file: new Uint8Array([1]),
                    parentId: parent.id,
                    index: 0,
                }),
                "invalidated-child-head"
            );
            let currentParent: LargeFile | undefined = parent;
            (files.files.index as any).get = async (id: string) =>
                id === child.id
                    ? child
                    : id === parent.id
                      ? currentParent
                      : undefined;
            Object.defineProperty(files.files.index, "valueEncoding", {
                configurable: true,
                value: { decoder: () => child },
            });
            const entry = createPutEntry(child, "invalidated-child-head");
            expect(await (files as any).shouldKeepFileEntry(entry)).toBe(true);

            currentParent = replacement;

            expect(await (files as any).shouldKeepFileEntry(entry)).toBe(false);
            expect(
                (files as any).retainedLargeFileChunkCounts.has(parent.id)
            ).toBe(false);
            expect((files as any).retainedChunkIds).not.toContain(child.id);
            expect((files as any).retainedChunkEntryHeads).not.toContain(
                "invalidated-child-head"
            );
        }
    });

    it("rebuilds retention for a current legacy non-deterministic chunk id", async () => {
        const files = new Files();
        const parent = new LargeFile({
            id: "legacy-parent",
            name: "legacy-parent.bin",
            size: 1n,
            chunkCount: 1,
            ready: true,
        });
        const child = withHead(
            new TinyFile({
                id: "legacy-random-chunk-id",
                name: `${parent.name}/0`,
                file: new Uint8Array([1]),
                parentId: parent.id,
                index: 0,
            }),
            "legacy-child-head"
        );
        (files.files.index as any).get = async (id: string) =>
            id === child.id ? child : id === parent.id ? parent : undefined;
        Object.defineProperty(files.files.index, "valueEncoding", {
            configurable: true,
            value: { decoder: () => child },
        });

        expect(
            await (files as any).shouldKeepFileEntry(
                createPutEntry(child, "legacy-child-head")
            )
        ).toBe(true);
        expect((files as any).retainedChunkIds).toContain(child.id);
        expect(
            (files as any).retainedEntryHeadsByDocumentId.get(child.id)
        ).toEqual(new Set(["legacy-child-head"]));
    });

    it("keeps shared and foreign-owned heads when another file releases", () => {
        const files = new Files();
        files.retainChunkEntryHead("shared-head", "first-file", "first-file:0");
        files.retainChunkEntryHead(
            "shared-head",
            "second-file",
            "second-file:0"
        );
        files.retainChunkEntryHead(
            "foreign-head",
            "foreign-file",
            "foreign-file:0"
        );

        files.releaseLargeFileRetention({
            id: "first-file",
            chunkCount: 0xffffffff,
            chunkEntryHeads: ["shared-head", "foreign-head"],
        });

        expect((files as any).retainedChunkEntryHeads).toContain("shared-head");
        expect((files as any).retainedChunkEntryHeads).toContain(
            "foreign-head"
        );
        expect(
            (files as any).retainedChunkEntryHeadOwners
                .get("shared-head")
                .has("second-file")
        ).toBe(true);

        files.releaseLargeFileRetention({
            id: "second-file",
            chunkCount: 0xffffffff,
        });
        expect((files as any).retainedChunkEntryHeads).not.toContain(
            "shared-head"
        );
        expect((files as any).retainedChunkEntryHeads).toContain(
            "foreign-head"
        );
    });

    it("releases only the deleted child document within its retained group", async () => {
        const files = new Files();
        const parent = new LargeFile({
            id: "direct-child-parent",
            name: "direct-child-parent.bin",
            size: 2n,
            chunkCount: 2,
            ready: true,
        });
        const first = new TinyFile({
            id: `${parent.id}:0`,
            name: `${parent.name}/0`,
            file: new Uint8Array([1]),
            parentId: parent.id,
            index: 0,
        });
        const second = new TinyFile({
            id: `${parent.id}:1`,
            name: `${parent.name}/1`,
            file: new Uint8Array([2]),
            parentId: parent.id,
            index: 1,
        });
        Object.defineProperty(first, "__context", {
            value: { head: "first-child-head" },
        });
        files.retainFileRead(parent);
        files.retainChunkRead(first.id, parent.id);
        files.retainChunkRead(second.id, parent.id);
        files.retainChunkEntryHead("first-child-head", parent.id, first.id);
        files.retainChunkEntryHead("second-child-head", parent.id, second.id);

        (files.files.index as any).get = async () => first;
        (files.files as any).del = async () => undefined;
        await files.removeById(first.id);

        expect((files as any).retainedLargeFileChunkCounts.get(parent.id)).toBe(
            2
        );
        expect((files as any).retainedChunkIds).toEqual(new Set([second.id]));
        expect((files as any).retainedChunkEntryHeads).toEqual(
            new Set(["second-child-head"])
        );
    });

    it("retires the pending root head without releasing its ready replacement", () => {
        const files = new Files();
        const root = new LargeFile({
            id: "pending-ready-root",
            name: "pending-ready-root.bin",
            size: 1n,
            chunkCount: 1,
            ready: false,
        });
        files.retainChunkEntryHead("pending-root-head", root.id, root.id);
        files.retainChunkEntryHead("ready-root-head", root.id, root.id);

        (files as any).retireAuthoredFileEntry(root, "pending-root-head");

        expect((files as any).retainedChunkEntryHeads).toEqual(
            new Set(["ready-root-head"])
        );
    });

    it("does not release retention from the public LargeFile.delete cleanup API", async () => {
        const files = new Files();
        const file = new LargeFile({
            id: "failed-delete",
            name: "failed-delete.bin",
            size: 1n,
            chunkCount: 0xffffffff,
            ready: true,
        });
        files.retainFileRead(file);
        files.retainChunkRead("failed-delete-legacy", file.id);
        files.retainChunkEntryHead("failed-delete-head", file.id);
        file.fetchChunks = async () => {
            throw new Error("fetch failed");
        };

        await expect(file.delete(files)).rejects.toThrow("fetch failed");

        expect((files as any).retainedLargeFileChunkCounts.get(file.id)).toBe(
            file.chunkCount
        );
        expect((files as any).retainedChunkIds).toContain(
            "failed-delete-legacy"
        );
        expect((files as any).retainedChunkEntryHeads).toContain(
            "failed-delete-head"
        );
    });

    it("preserves root retention until orphan cleanup retry succeeds", async () => {
        const files = new Files();
        const file = new LargeFile({
            id: "failed-orphan-cleanup",
            name: "failed-orphan-cleanup.bin",
            size: 1n,
            chunkCount: 0xffffffff,
            ready: true,
        });
        files.retainFileRead(file);
        files.retainChunkRead("failed-orphan-cleanup-legacy", file.id);
        files.retainChunkEntryHead("failed-orphan-cleanup-head", file.id);
        (files.files.index as any).get = async () => file;
        let rootDeleted = false;
        (files.files as any).del = async () => {
            rootDeleted = true;
        };
        const fetchChunks = vi
            .spyOn(file, "fetchChunks")
            .mockImplementation(async () => {
                expect(rootDeleted).toBe(true);
                throw new Error("fetch failed");
            });

        await expect(files.removeById(file.id)).rejects.toThrow("fetch failed");

        expect(rootDeleted).toBe(true);
        expect((files as any).retainedLargeFileChunkCounts.get(file.id)).toBe(
            file.chunkCount
        );
        expect((files as any).retainedChunkIds).toContain(
            "failed-orphan-cleanup-legacy"
        );
        expect((files as any).retainedChunkEntryHeads).toContain(
            "failed-orphan-cleanup-head"
        );
        expect((files as any).pendingLargeFileDeletions.has(file.id)).toBe(
            true
        );

        fetchChunks.mockResolvedValue([]);
        await files.removeById(file.id);

        expect((files as any).retainedLargeFileChunkCounts.size).toBe(0);
        expect((files as any).retainedChunkIds.size).toBe(0);
        expect((files as any).retainedChunkEntryHeads.size).toBe(0);
        expect((files as any).retainedEntryHeadsByFileId.size).toBe(0);
        expect((files as any).pendingLargeFileDeletions.size).toBe(0);
    });

    it("releases failed-upload retention even when chunk deletion rejects", async () => {
        const files = new Files();
        const chunk = withHead(
            new TinyFile({
                id: "failed:0",
                name: "failed/0",
                file: new Uint8Array([1]),
                parentId: "failed",
                index: 0,
            }),
            "failed-head"
        );
        files.retainChunkRead(chunk.id);
        files.retainChunkEntryHead("failed-head", "failed", chunk.id);

        const originalGet = files.files.index.get.bind(files.files.index);
        const originalLogGet = files.files.log.log.get.bind(
            files.files.log.log
        );
        const originalDelete = files.files.del.bind(files.files);
        (files.files.index as any).get = async () => chunk;
        (files.files.log.log as any).get = async () => ({});
        (files.files as any).del = async () => {
            throw new Error("delete failed");
        };

        try {
            await expect(
                (files as any).cleanupChunkedUpload("failed", 1, [
                    "failed-head",
                ])
            ).rejects.toThrow("delete failed");
        } finally {
            (files.files.index as any).get = originalGet;
            (files.files.log.log as any).get = originalLogGet;
            (files.files as any).del = originalDelete;
        }

        expect((files as any).retainedChunkIds.size).toBe(0);
        expect((files as any).retainedChunkEntryHeads.size).toBe(0);
    });

    it("releases exact failed-upload heads while preserving unknown id retention", async () => {
        const files = new Files();
        files.retainChunkRead("failed-search:0");
        files.retainChunkEntryHead(
            "failed-search-head",
            "failed-search",
            "failed-search:0"
        );
        const originalGet = files.files.index.get.bind(files.files.index);
        (files.files.index as any).get = async () => {
            throw new Error("lookup failed");
        };

        try {
            await expect(
                (files as any).cleanupChunkedUpload("failed-search", 1, [
                    "failed-search-head",
                ])
            ).rejects.toThrow("lookup failed");
        } finally {
            (files.files.index as any).get = originalGet;
        }

        expect((files as any).retainedChunkIds).toContain("failed-search:0");
        expect((files as any).retainedChunkEntryHeads.size).toBe(0);
    });
});
