import { describe, expect, it } from "vitest";
import {
    PROOF_MAX_RECORDS,
    buildProof,
    formatHlc,
    hlcProvedOf,
    parseHlcProved,
    validateProof,
    type ContainedInput,
    type Proof,
} from "../readiness/proof.js";
import { SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1 } from "../readiness/scopes.js";

/**
 * The readiness proof (M1 plan section 7.3, design 4.10): bounded and
 * deterministic records, a shape check that never throws, `hlcProved` as a
 * hint that reads as 0 when malformed, and the trust results an
 * access-controlled store's records carry (PR-3 commit 4, SPEC4 G4-2).
 */

const U64_MAX = (1n << 64n) - 1n;

const anchor = (fill: number) => new Uint8Array(32).fill(fill);

const contained = (
    peer: string,
    overrides: Partial<ContainedInput> = {}
): ContainedInput => ({
    peer,
    scope: SCOPE_NAMESPACE_V1,
    source: "reconciled",
    qualified: false,
    count: 10,
    hlc: 100n,
    anchor: anchor(1),
    ...overrides,
});

const peerName = (i: number) => `peer-${String(i).padStart(3, "0")}`;

/** A small valid proof as JSON would carry it. */
const sample = (): Proof =>
    buildProof({
        scopes: [SCOPE_TRUST_V1, SCOPE_NAMESPACE_V1],
        contained: [
            contained("a", { qualified: true, source: "creator" }),
            contained("a", { scope: SCOPE_TRUST_V1, hlc: 5n }),
        ],
        excluded: [{ peer: "b", reason: "inconsistent" }],
        gaps: [{ peer: "c", missing: 3 }],
    });

const json = (proof: Proof): any => JSON.parse(JSON.stringify(proof));

describe("readiness proof", () => {
    describe("buildProof", () => {
        it("cuts each array to 32 records and keeps the qualified one", () => {
            const input = {
                scopes: [SCOPE_NAMESPACE_V1] as const,
                // The one qualified record would sort last by every other key.
                contained: [
                    ...Array.from({ length: 40 }, (_, i) =>
                        contained(peerName(i), { hlc: BigInt(1000 + i) })
                    ),
                    contained("zzz-qualified", { qualified: true, hlc: 1n }),
                ],
                excluded: Array.from({ length: 40 }, (_, i) => ({
                    peer: peerName(i),
                    reason: "unsubstantiated" as const,
                })),
                gaps: Array.from({ length: 40 }, (_, i) => ({
                    peer: peerName(i),
                    missing: i,
                })),
            };
            const proof = buildProof(input);
            expect(proof.contained).toHaveLength(PROOF_MAX_RECORDS);
            expect(proof.excluded).toHaveLength(PROOF_MAX_RECORDS);
            expect(proof.gaps).toHaveLength(PROOF_MAX_RECORDS);
            expect(proof.contained[0]).toMatchObject({
                peer: "zzz-qualified",
                qualified: true,
                hlc: "1",
            });
            // The rest by higher hlc: the 31 newest unqualified records.
            expect(proof.contained.slice(1).map(({ hlc }) => hlc)).toEqual(
                Array.from({ length: 31 }, (_, i) => String(1039 - i))
            );
            expect(proof.excluded.map(({ peer }) => peer)).toEqual(
                Array.from({ length: 32 }, (_, i) => peerName(i))
            );
            expect(validateProof(json(proof))).toEqual({ ok: true, proof });
        });

        it("orders records deterministically: qualified, namespace, higher hlc, peer", () => {
            const records = [
                contained("d", { scope: SCOPE_TRUST_V1, hlc: 900n }),
                contained("c", { hlc: 50n }),
                contained("b", { hlc: 50n }),
                contained("a", { hlc: 10n }),
                contained("e", { qualified: true, hlc: 1n }),
                contained("f", {
                    qualified: true,
                    scope: SCOPE_TRUST_V1,
                    hlc: 999n,
                }),
            ];
            const expected = ["e", "f", "b", "c", "a", "d"];
            for (let round = 0; round < 10; round++) {
                // A deterministic shuffle of the input.
                const shuffled = [...records].sort(
                    (x, y) =>
                        ((x.peer.charCodeAt(0) * (round + 3)) % 7) -
                        ((y.peer.charCodeAt(0) * (round + 3)) % 7)
                );
                const proof = buildProof({
                    scopes: [SCOPE_TRUST_V1, SCOPE_NAMESPACE_V1],
                    contained: shuffled,
                    excluded: [
                        { peer: "y", reason: "inconsistent" },
                        { peer: "x", reason: "unsubstantiated" },
                    ],
                    gaps: [
                        { peer: "y", missing: "unknown" },
                        { peer: "x", missing: 2 },
                    ],
                });
                expect(proof.contained.map(({ peer }) => peer)).toEqual(
                    expected
                );
                expect(proof.scopes).toEqual(["namespace-v1", "trust-v1"]);
                expect(proof.excluded.map(({ peer }) => peer)).toEqual([
                    "x",
                    "y",
                ]);
                expect(proof.gaps.map(({ peer }) => peer)).toEqual(["x", "y"]);
            }
        });

        it("breaks every tie, so equal keys keep one order whatever the input order", () => {
            // Same peer, scope, qualification and hlc: only the anchor
            // differs. Same peer excluded twice, and a gap twice.
            const records = [
                contained("a", { anchor: anchor(2) }),
                contained("a", { anchor: anchor(1) }),
            ];
            const excluded = [
                { peer: "a", reason: "unsubstantiated" as const },
                { peer: "a", reason: "inconsistent" as const },
            ];
            const gaps = [
                { peer: "a", missing: "unknown" as const },
                { peer: "a", missing: 3 },
            ];
            const build = (reverse: boolean) => {
                const order = <T>(values: T[]) =>
                    reverse ? [...values].reverse() : values;
                return buildProof({
                    scopes: [SCOPE_NAMESPACE_V1],
                    contained: order(records),
                    excluded: order(excluded),
                    gaps: order(gaps),
                });
            };
            const forward = build(false);
            expect(build(true)).toEqual(forward);
            expect(forward.contained.map((record) => record.anchor)).toEqual([
                "01".repeat(32),
                "02".repeat(32),
            ]);
            expect(forward.excluded.map(({ reason }) => reason)).toEqual([
                "inconsistent",
                "unsubstantiated",
            ]);
            expect(forward.gaps.map(({ missing }) => missing)).toEqual([
                3,
                "unknown",
            ]);
        });

        it("formats hlc as a decimal u64 and the anchor as lowercase hex", () => {
            const proof = buildProof({
                scopes: [SCOPE_NAMESPACE_V1],
                contained: [
                    contained("a", {
                        hlc: U64_MAX,
                        anchor: Uint8Array.from({ length: 32 }, (_, i) =>
                            i === 0 ? 0xab : i
                        ),
                        count: 0xffff_ffff,
                    }),
                ],
                excluded: [],
                gaps: [],
            });
            expect(proof.contained[0].hlc).toBe("18446744073709551615");
            expect(proof.contained[0].anchor).toBe(
                "ab0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
            );
            expect(formatHlc(1234n)).toBe("1234");
            expect(validateProof(json(proof)).ok).toBe(true);
        });
    });

    describe("validateProof", () => {
        it("accepts what buildProof built and copies only known keys", () => {
            const proof = sample();
            expect(validateProof(json(proof))).toEqual({ ok: true, proof });
            const extended = {
                ...json(proof),
                extra: 1,
                contained: json(proof).contained.map((record: any) => ({
                    ...record,
                    extra: "x",
                })),
            };
            const result = validateProof(extended);
            expect(result).toEqual({ ok: true, proof });
            if (result.ok) {
                expect("extra" in result.proof).toBe(false);
                expect("extra" in result.proof.contained[0]).toBe(false);
            }
        });

        it("rejects every malformed shape", () => {
            const bad: Array<[string, (value: any) => void]> = [
                ["version 2", (v) => (v.v = 2)],
                ["version as a string", (v) => (v.v = "1")],
                ["no scopes", (v) => (v.scopes = [])],
                ["an unknown scope", (v) => (v.scopes = ["files-v1"])],
                [
                    "a repeated scope",
                    (v) => {
                        // Namespace records only, so the scope list alone
                        // is wrong.
                        v.scopes = ["namespace-v1", "namespace-v1"];
                        v.contained = v.contained.filter(
                            (record: any) => record.scope === "namespace-v1"
                        );
                    },
                ],
                [
                    "three scopes",
                    (v) =>
                        (v.scopes = ["namespace-v1", "trust-v1", "trust-v1"]),
                ],
                ["missing contained", (v) => delete v.contained],
                ["missing excluded", (v) => delete v.excluded],
                ["missing gaps", (v) => delete v.gaps],
                ["contained not an array", (v) => (v.contained = {})],
                [
                    "33 contained records",
                    (v) =>
                        (v.contained = Array.from(
                            { length: 33 },
                            () => v.contained[0]
                        )),
                ],
                [
                    "33 excluded records",
                    (v) =>
                        (v.excluded = Array.from(
                            { length: 33 },
                            () => v.excluded[0]
                        )),
                ],
                [
                    "33 gaps",
                    (v) =>
                        (v.gaps = Array.from({ length: 33 }, () => v.gaps[0])),
                ],
                ["a null record", (v) => (v.contained[0] = null)],
                ["a short anchor", (v) => (v.contained[0].anchor = "ab")],
                [
                    "an uppercase anchor",
                    (v) =>
                        (v.contained[0].anchor =
                            "AB" + v.contained[0].anchor.slice(2)),
                ],
                ["a hex hlc", (v) => (v.contained[0].hlc = "0x10")],
                ["a negative hlc", (v) => (v.contained[0].hlc = "-1")],
                ["an hlc as a number", (v) => (v.contained[0].hlc = 5)],
                [
                    "an hlc above u64",
                    (v) => (v.contained[0].hlc = "18446744073709551616"),
                ],
                [
                    "an hlc of 21 digits",
                    (v) => (v.contained[0].hlc = "000000000000000000001"),
                ],
                ["an unknown source", (v) => (v.contained[0].source = "peer")],
                [
                    "qualified as a string",
                    (v) => (v.contained[0].qualified = "true"),
                ],
                ["a fractional count", (v) => (v.contained[0].count = 1.5)],
                ["a negative count", (v) => (v.contained[0].count = -1)],
                ["a count above u32", (v) => (v.contained[0].count = 2 ** 32)],
                ["an empty peer", (v) => (v.contained[0].peer = "")],
                [
                    "a peer of 129 characters",
                    (v) => (v.contained[0].peer = "p".repeat(129)),
                ],
                [
                    "a scope not listed",
                    (v) => {
                        v.scopes = ["namespace-v1"];
                        v.contained[1].scope = "trust-v1";
                    },
                ],
                ["an unknown reason", (v) => (v.excluded[0].reason = "silent")],
                ["a gap of -1", (v) => (v.gaps[0].missing = -1)],
                ["a gap as text", (v) => (v.gaps[0].missing = "many")],
            ];
            for (const [name, mutate] of bad) {
                const value = json(sample());
                mutate(value);
                const result = validateProof(value);
                expect(result.ok, name).toBe(false);
            }
            // The bounds themselves are accepted.
            const edge = json(sample());
            edge.contained[0].hlc = "18446744073709551615";
            edge.contained[0].count = 0xffff_ffff;
            edge.contained[0].peer = "p".repeat(128);
            edge.gaps[0].missing = "unknown";
            expect(validateProof(edge).ok).toBe(true);
        });

        it("never throws on arbitrary values", () => {
            const hostile = new Proxy(
                {},
                {
                    get() {
                        throw new Error("trap");
                    },
                }
            );
            const values: unknown[] = [
                undefined,
                null,
                0,
                "proof",
                [],
                [1, 2],
                { v: 1 },
                { v: 1, scopes: "namespace-v1" },
                { v: 1, scopes: ["namespace-v1"], contained: [1] },
                hostile,
                { ...json(sample()), contained: [hostile] },
            ];
            // A seeded random walk over JSON-like shapes.
            let seed = 7;
            const random = () => {
                seed = (seed * 1103515245 + 12345) & 0x7fffffff;
                return seed / 0x7fffffff;
            };
            const anyValue = (depth: number): unknown => {
                const pick = Math.floor(random() * 7);
                if (depth > 3 || pick === 0) return null;
                if (pick === 1) return Math.floor(random() * 1e6) - 5e5;
                if (pick === 2) return String(random());
                if (pick === 3) return random() < 0.5;
                if (pick === 4) {
                    return Array.from(
                        { length: Math.floor(random() * 4) },
                        () => anyValue(depth + 1)
                    );
                }
                const out: Record<string, unknown> = {};
                for (const key of [
                    "v",
                    "scopes",
                    "contained",
                    "excluded",
                    "gaps",
                    "peer",
                    "hlc",
                ]) {
                    if (random() < 0.5) out[key] = anyValue(depth + 1);
                }
                return out;
            };
            for (let i = 0; i < 500; i++) values.push(anyValue(0));
            for (const value of values) {
                expect(() => validateProof(value)).not.toThrow();
                expect(validateProof(value).ok).toBe(false);
            }
        });
    });

    describe("trust results (G4-2)", () => {
        /** An access-controlled proof: a trusted donor, an untrusted one. */
        const aclProof = () =>
            buildProof({
                scopes: [SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1],
                contained: [
                    contained("a", {
                        qualified: true,
                        source: "creator",
                        identity: "trusted",
                        untrusted: 3,
                    }),
                    contained("a", {
                        scope: SCOPE_TRUST_V1,
                        qualified: true,
                        source: "creator",
                        identity: "trusted",
                    }),
                    contained("b", { identity: "untrusted" }),
                ],
                excluded: [],
                gaps: [],
            });

        it("buildProof writes identity and untrusted, and validateProof round-trips them", () => {
            const proof = aclProof();
            expect(proof.contained).toEqual([
                expect.objectContaining({
                    peer: "a",
                    scope: "namespace-v1",
                    identity: "trusted",
                    untrusted: 3,
                }),
                expect.objectContaining({
                    peer: "a",
                    scope: "trust-v1",
                    identity: "trusted",
                }),
                expect.objectContaining({ peer: "b", identity: "untrusted" }),
            ]);
            // `untrusted` only above 0, so the trust records carry none.
            expect(proof.contained[1]).not.toHaveProperty("untrusted");
            expect(proof.contained[2]).not.toHaveProperty("untrusted");
            expect(validateProof(json(proof))).toEqual({ ok: true, proof });
            // The u32 bound itself is accepted.
            const edge = json(proof);
            edge.contained[0].untrusted = 0xffff_ffff;
            const checked = validateProof(edge);
            expect(checked.ok).toBe(true);
            if (checked.ok) {
                expect(checked.proof.contained[0].untrusted).toBe(0xffff_ffff);
            }
        });

        it("open mode, a check still running and no untrusted heads write neither key", () => {
            const proof = buildProof({
                scopes: [SCOPE_NAMESPACE_V1],
                contained: [
                    contained("a", { qualified: true }),
                    contained("b", { identity: undefined, untrusted: 0 }),
                ],
                excluded: [],
                gaps: [],
            });
            for (const record of proof.contained) {
                expect(record).not.toHaveProperty("identity");
                expect(record).not.toHaveProperty("untrusted");
            }
            expect(validateProof(json(proof))).toEqual({ ok: true, proof });
            // Values the coordinator never passes are not written either.
            const odd = buildProof({
                scopes: [SCOPE_NAMESPACE_V1],
                contained: [
                    contained("a", {
                        identity: "checking" as any,
                        untrusted: -1,
                    }),
                    contained("b", { untrusted: 1.5 }),
                    contained("c", { untrusted: 2 ** 32 }),
                ],
                excluded: [],
                gaps: [],
            });
            for (const record of odd.contained) {
                expect(record).not.toHaveProperty("identity");
                expect(record).not.toHaveProperty("untrusted");
            }
        });

        it("rejects a bad identity or untrusted as malformed", () => {
            const bad: Array<[string, (value: any) => void]> = [
                [
                    "identity checking",
                    (v) => (v.contained[0].identity = "checking"),
                ],
                [
                    "identity as a boolean",
                    (v) => (v.contained[0].identity = true),
                ],
                ["identity null", (v) => (v.contained[0].identity = null)],
                [
                    "untrusted as a string",
                    (v) => (v.contained[0].untrusted = "3"),
                ],
                ["untrusted negative", (v) => (v.contained[0].untrusted = -1)],
                [
                    "untrusted fractional",
                    (v) => (v.contained[0].untrusted = 1.5),
                ],
                [
                    "untrusted above u32",
                    (v) => (v.contained[0].untrusted = 2 ** 32),
                ],
                ["untrusted null", (v) => (v.contained[0].untrusted = null)],
            ];
            for (const [name, mutate] of bad) {
                const value = json(aclProof());
                mutate(value);
                expect(validateProof(value).ok, name).toBe(false);
            }
            // Absent keys are fine: a record of a check still running.
            const value = json(aclProof());
            delete value.contained[0].identity;
            delete value.contained[0].untrusted;
            const checked = validateProof(value);
            expect(checked.ok).toBe(true);
            if (checked.ok) {
                expect(checked.proof.contained[0]).not.toHaveProperty(
                    "identity"
                );
                expect(checked.proof.contained[0]).not.toHaveProperty(
                    "untrusted"
                );
            }
        });
    });

    describe("hlcProved", () => {
        it("hlcProvedOf is the highest namespace hlc, 0 without one", () => {
            const proof = buildProof({
                scopes: [SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1],
                contained: [
                    contained("a", { hlc: 40n }),
                    contained("b", { hlc: 70n, qualified: true }),
                    contained("c", { scope: SCOPE_TRUST_V1, hlc: 500n }),
                ],
                excluded: [],
                gaps: [],
            });
            expect(hlcProvedOf(proof)).toBe(70n);
            // The highest, not the first: a qualified record sorts first.
            expect(
                hlcProvedOf(
                    buildProof({
                        scopes: [SCOPE_NAMESPACE_V1],
                        contained: [
                            contained("a", { hlc: 90n }),
                            contained("b", { hlc: 10n, qualified: true }),
                        ],
                        excluded: [],
                        gaps: [],
                    })
                )
            ).toBe(90n);
            expect(
                hlcProvedOf(
                    buildProof({
                        scopes: [SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1],
                        contained: [
                            contained("c", { scope: SCOPE_TRUST_V1, hlc: 9n }),
                        ],
                        excluded: [],
                        gaps: [],
                    })
                )
            ).toBe(0n);
        });

        it("parseHlcProved reads a decimal u64 and anything else as 0", () => {
            expect(parseHlcProved("123")).toBe(123n);
            expect(parseHlcProved("0")).toBe(0n);
            expect(parseHlcProved("18446744073709551615")).toBe(U64_MAX);
            for (const value of [
                "18446744073709551616",
                "99999999999999999999",
                "-1",
                "1.5",
                " 1",
                "1e3",
                "0x10",
                "+1",
                "1+1",
                "",
                "abc",
                5,
                5n,
                null,
                undefined,
                {},
                ["1"],
            ]) {
                expect(parseHlcProved(value), String(value)).toBe(0n);
            }
        });
    });
});
