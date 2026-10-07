import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IdHeadMap, sipHash24 } from "../readiness/id-map.js";

/** A deterministic 32-byte head for test row `n` at version `v`. */
const headOf = (n: number, v = 0) => {
    const out = new Uint8Array(32);
    const view = new DataView(out.buffer);
    view.setUint32(0, n, true);
    view.setUint32(4, v, true);
    out[31] = 0xa5;
    return out;
};

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** Live contents as id-independent `head hex -> modified`. */
const contents = (map: IdHeadMap) => {
    const out = new Map<string, bigint>();
    map.forEach((head, modified) => out.set(hex(head), modified));
    return out;
};

/** Seeded xorshift32, so a failing sequence reproduces. */
const prng = (seed: number) => {
    let x = seed >>> 0 || 1;
    return (n: number) => {
        x ^= x << 13;
        x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        return x % n;
    };
};

describe("readiness id map", () => {
    it("computes SipHash-2-4 (reference vectors)", () => {
        // Aumasson and Bernstein's vectors: key 00..0f, message 00..(n-1).
        const key = new Uint32Array(
            new Uint8Array(Array.from({ length: 16 }, (_, i) => i)).buffer
        );
        const vectors: Array<[number, bigint]> = [
            [0, 0x726fdb47dd0e0e31n],
            [1, 0x74f839c593dc67fdn],
            [2, 0x0d6c8009d9a94f5an],
            [3, 0x85676696d7fb7e2dn],
            [7, 0xab0200f58b01d137n],
            [8, 0x93f5f5799a932462n],
            [9, 0x9e0082df0ba9e4b0n],
            [15, 0xa129ca6149be45e5n],
            [16, 0x3f2acc7f57c29bdbn],
            [31, 0x32d892fad841c342n],
            [63, 0x958a324ceb064572n],
        ];
        const out = new Uint32Array(2);
        for (const [n, expected] of vectors) {
            const message = new Uint8Array(
                Array.from({ length: n }, (_, i) => i)
            );
            sipHash24(key, message, n, out);
            expect((BigInt(out[1]) << 32n) | BigInt(out[0])).toBe(expected);
        }
    });

    it("sets, replaces, deletes and grows like a Map", () => {
        const map = new IdHeadMap();
        const model = new Map<string, { head: Uint8Array; modified: bigint }>();
        const next = prng(0x5eed);
        let version = 0;
        for (let step = 0; step < 40_000; step++) {
            const id = `naming:${next(6_000)}`;
            const op = next(10);
            if (op < 6) {
                const head = headOf(step, ++version);
                const modified = BigInt(next(1_000_000));
                const result = map.set(id, head, modified);
                const before = model.get(id);
                expect(result.prev && hex(result.prev)).toBe(
                    before && hex(before.head)
                );
                expect(result.prevModified).toBe(before?.modified);
                model.set(id, { head, modified });
            } else {
                const result = map.delete(id);
                const before = model.get(id);
                expect(result.prev && hex(result.prev)).toBe(
                    before && hex(before.head)
                );
                model.delete(id);
            }
            expect(map.size).toBe(model.size);
        }
        expect(map.size).toBeGreaterThan(1_000);
        for (let n = 0; n < 6_000; n++) {
            const id = `naming:${n}`;
            const slot = map.get(id);
            const row = model.get(id);
            if (!row) {
                expect(slot).toBe(-1);
                continue;
            }
            expect(hex(map.head(slot))).toBe(hex(row.head));
            expect(map.modified(slot)).toBe(row.modified);
        }
        expect(contents(map)).toEqual(
            new Map(
                [...model.values()].map((row) => [hex(row.head), row.modified])
            )
        );
        // Deleting everything in a random order keeps every remaining key
        // reachable (backward-shift deletion leaves no probe holes).
        const ids = [...model.keys()];
        for (let i = ids.length - 1; i > 0; i--) {
            const j = next(i + 1);
            [ids[i], ids[j]] = [ids[j], ids[i]];
        }
        for (let i = 0; i < ids.length; i++) {
            expect(map.delete(ids[i]).prev).toBeDefined();
            if (i % 97 === 0) {
                for (let k = i + 1; k < ids.length; k++) {
                    expect(map.get(ids[k])).toBeGreaterThanOrEqual(0);
                }
            }
        }
        expect(map.size).toBe(0);
        expect(map.delete("naming:0")).toEqual({});
    });

    it("keys by bytes and by any string, and keeps modified exact", () => {
        const map = new IdHeadMap();
        const big = 2n ** 63n + 12_345n; // far above 2^53: a Float64 would round
        const bytesId = Uint8Array.of(1, 2, 3, 4);
        const long = "x".repeat(10_000);
        map.set(bytesId, headOf(1), big);
        map.set("snowman ☃ and 😀", headOf(2), 1n);
        map.set(long, headOf(3), 2n);
        expect(map.modified(map.get(Uint8Array.of(1, 2, 3, 4)))).toBe(big);
        expect(map.get(Uint8Array.of(1, 2, 3, 5))).toBe(-1);
        expect(hex(map.head(map.get("snowman ☃ and 😀")))).toBe(hex(headOf(2)));
        expect(map.get("snowman ☃ and 😁")).toBe(-1);
        expect(hex(map.head(map.get(long)))).toBe(hex(headOf(3)));
        expect(map.get(long + "x")).toBe(-1);
        expect(() => map.set("short", new Uint8Array(31), 0n)).toThrow();
    });

    it("hashes a string id as its UTF-8 bytes", () => {
        const map = new IdHeadMap();
        for (const id of [
            "",
            "naming:Z9_-",
            "file-version:" + "q".repeat(57),
            "snowman ☃ and 😀",
            "é",
        ]) {
            expect(map.hashOf(id)).toEqual(
                map.hashOf(new TextEncoder().encode(id))
            );
        }
    });

    it("puts and removes without allocating, copying the replaced head", () => {
        const map = new IdHeadMap();
        const prev = new Uint8Array(32);
        const head = headOf(1);
        expect(map.put("naming:a", head, 7n, prev)).toBe(false);
        head.fill(0); // the map keeps its own copy
        const slot = map.get("naming:a");
        expect(map.headEquals(slot, headOf(1))).toBe(true);
        expect(map.headEquals(slot, headOf(2))).toBe(false);
        expect(map.put("naming:a", headOf(2), 8n, prev)).toBe(true);
        expect(hex(prev)).toBe(hex(headOf(1)));
        expect(map.modified(map.get("naming:a"))).toBe(8n);
        expect(map.remove("naming:b", prev)).toBe(false);
        expect(map.remove("naming:a", prev)).toBe(true);
        expect(hex(prev)).toBe(hex(headOf(2)));
        expect(map.size).toBe(0);
    });

    it("counts and visits the rows above an hlc", () => {
        const map = new IdHeadMap();
        for (let n = 0; n < 100; n++) {
            map.set(`file-version:${n}`, headOf(n), BigInt(n) * 1_000_000n);
        }
        const seen: string[] = [];
        expect(
            map.forEachAbove(89_000_000n, (head) => seen.push(hex(head)))
        ).toBe(10);
        expect(new Set(seen)).toEqual(
            new Set(Array.from({ length: 10 }, (_, i) => hex(headOf(90 + i))))
        );
        expect(map.forEachAbove(99_000_000n)).toBe(0);
        expect(map.forEachAbove(0n)).toBe(99);
    });

    it("serializes and restores the same contents under the same seed", () => {
        const map = new IdHeadMap();
        for (let n = 0; n < 5_000; n++) {
            map.set(
                `naming:${n}`,
                headOf(n),
                1_800_000_000_000_000_000n + BigInt(n)
            );
        }
        for (let n = 0; n < 5_000; n += 3) map.delete(`naming:${n}`);
        const bytes = map.serialize();
        expect(bytes.length).toBe(16 + 4 + map.size * 48);
        const restored = IdHeadMap.restore(bytes);
        expect(hex(restored.seed)).toBe(hex(map.seed));
        expect(restored.size).toBe(map.size);
        expect(contents(restored)).toEqual(contents(map));
        for (let n = 0; n < 5_000; n++) {
            const id = `naming:${n}`;
            expect(restored.hashOf(id)).toEqual(map.hashOf(id));
            const slot = restored.get(id);
            expect(slot < 0).toBe(n % 3 === 0);
            if (slot >= 0)
                expect(hex(restored.head(slot))).toBe(hex(headOf(n)));
        }
        // The restored map keeps working: replace, delete, grow.
        restored.set("naming:1", headOf(1, 9), 5n);
        restored.delete("naming:2");
        for (let n = 5_000; n < 12_000; n++)
            restored.set(`naming:${n}`, headOf(n), 0n);
        expect(restored.size).toBe(map.size - 1 + 7_000);
        expect(hex(restored.head(restored.get("naming:1")))).toBe(
            hex(headOf(1, 9))
        );
        expect(IdHeadMap.restore(new IdHeadMap().serialize()).size).toBe(0);
    });

    it("rejects malformed serialized maps", () => {
        const map = new IdHeadMap();
        map.set("a", headOf(1), 1n);
        map.set("b", headOf(2), 2n);
        const bytes = map.serialize();
        expect(() => IdHeadMap.restore(bytes.subarray(0, 10))).toThrow(
            /truncated/
        );
        expect(() =>
            IdHeadMap.restore(bytes.subarray(0, bytes.length - 1))
        ).toThrow(/length/);
        const longer = new Uint8Array(bytes.length + 48);
        longer.set(bytes);
        expect(() => IdHeadMap.restore(longer)).toThrow(/length/);
        const duplicate = bytes.slice();
        duplicate.copyWithin(20 + 8, 20, 28); // second key := first key
        expect(() => IdHeadMap.restore(duplicate)).toThrow(/duplicate/);
    });

    it("hashes ids under a per-map seed", () => {
        const a = new IdHeadMap(randomBytes(16));
        const b = new IdHeadMap(randomBytes(16));
        const same = new IdHeadMap(a.seed);
        let differs = 0;
        for (let n = 0; n < 64; n++) {
            const id = `naming:${n}`;
            if (a.hashOf(id).join() !== b.hashOf(id).join()) differs++;
            expect(same.hashOf(id)).toEqual(a.hashOf(id));
        }
        expect(differs).toBe(64);
        // Same contents under either seed.
        for (const map of [a, b]) {
            for (let n = 0; n < 1_000; n++)
                map.set(`naming:${n}`, headOf(n), BigInt(n));
            for (let n = 0; n < 1_000; n += 2) map.delete(`naming:${n}`);
        }
        expect(contents(a)).toEqual(contents(b));
        expect(() => new IdHeadMap(new Uint8Array(15))).toThrow();
    });
});
