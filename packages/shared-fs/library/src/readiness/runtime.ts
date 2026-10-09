import { randomBytes, sha256Sync, toHexString } from "@peerbit/crypto";
import type { PublicSignKey } from "@peerbit/crypto";
import type { DocumentsLike } from "@peerbit/document";
import { AnchorHost, type LaneSet } from "./anchor-host.js";
import { cellKey } from "./cells.js";
import { M, NOTICE_TARGETS } from "./constants.js";
import {
    Coordinator,
    type CoordinatorDebug,
    type CoordinatorTransport,
    type Evaluation,
    type ReadinessStatus,
    type StatusContext,
} from "./coordinator.js";
import type { RejectionReason } from "./explain.js";
import {
    encodeStructures,
    takeStructures,
    writeStructures,
    type DecodeResult,
    type PersistedScope,
} from "./persist.js";
import {
    rejectionOf,
    sessionScopeOf,
    type ExplainStore,
    type PullStore,
    type SessionScopeBundle,
} from "./ports.js";
import { LifeRecorder } from "./reachability.js";
import {
    Responder,
    type ResponderPorts,
    type ResponderScope,
    type Timers,
} from "./responder.js";
import {
    NAMESPACE_V1,
    SCOPE_NAMESPACE_V1,
    SCOPE_TRUST_V1,
    TRUST_V1,
    type ScopeDescriptor,
    type ScopeId,
} from "./scopes.js";
import type { SessionResult } from "./session.js";
import {
    runSessionShadowCheck,
    runShadowCheck,
    shadowRegistry,
} from "./shadow.js";
import { ScopeTap, documentsIndexPort } from "./tap.js";
import {
    CellsReqV1,
    CloseV1,
    ListPageV1,
    LOG_ID_BYTES,
    NOTICE_REASON,
    OPEN_NONCE_BYTES,
    OpenV1,
    encodeReadinessMessage,
    type ReadinessMessage,
} from "./wire.js";

/**
 * How a scope's maintained state started in this open generation:
 * restored from the structures file, seeded by an index scan (no usable
 * file, or a restore whose count did not match), or not started. A count
 * check deferred past the start may still scan again later
 * (`ScopeTap.stats.rescans`).
 */
export type ScopeStart =
    | { kind: "pending" }
    | { kind: "restored" }
    | { kind: "scanned"; rejected?: string }
    | { kind: "failed"; error: unknown };

/**
 * One scope of one open generation: the tap and its sink, the lane set,
 * which keeps the anchor lanes and the cells in the worker. `laneSet.seq ===
 * tap.epoch` at every synchronous point (M1 plan section 4).
 */
export interface ScopeState extends ResponderScope {
    readonly started: Promise<void>;
}

/** What `startJoin` needs from the host (PR-3 commit 2, prerequisite mode). */
export interface JoinOptions {
    /**
     * Builds the readiness topic's view of the network (production:
     * `PeerbitTransport`), only when the join starts; a throw faults the
     * join (gated), never the open.
     */
    transport(): CoordinatorTransport;
    /** From the sidecar (commit 4); 0 until then. */
    hlcProved: bigint;
    /** After each evaluation (prerequisite mode: the tracker's recheck). */
    onEvaluate?(evaluation: Evaluation): void;
    /** Bounded timers for the sessions (`systemTimers` by default). */
    timers?: Timers;
    now?(): number;
}

/** `ReadinessRuntime.debug()`: what is armed and in flight. */
export interface RuntimeDebug {
    /** The responder's idle timers plus the coordinator's sessions' timers. */
    armedTimers: number;
    responder?: ReturnType<Responder["debug"]>;
    coordinator?: CoordinatorDebug;
    /** Why this generation's join cannot be satisfied (G2-11). */
    joinFault?: string;
    /** Joiner sends that failed (the coordinator's sessions). */
    sendFailures: number;
}

const isRequest = (message: ReadinessMessage) =>
    message instanceof OpenV1 ||
    message instanceof CellsReqV1 ||
    message instanceof ListPageV1 ||
    message instanceof CloseV1;

/** The 32-byte id of a store's log (the wire's `logId`). */
export const logIdOf = (documents: DocumentsLike<any, any>): Uint8Array => {
    const id: Uint8Array | undefined = (documents as any).log?.log?.id;
    if (!(id instanceof Uint8Array)) {
        throw new Error("readiness: the store's log has no id");
    }
    // Store ids are sha256 outputs today; anything else is hashed so the
    // wire field stays 32 bytes.
    return id.length === LOG_ID_BYTES ? Uint8Array.from(id) : sha256Sync(id);
};

/**
 * Readiness state of one open generation of a filesystem: the scope taps,
 * their lane sets (anchor lanes and cells), the responder, and their
 * persistence. The filesystem creates one per open and talks only to this
 * object; nothing here reads the program after close. It maintains the
 * structures and answers on every peer. On a fresh full address-open it
 * also runs the joiner's coordinator (`startJoin`, PR-3 commit 2): in
 * prerequisite mode today's tracker still decides when the filesystem turns
 * ready and additionally requires `satisfied()`, so the coordinator can only
 * keep a joiner gated longer, never release it earlier.
 */
export class ReadinessRuntime {
    readonly openNonce: Uint8Array = randomBytes(OPEN_NONCE_BYTES);
    readonly starts = new Map<ScopeDescriptor["name"], ScopeStart>();
    readonly responder?: Responder;
    private readonly scopes = new Map<ScopeId, ScopeState>();
    /** The store each scope's tap listens on (the session bundles read it). */
    private readonly stores = new Map<ScopeId, DocumentsLike<any, any>>();
    /** Session ports per scope, built on the first `sessionScope(id)`. */
    private readonly bundles = new Map<
        ScopeId,
        { state: ScopeState; bundle: SessionScopeBundle }
    >();
    /** Disposed bundles' pull queues until their aborted joins settle. */
    private readonly pullsSettling = new Set<Promise<void>>();
    readonly cellKey: [number, number];
    private blockedValue = false;
    private disposedValue = false;
    private readonly seeding: Promise<void>[] = [];
    /** The namespace start as it stood when `prepareClose` sealed the taps. */
    private sealedStart?: ScopeStart;
    /** Messages received while this generation was live (diagnostics). */
    messagesReceived = 0;
    /** The joiner's coordinator of this generation (`startJoin`). */
    private coordinatorValue?: Coordinator;
    private joinStarted = false;
    /**
     * Set when `startJoin` ran but no coordinator could: J cannot contain
     * anyone this open, so `satisfied()` stays false (G2-11).
     */
    private joinFault?: string;
    /** READY notices went out (`markReady`); once per generation. */
    private readyNoticed = false;
    /**
     * Signs of life from the namespace attach until the coordinator's start
     * takes them (an open that may run a join, `attachNamespace`).
     */
    private lifeRecorder?: LifeRecorder;
    private sendFailures = 0;

    /**
     * The decoded structures file until the namespace start takes it; then
     * cleared, so a discarded restore (its map is up to 9.6 MB at 200k rows)
     * can be collected while this generation lives.
     */
    private persisted?: DecodeResult;
    /** The structures take started by `create` (`whenTaken`). */
    private readonly taking: Promise<void>;

    private constructor(
        readonly address: string,
        readonly directory: string | undefined,
        /** The namespace store's log id: its structures file's name. */
        readonly namespaceStore: Uint8Array,
        /**
         * Undefined when this runtime cannot hash (no `node:crypto`, e.g. a
         * browser): the generation then maintains and answers nothing.
         */
        readonly anchorHost: AnchorHost | undefined,
        private readonly ports: ResponderPorts | undefined,
        taking: Promise<DecodeResult | undefined>,
        readonly unavailable?: string,
        /** The filesystem, for the test-mode shadow opt-outs. */
        readonly program?: object
    ) {
        this.taking = taking.then((persisted) => {
            this.persisted = persisted;
        });
        this.cellKey = cellKey(address);
        // Test mode: remember which test opened this generation, so a shadow
        // difference fails that test and no other (the suite shares module
        // state across files).
        const registry = shadowRegistry();
        registry?.live.set(this, { ...registry.current });
        registry?.runtimes.set(toHexString(this.openNonce), new WeakRef(this));
        if (ports && anchorHost) {
            this.responder = new Responder(
                {
                    openNonce: this.openNonce,
                    scope: (id) => this.scopes.get(id),
                    answering: () => !this.blockedValue && !this.disposedValue,
                },
                ports
            );
        }
    }

    /**
     * Captures the address and directory for this generation and starts
     * taking (reading, verifying, unlinking) the persisted structures; the
     * open awaits `whenTaken` before the namespace store ingests, so the
     * take's directory fsync overlaps the trust graph's open. The trust
     * scope is always seeded by scan: its tap may move to the instance
     * `TrustedNetwork.open` returns (S8), so events during that open can be
     * missed and a restore could miss them. A trust file is still removed if
     * one exists. Without `ports` the runtime maintains state but does not
     * answer. Never rejects for want of the anchor host: without one the
     * generation runs without readiness state, so an open cannot fail
     * because of it (shadow mode decides nothing).
     */
    static async create(properties: {
        address: string;
        directory?: string;
        /** Log ids of the stores the scopes describe (`logIdOf`). */
        stores: { namespace: Uint8Array; trust?: Uint8Array };
        ports?: ResponderPorts;
        anchorHost?: AnchorHost;
        /** The filesystem (test-mode shadow opt-outs; never read otherwise). */
        program?: object;
    }): Promise<ReadinessRuntime> {
        const { address, directory, stores } = properties;
        const take = async (store: Uint8Array, scope: ScopeDescriptor) =>
            directory
                ? takeStructures(directory, store, address, scope).catch(
                      (error: any): DecodeResult => ({
                          ok: false,
                          reason: `take: ${error?.message ?? error}`,
                      })
                  )
                : undefined;
        const taking = Promise.all([
            take(stores.namespace, NAMESPACE_V1),
            stores.trust && take(stores.trust, TRUST_V1),
        ]).then(([namespace]) => namespace);
        let host = properties.anchorHost;
        let unavailable: string | undefined;
        if (!host) {
            try {
                host = await AnchorHost.shared();
            } catch (error: any) {
                unavailable = `anchor host: ${error?.message ?? error}`;
            }
        }
        return new ReadinessRuntime(
            address,
            directory,
            stores.namespace,
            host,
            properties.ports,
            taking,
            unavailable,
            properties.program
        );
    }

    /**
     * Resolves once the structures files of this open are taken: each one
     * read and durably removed (or voided). Await it before the namespace
     * store ingests. Never rejects.
     */
    whenTaken(): Promise<void> {
        return this.taking;
    }

    get blocked(): boolean {
        return this.blockedValue;
    }

    get disposed(): boolean {
        return this.disposedValue;
    }

    get namespace(): ScopeTap | undefined {
        return this.scopes.get(SCOPE_NAMESPACE_V1)?.tap;
    }

    get trust(): ScopeTap | undefined {
        return this.scopes.get(SCOPE_TRUST_V1)?.tap;
    }

    /** A scope of this generation (tests, the shadow check, PR-3). */
    scope(id: ScopeId): ScopeState | undefined {
        return this.scopes.get(id);
    }

    /** Every scope of this generation, the namespace first. */
    scopeStates(): ScopeState[] {
        return ([SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1] as ScopeId[]).flatMap(
            (id) => {
                const state = this.scopes.get(id);
                return state ? [state] : [];
            }
        );
    }

    /**
     * Synchronous: a close or reopen began; answer nothing from now on. The
     * coordinator goes first, while sends still pass, so each session it
     * closes can tell R (`CloseV1`); then the session bundles, so no pull
     * queue sink stays on a tap that the close will seal, and their joins
     * in flight abort (`whenPullsSettled` joins them).
     */
    block() {
        this.disposeJoin();
        this.blockedValue = true;
    }

    /** The coordinator and the session bundles; idempotent, never throws. */
    private disposeJoin() {
        this.disposeLifeRecorder();
        const coordinator = this.coordinatorValue;
        if (coordinator) {
            try {
                coordinator.dispose();
            } catch (error: any) {
                console.warn(
                    "shared-fs: readiness coordinator dispose failed:",
                    error?.message ?? error
                );
            }
        }
        for (const id of [...this.bundles.keys()]) this.disposeBundle(id);
    }

    private disposeLifeRecorder() {
        const recorder = this.lifeRecorder;
        this.lifeRecorder = undefined;
        try {
            recorder?.dispose();
        } catch {
            // Removing its listeners never throws.
        }
    }

    private disposeBundle(id: ScopeId) {
        const held = this.bundles.get(id);
        if (!held) return;
        this.bundles.delete(id);
        try {
            held.bundle.dispose();
        } catch {
            // A pull queue's dispose only unsubscribes and aborts.
        }
        const settling = held.bundle.pulls.whenIdle();
        this.pullsSettling.add(settling);
        void settling.finally(() => this.pullsSettling.delete(settling));
    }

    /**
     * Settles once every pull join of this generation's session bundles has
     * settled; a bundle's dispose (`block`, `prepareClose`) aborts them
     * first. Await it before the stores close or drop: `Log.close` and
     * `Log.drop` refuse while a join of ours still runs a mutation callback
     * (`@peerbit/log log.js:4104-4111`, `4193-4197`). Never rejects.
     */
    async whenPullsSettled(): Promise<void> {
        while (this.pullsSettling.size > 0) {
            await Promise.all([...this.pullsSettling]);
        }
    }

    /**
     * A scope's tap with its sink, listening on `documents` (buffering until
     * the start). The lane set (lanes and cells) attaches before any event
     * can apply.
     */
    private createScope(
        descriptor: ScopeDescriptor,
        documents: DocumentsLike<any, any>
    ): { state: ScopeState; settle: () => void } | undefined {
        this.disposeScope(descriptor.id);
        if (!this.anchorHost) return undefined;
        const tap = new ScopeTap(
            descriptor,
            documentsIndexPort(documents, descriptor)
        );
        const laneSet: LaneSet = this.anchorHost.open(descriptor.ivTag, {
            // A worker failure rebuilds the lanes and cells from the live
            // heads.
            slab: () => tap.map,
            cells: { m: M, k0: this.cellKey[0], k1: this.cellKey[1] },
        });
        tap.addSink({
            apply: (digest, sign) => laneSet.apply(digest, sign),
            // A discarded restore: the tap keeps counting its epoch.
            reset: () => laneSet.reset(tap.epoch),
        });
        // A `BUSY` answered while the count was unverified promised a notice
        // that no session end would send (G2-9): the verified count is room.
        tap.onCountVerified(() => this.responder?.noticeCapacity());
        let settle!: () => void;
        const started = new Promise<void>((resolve) => (settle = resolve));
        const state: ScopeState = {
            descriptor,
            tap,
            laneSet,
            logId: logIdOf(documents),
            started,
        };
        tap.attach(documents.events as any);
        this.scopes.set(descriptor.id, state);
        this.stores.set(descriptor.id, documents);
        this.starts.set(descriptor.name, { kind: "pending" });
        return { state, settle };
    }

    private readonly settlers = new Map<ScopeId, () => void>();

    private disposeScope(id: ScopeId) {
        // Its session ports read the tap and the store being replaced.
        this.disposeBundle(id);
        this.stores.delete(id);
        const state = this.scopes.get(id);
        if (!state) return;
        this.scopes.delete(id);
        state.tap.dispose();
        state.laneSet.close();
        this.settlers.get(id)?.();
        this.settlers.delete(id);
    }

    /**
     * Attach before `entries.open()`, so events during open are buffered.
     * `join`: this open may run the joiner's coordinator (a fresh full
     * address-open); the replication announcements and readiness messages
     * that arrive from now on are recorded for it as signs of life, since
     * the coordinator only starts after the store opened.
     */
    attachNamespace(
        entries: DocumentsLike<any, any>,
        options: { join?: boolean } = {}
    ) {
        if (this.disposedValue) return;
        const created = this.createScope(NAMESPACE_V1, entries);
        if (created) this.settlers.set(SCOPE_NAMESPACE_V1, created.settle);
        if (options.join && !this.joinStarted) {
            this.lifeRecorder?.dispose();
            let events: unknown;
            try {
                events = (entries as any).log?.events;
            } catch {
                // No events: the coordinator then sees no sign of life from
                // before its start.
            }
            this.lifeRecorder = new LifeRecorder(events);
        }
    }

    /**
     * After `entries.open()`: restore the persisted state, or seed by scan.
     * Runs in the background; `whenStarted` joins it.
     */
    startNamespace() {
        const state = this.scopes.get(SCOPE_NAMESPACE_V1);
        if (!state || this.disposedValue) return;
        const { tap, laneSet } = state;
        this.track(state, async () => {
            // Taken before the store opened (`whenTaken`); this await only
            // reads the result.
            await this.taking;
            const persisted = this.persisted;
            this.persisted = undefined;
            if (persisted?.ok && persisted.state.scope === SCOPE_NAMESPACE_V1) {
                const { map, hlc, epoch } = persisted.state;
                // The sink first: the tap applies its buffered events at once.
                laneSet.restore(
                    persisted.state.lanes!,
                    epoch,
                    persisted.state.cells!
                );
                tap.restore({ map, hlc, epoch });
                // A count that differs discards the restore (the tap scans
                // again). One that cannot be compared during ingest keeps it
                // unverified until a later change or a consumer compares it
                // (`ScopeTap.checkCount`); unverified, it is not persisted.
                if ((await tap.checkCount()) === false) {
                    return { kind: "scanned", rejected: "count" };
                }
                return { kind: "restored" };
            }
            await tap.seedChecked();
            return persisted && !persisted.ok
                ? { kind: "scanned", rejected: persisted.reason }
                : { kind: "scanned" };
        });
    }

    /** The trust graph instance the trust tap listens on. */
    private trustDocuments?: DocumentsLike<any, any>;

    /**
     * Before `TrustedNetwork.open()`: listen on the trust graph instance it
     * will open, buffering. Documents decides once, when a batch starts,
     * whether that batch dispatches a change event at all: a replicated
     * batch that started before any listener existed would index its rows
     * with no event, after the seed scan read the index.
     */
    attachTrust(trustGraph: DocumentsLike<any, any>) {
        if (this.disposedValue) return;
        const created = this.createScope(TRUST_V1, trustGraph);
        if (!created) return;
        this.trustDocuments = trustGraph;
        this.settlers.set(SCOPE_TRUST_V1, created.settle);
    }

    /**
     * After `TrustedNetwork.open()`: seed the trust tap by scan; the scan
     * starts after the attach. `open` replaces its trust graph with the
     * instance `node.open` returned (S8); when that is another instance (one
     * already open at the same address), the tap moves to it first.
     */
    startTrust(trustGraph: DocumentsLike<any, any>) {
        if (this.disposedValue) return;
        if (
            trustGraph !== this.trustDocuments ||
            !this.scopes.has(SCOPE_TRUST_V1)
        ) {
            this.attachTrust(trustGraph);
        }
        const state = this.scopes.get(SCOPE_TRUST_V1);
        if (!state) return;
        this.track(state, async () => {
            await state.tap.seedChecked();
            return { kind: "scanned" };
        });
    }

    private track(state: ScopeState, start: () => Promise<ScopeStart>) {
        const { descriptor, tap } = state;
        this.starts.set(descriptor.name, { kind: "pending" });
        const run = start()
            .then(
                (outcome) => {
                    if (!this.disposedValue) {
                        this.starts.set(descriptor.name, outcome);
                    }
                },
                (error) => {
                    if (this.disposedValue || tap.state === "disposed") return;
                    tap.faulted ??= error;
                    this.starts.set(descriptor.name, { kind: "failed", error });
                }
            )
            .finally(() => this.settlers.get(descriptor.id)?.());
        this.seeding.push(run);
    }

    /** Resolves when every started scope restored, seeded or failed. */
    async whenStarted(): Promise<void> {
        await Promise.all(this.seeding);
    }

    /**
     * The readiness RPC handler. Requests go to the responder; every message
     * also goes to the coordinator, if one runs: answers and notices to its
     * sessions, and any message as a sign of life of its signer. `bytes` is
     * the RPC envelope's size (at least the message's own; the sessions cap
     * answers by it, G2-14); without it the message is encoded again. Never
     * throws.
     */
    onMessage(
        message: ReadinessMessage,
        from: PublicSignKey | undefined,
        bytes?: number
    ) {
        if (!from || this.disposedValue || this.blockedValue) return;
        this.messagesReceived++;
        if (isRequest(message)) this.responder?.onMessage(message, from);
        // Until the coordinator's start takes the record: a sign of life
        // its discovery counts.
        this.lifeRecorder?.noteMessage(from);
        const coordinator = this.coordinatorValue;
        if (!coordinator) return;
        try {
            const size =
                typeof bytes === "number" && bytes > 0
                    ? bytes
                    : encodeReadinessMessage(message).length;
            coordinator.onMessage(message, from.hashcode(), size, from);
        } catch (error: any) {
            console.warn(
                "shared-fs: readiness coordinator error:",
                error?.message ?? error
            );
        }
    }

    /**
     * The session ports of scope `id` for this generation: built on first
     * use over the scope's tap, lane set and store (ports.ts), and kept
     * until the scope or the generation goes. Undefined when the scope is
     * absent or the generation blocked or disposed.
     */
    sessionScope(id: ScopeId): SessionScopeBundle | undefined {
        if (this.blockedValue || this.disposedValue) return undefined;
        const state = this.scopes.get(id);
        const store = this.stores.get(id);
        if (!state || !store) return undefined;
        const held = this.bundles.get(id);
        if (held?.state === state) return held.bundle;
        if (held) this.disposeBundle(id);
        // Documents satisfies both (its `log` is the SharedLog, whose `log`
        // is the Log; its `index` carries the value encoding).
        const bundle = sessionScopeOf(
            state,
            store as unknown as ExplainStore & PullStore,
            this.cellKey
        );
        this.bundles.set(id, { state, bundle });
        return bundle;
    }

    /**
     * `canPerformEntry`'s hook: a refusal of `head` in scope `scope`. Kept
     * only while a pull of this generation tracks the head (one map lookup
     * otherwise). Never throws.
     */
    noteRejection(scope: ScopeId, head: unknown, reason: RejectionReason) {
        if (this.disposedValue || typeof head !== "string") return;
        try {
            this.bundles
                .get(scope)
                ?.bundle.rejections.note(head, rejectionOf(reason));
        } catch {
            // Diagnostics of a pull; never the admission's concern.
        }
    }

    /**
     * Whether rows of `scope` arrive by sync in this open (design 4.5 step
     * 5): a change event in scope since the tap attached. The seed scan and
     * a restore count none, and a gated joiner writes nothing itself.
     */
    syncDelivering(scope: ScopeId): boolean {
        return (this.scopes.get(scope)?.tap.stats.events ?? 0) > 0;
    }

    /**
     * Starts the joiner's coordinator, once per generation: the host calls
     * it for a fresh full address-open only (never a creator, a warm
     * reopen, an observer or `allowPartialWrites`; deviation h). Sessions
     * wait for the namespace scope's start; commit 2 opens the namespace
     * scope only. Without readiness state (no anchor host) nothing can be
     * contained this open: `satisfied()` stays false and the status names
     * the fault (G2-11); `assumeComplete` is the escape.
     */
    startJoin(options: JoinOptions): void {
        if (this.joinStarted || this.blockedValue || this.disposedValue) {
            return;
        }
        this.joinStarted = true;
        const namespace = this.scopes.get(SCOPE_NAMESPACE_V1);
        const fault = !this.anchorHost
            ? `no readiness state: ${this.unavailable ?? "no anchor host"}`
            : !this.ports
              ? "no readiness transport"
              : !namespace
                ? "no namespace scope"
                : undefined;
        if (fault !== undefined) {
            this.joinFault = fault;
            this.disposeLifeRecorder();
            return;
        }
        let transport: CoordinatorTransport;
        try {
            transport = options.transport();
        } catch (error: any) {
            // Gated, never a failed open: the join cannot see its peers.
            this.joinFault = `readiness transport: ${error?.message ?? error}`;
            this.disposeLifeRecorder();
            return;
        }
        const registry = shadowRegistry();
        const coordinator = new Coordinator({
            transport,
            // Taken once, by `start` (after its listeners attached). No
            // recorder (the host did not mark this open as a join): unknown,
            // so the coordinator counts every replicator row live.
            signsOfLife: () => {
                const recorder = this.lifeRecorder;
                this.lifeRecorder = undefined;
                return recorder?.take();
            },
            send: (message, to) => this.sendTo(message, to),
            scopes: [SCOPE_NAMESPACE_V1],
            scope: (id) => this.sessionScope(id)?.ports,
            started: () => namespace!.started,
            hlcProved: options.hlcProved,
            syncDelivering: (scope) => this.syncDelivering(scope),
            timers: options.timers,
            now: options.now,
            onEvaluate: options.onEvaluate,
            onContained: registry
                ? (_peer, results) => this.checkContained(results)
                : undefined,
        });
        this.coordinatorValue = coordinator;
        try {
            coordinator.start();
        } catch (error: any) {
            // A bug, never a reason to release: the join stays unsatisfied.
            this.joinFault = `coordinator: ${error?.message ?? error}`;
            this.disposeJoin();
        }
    }

    /** A directed one-way send of the coordinator's sessions. */
    private sendTo(message: ReadinessMessage, to: string) {
        if (this.blockedValue || this.disposedValue || !this.ports) return;
        try {
            void this.ports.send(message, to).catch(() => {
                this.sendFailures++;
            });
        } catch {
            this.sendFailures++;
        }
    }

    /** Coalesced re-evaluation of the predicate (the #403 hook). */
    evaluate(): void {
        try {
            this.coordinatorValue?.evaluate();
        } catch {
            // Never surfaces into the host's settle path.
        }
    }

    /**
     * The commit-2 predicate (`Coordinator.satisfied`): false when no join
     * ran or it faulted, so a caller that requires it fails closed.
     */
    satisfied(): boolean {
        if (this.joinFault !== undefined || this.disposedValue) return false;
        return this.coordinatorValue?.satisfied() === true;
    }

    /**
     * A status snapshot of this generation's join, or undefined when none
     * ran (a creator, a warm reopen, an observer, `allowPartialWrites`).
     */
    status(context: StatusContext): ReadinessStatus | undefined {
        if (!this.joinStarted) return undefined;
        if (this.joinFault !== undefined) {
            return {
                state: context.writeReady ? "ready" : "reconciling",
                satisfied: false,
                required: [],
                contained: [],
                excluded: [],
                silent: [],
                inFlight: [],
                busy: [],
                fetchPending: [],
                gaps: [],
                unconfirmed: [],
                fault: this.joinFault,
            };
        }
        return this.coordinatorValue?.status(context);
    }

    /**
     * J turned ready (the tracker's decision or `assumeComplete`), after
     * the host flipped its state, so the provenance the notices carry says
     * ready: the coordinator finishes (sessions closed, records kept for
     * `status`), and every peer that had a session or a `BUSY` with J,
     * either way, gets a READY notice (a trigger for peers J's view may now
     * qualify; never evidence). Once per generation.
     */
    markReady(): void {
        if (this.disposedValue || this.readyNoticed) return;
        this.readyNoticed = true;
        const coordinator = this.coordinatorValue;
        let joined: string[] = [];
        if (coordinator) {
            try {
                joined = coordinator.noticeTargets();
                coordinator.finish();
            } catch (error: any) {
                console.warn(
                    "shared-fs: readiness coordinator finish failed:",
                    error?.message ?? error
                );
            }
        }
        const responder = this.responder;
        if (!responder || this.blockedValue) return;
        const targets = new Map<string, PublicSignKey | string>(
            responder.noticeTargets
        );
        for (const hash of joined) {
            if (targets.size >= NOTICE_TARGETS) break;
            if (!targets.has(hash)) targets.set(hash, hash);
        }
        if (targets.size === 0) return;
        try {
            responder.sendNotice(
                [...targets.values()].slice(0, NOTICE_TARGETS),
                NOTICE_REASON.READY
            );
        } catch {
            // Sends never throw; a notice is a trigger, never needed.
        }
    }

    /**
     * J's trust graph changed: live sessions classify their trust-pending
     * and logged hashes again (G2-10). Never throws.
     */
    onTrustChange(): void {
        try {
            this.coordinatorValue?.reclassify();
        } catch {
            // The trust listener must not fail.
        }
    }

    /** Armed timers and in-flight state (tests and diagnostics). */
    debug(): RuntimeDebug {
        const responder = this.responder?.debug();
        const coordinator = this.coordinatorValue?.debug();
        return {
            armedTimers:
                (responder?.armedTimers ?? 0) + (coordinator?.armedTimers ?? 0),
            responder,
            coordinator,
            joinFault: this.joinFault,
            sendFailures: this.sendFailures,
        };
    }

    /** The joiner's coordinator of this generation, if one runs (tests). */
    get coordinator(): Coordinator | undefined {
        return this.coordinatorValue;
    }

    /**
     * Test mode: a session contained scopes of R. Compares J's maintained
     * state of those scopes with its index and, when R's runtime lives in
     * this process, R's too, in the background (C1 G18).
     */
    private checkContained(results: readonly SessionResult[]) {
        const registry = shadowRegistry();
        if (!registry || this.blockedValue || this.disposedValue) return;
        const recordedIn = { ...registry.current };
        const scopes = new Set(results.map((result) => result.scope));
        const remotes = new Set<ReadinessRuntime>();
        for (const result of results) {
            const remote = registry.runtimes
                .get(toHexString(result.openNonce))
                ?.deref();
            if (remote instanceof ReadinessRuntime && remote !== this) {
                remotes.add(remote);
            }
        }
        void (async () => {
            await runSessionShadowCheck(this, registry, scopes, recordedIn);
            for (const remote of remotes) {
                await runSessionShadowCheck(
                    remote,
                    registry,
                    scopes,
                    recordedIn
                );
            }
        })().catch(() => {});
    }

    /**
     * The close transition, after its drain and right before
     * `super.close()`: lets the queued replace verifies run once each
     * (bounded, however long remote replaces go on; one still moving faults
     * its tap), runs the K2 shadow check in test mode (the stores are still
     * open, so the index can be scanned), then seals the taps, since the
     * stores close next and an index read from then on could see a closing
     * index. A verify pending at the seal faults its tap, and a start
     * (restore or seed scan) that has not finished by now is not persisted:
     * the next open rebuilds. `program` is the filesystem, for the shadow
     * opt-outs (the one `create` was given by default). A count never
     * verified is compared once more before the seal. The coordinator is
     * gone by now (`block`); no session sink stays on a tap, and the pull
     * joins it aborted have settled before this returns, so none still
     * commits when the stores close. Never throws.
     */
    async prepareClose(
        program: object | undefined = this.program
    ): Promise<void> {
        if (this.disposedValue || this.sealedStart) return;
        this.disposeJoin();
        this.blockedValue = true;
        await this.whenPullsSettled();
        const drain = async () => {
            try {
                await Promise.all(
                    [...this.scopes.values()].map(({ tap }) =>
                        tap.drainVerifies()
                    )
                );
            } catch {
                // drainVerifies does not reject; a failed read faults its tap.
            }
        };
        await drain();
        const registry = shadowRegistry();
        if (registry && !this.disposedValue) {
            await runShadowCheck(this, registry, program).catch(() => {});
            // Arrivals during the check may have queued verifies.
            await drain();
        }
        if (this.disposedValue) return;
        // Only a verified count is persisted.
        await Promise.all(
            [...this.scopes.values()].map(({ tap }) =>
                tap.confirmCount().catch(() => {})
            )
        );
        if (this.disposedValue) return;
        for (const { tap } of this.scopes.values()) tap.seal();
        this.sealedStart = this.starts.get(NAMESPACE_V1.name) ?? {
            kind: "pending",
        };
    }

    /**
     * Call only after `super.close()` returned true: the stores are closed,
     * so no change event can land after the snapshot. Writes the namespace
     * structures (map, cells and the lanes at the same sequence point) when
     * its start finished before `prepareClose`, its count was verified and
     * nothing faulted it, then disposes. The state request keeps the process
     * alive until it answers (S14). Never throws: a failed write logs and
     * leaves no file, and the next open rebuilds.
     */
    async persistAndDispose(): Promise<void> {
        if (this.disposedValue) return;
        this.blockedValue = true;
        try {
            const state = this.scopes.get(SCOPE_NAMESPACE_V1);
            const tap = state?.tap;
            const started = this.sealedStart?.kind;
            if (
                state &&
                tap &&
                this.directory &&
                tap.sealed &&
                tap.state === "live" &&
                tap.faulted === undefined &&
                tap.countVerified &&
                (started === "restored" || started === "scanned")
            ) {
                // One synchronous point: the map, and one request for the
                // lanes and cells of its seq (a worker failure cannot leave
                // one of them unanswered).
                const { seq, state: frozen } = state.laneSet.stateNow("lanes");
                const { count, hlc, epoch, map } = tap;
                if (seq !== epoch) {
                    frozen.catch(() => {});
                    throw new Error(
                        `lane set at ${seq}, tap at epoch ${epoch}`
                    );
                }
                const { cells, lanes } = await frozen;
                const persisted: PersistedScope = {
                    scope: tap.scope.id,
                    count,
                    hlc,
                    epoch,
                    map,
                    cells,
                    lanes,
                };
                await writeStructures(
                    this.directory,
                    this.namespaceStore,
                    tap.scope,
                    encodeStructures(this.address, persisted)
                );
            }
        } catch (error: any) {
            console.warn(
                "shared-fs: readiness state not persisted (the next open rebuilds it):",
                error?.message ?? error
            );
        } finally {
            this.disposeWithoutPersist();
        }
    }

    disposeWithoutPersist() {
        this.disposeJoin();
        this.blockedValue = true;
        this.disposedValue = true;
        const registry = shadowRegistry();
        registry?.live.delete(this);
        const nonce = toHexString(this.openNonce);
        if (registry?.runtimes.get(nonce)?.deref() === this) {
            registry.runtimes.delete(nonce);
        }
        this.responder?.dispose();
        for (const id of [...this.scopes.keys()]) this.disposeScope(id);
        this.trustDocuments = undefined;
    }
}
