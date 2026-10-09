import { appendFileSync } from "node:fs";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { equals } from "@peerbit/crypto";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    openSharedFs,
    type BootstrapTelemetryEvent,
    type SharedFsHandle,
} from "../index.js";
import { ChangesetManifest, FileVersion, NamingEvent } from "../model.js";
import { Coordinator, type Evaluation } from "../readiness/coordinator.js";
import type { ReadinessRuntime } from "../readiness/runtime.js";
import { NAMESPACE_V1, SCOPE_NAMESPACE_V1 } from "../readiness/scopes.js";
import { documentsIndexPort } from "../readiness/tap.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * Design test 13 (WRITE_READINESS_V2.md section 8; M1 plan sections 7.4,
 * 10.3 and S17): a fresh full joiner J of a static donor with 6,000 files
 * never reports write-ready while any namespace row of the donor is missing
 * from J's index, and it does turn ready, in the prerequisite mode of PR-3
 * commit 2. Today's timer alone released this join at 62-97 s with 3-4% of
 * the rows missing (D13, `semantic-safety/results.ndjson`). The shape of
 * that harness is kept: 60 directories of 100 files, one `writeBatch` each,
 * then an address-open with `bootstrap: false` (J dials first, see below).
 * J's quiet window is cut to 100 ms (as in readiness-join.test.ts), so the
 * coordinator, not the window, is what holds J.
 *
 * The invariant is sampled on events, never on a poll:
 *
 * - every `satisfied()` of J's coordinator (each evaluation, the tracker's
 *   check, and `markWriteReady`'s one synchronous decision point; commit 4
 *   makes it the predicate), patched on the prototype before J opens. A
 *   true answer is containment of the donor (design 2.1), so it must not
 *   come while a donor row is missing;
 * - every evaluation's `bootstrapStatus()` (its readiness state and
 *   `writeReady`, recorded as transitions), once J's handle exists;
 * - the `write-ready` bootstrap telemetry (inside the flip, armed from the
 *   open on), the `write:ready` event (inside its dispatch) and
 *   `awaitWriteReady`'s resolution.
 *
 * "Missing from J's index" is read from a mirror the test keeps of J's
 * namespace rows (id to head) from its entries store's `change` events.
 * Documents dispatches one after the index write, and the mirror attaches
 * before J's store handles its first change (`handleChangesInOrder`,
 * patched on the prototype as readiness-join.test.ts holds it), so the
 * mirror is synchronous at every sample, independent of the readiness tap,
 * and sees the rows that arrive while J's open still runs (13-42 s at this
 * size in D13). After ready it is checked against a scan of J's index.
 *
 * Slow lane only (S16):
 *
 *   PEERBIT_SHARED_FS_READINESS_SLOW=1 \
 *   [PEERBIT_SHARED_FS_READINESS_6K_FILES=6000] \
 *   [PEERBIT_SHARED_FS_READINESS_6K_OUT=results.ndjson] \
 *   CI=true pnpm exec vitest run ... src/__tests__/readiness-6k.slow.test.ts
 *
 * Run it 3 times (plan 10.3). Each run logs one `[readiness-6k]` line (and
 * appends it to the `_OUT` file): time to ready, J's namespace row count
 * against the donor's at the flip and after, the samples, the readiness
 * state transitions and the session record.
 */

const enabled = process.env.PEERBIT_SHARED_FS_READINESS_SLOW === "1";
const manualDescribe = enabled ? describe : describe.skip;
const FILES = Number(process.env.PEERBIT_SHARED_FS_READINESS_6K_FILES ?? 6_000);
const FILES_PER_DIR = 100;
const out = process.env.PEERBIT_SHARED_FS_READINESS_6K_OUT;
/** J's quiet window (today's tracker keeps one in commit 2). */
const SETTLE_MS = 100;
const READY_TIMEOUT_MS = 480_000;

const runtimeOf = (fs: SharedFsHandle): ReadinessRuntime | undefined =>
    (fs.program as any).readinessRuntime;
const programOf = (fs: SharedFsHandle): any => fs.program;
const entriesOf = (fs: SharedFsHandle): any => programOf(fs).entries;
const hashOf = (peer: Peerbit) => peer.identity.publicKey.hashcode();
const r1 = (ms: number | undefined) =>
    ms === undefined ? undefined : Math.round(ms * 10) / 10;

/** The namespace rows of `fs`'s index (id to head), read by a raw scan. */
const namespaceRows = async (fs: SharedFsHandle) => {
    const port = documentsIndexPort(entriesOf(fs), NAMESPACE_V1);
    const rows = new Map<string, string>();
    for await (const page of port.scan()) {
        for (const row of page) rows.set(row.key as string, row.head);
    }
    return rows;
};

/** Ids whose head in `actual` is not the one in `expected`, at most `n`. */
const differences = (
    expected: ReadonlyMap<string, string>,
    actual: ReadonlyMap<string, string>,
    n = 10
) => {
    const found: string[] = [];
    for (const [key, head] of expected) {
        if (actual.get(key) !== head) {
            found.push(key);
            if (found.length >= n) break;
        }
    }
    return found;
};

/** `promise`, a rejection naming `stage` (a bare `TimeoutError` does not). */
const at = <T>(stage: string, promise: Promise<T>) =>
    promise.catch((error: any) => {
        throw new Error(`${stage}: ${error?.name}: ${error?.message}`, {
            cause: error,
        });
    });

/** The object on `target`'s prototype chain that defines `name`. */
const ownerOf = (target: object, name: string): any => {
    for (let owner: any = target; owner; owner = Object.getPrototypeOf(owner)) {
        if (Object.hasOwn(owner, name)) return owner;
    }
    throw new Error(`no ${name} on the prototype chain`);
};

/** A namespace row (design 2.1), by class as the tap scopes them. */
const isNamespaceRow = (
    value: unknown
): value is NamingEvent | FileVersion | ChangesetManifest =>
    value instanceof NamingEvent ||
    value instanceof FileVersion ||
    value instanceof ChangesetManifest;

/**
 * J's indexed namespace rows (id to head), from its entries store's
 * `change` events, and the donor rows it lacks. Conservative: a removal
 * drops the id whatever head it names, and an add without a head drops it
 * too, so the mirror can call a held row missing but never a missing row
 * held.
 */
class IndexMirror {
    readonly rows = new Map<string, string>();
    /** Donor ids whose donor head the mirror does not hold. */
    readonly missing: Set<string>;
    store?: object;
    events = 0;
    adds = 0;
    removals = 0;
    /** When `missing` last became empty (ms since J's open began). */
    completeAtMs?: number;
    private detach?: () => void;

    constructor(
        private readonly donor: ReadonlyMap<string, string>,
        private readonly clock: () => number
    ) {
        this.missing = new Set(donor.keys());
    }

    /** Listens to `store`'s changes; the first store only. */
    attach(store: any) {
        if (this.store !== undefined) return;
        this.store = store;
        const listener = (event: any) => this.onChange(event?.detail);
        store.events.addEventListener("change", listener);
        this.detach = () =>
            store.events.removeEventListener("change", listener);
    }

    dispose() {
        this.detach?.();
        this.detach = undefined;
    }

    private onChange(detail: any) {
        this.events++;
        for (const value of detail?.added ?? []) {
            if (!isNamespaceRow(value) || typeof value.id !== "string") {
                continue;
            }
            this.adds++;
            const head = (value as any).__context?.head;
            if (typeof head === "string") this.rows.set(value.id, head);
            else this.rows.delete(value.id);
            this.settle(value.id);
        }
        for (const value of detail?.removed ?? []) {
            if (!isNamespaceRow(value) || typeof value.id !== "string") {
                continue;
            }
            this.removals++;
            this.rows.delete(value.id);
            this.settle(value.id);
        }
    }

    private settle(id: string) {
        const head = this.donor.get(id);
        if (head === undefined) return;
        if (this.rows.get(id) === head) {
            if (this.missing.delete(id) && this.missing.size === 0) {
                this.completeAtMs = this.clock();
            }
        } else if (!this.missing.has(id)) {
            this.missing.add(id);
            this.completeAtMs = undefined;
        }
    }
}

/** How J says it is (or would be, in commit 4) write-ready. */
type Report =
    | "satisfied"
    | "status-ready"
    | "telemetry-write-ready"
    | "write:ready"
    | "awaitWriteReady";

/** The samples of one join. Hooks run inside product code: never throw. */
class ReadyObserver {
    readonly mirror: IndexMirror;
    readonly reports: Record<Report, number> = {
        satisfied: 0,
        "status-ready": 0,
        "telemetry-write-ready": 0,
        "write:ready": 0,
        awaitWriteReady: 0,
    };
    satisfiedFalse = 0;
    evaluations = 0;
    firstSatisfiedAtMs?: number;
    flipAtMs?: number;
    /** Donor rows the mirror held at the flip. */
    heldAtFlip?: number;
    violationCount = 0;
    readonly violations: Array<{
        report: Report;
        atMs: number;
        missing: number;
        ids: string[];
    }> = [];
    readonly states: Array<{
        state: string;
        writeReady: boolean;
        atMs: number;
        missing: number;
    }> = [];
    readonly errors: string[] = [];
    fs?: SharedFsHandle;

    constructor(
        private readonly donor: ReadonlyMap<string, string>,
        readonly clock: () => number
    ) {
        this.mirror = new IndexMirror(donor, clock);
    }

    /** J reports ready through `report`: no donor row may be missing now. */
    reported(report: Report) {
        this.reports[report]++;
        const missing = this.mirror.missing.size;
        if (report === "telemetry-write-ready") {
            this.flipAtMs = this.clock();
            this.heldAtFlip = this.donor.size - missing;
        }
        if (missing === 0) return;
        this.violationCount++;
        if (this.violations.length < 20) {
            this.violations.push({
                report,
                atMs: Math.round(this.clock()),
                missing,
                ids: [...this.mirror.missing].slice(0, 5),
            });
        }
    }

    onSatisfied(answer: boolean) {
        try {
            if (!answer) {
                this.satisfiedFalse++;
                return;
            }
            this.firstSatisfiedAtMs ??= this.clock();
            this.reported("satisfied");
        } catch (error: any) {
            this.errors.push(`satisfied: ${error?.message ?? error}`);
        }
    }

    onEvaluated(_evaluation: Evaluation) {
        try {
            this.evaluations++;
            if (!this.fs) return;
            const status = this.fs.bootstrapStatus();
            const state = status.readiness?.state ?? "none";
            const writeReady = status.writeReady === true;
            const last = this.states.at(-1);
            if (last?.state !== state || last.writeReady !== writeReady) {
                this.states.push({
                    state,
                    writeReady,
                    atMs: Math.round(this.clock()),
                    missing: this.mirror.missing.size,
                });
            }
            if (writeReady || state === "ready") {
                this.reported("status-ready");
            }
        } catch (error: any) {
            this.errors.push(`evaluation: ${error?.message ?? error}`);
        }
    }
}

/**
 * Attaches `mirror` to J's entries store before Documents handles its
 * first change: `handleChangesInOrder` (`@peerbit/document` 15.1.11
 * `dist/src/program.js:3725`) writes the index rows of a committed log
 * change and then dispatches `change`. J's store is the one with the
 * donor's log id that is not the donor's own.
 */
const attachBeforeFirstChange = (donorStore: any, mirror: IndexMirror) => {
    const owner = ownerOf(donorStore, "handleChangesInOrder");
    const handleChangesInOrder = owner.handleChangesInOrder;
    const logId: Uint8Array = donorStore.log.log.id;
    owner.handleChangesInOrder = function (this: any, ...args: unknown[]) {
        const id = this?.log?.log?.id;
        if (
            this !== donorStore &&
            id instanceof Uint8Array &&
            equals(id, logId)
        ) {
            mirror.attach(this);
        }
        return handleChangesInOrder.apply(this, args);
    };
    return () => {
        owner.handleChangesInOrder = handleChangesInOrder;
        mirror.dispose();
    };
};

/**
 * Samples every `satisfied()` of the coordinator whose transport is
 * `self`'s (J's), and every evaluation after the host's `onEvaluate`. On
 * the prototype, because J's coordinator starts inside its open.
 */
const observeCoordinator = (self: string, observer: ReadyObserver) => {
    const prototype = Coordinator.prototype as any;
    const satisfied = prototype.satisfied;
    const start = prototype.start;
    const ours = (coordinator: Coordinator) =>
        coordinator.ports.transport.self === self;
    prototype.satisfied = function (this: Coordinator) {
        const answer: boolean = satisfied.call(this);
        if (ours(this)) observer.onSatisfied(answer);
        return answer;
    };
    prototype.start = function (this: Coordinator) {
        if (ours(this)) {
            const ports = this.ports as {
                onEvaluate?: (evaluation: Evaluation) => void;
            };
            const host = ports.onEvaluate;
            ports.onEvaluate = (evaluation) => {
                try {
                    host?.(evaluation);
                } finally {
                    observer.onEvaluated(evaluation);
                }
            };
        }
        return start.call(this);
    };
    return () => {
        prototype.satisfied = satisfied;
        prototype.start = start;
    };
};

manualDescribe("readiness 6k join (design test 13, slow lane)", () => {
    const peers: Peerbit[] = [];
    /** Undone first in afterEach: patched prototypes and the mirror. */
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
        `${FILES} files: J never reports write-ready while a donor namespace row is missing from its index, and turns ready`,
        async () => {
            const loadAtStart = loadavg()[0];
            const donorPeer = await createPeer();
            const joinerPeer = await createPeer();
            // J dials before the donor writes. In one process, a dial right
            // after the 6k-file write often times out (9 of 15 runs): the
            // donor's shared-log holds the event loop for seconds with paged
            // rebalance scans of its entry coordinates (the D13 harness hit
            // the same at 10k files). That says nothing about readiness; J
            // still opens the store after the write.
            await at("dial", joinerPeer.dial(donorPeer));
            const donor = await openSharedFs({
                peerbit: donorPeer,
                machineLabel: "6k-donor",
                gc: false,
            });
            const dirs = Math.ceil(FILES / FILES_PER_DIR);
            const buildStart = performance.now();
            for (let d = 0; d < dirs; d++) {
                const size = Math.min(FILES_PER_DIR, FILES - d * FILES_PER_DIR);
                await donor.writeBatch(
                    Array.from({ length: size }, (_, f) => ({
                        path: `/d${String(d).padStart(3, "0")}/f${f}.txt`,
                        content: `d${d}f${f}`,
                    }))
                );
            }
            const buildMs = performance.now() - buildStart;
            const donorRows = await namespaceRows(donor);
            // A naming event and a version per file, plus the directories.
            expect(donorRows.size).toBeGreaterThanOrEqual(2 * FILES + dirs);

            /** Set when J's open begins; J's coordinator starts inside it. */
            let t0 = 0;
            const clock = () => performance.now() - t0;
            const observer = new ReadyObserver(donorRows, clock);
            restores.push(
                attachBeforeFirstChange(entriesOf(donor), observer.mirror)
            );
            restores.push(observeCoordinator(hashOf(joinerPeer), observer));

            t0 = performance.now();
            const joiner = await at(
                "open",
                openSharedFs({
                    peerbit: joinerPeer,
                    address: donor.address,
                    machineLabel: "6k-joiner",
                    bootstrap: false,
                    gc: false,
                    writeReadinessSettleMs: SETTLE_MS,
                    telemetry: {
                        bootstrap: (event: BootstrapTelemetryEvent) => {
                            if (event.type === "write-ready") {
                                observer.reported("telemetry-write-ready");
                            }
                        },
                    },
                } as any)
            );
            const openMs = clock();
            // No change handled yet attaches it now; none can have been missed.
            observer.mirror.attach(entriesOf(joiner));
            expect(observer.mirror.store).toBe(entriesOf(joiner));
            observer.fs = joiner;
            const readyDuringOpen = joiner.bootstrapStatus().writeReady;
            if (!readyDuringOpen) {
                programOf(joiner).events.addEventListener(
                    "write:ready",
                    () => observer.reported("write:ready"),
                    { once: true }
                );
            }

            // A timeout is logged with the readiness snapshot, then thrown.
            const readyError = await joiner
                .awaitWriteReady({ timeout: READY_TIMEOUT_MS })
                .then(
                    () => {
                        observer.reported("awaitWriteReady");
                        return undefined;
                    },
                    (error: unknown) => error as Error
                );
            const readyMs = readyError ? undefined : clock();

            // After the flip: J's index, read by a scan, holds every donor
            // row, and the mirror the samples read agrees with it.
            const joinerRows = await namespaceRows(joiner);
            const missingFromIndex = differences(donorRows, joinerRows);
            const mirrorDrift = [
                ...differences(joinerRows, observer.mirror.rows),
                ...differences(observer.mirror.rows, joinerRows),
            ];
            // The donor stayed static.
            const donorAfter = await namespaceRows(donor);

            const donorHash = hashOf(donorPeer);
            const coordinator = runtimeOf(joiner)?.coordinator;
            const record = coordinator?.record(donorHash);
            const result = record?.results.get(SCOPE_NAMESPACE_V1);
            const status = joiner.bootstrapStatus();
            const line = {
                test: 13,
                files: FILES,
                dirs,
                settleMs: SETTLE_MS,
                load: [r1(loadAtStart), r1(loadavg()[0])],
                buildMs: Math.round(buildMs),
                donorRows: donorRows.size,
                openMs: Math.round(openMs),
                readyDuringOpen,
                completeAtMs: r1(observer.mirror.completeAtMs),
                firstSatisfiedAtMs: r1(observer.firstSatisfiedAtMs),
                flipAtMs: r1(observer.flipAtMs),
                readyMs: r1(readyMs),
                heldAtFlip: observer.heldAtFlip,
                joinerRowsAfter: joinerRows.size,
                reports: observer.reports,
                satisfiedFalse: observer.satisfiedFalse,
                evaluations: observer.evaluations,
                violations: observer.violationCount,
                states: observer.states,
                mirror: {
                    events: observer.mirror.events,
                    adds: observer.mirror.adds,
                    removals: observer.mirror.removals,
                },
                source: status.writeReadinessSource,
                peer: record && {
                    state: record.state,
                    qualified: record.qualified,
                    live: record.live,
                    reachable: record.reachable,
                    via: [...record.via],
                    sessionsOpened: record.sessionsOpened,
                    headerHeld: record.headerHeld,
                    parked: record.parked,
                },
                session: result && {
                    mode: result.mode,
                    source: result.source,
                    qualified: result.qualified,
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
                coordinator: coordinator?.debug(),
                sendFailures: runtimeOf(joiner)?.debug().sendFailures,
                responder: runtimeOf(donor)?.responder?.stats,
                error: readyError?.message,
                readiness: readyError ? status.readiness : undefined,
            };
            console.log("[readiness-6k] " + JSON.stringify(line));
            if (out) appendFileSync(out, JSON.stringify(line) + "\n");
            if (readyError) throw readyError;

            expect(observer.errors).toEqual([]);
            expect(observer.violations).toEqual([]);
            // Every channel that says ready was sampled at least once.
            expect(observer.reports.satisfied).toBeGreaterThan(0);
            expect(observer.reports["telemetry-write-ready"]).toBe(1);
            expect(observer.reports["write:ready"]).toBe(
                readyDuringOpen ? 0 : 1
            );
            expect(observer.heldAtFlip).toBe(donorRows.size);
            expect(missingFromIndex).toEqual([]);
            expect(joinerRows.size).toBe(donorRows.size);
            expect(mirrorDrift).toEqual([]);
            expect(differences(donorRows, donorAfter)).toEqual([]);
            expect(donorAfter.size).toBe(donorRows.size);

            expect(programOf(joiner).readinessProvenance()).toMatchObject({
                writeReady: true,
                source: "reconciled",
            });
            expect(status.readiness).toMatchObject({
                state: "ready",
                satisfied: true,
                required: [],
                excluded: [],
                gaps: [],
            });
            expect(status.readiness!.contained).toEqual([
                {
                    peer: donorHash,
                    qualified: true,
                    source: "creator",
                    scopes: ["namespace-v1"],
                    departed: false,
                },
            ]);
            expect(result).toMatchObject({
                count: donorRows.size,
                qualified: true,
            });
        },
        READY_TIMEOUT_MS + 120_000
    );
});
