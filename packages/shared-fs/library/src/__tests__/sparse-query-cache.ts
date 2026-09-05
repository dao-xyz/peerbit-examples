/**
 * Test-only cache of owned query-result bytes, not a persistent block store.
 * The byte bound counts payloads; the entry bound limits Map/key bookkeeping.
 */
export class SparseReadCache {
    private readonly maxBytes: number;
    private readonly maxEntries: number;
    private readonly values = new Map<string, Uint8Array>();
    private bytes = 0;
    private evictions = 0;

    constructor(options: { maxBytes: number; maxEntries: number }) {
        for (const name of ["maxBytes", "maxEntries"] as const) {
            const value = options[name];
            if (!Number.isSafeInteger(value) || value < 0) {
                throw new RangeError(
                    `${name} must be a nonnegative safe integer`
                );
            }
        }
        this.maxBytes = options.maxBytes;
        this.maxEntries = options.maxEntries;
    }

    get(id: string): Uint8Array | undefined {
        const value = this.values.get(id);
        if (value === undefined) return undefined;
        this.values.delete(id);
        this.values.set(id, value);
        return new Uint8Array(value);
    }

    set(id: string, value: Uint8Array): void {
        const existing = this.values.get(id);
        if (
            this.maxBytes === 0 ||
            this.maxEntries === 0 ||
            value.byteLength > this.maxBytes
        ) {
            // A newer uncacheable result must not leave its older bytes warm.
            if (existing !== undefined) this.evict(id, existing);
            return;
        }
        // Own the bytes before changing the retained cache. This copies Buffer
        // values too; Buffer.slice() would retain a shared mutable view.
        const owned = new Uint8Array(value);
        if (existing !== undefined) {
            this.values.delete(id);
            this.bytes -= existing.byteLength;
        }
        while (
            this.values.size >= this.maxEntries ||
            this.bytes > this.maxBytes - owned.byteLength
        ) {
            const oldest = this.values.entries().next().value!;
            this.evict(oldest[0], oldest[1]);
        }
        this.values.set(id, owned);
        this.bytes += owned.byteLength;
    }

    clear(): void {
        this.values.clear();
        this.bytes = 0;
    }

    stats(): { entries: number; bytes: number; evictions: number } {
        return {
            entries: this.values.size,
            bytes: this.bytes,
            // Cumulative capacity/admission removals, not clear/replacements.
            evictions: this.evictions,
        };
    }

    private evict(id: string, value: Uint8Array): void {
        this.values.delete(id);
        this.bytes -= value.byteLength;
        this.evictions++;
    }
}
