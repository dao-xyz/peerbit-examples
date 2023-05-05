import { Peerbit } from "@dao-xyz/peerbit";
import { LSession, waitForPeers } from "@dao-xyz/peerbit-test-utils";
import { ReplicatorType } from "@dao-xyz/peerbit-program";
import { Files } from "..";
import { ObserverType } from "@dao-xyz/peerbit-program";
import { equals } from "uint8arrays";
import crypto from "crypto";

describe("index", () => {
    let session: LSession, peer: Peerbit, peer2: Peerbit;

    beforeAll(async () => {
        session = await LSession.connected(2);
        peer = await Peerbit.create({ libp2p: session.peers[0] });
        peer2 = await Peerbit.create({ libp2p: session.peers[1] });
    });

    afterAll(async () => {
        await session.stop();
    });

    it("tiny file", async () => {
        // Peer 1 is subscribing to a replication topic (to start helping the network)
        const filestore = await peer.open(new Files());

        const smallFile = new Uint8Array([123]);
        await filestore.create("tiny file", smallFile);

        const filestoreReader = await peer2.open<Files>(filestore.address);
        await waitForPeers(
            peer2.libp2p,
            peer.libp2p,
            filestore.address.toString()
        );
        expect(
            new Uint8Array((await filestoreReader.get("tiny file"))!)
        ).toEqual(smallFile);
    });

    it("small file", async () => {
        // Peer 1 is subscribing to a replication topic (to start helping the network)
        const filestore = await peer.open(new Files());

        const smallFile = new Uint8Array(2 * 1e6); // 2 mb
        await filestore.create("small file", smallFile);

        const filestoreReader = await peer2.open<Files>(filestore.address, {
            role: new ObserverType(),
        });
        await waitForPeers(
            peer2.libp2p,
            peer.libp2p,
            filestore.address.toString()
        );
        const file = await filestoreReader.get("small file");
        expect(equals(new Uint8Array(file!), smallFile)).toBeTrue();
    });

    describe("large file", () => {
        it("will deduplicate chunks", async () => {
            // Peer 1 is subscribing to a replication topic (to start helping the network)
            const filestore = await peer.open(new Files(), {
                role: new ReplicatorType(),
            });

            const largeFile = new Uint8Array(5 * 1e7); // 50 mb
            await filestore.create("large file", largeFile);

            // +1 for the LargeFile that contains meta info about the chunks (SmallFiles)
            // +2 SmallFiles, because all chunks expect the last one will be exactly the same
            //(the last chunk will be different because it is smaller, but will also just contain 0)
            expect(filestore.files.index.size).toEqual(3);

            const filestoreReader = await peer2.open<Files>(filestore.address);
            await waitForPeers(
                peer2.libp2p,
                peer.libp2p,
                filestore.address.toString()
            );
            const file = (await filestoreReader.get("large file"))!;
            expect(equals(file!, largeFile)).toBeTrue();
        });

        it("random file", async () => {
            // Peer 1 is subscribing to a replication topic (to start helping the network)
            const filestore = await peer.open(new Files(), {
                role: new ReplicatorType(),
            });

            const largeFile = crypto.randomBytes(5 * 1e7); // 50 mb
            await filestore.create("random large file", largeFile);

            // +1 for the LargeFile that contains meta info about the chunks (SmallFiles)
            // +56 SmallFiles
            expect(filestore.files.index.size).toEqual(57);

            const filestoreReader = await peer2.open<Files>(filestore.address);
            await waitForPeers(
                peer2.libp2p,
                peer.libp2p,
                filestore.address.toString()
            );
            const file = (await filestoreReader.get("random large file"))!;
            expect(equals(file!, largeFile)).toBeTrue();
        });
    });
});
