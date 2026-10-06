import { toHexString } from "@peerbit/crypto";
import { AnchorHost } from "./anchor-host.js";
import { Cells } from "./cells.js";
import { DIGEST_BYTES, M } from "./constants.js";
import { headDigest } from "./digest.js";
import type { IdHeadMap, IdKey } from "./id-map.js";
import type { ScopeState } from "./runtime.js";

/**
 * The K2 shadow check (M1 plan section 7.2, S9), test mode only.
 *
 * In every filesystem close, after the drain and before the stores close,
 * each scope's maintained state (cells, count, `hlc`, the id -> head map and
 * the anchor) is compared with a fresh build from an index scan. Rows are
 * matched by id, and a difference counts only once no event can explain it
 * (`compareScope`). A difference is recorded in the registry, never thrown
 * from close; the test setup fails the test that recorded it.
 *
 * Switched on by `globalThis.__SFS_READINESS_SHADOW__`, which the library's
 * `vitest.setup.ts` sets to a registry. Product code never sets it, and
 * without it nothing here runs.
 */

export interface ShadowOwner {
    file?: string;
    test?: string;
}

export interface ShadowFailure {
    owner: ShadowOwner;
    address: string;
    scope?: string;
    message: string;
}

export interface ShadowRegistry {
    /** The running test file and test, set by the test setup. */
    current: ShadowOwner;
    /** Recorded failures; the setup takes them per test file. */
    failures: ShadowFailure[];
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
    | { kind: "skipped"; reason: string };

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
 * that nothing named waits for an event naming it, up to `eventWaitMs`,
 * whatever happens to other rows meanwhile; if none comes, the difference
 * is real. Once every row matches, the cells, count, `hlc` and anchor are
 * compared with a build from the same scan, at the same synchronous point.
 */
export const compareScope = async (
    state: ScopeState,
    cellKey: [number, number],
    options: CompareOptions = {}
): Promise<ShadowOutcome> => {
    const { tap, laneSet } = state;
    const eventWaitMs = options.eventWaitMs ?? EVENT_WAIT_MS;
    let touched = new Set<string>();
    let waitingFor: Set<string> | undefined;
    let wake: (() => void) | undefined;
    const unwatch = tap.watch((key) => {
        const hash = tap.map.hashKey(key);
        touched.add(hash);
        if (waitingFor?.has(hash)) wake?.();
    });
    let attempts = 0;
    let last: string | undefined;
    try {
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
            // Bounded: verifies queued later are compared as in flight.
            await tap.verifiesSettled();
            if (tap.state !== "live") {
                return { kind: "skipped", reason: `tap ${tap.state}` };
            }
            if (tap.faulted !== undefined) {
                return { kind: "skipped", reason: "tap faulted" };
            }
            if (laneSet.faulted || laneSet.closed) {
                return { kind: "skipped", reason: "lane set unavailable" };
            }
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
                continue;
            }
            if (tap.faulted !== undefined) {
                return { kind: "skipped", reason: "tap faulted" };
            }
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
            if (settled.length === 0) {
                // Only rows an event named during the scan: scan again.
                continue;
            }
            // Rows nothing named: their event may still be on its way.
            waitingFor = new Set(settled);
            const named = await new Promise<boolean>((resolve) => {
                const timer = setTimeout(() => resolve(false), eventWaitMs);
                wake = () => {
                    clearTimeout(timer);
                    resolve(true);
                };
            });
            waitingFor = undefined;
            wake = undefined;
            if (!named) {
                return {
                    kind: "different",
                    attempts,
                    difference: `${last} (no event named them in ${eventWaitMs} ms)`,
                };
            }
        }
    } catch (error: any) {
        // A failed read or a worker restart: nothing was compared.
        return {
            kind: "skipped",
            reason: `error: ${error?.message ?? error}`,
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
    const { tap, cells, laneSet } = state;
    const problems: string[] = [];
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
    if (!sameBytes(cells.toBytes(), fresh.toBytes())) {
        problems.push("cells differ");
    }
    const maintained =
        laneSet.seq === tap.epoch ? laneSet.digestNow() : undefined;
    if (!maintained) {
        problems.push(`lane set at ${laneSet.seq}, tap at ${tap.epoch}`);
    }
    maintained?.digest.catch(() => {});
    const scanned = await laneSet.digestOf(list);
    if (maintained && !sameBytes(await maintained.digest, scanned)) {
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
    program: object | undefined
): Promise<ShadowOutcome[]> => {
    if (program && registry.optedOut.has(program)) {
        registry.counts.skipped++;
        return [{ kind: "skipped", reason: "opted out" }];
    }
    const owner = registry.live.get(runtime) ?? registry.current;
    const record = (message: string, scope?: string) => {
        registry.counts.failed++;
        registry.failures.push({
            owner,
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
        const outcome = await compareScope(state, runtime.cellKey);
        outcomes.push(outcome);
        const scope = state.descriptor.name;
        if (outcome.kind === "equal") registry.counts.compared++;
        else if (outcome.kind === "unstable") {
            registry.counts.unstable++;
            if (outcome.difference) registry.counts.unconfirmed++;
        } else if (outcome.kind === "skipped") registry.counts.skipped++;
        else {
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
