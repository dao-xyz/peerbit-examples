import { Peerbit } from "@dao-xyz/peerbit";
import { LSession } from "@dao-xyz/peerbit-test-utils";
import { waitFor } from "@dao-xyz/peerbit-time";
import { jest } from "@jest/globals";
import { Name, Names } from "..";
import { ReplicatorType } from "@dao-xyz/peerbit-program";
import { delay } from "@dao-xyz/peerbit-time";
import { Ed25519Keypair, PreHash } from "@dao-xyz/peerbit-crypto";
describe("index", () => {
    let session: LSession, peer: Peerbit, peer2: Peerbit;
    jest.setTimeout(60 * 1000);

    beforeAll(async () => {
        session = await LSession.connected(2);
        peer = await Peerbit.create({ libp2p: session.peers[0] });
        peer2 = await Peerbit.create({ libp2p: session.peers[1] });
        await delay(2000);
    });

    afterAll(async () => {
        await session.stop();
    });

    it("one name", async () => {
        // Peer 1 is subscribing to a replication topic (to start helping the network)
        const names = await peer.open(new Names({ id: "1" }), {
            role: new ReplicatorType(),
        });

        await names.names.put(new Name("aa"));
        expect(await names.getName(peer.identity.publicKey)).toEqual("aa");
        await names.names.put(new Name("a"));
        expect(await names.getName(peer.identity.publicKey)).toEqual("a");
        await names.names.put(new Name("aa"));
        expect(await names.getName(peer.identity.publicKey)).toEqual("aa");
    });

    it("multisig name", async () => {
        // Peer 1 is subscribing to a replication topic (to start helping the network)
        let kp = await Ed25519Keypair.create();
        const names = await peer.open(new Names({ id: "2" }), {
            role: new ReplicatorType(),
        });

        await names.names.put(new Name("a"), {
            signers: [
                peer.identity.sign.bind(peer.identity),
                kp.signer(PreHash.NONE),
            ],
        });
        expect(await names.getName(peer.identity.publicKey)).toEqual("a");
        expect(await names.getName(kp.publicKey)).toEqual("a");
    });
});
