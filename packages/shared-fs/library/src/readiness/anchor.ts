/**
 * The anchor of a scope (WRITE_READINESS_V2.md section 4.4, D17): an
 * LtHash32 set hash of 1,024 u32 lanes. An element (a 32-byte entry hash) is
 * expanded to 4 KiB of AES-256-CTR keystream keyed by the element itself,
 * with the scope's 16-byte domain tag as the IV, and added lane by lane mod
 * 2^32; a removal subtracts. The digest is D = sha256(tag || lanes), lanes
 * little-endian.
 *
 * `createAnchorMath` is self-contained on purpose: it uses no import and no
 * outer binding, so the anchor worker embeds its source text and the worker
 * and the inline fallback run exactly the same code (M1 plan section 4).
 * Keep it that way: no imports, no module constants, no classes.
 *
 * Changing the expansion after a v9.2 release needs a salt bump, not just a
 * new format tag: mixed expansions make honest recovery lists mismatch
 * (M1 plan S3).
 */

/** The `node:crypto` surface the anchor uses. */
export interface AnchorCrypto {
    createCipheriv(
        algorithm: string,
        key: Uint8Array,
        iv: Uint8Array
    ): { update(data: Uint8Array): Uint8Array };
    createHash(algorithm: string): {
        update(data: Uint8Array): any;
        digest(): Uint8Array;
    };
}

export interface AnchorMath {
    readonly lanes: number;
    /** Adds (+1) or subtracts (-1) the expansions of `n` digests at `buf`. */
    applyMany(
        lanes: Uint32Array,
        iv: Uint8Array,
        buf: Uint8Array,
        signs: Int8Array | number
    ): void;
    /** D = sha256(iv || lanes as little-endian bytes). */
    digest(lanes: Uint32Array, iv: Uint8Array): Uint8Array;
    /** Lanes as little-endian bytes (persistence). */
    lanesToBytes(lanes: Uint32Array): Uint8Array;
    /** Inverse of `lanesToBytes`. */
    bytesToLanes(bytes: Uint8Array): Uint32Array;
}

export function createAnchorMath(crypto: AnchorCrypto): AnchorMath {
    const LANE_COUNT = 1024;
    const ELEMENT = 32;
    const zero = new Uint8Array(LANE_COUNT * 4);
    const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    const expand = (key: Uint8Array, iv: Uint8Array) => {
        const stream = crypto
            .createCipheriv("aes-256-ctr", key, iv)
            .update(zero);
        if (littleEndian && stream.byteOffset % 4 === 0) {
            return new Uint32Array(
                stream.buffer,
                stream.byteOffset,
                LANE_COUNT
            );
        }
        const out = new Uint32Array(LANE_COUNT);
        for (let i = 0; i < LANE_COUNT; i++) {
            const o = 4 * i;
            out[i] =
                (stream[o] |
                    (stream[o + 1] << 8) |
                    (stream[o + 2] << 16) |
                    (stream[o + 3] << 24)) >>>
                0;
        }
        return out;
    };
    const lanesToBytes = (lanes: Uint32Array) => {
        const out = new Uint8Array(LANE_COUNT * 4);
        for (let i = 0; i < LANE_COUNT; i++) {
            const v = lanes[i];
            const o = 4 * i;
            out[o] = v & 0xff;
            out[o + 1] = (v >>> 8) & 0xff;
            out[o + 2] = (v >>> 16) & 0xff;
            out[o + 3] = (v >>> 24) & 0xff;
        }
        return out;
    };
    const bytesToLanes = (bytes: Uint8Array) => {
        if (bytes.length !== LANE_COUNT * 4) {
            throw new Error("anchor: expected " + LANE_COUNT * 4 + " bytes");
        }
        const out = new Uint32Array(LANE_COUNT);
        for (let i = 0; i < LANE_COUNT; i++) {
            const o = 4 * i;
            out[i] =
                (bytes[o] |
                    (bytes[o + 1] << 8) |
                    (bytes[o + 2] << 16) |
                    (bytes[o + 3] << 24)) >>>
                0;
        }
        return out;
    };
    return {
        lanes: LANE_COUNT,
        applyMany(lanes, iv, buf, signs) {
            if (buf.length % ELEMENT !== 0) {
                throw new Error("anchor: digests must be 32 bytes each");
            }
            const n = buf.length / ELEMENT;
            for (let e = 0; e < n; e++) {
                const sign = typeof signs === "number" ? signs : signs[e];
                const w = expand(
                    buf.subarray(e * ELEMENT, e * ELEMENT + ELEMENT),
                    iv
                );
                if (sign > 0) {
                    for (let i = 0; i < LANE_COUNT; i++) lanes[i] += w[i];
                } else {
                    for (let i = 0; i < LANE_COUNT; i++) lanes[i] -= w[i];
                }
            }
        },
        digest(lanes, iv) {
            const hash = crypto.createHash("sha256");
            hash.update(iv);
            hash.update(lanesToBytes(lanes));
            return new Uint8Array(hash.digest());
        },
        lanesToBytes,
        bytesToLanes,
    };
}
