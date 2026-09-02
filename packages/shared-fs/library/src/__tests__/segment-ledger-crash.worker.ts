import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SharedFileSystem } from "../index.js";
import type {
    SegmentLedgerCrashScenario,
    SegmentLedgerCrashWorkerMessage,
} from "./segment-ledger-crash.protocol.js";

const scenario = process.argv[2] as SegmentLedgerCrashScenario | undefined;
const root = process.argv[3];
const scenarios = new Set<SegmentLedgerCrashScenario>([
    "lock-candidate-durable",
    "ledger-temp-durable",
    "ledger-directory-durable",
    "lock-release-detached",
]);

if (!scenario || !scenarios.has(scenario) || !root) {
    throw new Error(
        "Expected segment-ledger-crash.worker.ts <scenario> <root>"
    );
}

process.once("disconnect", () => process.exit(2));

const send = (message: SegmentLedgerCrashWorkerMessage) =>
    new Promise<void>((resolve, reject) => {
        if (!process.send) {
            reject(new Error("Crash worker requires a Node IPC channel"));
            return;
        }
        process.send(message, (error) => {
            if (error) reject(error);
            else resolve();
        });
    });

const parkForParentKill = () =>
    new Promise<never>(() => {
        setInterval(() => undefined, 60_000);
    });

const ledger = (cids: string[], generation: number) => ({
    v: 1,
    generation,
    current: null,
    retired: cids.map((cid, index) => ({
        cids: [{ cid, bytes: cid.length }],
        retiredAtMs: index + 1,
        snapshotSeq: `${index + 1}`,
    })),
});

const run = async () => {
    await mkdir(root, { recursive: true });
    const ledgerPath = join(root, "ledger.json");
    const program: any = new SharedFileSystem();
    program.segmentLedgerPath = async () => ledgerPath;
    let tokenSequence = 0;
    const nextToken = () => `${scenario}-${process.pid}-${++tokenSequence}`;

    if (scenario === "lock-candidate-durable") {
        program.setSegmentLedgerRuntimeForTest({
            nextToken,
            onStage: async (stage: string, context: any) => {
                if (stage !== scenario) return;
                await send({
                    type: "checkpoint",
                    scenario,
                    ledgerPath,
                    artifactPath: context.artifactPath,
                });
                await parkForParentKill();
            },
        });
        await program.acquireSegmentLedgerLock(ledgerPath);
        throw new Error("candidate crash checkpoint unexpectedly resumed");
    }

    program.setSegmentLedgerRuntimeForTest({ nextToken });
    await program.saveSegmentLedgerCas(0, ledger(["baseline"], 0));
    program.setSegmentLedgerRuntimeForTest({
        nextToken,
        onStage: async (stage: string, context: any) => {
            if (stage !== scenario) return;
            await send({
                type: "checkpoint",
                scenario,
                ledgerPath,
                artifactPath: context.artifactPath,
            });
            await parkForParentKill();
        },
    });
    await program.saveSegmentLedgerCas(
        1,
        ledger(["baseline", "crash-write"], 1)
    );
    throw new Error(`${scenario} crash checkpoint unexpectedly resumed`);
};

run().catch(async (error) => {
    const value = error instanceof Error ? error : new Error(String(error));
    await send({
        type: "fatal",
        message: value.message,
        stack: value.stack,
    }).catch(() => {});
    process.exitCode = 1;
});
