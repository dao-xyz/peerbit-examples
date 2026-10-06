import { randomBytes } from "@peerbit/crypto";
import { DIGEST_BYTES } from "./constants.js";

/**
 * Document id -> current head, so a replace (which Documents reports as a
 * bare `added`) can subtract the head it replaced. Compact form: open
 * addressing on a keyed 64-bit hash of the id, plus dense slot columns
 * (32-byte heads and exact u64 `__context.modified`). About 56-64 B per
 * row, against 175-243 B for a `Map<string, string>` (M0 P4).
 *
 * The hash is SipHash-2-4 under a 16-byte seed drawn per open and kept only
 * in the local structures file (M1 plan deviation d). Ids are writer
 * chosen; with a public or seed-independent hash a writer could grind two
 * ids onto one key, and the maintained set would then lose a row the index
 * holds. Only the hash is stored, never the id.
 */

export type IdKey = string | Uint8Array;

const textEncoder = new TextEncoder();
let scratch = new Uint8Array(256);

// SipHash state as 32-bit halves: v0..v3 low and high words.
const V = new Uint32Array(8);
const OUT = new Uint32Array(2);

const sipRound = () => {
    let v0l = V[0],
        v0h = V[1],
        v1l = V[2],
        v1h = V[3],
        v2l = V[4],
        v2h = V[5],
        v3l = V[6],
        v3h = V[7],
        lo: number,
        hi: number;
    // v0 += v1; v1 = rotl(v1, 13); v1 ^= v0; v0 = rotl(v0, 32)
    lo = (v0l + v1l) >>> 0;
    v0h = (v0h + v1h + (lo < v0l ? 1 : 0)) >>> 0;
    v0l = lo;
    lo = (v1l << 13) | (v1h >>> 19);
    hi = (v1h << 13) | (v1l >>> 19);
    v1l = (lo ^ v0l) >>> 0;
    v1h = (hi ^ v0h) >>> 0;
    lo = v0l;
    v0l = v0h;
    v0h = lo;
    // v2 += v3; v3 = rotl(v3, 16); v3 ^= v2
    lo = (v2l + v3l) >>> 0;
    v2h = (v2h + v3h + (lo < v2l ? 1 : 0)) >>> 0;
    v2l = lo;
    lo = (v3l << 16) | (v3h >>> 16);
    hi = (v3h << 16) | (v3l >>> 16);
    v3l = (lo ^ v2l) >>> 0;
    v3h = (hi ^ v2h) >>> 0;
    // v0 += v3; v3 = rotl(v3, 21); v3 ^= v0
    lo = (v0l + v3l) >>> 0;
    v0h = (v0h + v3h + (lo < v0l ? 1 : 0)) >>> 0;
    v0l = lo;
    lo = (v3l << 21) | (v3h >>> 11);
    hi = (v3h << 21) | (v3l >>> 11);
    v3l = (lo ^ v0l) >>> 0;
    v3h = (hi ^ v0h) >>> 0;
    // v2 += v1; v1 = rotl(v1, 17); v1 ^= v2; v2 = rotl(v2, 32)
    lo = (v2l + v1l) >>> 0;
    v2h = (v2h + v1h + (lo < v2l ? 1 : 0)) >>> 0;
    v2l = lo;
    lo = (v1l << 17) | (v1h >>> 15);
    hi = (v1h << 17) | (v1l >>> 15);
    v1l = (lo ^ v2l) >>> 0;
    v1h = (hi ^ v2h) >>> 0;
    lo = v2l;
    v2l = v2h;
    v2h = lo;
    V[0] = v0l;
    V[1] = v0h;
    V[2] = v1l;
    V[3] = v1h;
    V[4] = v2l;
    V[5] = v2h;
    V[6] = v3l;
    V[7] = v3h;
};

const readU32 = (b: Uint8Array, o: number) =>
    (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/**
 * SipHash-2-4 of `bytes[0, length)` under a 128-bit key given as four
 * little-endian u32 words (k0 low, k0 high, k1 low, k1 high). Writes the
 * 64-bit result into `out` as [low, high].
 */
export const sipHash24 = (
    key: Uint32Array,
    bytes: Uint8Array,
    length: number,
    out: Uint32Array
) => {
    V[0] = (key[0] ^ 0x70736575) >>> 0;
    V[1] = (key[1] ^ 0x736f6d65) >>> 0;
    V[2] = (key[2] ^ 0x6e646f6d) >>> 0;
    V[3] = (key[3] ^ 0x646f7261) >>> 0;
    V[4] = (key[0] ^ 0x6e657261) >>> 0;
    V[5] = (key[1] ^ 0x6c796765) >>> 0;
    V[6] = (key[2] ^ 0x79746573) >>> 0;
    V[7] = (key[3] ^ 0x74656462) >>> 0;
    const end = length - (length % 8);
    for (let o = 0; o < end; o += 8) {
        const ml = readU32(bytes, o);
        const mh = readU32(bytes, o + 4);
        V[6] ^= ml;
        V[7] ^= mh;
        sipRound();
        sipRound();
        V[0] ^= ml;
        V[1] ^= mh;
    }
    let ml = 0;
    let mh = (length & 0xff) << 24;
    const left = length - end;
    for (let i = 0; i < left; i++) {
        const b = bytes[end + i];
        if (i < 4) ml |= b << (8 * i);
        else mh |= b << (8 * (i - 4));
    }
    ml >>>= 0;
    mh >>>= 0;
    V[6] ^= ml;
    V[7] ^= mh;
    sipRound();
    sipRound();
    V[0] ^= ml;
    V[1] ^= mh;
    V[4] ^= 0xff;
    sipRound();
    sipRound();
    sipRound();
    sipRound();
    out[0] = (V[0] ^ V[2] ^ V[4] ^ V[6]) >>> 0;
    out[1] = (V[1] ^ V[3] ^ V[5] ^ V[7]) >>> 0;
};

const ID_SEED_BYTES = 16;
/** Slot load factor of the probe table (it grows at half full). */
const MIN_TABLE = 64;

export class IdHeadMap {
    readonly seed: Uint8Array;
    private readonly key: Uint32Array;
    private table: Int32Array; // slot + 1, 0 = empty
    private mask: number;
    private keyLo: Uint32Array;
    private keyHi: Uint32Array;
    private heads: Uint8Array;
    private mods: BigUint64Array;
    private capacity: number;
    private count = 0;
    /**
     * The last string id hashed and its hash: a tap reads an id and then
     * writes it, so the second lookup reuses the hash. Strings only, since
     * they are immutable.
     */
    private lastId?: string;
    private lastLo = 0;
    private lastHi = 0;

    constructor(seed: Uint8Array = randomBytes(ID_SEED_BYTES)) {
        if (seed.length !== ID_SEED_BYTES) {
            throw new Error(`id map seed must be ${ID_SEED_BYTES} bytes`);
        }
        this.seed = Uint8Array.from(seed);
        this.key = new Uint32Array(4);
        for (let i = 0; i < 4; i++) {
            this.key[i] = readU32(this.seed, 4 * i);
        }
        this.capacity = MIN_TABLE / 2;
        this.table = new Int32Array(MIN_TABLE);
        this.mask = MIN_TABLE - 1;
        this.keyLo = new Uint32Array(this.capacity);
        this.keyHi = new Uint32Array(this.capacity);
        this.heads = new Uint8Array(this.capacity * DIGEST_BYTES);
        this.mods = new BigUint64Array(this.capacity);
    }

    get size(): number {
        return this.count;
    }

    /** The keyed 64-bit hash of `id` as [low, high] (tests and diagnostics). */
    hashOf(id: IdKey): [number, number] {
        this.hash(id);
        return [OUT[0], OUT[1]];
    }

    private hash(id: IdKey) {
        if (typeof id === "string") {
            if (id === this.lastId) {
                OUT[0] = this.lastLo;
                OUT[1] = this.lastHi;
                return;
            }
            if (scratch.length < id.length * 3) {
                scratch = new Uint8Array(id.length * 3);
            }
            const { written } = textEncoder.encodeInto(id, scratch);
            sipHash24(this.key, scratch, written, OUT);
            this.lastId = id;
            this.lastLo = OUT[0];
            this.lastHi = OUT[1];
        } else {
            sipHash24(this.key, id, id.length, OUT);
        }
    }

    /** Table index holding (lo, hi), or -1. */
    private find(lo: number, hi: number): number {
        let i = lo & this.mask;
        for (;;) {
            const entry = this.table[i];
            if (entry === 0) {
                return -1;
            }
            const slot = entry - 1;
            if (this.keyLo[slot] === lo && this.keyHi[slot] === hi) {
                return i;
            }
            i = (i + 1) & this.mask;
        }
    }

    private insertKey(lo: number, hi: number, slot: number) {
        let i = lo & this.mask;
        while (this.table[i] !== 0) {
            i = (i + 1) & this.mask;
        }
        this.table[i] = slot + 1;
    }

    private grow() {
        const capacity = this.capacity * 2;
        const keyLo = new Uint32Array(capacity);
        keyLo.set(this.keyLo);
        const keyHi = new Uint32Array(capacity);
        keyHi.set(this.keyHi);
        const heads = new Uint8Array(capacity * DIGEST_BYTES);
        heads.set(this.heads);
        const mods = new BigUint64Array(capacity);
        mods.set(this.mods);
        this.keyLo = keyLo;
        this.keyHi = keyHi;
        this.heads = heads;
        this.mods = mods;
        this.capacity = capacity;
        this.table = new Int32Array(capacity * 2);
        this.mask = capacity * 2 - 1;
        for (let slot = 0; slot < this.count; slot++) {
            this.insertKey(this.keyLo[slot], this.keyHi[slot], slot);
        }
    }

    /** The slot of `id`, or -1. Slots move on delete; do not keep them. */
    get(id: IdKey): number {
        this.hash(id);
        const i = this.find(OUT[0], OUT[1]);
        return i < 0 ? -1 : this.table[i] - 1;
    }

    /** A view of the slot's head; valid until the next mutation. */
    head(slot: number): Uint8Array {
        return this.heads.subarray(
            slot * DIGEST_BYTES,
            slot * DIGEST_BYTES + DIGEST_BYTES
        );
    }

    modified(slot: number): bigint {
        return this.mods[slot];
    }

    set(
        id: IdKey,
        digest: Uint8Array,
        modified: bigint
    ): { prev?: Uint8Array; prevModified?: bigint } {
        if (digest.length < DIGEST_BYTES) {
            throw new Error(`expected a ${DIGEST_BYTES}-byte digest`);
        }
        this.hash(id);
        const lo = OUT[0];
        const hi = OUT[1];
        const i = this.find(lo, hi);
        if (i >= 0) {
            const slot = this.table[i] - 1;
            const prev = this.head(slot).slice();
            const prevModified = this.mods[slot];
            this.heads.set(
                digest.subarray(0, DIGEST_BYTES),
                slot * DIGEST_BYTES
            );
            this.mods[slot] = modified;
            return { prev, prevModified };
        }
        if (this.count === this.capacity) {
            this.grow();
        }
        const slot = this.count++;
        this.keyLo[slot] = lo;
        this.keyHi[slot] = hi;
        this.heads.set(digest.subarray(0, DIGEST_BYTES), slot * DIGEST_BYTES);
        this.mods[slot] = modified;
        this.insertKey(lo, hi, slot);
        return {};
    }

    delete(id: IdKey): { prev?: Uint8Array; prevModified?: bigint } {
        this.hash(id);
        let i = this.find(OUT[0], OUT[1]);
        if (i < 0) {
            return {};
        }
        const slot = this.table[i] - 1;
        const prev = this.head(slot).slice();
        const prevModified = this.mods[slot];
        // Backward-shift deletion keeps linear probing free of tombstones.
        this.table[i] = 0;
        let j = i;
        for (;;) {
            j = (j + 1) & this.mask;
            const entry = this.table[j];
            if (entry === 0) {
                break;
            }
            const home = this.keyLo[entry - 1] & this.mask;
            const between =
                i <= j ? i < home && home <= j : i < home || home <= j;
            if (!between) {
                this.table[i] = entry;
                this.table[j] = 0;
                i = j;
            }
        }
        // Keep the slot columns dense: move the last slot into the hole.
        const last = this.count - 1;
        if (slot !== last) {
            const lo = this.keyLo[last];
            const hi = this.keyHi[last];
            const at = this.find(lo, hi);
            this.table[at] = slot + 1;
            this.keyLo[slot] = lo;
            this.keyHi[slot] = hi;
            this.heads.copyWithin(
                slot * DIGEST_BYTES,
                last * DIGEST_BYTES,
                last * DIGEST_BYTES + DIGEST_BYTES
            );
            this.mods[slot] = this.mods[last];
        }
        this.count--;
        return { prev, prevModified };
    }

    /** Calls `fn` with every live head (a view) and its modified time. */
    forEach(fn: (digest: Uint8Array, modified: bigint) => void) {
        for (let slot = 0; slot < this.count; slot++) {
            fn(this.head(slot), this.mods[slot]);
        }
    }

    /**
     * Calls `fn` with every row's keyed hash as `"low:high"` (the form
     * `hashKey` returns), its head (a view) and its modified time. For the
     * shadow check, which matches rows by id hash.
     */
    forEachEntry(
        fn: (hash: string, digest: Uint8Array, modified: bigint) => void
    ) {
        for (let slot = 0; slot < this.count; slot++) {
            fn(
                `${this.keyLo[slot]}:${this.keyHi[slot]}`,
                this.head(slot),
                this.mods[slot]
            );
        }
    }

    /** The keyed hash of `id` in the form `forEachEntry` passes. */
    hashKey(id: IdKey): string {
        this.hash(id);
        return `${OUT[0]}:${OUT[1]}`;
    }

    /** Counts rows with modified > `hlc`, calling `fn` for each (O(n)). */
    forEachAbove(hlc: bigint, fn?: (digest: Uint8Array) => void): number {
        let n = 0;
        for (let slot = 0; slot < this.count; slot++) {
            if (this.mods[slot] > hlc) {
                n++;
                fn?.(this.head(slot));
            }
        }
        return n;
    }

    /**
     * seed (16) | n (u32 LE) | keys (n x 8: low, high) | heads (n x 32) |
     * modified (n x 8, u64 LE).
     */
    serialize(): Uint8Array {
        const n = this.count;
        const out = new Uint8Array(ID_SEED_BYTES + 4 + n * 48);
        const view = new DataView(out.buffer);
        out.set(this.seed, 0);
        view.setUint32(ID_SEED_BYTES, n, true);
        let o = ID_SEED_BYTES + 4;
        for (let slot = 0; slot < n; slot++, o += 8) {
            view.setUint32(o, this.keyLo[slot], true);
            view.setUint32(o + 4, this.keyHi[slot], true);
        }
        out.set(this.heads.subarray(0, n * DIGEST_BYTES), o);
        o += n * DIGEST_BYTES;
        for (let slot = 0; slot < n; slot++, o += 8) {
            view.setBigUint64(o, this.mods[slot], true);
        }
        return out;
    }

    static restore(bytes: Uint8Array): IdHeadMap {
        if (bytes.length < ID_SEED_BYTES + 4) {
            throw new Error("id map: truncated");
        }
        const view = new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength
        );
        const n = view.getUint32(ID_SEED_BYTES, true);
        if (bytes.length !== ID_SEED_BYTES + 4 + n * 48) {
            throw new Error("id map: length does not match its row count");
        }
        const map = new IdHeadMap(bytes.subarray(0, ID_SEED_BYTES));
        while (map.capacity < n) {
            map.capacity *= 2;
        }
        map.keyLo = new Uint32Array(map.capacity);
        map.keyHi = new Uint32Array(map.capacity);
        map.heads = new Uint8Array(map.capacity * DIGEST_BYTES);
        map.mods = new BigUint64Array(map.capacity);
        map.table = new Int32Array(map.capacity * 2);
        map.mask = map.capacity * 2 - 1;
        let o = ID_SEED_BYTES + 4;
        for (let slot = 0; slot < n; slot++, o += 8) {
            const lo = view.getUint32(o, true);
            const hi = view.getUint32(o + 4, true);
            if (map.find(lo, hi) >= 0) {
                throw new Error("id map: duplicate key");
            }
            map.keyLo[slot] = lo;
            map.keyHi[slot] = hi;
            map.insertKey(lo, hi, slot);
            map.count = slot + 1;
        }
        map.heads.set(bytes.subarray(o, o + n * DIGEST_BYTES));
        o += n * DIGEST_BYTES;
        for (let slot = 0; slot < n; slot++, o += 8) {
            map.mods[slot] = view.getBigUint64(o, true);
        }
        return map;
    }
}
