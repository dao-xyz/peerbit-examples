import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
    analyzePlacement,
    comparePlacement,
    type PlacementSnapshot,
} from "./adaptive-placement-analysis.js";
import {
    digest,
    fixtureFile,
    placementPlan,
    type PlacementCommand,
    type PlacementConfig,
} from "./adaptive-placement.bench.model.js";
import { errorInfo } from "./adaptive-placement-telemetry.js";

const enabled = process.env.PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT === "1";
const selected =
    process.env.PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_MODE ?? "both";
assert(["full", "adaptive", "both"].includes(selected));
const manual = enabled ? describe : describe.skip;
const modes =
    selected === "both"
        ? (["full", "adaptive"] as const)
        : [selected as "full" | "adaptive"];
const workerPath = fileURLToPath(
    new URL("./adaptive-placement.bench.worker.ts", import.meta.url)
);
const files = 24;
const chunkBytes = 4_096;
const expected = Array.from(
    { length: files },
    (_, i) => fixtureFile(i, chunkBytes).manifest
);
const projectedLogBytes = expected.reduce(
    (sum, manifest) => sum + manifest.bytes + manifest.chunkIds.length * 1_024,
    0
);
const plan = placementPlan(
    process.env.PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_COPIES,
    projectedLogBytes
);
const { minCopies, budgets, initialCustodians, joiningPeer, survivors } = plan;
const profiled =
    process.env.PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_PROFILE === "1";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class PlacementWorker {
    child: ChildProcess;
    ready: Promise<any>;
    closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    pending = new Map<
        number,
        {
            resolve: (value: any) => void;
            reject: (error: Error) => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();
    sequence = 0;
    exited = false;
    diagnostics = "";
    omittedDiagnosticChars = 0;
    firstFailure: unknown;
    constructor(readonly config: PlacementConfig) {
        this.child = fork(workerPath, [JSON.stringify(config)], {
            execArgv: ["--import", "tsx"],
            silent: true,
        });
        for (const stream of [this.child.stdout, this.child.stderr])
            stream!.on("data", (bytes: Buffer) => {
                this.diagnostics += bytes.toString();
                if (this.diagnostics.length > 65_536) {
                    this.omittedDiagnosticChars +=
                        this.diagnostics.length - 65_536;
                    this.diagnostics = this.diagnostics.slice(-65_536);
                }
            });
        this.closed = new Promise((resolve) =>
            this.child.once("exit", (code, signal) => {
                this.exited = true;
                for (const pending of this.pending.values()) {
                    clearTimeout(pending.timer);
                    pending.reject(
                        new Error(
                            `peer ${config.peer} exited before response: ${code}/${signal}`
                        )
                    );
                }
                this.pending.clear();
                resolve({ code, signal });
            })
        );
        this.ready = new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`peer ${config.peer} boot deadline`)),
                35_000
            );
            const fail = (error: Error) => {
                clearTimeout(timer);
                reject(error);
            };
            this.child.once("error", fail);
            this.closed.then((status) =>
                fail(
                    new Error(
                        `peer exited during boot: ${JSON.stringify(status)}`
                    )
                )
            );
            this.child.on("message", (message: any) => {
                if (message.ready) {
                    clearTimeout(timer);
                    resolve(message);
                }
                if (message.fatal)
                    fail(
                        new Error("worker boot failed", {
                            cause: message.fatal,
                        })
                    );
                // Preserve a late failure even after its caller's deadline expired.
                if (message.ok === false)
                    this.firstFailure ??= {
                        error: message.error,
                        context: message.context,
                        profile: message.profile,
                    };
                const pending = this.pending.get(message.request);
                if (!pending) return;
                clearTimeout(pending.timer);
                this.pending.delete(message.request);
                if (message.ok) pending.resolve(message.value);
                else {
                    pending.reject(
                        new Error(`peer ${config.peer} command failed`, {
                            cause: message.error,
                        })
                    );
                }
            });
        });
    }
    request<T = any>(command: PlacementCommand, timeout = 35_000): Promise<T> {
        assert(!this.exited && this.child.connected, "worker is not connected");
        const request = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(request);
                reject(
                    new Error(
                        `peer ${this.config.peer}: ${command.type} exceeded ${timeout}ms`
                    )
                );
            }, timeout);
            this.pending.set(request, { resolve, reject, timer });
            this.child.send({ request, command }, (error) => {
                if (!error) return;
                clearTimeout(timer);
                this.pending.delete(request);
                reject(error);
            });
        });
    }
    async waitExit(timeout = 15_000) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                this.closed,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    `peer ${this.config.peer}: natural exit deadline`
                                )
                            ),
                        timeout
                    );
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
    async stop() {
        const result = await this.request({ type: "stop" }, 20_000);
        assert.deepEqual(await this.waitExit(), { code: 0, signal: null });
        return result;
    }
    async crash() {
        assert(this.child.kill("SIGKILL"));
        const result = await this.waitExit();
        assert.equal(result.signal, "SIGKILL");
        return result;
    }
}

const sourceHashes = async () =>
    Object.fromEntries(
        await Promise.all(
            [
                "adaptive-placement.bench.test.ts",
                "adaptive-placement.bench.worker.ts",
                "adaptive-placement.bench.model.ts",
                "adaptive-placement-analysis.ts",
                "adaptive-placement-telemetry.ts",
                "process-isolated-soak-storage.ts",
                "../../../../../pnpm-lock.yaml",
            ].map(async (name) => [
                name,
                digest(await readFile(new URL(name, import.meta.url))),
            ])
        )
    );

manual(
    "split-plane placement experiment (not a filesystem implementation)",
    () => {
        it.each(modes)(
            "measures %s placement through join, loss and offline reopen",
            async (mode) => {
                const directory = await mkdtemp(
                    join(tmpdir(), `peerbit-placement-${mode}-`)
                );
                const hashes = await sourceHashes();
                const all: PlacementWorker[] = [];
                const active = new Map<number, PlacementWorker>();
                const identities: any[] = [];
                const onlineIdentities = new Map<number, string>();
                const events: any[] = [];
                const writeTimings: any[] = [];
                let previous: PlacementSnapshot[] | undefined;
                let failure: unknown;
                let aborted = false;
                const ensureActive = () =>
                    assert(!aborted, "placement scenario is no longer active");
                let timeout: ReturnType<typeof setTimeout> | undefined;
                const log = (event: any) => {
                    const entry = {
                        atMs: performance.now() - started,
                        ...event,
                    };
                    events.push(entry);
                    console.log("placement-event: " + JSON.stringify(entry));
                };
                const started = performance.now();
                const start = async (peer: number, offline = false) => {
                    ensureActive();
                    const worker = new PlacementWorker({
                        peer,
                        directory: join(directory, String(peer)),
                        run: directory,
                        mode,
                        capacityBytes: budgets[peer],
                        offline,
                        minCopies,
                        generation: all.length + 1,
                        profile: profiled,
                    });
                    all.push(worker);
                    active.set(peer, worker);
                    const ready = await worker.ready;
                    ensureActive();
                    if (offline) {
                        assert.equal(
                            ready.hash,
                            onlineIdentities.get(peer),
                            "offline reopen changed identity"
                        );
                        assert.equal(
                            ready.addresses.length,
                            0,
                            "offline peer is listening"
                        );
                    } else {
                        assert(
                            ![...onlineIdentities.values()].includes(
                                ready.hash
                            ),
                            "custody requires distinct peer identities"
                        );
                        onlineIdentities.set(peer, ready.hash);
                    }
                    identities.push({ ...ready });
                    log({ type: "ready", peer, pid: ready.pid, offline });
                    return worker;
                };
                const connect = async (worker: PlacementWorker) => {
                    ensureActive();
                    const others = await Promise.all(
                        [...active.values()]
                            .filter((other) => other !== worker)
                            .map((other) => other.ready)
                    );
                    ensureActive();
                    await worker.request({
                        type: "dial",
                        addresses: others.map((other) => other.addresses),
                    });
                };
                const sample = async (
                    phase: string,
                    count: number,
                    verify = false
                ) => {
                    ensureActive();
                    const snapshots: PlacementSnapshot[] = await Promise.all(
                        [...active.values()].map((worker) =>
                            worker.request({ type: "snapshot", verify })
                        )
                    );
                    ensureActive();
                    if (profiled)
                        for (const snapshot of snapshots) {
                            const profile = (
                                snapshot as PlacementSnapshot & {
                                    profile: {
                                        metadata: { total: number };
                                        chunks: { total: number };
                                    };
                                }
                            ).profile;
                            assert(
                                profile?.metadata.total > 0 &&
                                    profile?.chunks.total > 0,
                                "enabled profiler emitted no events for a plane"
                            );
                        }
                    for (const [index, worker] of [
                        ...active.values(),
                    ].entries())
                        if (worker.config.offline)
                            assert.equal(
                                (
                                    snapshots[index] as PlacementSnapshot & {
                                        connections: number;
                                    }
                                ).connections,
                                0,
                                "offline peer has network connections"
                            );
                    const analysis = analyzePlacement(
                        snapshots,
                        expected.slice(0, count),
                        { minCopies }
                    );
                    const movement = previous
                        ? comparePlacement(previous, snapshots)
                        : null;
                    previous = snapshots;
                    log({
                        type: "sample",
                        phase,
                        snapshots,
                        analysis,
                        movement,
                    });
                    return { snapshots, analysis };
                };
                const settle = async (phase: string, count: number) => {
                    const until = performance.now() + 30_000;
                    let stable = 0;
                    let last = "";
                    while (performance.now() < until) {
                        const current = await sample(phase, count);
                        const signature = JSON.stringify(
                            current.snapshots.map((peer) => [
                                peer.peer,
                                peer.chunks.map((chunk) => chunk.id).sort(),
                                peer.metadata.map((meta) => meta.id).sort(),
                            ])
                        );
                        const complete =
                            current.analysis.belowMinCopies.length === 0 &&
                            current.analysis.missingMetadataByPeer.every(
                                (peer) => peer.ids.length === 0
                            );
                        stable =
                            complete && signature === last ? stable + 1 : 0;
                        last = signature;
                        if (stable >= 2) return current;
                        await delay(1_000);
                    }
                    throw new Error(
                        `${phase}: coverage/metadata/inventory-stability deadline`
                    );
                };
                const write = async (from: number, to: number) => {
                    for (let file = from; file < to; file++) {
                        ensureActive();
                        const result = await active.get(0)!.request({
                            type: "write",
                            files: [file],
                            chunkBytes,
                        });
                        ensureActive();
                        writeTimings.push(...result.timings);
                        log({ type: "write-receipt", ...result.timings[0] });
                    }
                };
                const run = async () => {
                    for (let peer = 0; peer <= initialCustodians; peer++) {
                        const worker = await start(peer);
                        await connect(worker);
                    }
                    await write(0, 8);
                    await settle("initial-custodians", 8);
                    // The producer continues while another independently backed peer joins.
                    const [, joining] = await Promise.all([
                        write(8, 12),
                        start(joiningPeer),
                    ]);
                    log({ type: "join-connect-start", peer: joiningPeer });
                    await Promise.all([
                        write(12, 16),
                        connect(joining).then(() =>
                            log({
                                type: "join-connect-complete",
                                peer: joiningPeer,
                            })
                        ),
                    ]);
                    const joined = await settle("joined-custodians", 16);
                    if (mode === "full")
                        for (const peer of joined.snapshots.filter(
                            (peer) => peer.role === "custodian"
                        )) {
                            assert.equal(
                                peer.chunks.length,
                                new Set(
                                    expected
                                        .slice(0, 16)
                                        .flatMap((meta) => meta.chunkIds)
                                ).size
                            );
                        }
                    if (mode === "adaptive") {
                        log({
                            type: "capacity-change",
                            peer: 1,
                            bytes: Math.ceil(budgets[1]! * 0.75),
                        });
                        await active.get(1)!.request({
                            type: "budget",
                            bytes: Math.ceil(budgets[1]! * 0.75),
                        });
                        await settle("reduced-budget", 16);
                    }
                    // Intentional abrupt loss, not successful cleanup or safe disposal.
                    ensureActive();
                    const lost = active.get(1)!;
                    await Promise.all([
                        write(16, files),
                        lost.crash().then(() => {
                            active.delete(1);
                            log({ type: "planned-custodian-crash", peer: 1 });
                        }),
                    ]);
                    const final = await settle("surviving-custodians", files);
                    if (mode === "adaptive") {
                        const unique = new Set(
                            expected.flatMap((meta) => meta.chunkIds)
                        ).size;
                        assert(
                            final.snapshots.some(
                                (peer) =>
                                    peer.role === "custodian" &&
                                    peer.chunks.length < unique
                            ),
                            "adaptive run did not demonstrate partial content placement"
                        );
                        const custodian = final.snapshots.find(
                            (peer) =>
                                peer.role === "custodian" &&
                                peer.chunks.length < unique
                        )!;
                        const localIds = new Set(
                            custodian.chunks.map((chunk) => chunk.id)
                        );
                        const file = expected.findIndex((meta) =>
                            meta.chunkIds.some((id) => !localIds.has(id))
                        );
                        assert(file >= 0);
                        const remoteRead = await active
                            .get(custodian.peer)!
                            .request({
                                type: "read",
                                files: [file],
                                chunkBytes,
                                remote: true,
                            });
                        assert(
                            remoteRead.localMisses > 0 &&
                                remoteRead.remoteReturns ===
                                    remoteRead.localMisses,
                            "did not prove retrieval of missing local content"
                        );
                        log({
                            type: "verified-missing-content-read",
                            peer: custodian.peer,
                            ...remoteRead,
                        });
                    }
                    const read = await active.get(joiningPeer)!.request({
                        type: "read",
                        files: [0, 1, 0, 2, 0, 3, 0, 4],
                        chunkBytes,
                        remote: true,
                    });
                    ensureActive();
                    log({ type: "verified-hot-reads", ...read });
                    const barrier = await active
                        .get(0)!
                        .request({ type: "barrier" });
                    ensureActive();
                    log({ type: "renewed-persisted-barrier", ...barrier });
                    await sample("after-final-barrier", files, true);
                    log({
                        type: "publisher-stop",
                        result: await active.get(0)!.stop(),
                    });
                    active.delete(0);
                    ensureActive();
                    await Promise.all(
                        [...active.values()].map((worker) => worker.crash())
                    );
                    log({ type: "planned-all-custodian-crash" });
                    active.clear();
                    for (const peer of survivors) await start(peer, true);
                    const offline = await sample("offline-reopen", files, true);
                    assert.equal(
                        offline.analysis.belowMinCopies.length,
                        0,
                        "offline surviving copies below N"
                    );
                    assert(
                        offline.analysis.missingMetadataByPeer.every(
                            (peer) => peer.ids.length === 0
                        )
                    );
                };
                try {
                    await Promise.race([
                        run(),
                        new Promise<never>((_resolve, reject) => {
                            timeout = setTimeout(
                                () =>
                                    reject(
                                        new Error(
                                            "placement run exceeded 180 seconds"
                                        )
                                    ),
                                180_000
                            );
                        }),
                    ]);
                } catch (error) {
                    aborted = true;
                    failure = error;
                    log({ type: "failure", error: errorInfo(error) });
                    const snapshots = await Promise.allSettled(
                        [...active.values()]
                            .filter((worker) => !worker.exited)
                            .map(async (worker) => {
                                const [inventory, profile] =
                                    await Promise.allSettled([
                                        worker.request(
                                            { type: "snapshot" },
                                            5_000
                                        ),
                                        worker.request(
                                            { type: "profile" },
                                            1_000
                                        ),
                                    ]);
                                return {
                                    peer: worker.config.peer,
                                    generation: worker.config.generation,
                                    snapshot:
                                        inventory.status === "fulfilled"
                                            ? inventory.value
                                            : {
                                                  error: errorInfo(
                                                      inventory.reason
                                                  ),
                                              },
                                    profile:
                                        profile.status === "fulfilled"
                                            ? profile.value
                                            : {
                                                  error: errorInfo(
                                                      profile.reason
                                                  ),
                                              },
                                };
                            })
                    );
                    log({
                        type: "failure-inventories",
                        snapshots: snapshots.map((result) =>
                            result.status === "fulfilled"
                                ? result.value
                                : { error: errorInfo(result.reason) }
                        ),
                    });
                } finally {
                    aborted = true;
                    if (timeout) clearTimeout(timeout);
                    const results = await Promise.allSettled(
                        all
                            .filter((worker) => !worker.exited)
                            .map(async (worker) => {
                                try {
                                    return await worker.stop();
                                } catch (error) {
                                    log({
                                        type: "cleanup-failure",
                                        peer: worker.config.peer,
                                        error: errorInfo(error),
                                    });
                                    if (!worker.exited) await worker.crash();
                                    throw error;
                                }
                            })
                    );
                    const cleanupErrors = results.flatMap((result) =>
                        result.status === "rejected" ? [result.reason] : []
                    );
                    if (cleanupErrors.length)
                        failure = new AggregateError(
                            [...(failure ? [failure] : []), ...cleanupErrors],
                            "placement cleanup failed"
                        );
                }
                try {
                    assert.deepEqual(
                        await sourceHashes(),
                        hashes,
                        "harness source changed during run"
                    );
                } catch (error) {
                    failure = new AggregateError(
                        [...(failure ? [failure] : []), error],
                        "source provenance changed"
                    );
                }
                const report = {
                    schema: "shared-fs-split-plane-probe-v2",
                    mode,
                    directory,
                    files,
                    chunkBytes,
                    minCopies,
                    topology: plan,
                    profiled,
                    ok: !failure,
                    hashes,
                    identities,
                    writeTimings,
                    events,
                    diagnostics: all.map((worker) => ({
                        peer: worker.config.peer,
                        pid: worker.child.pid,
                        tail: worker.diagnostics,
                        omittedChars: worker.omittedDiagnosticChars,
                        firstFailure: worker.firstFailure ?? null,
                    })),
                    caveats: [
                        "test-only Documents model, not a working sharded filesystem",
                        "storage budgets are soft log-byte targets, not hardware quotas",
                        "same-host independent processes; no heterogeneous hardware or network emulation",
                        "observed residency changes are not wire traffic measurements",
                        "stable inventories over two intervals do not establish long-run controller stability",
                        "receipt failure can follow local commit; no write retries are performed",
                        "retained directories are evidence; no physical reclamation tested",
                        "small sample, not reliable p95/p99 or throughput scaling evidence",
                        "profile durations can overlap or nest; sums are not CPU time or wall-clock critical paths",
                    ],
                };
                console.log("placement-report: " + JSON.stringify(report));
                if (failure) throw failure;
            },
            240_000
        );
    }
);
