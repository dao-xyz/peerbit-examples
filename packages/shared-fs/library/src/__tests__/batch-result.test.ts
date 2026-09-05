import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    FileVersion,
    SharedFileSystem,
    openSharedFs,
    type SharedFsHandle,
    type SharedFsVersionInfo,
} from "../index.js";

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

describe("shared fs batch result assembly", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;

    beforeEach(async () => {
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "batch-result",
            bootstrap: false,
            gc: false,
        });
    });

    afterEach(async () => {
        await peer.stop();
    });

    const expectStoredResult = async (
        result: SharedFsVersionInfo | undefined,
        path: string
    ) => {
        expect(result).toBeDefined();
        const version = await fs.program.entries.index.get(result!.id, {
            local: true,
            remote: false,
        });
        if (!(version instanceof FileVersion)) {
            throw new Error("Expected the result's stored FileVersion");
        }
        const stored = version;
        expect(result).toEqual({
            id: stored.id,
            nodeId: stored.nodeId,
            path,
            size: stored.size,
            contentHash: stored.contentHash,
            parentVersionIds: stored.parentVersionIds,
            createdAt: stored.createdAt,
            authorKey: stored.authorKey,
            machineLabel: stored.machineLabel,
            deleted: false,
            head: true,
        });
        expect((await fs.versions(path)).filter((item) => item.head)).toEqual([
            result,
        ]);
        return stored;
    };

    it("returns every stored field for a create and an overwrite", async () => {
        const first = await fs.writeBatch([
            { path: "/nested/new.txt", content: "created" },
        ]);
        const created = await expectStoredResult(
            first.results[0],
            "/nested/new.txt"
        );
        expect(created.parentVersionIds).toEqual([]);

        const second = await fs.writeBatch([
            { path: "/nested/new.txt", content: "overwritten" },
        ]);
        const overwritten = await expectStoredResult(
            second.results[0],
            "/nested/new.txt"
        );
        expect(overwritten.nodeId).toBe(created.nodeId);
        expect(overwritten.parentVersionIds).toEqual([created.id]);
        expect(decode(await fs.readFile("/nested/new.txt"))).toBe(
            "overwritten"
        );
    });

    it("returns the sole new head after merging every captured conflict head", async () => {
        const base = await fs.writeFile("/conflict.txt", "base");
        const left = await fs.writeFile("/conflict.txt", "left", {
            baseVersionIds: [base.id],
        });
        const right = await fs.writeFile("/conflict.txt", "right", {
            baseVersionIds: [base.id],
        });
        const before = (await fs.versions("/conflict.txt")).filter(
            (item) => item.head
        );
        expect(before.map((item) => item.id).sort()).toEqual(
            [left.id, right.id].sort()
        );

        const batch = await fs.writeBatch([
            { path: "/conflict.txt", content: "merged" },
        ]);
        const merged = await expectStoredResult(
            batch.results[0],
            "/conflict.txt"
        );
        // History enumeration and causal-head selection have different sort
        // orders; the exact result/stored parent ordering is checked above.
        expect(merged.parentVersionIds.sort()).toEqual(
            before.map((item) => item.id).sort()
        );
        expect(decode(await fs.readFile("/conflict.txt"))).toBe("merged");
    });

    it("keeps unchanged and deleted result slots undefined and in input order", async () => {
        const unchanged = await fs.writeFile("/same.txt", "same");
        await fs.writeFile("/remove.txt", "remove");
        const batch = await fs.writeBatch([
            { path: "/same.txt", content: "same" },
            { path: "/remove.txt", delete: true },
            { path: "/new.txt", content: "new" },
            { path: "/missing.txt", delete: true },
        ]);
        expect(batch.results).toHaveLength(4);
        expect(batch.results[0]).toBeUndefined();
        expect(batch.results[1]).toBeUndefined();
        await expectStoredResult(batch.results[2], "/new.txt");
        expect(batch.results[3]).toBeUndefined();
        expect(await fs.versions("/same.txt")).toEqual([unchanged]);
        expect(await fs.stat("/remove.txt")).toBeUndefined();
        expect(await fs.stat("/missing.txt")).toBeUndefined();
    });
});

describe("batch result-only work equivalence", () => {
    it.each([0, 1, 64])(
        "eliminates duplicate result assembly with %i captured parent heads",
        (parents) => {
            const counts = {
                parentDecodes: 0,
                rowConversions: 0,
                headVisits: 0,
            };
            const parentIds = Array.from(
                { length: parents },
                (_, i) => `v:${i}`
            );
            const version = new FileVersion({
                id: "v:new",
                nodeId: "file:fixture",
                parentVersionIds: parentIds,
                causalDepth: 7n,
                contentHash: "fixture-hash",
                size: 123n,
                chunkIds: ["chunk:fixture"],
                createdAt: 456n,
                authorKey: "fixture-author",
                machineLabel: "fixture-machine",
                changesetId: "fixture-turn",
            });
            const parentGetter = Object.getOwnPropertyDescriptor(
                FileVersion.prototype,
                "parentVersionIds"
            )!.get!;
            // Observe only this fixture instance, never shared prototypes.
            Object.defineProperty(version, "parentVersionIds", {
                get() {
                    counts.parentDecodes++;
                    return parentGetter.call(this) as string[];
                },
            });
            const oldHeads = parentIds.map((id) => ({
                get id() {
                    counts.headVisits++;
                    return id;
                },
            }));
            // Reproduce the removed local result assembly, not any database,
            // hashing, signature, or publication work. Both paths call the
            // real formatter; this is a deterministic work count, not timing.
            const rowOf = (raw: FileVersion) => {
                counts.rowConversions++;
                return {
                    id: raw.id,
                    nodeId: raw.nodeId,
                    causalDepth: BigInt(raw.causalDepth ?? 0),
                    createdAt: BigInt(raw.createdAt ?? 0),
                    size: BigInt(raw.size ?? 0),
                    contentHash: raw.contentHash,
                    parentVersionIds: raw.parentVersionIds,
                    authorKey: raw.authorKey,
                    machineLabel: raw.machineLabel,
                    changesetId: raw.changesetId,
                };
            };
            const format = (SharedFileSystem.prototype as any).versionInfo;
            const referenced = new Set(version.parentVersionIds);
            const legacy = format(rowOf(version), "/fixture.txt", [
                rowOf(version),
                ...oldHeads.filter((head) => !referenced.has(head.id)),
            ]);
            expect(counts).toEqual({
                parentDecodes: 3,
                rowConversions: 2,
                headVisits: parents,
            });
            counts.parentDecodes = 0;
            counts.rowConversions = 0;
            counts.headVisits = 0;
            const direct = format(version, "/fixture.txt", [version]);
            expect(direct).toEqual(legacy);
            expect(counts).toEqual({
                parentDecodes: 1,
                rowConversions: 0,
                headVisits: 0,
            });
        }
    );
});
