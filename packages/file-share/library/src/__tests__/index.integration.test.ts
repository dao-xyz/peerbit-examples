import { Peerbit } from "peerbit";
import { Files, LargeFile } from "..";
import { equals } from "uint8arrays";
import crypto from "crypto";
import { waitForResolved } from "@peerbit/time";
import { expect } from "chai";
describe("index", () => {
    let peer: Peerbit, peer2: Peerbit;

    before(async () => {
        peer = await Peerbit.create();
        peer2 = await Peerbit.create();
        await peer.dial(peer2);
    });

    after(async () => {
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
        ).to.eq(smallFile);

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

            const largeFile = crypto.randomBytes(5 * 1e7); // 50 mb
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

            const file = (await filestoreReader.getByName(
                "random large file"
            ))!;
            expect(equals(file!.bytes, largeFile)).to.be.true;

            await filestore.removeByName("random large file");
            expect(await filestoreReader.getByName("random large file")).to.be
                .undefined;
        });

        it("replicates", async () => {
            const filestore = await peer.open(new Files());

            const filestoreReplicator2 = await peer2.open<Files>(
                filestore.address
            );

            let t0 = +new Date();
            const largeFile = crypto.randomBytes(5 * 1e7); // 50 mb
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
