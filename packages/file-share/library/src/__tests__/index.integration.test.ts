import { Peerbit } from "peerbit";
import {
    Files,
    IndexableFile,
    LargeFile,
    type ReReadableChunkSource,
    TinyFile,
} from "../index.js";
import { concat, equals } from "uint8arrays";
import crypto from "crypto";
import { delay, waitForResolved } from "@peerbit/time";
import { expect, describe, it, beforeEach, afterEach } from "vitest";
import { deserialize, serialize } from "@dao-xyz/borsh";
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
        it("will deduplicate chunks", async () => {
            // Peer 1 is subscribing to a replication topic (to start helping the network)
            const filestore = await peer.open(new Files());

            const largeFile = new Uint8Array(5 * 1e7 + 1); // 50 mb + 1 byte to make this not perfect splittable
            await filestore.add("large file", largeFile);

            // +1 for the LargeFile that contains meta info about the chunks (SmallFiles)
            // +2 SmallFiles, because all chunks expect the last one will be exactly the same
            //(the last chunk will be different because it is smaller, but will also just contain 0)
            expect(await filestore.files.index.getSize()).to.eq(3);

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

            // +1 for the LargeFile that contains meta info about the chunks (SmallFiles)
            // +56 SmallFiles
            expect(await filestore.files.index.getSize()).to.eq(101); // depends on the chunk size used

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

        it("streams rereadable sources in bounded chunks", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            const readChunkSizes: number[] = [];
            let readPasses = 0;

            const source: ReReadableChunkSource = {
                size: BigInt(largeFile.byteLength),
                async *readChunks(chunkSize: number) {
                    readPasses++;
                    readChunkSizes.push(chunkSize);
                    for (
                        let offset = 0;
                        offset < largeFile.byteLength;
                        offset += chunkSize
                    ) {
                        yield largeFile.subarray(
                            offset,
                            Math.min(offset + chunkSize, largeFile.byteLength)
                        );
                    }
                },
            };

            await filestore.addSource("streamed source", source);

            expect(readPasses).to.eq(2);
            expect(readChunkSizes).to.deep.eq([5e5, 5e5]);

            const file = await filestore.getByName("streamed source");
            expect(equals(file!.bytes, largeFile)).to.be.true;
        });

        it("streams downloaded files chunk by chunk", async () => {
            const filestore = await peer.open(new Files());
            const largeFile = crypto.randomBytes(12 * 1e6) as Uint8Array;
            await filestore.add("streamed download", largeFile);

            const filestoreReader = await peer2.open<Files>(filestore.address, {
                args: { replicate: false },
            });
            await filestoreReader.files.log.waitForReplicator(
                peer.identity.publicKey
            );

            const file = await filestoreReader.resolveByName(
                "streamed download",
                { replicate: true }
            );
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

        it("stores file sizes as u64", () => {
            const size = 5_000_000_000n;
            const largeFile = new LargeFile({
                id: "large",
                name: "large-file",
                fileIds: ["a", "b"],
                size,
            });
            const indexable = new IndexableFile(largeFile);

            const decodedFile = deserialize(
                serialize(largeFile),
                LargeFile
            );
            const decodedIndexable = deserialize(
                serialize(indexable),
                IndexableFile
            );

            expect(decodedFile.size).to.eq(size);
            expect(decodedIndexable.size).to.eq(size);
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

        it("replicates", async () => {
            const filestore = await peer.open(new Files());

            const filestoreReplicator2 = await peer2.open<Files>(
                filestore.address
            );

            let t0 = +new Date();
            const largeFile = crypto.randomBytes(5 * 1e7) as Uint8Array; // 50 mb
            await filestore.add("random large file", largeFile);

            // +1 for the LargeFile that contains meta info about the chunks (SmallFiles)
            // +56 SmallFiles
            expect(await filestore.files.index.getSize()).to.eq(101); // depends on the chunk size used

            await waitForResolved(async () =>
                expect(await filestoreReplicator2.files.index.getSize()).to.eq(
                    101
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
