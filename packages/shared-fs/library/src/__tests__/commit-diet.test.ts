import { Peerbit } from "peerbit";
import { Compare, IntegerCompare, StringMatch } from "@peerbit/document";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    DEFAULT_FILE_CHUNK_SIZE,
    FileChunk,
    FileVersion,
    chunkIdForBytes,
    createSharedFsMountBackend,
    openSharedFs,
    type SharedFsHandle,
    type SharedFsMountProfileEvent,
} from "../index.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

type Decision = "skip" | "put-unique" | "put-linked";

/** Distinct, deterministic bytes; `seed` selects the content. */
const patternedBytes = (size: number, seed: number) => {
    const bytes = new Uint8Array(size);
    let state = (seed * 2654435761) >>> 0 || 1;
    for (let i = 0; i < size; i++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        bytes[i] = state & 0xff;
    }
    return bytes;
};

/** Every StringMatch (key, value) inside a query tree. */
const stringMatches = (query: unknown): { key: string; value: string }[] => {
    const out: { key: string; value: string }[] = [];
    const visit = (node: any) => {
        if (Array.isArray(node)) {
            node.forEach(visit);
            return;
        }
        if (!node || typeof node !== "object") return;
        if (node instanceof StringMatch) {
            const key = Array.isArray(node.key)
                ? node.key.join(".")
                : String(node.key);
            out.push({ key, value: node.value });
            return;
        }
        if (Array.isArray(node.or)) visit(node.or);
        if (Array.isArray(node.and)) visit(node.and);
        if (node.not) visit(node.not);
        if (Array.isArray(node.query)) visit(node.query);
    };
    visit(query);
    return out;
};

/**
 * The pre-batching W1 logic, verbatim in effect: one presence probe per
 * chunk, then (present chunks only) one fresh-witness query per chunk. It
 * only reads, so it can run against the exact state a write then sees.
 */
const referenceDecisions = async (
    program: any,
    chunks: FileChunk[],
    dedup: "verify" | "off" | undefined
): Promise<Map<string, Decision>> => {
    const unique = [...new Map(chunks.map((c) => [c.id, c])).values()];
    const decisions = new Map<string, Decision>();
    if (dedup === "off" || !program.isFullReplica()) {
        for (const chunk of unique) decisions.set(chunk.id, "put-linked");
        return decisions;
    }
    const horizonFloor = BigInt(
        Math.max(0, Math.floor(program.clock() - program.skipHorizonMs))
    );
    for (const chunk of unique) {
        if (!(await program.hasDocument(chunk.id))) {
            decisions.set(chunk.id, "put-unique");
            continue;
        }
        const iterator = program.entries.index.iterate(
            {
                query: [
                    new StringMatch({ key: "kind", value: "file-version" }),
                    new StringMatch({ key: "chunkRefs", value: chunk.id }),
                    new IntegerCompare({
                        key: "createdAt",
                        compare: Compare.GreaterOrEqual,
                        value: horizonFloor,
                    }),
                ],
            },
            { local: true, remote: false, resolve: false }
        );
        let witnessed: boolean;
        try {
            witnessed = (await iterator.next(1)).length > 0;
        } finally {
            await iterator.close?.();
        }
        decisions.set(chunk.id, witnessed ? "skip" : "put-linked");
    }
    return decisions;
};

/** Chunk puts observed during `run`, as W1 decisions per chunk id. */
const observeDecisions = async <T>(
    program: any,
    chunkIds: string[],
    run: () => Promise<T>
): Promise<{ result: T; decisions: Map<string, Decision> }> => {
    const puts = new Map<string, Decision>();
    const original = program.entries.put.bind(program.entries);
    const spy = vi
        .spyOn(program.entries, "put")
        .mockImplementation(async (doc: any, options: any) => {
            if (doc instanceof FileChunk && !puts.has(doc.id)) {
                puts.set(
                    doc.id,
                    options?.unique === true ? "put-unique" : "put-linked"
                );
            }
            return original(doc, options);
        });
    try {
        const result = await run();
        const decisions = new Map<string, Decision>();
        for (const id of new Set(chunkIds)) {
            decisions.set(id, puts.get(id) ?? "skip");
        }
        return { result, decisions };
    } finally {
        spy.mockRestore();
    }
};

const chunksOf = (content: string, chunkSize: number) => {
    const bytes = encode(content);
    const chunks: FileChunk[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        chunks.push(
            new FileChunk({ bytes: bytes.subarray(offset, offset + chunkSize) })
        );
    }
    return chunks;
};

/** touchChunks detail of the single profiled writeFile in `events`. */
const touchDetail = (events: SharedFsMountProfileEvent[]) =>
    events.find((event) => event.phase === "writeFile.touchChunks")?.detail as
        | Record<string, number>
        | undefined;

describe("v9 commit diet: batched W1/W2 bookkeeping", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;
    let program: any;
    /** Fixed injected clock: reference and write share one horizon floor. */
    let fakeNow: number;
    let crafted = 0;

    /**
     * A version row with a chosen createdAt that references `chunkIds`: a
     * witness (or non-witness) with exactly the age the case needs.
     */
    const craftVersion = async (
        chunkIds: string[],
        createdAt: number,
        nodeId = `file:crafted-${crafted}`
    ) => {
        const version = new FileVersion({
            id: `version:crafted-${crafted++}`,
            nodeId,
            parentVersionIds: [],
            causalDepth: 1,
            contentHash: "crafted",
            size: chunkIds.length,
            mode: 0o100644,
            mtime: createdAt,
            chunkIds,
            createdAt,
            authorKey: "",
            machineLabel: "crafted",
        });
        await program.entries.put(version, { unique: true });
        return version;
    };
    const putChunk = async (content: string) => {
        const chunk = new FileChunk({ bytes: encode(content) });
        await program.entries.put(chunk, { unique: true });
        return chunk.id;
    };
    const id = (content: string) => chunkIdForBytes(encode(content));

    beforeEach(async () => {
        fakeNow = Date.now();
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "commit-diet",
            clock: () => fakeNow,
        });
        program = fs.program;
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await peer.stop();
    });

    it("makes exactly the per-chunk W1 decisions across a matrix of chunk states", async () => {
        const young = fakeNow;
        const stale = fakeNow - 20 * DAY_MS;
        const edge = fakeNow - program.skipHorizonMs;
        // Present with a young witness; with only a stale witness; with no
        // witness at all; exactly on the horizon floor (still fresh); just
        // past it (stale); absent although a young version references it.
        await putChunk("YNG1");
        await craftVersion([id("YNG1")], young);
        await putChunk("STL1");
        await craftVersion([id("STL1")], stale);
        await putChunk("NOW1");
        await putChunk("EDG1");
        await craftVersion([id("EDG1")], edge);
        await putChunk("OLD1");
        await craftVersion([id("OLD1")], edge - 1);
        await craftVersion([id("YAB1")], young);
        // Present and witnessed by both a stale and a young version.
        await putChunk("MIX1");
        await craftVersion([id("MIX1")], stale);
        await craftVersion([id("MIX1")], young);

        // Repeated chunks (YNG1, ABS1 twice) and an absent chunk.
        const content = "YNG1STL1NOW1EDG1OLD1YAB1MIX1ABS1YNG1ABS1";
        const chunks = chunksOf(content, 4);
        const expected = await referenceDecisions(program, chunks, undefined);
        expect(Object.fromEntries(expected)).toEqual({
            [id("YNG1")]: "skip",
            [id("STL1")]: "put-linked",
            [id("NOW1")]: "put-linked",
            [id("EDG1")]: "skip",
            [id("OLD1")]: "put-linked",
            [id("YAB1")]: "put-unique",
            [id("MIX1")]: "skip",
            [id("ABS1")]: "put-unique",
        });
        const events: SharedFsMountProfileEvent[] = [];
        const { decisions } = await observeDecisions(
            program,
            chunks.map((chunk) => chunk.id),
            () =>
                fs.writeFile("/matrix.txt", content, {
                    chunkSize: 4,
                    mountProfile: {
                        sink: (event) => events.push(event),
                        writeId: 1,
                    },
                })
        );
        expect(decisions).toEqual(expected);
        expect(touchDetail(events)).toMatchObject({
            chunks: 8,
            probes: 8,
            probeQueries: 1,
            witnessQueries: 1,
            dedupSkips: 3,
            baseWitnessed: 0,
            absentPuts: 2,
            linkedPuts: 3,
        });
        expect(decode(await fs.readFile("/matrix.txt"))).toBe(content);
    });

    it("keeps the same decisions with dedup off and on a partial replica", async () => {
        await putChunk("YNG2");
        await craftVersion([id("YNG2")], fakeNow);
        const content = "YNG2ABS2YNG2";
        const chunks = chunksOf(content, 4);
        const expected = await referenceDecisions(program, chunks, "off");
        expect([...expected.values()]).toEqual(["put-linked", "put-linked"]);
        const { decisions } = await observeDecisions(
            program,
            chunks.map((chunk) => chunk.id),
            () =>
                fs.writeFile("/off.txt", content, {
                    chunkSize: 4,
                    dedup: "off",
                })
        );
        expect(decisions).toEqual(expected);

        const observer = await Peerbit.create();
        try {
            const partial = await openSharedFs({
                peerbit: observer,
                machineLabel: "partial",
                replicate: false,
            });
            const partialProgram: any = partial.program;
            expect(partialProgram.isFullReplica()).toBe(false);
            const partialExpected = await referenceDecisions(
                partialProgram,
                chunks,
                undefined
            );
            const observed = await observeDecisions(
                partialProgram,
                chunks.map((chunk) => chunk.id),
                () => partial.writeFile("/p.txt", content, { chunkSize: 4 })
            );
            expect(observed.decisions).toEqual(partialExpected);
            expect([...partialExpected.values()]).toEqual([
                "put-linked",
                "put-linked",
            ]);
        } finally {
            await observer.stop().catch(() => {});
        }
    });

    it("narrows the batched witness query across rounds with identical decisions", async () => {
        // 40 present chunks, each witnessed by its own young version, plus
        // 8 present unwitnessed chunks: one witness page (16 rows) cannot
        // prove completeness, so the Or narrows round by round.
        const parts: string[] = [];
        for (let i = 0; i < 48; i++) {
            const part = `W${String(i).padStart(3, "0")}`;
            parts.push(part);
            await putChunk(part);
            if (i < 40) await craftVersion([id(part)], fakeNow);
        }
        const content = parts.join("");
        const chunks = chunksOf(content, 4);
        const expected = await referenceDecisions(program, chunks, undefined);
        const events: SharedFsMountProfileEvent[] = [];
        const { decisions } = await observeDecisions(
            program,
            chunks.map((chunk) => chunk.id),
            () =>
                fs.writeFile("/rounds.txt", content, {
                    chunkSize: 4,
                    mountProfile: {
                        sink: (event) => events.push(event),
                        writeId: 2,
                    },
                })
        );
        expect(decisions).toEqual(expected);
        const detail = touchDetail(events)!;
        expect(detail).toMatchObject({ dedupSkips: 40, linkedPuts: 8 });
        // 17 + 17 rows witness 34 chunks; the third round reads the rest.
        expect(detail.witnessQueries).toBe(3);
    });

    it("falls back to exact per-chunk witness queries when a round cannot progress", async () => {
        await putChunk("FBK1");
        await craftVersion([id("FBK1")], fakeNow);
        await putChunk("FBK2");
        await putChunk("FBK3");
        await craftVersion([id("FBK3")], fakeNow - 20 * DAY_MS);
        const content = "FBK1FBK2FBK3";
        const chunks = chunksOf(content, 4);
        const expected = await referenceDecisions(program, chunks, undefined);
        const localIndexRows = program.localIndexRows.bind(program);
        vi.spyOn(program, "localIndexRows").mockImplementation(
            async (query: unknown, options: any) => {
                const result = await localIndexRows(query, options);
                const isWitnessPage =
                    options?.limit !== undefined &&
                    options.limit > 0 &&
                    stringMatches(query).some(
                        (match) => match.key === "chunkRefs"
                    );
                // A matching row that is gone by its re-read, with more
                // matches claimed: the round cannot progress.
                return isWitnessPage
                    ? { rows: [{ id: "version:vanished" }], complete: false }
                    : result;
            }
        );
        const { decisions } = await observeDecisions(
            program,
            chunks.map((chunk) => chunk.id),
            () => fs.writeFile("/fallback.txt", content, { chunkSize: 4 })
        );
        expect(decisions).toEqual(expected);
        expect(Object.fromEntries(decisions)).toEqual({
            [id("FBK1")]: "skip",
            [id("FBK2")]: "put-linked",
            [id("FBK3")]: "put-linked",
        });
    });

    it("lets only a loaded, young, locally present base version witness", async () => {
        const first = await fs.writeFile("/based.txt", "BAS1BAS2", {
            chunkSize: 4,
        });
        const write = async (
            content: string,
            options: Record<string, unknown>,
            writeId: number
        ) => {
            const events: SharedFsMountProfileEvent[] = [];
            const chunks = chunksOf(content, 4);
            const expected = await referenceDecisions(
                program,
                chunks,
                undefined
            );
            const { result, decisions } = await observeDecisions(
                program,
                chunks.map((chunk) => chunk.id),
                () =>
                    fs.writeFile("/based.txt", content, {
                        chunkSize: 4,
                        ...options,
                        mountProfile: {
                            sink: (event) => events.push(event),
                            writeId,
                        },
                    })
            );
            expect(decisions).toEqual(expected);
            return { result, decisions, detail: touchDetail(events)! };
        };

        // Young, present, loaded explicit base: it witnesses its own chunks
        // with no witness query; a chunk it references that is absent here
        // is still put.
        const second = await write(
            "BAS1BAS2NEW1",
            { baseVersionIds: [first.id], expectedNodeId: first.nodeId },
            1
        );
        expect(second.detail).toMatchObject({
            probeQueries: 1,
            baseWitnessed: 2,
            dedupSkips: 2,
            witnessQueries: 0,
            absentPuts: 1,
        });

        // Ordinary writes use the current head row the same way.
        const third = await write("BAS1BAS2NEW1NEW2", {}, 2);
        expect(third.detail).toMatchObject({
            baseWitnessed: 3,
            witnessQueries: 0,
            absentPuts: 1,
        });

        // A base that references an absent chunk: presence decides first.
        const ghostBase = await craftVersion(
            [id("BAS1"), id("GST1")],
            fakeNow,
            first.nodeId
        );
        const ghost = await write(
            "BAS1GST1",
            { baseVersionIds: [ghostBase.id] },
            3
        );
        expect(ghost.decisions.get(id("GST1"))).toBe("put-unique");
        expect(ghost.detail).toMatchObject({ baseWitnessed: 1 });

        // Stale base: no base witness; the witness query decides (BAS1 is
        // still referenced by young versions, STB1 only by the stale base).
        await putChunk("STB1");
        const staleBase = await craftVersion(
            [id("BAS1"), id("STB1")],
            fakeNow - 20 * DAY_MS,
            first.nodeId
        );
        const stale = await write(
            "BAS1STB1",
            { baseVersionIds: [staleBase.id] },
            4
        );
        expect(stale.detail).toMatchObject({
            baseWitnessed: 0,
            witnessQueries: 1,
        });
        expect(stale.decisions.get(id("BAS1"))).toBe("skip");
        expect(stale.decisions.get(id("STB1"))).toBe("put-linked");

        // A base id that never loaded witnesses nothing.
        await putChunk("UNL1");
        const missing = await write(
            "UNL1",
            { baseVersionIds: ["version:not-here"] },
            5
        );
        expect(missing.detail).toMatchObject({
            baseWitnessed: 0,
            witnessQueries: 1,
        });
        expect(missing.decisions.get(id("UNL1"))).toBe("put-linked");

        // A loaded base document that is not a row in the local index (as a
        // bootstrap-overlay document would be) witnesses nothing either:
        // the base is re-read from the index, never trusted as loaded.
        await putChunk("FAB1");
        const fabricated = new FileVersion({
            id: "version:fabricated",
            nodeId: first.nodeId,
            parentVersionIds: [],
            causalDepth: 1,
            contentHash: "fabricated",
            size: 4,
            mode: 0o100644,
            mtime: fakeNow,
            chunkIds: [id("FAB1")],
            createdAt: fakeNow,
            authorKey: "",
            machineLabel: "fabricated",
        });
        const getDocument = program.getDocument.bind(program);
        vi.spyOn(program, "getDocument").mockImplementation(
            async (docId: unknown) =>
                docId === fabricated.id ? fabricated : getDocument(docId)
        );
        const fake = await write(
            "FAB1",
            { baseVersionIds: [fabricated.id] },
            6
        );
        expect(fake.detail).toMatchObject({
            baseWitnessed: 0,
            witnessQueries: 1,
            linkedPuts: 1,
        });
        expect(fake.decisions.get(id("FAB1"))).toBe("put-linked");
        vi.mocked(program.getDocument).mockRestore();
        expect(decode(await fs.readVersion("/based.txt", fake.result.id))).toBe(
            "FAB1"
        );
    });

    it("W2 re-puts a chunk removed between the dedup skip and the version put", async () => {
        const first = await fs.writeFile("/w2.txt", "KEEPGONE", {
            chunkSize: 4,
        });
        const gone = id("GONE");
        const original = program.entries.put.bind(program.entries);
        let removed = false;
        vi.spyOn(program.entries, "put").mockImplementation(
            async (doc: any, options: any) => {
                const result = await original(doc, options);
                if (doc instanceof FileVersion && !removed) {
                    removed = true;
                    // A collector deleting the skipped chunk inside the
                    // probe window; Guard D is held off so only W2 can heal.
                    program.gcSuppressed.add(gone);
                    await program.entries.del(gone);
                    expect(await program.hasDocument(gone)).toBe(false);
                }
                return result;
            }
        );
        const events: SharedFsMountProfileEvent[] = [];
        try {
            await fs.writeFile("/w2.txt", "KEEPGONENEW3", {
                chunkSize: 4,
                baseVersionIds: [first.id],
                expectedNodeId: first.nodeId,
                mountProfile: {
                    sink: (event) => events.push(event),
                    writeId: 1,
                },
            });
        } finally {
            program.gcSuppressed.delete(gone);
        }
        expect(removed).toBe(true);
        expect(touchDetail(events)).toMatchObject({ dedupSkips: 2 });
        expect(
            events.find((event) => event.phase === "writeFile.verifyChunks")
                ?.detail
        ).toMatchObject({ chunks: 3, reputs: 1, reputBytes: 4 });
        expect(await program.hasDocument(gone)).toBe(true);
        expect(decode(await fs.readFile("/w2.txt"))).toBe("KEEPGONENEW3");
    });

    it("commits a 4 KiB overwrite into a 64-chunk file with O(1) W1/W2 index queries", async () => {
        const size = 64 * DEFAULT_FILE_CHUNK_SIZE;
        const expected = patternedBytes(size, 7);
        await fs.writeFile("/big.bin", expected);
        const events: SharedFsMountProfileEvent[] = [];
        const backend = createSharedFsMountBackend(fs, {
            profile: (event) => events.push(event),
        });
        const handle = await backend.open("/big.bin", {
            read: true,
            write: true,
        });
        const patch = patternedBytes(4096, 8);
        const offset = 5 * DEFAULT_FILE_CHUNK_SIZE + 1234;
        await backend.write(handle, patch, offset);
        expected.set(patch, offset);

        const chunkQueries: { kind: "presence" | "witness"; ids: number }[] =
            [];
        const classify = (query: unknown) => {
            const matches = stringMatches(query);
            const witness = matches.filter((m) => m.key === "chunkRefs");
            const presence = matches.filter(
                (m) => m.key === "id" && m.value.startsWith("chunk:")
            );
            if (witness.length > 0) {
                chunkQueries.push({ kind: "witness", ids: witness.length });
            } else if (presence.length > 0) {
                chunkQueries.push({ kind: "presence", ids: presence.length });
            }
        };
        const rawIndex = program.entries.index.index;
        const rawIterate = rawIndex.iterate.bind(rawIndex);
        vi.spyOn(rawIndex, "iterate").mockImplementation(
            (request: any, options: any) => {
                classify(request?.query);
                return rawIterate(request, options);
            }
        );
        const documentsIterate = program.entries.index.iterate.bind(
            program.entries.index
        );
        vi.spyOn(program.entries.index, "iterate").mockImplementation(
            (request: any, options: any) => {
                classify(request?.query);
                return documentsIterate(request, options);
            }
        );
        const documentsGet = program.entries.index.get.bind(
            program.entries.index
        );
        let chunkGets = 0;
        vi.spyOn(program.entries.index, "get").mockImplementation(
            (key: any, options: any) => {
                if (typeof key === "string" && key.startsWith("chunk:")) {
                    chunkGets++;
                }
                return documentsGet(key, options);
            }
        );
        await backend.fsync(handle);
        vi.restoreAllMocks();
        await backend.release(handle);

        // One presence probe before the version (W1, carrying the base) and
        // one after it (W2); no witness query, no per-chunk lookups.
        expect(chunkQueries).toEqual([
            { kind: "presence", ids: 64 },
            { kind: "presence", ids: 64 },
        ]);
        expect(chunkGets).toBe(0);
        expect(touchDetail(events)).toMatchObject({
            chunks: 64,
            probes: 64,
            probeQueries: 1,
            witnessQueries: 0,
            baseWitnessed: 63,
            dedupSkips: 63,
            chunkPuts: 1,
            absentPuts: 1,
            linkedPuts: 0,
        });
        expect(
            events.find((event) => event.phase === "writeFile.verifyChunks")
                ?.detail
        ).toMatchObject({ chunks: 64, reputs: 0 });
        const read = await fs.readFile("/big.bin");
        expect(read?.byteLength).toBe(size);
        expect(Buffer.compare(Buffer.from(read!), Buffer.from(expected))).toBe(
            0
        );
    });

    it("batches the witness query for chunks no base covers", async () => {
        // 200 chunks witnessed only by another file's young version: a new
        // path has no base, so the witness query answers them in
        // ceil(200 / 128) batched queries instead of 200.
        const content = patternedBytes(200 * 1024, 11);
        await fs.writeFile("/source.bin", content, { chunkSize: 1024 });
        const events: SharedFsMountProfileEvent[] = [];
        await fs.writeFile("/copy.bin", content, {
            chunkSize: 1024,
            mountProfile: { sink: (event) => events.push(event), writeId: 1 },
        });
        expect(touchDetail(events)).toMatchObject({
            chunks: 200,
            probes: 200,
            probeQueries: 2,
            witnessQueries: 2,
            baseWitnessed: 0,
            dedupSkips: 200,
            chunkPuts: 0,
        });
        const read = await fs.readFile("/copy.bin");
        expect(Buffer.compare(Buffer.from(read!), Buffer.from(content))).toBe(
            0
        );
    });

    it("probes, decides and puts one slice before probing the next", async () => {
        // 130 absent chunks: two slices (128 + 2). A second-slice chunk
        // arrives (as if replicated from a peer) while the first slice's
        // puts run. Its probe comes after that, so it sees the row and takes
        // the linked put; an absence verdict from before the first slice's
        // puts would fork it with an unlinked unique put.
        const parts: string[] = [];
        for (let i = 0; i < 130; i++) {
            parts.push(`S${String(i).padStart(3, "0")}`);
        }
        const content = parts.join("");
        const chunks = chunksOf(content, 4);
        const late = chunks[129];
        const order: string[] = [];
        let versionPut = false;
        const indexRowsById = program.indexRowsById.bind(program);
        vi.spyOn(program, "indexRowsById").mockImplementation(
            async (ids: any, shape: any, onQuery: any) => {
                const probed = (ids as string[]).filter((docId) =>
                    docId.startsWith("chunk:")
                ).length;
                if (!versionPut && probed > 0) order.push(`probe:${probed}`);
                return indexRowsById(ids, shape, onQuery);
            }
        );
        const original = program.entries.put.bind(program.entries);
        const decisions = new Map<string, Decision>();
        let arrived = false;
        vi.spyOn(program.entries, "put").mockImplementation(
            async (doc: any, options: any) => {
                if (doc instanceof FileVersion) versionPut = true;
                if (doc instanceof FileChunk && !versionPut) {
                    order.push("put");
                    decisions.set(
                        doc.id,
                        options?.unique === true ? "put-unique" : "put-linked"
                    );
                    if (!arrived) {
                        arrived = true;
                        await original(late, { unique: true });
                    }
                }
                return original(doc, options);
            }
        );
        const events: SharedFsMountProfileEvent[] = [];
        await fs.writeFile("/sliced.txt", content, {
            chunkSize: 4,
            mountProfile: { sink: (event) => events.push(event), writeId: 1 },
        });
        vi.restoreAllMocks();

        expect(decisions.get(late.id)).toBe("put-linked");
        expect(order).toEqual([
            "probe:128",
            ...new Array(128).fill("put"),
            "probe:2",
            "put",
            "put",
        ]);
        expect(
            chunks
                .slice(0, 129)
                .every((chunk) => decisions.get(chunk.id) === "put-unique")
        ).toBe(true);
        expect(touchDetail(events)).toMatchObject({
            chunks: 130,
            probes: 130,
            probeQueries: 2,
            witnessQueries: 1,
            dedupSkips: 0,
            absentPuts: 129,
            linkedPuts: 1,
        });
        expect(decode(await fs.readFile("/sliced.txt"))).toBe(content);
    });
});
