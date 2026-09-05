/** Public namespace phases, one fresh process per shape; no mount or remote durability claim. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { cpus, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringMatch } from "@peerbit/document";
import { Peerbit } from "peerbit";
import { openSharedFs, type SharedFsHandle } from "../index.js";

const shape = process.argv[2];
const size = Number(process.argv[3]);
assert(["wide", "versions", "churn", "claims"].includes(shape));
assert(Number.isSafeInteger(size) && size >= 2 && size <= 10_000);
const samples = 20;
const peers: Peerbit[] = [];
const phases: Record<string, unknown> = {};
const counts: Record<string, unknown> = {};
const decode = (bytes: Uint8Array | undefined) =>
    bytes && new TextDecoder().decode(bytes);
const hash = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex");
const fileHash = async (relative: string) =>
    hash(await readFile(new URL(relative, import.meta.url)));
const provenance = async (name: string) => {
    const url = import.meta.resolve(name);
    const entry = await realpath(fileURLToPath(url));
    for (let directory = dirname(entry); ; ) {
        try {
            const bytes = await readFile(join(directory, "package.json"));
            const pkg = JSON.parse(bytes.toString());
            if (pkg.name === name)
                return {
                    version: pkg.version,
                    url,
                    entry,
                    entrySha256: hash(await readFile(entry)),
                    packageSha256: hash(bytes),
                };
        } catch (error: any) {
            if (error.code !== "ENOENT") throw error;
        }
        const parent = dirname(directory);
        assert.notEqual(parent, directory, `cannot identify ${name}`);
        directory = parent;
    }
};
const modules = Object.fromEntries(
    await Promise.all(
        [
            "peerbit",
            "@peerbit/document",
            "@peerbit/shared-log",
            "@dao-xyz/borsh",
            "@peerbit/crypto",
        ].map(async (name) => [name, await provenance(name)])
    )
);
const memory = () => ({ ...process.memoryUsage() });
const memoryBefore = memory();
const counters = (fs: SharedFsHandle) => ({
    queries: fs.program.rowQueries,
    candidates: (fs.program as any).slotCandidateRowsExamined as number,
});
const measure = async <T>(
    fs: SharedFsHandle,
    name: string,
    repetitions: number,
    operation: (i: number) => Promise<T>,
    validate: (value: T, i: number) => unknown | Promise<unknown>
) => {
    const elapsed: number[] = [];
    let queries = 0;
    let candidates = 0;
    for (let i = 0; i < repetitions; i++) {
        const before = counters(fs);
        const start = performance.now();
        const value = await operation(i);
        elapsed.push(performance.now() - start);
        const after = counters(fs);
        queries += after.queries - before.queries;
        candidates += after.candidates - before.candidates;
        await validate(value, i); // Oracles, including validation IO, are outside timers/counters.
    }
    const sorted = [...elapsed].sort((a, b) => a - b);
    phases[name] = {
        samples: repetitions,
        firstMs: elapsed[0],
        totalMs: elapsed.reduce((a, b) => a + b, 0),
        p50Ms: sorted[Math.ceil(repetitions * 0.5) - 1],
        p95Ms: sorted[Math.ceil(repetitions * 0.95) - 1],
        indexOnlyRowQueries: queries,
        pointCandidateRowsExamined: candidates,
    };
};
const rowsOf = async (fs: SharedFsHandle, kind: string): Promise<any[]> =>
    fs.program.entries.index
        .iterate(
            { query: [new StringMatch({ key: "kind", value: kind })] },
            { local: true, remote: false, resolve: false }
        )
        .all();
const snapshot = (fs: SharedFsHandle) =>
    (fs.program as any).slotCandidateCache.snapshot();
const coldCandidates = (fs: SharedFsHandle) =>
    (fs.program as any).slotCandidateCache.clear();
const makePeer = async (partitioned?: () => boolean) => {
    const gate =
        partitioned &&
        Object.fromEntries(
            [
                "denyDialPeer",
                "denyDialMultiaddr",
                "denyInboundConnection",
                "denyOutboundConnection",
                "denyInboundEncryptedConnection",
                "denyOutboundEncryptedConnection",
                "denyInboundUpgradedConnection",
                "denyOutboundUpgradedConnection",
            ].map((name) => [name, partitioned])
        );
    const peer = await Peerbit.create(
        gate ? { libp2p: { connectionGater: gate } } : {}
    );
    peers.push(peer);
    return peer;
};
const waitFor = async (predicate: () => Promise<boolean>, label: string) => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
        while (!stopped) {
            if (await predicate()) return;
            if (!stopped)
                await new Promise((resolve) => setTimeout(resolve, 25));
        }
    };
    try {
        await Promise.race([
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    stopped = true;
                    reject(
                        new Error(`${label}: convergence deadline exceeded`)
                    );
                }, 30_000);
            }),
            poll(),
        ]);
    } finally {
        stopped = true;
        if (timer) clearTimeout(timer);
    }
    // These read APIs expose no cancellation signal. The deadline bounds the
    // caller and stops future polls, not an already pending read. The parent
    // process's unchanged 90-second cap also covers stuck IO and shutdown.
};

let report: Record<string, unknown> | undefined;
let failure: unknown;
let collectClaimsDiagnostics: (() => Promise<unknown>) | undefined;
try {
    let fs: SharedFsHandle;
    if (shape === "claims") {
        let partitioned = false;
        for (let i = 0; i < 3; i++) await makePeer(() => partitioned);
        for (let i = 0; i < peers.length; i++)
            for (let j = i + 1; j < peers.length; j++)
                await peers[i].dial(peers[j]);
        fs = await openSharedFs({ peerbit: peers[0], machineLabel: "claim-0" });
        // Address-open readiness needs genuine remote history before the
        // deliberate partition; never enable unsafe partial writes here.
        await fs.writeFile("/ready.txt", "ready");
        const handles = [fs];
        for (let i = 1; i < peers.length; i++)
            handles.push(
                await openSharedFs({
                    peerbit: peers[i],
                    address: fs.address,
                    machineLabel: `claim-${i}`,
                })
            );
        await Promise.all(
            handles.map((handle) => handle.awaitWriteReady({ timeout: 30_000 }))
        );
        for (const handle of handles)
            assert.equal(decode(await handle.readFile("/ready.txt")), "ready");
        partitioned = true;
        for (let i = 0; i < peers.length; i++)
            for (let j = i + 1; j < peers.length; j++)
                await peers[i].hangUp(peers[j].identity.publicKey);
        await waitFor(
            async () =>
                peers.every(
                    (peer) => peer.libp2p.getConnections().length === 0
                ),
            "partition"
        );
        const expected = new Map<string, string>();
        collectClaimsDiagnostics = async () => ({
            expected: [...expected],
            peers: await Promise.all(
                handles.map(async (handle, index) => {
                    const capture = async (read: () => Promise<unknown>) => {
                        let timer: ReturnType<typeof setTimeout> | undefined;
                        try {
                            return await Promise.race([
                                read(),
                                new Promise((resolve) => {
                                    timer = setTimeout(
                                        () =>
                                            resolve({
                                                diagnosticTimeout: true,
                                            }),
                                        1_000
                                    );
                                }),
                            ]);
                        } catch (error: any) {
                            return { error: String(error?.stack ?? error) };
                        } finally {
                            if (timer) clearTimeout(timer);
                        }
                    };
                    const [stat, bytes, conflicts, listed, namingRows] =
                        await Promise.all([
                            capture(() => handle.stat("/shared.txt")),
                            capture(async () => {
                                const value =
                                    await handle.readFile("/shared.txt");
                                return (
                                    value && {
                                        length: value.length,
                                        hex: Buffer.from(
                                            value.subarray(0, 128)
                                        ).toString("hex"),
                                        text: decode(value.subarray(0, 128)),
                                    }
                                );
                            }),
                            capture(() =>
                                handle.namingConflicts("/shared.txt")
                            ),
                            capture(() => handle.list("/")),
                            capture(async () => {
                                const rows = await rowsOf(handle, "naming");
                                return {
                                    count: rows.length,
                                    rows: rows.slice(0, 32).map((row) => ({
                                        id: row.id,
                                        nodeId: row.nodeId,
                                        parentId: row.parentId,
                                        name: row.name,
                                        deleted: row.deleted,
                                        causalRefs: row.causalRefs,
                                    })),
                                };
                            }),
                        ]);
                    return {
                        peer: index,
                        connections:
                            peers[index].libp2p.getConnections().length,
                        bootstrap: handle.bootstrapStatus(),
                        cache: snapshot(handle),
                        counters: counters(handle),
                        stat,
                        bytes,
                        conflicts,
                        listed,
                        namingRows,
                    };
                })
            ),
        });
        for (const [i, handle] of handles.entries()) {
            const content = `claim-${i}`;
            await handle.writeFile("/shared.txt", content);
            const info = await handle.stat("/shared.txt");
            assert(info);
            expected.set(info.nodeId, content);
        }
        assert.equal(
            expected.size,
            3,
            "partition must produce three independent live node claims"
        );
        const connectedAt = performance.now();
        partitioned = false;
        for (let i = 0; i < peers.length; i++)
            for (let j = i + 1; j < peers.length; j++)
                await peers[i].dial(peers[j]);
        const signature = async (handle: SharedFsHandle) => {
            const conflicts = await handle.namingConflicts("/shared.txt");
            const duplicate = conflicts.find(
                (entry) => entry.type === "duplicate-name"
            );
            if (!duplicate) return undefined;
            const ids = [
                duplicate.nodeId,
                ...(duplicate.shadowedNodeIds ?? []),
            ];
            if (
                ids.length !== 3 ||
                new Set(ids).size !== 3 ||
                ids.some((id) => !expected.has(id))
            )
                return undefined;
            const info = await handle.stat("/shared.txt");
            if (
                !info?.namingConflict ||
                info.conflict ||
                info.nodeId !== duplicate.nodeId
            )
                return undefined;
            if (
                decode(await handle.readFile("/shared.txt")) !==
                expected.get(info.nodeId)
            )
                return undefined;
            const listed = await handle.list("/");
            if (
                listed.length !== 2 ||
                listed.find((entry) => entry.name === "shared.txt")?.nodeId !==
                    info.nodeId
            )
                return undefined;
            return JSON.stringify({
                winner: info.nodeId,
                ids: ids.sort(),
                events: [...duplicate.eventIds].sort(),
            });
        };
        await waitFor(async () => {
            const signatures = await Promise.all(handles.map(signature));
            return signatures.every(
                (s) => s !== undefined && s === signatures[0]
            );
        }, "three real claimants");
        counts.reconnectThroughValidatedConvergenceMs =
            performance.now() - connectedAt;
        counts.claimants = expected.size;
        const winner = (await fs.stat("/shared.txt"))!.nodeId;
        coldCandidates(fs);
        await measure(
            fs,
            "coldCandidateStat",
            1,
            () => fs.stat("/shared.txt"),
            (info) => {
                assert.equal(info?.nodeId, winner);
                assert.equal(info?.namingConflict, true);
                assert.equal(info?.conflict, false);
            }
        );
        await measure(
            fs,
            "warmStat",
            samples,
            () => fs.stat("/shared.txt"),
            (info) => {
                assert.equal(info?.nodeId, winner);
                assert.equal(info?.namingConflict, true);
                assert.equal(info?.conflict, false);
            }
        );
        await measure(
            fs,
            "conflictEnumeration",
            3,
            () => fs.namingConflicts("/shared.txt"),
            (conflicts) => {
                const duplicate = conflicts.find(
                    (entry) => entry.type === "duplicate-name"
                );
                assert(duplicate);
                assert.deepEqual(
                    new Set([
                        duplicate.nodeId,
                        ...(duplicate.shadowedNodeIds ?? []),
                    ]),
                    new Set(expected.keys())
                );
            }
        );
    } else {
        fs = await openSharedFs({
            peerbit: await makePeer(),
            machineLabel: `namespace-${shape}`,
        });
        await fs.mkdir("/work");
        if (shape === "wide") {
            const entries = Array.from({ length: size }, (_, i) => ({
                path: `/work/file-${i}.txt`,
                content: `payload-${i}`,
            }));
            await fs.writeBatch(entries);
            const target = entries[Math.floor(size / 2)];
            const nodeId = (await fs.stat(target.path))!.nodeId;
            coldCandidates(fs);
            await measure(
                fs,
                "coldCandidateStat",
                1,
                () => fs.stat(target.path),
                (info) => assert.equal(info?.nodeId, nodeId)
            );
            await measure(
                fs,
                "warmStat",
                samples,
                () => fs.stat(target.path),
                (info) => assert.equal(info?.nodeId, nodeId)
            );
            await measure(
                fs,
                "distinctMissingStat",
                samples,
                (i) => fs.stat(`/work/missing-${i}`),
                (info) => assert.equal(info, undefined)
            );
            counts.afterPoints = snapshot(fs);
            const names = entries.map((entry) => entry.path.slice(6)).sort();
            await measure(
                fs,
                "listAfterPoints",
                3,
                () => fs.list("/work"),
                (listed) => {
                    assert.deepEqual(
                        listed.map((entry) => entry.name).sort(),
                        names
                    );
                    assert.equal(
                        new Set(listed.map((entry) => entry.nodeId)).size,
                        size
                    );
                }
            );
            await measure(
                fs,
                "createStream",
                samples,
                (i) => fs.writeFile(`/work/new-${i}.txt`, `new-${i}`),
                async (_result, i) => {
                    assert.equal(
                        decode(await fs.readFile(`/work/new-${i}.txt`)),
                        `new-${i}`
                    );
                }
            );
            const listed = await fs.list("/work");
            assert.equal(listed.length, size + samples);
            for (const entry of entries)
                assert.equal(
                    decode(await fs.readFile(entry.path)),
                    entry.content
                );
        } else {
            await fs.writeFile("/work/hot.txt", "revision-0");
            let nodeId = (await fs.stat("/work/hot.txt"))!.nodeId;
            const original = nodeId;
            counts.namingBefore = (await rowsOf(fs, "naming")).length;
            await measure(
                fs,
                "beforeHistoryStat",
                samples,
                () => fs.stat("/work/hot.txt"),
                (info) => assert.equal(info?.nodeId, original)
            );
            if (shape === "versions") {
                await measure(
                    fs,
                    "saveHistory",
                    size,
                    (i) => fs.writeFile("/work/hot.txt", `revision-${i + 1}`),
                    async (_result, i) => {
                        assert.equal(
                            decode(await fs.readFile("/work/hot.txt")),
                            `revision-${i + 1}`
                        );
                        assert.equal(
                            (await fs.stat("/work/hot.txt"))?.nodeId,
                            original
                        );
                    }
                );
                counts.namingAfter = (await rowsOf(fs, "naming")).length;
                assert.equal(
                    counts.namingAfter,
                    counts.namingBefore,
                    "ordinary saves must not append naming history"
                );
                counts.contentVersions = (
                    await fs.versions("/work/hot.txt")
                ).length;
                assert.equal(counts.contentVersions, size + 1);
            } else {
                await measure(
                    fs,
                    "renameDeleteRecreateCycle",
                    size,
                    async (i) => {
                        await fs.rename("/work/hot.txt", "/work/moved.txt");
                        await fs.rename("/work/moved.txt", "/work/hot.txt");
                        await fs.rm("/work/hot.txt");
                        await fs.writeFile("/work/hot.txt", `life-${i + 1}`);
                    },
                    async (_result, i) => {
                        const info = await fs.stat("/work/hot.txt");
                        assert(info);
                        assert.notEqual(info.nodeId, nodeId);
                        nodeId = info.nodeId;
                        assert.equal(
                            await fs.stat("/work/moved.txt"),
                            undefined
                        );
                        assert.equal(
                            decode(await fs.readFile("/work/hot.txt")),
                            `life-${i + 1}`
                        );
                    }
                );
                counts.namingAfter = (await rowsOf(fs, "naming")).length;
                assert.equal(
                    counts.namingAfter,
                    Number(counts.namingBefore) + size * 4
                );
                assert.equal((await fs.namingConflicts()).length, 0);
            }
            coldCandidates(fs);
            await measure(
                fs,
                "coldCandidateStat",
                1,
                () => fs.stat("/work/hot.txt"),
                (info) => assert.equal(info?.nodeId, nodeId)
            );
            await measure(
                fs,
                "warmStat",
                samples,
                () => fs.stat("/work/hot.txt"),
                (info) => assert.equal(info?.nodeId, nodeId)
            );
            await measure(
                fs,
                "listAfterHistory",
                3,
                () => fs.list("/work"),
                (listed) => {
                    assert.equal(listed.length, 1);
                    assert.equal(listed[0].nodeId, nodeId);
                    assert.equal(listed[0].name, "hot.txt");
                }
            );
        }
    }
    counts.finalCache = snapshot(fs);
    report = {
        schema: "shared-fs-public-namespace-v1",
        shape,
        size,
        samples,
        scope: "public API with in-memory Peerbit storage; one process per shape; claims uses three partitioned in-process peers; no mount or persisted receipts",
        caveats: [
            "coldCandidateStat clears only the candidate cache, not other caches or OS pages",
            "validation IO is outside timers and can warm caches between operations",
            "convergence timing includes validation and 25ms polling",
            "memory endpoints are process-wide, not retained cache bytes or peak measurements",
            "indexOnlyRowQueries excludes document-resolution queries; pointCandidateRowsExamined excludes full sweep rows",
            "claims always uses three genuine peers regardless of size",
            "module provenance records resolution from this worker, not every transitive import identity",
        ],
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        osRelease: release(),
        cpu: cpus()[0]?.model,
        modules,
        hashes: {
            lock: await fileHash("../../../../../pnpm-lock.yaml"),
            source: await fileHash("../index.ts"),
            cache: await fileHash("../slot-candidate-cache.ts"),
            worker: await fileHash("./slot-candidate-cache.bench.worker.ts"),
        },
        phases,
        counts,
        memoryBefore,
        memoryAfter: memory(),
    };
} catch (error) {
    failure = error;
    if (collectClaimsDiagnostics) {
        try {
            console.error(
                "namespace-claims-failure: " +
                    JSON.stringify(
                        await collectClaimsDiagnostics(),
                        (_key, value) =>
                            typeof value === "bigint" ? String(value) : value
                    )
            );
        } catch (diagnosticError) {
            console.error(
                "namespace-claims-diagnostic-error:",
                diagnosticError
            );
        }
    }
} finally {
    const results = await Promise.allSettled(peers.map((peer) => peer.stop()));
    const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
    );
    if (errors.length)
        failure = new AggregateError(
            failure ? [failure, ...errors] : errors,
            "namespace benchmark cleanup failed"
        );
}
if (failure) throw failure;
assert(report);
console.log(
    "namespace-workload: " +
        JSON.stringify({ ...report, memoryAfterClose: memory() })
);
