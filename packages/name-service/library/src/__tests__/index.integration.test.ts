import { Peerbit } from "peerbit";
import { Name, Names } from "../index.js";
import { Ed25519Keypair, PreHash } from "@peerbit/crypto";
import { randomBytes } from "@peerbit/crypto";
import { describe, beforeAll, afterAll, test, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("index", () => {
    let peer: Peerbit;

    beforeAll(async () => {
        peer = await Peerbit.create();
    });

    afterAll(async () => {
        await peer.stop();
    });

    test("one name", async () => {
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

    it("reopens its index from persisted state", async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-name-service-")
        );
        const id = randomBytes(32);
        let publicKey: Ed25519Keypair["publicKey"];

        try {
            const firstPeer = await Peerbit.create({ directory });
            try {
                publicKey = firstPeer.identity.publicKey;
                const names = await firstPeer.open(new Names({ id }));
                await names.names.put(new Name(publicKey, "persisted"));
            } finally {
                await firstPeer.stop();
            }

            const secondPeer = await Peerbit.create({ directory });
            try {
                const names = await secondPeer.open(new Names({ id }));
                expect((await names.getName(publicKey))?.name).to.eq(
                    "persisted"
                );
            } finally {
                await secondPeer.stop();
            }
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });
});
