import { randomBytes } from "node:crypto";
import { StringMatch } from "@peerbit/document";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";
import { FileChunk, FileVersion } from "../model.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * GC's HEAL step repairs a chunk a surviving version names but this replica
 * lacks. Since PR-3 commit 4 a fresh joiner turns write-ready once its
 * namespace rows are contained, often before a single chunk arrived (design
 * 2.3: chunk bytes are not proven), so a GC right after ready, manual or
 * the first scheduled tick, meets chunks that are only still replicating.
 * Healing those re-puts them as new entries that every replica receives
 * again in full. A missing chunk is damage only once a version naming it
 * arrived here at least `chunkGraceMs` ago, the window chunk deletion also
 * leaves for replication lag; before that its node is kept out of deletion
 * for the run, as a damaged node is, and nothing is put.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const programOf = (fs: SharedFsHandle): any => fs.program;

const waitUntil = async (
    assertion: () => Promise<void> | void,
    timeoutMs = process.env.CI ? 60_000 : 30_000
) => {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
    throw lastError;
};

/** Every chunk id a version of `fs` names, from its local index. */
const chunkIdsOf = async (fs: SharedFsHandle) => {
    const versions: FileVersion[] = await programOf(fs).queryDocuments([
        new StringMatch({ key: "kind", value: "file-version" }),
    ]);
    return new Set(versions.flatMap((version) => version.chunkIds));
};

/** The chunk ids of `ids` that `fs` lacks locally. */
const missingOn = async (fs: SharedFsHandle, ids: Iterable<string>) => {
    const missing: string[] = [];
    for (const id of ids) {
        if (!(await programOf(fs).hasDocument(id))) missing.push(id);
    }
    return missing;
};

/** Counts the FileChunk entries `fs` itself puts from now on. */
const countChunkPuts = (fs: SharedFsHandle) => {
    const entries = programOf(fs).entries;
    const put = entries.put;
    const counts = { puts: 0 };
    entries.put = function (this: unknown, value: unknown, ...rest: unknown[]) {
        if (value instanceof FileChunk) counts.puts++;
        return put.call(this, value, ...rest);
    };
    return { counts, restore: () => (entries.put = put) };
};

describe("GC heal of chunks still replicating", () => {
    const peers: Peerbit[] = [];
    const restores: Array<() => void> = [];

    afterEach(async () => {
        for (const restore of restores.splice(0).reverse()) restore();
        await stopTestPeers(peers);
    });

    const createPeer = async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        return peer;
    };

    /** A creator holding `files` files of `bytes` random bytes each. */
    const createDonor = async (files: number, bytes: number) => {
        const peer = await createPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "heal-donor",
            gc: false,
        });
        for (let i = 0; i < files; i++) {
            await fs.writeFile(`/f-${i}.bin`, randomBytes(bytes));
        }
        return { peer, fs };
    };

    const joinOf = async (donor: { peer: Peerbit; fs: SharedFsHandle }) => {
        const peer = await createPeer();
        await peer.dial(donor.peer);
        const fs = await openSharedFs({
            peerbit: peer,
            address: donor.fs.address,
            machineLabel: "heal-joiner",
            bootstrap: false,
            gc: false,
        });
        return { peer, fs };
    };

    it("GC right after a fresh join heals nothing that is still replicating, and keeps those nodes out of deletion", async () => {
        const donor = await createDonor(48, 384 * 1024);
        const joiner = await joinOf(donor);
        await joiner.fs.awaitWriteReady({ timeout: 60_000 });
        expect(joiner.fs.bootstrapStatus().writeReadinessSource).toBe(
            "reconciled"
        );
        const chunkIds = await chunkIdsOf(donor.fs);
        expect(chunkIds.size).toBe(48);
        const missingAtReady = (await missingOn(joiner.fs, chunkIds)).length;

        const watch = countChunkPuts(joiner.fs);
        restores.push(watch.restore);
        const report = await joiner.fs.collectGarbage({ settleMs: 0 });
        watch.restore();
        console.info(
            `gc-heal: ${missingAtReady} of ${chunkIds.size} chunks missing at ready; healed ${report.healedChunks}, chunk puts ${watch.counts.puts}`
        );
        expect(report.healedChunks).toBe(0);
        expect(report.damagedNodeIds).toEqual([]);
        expect(watch.counts.puts).toBe(0);
        if (missingAtReady > 0) {
            expect(report.warnings).toContainEqual(
                expect.stringMatching(
                    /^[1-9][0-9]* nodes? reference chunks that may still be replicating/
                )
            );
        }

        // They were in flight, not lost: sync delivers every one.
        await waitUntil(async () =>
            expect(await missingOn(joiner.fs, chunkIds)).toEqual([])
        );
        expect(await missingOn(donor.fs, chunkIds)).toEqual([]);
    });

    it("heals a missing chunk once a version naming it arrived chunkGraceMs ago, and not before", async () => {
        const donor = await createDonor(2, 1024);
        const joiner = await joinOf(donor);
        await joiner.fs.awaitWriteReady({ timeout: 60_000 });
        const chunkIds = await chunkIdsOf(donor.fs);
        await waitUntil(async () =>
            expect(await missingOn(joiner.fs, chunkIds)).toEqual([])
        );
        // The joiner reads one chunk as absent: lost locally, a remote copy
        // (here the local one, which fetchChunk verifies) can heal it.
        const [victim] = [...chunkIds];
        const program = programOf(joiner.fs);
        const hasDocument = program.hasDocument;
        program.hasDocument = function (this: unknown, id: string) {
            return id === victim
                ? Promise.resolve(false)
                : hasDocument.call(this, id);
        };
        restores.push(() => delete program.hasDocument);
        const watch = countChunkPuts(joiner.fs);
        restores.push(watch.restore);

        // Its version arrived moments ago: it may still be replicating.
        const young = await joiner.fs.collectGarbage({ settleMs: 0 });
        expect(young.healedChunks).toBe(0);
        expect(young.damagedNodeIds).toEqual([]);
        expect(young.warnings).toContainEqual(
            expect.stringMatching(
                /^1 node references chunks that may still be replicating/
            )
        );
        expect(watch.counts.puts).toBe(0);

        // Two days later the same absence is damage, and HEAL repairs it.
        const settled = await joiner.fs.collectGarbage({
            settleMs: 0,
            nowMs: Date.now() + 2 * DAY_MS,
        });
        expect(settled.healedChunks).toBe(1);
        expect(settled.damagedNodeIds).toEqual([]);
        expect(watch.counts.puts).toBe(1);
    });

    it("puts nothing when the chunk arrived while its heal fetch ran", async () => {
        const donor = await createDonor(1, 1024);
        const joiner = await joinOf(donor);
        await joiner.fs.awaitWriteReady({ timeout: 60_000 });
        const chunkIds = await chunkIdsOf(donor.fs);
        await waitUntil(async () =>
            expect(await missingOn(joiner.fs, chunkIds)).toEqual([])
        );
        // Absent at HEAL's probe, present again once the fetch returned.
        const [victim] = [...chunkIds];
        const program = programOf(joiner.fs);
        const hasDocument = program.hasDocument;
        let probes = 0;
        program.hasDocument = function (this: unknown, id: string) {
            if (id === victim && probes++ === 0) return Promise.resolve(false);
            return hasDocument.call(this, id);
        };
        restores.push(() => delete program.hasDocument);
        const watch = countChunkPuts(joiner.fs);
        restores.push(watch.restore);

        const report = await joiner.fs.collectGarbage({
            settleMs: 0,
            nowMs: Date.now() + 2 * DAY_MS,
        });
        expect(probes).toBe(2);
        expect(report.healedChunks).toBe(0);
        expect(report.damagedNodeIds).toEqual([]);
        expect(watch.counts.puts).toBe(0);
    });
});
