import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const enabled = process.env.PEERBIT_SHARED_FS_SLOT_RESOURCE_BENCH === "1";
const manualDescribe = enabled ? describe : describe.skip;
const width = process.env.PEERBIT_SHARED_FS_SLOT_RESOURCE_WIDTH ?? "100000";
const workerPath = fileURLToPath(
    new URL("./slot-candidate-resource.bench.worker.ts", import.meta.url)
);

manualDescribe("shared fs disk-backed slot cache resource benchmark", () => {
    it.each(["unique", "same-name"])(
        "measures %s in a fresh process with a three-minute deadline",
        (kind) => {
            const result = spawnSync(
                process.execPath,
                ["--expose-gc", "--import", "tsx", workerPath, width, kind],
                { encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024 }
            );
            console.log(result.stdout);
            console.error(result.stderr);
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            const report = JSON.parse(result.stdout.trim());
            expect(report.width).toBe(Number(width));
            expect(report.case).toBe(kind);
            expect(report.cardinalities.final).toEqual({
                parents: 0,
                names: 0,
                rows: 0,
                reverse: 0,
            });
        },
        185_000
    );
});
