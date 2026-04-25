import { Peerbit } from "peerbit";
import { Files, IndexableFile, LargeFile, TinyFile } from "../index.js";
import { concat, equals } from "uint8arrays";
import crypto from "crypto";
import { delay, waitForResolved } from "@peerbit/time";
import { sha256Base64Sync } from "@peerbit/crypto";
import { deserialize, serialize } from "@dao-xyz/borsh";
import { expect, describe, it, beforeEach, afterEach } from "vitest";
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

            const addedId = await filestore.add(
                "streamed large blob",
                new Blob([largeFile]),
                undefined,
                (progress) => {
                    addProgress.push(progress);
                }
            );

            const added = await filestore.files.index.get(addedId);
            expect(added).to.be.instanceOf(LargeFile);
            expect((added as LargeFile).finalHash).to.eq(expectedId);
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

            (filestoreReader.files.index as any).search = async (
                request: { query: unknown | unknown[] },
                options: unknown
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const isBulkChunkLookup = queries.some(
                    (query: any) =>
                        query?.key === "parentId" && query?.value === fileId
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
                    directChunkGets++;
                    inflightChunkGets++;
                    maxInflightChunkGets = Math.max(
                        maxInflightChunkGets,
                        inflightChunkGets
                    );
                    await delay(25);
                    inflightChunkGets--;
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
            expect(streamedChunks.length).to.be.greaterThan(1);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("streams observer downloads with bounded direct chunk reads", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileId = await filestore.add(
                "observer download uses bounded direct chunks",
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
            let sawChunkReplicate = false;

            (filestoreReader.files.index as any).search = async (
                request: { query: unknown | unknown[] },
                options: unknown
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const hasParentIdLookup = queries.some((query: any) => {
                    const key = Array.isArray(query?.key)
                        ? query.key[0]
                        : query?.key;
                    return key === "parentId" && query?.value === fileId;
                });
                if (hasParentIdLookup) {
                    parentIdSearches++;
                }

                return originalSearch(request as never, options as never);
            };

            (filestoreReader.files.index as any).get = async (
                id: string,
                options: { remote?: { replicate?: boolean } }
            ) => {
                if (id.startsWith(`${fileId}:`)) {
                    directChunkGets++;
                    sawChunkReplicate ||= options?.remote?.replicate === true;
                    inflightChunkGets++;
                    maxInflightChunkGets = Math.max(
                        maxInflightChunkGets,
                        inflightChunkGets
                    );
                    try {
                        await delay(25);
                        return originalGet(id as never, options as never);
                    } finally {
                        inflightChunkGets--;
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
            expect(maxInflightChunkGets).to.be.lessThanOrEqual(2);
            expect(sawChunkReplicate).to.be.true;
            expect(
                filestoreReader.lastReadDiagnostics?.prefetchedChunkCount
            ).to.eq(0);
            expect(filestoreReader.lastReadDiagnostics?.chunkReadAhead).to.eq(
                2
            );
            expect(
                filestoreReader.lastReadDiagnostics?.maxInFlightChunkReads
            ).to.be.lessThanOrEqual(2);
            expect(streamedChunks.length).to.be.greaterThan(1);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("buffers observer downloads with bounded direct chunk reads", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileId = await filestore.add(
                "observer buffered download uses bounded direct chunks",
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

            const originalSearch = filestoreReader.files.index.search.bind(
                filestoreReader.files.index
            );
            const originalGet = filestoreReader.files.index.get.bind(
                filestoreReader.files.index
            );
            let parentIdSearches = 0;
            let directChunkLookups = 0;
            let inflightChunkGets = 0;
            let maxInflightChunkGets = 0;
            let sawChunkReplicate = false;

            (filestoreReader.files.index as any).search = async (
                request: { query?: unknown | unknown[] },
                options: unknown
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const hasParentIdLookup = queries.some((query: any) => {
                    const key = Array.isArray(query?.key)
                        ? query.key[0]
                        : query?.key;
                    return key === "parentId" && query?.value === fileId;
                });
                if (hasParentIdLookup) {
                    parentIdSearches++;
                }
                return originalSearch(request as never, options as never);
            };

            (filestoreReader.files.index as any).get = async (
                id: string,
                options: { remote?: { replicate?: boolean } }
            ) => {
                if (id.startsWith(`${fileId}:`)) {
                    directChunkLookups++;
                    sawChunkReplicate ||= options?.remote?.replicate === true;
                    inflightChunkGets++;
                    maxInflightChunkGets = Math.max(
                        maxInflightChunkGets,
                        inflightChunkGets
                    );
                    try {
                        await delay(25);
                        return originalGet(id as never, options as never);
                    } finally {
                        inflightChunkGets--;
                    }
                }
                return originalGet(id as never, options as never);
            };

            const bytes = await file!.getFile(filestoreReader, {
                as: "joined",
            });

            expect(parentIdSearches).to.eq(0);
            expect(directChunkLookups).to.be.greaterThan(1);
            expect(maxInflightChunkGets).to.be.greaterThan(1);
            expect(maxInflightChunkGets).to.be.lessThanOrEqual(2);
            expect(sawChunkReplicate).to.be.true;
            expect(
                filestoreReader.lastReadDiagnostics?.prefetchedChunkCount
            ).to.eq(0);
            expect(filestoreReader.lastReadDiagnostics?.chunkReadAhead).to.eq(
                2
            );
            expect(
                filestoreReader.lastReadDiagnostics?.maxInFlightChunkReads
            ).to.be.lessThanOrEqual(2);
            expect(equals(bytes, largeFile)).to.be.true;
        });

        it("prepares observer downloads with temporary chunk replication", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileId = await filestore.add(
                "observer download is prepared through replication",
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
            const release = await filestoreReader.prepareLargeFileDownload(
                file as LargeFile,
                { timeout: 30_000 }
            );

            try {
                expect(
                    await filestoreReader.countLocalChunks(file as LargeFile)
                ).to.eq((file as LargeFile).chunkCount);
                expect(
                    filestoreReader.lastDownloadPreparationDiagnostics
                        ?.lastLocalChunkCount
                ).to.eq((file as LargeFile).chunkCount);

                const bytes = await file!.getFile(filestoreReader, {
                    as: "joined",
                });
                expect(equals(bytes, largeFile)).to.be.true;
            } finally {
                await release();
            }

            expect(
                filestoreReader.lastDownloadPreparationDiagnostics
                    ?.cleanupFinishedAt
            ).to.be.a("number");
        });

        it("waits for replicated chunks before local streaming", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileId = await filestore.add(
                "replicator download waits for local chunks",
                largeFile
            );

            const filestoreReader = await peer2.open<Files>(filestore.address, {
                args: { replicate: { factor: 1 } },
            });
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file = await filestoreReader.files.index.get(fileId);
            expect(file).to.be.instanceOf(LargeFile);

            await filestoreReader.waitForLocalChunks(file as LargeFile, {
                timeout: 60_000,
            });

            expect(
                await filestoreReader.countLocalChunks(file as LargeFile)
            ).to.eq((file as LargeFile).chunkCount);
            expect(
                filestoreReader.lastDownloadPreparationDiagnostics?.mode
            ).to.eq("local-chunks");
            expect(
                filestoreReader.lastDownloadPreparationDiagnostics
                    ?.lastLocalChunkCount
            ).to.eq((file as LargeFile).chunkCount);

            const streamedChunks: Uint8Array[] = [];
            await file!.writeFile(filestoreReader, {
                write: async (chunk) => {
                    streamedChunks.push(chunk);
                },
            });
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

            const originalGet = filestoreReader.files.index.get.bind(
                filestoreReader.files.index
            );
            let observedChunkGets = 0;
            let sawKeepOpenWait = false;
            let sawSelfInHints = false;
            let sawChunkReplicate = false;
            const selfHash = peer2.identity.publicKey.hashcode();

            (filestoreReader.files.index as any).get = async (
                id: string,
                options: {
                    remote?: {
                        wait?: {
                            timeout: number;
                            behavior: string;
                        };
                        from?: string[];
                        replicate?: boolean;
                    };
                }
            ) => {
                if (id.startsWith(`${fileId}:`)) {
                    observedChunkGets++;
                    sawKeepOpenWait ||=
                        options?.remote?.wait?.behavior === "keep-open";
                    sawSelfInHints ||=
                        options?.remote?.from?.includes(selfHash) === true;
                    sawChunkReplicate ||= options?.remote?.replicate === true;
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
            expect(sawChunkReplicate).to.be.true;
            expect(streamedChunks.length).to.be.greaterThan(1);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("retries transient chunk lookup aborts", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileId = await filestore.add(
                "streamed download with transient abort",
                largeFile
            );

            const filestoreReader = await peer2.open<Files>(filestore.address);
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file = await filestoreReader.files.index.get(fileId);
            expect(file).to.be.instanceOf(LargeFile);

            const originalGet = filestoreReader.files.index.get.bind(
                filestoreReader.files.index
            );
            const transientChunkId = `${fileId}:1`;
            let abortedOnce = false;

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
                return originalGet(id as never, options as never);
            };

            const streamedChunks: Uint8Array[] = [];

            await file!.writeFile(filestoreReader, {
                write: async (chunk) => {
                    streamedChunks.push(chunk);
                },
            });

            expect(abortedOnce).to.be.true;
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

        it("scales chunk sizes for multi-gigabyte sources", async () => {
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
            expect(requestedChunkSize).to.be.greaterThan(500_000);
            expect(requestedChunkSize).to.be.greaterThan(4_000_000);
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
