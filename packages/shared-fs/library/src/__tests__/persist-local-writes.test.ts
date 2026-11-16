import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { openSharedFs, PersistLocalWritesError } from "../index.js";

// A give-up bound, not a retry budget.
const WAIT_TIMEOUT_MS = 30_000;

describe("persistLocalWrites", () => {
    const peers = new Set<Peerbit>();
    const directories: string[] = [];

    const createPeer = async (label: string) => {
        const directory = await mkdtemp(
            join(tmpdir(), `peerbit-shared-fs-persist-local-${label}-`)
        );
        directories.push(directory);
        const peer = await Peerbit.create({ directory });
        peers.add(peer);
        return peer;
    };

    afterEach(async () => {
        await Promise.allSettled([...peers].map((peer) => peer.stop()));
        peers.clear();
        for (const directory of directories.splice(0)) {
            await rm(directory, {
                recursive: true,
                force: true,
                maxRetries: 10,
                retryDelay: 200,
            });
        }
    });

    const open = (peerbit: Peerbit, label: string, address?: string) =>
        openSharedFs({
            peerbit,
            ...(address ? { address, allowPartialWrites: true } : {}),
            machineLabel: label,
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });

    it("fences only this replica's writes, once each, while another writer writes", async () => {
        const sourcePeer = await createPeer("source");
        const otherPeer = await createPeer("other");
        await sourcePeer.dial(otherPeer);
        const source = await open(sourcePeer, "source");
        const other = await open(otherPeer, "other", source.address);
        // Program events: the join the ledger watches.
        await new Promise<void>((resolve, reject) => {
            const events = source.program.entries.log.events;
            const timer = setTimeout(
                () => reject(new Error("no replicator:join")),
                WAIT_TIMEOUT_MS
            );
            const check = () => {
                if (source.pendingLocalWrites().remoteReplicaSeen) {
                    clearTimeout(timer);
                    events.removeEventListener("replicator:join", check);
                    resolve();
                }
            };
            events.addEventListener("replicator:join", check);
            check();
        });

        const before = source.pendingLocalWrites().entries;
        await source.writeFile("/a.txt", "a");
        await source.writeFile("/b.txt", "b");
        // A chunk, a version and a name per new file.
        expect(source.pendingLocalWrites().entries).toBe(before + 6);

        // The other writer's file reaches the source but is not its write.
        await other.writeFile("/other.txt", "other");
        await new Promise<void>((resolve) => {
            const events = source.program.entries.events;
            const check = async () => {
                if (await source.readFile("/other.txt")) {
                    events.removeEventListener("change", check);
                    resolve();
                }
            };
            events.addEventListener("change", check);
            void check();
        });
        expect(source.pendingLocalWrites().entries).toBe(before + 6);

        const acknowledged = await source.persistLocalWrites({
            timeout: WAIT_TIMEOUT_MS,
        });
        expect(acknowledged).toBe(before + 6);
        expect(source.pendingLocalWrites().entries).toBe(0);
        // Acknowledged once: nothing to send again.
        expect(
            await source.persistLocalWrites({ timeout: WAIT_TIMEOUT_MS })
        ).toBe(0);

        // A rewrite: only its new entries are pending and sent.
        await source.writeFile("/a.txt", "a, again");
        const rewrite = source.pendingLocalWrites().entries;
        expect(rewrite).toBeGreaterThan(0);
        expect(rewrite).toBeLessThan(before + 6);
        expect(
            await source.persistLocalWrites({ timeout: WAIT_TIMEOUT_MS })
        ).toBe(rewrite);
    });

    it("fails at once without a timeout when no replica can acknowledge, listing what is left", async () => {
        const alone = await open(await createPeer("alone"), "alone");
        await alone.writeFile("/only-here.txt", "only here");
        const error = await alone.persistLocalWrites().then(
            () => undefined,
            (error: unknown) => error
        );
        expect(error).toBeInstanceOf(PersistLocalWritesError);
        const { unacknowledged } = error as PersistLocalWritesError;
        expect(
            unacknowledged.filter(({ path }) => path === "/only-here.txt")
        ).toHaveLength(3);
        expect(alone.pendingLocalWrites()).toEqual({
            entries: unacknowledged.length,
            remoteReplicaSeen: false,
        });
        await expect(alone.persistLocalWrites({ minAcks: 0 })).rejects.toThrow(
            "persistLocalWrites requires a positive integer minAcks"
        );
    });
});
