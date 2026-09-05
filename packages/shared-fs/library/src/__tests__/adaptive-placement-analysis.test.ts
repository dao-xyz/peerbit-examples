import { describe, expect, it } from "vitest";
import {
    analyzePlacement,
    comparePlacement,
    type PlacementMetadata,
    type PlacementSnapshot,
} from "./adaptive-placement-analysis.js";

const metadata: PlacementMetadata[] = [
    {
        id: "file-a",
        chunkIds: ["small", "large"],
        chunkBytes: [2, 8],
        bytes: 10,
        hash: "hash-a",
    },
];
const snapshot = (
    peer: number,
    overrides: Partial<PlacementSnapshot> = {}
): PlacementSnapshot => ({
    peer,
    role: "custodian",
    capacityBytes: 12,
    participation: 1,
    localLogBytes: 15,
    chunks: [
        { id: "small", bytes: 2 },
        { id: "large", bytes: 8 },
    ],
    metadata,
    ...overrides,
});
const analyze = (
    peers: PlacementSnapshot[],
    expected = metadata,
    minCopies = 2
) => analyzePlacement(peers, expected, { minCopies });

describe("adaptive placement snapshot analysis", () => {
    it("counts distinct custodians, not the publisher, and leaves inputs untouched", () => {
        const peers = [
            snapshot(2),
            snapshot(0, { role: "publisher" }),
            snapshot(1),
        ];
        const original = structuredClone({ peers, metadata });
        const report = analyze(peers);
        expect(
            report.copiesByChunk.map((chunk) => [
                chunk.id,
                chunk.copies,
                chunk.custodians,
            ])
        ).toEqual([
            ["large", 2, [1, 2]],
            ["small", 2, [1, 2]],
        ]);
        expect(report.belowMinCopies).toEqual([]);
        expect(report.coverage.minCopies).toEqual({
            chunks: 2,
            bytes: 10,
            countFraction: 1,
            byteFraction: 1,
        });
        expect(report.missingMetadataByPeer).toEqual([
            { peer: 0, ids: [] },
            { peer: 1, ids: [] },
            { peer: 2, ids: [] },
        ]);
        expect({ peers, metadata }).toEqual(original);
        expect(report.semantics).toContain("not network bytes or proof");
    });

    it("separates metadata gaps from count and byte-weighted custody coverage", () => {
        const report = analyze([
            snapshot(0, { role: "publisher" }),
            snapshot(1),
            snapshot(2, { metadata: [], chunks: [{ id: "small", bytes: 2 }] }),
        ]);
        expect(report.missingMetadataByPeer[2]).toEqual({
            peer: 2,
            ids: ["file-a"],
        });
        expect(report.coverage.anyCustodian).toEqual({
            chunks: 2,
            bytes: 10,
            countFraction: 1,
            byteFraction: 1,
        });
        expect(report.coverage.minCopies).toEqual({
            chunks: 1,
            bytes: 2,
            countFraction: 0.5,
            byteFraction: 0.2,
        });
        expect(report.belowMinCopies.map((chunk) => chunk.id)).toEqual([
            "large",
        ]);
    });

    it("deduplicates overlapping files and repeated file chunks", () => {
        const expected = [
            ...metadata,
            {
                id: "file-b",
                chunkIds: ["small", "small"],
                chunkBytes: [2, 2],
                bytes: 4,
                hash: "hash-b",
            },
        ];
        const report = analyze(
            [snapshot(1, { metadata: expected })],
            expected,
            1
        );
        expect(report.expectedMetadataCount).toBe(2);
        expect(report.expectedChunkCount).toBe(2);
        expect(report.expectedUniquePayloadBytes).toBe(10);
        expect(report.peers[0].logicalPayloadBytes).toBe(10);
    });

    it("does not treat publisher-only bytes as remote custody", () => {
        const report = analyze([snapshot(0, { role: "publisher" })]);
        expect(report.coverage.anyCustodian).toEqual({
            chunks: 0,
            bytes: 0,
            countFraction: 0,
            byteFraction: 0,
        });
        expect(report.copiesByChunk.every((chunk) => chunk.copies === 0)).toBe(
            true
        );
        expect(report.peers[0].logicalPayloadBytes).toBe(10);
    });

    it("reports empty and zero-byte inventories without fabricated ratios", () => {
        expect(analyze([], []).coverage.minCopies).toEqual({
            chunks: 0,
            bytes: 0,
            countFraction: null,
            byteFraction: null,
        });
        const empty = [
            {
                id: "empty",
                chunkIds: ["zero"],
                chunkBytes: [0],
                bytes: 0,
                hash: "zero-hash",
            },
        ];
        const report = analyze(
            [
                snapshot(1, {
                    metadata: empty,
                    chunks: [{ id: "zero", bytes: 0 }],
                }),
            ],
            empty,
            1
        );
        expect(report.coverage.minCopies).toEqual({
            chunks: 1,
            bytes: 0,
            countFraction: 1,
            byteFraction: null,
        });
        expect(analyze([], metadata).belowMinCopies).toHaveLength(2);
    });

    it("reports soft-target overage separately for payload and log bytes", () => {
        const report = analyze([
            snapshot(1, { capacityBytes: 3, participation: 0.25 }),
            snapshot(2, { capacityBytes: null }),
        ]);
        expect(report.peers[0]).toMatchObject({
            logicalPayloadBytes: 10,
            localLogBytes: 15,
            payloadTargetOverageBytes: 7,
            logTargetOverageBytes: 12,
            participation: 0.25,
        });
        expect(report.peers[1]).toMatchObject({
            payloadTargetOverageBytes: null,
            logTargetOverageBytes: null,
        });
        expect(report.capacitySemantics).toContain(
            "not an enforced hard quota"
        );
    });

    it("rejects duplicate identities and local IDs", () => {
        expect(() => analyze([snapshot(1), snapshot(1)])).toThrow(
            /Duplicate peer/
        );
        expect(() =>
            analyze([
                snapshot(1, {
                    chunks: [
                        { id: "small", bytes: 2 },
                        { id: "small", bytes: 2 },
                    ],
                }),
            ])
        ).toThrow(/Duplicate local chunk/);
        expect(() =>
            analyze([snapshot(1, { metadata: [...metadata, ...metadata] })])
        ).toThrow(/Duplicate local metadata/);
        expect(() => analyze([], [...metadata, ...metadata])).toThrow(
            /Duplicate expected metadata/
        );
    });

    it("rejects unknown chunks, unknown metadata, and inconsistent manifests", () => {
        expect(() =>
            analyze([snapshot(1, { chunks: [{ id: "unknown", bytes: 1 }] })])
        ).toThrow(/Unknown chunk/);
        expect(() =>
            analyze([
                snapshot(1, { metadata: [{ ...metadata[0], id: "unknown" }] }),
            ])
        ).toThrow(/Unknown metadata/);
        expect(() =>
            analyze([
                snapshot(1, {
                    metadata: [{ ...metadata[0], hash: "different" }],
                }),
            ])
        ).toThrow(/Conflicting metadata/);
        expect(() =>
            analyze(
                [],
                [
                    ...metadata,
                    {
                        id: "file-b",
                        chunkIds: ["small"],
                        chunkBytes: [3],
                        bytes: 3,
                        hash: "hash-b",
                    },
                ]
            )
        ).toThrow(/Conflicting chunk size/);
        expect(() =>
            analyze([], [{ ...metadata[0], chunkBytes: [2] }])
        ).toThrow(/Misaligned/);
        expect(() => analyze([], [{ ...metadata[0], bytes: 11 }])).toThrow(
            /file size mismatch/
        );
    });

    it("rejects invalid counts and nonfinite stats", () => {
        for (const bad of [
            -1,
            0.5,
            NaN,
            Infinity,
            Number.MAX_SAFE_INTEGER + 1,
        ]) {
            for (const field of [
                "peer",
                "capacityBytes",
                "localLogBytes",
            ] as const) {
                expect(() =>
                    analyze([snapshot(1, { [field]: bad })])
                ).toThrow();
            }
            expect(() =>
                analyze([
                    snapshot(1, { chunks: [{ id: "small", bytes: bad }] }),
                ])
            ).toThrow();
            expect(() =>
                analyzePlacement([], [], { minCopies: bad })
            ).toThrow();
        }
        for (const participation of [-1, NaN, Infinity]) {
            expect(() => analyze([snapshot(1, { participation })])).toThrow(
                /Participation/
            );
        }
        expect(() => analyzePlacement([], [], { minCopies: 0 })).toThrow(
            /positive/
        );
        expect(() =>
            analyze([snapshot(1, { role: "other" as "custodian" })])
        ).toThrow(/role/);
    });
});

describe("adaptive placement comparison", () => {
    it("reports joins/leaves and observed per-peer residency deltas, not transfers", () => {
        const previous = [
            snapshot(0, { role: "publisher" }),
            snapshot(1),
            snapshot(2, { chunks: [{ id: "small", bytes: 2 }] }),
        ];
        const next = [
            snapshot(0, { role: "publisher" }),
            snapshot(2, { chunks: [{ id: "large", bytes: 8 }] }),
            snapshot(3),
        ];
        const original = structuredClone({ previous, next });
        const report = comparePlacement(previous, next);
        expect(report.joinedPeers).toEqual([3]);
        expect(report.leftPeers).toEqual([1]);
        expect(
            report.peers.map((peer) => [
                peer.peer,
                peer.membership,
                peer.addedBytes,
                peer.removedBytes,
            ])
        ).toEqual([
            [0, "present", 0, 0],
            [1, "left", 0, 10],
            [2, "present", 8, 2],
            [3, "joined", 10, 0],
        ]);
        expect(report).toMatchObject({ addedBytes: 18, removedBytes: 12 });
        expect(report.membershipSemantics).toContain(
            "does not prove physical block deletion"
        );
        expect({ previous, next }).toEqual(original);
    });

    it("makes role changes explicit without inventing residency movement", () => {
        const report = comparePlacement(
            [snapshot(1, { role: "publisher" })],
            [snapshot(1)]
        );
        expect(report.peers[0]).toMatchObject({
            previousRole: "publisher",
            nextRole: "custodian",
            additions: [],
            removals: [],
        });
        expect(comparePlacement([], [])).toMatchObject({
            peers: [],
            addedBytes: 0,
            removedBytes: 0,
        });
    });

    it("rejects duplicate peers and cross-snapshot immutable identity conflicts", () => {
        expect(() => comparePlacement([snapshot(1), snapshot(1)], [])).toThrow(
            /Duplicate peer/
        );
        expect(() =>
            comparePlacement(
                [snapshot(1)],
                [
                    snapshot(1, {
                        metadata: [],
                        chunks: [{ id: "small", bytes: 3 }],
                    }),
                ]
            )
        ).toThrow(/Conflicting chunk size/);
        expect(() =>
            comparePlacement(
                [snapshot(1)],
                [
                    snapshot(1, {
                        metadata: [{ ...metadata[0], hash: "changed" }],
                    }),
                ]
            )
        ).toThrow(/Conflicting metadata/);
    });
});
