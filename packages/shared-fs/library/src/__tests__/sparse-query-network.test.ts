import { performance } from "node:perf_hooks";
import { Peerbit } from "peerbit";
import { afterEach, expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";
import { SparseQueryClient } from "./sparse-query-client.js";

const peers: Peerbit[] = [];
afterEach(async () => {
    const results = await Promise.allSettled(
        peers.splice(0).map((peer) => peer.stop())
    );
    const errors = results.filter(
        (result): result is PromiseRejectedResult =>
            result.status === "rejected"
    );
    if (errors.length)
        throw new AggregateError(
            errors.map((result) => result.reason),
            "Sparse probe shutdown failed"
        );
});

const payload = (seed: number) => {
    const bytes = new Uint8Array(4096);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + seed) % 251;
    new DataView(bytes.buffer).setUint32(0, seed);
    return bytes;
};

const residency = async (peer: Peerbit, fs: SharedFsHandle) => {
    let blocks = 0;
    let censusBytes = 0;
    for await (const [, bytes] of peer.services.blocks.iterator()) {
        blocks++;
        censusBytes += bytes.byteLength;
        if (blocks > 1024 || censusBytes > 16 * 1024 * 1024)
            throw new Error("Sparse block census budget exceeded");
    }
    return {
        documents: await fs.program.entries.index.getSize(),
        logEntries: fs.program.entries.log.log.length,
        ranges: (await fs.program.entries.log.getMyReplicationSegments())
            .length,
        blocks,
        censusBytes,
        blockBytes: String(await peer.services.blocks.size()),
    };
};

it(
    "queries a sparse real shared-fs observer across edits, moves, deletes and reconnects",
    { retry: 0 },
    async () => {
        const files = Number(process.env.PEERBIT_SHARED_FS_SPARSE_FILES ?? 64);
        if (!Number.isSafeInteger(files) || files < 32 || files > 10_000)
            throw new Error("Sparse fixture files must be 32..10000");
        const sourcePeer = await Peerbit.create();
        peers.push(sourcePeer);
        const source = await openSharedFs({
            peerbit: sourcePeer,
            machineLabel: "sparse-source",
            bootstrap: false,
        });
        await source.writeBatch(
            Array.from({ length: files }, (_, i) => ({
                path: `/cold/f-${i}.bin`,
                content: payload(i),
            }))
        );
        await source.mkdir("/elsewhere");
        const sourceDocuments = await source.program.entries.index.getSize();
        expect(sourceDocuments).toBeGreaterThanOrEqual(files * 3);

        const observerPeer = await Peerbit.create();
        peers.push(observerPeer);
        await observerPeer.dial(sourcePeer);
        const openStart = performance.now();
        const observer = await openSharedFs({
            peerbit: observerPeer,
            address: source.address,
            machineLabel: "sparse-observer",
            replicate: false,
            bootstrap: false,
        });
        const openMs = performance.now() - openStart;
        await observer.program.entries.waitFor(sourcePeer.identity.publicKey, {
            timeout: 5_000,
        });
        const before = await residency(observerPeer, observer);
        expect(before).toMatchObject({
            documents: 0,
            logEntries: 0,
            ranges: 0,
        });
        const reader = new SparseQueryClient(
            observer.program.entries,
            sourcePeer.identity.publicKey.hashcode()
        );
        const firstStart = performance.now();
        const cold = await reader.lookup("root", "cold");
        expect(cold.status).toBe("observed");
        const selected = await reader.lookup(cold.nodeId!, "f-0.bin");
        expect(selected.status).toBe("observed");
        const nodeId = selected.nodeId!;
        const first = await reader.readNode(nodeId);
        expect(first.status).toBe("observed");
        expect(first.bytes).toEqual(payload(0));
        expect(reader.counters.chunkFetches).toBe(1);
        const firstReadMs = performance.now() - firstStart;
        first.bytes!.fill(255);
        expect(await residency(observerPeer, observer)).toEqual(before);
        const warmStart = performance.now();
        expect((await reader.readNode(nodeId)).bytes).toEqual(payload(0));
        const warmReadMs = performance.now() - warmStart;
        expect(reader.counters.chunkFetches).toBe(1);
        expect(reader.counters.cacheHits).toBe(1);

        const scan = Math.min(files, 128);
        const scanStart = performance.now();
        for (let i = 1; i < scan; i++) {
            const slot = await reader.lookup(cold.nodeId!, `f-${i}.bin`);
            expect((await reader.readNode(slot.nodeId!)).bytes).toEqual(
                payload(i)
            );
            expect(reader.cache.stats().bytes).toBeLessThanOrEqual(16 * 1024);
            expect(reader.cache.stats().entries).toBeLessThanOrEqual(4);
        }
        const scanMs = performance.now() - scanStart;
        expect(reader.cache.stats().evictions).toBe(scan - 4);
        const scanCache = reader.cache.stats();
        expect(await residency(observerPeer, observer)).toEqual(before);
        const fetchesBeforeReread = reader.counters.chunkFetches;
        expect((await reader.readNode(nodeId)).bytes).toEqual(payload(0));
        expect(reader.counters.chunkFetches).toBe(fetchesBeforeReread + 1);

        await source.writeFile("/cold/f-0.bin", payload(10_001));
        expect((await reader.readNode(nodeId)).bytes).toEqual(payload(10_001));
        await source.rename("/cold/f-0.bin", "/elsewhere/renamed.bin");
        expect((await reader.lookup(cold.nodeId!, "f-0.bin")).status).toBe(
            "not-observed"
        );
        const destination = await reader.lookup("root", "elsewhere");
        expect(
            (await reader.lookup(destination.nodeId!, "renamed.bin")).nodeId
        ).toBe(nodeId);
        expect((await reader.readNode(nodeId)).naming?.name).toBe(
            "renamed.bin"
        );

        reader.disconnect();
        await observerPeer.hangUp(sourcePeer.identity.publicKey);
        await expect(reader.readNode(nodeId)).rejects.toThrow("disconnected");
        expect(reader.cache.stats()).toMatchObject({ entries: 0, bytes: 0 });
        await source.writeFile("/elsewhere/renamed.bin", payload(10_002));
        await observerPeer.dial(sourcePeer);
        await observer.program.entries.waitFor(sourcePeer.identity.publicKey, {
            timeout: 5_000,
        });
        reader.reconnect();
        // Fresh slot + stable-ID queries, not reuse of a stale path-to-node binding.
        expect(
            (await reader.lookup(destination.nodeId!, "renamed.bin")).nodeId
        ).toBe(nodeId);
        expect((await reader.readNode(nodeId)).bytes).toEqual(payload(10_002));
        await source.rm("/elsewhere/renamed.bin");
        expect((await reader.readNode(nodeId)).status).toBe("deleted");
        expect(
            (await reader.lookup(destination.nodeId!, "renamed.bin")).status
        ).toBe("not-observed");
        const after = await residency(observerPeer, observer);
        expect(after).toEqual(before);
        console.log(
            JSON.stringify({
                event: "shared-fs.sparse-query-probe",
                files,
                sourceDocuments,
                fixturePayloadBytes: files * 4096,
                totalUniqueReadFiles: scan,
                timedScanFiles: scan - 1,
                openMs,
                firstPathLookupAndReadMs: firstReadMs,
                warmNodeReadMs: warmReadMs,
                scanMs,
                scanCache,
                before,
                after,
                counters: reader.counters,
                cache: reader.cache.stats(),
                scope: "single-source read-only explicit-refresh; not live push, global completeness, N-receipts or physical reclamation",
            })
        );
        reader.disconnect();
    }
);
