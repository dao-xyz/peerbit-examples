import { Peerbit } from "peerbit";
import { Name, Names } from "..";
import { Ed25519Keypair, PreHash } from "@peerbit/crypto";
import { randomBytes } from "@peerbit/crypto";

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
        const names = await peer.open(new Names({ id: randomBytes(32) }));

        await names.names.put(new Name(peer.identity.publicKey, "aa"));
        expect((await names.getName(peer.identity.publicKey))?.name).toEqual(
            "aa"
        );
        await names.names.put(new Name(peer.identity.publicKey, "a"));
        expect((await names.getName(peer.identity.publicKey))?.name).toEqual(
            "a"
        );
        await names.names.put(new Name(peer.identity.publicKey, "aa"));
        expect((await names.getName(peer.identity.publicKey))?.name).toEqual(
            "aa"
        );
    });

    it("multisig name", async () => {
        // Peer 1 is subscribing to a replication topic (to start helping the network)
        let kp = await Ed25519Keypair.create();
        const names = await peer.open(new Names({ id: randomBytes(32) }));

        await names.names.put(new Name(peer.identity.publicKey, "a"), {
            signers: [
                peer.identity.sign.bind(peer.identity),
                kp.signer(PreHash.NONE),
            ],
        });
        expect((await names.getName(peer.identity.publicKey))?.name).toEqual(
            "a"
        );
        expect((await names.getName(kp.publicKey))?.name).toEqual("a");
    });
});
