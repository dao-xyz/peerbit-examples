import { sha256Sync } from "@peerbit/crypto";
import { concat, fromString, toString } from "uint8arrays";
import { DIGEST_BYTES } from "./constants.js";

/**
 * Entry hash <-> 32-byte element. Log entry hashes are CIDv1, raw codec,
 * sha2-256, in base58btc ("zb2rh..."); the element is the multihash
 * digest, so a peeled cell is a hash a joiner can pull without a resolve
 * round trip (WRITE_READINESS_V2.md section 4.2).
 */

/** CIDv1 (0x01), raw (0x55), sha2-256 (0x12), 32 bytes (0x20). */
const CID_PREFIX = Uint8Array.of(0x01, 0x55, 0x12, 0x20);
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DIGIT = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) {
    DIGIT[ALPHABET.charCodeAt(i)] = i;
}
const LIMB = 16_777_216; // 2^24
const LIMBS = 12; // 12 x 24 bits = the 36 bytes of prefix and digest
const limbs = new Float64Array(LIMBS);
const FALLBACK_TAG = fromString("shared-fs/readiness/head-fallback/v1:");

/** Heads that did not decode as the standard shape (kept for telemetry). */
export const headDigestStats = { fallbacks: 0 };

/**
 * Fixed-shape base58btc decoder for the standard head: 24-bit limbs, four
 * digits per step (58^4 < 2^24), every product exact in a double. 0.37-0.45
 * µs per head against 2.0-2.6 µs for a generic decode (M0 P4). Writes the
 * digest into `out` and returns false, leaving `out` unspecified, when the
 * head is not the standard shape.
 */
const decodeStandard = (head: string, out: Uint8Array): boolean => {
    const n = head.length;
    if (n < 2 || head.charCodeAt(0) !== 0x7a /* z */) {
        return false;
    }
    limbs.fill(0);
    let i = 1;
    while (i < n) {
        let acc = 0;
        let mul = 1;
        for (let k = 0; k < 4 && i < n; k++, i++) {
            const c = head.charCodeAt(i);
            const v = c < 128 ? DIGIT[c] : -1;
            if (v < 0) {
                return false;
            }
            acc = acc * 58 + v;
            mul *= 58;
        }
        let carry = acc;
        for (let j = 0; j < LIMBS; j++) {
            const x = limbs[j] * mul + carry;
            carry = Math.floor(x / LIMB);
            limbs[j] = x - carry * LIMB;
        }
        if (carry !== 0) {
            return false;
        }
    }
    // limbs[11] holds bytes 0-2 (most significant), limbs[0] bytes 33-35.
    const top = limbs[LIMBS - 1];
    const b1 = limbs[LIMBS - 2];
    if (
        ((top >>> 16) & 0xff) !== CID_PREFIX[0] ||
        ((top >>> 8) & 0xff) !== CID_PREFIX[1] ||
        (top & 0xff) !== CID_PREFIX[2] ||
        ((b1 >>> 16) & 0xff) !== CID_PREFIX[3]
    ) {
        return false;
    }
    for (let j = 0; j < LIMBS; j++) {
        const v = limbs[j];
        const o = 35 - 3 * j - 4; // position in the digest (prefix stripped)
        if (o >= 0) out[o] = v & 0xff;
        if (o - 1 >= 0) out[o - 1] = (v >>> 8) & 0xff;
        if (o - 2 >= 0) out[o - 2] = (v >>> 16) & 0xff;
    }
    // A leading "1" digit would encode a zero byte the limbs cannot hold;
    // the standard prefix starts with 0x01, so a canonical head has none.
    return head.charCodeAt(1) !== 0x31;
};

/**
 * Writes the 32-byte element of `head` into `out` (at offset 0). A head that
 * is not the standard shape maps deterministically to a tagged sha256 of its
 * text and is counted; returns whether the head was standard.
 */
export const headDigestInto = (head: string, out: Uint8Array): boolean => {
    if (decodeStandard(head, out)) {
        return true;
    }
    headDigestStats.fallbacks++;
    out.set(sha256Sync(concat([FALLBACK_TAG, fromString(head)])));
    return false;
};

/** The element of `head` as a new array. */
export const headDigest = (head: string): Uint8Array => {
    const out = new Uint8Array(DIGEST_BYTES);
    headDigestInto(head, out);
    return out;
};

/** The standard head string of an element (inverse of the fast path). */
export const digestToHead = (digest: Uint8Array): string => {
    if (digest.length !== DIGEST_BYTES) {
        throw new Error(`expected a ${DIGEST_BYTES}-byte digest`);
    }
    return "z" + toString(concat([CID_PREFIX, digest]), "base58btc");
};
