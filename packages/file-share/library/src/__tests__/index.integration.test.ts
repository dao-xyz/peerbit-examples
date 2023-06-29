import { Peerbit } from "peerbit";
import { Files } from "..";
import { equals } from "uint8arrays";
import crypto from "crypto";
import { Observer } from "@peerbit/document";

describe("index", () => {
    let peer: Peerbit, peer2: Peerbit;

    beforeAll(async () => {
        peer = await Peerbit.create();
        peer2 = await Peerbit.create();
        await peer.dial(peer2);
    });

    afterAll(async () => {
        await peer.stop();
        await peer2.stop();
    });

    it("tiny file", async () => {
        // Peer 1 is subscribing to a replication topic (to start helping the network)
        const filestore = await peer.open(new Files());

        const smallFile = new Uint8Array([123]);
        await filestore.create("tiny file", smallFile);

        const filestoreReader = await peer2.open<Files>(filestore.address);
        await filestoreReader.waitFor(peer.identity.publicKey);
        expect(
            new Uint8Array(
                (await filestoreReader.getByName("tiny file"))!.bytes
            )
        ).toEqual(smallFile);
    });

    it("small file", async () => {
        // Peer 1 is subscribing to a replication topic (to start helping the network)
        const filestore = await peer.open(new Files());

        const smallFile = new Uint8Array(2 * 1e6); // 2 mb
        await filestore.create("small file", smallFile);

        const filestoreReader = await peer2.open<Files>(filestore.address, {
            args: {
                role: new Observer(),
            },
        });
        await filestoreReader.waitFor(peer.identity.publicKey);

        const file = await filestoreReader.getByName("small file");
        expect(equals(new Uint8Array(file!.bytes), smallFile)).toBeTrue();
    });

    describe("large file", () => {
        it("will deduplicate chunks", async () => {
            // Peer 1 is subscribing to a replication topic (to start helping the network)
            const filestore = await peer.open(new Files());

            const largeFile = new Uint8Array(5 * 1e7); // 50 mb
            await filestore.create("large file", largeFile);

            // +1 for the LargeFile that contains meta info about the chunks (SmallFiles)
            // +2 SmallFiles, because all chunks expect the last one will be exactly the same
            //(the last chunk will be different because it is smaller, but will also just contain 0)
            expect(filestore.files.index.size).toEqual(3);

            const filestoreReader = await peer2.open<Files>(filestore.address);
            await filestoreReader.waitFor(peer.identity.publicKey);

            const file = await filestoreReader.getByName("large file");
            expect(equals(file!.bytes, largeFile)).toBeTrue();
        });

        it("random file", async () => {
            // Peer 1 is subscribing to a replication topic (to start helping the network)
            const filestore = await peer.open(new Files());

            const largeFile = crypto.randomBytes(5 * 1e7); // 50 mb
            await filestore.create("random large file", largeFile);

            // +1 for the LargeFile that contains meta info about the chunks (SmallFiles)
            // +56 SmallFiles
            expect(filestore.files.index.size).toEqual(57);

            const filestoreReader = await peer2.open<Files>(filestore.address);
            await filestoreReader.waitFor(peer.identity.publicKey);

            const file = (await filestoreReader.getByName(
                "random large file"
            ))!;
            expect(equals(file!.bytes, largeFile)).toBeTrue();
        });
    });
});
