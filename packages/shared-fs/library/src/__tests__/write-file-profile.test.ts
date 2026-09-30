import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    createSharedFsMountBackend,
    openSharedFs,
    SharedFsExpectedNodeMismatchError,
    SharedFsHandle,
    type SharedFsMountBackendTarget,
    type SharedFsMountProfileEvent,
    type WriteFileOptions,
} from "../index.js";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
};

const isSubPhase = (event: SharedFsMountProfileEvent) =>
    event.phase.startsWith("writeFile.");

const end = (event: SharedFsMountProfileEvent) =>
    BigInt(event.startUnixNs) + BigInt(event.durationNs);

/** The sub-phase records joined to each `mount.target.writeFile` record. */
const joinedWrites = (events: SharedFsMountProfileEvent[]) =>
    events
        .filter((event) => event.phase === "mount.target.writeFile")
        .map((parent) => ({
            parent,
            children: events.filter(
                (event) =>
                    isSubPhase(event) &&
                    event.detail?.writeId === parent.detail?.writeId
            ),
        }));

/**
 * Children lie inside the parent window, are contiguous in code order (each
 * starts where the previous ended, from one clock reading), and therefore sum
 * to no more than the parent.
 */
const expectNested = (
    parent: SharedFsMountProfileEvent,
    children: SharedFsMountProfileEvent[]
) => {
    expect(children.length).toBeGreaterThan(0);
    expect(BigInt(children[0].startUnixNs) >= BigInt(parent.startUnixNs)).toBe(
        true
    );
    expect(end(children.at(-1)!) <= end(parent)).toBe(true);
    for (let index = 1; index < children.length; index++) {
        expect(BigInt(children[index].startUnixNs)).toBe(
            end(children[index - 1])
        );
    }
    const sum = children.reduce((total, child) => total + child.durationNs, 0);
    expect(sum).toBeLessThanOrEqual(parent.durationNs);
    expect(BigInt(sum)).toBe(
        end(children.at(-1)!) - BigInt(children[0].startUnixNs)
    );
};

const phaseSequence = (children: SharedFsMountProfileEvent[]) =>
    children.map((child) =>
        child.phase === "writeFile.guard"
            ? `guard:${child.detail?.checkpoint}`
            : child.phase === "writeFile.cacheApply"
              ? `cacheApply:${child.detail?.document}`
              : child.phase.slice("writeFile.".length)
    );

const byPhase = (children: SharedFsMountProfileEvent[], phase: string) =>
    children.find((child) => child.phase === phase)?.detail;

/** Custom mount target whose writeFile calls are observable. */
const spiedTarget = (fs: SharedFsHandle) => {
    const options: (WriteFileOptions | undefined)[] = [];
    const target: SharedFsMountBackendTarget = {
        readVersionForMount: (path, versionId) =>
            fs.readVersionForMount(path, versionId),
        writeFile: (path, source, writeOptions) => {
            options.push(writeOptions);
            return fs.writeFile(path, source, writeOptions);
        },
        setMetadata: (path, patch, metadataOptions) =>
            fs.setMetadata(path, patch, metadataOptions),
        mkdir: (path) => fs.mkdir(path),
        mutateNamespaceForMount: (mutation) =>
            fs.mutateNamespaceForMount(mutation),
        list: (path) => fs.list(path),
        versions: (path) => fs.versions(path),
        conflicts: (path, conflictOptions) =>
            fs.conflicts(path, conflictOptions),
        stat: (path) => fs.stat(path),
        bootstrapStatus: () => fs.bootstrapStatus(),
    };
    return { target, options };
};

describe("opt-in writeFile sub-phase profiling", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;

    beforeEach(async () => {
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "write-profile-test",
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await peer.stop();
    });

    it("never hands the live hook to a target that is not a SharedFs handle", async () => {
        const commit = async (
            target: SharedFsMountBackendTarget,
            path: string,
            content: string
        ) => {
            const events: SharedFsMountProfileEvent[] = [];
            const backend = createSharedFsMountBackend(target, {
                profile: (event) => events.push(event),
            });
            const handle = await backend.open(path, {
                write: true,
                create: true,
            });
            await backend.write(handle, encode(content), 0);
            await backend.release(handle);
            return events;
        };

        // A third-party target that implements the public mount target
        // contract but clones its options (as a worker or IPC proxy would):
        // a function-valued hook would make every profiled commit fail.
        const cloned: (WriteFileOptions | undefined)[] = [];
        const cloning: SharedFsMountBackendTarget = {
            ...spiedTarget(fs).target,
            writeFile: (path, source, writeOptions) => {
                const copy = structuredClone(writeOptions);
                cloned.push(copy);
                return fs.writeFile(path, source, copy);
            },
        };
        let events = await commit(cloning, "/cloned.txt", "cloned");
        expect(cloned).toHaveLength(1);
        expect(cloned[0]).not.toHaveProperty("mountProfile");
        expect(cloned[0]).toMatchObject({ expectedNodeId: null });
        expect(events.filter(isSubPhase)).toEqual([]);
        expect(events.map((event) => [event.phase, event.ok])).toEqual([
            ["mount.target.writeFile", true],
            ["mount.localCommit", true],
        ]);
        expect(decode(await fs.readFile("/cloned.txt"))).toBe("cloned");

        // A SharedFsHandle subclass that overrides writeFile loses the
        // private opt-in unless it re-establishes it.
        const seen: (WriteFileOptions | undefined)[] = [];
        class CopyingHandle extends SharedFsHandle {
            writeFile(
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                writeOptions?: WriteFileOptions
            ) {
                seen.push(writeOptions);
                return super.writeFile(
                    path,
                    source,
                    structuredClone(writeOptions)
                );
            }
        }
        events = await commit(
            new CopyingHandle(fs.program),
            "/copied.txt",
            "copied"
        );
        expect(seen).toHaveLength(1);
        expect(seen[0]).not.toHaveProperty("mountProfile");
        expect(events.filter(isSubPhase)).toEqual([]);
        expect(decode(await fs.readFile("/copied.txt"))).toBe("copied");

        // The default handle and the artifact-ignore wrapper, which forwards
        // options unchanged, keep it.
        events = await commit(fs, "/handle.txt", "handle");
        expect(events.filter(isSubPhase).length).toBeGreaterThan(0);
        const ignorePeer = await Peerbit.create();
        try {
            const ignoring = await openSharedFs({
                peerbit: ignorePeer,
                machineLabel: "write-profile-test",
                ignore: { patterns: ["dist/"] },
            });
            expect(ignoring.constructor.name).toBe("IgnoreAwareFs");
            events = await commit(ignoring, "/ignored-wrapper.txt", "wrapped");
            const [write] = joinedWrites(events);
            expectNested(write.parent, write.children);
            expect(phaseSequence(write.children).at(-1)).toBe("result");
            expect(
                decode(await ignoring.readFile("/ignored-wrapper.txt"))
            ).toBe("wrapped");
        } finally {
            await ignorePeer.stop();
        }
    });

    it("passes no hook without profiling", async () => {
        const unprofiled = spiedTarget(fs);
        const plain = createSharedFsMountBackend(unprofiled.target);
        const handle = await plain.open("/plain.txt", {
            write: true,
            create: true,
        });
        await plain.write(handle, encode("plain"), 0);
        await plain.release(handle);
        expect(unprofiled.options).toHaveLength(1);
        expect(unprofiled.options[0]).not.toHaveProperty("mountProfile");
    });

    it("keeps profiled and unprofiled writes observably identical", async () => {
        const run = async (target: SharedFsHandle, profiled: boolean) => {
            const events: SharedFsMountProfileEvent[] = [];
            const backend = createSharedFsMountBackend(target, {
                ...(profiled ? { profile: (event) => events.push(event) } : {}),
            });
            const write = async (
                path: string,
                content: string,
                flags: Parameters<typeof backend.open>[1],
                mtimeMs?: number
            ) => {
                const handle = await backend.open(path, flags);
                await backend.write(handle, encode(content), 0);
                if (mtimeMs !== undefined) {
                    await backend.setattr(path, { mtimeMs });
                }
                await backend.fsync(handle);
                await backend.release(handle);
            };
            await backend.mkdir("/d");
            await write("/d/a.txt", "hello", { write: true, create: true });
            const rewrite = { write: true, truncate: true };
            await write("/d/a.txt", "hello world", rewrite, 1000);
            // Same bytes and mtime over the same single head: an exact-head
            // no-op. An unpinned mtime is the write's clock reading, so the
            // two runs diverged whenever only one wrote both in the same ms.
            await write("/d/a.txt", "hello world", rewrite, 1000);
            // Same content elsewhere: a deduplicated chunk.
            await write("/d/b.txt", "hello world", {
                write: true,
                create: true,
            });
            const hook = profiled
                ? {
                      mountProfile: {
                          sink: (event: SharedFsMountProfileEvent) =>
                              events.push(event),
                          writeId: 1000,
                      },
                  }
                : {};
            const direct = await target.writeFile("/d/c.txt", "abcabcabc", {
                chunkSize: 3,
                ...hook,
            });
            const failures: unknown[] = [];
            for (const attempt of [
                () =>
                    target.writeFile("/d/a.txt", "stale", {
                        expectedNodeId: "file:missing",
                        ...hook,
                    }),
                () => target.writeFile("/d", "x", hook),
                () => target.writeFile("/", "x", hook),
            ]) {
                try {
                    await attempt();
                    failures.push("resolved");
                } catch (error: any) {
                    failures.push({
                        name: error?.name,
                        code: error?.code,
                        checkpoint: error?.checkpoint,
                    });
                }
            }
            const versions = await target.versions("/d/a.txt");
            const listing = await target.list("/d");
            return {
                events,
                observed: {
                    a: decode(await target.readFile("/d/a.txt")),
                    b: decode(await target.readFile("/d/b.txt")),
                    c: decode(await target.readFile("/d/c.txt")),
                    direct: {
                        size: direct.size,
                        contentHash: direct.contentHash,
                        head: direct.head,
                        parents: direct.parentVersionIds.length,
                    },
                    versions: versions.map((version) => ({
                        size: version.size,
                        contentHash: version.contentHash,
                        parents: version.parentVersionIds.length,
                    })),
                    listing: listing
                        .map((entry) => ({
                            name: entry.name,
                            kind: entry.kind,
                            size: entry.size,
                            conflict: entry.conflict,
                        }))
                        .sort((left, right) =>
                            left.name < right.name ? -1 : 1
                        ),
                    failures,
                },
            };
        };
        const otherPeer = await Peerbit.create();
        try {
            const other = await openSharedFs({
                peerbit: otherPeer,
                machineLabel: "write-profile-test",
            });
            const profiled = await run(fs, true);
            const plain = await run(other, false);
            expect(profiled.observed).toEqual(plain.observed);
            expect(plain.observed.versions).toHaveLength(2);
            expect(plain.events).toEqual([]);
            expect(profiled.events.filter(isSubPhase).length).toBeGreaterThan(
                0
            );
            expect(profiled.observed.failures).toEqual([
                {
                    name: "SharedFsExpectedNodeMismatchError",
                    code: "EAGAIN",
                    checkpoint: "initial",
                },
                {
                    name: "SharedFsError",
                    code: "EISDIR",
                    checkpoint: undefined,
                },
                {
                    name: "SharedFsError",
                    code: "EISDIR",
                    checkpoint: undefined,
                },
            ]);
        } finally {
            await otherPeer.stop();
        }
    });

    it("nests contiguous sub-phases inside the target write they join", async () => {
        const events: SharedFsMountProfileEvent[] = [];
        const backend = createSharedFsMountBackend(fs, {
            profile: (event) => events.push(event),
        });
        const create = await backend.open("/nested.txt", {
            write: true,
            create: true,
        });
        await backend.write(create, encode("hello"), 0);
        await backend.flush(create);
        await backend.release(create);
        const overwrite = await backend.open("/nested.txt", {
            write: true,
            truncate: true,
        });
        await backend.write(overwrite, encode("hello again"), 0);
        await backend.fsync(overwrite);
        await backend.release(overwrite);

        const writes = joinedWrites(events);
        expect(writes.map(({ parent }) => parent.detail?.writeId)).toEqual([
            1, 2,
        ]);
        // Every sub-phase record belongs to exactly one target write.
        expect(
            writes.reduce((sum, { children }) => sum + children.length, 0)
        ).toBe(events.filter(isSubPhase).length);
        for (const { parent, children } of writes) {
            expectNested(parent, children);
            // Sub-phases are emitted, in order, before their parent closes.
            const parentIndex = events.indexOf(parent);
            for (const child of children) {
                expect(events.indexOf(child)).toBeLessThan(parentIndex);
                expect(child).toMatchObject({
                    schema: "peerbit.shared-fs.mount-profile",
                    schemaVersion: 1,
                    source: "node-daemon",
                    operation: "writeFile",
                    ok: true,
                });
                expect(child.detail).not.toHaveProperty("code");
            }
        }
        const [created, replaced] = writes;
        expect(phaseSequence(created.children)).toEqual([
            "prepare",
            "resolvePath",
            "readHeads",
            "hash",
            "chunk",
            "touchChunks",
            "guard:before-version",
            "versionPut",
            "cacheApply:version",
            "verifyChunks",
            "guard:before-naming",
            "resolveParent",
            "namingPut",
            "cacheApply:naming",
            "result",
        ]);
        expect(phaseSequence(replaced.children)).toEqual([
            "prepare",
            "resolvePath",
            "readHeads",
            "hash",
            "loadBase",
            "chunk",
            "touchChunks",
            "guard:before-version",
            "versionPut",
            "cacheApply:version",
            "verifyChunks",
            "guard:after-version",
            "result",
        ]);
        // The fence still reports the parent write it started.
        const fsync = events.find(
            (event) =>
                event.phase === "mount.localCommit" &&
                event.operation === "fsync"
        )!;
        expect(fsync.detail?.writeFileNs).toBe(replaced.parent.durationNs);
        expect(decode(await fs.readFile("/nested.txt"))).toBe("hello again");
    });

    it("reports bytes, chunk I/O, dedup skips and outcomes in detail", async () => {
        const events: SharedFsMountProfileEvent[] = [];
        const backend = createSharedFsMountBackend(fs, {
            profile: (event) => events.push(event),
        });
        const write = async (
            path: string,
            content: string,
            flags: Parameters<typeof backend.open>[1],
            mtimeMs?: number
        ) => {
            const handle = await backend.open(path, flags);
            await backend.write(handle, encode(content), 0);
            if (mtimeMs !== undefined) {
                await backend.setattr(path, { mtimeMs });
            }
            await backend.release(handle);
        };
        await write("/first.txt", "shared bytes", {
            write: true,
            create: true,
        });
        await write("/second.txt", "shared bytes", {
            write: true,
            create: true,
        });
        const rewrite = { write: true, truncate: true };
        await write("/second.txt", "shared bytes", rewrite, 1000);
        await write("/second.txt", "shared bytes", rewrite, 1000);
        const [first, second, reused, unchanged] = joinedWrites(events);

        expect(first.parent.detail).toMatchObject({ bytes: 12, writeId: 1 });
        expect(byPhase(first.children, "writeFile.prepare")).toEqual({
            writeId: 1,
            bytes: 12,
        });
        expect(byPhase(first.children, "writeFile.resolvePath")).toEqual({
            writeId: 1,
            existing: false,
        });
        expect(byPhase(first.children, "writeFile.readHeads")).toEqual({
            writeId: 1,
            heads: 0,
        });
        expect(byPhase(first.children, "writeFile.chunk")).toEqual({
            writeId: 1,
            bytes: 12,
            chunks: 1,
            uniqueChunks: 1,
        });
        expect(byPhase(first.children, "writeFile.touchChunks")).toMatchObject({
            writeId: 1,
            chunks: 1,
            dedup: "verify",
            probes: 1,
            witnessQueries: 0,
            dedupSkips: 0,
            dedupSkipBytes: 0,
            chunkPuts: 1,
            chunkPutBytes: 12,
            absentPuts: 1,
            linkedPuts: 0,
            unprobedPuts: 0,
        });
        expect(byPhase(first.children, "writeFile.versionPut")).toEqual({
            writeId: 1,
            parents: 0,
            chunkRefs: 1,
        });
        expect(byPhase(first.children, "writeFile.verifyChunks")).toEqual({
            writeId: 1,
            chunks: 1,
            reputs: 0,
            reputBytes: 0,
        });
        expect(byPhase(first.children, "writeFile.resolveParent")).toEqual({
            writeId: 1,
            guarded: true,
        });
        expect(byPhase(first.children, "writeFile.result")).toEqual({
            writeId: 1,
            outcome: "created",
            newFile: true,
        });

        // The chunk exists and a fresh version references it: W1 skips it.
        expect(byPhase(second.children, "writeFile.touchChunks")).toMatchObject(
            {
                writeId: 2,
                probes: 1,
                witnessQueries: 1,
                dedupSkips: 1,
                dedupSkipBytes: 12,
                chunkPuts: 0,
                chunkPutBytes: 0,
            }
        );

        // Identical bytes with a new mtime reuse the head's chunks: no chunk,
        // touchChunks or verifyChunks record.
        expect(phaseSequence(reused.children)).toEqual([
            "prepare",
            "resolvePath",
            "readHeads",
            "hash",
            "loadBase",
            "guard:before-version",
            "versionPut",
            "cacheApply:version",
            "guard:after-version",
            "result",
        ]);

        // Identical bytes and metadata over the opened head: the library's
        // exact-head no-op.
        expect(phaseSequence(unchanged.children)).toEqual([
            "prepare",
            "resolvePath",
            "readHeads",
            "hash",
            "guard:no-op",
            "result",
        ]);
        expect(byPhase(unchanged.children, "writeFile.resolvePath")).toEqual({
            writeId: 4,
            existing: true,
        });
        expect(byPhase(unchanged.children, "writeFile.readHeads")).toEqual({
            writeId: 4,
            heads: 1,
        });
        expect(byPhase(unchanged.children, "writeFile.result")).toEqual({
            writeId: 4,
            outcome: "unchanged",
            newFile: false,
        });

        // Direct library calls with the hook: repeated chunks, dedup off.
        const direct: SharedFsMountProfileEvent[] = [];
        const hook = {
            sink: (event: SharedFsMountProfileEvent) => direct.push(event),
            writeId: 77,
        };
        await fs.writeFile("/chunks.txt", "abcabcxyz", {
            chunkSize: 3,
            mountProfile: hook,
        });
        expect(byPhase(direct, "writeFile.chunk")).toEqual({
            writeId: 77,
            bytes: 9,
            chunks: 3,
            uniqueChunks: 2,
        });
        expect(byPhase(direct, "writeFile.touchChunks")).toMatchObject({
            chunks: 2,
            probes: 2,
            chunkPuts: 2,
            chunkPutBytes: 6,
        });
        expect(byPhase(direct, "writeFile.versionPut")).toEqual({
            writeId: 77,
            parents: 0,
            chunkRefs: 3,
        });
        // No expected-node guard for ordinary API writes.
        expect(direct.some((event) => event.phase === "writeFile.guard")).toBe(
            false
        );
        direct.length = 0;
        await fs.writeFile("/chunks.txt", "partition-proof", {
            dedup: "off",
            mountProfile: hook,
        });
        expect(byPhase(direct, "writeFile.touchChunks")).toMatchObject({
            dedup: "off",
            probes: 0,
            chunkPuts: 1,
            unprobedPuts: 1,
        });
        expect(
            direct.some((event) => event.phase === "writeFile.verifyChunks")
        ).toBe(false);
        expect(decode(await fs.readFile("/chunks.txt"))).toBe(
            "partition-proof"
        );
    });

    it("closes the failing sub-phase with its code and emits nothing after it", async () => {
        const events: SharedFsMountProfileEvent[] = [];
        const hook = {
            sink: (event: SharedFsMountProfileEvent) => events.push(event),
            writeId: 5,
        };
        await expect(
            fs.writeFile("/", "x", { mountProfile: hook })
        ).rejects.toMatchObject({ code: "EISDIR" });
        expect(events.map((event) => [event.phase, event.ok])).toEqual([
            ["writeFile.prepare", false],
        ]);
        expect(events[0].detail).toEqual({ writeId: 5, code: "EISDIR" });

        await fs.writeFile("/existing.txt", "first");
        events.length = 0;
        await expect(
            fs.writeFile("/existing.txt", "stale", {
                expectedNodeId: "file:missing",
                mountProfile: hook,
            })
        ).rejects.toBeInstanceOf(SharedFsExpectedNodeMismatchError);
        expect(events.map((event) => [event.phase, event.ok])).toEqual([
            ["writeFile.prepare", true],
            ["writeFile.resolvePath", false],
        ]);
        expect(events[1].detail).toMatchObject({ writeId: 5, code: "EAGAIN" });

        // A replacement that wins while the version put is parked fails the
        // before-naming guard; that guard is the last record.
        const program = (fs as any).program;
        const entriesPut = program.entries.put.bind(program.entries);
        const entered = deferred();
        const allowed = deferred();
        let gate = true;
        vi.spyOn(program.entries, "put").mockImplementation(
            async (document: any, options: any) => {
                const result = await entriesPut(document, options);
                if (gate && document?.constructor?.name === "FileVersion") {
                    gate = false;
                    entered.resolve();
                    await allowed.promise;
                }
                return result;
            }
        );
        events.length = 0;
        const stale = fs.writeFile("/raced.txt", "stale", {
            expectedNodeId: null,
            mountProfile: hook,
        });
        await entered.promise;
        await fs.writeFile("/raced.txt", "winner");
        allowed.resolve();
        await expect(stale).rejects.toMatchObject({
            code: "EAGAIN",
            checkpoint: "before-naming",
        });
        expect(phaseSequence(events).slice(-3)).toEqual([
            "cacheApply:version",
            "verifyChunks",
            "guard:before-naming",
        ]);
        expect(events.slice(0, -1).every((event) => event.ok)).toBe(true);
        expect(events.at(-1)).toMatchObject({
            ok: false,
            detail: {
                writeId: 5,
                checkpoint: "before-naming",
                code: "EAGAIN",
            },
        });
        for (let index = 1; index < events.length; index++) {
            expect(BigInt(events[index].startUnixNs)).toBe(
                end(events[index - 1])
            );
        }
        expect(decode(await fs.readFile("/raced.txt"))).toBe("winner");
    });

    it("never lets a throwing or malformed hook change the write", async () => {
        const throwing = {
            sink: () => {
                throw new Error("broken observer");
            },
            writeId: 1,
        };
        await fs.writeFile("/observed.txt", "kept", {
            mountProfile: throwing,
        });
        expect(decode(await fs.readFile("/observed.txt"))).toBe("kept");

        const rejecting = {
            sink: async () => {
                throw new Error("async observer");
            },
            writeId: 2,
        };
        await fs.writeFile("/observed.txt", "kept again", {
            mountProfile: rejecting,
        });
        expect(decode(await fs.readFile("/observed.txt"))).toBe("kept again");

        // Not a sink: the write proceeds unprofiled.
        await fs.writeFile("/observed.txt", "still kept", {
            mountProfile: { sink: "nope", writeId: 3 } as any,
        });
        expect(decode(await fs.readFile("/observed.txt"))).toBe("still kept");

        // A non-integer writeId is omitted rather than recorded.
        const events: SharedFsMountProfileEvent[] = [];
        await fs.writeFile("/observed.txt", "no id", {
            mountProfile: {
                sink: (event) => events.push(event),
                writeId: Number.NaN,
            },
        });
        expect(events.length).toBeGreaterThan(0);
        for (const event of events) {
            expect(event.detail).not.toHaveProperty("writeId");
        }
    });
});
