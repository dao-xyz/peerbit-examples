import { Peerbit } from "peerbit";
import { Name, Names } from "../index.js";
import { Ed25519Keypair, PreHash } from "@peerbit/crypto";
import { randomBytes } from "@peerbit/crypto";
import { expect } from "chai";

describe("index", () => {
    let peer: Peerbit;

    before(async () => {
        peer = await Peerbit.create();
    });

    after(async () => {
        await peer.stop();
    });

    it("one name", async () => {
        // Peer 1 is subscribing to a replication topic (to start helping the network)
        const names = await peer.open(new Names({ id: randomBytes(32) }));

        await names.names.put(new Name(peer.identity.publicKey, "aa"));
        expect((await names.getName(peer.identity.publicKey))?.name).to.eq(
            "aa"
        );
        await names.names.put(new Name(peer.identity.publicKey, "a"));
        expect((await names.getName(peer.identity.publicKey))?.name).to.eq("a");
        await names.names.put(new Name(peer.identity.publicKey, "aa"));
        expect((await names.getName(peer.identity.publicKey))?.name).to.eq(
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
        expect((await names.getName(peer.identity.publicKey))?.name).to.eq("a");
        expect((await names.getName(kp.publicKey))?.name).to.eq("a");
    });
});
