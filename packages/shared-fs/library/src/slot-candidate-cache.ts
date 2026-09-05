/** Internal, retained-memory bounds for exact naming-history caches. */
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

export type SlotCandidateCacheLimits = {
    /** Slot records plus parent markers; includes cached negatives. */
    maxSlots: number;
    maxRows: number;
    /** Accounting estimate, not an exact V8 heap measurement. */
    maxEstimatedBytes: number;
    /** Distinct active slot queries; other callers wait for capacity. */
    maxInFlight: number;
};

export const DEFAULT_SLOT_CANDIDATE_CACHE_LIMITS: SlotCandidateCacheLimits = {
    maxSlots: 4_096,
    maxRows: 16_384,
    maxEstimatedBytes: 8 * 1024 * 1024,
    maxInFlight: 64,
};

type Parent = {
    kind: "parent";
    parentId: string;
    complete: boolean;
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

export class BoundedSlotCandidateCache {
    readonly limits: Readonly<SlotCandidateCacheLimits>;
    /** Invalidates fills when eviction/clear changes cache ownership. */
    revision = 0;
    private parents = new Map<string, Parent>();
    private placements = new Map<string, Slot>();
    private lru = new Map<Parent | Slot, true>();
    private rows = 0;
    private slots = 0;
    private bytes = 0;
    private fills = new Map<string, Promise<SlotNamingRow[]>>();
    private capacityChanged: Promise<void> | undefined;
    private notifyCapacity: (() => void) | undefined;

    constructor(limits: Partial<SlotCandidateCacheLimits> = {}) {
        this.limits = { ...DEFAULT_SLOT_CANDIDATE_CACHE_LIMITS, ...limits };
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
            completeParents: [...this.parents.values()].filter(
                (p) => p.complete
            ).length,
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

    getSlot(parentId: string, name: string): SlotNamingRow[] | undefined {
        const parent = this.parents.get(parentId);
        if (!parent) return undefined;
        const slot = parent.slots.get(name);
        if (!slot && !parent.complete) return undefined;
        this.touch(parent);
        if (slot) this.touch(slot);
        return slot ? [...slot.rows.values()] : [];
    }

    getSweep(parentId: string): SlotNamingRow[] | undefined {
        const parent = this.parents.get(parentId);
        if (!parent?.complete) return undefined;
        this.touch(parent);
        const result: SlotNamingRow[] = [];
        for (const slot of parent.slots.values()) {
            this.touch(slot);
            for (const row of slot.rows.values()) result.push(row);
        }
        return result;
    }

    private removeSlot(slot: Slot) {
        slot.parent.slots.delete(slot.name);
        slot.parent.complete = false;
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
        this.revision++;
        this.removeSlot(slot);
        if (parent.slots.size === 0) this.evictParent(parentId);
    }

    evictParent(parentId: string) {
        const parent = this.parents.get(parentId);
        if (!parent) return;
        this.revision++;
        for (const slot of parent.slots.values()) this.removeSlot(slot);
        this.parents.delete(parentId);
        this.lru.delete(parent);
        this.bytes -= parent.bytes;
    }

    clear() {
        this.revision++;
        this.parents.clear();
        this.placements.clear();
        this.lru.clear();
        this.rows = 0;
        this.slots = 0;
        this.bytes = 0;
        // Active queries retain their own lifetime and capacity accounting.
        // Their captured revision prevents publication after this clear.
    }

    private fits(entries: number, rows: number, bytes: number) {
        return (
            entries <= this.limits.maxSlots &&
            rows <= this.limits.maxRows &&
            bytes <= this.limits.maxEstimatedBytes
        );
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
                // One eviction invalidates the complete source history and
                // all its reverse entries. Repeated moves from a long source
                // history do not repeatedly filter a shrinking array.
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
                complete: false,
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
        prepared: ReturnType<BoundedSlotCandidateCache["prepareSlot"]>
    ) {
        const slot: Slot = { kind: "slot", parent, ...prepared };
        parent.slots.set(slot.name, slot);
        this.slots++;
        this.rows += slot.rows.size;
        this.bytes += slot.bytes;
        this.touch(slot);
        for (const id of slot.rows.keys()) this.placements.set(id, slot);
    }

    installSlot(parentId: string, name: string, rows: Iterable<SlotNamingRow>) {
        const prepared = this.prepareSlot(name, rows);
        this.evictSlot(parentId, name);
        this.relocate(prepared.rows.values(), parentId, name);
        if (
            !this.fits(
                2,
                prepared.rows.size,
                parentBytes(parentId) + prepared.bytes
            )
        ) {
            const parent = this.parents.get(parentId);
            if (parent?.complete) {
                parent.complete = false;
                this.revision++;
                if (parent.slots.size === 0) this.evictParent(parentId);
            }
            return false;
        }
        const hadParent = this.parents.has(parentId);
        this.makeRoom(
            hadParent ? 1 : 2,
            prepared.rows.size,
            prepared.bytes + (hadParent ? 0 : parentBytes(parentId))
        );
        // Capacity eviction may remove the destination parent itself.
        if (!this.parents.has(parentId))
            this.makeRoom(
                2,
                prepared.rows.size,
                parentBytes(parentId) + prepared.bytes
            );
        this.addSlot(this.addParent(parentId), prepared);
        return true;
    }

    installSweep(
        parentId: string,
        groups: Iterable<[string, Iterable<SlotNamingRow>]>
    ) {
        const prepared = [...groups].map(([name, rows]) =>
            this.prepareSlot(name, rows)
        );
        const rows = prepared.reduce((sum, slot) => sum + slot.rows.size, 0);
        const bytes =
            parentBytes(parentId) +
            prepared.reduce((sum, slot) => sum + slot.bytes, 0);
        this.evictParent(parentId);
        for (const slot of prepared)
            this.relocate(slot.rows.values(), parentId, slot.name);
        if (!this.fits(1 + prepared.length, rows, bytes)) return false;
        this.makeRoom(1 + prepared.length, rows, bytes);
        const parent = this.addParent(parentId);
        for (const slot of prepared) this.addSlot(parent, slot);
        parent.complete = true;
        return true;
    }

    applyAdded(row: SlotNamingRow) {
        this.relocate([row], row.parentId, row.name);
        const parent = this.parents.get(row.parentId);
        const slot = parent?.slots.get(row.name);
        // One arriving event is not proof that an unknown slot has no other
        // history. A cached negative or complete directory is such proof.
        if (!slot && !parent?.complete) return;
        const wasComplete = parent!.complete;
        const expectedSlots = parent!.slots.size + (slot ? 0 : 1);
        const rows = new Map(slot?.rows);
        rows.set(row.id, row);
        if (
            this.installSlot(row.parentId, row.name, rows.values()) &&
            wasComplete
        ) {
            // Restoring completeness is valid only if capacity work retained
            // every other slot of that complete parent.
            const current = this.parents.get(row.parentId)!;
            if (current === parent && current.slots.size === expectedSlots)
                current.complete = true;
        }
    }

    applyRemoved(row: SlotNamingRow) {
        const previous = this.placements.get(row.id);
        if (previous) this.evictSlot(previous.parent.parentId, previous.name);
        this.evictSlot(row.parentId, row.name);
        // A complete empty parent has no slot record to evict, but removal
        // still invalidates its completeness conservatively.
        const parent = this.parents.get(row.parentId);
        if (parent?.complete) {
            parent.complete = false;
            this.revision++;
        }
    }

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
