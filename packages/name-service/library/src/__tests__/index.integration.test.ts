import { Peerbit } from "@dao-xyz/peerbit";
import { LSession } from "@dao-xyz/peerbit-test-utils";
import { Name, Names } from "..";
import { ReplicatorType } from "@dao-xyz/peerbit-program";
import { delay } from "@dao-xyz/peerbit-time";
import { Ed25519Keypair, PreHash } from "@dao-xyz/peerbit-crypto";
import { randomBytes } from "@dao-xyz/peerbit-crypto";

describe("index", () => {
    let peer: Peerbit;

    beforeAll(async () => {
        peer = await Peerbit.create();
    });

    afterAll(async () => {
        await peer.stop();
    });

    it("one name", async () => {
        // Peer 1 is subscribing to a replication topic (to start helping the network)
        const names = await peer.open(new Names({ id: randomBytes(32) }), {
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
        const names = await peer.open(new Names({ id: randomBytes(32) }), {
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
