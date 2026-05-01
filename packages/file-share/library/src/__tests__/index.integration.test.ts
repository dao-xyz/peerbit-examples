import { Peerbit } from "peerbit";
import {
    Files,
    IndexableFile,
    LargeFile,
    LargeFileWithChunkHeads,
    TinyFile,
} from "../index.js";
import { concat, equals } from "uint8arrays";
import crypto from "crypto";
import { delay, waitForResolved } from "@peerbit/time";
import { sha256Base64Sync } from "@peerbit/crypto";
import { deserialize, serialize } from "@dao-xyz/borsh";
import { expect, describe, it, beforeEach, afterEach } from "vitest";
import { decodeReplicas } from "@peerbit/shared-log";

const getQueryKey = (query: any) =>
    Array.isArray(query?.key) ? query.key.join(".") : query?.key;

const getQueryValue = (query: any) => query?.value?.value ?? query?.value;
const stripChunkEntryHeads = (file: LargeFile | undefined) => {
    (file as any).chunkEntryHeads = undefined;
};

describe("index", () => {
    let peer: Peerbit, peer2: Peerbit;

    beforeEach(async () => {
        peer = await Peerbit.create();
        peer2 = await Peerbit.create();
        await peer.dial(peer2);
    });

    afterEach(async () => {
        await peer.stop();
        await peer2.stop();
    });

    it("tiny file", async () => {
        // Peer 1 is subscribing to a replication topic (to start helping the network)
        const filestore = await peer.open(new Files());

        const smallFile = new Uint8Array([123]);
        await filestore.add("tiny file", smallFile);
        const filestoreReader = await peer2.open<Files>(filestore.address, {
            args: { replicate: false },
        });
        await filestoreReader.files.log.waitForReplicator(
            peer.identity.publicKey
        );

        expect(
            new Uint8Array(
                (await filestoreReader.getByName("tiny file"))!.bytes
            )
        ).to.deep.eq(smallFile);

        await filestore.removeByName("tiny file");
        expect(await filestoreReader.getByName("tiny file")).to.be.undefined;
    });

    it("small file", async () => {
        // Peer 1 is subscribing to a replication topic (to start helping the network)
        const filestore = await peer.open(new Files());

        const smallFile = new Uint8Array(2 * 1e6); // 2 mb
        await filestore.add("small file", smallFile);

        const filestoreReader = await peer2.open<Files>(filestore.address, {
            args: {
                replicate: false,
            },
        });
        await filestoreReader.files.log.waitForReplicator(
            peer.identity.publicKey
        );

        const file = await filestoreReader.getByName("small file");
        expect(equals(new Uint8Array(file!.bytes), smallFile)).to.be.true;

        await filestore.removeByName("small file");
        expect(await filestoreReader.getByName("small file")).to.be.undefined;

        // TODO check that block is removed
    });

    describe("large file", () => {
        it("keeps self-signed shallow chunk entries during adaptive pruning", async () => {
            const filestore = await peer.open(new Files());
            const entryHash = "self-signed-chunk-entry";

            expect(
                await (filestore as any).shouldKeepFileEntry({
                    hash: entryHash,
                    signatures: [{ publicKey: peer.identity.publicKey }],
                })
            ).to.be.true;
        });

        it("keeps retained chunk entries by payload during adaptive pruning", async () => {
            const writer = await peer.open(new Files());
            const reader = await peer2.open<Files>(writer.address);
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileId = await writer.add(
                "retained chunk payload",
                largeFile
            );
            const retainedChunkId = `${fileId}:2`;
            const retainedChunk = await writer.files.index.get(
                retainedChunkId,
                {
                    local: true,
                    remote: false,
                }
            );
            const retainedHead = (retainedChunk as any).__context.head;
            const retainedEntry = await writer.files.log.log.get(retainedHead);
            reader.retainChunkRead(retainedChunkId);

            expect(await (reader as any).shouldKeepFileEntry(retainedEntry)).to
                .be.true;
        });

        it("does not keep unknown shallow entries by hash alone during adaptive pruning", async () => {
            const filestore = await peer.open(new Files());
            const originalGet = filestore.files.log.log.get.bind(
                filestore.files.log.log
            );

            (filestore.files.log.log as any).get = async () => undefined;

            try {
                expect(
                    await (filestore as any).shouldKeepFileEntry({
                        hash: "unresolved-entry",
                    })
                ).to.be.false;
            } finally {
                (filestore.files.log.log as any).get = originalGet;
            }
        });

        it("uses adaptive replication settings for root manifests and chunks", async () => {
            const writer = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileId = await writer.add(
                "adaptively replicated root",
                largeFile
            );
            const indexedRoot = await writer.files.index.get(fileId, {
                resolve: false,
                local: true,
                remote: false,
            } as any);
            const rootHead = (indexedRoot as any).__context.head;
            const shallowRoot = await writer.files.log.log.getShallow(rootHead);
            const indexedChunk = await writer.files.index.get(`${fileId}:0`, {
                resolve: false,
                local: true,
                remote: false,
            } as any);
            const chunkHead = (indexedChunk as any).__context.head;
            const shallowChunk =
                await writer.files.log.log.getShallow(chunkHead);

            const rootReplicas = decodeReplicas(shallowRoot!).getValue(
                writer.files.log
            );
            const chunkReplicas = decodeReplicas(shallowChunk!).getValue(
                writer.files.log
            );

            expect(rootReplicas).to.eq(3);
            expect(chunkReplicas).to.eq(rootReplicas);
        });

        it("prioritizes newer heads during adaptive sync", async () => {
            const filestore = await peer.open(new Files());
            const syncOptions =
                (filestore.files.log as any).syncronizer?.properties?.sync ??
                (filestore.files.log as any).syncronizer?.syncOptions;

            expect(syncOptions?.maxSimpleEntries).to.eq(128);
            expect(syncOptions?.priority?.({ wallTime: 20n })).to.be.greaterThan(
                syncOptions?.priority?.({ wallTime: 10n })
            );
        });

        it("keeps ready root manifests during adaptive pruning", async () => {
            const writer = await peer.open(new Files());
            const reader = await peer2.open<Files>(writer.address);
            const readyRoot = new LargeFileWithChunkHeads({
                id: "adaptive-root-ready",
                name: "adaptive-root-ready.bin",
                size: 12n * 1024n * 1024n,
                chunkCount: 2,
                ready: true,
                finalHash: "final-hash",
                chunkEntryHeads: ["chunk-head-0", "chunk-head-1"],
            });
            const appended = await writer.files.put(readyRoot);

            expect(await (reader as any).shouldKeepFileEntry(appended.entry)).to
                .be.true;
        });

        it("stores upload-scoped chunks for repeated large-file segments", async () => {
            // Peer 1 is subscribing to a replication topic (to start helping the network)
            const filestore = await peer.open(new Files());

            const largeFile = new Uint8Array(5 * 1e7 + 1); // 50 mb + 1 byte to make this not perfect splittable
            await filestore.add("large file", largeFile);

            // 96 upload-scoped chunks + 1 root manifest.
            expect(await filestore.files.index.getSize()).to.eq(97);

            const filestoreReader = await peer2.open<Files>(filestore.address, {
                args: { replicate: false },
            });
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file = await filestoreReader.getByName("large file");
            expect(equals(file!.bytes, largeFile)).to.be.true;
        });

        it("random file", async () => {
            // Peer 1 is subscribing to a replication topic (to start helping the network)
            const filestore = await peer.open(new Files());

            const largeFile = crypto.randomBytes(5 * 1e7) as Uint8Array; // 50 mb
            await filestore.add("random large file", largeFile);

            // 96 upload-scoped chunks + 1 root manifest.
            expect(await filestore.files.index.getSize()).to.eq(97); // depends on the chunk size used

            const filestoreReader = await peer2.open<Files>(filestore.address, {
                args: { replicate: false },
            });
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file =
                (await filestoreReader.getByName("random large file"))!;

            expect(equals(file!.bytes, largeFile)).to.be.true;

            await filestore.removeByName("random large file");
            expect(await filestoreReader.getByName("random large file")).to.be
                .undefined;
        });

        it("streams blob uploads without changing the root hash", async () => {
            const filestore = await peer.open(new Files());

            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const expectedId = sha256Base64Sync(largeFile);
            const addProgress: number[] = [];
            class StreamingOnlyBlob extends Blob {
                streamCalls = 0;

                stream() {
                    this.streamCalls += 1;
                    return super.stream();
                }

                slice(): Blob {
                    throw new Error("large blob uploads should use stream()");
                }
            }
            const blob = new StreamingOnlyBlob([largeFile]);

            const addedId = await filestore.add(
                "streamed large blob",
                blob,
                undefined,
                (progress) => {
                    addProgress.push(progress);
                }
            );

            const added = await filestore.files.index.get(addedId);
            expect(added).to.be.instanceOf(LargeFile);
            expect((added as LargeFile).finalHash).to.eq(expectedId);
            expect(blob.streamCalls).to.eq(1);
            expect(addProgress.some((x) => x > 0 && x < 1)).to.be.true;

            const filestoreReader = await peer2.open<Files>(filestore.address, {
                args: { replicate: false },
            });
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file = await filestoreReader.getByName("streamed large blob");
            expect(equals(file!.bytes, largeFile)).to.be.true;
        });

        it("links streamed ready manifests after pending upload manifests", async () => {
            const filestore = await peer.open(new Files());
            const originalPut = filestore.files.put.bind(filestore.files);
            let pendingHead: string | undefined;
            let readyNext: unknown[] | undefined;

            (filestore.files as any).put = async (
                entry: unknown,
                options: unknown
            ) => {
                const result = await originalPut(
                    entry as never,
                    options as never
                );
                if (entry instanceof LargeFile && entry.ready === false) {
                    pendingHead = result.entry.hash;
                }
                if (entry instanceof LargeFile && entry.ready === true) {
                    readyNext = result.entry.meta.next;
                }
                return result;
            };

            try {
                const largeFile = crypto.randomBytes(6 * 1e6) as Uint8Array;
                const fileId = await filestore.add(
                    "linked streamed ready manifest",
                    new Blob([largeFile])
                );
                const listed = await filestore.list();
                const listedFile = listed.find((file) => file.id === fileId);

                expect(pendingHead).to.be.a("string");
                expect(
                    readyNext?.some((next: any) =>
                        typeof next === "string"
                            ? next === pendingHead
                            : next?.hash === pendingHead
                    )
                ).to.be.true;
                expect(listedFile).to.be.instanceOf(LargeFile);
                expect((listedFile as LargeFile).ready).to.be.true;
                expect(
                    filestore.lastUploadDiagnostics?.readyManifestFinishedAt
                ).to.be.a("number");
            } finally {
                (filestore.files as any).put = originalPut;
            }
        });

        it("streams downloaded files chunk by chunk", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileId = await filestore.add("streamed download", largeFile);

            const filestoreReader = await peer2.open<Files>(filestore.address, {
                args: { replicate: false },
            });
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file = await filestoreReader.files.index.get(fileId);
            const streamedChunks: Uint8Array[] = [];

            expect(file).to.be.instanceOf(LargeFile);

            await file!.writeFile(filestoreReader, {
                write: async (chunk) => {
                    streamedChunks.push(chunk);
                },
            });

            expect(streamedChunks.length).to.be.greaterThan(1);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("pins persisted large-file chunk reads before streaming starts", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileId = await filestore.add(
                "pinned streamed download",
                largeFile
            );
            const file = (await filestore.files.index.get(fileId)) as LargeFile;
            const retainedChunks = new Set<string>();
            const retainChunkRead = filestore.retainChunkRead.bind(filestore);
            let firstWriteRetainedCount: number | undefined;

            (filestore as any).retainChunkRead = (chunkId: string) => {
                retainedChunks.add(chunkId);
                return retainChunkRead(chunkId);
            };

            await file.writeFile(filestore, {
                write: async () => {
                    firstWriteRetainedCount ??= retainedChunks.size;
                },
            });

            expect(firstWriteRetainedCount).to.eq(file.chunkCount);
        });

        it("records diagnostics for chunked uploads", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileId = await filestore.add(
                "diagnostic large file",
                largeFile
            );

            expect(fileId).to.be.a("string");
            expect(filestore.lastUploadDiagnostics).to.deep.include({
                uploadId: fileId,
                fileName: "diagnostic large file",
                sizeBytes: largeFile.byteLength,
            });
            expect(
                filestore.lastUploadDiagnostics?.chunkCount
            ).to.be.greaterThan(1);
            expect(filestore.lastUploadDiagnostics?.chunkPutCount).to.eq(
                filestore.lastUploadDiagnostics?.chunkCount
            );
            expect(
                filestore.lastUploadDiagnostics?.manifestFinishedAt
            ).to.not.eq(null);
            expect(
                filestore.lastUploadDiagnostics?.readyManifestFinishedAt
            ).to.not.eq(null);
            expect(filestore.lastUploadDiagnostics?.finishedAt).to.not.eq(null);
            expect(filestore.lastUploadDiagnostics?.failureMessage).to.eq(null);
        });

        it("pipelines persisted chunk reads without using parentId searches", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileId = await filestore.add(
                "streamed download with persisted read-ahead",
                largeFile
            );

            const filestoreReader = await peer2.open<Files>(filestore.address);
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file = await filestoreReader.files.index.get(fileId);
            expect(file).to.be.instanceOf(LargeFile);
            stripChunkEntryHeads(file);

            const originalSearch = filestoreReader.files.index.search.bind(
                filestoreReader.files.index
            );
            const originalGet = filestoreReader.files.index.get.bind(
                filestoreReader.files.index
            );
            let parentIdSearches = 0;
            let directChunkGets = 0;
            let inflightChunkGets = 0;
            let maxInflightChunkGets = 0;
            let sawChunkWaitFor = false;
            let indexedChunkGets = 0;
            let resolvedRemoteChunkGets = 0;
            const resolvedChunks = new Set<string>();
            const retainedChunkId = `${fileId}:1`;
            const retainedWriterChunk = await filestore.files.index.get(
                retainedChunkId,
                {
                    local: true,
                    remote: false,
                }
            );
            const retainedWriterEntry = await filestore.files.log.log.get(
                (retainedWriterChunk as any).__context.head
            );
            let retainedBeforeIndexedReplication = false;

            (filestoreReader.files.index as any).search = async (
                request: { query: unknown | unknown[] },
                options: unknown
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const isBulkChunkLookup = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "parentId" &&
                        getQueryValue(query) === fileId
                );

                if (isBulkChunkLookup) {
                    parentIdSearches++;
                    throw new Error("parentId chunk search should not be used");
                }

                return originalSearch(request as never, options as never);
            };

            (filestoreReader.files.index as any).get = async (
                id: string,
                options: unknown
            ) => {
                if (id.startsWith(`${fileId}:`)) {
                    const getOptions = options as {
                        resolve?: boolean;
                        remote?: false | { replicate?: boolean };
                    };
                    sawChunkWaitFor ||=
                        (getOptions as { waitFor?: number })?.waitFor != null;
                    if (
                        getOptions.resolve === false &&
                        getOptions.remote &&
                        getOptions.remote !== false
                    ) {
                        indexedChunkGets++;
                        if (id === retainedChunkId) {
                            retainedBeforeIndexedReplication = await (
                                filestoreReader.files.log as any
                            ).keep(retainedWriterEntry);
                        }
                    } else if (
                        getOptions.remote &&
                        getOptions.remote !== false
                    ) {
                        resolvedRemoteChunkGets++;
                        resolvedChunks.add(id);
                        if (id === retainedChunkId) {
                            retainedBeforeIndexedReplication = await (
                                filestoreReader.files.log as any
                            ).keep(retainedWriterEntry);
                        }
                    }
                    directChunkGets++;
                    inflightChunkGets++;
                    maxInflightChunkGets = Math.max(
                        maxInflightChunkGets,
                        inflightChunkGets
                    );
                    await delay(25);
                    inflightChunkGets--;
                    if (
                        getOptions.remote === false &&
                        !resolvedChunks.has(id)
                    ) {
                        return undefined;
                    }
                }
                return originalGet(id as never, options as never);
            };

            const streamedChunks: Uint8Array[] = [];

            await file!.writeFile(filestoreReader, {
                write: async (chunk) => {
                    streamedChunks.push(chunk);
                },
            });

            expect(parentIdSearches).to.eq(0);
            expect(directChunkGets).to.be.greaterThan(1);
            expect(maxInflightChunkGets).to.be.greaterThan(1);
            const readAhead = filestoreReader.lastReadDiagnostics?.readAhead;
            expect(readAhead).to.be.greaterThan(4);
            expect(readAhead).to.be.lessThanOrEqual(file!.chunkCount);
            expect(
                filestoreReader.lastReadDiagnostics?.chunkAttemptTimeoutMs
            ).to.eq(5_000);
            expect(sawChunkWaitFor).to.be.false;
            expect(indexedChunkGets).to.eq(0);
            expect(resolvedRemoteChunkGets).to.be.greaterThan(1);
            expect(retainedBeforeIndexedReplication).to.be.true;
            expect(maxInflightChunkGets).to.be.lessThanOrEqual(readAhead);
            expect(
                Object.keys(
                    filestoreReader.lastReadDiagnostics
                        ?.chunkResolveStartedAt ?? {}
                ).length
            ).to.be.greaterThan(1);
            expect(
                Object.keys(
                    filestoreReader.lastReadDiagnostics
                        ?.chunkMaterializeFinishedAt ?? {}
                ).length
            ).to.eq(streamedChunks.length);
            expect(streamedChunks.length).to.be.greaterThan(1);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("scales chunk lookup attempt timeouts for large persisted chunks", async () => {
            const filestore = await peer.open(new Files());
            const file = new LargeFile({
                id: "large-timeout-scale",
                name: "large timeout scale",
                size: BigInt(512 * 1024 * 1024),
                chunkCount: 256,
                ready: true,
            });
            const originalGet = filestore.files.index.get.bind(
                filestore.files.index
            );

            (filestore.files.index as any).get = async (
                id: string,
                options: unknown
            ) => {
                if (id.startsWith(`${file.id}:`)) {
                    throw new Error("stop after timeout diagnostic");
                }
                return originalGet(id as never, options as never);
            };

            try {
                await file.writeFile(
                    filestore,
                    { write: async () => {} },
                    { timeout: 60_000 }
                );
                expect.fail("expected chunk resolution to fail");
            } catch (error) {
                expect((error as Error).message).to.contain(
                    "stop after timeout diagnostic"
                );
            } finally {
                (filestore.files.index as any).get = originalGet;
            }

            expect(
                filestore.lastReadDiagnostics?.chunkAttemptTimeoutMs
            ).to.be.greaterThan(5_000);
            expect(
                filestore.lastReadDiagnostics?.chunkAttemptTimeoutMs
            ).to.be.lessThanOrEqual(45_000);
        });

        it("caps large file chunks to browser transport-safe payloads", async () => {
            const filestore = await peer.open(new Files());
            let observedChunkSize: number | undefined;

            try {
                await filestore.addSource("transport-safe chunks", {
                    size: BigInt(512 * 1024 * 1024),
                    readChunks: async function* (chunkSize: number) {
                        observedChunkSize = chunkSize;
                        yield new Uint8Array(0);
                    },
                });
                expect.fail("expected source size mismatch");
            } catch (error) {
                expect((error as Error).message).to.contain(
                    "Source size changed during upload"
                );
            }

            expect(observedChunkSize).to.eq(512 * 1024);
        });

        it("uses indexed chunk search when direct chunk lookup misses", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileName = "streamed download with indexed chunk search";
            const fileId = await filestore.add(fileName, largeFile);

            const filestoreReader = await peer2.open<Files>(filestore.address);
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file = await filestoreReader.files.index.get(fileId);
            expect(file).to.be.instanceOf(LargeFile);
            stripChunkEntryHeads(file);

            const originalSearch = filestoreReader.files.index.search.bind(
                filestoreReader.files.index
            );
            const originalGet = filestoreReader.files.index.get.bind(
                filestoreReader.files.index
            );
            const missingDirectChunkId = `${fileId}:1`;
            let directChunkMisses = 0;
            let indexedChunkSearches = 0;

            (filestoreReader.files.index as any).get = async (
                id: string,
                options: unknown
            ) => {
                if (id === missingDirectChunkId) {
                    directChunkMisses++;
                    return undefined;
                }
                return originalGet(id as never, options as never);
            };

            (filestoreReader.files.index as any).search = async (
                request: { query: unknown | unknown[] },
                options: unknown
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const hasParentId = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "parentId" &&
                        getQueryValue(query) === fileId
                );
                const hasChunkName = queries.some((query: any) => {
                    return (
                        getQueryKey(query) === "name" &&
                        getQueryValue(query) === `${fileName}/1`
                    );
                });
                if (hasParentId && hasChunkName) {
                    indexedChunkSearches++;
                }

                return originalSearch(request as never, options as never);
            };

            const streamedChunks: Uint8Array[] = [];

            await file!.writeFile(filestoreReader, {
                write: async (chunk) => {
                    streamedChunks.push(chunk);
                },
            });

            expect(directChunkMisses).to.be.greaterThan(0);
            expect(indexedChunkSearches).to.be.greaterThan(0);
            expect(streamedChunks.length).to.be.greaterThan(1);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("uses non-replicating chunk reads when persisted and precise lookups miss", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileName = "streamed download with non-replicating read";
            const fileId = await filestore.add(fileName, largeFile);

            const filestoreReader = await peer2.open<Files>(filestore.address);
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file = await filestoreReader.files.index.get(fileId);
            expect(file).to.be.instanceOf(LargeFile);
            stripChunkEntryHeads(file);

            const originalSearch = filestoreReader.files.index.search.bind(
                filestoreReader.files.index
            );
            const originalGet = filestoreReader.files.index.get.bind(
                filestoreReader.files.index
            );
            const missingDirectChunkId = `${fileId}:1`;
            let directChunkMisses = 0;
            let preciseChunkSearches = 0;
            let nonReplicatingChunkGets = 0;
            let sawUnhintedNonReplicatingGet = false;

            (filestoreReader.files.index as any).get = async (
                id: string,
                options: { remote?: { from?: string[]; replicate?: boolean } }
            ) => {
                if (id === missingDirectChunkId) {
                    if (options?.remote?.replicate === false) {
                        nonReplicatingChunkGets++;
                        sawUnhintedNonReplicatingGet ||=
                            options.remote.from == null;
                        return originalGet(id as never, options as never);
                    }
                    directChunkMisses++;
                    return undefined;
                }
                return originalGet(id as never, options as never);
            };

            (filestoreReader.files.index as any).search = async (
                request: { query: unknown | unknown[] },
                options: unknown
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const hasParentId = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "parentId" &&
                        getQueryValue(query) === fileId
                );
                const hasChunkName = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "name" &&
                        getQueryValue(query) === `${fileName}/1`
                );

                if (hasParentId && hasChunkName) {
                    preciseChunkSearches++;
                    return [];
                }

                return originalSearch(request as never, options as never);
            };

            const streamedChunks: Uint8Array[] = [];

            await file!.writeFile(filestoreReader, {
                write: async (chunk) => {
                    streamedChunks.push(chunk);
                },
            });

            expect(directChunkMisses).to.be.greaterThan(0);
            expect(preciseChunkSearches).to.be.greaterThan(0);
            expect(nonReplicatingChunkGets).to.be.greaterThan(0);
            expect(sawUnhintedNonReplicatingGet).to.be.true;
            expect(streamedChunks.length).to.be.greaterThan(1);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("uses resolved precise search when adaptive exact routes miss", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileName = "streamed download with resolved precise search";
            const fileId = await filestore.add(fileName, largeFile);

            const filestoreReader = await peer2.open<Files>(filestore.address);
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file = await filestoreReader.files.index.get(fileId);
            expect(file).to.be.instanceOf(LargeFile);
            stripChunkEntryHeads(file);

            const writerHash = peer.identity.publicKey.hashcode();
            (filestoreReader as any).getReadPeerHints = async () => [
                writerHash,
            ];
            const originalSearch = filestoreReader.files.index.search.bind(
                filestoreReader.files.index
            );
            const originalGet = filestoreReader.files.index.get.bind(
                filestoreReader.files.index
            );
            const delayedChunkId = `${fileId}:1`;
            let directChunkGets = 0;
            let exactNonReplicatingGets = 0;
            let replicatingPreciseSearches = 0;
            let resolvedPreciseSearches = 0;
            let parentChunkSearches = 0;

            (filestoreReader.files.index as any).get = async (
                id: string,
                options: {
                    resolve?: boolean;
                    remote?:
                        | {
                              from?: string[];
                              replicate?: boolean;
                              strategy?: string;
                          }
                        | false;
                }
            ) => {
                if (id === delayedChunkId) {
                    const remote = options?.remote;
                    if (remote === false) {
                        return undefined;
                    }
                    if (remote?.replicate === false) {
                        exactNonReplicatingGets++;
                        return undefined;
                    }
                    directChunkGets++;
                    return undefined;
                }
                return originalGet(id as never, options as never);
            };

            (filestoreReader.files.index as any).search = async (
                request: { query: unknown | unknown[] },
                options: {
                    resolve?: boolean;
                    remote?: false | { replicate?: boolean };
                }
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const hasParentId = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "parentId" &&
                        getQueryValue(query) === fileId
                );
                const hasChunkName = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "name" &&
                        getQueryValue(query) === `${fileName}/1`
                );

                if (hasParentId && hasChunkName) {
                    if (
                        options?.remote &&
                        options.remote !== false &&
                        options.remote.replicate === false &&
                        options.resolve !== false
                    ) {
                        resolvedPreciseSearches++;
                        return originalSearch(
                            request as never,
                            options as never
                        );
                    }
                    replicatingPreciseSearches++;
                    return [];
                }
                if (hasParentId) {
                    parentChunkSearches++;
                    return [];
                }

                return originalSearch(request as never, options as never);
            };

            const streamedChunks: Uint8Array[] = [];

            try {
                await file!.writeFile(
                    filestoreReader,
                    {
                        write: async (chunk) => {
                            streamedChunks.push(chunk);
                        },
                    },
                    { timeout: 20_000 }
                );
            } finally {
                (filestoreReader.files.index as any).get = originalGet;
                (filestoreReader.files.index as any).search = originalSearch;
            }

            expect(directChunkGets).to.be.greaterThan(0);
            expect(replicatingPreciseSearches).to.be.greaterThan(0);
            expect(exactNonReplicatingGets).to.be.greaterThan(0);
            expect(resolvedPreciseSearches).to.be.greaterThan(0);
            expect(parentChunkSearches).to.eq(0);
            expect(
                filestoreReader.lastReadDiagnostics?.chunkResolved?.[1]
            ).to.eq("resolved-search");
            expect(streamedChunks.length).to.be.greaterThan(1);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("streams a pending manifest when the complete chunk set is already local", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileName = "pending manifest with complete local chunks";
            const fileId = await filestore.add(fileName, largeFile);
            const pendingFile = new LargeFile({
                id: fileId,
                name: fileName,
                size: BigInt(largeFile.byteLength),
                chunkCount: filestore.lastUploadDiagnostics!.chunkCount,
                ready: false,
            });
            const originalSearch = filestore.files.index.search.bind(
                filestore.files.index
            );

            (filestore.files.index as any).search = async (
                request: { query: unknown | unknown[] },
                options: unknown
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const hasRootId = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "id" &&
                        getQueryValue(query) === fileId
                );
                if (hasRootId) {
                    return [pendingFile];
                }
                return originalSearch(request as never, options as never);
            };

            const streamedChunks: Uint8Array[] = [];

            try {
                await pendingFile.writeFile(
                    filestore,
                    {
                        write: async (chunk) => {
                            streamedChunks.push(chunk);
                        },
                    },
                    { timeout: 20_000 }
                );
            } finally {
                (filestore.files.index as any).search = originalSearch;
            }

            expect(
                filestore.lastReadDiagnostics?.waitUntilReadyResolvedBy
            ).to.eq("complete-chunks");
            expect(streamedChunks.length).to.be.greaterThan(1);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("keeps pending adaptive manifests blocked without ready or complete local chunks", async () => {
            const filestore = await peer.open(new Files());
            const fileName = "pending manifest with arbitrary local chunks";
            const fileId = "pending-manifest-arbitrary-local-chunks";
            const pendingFile = new LargeFile({
                id: fileId,
                name: fileName,
                size: 2n * 1024n * 1024n,
                chunkCount: 4,
                ready: false,
            });
            const originalSearch = filestore.files.index.search.bind(
                filestore.files.index
            );
            const originalGet = filestore.files.index.get.bind(
                filestore.files.index
            );
            const originalCountLocalChunks =
                filestore.countLocalChunks.bind(filestore);
            const originalGetReadPeerHints =
                filestore.getReadPeerHints.bind(filestore);

            (filestore as any).getReadPeerHints = async () => ["writer-peer"];
            (filestore as any).countLocalChunks = async () => 1;
            (filestore.files.index as any).search = async (
                request: { query: unknown | unknown[] },
                options: unknown
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const hasRootId = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "id" &&
                        getQueryValue(query) === fileId
                );
                if (hasRootId) {
                    return [pendingFile];
                }
                return [];
            };
            (filestore.files.index as any).get = async (
                id: unknown,
                options: any
            ) => {
                if (
                    id === fileId &&
                    options?.remote &&
                    options.remote !== false
                ) {
                    return pendingFile;
                }
                if (typeof id === "string" && id.startsWith(`${fileId}:`)) {
                    return undefined;
                }
                return originalGet(id as never, options as never);
            };

            const streamedChunks: Uint8Array[] = [];

            try {
                await expect(
                    pendingFile.writeFile(
                        filestore,
                        {
                            write: async (chunk) => {
                                streamedChunks.push(chunk);
                            },
                        },
                        { timeout: 500 }
                    )
                ).rejects.toThrow(/still uploading/);
            } finally {
                (filestore.files.index as any).search = originalSearch;
                (filestore.files.index as any).get = originalGet;
                (filestore as any).countLocalChunks = originalCountLocalChunks;
                (filestore as any).getReadPeerHints = originalGetReadPeerHints;
            }

            expect(
                filestore.lastReadDiagnostics?.waitUntilReadyResolvedBy
            ).not.to.eq("pending-manifest-local-chunks");
            expect(
                filestore.lastReadDiagnostics?.lastReadyProbe?.localChunkCount
            ).to.eq(1);
            expect(streamedChunks).to.have.length(0);
        });

        it("keeps pending adaptive manifests blocked when only a majority of chunks are local", async () => {
            const filestore = await peer.open(new Files());
            const fileName = "pending manifest with majority local chunks";
            const fileId = "pending-manifest-majority-local-chunks";
            const chunkCount = 6;
            const localChunkCount = 4;
            const pendingFile = new LargeFile({
                id: fileId,
                name: fileName,
                size: BigInt(chunkCount),
                chunkCount,
                ready: false,
            });
            for (let index = 0; index < localChunkCount; index++) {
                await filestore.files.put(
                    new TinyFile({
                        id: `${fileId}:${index}`,
                        name: `${fileName}/${index}`,
                        file: new Uint8Array([index]),
                        parentId: fileId,
                        index,
                    })
                );
            }
            const originalSearch = filestore.files.index.search.bind(
                filestore.files.index
            );
            const originalCountLocalChunks =
                filestore.countLocalChunks.bind(filestore);
            const originalGetReadPeerHints =
                filestore.getReadPeerHints.bind(filestore);

            (filestore as any).getReadPeerHints = async () => ["writer-peer"];
            (filestore as any).countLocalChunks = async () => localChunkCount;
            (filestore.files.index as any).search = async (
                request: { query: unknown | unknown[] },
                options: unknown
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const hasRootId = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "id" &&
                        getQueryValue(query) === fileId
                );
                if (hasRootId) {
                    return [pendingFile];
                }
                return originalSearch(request as never, options as never);
            };

            const streamedChunks: Uint8Array[] = [];

            try {
                await expect(
                    pendingFile.writeFile(
                        filestore,
                        {
                            write: async (chunk) => {
                                streamedChunks.push(chunk);
                            },
                        },
                        { timeout: 500 }
                    )
                ).rejects.toThrow(/still uploading/);
            } finally {
                (filestore.files.index as any).search = originalSearch;
                (filestore as any).countLocalChunks = originalCountLocalChunks;
                (filestore as any).getReadPeerHints = originalGetReadPeerHints;
            }

            expect(
                filestore.lastReadDiagnostics?.waitUntilReadyResolvedBy
            ).not.to.eq("pending-manifest");
            expect(
                filestore.lastReadDiagnostics?.lastReadyProbe?.localChunkCount
            ).to.eq(localChunkCount);
            expect(streamedChunks).to.have.length(0);
        });

        it("checks local complete chunks while read peer hints are present", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileName = "pending manifest with hinted complete chunks";
            const fileId = await filestore.add(fileName, largeFile);
            const pendingFile = new LargeFile({
                id: fileId,
                name: fileName,
                size: BigInt(largeFile.byteLength),
                chunkCount: filestore.lastUploadDiagnostics!.chunkCount,
                ready: false,
            });
            const originalSearch = filestore.files.index.search.bind(
                filestore.files.index
            );
            const originalGetReadPeerHints =
                filestore.getReadPeerHints.bind(filestore);
            let readPeerHintCalls = 0;
            let localReadySearches = 0;

            (filestore as any).getReadPeerHints = async () => {
                readPeerHintCalls++;
                return ["missing-read-peer"];
            };
            (filestore.files.index as any).search = async (
                request: { query: unknown | unknown[] },
                options: unknown
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const hasRootId = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "id" &&
                        getQueryValue(query) === fileId
                );
                if (hasRootId) {
                    if (
                        (options as any)?.local === true &&
                        (options as any)?.remote
                    ) {
                        throw new Error(
                            "ready search must not combine local and remote"
                        );
                    }
                    if ((options as any)?.local === true) {
                        localReadySearches++;
                        return [pendingFile];
                    }
                    return [];
                }
                return originalSearch(request as never, options as never);
            };

            const streamedChunks: Uint8Array[] = [];

            try {
                await pendingFile.writeFile(
                    filestore,
                    {
                        write: async (chunk) => {
                            streamedChunks.push(chunk);
                        },
                    },
                    { timeout: 20_000 }
                );
            } finally {
                (filestore.files.index as any).search = originalSearch;
                (filestore as any).getReadPeerHints = originalGetReadPeerHints;
            }

            expect(readPeerHintCalls).to.be.greaterThan(0);
            expect(localReadySearches).to.be.greaterThan(0);
            expect(
                filestore.lastReadDiagnostics?.waitUntilReadyResolvedBy
            ).to.eq("complete-chunks");
            expect(
                filestore.lastReadDiagnostics?.lastReadyProbe?.localChunkCount
            ).to.eq(pendingFile.chunkCount);
            expect(streamedChunks.length).to.be.greaterThan(1);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("streams pending manifests when hinted ready search fails", async () => {
            const filestore = await peer.open(new Files());
            const fileName = "pending manifest with failing ready search";
            const fileId = "pending-ready-search-fails";
            const chunkCount = 128;
            const expected = new Uint8Array(chunkCount);
            for (let index = 0; index < chunkCount; index++) {
                expected[index] = index % 256;
                await filestore.files.put(
                    new TinyFile({
                        id: `${fileId}:${index}`,
                        name: `${fileName}/${index}`,
                        file: new Uint8Array([expected[index]]),
                        parentId: fileId,
                        index,
                    })
                );
            }
            const pendingFile = new LargeFile({
                id: fileId,
                name: fileName,
                size: BigInt(expected.byteLength),
                chunkCount,
                ready: false,
            });
            const originalSearch = filestore.files.index.search.bind(
                filestore.files.index
            );
            const originalCountLocalChunks =
                filestore.countLocalChunks.bind(filestore);
            const originalGetReadPeerHints =
                filestore.getReadPeerHints.bind(filestore);
            let countCalls = 0;
            let remoteReadyFailures = 0;

            (filestore as any).getReadPeerHints = async () => [
                "missing-read-peer",
            ];
            (filestore as any).countLocalChunks = async (parent: LargeFile) => {
                countCalls++;
                if (countCalls === 1) {
                    return Math.ceil(parent.chunkCount / 2);
                }
                return originalCountLocalChunks(parent);
            };
            (filestore.files.index as any).search = async (
                request: { query: unknown | unknown[] },
                options: unknown
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const hasRootId = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "id" &&
                        getQueryValue(query) === fileId
                );
                if (hasRootId) {
                    if ((options as any)?.local === true) {
                        return [pendingFile];
                    }
                    if ((options as any)?.remote) {
                        remoteReadyFailures++;
                        throw new Error("remote ready search failed");
                    }
                    return [];
                }
                return originalSearch(request as never, options as never);
            };

            const streamedChunks: Uint8Array[] = [];

            try {
                await pendingFile.writeFile(
                    filestore,
                    {
                        write: async (chunk) => {
                            streamedChunks.push(chunk);
                        },
                    },
                    { timeout: 20_000 }
                );
            } finally {
                (filestore.files.index as any).search = originalSearch;
                (filestore as any).countLocalChunks = originalCountLocalChunks;
                (filestore as any).getReadPeerHints = originalGetReadPeerHints;
            }

            expect(remoteReadyFailures).to.be.greaterThan(0);
            expect(
                filestore.lastReadDiagnostics?.readyRemoteSearchErrors?.[0]
            ).to.eq("remote ready search failed");
            expect(
                filestore.lastReadDiagnostics?.waitUntilReadyResolvedBy
            ).to.eq("complete-chunks");
            expect(equals(concat(streamedChunks), expected)).to.be.true;
        });

        it("waits for complete local chunks while ready search is still pending", async () => {
            const filestore = await peer.open(new Files());
            const fileName = "pending manifest with partial local chunks";
            const fileId = "pending-ready-search-pending";
            const chunkCount = 100;
            const expected = new Uint8Array(chunkCount);
            for (let index = 0; index < chunkCount; index++) {
                expected[index] = index % 256;
                await filestore.files.put(
                    new TinyFile({
                        id: `${fileId}:${index}`,
                        name: `${fileName}/${index}`,
                        file: new Uint8Array([expected[index]]),
                        parentId: fileId,
                        index,
                    })
                );
            }
            const pendingFile = new LargeFile({
                id: fileId,
                name: fileName,
                size: BigInt(expected.byteLength),
                chunkCount,
                ready: false,
            });
            const originalSearch = filestore.files.index.search.bind(
                filestore.files.index
            );
            const originalCountLocalChunks =
                filestore.countLocalChunks.bind(filestore);
            const originalGetReadPeerHints =
                filestore.getReadPeerHints.bind(filestore);
            let countCalls = 0;
            let remoteReadySearches = 0;

            (filestore as any).getReadPeerHints = async () => ["writer-peer"];
            (filestore as any).countLocalChunks = async (parent: LargeFile) => {
                countCalls++;
                if (countCalls === 1) {
                    return Math.ceil(parent.chunkCount / 2);
                }
                return originalCountLocalChunks(parent);
            };
            (filestore.files.index as any).search = async (
                request: { query: unknown | unknown[] },
                options: unknown
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const hasRootId = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "id" &&
                        getQueryValue(query) === fileId
                );
                if (hasRootId) {
                    if ((options as any)?.remote) {
                        remoteReadySearches++;
                    }
                    return [pendingFile];
                }
                return originalSearch(request as never, options as never);
            };

            const streamedChunks: Uint8Array[] = [];

            try {
                await pendingFile.writeFile(
                    filestore,
                    {
                        write: async (chunk) => {
                            streamedChunks.push(chunk);
                        },
                    },
                    { timeout: 20_000 }
                );
            } finally {
                (filestore.files.index as any).search = originalSearch;
                (filestore as any).countLocalChunks = originalCountLocalChunks;
                (filestore as any).getReadPeerHints = originalGetReadPeerHints;
            }

            expect(remoteReadySearches).to.be.greaterThan(0);
            expect(
                filestore.lastReadDiagnostics?.waitUntilReadyResolvedBy
            ).to.eq("complete-chunks");
            expect(equals(concat(streamedChunks), expected)).to.be.true;
        });

        it("uses non-replicating parent search when adaptive exact routes miss", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileName = "streamed download with parent search";
            const fileId = await filestore.add(fileName, largeFile);

            const filestoreReader = await peer2.open<Files>(filestore.address);
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file = await filestoreReader.files.index.get(fileId);
            expect(file).to.be.instanceOf(LargeFile);
            stripChunkEntryHeads(file);

            const writerHash = peer.identity.publicKey.hashcode();
            (filestoreReader as any).getReadPeerHints = async () => [
                writerHash,
            ];
            const originalSearch = filestoreReader.files.index.search.bind(
                filestoreReader.files.index
            );
            const originalGet = filestoreReader.files.index.get.bind(
                filestoreReader.files.index
            );
            const delayedChunkId = `${fileId}:1`;
            let directChunkGets = 0;
            let exactNonReplicatingGets = 0;
            let replicatingPreciseSearches = 0;
            let resolvedPreciseSearches = 0;
            let persistedParentSearches = 0;
            let nonReplicatingParentSearches = 0;

            (filestoreReader.files.index as any).get = async (
                id: string,
                options: {
                    resolve?: boolean;
                    remote?:
                        | {
                              from?: string[];
                              replicate?: boolean;
                              strategy?: string;
                          }
                        | false;
                }
            ) => {
                if (id === delayedChunkId) {
                    const remote = options?.remote;
                    if (remote === false) {
                        return undefined;
                    }
                    if (remote?.replicate === false) {
                        exactNonReplicatingGets++;
                        return undefined;
                    }
                    directChunkGets++;
                    return undefined;
                }
                return originalGet(id as never, options as never);
            };

            (filestoreReader.files.index as any).search = async (
                request: { query: unknown | unknown[] },
                options: {
                    resolve?: boolean;
                    remote?: false | { replicate?: boolean };
                }
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const hasParentId = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "parentId" &&
                        getQueryValue(query) === fileId
                );
                const hasChunkName = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "name" &&
                        getQueryValue(query) === `${fileName}/1`
                );

                if (hasParentId && hasChunkName) {
                    if (
                        options?.remote &&
                        options.remote !== false &&
                        options.remote.replicate === false &&
                        options.resolve !== false
                    ) {
                        resolvedPreciseSearches++;
                    } else {
                        replicatingPreciseSearches++;
                    }
                    return [];
                }

                if (hasParentId) {
                    if (
                        options?.remote &&
                        options.remote !== false &&
                        options.remote.replicate === false
                    ) {
                        nonReplicatingParentSearches++;
                        return originalSearch(
                            request as never,
                            options as never
                        );
                    }
                    persistedParentSearches++;
                    return [];
                }

                return originalSearch(request as never, options as never);
            };

            const streamedChunks: Uint8Array[] = [];

            try {
                await file!.writeFile(
                    filestoreReader,
                    {
                        write: async (chunk) => {
                            streamedChunks.push(chunk);
                        },
                    },
                    { timeout: 20_000 }
                );
            } finally {
                (filestoreReader.files.index as any).get = originalGet;
                (filestoreReader.files.index as any).search = originalSearch;
            }

            expect(directChunkGets).to.be.greaterThan(0);
            expect(replicatingPreciseSearches).to.be.greaterThan(0);
            expect(exactNonReplicatingGets).to.be.greaterThan(0);
            expect(resolvedPreciseSearches).to.be.greaterThan(0);
            expect(persistedParentSearches).to.be.greaterThan(0);
            expect(nonReplicatingParentSearches).to.be.greaterThan(0);
            expect(
                filestoreReader.lastReadDiagnostics?.chunkResolved?.[1]
            ).to.eq("non-replicating-parent-search");
            expect(streamedChunks.length).to.be.greaterThan(1);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("keeps hinted chunk reads after unhinted non-replicating misses", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileName = "streamed download with hinted exact read";
            const fileId = await filestore.add(fileName, largeFile);

            const filestoreReader = await peer2.open<Files>(filestore.address);
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file = await filestoreReader.files.index.get(fileId);
            expect(file).to.be.instanceOf(LargeFile);
            stripChunkEntryHeads(file);

            const writerHash = peer.identity.publicKey.hashcode();
            let readPeerHintLookups = 0;
            (filestoreReader as any).getReadPeerHints = async () => {
                readPeerHintLookups++;
                return readPeerHintLookups === 1 ? [writerHash] : undefined;
            };
            const originalSearch = filestoreReader.files.index.search.bind(
                filestoreReader.files.index
            );
            const originalGet = filestoreReader.files.index.get.bind(
                filestoreReader.files.index
            );
            const missingDirectChunkId = `${fileId}:1`;
            let directChunkMisses = 0;
            let preciseChunkSearches = 0;
            let unhintedNonReplicatingGets = 0;
            let hintedNonReplicatingGets = 0;

            (filestoreReader.files.index as any).get = async (
                id: string,
                options: { remote?: { from?: string[]; replicate?: boolean } }
            ) => {
                if (id === missingDirectChunkId) {
                    if (options?.remote?.replicate === false) {
                        if (options.remote.from == null) {
                            unhintedNonReplicatingGets++;
                            return undefined;
                        }
                        hintedNonReplicatingGets++;
                        return originalGet(id as never, options as never);
                    }
                    directChunkMisses++;
                    return undefined;
                }
                return originalGet(id as never, options as never);
            };

            (filestoreReader.files.index as any).search = async (
                request: { query: unknown | unknown[] },
                options: unknown
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const hasParentId = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "parentId" &&
                        getQueryValue(query) === fileId
                );
                const hasChunkName = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "name" &&
                        getQueryValue(query) === `${fileName}/1`
                );

                if (hasParentId && hasChunkName) {
                    preciseChunkSearches++;
                    return [];
                }

                return originalSearch(request as never, options as never);
            };

            const streamedChunks: Uint8Array[] = [];

            await file!.writeFile(
                filestoreReader,
                {
                    write: async (chunk) => {
                        streamedChunks.push(chunk);
                    },
                },
                { timeout: 15_000 }
            );

            expect(directChunkMisses).to.be.greaterThan(0);
            expect(preciseChunkSearches).to.be.greaterThan(0);
            expect(readPeerHintLookups).to.be.greaterThan(1);
            expect(unhintedNonReplicatingGets).to.be.greaterThan(0);
            expect(hintedNonReplicatingGets).to.be.greaterThan(0);
            expect(streamedChunks.length).to.be.greaterThan(1);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("keeps read peer hints after exact chunk misses", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileName = "streamed download with stable hinted reads";
            const fileId = await filestore.add(fileName, largeFile);

            const filestoreReader = await peer2.open<Files>(filestore.address);
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file = await filestoreReader.files.index.get(fileId);
            expect(file).to.be.instanceOf(LargeFile);
            stripChunkEntryHeads(file);

            const writerHash = peer.identity.publicKey.hashcode();
            (filestoreReader as any).getReadPeerHints = async () => [
                writerHash,
            ];
            const originalSearch = filestoreReader.files.index.search.bind(
                filestoreReader.files.index
            );
            const originalGet = filestoreReader.files.index.get.bind(
                filestoreReader.files.index
            );
            const originalIterate =
                filestoreReader.files.log.log.entryIndex.iterate.bind(
                    filestoreReader.files.log.log.entryIndex
                );
            const delayedChunkId = `${fileId}:1`;
            let directChunkGets = 0;
            let hintedDirectGetsAfterNonReplicatingRead = 0;
            let unhintedDirectGetsAfterNonReplicatingRead = 0;
            let nonReplicatingReads = 0;
            let preciseChunkSearches = 0;
            let parentChunkSearches = 0;

            (filestoreReader.files.index as any).get = async (
                id: string,
                options: {
                    resolve?: boolean;
                    remote?:
                        | {
                              from?: string[];
                              replicate?: boolean;
                              strategy?: string;
                          }
                        | false;
                }
            ) => {
                if (id === delayedChunkId) {
                    const remote = options?.remote;
                    if (remote === false) {
                        return undefined;
                    }
                    if (remote?.replicate === false) {
                        nonReplicatingReads++;
                        return undefined;
                    }
                    directChunkGets++;
                    if (nonReplicatingReads > 0) {
                        if (remote?.from?.includes(writerHash)) {
                            hintedDirectGetsAfterNonReplicatingRead++;
                        } else {
                            unhintedDirectGetsAfterNonReplicatingRead++;
                        }
                    }
                    if (directChunkGets <= 4) {
                        return undefined;
                    }
                    if (
                        remote?.from?.includes(writerHash) &&
                        remote.strategy === "always"
                    ) {
                        return originalGet(id as never, options as never);
                    }
                    return undefined;
                }
                return originalGet(id as never, options as never);
            };

            (filestoreReader.files.index as any).search = async (
                request: { query: unknown | unknown[] },
                options: unknown
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const hasParentId = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "parentId" &&
                        getQueryValue(query) === fileId
                );
                const hasChunkName = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "name" &&
                        getQueryValue(query) === `${fileName}/1`
                );

                if (hasParentId) {
                    if (hasChunkName) {
                        preciseChunkSearches++;
                    } else {
                        parentChunkSearches++;
                    }
                    return [];
                }

                return originalSearch(request as never, options as never);
            };

            (filestoreReader.files.log.log.entryIndex as any).iterate = () => ({
                done: () => true,
                next: async () => [],
                all: async () => [],
                close: async () => {},
            });

            const streamedChunks: Uint8Array[] = [];
            try {
                await file!.writeFile(
                    filestoreReader,
                    {
                        write: async (chunk) => {
                            streamedChunks.push(chunk);
                        },
                    },
                    { timeout: 20_000 }
                );
            } finally {
                (filestoreReader.files.index as any).get = originalGet;
                (filestoreReader.files.index as any).search = originalSearch;
                (filestoreReader.files.log.log.entryIndex as any).iterate =
                    originalIterate;
            }

            expect(directChunkGets).to.be.greaterThan(4);
            expect(preciseChunkSearches).to.be.greaterThan(0);
            expect(nonReplicatingReads).to.be.greaterThan(0);
            expect(hintedDirectGetsAfterNonReplicatingRead).to.be.greaterThan(
                0
            );
            expect(unhintedDirectGetsAfterNonReplicatingRead).to.eq(0);
            expect(
                filestoreReader.lastReadDiagnostics?.initialReadPeerHints
            ).to.deep.eq([writerHash]);
            expect(
                filestoreReader.lastReadDiagnostics?.chunkHints?.[1]
            ).to.deep.eq([writerHash]);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("uses parent chunk search when exact chunk routes miss", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileName = "streamed download with parent search";
            const fileId = await filestore.add(fileName, largeFile);

            const filestoreReader = await peer2.open<Files>(filestore.address);
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file = await filestoreReader.files.index.get(fileId);
            expect(file).to.be.instanceOf(LargeFile);
            stripChunkEntryHeads(file);

            const originalSearch = filestoreReader.files.index.search.bind(
                filestoreReader.files.index
            );
            const originalGet = filestoreReader.files.index.get.bind(
                filestoreReader.files.index
            );
            const missingDirectChunkId = `${fileId}:1`;
            let directChunkMisses = 0;
            let preciseChunkSearches = 0;
            let parentChunkSearches = 0;

            (filestoreReader.files.index as any).get = async (
                id: string,
                options: unknown
            ) => {
                if (id === missingDirectChunkId) {
                    directChunkMisses++;
                    return undefined;
                }
                return originalGet(id as never, options as never);
            };

            (filestoreReader.files.index as any).search = async (
                request: { query: unknown | unknown[] },
                options: unknown
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const hasParentId = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "parentId" &&
                        getQueryValue(query) === fileId
                );
                const hasChunkName = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "name" &&
                        getQueryValue(query) === `${fileName}/1`
                );

                if (hasParentId && hasChunkName) {
                    preciseChunkSearches++;
                    return [];
                }
                if (hasParentId) {
                    parentChunkSearches++;
                }

                return originalSearch(request as never, options as never);
            };

            const streamedChunks: Uint8Array[] = [];

            await file!.writeFile(
                filestoreReader,
                {
                    write: async (chunk) => {
                        streamedChunks.push(chunk);
                    },
                },
                { timeout: 15_000 }
            );

            expect(directChunkMisses).to.be.greaterThan(0);
            expect(preciseChunkSearches).to.be.greaterThan(0);
            expect(parentChunkSearches).to.be.greaterThan(0);
            expect(streamedChunks.length).to.be.greaterThan(1);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("waits for all chunk documents before streaming observer downloads", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileId = await filestore.add(
                "observer download waits for full chunk set",
                largeFile
            );

            const filestoreReader = await peer2.open<Files>(filestore.address, {
                args: { replicate: false },
            });
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file = await filestoreReader.files.index.get(fileId);
            expect(file).to.be.instanceOf(LargeFile);
            stripChunkEntryHeads(file);

            const originalSearch = filestoreReader.files.index.search.bind(
                filestoreReader.files.index
            );
            const originalGet = filestoreReader.files.index.get.bind(
                filestoreReader.files.index
            );
            let fetchSearchCalls = 0;
            let partialFetches = 0;
            let directChunkGets = 0;

            (filestoreReader.files.index as any).search = async (
                request: unknown,
                options: unknown
            ) => {
                const results = await originalSearch(
                    request as never,
                    options as never
                );
                const chunkResults = results.filter(
                    (result: unknown) =>
                        result instanceof TinyFile && result.parentId === fileId
                );
                if (chunkResults.length === 0) {
                    return results;
                }

                fetchSearchCalls++;
                if (partialFetches < 2) {
                    partialFetches++;
                    return results.filter(
                        (result: unknown) =>
                            !(
                                result instanceof TinyFile &&
                                result.parentId === fileId &&
                                result.index === 1
                            )
                    );
                }

                return results;
            };

            (filestoreReader.files.index as any).get = async (
                id: string,
                options: unknown
            ) => {
                if (id.startsWith(`${fileId}:`)) {
                    directChunkGets++;
                }
                return originalGet(id as never, options as never);
            };

            const streamedChunks: Uint8Array[] = [];
            await file!.writeFile(filestoreReader, {
                write: async (chunk) => {
                    streamedChunks.push(chunk);
                },
            });

            expect(fetchSearchCalls).to.be.greaterThan(0);
            expect(partialFetches).to.eq(2);
            expect(directChunkGets).to.eq(0);
            expect(streamedChunks.length).to.be.greaterThan(1);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("uses chunk-id lookups when observer chunk searches miss available chunks", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileId = await filestore.add(
                "observer download uses chunk-id lookups",
                largeFile
            );

            const filestoreReader = await peer2.open<Files>(filestore.address, {
                args: { replicate: false },
            });
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file = await filestoreReader.files.index.get(fileId);
            expect(file).to.be.instanceOf(LargeFile);
            stripChunkEntryHeads(file);

            const originalSearch = filestoreReader.files.index.search.bind(
                filestoreReader.files.index
            );
            const originalGet = filestoreReader.files.index.get.bind(
                filestoreReader.files.index
            );
            let parentIdSearchCalls = 0;
            let directChunkGets = 0;

            (filestoreReader.files.index as any).search = async (
                request: unknown,
                options: unknown
            ) => {
                const results = await originalSearch(
                    request as never,
                    options as never
                );
                const chunkResults = results.filter(
                    (result: unknown) =>
                        result instanceof TinyFile && result.parentId === fileId
                );
                if (chunkResults.length === 0) {
                    return results;
                }

                parentIdSearchCalls++;
                return results.filter(
                    (result: unknown) =>
                        !(
                            result instanceof TinyFile &&
                            result.parentId === fileId &&
                            result.index === 1
                        )
                );
            };

            (filestoreReader.files.index as any).get = async (
                id: string,
                options: unknown
            ) => {
                if (id.startsWith(`${fileId}:`)) {
                    directChunkGets++;
                }
                return originalGet(id as never, options as never);
            };

            const streamedChunks: Uint8Array[] = [];
            await file!.writeFile(filestoreReader, {
                write: async (chunk) => {
                    streamedChunks.push(chunk);
                },
            });

            expect(parentIdSearchCalls).to.be.greaterThan(0);
            expect(directChunkGets).to.be.greaterThan(0);
            expect(streamedChunks.length).to.be.greaterThan(1);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("avoids keep-open remote waits for observer chunk downloads", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileId = await filestore.add(
                "observer chunk reads stay stateless",
                largeFile
            );

            const filestoreReader = await peer2.open<Files>(filestore.address, {
                args: { replicate: false },
            });
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file = await filestoreReader.files.index.get(fileId);
            expect(file).to.be.instanceOf(LargeFile);
            stripChunkEntryHeads(file);

            const originalSearch = filestoreReader.files.index.search.bind(
                filestoreReader.files.index
            );
            const originalGet = filestoreReader.files.index.get.bind(
                filestoreReader.files.index
            );
            let observedChunkGets = 0;
            let sawKeepOpenWait = false;
            let sawSelfInHints = false;
            const selfHash = peer2.identity.publicKey.hashcode();

            (filestoreReader.files.index as any).search = async (
                request: unknown,
                options: unknown
            ) => {
                const results = await originalSearch(
                    request as never,
                    options as never
                );
                const chunkResults = results.filter(
                    (result: unknown) =>
                        result instanceof TinyFile && result.parentId === fileId
                );
                if (chunkResults.length === 0) {
                    return results;
                }

                return results.filter(
                    (result: unknown) =>
                        !(
                            result instanceof TinyFile &&
                            result.parentId === fileId &&
                            result.index === 1
                        )
                );
            };

            (filestoreReader.files.index as any).get = async (
                id: string,
                options: {
                    remote?: {
                        wait?: {
                            timeout: number;
                            behavior: string;
                        };
                    };
                }
            ) => {
                if (id.startsWith(`${fileId}:`)) {
                    observedChunkGets++;
                    sawKeepOpenWait ||=
                        options?.remote?.wait?.behavior === "keep-open";
                    sawSelfInHints ||=
                        options?.remote?.from?.includes(selfHash) === true;
                }
                return originalGet(id as never, options as never);
            };

            const streamedChunks: Uint8Array[] = [];
            await file!.writeFile(filestoreReader, {
                write: async (chunk) => {
                    streamedChunks.push(chunk);
                },
            });

            expect(observedChunkGets).to.be.greaterThan(0);
            expect(sawKeepOpenWait).to.be.false;
            expect(sawSelfInHints).to.be.false;
            expect(streamedChunks.length).to.be.greaterThan(1);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("retries transient chunk lookup transport failures", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileName =
                "streamed download with transient transport failures";
            const fileId = await filestore.add(fileName, largeFile);

            const filestoreReader = await peer2.open<Files>(filestore.address);
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file = await filestoreReader.files.index.get(fileId);
            expect(file).to.be.instanceOf(LargeFile);
            stripChunkEntryHeads(file);

            const originalSearch = filestoreReader.files.index.search.bind(
                filestoreReader.files.index
            );
            const originalGet = filestoreReader.files.index.get.bind(
                filestoreReader.files.index
            );
            const transientChunkId = `${fileId}:1`;
            let abortedOnce = false;
            let failedBlockOnce = false;
            let deliveryFailedOnce = false;

            (filestoreReader.files.index as any).search = async (
                request: { query: unknown | unknown[] },
                options: unknown
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const isTransientChunkSearch =
                    queries.some(
                        (query: any) =>
                            getQueryKey(query) === "parentId" &&
                            getQueryValue(query) === fileId
                    ) &&
                    queries.some(
                        (query: any) =>
                            getQueryKey(query) === "name" &&
                            getQueryValue(query) === `${fileName}/1`
                    );

                if (
                    isTransientChunkSearch &&
                    !(abortedOnce && failedBlockOnce && deliveryFailedOnce)
                ) {
                    return [];
                }

                return originalSearch(request as never, options as never);
            };

            (filestoreReader.files.index as any).get = async (
                id: string,
                options: unknown
            ) => {
                if (id === transientChunkId && !abortedOnce) {
                    abortedOnce = true;
                    const error = new Error("fanout channel closed");
                    error.name = "AbortError";
                    throw error;
                }
                if (id === transientChunkId && !failedBlockOnce) {
                    failedBlockOnce = true;
                    throw new Error(
                        "Failed to resolve block: transient-test-block"
                    );
                }
                if (id === transientChunkId && !deliveryFailedOnce) {
                    deliveryFailedOnce = true;
                    throw {
                        name: "DeliveryError",
                        message:
                            "Failed to get message test delivery acknowledges from all nodes (0/1)",
                    };
                }
                return originalGet(id as never, options as never);
            };

            const streamedChunks: Uint8Array[] = [];

            await file!.writeFile(filestoreReader, {
                write: async (chunk) => {
                    streamedChunks.push(chunk);
                },
            });

            expect(abortedOnce).to.be.true;
            expect(failedBlockOnce).to.be.true;
            expect(deliveryFailedOnce).to.be.true;
            expect(streamedChunks.length).to.be.greaterThan(1);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("stores file sizes as u64", () => {
            const size = 5_000_000_000n;
            const largeFile = new LargeFile({
                id: "large",
                name: "large-file",
                size,
                chunkCount: 2,
                ready: true,
            });
            const indexable = new IndexableFile(largeFile);

            const decodedFile = deserialize(serialize(largeFile), LargeFile);
            const decodedIndexable = deserialize(
                serialize(indexable),
                IndexableFile
            );

            expect(decodedFile.size).to.eq(size);
            expect(decodedIndexable.size).to.eq(size);
        });

        it("caps chunk sizes for multi-gigabyte browser sources", async () => {
            const filestore = await peer.open(new Files());
            let requestedChunkSize = 0;
            let error: any;

            try {
                await filestore.addSource("huge-file", {
                    size: 5_000_000_000n,
                    async *readChunks(chunkSize: number) {
                        requestedChunkSize = chunkSize;
                        throw new Error("stop-after-measuring");
                    },
                });
            } catch (caught) {
                error = caught;
            }

            expect(error?.message).to.eq("stop-after-measuring");
            expect(requestedChunkSize).to.eq(512 * 1024);
        });

        it("keeps runner-sized uploads to browser-safe chunks", async () => {
            const filestore = await peer.open(new Files());
            let requestedChunkSize = 0;
            let error: any;

            try {
                await filestore.addSource("runner-sized-file", {
                    size: 512n * 1024n * 1024n,
                    async *readChunks(chunkSize: number) {
                        requestedChunkSize = chunkSize;
                        throw new Error("stop-after-measuring");
                    },
                });
            } catch (caught) {
                error = caught;
            }

            expect(error?.message).to.eq("stop-after-measuring");
            expect(requestedChunkSize).to.eq(512 * 1024);
        });

        it("exposes large file metadata before chunk upload finishes", async () => {
            const filestore = await peer.open(new Files());
            const filestoreReader = await peer2.open<Files>(filestore.address, {
                args: { replicate: false },
            });
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const fileName = "visible-before-finish";
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const originalPut = filestore.files.put.bind(filestore.files);
            let uploadCompleted = false;

            (filestore.files as any).put = async (entry: unknown) => {
                if (entry instanceof TinyFile && entry.parentId != null) {
                    await delay(25);
                }
                return originalPut(entry as never);
            };

            const addPromise = filestore
                .add(fileName, largeFile)
                .finally(() => {
                    uploadCompleted = true;
                });

            await waitForResolved(
                async () => {
                    expect(uploadCompleted).to.be.false;
                    const listed = await filestoreReader.list();
                    expect(listed.some((x) => x.name === fileName)).to.be.true;
                },
                { timeout: 30_000, delayInterval: 200 }
            );

            await addPromise;
        });

        it("waits for ready manifests before reading early-discovered large files", async () => {
            const filestore = await peer.open(new Files());
            const filestoreReader = await peer2.open<Files>(filestore.address, {
                args: { replicate: false },
            });
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const fileName = "read-after-ready";
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const originalPut = filestore.files.put.bind(filestore.files);
            let uploadCompleted = false;
            let uploadId: string | undefined;

            (filestore.files as any).put = async (entry: unknown) => {
                if (entry instanceof LargeFile && !entry.ready) {
                    uploadId = entry.id;
                }
                if (entry instanceof TinyFile && entry.parentId != null) {
                    await delay(250);
                }
                return originalPut(entry as never);
            };

            const addPromise = filestore
                .add(fileName, largeFile)
                .finally(() => {
                    uploadCompleted = true;
                });

            let discoveredFile: LargeFile | undefined;
            await waitForResolved(
                async () => {
                    expect(uploadId).to.be.ok;
                    const match = await filestoreReader.resolveById(uploadId!, {
                        replicate: true,
                        timeout: 1_000,
                    });
                    expect(match).to.be.instanceOf(LargeFile);
                    expect((match as LargeFile).ready).to.be.false;
                    discoveredFile = match as LargeFile;
                },
                { timeout: 30_000, delayInterval: 200 }
            );

            const streamedChunks: Uint8Array[] = [];
            await discoveredFile!.writeFile(filestoreReader, {
                write: async (chunk) => {
                    streamedChunks.push(chunk);
                },
            });

            await addPromise;
            expect(streamedChunks.length).to.be.greaterThan(1);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("prefers ready manifests when listing duplicate large-file roots", async () => {
            const filestore = await peer.open(new Files());
            const uploadId = "duplicate-ready-manifest";
            const pending = new LargeFile({
                id: uploadId,
                name: "duplicate-ready.bin",
                size: 12n * 1024n * 1024n,
                chunkCount: 3,
                ready: false,
            });
            const ready = new LargeFile({
                id: uploadId,
                name: "duplicate-ready.bin",
                size: pending.size,
                chunkCount: pending.chunkCount,
                ready: true,
                finalHash: "ready-hash",
            });
            const originalSearch = filestore.files.index.search.bind(
                filestore.files.index
            );
            let searchCalls = 0;

            (filestore.files.index as any).search = async () => {
                searchCalls++;
                return searchCalls === 1 ? [pending] : [pending, ready];
            };
            try {
                const listed = await filestore.list();
                expect(listed).to.have.length(1);
                expect(listed[0]).to.be.instanceOf(LargeFile);
                expect((listed[0] as LargeFile).ready).to.be.true;
                expect((listed[0] as LargeFile).finalHash).to.eq("ready-hash");
                expect(searchCalls).to.eq(2);
            } finally {
                (filestore.files.index as any).search = originalSearch;
            }
        });

        it("replicates", async () => {
            const filestore = await peer.open(new Files());

            const filestoreReplicator2 = await peer2.open<Files>(
                filestore.address
            );

            let t0 = +new Date();
            const largeFile = crypto.randomBytes(5 * 1e7) as Uint8Array; // 50 mb
            await filestore.add("random large file", largeFile);

            // 96 upload-scoped chunks + 1 root manifest.
            expect(await filestore.files.index.getSize()).to.eq(97); // depends on the chunk size used

            await waitForResolved(async () =>
                expect(await filestoreReplicator2.files.index.getSize()).to.eq(
                    97
                )
            );
        });

        /*  TODO
         it("rejects after retries", async () => {
             // Peer 1 is subscribing to a replication topic (to start helping the network)
             const filestore = await peer.open(new Files());
 
             const largeFile = crypto.randomBytes(1e7); // 50 mb
             await filestore.add("10mb file", largeFile);
 
             const filestoreReader = await peer2.open<Files>(filestore.address, {
                 args: { replicate: false },
             });
             await filestoreReader.files.log.waitForReplicator(
                 peer.identity.publicKey
             );
 
             const results = await filestoreReader.files.index.search(
                 new SearchRequest({
                     query: [
                         new StringMatch({ key: "name", value: "10mb file" }),
                     ],
                 }),
                 {
                     local: true,
                     remote: {
                         timeout: 10 * 1000,
                     },
                 }
             );
             expect(results).to.have.length(1);
             const f0 = results[0] as LargeFile;
             const allChunks = await f0.fetchChunks(filestoreReader);
 
             // We do this step so we can terminate the filestore in the process when chunks are fetched
             f0.fetchChunks = async (_) => {
                 return allChunks;
             };
 
             await peer.stop();
             await expect(() =>
                 f0.getFile(filestoreReader, { timeout: 500, as: "joined" })
             ).rejects.toThrow(
                 "Failed to resolve file. Recieved 0/12 chunks"
             );
         }); */
    });
});
