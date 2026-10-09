import {
    calculateRawCid,
    cidifyString,
    stringifyCid,
} from "@peerbit/blocks-interface";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
    digestToHead,
    headDigest,
    headDigestInto,
    headDigestStats,
} from "../readiness/digest.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("readiness head digest", () => {
    it("decodes 50k standard heads exactly like the generic decoder", async () => {
        const fallbacks = headDigestStats.fallbacks;
        const out = new Uint8Array(40).fill(0xee);
        let mismatches = 0;
        for (let i = 0; i < 50_000; i++) {
            // Entry hashes are raw-codec CIDv1 over sha2-256, as Peerbit's
            // log computes them.
            const { cid: head } = await calculateRawCid(
                randomBytes(1 + (i % 64))
            );
            const expected = cidifyString(head).multihash.digest;
            if (hex(headDigest(head)) !== hex(expected)) mismatches++;
            expect(headDigestInto(head, out)).toBe(true);
            if (hex(out.subarray(0, 32)) !== hex(expected)) mismatches++;
            if (digestToHead(expected) !== head) mismatches++;
        }
        expect(mismatches).toBe(0);
        expect(out.subarray(32).every((byte) => byte === 0xee)).toBe(true);
        expect(headDigestStats.fallbacks).toBe(fallbacks);
    });

    it("covers the extreme digests", async () => {
        for (const fill of [0x00, 0xff]) {
            const digest = new Uint8Array(32).fill(fill);
            const head = digestToHead(digest);
            expect(head.startsWith("zb2rh")).toBe(true);
            expect(hex(headDigest(head))).toBe(hex(digest));
            expect(hex(cidifyString(head).multihash.digest)).toBe(hex(digest));
        }
        expect(() => digestToHead(new Uint8Array(31))).toThrow();
    });

    it("maps a non-standard head to a deterministic fallback", async () => {
        const { cid: standard } = await calculateRawCid(Uint8Array.of(1, 2, 3));
        const cid = cidifyString(standard);
        const CID = cid.constructor as any;
        const nonStandard = [
            // CIDv0 (base58btc multihash, no multibase prefix)
            CID.createV0(cid.multihash).toString(),
            // dag-cbor CIDv1 (codec 0x71) in base58btc: right length, wrong
            // prefix
            stringifyCid(CID.createV1(0x71, cid.multihash)),
            // a leading "1" encodes a zero byte the standard shape never has
            "z1" + standard.slice(1),
            // one more digit overflows 36 bytes
            standard + "1",
            // characters outside the alphabet
            standard.slice(0, -1) + "0",
            standard.replace("z", "b"),
            "z",
            "",
            "zé",
        ];
        const seen = new Set<string>([hex(headDigest(standard))]);
        for (const head of nonStandard) {
            const before = headDigestStats.fallbacks;
            const out = new Uint8Array(32);
            expect(headDigestInto(head, out)).toBe(false);
            expect(headDigestStats.fallbacks).toBe(before + 1);
            expect(hex(headDigest(head))).toBe(hex(out));
            seen.add(hex(out));
        }
        // Every fallback is distinct from the others and from real digests.
        expect(seen.size).toBe(nonStandard.length + 1);
    });
});
