import nodeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    FileVersion,
    SharedFsError,
    SharedFsVersionUnavailableError,
    encodePublicSignKey,
    openSharedFs,
    type IgnoreAwareFs,
    type SharedFsHandle,
} from "../index.js";
import { stopTestPeers } from "./stop-test-peers.js";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const waitUntil = async (
    assertion: () => Promise<void> | void,
    timeoutMs = process.env.CI ? 90_000 : 30_000
) => {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    throw lastError;
};

const chunkIdsOf = async (fs: SharedFsHandle, versionId: string) => {
    const version = await (fs.program as any).getDocument(versionId);
    if (!(version instanceof FileVersion)) {
        throw new Error(`version ${versionId} is not resolvable`);
    }
    return new Set(version.chunkIds);
};

/**
 * Make selected chunks unreadable at the single chunk-fetch seam, so the real
 * version walk, whole-file hash check and fallback logic still run. Deleting
 * chunk entries is not usable here: GC's chunk-presence repair resurrects
 * referenced chunks.
 */
const failChunks = (
    fs: SharedFsHandle,
    ids: Set<string>,
    mode: "missing" | "tampered" = "missing"
) => {
    const program = fs.program as any;
    const original = program.fetchChunk.bind(program);
    return vi
        .spyOn(program, "fetchChunk")
        .mockImplementation(async (id: any, normalizedPath: any) => {
            if (!ids.has(id)) {
                return original(id, normalizedPath);
            }
            if (mode === "tampered") {
                return { id, bytes: encode("tampered bytes") };
            }
            throw new SharedFsError(
                "EIO",
                `Missing chunk ${id} for ${normalizedPath}`
            );
        });
};

describe("version-identified reads", () => {
    const peers: Peerbit[] = [];

    afterEach(async () => {
        vi.restoreAllMocks();
        await stopTestPeers(peers);
    });

    const open = async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        return openSharedFs({ peerbit: peer, machineLabel: "reader" });
    };

    it("identifies the visible head it read", async () => {
        const fs = await open();
        await fs.writeFile("/doc.txt", "first");
        const second = await fs.writeFile("/doc.txt", "second");

        const read = await fs.readFileWithVersion("/doc.txt");
        expect(read).toMatchObject({
            versionId: second.id,
            nodeId: second.nodeId,
            visibleVersionId: second.id,
            headVersionIds: [second.id],
            substituted: false,
            contentHash: second.contentHash,
            size: BigInt("second".length),
        });
        expect(decode(read?.bytes)).toBe("second");
        expect(decode(await fs.readFile("/doc.txt"))).toBe("second");
        expect(
            (await fs.readFileWithVersion("/doc.txt", { mode: "exact" }))
                ?.versionId
        ).toBe(second.id);
        expect(await fs.readFileWithVersion("/missing.txt")).toBeUndefined();
        await fs.mkdir("/dir");
        expect(await fs.readFileWithVersion("/dir")).toBeUndefined();
    });

    it("reports a substituted ancestor while exact reads fail closed", async () => {
        const fs = await open();
        const first = await fs.writeFile("/doc.txt", "first");
        const second = await fs.writeFile("/doc.txt", "second");
        const unavailable = await chunkIdsOf(fs, second.id);
        const fetch = failChunks(fs, unavailable);

        const read = await fs.readFileWithVersion("/doc.txt");
        expect(read).toMatchObject({
            versionId: first.id,
            visibleVersionId: second.id,
            headVersionIds: [second.id],
            substituted: true,
            contentHash: first.contentHash,
        });
        expect(decode(read?.bytes)).toBe("first");
        // readFile() keeps its availability fallback byte-for-byte.
        expect(decode(await fs.readFile("/doc.txt"))).toBe("first");

        const exact = await fs
            .readFileWithVersion("/doc.txt", { mode: "exact" })
            .then(
                () => undefined,
                (error) => error
            );
        expect(exact).toBeInstanceOf(SharedFsVersionUnavailableError);
        expect(exact).toBeInstanceOf(SharedFsError);
        expect(exact.code).toBe("EIO");
        expect(exact.versionId).toBe(second.id);
        expect(exact.path).toBe("/doc.txt");
        expect(exact.cause).toBeInstanceOf(SharedFsError);
        expect(exact.message).toMatch(/Missing chunk/);

        fetch.mockRestore();
        const recovered = await fs.readFileWithVersion("/doc.txt", {
            mode: "exact",
        });
        expect(recovered?.versionId).toBe(second.id);
        expect(decode(recovered?.bytes)).toBe("second");
    });

    it("never returns bytes that fail whole-file verification", async () => {
        const fs = await open();
        const first = await fs.writeFile("/doc.txt", "first");
        const second = await fs.writeFile("/doc.txt", "second");
        failChunks(fs, await chunkIdsOf(fs, second.id), "tampered");

        const exact = await fs
            .readFileWithVersion("/doc.txt", { mode: "exact" })
            .then(
                () => undefined,
                (error) => error
            );
        expect(exact).toBeInstanceOf(SharedFsVersionUnavailableError);
        expect(exact.versionId).toBe(second.id);
        expect(exact.message).toMatch(/hash mismatch/);

        const read = await fs.readFileWithVersion("/doc.txt");
        expect(read?.versionId).toBe(first.id);
        expect(read?.substituted).toBe(true);
        expect(decode(read?.bytes)).toBe("first");
    });

    it("walks past a missing visible version document only in available mode", async () => {
        const fs = await open();
        const first = await fs.writeFile("/doc.txt", "first");
        const second = await fs.writeFile("/doc.txt", "second");
        const program = fs.program as any;
        const original = program.getDocument.bind(program);
        vi.spyOn(program, "getDocument").mockImplementation(
            async (id: any, ...rest: any[]) =>
                id === second.id ? undefined : original(id, ...rest)
        );

        const read = await fs.readFileWithVersion("/doc.txt");
        expect(read).toMatchObject({
            versionId: first.id,
            visibleVersionId: second.id,
            substituted: true,
        });
        await expect(
            fs.readFileWithVersion("/doc.txt", { mode: "exact" })
        ).rejects.toMatchObject({
            name: "SharedFsVersionUnavailableError",
            code: "EIO",
            versionId: second.id,
        });
    });

    it("reports every head of a content conflict", async () => {
        const fs = await open();
        const base = await fs.writeFile("/doc.txt", "base");
        const left = await fs.writeFile("/doc.txt", "left", {
            baseVersionIds: [base.id],
        });
        const right = await fs.writeFile("/doc.txt", "right", {
            baseVersionIds: [base.id],
        });

        const read = await fs.readFileWithVersion("/doc.txt");
        expect(new Set(read?.headVersionIds)).toEqual(
            new Set([left.id, right.id])
        );
        // stat() is the independent oracle for the visible head and order.
        const info = await fs.stat("/doc.txt");
        expect(info?.conflict).toBe(true);
        expect(read?.visibleVersionId).toBe(info?.versionId);
        expect(read?.headVersionIds).toEqual(info?.headVersionIds);
        expect(read?.versionId).toBe(info?.versionId);
        expect(read?.substituted).toBe(false);
        expect(read?.contentHash).toBe(info?.contentHash);
        expect(decode(read?.bytes)).toBe(
            decode(await fs.readVersion("/doc.txt", info!.versionId!))
        );
        expect(
            (await fs.readFileWithVersion("/doc.txt", { mode: "exact" }))
                ?.versionId
        ).toBe(info?.versionId);
    });

    it("keeps non-verification errors untyped in exact mode", async () => {
        const fs = await open();
        await fs.writeFile("/doc.txt", "first");
        const second = await fs.writeFile("/doc.txt", "second");
        const unavailable = await chunkIdsOf(fs, second.id);
        const program = fs.program as any;
        const original = program.fetchChunk.bind(program);
        vi.spyOn(program, "fetchChunk").mockImplementation(
            async (id: any, normalizedPath: any) => {
                if (unavailable.has(id)) {
                    throw new SharedFsError("ECLOSED", "store closed");
                }
                return original(id, normalizedPath);
            }
        );

        const exact = await fs
            .readFileWithVersion("/doc.txt", { mode: "exact" })
            .then(
                () => undefined,
                (error) => error
            );
        expect(exact).toBeInstanceOf(SharedFsError);
        expect(exact).not.toBeInstanceOf(SharedFsVersionUnavailableError);
        expect(exact.code).toBe("ECLOSED");
    });

    it("rejects an unknown read mode", async () => {
        const fs = await open();
        await fs.writeFile("/doc.txt", "x");
        await expect(
            fs.readFileWithVersion("/doc.txt", { mode: "newest" as any })
        ).rejects.toMatchObject({ code: "EINVAL" });
    });

    it("keeps version identity across close and reopen", async () => {
        const directory = await nodeFs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-read-version-")
        );
        try {
            const firstPeer = await Peerbit.create({ directory });
            peers.push(firstPeer);
            const first = await openSharedFs({
                peerbit: firstPeer,
                machineLabel: "writer",
                replicate: false,
            });
            const address = first.address;
            await first.writeFile("/doc.txt", "one");
            const written = await first.writeFile("/doc.txt", "two");
            await stopTestPeers(peers);

            const secondPeer = await Peerbit.create({ directory });
            peers.push(secondPeer);
            const reopened = await openSharedFs({
                peerbit: secondPeer,
                address,
                machineLabel: "reader",
                replicate: false,
            });
            const read = await reopened.readFileWithVersion("/doc.txt", {
                mode: "exact",
            });
            expect(read).toMatchObject({
                versionId: written.id,
                contentHash: written.contentHash,
                substituted: false,
            });
            expect(decode(read?.bytes)).toBe("two");
        } finally {
            await stopTestPeers(peers);
            await nodeFs.rm(directory, { recursive: true, force: true });
        }
    });
});

describe("rulesFileAuthors gates the installed rules version", () => {
    const peers: Peerbit[] = [];

    afterEach(async () => {
        vi.restoreAllMocks();
        await stopTestPeers(peers);
    });

    it("does not install rules from an unlisted ancestor when the allowed head is unavailable", async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        const selfKey = encodePublicSignKey(peer.identity.publicKey);
        const fs = (await openSharedFs({
            peerbit: peer,
            machineLabel: "a",
            ignore: { rulesFileAuthors: [selfKey] },
        })) as IgnoreAwareFs;
        const program = fs.program as any;

        await fs.writeFile("/.artifactignore", "dist/\n");
        await waitUntil(() => {
            expect(fs.ignoreStatus().provenance).toBe("rules-file");
            expect(fs.ignoreCheck("/dist/x").ignored).toBe(true);
        });

        // An overwrite whose (advisory) author is not allowlisted is
        // rejected at the head gate; the last good rules stay.
        const signedMetadata = program.signedMetadata.bind(program);
        const impersonation = vi
            .spyOn(program, "signedMetadata")
            .mockImplementation(() => ({
                ...signedMetadata(),
                authorKey: "mallory",
            }));
        const unlisted = await fs.writeFile("/.artifactignore", "logs/\n");
        impersonation.mockRestore();
        expect(unlisted.authorKey).toBe("mallory");
        await waitUntil(() => {
            expect(fs.ignoreStatus().degraded).toMatch(
                /head authored by mallory/
            );
        });
        expect(fs.ignoreCheck("/logs/x").ignored).toBe(false);

        // An allowed author overwrites it: the gate passes again.
        const allowed = await fs.writeFile("/.artifactignore", "cache/\n");
        await waitUntil(() => {
            expect(fs.ignoreStatus().degraded).toBeUndefined();
            expect(fs.ignoreCheck("/cache/x").ignored).toBe(true);
        });

        // The allowed head's content becomes unavailable. The read falls
        // back to the unlisted ancestor, which must not be installed.
        failChunks(fs, await chunkIdsOf(fs, allowed.id));
        const substituted = await fs.readFileWithVersion("/.artifactignore");
        expect(substituted?.versionId).toBe(unlisted.id);
        await fs.ignorePolicy.refresh();

        expect(fs.ignoreStatus().degraded).toMatch(
            new RegExp(`version ${unlisted.id} authored by mallory`)
        );
        expect(fs.ignoreStatus().provenance).toBe("rules-file");
        expect(fs.ignoreCheck("/cache/x").ignored).toBe(true); // last good
        expect(fs.ignoreCheck("/logs/x").ignored).toBe(false);
    });

    it("fails closed when the installed version's author cannot be checked", async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        const fs = (await openSharedFs({
            peerbit: peer,
            machineLabel: "a",
            ignore: {
                rulesFileAuthors: [
                    encodePublicSignKey(peer.identity.publicKey),
                ],
            },
        })) as IgnoreAwareFs;
        await fs.writeFile("/.artifactignore", "cache/\n");
        await waitUntil(() => {
            expect(fs.ignoreStatus().provenance).toBe("rules-file");
            expect(fs.ignoreCheck("/cache/x").ignored).toBe(true);
        });

        // Without the version list only the naming author passes the head
        // gate; the content author of the version read is unknown.
        vi.spyOn(fs.program as any, "versions").mockRejectedValue(
            new Error("index busy")
        );
        await fs.writeFile("/.artifactignore", "tmp/\n");
        await fs.ignorePolicy.refresh();

        expect(fs.ignoreStatus().degraded).toMatch(/an unchecked author/);
        expect(fs.ignoreCheck("/cache/x").ignored).toBe(true); // last good
        expect(fs.ignoreCheck("/tmp/x").ignored).toBe(false);
    });
});
