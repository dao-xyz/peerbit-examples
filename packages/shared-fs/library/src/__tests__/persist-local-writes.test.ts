import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    FileVersion,
    openSharedFs,
    PersistLocalWritesError,
    type SharedFsHandle,
} from "../index.js";

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

    // Program events: the join the ledger watches.
    const untilReplicaSeen = (fs: SharedFsHandle) =>
        new Promise<void>((resolve, reject) => {
            const events = fs.program.entries.log.events;
            const timer = setTimeout(
                () => reject(new Error("no replicator:join")),
                WAIT_TIMEOUT_MS
            );
            const check = () => {
                if (fs.pendingLocalWrites().remoteReplicaSeen) {
                    clearTimeout(timer);
                    events.removeEventListener("replicator:join", check);
                    resolve();
                }
            };
            events.addEventListener("replicator:join", check);
            check();
        });

    const pair = async () => {
        const sourcePeer = await createPeer("source");
        const otherPeer = await createPeer("other");
        await sourcePeer.dial(otherPeer);
        const source = await open(sourcePeer, "source");
        const other = await open(otherPeer, "other", source.address);
        await untilReplicaSeen(source);
        return { source, other, sourcePeer };
    };

    // Runs `during` once, as the fence starts delivering.
    const onFirstDelivery = (
        fs: SharedFsHandle,
        during: () => Promise<unknown>
    ) => {
        const log: any = fs.program.entries.log;
        const deliver = log.deliverPersistedEntries.bind(log);
        let first = true;
        log.deliverPersistedEntries = async (...args: unknown[]) => {
            if (first) {
                first = false;
                await during();
            }
            return deliver(...args);
        };
    };

    // None of the events a waiting fence starts over on.
    const withholdReplicationEvents = (fs: SharedFsHandle) => {
        const events: any = fs.program.entries.log.events;
        const dispatch = events.dispatchEvent.bind(events);
        events.dispatchEvent = (event: Event) =>
            /^replicator:(join|mature)$|^replication:change$/.test(
                event.type
            ) || dispatch(event);
    };

    it("fences only this replica's writes, once each, while another writer writes", async () => {
        const { source, other } = await pair();

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

        // A rewrite: only its new entries are pending, sent with the name
        // they resolve through (sent again: it may have changed).
        await source.writeFile("/a.txt", "a, again");
        const rewrite = source.pendingLocalWrites().entries;
        expect(rewrite).toBeGreaterThan(0);
        expect(rewrite).toBeLessThan(before + 6);
        expect(
            await source.persistLocalWrites({ timeout: WAIT_TIMEOUT_MS })
        ).toBe(rewrite + 1);
    });

    it("starts over when an entry it holds is deleted under it", async () => {
        const { source } = await pair();
        const versions: string[] = [];
        source.program.entries.events.addEventListener("change", (event) => {
            for (const value of event.detail.added)
                if (value instanceof FileVersion) versions.push(value.id);
        });
        await source.writeFile("/a.txt", "a");
        await source.writeFile("/a.txt", "a, again");
        const pending = source.pendingLocalWrites().entries;
        withholdReplicationEvents(source);
        // As GC deletes the superseded version.
        onFirstDelivery(source, () => source.program.entries.del(versions[0]));
        expect(
            await source.persistLocalWrites({ timeout: WAIT_TIMEOUT_MS })
        ).toBe(pending - 1);
        expect(source.pendingLocalWrites().entries).toBe(0);
    });

    it("starts over when an entry it holds is put again under it", async () => {
        const { source } = await pair();
        await source.writeFile("/a.txt", "same bytes");
        const pending = source.pendingLocalWrites().entries;
        withholdReplicationEvents(source);
        // The same bytes again, not deduplicated: their chunk is put again
        // under its id, and that new head replaces the one being delivered.
        onFirstDelivery(source, () =>
            source.writeFile("/copy.txt", "same bytes", { dedup: "off" })
        );
        const started = performance.now();
        // Its version and its name are new; the chunk is the same entry id.
        expect(
            await source.persistLocalWrites({ timeout: WAIT_TIMEOUT_MS })
        ).toBe(pending + 2);
        // Not at the deadline: the replaced head is never acknowledged.
        expect(performance.now() - started).toBeLessThan(WAIT_TIMEOUT_MS / 2);
        expect(source.pendingLocalWrites().entries).toBe(0);
    });

    it("is not failed by a snapshot published while it runs", async () => {
        const { source } = await pair();
        await source.writeFile("/a.txt", "a");
        // The next snapshot CUTs this one's manifest: maintenance, not fenced.
        await source.snapshotWrite();
        const pending = source.pendingLocalWrites().entries;
        withholdReplicationEvents(source);
        onFirstDelivery(source, () => source.snapshotWrite());
        expect(
            await source.persistLocalWrites({ timeout: WAIT_TIMEOUT_MS })
        ).toBe(pending);
        expect(source.pendingLocalWrites().entries).toBe(0);
    });

    it("fences what is written while it runs", async () => {
        const { source } = await pair();
        await source.writeFile("/before.txt", "before");
        const pending = source.pendingLocalWrites().entries;
        onFirstDelivery(source, () => source.writeFile("/during.txt", "x"));
        expect(
            await source.persistLocalWrites({ timeout: WAIT_TIMEOUT_MS })
        ).toBe(pending + 3);
        expect(source.pendingLocalWrites().entries).toBe(0);
    });

    it("fences the names a path resolves through, an earlier session's too", async () => {
        const writerPeer = await createPeer("writer");
        // An earlier session, alone, makes /dir and ends without a fence.
        const earlier = await open(writerPeer, "writer");
        const address = earlier.address!;
        await earlier.mkdir("/dir");
        await earlier.program.close();

        const receiverPeer = await createPeer("receiver");
        await writerPeer.dial(receiverPeer);
        const writer = await open(writerPeer, "writer", address);
        const receiver = await open(receiverPeer, "receiver", address);
        await untilReplicaSeen(writer);
        const before = writer.pendingLocalWrites().entries;
        await writer.writeFile("/dir/new.txt", "new");
        expect(writer.pendingLocalWrites().entries).toBe(before + 3);
        // /dir's name too, though no write of this session made it.
        expect(
            await writer.persistLocalWrites({ timeout: WAIT_TIMEOUT_MS })
        ).toBe(before + 4);
        await writerPeer.stop();
        expect(
            new TextDecoder().decode(await receiver.readFile("/dir/new.txt"))
        ).toBe("new");
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
