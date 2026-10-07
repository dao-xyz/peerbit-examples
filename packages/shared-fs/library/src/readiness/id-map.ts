import { randomBytes } from "@peerbit/crypto";
import { DIGEST_BYTES } from "./constants.js";

/**
 * Document id -> current head, so a replace (which Documents reports as a
 * bare `added`) can subtract the head it replaced. Compact form: open
 * addressing on a keyed 64-bit hash of the id, plus dense rows (the hash,
 * the 32-byte head and the exact u64 `__context.modified`). 64 B per slot
 * of capacity, against 175-243 B per row for a `Map<string, string>`
 * (M0 P4).
 *
 * Laid out for the tap's write path, whose cost inside a filesystem
 * process is mostly cache misses: a probe compares the hash's low word in
 * the table itself, and a row is one 48-byte span, so a lookup touches the
 * table line and the row only. The tap's calls (`get`, `headEquals`,
 * `put`, `remove`) allocate nothing; `set` and `delete` return copies.
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
const OUT = new Uint32Array(2);

const readU32 = (b: Uint8Array, o: number) =>
    (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/**
 * SipHash-2-4 of `bytes[0, length)` under a 128-bit key given as four
 * little-endian u32 words (k0 low, k0 high, k1 low, k1 high). Writes the
 * 64-bit result into `out` as [low, high]. The state stays in locals as
 * 32-bit halves; one loop runs every round, taking in a message word
 * before and after each pair of compression rounds.
 */
export const sipHash24 = (
    key: Uint32Array,
    bytes: Uint8Array,
    length: number,
    out: Uint32Array
) => {
    let v0l = (key[0] ^ 0x70736575) >>> 0,
        v0h = (key[1] ^ 0x736f6d65) >>> 0,
        v1l = (key[2] ^ 0x6e646f6d) >>> 0,
        v1h = (key[3] ^ 0x646f7261) >>> 0,
        v2l = (key[0] ^ 0x6e657261) >>> 0,
        v2h = (key[1] ^ 0x6c796765) >>> 0,
        v3l = (key[2] ^ 0x79746573) >>> 0,
        v3h = (key[3] ^ 0x74656462) >>> 0,
        lo: number,
        hi: number;
    const end = length - (length % 8);
    // Blocks of 8 bytes, then the last block (the tail and the length).
    const compression = 2 * (end / 8 + 1);
    let ml = 0;
    let mh = 0;
    for (let round = 0; round < compression + 4; round++) {
        if (round < compression && (round & 1) === 0) {
            const o = 4 * round;
            if (o < end) {
                ml = readU32(bytes, o);
                mh = readU32(bytes, o + 4);
            } else {
                ml = 0;
                mh = (length & 0xff) << 24;
                for (let i = 0; i < length - end; i++) {
                    const b = bytes[end + i];
                    if (i < 4) ml |= b << (8 * i);
                    else mh |= b << (8 * (i - 4));
                }
                ml >>>= 0;
                mh >>>= 0;
            }
            v3l = (v3l ^ ml) >>> 0;
            v3h = (v3h ^ mh) >>> 0;
        }
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
        if (round < compression && (round & 1) === 1) {
            v0l = (v0l ^ ml) >>> 0;
            v0h = (v0h ^ mh) >>> 0;
            if (round === compression - 1) v2l = (v2l ^ 0xff) >>> 0;
        }
    }
    out[0] = (v0l ^ v1l ^ v2l ^ v3l) >>> 0;
    out[1] = (v0h ^ v1h ^ v2h ^ v3h) >>> 0;
};

const ID_SEED_BYTES = 16;
/** Slot load factor of the probe table (it grows at half full). */
const MIN_TABLE = 64;
/** A row: hash low and high, the head (8 words), modified (u64 LE). */
const ROW_WORDS = 12;
const ROW_BYTES = 4 * ROW_WORDS;
const HEAD_AT = 8;
/** `modified` of row r is u64 number `ROW_U64 * r + MOD_U64`. */
const ROW_U64 = ROW_BYTES / 8;
const MOD_U64 = 5;
const MOD_WORD = 2 * MOD_U64;
/**
 * Rows hold host-order words: on a little-endian host a row's bytes are
 * already the serialized layout (keys and `modified` little-endian), so
 * `serialize` and `restore` copy words.
 */
const HOST_LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export class IdHeadMap {
    readonly seed: Uint8Array;
    private readonly key: Uint32Array;
    /** Two i32 per entry: slot + 1 (0 = empty) and the hash's low word. */
    private table: Int32Array;
    /** Entries in the table, less one. */
    private mask: number;
    /** The rows, as words, bytes (heads) and u64 (modified). */
    private words: Uint32Array;
    private bytes: Uint8Array;
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
        this.mask = MIN_TABLE - 1;
        this.table = new Int32Array(2 * MIN_TABLE);
        const rows = new ArrayBuffer(this.capacity * ROW_BYTES);
        this.words = new Uint32Array(rows);
        this.bytes = new Uint8Array(rows);
        this.mods = new BigUint64Array(rows);
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
            const n = id.length;
            if (scratch.length < n * 3) {
                scratch = new Uint8Array(n * 3);
            }
            // Ids are ASCII in practice: their UTF-8 is their char codes.
            let length = n;
            for (let i = 0; i < n; i++) {
                const c = id.charCodeAt(i);
                if (c >= 0x80) {
                    length = textEncoder.encodeInto(id, scratch).written;
                    break;
                }
                scratch[i] = c;
            }
            sipHash24(this.key, scratch, length, OUT);
            this.lastId = id;
            this.lastLo = OUT[0];
            this.lastHi = OUT[1];
        } else {
            sipHash24(this.key, id, id.length, OUT);
        }
    }

    /** Table entry holding (lo, hi), or -1. */
    private find(lo: number, hi: number): number {
        const table = this.table;
        const mask = this.mask;
        const low = lo | 0;
        let i = lo & mask;
        for (;;) {
            const entry = table[2 * i];
            if (entry === 0) {
                return -1;
            }
            if (
                table[2 * i + 1] === low &&
                this.words[(entry - 1) * ROW_WORDS + 1] === hi
            ) {
                return i;
            }
            i = (i + 1) & mask;
        }
    }

    private insertKey(lo: number, slot: number) {
        const table = this.table;
        let i = lo & this.mask;
        while (table[2 * i] !== 0) {
            i = (i + 1) & this.mask;
        }
        table[2 * i] = slot + 1;
        table[2 * i + 1] = lo;
    }

    /** Rows and table for `capacity` rows; keeps the first `count` rows. */
    private resize(capacity: number) {
        const rows = new ArrayBuffer(capacity * ROW_BYTES);
        const words = new Uint32Array(rows);
        words.set(this.words.subarray(0, this.count * ROW_WORDS));
        this.words = words;
        this.bytes = new Uint8Array(rows);
        this.mods = new BigUint64Array(rows);
        this.capacity = capacity;
        this.mask = capacity * 2 - 1;
        this.table = new Int32Array(capacity * 4);
        for (let slot = 0; slot < this.count; slot++) {
            this.insertKey(this.words[slot * ROW_WORDS], slot);
        }
    }

    /** The slot of `id`, or -1. Slots move on delete; do not keep them. */
    get(id: IdKey): number {
        this.hash(id);
        const i = this.find(OUT[0], OUT[1]);
        return i < 0 ? -1 : this.table[2 * i] - 1;
    }

    /** A view of the slot's head; valid until the next mutation. */
    head(slot: number): Uint8Array {
        const at = slot * ROW_BYTES + HEAD_AT;
        return this.bytes.subarray(at, at + DIGEST_BYTES);
    }

    /** Whether the slot's head is `digest` (its first 32 bytes). */
    headEquals(slot: number, digest: Uint8Array): boolean {
        const bytes = this.bytes;
        const at = slot * ROW_BYTES + HEAD_AT;
        for (let i = 0; i < DIGEST_BYTES; i++) {
            if (bytes[at + i] !== digest[i]) return false;
        }
        return true;
    }

    modified(slot: number): bigint {
        return this.mods[slot * ROW_U64 + MOD_U64];
    }

    private copyHead(slot: number, out: Uint8Array) {
        const bytes = this.bytes;
        const at = slot * ROW_BYTES + HEAD_AT;
        for (let i = 0; i < DIGEST_BYTES; i++) out[i] = bytes[at + i];
    }

    private writeRow(slot: number, digest: Uint8Array, modified: bigint) {
        const bytes = this.bytes;
        const at = slot * ROW_BYTES + HEAD_AT;
        for (let i = 0; i < DIGEST_BYTES; i++) bytes[at + i] = digest[i];
        this.mods[slot * ROW_U64 + MOD_U64] = modified;
    }

    /**
     * Sets `id` to `digest` (its first 32 bytes) and `modified`; returns
     * whether it replaced a row, whose head is then copied into `prev`.
     */
    put(
        id: IdKey,
        digest: Uint8Array,
        modified: bigint,
        prev?: Uint8Array
    ): boolean {
        if (digest.length < DIGEST_BYTES) {
            throw new Error(`expected a ${DIGEST_BYTES}-byte digest`);
        }
        this.hash(id);
        const lo = OUT[0];
        const hi = OUT[1];
        const i = this.find(lo, hi);
        if (i >= 0) {
            const slot = this.table[2 * i] - 1;
            if (prev) this.copyHead(slot, prev);
            this.writeRow(slot, digest, modified);
            return true;
        }
        if (this.count === this.capacity) {
            this.resize(this.capacity * 2);
        }
        const slot = this.count++;
        this.words[slot * ROW_WORDS] = lo;
        this.words[slot * ROW_WORDS + 1] = hi;
        this.writeRow(slot, digest, modified);
        this.insertKey(lo, slot);
        return false;
    }

    /** `put`, returning copies of the replaced head and modified time. */
    set(
        id: IdKey,
        digest: Uint8Array,
        modified: bigint
    ): { prev?: Uint8Array; prevModified?: bigint } {
        const slot = this.get(id);
        const prevModified = slot >= 0 ? this.modified(slot) : undefined;
        const prev = new Uint8Array(DIGEST_BYTES);
        return this.put(id, digest, modified, prev)
            ? { prev, prevModified }
            : {};
    }

    /**
     * Deletes `id`; returns whether it held a row, whose head is then copied
     * into `prev`.
     */
    remove(id: IdKey, prev?: Uint8Array): boolean {
        this.hash(id);
        let i = this.find(OUT[0], OUT[1]);
        if (i < 0) {
            return false;
        }
        const table = this.table;
        const mask = this.mask;
        const slot = table[2 * i] - 1;
        if (prev) this.copyHead(slot, prev);
        // Backward-shift deletion keeps linear probing free of tombstones.
        table[2 * i] = 0;
        let j = i;
        for (;;) {
            j = (j + 1) & mask;
            const entry = table[2 * j];
            if (entry === 0) {
                break;
            }
            const home = table[2 * j + 1] & mask;
            const between =
                i <= j ? i < home && home <= j : i < home || home <= j;
            if (!between) {
                table[2 * i] = entry;
                table[2 * i + 1] = table[2 * j + 1];
                table[2 * j] = 0;
                i = j;
            }
        }
        // Keep the rows dense: move the last row into the hole.
        const last = this.count - 1;
        if (slot !== last) {
            const words = this.words;
            const at = this.find(
                words[last * ROW_WORDS],
                words[last * ROW_WORDS + 1]
            );
            table[2 * at] = slot + 1;
            words.copyWithin(
                slot * ROW_WORDS,
                last * ROW_WORDS,
                last * ROW_WORDS + ROW_WORDS
            );
        }
        this.count--;
        return true;
    }

    /** `remove`, returning copies of the removed head and modified time. */
    delete(id: IdKey): { prev?: Uint8Array; prevModified?: bigint } {
        const slot = this.get(id);
        if (slot < 0) {
            return {};
        }
        const prevModified = this.modified(slot);
        const prev = new Uint8Array(DIGEST_BYTES);
        this.remove(id, prev);
        return { prev, prevModified };
    }

    /** Calls `fn` with every live head (a view) and its modified time. */
    forEach(fn: (digest: Uint8Array, modified: bigint) => void) {
        for (let slot = 0; slot < this.count; slot++) {
            fn(this.head(slot), this.modified(slot));
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
                `${this.words[slot * ROW_WORDS]}:${this.words[slot * ROW_WORDS + 1]}`,
                this.head(slot),
                this.modified(slot)
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
            if (this.modified(slot) > hlc) {
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
        const words = this.words;
        const bytes = this.bytes;
        let o = ID_SEED_BYTES + 4;
        for (let slot = 0; slot < n; slot++, o += 8) {
            view.setUint32(o, words[slot * ROW_WORDS], true);
            view.setUint32(o + 4, words[slot * ROW_WORDS + 1], true);
        }
        for (let slot = 0; slot < n; slot++) {
            const w = slot * ROW_WORDS + HEAD_AT / 4;
            // Memory order either way: the head is bytes.
            for (let k = 0; k < 8; k++, o += 4) {
                view.setUint32(o, words[w + k], HOST_LE);
            }
        }
        for (let slot = 0; slot < n; slot++, o += 8) {
            if (HOST_LE) {
                view.setUint32(o, words[slot * ROW_WORDS + MOD_WORD], true);
                view.setUint32(
                    o + 4,
                    words[slot * ROW_WORDS + MOD_WORD + 1],
                    true
                );
            } else {
                view.setBigUint64(o, this.modified(slot), true);
            }
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
        let capacity = map.capacity;
        while (capacity < n) {
            capacity *= 2;
        }
        map.resize(capacity);
        const words = map.words;
        let o = ID_SEED_BYTES + 4;
        for (let slot = 0; slot < n; slot++, o += 8) {
            const lo = view.getUint32(o, true);
            const hi = view.getUint32(o + 4, true);
            if (map.find(lo, hi) >= 0) {
                throw new Error("id map: duplicate key");
            }
            words[slot * ROW_WORDS] = lo;
            words[slot * ROW_WORDS + 1] = hi;
            map.insertKey(lo, slot);
            map.count = slot + 1;
        }
        for (let slot = 0; slot < n; slot++) {
            const w = slot * ROW_WORDS + HEAD_AT / 4;
            for (let k = 0; k < 8; k++, o += 4) {
                words[w + k] = view.getUint32(o, HOST_LE);
            }
        }
        for (let slot = 0; slot < n; slot++, o += 8) {
            if (HOST_LE) {
                words[slot * ROW_WORDS + MOD_WORD] = view.getUint32(o, true);
                words[slot * ROW_WORDS + MOD_WORD + 1] = view.getUint32(
                    o + 4,
                    true
                );
            } else {
                map.mods[slot * ROW_U64 + MOD_U64] = view.getBigUint64(o, true);
            }
        }
        return map;
    }
}
