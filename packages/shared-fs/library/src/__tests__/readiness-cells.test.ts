import { createCipheriv, createHash, randomBytes } from "node:crypto";
import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAnchorMath } from "../readiness/anchor.js";
import {
    Cells,
    cellIndices,
    cellKey,
    chkL,
    createCellsMath,
    decodeCellsInto,
    digestToLanes,
    emptyRemoteCells,
    encodeCells,
    lanesToDigest,
    peel,
    peelDifference,
    subtractPrefix,
} from "../readiness/cells.js";
import { CELL_BYTES, LANES, M } from "../readiness/constants.js";
import { NAMESPACE_V1, TRUST_V1 } from "../readiness/scopes.js";

/**
 * The maintained cells and the anchor math (M1 plan section 8): a port of
 * the P5 self-test plus golden vectors. The vectors were computed with the
 * P5 prototype (`m0/p5/proto/cells.mjs`); a failure here means the cell
 * format or the expansion drifted, which is a wire change.
 */

const golden = (i: number) =>
    new Uint8Array(
        createHash("sha256")
            .update("readiness-cells-golden-" + i)
            .digest()
    );
const random = () => new Uint8Array(randomBytes(32));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const sha = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");

const [k0, k1] = cellKey("zb2-test-address");
const math = createAnchorMath(crypto as any);

/** Cells and inline lanes of one side. */
const side = () => ({
    cells: new Cells(M, k0, k1),
    lanes: new Uint32Array(LANES),
});
const put = (
    s: ReturnType<typeof side>,
    digest: Uint8Array,
    sign: 1 | -1 = 1
) => {
    s.cells.apply(digest, sign);
    math.applyMany(s.lanes, NAMESPACE_V1.ivTag, digest, sign);
};
const anchorOf = (lanes: Uint32Array) => math.digest(lanes, NAMESPACE_V1.ivTag);

describe("readiness cells", () => {
    it("pins the cell key, checksum, walk and codec (golden vectors)", () => {
        expect([k0, k1]).toEqual([-475717109, -586693766]);
        const out = new Uint32Array(2);
        chkL(digestToLanes(golden(0)), 0, k0, k1, out);
        expect([out[0], out[1]]).toEqual([2825034331, 2183918489]);
        expect(cellIndices(golden(0), k0, k1)).toEqual([
            0, 1, 2, 3, 6, 9, 25, 43, 83, 122, 198, 231, 332, 518, 967, 1578,
            1649,
        ]);

        const cells = new Cells(M, k0, k1);
        for (let i = 0; i < 5; i++) cells.apply(golden(i), 1);
        cells.apply(golden(1), -1);
        const prefix = encodeCells(cells, 0, 4);
        expect(prefix.length).toBe(4 * CELL_BYTES);
        expect(hex(prefix.subarray(0, CELL_BYTES))).toBe(
            "24c45264442ada6b6c3f66b3d4ec6987d51c5bfca3f67953a73bf6d451d2888419707a8fbd745da604000000"
        );
        expect(sha(prefix)).toBe(
            "b11aa2e4107f9ec52a8c5b8b0ea4bf7f6a6f88da3e9e14519800f3bf10b5062a"
        );
        expect(sha(cells.toBytes())).toBe(
            "e5bb5d83db9d7a18bdbdbf2e325165aec6c7aa3db46f3e45682b35838fbcfd0e"
        );
    });

    it("pins the anchor expansion and digest (golden vectors)", () => {
        // AES-256-CTR keyed by the element, IV = the scope's domain tag.
        const lanes = new Uint32Array(LANES);
        math.applyMany(lanes, NAMESPACE_V1.ivTag, golden(0), 1);
        expect([lanes[0], lanes[1], lanes[2], lanes[3]]).toEqual([
            1341555553, 3983405529, 1469337108, 731872923,
        ]);
        expect(sha(math.lanesToBytes(lanes))).toBe(
            "4090ca5dcff32ad9ca1990c6f6ab999737d1dc25537df19d28332c18d37d8ee8"
        );
        // Same keystream as a direct cipher (the IV is the 16-byte tag).
        const direct = createCipheriv(
            "aes-256-ctr",
            golden(0),
            NAMESPACE_V1.ivTag
        ).update(new Uint8Array(LANES * 4));
        expect(sha(direct)).toBe(sha(math.lanesToBytes(lanes)));
        // D = sha256(tag || lanes): the empty set and a pinned set.
        expect(hex(anchorOf(new Uint32Array(LANES)))).toBe(
            createHash("sha256")
                .update(NAMESPACE_V1.ivTag)
                .update(new Uint8Array(LANES * 4))
                .digest("hex")
        );
        const set = new Uint32Array(LANES);
        for (let i = 0; i < 5; i++) {
            math.applyMany(set, NAMESPACE_V1.ivTag, golden(i), 1);
        }
        expect(hex(anchorOf(set))).toBe(
            "0dc5876f7cee5a2c62489f4a26a54104f6fca1d2baa1c7970ad14306a4c963c2"
        );
        // Scopes are separate domains.
        const trust = new Uint32Array(LANES);
        for (let i = 0; i < 5; i++) {
            math.applyMany(trust, TRUST_V1.ivTag, golden(i), 1);
        }
        expect(hex(math.digest(trust, TRUST_V1.ivTag))).not.toBe(
            hex(anchorOf(set))
        );
    });

    it("peels both differences at d = 0..1,000 and certifies J - X + E == R", () => {
        for (const [base, d, x] of [
            [1000, 0, 0],
            [1000, 3, 0],
            [1000, 10, 10],
            [5000, 200, 50],
            [100, 1000, 0],
        ]) {
            const R = side();
            const J = side();
            const common = Array.from({ length: base }, random);
            const onlyR = Array.from({ length: d }, random);
            const onlyJ = Array.from({ length: x }, random);
            for (const h of common) {
                put(R, h);
                put(J, h);
            }
            for (const h of onlyR) put(R, h);
            for (const h of onlyJ) put(J, h);

            // R's prefix over the wire, grown x4 until it decodes.
            let m = Math.min(
                M,
                Math.max(64, Math.ceil((1.8 * (d + x)) / 32) * 32)
            );
            const received = emptyRemoteCells();
            decodeCellsInto(received, 0, encodeCells(R.cells, 0, m));
            let result = peelDifference(received, J.cells, m);
            while (!result.ok && m < M) {
                m = Math.min(M, 4 * m);
                decodeCellsInto(received, 0, encodeCells(R.cells, 0, m));
                result = peelDifference(received, J.cells, m);
            }
            expect(result.ok, `base=${base} d=${d} x=${x}`).toBe(true);
            expect(received.have).toBe(m);
            expect(new Set(result.plus.map(hex))).toEqual(
                new Set(onlyR.map(hex))
            );
            expect(new Set(result.minus.map(hex))).toEqual(
                new Set(onlyJ.map(hex))
            );

            const certificate = J.lanes.slice();
            for (const h of onlyJ) {
                math.applyMany(certificate, NAMESPACE_V1.ivTag, h, -1);
            }
            for (const h of onlyR) {
                math.applyMany(certificate, NAMESPACE_V1.ivTag, h, 1);
            }
            expect(hex(anchorOf(certificate))).toBe(hex(anchorOf(R.lanes)));
        }
    });

    it("grows a stalled prefix x4 until it decodes", () => {
        const R = side();
        const J = side();
        const onlyR = Array.from({ length: 200 }, random);
        for (const h of onlyR) put(R, h);
        // 64 cells cannot hold 200 elements; 4 x 64 x 4 = 1,024 can.
        const sizes: number[] = [];
        let m = 64;
        let result = peelDifference(R.cells, J.cells, m);
        sizes.push(m);
        while (!result.ok && m < M) {
            m = Math.min(M, 4 * m);
            sizes.push(m);
            result = peelDifference(R.cells, J.cells, m);
        }
        expect(result.ok).toBe(true);
        expect(sizes[0]).toBe(64);
        expect(sizes.length).toBeGreaterThan(1);
        expect(result.plus.length).toBe(200);
    });

    it("removal is the exact inverse of insertion", () => {
        const S = side();
        const hashes = Array.from({ length: 50 }, random);
        for (const h of hashes) put(S, h);
        expect(S.cells.isEmpty()).toBe(false);
        for (const h of hashes) put(S, h, -1);
        expect(S.cells.isEmpty()).toBe(true);
        expect(hex(anchorOf(S.lanes))).toBe(
            hex(anchorOf(new Uint32Array(LANES)))
        );
    });

    it("a different set never certifies", () => {
        const R = side();
        const J = side();
        for (let i = 0; i < 100; i++) {
            const h = random();
            put(R, h);
            if (i) put(J, h);
        }
        expect(hex(anchorOf(J.lanes))).not.toBe(hex(anchorOf(R.lanes)));
        // Equal counts, one element swapped.
        put(J, random());
        expect(hex(anchorOf(J.lanes))).not.toBe(hex(anchorOf(R.lanes)));
    });

    it("copies, subtracts and round-trips the 44-byte codec", () => {
        const cells = new Cells(M, k0, k1);
        for (let i = 0; i < 20; i++) cells.apply(golden(i), 1);
        const copy = cells.copy();
        cells.apply(golden(99), 1);
        // The copy is a snapshot: later applies do not reach it.
        expect(hex(encodeCells(copy, 0, M))).not.toBe(
            hex(encodeCells(cells, 0, M))
        );
        const restored = new Cells(M, k0, k1);
        restored.restore(cells.toBytes());
        expect(hex(restored.toBytes())).toBe(hex(cells.toBytes()));
        expect(() => restored.restore(new Uint8Array(10))).toThrow();

        const difference = subtractPrefix(cells, copy, M);
        const result = peel(difference, M, k0, k1);
        expect(result.ok).toBe(true);
        expect(result.plus.map(hex)).toEqual([hex(golden(99))]);
        expect(result.minus).toEqual([]);

        expect(hex(lanesToDigest(digestToLanes(golden(7))))).toBe(
            hex(golden(7))
        );
        expect(() =>
            decodeCellsInto(emptyRemoteCells(), 0, new Uint8Array(45))
        ).toThrow();
        expect(() =>
            decodeCellsInto(emptyRemoteCells(), M, new Uint8Array(CELL_BYTES))
        ).toThrow();

        cells.reset();
        expect(cells.isEmpty()).toBe(true);
    });

    it("the worker's cells upkeep matches Cells exactly", () => {
        const cellsMath = createCellsMath();
        const kept = cellsMath.create(M);
        const cells = new Cells(M, k0, k1);
        for (let i = 0; i < 5; i++) {
            cells.apply(golden(i), 1);
            cellsMath.applyMany(kept, k0, k1, golden(i), 1);
        }
        cells.apply(golden(1), -1);
        cellsMath.applyMany(kept, k0, k1, golden(1), -1);
        // The golden set above, byte for byte.
        expect(sha(cellsMath.toBytes(kept))).toBe(sha(cells.toBytes()));
        // Batches with mixed signs, and counts below zero.
        const batch = Array.from({ length: 300 }, random);
        const buf = new Uint8Array(32 * batch.length);
        const signs = new Int8Array(batch.length);
        batch.forEach((digest, i) => {
            buf.set(digest, 32 * i);
            signs[i] = i % 3 === 0 ? -1 : 1;
            cells.apply(digest, signs[i] as 1 | -1);
        });
        cellsMath.applyMany(kept, k0, k1, buf, signs);
        expect(hex(cellsMath.toBytes(kept))).toBe(hex(cells.toBytes()));
        expect(
            hex(cellsMath.toBytes(cellsMath.fromBytes(cells.toBytes())))
        ).toBe(hex(cells.toBytes()));
        expect(() => cellsMath.fromBytes(new Uint8Array(45))).toThrow();
        expect(() =>
            cellsMath.applyMany(kept, k0, k1, new Uint8Array(33), 1)
        ).toThrow();
    });

    it("touches about 15 cells per element at M = 4,096", () => {
        let total = 0;
        for (let i = 0; i < 1000; i++) {
            total += cellIndices(golden(i), k0, k1).length;
        }
        const mean = total / 1000;
        expect(mean).toBeGreaterThan(10);
        expect(mean).toBeLessThan(20);
    });
});
