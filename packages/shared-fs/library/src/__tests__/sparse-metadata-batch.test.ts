import { And, Or, StringMatch } from "@peerbit/document";
import { describe, expect, it, vi } from "vitest";
import { FileChunk, NamingEvent, type SharedFsEntry } from "../model.js";
import { SparseQueryClient } from "./sparse-query-client.js";
import { SparseMetadataBatchClient } from "./sparse-metadata-batch.js";

const source = "source";
const coverage = "single-source-non-atomic";
const slots = [
    { parentId: "dir:p", name: "a" },
    { parentId: "dir:p", name: "b" },
];
const naming = (
    name: string,
    overrides: Partial<ConstructorParameters<typeof NamingEvent>[0]> = {}
) =>
    new NamingEvent({
        id: `naming:${name}`,
        nodeId: `file:${name}`,
        parentId: "dir:p",
        name,
        causalDepth: 1n,
        createdAt: 1n,
        authorKey: source,
        machineLabel: source,
        ...overrides,
    });
type Limits = ConstructorParameters<typeof SparseMetadataBatchClient>[2];
type Plan = {
    pages: SharedFsEntry[][];
    neverDone?: boolean;
    next?: () => Promise<SharedFsEntry[]>;
    close?: () => Promise<void>;
};
const rows = (...values: SharedFsEntry[]): Plan => ({ pages: [values] });
const fixture = (plans: Plan[], limits?: Limits) => {
    const pending = [...plans];
    const iterators: Array<{
        next: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
    }> = [];
    const iterate = vi.fn((_request: unknown, _options: unknown) => {
        const plan = pending.shift();
        if (!plan) throw new Error("Unscripted query");
        let page = 0;
        const iterator = {
            done: () => !plan.neverDone && page >= plan.pages.length,
            next: vi.fn(async (_amount: number) => {
                const current = page++;
                return plan.next ? plan.next() : (plan.pages[current] ?? []);
            }),
            close: vi.fn(async () => {
                await plan.close?.();
            }),
        };
        iterators.push(iterator);
        return iterator;
    });
    const entries = { index: { iterate } } as unknown as ConstructorParameters<
        typeof SparseQueryClient
    >[0];
    return {
        entries,
        iterate,
        iterators,
        client: new SparseMetadataBatchClient(entries, source, limits),
        closed: () =>
            iterators.forEach((iterator) =>
                expect(iterator.close).toHaveBeenCalledTimes(1)
            ),
    };
};
const small = (
    overrides: Partial<NonNullable<Limits>> = {}
): NonNullable<Limits> => ({
    maxKeys: 8,
    maxRows: 64,
    maxPages: 64,
    pageSize: 8,
    timeout: 5000,
    ...overrides,
});
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

describe("bounded test-only independent metadata batching", () => {
    it("matches sequential lookup results with out-of-order rows and finite short/empty pages", async () => {
        const a = naming("a"),
            b = naming("b");
        const baseline = fixture([rows(a), rows(a), rows(b), rows(b)]);
        const reader = new SparseQueryClient(baseline.entries, source);
        const expected: Awaited<ReturnType<SparseQueryClient["lookup"]>>[] = [];
        for (const slot of slots)
            expected.push(await reader.lookup(slot.parentId, slot.name));
        const batch = fixture([
            { pages: [[b], [], [a]] },
            { pages: [[a], [b]] },
        ]);
        expect(await batch.client.lookupMany(slots)).toEqual(expected);
        expect(batch.client.counters).toEqual({ queries: 2, rows: 4 });
        expect(batch.iterators[0].next).toHaveBeenCalledTimes(3);
        baseline.closed();
        batch.closed();
    });

    it("keeps complete predicates in each OR branch and preserves remote query options", async () => {
        const a = naming("a"),
            b = naming("b"),
            f = fixture([rows(a, b), rows(a, b)]);
        await f.client.lookupMany(slots);
        expect(f.iterate.mock.calls[0][0]).toEqual({
            query: [
                new Or(
                    slots.map(
                        (slot) =>
                            new And([
                                new StringMatch({
                                    key: "kind",
                                    value: "naming",
                                }),
                                new StringMatch({
                                    key: "parentId",
                                    value: slot.parentId,
                                }),
                                new StringMatch({
                                    key: "name",
                                    value: slot.name,
                                }),
                            ])
                    )
                ),
            ],
        });
        expect(f.iterate.mock.calls[1][0]).toEqual({
            query: [
                new Or(
                    [a, b].map(
                        (entry) =>
                            new And([
                                new StringMatch({
                                    key: "kind",
                                    value: "naming",
                                }),
                                new StringMatch({
                                    key: "nodeId",
                                    value: entry.nodeId,
                                }),
                            ])
                    )
                ),
            ],
        });
        for (const [, options] of f.iterate.mock.calls)
            expect(options).toEqual({
                local: false,
                resolve: true,
                signal: expect.any(AbortSignal),
                remote: {
                    from: [source],
                    replicate: false,
                    throwOnMissing: true,
                    retryMissingResponses: false,
                    timeout: 5000,
                },
            });
        expect(f.iterators[0].close.mock.invocationCallOrder[0]).toBeLessThan(
            f.iterate.mock.invocationCallOrder[1]
        );
    });

    it("does not discover a new claimant through another slot's revalidation", async () => {
        const a = naming("a"),
            moved = naming("b", {
                id: "naming:moved",
                nodeId: a.nodeId,
                parentNamingIds: [a.id],
            });
        const f = fixture([rows(a), rows(a, moved)]);
        expect(await f.client.lookupMany(slots)).toEqual(
            slots.map(() => ({
                status: "not-observed",
                nodeId: undefined,
                coverage,
            }))
        );
    });

    it.each(["move", "delete"] as const)(
        "revalidates a concurrent %s by stable node ID",
        async (change) => {
            const a = naming("a"),
                changed = naming("a", {
                    id: "naming:next",
                    parentNamingIds: [a.id],
                    ...(change === "move"
                        ? { parentId: "dir:elsewhere" }
                        : { deleted: true }),
                });
            const f = fixture([rows(a), rows(a, changed)]);
            expect((await f.client.lookupMany([slots[0]]))[0]).toEqual({
                status: "not-observed",
                nodeId: undefined,
                coverage,
            });
            f.closed();
        }
    );

    it("labels empty discovery as not-observed and never as authoritative deletion", async () => {
        const f = fixture([rows()]);
        expect(await f.client.lookupMany(slots)).toEqual(
            slots.map(() => ({
                status: "not-observed",
                nodeId: undefined,
                coverage,
            }))
        );
        expect(f.iterate).toHaveBeenCalledTimes(1);
    });

    it("matches baseline unavailability when a discovered node has no revalidation history", async () => {
        const a = naming("a"),
            old = fixture([rows(a), rows()]),
            batch = fixture([rows(a), rows()]);
        await expect(
            new SparseQueryClient(old.entries, source).lookup("dir:p", "a")
        ).rejects.toThrow("Source changed during slot lookup");
        await expect(batch.client.lookupMany([slots[0]])).rejects.toThrow(
            "Source changed during slot lookup"
        );
        old.closed();
        batch.closed();
    });

    it.each(["conflict", "cycle", "contested"] as const)(
        "refuses %s histories",
        async (kind) => {
            const a = naming("a"),
                other = naming("a", {
                    id: "naming:other",
                    ...(kind === "contested" ? { nodeId: "file:other" } : {}),
                    ...(kind === "cycle" ? { parentNamingIds: [a.id] } : {}),
                });
            if (kind === "cycle") a.parentNamingIds = [other.id];
            const f = fixture([rows(a, other), rows(a, other)]);
            await expect(f.client.lookupMany([slots[0]])).rejects.toThrow(
                kind === "contested"
                    ? "contested slots"
                    : "conflicting or cyclic heads"
            );
            f.closed();
        }
    );

    it.each(["slot", "history", "type"] as const)(
        "binds every %s response to a requested branch",
        async (kind) => {
            const a = naming("a");
            const f =
                kind === "slot"
                    ? fixture([rows(naming("not-requested"))])
                    : kind === "type"
                      ? fixture([
                            rows(new FileChunk({ bytes: new Uint8Array([1]) })),
                        ])
                      : fixture([
                            rows(a),
                            rows(naming("a", { nodeId: "file:wrong" })),
                        ]);
            await expect(f.client.lookupMany([slots[0]])).rejects.toThrow(
                kind === "history"
                    ? "Invalid naming response"
                    : "Invalid slot response"
            );
            f.closed();
        }
    );

    it("bounds rows across both stages and closes before reporting overflow", async () => {
        const a = naming("a"),
            b = naming("b"),
            f = fixture([rows(a, b), rows(a, b)], small({ maxRows: 3 }));
        await expect(f.client.lookupMany(slots)).rejects.toThrow(
            "row budget exceeded"
        );
        expect(f.iterators[1].next).toHaveBeenCalledWith(2);
        f.closed();
    });

    it("bounds non-progress pages and owns a copy of caller limits", async () => {
        const supplied = small({ maxPages: 2 });
        const f = fixture([{ pages: [], neverDone: true }], supplied);
        supplied.maxPages = 5;
        await expect(f.client.lookupMany(slots)).rejects.toThrow(
            "page budget exceeded"
        );
        expect(f.iterators[0].next).toHaveBeenCalledTimes(2);
        f.closed();
    });

    it("bounds both requested keys and discovered contested candidates", async () => {
        const f = fixture([
            rows(
                ...Array.from({ length: 9 }, (_, i) =>
                    naming("a", { id: `n:${i}`, nodeId: `f:${i}` })
                )
            ),
        ]);
        await expect(
            f.client.lookupMany(Array(9).fill(slots[0]))
        ).rejects.toThrow("key budget exceeded");
        expect(f.iterate).not.toHaveBeenCalled();
        await expect(f.client.lookupMany([slots[0]])).rejects.toThrow(
            "key budget exceeded"
        );
        expect(f.iterate).toHaveBeenCalledTimes(1);
        f.closed();
    });

    it.each([undefined, new Error("source unavailable")])(
        "preserves lone query rejection %s and closes",
        async (error) => {
            const f = fixture([
                {
                    pages: [[]],
                    next: async () => {
                        throw error;
                    },
                },
            ]);
            await expect(f.client.lookupMany(slots)).rejects.toBe(error);
            f.closed();
        }
    );

    it("preserves undefined query error plus close failure in order", async () => {
        const closeError = new Error("close"),
            f = fixture([
                {
                    pages: [[]],
                    next: async () => {
                        throw undefined;
                    },
                    close: async () => {
                        throw closeError;
                    },
                },
            ]);
        await expect(f.client.lookupMany(slots)).rejects.toMatchObject({
            errors: [undefined, closeError],
        });
        f.closed();
    });

    it("preserves close-only rejection instead of returning successful absence", async () => {
        const f = fixture([
            {
                pages: [[]],
                close: async () => {
                    throw undefined;
                },
            },
        ]);
        await expect(f.client.lookupMany(slots)).rejects.toBeUndefined();
        f.closed();
    });

    it("rejects stale completion after reconnect even when cancellation occurs in close", async () => {
        const a = naming("a");
        const f = fixture([
            {
                pages: [[a]],
                close: async () => {
                    client.reconnect();
                },
            },
            rows(a),
            rows(a),
        ]);
        const client = f.client;
        await expect(client.lookupMany([slots[0]])).rejects.toThrow(
            "session invalidated"
        );
        expect(f.iterate).toHaveBeenCalledTimes(1);
        expect((await client.lookupMany([slots[0]]))[0].status).toBe(
            "observed"
        );
        f.closed();
    });

    it("forwards abort, forbids overlap, copies slots, and permits a later session", async () => {
        const pending = deferred<SharedFsEntry[]>(),
            a = naming("a"),
            controller = new AbortController();
        const f = fixture([
            { pages: [[]], next: () => pending.promise },
            rows(a),
            rows(a),
        ]);
        const input = [{ ...slots[0] }];
        const running = f.client.lookupMany(input, controller.signal);
        input[0].name = "mutated";
        await expect(f.client.lookupMany(slots)).rejects.toThrow("in flight");
        const error = new Error("caller abort");
        controller.abort(error);
        pending.resolve([a]);
        await expect(running).rejects.toBe(error);
        f.closed();
        f.client.disconnect();
        await expect(f.client.lookupMany(slots)).rejects.toThrow(
            "disconnected"
        );
        f.client.reconnect();
        expect((await f.client.lookupMany([slots[0]]))[0].nodeId).toBe(
            a.nodeId
        );
    });

    it("releases the operation guard after an invalid signal so a valid call can follow", async () => {
        const a = naming("a");
        const f = fixture([rows(a), rows(a)]);
        // A JavaScript caller can evade the signature; this must not wedge busy.
        await expect(
            f.client.lookupMany([slots[0]], {} as AbortSignal)
        ).rejects.toBeInstanceOf(TypeError);
        expect(f.iterate).not.toHaveBeenCalled();
        expect(f.client.counters).toEqual({ queries: 0, rows: 0 });
        const valid = new AbortController();
        expect(await f.client.lookupMany([slots[0]], valid.signal)).toEqual([
            { status: "observed", nodeId: a.nodeId, coverage },
        ]);
        expect(f.client.counters).toEqual({ queries: 2, rows: 2 });
        f.closed();
    });

    it("rejects invalid construction and allows an empty bounded request without a query", async () => {
        const f = fixture([]);
        expect(() => new SparseMetadataBatchClient(f.entries, " ")).toThrow(
            "explicit source"
        );
        for (const value of [0, -1, 1.5, Infinity, NaN])
            expect(
                () =>
                    new SparseMetadataBatchClient(
                        f.entries,
                        source,
                        small({ maxRows: value })
                    )
            ).toThrow("positive safe integers");
        expect(
            () =>
                new SparseMetadataBatchClient(
                    f.entries,
                    source,
                    small({ maxKeys: 9 })
                )
        ).toThrow("maxKeys exceeds 8");
        expect(await f.client.lookupMany([])).toEqual([]);
        expect(f.iterate).not.toHaveBeenCalled();
    });

    it.each(["maxKeys", "maxRows", "maxPages", "pageSize", "timeout"] as const)(
        "requires the explicit %s bound and rejects undefined, nonfinite and oversized values",
        (key) => {
            const f = fixture([]);
            const partial: Partial<NonNullable<Limits>> = small();
            delete partial[key];
            // Deliberately exercise calls from untyped JavaScript consumers.
            expect(
                () =>
                    new SparseMetadataBatchClient(
                        f.entries,
                        source,
                        partial as NonNullable<Limits>
                    )
            ).toThrow("complete bounded limits");
            const caps = {
                maxKeys: 8,
                maxRows: 64,
                maxPages: 64,
                pageSize: 64,
                timeout: 5000,
            };
            for (const value of [undefined, NaN, Infinity, caps[key] + 1])
                expect(
                    () =>
                        new SparseMetadataBatchClient(f.entries, source, {
                            ...small(),
                            [key]: value,
                        } as NonNullable<Limits>)
                ).toThrow();
            expect(f.iterate).not.toHaveBeenCalled();
        }
    );

    it("rejects nonobject, partial and extra-key runtime limits while accepting the hard caps", () => {
        const f = fixture([]);
        for (const invalid of [
            null,
            false,
            42,
            "",
            [],
            {},
            { maxRows: 64 },
            { ...small(), extra: 1 },
        ])
            expect(
                () =>
                    new SparseMetadataBatchClient(
                        f.entries,
                        source,
                        invalid as unknown as NonNullable<Limits>
                    )
            ).toThrow("complete bounded limits");
        expect(
            () =>
                new SparseMetadataBatchClient(f.entries, source, {
                    maxKeys: 8,
                    maxRows: 64,
                    maxPages: 64,
                    pageSize: 64,
                    timeout: 5000,
                })
        ).not.toThrow();
        expect(f.iterate).not.toHaveBeenCalled();
    });
});
