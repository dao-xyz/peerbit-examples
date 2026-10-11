import { appendFileSync } from "node:fs";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import type { PublicSignKey } from "@peerbit/crypto";
import { BORSH_ENCODING_OPERATION } from "@peerbit/document";
import { EntryType } from "@peerbit/log";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    openSharedFs,
    type BootstrapTelemetryEvent,
    type SharedFsHandle,
} from "../index.js";
import {
    DIGEST_BYTES,
    NOTICE_TARGETS,
    SESSIONS_PER_PEER,
    SESSIONS_TOTAL,
} from "../readiness/constants.js";
import { Coordinator, type Evaluation } from "../readiness/coordinator.js";
import { ReadinessRuntime } from "../readiness/runtime.js";
import { NAMESPACE_V1, SCOPE_NAMESPACE_V1 } from "../readiness/scopes.js";
import { JoinerSession } from "../readiness/session.js";
import { documentsIndexPort } from "../readiness/tap.js";
import {
    ERROR_CODE,
    NOTICE_REASON,
    OpenV1,
    StateNoticeV1,
    type ReadinessMessage,
} from "../readiness/wire.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * Design tests 43 and 46 (WRITE_READINESS_V2.md section 8; M1 plan 7.4,
 * SPEC-PR4 6.3), the slow lane of PR-4. Both measure on real in-process
 * Peerbit peers and sample on events (patched prototypes and the donor's
 * responder instance, as readiness-6k.slow.test.ts does), never on a poll.
 *
 * **Test 43, a donor with 20k CUTs.** A fresh joiner of a donor with a long
 * GC history becomes ready, and no readiness state grows with the CUT count
 * (design 4.6: `superseded` is a lookup in J's log, not a map; rejections
 * are bounded by the pulls in flight). The CUTs are made the real way: the
 * donor writes FILES distinct single-chunk files in batches of 100, rewrites
 * each one VERSIONS - 1 times, moves its injected clock 40 days on and runs
 * one `collectGarbage({ keepVersions: 1, chunkSweep: "immediate" })`, which
 * retires every older version with a CUT of its FileVersion and one of its
 * chunk (design 4.6 "about 2 per retired single-chunk version"). The
 * defaults, 2,500 files of 5 versions, give 10,000 retired versions and
 * about 20,000 CUTs against about 5,000 live namespace rows, so the
 * namespace CUTs alone outnumber the live rows twice: any readiness state
 * that kept an item per CUT would exceed the live-row bounds asserted
 * below. Sampled sizes:
 *
 * - J, at every evaluation of its coordinator, after each list a session
 *   derives its pending set from, at the flip and after: the namespace
 *   tap's count, its id map's capacity and recent removals; the
 *   coordinator's records and sessions; every session's pending set,
 *   status sets, explained set, X, received list and journal; the scope's
 *   rejection record and pull heads in flight;
 * - D, after every readiness request its responder handles, at J's flip
 *   and after: its tap, its responder's snapshot count and list copy.
 *
 * **Test 46, a 20-joiner `BUSY` storm.** One donor of 200 files and 20
 * fresh joiners, each on its own Peerbit and connected to the donor only,
 * opened concurrently. The donor's responder holds every request until
 * OPENs of all 20 joiners reached it and then handles them in arrival
 * order, so 16 sessions open and the other joiners get `BUSY` at once
 * (joiners whose three attempts ran out during the hold are `silent` by
 * then, and their held OPENs are answered late). Its sessions, per-peer
 * sessions and `BUSY` waiters are sampled after every message it handles
 * and at every session it creates. All 20 must turn ready with no retry by
 * the caller (one awaitWriteReady each); every joiner refused with `BUSY`
 * must pass through `busy` (its `readiness-peer` telemetry) and be asked
 * again in a fresh session; every capacity notice the donor sent must reach
 * its joiner. The joiners see each other too, so each one also asks the
 * other 19, gated, and their own responders refuse some of those requests.
 *
 * Slow lane only (S16):
 *
 *   PEERBIT_SHARED_FS_READINESS_SLOW=1 \
 *   [PEERBIT_SHARED_FS_READINESS_43_FILES=2500] \
 *   [PEERBIT_SHARED_FS_READINESS_43_VERSIONS=5] \
 *   [PEERBIT_SHARED_FS_READINESS_43_MIN_CUTS=20000] \
 *   [PEERBIT_SHARED_FS_READINESS_46_JOINERS=20] \
 *   [PEERBIT_SHARED_FS_READINESS_SLOW_OUT=results.ndjson] \
 *   CI=true pnpm exec vitest run ... src/__tests__/readiness-slow.slow.test.ts
 *
 * Each test logs one `[readiness-slow]` line (and appends it to the `_OUT`
 * file) with its durations, sizes and resource use.
 */

const enabled = process.env.PEERBIT_SHARED_FS_READINESS_SLOW === "1";
const manualDescribe = enabled ? describe : describe.skip;
const out = process.env.PEERBIT_SHARED_FS_READINESS_SLOW_OUT;

const FILES_43 = Number(
    process.env.PEERBIT_SHARED_FS_READINESS_43_FILES ?? 2_500
);
const VERSIONS_43 = Number(
    process.env.PEERBIT_SHARED_FS_READINESS_43_VERSIONS ?? 5
);
const MIN_CUTS_43 = Number(
    process.env.PEERBIT_SHARED_FS_READINESS_43_MIN_CUTS ?? 20_000
);
const READY_TIMEOUT_43_MS = 480_000;

const JOINERS_46 = Number(
    process.env.PEERBIT_SHARED_FS_READINESS_46_JOINERS ?? 20
);
const FILES_46 = 200;
const READY_TIMEOUT_46_MS = 300_000;
/** The hold ends when every joiner's OPEN arrived, or after this long. */
const HOLD_LIMIT_46_MS = 120_000;
/** Notices still in flight after the last joiner turned ready. */
const DELIVERY_LIMIT_46_MS = 30_000;

const FILES_PER_DIR = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
/** `RECENT_REMOVALS` in tap.ts: the ids a tap remembers as removed lately. */
const RECENT_REMOVALS = 4096;

const runtimeOf = (fs: SharedFsHandle): ReadinessRuntime | undefined =>
    (fs.program as any).readinessRuntime;
const programOf = (fs: SharedFsHandle): any => fs.program;
const entriesOf = (fs: SharedFsHandle): any => programOf(fs).entries;
const hashOf = (peer: Peerbit) => peer.identity.publicKey.hashcode();
const r1 = (ms: number | undefined) =>
    ms === undefined ? undefined : Math.round(ms * 10) / 10;
const mb = (bytes: number) => Math.round(bytes / 1024 / 102.4) / 10;
const pathOf = (dir: number, file: number) =>
    `/d${String(dir).padStart(3, "0")}/f${file}.txt`;
/** The smallest power of two >= n (the id map's table sizes). */
const ceilPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
const percentile = (values: number[], p: number) => {
    if (values.length === 0) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[
        Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)
    ];
};

/** `promise`, a rejection naming `stage` (a bare `TimeoutError` does not). */
const at = <T>(stage: string, promise: Promise<T>) =>
    promise.catch((error: any) => {
        throw new Error(`${stage}: ${error?.name}: ${error?.message}`, {
            cause: error,
        });
    });

const log = (line: Record<string, unknown>) => {
    console.log("[readiness-slow] " + JSON.stringify(line));
    if (out) appendFileSync(out, JSON.stringify(line) + "\n");
};

/** Process memory (MB) and CPU time (ms) since `since`. */
const resources = (since?: NodeJS.CpuUsage) => {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage(since);
    return {
        rssMb: mb(memory.rss),
        heapMb: mb(memory.heapUsed),
        externalMb: mb(memory.external),
        cpuUserMs: Math.round(cpu.user / 1000),
        cpuSystemMs: Math.round(cpu.system / 1000),
    };
};

/** The namespace rows of `fs`'s index (id to head), read by a raw scan. */
const namespaceRows = async (fs: SharedFsHandle) => {
    const port = documentsIndexPort(entriesOf(fs), NAMESPACE_V1);
    const rows = new Map<string, string>();
    for await (const page of port.scan()) {
        for (const row of page) rows.set(row.key as string, row.head);
    }
    return rows;
};

/**
 * The entries and the CUT entries of `fs`'s entries log (their hashes), by
 * a scan of its index.
 */
const logCounts = async (fs: SharedFsHandle) => {
    const iterator = entriesOf(fs).log.log.entryIndex.iterate(
        [],
        undefined,
        false
    );
    const hashes = new Set<string>();
    const cuts = new Set<string>();
    try {
        while (!iterator.done()) {
            const page: any[] = await iterator.next(4096);
            if (page.length === 0) break;
            for (const entry of page) {
                hashes.add(entry.hash);
                if (entry?.meta?.type === EntryType.CUT) cuts.add(entry.hash);
            }
        }
    } finally {
        await iterator.close();
    }
    return { entries: hashes.size, hashes, cuts };
};

type LogCounts = Awaited<ReturnType<typeof logCounts>>;

/**
 * The CUTs of `after` missing from `before` (at most 10): who signed each
 * (`names` maps hashcodes to labels), the document id it deleted, whether
 * its target was in `before`, and its wall time against `sinceMs`.
 */
const newCuts = async (
    fs: SharedFsHandle,
    before: LogCounts,
    after: LogCounts,
    names: Record<string, string>,
    sinceMs: number
) => {
    const log = entriesOf(fs).log.log;
    const out: Array<Record<string, unknown>> = [];
    for (const hash of after.cuts) {
        if (before.cuts.has(hash)) continue;
        const entry = await log.get(hash);
        const signer: string | undefined =
            entry?.signatures?.[0]?.publicKey?.hashcode();
        let operation: any;
        try {
            operation = (await entry.getPayload()).getValue(
                BORSH_ENCODING_OPERATION
            );
        } catch (error: any) {
            operation = { error: error?.message ?? String(error) };
        }
        const wallTime: bigint | undefined =
            entry?.meta?.clock?.timestamp?.wallTime;
        const target: string | undefined = entry?.meta?.next?.[0];
        out.push({
            signer:
                signer === undefined ? undefined : (names[signer] ?? signer),
            operation: operation?.constructor?.name,
            id: String(
                operation?.key?.key ?? operation?.key ?? operation?.error
            ),
            targetBefore:
                target === undefined ? undefined : before.hashes.has(target),
            msAfter:
                wallTime === undefined
                    ? undefined
                    : Number(wallTime / 1_000_000n) - sinceMs,
        });
        if (out.length >= 10) break;
    }
    return out;
};

const countsOf = (log: LogCounts) => ({
    entries: log.entries,
    cuts: log.cuts.size,
});

/** Raises each of `high`'s values to the matching one in `sizes`. */
const raise = (high: Record<string, number>, sizes: Record<string, number>) => {
    for (const [key, value] of Object.entries(sizes)) {
        if (value > (high[key] ?? 0)) high[key] = value;
    }
};

/**
 * J's readiness state of the namespace scope now, as item counts: its tap,
 * coordinator, the namespace runs of its sessions with `peer`, and the
 * scope's rejection record and pull queue.
 */
const joinerSizes = (runtime: ReadinessRuntime, peer: string) => {
    const tap = runtime.namespace as any;
    const coordinator = runtime.coordinator as any;
    const bundle = (runtime as any).bundles?.get(SCOPE_NAMESPACE_V1)?.bundle;
    const sizes = {
        tapCount: tap?.count ?? 0,
        idMapCapacity: tap?.map?.capacity ?? 0,
        recentRemovals: tap?.recentRemovals?.size ?? 0,
        verifyVersions: tap?.verifyVersions?.size ?? 0,
        records: coordinator?.entries?.size ?? 0,
        sessions: coordinator?.owners?.size ?? 0,
        pending: 0,
        statusSets: 0,
        explained: 0,
        xPeel: 0,
        listed: 0,
        list: 0,
        journal: 0,
        rejections: bundle?.rejections?.size ?? 0,
        pullHeadsInFlight: bundle?.pulls?.inFlightHeads ?? 0,
    };
    for (const session of coordinator?.owners?.keys() ?? []) {
        if ((session as JoinerSession).peer !== peer) continue;
        for (const run of (session as any).runs ?? []) {
            if (run.id !== SCOPE_NAMESPACE_V1) continue;
            sizes.pending += run.pending.size;
            for (const set of Object.values(run.sets) as Set<string>[]) {
                sizes.statusSets += set.size;
            }
            sizes.explained += run.explained.size;
            sizes.xPeel += run.xPeel.size;
            sizes.listed += run.listed;
            sizes.list += (run.list?.length ?? 0) / DIGEST_BYTES;
            sizes.journal += run.journal?.length ?? 0;
        }
    }
    return sizes;
};

/** D's readiness state of the namespace scope now: its tap and responder. */
const donorSizes = (runtime: ReadinessRuntime) => {
    const tap = runtime.namespace as any;
    const responder = runtime.responder as any;
    const snapshot = responder?.snapshots?.get(SCOPE_NAMESPACE_V1);
    const list = responder?.lists?.get(SCOPE_NAMESPACE_V1)?.list;
    return {
        tapCount: tap?.count ?? 0,
        idMapCapacity: tap?.map?.capacity ?? 0,
        recentRemovals: tap?.recentRemovals?.size ?? 0,
        snapshotCount: snapshot?.count ?? 0,
        snapshotAboveCache: snapshot?.above?.size ?? 0,
        listCopy: (list?.length ?? 0) / DIGEST_BYTES,
        sessions: responder?.sessions?.size ?? 0,
        noticeTargets: responder?.noticeTargets?.size ?? 0,
        busyWaiters: responder?.busyWaiters?.size ?? 0,
    };
};

/**
 * Test 43's samples. Hooks run inside product code: they never throw.
 */
class StateSampler {
    readonly joinerHigh: Record<string, number> = {};
    readonly donorHigh: Record<string, number> = {};
    /** Distinct snapshot counts and list copy sizes the responder held. */
    readonly snapshotCounts = new Set<number>();
    readonly listCopies = new Set<number>();
    /** Sizes of each list a session derived its pending set from. */
    readonly lists: Array<{
        list: number;
        pending: number;
        explained: number;
    }> = [];
    evaluations = 0;
    responderMessages = 0;
    joiner?: ReadinessRuntime;
    atFlip?: {
        joiner: ReturnType<typeof joinerSizes>;
        donor: ReturnType<typeof donorSizes>;
    };
    readonly errors: string[] = [];

    constructor(
        readonly donor: ReadinessRuntime,
        readonly donorHash: string
    ) {}

    private guard(stage: string, fn: () => void) {
        try {
            fn();
        } catch (error: any) {
            this.errors.push(`${stage}: ${error?.message ?? error}`);
        }
    }

    sampleJoiner(stage = "joiner") {
        this.guard(stage, () => {
            if (!this.joiner) return;
            raise(this.joinerHigh, joinerSizes(this.joiner, this.donorHash));
        });
    }

    sampleDonor(stage = "donor") {
        this.guard(stage, () => {
            const sizes = donorSizes(this.donor);
            raise(this.donorHigh, sizes);
            if (sizes.snapshotCount > 0) {
                this.snapshotCounts.add(sizes.snapshotCount);
            }
            if (sizes.listCopy > 0) this.listCopies.add(sizes.listCopy);
        });
    }

    onEvaluated() {
        this.evaluations++;
        this.sampleJoiner("evaluation");
    }

    onResponderMessage() {
        this.responderMessages++;
        this.sampleDonor("responder");
    }

    onListPending(run: any) {
        this.guard("listPending", () => {
            this.lists.push({
                list: (run.list?.length ?? 0) / DIGEST_BYTES,
                pending: run.pending.size,
                explained: run.explained.size,
            });
        });
        this.sampleJoiner("listPending");
    }

    onFlip() {
        this.guard("flip", () => {
            if (!this.joiner) throw new Error("no joiner runtime at the flip");
            this.atFlip = {
                joiner: joinerSizes(this.joiner, this.donorHash),
                donor: donorSizes(this.donor),
            };
        });
        this.sampleJoiner("flip");
        this.sampleDonor("flip");
    }
}

/**
 * Hooks test 43's sampler into J's join: the runtime that starts a join is
 * J's (D is the creator and starts none); every evaluation of J's
 * coordinator; every list a session of J derives its pending set from. On
 * the prototypes, because all three start inside J's open.
 */
const observeJoin = (sampler: StateSampler, joinerHash: string) => {
    const runtimePrototype = ReadinessRuntime.prototype as any;
    const coordinatorPrototype = Coordinator.prototype as any;
    const sessionPrototype = JoinerSession.prototype as any;
    const startJoin = runtimePrototype.startJoin;
    const start = coordinatorPrototype.start;
    const listPending = sessionPrototype.listPending;
    runtimePrototype.startJoin = function (
        this: ReadinessRuntime,
        ...args: any[]
    ) {
        sampler.joiner ??= this;
        return startJoin.apply(this, args);
    };
    coordinatorPrototype.start = function (this: Coordinator) {
        if (this.ports.transport.self === joinerHash) {
            const ports = this.ports as {
                onEvaluate?: (evaluation: Evaluation) => void;
            };
            const host = ports.onEvaluate;
            ports.onEvaluate = (evaluation) => {
                try {
                    host?.(evaluation);
                } finally {
                    sampler.onEvaluated();
                }
            };
        }
        return start.call(this);
    };
    sessionPrototype.listPending = function (this: JoinerSession, run: any) {
        const result = listPending.call(this, run);
        if (this.peer === sampler.donorHash && run?.id === SCOPE_NAMESPACE_V1) {
            sampler.onListPending(run);
        }
        return result;
    };
    return () => {
        runtimePrototype.startJoin = startJoin;
        coordinatorPrototype.start = start;
        sessionPrototype.listPending = listPending;
    };
};

/** Samples D's state after every request its responder handles. */
const observeResponder = (donor: SharedFsHandle, sampler: StateSampler) => {
    const responder = runtimeOf(donor)!.responder!;
    const onMessage = responder.onMessage;
    responder.onMessage = (message, from) => {
        onMessage.call(responder, message, from);
        sampler.onResponderMessage();
    };
    return () => {
        responder.onMessage = onMessage;
    };
};

/**
 * Test 46's donor responder: holds every request until OPENs from
 * `joiners` distinct peers arrived (or `arm`'s limit passed), then handles
 * them in arrival order. Samples the responder after every message it
 * handles and at every session it creates; records `BUSY` answers and
 * notices by peer.
 */
const stormResponder = (donor: SharedFsHandle, joiners: number) => {
    const responder = runtimeOf(donor)!.responder! as any;
    const onMessage = responder.onMessage;
    const error = responder.error;
    const sendNotice = responder.sendNotice;
    const sessions: Map<string, unknown> = responder.sessions;
    const perPeer: Map<string, number> = responder.perPeer;
    const set = sessions.set;
    const held: Array<[ReadinessMessage, PublicSignKey]> = [];
    const state = {
        openers: new Set<string>(),
        heldMessages: 0,
        releasedBy: undefined as "opens" | "limit" | undefined,
        armedAtMs: undefined as number | undefined,
        releasedAtMs: undefined as number | undefined,
        samples: 0,
        high: { sessions: 0, perPeer: 0, busyWaiters: 0, noticeTargets: 0 },
        /** `BUSY` answers per peer. */
        busyTo: new Map<string, number>(),
        /** Notices sent per peer and reason (`NOTICE_REASON`). */
        noticesTo: new Map<string, Record<number, number>>(),
        errors: [] as string[],
    };
    let limit: ReturnType<typeof setTimeout> | undefined;

    const sample = () => {
        try {
            state.samples++;
            const debug = responder.debug();
            let peerHigh = 0;
            for (const count of perPeer.values()) {
                peerHigh = Math.max(peerHigh, count);
            }
            raise(state.high, {
                sessions: Math.max(debug.sessions, sessions.size),
                perPeer: peerHigh,
                busyWaiters: debug.busyWaiters,
                noticeTargets: responder.noticeTargets.size,
            });
        } catch (error: any) {
            state.errors.push(error?.message ?? String(error));
        }
    };
    const release = (by: "opens" | "limit") => {
        if (state.releasedBy) return;
        state.releasedBy = by;
        state.releasedAtMs = performance.now();
        if (limit !== undefined) clearTimeout(limit);
        for (const [message, from] of held.splice(0)) {
            onMessage.call(responder, message, from);
            sample();
        }
    };

    responder.onMessage = (
        message: ReadinessMessage,
        from: PublicSignKey | undefined
    ) => {
        if (!state.releasedBy && from) {
            held.push([message, from]);
            state.heldMessages++;
            if (message instanceof OpenV1) {
                state.openers.add(from.hashcode());
                if (state.openers.size >= joiners) release("opens");
            }
            return;
        }
        onMessage.call(responder, message, from);
        sample();
    };
    sessions.set = function (this: Map<string, unknown>, key, value) {
        const result = set.call(this, key, value);
        sample();
        return result;
    };
    responder.error = function (
        this: unknown,
        to: PublicSignKey,
        sessionId: Uint8Array,
        code: number,
        ...rest: unknown[]
    ) {
        if (code === ERROR_CODE.BUSY) {
            const hash = to.hashcode();
            state.busyTo.set(hash, (state.busyTo.get(hash) ?? 0) + 1);
        }
        return error.call(this, to, sessionId, code, ...rest);
    };
    responder.sendNotice = function (
        this: unknown,
        peers: Iterable<PublicSignKey | string>,
        reason: number
    ) {
        const list = [...peers];
        for (const peer of list) {
            const hash = typeof peer === "string" ? peer : peer.hashcode();
            const counts = state.noticesTo.get(hash) ?? {};
            counts[reason] = (counts[reason] ?? 0) + 1;
            state.noticesTo.set(hash, counts);
        }
        return sendNotice.call(this, list, reason);
    };
    return {
        state,
        /** Starts the hold's limit (the joiners start opening now). */
        arm: () => {
            state.armedAtMs = performance.now();
            limit = setTimeout(() => release("limit"), HOLD_LIMIT_46_MS);
        },
        restore: () => {
            if (limit !== undefined) clearTimeout(limit);
            // The wrappers are own properties over the prototype's methods.
            delete responder.onMessage;
            delete responder.error;
            delete responder.sendNotice;
            delete (sessions as any).set;
        },
    };
};

/**
 * Notices from `donorHash` that each runtime received (by reason), counted
 * where the runtime receives readiness messages, so a notice after the
 * joiner's flip counts too. `onReceive` runs after each one.
 */
const observeNotices = (donorHash: string, onReceive: () => void) => {
    const prototype = ReadinessRuntime.prototype as any;
    const onMessage = prototype.onMessage;
    const received = new Map<ReadinessRuntime, Record<number, number>>();
    prototype.onMessage = function (
        this: ReadinessRuntime,
        message: ReadinessMessage,
        from: PublicSignKey | undefined,
        ...rest: unknown[]
    ) {
        const result = onMessage.call(this, message, from, ...rest);
        try {
            if (
                message instanceof StateNoticeV1 &&
                from?.hashcode() === donorHash
            ) {
                const counts = received.get(this) ?? {};
                counts[message.reason] = (counts[message.reason] ?? 0) + 1;
                received.set(this, counts);
                onReceive();
            }
        } catch {
            // Sampling must not fail the message.
        }
        return result;
    };
    return {
        received,
        restore: () => {
            prototype.onMessage = onMessage;
        },
    };
};

manualDescribe("readiness slow lanes (design tests 43 and 46)", () => {
    const peers: Peerbit[] = [];
    /** Undone first in afterEach: patched prototypes and responders. */
    const restores: Array<() => void> = [];

    afterEach(async () => {
        for (const restore of restores.splice(0).reverse()) {
            try {
                restore();
            } catch {
                // Best effort; the peers stop next either way.
            }
        }
        await stopTestPeers(peers);
    });

    const createPeer = async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        return peer;
    };

    it(
        `test 43: a fresh joiner of a donor with ${2 * FILES_43 * (VERSIONS_43 - 1)} CUTs turns ready, and no readiness state grows with the CUTs`,
        async () => {
            const loadAtStart = loadavg()[0];
            const cpuAtStart = process.cpuUsage();
            const memoryAtStart = resources(cpuAtStart);
            const donorPeer = await createPeer();
            const joinerPeer = await createPeer();
            // J dials before the donor writes, as in readiness-6k: a dial
            // right after a large write can time out while the donor's
            // shared-log holds the event loop. J opens the store after GC.
            await at("dial", joinerPeer.dial(donorPeer));
            let skewMs = 0;
            const donor = await openSharedFs({
                peerbit: donorPeer,
                machineLabel: "43-donor",
                gc: false,
                bootstrap: false,
                clock: () => Date.now() + skewMs,
            });
            const dirs = Math.ceil(FILES_43 / FILES_PER_DIR);
            const buildStart = performance.now();
            for (let version = 0; version < VERSIONS_43; version++) {
                for (let d = 0; d < dirs; d++) {
                    const size = Math.min(
                        FILES_PER_DIR,
                        FILES_43 - d * FILES_PER_DIR
                    );
                    // Distinct bytes per file and version: one chunk each,
                    // retired with its version.
                    await donor.writeBatch(
                        Array.from({ length: size }, (_, f) => ({
                            path: pathOf(d, f),
                            content: `d${d}f${f}v${version}`,
                        }))
                    );
                }
            }
            const buildMs = performance.now() - buildStart;
            const donorRuntime = runtimeOf(donor)!;
            const rowsBeforeGc = (await namespaceRows(donor)).size;
            const logBeforeGc = await logCounts(donor);
            const memoryAfterBuild = resources(cpuAtStart);

            // Every version but the newest is past retention and grace.
            skewMs = 40 * DAY_MS;
            const gcStart = performance.now();
            const gc = await at(
                "gc",
                donor.collectGarbage({
                    settleMs: 0,
                    chunkSweep: "immediate",
                    keepVersions: 1,
                })
            );
            const gcMs = performance.now() - gcStart;
            const gcEndMs = Date.now();
            await donorRuntime.namespace!.verifyIdle();
            const donorRows = await namespaceRows(donor);
            const countStart = performance.now();
            const donorLog = await logCounts(donor);
            const countMs = performance.now() - countStart;
            const memoryAfterGc = resources(cpuAtStart);
            const donorAfterGc = donorSizes(donorRuntime);
            const retired = FILES_43 * (VERSIONS_43 - 1);
            expect(gc).toMatchObject({
                retiredVersions: retired,
                deletedChunks: retired,
                cutRecoveries: 0,
            });
            expect(donorRows.size).toBe(rowsBeforeGc - retired);
            expect(logBeforeGc.cuts.size).toBe(0);
            expect(donorLog.cuts.size).toBeGreaterThanOrEqual(MIN_CUTS_43);
            expect(donorLog.cuts.size).toBeGreaterThanOrEqual(2 * retired);
            // The live-row bounds below discriminate only while the
            // namespace CUTs alone outnumber the live rows.
            expect(retired).toBeGreaterThan(donorRows.size);

            const donorHash = hashOf(donorPeer);
            const sampler = new StateSampler(donorRuntime, donorHash);
            restores.push(observeJoin(sampler, hashOf(joinerPeer)));
            restores.push(observeResponder(donor, sampler));

            const t0 = performance.now();
            const clock = () => performance.now() - t0;
            const cpuAtOpen = process.cpuUsage();
            let flipAtMs: number | undefined;
            const telemetry: BootstrapTelemetryEvent[] = [];
            const joiner = await at(
                "open",
                openSharedFs({
                    peerbit: joinerPeer,
                    address: donor.address,
                    machineLabel: "43-joiner",
                    bootstrap: false,
                    gc: false,
                    telemetry: {
                        bootstrap: (event: BootstrapTelemetryEvent) => {
                            telemetry.push(event);
                            if (event.type === "write-ready") {
                                flipAtMs = clock();
                                sampler.onFlip();
                            }
                        },
                    },
                })
            );
            const openMs = clock();
            const readyError = await joiner
                .awaitWriteReady({ timeout: READY_TIMEOUT_43_MS })
                .then(
                    () => undefined,
                    (error: unknown) => error as Error
                );
            const readyMs = readyError ? undefined : clock();
            const joinCpu = resources(cpuAtOpen);

            const joinerRuntime = runtimeOf(joiner)!;
            sampler.sampleJoiner("after");
            sampler.sampleDonor("after");
            const joinerRows = await namespaceRows(joiner);
            const joinerLog = await logCounts(joiner);
            const donorLogAfter = await logCounts(donor);
            // CUT entries made after GC, logged only: the donor's snapshot
            // publisher puts each new manifest as a CUT of the last one
            // (`snapshotWrite`), and one can land during the join.
            const cutsSinceGc = await newCuts(
                donor,
                donorLog,
                donorLogAfter,
                {
                    [hashOf(donorPeer)]: "donor",
                    [hashOf(joinerPeer)]: "joiner",
                },
                gcEndMs
            );
            const coordinator = joinerRuntime.coordinator;
            const record = coordinator?.record(donorHash);
            const result = record?.results.get(SCOPE_NAMESPACE_V1);
            const proof = readyError ? undefined : coordinator?.proof();
            const runtimeDebug = joinerRuntime.debug();
            const status = joiner.bootstrapStatus();
            const live = donorRows.size;
            const line = {
                test: 43,
                files: FILES_43,
                versions: VERSIONS_43,
                dirs,
                load: [r1(loadAtStart), r1(loadavg()[0])],
                buildMs: Math.round(buildMs),
                gcMs: Math.round(gcMs),
                cutCountMs: Math.round(countMs),
                gc: {
                    retiredVersions: gc.retiredVersions,
                    deletedChunks: gc.deletedChunks,
                    compactedNamingEvents: gc.compactedNamingEvents,
                    cutRecoveries: gc.cutRecoveries,
                },
                rowsBeforeGc,
                liveRows: live,
                donorLog: countsOf(donorLog),
                donorLogAfter: countsOf(donorLogAfter),
                joinerLog: countsOf(joinerLog),
                cutsSinceGc,
                openMs: Math.round(openMs),
                flipAtMs: r1(flipAtMs),
                readyMs: r1(readyMs),
                source: status.writeReadinessSource,
                session: result && {
                    mode: result.mode,
                    count: result.count,
                    missingAtStart: result.missingAtStart,
                    pulled: result.pulled,
                    explained: result.explained,
                    explainedBy: result.explainedBy,
                    x: result.x,
                    cells: result.cells,
                    recoveries: result.recoveries,
                    roundTrips: result.roundTrips,
                    certificates: result.certificates,
                    ms: Math.round(result.ms),
                },
                sessionsOpened: record?.sessionsOpened,
                proof: proof && {
                    contained: proof.contained.map(({ peer, count }) => ({
                        donor: peer === donorHash,
                        count,
                    })),
                    excluded: proof.excluded.length,
                    gaps: proof.gaps.length,
                },
                atFlip: sampler.atFlip,
                joinerHigh: sampler.joinerHigh,
                donorAfterGc,
                donorHigh: sampler.donorHigh,
                snapshotCounts: [...sampler.snapshotCounts],
                listCopies: [...sampler.listCopies],
                lists: sampler.lists,
                evaluations: sampler.evaluations,
                responderMessages: sampler.responderMessages,
                armedTimersAfter: runtimeDebug.armedTimers,
                responder: donorRuntime.responder?.stats,
                resources: {
                    start: memoryAtStart,
                    afterBuild: memoryAfterBuild,
                    afterGc: memoryAfterGc,
                    join: joinCpu,
                },
                samplerErrors: sampler.errors,
                error: readyError?.message,
                readiness: readyError ? status.readiness : undefined,
            };
            log(line);
            if (readyError) throw readyError;

            expect(sampler.errors).toEqual([]);
            expect(readyMs).toBeLessThanOrEqual(READY_TIMEOUT_43_MS);
            expect(status.writeReadinessSource).toBe("reconciled");
            expect(joinerRows).toEqual(donorRows);

            // At the flip and after, D's and J's taps hold the live rows.
            expect(sampler.atFlip).toBeDefined();
            expect(sampler.atFlip!.joiner.tapCount).toBe(live);
            expect(sampler.atFlip!.donor.tapCount).toBe(live);
            expect(joinerRuntime.namespace!.count).toBe(live);
            expect(donorRuntime.namespace!.count).toBe(live);

            // D's responder froze the live rows only, and a list copy (if a
            // list session ran) holds them only.
            expect([...sampler.snapshotCounts]).toEqual([live]);
            for (const size of sampler.listCopies) expect(size).toBe(live);
            for (const list of sampler.lists) {
                expect(list.list).toBe(live);
                expect(list.pending).toBeLessThanOrEqual(live);
            }

            // J: one record, nothing armed after ready, and every sampled
            // size bounded by the live rows (none by the CUT count).
            expect(sampler.joinerHigh.records).toBe(1);
            expect(runtimeDebug.armedTimers).toBe(0);
            const high = sampler.joinerHigh;
            for (const key of [
                "tapCount",
                "pending",
                "statusSets",
                "explained",
                "xPeel",
                "listed",
                "list",
                "journal",
                "rejections",
                "pullHeadsInFlight",
                "recentRemovals",
                "verifyVersions",
            ]) {
                expect(high[key] ?? 0, key).toBeLessThanOrEqual(live);
            }
            expect(high.idMapCapacity).toBeLessThanOrEqual(ceilPow2(live));

            // D: the tap's id map is sized by the peak live set (it never
            // shrinks), and its recent removals by their fixed bound.
            expect(sampler.donorHigh.idMapCapacity).toBeLessThanOrEqual(
                ceilPow2(rowsBeforeGc)
            );
            expect(sampler.donorHigh.recentRemovals).toBeLessThanOrEqual(
                RECENT_REMOVALS
            );

            // The contained session and the proof count the live rows.
            expect(result).toMatchObject({ count: live, qualified: true });
            expect(result!.explained).toBeLessThanOrEqual(
                result!.missingAtStart
            );
            expect(proof).toMatchObject({ excluded: [], gaps: [] });
            expect(proof!.contained).toEqual([
                expect.objectContaining({
                    peer: donorHash,
                    qualified: true,
                    count: live,
                }),
            ]);
        },
        READY_TIMEOUT_43_MS + 900_000
    );

    it(
        `test 46: ${JOINERS_46} joiners storm one donor with BUSY; all turn ready and the donor never exceeds its caps`,
        async () => {
            const loadAtStart = loadavg()[0];
            const cpuAtStart = process.cpuUsage();
            const donorPeer = await createPeer();
            const donor = await openSharedFs({
                peerbit: donorPeer,
                machineLabel: "46-donor",
                gc: false,
            });
            for (let d = 0; d < FILES_46 / FILES_PER_DIR; d++) {
                await donor.writeBatch(
                    Array.from({ length: FILES_PER_DIR }, (_, f) => ({
                        path: pathOf(d, f),
                        content: `d${d}f${f}`,
                    }))
                );
            }
            const donorRows = await namespaceRows(donor);
            const donorHash = hashOf(donorPeer);

            const joinerPeers: Peerbit[] = [];
            for (let i = 0; i < JOINERS_46; i++) {
                joinerPeers.push(await createPeer());
            }
            // Each joiner is connected to D only. D dials them: libp2p
            // refuses more than 5 inbound connections a second from one
            // host (`inboundConnectionThreshold`), which 20 joiners dialing
            // D from localhost exceed.
            await at(
                "dial",
                Promise.all(joinerPeers.map((peer) => donorPeer.dial(peer)))
            );
            const memoryBeforeOpen = resources(cpuAtStart);

            const storm = stormResponder(donor, JOINERS_46);
            restores.push(storm.restore);
            /** Each joiner's runtime once its open returned. */
            const runtimes: Array<ReadinessRuntime | undefined> = [];
            let delivered: (() => void) | undefined;
            const undelivered = () => {
                const missing: string[] = [];
                runtimes.forEach((runtime, i) => {
                    const hash = hashOf(joinerPeers[i]);
                    const sent =
                        storm.state.noticesTo.get(hash)?.[
                            NOTICE_REASON.CAPACITY
                        ] ?? 0;
                    const got = runtime
                        ? (notices.received.get(runtime)?.[
                              NOTICE_REASON.CAPACITY
                          ] ?? 0)
                        : 0;
                    if (got < sent) missing.push(`j${i}: ${got} of ${sent}`);
                });
                return missing;
            };
            const notices = observeNotices(donorHash, () => {
                if (delivered && undelivered().length === 0) delivered();
            });
            restores.push(notices.restore);

            const t0 = performance.now();
            const clock = () => performance.now() - t0;
            const telemetry: BootstrapTelemetryEvent[][] = joinerPeers.map(
                () => []
            );
            const readyAtMs: Array<number | undefined> = [];
            const openMs: number[] = [];
            storm.arm();
            const joiners = await at(
                "open",
                Promise.all(
                    joinerPeers.map(async (peer, i) => {
                        const fs = await openSharedFs({
                            peerbit: peer,
                            address: donor.address,
                            machineLabel: `46-joiner-${i}`,
                            bootstrap: false,
                            gc: false,
                            telemetry: {
                                bootstrap: (event: BootstrapTelemetryEvent) => {
                                    telemetry[i].push(event);
                                    if (event.type === "write-ready") {
                                        readyAtMs[i] = clock();
                                    }
                                },
                            },
                        });
                        openMs[i] = clock();
                        runtimes[i] = runtimeOf(fs);
                        return fs;
                    })
                )
            );
            const memoryAfterOpen = resources(cpuAtStart);
            // One wait per joiner: nobody retries.
            const errors = await Promise.all(
                joiners.map((fs) =>
                    fs.awaitWriteReady({ timeout: READY_TIMEOUT_46_MS }).then(
                        () => undefined,
                        (error: unknown) => error as Error
                    )
                )
            );
            const allReadyMs = clock();
            const memoryAfterReady = resources(cpuAtStart);

            // Capacity notices still in flight reach their joiners.
            let deliveryLimit: ReturnType<typeof setTimeout> | undefined;
            await new Promise<void>((resolve) => {
                delivered = resolve;
                deliveryLimit = setTimeout(resolve, DELIVERY_LIMIT_46_MS);
                if (undelivered().length === 0) resolve();
            });
            clearTimeout(deliveryLimit);
            const missingNotices = undelivered();

            const perJoiner = joiners.map((fs, i) => {
                const hash = hashOf(joinerPeers[i]);
                const coordinator = runtimeOf(fs)?.coordinator;
                const record = coordinator?.record(donorHash);
                const donorStates = telemetry[i]
                    .filter(
                        (event) =>
                            event.type === "readiness-peer" &&
                            event.peer === donorHash
                    )
                    .map((event: any) => `${event.state}/${event.reason}`);
                const records = coordinator?.records() ?? [];
                return {
                    i,
                    hash,
                    source: fs.bootstrapStatus().writeReadinessSource,
                    openMs: Math.round(openMs[i]),
                    readyAtMs: r1(readyAtMs[i]),
                    busy: storm.state.busyTo.get(hash) ?? 0,
                    noticesSent: storm.state.noticesTo.get(hash) ?? {},
                    noticesReceived: runtimes[i]
                        ? (notices.received.get(runtimes[i]!) ?? {})
                        : {},
                    donorStates,
                    donorSessionsOpened: record?.sessionsOpened ?? 0,
                    donorState: record?.state,
                    records: records.length,
                    sessionsOpened: records.reduce(
                        (sum, entry) => sum + entry.sessionsOpened,
                        0
                    ),
                    proofHasDonor:
                        coordinator
                            ?.proof()
                            .contained.some(
                                ({ peer, qualified }) =>
                                    peer === donorHash && qualified
                            ) ?? false,
                    /** `BUSY` answers of this joiner's own responder. */
                    ownBusy: runtimeOf(fs)?.responder?.stats.busy,
                };
            });
            const readyTimes = readyAtMs.filter(
                (ms): ms is number => ms !== undefined
            );
            const line = {
                test: 46,
                joiners: JOINERS_46,
                files: FILES_46,
                donorRows: donorRows.size,
                load: [r1(loadAtStart), r1(loadavg()[0])],
                hold: {
                    releasedBy: storm.state.releasedBy,
                    releasedAtMs: r1(
                        storm.state.releasedAtMs !== undefined &&
                            storm.state.armedAtMs !== undefined
                            ? storm.state.releasedAtMs - storm.state.armedAtMs
                            : undefined
                    ),
                    heldMessages: storm.state.heldMessages,
                    openers: storm.state.openers.size,
                },
                openMs: {
                    p50: r1(percentile(openMs, 0.5)),
                    max: r1(Math.max(...openMs)),
                },
                readyMs: {
                    p50: r1(percentile(readyTimes, 0.5)),
                    p95: r1(percentile(readyTimes, 0.95)),
                    max: r1(Math.max(...readyTimes)),
                    all: r1(allReadyMs),
                },
                donor: {
                    high: storm.state.high,
                    samples: storm.state.samples,
                    stats: runtimeOf(donor)?.responder?.stats,
                    messagesReceived: runtimeOf(donor)?.messagesReceived,
                    busyJoiners: storm.state.busyTo.size,
                    noticedJoiners: storm.state.noticesTo.size,
                },
                missingNotices,
                perJoiner: perJoiner.map(({ hash: _hash, ...rest }) => rest),
                resources: {
                    beforeOpen: memoryBeforeOpen,
                    afterOpen: memoryAfterOpen,
                    afterReady: memoryAfterReady,
                },
                samplerErrors: storm.state.errors,
                errors: errors
                    .map((error, i) =>
                        error ? `j${i}: ${error.message}` : undefined
                    )
                    .filter(Boolean),
            };
            log(line);

            expect(storm.state.errors).toEqual([]);
            expect(errors.filter(Boolean)).toEqual([]);
            // The storm happened: every joiner's OPEN reached the held
            // donor, which refused the ones beyond its total cap.
            expect(storm.state.releasedBy).toBe("opens");
            expect(
                runtimeOf(donor)!.responder!.stats.busy
            ).toBeGreaterThanOrEqual(JOINERS_46 - SESSIONS_TOTAL);
            // Caps never exceeded.
            expect(storm.state.high.sessions).toBeLessThanOrEqual(
                SESSIONS_TOTAL
            );
            expect(storm.state.high.perPeer).toBeLessThanOrEqual(
                SESSIONS_PER_PEER
            );
            expect(storm.state.high.busyWaiters).toBeLessThanOrEqual(
                NOTICE_TARGETS
            );
            // All ready, reconciled, within the limit, each proof with D.
            for (const joiner of perJoiner) {
                expect({ i: joiner.i, source: joiner.source }).toEqual({
                    i: joiner.i,
                    source: "reconciled",
                });
                expect({ i: joiner.i, has: joiner.proofHasDonor }).toEqual({
                    i: joiner.i,
                    has: true,
                });
                expect(joiner.readyAtMs).toBeLessThanOrEqual(
                    READY_TIMEOUT_46_MS
                );
            }
            // Every joiner refused with BUSY passed through `busy` and was
            // asked again in a fresh session, with no retry by its caller.
            const refused = perJoiner.filter((joiner) => joiner.busy > 0);
            expect(refused.length).toBeGreaterThanOrEqual(
                JOINERS_46 - SESSIONS_TOTAL
            );
            for (const joiner of refused) {
                const busyAt = joiner.donorStates.findIndex((state) =>
                    state.startsWith("busy/")
                );
                expect({ i: joiner.i, busyAt: busyAt >= 0 }).toEqual({
                    i: joiner.i,
                    busyAt: true,
                });
                expect({
                    i: joiner.i,
                    last: joiner.donorStates.at(-1),
                }).toEqual({ i: joiner.i, last: "contained/qualified" });
                expect(joiner.donorSessionsOpened).toBeGreaterThanOrEqual(2);
            }
            // The donor's capacity notices went out and arrived.
            expect(storm.state.noticesTo.size).toBeGreaterThan(0);
            expect(missingNotices).toEqual([]);
        },
        READY_TIMEOUT_46_MS + HOLD_LIMIT_46_MS + 300_000
    );
});
