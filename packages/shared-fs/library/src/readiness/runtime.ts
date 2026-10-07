import { randomBytes, sha256Sync } from "@peerbit/crypto";
import type { PublicSignKey } from "@peerbit/crypto";
import type { DocumentsLike } from "@peerbit/document";
import { AnchorHost, type LaneSet } from "./anchor-host.js";
import { cellKey } from "./cells.js";
import { M } from "./constants.js";
import {
    encodeStructures,
    takeStructures,
    writeStructures,
    type DecodeResult,
    type PersistedScope,
} from "./persist.js";
import {
    Responder,
    type ResponderPorts,
    type ResponderScope,
} from "./responder.js";
import {
    NAMESPACE_V1,
    SCOPE_NAMESPACE_V1,
    SCOPE_TRUST_V1,
    TRUST_V1,
    type ScopeDescriptor,
    type ScopeId,
} from "./scopes.js";
import { runShadowCheck, shadowRegistry } from "./shadow.js";
import { ScopeTap, documentsIndexPort } from "./tap.js";
import {
    LOG_ID_BYTES,
    OPEN_NONCE_BYTES,
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
 * object; nothing here reads the program after close. In shadow mode it
 * maintains the structures and answers on every peer but decides nothing.
 */
export class ReadinessRuntime {
    readonly openNonce: Uint8Array = randomBytes(OPEN_NONCE_BYTES);
    readonly starts = new Map<ScopeDescriptor["name"], ScopeStart>();
    readonly responder?: Responder;
    private readonly scopes = new Map<ScopeId, ScopeState>();
    readonly cellKey: [number, number];
    private blockedValue = false;
    private disposedValue = false;
    private readonly seeding: Promise<void>[] = [];
    /** The namespace start as it stood when `prepareClose` sealed the taps. */
    private sealedStart?: ScopeStart;
    /** Messages received while this generation was live (diagnostics). */
    messagesReceived = 0;

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
        ports: ResponderPorts | undefined,
        taking: Promise<DecodeResult | undefined>,
        readonly unavailable?: string
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
            unavailable
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

    /** Synchronous: a close or reopen began; answer nothing from now on. */
    block() {
        this.blockedValue = true;
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
        this.starts.set(descriptor.name, { kind: "pending" });
        return { state, settle };
    }

    private readonly settlers = new Map<ScopeId, () => void>();

    private disposeScope(id: ScopeId) {
        const state = this.scopes.get(id);
        if (!state) return;
        this.scopes.delete(id);
        state.tap.dispose();
        state.laneSet.close();
        this.settlers.get(id)?.();
        this.settlers.delete(id);
    }

    /** Attach before `entries.open()`, so events during open are buffered. */
    attachNamespace(entries: DocumentsLike<any, any>) {
        if (this.disposedValue) return;
        const created = this.createScope(NAMESPACE_V1, entries);
        if (created) this.settlers.set(SCOPE_NAMESPACE_V1, created.settle);
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
                // unverified until a quiet point (`ScopeTap.checkCount`),
                // and unverified, it is not persisted.
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

    /** The readiness RPC handler. Never throws. */
    onMessage(message: ReadinessMessage, from: PublicSignKey | undefined) {
        if (this.disposedValue || this.blockedValue) return;
        this.messagesReceived++;
        this.responder?.onMessage(message, from);
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
     * opt-outs. A count check still waiting for a quiet point compares once
     * more before the seal. Never throws.
     */
    async prepareClose(program?: object): Promise<void> {
        if (this.disposedValue || this.sealedStart) return;
        this.blockedValue = true;
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
     * nothing faulted it, then disposes. The lanes request keeps the process
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
                // One synchronous point: the map and the lanes and cells
                // requests (answered for the same seq).
                const { seq, lanes } = state.laneSet.lanesNow();
                const { cells } = state.laneSet.cellsNow();
                const both = Promise.all([lanes, cells]);
                const { count, hlc, epoch, map } = tap;
                if (seq !== epoch) {
                    both.catch(() => {});
                    throw new Error(
                        `lane set at ${seq}, tap at epoch ${epoch}`
                    );
                }
                const [laneBytes, cellBytes] = await both;
                const persisted: PersistedScope = {
                    scope: tap.scope.id,
                    count,
                    hlc,
                    epoch,
                    map,
                    cells: cellBytes,
                    lanes: laneBytes,
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
        this.blockedValue = true;
        this.disposedValue = true;
        shadowRegistry()?.live.delete(this);
        this.responder?.dispose();
        for (const id of [...this.scopes.keys()]) this.disposeScope(id);
        this.trustDocuments = undefined;
    }
}
