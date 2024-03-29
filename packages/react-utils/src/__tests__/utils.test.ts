import { getAllKeyPairs, getFreeKeypair, releaseKey } from "../utils";
import nodelocalstorage from "node-localstorage";
import { FastMutex } from "../lockstorage";
import { delay } from "@peerbit/time";
import { default as sodium } from "libsodium-wrappers";
import { v4 as uuid } from "uuid";
var LocalStorage = nodelocalstorage.LocalStorage;
var localStorage = new LocalStorage("./tmp/getKeypair");
globalThis.localStorage = localStorage;

describe("getKeypair", () => {
    beforeAll(async () => {
        await sodium.ready;
    });

    it("can aquire multiple keypairs", async () => {
        let timeout = 1000;
        let mutex = new FastMutex({ localStorage, timeout });
        let lock = true;
        const lockCondition = () => lock;
        let id = uuid();
        const { key: keypair, path: path1 } = await getFreeKeypair(
            id,
            mutex,
            lockCondition
        );
        const { key: keypair2, path: path2 } = await getFreeKeypair(id, mutex);
        expect(keypair!.equals(keypair2!)).toBeFalse();
        expect(path1).not.toEqual(path2);
        lock = false;
        await delay(timeout);
        const { path: path3, key: keypair3 } = await getFreeKeypair(id, mutex);
        expect(path3).toEqual(path1);
        expect(keypair3.equals(keypair)).toBeTrue();

        const allKeypair = await getAllKeyPairs(id);
        expect(allKeypair.map((x) => x.publicKey.hashcode())).toEqual([
            keypair3.publicKey.hashcode(),
            keypair2.publicKey.hashcode(),
        ]);
    });

    it("can release if same id", async () => {
        let timeout = 1000;
        let mutex = new FastMutex({ localStorage, timeout });
        let lock = true;
        const lockCondition = () => lock;
        let id = uuid();
        const { key: keypair, path: path1 } = await getFreeKeypair(
            id,
            mutex,
            lockCondition,
            true
        );
        const { key: keypair2, path: path2 } = await getFreeKeypair(
            id,
            mutex,
            undefined,
            true
        );
        expect(keypair!.equals(keypair2!)).toBeTrue();
        expect(path1).toEqual(path2);
        const allKeypair = await getAllKeyPairs(id);
        expect(allKeypair).toHaveLength(1);
    });

    it("releases manually", async () => {
        let timeout = 1000;
        let mutex = new FastMutex({ localStorage, timeout });
        const id = uuid();

        const { key: keypair, path: path1 } = await getFreeKeypair(id, mutex);

        const { key: keypair2, path: path2 } = await getFreeKeypair(id, mutex);

        expect(path1).not.toEqual(path2);
        releaseKey(path1, mutex);
        expect(mutex.getLockedInfo(path1)).toBeUndefined();
        const { key: keypair3, path: path3 } = await getFreeKeypair(id, mutex);

        expect(path1).toEqual(path3); // we can now acquire key at path1 again, since we released it
    });
});
