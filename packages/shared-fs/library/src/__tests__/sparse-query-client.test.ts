import { sha256Base64Sync } from "@peerbit/crypto";
import { StringMatch } from "@peerbit/document";
import { describe, expect, it, vi } from "vitest";
import {
    FileChunk,
    FileVersion,
    NamingEvent,
    type SharedFsEntry,
} from "../model.js";
import { SparseQueryClient } from "./sparse-query-client.js";

// Pure protocol-boundary fixtures: no Peerbit instances, transport, or source
// convergence. Real model classes exercise the probe's validation and layout.
const source = sha256Base64Sync(new TextEncoder().encode("sparse-test-source"));
const nodeId = "file:selected";
const parentId = "dir:parent";
const coverage = "single-source-non-atomic";
type Limits = NonNullable<ConstructorParameters<typeof SparseQueryClient>[2]>;
const limits = (overrides: Partial<Limits> = {}): Limits => ({
    maxRows: 64,
    maxPages: 64,
    pageSize: 8,
    maxFileBytes: 1024,
    maxChunkBytes: 1024,
    timeout: 5_000,
    ...overrides,
});

const naming = (
    overrides: Partial<ConstructorParameters<typeof NamingEvent>[0]> = {}
) =>
    new NamingEvent({
        id: "naming:initial",
        nodeId,
        parentId,
        name: "selected.txt",
        causalDepth: 1n,
        createdAt: 1n,
        authorKey: source,
        machineLabel: "source",
        ...overrides,
    });

const encode = (text: string) => new TextEncoder().encode(text);
const makeFile = (
    parts = ["one"],
    overrides: Partial<ConstructorParameters<typeof FileVersion>[0]> = {}
) => {
    const chunks = parts.map((part) => new FileChunk({ bytes: encode(part) }));
    const bytes = encode(parts.join(""));
    const version = new FileVersion({
        id: "version:initial",
        nodeId,
        causalDepth: 1n,
        createdAt: 1n,
        authorKey: source,
        machineLabel: "source",
        contentHash: sha256Base64Sync(bytes),
        size: bytes.byteLength,
        chunkIds: chunks.map((chunk) => chunk.id),
        ...overrides,
    });
    return { chunks, version, bytes };
};

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
};

type PagePlan = {
    pages: SharedFsEntry[][];
    neverDone?: boolean;
    next?: (amount: number, page: number) => Promise<SharedFsEntry[]>;
    close?: () => Promise<void>;
};
const rows = (...values: SharedFsEntry[]): PagePlan => ({ pages: [values] });
const scripted = (plans: PagePlan[], overrides: Partial<Limits> = {}) => {
    const remaining = [...plans];
    const iterators: Array<{
        next: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
    }> = [];
    const iterate = vi.fn((_request: unknown, _options: unknown) => {
        const plan = remaining.shift();
        if (!plan) throw new Error("Unexpected unscripted query");
        let page = 0;
        const iterator = {
            done: () => !plan.neverDone && page >= plan.pages.length,
            next: vi.fn(async (amount: number) => {
                const current = page++;
                return plan.next
                    ? plan.next(amount, current)
                    : (plan.pages[current] ?? []);
            }),
            close: vi.fn(async () => {
                await plan.close?.();
            }),
        };
        iterators.push(iterator);
        return iterator;
    });
    // Only the real query boundary is mocked; the probe never receives a log,
    // append method, peer identity, or a helper that could replicate results.
    const entries = { index: { iterate } } as unknown as ConstructorParameters<
        typeof SparseQueryClient
    >[0];
    const client = new SparseQueryClient(entries, source, limits(overrides));
    const closedOnce = () => {
        for (const iterator of iterators)
            expect(iterator.close).toHaveBeenCalledTimes(1);
    };
    return { client, entries, iterate, iterators, closedOnce };
};

describe("test-only sparse query client (pure boundary fixtures)", () => {
    it.each(["", " \t\n"])("rejects an empty source %j", (invalid) => {
        const fixture = scripted([]);
        expect(() => new SparseQueryClient(fixture.entries, invalid)).toThrow(
            "requires an explicit source"
        );
        expect(fixture.iterate).not.toHaveBeenCalled();
    });

    it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
        "rejects an invalid row limit %s",
        (maxRows) => {
            const fixture = scripted([]);
            expect(
                () =>
                    new SparseQueryClient(
                        fixture.entries,
                        source,
                        limits({ maxRows })
                    )
            ).toThrow("positive safe integers");
            expect(fixture.iterate).not.toHaveBeenCalled();
        }
    );

    it("owns a limits copy so caller mutation cannot relax the page bound", async () => {
        const fixture = scripted([{ pages: [], neverDone: true }]);
        const supplied = limits({ maxPages: 2 });
        const client = new SparseQueryClient(fixture.entries, source, supplied);
        supplied.maxPages = 3;
        supplied.pageSize = 1;
        await expect(client.lookup(parentId, "x")).rejects.toThrow(
            "page budget exceeded"
        );
        expect(fixture.iterators[0].next).toHaveBeenCalledTimes(2);
        expect(fixture.iterators[0].next).toHaveBeenCalledWith(8);
        fixture.closedOnce();
    });

    it("uses bounded source-only nonreplicating queries and does not treat a short page as EOF", async () => {
        const entry = naming();
        const fixture = scripted([{ pages: [[], [entry]] }, rows(entry)]);
        await expect(
            fixture.client.lookup(parentId, entry.name)
        ).resolves.toEqual({
            status: "observed",
            nodeId,
            coverage,
        });
        expect(fixture.iterators[0].next).toHaveBeenCalledTimes(2);
        expect(fixture.iterate.mock.calls[0][0]).toEqual({
            query: [
                new StringMatch({ key: "kind", value: "naming" }),
                new StringMatch({ key: "parentId", value: parentId }),
                new StringMatch({ key: "name", value: entry.name }),
            ],
        });
        expect(fixture.iterate.mock.calls[1][0]).toEqual({
            query: [
                new StringMatch({ key: "kind", value: "naming" }),
                new StringMatch({ key: "nodeId", value: nodeId }),
            ],
        });
        for (const [, options] of fixture.iterate.mock.calls) {
            expect(options).toEqual({
                local: false,
                resolve: true,
                signal: expect.any(AbortSignal),
                remote: {
                    from: [source],
                    replicate: false,
                    throwOnMissing: true,
                    retryMissingResponses: false,
                    timeout: 5_000,
                },
            });
        }
        fixture.closedOnce();
    });

    it("labels empty coverage as not-observed, not global absence", async () => {
        const fixture = scripted([rows()]);
        await expect(
            fixture.client.lookup(parentId, "missing")
        ).resolves.toEqual({
            status: "not-observed",
            nodeId: undefined,
            coverage,
        });
        fixture.closedOnce();
    });

    it.each(["error", "undefined"] as const)(
        "preserves a lone %s page rejection and closes its iterator",
        async (kind) => {
            const reason =
                kind === "undefined"
                    ? undefined
                    : new Error("source refused query");
            const fixture = scripted([
                {
                    pages: [[]],
                    next: async () => {
                        throw reason;
                    },
                },
            ]);
            await expect(fixture.client.lookup(parentId, "x")).rejects.toBe(
                reason
            );
            fixture.closedOnce();
        }
    );

    it.each(["error", "undefined"] as const)(
        "preserves a lone %s close rejection without returning success",
        async (kind) => {
            const reason =
                kind === "undefined"
                    ? undefined
                    : new Error("source iterator close failed");
            const fixture = scripted([
                {
                    pages: [[]],
                    close: async () => {
                        throw reason;
                    },
                },
            ]);
            await expect(fixture.client.lookup(parentId, "x")).rejects.toBe(
                reason
            );
            fixture.closedOnce();
        }
    );

    it.each([
        { label: "two errors", undefinedQuery: false, undefinedClose: false },
        {
            label: "undefined query rejection",
            undefinedQuery: true,
            undefinedClose: false,
        },
        {
            label: "undefined close rejection",
            undefinedQuery: false,
            undefinedClose: true,
        },
        {
            label: "two undefined rejections",
            undefinedQuery: true,
            undefinedClose: true,
        },
    ])(
        "preserves both failures in query-first order for $label",
        async ({ undefinedQuery, undefinedClose }) => {
            const queryError = undefinedQuery
                ? undefined
                : new Error("original query failure");
            const closeError = undefinedClose
                ? undefined
                : new Error("secondary close failure");
            const fixture = scripted([
                {
                    pages: [[]],
                    next: async () => {
                        throw queryError;
                    },
                    close: async () => {
                        throw closeError;
                    },
                },
            ]);
            const result = await fixture.client.lookup(parentId, "x").then(
                () => ({ ok: true as const }),
                (reason: unknown) => ({ ok: false as const, reason })
            );
            expect(result.ok).toBe(false);
            if (result.ok) throw new Error("Expected dual-failure rejection");
            expect(result.reason).toBeInstanceOf(AggregateError);
            const aggregate = result.reason as AggregateError;
            expect(aggregate.errors).toHaveLength(2);
            expect(aggregate.errors[0]).toBe(queryError);
            expect(aggregate.errors[1]).toBe(closeError);
            fixture.closedOnce();
        }
    );

    it("closes and refuses partial success when the aggregate row budget overflows", async () => {
        const entry = naming();
        const fixture = scripted([rows(entry), rows(entry)], { maxRows: 1 });
        await expect(
            fixture.client.lookup(parentId, entry.name)
        ).rejects.toThrow("row budget exceeded");
        expect(fixture.iterators[1].next).toHaveBeenCalledWith(1);
        fixture.closedOnce();
    });

    it("bounds empty pages independently of rows", async () => {
        const fixture = scripted([{ pages: [], neverDone: true }], {
            maxPages: 2,
        });
        await expect(fixture.client.lookup(parentId, "x")).rejects.toThrow(
            "page budget exceeded"
        );
        expect(fixture.iterators[0].next).toHaveBeenCalledTimes(2);
        fixture.closedOnce();
    });

    it("does not start a query for a pre-aborted operation", async () => {
        const reason = new Error("caller aborted");
        const fixture = scripted([]);
        await expect(
            fixture.client.lookup(parentId, "x", AbortSignal.abort(reason))
        ).rejects.toBe(reason);
        expect(fixture.iterate).not.toHaveBeenCalled();
    });

    it("closes a parked query and rejects its late page after caller abort", async () => {
        const reached = deferred<void>();
        const page = deferred<SharedFsEntry[]>();
        const fixture = scripted([
            {
                pages: [[]],
                next: async () => {
                    reached.resolve();
                    return page.promise;
                },
            },
        ]);
        const controller = new AbortController();
        const reason = new Error("caller abort while reading");
        const outcome = expect(
            fixture.client.lookup(parentId, "x", controller.signal)
        ).rejects.toBe(reason);
        await reached.promise;
        controller.abort(reason);
        page.resolve([]);
        await outcome;
        fixture.closedOnce();
    });

    it("revalidates the candidate by node ID and observes a move out of the old slot", async () => {
        const initial = naming();
        const moved = naming({
            id: "naming:moved",
            parentId: "dir:elsewhere",
            name: "renamed.txt",
            parentNamingIds: [initial.id],
            causalDepth: 2n,
        });
        const fixture = scripted([rows(initial), rows(initial, moved)]);
        await expect(
            fixture.client.lookup(parentId, initial.name)
        ).resolves.toMatchObject({ status: "not-observed", coverage });
        expect(fixture.iterate).toHaveBeenCalledTimes(2);
        fixture.closedOnce();
    });

    it("honors a tombstone without fetching retained versions or chunks", async () => {
        const initial = naming();
        const deleted = naming({
            id: "naming:deleted",
            deleted: true,
            parentNamingIds: [initial.id],
            causalDepth: 2n,
        });
        const fixture = scripted([rows(initial, deleted)]);
        await expect(fixture.client.readNode(nodeId)).resolves.toEqual({
            status: "deleted",
            coverage,
            naming: deleted,
        });
        expect(fixture.iterate).toHaveBeenCalledTimes(1);
        expect(fixture.client.counters.chunkFetches).toBe(0);
        fixture.closedOnce();
    });

    it.each(["concurrent", "cyclic"] as const)(
        "fails closed for %s naming heads",
        async (kind) => {
            const first = naming({
                parentNamingIds: kind === "cyclic" ? ["naming:second"] : [],
            });
            const second = naming({
                id: "naming:second",
                deleted: true,
                parentNamingIds: kind === "cyclic" ? [first.id] : [],
            });
            const fixture = scripted([rows(first, second)]);
            await expect(fixture.client.readNode(nodeId)).rejects.toThrow(
                "conflicting or cyclic heads"
            );
            fixture.closedOnce();
        }
    );

    it("fails closed for two live nodes claiming the same slot", async () => {
        const first = naming();
        const second = naming({ id: "naming:other", nodeId: "file:other" });
        const fixture = scripted([
            rows(first, second),
            rows(first),
            rows(second),
        ]);
        await expect(
            fixture.client.lookup(parentId, first.name)
        ).rejects.toThrow("contested slots");
        fixture.closedOnce();
    });

    it("fails closed for concurrent content heads", async () => {
        const first = makeFile().version;
        const second = makeFile(["two"], { id: "version:other" }).version;
        const fixture = scripted([rows(naming()), rows(first, second)]);
        await expect(fixture.client.readNode(nodeId)).rejects.toThrow(
            "conflicting or cyclic heads"
        );
        expect(fixture.client.counters.chunkFetches).toBe(0);
        fixture.closedOnce();
    });

    it("reconstructs ordered repeated chunks and verifies the exact selected version", async () => {
        const file = makeFile(["aa", "bb", "aa"]);
        const fixture = scripted([
            rows(naming()),
            rows(file.version),
            rows(file.chunks[0]),
            rows(file.chunks[1]),
        ]);
        const result = await fixture.client.readNode(nodeId);
        expect(result.status).toBe("observed");
        if (result.status !== "observed")
            throw new Error("Expected observed file");
        expect(result.version).toBe(file.version);
        expect(result.bytes).toEqual(file.bytes);
        expect(result.coverage).toBe(coverage);
        expect(fixture.client.counters.chunkFetches).toBe(2);
        expect(fixture.client.counters.cacheHits).toBe(1);
        fixture.closedOnce();
    });

    it("refreshes the node history and reads its unique superseding version", async () => {
        const old = makeFile(["old"]);
        const current = makeFile(["new"], {
            id: "version:current",
            parentVersionIds: [old.version.id],
            causalDepth: 2n,
        });
        const fixture = scripted([
            rows(naming()),
            rows(current.version, old.version),
            rows(current.chunks[0]),
        ]);
        const result = await fixture.client.readNode(nodeId);
        expect(result.status).toBe("observed");
        if (result.status !== "observed")
            throw new Error("Expected observed file");
        expect(result.version.id).toBe(current.version.id);
        expect(result.bytes).toEqual(current.bytes);
        fixture.closedOnce();
    });

    it("does not turn a missing-source refresh into absence or cached success", async () => {
        const file = makeFile();
        const missing = new Error(
            "Missing response from expected sparse source"
        );
        const fixture = scripted([
            rows(naming()),
            rows(file.version),
            rows(file.chunks[0]),
            {
                pages: [[]],
                next: async () => {
                    throw missing;
                },
            },
        ]);
        await expect(fixture.client.readNode(nodeId)).resolves.toMatchObject({
            status: "observed",
        });
        expect(fixture.client.cache.get(file.chunks[0].id)).toEqual(file.bytes);
        await expect(fixture.client.readNode(nodeId)).rejects.toBe(missing);
        expect(fixture.client.counters.chunkFetches).toBe(1);
        fixture.closedOnce();
    });

    it.each(["bytes", "hash-field"] as const)(
        "rejects inconsistent chunk %s",
        async (field) => {
            const file = makeFile();
            const invalid =
                field === "bytes"
                    ? new FileChunk({
                          bytes: encode("bad"),
                          hash: file.chunks[0].hash,
                      })
                    : new FileChunk({ bytes: file.chunks[0].bytes });
            if (field === "hash-field") invalid.hash = "wrong-hash";
            const fixture = scripted([
                rows(naming()),
                rows(file.version),
                rows(invalid),
            ]);
            await expect(fixture.client.readNode(nodeId)).rejects.toThrow(
                "Invalid or oversized chunk"
            );
            fixture.closedOnce();
        }
    );

    it.each([
        {
            label: "too small",
            size: 2n,
            error: "Chunk layout exceeds file size",
        },
        {
            label: "too large",
            size: 4n,
            error: "File content verification failed",
        },
        {
            label: "wrong hash",
            contentHash: sha256Base64Sync(encode("bad")),
            error: "File content verification failed",
        },
    ])(
        "rejects a $label file layout or hash",
        async ({ size, contentHash, error }) => {
            const file = makeFile(["one"], {
                ...(size === undefined ? {} : { size }),
                ...(contentHash === undefined ? {} : { contentHash }),
            });
            const fixture = scripted([
                rows(naming()),
                rows(file.version),
                rows(file.chunks[0]),
            ]);
            await expect(fixture.client.readNode(nodeId)).rejects.toThrow(
                error
            );
            fixture.closedOnce();
        }
    );

    it.each([
        {
            label: "file bytes",
            overrides: { maxFileBytes: 2 },
            error: "file byte budget exceeded",
            fetch: false,
        },
        {
            label: "chunk bytes",
            overrides: { maxChunkBytes: 2 },
            error: "Invalid or oversized chunk",
            fetch: true,
        },
    ])("enforces the $label bound", async ({ overrides, error, fetch }) => {
        const file = makeFile();
        const fixture = scripted(
            [
                rows(naming()),
                rows(file.version),
                ...(fetch ? [rows(file.chunks[0])] : []),
            ],
            overrides
        );
        await expect(fixture.client.readNode(nodeId)).rejects.toThrow(error);
        fixture.closedOnce();
    });

    it("bounds chunk fanout independently of the claimed file size", async () => {
        const file = makeFile(["a", "a", "a"]);
        const fixture = scripted([rows(naming()), rows(file.version)], {
            maxRows: 2,
        });
        await expect(fixture.client.readNode(nodeId)).rejects.toThrow(
            "chunk count budget exceeded"
        );
        expect(fixture.client.counters.chunkFetches).toBe(0);
        fixture.closedOnce();
    });

    it("rejects a model of the wrong kind in a naming response", async () => {
        const fixture = scripted([rows(makeFile().version)]);
        await expect(fixture.client.readNode(nodeId)).rejects.toThrow(
            "Invalid naming response"
        );
        fixture.closedOnce();
    });

    it.each(["naming", "version"] as const)(
        "rejects a %s response for another node",
        async (kind) => {
            const plans =
                kind === "naming"
                    ? [rows(naming({ nodeId: "file:other" }))]
                    : [
                          rows(naming()),
                          rows(
                              makeFile(["one"], { nodeId: "file:other" })
                                  .version
                          ),
                      ];
            const fixture = scripted(plans);
            await expect(fixture.client.readNode(nodeId)).rejects.toThrow(
                kind === "naming"
                    ? "Invalid naming response"
                    : "Invalid version response"
            );
            fixture.closedOnce();
        }
    );

    it("rejects old-generation completion and requires explicit reconnect before fresh work", async () => {
        const reached = deferred<void>();
        const page = deferred<SharedFsEntry[]>();
        const fixture = scripted([
            {
                pages: [[]],
                next: async () => {
                    reached.resolve();
                    return page.promise;
                },
            },
            rows(),
        ]);
        const outcome = expect(
            fixture.client.lookup(parentId, "x")
        ).rejects.toThrow("session invalidated");
        await reached.promise;
        fixture.client.disconnect();
        await expect(fixture.client.lookup(parentId, "x")).rejects.toThrow(
            "disconnected"
        );
        fixture.client.reconnect();
        page.resolve([]);
        await outcome;
        await expect(
            fixture.client.lookup(parentId, "x")
        ).resolves.toMatchObject({ status: "not-observed", coverage });
        fixture.closedOnce();
    });

    it("does not refill the cache from an old generation parked in iterator close", async () => {
        const file = makeFile();
        const reached = deferred<void>();
        const release = deferred<void>();
        const fixture = scripted([
            rows(naming()),
            rows(file.version),
            {
                pages: [[file.chunks[0]]],
                close: async () => {
                    reached.resolve();
                    await release.promise;
                },
            },
        ]);
        const outcome = expect(fixture.client.readNode(nodeId)).rejects.toThrow(
            "session invalidated"
        );
        await reached.promise;
        fixture.client.reconnect();
        release.resolve();
        await outcome;
        expect(fixture.client.cache.get(file.chunks[0].id)).toBeUndefined();
        fixture.closedOnce();
    });
});
