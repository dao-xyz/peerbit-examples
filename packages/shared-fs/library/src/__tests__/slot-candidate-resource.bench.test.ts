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
            if (result.status !== 0) console.log(result.stdout);
            console.error(result.stderr);
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            const report = JSON.parse(result.stdout.trim());
            console.log(
                JSON.stringify({
                    implementation: report.implementation,
                    width: report.width,
                    case: report.case,
                    timings: report.timings,
                    queries: report.queries,
                })
            );
            expect(report.width).toBe(Number(width));
            expect(report.case).toBe(kind);
            expect(report.schema).toBe("shared-fs-slot-resource-v2");
            expect(report.queryPlans.length).toBeGreaterThan(0);
            expect(report.cacheStates.final).toMatchObject({
                parents: 0,
                slots: 0,
                rows: 0,
                reverse: 0,
                inFlight: 0,
            });
            if (report.implementation === "bounded-slot") {
                expect(report.queries.firstColdHit.returnedRows).toBe(
                    kind === "same-name" ? Number(width) : 1
                );
                expect(report.queries.firstColdMiss.returnedRows).toBe(0);
                expect(report.queries.createIndexStream.queries).toBe(100);
                expect(report.smallBoundControl.entries).toBeLessThanOrEqual(
                    32
                );
                expect(
                    report.queryPlans.some((query: any) =>
                        query.plan.some(
                            (row: any) =>
                                row.detail.includes("kind=?") &&
                                row.detail.includes("parentId=?") &&
                                row.detail.includes("name=?")
                        )
                    )
                ).toBe(true);
            }
        },
        185_000
    );
});
