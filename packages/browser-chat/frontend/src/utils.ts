import axios from "axios";
import { Level } from "level";
import { serialize, deserialize } from "@dao-xyz/borsh";
import { peerIdFromKeys } from "@libp2p/peer-id";
import { Ed25519Keypair, fromBase64, toBase64 } from "@dao-xyz/peerbit-crypto";
import { supportedKeys } from "@libp2p/crypto/keys";
import { PeerId } from "@libp2p/interface-peer-id";

export const resolveSwarmAddress = async (url: string) => {
    if (url.startsWith("/")) {
        return url; // Possible already an swarm address
    }
    if (url.startsWith("http") == false) {
        url = "https://" + url;
    }
    if (url.endsWith("/")) {
        url = url.substring(0, url.length - 1);
    }
    let domain = url;
    if (domain.startsWith("http://")) {
        domain = domain.substring("http://".length);
    }
    if (domain.startsWith("https://")) {
        domain = domain.substring("https://".length);
    }
    return (
        "/dns4/" +
        domain +
        "/tcp/4003/wss/p2p/" +
        (await axios.get(url + ":9002/peer/id")).data
    );
};

export const getKeypair = async (
    level: Level<string, Uint8Array> = new Level<string, Uint8Array>("./peer", {
        valueEncoding: "view",
    })
) => {
    let keypair: Ed25519Keypair;
    try {
        const bytes = await level.get("_key", { valueEncoding: "view" });
        keypair = deserialize(bytes, Ed25519Keypair);
        return keypair;
    } catch (error) {
        console.log("Failed to find key! ", error);

        keypair = Ed25519Keypair.create();
        await level.put("_key", serialize(keypair));
        return keypair;
    }
};

export const getPeerIdFromKeypair = async (
    keypair: Ed25519Keypair
): Promise<PeerId> => {
    return peerIdFromKeys(
        new supportedKeys["ed25519"].Ed25519PublicKey(
            keypair.publicKey.publicKey
        ).bytes,
        new supportedKeys["ed25519"].Ed25519PrivateKey(
            keypair.privateKey.privateKey,
            keypair.publicKey.publicKey
        ).bytes
    );
};
