// Child process for readiness-persist.test.ts, run with `node --import tsx`.
// Scenarios (argv[2], directory argv[3], optional address argv[4]):
// - close: opens (or reopens) a filesystem, writes, reports its address and
//   then starts `peer.stop()` without awaiting it. Nothing else keeps the
//   process alive, so the structures file is written only if the close
//   itself does (S14).
// - crash: reopens the filesystem, writes, reports, and kills itself with
//   SIGKILL before any close.
import { Peerbit } from "peerbit";
import { openSharedFs } from "../index.js";

const [scenario, directory, address] = process.argv.slice(2);

const report = (value: Record<string, unknown>) =>
    new Promise<void>((resolve) =>
        process.stdout.write(JSON.stringify(value) + "\n", () => resolve())
    );

const peer = await Peerbit.create({ directory });
const fs = await openSharedFs({
    peerbit: peer,
    ...(address ? { address } : {}),
    bootstrap: false,
    gc: false,
});
const runtime = (fs.program as any).readinessRuntime;
await runtime.whenStarted();
const prefix = address ? "again" : "first";
for (let i = 0; i < 20; i++) {
    await fs.writeFile(`/${prefix}-${i}.txt`, `${prefix} ${i}`);
}
await report({
    scenario,
    address: fs.address,
    store: Buffer.from(runtime.namespaceStore).toString("hex"),
    start: runtime.starts.get("namespace-v1"),
    count: runtime.namespace.count,
    mode: runtime.anchorHost.mode,
});
if (scenario === "crash") {
    process.kill(process.pid, "SIGKILL");
} else {
    void peer.stop();
}
