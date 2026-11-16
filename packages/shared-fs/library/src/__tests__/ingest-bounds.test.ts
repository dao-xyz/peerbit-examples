import { serialize } from "@dao-xyz/borsh";
import { Ed25519Keypair, sha256Base64Sync } from "@peerbit/crypto";
import { Peerbit } from "peerbit";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import * as library from "../index.js";
import {
    BootstrapManifest,
    DEFAULT_FILE_CHUNK_SIZE,
    FileChunk,
    FileVersion,
    NamingEvent,
    SegmentRef,
    SHARED_FS_MODE,
    SnapshotCounts,
    SnapshotManifestPayload,
    SnapshotSegment,
    chunkIdForBytes,
    createSharedFsMountBackend,
    encodePublicSignKey,
    openSharedFs,
    type BootstrapTelemetryEvent,
    type SharedFsEntry,
    type SharedFsHandle,
} from "../index.js";
import { holdCuts } from "./readiness-cut-hold.js";

// The bounds, spelled out so a change to the exported constants shows.
const DEPTH_CAP = 2n ** 53n - 1n;
const MAX_CHUNKS = 65_536;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const KIB = 1024;

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const canonicalId = (prefix: string) =>
    `${prefix}:${randomBytes(32).toString("base64url")}`;

const ZERO_KIB = chunkIdForBytes(new Uint8Array(KIB));

/** What a refused put rejects with (the log's access check). */
const REFUSED = /Not allowed to append/;

/**
 * `promise`, resolving to "resolved": an expected rejection that resolves
 * instead then fails with that word, not with a printout of the value (a
 * handle or a put result reaches libp2p, which pretty-format cannot print).
 */
const settled = (promise: Promise<unknown>) =>
    promise.then(() => "resolved" as const);

const version = (
    patch: { causalDepth?: bigint; size?: bigint; chunkIds?: string[] } = {}
) =>
    new FileVersion({
        id: canonicalId("version"),
        nodeId: canonicalId("file"),
        causalDepth: patch.causalDepth ?? 1n,
        contentHash: "forged",
        size: patch.size ?? BigInt(KIB),
        mode: SHARED_FS_MODE.file,
        mtime: 0n,
        chunkIds: patch.chunkIds ?? [ZERO_KIB],
        createdAt: 1n,
        authorKey: "forger",
        machineLabel: "forger",
    });

const naming = (name: string, causalDepth = 1n) =>
    new NamingEvent({
        id: canonicalId("naming"),
        nodeId: canonicalId("file"),
        parentId: "root",
        name,
        causalDepth,
        createdAt: 1n,
        authorKey: "forger",
        machineLabel: "forger",
    });

/** Rows no writer makes; each is refused on its own. */
const forgedRows: [string, () => SharedFsEntry][] = [
    [
        "a version at causalDepth 2^64-1",
        () => version({ causalDepth: 2n ** 64n - 1n }),
    ],
    [
        "a naming event at causalDepth 2^64-1",
        () => naming("deep", 2n ** 64n - 1n),
    ],
    [
        "a version one past the depth cap",
        () => version({ causalDepth: DEPTH_CAP + 1n }),
    ],
    // A real chunk id repeated 10^6 times would exceed the 5 MB document
    // cap; a short one fits, so only the list length refuses it.
    [
        "a version repeating one chunk id 10^6 times",
        () =>
            version({
                size: 1_000_000n,
                chunkIds: new Array<string>(1_000_000).fill("z"),
            }),
    ],
    [
        "a version of 65,537 one-byte chunks",
        () =>
            version({
                size: BigInt(MAX_CHUNKS + 1),
                chunkIds: new Array<string>(MAX_CHUNKS + 1).fill(
                    chunkIdForBytes(new Uint8Array(1))
                ),
            }),
    ],
    [
        "a chunk list longer than its size",
        () => version({ size: 1n, chunkIds: [ZERO_KIB, ZERO_KIB] }),
    ],
    [
        "a chunk list no chunk size yields",
        () => version({ size: 10n, chunkIds: new Array(6).fill(ZERO_KIB) }),
    ],
    [
        "a non-empty file without chunks",
        () => version({ size: 5n, chunkIds: [] }),
    ],
    [
        "a chunk list with 8,001 distinct ids",
        () =>
            version({
                size: 8_001n,
                chunkIds: Array.from({ length: 8_001 }, (_, i) =>
                    chunkIdForBytes(Uint8Array.of(i >> 8, i & 255))
                ),
            }),
    ],
    [
        "a chunk of 4 MiB + 1 bytes",
        () => new FileChunk({ bytes: new Uint8Array(MAX_CHUNK_BYTES + 1) }),
    ],
    ["a 300-byte name", () => naming("a".repeat(300))],
    ["a 256-byte multi-byte name", () => naming("é".repeat(128))],
    ["a name with NUL", () => naming("a\u0000b")],
    ["a name with U+0001", () => naming("a\u0001b")],
    ["a name with U+001F", () => naming("a\u001fb")],
    ["a name with DEL", () => naming("a\u007fb")],
];

/** The rows a snapshot segment holds (it never holds chunks). */
const forgedSegmentRows = forgedRows.filter(([label]) =>
    [
        "a version at causalDepth 2^64-1",
        "a naming event at causalDepth 2^64-1",
        "a version repeating one chunk id 10^6 times",
        "a chunk list no chunk size yields",
        "a 300-byte name",
        "a name with NUL",
        "a name with U+0001",
    ].includes(label)
);

describe("shared fs ingest bounds", () => {
    const peers: Peerbit[] = [];
    const cutHolds: ReturnType<typeof holdCuts>[] = [];
    afterEach(async () => {
        await Promise.allSettled(peers.splice(0).map((peer) => peer.stop()));
        for (const hold of cutHolds.splice(0)) hold.restore();
    });

    const createPeer = async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        return peer;
    };

    const open = async (peer?: Peerbit) =>
        openSharedFs({
            peerbit: peer ?? (await createPeer()),
            machineLabel: "bounds",
        });

    const doc = async (fs: SharedFsHandle, id: string) =>
        (await fs.program.entries.index.get(id, {
            local: true,
            remote: false,
        })) as unknown as FileVersion | NamingEvent | undefined;

    const logLength = (fs: SharedFsHandle) =>
        (fs.program as any).entries.log.log.length as number;

    /**
     * Publishes a snapshot of exactly `entries` (one segment, a fresh
     * signer) through `fs`: what a donor holding those rows would serve.
     */
    const publishSnapshot = async (
        peer: Peerbit,
        fs: SharedFsHandle,
        entries: SharedFsEntry[]
    ) => {
        const bytes = serialize(new SnapshotSegment({ entries }));
        const cid = (await (peer.services.blocks as any).put(bytes)) as string;
        const payloadBytes = serialize(
            new SnapshotManifestPayload({
                storeId: fs.program.id,
                snapshotSeq: 1n,
                createdAtWallMs: BigInt(Date.now()),
                counts: new SnapshotCounts({
                    nodes: entries.length,
                    docs: entries.length,
                    bytes: bytes.byteLength,
                }),
                segments: [
                    new SegmentRef({
                        cid,
                        sha256: sha256Base64Sync(bytes),
                        docCount: entries.length,
                        byteLength: bytes.byteLength,
                    }),
                ],
            })
        );
        const signer = await Ed25519Keypair.create();
        await fs.program.entries.put(
            new BootstrapManifest({
                id: `bootstrap:${encodePublicSignKey(signer.publicKey)}`,
                payloadBytes,
                signatureBytes: serialize(await signer.sign(payloadBytes)),
            })
        );
    };

    /**
     * A joiner of the donor that must install a snapshot: its open rejects
     * with the install's error. Its readiness proof cannot cut the
     * bootstrap first (readiness-cut-hold.ts).
     */
    const joinFromSnapshot = async (donorPeer: Peerbit, address: string) => {
        const joinerPeer = await createPeer();
        cutHolds.push(holdCuts(joinerPeer));
        await joinerPeer.dial(donorPeer);
        return openSharedFs({
            peerbit: joinerPeer,
            address,
            machineLabel: "joiner",
            bootstrap: { mode: "require", discoveryTimeoutMs: 30_000 },
        });
    };

    it("exports the bounds", () => {
        expect({
            MAX_NAME_BYTES: library.MAX_NAME_BYTES,
            MAX_FILE_CHUNK_SIZE: library.MAX_FILE_CHUNK_SIZE,
            MAX_FILE_VERSION_CHUNKS: library.MAX_FILE_VERSION_CHUNKS,
            MAX_CAUSAL_DEPTH: library.MAX_CAUSAL_DEPTH,
        }).toEqual({
            MAX_NAME_BYTES: 255,
            MAX_FILE_CHUNK_SIZE: MAX_CHUNK_BYTES,
            MAX_FILE_VERSION_CHUNKS: MAX_CHUNKS,
            MAX_CAUSAL_DEPTH: DEPTH_CAP,
        });
    });

    it.each(forgedRows)("refuses %s at ingest", async (_, make) => {
        const fs = await open();
        const row = make();
        const before = logLength(fs);
        await expect(settled(fs.program.entries.put(row))).rejects.toThrow(
            REFUSED
        );
        expect((await doc(fs, row.id))?.id).toBeUndefined();
        expect(logLength(fs)).toBe(before);
    });

    it.each(forgedSegmentRows)(
        "refuses %s at snapshot-segment install",
        async (_, make) => {
            const donorPeer = await createPeer();
            const donor = await open(donorPeer);
            await donor.writeFile("/kept.txt", "kept");
            await publishSnapshot(donorPeer, donor, [make()]);
            await expect(
                settled(joinFromSnapshot(donorPeer, donor.address!))
            ).rejects.toThrow(/structurally invalid/);
        }
    );

    it("joins past rows it refuses: write-ready and synced, without them", async () => {
        const donorPeer = await createPeer();
        const donor = await open(donorPeer);
        await donor.writeFile("/kept.txt", "kept");
        // A peer that took these rows before the bounds existed.
        const program = donor.program as any;
        program.canPerformEntry = async () => true;
        const rows = forgedSegmentRows.map(([, make]) => make());
        try {
            for (const row of rows) await donor.program.entries.put(row);
        } finally {
            delete program.canPerformEntry;
        }
        const joinerPeer = await createPeer();
        await joinerPeer.dial(donorPeer);
        const events: BootstrapTelemetryEvent[] = [];
        const joiner = await openSharedFs({
            peerbit: joinerPeer,
            address: donor.address!,
            machineLabel: "joiner",
            telemetry: { bootstrap: (event) => events.push(event) },
        });
        await joiner.awaitWriteReady({ timeout: 90_000 });
        // Its readiness proof met the rows and explained them as refused.
        let refused = 0;
        for (const event of events) {
            if (event.type === "readiness-session") {
                refused += event.explainedBy["rejected-structure"] ?? 0;
            }
        }
        expect(refused).toBeGreaterThan(0);
        expect(decode(await joiner.readFile("/kept.txt"))).toBe("kept");
        for (const row of rows) {
            expect((await doc(joiner, row.id))?.id).toBeUndefined();
        }
        await joiner.writeFile("/joined.txt", "joined");
    });

    it("refuses bad names on local writes with ENAMETOOLONG or EINVAL before writing", async () => {
        const fs = await open();
        await fs.mkdir("/d");
        const ok = await fs.writeFile("/d/ok.txt", "ok");
        const backend = createSharedFsMountBackend(fs);
        const before = logLength(fs);
        const cases: [string, string][] = [
            ["a".repeat(256), "ENAMETOOLONG"],
            ["é".repeat(128), "ENAMETOOLONG"],
            ["😀".repeat(64), "ENAMETOOLONG"],
            ["a\u0000b", "EINVAL"],
            ["a\u0001b", "EINVAL"],
            ["a\u001fb", "EINVAL"],
            ["a\u007fb", "EINVAL"],
            // No UTF-8 form: borsh would ship other bytes than it stored.
            ["a\ud800b", "EINVAL"],
        ];
        for (const [name, code] of cases) {
            const path = `/d/${name}`;
            const refused = { code };
            await expect(
                settled(fs.writeFile(path, "x"))
            ).rejects.toMatchObject(refused);
            await expect(
                settled(
                    fs.writeFile(path, "target", {
                        mode: SHARED_FS_MODE.symlink,
                    })
                )
            ).rejects.toMatchObject(refused);
            await expect(settled(fs.mkdir(path))).rejects.toMatchObject(
                refused
            );
            await expect(
                settled(fs.rename("/d/ok.txt", path))
            ).rejects.toMatchObject(refused);
            await expect(
                settled(fs.writeBatch([{ path, content: "x" }]))
            ).rejects.toMatchObject(refused);
            await expect(
                settled(
                    fs.writeBatch([{ path: `${path}/x.txt`, content: "x" }])
                )
            ).rejects.toMatchObject(refused);
            await expect(
                settled(
                    fs.resolveNamingConflict(ok.nodeId, {
                        type: "move",
                        to: path,
                    })
                )
            ).rejects.toMatchObject(refused);
            // The mount refuses at create, not at the later commit.
            await expect(
                settled(backend.open(path, { write: true, create: true }))
            ).rejects.toMatchObject(refused);
            await expect(settled(backend.mkdir(path))).rejects.toMatchObject(
                refused
            );
            await expect(
                settled(backend.rename("/d/ok.txt", path))
            ).rejects.toMatchObject(refused);
            await expect(
                settled(backend.symlink("target", path))
            ).rejects.toMatchObject(refused);
        }
        expect(logLength(fs)).toBe(before);
        expect((await fs.list("/d")).map((entry) => entry.name)).toEqual([
            "ok.txt",
        ]);

        // 255 bytes of UTF-8 is the longest name, however many characters.
        for (const name of [
            "é".repeat(127) + "a",
            "😀".repeat(63) + "abc",
            "€".repeat(85),
        ]) {
            await fs.writeFile(`/d/${name}`, name);
            expect(decode(await fs.readFile(`/d/${name}`))).toBe(name);
        }
        const directory = "a".repeat(255);
        await fs.mkdir(`/d/${directory}`);
        await fs.rename("/d/ok.txt", `/d/${directory}/${"b".repeat(255)}`);
        const handle = await backend.open(`/d/${"c".repeat(255)}`, {
            write: true,
            create: true,
        });
        await backend.release(handle);
        expect(await fs.stat(`/d/${"c".repeat(255)}`)).toBeDefined();
    });

    it("bounds chunk sizes and chunk lists on local writes and keeps a sparse file at the bound", async () => {
        const fs = await open();
        // A sparse file repeats its zero chunk: 65,536 times is the bound.
        const sparse = await fs.writeFile(
            "/sparse.bin",
            new Uint8Array(MAX_CHUNKS * KIB),
            { chunkSize: KIB }
        );
        const stored = (await doc(fs, sparse.id)) as FileVersion;
        expect(stored.chunkIds).toHaveLength(MAX_CHUNKS);
        expect(new Set(stored.chunkIds)).toEqual(new Set([ZERO_KIB]));
        expect((await fs.readFile("/sparse.bin"))?.byteLength).toBe(
            MAX_CHUNKS * KIB
        );

        const before = logLength(fs);
        const oneMore = new Uint8Array(MAX_CHUNKS * KIB + 1);
        await expect(
            settled(fs.writeFile("/big.bin", oneMore, { chunkSize: KIB }))
        ).rejects.toMatchObject({ code: "EFBIG" });
        await expect(
            settled(
                fs.writeBatch([
                    { path: "/big.bin", content: oneMore, chunkSize: KIB },
                ])
            )
        ).rejects.toMatchObject({ code: "EFBIG" });
        for (const chunkSize of [MAX_CHUNK_BYTES + 1, 0, 1.5]) {
            await expect(
                settled(fs.writeFile("/c.bin", "c", { chunkSize }))
            ).rejects.toMatchObject({ code: "EINVAL" });
        }
        expect(logLength(fs)).toBe(before);

        // The largest chunk size is accepted.
        const bytes = new Uint8Array(randomBytes(MAX_CHUNK_BYTES + 1));
        const large = await fs.writeFile("/large.bin", bytes, {
            chunkSize: MAX_CHUNK_BYTES,
        });
        expect(
            ((await doc(fs, large.id)) as FileVersion).chunkIds
        ).toHaveLength(2);
        expect(
            Buffer.from((await fs.readFile("/large.bin"))!).equals(
                Buffer.from(bytes)
            )
        ).toBe(true);

        // The mount commits at the default chunk size, so it holds a file
        // of at most 65,536 default chunks.
        const backend = createSharedFsMountBackend(fs);
        const handle = await backend.open("/m.bin", {
            write: true,
            create: true,
        });
        // Far past any bound first: without one, this allocation fails at
        // once, before the exact bound below could allocate gigabytes.
        await expect(
            settled(backend.write(handle, Uint8Array.of(1), 2 ** 50))
        ).rejects.toMatchObject({ code: "EFBIG" });
        const mountMax = MAX_CHUNKS * DEFAULT_FILE_CHUNK_SIZE;
        await expect(
            settled(backend.truncate(handle, mountMax + 1))
        ).rejects.toMatchObject({ code: "EFBIG" });
        await expect(
            settled(backend.write(handle, Uint8Array.of(1), mountMax))
        ).rejects.toMatchObject({ code: "EFBIG" });
        await backend.write(handle, Uint8Array.of(1), 0);
        await backend.release(handle);
        expect(decode(await fs.readFile("/m.bin"))).toBe("\u0001");
    });

    it("refuses to assemble a version whose chunks do not add up to its size", async () => {
        const fs = await open();
        const base = await fs.writeFile("/s.bin", new Uint8Array(KIB), {
            chunkSize: KIB,
        });
        // Structurally 64 one-byte chunks, but each chunk is 1 KiB.
        const forged = new FileVersion({
            ...((await doc(fs, base.id)) as FileVersion),
            id: canonicalId("version"),
            parentVersionIds: [base.id],
            causalDepth: 2n,
            size: 64n,
            chunkIds: new Array(64).fill(ZERO_KIB),
        });
        await fs.program.entries.put(forged, { unique: true });
        await expect(
            settled(fs.readFileWithVersion("/s.bin", { mode: "exact" }))
        ).rejects.toMatchObject({
            code: "EIO",
            cause: { message: expect.stringMatching(/size mismatch/) },
        });
    });

    it("saturates causal depth at the cap and breaks ties there by id", async () => {
        const fs = await open();
        const base = (await doc(
            fs,
            (await fs.writeFile("/deep.txt", "base")).id
        )) as FileVersion;
        await fs.program.entries.put(
            new FileVersion({
                ...base,
                id: canonicalId("version"),
                parentVersionIds: [base.id],
                causalDepth: DEPTH_CAP - 1n,
                chunkIds: base.chunkIds,
            }),
            { unique: true }
        );
        const depthOf = async (id: string) => (await doc(fs, id))!.causalDepth;
        const one = await fs.writeFile("/deep.txt", "one");
        expect(await depthOf(one.id)).toBe(DEPTH_CAP);
        // Past the cap a child keeps it, and still supersedes its parent.
        const two = await fs.writeFile("/deep.txt", "two");
        expect(await depthOf(two.id)).toBe(DEPTH_CAP);
        expect(decode(await fs.readFile("/deep.txt"))).toBe("two");
        // Concurrent heads at the cap: the smaller id is visible.
        const left = await fs.writeFile("/deep.txt", "left", {
            baseVersionIds: [two.id],
        });
        const right = await fs.writeFile("/deep.txt", "right", {
            baseVersionIds: [two.id],
        });
        expect([await depthOf(left.id), await depthOf(right.id)]).toEqual([
            DEPTH_CAP,
            DEPTH_CAP,
        ]);
        const first = left.id < right.id ? left : right;
        expect((await fs.stat("/deep.txt"))!.versionId).toBe(first.id);
        const merged = await fs.writeFile("/deep.txt", "merged");
        expect(await depthOf(merged.id)).toBe(DEPTH_CAP);
        expect([...merged.parentVersionIds].sort()).toEqual(
            [left.id, right.id].sort()
        );

        // A batch save of the bytes another writer put at the cap is a
        // recorded copy, and keeps its depth.
        const mergedDoc = (await doc(fs, merged.id)) as FileVersion;
        const other = new FileVersion({
            ...mergedDoc,
            id: canonicalId("version"),
            parentVersionIds: [merged.id],
            chunkIds: mergedDoc.chunkIds,
            authorKey: "other",
            machineLabel: "other",
        });
        await fs.program.entries.put(other, { unique: true });
        const [copy] = (
            await fs.writeBatch([{ path: "/deep.txt", content: "merged" }])
        ).results;
        expect(copy!.parentVersionIds).toContain(other.id);
        expect(await depthOf(copy!.id)).toBe(DEPTH_CAP);

        // Naming saturates the same way.
        const namingRows = async () =>
            (await fs.program.entries.index
                .iterate(
                    { query: { kind: "naming", nodeId: base.nodeId } },
                    { local: true, remote: false, resolve: false }
                )
                .all()) as any[];
        const [created] = await namingRows();
        await fs.program.entries.put(
            new NamingEvent({
                id: canonicalId("naming"),
                nodeId: base.nodeId,
                parentId: "root",
                name: "deep.txt",
                causalDepth: DEPTH_CAP - 1n,
                parentNamingIds: [created.id],
                createdAt: 1n,
                authorKey: "forger",
                machineLabel: "forger",
            }),
            { unique: true }
        );
        await fs.rename("/deep.txt", "/deeper.txt");
        await fs.rename("/deeper.txt", "/deepest.txt");
        expect(await fs.stat("/deeper.txt")).toBeUndefined();
        expect((await fs.stat("/deepest.txt"))!.nodeId).toBe(base.nodeId);
        expect(
            (await namingRows())
                .filter((row) => row.name !== "deep.txt")
                .map((row) => [row.name, BigInt(row.causalDepth)])
                .sort()
        ).toEqual([
            ["deeper.txt", DEPTH_CAP],
            ["deepest.txt", DEPTH_CAP],
        ]);
    });

    it("installs a snapshot holding the honest edge cases", async () => {
        const donorPeer = await createPeer();
        const donor = await open(donorPeer);
        const longName = "é".repeat(127) + "a";
        await donor.writeFile(`/${longName}`, "long");
        await donor.writeFile("/sparse.bin", new Uint8Array(MAX_CHUNKS * KIB), {
            chunkSize: KIB,
        });
        const base = (await doc(
            donor,
            (await donor.writeFile("/deep.txt", "base")).id
        )) as FileVersion;
        await donor.program.entries.put(
            new FileVersion({
                ...base,
                id: canonicalId("version"),
                parentVersionIds: [base.id],
                causalDepth: DEPTH_CAP,
                chunkIds: base.chunkIds,
            }),
            { unique: true }
        );
        const top = await donor.writeFile("/deep.txt", "top");
        expect((await doc(donor, top.id))!.causalDepth).toBe(DEPTH_CAP);
        await donor.snapshotWrite();

        const joiner = await joinFromSnapshot(donorPeer, donor.address!);
        expect(["overlay-active", "converged"]).toContain(
            joiner.bootstrapStatus().phase
        );
        expect((await joiner.stat(`/${longName}`))?.size).toBe(4n);
        expect((await joiner.stat("/sparse.bin"))?.size).toBe(
            BigInt(MAX_CHUNKS * KIB)
        );
        expect((await joiner.stat("/deep.txt"))?.versionId).toBe(top.id);
    });
});
