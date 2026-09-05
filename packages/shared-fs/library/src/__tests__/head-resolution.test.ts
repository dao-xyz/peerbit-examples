import { describe, expect, it } from "vitest";
import { SharedFileSystem } from "../index.js";

const row = (
    id: string,
    parents: string[] = [],
    causalDepth = 1n,
    deleted = false
) => ({
    id,
    nodeId: "file:head-fixture",
    parentId: "directory:root",
    name: id,
    deleted,
    causalDepth,
    createdAt: 0n,
    size: 0n,
    parentNamingIds: parents,
    parentVersionIds: parents,
});
type Row = ReturnType<typeof row>;

const permutations = <T>(values: T[]): T[][] =>
    values.length < 2
        ? [values]
        : values.flatMap((value, i) =>
              permutations(values.filter((_other, j) => i !== j)).map(
                  (rest) => [value, ...rest]
              )
          );

// Exercise the actual internal read paths with a warm row cache, without
// network/storage setup or a test-only production export. Integration tests
// separately cover ingest, cache invalidation, GC and public file reads.
const resolveHeads = async (rows: Row[], kind: "naming" | "content") => {
    const program: any = Object.create(SharedFileSystem.prototype);
    if (kind === "content") return program.contentHeads(rows) as Row[];
    program.namingRowCache = new Map([
        ["file:head-fixture", new Map(rows.map((entry) => [entry.id, entry]))],
    ]);
    const state = await program.namingStateForNode("file:head-fixture");
    return (state?.heads ?? []) as Row[];
};

describe.each(["naming", "content"] as const)("%s head resolution", (kind) => {
    it.each([
        { label: "empty history", rows: [], heads: [] },
        {
            label: "chain",
            rows: [row("a"), row("b", ["a"], 2n), row("c", ["b"], 3n)],
            heads: ["c"],
        },
        {
            label: "fork",
            rows: [row("a"), row("b", ["a"], 2n), row("c", ["a"], 2n)],
            heads: ["b", "c"],
        },
        {
            label: "merge",
            rows: [row("b"), row("c"), row("d", ["b", "c"], 2n)],
            heads: ["d"],
        },
        {
            label: "missing ancestors",
            rows: [row("a", ["missing"], 50n), row("b", [], 2n)],
            heads: ["a", "b"],
        },
        {
            label: "repeated parent references",
            rows: [row("a"), row("b", ["a", "a"], 2n)],
            heads: ["b"],
        },
        {
            label: "self cycle (existing behavior, not cycle repair)",
            rows: [row("a", ["a"])],
            heads: [],
        },
        {
            label: "cycle plus independent head (existing behavior)",
            rows: [row("a", ["b"]), row("b", ["a"]), row("c")],
            heads: ["c"],
        },
    ])(
        "preserves exact heads for $label in every input order",
        async (fixture) => {
            for (const rows of permutations(fixture.rows)) {
                const before = structuredClone(rows);
                expect(
                    (await resolveHeads(rows, kind)).map((entry) => entry.id)
                ).toEqual(fixture.heads);
                expect(rows).toEqual(before);
            }
        }
    );

    it("preserves stored-depth winner after removing ancestors", async () => {
        // The locally deeper branch must not beat a surviving head whose
        // higher stored depth reflects ancestors that have been retired.
        const ancestor = row("ancestor");
        const shallow = row("a", [ancestor.id], 2n);
        const deep = row("z", ["retired-parent"], 100n);
        for (const rows of permutations([ancestor, shallow, deep])) {
            expect(
                (await resolveHeads(rows, kind)).map((entry) => entry.id)
            ).toEqual(["z", "a"]);
            expect(
                (
                    await resolveHeads(
                        rows.filter((entry) => entry !== ancestor),
                        kind
                    )
                ).map((entry) => entry.id)
            ).toEqual(["z", "a"]);
        }
    });

    it("preserves ascending ID tie breaks at equal stored depth", async () => {
        const rows = [row("c", [], 9n), row("a", [], 9n), row("b", [], 9n)];
        for (const order of permutations(rows)) {
            expect(
                (await resolveHeads(order, kind)).map((entry) => entry.id)
            ).toEqual(["a", "b", "c"]);
        }
    });

    it("handles a deep reverse-ordered history without recursive traversal", async () => {
        const rows = Array.from({ length: 20_000 }, (_, i) =>
            row(String(i), i === 0 ? [] : [String(i - 1)], BigInt(i + 1))
        ).reverse();
        expect(
            (await resolveHeads(rows, kind)).map((entry) => entry.id)
        ).toEqual(["19999"]);
    });
});

it("preserves the naming non-delete bias ahead of equal-depth ID ordering", async () => {
    for (const rows of permutations([
        row("a", [], 3n, true),
        row("z", [], 3n),
    ])) {
        expect(
            (await resolveHeads(rows, "naming")).map((entry) => entry.id)
        ).toEqual(["z", "a"]);
    }
});
