import { sha256Sync } from "@peerbit/crypto";
import { concat, fromString } from "uint8arrays";
import { CELL_BYTES, DIGEST_BYTES, L, M } from "./constants.js";

/**
 * The maintained rateless IBLT prefix of a scope (WRITE_READINESS_V2.md
 * section 4.4): the first M = 4,096 cells over the live set of 32-byte
 * entry hashes. A cell holds the XOR of the hashes mapped to it (8 u32
 * lanes), the XOR of their keyed 64-bit checksums and a signed count.
 *
 * A port of the M0 P5 prototype (`m0/p5/proto/cells.mjs`, itself the
 * "A32.h32" arm of the SOTA harness): the checksum `chkL`, the xorshift walk
 * seeded by that checksum, the cell key and the 44-byte codec are pinned by
 * golden vectors in `readiness-cells.test.ts`. Any change to them is a wire
 * change (see wire.ts).
 */

/** Anything holding cells in the maintained layout. */
export interface CellsLike {
    readonly sum: Uint32Array;
    readonly chk: Uint32Array;
    readonly cnt: Int32Array;
}

const CK = new Uint32Array(2);
const LANES_SCRATCH = new Uint32Array(L);

/**
 * Keyed 64-bit checksum of the L lanes at `ids[off..off+L)`: two murmur3
 * fmix chains under the keys k0 and k1. Writes [low, high] into `out`.
 */
export const chkL = (
    ids: Uint32Array,
    off: number,
    k0: number,
    k1: number,
    out: Uint32Array
) => {
    let a = k0 ^ 0x85ebca6b;
    let b = k1 ^ 0xc2b2ae35;
    for (let i = 0; i < L; i++) {
        const v = ids[off + i];
        a = Math.imul(a ^ v, 0xcc9e2d51);
        a = (a << 15) | (a >>> 17);
        a = Math.imul(a, 0x1b873593);
        b = Math.imul(b ^ v, 0x85ebca6b);
        b = (b << 13) | (b >>> 19);
        b = Math.imul(b, 0xc2b2ae35);
    }
    a ^= a >>> 16;
    a = Math.imul(a, 0x85ebca6b);
    a ^= a >>> 13;
    a = Math.imul(a, 0xc2b2ae35);
    a ^= a >>> 16;
    b ^= b >>> 15;
    b = Math.imul(b, 0x2c1b3c6d);
    b ^= b >>> 12;
    b = Math.imul(b, 0x297a2d39);
    b ^= b >>> 15;
    out[0] = a >>> 0;
    out[1] = b >>> 0;
};

/**
 * The cell checksum key of a store: public on purpose (design 4.4), since
 * the anchor carries the security and the cells need no secret.
 *
 * The cost of that (design 4.4 accepts it as "only a false hint"): a writer
 * can grind two entries with one 64-bit checksum in about 2^32 hashes. Equal
 * checksums walk to the same cells at every prefix, so the pair never
 * peels, and every joiner missing both rows falls back to list mode. A
 * responder serves one list session at a time (deviation c), so fresh
 * joiners of such a store are then served one after another, each holding
 * the list session up to the 30 s idle. PR-3's BUSY-storm test (46) covers
 * it.
 */
export const cellKey = (address: string): [number, number] => {
    const k = sha256Sync(
        concat([fromString("sfs-readiness-cells-v1"), fromString(address)])
    );
    const view = new DataView(k.buffer, k.byteOffset, 16);
    return [
        (view.getUint32(0, true) ^ view.getUint32(8, true)) | 0,
        (view.getUint32(4, true) ^ view.getUint32(12, true)) | 0,
    ];
};

/**
 * The rateless index walk (Yang, Gilad and Alizadeh 2024): calls `visit`
 * with every cell index below `m` that an element with checksum (c0, c1)
 * maps to, in increasing order. A 64-bit xorshift state seeded from the
 * checksum drives the gaps; a 32-bit seed failed 4 of 20 decodes at
 * d = 40k (design 4.4).
 */
const walk = (
    c0: number,
    c1: number,
    m: number,
    visit: (i: number) => void
) => {
    let lo = c0 | 0;
    let hi = c1 | 0 || 0x6d2b79f5;
    let t: number;
    let i = 0;
    while (i < m) {
        visit(i);
        t = lo << 13;
        hi ^= (hi << 13) | (lo >>> 19);
        lo ^= t;
        t = hi >>> 7;
        lo ^= (lo >>> 7) | (hi << 25);
        hi ^= t;
        t = lo << 17;
        hi ^= (hi << 17) | (lo >>> 15);
        lo ^= t;
        const u =
            1 -
            ((hi >>> 0) * 2.3283064365386963e-10 +
                (lo >>> 0) * 5.421010862427522e-20);
        i += Math.ceil((i + 1.5) * (1 / Math.sqrt(u) - 1)) || 1;
    }
};

/** Reads a 32-byte digest as L little-endian u32 lanes into `out`. */
export const digestToLanes = (
    digest: Uint8Array,
    out: Uint32Array = new Uint32Array(L)
): Uint32Array => {
    if (digest.length < DIGEST_BYTES) {
        throw new Error(`expected a ${DIGEST_BYTES}-byte digest`);
    }
    for (let k = 0; k < L; k++) {
        const o = 4 * k;
        out[k] =
            (digest[o] |
                (digest[o + 1] << 8) |
                (digest[o + 2] << 16) |
                (digest[o + 3] << 24)) >>>
            0;
    }
    return out;
};

/** The 32-byte digest of L lanes (inverse of `digestToLanes`). */
export const lanesToDigest = (lanes: Uint32Array, off = 0): Uint8Array => {
    const out = new Uint8Array(DIGEST_BYTES);
    for (let k = 0; k < L; k++) {
        const v = lanes[off + k];
        const o = 4 * k;
        out[o] = v & 0xff;
        out[o + 1] = (v >>> 8) & 0xff;
        out[o + 2] = (v >>> 16) & 0xff;
        out[o + 3] = (v >>> 24) & 0xff;
    }
    return out;
};

/** Cell indices below `m` that `digest` maps to (tests and diagnostics). */
export const cellIndices = (
    digest: Uint8Array,
    k0: number,
    k1: number,
    m = M
): number[] => {
    const lanes = digestToLanes(digest);
    const out = new Uint32Array(2);
    chkL(lanes, 0, k0, k1, out);
    const indices: number[] = [];
    walk(out[0], out[1], m, (i) => indices.push(i));
    return indices;
};

export class Cells implements CellsLike {
    readonly sum: Uint32Array;
    readonly chk: Uint32Array;
    readonly cnt: Int32Array;

    constructor(
        readonly m: number,
        readonly k0: number,
        readonly k1: number
    ) {
        this.sum = new Uint32Array(L * m);
        this.chk = new Uint32Array(2 * m);
        this.cnt = new Int32Array(m);
    }

    /**
     * Adds (+1) or removes (-1) the element with lanes `ids[off..off+L)`.
     * The tap's hot path: `walk` is inlined here with the lanes unrolled
     * (L = 8). With a callback per cell it cost 2.2 us per element inside a
     * filesystem process against 0.4 us standalone (review bench, 20k rows);
     * the golden vectors pin both to the same cells.
     */
    applyLanes(ids: Uint32Array, sign: 1 | -1, off = 0) {
        const sum = this.sum;
        const chk = this.chk;
        const cnt = this.cnt;
        const m = this.m;
        chkL(ids, off, this.k0, this.k1, CK);
        const c0 = CK[0];
        const c1 = CK[1];
        const v0 = ids[off];
        const v1 = ids[off + 1];
        const v2 = ids[off + 2];
        const v3 = ids[off + 3];
        const v4 = ids[off + 4];
        const v5 = ids[off + 5];
        const v6 = ids[off + 6];
        const v7 = ids[off + 7];
        let lo = c0 | 0;
        let hi = c1 | 0 || 0x6d2b79f5;
        let t: number;
        let i = 0;
        while (i < m) {
            const b = 8 * i;
            sum[b] ^= v0;
            sum[b + 1] ^= v1;
            sum[b + 2] ^= v2;
            sum[b + 3] ^= v3;
            sum[b + 4] ^= v4;
            sum[b + 5] ^= v5;
            sum[b + 6] ^= v6;
            sum[b + 7] ^= v7;
            chk[2 * i] ^= c0;
            chk[2 * i + 1] ^= c1;
            cnt[i] += sign;
            // The step of `walk`, unchanged.
            t = lo << 13;
            hi ^= (hi << 13) | (lo >>> 19);
            lo ^= t;
            t = hi >>> 7;
            lo ^= (lo >>> 7) | (hi << 25);
            hi ^= t;
            t = lo << 17;
            hi ^= (hi << 17) | (lo >>> 15);
            lo ^= t;
            const u =
                1 -
                ((hi >>> 0) * 2.3283064365386963e-10 +
                    (lo >>> 0) * 5.421010862427522e-20);
            i += Math.ceil((i + 1.5) * (1 / Math.sqrt(u) - 1)) || 1;
        }
    }

    /** The tap sink: adds or removes one 32-byte digest. */
    apply(digest: Uint8Array, sign: 1 | -1) {
        this.applyLanes(digestToLanes(digest, LANES_SCRATCH), sign);
    }

    /** Back to the empty set (a discarded restore). */
    reset() {
        this.sum.fill(0);
        this.chk.fill(0);
        this.cnt.fill(0);
    }

    copy(): Cells {
        const out = new Cells(this.m, this.k0, this.k1);
        out.sum.set(this.sum);
        out.chk.set(this.chk);
        out.cnt.set(this.cnt);
        return out;
    }

    /** All m cells in the wire layout (persistence). */
    toBytes(): Uint8Array {
        return encodeCells(this, 0, this.m);
    }

    /** Replaces every cell with `bytes` (m x 44 B, the wire layout). */
    restore(bytes: Uint8Array) {
        if (bytes.length !== this.m * CELL_BYTES) {
            throw new Error(
                `expected ${this.m * CELL_BYTES} bytes of cells, got ${bytes.length}`
            );
        }
        decodeCellsInto(this, 0, bytes);
    }

    /** Whether every cell is zero (the empty set). */
    isEmpty(): boolean {
        return (
            this.cnt.every((v) => v === 0) &&
            this.chk.every((v) => v === 0) &&
            this.sum.every((v) => v === 0)
        );
    }
}

/** Cells received from a peer: the prefix [0, have) is filled. */
export interface RemoteCells extends CellsLike {
    have: number;
}

export const emptyRemoteCells = (m = M): RemoteCells => ({
    sum: new Uint32Array(L * m),
    chk: new Uint32Array(2 * m),
    cnt: new Int32Array(m),
    have: 0,
});

/**
 * (R - J) over the prefix [0, m): XOR of sums and checksums, difference of
 * counts. `r` is R's cells (a snapshot or received prefix), `j` J's own.
 */
export const subtractPrefix = (
    r: CellsLike,
    j: CellsLike,
    m: number
): CellsLike => {
    const sum = new Uint32Array(L * m);
    const chk = new Uint32Array(2 * m);
    const cnt = new Int32Array(m);
    for (let i = 0; i < L * m; i++) sum[i] = r.sum[i] ^ j.sum[i];
    for (let i = 0; i < 2 * m; i++) chk[i] = r.chk[i] ^ j.chk[i];
    for (let i = 0; i < m; i++) cnt[i] = r.cnt[i] - j.cnt[i];
    return { sum, chk, cnt };
};

export interface PeelResult {
    /** Every cell decoded to zero: `plus` and `minus` are the whole difference. */
    ok: boolean;
    /** Elements only in R (32-byte digests). */
    plus: Uint8Array[];
    /** Elements only in J. */
    minus: Uint8Array[];
}

/**
 * Peels a difference `d` of m cells in place (it is consumed). A cell is
 * pure when its count is +1 or -1 and its checksum matches the checksum of
 * its sum; each pure cell yields one element, which is removed from every
 * cell it maps to. `ok` only when every cell ends at zero.
 */
export const peel = (
    d: CellsLike,
    m: number,
    k0: number,
    k1: number
): PeelResult => {
    const { sum, chk, cnt } = d;
    const pk = new Uint32Array(2);
    const pure = (i: number) => {
        const c = cnt[i];
        if (c !== 1 && c !== -1) return false;
        chkL(sum, L * i, k0, k1, pk);
        return pk[0] === chk[2 * i] && pk[1] === chk[2 * i + 1];
    };
    const queue: number[] = [];
    for (let i = 0; i < m; i++) {
        if (pure(i)) queue.push(i);
    }
    const plus: Uint8Array[] = [];
    const minus: Uint8Array[] = [];
    const id = new Uint32Array(L);
    let guard = 0;
    while (queue.length) {
        const i = queue.pop()!;
        if (!pure(i)) continue;
        if (++guard > 4 * m + 64) break;
        const s = cnt[i];
        for (let k = 0; k < L; k++) id[k] = sum[L * i + k];
        (s === 1 ? plus : minus).push(lanesToDigest(id));
        chkL(id, 0, k0, k1, pk);
        const c0 = pk[0];
        const c1 = pk[1];
        walk(c0, c1, m, (j) => {
            const b = L * j;
            for (let k = 0; k < L; k++) sum[b + k] ^= id[k];
            chk[2 * j] ^= c0;
            chk[2 * j + 1] ^= c1;
            cnt[j] -= s;
            if (pure(j)) queue.push(j);
        });
    }
    for (let i = 0; i < m; i++) {
        if (cnt[i] !== 0 || chk[2 * i] !== 0 || chk[2 * i + 1] !== 0) {
            return { ok: false, plus, minus };
        }
        for (let k = 0; k < L; k++) {
            if (sum[L * i + k] !== 0) return { ok: false, plus, minus };
        }
    }
    return { ok: true, plus, minus };
};

/** Peels (R - J) over [0, m) without touching either side. */
export const peelDifference = (r: CellsLike, j: Cells, m: number): PeelResult =>
    peel(subtractPrefix(r, j, m), m, j.k0, j.k1);

/**
 * Cells [from, to) in the wire layout: per cell 8 u32 sum lanes, the two
 * u32 checksum words and the i32 count, all little-endian (44 B).
 */
export const encodeCells = (
    c: CellsLike,
    from: number,
    to: number
): Uint8Array => {
    const n = to - from;
    const out = new Uint8Array(n * CELL_BYTES);
    const view = new DataView(out.buffer);
    let o = 0;
    for (let i = from; i < to; i++) {
        for (let k = 0; k < L; k++, o += 4) {
            view.setUint32(o, c.sum[L * i + k], true);
        }
        view.setUint32(o, c.chk[2 * i], true);
        o += 4;
        view.setUint32(o, c.chk[2 * i + 1], true);
        o += 4;
        view.setInt32(o, c.cnt[i], true);
        o += 4;
    }
    return out;
};

/**
 * Writes wire cells into `dst` starting at cell `from`; returns the number
 * of cells. Raises `have` of a remote cell set.
 */
export const decodeCellsInto = (
    dst: CellsLike & { have?: number },
    from: number,
    bytes: Uint8Array
): number => {
    const n = bytes.length / CELL_BYTES;
    if (!Number.isInteger(n) || from + n > dst.cnt.length) {
        throw new Error("bad cell payload");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let o = 0;
    for (let i = from; i < from + n; i++) {
        for (let k = 0; k < L; k++, o += 4) {
            dst.sum[L * i + k] = view.getUint32(o, true);
        }
        dst.chk[2 * i] = view.getUint32(o, true);
        o += 4;
        dst.chk[2 * i + 1] = view.getUint32(o, true);
        o += 4;
        dst.cnt[i] = view.getInt32(o, true);
        o += 4;
    }
    if (dst.have !== undefined) {
        dst.have = Math.max(dst.have, from + n);
    }
    return n;
};
