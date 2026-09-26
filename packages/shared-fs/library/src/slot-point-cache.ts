/**
 * Internal, retained-memory bounds for exact directory-slot histories.
 *
 * A slot is one `(parentId, name)` pair. The cache holds only the rows of
 * slots that were read with an exact index query, including cached negatives
 * (an empty history). It never represents a complete directory: listings stay
 * in the program's per-directory sweep cache.
 */
export type SlotNamingRow = {
    id: string;
    nodeId: string;
    parentId: string;
    name: string;
    deleted: boolean;
    causalDepth: bigint;
    createdAt: bigint;
    parentNamingIds: string[];
    authorKey?: string;
    machineLabel?: string;
    changesetId?: string;
};

export type SlotPointCacheLimits = {
    /** Slot records plus parent markers; includes cached negatives. */
    maxSlots: number;
    maxRows: number;
    /** Accounting estimate, not an exact V8 heap measurement. */
    maxEstimatedBytes: number;
    /** Distinct active slot queries; other callers wait for capacity. */
    maxInFlight: number;
};

export const DEFAULT_SLOT_POINT_CACHE_LIMITS: SlotPointCacheLimits = {
    maxSlots: 4_096,
    maxRows: 16_384,
    maxEstimatedBytes: 8 * 1024 * 1024,
    maxInFlight: 64,
};

type Parent = {
    kind: "parent";
    parentId: string;
    slots: Map<string, Slot>;
    bytes: number;
};
type Slot = {
    kind: "slot";
    parent: Parent;
    name: string;
    rows: Map<string, SlotNamingRow>;
    bytes: number;
};

const stringBytes = (value: string | undefined) => (value?.length ?? 0) * 2;
const parentBytes = (id: string) => 128 + stringBytes(id);
const slotBytes = (name: string) => 160 + stringBytes(name);
const rowBytes = (row: SlotNamingRow) =>
    // Row/map/reverse-entry overhead plus every retained variable-length
    // field. Shared or interned strings are charged again conservatively.
    352 +
    stringBytes(row.id) +
    stringBytes(row.nodeId) +
    stringBytes(row.parentId) +
    stringBytes(row.name) +
    stringBytes(row.authorKey) +
    stringBytes(row.machineLabel) +
    stringBytes(row.changesetId) +
    row.parentNamingIds.reduce((sum, id) => sum + 32 + stringBytes(id), 0);

/**
 * LRU cache of exact slot histories. Rows leave the cache only by evicting a
 * whole slot, never by editing one: a slot is either absent (unknown) or holds
 * every row the index had for it when it was filled, plus later arrivals.
 */
export class BoundedSlotPointCache {
    readonly limits: Readonly<SlotPointCacheLimits>;
    private parents = new Map<string, Parent>();
    /** Reverse map: row id -> the cached slot that holds it. */
    private placements = new Map<string, Slot>();
    private lru = new Map<Parent | Slot, true>();
    private rows = 0;
    private slots = 0;
    private bytes = 0;
    private fills = new Map<string, Promise<SlotNamingRow[]>>();
    private capacityChanged: Promise<void> | undefined;
    private notifyCapacity: (() => void) | undefined;

    constructor(limits: Partial<SlotPointCacheLimits> = {}) {
        this.limits = { ...DEFAULT_SLOT_POINT_CACHE_LIMITS, ...limits };
        for (const value of Object.values(this.limits)) {
            if (!Number.isSafeInteger(value) || value < 1) {
                throw new RangeError(
                    "slot cache limits must be positive safe integers"
                );
            }
        }
    }

    snapshot() {
        return {
            parents: this.parents.size,
            slots: this.slots,
            entries: this.parents.size + this.slots,
            rows: this.rows,
            estimatedBytes: this.bytes,
            reverse: this.placements.size,
            inFlight: this.fills.size,
        };
    }

    private touch(value: Parent | Slot) {
        this.lru.delete(value);
        this.lru.set(value, true);
    }

    /** The cached history of one slot (`[]` is a cached absence), or undefined. */
    getSlot(parentId: string, name: string): SlotNamingRow[] | undefined {
        const parent = this.parents.get(parentId);
        const slot = parent?.slots.get(name);
        if (!parent || !slot) return undefined;
        this.touch(parent);
        this.touch(slot);
        return [...slot.rows.values()];
    }

    private removeSlot(slot: Slot) {
        slot.parent.slots.delete(slot.name);
        this.lru.delete(slot);
        this.slots--;
        this.rows -= slot.rows.size;
        this.bytes -= slot.bytes;
        for (const id of slot.rows.keys()) {
            if (this.placements.get(id) === slot) this.placements.delete(id);
        }
    }

    evictSlot(parentId: string, name: string) {
        const parent = this.parents.get(parentId);
        const slot = parent?.slots.get(name);
        if (!parent || !slot) return;
        this.removeSlot(slot);
        if (parent.slots.size === 0) this.evictParent(parentId);
    }

    evictParent(parentId: string) {
        const parent = this.parents.get(parentId);
        if (!parent) return;
        for (const slot of parent.slots.values()) this.removeSlot(slot);
        this.parents.delete(parentId);
        this.lru.delete(parent);
        this.bytes -= parent.bytes;
    }

    clear() {
        this.parents.clear();
        this.placements.clear();
        this.lru.clear();
        this.rows = 0;
        this.slots = 0;
        this.bytes = 0;
        // Active queries keep their own lifetime and capacity accounting.
        // The program fences their publication (generation, cache identity,
        // per-directory epoch); a clear alone does not make a snapshot stale.
    }

    private fits(entries: number, rows: number, bytes: number) {
        return (
            entries <= this.limits.maxSlots &&
            rows <= this.limits.maxRows &&
            bytes <= this.limits.maxEstimatedBytes
        );
    }

    /** Whether one slot, with its parent marker, fits in an empty cache. */
    private fitsAlone(parentId: string, rows: number, bytes: number) {
        return this.fits(2, rows, parentBytes(parentId) + bytes);
    }

    private makeRoom(entries: number, rows: number, bytes: number) {
        while (
            !this.fits(
                this.parents.size + this.slots + entries,
                this.rows + rows,
                this.bytes + bytes
            )
        ) {
            const oldest = this.lru.keys().next().value;
            if (!oldest) return;
            if (oldest.kind === "parent") this.evictParent(oldest.parentId);
            else this.evictSlot(oldest.parent.parentId, oldest.name);
        }
    }

    private prepareSlot(name: string, rows: Iterable<SlotNamingRow>) {
        const indexed = new Map<string, SlotNamingRow>();
        let bytes = slotBytes(name);
        for (const row of rows) {
            const prior = indexed.get(row.id);
            if (prior) bytes -= rowBytes(prior);
            indexed.set(row.id, row);
            bytes += rowBytes(row);
        }
        return { name, rows: indexed, bytes };
    }

    /**
     * Evict every other cached slot that still claims one of these row ids.
     * A same-id Documents replacement moves a row between slots; the source
     * slot is dropped whole (one eviction, however long its history), so the
     * next read of it re-queries its exact current history.
     */
    private relocate(
        rows: Iterable<SlotNamingRow>,
        parentId: string,
        name: string
    ) {
        for (const row of rows) {
            const previous = this.placements.get(row.id);
            if (
                previous &&
                (previous.parent.parentId !== parentId ||
                    previous.name !== name)
            ) {
                this.evictSlot(previous.parent.parentId, previous.name);
            }
        }
    }

    private addParent(parentId: string) {
        let parent = this.parents.get(parentId);
        if (!parent) {
            parent = {
                kind: "parent",
                parentId,
                slots: new Map(),
                bytes: parentBytes(parentId),
            };
            this.parents.set(parentId, parent);
            this.bytes += parent.bytes;
        }
        this.touch(parent);
        return parent;
    }

    private addSlot(
        parent: Parent,
        prepared: ReturnType<BoundedSlotPointCache["prepareSlot"]>
    ) {
        const slot: Slot = { kind: "slot", parent, ...prepared };
        parent.slots.set(slot.name, slot);
        this.slots++;
        this.rows += slot.rows.size;
        this.bytes += slot.bytes;
        this.touch(slot);
        for (const id of slot.rows.keys()) this.placements.set(id, slot);
    }

    /**
     * Admit the complete history of one slot from an exact index query.
     * Admission is decided before any mutation: a history that cannot fit
     * even in an empty cache is not retained, and evicts or relocates
     * nothing. Returns whether the history is now cached.
     */
    installSlot(
        parentId: string,
        name: string,
        rows: Iterable<SlotNamingRow>
    ): boolean {
        const prepared = this.prepareSlot(name, rows);
        if (!this.fitsAlone(parentId, prepared.rows.size, prepared.bytes)) {
            return false;
        }
        this.evictSlot(parentId, name);
        this.relocate(prepared.rows.values(), parentId, name);
        const parent = this.parents.get(parentId);
        if (parent) this.touch(parent);
        this.makeRoom(
            parent ? 1 : 2,
            prepared.rows.size,
            prepared.bytes + (parent ? 0 : parentBytes(parentId))
        );
        // Capacity eviction may have removed the destination parent itself.
        if (parent && !this.parents.has(parentId)) {
            this.makeRoom(
                2,
                prepared.rows.size,
                parentBytes(parentId) + prepared.bytes
            );
        }
        this.addSlot(this.addParent(parentId), prepared);
        return true;
    }

    /**
     * Authoritative arrival (a Documents change event or a local write).
     * Keeps every cached slot exact: the row leaves any other slot that held
     * its id and joins its own slot if that slot is cached. An arrival into an
     * unknown slot is ignored — one event does not prove the rest of that
     * slot's history. A cached slot that can no longer fit is dropped.
     */
    applyAdded(row: SlotNamingRow) {
        this.relocate([row], row.parentId, row.name);
        const parent = this.parents.get(row.parentId);
        const slot = parent?.slots.get(row.name);
        if (!parent || !slot) return;
        const prior = slot.rows.get(row.id);
        const rowDelta = prior ? 0 : 1;
        const byteDelta = rowBytes(row) - (prior ? rowBytes(prior) : 0);
        if (
            !this.fitsAlone(
                row.parentId,
                slot.rows.size + rowDelta,
                slot.bytes + byteDelta
            )
        ) {
            this.evictSlot(row.parentId, row.name);
            return;
        }
        slot.rows.set(row.id, row);
        slot.bytes += byteDelta;
        this.rows += rowDelta;
        this.bytes += byteDelta;
        this.placements.set(row.id, slot);
        this.touch(parent);
        this.touch(slot);
        // The grown slot is the most recent entry and fits alone, so this
        // evicts only older entries.
        this.makeRoom(0, 0, 0);
    }

    /** Authoritative removal (GC): drop every slot that may hold the row. */
    applyRemoved(row: SlotNamingRow) {
        const previous = this.placements.get(row.id);
        if (previous) this.evictSlot(previous.parent.parentId, previous.name);
        this.evictSlot(row.parentId, row.name);
    }

    /**
     * Single-flight for identical slot queries. `stamp` must change whenever
     * a caller could observe a newer snapshot than an active query, so a
     * later caller never joins a pre-event result.
     */
    async runSlotFill(
        parentId: string,
        name: string,
        stamp: string,
        fill: () => Promise<SlotNamingRow[]>
    ) {
        const key = JSON.stringify([parentId, name, stamp]);
        for (;;) {
            const existing = this.fills.get(key);
            if (existing) return existing;
            if (this.fills.size < this.limits.maxInFlight) break;
            this.capacityChanged ??= new Promise<void>((resolve) => {
                this.notifyCapacity = resolve;
            });
            await this.capacityChanged;
        }
        const promise: Promise<SlotNamingRow[]> = Promise.resolve()
            .then(fill)
            .finally(() => {
                if (this.fills.get(key) === promise) this.fills.delete(key);
                const notify = this.notifyCapacity;
                this.capacityChanged = undefined;
                this.notifyCapacity = undefined;
                notify?.();
            });
        this.fills.set(key, promise);
        return promise;
    }
}
