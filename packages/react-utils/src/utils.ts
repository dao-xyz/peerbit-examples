import axios from "axios";
import { serialize, deserialize } from "@dao-xyz/borsh";
import { Ed25519Keypair, toBase64, fromBase64 } from "@dao-xyz/peerbit-crypto";
import { FastMutex } from "./lockstorage";
import { v4 as uuid } from "uuid";

export const resolveSwarmAddress = async (url: string, timeout = 5000) => {
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
        (await axios.get(url + ":9002/peer/id", { timeout })).data
    );
};

export const getTabId = () => {
    const idFromStorage = sessionStorage.getItem("TAB_ID");
    if (idFromStorage) {
        return idFromStorage;
    } else {
        const id = uuid(); // generate unique UUID
        sessionStorage.setItem("TAB_ID", id);
        return id;
    }
};

const ID_COUNTER_KEY = "idc/";

const getKeyId = (prefix: string, id: number) => prefix + "/" + id;

export const releaseKey = (
    path: string,
    lock: FastMutex = new FastMutex({ clientId: getTabId() })
) => {
    lock.release(path);
};

export const getFreeKeypair = async (
    id: string = "",
    lock: FastMutex = new FastMutex({ clientId: getTabId() }),
    lockCondition: () => boolean = () => true,
    releaseLockIfSameId?: boolean
) => {
    const idCounterKey = ID_COUNTER_KEY + id;
    await lock.lock(idCounterKey, () => true);
    let idCounter = JSON.parse(localStorage.getItem(idCounterKey) || "0");
    for (let i = 0; i < 10000; i++) {
        const key = getKeyId(id, i);
        let lockedInfo = lock.getLockedInfo(key);
        if (lockedInfo) {
            if (lockedInfo === lock.clientId && releaseLockIfSameId) {
                await lock.release(key); // Release lock
            } else {
                continue;
            }
        }
        console.log("aquire id at", i);
        await lock.lock(key, lockCondition);

        localStorage.setItem(
            idCounterKey,
            JSON.stringify(Math.max(idCounter, i + 1))
        );
        await lock.release(idCounterKey);
        return {
            path: key,
            key: await getKeypair(key),
        };
    }
    throw new Error("Failed to resolve key");
};

export const getAllKeyPairs = async (id: string = "") => {
    const idCounterKey = ID_COUNTER_KEY + id;
    const counter = JSON.parse(localStorage.getItem(idCounterKey) || "0");
    let ret: Ed25519Keypair[] = [];
    for (let i = 0; i < counter; i++) {
        const key = getKeyId(id, i);
        const kp = loadKeypair(key);
        if (kp) {
            ret.push(kp);
        }
    }
    return ret;
};

let _getKeypair: Promise<any>;

export const getKeypair = async (keyName: string): Promise<Ed25519Keypair> => {
    await _getKeypair;
    const fn = async () => {
        let keypair: Ed25519Keypair | undefined = loadKeypair(keyName);
        if (keypair) {
            return keypair;
        }

        keypair = await Ed25519Keypair.create();
        saveKeypair(keyName, keypair);
        return keypair;
    };
    _getKeypair = fn();
    return _getKeypair;
};

const saveKeypair = (path: string, key: Ed25519Keypair) => {
    const str = toBase64(serialize(key));
    localStorage.setItem("_keys/" + path, str);
};

const loadKeypair = (path: string) => {
    let item = localStorage.getItem("_keys/" + path);
    if (!item) {
        return;
    }
    return deserialize(fromBase64(item), Ed25519Keypair);
};

export const inIframe = () => {
    try {
        return window.self !== window.top;
    } catch (e) {
        return true;
    }
};
