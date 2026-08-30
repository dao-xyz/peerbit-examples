/**
 * Read-side turn barriers over changeset manifests.
 *
 * A ChangesetBarrierHub counts member-document admissions against the
 * membership that admitted manifests declare, and resolves awaitChangeset
 * barriers / feeds watchChangesets streams. It taps the same change feed
 * as the watch layer, holds only bounded state, and talks to the program
 * exclusively through ChangesetHost — no winner logic, no store access.
 *
 * Race discipline (normative, from the judged design):
 * - Tracker init registers a BUFFER before any query, so arrivals and
 *   removals during the probe are never lost; the probe then reads the
 *   indexed changesetId fast path plus an id-probe for residue members
 *   (adopted satisfiers carry foreign/absent changesetId stamps).
 * - A removal observed for a pending member counts as observed-admitted
 *   (a removal only materializes for a document that was admitted).
 * - Completeness is an observation; GC never falsifies it (session latch).
 */
import { ChangesetManifest, ChangesetManifestPayload } from "./model.js";
import { deserialize } from "@dao-xyz/borsh";
import { toBase64URL } from "@peerbit/crypto";

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export type ChangesetManifestStatus = {
    manifestId: string;
    /** AUTHENTICATED author (inner signature), unlike advisory doc rows. */
    authorKey: string;
    createdAtWallMs: number;
    localArrivalMs?: number;
    expected: number;
    /** Observed admitted, including admitted-then-retired members. */
    arrived: number;
    missing: number;
    complete: boolean;
    /** The manifest document itself was retired mid-track. */
    removed?: boolean;
    /** False when excluded by a manifestId/authors scope. */
    inScope: boolean;
    /** First <=100 unarrived member ids (diagnostics). */
    missingMembers?: string[];
};

export type ChangesetVerdict =
    | "complete"
    | "pending"
    | "collected-or-incomplete"
    | "unknown";

export type ChangesetStatus = {
    changesetId: string;
    /** At least one manifest for the id is locally admitted. */
    known: boolean;
    /** Union of member sets over in-scope manifests. */
    expected: number;
    arrived: number;
    complete: boolean;
    verdict: ChangesetVerdict;
    bootstrapPhase?: string;
    manifests: ChangesetManifestStatus[];
};

export type AwaitChangesetOptions = {
    /** Default 30_000 ms. Pass Infinity explicitly for no timeout. */
    timeoutMs?: number;
    signal?: AbortSignal;
    /**
     * EXACT barrier (recommended): only this manifest's members gate.
     * Unforgeable — member ids are unguessable and inner-signed.
     */
    manifestId?: string;
    /** Unscoped fallback filter: only manifests by these authors gate. */
    authors?: string[];
    /**
     * Missing members resolve "collected-or-incomplete" once every
     * in-scope manifest is older than this by BOTH its writer stamp and
     * its local arrival (the arrival-age floor defuses backdating).
     * Default 48h (the GC grace floor). 0 disables.
     */
    historicThresholdMs?: number;
    allowPartial?: boolean;
};

export type ChangesetEvent =
    | {
          type: "manifest";
          changesetId: string;
          manifest: ChangesetManifestStatus;
      }
    | { type: "complete"; changesetId: string; status: ChangesetStatus };

export interface ChangesetWatcher extends AsyncIterable<ChangesetEvent[]> {
    readonly closed: boolean;
    on(type: "change", cb: (batch: ChangesetEvent[]) => void): () => void;
    on(type: "error", cb: (error: Error) => void): () => void;
    on(type: "close", cb: () => void): () => void;
    close(): void;
}

/* ------------------------------------------------------------------ */
/* Host surface                                                        */
/* ------------------------------------------------------------------ */

export interface ChangesetHost {
    /** Resolved manifest documents for a changeset id (few, local only). */
    manifestsFor(
        changesetId: string
    ): Promise<{ manifest: ChangesetManifest; localArrivalMs?: number }[]>;
    /** Ids of naming/version rows stamped with the id (indexed fast path). */
    arrivedMemberIds(changesetId: string): Promise<Set<string>>;
    /** Indexed single-id existence probe (residue members). */
    hasDocumentId(id: string): Promise<boolean>;
    bootstrapPhase(): string;
    overlayActive(): boolean;
    awaitBootstrapConverged(): Promise<unknown>;
    clock(): number;
    makeError(code: string, message: string): Error;
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HISTORIC_THRESHOLD_MS = 172_800_000; // 48h
const TRACKER_LRU_CAP = 4096;
const EMITTED_LATCH_CAP = 65_536;
const HISTORIC_CHECK_INTERVAL_MS = 30_000;
const MISSING_DIAGNOSTIC_CAP = 100;
/** Manifests tracked per changeset id; a trusted-but-rogue writer minting
 *  endless distinct manifests must not grow tracker state without bound. */
const MAX_MANIFESTS_PER_TRACKER = 64;
const PROBED_IDS_CAP = 4096;
const TRACKER_BUFFER_CAP = 50_000;

type ManifestTrack = {
    manifestId: string;
    authorKey: string;
    createdAtWallMs: number;
    localArrivalMs?: number;
    memberIds: string[];
    expected: number;
    /** Null once complete (counters retained). */
    pending: Set<string> | null;
    removed?: boolean;
};

type Waiter = {
    scopeManifestId?: string;
    scopeAuthors?: string[];
    historicThresholdMs: number;
    resolve: (status: ChangesetStatus) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
    signalCleanup?: () => void;
    settled: boolean;
};

type Tracker = {
    changesetId: string;
    manifests: Map<string, ManifestTrack>;
    /** Ids observed admitted BEFORE their manifest was known. */
    observed: Set<string>;
    waiters: Waiter[];
    initialized: Promise<void>;
    buffer: {
        added: string[];
        manifests: ChangesetManifest[];
        overflow: boolean;
    } | null;
    lastTouched: number;
    pinned: number;
};

const memberIdsOf = (manifest: ChangesetManifest): string[] => {
    const payload = deserialize(
        manifest.payloadBytes,
        ChangesetManifestPayload
    );
    // Reconstruct with the SAME codec createId uses, so round-tripping a
    // member id through raw bytes is byte-exact.
    return [
        ...payload.versionMembers.map((raw) => `version:${toBase64URL(raw)}`),
        ...payload.namingMembers.map((raw) => `naming:${toBase64URL(raw)}`),
    ];
};

export class ChangesetBarrierHub {
    private trackers = new Map<string, Tracker>();
    private pendingIndex = new Map<string, Set<Tracker>>();
    private streams = new Set<ChangesetStreamImpl>();
    private emittedOnce = new Set<string>();
    private probedIds = new Set<string>();
    /** Trackers whose init buffer is live — the only ones the tap scans. */
    private bufferingTrackers = new Set<Tracker>();
    private historicTimer?: ReturnType<typeof setInterval>;
    /** Complete-emissions queued while the bootstrap overlay serves reads. */
    private overlayQueue: ChangesetEvent[] = [];
    private closed = false;

    constructor(private host: ChangesetHost) {}

    /* ---------------- feed tap (synchronous) ---------------- */

    ingest(added: any[], removed: any[]): void {
        if (this.closed) return;
        for (const doc of added) {
            if (doc instanceof ChangesetManifest) {
                this.onManifestArrived(doc);
                continue;
            }
            const id = (doc as any)?.id;
            if (typeof id !== "string") continue;
            this.onMemberObserved(id);
            const changesetId = (doc as any)?.changesetId;
            if (
                typeof changesetId === "string" &&
                !this.trackers.has(changesetId) &&
                this.hasGlobalStream() &&
                !this.probedIds.has(changesetId)
            ) {
                // Seed-on-first-touch: a member arriving before any local
                // interest, while a global stream exists, probes ONCE for
                // its manifest (covers the manifest-before-restart /
                // members-after straddle for push consumers).
                if (this.probedIds.size >= PROBED_IDS_CAP) {
                    const oldest = this.probedIds.values().next().value;
                    if (oldest !== undefined) this.probedIds.delete(oldest);
                }
                this.probedIds.add(changesetId);
                queueMicrotask(() => {
                    void this.ensureTracker(changesetId, false).catch(() => {});
                });
            }
        }
        for (const doc of removed) {
            if (doc instanceof ChangesetManifest) {
                this.onManifestRemoved(doc);
                continue;
            }
            const id = (doc as any)?.id;
            if (typeof id !== "string") continue;
            // A removal materializes only for an admitted document.
            this.onMemberObserved(id);
        }
    }

    /** Bootstrap overlay retired: flush queued complete emissions. */
    overlayRetired(): void {
        if (this.overlayQueue.length === 0) return;
        const queued = this.overlayQueue.splice(0);
        for (const event of queued) this.emitToStreams(event);
    }

    /* ---------------- tracker machinery ---------------- */

    private hasGlobalStream(): boolean {
        for (const stream of this.streams) {
            if (!stream.scopeChangesetId) return true;
        }
        return false;
    }

    private touch(tracker: Tracker): void {
        tracker.lastTouched = this.host.clock();
        this.evictIfNeeded();
    }

    private evictIfNeeded(): void {
        if (this.trackers.size <= TRACKER_LRU_CAP) return;
        // Evict least-recently-touched unpinned trackers; prefer complete.
        const candidates = [...this.trackers.values()]
            .filter((tracker) => tracker.pinned === 0)
            .sort((a, b) => a.lastTouched - b.lastTouched);
        for (const tracker of candidates) {
            if (this.trackers.size <= TRACKER_LRU_CAP) break;
            this.dropTracker(tracker);
        }
    }

    private dropTracker(tracker: Tracker): void {
        this.trackers.delete(tracker.changesetId);
        for (const track of tracker.manifests.values()) {
            if (!track.pending) continue;
            for (const id of track.pending) {
                const set = this.pendingIndex.get(id);
                set?.delete(tracker);
                if (set && set.size === 0) this.pendingIndex.delete(id);
            }
        }
    }

    private async ensureTracker(
        changesetId: string,
        pin: boolean
    ): Promise<Tracker> {
        let tracker = this.trackers.get(changesetId);
        if (tracker) {
            this.touch(tracker);
            await tracker.initialized;
            if (pin) tracker.pinned += 1; // only after a successful init
            return tracker;
        }
        // Register with a buffer BEFORE any query: the tap routes matching
        // arrivals into the buffer while the probe runs.
        const fresh: Tracker = {
            changesetId,
            manifests: new Map(),
            observed: new Set(),
            waiters: [],
            initialized: undefined as any,
            buffer: { added: [], manifests: [], overflow: false },
            lastTouched: this.host.clock(),
            pinned: 0,
        };
        this.trackers.set(changesetId, fresh);
        this.bufferingTrackers.add(fresh);
        fresh.initialized = (async () => {
            const manifests = await this.host.manifestsFor(changesetId);
            const arrived = await this.host.arrivedMemberIds(changesetId);
            for (const id of arrived) fresh.observed.add(id);
            for (const { manifest, localArrivalMs } of manifests) {
                await this.installManifest(fresh, manifest, localArrivalMs);
            }
            // Drain the buffer through the normal paths.
            const buffered = fresh.buffer;
            fresh.buffer = null;
            this.bufferingTrackers.delete(fresh);
            for (const manifest of buffered?.manifests ?? []) {
                await this.installManifest(fresh, manifest, undefined);
            }
            for (const id of buffered?.added ?? []) {
                this.observeOnTracker(fresh, id);
            }
            if (buffered?.overflow) {
                // The buffer saturated during init: re-probe the indexed
                // fast path once so nothing recorded there is missed.
                const again = await this.host.arrivedMemberIds(changesetId);
                for (const id of again) this.observeOnTracker(fresh, id);
            }
            this.evaluateCompletion(fresh);
        })();
        try {
            await fresh.initialized;
        } catch (error) {
            // A failed probe must not poison the id for the session: the
            // next call re-registers and re-probes from scratch.
            this.bufferingTrackers.delete(fresh);
            this.dropTracker(fresh);
            throw error;
        }
        if (pin) fresh.pinned += 1;
        this.evictIfNeeded();
        return fresh;
    }

    /** Install one manifest's membership on a tracker (idempotent). */
    private async installManifest(
        tracker: Tracker,
        manifest: ChangesetManifest,
        localArrivalMs: number | undefined
    ): Promise<void> {
        if (tracker.manifests.has(manifest.id)) return;
        if (tracker.manifests.size >= MAX_MANIFESTS_PER_TRACKER) {
            // Bounded against manifest-minting writers; documented cap.
            return;
        }
        const memberIds = memberIdsOf(manifest);
        const track: ManifestTrack = {
            manifestId: manifest.id,
            authorKey: manifest.authorKey,
            createdAtWallMs: Number(manifest.createdAtWallMs),
            localArrivalMs: localArrivalMs ?? this.host.clock(),
            memberIds,
            expected: memberIds.length,
            pending: new Set(memberIds),
        };
        // Register BEFORE any await: arrivals during the residue probes
        // route through pendingIndex/observeOnTracker (idempotent deletes),
        // so no admission in the probe window can be lost.
        tracker.manifests.set(manifest.id, track);
        for (const id of track.pending!) {
            let set = this.pendingIndex.get(id);
            if (!set) {
                set = new Set();
                this.pendingIndex.set(id, set);
            }
            set.add(tracker);
        }
        if (track.pending!.size > 0) {
            // A new incomplete manifest reopens the transition: the next
            // completion must fire a fresh complete event (latch is per
            // transition, not per changeset id forever).
            this.emittedOnce.delete(`${tracker.changesetId}#complete`);
        }
        // Fast-path observations (changesetId-stamped rows) first...
        for (const id of [...track.pending!]) {
            if (tracker.observed.has(id)) {
                this.observeOnTracker(tracker, id);
            }
        }
        // ...then the residue id-probe: adopted members carry foreign or
        // absent changesetId stamps; arrival means "a document with this
        // id was admitted", period.
        for (const id of [...(track.pending ?? [])]) {
            if (track.pending === null) break;
            if (await this.host.hasDocumentId(id)) {
                this.observeOnTracker(tracker, id);
            }
        }
        if (track.pending && track.pending.size === 0) track.pending = null;
        this.emitEvent({
            type: "manifest",
            changesetId: tracker.changesetId,
            manifest: this.manifestStatus(track, undefined, undefined),
        });
    }

    private onManifestArrived(manifest: ChangesetManifest): void {
        const changesetId = manifest.changesetId;
        const tracker = this.trackers.get(changesetId);
        if (tracker) {
            if (tracker.buffer) {
                tracker.buffer.manifests.push(manifest);
                return;
            }
            queueMicrotask(() => {
                void (async () => {
                    await this.installManifest(tracker, manifest, undefined);
                    this.evaluateCompletion(tracker);
                })().catch(() => {});
            });
            return;
        }
        if (this.hasGlobalStream()) {
            queueMicrotask(() => {
                void this.ensureTracker(changesetId, false).catch(() => {});
            });
        }
    }

    private onManifestRemoved(manifest: ChangesetManifest): void {
        const tracker = this.trackers.get(manifest.changesetId);
        const track = tracker?.manifests.get(manifest.id);
        if (!tracker || !track) return;
        // A sweep proves the store aged past the turn: the manifest no
        // longer gates other waiters, and ITS waiters resolve honestly.
        track.removed = true;
        if (track.pending && track.pending.size > 0) {
            for (const id of track.pending) {
                // Keep routing alive for ids a sibling manifest still gates
                // on — a sweep of one manifest must not sever the others.
                let stillNeeded = false;
                for (const other of tracker.manifests.values()) {
                    if (other === track || other.removed) continue;
                    if (other.pending?.has(id)) {
                        stillNeeded = true;
                        break;
                    }
                }
                if (stillNeeded) continue;
                const set = this.pendingIndex.get(id);
                set?.delete(tracker);
                if (set && set.size === 0) this.pendingIndex.delete(id);
            }
            queueMicrotask(() => this.settleWaiters(tracker));
        }
    }

    private onMemberObserved(id: string): void {
        const set = this.pendingIndex.get(id);
        if (set) {
            for (const tracker of [...set]) {
                this.observeOnTracker(tracker, id);
            }
        }
        // Only trackers with a live init buffer record raw ids.
        for (const tracker of this.bufferingTrackers) {
            const buffer = tracker.buffer;
            if (!buffer) continue;
            if (buffer.added.length >= TRACKER_BUFFER_CAP) {
                buffer.overflow = true;
                continue;
            }
            buffer.added.push(id);
        }
    }

    private observeOnTracker(tracker: Tracker, id: string): void {
        tracker.observed.add(id);
        let transitioned = false;
        for (const track of tracker.manifests.values()) {
            if (track.pending?.delete(id)) {
                if (track.pending.size === 0) {
                    track.pending = null;
                    transitioned = true;
                }
            }
        }
        const set = this.pendingIndex.get(id);
        set?.delete(tracker);
        if (set && set.size === 0) this.pendingIndex.delete(id);
        // Full evaluation is O(members): run it only when a manifest just
        // completed (per-arrival work stays O(1) map/set ops).
        if (transitioned) {
            queueMicrotask(() => this.evaluateCompletion(tracker));
        }
    }

    /* ---------------- completion + waiters ---------------- */

    private manifestStatus(
        track: ManifestTrack,
        scopeManifestId: string | undefined,
        scopeAuthors: string[] | undefined
    ): ChangesetManifestStatus {
        const missing = track.pending ? track.pending.size : 0;
        const inScope = scopeManifestId
            ? track.manifestId === scopeManifestId
            : scopeAuthors
              ? scopeAuthors.includes(track.authorKey)
              : true;
        return {
            manifestId: track.manifestId,
            authorKey: track.authorKey,
            createdAtWallMs: track.createdAtWallMs,
            localArrivalMs: track.localArrivalMs,
            expected: track.expected,
            arrived: track.expected - missing,
            missing,
            complete: missing === 0,
            removed: track.removed || undefined,
            inScope,
            missingMembers:
                missing > 0
                    ? [...track.pending!].slice(0, MISSING_DIAGNOSTIC_CAP)
                    : undefined,
        };
    }

    status(
        changesetId: string,
        scopeManifestId?: string,
        scopeAuthors?: string[],
        historicThresholdMs = DEFAULT_HISTORIC_THRESHOLD_MS
    ): ChangesetStatus {
        const tracker = this.trackers.get(changesetId);
        const manifests = tracker
            ? [...tracker.manifests.values()].map((track) =>
                  this.manifestStatus(track, scopeManifestId, scopeAuthors)
              )
            : [];
        const inScope = manifests.filter((m) => m.inScope);
        const memberUnion = new Set<string>();
        const arrivedUnion = new Set<string>();
        if (tracker) {
            for (const track of tracker.manifests.values()) {
                const statusRow = this.manifestStatus(
                    track,
                    scopeManifestId,
                    scopeAuthors
                );
                if (!statusRow.inScope) continue;
                for (const id of track.memberIds) {
                    memberUnion.add(id);
                    if (!track.pending || !track.pending.has(id)) {
                        arrivedUnion.add(id);
                    }
                }
            }
        }
        const known = manifests.length > 0;
        const gatingIncomplete = inScope.filter(
            (m) => !m.complete && !m.removed
        );
        // A manifest observed complete stays complete even after GC
        // sweeps the manifest document: completeness is an observation the
        // sweep never falsifies.
        const complete =
            known &&
            inScope.length > 0 &&
            gatingIncomplete.length === 0 &&
            inScope.some((m) => m.complete);
        let verdict: ChangesetVerdict;
        if (!known) {
            verdict = "unknown";
        } else if (inScope.length === 0) {
            verdict = "unknown";
        } else if (complete) {
            verdict = "complete";
        } else if (
            gatingIncomplete.length === 0 ||
            this.pastHistoricThreshold(gatingIncomplete, historicThresholdMs)
        ) {
            verdict = "collected-or-incomplete";
        } else {
            verdict = "pending";
        }
        const phase = this.host.bootstrapPhase();
        return {
            changesetId,
            known,
            expected: memberUnion.size,
            arrived: arrivedUnion.size,
            complete: verdict === "complete",
            verdict,
            bootstrapPhase:
                phase === "converged" || phase === "off" ? undefined : phase,
            manifests,
        };
    }

    private pastHistoricThreshold(
        incomplete: ChangesetManifestStatus[],
        thresholdMs: number
    ): boolean {
        if (thresholdMs <= 0) return false;
        const now = this.host.clock();
        return incomplete.every((m) => {
            const age =
                now - Math.max(m.createdAtWallMs, m.localArrivalMs ?? 0);
            return age >= thresholdMs;
        });
    }

    private evaluateCompletion(tracker: Tracker): void {
        this.settleWaiters(tracker);
        // Session-latched complete emission (unscoped view).
        const status = this.status(tracker.changesetId);
        if (status.verdict === "complete") {
            const latch = `${tracker.changesetId}#complete`;
            if (!this.emittedOnce.has(latch)) {
                if (this.emittedOnce.size >= EMITTED_LATCH_CAP) {
                    // Evict the oldest half (insertion order), never all —
                    // a full clear would re-fire completes for live ids.
                    let toDrop = EMITTED_LATCH_CAP >> 1;
                    for (const key of this.emittedOnce) {
                        if (toDrop-- <= 0) break;
                        this.emittedOnce.delete(key);
                    }
                }
                this.emittedOnce.add(latch);
                this.emitEvent({
                    type: "complete",
                    changesetId: tracker.changesetId,
                    status,
                });
            }
            // Completed trackers drop pending sets (counters retained).
            for (const track of tracker.manifests.values()) {
                if (track.pending && track.pending.size === 0) {
                    track.pending = null;
                }
            }
        }
    }

    private settleWaiters(tracker: Tracker): void {
        if (tracker.waiters.length === 0) return;
        const remaining: Waiter[] = [];
        for (const waiter of tracker.waiters) {
            if (waiter.settled) continue;
            const status = this.status(
                tracker.changesetId,
                waiter.scopeManifestId,
                waiter.scopeAuthors,
                waiter.historicThresholdMs
            );
            if (
                status.verdict === "complete" ||
                status.verdict === "collected-or-incomplete"
            ) {
                this.finishWaiter(waiter, tracker);
                waiter.resolve(status);
            } else {
                remaining.push(waiter);
            }
        }
        tracker.waiters = remaining;
        this.armHistoricTimer();
    }

    private finishWaiter(waiter: Waiter, tracker: Tracker): void {
        waiter.settled = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.signalCleanup?.();
        tracker.pinned = Math.max(0, tracker.pinned - 1);
    }

    private armHistoricTimer(): void {
        const anyWaiters = [...this.trackers.values()].some(
            (tracker) => tracker.waiters.length > 0
        );
        if (anyWaiters && !this.historicTimer) {
            this.historicTimer = setInterval(() => {
                for (const tracker of this.trackers.values()) {
                    if (tracker.waiters.length > 0) {
                        this.settleWaiters(tracker);
                    }
                }
                this.armHistoricTimer();
            }, HISTORIC_CHECK_INTERVAL_MS);
            (this.historicTimer as any)?.unref?.();
        } else if (!anyWaiters && this.historicTimer) {
            clearInterval(this.historicTimer);
            this.historicTimer = undefined;
        }
    }

    /* ---------------- public operations ---------------- */

    /** Install (or refresh) a tracker without pinning or waiting. */
    async ensure(changesetId: string): Promise<void> {
        if (this.closed) {
            throw this.host.makeError("ECLOSED", "store closed");
        }
        await this.ensureTracker(changesetId, false);
    }

    async await(
        changesetId: string,
        options: AwaitChangesetOptions = {}
    ): Promise<ChangesetStatus> {
        if (this.closed) {
            throw this.host.makeError("ECLOSED", "store closed");
        }
        // One deadline spans the WHOLE call — including the bootstrap
        // convergence wait and tracker init — so a 30s timeout during a
        // 15-minute overlay window rejects at 30s with bootstrapPhase
        // attached instead of silently blocking.
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const startedAt = this.host.clock();
        const timedOutError = () => {
            const error: any = this.host.makeError(
                "ETIMEDOUT",
                `awaitChangeset(${changesetId}) timed out after ${timeoutMs}ms`
            );
            error.status = this.status(
                changesetId,
                options.manifestId,
                options.authors,
                options.historicThresholdMs ?? DEFAULT_HISTORIC_THRESHOLD_MS
            );
            return error;
        };
        const race = async <T>(work: Promise<T>): Promise<T> => {
            if (!Number.isFinite(timeoutMs) && !options.signal) return work;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let onAbort: (() => void) | undefined;
            try {
                return await new Promise<T>((resolve, reject) => {
                    if (Number.isFinite(timeoutMs)) {
                        const remaining = Math.max(
                            0,
                            timeoutMs - (this.host.clock() - startedAt)
                        );
                        timer = setTimeout(
                            () => reject(timedOutError()),
                            remaining
                        );
                    }
                    if (options.signal) {
                        onAbort = () =>
                            reject(
                                this.host.makeError(
                                    "EINVAL",
                                    "awaitChangeset aborted"
                                )
                            );
                        if (options.signal.aborted) {
                            onAbort();
                            return;
                        }
                        options.signal.addEventListener("abort", onAbort, {
                            once: true,
                        });
                    }
                    work.then(resolve, reject);
                });
            } finally {
                if (timer) clearTimeout(timer);
                if (onAbort) {
                    options.signal?.removeEventListener("abort", onAbort);
                }
            }
        };
        if (this.host.overlayActive() && !options.allowPartial) {
            // Compose bootstrap convergence: overlay-served docs never
            // enter the feed/index, so counting now would under-count for
            // the whole overlay window. awaitBootstrapConverged settles on
            // every terminal transition — this cannot wedge.
            await race(this.host.awaitBootstrapConverged());
        }
        const tracker = await race(this.ensureTracker(changesetId, false));
        if (this.closed) {
            throw this.host.makeError("ECLOSED", "store closed");
        }
        return new Promise<ChangesetStatus>((resolve, reject) => {
            const waiter: Waiter = {
                scopeManifestId: options.manifestId,
                scopeAuthors: options.authors,
                historicThresholdMs:
                    options.historicThresholdMs ??
                    DEFAULT_HISTORIC_THRESHOLD_MS,
                resolve,
                reject,
                settled: false,
            };
            tracker.pinned += 1; // finishWaiter releases it
            const finishRejected = (error: Error) => {
                if (waiter.settled) return;
                this.finishWaiter(waiter, tracker);
                tracker.waiters = tracker.waiters.filter((w) => w !== waiter);
                reject(error);
            };
            if (Number.isFinite(timeoutMs)) {
                const remaining = Math.max(
                    0,
                    timeoutMs - (this.host.clock() - startedAt)
                );
                waiter.timer = setTimeout(
                    () => finishRejected(timedOutError()),
                    remaining
                );
            }
            if (options.signal) {
                const onAbort = () =>
                    finishRejected(
                        this.host.makeError("EINVAL", "awaitChangeset aborted")
                    );
                options.signal.addEventListener("abort", onAbort, {
                    once: true,
                });
                waiter.signalCleanup = () =>
                    options.signal!.removeEventListener("abort", onAbort);
                if (options.signal.aborted) {
                    onAbort();
                    return;
                }
            }
            tracker.waiters.push(waiter);
            this.settleWaiters(tracker);
        });
    }

    watch(options?: {
        changesetId?: string;
        signal?: AbortSignal;
    }): ChangesetWatcher {
        const stream = new ChangesetStreamImpl(
            options?.changesetId,
            () => this.streams.delete(stream),
            this.host
        );
        this.streams.add(stream);
        if (options?.signal?.aborted) {
            stream.close();
            return stream;
        }
        options?.signal?.addEventListener("abort", () => stream.close(), {
            once: true,
        });
        if (options?.changesetId) {
            // Scoped streams pin their tracker while subscribed; a stream
            // that closed before the tracker resolved releases immediately.
            void this.ensureTracker(options.changesetId, false)
                .then((tracker) => {
                    if (stream.closed) return;
                    tracker.pinned += 1;
                    stream.onClose(() => {
                        tracker.pinned = Math.max(0, tracker.pinned - 1);
                    });
                })
                .catch(() => {});
        }
        return stream;
    }

    private emitEvent(event: ChangesetEvent): void {
        if (event.type === "complete" && this.host.overlayActive()) {
            // The served view may lag genuine log admissions during the
            // overlay; emitting early would break "a read triggered by
            // complete sees the whole turn". Queue until retirement.
            this.overlayQueue.push(event);
            return;
        }
        this.emitToStreams(event);
    }

    private emitToStreams(event: ChangesetEvent): void {
        for (const stream of [...this.streams]) {
            stream.offer(event);
        }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.historicTimer) clearInterval(this.historicTimer);
        for (const tracker of this.trackers.values()) {
            for (const waiter of tracker.waiters) {
                if (waiter.settled) continue;
                waiter.settled = true;
                if (waiter.timer) clearTimeout(waiter.timer);
                waiter.signalCleanup?.();
                waiter.reject(this.host.makeError("ECLOSED", "store closed"));
            }
            tracker.waiters = [];
        }
        for (const stream of [...this.streams]) stream.close();
        this.trackers.clear();
        this.pendingIndex.clear();
        this.overlayQueue = [];
    }
}

/* ------------------------------------------------------------------ */
/* Stream implementation                                               */
/* ------------------------------------------------------------------ */

class ChangesetStreamImpl implements ChangesetWatcher {
    closed = false;
    private changeCbs = new Set<(batch: ChangesetEvent[]) => void>();
    private errorCbs = new Set<(error: Error) => void>();
    private closeCbs = new Set<() => void>();
    private pending: ChangesetEvent[] | null = null;
    private iteratorActive = false;
    private iteratorWake: (() => void) | null = null;

    constructor(
        readonly scopeChangesetId: string | undefined,
        private detach: () => void,
        private host: ChangesetHost
    ) {}

    offer(event: ChangesetEvent): void {
        if (this.closed) return;
        if (
            this.scopeChangesetId &&
            event.changesetId !== this.scopeChangesetId
        ) {
            return;
        }
        for (const cb of [...this.changeCbs]) {
            try {
                cb([event]);
            } catch {
                /* subscriber errors are theirs */
            }
        }
        if (this.iteratorActive) {
            this.pending = this.pending ? [...this.pending, event] : [event];
        }
        this.iteratorWake?.();
    }

    onClose(cb: () => void): void {
        this.closeCbs.add(cb);
    }

    on(type: any, cb: any): () => void {
        const set =
            type === "change"
                ? this.changeCbs
                : type === "error"
                  ? this.errorCbs
                  : this.closeCbs;
        set.add(cb);
        return () => set.delete(cb);
    }

    [Symbol.asyncIterator](): AsyncIterator<ChangesetEvent[]> {
        if (this.iteratorActive) {
            throw this.host.makeError(
                "EINVAL",
                "watcher already has an active iterator"
            );
        }
        this.iteratorActive = true;
        const next = async (): Promise<IteratorResult<ChangesetEvent[]>> => {
            for (;;) {
                if (this.pending && this.pending.length > 0) {
                    const batch = this.pending;
                    this.pending = null;
                    return { value: batch, done: false };
                }
                if (this.closed) {
                    this.iteratorActive = false;
                    return { value: undefined, done: true };
                }
                await new Promise<void>((resolve) => {
                    this.iteratorWake = resolve;
                });
                this.iteratorWake = null;
            }
        };
        return {
            next,
            return: async () => {
                this.iteratorActive = false;
                return { value: undefined, done: true };
            },
        };
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.detach();
        this.pending = null;
        this.iteratorWake?.();
        for (const cb of [...this.closeCbs]) cb();
        this.changeCbs.clear();
        this.errorCbs.clear();
        this.closeCbs.clear();
    }
}
