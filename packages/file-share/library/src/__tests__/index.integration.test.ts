import { Peerbit } from "peerbit";
import {
    AbstractFile,
    Files,
    IndexableFile,
    LargeFile,
    LargeFileWithChunkHeads,
    ParentedLargeFileWithChunkHeads,
    TINY_FILE_WRITE_SIZE_LIMIT_BYTES,
    TinyFile,
    type UploadDiagnostics,
    isLargeFileLike,
} from "../index.js";
import { concat, equals } from "uint8arrays";
import crypto from "crypto";
import { delay, TimeoutError, waitForResolved } from "@peerbit/time";
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

const uploadLargeThrough = (
    filestore: Files,
    path: "bytes" | "source",
    name: string,
    bytes: Uint8Array
) =>
    path === "bytes"
        ? filestore.add(name, bytes)
        : filestore.addSource(name, {
              size: BigInt(bytes.byteLength),
              readChunks: async function* () {
                  yield bytes;
              },
          });

const UPLOAD_PROGRESS_BASIS_POINTS = Array.from(
    { length: 21 },
    (_, index) => index * 500
);

const getExpectedUploadProgressTargetBytes = (
    sizeBytes: number,
    basisPoints: number
) => Number((BigInt(sizeBytes) * BigInt(basisPoints) + 9_999n) / 10_000n);

const expectUploadProgressPrefix = (diagnostics: UploadDiagnostics) => {
    const telemetry = diagnostics.progressTelemetry;
    expect(telemetry).to.deep.include({
        schemaVersion: 1,
        kind: "upload-chunk-commit",
        clock: "unix-epoch-ms",
    });
    const milestones = telemetry!.milestones;
    expect(milestones.length).to.be.within(
        1,
        UPLOAD_PROGRESS_BASIS_POINTS.length
    );
    expect(milestones.map((value) => value.basisPoints)).to.deep.eq(
        UPLOAD_PROGRESS_BASIS_POINTS.slice(0, milestones.length)
    );
    expect(milestones[0]).to.deep.eq({
        basisPoints: 0,
        targetBytes: 0,
        completedBytes: 0,
        reachedAt: diagnostics.startedAt,
        chunkIndex: null,
    });
    for (let index = 1; index < milestones.length; index++) {
        const milestone = milestones[index];
        const previous = milestones[index - 1];
        expect(milestone.targetBytes).to.eq(
            getExpectedUploadProgressTargetBytes(
                diagnostics.sizeBytes,
                milestone.basisPoints
            )
        );
        expect(milestone.completedBytes).to.be.greaterThanOrEqual(
            milestone.targetBytes
        );
        expect(milestone.completedBytes).to.be.lessThanOrEqual(
            diagnostics.sizeBytes
        );
        expect(milestone.completedBytes - milestone.targetBytes).to.be.lessThan(
            diagnostics.chunkSize
        );
        expect(milestone.completedBytes).to.be.greaterThanOrEqual(
            previous.completedBytes
        );
        expect(milestone.reachedAt).to.be.greaterThanOrEqual(
            previous.reachedAt
        );
        expect(Number.isInteger(milestone.chunkIndex)).to.be.true;
        expect(milestone.chunkIndex!).to.be.within(
            0,
            diagnostics.chunkCount - 1
        );
    }
    return milestones;
};

const expectCompleteUploadProgress = (diagnostics: UploadDiagnostics) => {
    const milestones = expectUploadProgressPrefix(diagnostics);
    expect(milestones).to.have.length(UPLOAD_PROGRESS_BASIS_POINTS.length);
    expect(milestones.at(-1)).to.deep.include({
        basisPoints: 10_000,
        targetBytes: diagnostics.sizeBytes,
        completedBytes: diagnostics.sizeBytes,
        reachedAt: diagnostics.lastChunkFinishedAt,
    });
    return milestones;
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

    it("lists compact local chunk ids across replacement and deletion", async () => {
        const filestore = await peer.open(new Files());
        const parentId = "local-chunk-id-snapshot";
        const changes: Array<{
            added: AbstractFile[];
            removed: AbstractFile[];
        }> = [];
        filestore.files.events.addEventListener("change", (event) => {
            changes.push(event.detail);
        });
        const parent = new LargeFile({
            id: parentId,
            name: "snapshot",
            size: 4n,
            chunkCount: 4,
            ready: false,
        });
        const first = new TinyFile({
            name: "snapshot/0",
            file: new Uint8Array([1]),
            parentId,
            index: 0,
        });
        const second = new TinyFile({
            name: "snapshot/1",
            file: new Uint8Array([2]),
            parentId,
            index: 1,
        });
        const nestedTiny = new TinyFile({
            id: "local-chunk-id-snapshot:nested-tiny",
            name: "snapshot/nested-tiny",
            file: new Uint8Array([3]),
            parentId,
        });
        const nestedLarge = new ParentedLargeFileWithChunkHeads({
            id: "local-chunk-id-snapshot:nested-large",
            name: "snapshot/nested-large",
            size: 1n,
            chunkCount: 0,
            ready: true,
            parentId,
        });
        const exactIdTinyWithoutIndex = new TinyFile({
            id: `${parentId}:2`,
            name: "snapshot/exact-id-without-index",
            file: new Uint8Array([4]),
            parentId,
        });
        const exactIdWrongType = new ParentedLargeFileWithChunkHeads({
            id: `${parentId}:3`,
            name: "snapshot/exact-id-wrong-type",
            size: 1n,
            chunkCount: 0,
            ready: true,
            parentId,
        });
        const outOfRange = new TinyFile({
            name: "snapshot/4",
            file: new Uint8Array([5]),
            parentId,
            index: parent.chunkCount,
        });

        await filestore.files.put(parent);
        await filestore.files.put(first);
        await filestore.files.put(second);
        await filestore.files.put(nestedTiny);
        await filestore.files.put(nestedLarge);
        await filestore.files.put(exactIdTinyWithoutIndex);
        await filestore.files.put(exactIdWrongType);
        await filestore.files.put(outOfRange);
        const occupiedSlotIds = [
            first.id,
            second.id,
            exactIdTinyWithoutIndex.id,
            exactIdWrongType.id,
        ];
        expect(
            (await filestore.listLocalChunkIds(parent)).sort()
        ).to.deep.equal(occupiedSlotIds.sort());

        changes.length = 0;
        await filestore.files.put(
            new TinyFile({
                id: first.id,
                name: first.name,
                file: new Uint8Array([3]),
                parentId,
                index: 0,
            })
        );
        expect(changes).to.have.length(1);
        expect(changes[0].added).to.have.length(1);
        expect(changes[0].removed).to.be.empty;
        expect(changes[0].added[0]).to.be.instanceOf(TinyFile);
        expect(changes[0].added[0]).to.include({
            id: first.id,
            parentId,
        });
        expect(
            (await filestore.listLocalChunkIds(parent)).sort()
        ).to.deep.equal(occupiedSlotIds.sort());

        changes.length = 0;
        await filestore.files.del(nestedTiny.id);
        expect(changes).to.have.length(1);
        expect(changes[0].removed[0]).to.be.instanceOf(TinyFile);
        expect(changes[0].removed[0]).to.include({
            id: nestedTiny.id,
            parentId,
            index: undefined,
        });
        expect(
            (await filestore.listLocalChunkIds(parent)).sort()
        ).to.deep.equal(occupiedSlotIds.sort());

        changes.length = 0;
        await filestore.files.del(nestedLarge.id);
        expect(changes).to.have.length(1);
        expect(changes[0].removed[0]).to.be.instanceOf(
            ParentedLargeFileWithChunkHeads
        );
        expect(
            (await filestore.listLocalChunkIds(parent)).sort()
        ).to.deep.equal(occupiedSlotIds.sort());

        changes.length = 0;
        await filestore.files.del(exactIdTinyWithoutIndex.id);
        expect(changes).to.have.length(1);
        expect(changes[0].removed[0]).to.be.instanceOf(TinyFile);
        expect(
            (await filestore.listLocalChunkIds(parent)).sort()
        ).to.deep.equal([first.id, second.id, exactIdWrongType.id].sort());

        changes.length = 0;
        await filestore.files.del(exactIdWrongType.id);
        expect(changes).to.have.length(1);
        expect(changes[0].removed[0]).to.be.instanceOf(
            ParentedLargeFileWithChunkHeads
        );
        expect(
            (await filestore.listLocalChunkIds(parent)).sort()
        ).to.deep.equal([first.id, second.id].sort());

        changes.length = 0;
        await filestore.files.del(second.id);
        expect(changes).to.have.length(1);
        expect(changes[0].added).to.be.empty;
        expect(changes[0].removed).to.have.length(1);
        expect(changes[0].removed[0]).to.be.instanceOf(TinyFile);
        expect(changes[0].removed[0]).to.include({
            id: second.id,
            parentId,
        });
        expect(await filestore.listLocalChunkIds(parent)).to.deep.equal([
            first.id,
        ]);
    });

    it("removes a remote-only root through a non-replicating observer", async () => {
        const writer = await peer.open(new Files());
        const fileId = await writer.add(
            "remote-only observer removal",
            new Uint8Array([1, 2, 3])
        );
        const reader = await peer2.open<Files>(writer.address, {
            args: { replicate: false },
        });
        await reader.files.log.waitForReplicator(peer.identity.publicKey);

        expect(
            await reader.files.index.get(fileId, {
                local: true,
                remote: false,
            })
        ).to.be.undefined;

        const originalSearch = reader.files.index.search.bind(
            reader.files.index
        );
        const originalDelete = reader.files.del.bind(reader.files);
        let exactRemoteOptions: any;
        let localHeadAtDelete: string | undefined;
        (reader.files.index as any).search = async (
            request: any,
            options: any
        ) => {
            const queries = Array.isArray(request.query)
                ? request.query
                : [request.query];
            if (
                queries.some(
                    (query: any) =>
                        getQueryKey(query) === "id" &&
                        getQueryValue(query) === fileId
                )
            ) {
                exactRemoteOptions = options;
            }
            return originalSearch(request, options);
        };
        (reader.files as any).del = async (id: string, ...args: any[]) => {
            const local = await reader.files.index.get(id, {
                local: true,
                remote: false,
            });
            localHeadAtDelete = (local as any)?.__context?.head;
            return (originalDelete as any)(id, ...args);
        };

        try {
            await reader.removeById(fileId);
        } finally {
            (reader.files.index as any).search = originalSearch;
            (reader.files as any).del = originalDelete;
        }

        expect(localHeadAtDelete).to.be.a("string");
        expect(exactRemoteOptions?.local).to.be.false;
        expect(exactRemoteOptions?.remote?.replicate).to.be.true;
        expect(exactRemoteOptions?.remote?.throwOnMissing).to.be.true;
        expect(exactRemoteOptions?.remote?.from).to.deep.eq([
            peer.identity.publicKey.hashcode(),
        ]);
        expect(
            await reader.files.index.get(fileId, {
                local: true,
                remote: false,
            })
        ).to.be.undefined;
        await waitForResolved(async () => {
            expect(
                await writer.files.index.get(fileId, {
                    local: true,
                    remote: false,
                })
            ).to.be.undefined;
        });
    });

    it("keeps public nested tiny files across restart state and removal", async () => {
        const filestore = await peer.open(new Files());
        const parentId = await filestore.add(
            "nested parent",
            new Uint8Array([1])
        );
        const nestedBytes = new Uint8Array([2, 3]);
        const nestedId = await filestore.add(
            "public nested tiny",
            nestedBytes,
            parentId
        );
        const nested = (await filestore.files.index.get(nestedId, {
            local: true,
            remote: false,
        })) as TinyFile;
        const nestedHead = (nested as any).__context.head as string;
        const nestedEntry = await filestore.files.log.log.get(nestedHead);

        expect(nested).to.be.instanceOf(TinyFile);
        expect(nested.parentId).to.eq(parentId);
        expect(nested.index).to.be.undefined;

        const reader = await peer2.open<Files>(filestore.address);
        await reader.files.log.waitForReplicator(peer.identity.publicKey);
        await reader.files.index.get(nestedId, {
            local: true,
            remote: {
                timeout: 10_000,
                throwOnMissing: false,
                replicate: true,
            },
        } as any);
        await waitForResolved(async () => {
            const local = await reader.files.index.get(nestedId, {
                local: true,
                remote: false,
            });
            expect((local as any)?.__context?.head).to.eq(nestedHead);
        });
        (reader as any).clearFileRuntimeState();
        expect(await (reader as any).shouldKeepFileEntry(nestedEntry)).to.be
            .true;
        expect(
            (reader as any).retainedEntryHeadsByFileId.get(nestedId)
        ).to.deep.eq(new Set([nestedHead]));
        expect((reader as any).retainedChunkIds.has(nestedId)).to.be.false;

        // Runtime retention maps are intentionally empty after a restart. The
        // current authored document must rebuild ownership under its own id,
        // not be subjected to LargeFile chunk validation under its parent.
        (filestore as any).clearFileRuntimeState();
        expect(await (filestore as any).shouldKeepFileEntry(nestedEntry)).to.be
            .true;
        expect(
            (filestore as any).retainedEntryHeadsByFileId.get(nestedId)
        ).to.deep.eq(new Set([nestedHead]));
        expect((filestore as any).retainedEntryHeadsByFileId.has(parentId)).to
            .be.false;
        expect((filestore as any).retainedChunkIds.has(nestedId)).to.be.false;

        await filestore.removeById(nestedId);

        expect(
            await filestore.files.index.get(nestedId, {
                local: true,
                remote: false,
            })
        ).to.be.undefined;
        expect(
            await filestore.files.index.get(parentId, {
                local: true,
                remote: false,
            })
        ).not.to.be.undefined;
        expect((filestore as any).retainedChunkEntryHeads.has(nestedHead)).to.be
            .false;
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
        it("round-trips every legacy and nested file variant without changing its bytes", () => {
            const variants: Array<{
                value: AbstractFile;
                type: new (...args: any[]) => AbstractFile;
            }> = [
                {
                    value: new TinyFile({
                        id: "variant-zero",
                        name: "variant-zero.bin",
                        file: new Uint8Array([1, 2, 3]),
                        parentId: "legacy-parent",
                        index: 7,
                    }),
                    type: TinyFile,
                },
                {
                    value: new LargeFile({
                        id: "variant-one",
                        name: "variant-one.bin",
                        size: 1n,
                        chunkCount: 1,
                        ready: true,
                        finalHash: "legacy-hash",
                    }),
                    type: LargeFile,
                },
                {
                    value: new LargeFileWithChunkHeads({
                        id: "variant-two",
                        name: "variant-two.bin",
                        size: 1n,
                        chunkCount: 1,
                        ready: true,
                        finalHash: "legacy-head-hash",
                        chunkEntryHeads: ["legacy-head"],
                    }),
                    type: LargeFileWithChunkHeads,
                },
                {
                    value: new ParentedLargeFileWithChunkHeads({
                        id: "variant-three",
                        name: "variant-three.bin",
                        size: 1n,
                        chunkCount: 1,
                        ready: true,
                        finalHash: "nested-head-hash",
                        chunkEntryHeads: ["nested-head"],
                        parentId: "nested-parent",
                    }),
                    type: ParentedLargeFileWithChunkHeads,
                },
            ];

            for (const { value, type } of variants) {
                const encoded = serialize(value);
                const decoded = deserialize(encoded, AbstractFile);
                expect(decoded).to.be.instanceOf(type);
                expect(equals(serialize(decoded), encoded)).to.be.true;
            }
        });

        it("keeps the exact 4 MiB cutoff in TinyFile and chunks only larger roots", async () => {
            const filestore = await peer.open(new Files());
            const parentId = await filestore.add(
                "cutoff parent",
                new Uint8Array([1])
            );
            const exact = new Uint8Array(TINY_FILE_WRITE_SIZE_LIMIT_BYTES);
            const exactId = await filestore.add(
                "exact cutoff nested",
                exact,
                parentId
            );
            const exactStored = await filestore.files.index.get(exactId, {
                local: true,
                remote: false,
            });
            expect(exactStored).to.be.instanceOf(TinyFile);
            expect(exactStored?.parentId).to.eq(parentId);

            const over = new Uint8Array(TINY_FILE_WRITE_SIZE_LIMIT_BYTES + 1);
            const overId = await filestore.add("over cutoff root", over);
            const overStored = await filestore.files.index.get(overId, {
                local: true,
                remote: false,
            });
            expect(overStored).to.be.instanceOf(LargeFileWithChunkHeads);
            expect(overStored?.parentId).to.be.undefined;
            expect((overStored as LargeFile).ready).to.be.true;
        });

        it.each(["bytes", "blob", "source"] as const)(
            "preserves parentId for chunked %s uploads above the tiny-file budget",
            async (uploadPath) => {
                const filestore = await peer.open(new Files());
                const parentId = await filestore.add(
                    "chunked upload parent",
                    new Uint8Array([1])
                );
                const bytes = new Uint8Array(
                    TINY_FILE_WRITE_SIZE_LIMIT_BYTES + 1
                );
                for (let index = 0; index < bytes.byteLength; index++) {
                    bytes[index] = index % 251;
                }
                const name = `nested chunked ${uploadPath}`;
                const fileId =
                    uploadPath === "bytes"
                        ? await filestore.add(name, bytes, parentId)
                        : uploadPath === "blob"
                          ? await filestore.addBlob(
                                name,
                                new Blob([bytes]),
                                parentId
                            )
                          : await filestore.addSource(
                                name,
                                {
                                    size: BigInt(bytes.byteLength),
                                    readChunks: async function* () {
                                        yield bytes;
                                    },
                                },
                                parentId
                            );

                const stored = await filestore.files.index.get(fileId, {
                    local: true,
                    remote: false,
                });
                expect(stored).to.be.instanceOf(
                    ParentedLargeFileWithChunkHeads
                );
                expect(stored!.parentId).to.eq(parentId);
                expect(isLargeFileLike(stored)).to.be.true;
                expect((stored as LargeFile).ready).to.be.true;
                expect((stored as LargeFile).chunkCount).to.be.greaterThan(1);

                const decoded = deserialize(serialize(stored!), AbstractFile);
                expect(decoded).to.be.instanceOf(
                    ParentedLargeFileWithChunkHeads
                );
                expect(decoded.parentId).to.eq(parentId);

                const listed = await filestore.list();
                expect(listed.some((file) => file.id === parentId)).to.be.true;
                expect(listed.some((file) => file.id === fileId)).to.be.false;
                const fetched = await filestore.getById(fileId);
                expect(fetched?.name).to.eq(name);
                expect(equals(fetched!.bytes, bytes)).to.be.true;
            }
        );

        it("applies list replication policy to root and ready-root searches", async () => {
            const filestore = await peer.open(new Files());
            const fileId = "list-replication-policy";
            const pending = new LargeFile({
                id: fileId,
                name: "list-replication-policy.bin",
                size: 1n,
                chunkCount: 1,
                ready: false,
            });
            const ready = new LargeFile({
                id: fileId,
                name: pending.name,
                size: pending.size,
                chunkCount: pending.chunkCount,
                ready: true,
                finalHash: sha256Base64Sync(new Uint8Array([1])),
            });
            const originalSearch = filestore.files.index.search.bind(
                filestore.files.index
            );
            const searchOptions: any[] = [];
            (filestore.files.index as any).search = async (
                _request: unknown,
                options: any
            ) => {
                searchOptions.push(options);
                return searchOptions.length % 2 === 1 ? [pending] : [ready];
            };

            const expectListReplication = async (
                expected: boolean,
                options?: { replicate?: boolean }
            ) => {
                const firstCall = searchOptions.length;
                const listed = await filestore.list(options);
                expect(listed).to.deep.eq([ready]);
                const calls = searchOptions.slice(firstCall);
                expect(calls).to.have.length(2);
                expect(calls.map((call) => call.remote.replicate)).to.deep.eq([
                    expected,
                    expected,
                ]);
            };

            try {
                filestore.persistChunkReads = true;
                await expectListReplication(false, { replicate: false });

                filestore.persistChunkReads = false;
                await expectListReplication(false);

                filestore.persistChunkReads = true;
                await expectListReplication(true);
            } finally {
                (filestore.files.index as any).search = originalSearch;
            }
        });

        it("keeps only current or pending self-authored puts and signed deletes", async () => {
            const filestore = await peer.open(new Files());
            const fileId = "self-authored-pruning";
            const first = await filestore.files.put(
                new TinyFile({
                    id: fileId,
                    name: "self-authored-pruning-first.bin",
                    file: new Uint8Array([1]),
                })
            );

            expect(await (filestore as any).shouldKeepFileEntry(first.entry)).to
                .be.true;

            const second = await filestore.files.put(
                new TinyFile({
                    id: fileId,
                    name: "self-authored-pruning-second.bin",
                    file: new Uint8Array([2]),
                })
            );
            (filestore as any).pendingAuthoredDocumentIds.set(fileId, 1);
            expect(await (filestore as any).shouldKeepFileEntry(first.entry)).to
                .be.true;
            (filestore as any).pendingAuthoredDocumentIds.delete(fileId);
            expect(await (filestore as any).shouldKeepFileEntry(first.entry)).to
                .be.false;
            expect(await (filestore as any).shouldKeepFileEntry(second.entry))
                .to.be.true;

            const deleted = await filestore.files.del(fileId);
            expect(await (filestore as any).shouldKeepFileEntry(second.entry))
                .to.be.false;
            expect(await (filestore as any).shouldKeepFileEntry(deleted.entry))
                .to.be.true;

            // Simulate a restart where all in-memory retention maps and release
            // tombstones are empty. The index is still the source of truth.
            (filestore as any).clearFileRuntimeState();
            expect(await (filestore as any).shouldKeepFileEntry(first.entry)).to
                .be.false;
            expect(await (filestore as any).shouldKeepFileEntry(second.entry))
                .to.be.false;
            expect(await (filestore as any).shouldKeepFileEntry(deleted.entry))
                .to.be.true;

            const readded = await filestore.files.put(
                new TinyFile({
                    id: fileId,
                    name: "self-authored-pruning-readded.bin",
                    file: new Uint8Array([3]),
                })
            );
            expect(await (filestore as any).shouldKeepFileEntry(readded.entry))
                .to.be.true;
            expect(await (filestore as any).shouldKeepFileEntry(second.entry))
                .to.be.false;
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
            await reader.files.log.waitForReplicator(peer.identity.publicKey);
            await waitForResolved(async () => {
                const current = await reader.files.index.get(retainedChunkId, {
                    resolve: false,
                    local: true,
                    remote: false,
                } as any);
                expect((current as any)?.__context?.head).to.eq(retainedHead);
            });

            expect(await (reader as any).shouldKeepFileEntry(retainedEntry)).to
                .be.true;
        });

        it("keeps exact manifest blocks without chunk index rows during adaptive pruning", async () => {
            const writer = await peer.open(new Files());
            const fileId = "retained-exact-manifest-blocks";
            const fileName = "retained-exact-manifest-blocks.bin";
            const chunks = [
                new Uint8Array([1, 2]),
                new Uint8Array([3, 4]),
                new Uint8Array([5, 6]),
            ];
            const chunkEntryHeads: string[] = [];
            for (const [index, bytes] of chunks.entries()) {
                const result = await writer.files.put(
                    new TinyFile({
                        id: `${fileId}:${index}`,
                        name: `${fileName}/${index}`,
                        file: bytes,
                        parentId: fileId,
                        index,
                    })
                );
                chunkEntryHeads[index] = result.entry.hash;
            }
            const expected = concat(chunks);
            const manifest = new LargeFileWithChunkHeads({
                id: fileId,
                name: fileName,
                size: BigInt(expected.byteLength),
                chunkCount: chunks.length,
                ready: true,
                finalHash: sha256Base64Sync(expected),
                chunkEntryHeads,
            });
            await writer.files.put(manifest);

            const reader = await peer2.open<Files>(writer.address, {
                args: { replicate: false },
            });
            reader.persistChunkReads = true;
            await reader.files.log.waitForReplicator(peer.identity.publicKey);
            const localManifest = await reader.resolveById(fileId, {
                timeout: 10_000,
                replicate: true,
                from: [peer.identity.publicKey.hashcode()],
                wait: false,
            });
            if (!isLargeFileLike(localManifest)) {
                throw new Error("Failed to materialize the ready manifest");
            }
            expect(await reader.countLocalChunks(localManifest)).to.eq(0);

            const roundTrip = await localManifest.getFile(reader, {
                as: "joined",
                timeout: 10_000,
            });
            expect(equals(roundTrip, expected)).to.be.true;
            expect(await reader.countLocalChunks(localManifest)).to.eq(0);
            expect(await reader.countLocalChunkBlocks(localManifest)).to.eq(
                chunks.length
            );

            (reader.files.log.log.entryIndex as any).cache.clear();
            const originalLogGet = reader.files.log.log.get.bind(
                reader.files.log.log
            );
            let retainedEntryReads = 0;
            (reader.files.log.log as any).get = async (
                hash: string,
                options: unknown
            ) => {
                if (chunkEntryHeads.includes(hash)) {
                    retainedEntryReads += 1;
                }
                return originalLogGet(hash as never, options as never);
            };
            try {
                for (const head of chunkEntryHeads) {
                    expect(
                        await (reader as any).shouldKeepFileEntry({
                            hash: head,
                        })
                    ).to.be.true;
                }
            } finally {
                (reader.files.log.log as any).get = originalLogGet;
            }
            expect(retainedEntryReads).to.eq(0);
            expect(await reader.countLocalChunkBlocks(localManifest)).to.eq(
                chunks.length
            );

            // Runtime ownership maps are intentionally cleared on close. The
            // durable root manifest must rebuild them before a post-restart
            // rebalance can prune sparse exact blocks.
            (reader as any).clearFileRuntimeState();
            expect((reader as any).retainedChunkEntryHeads.size).to.eq(0);
            (reader.files.log.log.entryIndex as any).cache.clear();
            const originalIndexGet = reader.files.index.get.bind(
                reader.files.index
            );
            (reader.files.index as any).get = async (
                id: unknown,
                options: unknown
            ) => {
                if (id === `${fileId}:0`) {
                    throw new Error("transient child index failure");
                }
                return originalIndexGet(id as never, options as never);
            };
            try {
                expect(
                    await (reader as any).shouldKeepFileEntry({
                        hash: chunkEntryHeads[0],
                    })
                ).to.be.true;
            } finally {
                (reader.files.index as any).get = originalIndexGet;
            }
            for (const head of chunkEntryHeads.slice(1)) {
                expect(
                    await (reader as any).shouldKeepFileEntry({ hash: head })
                ).to.be.true;
            }
            for (const head of chunkEntryHeads) {
                expect((reader as any).retainedChunkEntryHeads.has(head)).to.be
                    .true;
            }
            expect(await reader.countLocalChunkBlocks(localManifest)).to.eq(
                chunks.length
            );

            const replacementBytes = new Uint8Array([9, 10]);
            const replacementChunkPut = await reader.files.put(
                new TinyFile({
                    id: `${fileId}:0`,
                    name: `${fileName}/0`,
                    file: replacementBytes,
                    parentId: fileId,
                    index: 0,
                })
            );
            await reader.files.put(
                new LargeFileWithChunkHeads({
                    id: fileId,
                    name: fileName,
                    size: BigInt(replacementBytes.byteLength),
                    chunkCount: 1,
                    ready: true,
                    finalHash: sha256Base64Sync(replacementBytes),
                    chunkEntryHeads: [replacementChunkPut.entry.hash],
                })
            );
            for (const head of chunkEntryHeads) {
                expect(
                    await (reader as any).shouldKeepFileEntry({ hash: head })
                ).to.be.false;
                expect((reader as any).retainedChunkEntryHeads.has(head)).to.be
                    .false;
            }
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
            expect(
                syncOptions?.priority?.({ wallTime: 20n })
            ).to.be.greaterThan(syncOptions?.priority?.({ wallTime: 10n }));
        });

        it("keeps ready root manifests during adaptive pruning", async () => {
            const writer = await peer.open(new Files());
            const reader = await peer2.open<Files>(writer.address);
            await reader.files.log.waitForReplicator(peer.identity.publicKey);
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
            await waitForResolved(async () => {
                const current = await reader.files.index.get(readyRoot.id, {
                    resolve: false,
                    local: true,
                    remote: false,
                } as any);
                expect((current as any)?.__context?.head).to.eq(
                    appended.entry.hash
                );
            });

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

        it("retries exact child cleanup after the root deletion commits", async () => {
            const filestore = await peer.open(new Files());
            const fileId = await filestore.add(
                "retry child cleanup",
                new Uint8Array(5_000_001)
            );
            const ready = await filestore.files.index.get(fileId, {
                local: true,
                remote: false,
            });
            expect(isLargeFileLike(ready)).to.be.true;
            const chunkCount = (ready as LargeFile).chunkCount;
            const failedChunkId = `${fileId}:1`;
            const originalDelete = filestore.files.del.bind(filestore.files);
            let rootDeleteCommitted = false;
            let rejectedChildDelete = false;

            (filestore.files as any).del = async (
                id: string,
                ...args: any[]
            ) => {
                if (id === fileId) {
                    const result = await (originalDelete as any)(id, ...args);
                    rootDeleteCommitted = true;
                    return result;
                }
                if (id === failedChunkId && !rejectedChildDelete) {
                    expect(rootDeleteCommitted).to.be.true;
                    rejectedChildDelete = true;
                    throw new Error("injected child delete failure");
                }
                return (originalDelete as any)(id, ...args);
            };

            try {
                await expect(filestore.removeById(fileId)).rejects.toThrow(
                    "injected child delete failure"
                );
            } finally {
                (filestore.files as any).del = originalDelete;
            }

            expect(rootDeleteCommitted).to.be.true;
            expect(rejectedChildDelete).to.be.true;
            expect(
                await filestore.files.index.get(fileId, {
                    local: true,
                    remote: false,
                })
            ).to.be.undefined;
            expect(
                await filestore.files.index.get(failedChunkId, {
                    local: true,
                    remote: false,
                })
            ).not.to.be.undefined;
            expect((filestore as any).pendingLargeFileDeletions.has(fileId)).to
                .be.true;

            await filestore.removeById(fileId);

            for (let index = 0; index < chunkCount; index++) {
                expect(
                    await filestore.files.index.get(`${fileId}:${index}`, {
                        local: true,
                        remote: false,
                    })
                ).to.be.undefined;
            }
            expect((filestore as any).retainedChunkIdsByFileId.has(fileId)).to
                .be.false;
            expect((filestore as any).retainedEntryHeadsByFileId.has(fileId)).to
                .be.false;
            expect((filestore as any).pendingLargeFileDeletions.has(fileId)).to
                .be.false;
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
            expect(isLargeFileLike(added)).to.be.true;
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
                if (isLargeFileLike(entry) && entry.ready === false) {
                    pendingHead = result.entry.hash;
                }
                if (isLargeFileLike(entry) && entry.ready === true) {
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
                expect(isLargeFileLike(listedFile)).to.be.true;
                expect((listedFile as LargeFile).ready).to.be.true;
                expect(
                    filestore.lastUploadDiagnostics?.readyManifestFinishedAt
                ).to.be.a("number");
            } finally {
                (filestore.files as any).put = originalPut;
            }
        });

        it("acknowledges only the ready manifest and succeeds without peers", async () => {
            const disconnectedPeer = await Peerbit.create();
            try {
                const filestore = await disconnectedPeer.open(new Files());
                const originalPut = filestore.files.put.bind(filestore.files);
                const observedPuts: Array<{
                    value: AbstractFile;
                    options: any;
                }> = [];
                let readySignalWasAborted: boolean | undefined;

                (filestore.files as any).put = async (
                    value: AbstractFile,
                    ...args: any[]
                ) => {
                    observedPuts.push({ value, options: args[0] });
                    if (isLargeFileLike(value) && value.ready) {
                        readySignalWasAborted =
                            args[0]?.delivery?.signal?.aborted;
                    }
                    return (originalPut as any)(value, ...args);
                };

                let fileId: string;
                try {
                    const bytes = new Uint8Array(5_000_001);
                    bytes[bytes.length - 1] = 11;
                    fileId = await uploadLargeThrough(
                        filestore,
                        "source",
                        "ready delivery without peers",
                        bytes
                    );
                } finally {
                    (filestore.files as any).put = originalPut;
                }

                const deliveryPuts = observedPuts.filter(
                    ({ options }) => options?.delivery != null
                );
                expect(deliveryPuts).to.have.length(1);
                expect(isLargeFileLike(deliveryPuts[0].value)).to.be.true;
                expect((deliveryPuts[0].value as LargeFile).ready).to.be.true;
                const { signal, ...delivery } =
                    deliveryPuts[0].options.delivery;
                expect(delivery).to.deep.eq({
                    reliability: "ack",
                    minAcks: 1,
                    requireRecipients: false,
                    timeout: 5_000,
                });
                expect(signal).to.be.instanceOf(AbortSignal);
                expect(readySignalWasAborted).to.be.false;

                const localReady = await filestore.files.index.get(fileId!, {
                    local: true,
                    remote: false,
                });
                expect(isLargeFileLike(localReady)).to.be.true;
                expect((localReady as LargeFile).ready).to.be.true;
            } finally {
                await disconnectedPeer.stop();
            }
        });

        it("aborts a stale ready delivery wait without discarding its local commit", async () => {
            const filestore = await peer.open(new Files());
            const controller = new AbortController();
            const bytes = new Uint8Array(5_000_001);
            bytes[bytes.length - 1] = 13;
            const originalPut = filestore.files.put.bind(filestore.files);
            let uploadId: string | undefined;
            let deliverySignal: AbortSignal | undefined;
            let rejectStaleDelivery: ((reason: unknown) => void) | undefined;
            let markReadyCommitted!: () => void;
            const readyCommitted = new Promise<void>((resolve) => {
                markReadyCommitted = resolve;
            });

            (filestore.files as any).put = async (
                value: AbstractFile,
                ...args: any[]
            ) => {
                if (!isLargeFileLike(value) || !value.ready) {
                    return (originalPut as any)(value, ...args);
                }

                uploadId = value.id;
                const options = args[0];
                deliverySignal = options.delivery.signal;
                const result = await (originalPut as any)(value, {
                    ...options,
                    delivery: false,
                });
                markReadyCommitted();
                await new Promise<never>((_resolve, reject) => {
                    rejectStaleDelivery = reject;
                    const rejectAborted = () =>
                        reject(
                            deliverySignal?.reason ??
                                new Error("Ready delivery was aborted")
                        );
                    if (deliverySignal!.aborted) {
                        rejectAborted();
                    } else {
                        deliverySignal!.addEventListener(
                            "abort",
                            rejectAborted,
                            { once: true }
                        );
                    }
                });
                return result;
            };

            const upload = filestore.addSource(
                "stale ready delivery",
                {
                    size: BigInt(bytes.byteLength),
                    readChunks: async function* () {
                        yield bytes;
                    },
                },
                { signal: controller.signal }
            );

            try {
                await Promise.race([
                    readyCommitted,
                    delay(3_000).then(() => {
                        throw new Error(
                            "Ready manifest did not commit before abort test"
                        );
                    }),
                ]);
                expect(deliverySignal?.aborted).to.be.false;
                expect(deliverySignal).not.to.eq(controller.signal);
                controller.abort(new Error("cancel stale ready delivery"));
                await expect(
                    Promise.race([
                        upload,
                        delay(1_000).then(() => {
                            throw new Error(
                                "Upload did not observe the delivery abort"
                            );
                        }),
                    ])
                ).rejects.toThrow("cancel stale ready delivery");

                expect(deliverySignal?.aborted).to.be.true;
                const localReady = await filestore.files.index.get(uploadId!, {
                    local: true,
                    remote: false,
                });
                expect(isLargeFileLike(localReady)).to.be.true;
                expect((localReady as LargeFile).ready).to.be.true;
            } finally {
                controller.abort();
                rejectStaleDelivery?.(
                    new Error("Release stale ready delivery test gate")
                );
                await Promise.race([
                    upload.catch(() => undefined),
                    delay(1_000),
                ]);
                (filestore.files as any).put = originalPut;
            }
        });

        it("waits for a connected transport ACK while the remote indexes ready", async () => {
            const writer = await peer.open(new Files());
            const reader = await peer2.open<Files>(writer.address);
            await writer.files.log.waitForReplicator(peer2.identity.publicKey);

            const pendingFile = new LargeFile({
                id: "ready-ack-contract",
                name: "ready ACK contract",
                size: 0n,
                chunkCount: 0,
                ready: false,
            });
            const pendingPut = await (writer as any).putAuthoredFile(
                pendingFile
            );
            await waitForResolved(
                async () => {
                    const remotePending = await reader.files.index.get(
                        pendingFile.id,
                        { local: true, remote: false }
                    );
                    expect(isLargeFileLike(remotePending)).to.be.true;
                    expect((remotePending as LargeFile).ready).to.be.false;
                },
                { timeout: 3_000, delayInterval: 25 }
            );
            const readyFile = new LargeFileWithChunkHeads({
                id: pendingFile.id,
                name: pendingFile.name,
                size: pendingFile.size,
                chunkCount: pendingFile.chunkCount,
                ready: true,
                finalHash: sha256Base64Sync(new Uint8Array()),
                chunkEntryHeads: [],
            });

            const writerRpc: any = writer.files.log.rpc;
            const writerPubsub: any = peer.services.pubsub;
            const remotePubsub: any = peer2.services.pubsub;
            const originalWriterSend = writerRpc.send.bind(writerRpc);
            const originalWriterPublish =
                writerPubsub.publishMessage.bind(writerPubsub);
            const originalRemotePublish =
                remotePubsub.publishMessage.bind(remotePubsub);
            const remoteHash = peer2.identity.publicKey.hashcode();
            const readyMessageIds = new Set<string>();
            const toBase64 = (value: Uint8Array) =>
                Buffer.from(value).toString("base64");
            const controller = new AbortController();
            let commit: Promise<void> | undefined;
            let commitResolved = false;
            let readyCommitInFlight = false;
            let readyRpcSendCount = 0;
            let releaseAcks!: () => void;
            let markReadyMessageSent!: () => void;
            let markAckAttempted!: () => void;
            let markRemoteReadyIndexed!: () => void;
            const ackGate = new Promise<void>((resolve) => {
                releaseAcks = resolve;
            });
            const readyMessageSent = new Promise<void>((resolve) => {
                markReadyMessageSent = resolve;
            });
            const ackAttempted = new Promise<void>((resolve) => {
                markAckAttempted = resolve;
            });
            const remoteReadyIndexed = new Promise<void>((resolve) => {
                markRemoteReadyIndexed = resolve;
            });
            const onReaderChange = (event: any) => {
                if (
                    event.detail.added.some(
                        (value: AbstractFile) =>
                            value.id === readyFile.id &&
                            isLargeFileLike(value) &&
                            value.ready
                    )
                ) {
                    markRemoteReadyIndexed();
                }
            };
            reader.files.events.addEventListener("change", onReaderChange);

            writerRpc.send = async (...args: any[]) => {
                if (!readyCommitInFlight) {
                    return originalWriterSend(...args);
                }
                readyRpcSendCount += 1;
                try {
                    return await originalWriterSend(...args);
                } finally {
                    readyRpcSendCount -= 1;
                }
            };
            writerPubsub.publishMessage = async (...args: any[]) => {
                const message = args[1];
                const mode = message?.header?.mode;
                if (
                    readyRpcSendCount > 0 &&
                    message?.id instanceof Uint8Array &&
                    message?.hasData === true &&
                    Array.isArray(mode?.to) &&
                    Array.isArray(mode?.hops) &&
                    mode.to.includes(remoteHash)
                ) {
                    readyMessageIds.add(toBase64(message.id));
                    markReadyMessageSent();
                }
                return originalWriterPublish(...args);
            };
            remotePubsub.publishMessage = async (...args: any[]) => {
                const message = args[1];
                const acknowledgedId = message?.messageIdToAcknowledge;
                if (
                    acknowledgedId instanceof Uint8Array &&
                    Number.isInteger(message?.seenCounter) &&
                    readyMessageIds.has(toBase64(acknowledgedId))
                ) {
                    markAckAttempted();
                    await ackGate;
                }
                return originalRemotePublish(...args);
            };

            try {
                readyCommitInFlight = true;
                commit = (writer as any)
                    .commitReadyManifest(
                        pendingFile,
                        pendingPut,
                        readyFile,
                        controller.signal
                    )
                    .then(() => {
                        commitResolved = true;
                    })
                    .finally(() => {
                        readyCommitInFlight = false;
                    });
                await Promise.race([
                    Promise.all([
                        readyMessageSent,
                        ackAttempted,
                        remoteReadyIndexed,
                    ]),
                    delay(3_000).then(() => {
                        throw new Error(
                            "Ready manifest ACK/index evidence was not observed"
                        );
                    }),
                ]);
                expect([...readyMessageIds]).to.have.length(1);
                const remoteReady = await reader.files.index.get(readyFile.id, {
                    local: true,
                    remote: false,
                });
                expect(isLargeFileLike(remoteReady)).to.be.true;
                expect((remoteReady as LargeFile).ready).to.be.true;
                expect(commitResolved).to.be.false;

                // Stream ACKs mean a selected remote transport received and
                // verified the ready head. They are emitted before Files
                // indexing, so this is healthy-path propagation evidence, not
                // a remote-index or durable-replication guarantee.
                releaseAcks();
                await Promise.race([
                    commit,
                    delay(3_000).then(() => {
                        throw new Error(
                            "Ready manifest commit did not observe its ACK"
                        );
                    }),
                ]);
                expect(commitResolved).to.be.true;
            } finally {
                releaseAcks();
                controller.abort();
                await Promise.race([
                    commit?.catch(() => undefined) ?? Promise.resolve(),
                    delay(1_000),
                ]);
                reader.files.events.removeEventListener(
                    "change",
                    onReaderChange
                );
                writerRpc.send = originalWriterSend;
                writerPubsub.publishMessage = originalWriterPublish;
                remotePubsub.publishMessage = originalRemotePublish;
            }
        });

        for (const uploadPath of ["bytes", "source"] as const) {
            it(`does not leave a pending ${uploadPath} root after a precommit put rejection`, async () => {
                const filestore = await peer.open(new Files());
                const bytes = new Uint8Array(5_000_001);
                const originalPut = filestore.files.put.bind(filestore.files);
                const originalDelete = filestore.files.del.bind(
                    filestore.files
                );
                let uploadId: string | undefined;
                let rootDeleteCalls = 0;

                (filestore.files as any).put = async (
                    value: AbstractFile,
                    ...args: any[]
                ) => {
                    if (isLargeFileLike(value) && !value.ready) {
                        uploadId = value.id;
                        throw new Error("pending put rejected before commit");
                    }
                    return (originalPut as any)(value, ...args);
                };
                (filestore.files as any).del = async (
                    id: string,
                    ...args: any[]
                ) => {
                    if (id === uploadId) {
                        rootDeleteCalls += 1;
                    }
                    return (originalDelete as any)(id, ...args);
                };

                try {
                    await expect(
                        uploadLargeThrough(
                            filestore,
                            uploadPath,
                            `precommit pending ${uploadPath}`,
                            bytes
                        )
                    ).rejects.toThrow("pending put rejected before commit");
                } finally {
                    (filestore.files as any).put = originalPut;
                    (filestore.files as any).del = originalDelete;
                }

                expect(uploadId).to.be.a("string");
                expect(rootDeleteCalls).to.eq(0);
                expect(
                    await filestore.files.index.get(uploadId!, {
                        local: true,
                        remote: false,
                    })
                ).to.be.undefined;
            });

            it(`cleans a committed pending ${uploadPath} root when put rejects`, async () => {
                const filestore = await peer.open(new Files());
                const bytes = new Uint8Array(5_000_001);
                const originalPut = filestore.files.put.bind(filestore.files);
                let uploadId: string | undefined;

                (filestore.files as any).put = async (
                    value: AbstractFile,
                    ...args: any[]
                ) => {
                    const result = await (originalPut as any)(value, ...args);
                    if (isLargeFileLike(value) && !value.ready) {
                        uploadId = value.id;
                        throw new Error("pending put rejected after commit");
                    }
                    return result;
                };

                try {
                    await expect(
                        uploadLargeThrough(
                            filestore,
                            uploadPath,
                            `postcommit pending ${uploadPath}`,
                            bytes
                        )
                    ).rejects.toThrow("pending put rejected after commit");
                } finally {
                    (filestore.files as any).put = originalPut;
                }

                expect(uploadId).to.be.a("string");
                expect(
                    await filestore.files.index.get(uploadId!, {
                        local: true,
                        remote: false,
                    })
                ).to.be.undefined;
                expect(
                    (filestore as any).retainedEntryHeadsByFileId.has(uploadId)
                ).to.be.false;
                expect(
                    (filestore as any).retainedLargeFileChunkCounts.has(
                        uploadId
                    )
                ).to.be.false;
            });

            it(`recovers a locally committed ready ${uploadPath} manifest when delivery times out`, async () => {
                const filestore = await peer.open(new Files());
                const bytes = new Uint8Array(5_000_001);
                bytes[bytes.length - 1] = 7;
                const originalPut = filestore.files.put.bind(filestore.files);
                let timedOutReadyDelivery = false;
                let readyDeliverySignalWasAborted: boolean | undefined;
                let pendingHead: string | undefined;

                (filestore.files as any).put = async (
                    value: AbstractFile,
                    ...args: any[]
                ) => {
                    const result = await (originalPut as any)(value, ...args);
                    if (isLargeFileLike(value) && !value.ready) {
                        pendingHead = result.entry.hash;
                    }
                    if (
                        isLargeFileLike(value) &&
                        value.ready &&
                        !timedOutReadyDelivery
                    ) {
                        readyDeliverySignalWasAborted =
                            args[0]?.delivery?.signal?.aborted;
                        timedOutReadyDelivery = true;
                        throw new TimeoutError(
                            "Timeout waiting for ready manifest delivery"
                        );
                    }
                    return result;
                };

                let uploadId: string;
                try {
                    uploadId = await uploadLargeThrough(
                        filestore,
                        uploadPath,
                        `postcommit ready ${uploadPath}`,
                        bytes
                    );
                } finally {
                    (filestore.files as any).put = originalPut;
                }

                const ready = await filestore.files.index.get(uploadId!, {
                    local: true,
                    remote: false,
                });
                expect(timedOutReadyDelivery).to.be.true;
                expect(readyDeliverySignalWasAborted).to.be.false;
                expect(isLargeFileLike(ready)).to.be.true;
                expect((ready as LargeFile).ready).to.be.true;
                expect((ready as LargeFile).finalHash).to.eq(
                    sha256Base64Sync(bytes)
                );
                const retainedHeads = (
                    filestore as any
                ).retainedEntryHeadsByFileId.get(uploadId) as Set<string>;
                expect(retainedHeads).to.contain((ready as any).__context.head);
                expect(retainedHeads).not.to.contain(pendingHead);
            });

            it(`cancels a ${uploadPath} upload deleted before its ready commit`, async () => {
                const filestore = await peer.open(new Files());
                const bytes = new Uint8Array(5_000_001);
                const originalCommit = (
                    filestore as any
                ).commitReadyManifest.bind(filestore);
                let uploadId: string | undefined;
                let releaseCommit!: () => void;
                let markCommitReached!: () => void;
                const commitGate = new Promise<void>((resolve) => {
                    releaseCommit = resolve;
                });
                const commitReached = new Promise<void>((resolve) => {
                    markCommitReached = resolve;
                });

                (filestore as any).commitReadyManifest = async (
                    pendingFile: LargeFile,
                    ...args: any[]
                ) => {
                    uploadId = pendingFile.id;
                    markCommitReached();
                    await commitGate;
                    return originalCommit(pendingFile, ...args);
                };

                try {
                    const upload = uploadLargeThrough(
                        filestore,
                        uploadPath,
                        `delete-before-ready ${uploadPath}`,
                        bytes
                    );
                    await commitReached;
                    const chunkIds = [
                        ...(((filestore as any).retainedChunkIdsByFileId.get(
                            uploadId
                        ) as Set<string> | undefined) ?? []),
                    ];
                    expect(chunkIds.length).to.be.greaterThan(0);

                    await filestore.removeById(uploadId!);
                    releaseCommit();
                    await expect(upload).rejects.toThrow(
                        "cancelled or superseded before ready manifest commit"
                    );

                    expect(
                        await filestore.files.index.get(uploadId!, {
                            local: true,
                            remote: false,
                        })
                    ).to.be.undefined;
                    for (const chunkId of chunkIds) {
                        expect(
                            await filestore.files.index.get(chunkId, {
                                local: true,
                                remote: false,
                            })
                        ).to.be.undefined;
                    }
                    expect(
                        (filestore as any).retainedEntryHeadsByFileId.has(
                            uploadId
                        )
                    ).to.be.false;
                    expect(
                        (filestore as any).retainedChunkIdsByFileId.has(
                            uploadId
                        )
                    ).to.be.false;
                    expect(
                        (filestore as any).retainedLargeFileChunkCounts.has(
                            uploadId
                        )
                    ).to.be.false;
                } finally {
                    releaseCommit();
                    (filestore as any).commitReadyManifest = originalCommit;
                }
            });

            it(`preserves a pending replacement that supersedes a ${uploadPath} upload`, async () => {
                const filestore = await peer.open(new Files());
                const bytes = new Uint8Array(5_000_001);
                const originalCommit = (
                    filestore as any
                ).commitReadyManifest.bind(filestore);
                const originalCleanup = (
                    filestore as any
                ).cleanupChunkedUpload.bind(filestore);
                let pendingFile: LargeFile | undefined;
                let releaseCommit!: () => void;
                let markCommitReached!: () => void;
                let cleanupCalls = 0;
                const commitGate = new Promise<void>((resolve) => {
                    releaseCommit = resolve;
                });
                const commitReached = new Promise<void>((resolve) => {
                    markCommitReached = resolve;
                });

                (filestore as any).commitReadyManifest = async (
                    candidate: LargeFile,
                    ...args: any[]
                ) => {
                    pendingFile = candidate;
                    markCommitReached();
                    await commitGate;
                    return originalCommit(candidate, ...args);
                };
                (filestore as any).cleanupChunkedUpload = async (
                    ...args: any[]
                ) => {
                    cleanupCalls += 1;
                    return originalCleanup(...args);
                };

                try {
                    const upload = uploadLargeThrough(
                        filestore,
                        uploadPath,
                        `superseded-before-ready ${uploadPath}`,
                        bytes
                    );
                    await commitReached;
                    const replacement = new LargeFile({
                        id: pendingFile!.id,
                        name: `replacement ${uploadPath}`,
                        size: pendingFile!.size,
                        chunkCount: pendingFile!.chunkCount,
                        ready: false,
                    });
                    const replacementPut = await (
                        filestore as any
                    ).putAuthoredFile(replacement);
                    const replacementChunk = new TinyFile({
                        name: `replacement ${uploadPath}/owned`,
                        file: new Uint8Array([9]),
                        parentId: replacement.id,
                        index: replacement.chunkCount + 10,
                    });
                    const replacementChunkPut = await (
                        filestore as any
                    ).putAuthoredFile(replacementChunk);

                    releaseCommit();
                    await expect(upload).rejects.toThrow(
                        "cancelled or superseded before ready manifest commit"
                    );

                    expect(cleanupCalls).to.eq(0);
                    const current = await filestore.files.index.get(
                        replacement.id,
                        { local: true, remote: false }
                    );
                    expect((current as any)?.__context?.head).to.eq(
                        replacementPut.entry.hash
                    );
                    expect((current as LargeFile).name).to.eq(
                        `replacement ${uploadPath}`
                    );
                    expect(
                        await filestore.files.index.get(replacementChunk.id, {
                            local: true,
                            remote: false,
                        })
                    ).not.to.be.undefined;
                    expect(
                        (filestore as any).retainedChunkEntryHeads
                    ).to.contain(replacementChunkPut.entry.hash);
                    expect(
                        (filestore as any).retainedEntryHeadsByFileId.get(
                            replacement.id
                        )
                    ).to.contain(replacementPut.entry.hash);
                } finally {
                    releaseCommit();
                    (filestore as any).commitReadyManifest = originalCommit;
                    (filestore as any).cleanupChunkedUpload = originalCleanup;
                }
            });

            it(`preserves a replacement inserted after failed ${uploadPath} root proof`, async () => {
                const filestore = await peer.open(new Files());
                const bytes = new Uint8Array(5_000_001);
                bytes[bytes.length - 1] = 4;
                const originalCommit = (
                    filestore as any
                ).commitReadyManifest.bind(filestore);
                const originalCleanup = (
                    filestore as any
                ).cleanupChunkedUpload.bind(filestore);
                let replacementRootHead: string | undefined;
                let replacementChunkHead: string | undefined;
                let failedChunkHeads: string[] = [];

                (filestore as any).commitReadyManifest = async () => {
                    throw new Error(`forced ${uploadPath} ready failure`);
                };
                (filestore as any).cleanupChunkedUpload = async (
                    uploadId: string,
                    expectedChunkCount: number,
                    chunkEntryHeads: string[]
                ) => {
                    failedChunkHeads = [...chunkEntryHeads];
                    const replacementChunk = new TinyFile({
                        id: `${uploadId}:0`,
                        name: `replacement after proof ${uploadPath}/0`,
                        file: new Uint8Array([7, 8, 9]),
                        parentId: uploadId,
                        index: 0,
                    });
                    const replacementChunkPut = await (
                        filestore as any
                    ).putAuthoredFile(replacementChunk);
                    replacementChunkHead = replacementChunkPut.entry.hash;
                    const replacementRoot = new LargeFileWithChunkHeads({
                        id: uploadId,
                        name: `replacement after proof ${uploadPath}`,
                        size: 3n,
                        chunkCount: 1,
                        ready: true,
                        finalHash: sha256Base64Sync(replacementChunk.file),
                        chunkEntryHeads: [replacementChunkHead!],
                    });
                    const replacementRootPut = await (
                        filestore as any
                    ).putAuthoredFile(replacementRoot);
                    replacementRootHead = replacementRootPut.entry.hash;
                    return originalCleanup(
                        uploadId,
                        expectedChunkCount,
                        chunkEntryHeads
                    );
                };

                try {
                    await expect(
                        uploadLargeThrough(
                            filestore,
                            uploadPath,
                            `replacement after proof ${uploadPath}`,
                            bytes
                        )
                    ).rejects.toThrow(`forced ${uploadPath} ready failure`);
                } finally {
                    (filestore as any).commitReadyManifest = originalCommit;
                    (filestore as any).cleanupChunkedUpload = originalCleanup;
                }

                const uploadId = filestore.lastUploadDiagnostics!.uploadId;
                const currentRoot = await filestore.files.index.get(uploadId, {
                    local: true,
                    remote: false,
                });
                const currentChunk = await filestore.files.index.get(
                    `${uploadId}:0`,
                    { local: true, remote: false }
                );
                expect(failedChunkHeads.length).to.be.greaterThan(0);
                expect(failedChunkHeads).not.to.contain(replacementChunkHead);
                expect((currentRoot as any)?.__context?.head).to.eq(
                    replacementRootHead
                );
                expect((currentChunk as any)?.__context?.head).to.eq(
                    replacementChunkHead
                );
                expect((filestore as any).retainedChunkEntryHeads).to.contain(
                    replacementRootHead
                );
                expect((filestore as any).retainedChunkEntryHeads).to.contain(
                    replacementChunkHead
                );
                expect((filestore as any).retainedChunkIds).to.contain(
                    `${uploadId}:0`
                );
                expect(
                    (filestore as any).retainedLargeFileChunkCounts.get(
                        uploadId
                    )
                ).to.eq(1);
            });
        }

        it("serializes a ready commit that wins against concurrent deletion", async () => {
            const filestore = await peer.open(new Files());
            const bytes = new Uint8Array(5_000_001);
            const originalPut = filestore.files.put.bind(filestore.files);
            let readyId: string | undefined;
            let releaseReadyPut!: () => void;
            let markReadyPutStarted!: () => void;
            const readyPutGate = new Promise<void>((resolve) => {
                releaseReadyPut = resolve;
            });
            const readyPutStarted = new Promise<void>((resolve) => {
                markReadyPutStarted = resolve;
            });

            (filestore.files as any).put = async (
                value: AbstractFile,
                ...args: any[]
            ) => {
                if (isLargeFileLike(value) && value.ready) {
                    readyId = value.id;
                    markReadyPutStarted();
                    await readyPutGate;
                }
                return (originalPut as any)(value, ...args);
            };

            try {
                const upload = filestore.add(
                    "ready-commit-wins-delete-race",
                    bytes
                );
                await readyPutStarted;
                let deleteFinished = false;
                const deletion = filestore.removeById(readyId!).then(() => {
                    deleteFinished = true;
                });
                await Promise.resolve();
                expect(deleteFinished).to.be.false;

                releaseReadyPut();
                expect(await upload).to.eq(readyId);
                await deletion;
                expect(
                    await filestore.files.index.get(readyId!, {
                        local: true,
                        remote: false,
                    })
                ).to.be.undefined;
                expect((filestore as any).fileMutationTails.has(readyId)).to.be
                    .false;
            } finally {
                releaseReadyPut();
                (filestore.files as any).put = originalPut;
            }
        });

        it("preserves a byte-identical pending replacement when the original put rejects", async () => {
            const filestore = await peer.open(new Files());
            const bytes = new Uint8Array(5_000_001);
            const originalPut = filestore.files.put.bind(filestore.files);
            const originalDelete = filestore.files.del.bind(filestore.files);
            const originalCleanup = (
                filestore as any
            ).cleanupChunkedUpload.bind(filestore);
            let originalHead: string | undefined;
            let replacementHead: string | undefined;
            let uploadId: string | undefined;
            let deleteCalls = 0;
            let cleanupCalls = 0;

            (filestore.files as any).put = async (
                value: AbstractFile,
                ...args: any[]
            ) => {
                const result = await (originalPut as any)(value, ...args);
                if (isLargeFileLike(value) && !value.ready) {
                    uploadId = value.id;
                    originalHead = result.entry.hash;
                    const replacement = new LargeFile({
                        id: value.id,
                        name: value.name,
                        size: value.size,
                        chunkCount: value.chunkCount,
                        ready: false,
                    });
                    replacementHead = (await originalPut(replacement)).entry
                        .hash;
                    filestore.retainChunkEntryHead(
                        "replacement-retention-sentinel",
                        value.id,
                        value.id
                    );
                    throw new Error(
                        "original pending put rejected after replacement"
                    );
                }
                return result;
            };
            (filestore.files as any).del = async (
                id: string,
                ...args: any[]
            ) => {
                deleteCalls += 1;
                return (originalDelete as any)(id, ...args);
            };
            (filestore as any).cleanupChunkedUpload = async (
                ...args: any[]
            ) => {
                cleanupCalls += 1;
                return originalCleanup(...args);
            };

            try {
                await expect(
                    filestore.add("identical pending replacement", bytes)
                ).rejects.toThrow(
                    "original pending put rejected after replacement"
                );
            } finally {
                (filestore.files as any).put = originalPut;
                (filestore.files as any).del = originalDelete;
                (filestore as any).cleanupChunkedUpload = originalCleanup;
            }

            expect(originalHead).to.be.a("string");
            expect(replacementHead).to.be.a("string");
            expect(replacementHead).not.to.eq(originalHead);
            expect(deleteCalls).to.eq(0);
            expect(cleanupCalls).to.eq(0);
            const current = await filestore.files.index.get(uploadId!, {
                local: true,
                remote: false,
            });
            expect((current as any)?.__context?.head).to.eq(replacementHead);
            expect(isLargeFileLike(current)).to.be.true;
            expect((current as LargeFile).ready).to.be.false;
            expect((filestore as any).retainedChunkEntryHeads).to.contain(
                "replacement-retention-sentinel"
            );
        });

        it("cleans a failed upload when root deletion rejects after commit", async () => {
            const filestore = await peer.open(new Files());
            const originalDelete = filestore.files.del.bind(filestore.files);
            let deletedRootId: string | undefined;

            (filestore.files as any).del = async (
                id: string,
                ...args: any[]
            ) => {
                deletedRootId = id;
                await (originalDelete as any)(id, ...args);
                throw new Error("root delete delivery failed after commit");
            };

            try {
                await expect(
                    filestore.addSource("postcommit failed upload delete", {
                        size: 5_000_001n,
                        readChunks: async function* () {
                            yield new Uint8Array(5_000_002);
                        },
                    })
                ).rejects.toThrow("Source size changed during upload");
            } finally {
                (filestore.files as any).del = originalDelete;
            }

            expect(deletedRootId).to.eq(
                filestore.lastUploadDiagnostics?.uploadId
            );
            expect(
                await filestore.files.index.get(deletedRootId!, {
                    local: true,
                    remote: false,
                })
            ).to.be.undefined;
            expect(
                (filestore as any).retainedEntryHeadsByFileId.has(deletedRootId)
            ).to.be.false;
        });

        it("preserves a concurrent ready replacement after failed-upload deletion rejects", async () => {
            const filestore = await peer.open(new Files());
            const originalPut = filestore.files.put.bind(filestore.files);
            const originalDelete = filestore.files.del.bind(filestore.files);
            let replacementHead: string | undefined;

            (filestore.files as any).del = async (id: string) => {
                const pending = (await filestore.files.index.get(id, {
                    local: true,
                    remote: false,
                })) as LargeFile;
                const replacement = new LargeFileWithChunkHeads({
                    id,
                    name: pending.name,
                    size: pending.size,
                    chunkCount: pending.chunkCount,
                    ready: true,
                    finalHash: "concurrent-ready-replacement",
                    chunkEntryHeads: [],
                });
                const put = await originalPut(replacement);
                replacementHead = put.entry.hash;
                throw new Error("delete lost to concurrent replacement");
            };

            try {
                await expect(
                    filestore.addSource("replacement after failed upload", {
                        size: 5_000_001n,
                        readChunks: async function* () {
                            yield new Uint8Array(5_000_002);
                        },
                    })
                ).rejects.toThrow("Source size changed during upload");
            } finally {
                (filestore.files as any).put = originalPut;
                (filestore.files as any).del = originalDelete;
            }

            const uploadId = filestore.lastUploadDiagnostics!.uploadId;
            const current = await filestore.files.index.get(uploadId, {
                local: true,
                remote: false,
            });
            expect((current as any)?.__context?.head).to.eq(replacementHead);
            expect(isLargeFileLike(current)).to.be.true;
            expect((current as LargeFile).ready).to.be.true;
            expect((current as LargeFile).finalHash).to.eq(
                "concurrent-ready-replacement"
            );
        });

        it("preserves a concurrent replacement when ready-manifest put rejects", async () => {
            const filestore = await peer.open(new Files());
            const bytes = new Uint8Array(5_000_001);
            const originalPut = filestore.files.put.bind(filestore.files);
            let replacementHead: string | undefined;
            let injected = false;

            (filestore.files as any).put = async (
                value: AbstractFile,
                ...args: any[]
            ) => {
                const result = await (originalPut as any)(value, ...args);
                if (isLargeFileLike(value) && value.ready && !injected) {
                    injected = true;
                    const replacement = new LargeFileWithChunkHeads({
                        id: value.id,
                        name: "newer ready replacement",
                        size: value.size,
                        chunkCount: value.chunkCount,
                        ready: true,
                        finalHash: "newer-ready-hash",
                        chunkEntryHeads: [],
                    });
                    replacementHead = (await originalPut(replacement)).entry
                        .hash;
                    throw new Error("ready put lost to replacement");
                }
                return result;
            };

            try {
                await expect(
                    filestore.add("ready replacement race", bytes)
                ).rejects.toThrow("ready put lost to replacement");
            } finally {
                (filestore.files as any).put = originalPut;
            }

            const uploadId = filestore.lastUploadDiagnostics!.uploadId;
            const current = await filestore.files.index.get(uploadId, {
                local: true,
                remote: false,
            });
            expect((current as any)?.__context?.head).to.eq(replacementHead);
            expect((current as LargeFile).name).to.eq(
                "newer ready replacement"
            );
            expect((current as LargeFile).finalHash).to.eq("newer-ready-hash");
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

            expect(isLargeFileLike(file)).to.be.true;

            await file!.writeFile(filestoreReader, {
                write: async (chunk) => {
                    streamedChunks.push(chunk);
                },
            });

            expect(streamedChunks.length).to.be.greaterThan(1);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("pins persisted large-file range metadata before scanning chunks", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileId = await filestore.add(
                "pinned streamed download",
                largeFile
            );
            const file = (await filestore.files.index.get(fileId)) as LargeFile;
            const retainedChunkCounts = (filestore as any)
                .retainedLargeFileChunkCounts as Map<string, number>;
            retainedChunkCounts.clear();
            const countLocalChunks = filestore.countLocalChunks.bind(filestore);
            let rangePinnedBeforeChunkScan = false;

            (filestore as any).countLocalChunks = (candidate: LargeFile) => {
                rangePinnedBeforeChunkScan =
                    retainedChunkCounts.get(candidate.id) ===
                    candidate.chunkCount;
                return countLocalChunks(candidate);
            };

            try {
                await file.writeFile(filestore, {
                    write: async () => {},
                });
            } finally {
                (filestore as any).countLocalChunks = countLocalChunks;
            }

            expect(rangePinnedBeforeChunkScan).to.be.true;
            expect(retainedChunkCounts.get(file.id)).to.eq(file.chunkCount);
        });

        it("does not read ahead or retain listeners behind a suspended consumer", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(20 * 1e6) as Uint8Array;
            const fileId = await filestore.add(
                "cancelled streamed download",
                largeFile
            );
            const file = (await filestore.files.index.get(fileId)) as LargeFile;
            const chunkEntryHeads = (file as any).chunkEntryHeads as string[];
            expect(chunkEntryHeads).to.have.length(file.chunkCount);
            const log = filestore.files.log.log as any;
            const getManyOwner =
                typeof log.getMany === "function" ? log : log.entryIndex;
            const originalGetManyMethod = getManyOwner?.getMany;
            expect(originalGetManyMethod).to.be.a("function");
            const originalGetMany = originalGetManyMethod.bind(getManyOwner);
            let localBatchCalls = 0;
            let highestRequestedChunkIndex = -1;

            getManyOwner.getMany = async (
                requestedHeads: string[],
                options: any
            ) => {
                const requestedIndices = requestedHeads
                    .map((head) => chunkEntryHeads.indexOf(head))
                    .filter((index) => index >= 0);
                for (const index of requestedIndices) {
                    highestRequestedChunkIndex = Math.max(
                        highestRequestedChunkIndex,
                        index
                    );
                }
                if (options.remote === false) {
                    localBatchCalls += 1;
                }
                return originalGetMany(requestedHeads, options);
            };

            const stream = file.streamFile(filestore)[Symbol.asyncIterator]();
            try {
                const first = await stream.next();
                expect(first.done).to.be.false;
                const second = await stream.next();
                expect(second.done).to.be.false;
                expect((filestore as any).activeFileChangeSignals.size).to.eq(
                    0
                );
                const callsWhileSuspended = localBatchCalls;
                await delay(50);
                expect(localBatchCalls).to.eq(callsWhileSuspended);

                const returnStartedAt = Date.now();
                await stream.return?.();
                expect(Date.now() - returnStartedAt).to.be.lessThan(500);
                expect((filestore as any).activeFileChangeSignals.size).to.eq(
                    0
                );

                const callsAfterReturn = localBatchCalls;
                await delay(350);
                expect(localBatchCalls).to.eq(callsAfterReturn);
                expect(localBatchCalls).to.eq(1);
                expect(file.chunkCount).to.be.greaterThan(33);
                expect(highestRequestedChunkIndex).to.be.lessThan(
                    file.chunkCount
                );
                expect((filestore as any).activeFileChangeSignals.size).to.eq(
                    0
                );
            } finally {
                await stream.return?.();
                getManyOwner.getMany = originalGetManyMethod;
            }
        });

        it("cancels a bulk chunk fetch when the Files program closes", async () => {
            const filestore = await peer.open(new Files());
            const file = new LargeFile({
                id: "closing-bulk-fetch",
                name: "closing-bulk-fetch.bin",
                size: 1n,
                chunkCount: 1,
                ready: true,
            });
            let markStarted!: () => void;
            const started = new Promise<void>((resolve) => {
                markStarted = resolve;
            });
            let releaseLookup!: () => void;
            const lookupGate = new Promise<void>((resolve) => {
                releaseLookup = resolve;
            });
            (filestore as any).getReadPeerHints = async () => {
                markStarted();
                await lookupGate;
                return undefined;
            };

            const result = file
                .fetchChunks(filestore, { timeout: 10_000 })
                .then(
                    () => undefined,
                    (error) => error as Error
                );
            await started;
            await filestore.close();
            releaseLookup();

            expect((await result)?.message).to.eq("File read cancelled");
            expect((filestore as any).activeFileChangeSignals.size).to.eq(0);
        });

        it("cancels a pending-manifest wait when the Files program drops", async () => {
            const filestore = await peer.open(new Files());
            const file = new LargeFile({
                id: "dropping-ready-wait",
                name: "dropping-ready-wait.bin",
                size: 1n,
                chunkCount: 1,
                ready: false,
            });
            let markStarted!: () => void;
            const started = new Promise<void>((resolve) => {
                markStarted = resolve;
            });
            let releaseLookup!: () => void;
            const lookupGate = new Promise<void>((resolve) => {
                releaseLookup = resolve;
            });
            (filestore as any).getReadPeerHints = async () => {
                markStarted();
                await lookupGate;
                return undefined;
            };

            const stream = file.streamFile(filestore)[Symbol.asyncIterator]();
            const result = stream.next().then(
                () => undefined,
                (error) => error as Error
            );
            await started;
            await filestore.drop();
            releaseLookup();

            expect((await result)?.message).to.eq(
                "File store is being dropped"
            );
            expect((filestore as any).activeFileChangeSignals.size).to.eq(0);
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
                filestore.lastUploadDiagnostics?.maxConcurrentChunkPuts
            ).to.be.within(1, 8);
            expect(
                filestore.lastUploadDiagnostics?.maxConcurrentChunkPutBytes
            ).to.be.lessThanOrEqual(4 * 1024 * 1024);
            expect(
                filestore.lastUploadDiagnostics?.manifestFinishedAt
            ).to.not.eq(null);
            expect(
                filestore.lastUploadDiagnostics?.readyManifestFinishedAt
            ).to.not.eq(null);
            expect(filestore.lastUploadDiagnostics?.finishedAt).to.not.eq(null);
            expect(filestore.lastUploadDiagnostics?.failureMessage).to.eq(null);
            expectCompleteUploadProgress(filestore.lastUploadDiagnostics!);
        });

        it("copies reusable source buffers for tiny files", async () => {
            const filestore = await peer.open(new Files());
            const expected = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
            const fileId = await filestore.addSource("reused tiny source", {
                size: BigInt(expected.byteLength),
                readChunks: async function* () {
                    const reusable = new Uint8Array(4);
                    reusable.set(expected.subarray(0, 4));
                    yield reusable;
                    reusable.set(expected.subarray(4));
                    yield reusable;
                },
            });

            expect(filestore.lastUploadDiagnostics?.progressTelemetry).to.be
                .undefined;
            const file = await filestore.files.index.get(fileId, {
                local: true,
                remote: false,
            });
            expect(file).to.be.instanceOf(TinyFile);
            expect(
                equals(
                    await file!.getFile(filestore, { as: "joined" }),
                    expected
                )
            ).to.be.true;
        });

        it("cleans a pending manifest when source iterator construction fails", async () => {
            const filestore = await peer.open(new Files());

            await expect(
                filestore.addSource("throwing source", {
                    size: 6n * 1024n * 1024n,
                    readChunks: () => {
                        throw new Error("iterator construction failed");
                    },
                })
            ).rejects.toThrow("iterator construction failed");

            const diagnostics = filestore.lastUploadDiagnostics!;
            expect(diagnostics.failureMessage).to.eq(
                "iterator construction failed"
            );
            expect(
                await filestore.files.index.get(diagnostics.uploadId, {
                    local: true,
                    remote: false,
                })
            ).to.be.undefined;
        });

        it("preserves a failed upload when its pending-root deletion does not commit", async () => {
            const filestore = await peer.open(new Files());
            const originalDelete = filestore.files.del.bind(filestore.files);
            let deleteCalls = 0;
            (filestore.files as any).del = async () => {
                deleteCalls += 1;
                throw new Error("pending root delete failed");
            };

            try {
                await expect(
                    filestore.addSource("preserved throwing source", {
                        size: 6n * 1024n * 1024n,
                        readChunks: () => {
                            throw new Error("iterator construction failed");
                        },
                    })
                ).rejects.toThrow("iterator construction failed");
            } finally {
                (filestore.files as any).del = originalDelete;
            }

            const diagnostics = filestore.lastUploadDiagnostics!;
            expect(deleteCalls).to.eq(1);
            expect(
                await filestore.files.index.get(diagnostics.uploadId, {
                    local: true,
                    remote: false,
                })
            ).to.not.be.undefined;
            expect(
                (filestore as any).retainedLargeFileChunkCounts.get(
                    diagnostics.uploadId
                )
            ).to.eq(diagnostics.chunkCount);
            expect(
                (filestore as any).retainedEntryHeadsByFileId.has(
                    diagnostics.uploadId
                )
            ).to.be.true;

            await originalDelete(diagnostics.uploadId);
            filestore.releaseFileRetention(diagnostics.uploadId);
        });

        it("bounds concurrent chunk puts while preserving manifest order and integrity", async () => {
            const filestore = await peer.open(new Files());
            const bytes = crypto.randomBytes(8 * 1e6) as Uint8Array;
            const originalPut = filestore.files.put.bind(filestore.files);
            let activePuts = 0;
            let activeBytes = 0;
            let maxActivePuts = 0;
            let maxActiveBytes = 0;
            let readyManifestAfterDrain = false;
            const completedIndices = new Set<number>();
            const completionOrder: number[] = [];
            const readIndices: number[] = [];
            const progress: number[] = [];

            (filestore.files as any).put = async (
                value: any,
                ...args: any[]
            ) => {
                if (value instanceof TinyFile && value.parentId != null) {
                    activePuts += 1;
                    activeBytes += value.file.byteLength;
                    maxActivePuts = Math.max(maxActivePuts, activePuts);
                    maxActiveBytes = Math.max(maxActiveBytes, activeBytes);
                    try {
                        await delay(10 + ((3 - (value.index! % 4)) % 4) * 10);
                        const result = await (originalPut as any)(
                            value,
                            ...args
                        );
                        completedIndices.add(value.index!);
                        completionOrder.push(value.index!);
                        return result;
                    } finally {
                        activePuts -= 1;
                        activeBytes -= value.file.byteLength;
                    }
                }
                if (isLargeFileLike(value) && value.ready) {
                    readyManifestAfterDrain =
                        activePuts === 0 && completedIndices.size > 0;
                }
                return (originalPut as any)(value, ...args);
            };

            let fileId: string;
            try {
                fileId = await filestore.addSource(
                    "concurrent source upload",
                    {
                        size: BigInt(bytes.byteLength),
                        readChunks: async function* (chunkSize: number) {
                            const reusable = new Uint8Array(chunkSize);
                            let index = 0;
                            for (
                                let offset = 0;
                                offset < bytes.byteLength;
                                offset += chunkSize
                            ) {
                                readIndices.push(index++);
                                const end = Math.min(
                                    offset + chunkSize,
                                    bytes.byteLength
                                );
                                reusable.set(bytes.subarray(offset, end), 0);
                                yield reusable.subarray(0, end - offset);
                            }
                        },
                    },
                    undefined,
                    (value) => progress.push(value)
                );
            } finally {
                (filestore.files as any).put = originalPut;
            }

            const diagnostics = filestore.lastUploadDiagnostics!;
            expect(maxActivePuts).to.eq(8);
            expect(diagnostics.chunkPutConcurrencyLimit).to.eq(8);
            expect(diagnostics.chunkPutByteLimit).to.eq(4 * 1024 * 1024);
            expect(maxActivePuts).to.be.lessThanOrEqual(
                diagnostics.chunkPutConcurrencyLimit
            );
            expect(maxActiveBytes).to.be.lessThanOrEqual(
                diagnostics.chunkPutByteLimit
            );
            expect(diagnostics.maxConcurrentChunkPuts).to.eq(maxActivePuts);
            expect(diagnostics.maxConcurrentChunkPutBytes).to.eq(
                maxActiveBytes
            );
            expect(readyManifestAfterDrain).to.be.true;
            expect(readIndices).to.deep.eq([
                ...Array(diagnostics.chunkCount).keys(),
            ]);
            expect(
                progress.every(
                    (value, index) =>
                        index === 0 || value >= progress[index - 1]
                )
            ).to.be.true;
            expect(progress.at(-1)).to.eq(1);
            expect(
                completionOrder.some(
                    (value, index) =>
                        index > 0 && value < completionOrder[index - 1]
                )
            ).to.be.true;
            const milestones = expectCompleteUploadProgress(diagnostics);
            const expectedMilestoneChunkIndices: number[] = [];
            let simulatedCompletedBytes = 0;
            let nextMilestoneIndex = 1;
            for (const chunkIndex of completionOrder) {
                simulatedCompletedBytes += Math.min(
                    diagnostics.chunkSize,
                    diagnostics.sizeBytes - chunkIndex * diagnostics.chunkSize
                );
                while (
                    nextMilestoneIndex < UPLOAD_PROGRESS_BASIS_POINTS.length &&
                    simulatedCompletedBytes >=
                        getExpectedUploadProgressTargetBytes(
                            diagnostics.sizeBytes,
                            UPLOAD_PROGRESS_BASIS_POINTS[nextMilestoneIndex]
                        )
                ) {
                    expectedMilestoneChunkIndices.push(chunkIndex);
                    nextMilestoneIndex += 1;
                }
            }
            expect(
                milestones.slice(1).map((milestone) => milestone.chunkIndex)
            ).to.deep.eq(expectedMilestoneChunkIndices);

            const readyFile = await filestore.files.index.get(fileId!, {
                local: true,
                remote: false,
            });
            expect(isLargeFileLike(readyFile)).to.be.true;
            const heads = (readyFile as LargeFileWithChunkHeads)
                .chunkEntryHeads;
            expect(heads).to.have.length(diagnostics.chunkCount);
            for (let index = 0; index < diagnostics.chunkCount; index++) {
                const chunk = await filestore.files.index.get(
                    `${fileId!}:${index}`,
                    { local: true, remote: false }
                );
                expect((chunk as any).__context.head).to.eq(heads[index]);
            }
            const roundTrip = await readyFile!.getFile(filestore, {
                as: "joined",
            });
            expect(equals(roundTrip, bytes)).to.be.true;
        });

        it("settles concurrent workers and cleans up after a chunk put fails", async () => {
            const filestore = await peer.open(new Files());
            const bytes = crypto.randomBytes(8 * 1e6) as Uint8Array;
            const originalPut = filestore.files.put.bind(filestore.files);
            const originalDelete = filestore.files.del.bind(filestore.files);
            let activePuts = 0;
            let maxActivePuts = 0;
            let readyManifestWritten = false;
            const deletedIds: string[] = [];

            (filestore.files as any).put = async (
                value: any,
                ...args: any[]
            ) => {
                if (value instanceof TinyFile && value.parentId != null) {
                    activePuts += 1;
                    maxActivePuts = Math.max(maxActivePuts, activePuts);
                    try {
                        await delay(value.index === 2 ? 10 : 40);
                        if (value.index === 2) {
                            throw new Error("injected chunk put failure");
                        }
                        return (originalPut as any)(value, ...args);
                    } finally {
                        activePuts -= 1;
                    }
                }
                if (isLargeFileLike(value) && value.ready) {
                    readyManifestWritten = true;
                }
                return (originalPut as any)(value, ...args);
            };
            (filestore.files as any).del = async (id: string) => {
                deletedIds.push(id);
                return originalDelete(id);
            };

            try {
                await expect(
                    filestore.addSource("failing concurrent upload", {
                        size: BigInt(bytes.byteLength),
                        readChunks: async function* (chunkSize: number) {
                            for (
                                let offset = 0;
                                offset < bytes.byteLength;
                                offset += chunkSize
                            ) {
                                yield bytes.subarray(
                                    offset,
                                    Math.min(
                                        offset + chunkSize,
                                        bytes.byteLength
                                    )
                                );
                            }
                        },
                    })
                ).rejects.toThrow("injected chunk put failure");
            } finally {
                (filestore.files as any).put = originalPut;
                (filestore.files as any).del = originalDelete;
            }

            const diagnostics = filestore.lastUploadDiagnostics!;
            expect(maxActivePuts).to.be.greaterThan(1);
            expect(maxActivePuts).to.be.lessThanOrEqual(8);
            expect(diagnostics.chunkPutConcurrencyLimit).to.eq(8);
            expect(activePuts).to.eq(0);
            expect(readyManifestWritten).to.be.false;
            expect(diagnostics.readyManifestStartedAt).to.eq(null);
            expect(diagnostics.failureMessage).to.eq(
                "injected chunk put failure"
            );
            const milestones = expectUploadProgressPrefix(diagnostics);
            expect(milestones.length).to.be.lessThan(
                UPLOAD_PROGRESS_BASIS_POINTS.length
            );
            expect(milestones.at(-1)!.basisPoints).to.be.lessThan(10_000);
            expect(deletedIds[0]).to.eq(diagnostics.uploadId);
            expect(
                deletedIds
                    .slice(1)
                    .every((id) => id.startsWith(`${diagnostics.uploadId}:`))
            ).to.be.true;
            expect(
                await filestore.countLocalChunks({
                    id: diagnostics.uploadId,
                } as any)
            ).to.eq(0);
            expect(
                await filestore.files.index.get(diagnostics.uploadId, {
                    local: true,
                    remote: false,
                })
            ).to.be.undefined;
            expect(
                [...((filestore as any).retainedChunkIds as Set<string>)].some(
                    (id) => id.startsWith(`${diagnostics.uploadId}:`)
                )
            ).to.be.false;
        });

        it("pipelines persisted remote reads with bounded per-index lookups", async () => {
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
            expect(isLargeFileLike(file)).to.be.true;
            stripChunkEntryHeads(file);

            const originalSearch = filestoreReader.files.index.search.bind(
                filestoreReader.files.index
            );
            const originalGet = filestoreReader.files.index.get.bind(
                filestoreReader.files.index
            );
            const originalCountLocalChunks =
                filestoreReader.countLocalChunks.bind(filestoreReader);
            let parentIdSearches = 0;
            let directChunkGets = 0;
            let inflightChunkGets = 0;
            let maxInflightChunkGets = 0;
            let sawChunkWaitFor = false;
            let indexedChunkGets = 0;
            let resolvedRemoteChunkGets = 0;
            const batchReplicateValues: boolean[] = [];
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
                if (queries.some((query: any) => Array.isArray(query?.or))) {
                    const remote = (options as any)?.remote;
                    if (remote === false) {
                        return [];
                    }
                    batchReplicateValues.push(remote.replicate);
                }
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
            (filestoreReader as any).countLocalChunks = async (
                parent: LargeFile
            ) => {
                if (parent.id === fileId) {
                    return 0;
                }
                return originalCountLocalChunks(parent);
            };

            const streamedChunks: Uint8Array[] = [];

            try {
                await file!.writeFile(filestoreReader, {
                    write: async (chunk) => {
                        streamedChunks.push(chunk);
                    },
                });
            } finally {
                (filestoreReader as any).countLocalChunks =
                    originalCountLocalChunks;
                (filestoreReader.files.index as any).search = originalSearch;
                (filestoreReader.files.index as any).get = originalGet;
            }

            expect(parentIdSearches).to.eq(0);
            expect(directChunkGets).to.be.greaterThan(0);
            expect(maxInflightChunkGets).to.be.greaterThan(0);
            const readDiagnostics = filestoreReader.lastReadDiagnostics!;
            const readAhead = readDiagnostics.readAhead;
            expect(readDiagnostics.readAheadInitial).to.eq(2);
            expect(readAhead).to.be.lessThanOrEqual(
                readDiagnostics.readAheadLimit
            );
            expect(readDiagnostics.readAheadPeak).to.be.lessThanOrEqual(
                readDiagnostics.readAheadLimit
            );
            expect(readDiagnostics.readAheadLimit).to.be.lessThanOrEqual(8);
            expect(readAhead).to.be.lessThanOrEqual(file!.chunkCount);
            expect(readDiagnostics.readAheadSource).to.eq(
                "persisted-remote-adaptive"
            );
            expect(readDiagnostics.initialLocalChunkIndexRowCount).to.eq(
                readDiagnostics.initialLocalChunkCount
            );
            expect(
                filestoreReader.lastReadDiagnostics?.initialLocalChunkCount
            ).to.be.lessThan(file!.chunkCount);
            expect(readDiagnostics.chunkBatchQueryCount).to.eq(0);
            expect(readDiagnostics.chunkBatchResultCount).to.eq(0);
            expect(
                readDiagnostics.chunkPersistedRemoteBatchSkipCount
            ).to.be.greaterThan(0);
            expect(
                readDiagnostics.chunkPersistedRemoteBatchSkippedIndexCount
            ).to.eq(file!.chunkCount);
            expect(readDiagnostics.maxRemoteChunkBatchSize).to.eq(0);
            expect(readDiagnostics.maxConcurrentRemoteChunkBatches).to.eq(0);
            expect(maxInflightChunkGets).to.be.lessThanOrEqual(
                readDiagnostics.readAheadLimit
            );
            expect(readDiagnostics.chunkBatchResolverFallbackCount).to.eq(0);
            expect(batchReplicateValues).to.have.length(0);
            expect(readDiagnostics.peakKnownChunkCount).to.be.lessThanOrEqual(
                readDiagnostics.readAheadPeak * 2
            );
            expect(readDiagnostics.finalKnownChunkCount).to.eq(0);
            expect(sawChunkWaitFor).to.be.false;
            expect(indexedChunkGets).to.eq(0);
            expect(resolvedRemoteChunkGets).to.be.greaterThan(0);
            expect(
                await (filestoreReader.files.log as any).keep(
                    retainedWriterEntry
                )
            ).to.be.true;
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

        it("retries partial hinted chunk batches once without a peer hint", async () => {
            const writer = await peer.open(new Files());
            const bytes = crypto.randomBytes(8 * 1e6) as Uint8Array;
            const fileId = await writer.add("partial hinted batch", bytes);
            const reader = await peer2.open<Files>(writer.address, {
                args: { replicate: false },
            });
            await reader.files.log.waitForReplicator(peer.identity.publicKey);
            const file = await reader.files.index.get(fileId);
            expect(isLargeFileLike(file)).to.be.true;

            const writerChunks = new Map<string, TinyFile>();
            for (let index = 0; index < file!.chunkCount; index++) {
                const chunk = await writer.files.index.get(
                    `${fileId}:${index}`,
                    {
                        local: true,
                        remote: false,
                    }
                );
                writerChunks.set(chunk!.id, chunk as TinyFile);
            }
            const originalSearch = reader.files.index.search.bind(
                reader.files.index
            );
            const originalHints = reader.getReadPeerHints.bind(reader);
            let hintedBatches = 0;
            let unhintedFallbacks = 0;
            const replicateValues: boolean[] = [];
            (reader as any).getReadPeerHints = async () => ["hinted-writer"];
            (reader.files.index as any).search = async (
                request: any,
                options: any
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const idQueries = queries.find((query: any) =>
                    Array.isArray(query?.or)
                )?.or;
                if (
                    Array.isArray(idQueries) &&
                    idQueries.every((query: any) => getQueryKey(query) === "id")
                ) {
                    const ids = idQueries.map((query: any) =>
                        getQueryValue(query)
                    );
                    if (options.remote === false) {
                        return [];
                    }
                    replicateValues.push(options.remote.replicate);
                    if (options.remote.from) {
                        hintedBatches += 1;
                        await delay(30);
                        return [writerChunks.get(ids[0])];
                    }
                    unhintedFallbacks += 1;
                    return ids.map((id: string) => writerChunks.get(id));
                }
                return originalSearch(request as never, options as never);
            };

            let roundTrip: Uint8Array;
            try {
                roundTrip = await file!.getFile(reader, { as: "joined" });
            } finally {
                (reader.files.index as any).search = originalSearch;
                (reader as any).getReadPeerHints = originalHints;
            }

            expect(equals(roundTrip!, bytes)).to.be.true;
            expect(hintedBatches).to.be.greaterThan(0);
            expect(unhintedFallbacks).to.eq(hintedBatches);
            expect(replicateValues.every((value) => value === false)).to.be
                .true;
            expect(reader.lastReadDiagnostics?.chunkBatchFallbackCount).to.eq(
                hintedBatches
            );
            expect(
                reader.lastReadDiagnostics?.chunkBatchResolverFallbackCount
            ).to.eq(0);
            expect(reader.lastReadDiagnostics?.readAheadSource).to.eq(
                "observer-adaptive"
            );
            expect(reader.lastReadDiagnostics?.readAheadPeak).to.be.greaterThan(
                2
            );
            expect(
                reader.lastReadDiagnostics?.peakKnownChunkCount
            ).to.be.lessThanOrEqual(
                reader.lastReadDiagnostics!.readAheadPeak * 2
            );
            expect(reader.lastReadDiagnostics?.finalKnownChunkCount).to.eq(0);
            expect((reader as any).retainedChunkIds?.size ?? 0).to.eq(0);
            expect((reader as any).retainedChunkEntryHeads?.size ?? 0).to.eq(0);
            expect((reader as any).retainedEntryHeadsByFileId?.size ?? 0).to.eq(
                0
            );
        });

        it("falls back to indexed fields for legacy non-deterministic chunk ids", async () => {
            const writer = await peer.open(new Files());
            const fileId = "legacy-chunk-root";
            const fileName = "legacy-chunk-root.bin";
            const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
            for (const [index, bytes] of chunks.entries()) {
                await writer.files.put(
                    new TinyFile({
                        id: `legacy-chunk-${index}`,
                        name: `${fileName}/${index}`,
                        file: bytes,
                        parentId: fileId,
                        index,
                    })
                );
            }
            await writer.files.put(
                new LargeFile({
                    id: fileId,
                    name: fileName,
                    size: 4n,
                    chunkCount: chunks.length,
                    ready: true,
                    finalHash: sha256Base64Sync(concat(chunks)),
                })
            );

            const reader = await peer2.open<Files>(writer.address, {
                args: { replicate: false },
            });
            await reader.files.log.waitForReplicator(peer.identity.publicKey);
            const file = await reader.resolveById(fileId, {
                timeout: 10_000,
                replicate: false,
            });
            expect(isLargeFileLike(file)).to.be.true;
            const roundTrip = await file!.getFile(reader, { as: "joined" });

            expect(equals(roundTrip, concat(chunks))).to.be.true;
            expect(
                reader.lastReadDiagnostics?.chunkBatchResolverFallbackCount
            ).to.eq(chunks.length);
            expect(reader.lastReadDiagnostics?.chunkResolved?.[0]).to.eq(
                "indexed-search"
            );
            expect(reader.lastReadDiagnostics?.chunkResolved?.[1]).to.eq(
                "indexed-search"
            );
        });

        it("retries stale hints for persisted legacy chunks and rereads them offline", async () => {
            const writer = await peer.open(new Files());
            const fileId = "persisted-legacy-chunk-root";
            const fileName = "persisted-legacy-chunk-root.bin";
            const chunks = [
                new Uint8Array([1, 2, 3]),
                new Uint8Array([4, 5, 6]),
            ];
            for (const [index, bytes] of chunks.entries()) {
                await writer.files.put(
                    new TinyFile({
                        id: `persisted-legacy-chunk-${index}`,
                        name: `${fileName}/${index}`,
                        file: bytes,
                        parentId: fileId,
                        index,
                    })
                );
            }
            await writer.files.put(
                new LargeFile({
                    id: fileId,
                    name: fileName,
                    size: 6n,
                    chunkCount: chunks.length,
                    ready: true,
                    finalHash: sha256Base64Sync(concat(chunks)),
                })
            );

            const reader = await peer2.open<Files>(writer.address, {
                args: { replicate: false },
            });
            // Exercise persisted reads without background full-log replication.
            reader.persistChunkReads = true;
            await reader.files.log.waitForReplicator(peer.identity.publicKey);
            const file = await reader.resolveById(fileId, {
                timeout: 10_000,
                replicate: true,
            });
            expect(isLargeFileLike(file)).to.be.true;

            const originalSearch = reader.files.index.search.bind(
                reader.files.index
            );
            const originalGet = reader.files.index.get.bind(reader.files.index);
            const originalHints = reader.getReadPeerHints.bind(reader);
            let hintedDeterministicGets = 0;
            let hintedFieldSearches = 0;
            let unhintedPersistedFieldSearches = 0;
            (reader as any).getReadPeerHints = async () => ["stale-peer"];
            (reader.files.index as any).get = async (
                id: unknown,
                options: any
            ) => {
                if (
                    typeof id === "string" &&
                    id.startsWith(`${fileId}:`) &&
                    options?.remote?.from?.includes("stale-peer")
                ) {
                    // The test targets stale-hint recovery for legacy indexed
                    // fields. Make the preceding deterministic-id miss
                    // immediate instead of depending on transport timeout
                    // scheduling on a loaded CI runner.
                    hintedDeterministicGets += 1;
                    return undefined;
                }
                return originalGet(id as never, options as never);
            };
            (reader.files.index as any).search = async (
                request: any,
                options: any
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const isChunkFieldSearch =
                    queries.some(
                        (query: any) => getQueryKey(query) === "parentId"
                    ) &&
                    queries.some((query: any) => getQueryKey(query) === "name");
                if (options.remote?.from) {
                    if (isChunkFieldSearch) {
                        hintedFieldSearches += 1;
                    }
                    return [];
                }
                if (isChunkFieldSearch && options.remote?.replicate === true) {
                    unhintedPersistedFieldSearches += 1;
                }
                return originalSearch(request as never, options as never);
            };

            let firstRead: Uint8Array;
            try {
                firstRead = await file!.getFile(reader, {
                    as: "joined",
                    timeout: 15_000,
                });
            } finally {
                (reader.files.index as any).get = originalGet;
                (reader.files.index as any).search = originalSearch;
                (reader as any).getReadPeerHints = originalHints;
            }

            expect(equals(firstRead!, concat(chunks))).to.be.true;
            expect(hintedDeterministicGets).to.be.greaterThan(0);
            expect(hintedFieldSearches).to.be.greaterThan(0);
            expect(unhintedPersistedFieldSearches).to.eq(chunks.length);
            expect(reader.lastReadDiagnostics?.chunkResolved?.[0]).to.eq(
                "unhinted-persisted-indexed-search"
            );
            expect(reader.lastReadDiagnostics?.chunkResolved?.[1]).to.eq(
                "unhinted-persisted-indexed-search"
            );

            await writer.close();
            (reader as any).getReadPeerHints = async () => undefined;
            let offlineRead: Uint8Array;
            const offlineReadStartedAt = Date.now();
            try {
                offlineRead = await file!.getFile(reader, {
                    as: "joined",
                    timeout: 5_000,
                });
            } finally {
                (reader as any).getReadPeerHints = originalHints;
            }
            expect(Date.now() - offlineReadStartedAt).to.be.lessThan(2_000);
            expect(equals(offlineRead, concat(chunks))).to.be.true;
            expect(
                reader.lastReadDiagnostics?.chunkLocalIndexedBatchResultCount
            ).to.eq(chunks.length);
            expect(reader.lastReadDiagnostics?.readAheadSource).to.eq(
                "persisted-local"
            );
        });

        it("keeps a persisted observer prefix out of replication across root-list refreshes", async () => {
            const writer = await peer.open(new Files());
            const writerAddress = writer.address;
            const fileId = "persisted-observer-prefix";
            const fileName = "persisted-observer-prefix.bin";
            const chunks = Array.from(
                { length: 16 },
                (_, index) => new Uint8Array([index, index + 1, index + 2])
            );
            const chunkEntryHeads: string[] = [];
            for (const [index, bytes] of chunks.entries()) {
                const result = await writer.files.put(
                    new TinyFile({
                        id: `${fileId}:${index}`,
                        name: `${fileName}/${index}`,
                        file: bytes,
                        parentId: fileId,
                        index,
                    })
                );
                chunkEntryHeads[index] = result.entry.hash;
            }
            const expected = concat(chunks);
            await writer.files.put(
                new LargeFileWithChunkHeads({
                    id: fileId,
                    name: fileName,
                    size: BigInt(expected.byteLength),
                    chunkCount: chunks.length,
                    ready: true,
                    finalHash: sha256Base64Sync(expected),
                    chunkEntryHeads,
                })
            );

            let reader = await peer2.open<Files>(writerAddress, {
                args: { replicate: false },
            });
            const writerHash = peer.identity.publicKey.hashcode();
            const readerHash = peer2.identity.publicKey.hashcode();
            await reader.files.log.waitForReplicator(peer.identity.publicKey);
            await waitForResolved(async () => {
                expect(
                    [...(await writer.files.log.getReplicators())].sort()
                ).to.deep.eq([writerHash]);
                expect(
                    [...(await reader.files.log.getReplicators())].sort()
                ).to.deep.eq([writerHash]);
            });

            let file = await reader.resolveById(fileId, {
                timeout: 10_000,
                replicate: false,
            });
            expect(isLargeFileLike(file)).to.be.true;
            expect(await reader.countLocalChunks(file as LargeFile)).to.eq(0);
            expect(await reader.countLocalChunkBlocks(file as LargeFile)).to.eq(
                0
            );

            const selectedRootHead = (file as any).__context.head as string;
            const rootBlocks = reader.files.log.log.blocks;
            const originalRootBlockGet = rootBlocks.get.bind(rootBlocks);
            let releaseRootBlockFetch!: () => void;
            let markRootBlockFetchStarted!: () => void;
            const rootBlockFetchGate = new Promise<void>((resolve) => {
                releaseRootBlockFetch = resolve;
            });
            const rootBlockFetchStarted = new Promise<void>((resolve) => {
                markRootBlockFetchStarted = resolve;
            });
            (rootBlocks as any).get = async (
                hash: string,
                options: unknown
            ) => {
                if (hash === selectedRootHead) {
                    markRootBlockFetchStarted();
                    await rootBlockFetchGate;
                }
                return originalRootBlockGet(hash, options as never);
            };
            try {
                const persistRoot = reader.persistFileRoot(file!, {
                    timeout: 10_000,
                    from: [writerHash],
                });
                await rootBlockFetchStarted;
                expect(
                    await (reader as any).shouldKeepFileEntry({
                        hash: selectedRootHead,
                    })
                ).to.be.true;
                releaseRootBlockFetch();
                file = await persistRoot;
            } finally {
                releaseRootBlockFetch();
                (rootBlocks as any).get = originalRootBlockGet;
            }
            const persistedRoot = await reader.files.index.get(fileId, {
                local: true,
                remote: false,
            });
            expect((persistedRoot as any)?.__context?.head).to.eq(
                (file as any).__context.head
            );
            const persistedRootHead = (file as any).__context.head as string;
            await reader.files.log.log.blocks.rm(persistedRootHead);
            expect(await reader.files.log.log.blocks.has(persistedRootHead)).to
                .be.false;
            file = await reader.persistFileRoot(file, {
                timeout: 10_000,
                from: [writerHash],
            });
            expect(await reader.files.log.log.blocks.has(persistedRootHead)).to
                .be.true;
            // Let any prune requested while the root was being indexed settle.
            await delay(1_200);
            expect(await reader.files.log.log.blocks.has(persistedRootHead)).to
                .be.true;
            expect(
                (
                    await reader.files.index.get(fileId, {
                        local: true,
                        remote: false,
                    })
                )?.id
            ).to.eq(fileId);
            expect(
                await reader.files.log.getMyReplicationSegments()
            ).to.have.length(0);
            await waitForResolved(async () => {
                expect(
                    [...(await writer.files.log.getReplicators())].sort()
                ).to.deep.eq([writerHash]);
                expect(
                    [...(await reader.files.log.getReplicators())].sort()
                ).to.deep.eq([writerHash]);
            });

            reader.persistChunkReads = true;
            const transferId = "persisted-observer-prefix-preload";
            const iterator = (file as LargeFile)
                .streamFile(reader, { timeout: 10_000, transferId })
                [Symbol.asyncIterator]();
            const first = await iterator.next();
            expect(first.done).to.be.false;
            expect(first.value).to.deep.eq(chunks[0]);
            await iterator.return?.();

            const blockPresence = await Promise.all(
                chunkEntryHeads.map((head) =>
                    reader.files.log.log.blocks.has(head)
                )
            );
            const localBlockIndices = blockPresence.flatMap((present, index) =>
                present ? [index] : []
            );
            expect(localBlockIndices.length).to.be.greaterThan(0);
            expect(localBlockIndices.length).to.be.lessThan(chunks.length);
            expect(localBlockIndices).to.deep.eq(
                Array.from(
                    { length: localBlockIndices.length },
                    (_, index) => index
                )
            );
            expect(await reader.countLocalChunks(file as LargeFile)).to.eq(0);
            expect(reader.getActiveTransfers()).to.deep.eq([]);
            expect(reader.getReadDiagnostics(transferId)?.chunkFailure).to.be
                .null;

            const listed = await reader.list({ replicate: false });
            expect(listed.some((candidate) => candidate.id === fileId)).to.be
                .true;
            expect(await reader.countLocalChunks(file as LargeFile)).to.eq(0);
            expect(await reader.countLocalChunkBlocks(file as LargeFile)).to.eq(
                localBlockIndices.length
            );

            const writerReplicators = [
                ...(await writer.files.log.getReplicators()),
            ].sort();
            const readerReplicators = [
                ...(await reader.files.log.getReplicators()),
            ].sort();
            expect(writerReplicators).to.deep.eq([writerHash]);
            expect(readerReplicators).to.deep.eq([writerHash]);
            expect(readerReplicators).not.to.include(readerHash);
            expect(
                await reader.files.log.getMyReplicationSegments()
            ).to.have.length(0);

            await writer.close();
            await reader.close();
            reader = await peer2.open<Files>(writerAddress, {
                args: { replicate: false },
            });
            await delay(1_200);
            expect(
                await reader.files.log.getMyReplicationSegments()
            ).to.have.length(0);
            expect(await reader.files.log.log.blocks.has(persistedRootHead)).to
                .be.true;
            const offlineRoots = await reader.list({ replicate: false });
            expect(offlineRoots.some((candidate) => candidate.id === fileId)).to
                .be.true;
            const offlineRoot = await reader.resolveById(fileId, {
                replicate: false,
            });
            expect(isLargeFileLike(offlineRoot)).to.be.true;
            expect((offlineRoot as any).__context.head).to.eq(
                (file as any).__context.head
            );
        });

        it("persists batched manifest-head reads for an offline local reread", async () => {
            const writer = await peer.open(new Files());
            const fileId = "persisted-manifest-head-batch";
            const fileName = "persisted-manifest-head-batch.bin";
            const chunks = [
                new Uint8Array([1, 2]),
                new Uint8Array([3, 4]),
                new Uint8Array([5, 6]),
            ];
            const chunkEntryHeads: string[] = [];
            for (const [index, bytes] of chunks.entries()) {
                const result = await writer.files.put(
                    new TinyFile({
                        id: `${fileId}:${index}`,
                        name: `${fileName}/${index}`,
                        file: bytes,
                        parentId: fileId,
                        index,
                    })
                );
                chunkEntryHeads[index] = result.entry.hash;
            }
            const expected = concat(chunks);
            const manifest = new LargeFileWithChunkHeads({
                id: fileId,
                name: fileName,
                size: BigInt(expected.byteLength),
                chunkCount: chunks.length,
                ready: true,
                finalHash: sha256Base64Sync(expected),
                chunkEntryHeads,
            });
            const reader = await peer2.open<Files>(writer.address, {
                args: { replicate: false },
            });
            reader.persistChunkReads = true;
            await reader.files.log.waitForReplicator(peer.identity.publicKey);

            const log = reader.files.log.log as any;
            const getManyOwner =
                typeof log.getMany === "function" ? log : log.entryIndex;
            const originalGetManyMethod = getManyOwner?.getMany;
            expect(originalGetManyMethod).to.be.a("function");
            const readMany = originalGetManyMethod.bind(getManyOwner);
            const originalIndexGet = reader.files.index.get.bind(
                reader.files.index
            );
            const originalHints = reader.getReadPeerHints.bind(reader);
            const batchCalls: Array<{ heads: string[]; options: any }> = [];
            let perIndexChunkGets = 0;
            getManyOwner.getMany = async (heads: string[], options: any) => {
                batchCalls.push({ heads: [...heads], options });
                return readMany(heads, options);
            };
            (reader.files.index as any).get = async (
                id: unknown,
                options: unknown
            ) => {
                if (typeof id === "string" && id.startsWith(`${fileId}:`)) {
                    perIndexChunkGets += 1;
                }
                return originalIndexGet(id as never, options as never);
            };

            try {
                expect(await reader.countLocalChunks(manifest)).to.eq(0);
                expect(await reader.countLocalChunkBlocks(manifest)).to.eq(0);
                const firstRead = await manifest.getFile(reader, {
                    as: "joined",
                    timeout: 10_000,
                });
                expect(equals(firstRead, expected)).to.be.true;
                expect(
                    reader.lastReadDiagnostics?.initialLocalChunkBlockCount
                ).to.eq(0);
                // Demand persistence stores exact entry blocks without joining
                // the observer into Documents/index replication.
                expect(await reader.countLocalChunks(manifest)).to.eq(0);
                expect(await reader.countLocalChunkBlocks(manifest)).to.eq(
                    chunks.length
                );
                expect(perIndexChunkGets).to.eq(0);
                expect(
                    batchCalls.filter((call) => call.options.remote === false)
                        .length
                ).to.be.greaterThan(0);
                const remoteCalls = batchCalls.filter(
                    (call) =>
                        call.options.remote && call.options.remote !== false
                );
                expect(remoteCalls.length).to.be.greaterThan(0);
                expect(
                    remoteCalls.every(
                        (call) =>
                            call.heads.length <= 8 &&
                            call.options.remote.replicate === true &&
                            call.options.remote.timeout === 1_500 &&
                            call.options.remote.signal instanceof AbortSignal
                    )
                ).to.be.true;
                expect(
                    chunkEntryHeads.every((head) =>
                        (reader as any).retainedChunkEntryHeads.has(head)
                    )
                ).to.be.true;
                expect(
                    chunks.every((_, index) =>
                        (reader as any).retainedChunkIds.has(
                            `${fileId}:${index}`
                        )
                    )
                ).to.be.true;

                await writer.close();
                (reader.files.log.log.entryIndex as any).cache.clear();
                (reader as any).getReadPeerHints = async () => undefined;
                batchCalls.length = 0;
                const offlineRead = await manifest.getFile(reader, {
                    as: "joined",
                    timeout: 2_000,
                });

                expect(equals(offlineRead, expected)).to.be.true;
                expect(perIndexChunkGets).to.eq(0);
                expect(batchCalls.length).to.be.greaterThan(0);
                expect(
                    batchCalls.every((call) => call.options.remote === false)
                ).to.be.true;
                expect(
                    reader.lastReadDiagnostics
                        ?.chunkManifestHeadRemoteBatchQueryCount
                ).to.eq(0);
                expect(
                    reader.lastReadDiagnostics
                        ?.chunkManifestHeadLocalBatchAcceptedCount
                ).to.eq(chunks.length);
                expect(
                    reader.lastReadDiagnostics
                        ?.chunkManifestHeadRemoteBatchAcceptedCount
                ).to.eq(0);
                expect(reader.lastReadDiagnostics?.readAheadSource).to.eq(
                    "persisted-local"
                );
                expect(
                    reader.lastReadDiagnostics?.chunkBatchResolverFallbackCount
                ).to.eq(0);
                expect(reader.lastReadDiagnostics?.finalKnownChunkCount).to.eq(
                    0
                );
                expect(await reader.countLocalChunks(manifest)).to.eq(0);
                expect(await reader.countLocalChunkBlocks(manifest)).to.eq(
                    chunks.length
                );
            } finally {
                getManyOwner.getMany = originalGetManyMethod;
                (reader.files.index as any).get = originalIndexGet;
                (reader as any).getReadPeerHints = originalHints;
            }
        });

        it("batch reads a fully local persisted file without peer hints", async () => {
            const files = await peer.open(new Files());
            const bytes = crypto.randomBytes(8 * 1e6) as Uint8Array;
            const fileId = await files.add("offline persisted batch", bytes);
            const file = await files.files.index.get(fileId);
            const originalSearch = files.files.index.search.bind(
                files.files.index
            );
            const originalHints = files.getReadPeerHints.bind(files);
            const replicateValues: boolean[] = [];
            (files as any).getReadPeerHints = async () => undefined;
            (files.files.index as any).search = async (
                request: any,
                options: any
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                if (
                    options.remote !== false &&
                    queries.some((query: any) => Array.isArray(query?.or))
                ) {
                    replicateValues.push(options.remote.replicate);
                }
                return originalSearch(request as never, options as never);
            };

            let roundTrip: Uint8Array;
            try {
                roundTrip = await file!.getFile(files, { as: "joined" });
            } finally {
                (files.files.index as any).search = originalSearch;
                (files as any).getReadPeerHints = originalHints;
            }

            expect(equals(roundTrip!, bytes)).to.be.true;
            expect(replicateValues).to.have.length(0);
            expect(files.lastReadDiagnostics?.chunkBatchQueryCount).to.eq(0);
            expect(files.lastReadDiagnostics?.chunkBatchResultCount).to.eq(0);
            expect(
                files.lastReadDiagnostics
                    ?.chunkManifestHeadLocalBatchAcceptedCount
            ).to.eq(file!.chunkCount);
            expect(
                files.lastReadDiagnostics
                    ?.chunkManifestHeadRemoteBatchQueryCount
            ).to.eq(0);
            expect(
                files.lastReadDiagnostics?.chunkManifestHeadBatchAcceptedCount
            ).to.eq(file!.chunkCount);
            expect(files.lastReadDiagnostics?.readAheadSource).to.eq(
                "persisted-local"
            );
            expect(
                files.lastReadDiagnostics?.chunkBatchResolverFallbackCount
            ).to.eq(0);
            expect(files.lastReadDiagnostics?.finalKnownChunkCount).to.eq(0);
        });

        it("reclassifies stale local counts before bounded per-index reads", async () => {
            const writer = await peer.open(new Files());
            const bytes = crypto.randomBytes(20 * 1e6) as Uint8Array;
            const fileId = await writer.add("stale local chunk count", bytes);
            const reader = await peer2.open<Files>(writer.address);
            await reader.files.log.waitForReplicator(peer.identity.publicKey);
            const file = await reader.files.index.get(fileId);
            expect(isLargeFileLike(file)).to.be.true;
            expect(file!.chunkCount).to.be.greaterThan(34);
            stripChunkEntryHeads(file);

            const writerChunks = new Map<string, TinyFile>();
            await Promise.all(
                Array.from({ length: file!.chunkCount }, async (_, index) => {
                    const chunk = await writer.files.index.get(
                        `${fileId}:${index}`,
                        { local: true, remote: false }
                    );
                    writerChunks.set(chunk!.id, chunk as TinyFile);
                })
            );
            const originalSearch = reader.files.index.search.bind(
                reader.files.index
            );
            const originalGet = reader.files.index.get.bind(reader.files.index);
            const originalCountLocalChunks =
                reader.countLocalChunks.bind(reader);
            let localBatchCalls = 0;
            const remoteBatchSizes: number[] = [];
            let activeRemoteBatches = 0;
            let maxActiveRemoteBatches = 0;
            let perIndexRemoteGets = 0;
            let activePerIndexRemoteGets = 0;
            let maxActivePerIndexRemoteGets = 0;
            (reader as any).countLocalChunks = async (parent: LargeFile) =>
                parent.id === fileId
                    ? parent.chunkCount
                    : originalCountLocalChunks(parent);
            (reader.files.index as any).search = async (
                request: any,
                options: any
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                const idQueries = queries.find((query: any) =>
                    Array.isArray(query?.or)
                )?.or;
                if (
                    Array.isArray(idQueries) &&
                    idQueries.every((query: any) => getQueryKey(query) === "id")
                ) {
                    const ids = idQueries.map((query: any) =>
                        getQueryValue(query)
                    );
                    if (options.remote === false) {
                        localBatchCalls += 1;
                        if (localBatchCalls === 1) {
                            return ids.map((id: string) =>
                                writerChunks.get(id)
                            );
                        }
                        if (localBatchCalls === 2) {
                            // Simulate stale local rows/payloads after the
                            // initial exact probe while still returning enough
                            // objects to expose unbounded known-chunk caching.
                            return ids
                                .filter(
                                    (_: string, index: number) => index !== 1
                                )
                                .map((id: string) => writerChunks.get(id));
                        }
                        return [];
                    }
                    remoteBatchSizes.push(ids.length);
                    activeRemoteBatches += 1;
                    maxActiveRemoteBatches = Math.max(
                        maxActiveRemoteBatches,
                        activeRemoteBatches
                    );
                    try {
                        await delay(10);
                        return ids.map((id: string) => writerChunks.get(id));
                    } finally {
                        activeRemoteBatches -= 1;
                    }
                }
                return originalSearch(request as never, options as never);
            };
            (reader.files.index as any).get = async (
                id: string,
                options: any
            ) => {
                if (id.startsWith(`${fileId}:`)) {
                    if (options.remote === false) {
                        return undefined;
                    }
                    if (options.remote && options.remote !== false) {
                        perIndexRemoteGets += 1;
                        activePerIndexRemoteGets += 1;
                        maxActivePerIndexRemoteGets = Math.max(
                            maxActivePerIndexRemoteGets,
                            activePerIndexRemoteGets
                        );
                        try {
                            await delay(10);
                            return writerChunks.get(id);
                        } finally {
                            activePerIndexRemoteGets -= 1;
                        }
                    }
                }
                return originalGet(id as never, options as never);
            };

            let roundTrip: Uint8Array;
            try {
                roundTrip = await file!.getFile(reader, { as: "joined" });
            } finally {
                (reader.files.index as any).search = originalSearch;
                (reader.files.index as any).get = originalGet;
                (reader as any).countLocalChunks = originalCountLocalChunks;
            }

            expect(equals(roundTrip!, bytes)).to.be.true;
            // Initial verification plus the partial bounded local window; after
            // reclassification, persisted reads bypass batch prefetch entirely.
            expect(localBatchCalls).to.eq(2);
            expect(remoteBatchSizes).to.have.length(0);
            expect(maxActiveRemoteBatches).to.eq(0);
            expect(perIndexRemoteGets).to.be.greaterThan(0);
            expect(maxActivePerIndexRemoteGets).to.be.greaterThan(0);
            expect(reader.lastReadDiagnostics?.maxRemoteChunkBatchSize).to.eq(
                0
            );
            expect(
                reader.lastReadDiagnostics?.maxConcurrentRemoteChunkBatches
            ).to.eq(0);
            expect(
                reader.lastReadDiagnostics
                    ?.chunkBatchRemoteReclassificationCount
            ).to.eq(1);
            expect(reader.lastReadDiagnostics?.readAheadSource).to.eq(
                "persisted-remote-adaptive"
            );
            expect(
                reader.lastReadDiagnostics?.readAheadLimit
            ).to.be.lessThanOrEqual(8);
            expect(reader.lastReadDiagnostics?.readAhead).to.be.lessThanOrEqual(
                8
            );
            expect(maxActivePerIndexRemoteGets).to.be.lessThanOrEqual(
                reader.lastReadDiagnostics!.readAheadLimit
            );
            expect(
                reader.lastReadDiagnostics?.chunkPersistedRemoteBatchSkipCount
            ).to.be.greaterThan(0);
            // One demand resolver can race the bounded local-to-remote
            // reclassification; later indices must use the classified path.
            expect(
                reader.lastReadDiagnostics?.chunkBatchResolverFallbackCount
            ).to.be.lessThanOrEqual(1);
            expect(
                reader.lastReadDiagnostics?.peakKnownChunkCount
            ).to.be.lessThanOrEqual(
                reader.lastReadDiagnostics!.readAheadLimit * 2
            );
            expect(reader.lastReadDiagnostics?.finalKnownChunkCount).to.eq(0);
        });

        it("bounds persisted chunk misses to exact lookups", async () => {
            const filestore = await peer.open(new Files());
            const fileName = "missing persisted exact chunk";
            const fileId = "missing-persisted-exact-chunk";
            const file = new LargeFile({
                id: fileId,
                name: fileName,
                size: 1n,
                chunkCount: 1,
                ready: true,
            });
            const originalSearch = filestore.files.index.search.bind(
                filestore.files.index
            );
            const originalGet = filestore.files.index.get.bind(
                filestore.files.index
            );
            const originalGetReadPeerHints =
                filestore.getReadPeerHints.bind(filestore);
            let exactSearches = 0;
            let parentOnlySearches = 0;
            const retryMissingValues: unknown[] = [];

            (filestore as any).getReadPeerHints = async () => ["writer-peer"];
            (filestore.files.index as any).get = async (
                id: string,
                options: unknown
            ) => {
                if (id === `${fileId}:0`) {
                    const remote = (options as any)?.remote;
                    if (remote && remote !== false) {
                        retryMissingValues.push(remote.retryMissingResponses);
                    }
                    return undefined;
                }
                return originalGet(id as never, options as never);
            };
            (filestore.files.index as any).search = async (
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
                        getQueryValue(query) === `${fileName}/0`
                );
                if (hasParentId && hasChunkName) {
                    exactSearches++;
                    const remote = (options as any)?.remote;
                    if (remote && remote !== false) {
                        retryMissingValues.push(remote.retryMissingResponses);
                    }
                    return [];
                }
                if (hasParentId) {
                    parentOnlySearches++;
                    return [];
                }
                return originalSearch(request as never, options as never);
            };

            try {
                await expect(
                    file.writeFile(
                        filestore,
                        { write: async () => {} },
                        { timeout: 600 }
                    )
                ).rejects.toThrow(/Failed to resolve chunk/);
            } finally {
                (filestore.files.index as any).search = originalSearch;
                (filestore.files.index as any).get = originalGet;
                (filestore as any).getReadPeerHints = originalGetReadPeerHints;
            }

            expect(exactSearches).to.be.greaterThan(0);
            expect(parentOnlySearches).to.eq(0);
            expect(retryMissingValues.length).to.be.greaterThan(0);
            expect(retryMissingValues.every((value) => value === false)).to.be
                .true;
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
                        yield new Uint8Array(chunkSize);
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

        it("normalizes empty, oversized, and reusable source yields", async () => {
            const filestore = await peer.open(new Files());
            const expected = crypto.randomBytes(6 * 1024 * 1024) as Uint8Array;

            const fileId = await filestore.addSource(
                "normalized source chunks",
                {
                    size: BigInt(expected.byteLength),
                    readChunks: async function* (chunkSize: number) {
                        yield new Uint8Array(0);
                        const oversizedEnd = chunkSize * 2 + 17;
                        yield expected.subarray(0, oversizedEnd);
                        const reusable = new Uint8Array(
                            Math.max(1, Math.floor(chunkSize / 7))
                        );
                        for (
                            let offset = oversizedEnd;
                            offset < expected.byteLength;
                            offset += reusable.byteLength
                        ) {
                            const end = Math.min(
                                offset + reusable.byteLength,
                                expected.byteLength
                            );
                            reusable.set(expected.subarray(offset, end), 0);
                            yield reusable.subarray(0, end - offset);
                        }
                    },
                }
            );

            const diagnostics = filestore.lastUploadDiagnostics!;
            expect(diagnostics.chunkCount).to.eq(
                Math.ceil(expected.byteLength / diagnostics.chunkSize)
            );
            expectCompleteUploadProgress(diagnostics);
            for (let index = 0; index < diagnostics.chunkCount; index++) {
                const chunk = (await filestore.files.index.get(
                    `${fileId}:${index}`,
                    { local: true, remote: false }
                )) as TinyFile;
                expect(chunk.file.byteLength).to.eq(
                    index === diagnostics.chunkCount - 1
                        ? expected.byteLength % diagnostics.chunkSize ||
                              diagnostics.chunkSize
                        : diagnostics.chunkSize
                );
            }
            const file = await filestore.files.index.get(fileId, {
                local: true,
                remote: false,
            });
            expect(
                equals(
                    await file!.getFile(filestore, { as: "joined" }),
                    expected
                )
            ).to.be.true;
        });

        it("rejects a declared-size overrun before enqueuing its first chunk", async () => {
            const filestore = await peer.open(new Files());
            const declaredSize = 6 * 1024 * 1024;

            await expect(
                filestore.addSource("overrun source", {
                    size: BigInt(declaredSize),
                    readChunks: async function* () {
                        yield new Uint8Array(declaredSize + 1);
                    },
                })
            ).rejects.toThrow("Source size changed during upload");

            expect(filestore.lastUploadDiagnostics?.chunkPutCount).to.eq(0);
            // The first normalized staging buffer is now covered by the same
            // permit that would have been handed to its put. The overrun is
            // rejected before publication, while diagnostics still expose the
            // 512 KiB peak scheduler-owned memory reservation.
            expect(
                filestore.lastUploadDiagnostics?.maxConcurrentChunkPutBytes
            ).to.eq(512 * 1024);
        });

        it("withholds the final normalized chunk until the source finishes", async () => {
            const filestore = await peer.open(new Files());
            const expected = crypto.randomBytes(6 * 1024 * 1024) as Uint8Array;
            let markWaiting!: () => void;
            const waiting = new Promise<void>((resolve) => {
                markWaiting = resolve;
            });
            let finishSource!: () => void;
            const finish = new Promise<void>((resolve) => {
                finishSource = resolve;
            });
            const upload = filestore.addSource("withheld final chunk", {
                size: BigInt(expected.byteLength),
                readChunks: () => {
                    let nextCall = 0;
                    return {
                        [Symbol.asyncIterator]() {
                            return this;
                        },
                        async next() {
                            nextCall += 1;
                            if (nextCall === 1) {
                                return {
                                    done: false as const,
                                    value: expected,
                                };
                            }
                            markWaiting();
                            await finish;
                            return {
                                done: true as const,
                                value: undefined,
                            };
                        },
                    };
                },
            });

            await waiting;
            const diagnostics = filestore.lastUploadDiagnostics!;
            try {
                await waitForResolved(async () => {
                    expect(
                        await filestore.countLocalChunks({
                            id: diagnostics.uploadId,
                        } as any)
                    ).to.eq(diagnostics.chunkCount - 1);
                });
            } finally {
                finishSource();
            }
            const fileId = await upload;
            expect(
                await filestore.countLocalChunks({ id: fileId } as any)
            ).to.eq(diagnostics.chunkCount);
        });

        it("cancels a blocked source iterator after a queued put fails", async () => {
            const filestore = await peer.open(new Files());
            const originalPut = filestore.files.put.bind(filestore.files);
            let iteratorReturned = false;

            (filestore.files as any).put = async (
                value: any,
                ...args: any[]
            ) => {
                if (value instanceof TinyFile && value.parentId != null) {
                    await delay(10);
                    throw new Error("early queued put failure");
                }
                return (originalPut as any)(value, ...args);
            };

            try {
                await expect(
                    filestore.addSource("blocked source", {
                        size: 6n * 1024n * 1024n,
                        readChunks: (chunkSize: number) => {
                            let nextCalls = 0;
                            return {
                                [Symbol.asyncIterator]() {
                                    return this;
                                },
                                next() {
                                    nextCalls += 1;
                                    if (nextCalls === 1) {
                                        return Promise.resolve({
                                            done: false as const,
                                            value: new Uint8Array(chunkSize),
                                        });
                                    }
                                    return new Promise<never>(() => {});
                                },
                                return() {
                                    iteratorReturned = true;
                                    return Promise.resolve({
                                        done: true as const,
                                        value: undefined,
                                    });
                                },
                            };
                        },
                    })
                ).rejects.toThrow("early queued put failure");
            } finally {
                (filestore.files as any).put = originalPut;
            }

            expect(iteratorReturned).to.be.true;
            const diagnostics = filestore.lastUploadDiagnostics!;
            expect(
                await filestore.countLocalChunks({
                    id: diagnostics.uploadId,
                } as any)
            ).to.eq(0);
        });

        it("releases every attempted chunk after an oversized source stream", async () => {
            const filestore = await peer.open(new Files());
            const declaredSize = 6 * 1e6;

            await expect(
                filestore.addSource("oversized source", {
                    size: BigInt(declaredSize),
                    readChunks: async function* (chunkSize: number) {
                        const expectedChunks = Math.ceil(
                            declaredSize / chunkSize
                        );
                        for (let index = 0; index <= expectedChunks; index++) {
                            yield new Uint8Array(chunkSize);
                        }
                    },
                })
            ).rejects.toThrow("Source size changed during upload");

            const uploadId = filestore.lastUploadDiagnostics!.uploadId;
            expect(
                [
                    ...((filestore as any).retainedChunkIds as Set<string>),
                ].filter((id) => id.startsWith(`${uploadId}:`))
            ).toHaveLength(0);
            expect(
                await filestore.countLocalChunks({ id: uploadId } as any)
            ).to.eq(0);
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
            expect(isLargeFileLike(file)).to.be.true;
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
                if (queries.some((query: any) => Array.isArray(query?.or))) {
                    const results = await originalSearch(
                        request as never,
                        options as never
                    );
                    return results.filter(
                        (candidate) => candidate.id !== missingDirectChunkId
                    );
                }
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
                    if ((options as any)?.remote === false) {
                        // This test targets the direct-get -> indexed-search
                        // fallback, so suppress the earlier local legacy probe.
                        return [];
                    }
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
            expect(isLargeFileLike(file)).to.be.true;
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
                if (queries.some((query: any) => Array.isArray(query?.or))) {
                    const results = await originalSearch(
                        request as never,
                        options as never
                    );
                    return results.filter(
                        (candidate) => candidate.id !== missingDirectChunkId
                    );
                }
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
            expect(isLargeFileLike(file)).to.be.true;
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
                if (queries.some((query: any) => Array.isArray(query?.or))) {
                    const results = await originalSearch(
                        request as never,
                        options as never
                    );
                    return results.filter(
                        (candidate) => candidate.id !== delayedChunkId
                    );
                }
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

        it("streams a pending manifest resolved by a ready manifest get", async () => {
            const filestore = await peer.open(new Files());
            const fileId = "pending-ready-manifest-get";
            const fileName = "pending manifest resolved by get";
            const chunks = [
                new Uint8Array([1, 2]),
                new Uint8Array([3]),
                new Uint8Array([4, 5]),
            ];
            const expected = concat(chunks);
            const chunkEntryHeads: string[] = [];

            for (const [index, file] of chunks.entries()) {
                const result = await filestore.files.put(
                    new TinyFile({
                        id: `${fileId}:${index}`,
                        name: `${fileName}/${index}`,
                        file,
                        parentId: fileId,
                        index,
                    })
                );
                chunkEntryHeads[index] = result.entry.hash;
            }

            const pendingFile = new LargeFile({
                id: fileId,
                name: fileName,
                size: BigInt(expected.byteLength),
                chunkCount: chunks.length,
                ready: false,
            });
            const readyManifest = new LargeFileWithChunkHeads({
                id: fileId,
                name: fileName,
                size: BigInt(expected.byteLength),
                chunkCount: chunks.length,
                ready: true,
                finalHash: sha256Base64Sync(expected),
                chunkEntryHeads,
            });
            const originalSearch = filestore.files.index.search.bind(
                filestore.files.index
            );
            const originalGet = filestore.files.index.get.bind(
                filestore.files.index
            );
            let readyManifestGets = 0;

            (filestore.files.index as any).search = async (
                request: { query: unknown | unknown[] },
                options: unknown
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                if (
                    queries.some((query: any) => Array.isArray(query?.or)) ||
                    queries.some(
                        (query: any) => getQueryKey(query) === "parentId"
                    )
                ) {
                    return [];
                }
                const hasRootId = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "id" &&
                        getQueryValue(query) === fileId
                );
                if (hasRootId) {
                    if ((options as any)?.local === true) {
                        return [pendingFile];
                    }
                    return [];
                }
                return originalSearch(request as never, options as never);
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
                    readyManifestGets++;
                    return readyManifest;
                }
                if (typeof id === "string" && id.startsWith(`${fileId}:`)) {
                    if (options?.remote && options.remote !== false) {
                        throw new Error(
                            "chunk direct get should not be needed when the ready manifest has entry heads"
                        );
                    }
                    return undefined;
                }
                return originalGet(id as never, options as never);
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
                (filestore.files.index as any).get = originalGet;
            }

            expect(readyManifestGets).to.be.greaterThan(0);
            expect(
                filestore.lastReadDiagnostics?.waitUntilReadyResolvedBy
            ).to.eq("ready-manifest-get");
            expect(
                Object.values(
                    filestore.lastReadDiagnostics?.chunkResolved ?? {}
                )
            ).to.deep.eq(chunks.map(() => "cached"));
            expect(
                Object.values(
                    filestore.lastReadDiagnostics
                        ?.chunkManifestHeadBatchResolved ?? {}
                )
            ).to.deep.eq(chunkEntryHeads);
            expect(equals(concat(streamedChunks), expected)).to.be.true;
        });

        it("does not retain manifest heads while resolving observer chunks", async () => {
            const files = await peer.open(new Files());
            const fileId = "observer-manifest-heads";
            const fileName = "observer-manifest-heads.bin";
            const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
            const chunkEntryHeads: string[] = [];
            for (const [index, bytes] of chunks.entries()) {
                const result = await files.files.put(
                    new TinyFile({
                        id: `${fileId}:${index}`,
                        name: `${fileName}/${index}`,
                        file: bytes,
                        parentId: fileId,
                        index,
                    })
                );
                chunkEntryHeads[index] = result.entry.hash;
            }
            const manifest = new LargeFileWithChunkHeads({
                id: fileId,
                name: fileName,
                size: 4n,
                chunkCount: chunks.length,
                ready: true,
                finalHash: sha256Base64Sync(concat(chunks)),
                chunkEntryHeads,
            });
            const originalSearch = files.files.index.search.bind(
                files.files.index
            );
            const originalGet = files.files.index.get.bind(files.files.index);
            const originalLogGet = files.files.log.log.get.bind(
                files.files.log.log
            );
            const logSignals: AbortSignal[] = [];
            files.persistChunkReads = false;
            (files as any).retainedChunkIds = new Set();
            (files as any).retainedChunkEntryHeads = new Set();
            (files as any).retainedEntryHeadsByFileId = new Map();
            (files.files.index as any).search = async (
                request: any,
                options: any
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                if (
                    queries.some((query: any) => Array.isArray(query?.or)) ||
                    queries.some(
                        (query: any) => getQueryKey(query) === "parentId"
                    )
                ) {
                    expect(options.signal).to.be.instanceOf(AbortSignal);
                    return [];
                }
                return originalSearch(request as never, options as never);
            };
            (files.files.index as any).get = async (
                id: string,
                options: any
            ) => {
                if (id.startsWith(`${fileId}:`)) {
                    expect(options.signal).to.be.instanceOf(AbortSignal);
                    return undefined;
                }
                return originalGet(id as never, options as never);
            };
            (files.files.log.log as any).get = async (
                hash: string,
                options: any
            ) => {
                if (chunkEntryHeads.includes(hash)) {
                    logSignals.push(options.remote.signal);
                }
                return originalLogGet(hash as never, options as never);
            };

            let roundTrip: Uint8Array;
            try {
                roundTrip = await manifest.getFile(files, { as: "joined" });
            } finally {
                (files.files.index as any).search = originalSearch;
                (files.files.index as any).get = originalGet;
                (files.files.log.log as any).get = originalLogGet;
            }

            expect(equals(roundTrip!, concat(chunks))).to.be.true;
            expect(logSignals).to.have.length(chunks.length);
            expect(logSignals.every((signal) => signal instanceof AbortSignal))
                .to.be.true;
            expect((files as any).retainedChunkIds.size).to.eq(0);
            expect((files as any).retainedChunkEntryHeads.size).to.eq(0);
            expect((files as any).retainedEntryHeadsByFileId.size).to.eq(0);
        });

        it("allows non-persisting reads to fall back per chunk when ready manifest heads are missing", async () => {
            const filestore = await peer.open(new Files(), {
                args: { replicate: false },
            });
            const fileId = "missing-ready-heads";
            const fileName = "missing ready heads";
            const chunks = [
                new TinyFile({
                    id: `${fileId}:0`,
                    name: `${fileName}/0`,
                    file: new Uint8Array([1]),
                    parentId: fileId,
                    index: 0,
                }),
                new TinyFile({
                    id: `${fileId}:1`,
                    name: `${fileName}/1`,
                    file: new Uint8Array([2]),
                    parentId: fileId,
                    index: 1,
                }),
                new TinyFile({
                    id: `${fileId}:2`,
                    name: `${fileName}/2`,
                    file: new Uint8Array([3]),
                    parentId: fileId,
                    index: 2,
                }),
            ];
            const expected = concat(chunks.map((chunk) => chunk.file));
            const chunkEntryHeads = await Promise.all(
                chunks.map((_, index) =>
                    filestore.files.log.log.blocks.put(
                        new Uint8Array([0xff, index])
                    )
                )
            );
            await Promise.all(
                chunkEntryHeads.map((head) =>
                    filestore.files.log.log.blocks.rm(head)
                )
            );
            const pendingFile = new LargeFile({
                id: fileId,
                name: fileName,
                size: BigInt(expected.byteLength),
                chunkCount: chunks.length,
                ready: false,
            });
            const readyManifest = new LargeFileWithChunkHeads({
                id: fileId,
                name: fileName,
                size: BigInt(expected.byteLength),
                chunkCount: chunks.length,
                ready: true,
                finalHash: sha256Base64Sync(expected),
                chunkEntryHeads,
            });
            const originalSearch = filestore.files.index.search.bind(
                filestore.files.index
            );
            const originalGet = filestore.files.index.get.bind(
                filestore.files.index
            );
            const originalLogGet = filestore.files.log.log.get.bind(
                filestore.files.log.log
            );
            let manifestHeadGets = 0;

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
                    return (options as any)?.local === true
                        ? [pendingFile]
                        : [];
                }
                return originalSearch(request as never, options as never);
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
                    return readyManifest;
                }
                if (typeof id === "string" && id.startsWith(`${fileId}:`)) {
                    if (options?.remote && options.remote !== false) {
                        return chunks[Number(id.slice(`${fileId}:`.length))];
                    }
                    return undefined;
                }
                return originalGet(id as never, options as never);
            };
            (filestore.files.log.log as any).get = async (
                hash: string,
                options: unknown
            ) => {
                if (chunkEntryHeads.includes(hash)) {
                    manifestHeadGets++;
                    await delay(25);
                    return undefined;
                }
                return originalLogGet(hash as never, options as never);
            };

            const streamedChunks: Uint8Array[] = [];

            try {
                await pendingFile.writeFile(filestore, {
                    write: async (chunk) => {
                        streamedChunks.push(chunk);
                    },
                });
            } finally {
                (filestore.files.index as any).search = originalSearch;
                (filestore.files.index as any).get = originalGet;
                (filestore.files.log.log as any).get = originalLogGet;
            }

            expect(manifestHeadGets).to.eq(chunks.length);
            expect(
                Object.keys(
                    filestore.lastReadDiagnostics?.chunkManifestHeadMisses ?? {}
                )
            ).to.deep.eq(["0", "1", "2"]);
            expect(
                Object.values(
                    filestore.lastReadDiagnostics?.chunkResolved ?? {}
                )
            ).to.deep.eq(chunks.map(() => "non-replicating-get"));
            expect(equals(concat(streamedChunks), expected)).to.be.true;
        });

        it("retries transient ready manifest chunk head misses", async () => {
            const filestore = await peer.open(new Files());
            const fileId = "transient-ready-head-miss";
            const fileName = "transient ready head miss";
            const chunks = [
                new Uint8Array([1]),
                new Uint8Array([2]),
                new Uint8Array([3]),
            ];
            const expected = concat(chunks);
            const chunkEntryHeads: string[] = [];

            for (const [index, file] of chunks.entries()) {
                const result = await filestore.files.put(
                    new TinyFile({
                        id: `${fileId}:${index}`,
                        name: `${fileName}/${index}`,
                        file,
                        parentId: fileId,
                        index,
                    })
                );
                chunkEntryHeads[index] = result.entry.hash;
            }

            const pendingFile = new LargeFile({
                id: fileId,
                name: fileName,
                size: BigInt(expected.byteLength),
                chunkCount: chunks.length,
                ready: false,
            });
            const readyManifest = new LargeFileWithChunkHeads({
                id: fileId,
                name: fileName,
                size: BigInt(expected.byteLength),
                chunkCount: chunks.length,
                ready: true,
                finalHash: sha256Base64Sync(expected),
                chunkEntryHeads,
            });
            const originalSearch = filestore.files.index.search.bind(
                filestore.files.index
            );
            const originalGet = filestore.files.index.get.bind(
                filestore.files.index
            );
            const originalLogGet = filestore.files.log.log.get.bind(
                filestore.files.log.log
            );
            const log = filestore.files.log.log as any;
            const getManyOwner =
                typeof log.getMany === "function" ? log : log.entryIndex;
            const originalGetManyMethod = getManyOwner?.getMany;
            expect(originalGetManyMethod).to.be.a("function");
            const originalLogGetMany = originalGetManyMethod.bind(getManyOwner);
            let firstHeadMissed = false;
            let firstHeadGets = 0;

            (filestore.files.index as any).search = async (
                request: { query: unknown | unknown[] },
                options: unknown
            ) => {
                const queries = Array.isArray(request.query)
                    ? request.query
                    : [request.query];
                if (queries.some((query: any) => Array.isArray(query?.or))) {
                    return [];
                }
                const hasRootId = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "id" &&
                        getQueryValue(query) === fileId
                );
                if (hasRootId) {
                    return (options as any)?.local === true
                        ? [pendingFile]
                        : [];
                }
                const hasParentId = queries.some(
                    (query: any) =>
                        getQueryKey(query) === "parentId" &&
                        getQueryValue(query) === fileId
                );
                if (hasParentId) {
                    return [];
                }
                return originalSearch(request as never, options as never);
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
                    return readyManifest;
                }
                if (typeof id === "string" && id.startsWith(`${fileId}:`)) {
                    return undefined;
                }
                return originalGet(id as never, options as never);
            };
            (filestore.files.log.log as any).get = async (
                hash: string,
                options: unknown
            ) => {
                if (hash === chunkEntryHeads[0]) {
                    firstHeadGets++;
                    if (!firstHeadMissed) {
                        firstHeadMissed = true;
                        return undefined;
                    }
                }
                return originalLogGet(hash as never, options as never);
            };
            getManyOwner.getMany = async (
                hashes: string[],
                options: unknown
            ) => {
                const entries = await originalLogGetMany(
                    hashes,
                    options as never
                );
                return entries.map((entry, index) =>
                    hashes[index] === chunkEntryHeads[0] ? undefined : entry
                );
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
                    { timeout: 2_000 }
                );
            } finally {
                (filestore.files.index as any).search = originalSearch;
                (filestore.files.index as any).get = originalGet;
                (filestore.files.log.log as any).get = originalLogGet;
                getManyOwner.getMany = originalGetManyMethod;
            }

            expect(firstHeadGets).to.be.greaterThan(1);
            expect(
                filestore.lastReadDiagnostics
                    ?.chunkManifestEntryLocalDecodeMissCount
            ).to.eq(1);
            expect(
                filestore.lastReadDiagnostics
                    ?.chunkManifestEntryPersistenceSucceededCount
            ).to.eq(1);
            expect(
                filestore.lastReadDiagnostics
                    ?.chunkManifestEntryRawFetchAttemptCount
            ).to.eq(0);
            const resolvedRoutes = Object.values(
                filestore.lastReadDiagnostics?.chunkResolved ?? {}
            );
            expect(resolvedRoutes[0]).to.eq("manifest-entry-persistence");
            expect(
                resolvedRoutes.every(
                    (route) =>
                        route === "manifest-entry-persistence" ||
                        route === "cached"
                )
            ).to.be.true;
            expect(
                filestore.lastReadDiagnostics
                    ?.chunkManifestEntryContentMismatchIndices
            ).to.deep.eq([]);
            expect((filestore as any).retainedChunkEntryHeads).to.deep.eq(
                new Set(chunkEntryHeads)
            );
            expect(equals(concat(streamedChunks), expected)).to.be.true;
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
            expect(
                filestore.lastReadDiagnostics?.lastReadyProbe
                    ?.localChunkIndexRowCount
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
            expect(
                filestore.lastReadDiagnostics?.lastReadyProbe
                    ?.localChunkIndexRowCount
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

        it("uses non-replicating exact search when adaptive exact routes miss", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileName = "streamed download with parent search";
            const fileId = await filestore.add(fileName, largeFile);

            const filestoreReader = await peer2.open<Files>(filestore.address);
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file = await filestoreReader.files.index.get(fileId);
            expect(isLargeFileLike(file)).to.be.true;
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
            let parentOnlySearches = 0;

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
                if (queries.some((query: any) => Array.isArray(query?.or))) {
                    const results = await originalSearch(
                        request as never,
                        options as never
                    );
                    return results.filter(
                        (candidate) => candidate.id !== delayedChunkId
                    );
                }
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
                    return resolvedPreciseSearches > 0
                        ? originalSearch(request as never, options as never)
                        : [];
                }

                if (hasParentId) {
                    parentOnlySearches++;
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
            expect(parentOnlySearches).to.eq(0);
            expect(
                filestoreReader.lastReadDiagnostics?.chunkResolved?.[1]
            ).to.eq("resolved-search");
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
            expect(isLargeFileLike(file)).to.be.true;
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
                if (queries.some((query: any) => Array.isArray(query?.or))) {
                    const results = await originalSearch(
                        request as never,
                        options as never
                    );
                    return results.filter(
                        (candidate) => candidate.id !== missingDirectChunkId
                    );
                }
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
            expect(isLargeFileLike(file)).to.be.true;
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
                if (queries.some((query: any) => Array.isArray(query?.or))) {
                    const results = await originalSearch(
                        request as never,
                        options as never
                    );
                    return results.filter(
                        (candidate) => candidate.id !== delayedChunkId
                    );
                }
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

        it("uses exact chunk search when direct chunk routes miss", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const fileName = "streamed download with parent search";
            const fileId = await filestore.add(fileName, largeFile);

            const filestoreReader = await peer2.open<Files>(filestore.address);
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file = await filestoreReader.files.index.get(fileId);
            expect(isLargeFileLike(file)).to.be.true;
            stripChunkEntryHeads(file);

            const originalSearch = filestoreReader.files.index.search.bind(
                filestoreReader.files.index
            );
            const originalGet = filestoreReader.files.index.get.bind(
                filestoreReader.files.index
            );
            const missingDirectChunkId = `${fileId}:1`;
            const missingDirectChunk = await filestore.files.index.get(
                missingDirectChunkId,
                { local: true, remote: false }
            );
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
                if (queries.some((query: any) => Array.isArray(query?.or))) {
                    const results = await originalSearch(
                        request as never,
                        options as never
                    );
                    return results.filter(
                        (candidate) => candidate.id !== missingDirectChunkId
                    );
                }
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
                    if ((options as any)?.remote === false) {
                        return [];
                    }
                    preciseChunkSearches++;
                    return missingDirectChunk ? [missingDirectChunk] : [];
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
            expect(parentChunkSearches).to.eq(0);
            expect(
                filestoreReader.lastReadDiagnostics?.chunkResolved?.[1]
            ).to.eq("indexed-search");
            expect(streamedChunks.length).to.be.greaterThan(1);
            expect(equals(concat(streamedChunks), largeFile)).to.be.true;
        });

        it("falls back per-index after partial observer chunk batches", async () => {
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
            expect(isLargeFileLike(file)).to.be.true;
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
            expect(directChunkGets).to.be.greaterThan(0);
            expect(
                filestoreReader.lastReadDiagnostics
                    ?.chunkBatchResolverFallbackCount
            ).to.be.greaterThan(0);
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
            expect(isLargeFileLike(file)).to.be.true;
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
            expect(isLargeFileLike(file)).to.be.true;
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
            expect(isLargeFileLike(file)).to.be.true;
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
                if (queries.some((query: any) => Array.isArray(query?.or))) {
                    const results = await originalSearch(
                        request as never,
                        options as never
                    );
                    return results.filter(
                        (candidate) => candidate.id !== transientChunkId
                    );
                }
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
                if (isLargeFileLike(entry) && !entry.ready) {
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
                    expect(isLargeFileLike(match)).to.be.true;
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
                expect(isLargeFileLike(listed[0])).to.be.true;
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
