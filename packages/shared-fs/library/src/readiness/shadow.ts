import { toHexString } from "@peerbit/crypto";
import { AnchorHost, AnchorUnavailableError } from "./anchor-host.js";
import { Cells } from "./cells.js";
import { DIGEST_BYTES, M } from "./constants.js";
import { headDigest } from "./digest.js";
import type { IdHeadMap, IdKey } from "./id-map.js";
import type { ScopeState } from "./runtime.js";
import { CloseFault } from "./tap.js";

/**
 * The K2 shadow check (M1 plan section 7.2, S9), test mode only.
 *
 * In every filesystem close, after the drain and before the stores close,
 * each scope's maintained state (cells, count, `hlc`, the id -> head map and
 * the anchor) is compared with a fresh build from an index scan. Rows are
 * matched by id, and a difference counts only once no event can explain it
 * (`compareScope`). A difference is recorded in the registry, never thrown
 * from close; the test setup fails the test that recorded it. So is a
 * scope that could not be compared for a reason the close did not cause (a
 * faulted tap, a failed start, an error in the check): a fault must not
 * turn the check into a silent skip.
 *
 * Switched on by `globalThis.__SFS_READINESS_SHADOW__`, which the library's
 * `vitest.setup.ts` sets to a registry. Product code never sets it, and
 * without it nothing here runs.
 */

export interface ShadowOwner {
    file?: string;
    test?: string;
    /** The test's task id (names can repeat across describes). */
    id?: string;
}

export interface ShadowFailure {
    /** The test that opened the filesystem. */
    owner: ShadowOwner;
    /** The test running when it was recorded; none in a suite hook. */
    recordedIn: ShadowOwner;
    address: string;
    scope?: string;
    message: string;
}

/** A scope the check skipped for a reason the close caused. */
export interface ShadowSkip {
    owner: ShadowOwner;
    address: string;
    scope?: string;
    reason: string;
}

export interface ShadowRegistry {
    /** The running test file and test, set by the test setup. */
    current: ShadowOwner;
    /** Recorded failures; the setup takes them per test file. */
    failures: ShadowFailure[];
    /** Skips and their reasons; the setup reports them per test file. */
    skips: ShadowSkip[];
    /** Live runtimes and the test that opened them. */
    readonly live: WeakMap<object, ShadowOwner>;
    /** Filesystems whose closes skip the check (fault injection). */
    readonly optedOut: WeakSet<object>;
    /** Filesystems allowed to run on an inline process-wide host. */
    readonly inlineAllowed: WeakSet<object>;
    readonly counts: {
        checks: number;
        compared: number;
        /** Checks whose differing rows kept moving through every scan. */
        unstable: number;
        /** Unstable checks that saw a difference (each one in flight). */
        unconfirmed: number;
        skipped: number;
        failed: number;
    };
}

declare global {
    // eslint-disable-next-line no-var
    var __SFS_READINESS_SHADOW__: ShadowRegistry | undefined;
}

export const createShadowRegistry = (): ShadowRegistry => ({
    current: {},
    failures: [],
    skips: [],
    live: new WeakMap(),
    optedOut: new WeakSet(),
    inlineAllowed: new WeakSet(),
    counts: {
        checks: 0,
        compared: 0,
        unstable: 0,
        unconfirmed: 0,
        skipped: 0,
        failed: 0,
    },
});

/**
 * Test setup helper: removes and returns the failures of runtimes `file`
 * opened that were recorded during the test with task id `test` (all of
 * them when undefined), and every failure of another file's runtime (to be
 * reported, never to fail this file). A failure recorded in a suite hook
 * has no test, so it waits for the file's end.
 */
export const takeShadowFailures = (
    registry: ShadowRegistry,
    file: string | undefined,
    test?: string
): { mine: ShadowFailure[]; foreign: ShadowFailure[] } => {
    const mine: ShadowFailure[] = [];
    const foreign: ShadowFailure[] = [];
    const kept: ShadowFailure[] = [];
    for (const failure of registry.failures.splice(0)) {
        if (failure.owner.file !== undefined && failure.owner.file !== file) {
            foreign.push(failure);
        } else if (test === undefined || failure.recordedIn.id === test) {
            mine.push(failure);
        } else {
            kept.push(failure);
        }
    }
    registry.failures.push(...kept);
    return { mine, foreign };
};

/** The registry when the shadow check is on (tests), else undefined. */
export const shadowRegistry = (): ShadowRegistry | undefined =>
    globalThis.__SFS_READINESS_SHADOW__;

/**
 * Test helper: closes of this filesystem (its `program`) skip the shadow
 * check. For tests that corrupt structures or index state on purpose.
 */
export const optOutOfReadinessShadow = (program: object) => {
    shadowRegistry()?.optedOut.add(program);
};

/** Test helper: this filesystem may run on an inline process-wide host. */
export const allowInlineReadinessAnchor = (program: object) => {
    shadowRegistry()?.inlineAllowed.add(program);
};

export type ShadowOutcome =
    | { kind: "equal"; attempts: number }
    | { kind: "different"; attempts: number; difference: string }
    | { kind: "unstable"; attempts: number; difference?: string }
    /**
     * Not compared. `expected` when the close caused it (a start the close
     * overtook, a verify the close would not wait for, a worker restart);
     * otherwise the check reports it like a difference.
     */
    | { kind: "skipped"; reason: string; expected: boolean };

export interface CompareOptions {
    /**
     * How long rows that differ while no event names them wait for one
     * before the difference counts (ms).
     */
    eventWaitMs?: number;
}

/** Index scans per scope before the check gives up as unstable. */
const ATTEMPTS = 5;
/**
 * Documents writes its index before it dispatches the change event, with
 * awaits in between (a remote batch dispatches once its last put is
 * indexed), so a scan can see a row whose event is still on its way. Such a
 * row differs until its event names it; a row that differs and that no
 * event names within this bound is a real difference.
 */
const EVENT_WAIT_MS = 5_000;
/** Differing digests shown per kind. */
const SAMPLE = 4;

const sameBytes = (a: Uint8Array, b: Uint8Array) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
};

const short = (digest: Uint8Array) => toHexString(digest).slice(0, 16);

const skippedBy = (fault: unknown): ShadowOutcome => ({
    kind: "skipped",
    reason: `tap faulted: ${(fault as any)?.message ?? fault}`,
    expected: fault instanceof CloseFault,
});

/** A scope that cannot be compared now, or undefined. */
const unavailable = (state: ScopeState): ShadowOutcome | undefined => {
    const { tap, laneSet } = state;
    // A failed start faults the tap too, so the fault is read first.
    if (tap.faulted !== undefined) return skippedBy(tap.faulted);
    if (tap.state !== "live") {
        // Buffering: the close came before the restore or seed finished.
        return { kind: "skipped", reason: `tap ${tap.state}`, expected: true };
    }
    if (laneSet.closed) {
        return { kind: "skipped", reason: "lane set closed", expected: true };
    }
    if (laneSet.faulted) {
        return {
            kind: "skipped",
            reason: `lane set faulted: ${laneSet.faulted.message}`,
            expected: false,
        };
    }
    return undefined;
};

type ScannedRow = {
    /** The id's keyed hash under the map's seed (`IdHeadMap.hashKey`). */
    hash: string;
    key: IdKey;
    digest: Uint8Array;
    modified: bigint;
};

/** Collects a bounded sample per kind of difference. */
class Differences {
    readonly missing: string[] = [];
    readonly heads: string[] = [];
    readonly modified: string[] = [];
    readonly extra: string[] = [];
    rows = 0;
    private push(into: string[], value: string) {
        if (into.length < SAMPLE) into.push(value);
    }
    row(map: IdHeadMap, row: ScannedRow): boolean {
        const slot = map.get(row.key);
        if (slot < 0) {
            this.push(this.missing, `missing ${short(row.digest)}`);
        } else if (!sameBytes(map.head(slot), row.digest)) {
            this.push(
                this.heads,
                `head ${short(map.head(slot))} for ${short(row.digest)}`
            );
        } else if (map.modified(slot) !== row.modified) {
            this.push(
                this.modified,
                `modified ${map.modified(slot)} != ${row.modified} for ${short(row.digest)}`
            );
        } else {
            return false;
        }
        this.rows++;
        return true;
    }
    maintainedOnly(digest: Uint8Array) {
        this.push(this.extra, short(digest));
    }
    describe(count: number, indexed: number): string {
        const problems: string[] = [];
        if (count !== indexed) {
            problems.push(
                `count ${count}, index ${indexed} (delta ${count - indexed})`
            );
        }
        if (this.rows > 0) {
            const sample = [...this.missing, ...this.heads, ...this.modified];
            problems.push(
                `${this.rows} rows differ (${sample.slice(0, SAMPLE).join(", ")})`
            );
        }
        if (this.extra.length > 0) {
            problems.push(`maintained only: ${this.extra.join(", ")}`);
        }
        return problems.join("; ");
    }
}

/**
 * Compares one scope's maintained state with a fresh build from its index.
 * Call while the store is open, with the scope started. Never throws.
 *
 * Rows are matched by id. A scan is compared at its end, in one synchronous
 * step. A row that differs and that an event or a verify named during the
 * scan is in flight: the scope is scanned again. A row that differs and
 * that nothing named is timed on its own from the scan that first saw it so,
 * across scans, and only an event or verify naming it stops its clock: if
 * nothing names it within `eventWaitMs`, the difference is real, whatever
 * happens to other rows meanwhile. Once every row matches, the cells,
 * count, `hlc` and anchor are compared with a build from the same scan, at
 * the same synchronous point.
 */
export const compareScope = async (
    state: ScopeState,
    cellKey: [number, number],
    options: CompareOptions = {}
): Promise<ShadowOutcome> => {
    const { tap } = state;
    const eventWaitMs = options.eventWaitMs ?? EVENT_WAIT_MS;
    let touched = new Set<string>();
    /** Differing rows nothing named yet, by when a scan first saw them. */
    const unnamed = new Map<string, number>();
    let wake: (() => void) | undefined;
    const unwatch = tap.watch((key) => {
        const hash = tap.map.hashKey(key);
        touched.add(hash);
        if (unnamed.delete(hash)) wake?.();
    });
    /**
     * Waits until a row of `unnamed` is named (true) or the oldest one's
     * wait ran out (false).
     */
    const waitForNames = async (): Promise<boolean> => {
        let oldest = Infinity;
        for (const since of unnamed.values()) {
            if (since < oldest) oldest = since;
        }
        const left = oldest + eventWaitMs - Date.now();
        if (left <= 0) return false;
        try {
            return await new Promise<boolean>((resolve) => {
                const timer = setTimeout(() => resolve(false), left);
                wake = () => {
                    clearTimeout(timer);
                    resolve(true);
                };
            });
        } finally {
            wake = undefined;
        }
    };
    let attempts = 0;
    let last: string | undefined;
    const different = (): ShadowOutcome => ({
        kind: "different",
        attempts,
        difference: `${last} (no event named them in ${eventWaitMs} ms)`,
    });
    try {
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
            // Bounded: verifies queued later are compared as in flight.
            await tap.verifiesSettled();
            const skipped = unavailable(state);
            if (skipped) return skipped;
            const map = tap.map;
            touched = new Set();
            const rows: ScannedRow[] = [];
            for await (const page of tap.port.scan()) {
                for (const row of page) {
                    rows.push({
                        hash: map.hashKey(row.key),
                        key: row.key,
                        digest: headDigest(row.head),
                        modified: row.modified,
                    });
                }
            }
            // One synchronous step from here to the anchor requests.
            if (tap.state !== "live" || tap.map !== map) {
                // Reseeded during the scan: compare the new map.
                unnamed.clear();
                continue;
            }
            if (tap.faulted !== undefined) return skippedBy(tap.faulted);
            attempts++;
            const differences = new Differences();
            const settled: string[] = [];
            let moving = 0;
            const indexed = new Set<string>();
            for (const row of rows) {
                indexed.add(row.hash);
                if (touched.has(row.hash)) {
                    if (differences.row(map, row)) moving++;
                    continue;
                }
                if (differences.row(map, row)) settled.push(row.hash);
            }
            if (map.size !== indexed.size || settled.length + moving > 0) {
                map.forEachEntry((hash, digest) => {
                    if (indexed.has(hash)) return;
                    if (touched.has(hash)) {
                        moving++;
                        return;
                    }
                    settled.push(hash);
                    differences.maintainedOnly(digest);
                });
            }
            if (settled.length === 0 && moving === 0) {
                const problem = await compareBuilds(
                    state,
                    cellKey,
                    rows,
                    indexed.size
                );
                return problem === undefined
                    ? { kind: "equal", attempts }
                    : { kind: "different", attempts, difference: problem };
            }
            last = differences.describe(map.size, indexed.size);
            // A row no longer settled matches now (or was named).
            const now = Date.now();
            const settledNow = new Set(settled);
            for (const hash of [...unnamed.keys()]) {
                if (!settledNow.has(hash)) unnamed.delete(hash);
            }
            for (const hash of settled) {
                if (!unnamed.has(hash)) unnamed.set(hash, now);
            }
            if (unnamed.size === 0) {
                // Only rows an event named during the scan: scan again.
                continue;
            }
            // Rows nothing named: their event may still be on its way.
            if (!(await waitForNames())) return different();
        }
        // Out of scans: a row nothing named still gets its own full wait.
        while (unnamed.size > 0) {
            if (!(await waitForNames())) return different();
        }
    } catch (error: any) {
        // Nothing was compared. A worker restart (EAGAIN) is expected; a
        // failed read or a bug in the check is not.
        return {
            kind: "skipped",
            reason: `error: ${error?.message ?? error}`,
            expected: error instanceof AnchorUnavailableError,
        };
    } finally {
        unwatch();
    }
    return { kind: "unstable", attempts, difference: last };
};

/**
 * With every row matched at this synchronous point: the maintained cells,
 * count, `hlc` and anchor against a build from the scanned rows.
 */
const compareBuilds = async (
    state: ScopeState,
    cellKey: [number, number],
    rows: ScannedRow[],
    indexed: number
): Promise<string | undefined> => {
    const { tap, laneSet } = state;
    const problems: string[] = [];
    // Posted at this synchronous point: cells and anchor of the tap's
    // epoch, in one reply (a worker failure fails both).
    const maintained =
        laneSet.seq === tap.epoch
            ? laneSet.stateNow("digest").state
            : undefined;
    maintained?.catch(() => {});
    const fresh = new Cells(M, cellKey[0], cellKey[1]);
    const list = new Uint8Array(rows.length * DIGEST_BYTES);
    let hlc = 0n;
    rows.forEach((row, i) => {
        fresh.apply(row.digest, 1);
        list.set(row.digest, i * DIGEST_BYTES);
        if (row.modified > hlc) hlc = row.modified;
    });
    if (tap.count !== indexed || rows.length !== indexed) {
        problems.push(
            `count ${tap.count}, index ${rows.length} (delta ${tap.count - rows.length})`
        );
    }
    if (tap.hlc < hlc) {
        problems.push(`hlc ${tap.hlc} below the index's ${hlc}`);
    }
    const own = maintained && (await maintained);
    if (!own) {
        problems.push(`lane set at ${laneSet.seq}, tap at ${tap.epoch}`);
    } else if (!sameBytes(own.cells, fresh.toBytes())) {
        problems.push("cells differ");
    }
    const scanned = await laneSet.digestOf(list);
    if (own && !sameBytes(own.digest, scanned)) {
        problems.push("anchor differs");
    }
    return problems.length > 0 ? problems.join("; ") : undefined;
};

/**
 * The close-path check of one runtime: every live scope, then the
 * process-wide host's mode. Records into the registry; never throws.
 */
export const runShadowCheck = async (
    runtime: {
        readonly address: string;
        readonly anchorHost: AnchorHost | undefined;
        readonly unavailable?: string;
        readonly cellKey: [number, number];
        scopeStates(): ScopeState[];
    },
    registry: ShadowRegistry,
    program: object | undefined,
    options?: CompareOptions
): Promise<ShadowOutcome[]> => {
    const owner = registry.live.get(runtime) ?? registry.current;
    const skip = (reason: string, scope?: string) => {
        registry.counts.skipped++;
        registry.skips.push({ owner, address: runtime.address, scope, reason });
    };
    if (program && registry.optedOut.has(program)) {
        skip("opted out");
        return [{ kind: "skipped", reason: "opted out", expected: true }];
    }
    const record = (message: string, scope?: string) => {
        registry.counts.failed++;
        registry.failures.push({
            owner,
            // Stamped now: a close in a suite hook fails no test of its own.
            recordedIn: { ...registry.current },
            address: runtime.address,
            scope,
            message,
        });
    };
    if (!runtime.anchorHost) {
        // Node always has node:crypto: a runtime without readiness state
        // here would leave every check of this file vacuous.
        record(
            `readiness shadow: ${runtime.address} runs without readiness state (${runtime.unavailable ?? "unknown"})`
        );
        return [];
    }
    const outcomes: ShadowOutcome[] = [];
    for (const state of runtime.scopeStates()) {
        registry.counts.checks++;
        const outcome = await compareScope(state, runtime.cellKey, options);
        outcomes.push(outcome);
        const scope = state.descriptor.name;
        if (outcome.kind === "equal") registry.counts.compared++;
        else if (outcome.kind === "unstable") {
            registry.counts.unstable++;
            if (outcome.difference) registry.counts.unconfirmed++;
        } else if (outcome.kind === "skipped") {
            if (outcome.expected) skip(outcome.reason, scope);
            else {
                record(
                    `readiness shadow: ${scope} of ${runtime.address} was not compared: ${outcome.reason}`,
                    scope
                );
            }
        } else {
            record(
                `readiness shadow: ${scope} of ${runtime.address} differs from its index after ${outcome.attempts} scans: ${outcome.difference}`,
                scope
            );
        }
    }
    const shared = await AnchorHost.shared();
    if (
        runtime.anchorHost === shared &&
        shared.mode === "inline" &&
        !(program && registry.inlineAllowed.has(program))
    ) {
        record(
            `readiness shadow: the process-wide anchor host runs inline (${shared.stats.inlineReason ?? "unknown"})`
        );
    }
    return outcomes;
};
