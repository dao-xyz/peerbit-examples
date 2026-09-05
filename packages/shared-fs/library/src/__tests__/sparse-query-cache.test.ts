import { describe, expect, it } from "vitest";
import { SparseReadCache } from "./sparse-query-cache.js";

describe("test-only sparse query byte cache", () => {
    it("evicts by recency on both reads and replacements", () => {
        const cache = new SparseReadCache({ maxBytes: 100, maxEntries: 2 });
        cache.set("a", new Uint8Array([1]));
        cache.set("b", new Uint8Array([2]));
        expect(cache.get("a")).toEqual(new Uint8Array([1]));
        cache.set("c", new Uint8Array([3]));
        expect(cache.get("b")).toBeUndefined();
        cache.set("a", new Uint8Array([4]));
        cache.set("d", new Uint8Array([5]));
        expect(cache.get("c")).toBeUndefined();
        expect(cache.get("a")).toEqual(new Uint8Array([4]));
        expect(cache.get("d")).toEqual(new Uint8Array([5]));
        expect(cache.stats()).toEqual({ entries: 2, bytes: 2, evictions: 2 });
    });

    it("enforces the byte bound independently of the entry bound", () => {
        const cache = new SparseReadCache({ maxBytes: 5, maxEntries: 100 });
        cache.set("a", new Uint8Array(2));
        cache.set("b", new Uint8Array(2));
        cache.set("c", new Uint8Array(5));
        expect(cache.get("a")).toBeUndefined();
        expect(cache.get("b")).toBeUndefined();
        expect(cache.get("c")).toHaveLength(5);
        expect(cache.stats()).toEqual({ entries: 1, bytes: 5, evictions: 2 });
    });

    it("owns inserted and returned bytes, including Buffer subviews", () => {
        const cache = new SparseReadCache({ maxBytes: 10, maxEntries: 4 });
        const backing = Buffer.from([9, 1, 2, 9]);
        const input = backing.subarray(1, 3);
        cache.set("buffer", input);
        backing.fill(7);
        const first = cache.get("buffer")!;
        expect(first).toEqual(new Uint8Array([1, 2]));
        first.fill(8);
        expect(cache.get("buffer")).toEqual(new Uint8Array([1, 2]));
        const ordinary = new Uint8Array([3, 4]);
        cache.set("array", ordinary);
        ordinary.fill(0);
        expect(cache.get("array")).toEqual(new Uint8Array([3, 4]));
        expect(cache.stats()).toEqual({ entries: 2, bytes: 4, evictions: 0 });
    });

    it("reaccounts growing and shrinking replacements without stale bytes", () => {
        const cache = new SparseReadCache({ maxBytes: 6, maxEntries: 3 });
        cache.set("a", new Uint8Array(2));
        cache.set("b", new Uint8Array(2));
        cache.set("a", new Uint8Array(1));
        expect(cache.stats()).toEqual({ entries: 2, bytes: 3, evictions: 0 });
        cache.set("a", new Uint8Array(5));
        expect(cache.get("b")).toBeUndefined();
        expect(cache.stats()).toEqual({ entries: 1, bytes: 5, evictions: 1 });
        cache.set("a", new Uint8Array(0));
        expect(cache.get("a")).toEqual(new Uint8Array(0));
        expect(cache.stats()).toEqual({ entries: 1, bytes: 0, evictions: 1 });
    });

    it("drops oversized replacements but leaves unrelated retained values", () => {
        const cache = new SparseReadCache({ maxBytes: 4, maxEntries: 2 });
        cache.set("a", new Uint8Array([1]));
        cache.set("b", new Uint8Array([2]));
        cache.set("missing", new Uint8Array(5));
        expect(cache.stats()).toEqual({ entries: 2, bytes: 2, evictions: 0 });
        cache.set("a", new Uint8Array(5));
        expect(cache.get("a")).toBeUndefined();
        expect(cache.get("b")).toEqual(new Uint8Array([2]));
        expect(cache.stats()).toEqual({ entries: 1, bytes: 1, evictions: 1 });
    });

    it("bounds zero-length values by count and returns detached stats", () => {
        const cache = new SparseReadCache({ maxBytes: 1, maxEntries: 2 });
        cache.set("a", new Uint8Array(0));
        cache.set("b", new Uint8Array(0));
        cache.set("c", new Uint8Array(0));
        expect(cache.get("a")).toBeUndefined();
        const stats = cache.stats();
        stats.bytes = 100;
        stats.evictions = 100;
        expect(cache.stats()).toEqual({ entries: 2, bytes: 0, evictions: 1 });
        cache.clear();
        expect(cache.get("b")).toBeUndefined();
        expect(cache.stats()).toEqual({ entries: 0, bytes: 0, evictions: 1 });
        cache.set("new", new Uint8Array([4]));
        expect(cache.get("new")).toEqual(new Uint8Array([4]));
    });

    it.each([
        { maxBytes: 0, maxEntries: 2 },
        { maxBytes: 2, maxEntries: 0 },
        { maxBytes: 0, maxEntries: 0 },
    ])("disables retention for a zero budget: %j", (options) => {
        const cache = new SparseReadCache(options);
        cache.set("empty", new Uint8Array(0));
        cache.set("value", new Uint8Array([1]));
        expect(cache.get("empty")).toBeUndefined();
        expect(cache.get("value")).toBeUndefined();
        expect(cache.stats()).toEqual({ entries: 0, bytes: 0, evictions: 0 });
    });

    it("rejects invalid or missing budgets", () => {
        for (const invalid of [
            -1,
            1.5,
            NaN,
            Infinity,
            Number.MAX_SAFE_INTEGER + 1,
        ]) {
            expect(
                () => new SparseReadCache({ maxBytes: invalid, maxEntries: 1 })
            ).toThrow(RangeError);
            expect(
                () => new SparseReadCache({ maxBytes: 1, maxEntries: invalid })
            ).toThrow(RangeError);
        }
        expect(() => new SparseReadCache({} as never)).toThrow(RangeError);
    });

    it("matches an independent LRU oracle during a long bounded scan", () => {
        const cache = new SparseReadCache({ maxBytes: 73, maxEntries: 11 });
        const oracle: Array<{ id: string; bytes: Uint8Array }> = [];
        let evictions = 0;
        for (let i = 0; i < 10_000; i++) {
            const id = `file-${i % 43}`;
            const bytes = new Uint8Array(i % 97).fill(i % 251);
            const previous = oracle.findIndex((item) => item.id === id);
            if (previous !== -1) {
                oracle.splice(previous, 1);
                if (bytes.length > 73) evictions++;
            }
            if (bytes.length <= 73) {
                while (
                    oracle.length >= 11 ||
                    oracle.reduce((sum, item) => sum + item.bytes.length, 0) +
                        bytes.length >
                        73
                ) {
                    oracle.shift();
                    evictions++;
                }
                oracle.push({ id, bytes });
            }
            cache.set(id, bytes);
            const probe = `file-${(i * 17) % 43}`;
            const hit = oracle.findIndex((item) => item.id === probe);
            const expected = hit === -1 ? undefined : oracle.splice(hit, 1)[0];
            if (expected) oracle.push(expected);
            expect(cache.get(probe)).toEqual(expected?.bytes);
            const stats = cache.stats();
            expect(stats).toEqual({
                entries: oracle.length,
                bytes: oracle.reduce((sum, item) => sum + item.bytes.length, 0),
                evictions,
            });
            expect(stats.entries).toBeLessThanOrEqual(11);
            expect(stats.bytes).toBeLessThanOrEqual(73);
        }
    });
});
