import { Peerbit } from "@dao-xyz/peerbit";
import { LSession } from "@dao-xyz/peerbit-test-utils";
import { waitFor, delay } from "@dao-xyz/peerbit-time";
import { jest } from "@jest/globals";
import {
    DocumentQueryRequest,
    FieldStringMatchQuery,
    Results,
} from "@dao-xyz/peerbit-document";
import { ReplicatorType } from "@dao-xyz/peerbit-program";
import { Files } from "..";

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

        const smallFile = new Uint8Array([123])
        await filestore.create("tiny file", smallFile)

        const filestoreReader = await peer2.open<Files>(filestore.address);
        expect((await filestoreReader.get("tiny file"))).toEqual(smallFile)
    });


    it("small file", async () => {
        // Peer 1 is subscribing to a replication topic (to start helping the network)
        const filestore = await peer.open(new Files());

        const smallFile = new Uint8Array(2 * 1e6) // 2 mb
        await filestore.create("small file", smallFile)

        const filestoreReader = await peer2.open<Files>(filestore.address);
        expect((await filestoreReader.get("small file"))).toEqual(smallFile)
    });

    it("large file", async () => {
        // Peer 1 is subscribing to a replication topic (to start helping the network)
        const filestore = await peer.open(new Files(), {
            role: new ReplicatorType(),
        });

        const largeFile = new Uint8Array(5 * 1e7) // 50 mb
        await filestore.create("large file", largeFile)

        const filestoreReader = await peer2.open<Files>(filestore.address);
        expect((await filestoreReader.get("large file"))).toEqual(largeFile)
    });

});
