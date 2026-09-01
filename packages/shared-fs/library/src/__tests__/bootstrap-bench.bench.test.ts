import { performance } from "node:perf_hooks";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { openSharedFs } from "../index.js";

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

describe("bootstrap bench", () => {
    const peers: Peerbit[] = [];
    afterEach(async () => {
        await Promise.allSettled(peers.splice(0).map((p) => p.stop()));
    });

    it("2000-file cold start via snapshot", { timeout: 300_000 }, async () => {
        const a = await Peerbit.create();
        peers.push(a);
        const donor = await openSharedFs({ peerbit: a, machineLabel: "d" });
        for (let round = 0; round < 4; round++) {
            await donor.writeBatch(
                Array.from({ length: 500 }, (_, i) => ({
                    path: `/t/d-${(round * 500 + i) % 200}/f-${round * 500 + i}.txt`,
                    content: `payload ${round * 500 + i}`,
                }))
            );
        }
        const snap = await donor.snapshotWrite();
        console.log(
            "snapshot:",
            JSON.stringify({
                docs: Number(snap.docs),
                bytes: Number(snap.bytes),
                segments: snap.segments,
            })
        );

        const c = await Peerbit.create();
        peers.push(c);
        await c.dial(a);
        const t0 = performance.now();
        const joiner = await openSharedFs({
            peerbit: c,
            address: donor.address,
            machineLabel: "j",
        });
        // Time to READY: overlay active. Convergence is deliberately measured
        // from this point so the retirement tail is not hidden by the tree
        // readability probe below.
        let readyStatus = joiner.bootstrapStatus();
        while (readyStatus.phase !== "overlay-active") {
            if (
                readyStatus.phase === "converged" ||
                readyStatus.phase === "unverified"
            ) {
                throw new Error(
                    `missed overlay-active phase: ${readyStatus.phase}`
                );
            }
            await new Promise((r) => setTimeout(r, 5));
            readyStatus = joiner.bootstrapStatus();
        }
        const tReady = performance.now() - t0;
        const pendingAtReady = readyStatus.pendingDocs;
        const converged = joiner.awaitBootstrapConverged().then((result) => ({
            ...result,
            atMs: performance.now() - t0,
        }));
        const pendingDrained = (async () => {
            let status = readyStatus;
            for (;;) {
                if (
                    status.phase === "overlay-active" &&
                    status.pendingDocs === 0
                ) {
                    return performance.now() - t0;
                }
                if (status.phase !== "overlay-active") {
                    throw new Error(
                        `missed pending-zero observation: ${status.phase}`
                    );
                }
                await new Promise((r) => setTimeout(r, 5));
                status = joiner.bootstrapStatus();
            }
        })();
        // Full-tree readability probe at ready.
        const listStart = performance.now();
        const dirs = await joiner.list("/t");
        let files = 0;
        for (const dir of dirs) {
            files += (await joiner.list(dir.path)).length;
        }
        const treeWalkMs = performance.now() - listStart;
        const sample = decode(await joiner.readFile("/t/d-42/f-42.txt"));
        const tTreeReadable = performance.now() - t0;
        const [tPendingDrained, convergence] = await Promise.all([
            pendingDrained,
            converged,
        ]);
        const tConverged = convergence.atMs;
        const retirementTail = tConverged - tPendingDrained;
        console.log(
            "bootstrap-bench:",
            JSON.stringify(
                {
                    tReadyMs: tReady,
                    pendingAtReady,
                    dirs: dirs.length,
                    files,
                    treeWalkMs,
                    tTreeReadableMs: tTreeReadable,
                    tPendingDrainedMs: tPendingDrained,
                    tConvergedMs: tConverged,
                    retirementTailMs: retirementTail,
                    verified: convergence.verified,
                },
                (k, v) => (typeof v === "number" ? Number(v.toFixed(1)) : v)
            )
        );
        expect(dirs.length).toBe(200);
        expect(files).toBe(2000);
        expect(sample).toBe("payload 42");
        expect(convergence.verified).toBe(true);
    });
});
