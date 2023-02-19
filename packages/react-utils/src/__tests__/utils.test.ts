import { getFreeKeypair } from "../utils";
import nodelocalstorage from "node-localstorage";
import { FastMutex } from "../lockstorage";
import { MemoryLevel } from "memory-level";
import { delay } from "@dao-xyz/peerbit-time";
var LocalStorage = nodelocalstorage.LocalStorage;
var localStorage = new LocalStorage("./tmp");

describe("getKeypair", () => {
    let level: MemoryLevel<string, Uint8Array>;
    beforeEach(() => {
        level = new MemoryLevel({ valueEncoding: "view" });
    });
    afterEach(async () => {
        await level.close();
    });
    it("can aquire multiple keypairs", async () => {
        let timeout = 1000;
        let mutex = new FastMutex({ localStorage, timeout });
        let lock = true;
        const lockCondition = () => lock;
        const { key: keypair, path: path1 } = await getFreeKeypair(
            level,
            "id",
            mutex,
            lockCondition
        );
        const { key: keypair2, path: path2 } = await getFreeKeypair(
            level,
            "id",
            mutex
        );
        expect(keypair!.equals(keypair2!)).toBeFalse();
        expect(path1).not.toEqual(path2);
        lock = false;
        await delay(timeout);
        const { path: path3, key: keypair3 } = await getFreeKeypair(
            level,
            "id",
            mutex
        );
        expect(path3).toEqual(path1);
        expect(keypair3.equals(keypair)).toBeTrue();
    });
});
