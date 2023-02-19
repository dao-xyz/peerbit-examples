import axios from "axios";
import { AbstractLevel } from "abstract-level";
import { serialize, deserialize } from "@dao-xyz/borsh";
import { Ed25519Keypair } from "@dao-xyz/peerbit-crypto";
import { FastMutex } from "./lockstorage";

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

export const getFreeKeypair = async (
    level: AbstractLevel<any, string, Uint8Array>,
    id: string = "node/" + document.referrer ||
        "root" + "/" + window.self.location.host,
    lock: FastMutex = new FastMutex({ clientId: "ID" }),
    lockCondition: () => boolean = () => true
) => {
    for (let i = 0; i < 100; i++) {
        const key = id + "/" + i;
        if (lock.isLocked(key)) {
            continue;
        }
        await lock.lock(key, lockCondition);
        return {
            path: key,
            key: await getKeypair(level, key),
        };
    }
    throw new Error("Failed to resolve key");
};

let _getKeypair: Promise<any>;
export const getKeypair = async (
    level: AbstractLevel<any, string, Uint8Array>,
    keyName?: string
): Promise<Ed25519Keypair> => {
    await _getKeypair;
    const fn = async () => {
        let keypair: Ed25519Keypair;
        const keySuffix = keyName ? "/" + keyName : "";
        try {
            const bytes = await level.get("_key" + keySuffix, {
                valueEncoding: "view",
            });
            keypair = deserialize(bytes, Ed25519Keypair);
            return keypair;
        } catch (error) {
            keypair = await Ed25519Keypair.create();
            await level.put("_key" + keySuffix, serialize(keypair));
            return keypair;
        }
    };
    _getKeypair = fn();
    return _getKeypair;
};
