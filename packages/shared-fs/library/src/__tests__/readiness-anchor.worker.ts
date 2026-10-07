// Child process for readiness-anchor-host.test.ts and
// readiness-worker-tsx.node.test.ts, run with `node --import tsx`, so the
// worker source is serialized from tsx-transformed functions (S13).
// Scenarios (argv[2]):
// - pending: the only work left is a pending digestNow; the process must
//   stay alive until it arrives (S14), print it and exit 0.
// - idle: a lane set stays open after a round trip; nothing else is
//   pending, so the process must exit 0 by itself.
// - filesystem: opens a filesystem, writes, and reports the anchor host mode
//   after a digest and a cells round trip through the namespace lane set.
import * as crypto from "node:crypto";
import { createAnchorMath } from "../readiness/anchor.js";
import { AnchorHost } from "../readiness/anchor-host.js";
import { Cells } from "../readiness/cells.js";
import { LANES, M } from "../readiness/constants.js";

const scenario = process.argv[2];
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const element = (i: number) =>
    new Uint8Array(
        crypto
            .createHash("sha256")
            .update("child-" + i)
            .digest()
    );
const iv = new Uint8Array(16).fill(9);

const expected = (n: number) => {
    const math = createAnchorMath(crypto as any);
    const lanes = new Uint32Array(LANES);
    for (let i = 0; i < n; i++) math.applyMany(lanes, iv, element(i), 1);
    return hex(math.digest(lanes, iv));
};

const report = (value: Record<string, unknown>) =>
    process.stdout.write(JSON.stringify(value) + "\n");

if (scenario === "pending") {
    const host = await AnchorHost.shared();
    const set = host.open(iv);
    for (let i = 0; i < 2000; i++) set.apply(element(i), 1);
    // No await keeps this module alive past here: only the request does.
    void set.digestNow().digest.then((digest) => {
        report({
            scenario,
            mode: host.mode,
            digest: hex(digest),
            expected: expected(2000),
        });
    });
} else if (scenario === "idle") {
    const host = await AnchorHost.shared();
    const set = host.open(iv);
    for (let i = 0; i < 10; i++) set.apply(element(i), 1);
    const digest = await set.digestNow().digest;
    report({
        scenario,
        mode: host.mode,
        workerRunning: host.workerRunning,
        openSets: host.openSets,
        digest: hex(digest),
        expected: expected(10),
    });
    // The set stays open on purpose: an idle host must not keep the
    // process alive.
} else if (scenario === "filesystem") {
    const { Peerbit } = await import("peerbit");
    const { openSharedFs } = await import("../index.js");
    const peer = await Peerbit.create();
    try {
        const fs = await openSharedFs({ peerbit: peer });
        await fs.writeFile("/a.txt", new TextEncoder().encode("a"));
        const runtime = (fs.program as any).readinessRuntime;
        await runtime.whenStarted();
        const scope = runtime.scope(0);
        const { seq, digest } = scope.laneSet.digestNow();
        const { cells } = scope.laneSet.cellsNow();
        const list = new Uint8Array(scope.tap.count * 32);
        const fresh = new Cells(M, runtime.cellKey[0], runtime.cellKey[1]);
        let offset = 0;
        scope.tap.map.forEach((head: Uint8Array) => {
            list.set(head, offset);
            fresh.apply(head, 1);
            offset += 32;
        });
        const value = await digest;
        const ofList = await scope.laneSet.digestOf(list);
        const host = await AnchorHost.shared();
        report({
            scenario,
            mode: host.mode,
            failures: host.stats.failures,
            inlineReason: host.stats.inlineReason ?? null,
            seq,
            epoch: scope.tap.epoch,
            count: scope.tap.count,
            digest: hex(value),
            digestOfList: hex(ofList),
            cellsMatch: hex(await cells) === hex(fresh.toBytes()),
        });
    } finally {
        await peer.stop();
    }
}
