import axios from "axios";
import { Level } from "level";
import { serialize, deserialize } from "@dao-xyz/borsh";
import { Ed25519Keypair } from "@dao-xyz/peerbit-crypto";

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

let _getKeypair: Promise<any>;
export const getKeypair = async (
    level: Level<string, Uint8Array> = new Level<string, Uint8Array>("./peer", {
        valueEncoding: "view",
    })
): Promise<Ed25519Keypair> => {
    await _getKeypair;
    const fn = async () => {
        let keypair: Ed25519Keypair;
        try {
            const bytes = await level.get("_key", { valueEncoding: "view" });
            keypair = deserialize(bytes, Ed25519Keypair);
            return keypair;
        } catch (error) {
            console.log("Failed to find key! ", error);

            keypair = await Ed25519Keypair.create();
            await level.put("_key", serialize(keypair));
            return keypair;
        }
    };
    _getKeypair = fn();
    return _getKeypair;
};
