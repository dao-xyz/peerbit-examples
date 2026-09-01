import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    NamingEvent,
    createSharedFsMountBackend,
    openSharedFs,
    type IgnoreAwareFs,
    type SharedFsHandle,
} from "../index.js";

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const waitUntil = async (
    assertion: () => Promise<void> | void,
    options: { timeoutMs?: number; intervalMs?: number } = {}
) => {
    const timeoutMs = options.timeoutMs ?? (process.env.CI ? 90_000 : 30_000);
    const intervalMs = options.intervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }
    throw lastError;
};

describe("shared fs artifact ignores", () => {
    const peers: Peerbit[] = [];

    afterEach(async () => {
        await Promise.allSettled(
            peers.splice(0).map(async (peer) => {
                try {
                    await peer.stop();
                } catch {
                    /* benign close races */
                }
            })
        );
    });

    const createPeer = async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        return peer;
    };

    it("seals node_modules directories at ingest, on every entry point", async () => {
        const peer = await createPeer();
        const fs = await openSharedFs({ peerbit: peer, machineLabel: "a" });
        // Friendly SDK errors.
        await expect(fs.mkdir("/node_modules")).rejects.toThrow(/sealed/);
        await expect(fs.mkdir("/pkg/node_modules")).rejects.toThrow(/sealed/);
        await expect(
            fs.writeBatch([
                { path: "/apps/node_modules/lodash/index.js", content: "x" },
            ])
        ).rejects.toThrow(/sealed/);
        await expect(fs.rename("/whatever", "/node_modules")).rejects.toThrow(); // ENOENT source, but never a sealed dir
        // A FILE named node_modules stays legal (a script, say).
        await fs.writeFile("/node_modules", "#!/bin/sh");
        expect(decode(await fs.readFile("/node_modules"))).toBe("#!/bin/sh");
        // Ingest bounce even when the SDK layer is bypassed: a raw
        // sealed-name directory event is rejected by canPerform.
        const program: any = fs.program;
        const event = new NamingEvent({
            id: "naming:forged-sealed",
            nodeId: "dir:forged",
            parentId: "root",
            name: "node_modules",
            causalDepth: 1n,
            parentNamingIds: [],
            createdAt: 1n,
            authorKey: "x",
            machineLabel: "x",
        });
        await expect(program.entries.put(event)).rejects.toThrow();
        // Reserved control names are rejected everywhere.
        await expect(fs.writeFile("/.peerbit-x", "no")).rejects.toThrow(
            /reserved/
        );
        await expect(fs.mkdir("/.peerbit-y")).rejects.toThrow(/reserved/);
    });

    it("rejects ignored writes with typed errors and full verdicts", async () => {
        const peer = await createPeer();
        const fs = (await openSharedFs({
            peerbit: peer,
            machineLabel: "a",
            ignore: { patterns: ["dist/", "/apps/*/coverage"] },
        })) as IgnoreAwareFs;
        expect(fs.ignoreCheck("/dist/bundle.js").ignored).toBe(true);
        expect(fs.ignoreStatus().provenance).toBe("open-args");

        await expect(fs.writeFile("/dist/x.js", "1")).rejects.toThrow(
            /artifact-ignored/
        );
        await expect(fs.mkdir("/dist")).rejects.toThrow(/artifact-ignored/);
        await expect(
            fs.writeFile("/apps/web/coverage/lcov.info", "1")
        ).rejects.toThrow(/artifact-ignored/);
        // Not-ignored paths flow normally.
        await fs.mkdir("/src");
        await fs.writeFile("/src/main.ts", "ok");
        // rm of an ignored, non-existent path is ENOENT (not EIGNORED).
        await expect(fs.rm("/dist/never.js")).rejects.toThrow(/does not exist/);
        // rename across the boundary is EXDEV, both directions.
        await expect(
            fs.rename("/src/main.ts", "/dist/main.ts")
        ).rejects.toThrow(/boundary/);
        await expect(fs.rename("/dist/x", "/src/x")).rejects.toThrow(
            /boundary/
        );
        // A directory move that would carry an anchored boundary with it.
        await fs.mkdir("/apps");
        await expect(fs.rename("/apps", "/apps2")).rejects.toThrow(/boundary/);
    });

    it("keeps delegated mount commits behind the ignore-aware write override", async () => {
        const peer = await createPeer();
        const fs = (await openSharedFs({
            peerbit: peer,
            machineLabel: "a",
            ignore: {},
        })) as IgnoreAwareFs;
        await fs.writeFile("/later.tmp", "base");
        const backend = createSharedFsMountBackend(fs);
        const handle = await backend.open("/later.tmp", {
            read: true,
            write: true,
        });
        await backend.write(handle, new TextEncoder().encode("next"), 0);

        // Change policy after open so the mount's early ignoreCheck cannot be
        // the enforcing layer. The inherited capability must still dispatch
        // through IgnoreAwareFs.writeFile at commit time.
        await fs.program.writeFile("/.artifactignore", "later.tmp\n");
        await waitUntil(() => {
            expect(fs.ignoreCheck("/later.tmp").ignored).toBe(true);
        });

        await expect(backend.flush(handle)).rejects.toMatchObject({
            code: "EACCES",
        });
        expect(decode(await fs.program.readFile("/later.tmp"))).toBe("base");
    });

    it("skips ignored batch entries explicitly under onIgnored: skip", async () => {
        const peer = await createPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "a",
            ignore: { patterns: ["dist/"] },
        });
        await expect(
            fs.writeBatch([
                { path: "/src/a.ts", content: "1" },
                { path: "/dist/a.js", content: "1" },
            ])
        ).rejects.toThrow(/artifact-ignored/);
        const result = await fs.writeBatch(
            [
                { path: "/src/a.ts", content: "1" },
                { path: "/dist/a.js", content: "1" },
                { path: "/dist/b.js", content: "2" },
            ],
            { onIgnored: "skip" }
        );
        // Positional contract: results[i] corresponds to entries[i]
        // even when entries were skipped.
        expect(result.results).toHaveLength(3);
        expect(result.results[0]).toBeDefined();
        expect(result.results[0]?.path).toBe("/src/a.ts");
        expect(result.results[1]).toBeUndefined();
        expect(result.results[2]).toBeUndefined();
        expect(result.skipped?.map((s) => s.path)).toEqual([
            "/dist/a.js",
            "/dist/b.js",
        ]);
        expect(decode(await fs.readFile("/src/a.ts"))).toBe("1");
        expect(await fs.stat("/dist/a.js")).toBeUndefined();
    });

    it("pins waste-not-corruption: divergent policies never change shared state", async () => {
        const a = await createPeer();
        const b = await createPeer();
        await a.dial(b);
        const fsA = (await openSharedFs({
            peerbit: a,
            machineLabel: "a",
            ignore: { patterns: ["logs/"], showLeaked: "hide" },
        })) as IgnoreAwareFs;
        const fsB = await openSharedFs({
            peerbit: b,
            address: fsA.address,
            machineLabel: "b",
            // The fixture joins a deliberately empty address, which has no
            // namespace arrival from which to establish readiness.
            allowPartialWrites: true,
        });
        // B (no policy) writes what A ignores; A accepts and replicates
        // it — policy governs writes and views, never acceptance.
        await fsB.writeBatch([
            { path: "/logs/app.log", content: "leaked" },
            { path: "/src/real.ts", content: "kept" },
        ]);
        await waitUntil(async () => {
            expect(decode(await fsA.readFile("/src/real.ts"))).toBe("kept");
            // Exact-path reads of leaked entries always work (exclude
            // hides, it never blocks open)...
            expect(decode(await fsA.readFile("/logs/app.log"))).toBe("leaked");
        });
        // ...and stat tags them.
        expect((await fsA.stat("/logs/app.log"))?.ignoredLeak).toBe(true);
        // Default view hides the leaked tree; includeIgnored restores it.
        expect((await fsA.list("/")).map((entry) => entry.name)).not.toContain(
            "logs"
        );
        expect(
            (await fsA.list("/", { includeIgnored: true })).map(
                (entry) => entry.name
            )
        ).toContain("logs");
        // A's own writes into the ignored tree are rejected...
        await expect(fsA.writeFile("/logs/mine.log", "no")).rejects.toThrow(
            /artifact-ignored/
        );
        // ...and rm of the leaked entry points at the hygiene flow.
        await expect(fsA.rm("/logs/app.log")).rejects.toThrow(/hygiene/);
    });

    it("adopts, degrades and re-binds the replicated rules file", async () => {
        const peer = await createPeer();
        const fs = (await openSharedFs({
            peerbit: peer,
            machineLabel: "a",
            ignore: {},
        })) as IgnoreAwareFs;
        // No rules yet: everything writable.
        await fs.mkdir("/dist");
        await fs.writeFile("/dist/pre.js", "1");
        // The rules file is ordinary replicated data.
        await fs.writeFile("/.artifactignore", "# artifacts\ndist/\n");
        await waitUntil(() => {
            expect(fs.ignoreStatus().provenance).toBe("rules-file");
            expect(fs.ignoreCheck("/dist/x").ignored).toBe(true);
        });
        await expect(fs.writeFile("/dist/post.js", "1")).rejects.toThrow(
            /artifact-ignored/
        );
        // Pre-existing data under the new rule stays readable, hidden by
        // default, annotated on request.
        expect(decode(await fs.readFile("/dist/pre.js"))).toBe("1");
        // A catch-all hijack keeps the LAST GOOD rules and degrades
        // loudly instead of blacking out the tree.
        await fs.writeFile("/.artifactignore", "*\n");
        await waitUntil(() => {
            expect(fs.ignoreStatus().degraded).toMatch(/invalid/);
        });
        expect(fs.ignoreCheck("/dist/x").ignored).toBe(true); // last good
        expect(fs.ignoreCheck("/src/x").ignored).toBe(false);
        // Delete + recreate mints a fresh node: the slot watcher rebinds.
        await fs.rm("/.artifactignore");
        await fs.writeFile("/.artifactignore", "logs/\n");
        await waitUntil(() => {
            expect(fs.ignoreStatus().degraded).toBeUndefined();
            expect(fs.ignoreCheck("/logs/x").ignored).toBe(true);
            expect(fs.ignoreCheck("/dist/x").ignored).toBe(false);
        });
        // Renaming the rules file away disables it — the watcher tracks
        // the node, whose rename event carries the NEW name.
        await fs.rename("/.artifactignore", "/rules-disabled.txt");
        await waitUntil(() => {
            expect(fs.ignoreStatus().provenance).not.toBe("rules-file");
            expect(fs.ignoreCheck("/logs/x").ignored).toBe(false);
        });
    });

    it("covers advisory-only fleets: manifest rules install and stick", async () => {
        const donorPeer = await createPeer();
        const donor = (await openSharedFs({
            peerbit: donorPeer,
            machineLabel: "donor",
            ignore: { patterns: ["dist/"] },
        })) as IgnoreAwareFs;
        await donor.writeBatch(
            Array.from({ length: 120 }, (_, i) => ({
                path: `/tree/d-${i % 6}/f-${i}.txt`,
                content: `c${i}`,
            }))
        );
        // NO rules file anywhere: the fleet's policy travels only via
        // signed manifest advisory.
        await donor.snapshotWrite();

        const joinerPeer = await createPeer();
        await joinerPeer.dial(donorPeer);
        const joiner = (await openSharedFs({
            peerbit: joinerPeer,
            address: donor.address,
            machineLabel: "joiner",
            ignore: {},
        })) as IgnoreAwareFs;
        await waitUntil(
            () => {
                expect(joiner.ignoreStatus().provenance).toBe(
                    "manifest-advisory"
                );
            },
            { intervalMs: 20 }
        );
        await expect(joiner.writeFile("/dist/x.js", "1")).rejects.toThrow(
            /artifact-ignored/
        );
        // Sticky after convergence: advisory rules hold until a REAL
        // rules file replaces them.
        await joiner.awaitBootstrapConverged();
        await joiner.awaitWriteReady();
        // Trigger refresh via an unrelated same-named file in a subdir —
        // which must NOT collapse the advisory policy (slot-scoped
        // watcher + sticky last-good).
        await joiner.mkdir("/sub");
        await joiner.writeFile("/sub/.artifactignore", "unrelated/\n");
        await new Promise((resolve) => setTimeout(resolve, 800));
        expect(joiner.ignoreStatus().provenance).toBe("manifest-advisory");
        await expect(joiner.writeFile("/dist/y.js", "1")).rejects.toThrow(
            /artifact-ignored/
        );
    });

    it("carries advisory rules through snapshot manifests for the bootstrap window", async () => {
        const donorPeer = await createPeer();
        const donor = (await openSharedFs({
            peerbit: donorPeer,
            machineLabel: "donor",
            ignore: { patterns: ["dist/"] },
        })) as IgnoreAwareFs;
        await donor.writeBatch(
            Array.from({ length: 200 }, (_, i) => ({
                path: `/tree/d-${i % 10}/f-${i}.txt`,
                content: `c${i}`,
            }))
        );
        // The fleet's durable rules live in the replicated file; the
        // manifest advisory covers the window before it is readable.
        await donor.writeFile("/.artifactignore", "dist/\n");
        await donor.snapshotWrite();

        const joinerPeer = await createPeer();
        await joinerPeer.dial(donorPeer);
        const joiner = (await openSharedFs({
            peerbit: joinerPeer,
            address: donor.address,
            machineLabel: "joiner",
            ignore: {},
        })) as IgnoreAwareFs;
        // The manifest's advisory patterns reach the joiner's program at
        // accept time and its policy engine shortly after.
        await waitUntil(
            () => {
                expect(
                    (joiner.program as any).bootstrapAdvisoryIgnorePatterns
                ).toEqual(["dist/"]);
            },
            { intervalMs: 20 }
        );
        await waitUntil(() => {
            const status = joiner.ignoreStatus();
            expect(status.patterns).toContain("dist/");
        });
        await expect(joiner.writeFile("/dist/x.js", "1")).rejects.toThrow(
            /artifact-ignored/
        );
        await joiner.awaitBootstrapConverged();
    });
});
