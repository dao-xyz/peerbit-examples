import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    createSharedFsMountBackend,
    openSharedFs,
    type SharedFsHandle,
} from "../index.js";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

describe("mounted fsync batch safety boundary", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;

    beforeEach(async () => {
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "mount-fsync-batch-safety",
            gc: false,
        });
    });

    afterEach(async () => {
        await peer.stop();
    });

    it("shows that writeBatch absorbs a newer head instead of preserving the opened base", async () => {
        const exactOriginal = await fs.writeFile("/exact.txt", "original");
        const ceilingOriginal = await fs.writeFile("/ceiling.txt", "original");
        const backend = createSharedFsMountBackend(fs);
        const handle = await backend.open("/exact.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("mounted!"), 0);

        const exactConcurrent = await fs.writeFile("/exact.txt", "peer-new", {
            baseVersionIds: [exactOriginal.id],
        });
        const ceilingConcurrent = await fs.writeFile(
            "/ceiling.txt",
            "peer-new",
            { baseVersionIds: [ceilingOriginal.id] }
        );

        await backend.fsync(handle);
        await backend.release(handle);
        const ceilingBatch = await fs.writeBatch([
            { path: "/ceiling.txt", content: "mounted!" },
        ]);

        const exactHeads = (await fs.versions("/exact.txt")).filter(
            (version) => version.head
        );
        expect(exactHeads).toHaveLength(2);
        expect(exactHeads.map((version) => version.id)).toContain(
            exactConcurrent.id
        );
        const exactMounted = exactHeads.find(
            (version) => version.id !== exactConcurrent.id
        );
        expect(exactMounted?.parentVersionIds).toEqual([exactOriginal.id]);

        const ceilingHeads = (await fs.versions("/ceiling.txt")).filter(
            (version) => version.head
        );
        expect(ceilingHeads).toHaveLength(1);
        expect(ceilingHeads[0].id).toBe(ceilingBatch.results[0]?.id);
        expect(ceilingHeads[0].parentVersionIds).toEqual([
            ceilingConcurrent.id,
        ]);
    });

    it("shows that writeBatch can publish stale buffered bytes through a replacement node", async () => {
        const exactOriginal = await fs.writeFile("/exact.txt", "original");
        const ceilingOriginal = await fs.writeFile("/ceiling.txt", "original");
        const backend = createSharedFsMountBackend(fs);
        const handle = await backend.open("/exact.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("stale!!!"), 0);

        await fs.rm("/exact.txt");
        const exactReplacement = await fs.writeFile(
            "/exact.txt",
            "replacement"
        );
        await fs.rm("/ceiling.txt");
        const ceilingReplacement = await fs.writeFile(
            "/ceiling.txt",
            "replacement"
        );
        expect(exactReplacement.nodeId).not.toBe(exactOriginal.nodeId);
        expect(ceilingReplacement.nodeId).not.toBe(ceilingOriginal.nodeId);

        await expect(backend.fsync(handle)).rejects.toMatchObject({
            code: "EAGAIN",
        });
        await backend.release(handle);
        expect(decode(await fs.readFile("/exact.txt"))).toBe("replacement");

        const ceilingBatch = await fs.writeBatch([
            { path: "/ceiling.txt", content: "stale!!!" },
        ]);
        expect(ceilingBatch.results[0]?.nodeId).toBe(ceilingReplacement.nodeId);
        expect(decode(await fs.readFile("/ceiling.txt"))).toBe("stale!!!");
    });

    it("demonstrates the batch-wide rejection and committed-prefix failure domain", async () => {
        await fs.writeBatch([
            { path: "/one.txt", content: "old-one" },
            { path: "/two.txt", content: "old-two" },
        ]);
        const documents = fs.program.entries;
        const originalPut = documents.put.bind(documents);
        const originalPutMany = documents.putMany.bind(documents);
        documents.putMany = (async (
            ...args: Parameters<typeof documents.putMany>
        ) => {
            await originalPut(args[0][0], args[1]);
            throw new Error("injected failure after a committed prefix");
        }) as typeof documents.putMany;
        try {
            await expect(
                fs.writeBatch([
                    { path: "/one.txt", content: "new-one" },
                    { path: "/two.txt", content: "new-two" },
                ])
            ).rejects.toThrow("injected failure after a committed prefix");
        } finally {
            documents.putMany = originalPutMany;
        }

        expect(decode(await fs.readFile("/one.txt"))).toBe("new-one");
        expect(decode(await fs.readFile("/two.txt"))).toBe("old-two");
    });
});
