import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Peerbit } from "peerbit";
import { expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";
import { SparseQueryClient } from "./sparse-query-client.js";
import { SparseMetadataBatchClient } from "./sparse-metadata-batch.js";

const enabled = process.env.PEERBIT_SHARED_FS_METADATA_BATCH_BENCH === "1";
const payload = (seed: number) => {
    const bytes = new Uint8Array(4096);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + seed) % 251;
    new DataView(bytes.buffer).setUint32(0, seed);
    return bytes;
};
const sha = (value: Uint8Array) =>
    createHash("sha256").update(value).digest("hex");
const provenance = async () => {
    const packages: Record<
        string,
        { version: string; entry: string; entrySha256: string }
    > = {};
    for (const name of [
        "peerbit",
        "@peerbit/document",
        "@peerbit/shared-log",
        "@peerbit/crypto",
        "@dao-xyz/borsh",
    ]) {
        const entry = await realpath(fileURLToPath(import.meta.resolve(name)));
        for (let dir = dirname(entry); ; dir = dirname(dir)) {
            try {
                const pkg = JSON.parse(
                    await readFile(join(dir, "package.json"), "utf8")
                );
                if (pkg.name === name) {
                    packages[name] = {
                        version: pkg.version,
                        entry,
                        entrySha256: sha(await readFile(entry)),
                    };
                    break;
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                    throw error;
            }
            if (dir === dirname(dir))
                throw new Error(`Missing package provenance: ${name}`);
        }
    }
    const sourceHashes: Record<string, string> = {};
    for (const path of [
        "sparse-metadata-batch.bench.test.ts",
        "sparse-metadata-batch.ts",
        "sparse-query-client.ts",
        "sparse-query-cache.ts",
        "../../../../../pnpm-lock.yaml",
    ])
        sourceHashes[path] = sha(
            await readFile(new URL(path, import.meta.url))
        );
    return {
        packages,
        sourceHashes,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
    };
};
const residency = async (peer: Peerbit, fs: SharedFsHandle) => {
    let blocks = 0,
        censusBytes = 0;
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

it.skipIf(!enabled)(
    "compares bounded lookup batching with unchanged sequential reads",
    { retry: 0 },
    async () => {
        const mode = process.env.PEERBIT_SHARED_FS_METADATA_BATCH_MODE;
        if (mode !== "baseline" && mode !== "batch")
            throw new Error("Batch benchmark requires baseline or batch mode");
        const label = process.env.PEERBIT_SHARED_FS_METADATA_BATCH_LABEL;
        if (!label || !/^[a-zA-Z0-9-]{1,32}$/.test(label))
            throw new Error("Batch benchmark requires a bounded run label");
        const files = Number(
            process.env.PEERBIT_SHARED_FS_SPARSE_FILES ?? 5000
        );
        if (!Number.isSafeInteger(files) || files < 32 || files > 5000)
            throw new Error("Batch fixture files must be 32..5000");
        const peers: Peerbit[] = [];
        const errors: unknown[] = [];
        const report: Record<string, unknown> = {
            event: "shared-fs.sparse-metadata-batch-benchmark",
            label,
            mode,
            files,
            batchSize: 8,
            scope: "test-only same-process memory-store explicit-source lookup batching; not atomic freshness, production speedup, durability or writable sparse mount",
            instrumentation:
                "identical outer timers and logical query/row counters; no phase/transport wrapper; query count is not page or wire count",
        };
        let reader: SparseQueryClient | undefined,
            batch: SparseMetadataBatchClient | undefined;
        try {
            const beforeSource = await provenance();
            report.provenance = beforeSource;
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
            report.sourceDocuments =
                await source.program.entries.index.getSize();
            expect(report.sourceDocuments).toBeGreaterThanOrEqual(files * 3);
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
            report.openMs = performance.now() - openStart;
            await observer.program.entries.waitFor(
                sourcePeer.identity.publicKey,
                { timeout: 5000 }
            );
            const before = await residency(observerPeer, observer);
            report.before = before;
            expect(before).toMatchObject({
                documents: 0,
                logEntries: 0,
                ranges: 0,
            });
            reader = new SparseQueryClient(
                observer.program.entries,
                sourcePeer.identity.publicKey.hashcode()
            );
            batch = new SparseMetadataBatchClient(
                observer.program.entries,
                sourcePeer.identity.publicKey.hashcode()
            );
            const firstStart = performance.now();
            const cold = await reader.lookup("root", "cold");
            expect(cold.status).toBe("observed");
            const firstSlot = await reader.lookup(cold.nodeId!, "f-0.bin");
            expect(firstSlot.status).toBe("observed");
            const first = await reader.readNode(firstSlot.nodeId!);
            expect(first.bytes).toEqual(payload(0));
            report.firstPathLookupAndReadMs = performance.now() - firstStart;
            first.bytes!.fill(255);
            expect((await reader.readNode(firstSlot.nodeId!)).bytes).toEqual(
                payload(0)
            );
            expect(reader.counters.chunkFetches).toBe(1);
            expect(reader.counters.cacheHits).toBe(1);
            const scan = Math.min(files, 128);
            const initialCounts = { ...reader.counters };
            const scanStart = performance.now();
            for (let start = 1; start < scan; start += 8) {
                const indexes = Array.from(
                    { length: Math.min(8, scan - start) },
                    (_, i) => start + i
                );
                // Keep the baseline's lookup -> read order. Only independent slot
                // discoveries/revalidations move earlier in the opt-in variant.
                const slots =
                    mode === "batch"
                        ? await batch.lookupMany(
                              indexes.map((i) => ({
                                  parentId: cold.nodeId!,
                                  name: `f-${i}.bin`,
                              }))
                          )
                        : undefined;
                for (const [position, i] of indexes.entries()) {
                    const slot =
                        slots?.[position] ??
                        (await reader.lookup(cold.nodeId!, `f-${i}.bin`));
                    expect(slot.status).toBe("observed");
                    expect((await reader.readNode(slot.nodeId!)).bytes).toEqual(
                        payload(i)
                    );
                    expect(reader.cache.stats().bytes).toBeLessThanOrEqual(
                        16 * 1024
                    );
                    expect(reader.cache.stats().entries).toBeLessThanOrEqual(4);
                }
            }
            report.scanMs = performance.now() - scanStart;
            report.timedScanFiles = scan - 1;
            report.scanCache = reader.cache.stats();
            report.scanCounters = {
                queries:
                    reader.counters.queries -
                    initialCounts.queries +
                    batch.counters.queries,
                rows:
                    reader.counters.rows -
                    initialCounts.rows +
                    batch.counters.rows,
                chunkFetches:
                    reader.counters.chunkFetches - initialCounts.chunkFetches,
                cacheHits: reader.counters.cacheHits - initialCounts.cacheHits,
                batchedQueries: batch.counters.queries,
            };
            expect(report.scanCounters).toMatchObject({
                queries:
                    mode === "batch"
                        ? 2 * Math.ceil((scan - 1) / 8) + 3 * (scan - 1)
                        : 5 * (scan - 1),
                rows: 5 * (scan - 1),
                chunkFetches: scan - 1,
                cacheHits: 0,
            });
            expect(reader.cache.stats().evictions).toBe(scan - 4);
            expect(await residency(observerPeer, observer)).toEqual(before);
            expect((await reader.readNode(firstSlot.nodeId!)).bytes).toEqual(
                payload(0)
            );
            await source.writeFile("/cold/f-0.bin", payload(10001));
            expect((await reader.readNode(firstSlot.nodeId!)).bytes).toEqual(
                payload(10001)
            );
            await source.rename("/cold/f-0.bin", "/elsewhere/renamed.bin");
            expect(
                (
                    await batch.lookupMany([
                        { parentId: cold.nodeId!, name: "f-0.bin" },
                    ])
                )[0].status
            ).toBe("not-observed");
            const destination = await reader.lookup("root", "elsewhere");
            const renamedSlot = {
                parentId: destination.nodeId!,
                name: "renamed.bin",
            };
            expect((await batch.lookupMany([renamedSlot]))[0].nodeId).toBe(
                firstSlot.nodeId
            );
            reader.disconnect();
            batch.disconnect();
            await observerPeer.hangUp(sourcePeer.identity.publicKey);
            await expect(batch.lookupMany([renamedSlot])).rejects.toThrow(
                "disconnected"
            );
            await expect(reader.readNode(firstSlot.nodeId!)).rejects.toThrow(
                "disconnected"
            );
            expect(reader.cache.stats()).toMatchObject({
                entries: 0,
                bytes: 0,
            });
            await source.writeFile("/elsewhere/renamed.bin", payload(10002));
            await observerPeer.dial(sourcePeer);
            await observer.program.entries.waitFor(
                sourcePeer.identity.publicKey,
                { timeout: 5000 }
            );
            reader.reconnect();
            batch.reconnect();
            expect((await batch.lookupMany([renamedSlot]))[0].nodeId).toBe(
                firstSlot.nodeId
            );
            expect((await reader.readNode(firstSlot.nodeId!)).bytes).toEqual(
                payload(10002)
            );
            await source.rm("/elsewhere/renamed.bin");
            expect((await reader.readNode(firstSlot.nodeId!)).status).toBe(
                "deleted"
            );
            expect((await batch.lookupMany([renamedSlot]))[0].status).toBe(
                "not-observed"
            );
            report.after = await residency(observerPeer, observer);
            expect(report.after).toEqual(before);
            expect(await provenance()).toEqual(beforeSource);
        } catch (error) {
            errors.push(error);
            try {
                report.firstFailure = {
                    type: typeof error,
                    message:
                        error instanceof Error ? error.message : String(error),
                };
            } catch {
                report.firstFailure = {
                    type: typeof error,
                    message: "unformattable rejection",
                };
            }
        } finally {
            reader?.disconnect();
            batch?.disconnect();
            const stops = await Promise.allSettled(
                peers.map(async (peer) => peer.stop())
            );
            for (const stop of stops)
                if (stop.status === "rejected") errors.push(stop.reason);
            report.shutdown = stops.map((stop) => stop.status);
        }
        report.ok = errors.length === 0;
        console.log(JSON.stringify(report));
        if (errors.length === 1) throw errors[0];
        if (errors.length)
            throw new AggregateError(
                errors,
                "Batch experiment and cleanup failed"
            );
    }
);
