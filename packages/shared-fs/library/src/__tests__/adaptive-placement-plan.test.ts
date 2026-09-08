import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
    fixtureFile,
    placementPlan,
} from "./adaptive-placement.bench.model.js";

describe("bounded placement topology", () => {
    it("preserves the N=2 topology and budgets by default", () => {
        assert.deepEqual(placementPlan(undefined, 215_040), {
            minCopies: 2,
            initialCustodians: 3,
            joiningPeer: 4,
            survivors: [2, 3, 4],
            budgets: [null, 75_264, 129_024, 182_784, 258_048],
        });
        assert.deepEqual(
            placementPlan("2", 215_040),
            placementPlan(undefined, 215_040)
        );
    });
    it("gives N=3 four survivors after five custodians and one loss", () => {
        const plan = placementPlan("3", 215_040);
        assert.deepEqual(plan, {
            minCopies: 3,
            initialCustodians: 4,
            joiningPeer: 5,
            survivors: [2, 3, 4, 5],
            budgets: [null, 75_264, 129_024, 182_784, 258_048, 322_560],
        });
        assert.equal(plan.survivors.length, plan.minCopies + 1);
    });
    it("rejects unsupported or ambiguous replication targets", () => {
        for (const value of ["", "0", "1", "4", "NaN", "2.0", " 3", "03"])
            assert.throws(() => placementPlan(value, 215_040));
    });
    it("rejects invalid or overflowing byte projections", () => {
        for (const value of [
            0,
            -1,
            1.5,
            NaN,
            Infinity,
            Number.MAX_SAFE_INTEGER,
        ])
            assert.throws(() => placementPlan("3", value));
    });
    it("retains the same 24-file workload and independent chunks", () => {
        const files = Array.from({ length: 24 }, (_, file) =>
            fixtureFile(file, 4_096)
        );
        assert.equal(
            files.reduce((sum, file) => sum + file.manifest.bytes, 0),
            172_032
        );
        assert.equal(
            new Set(files.flatMap((file) => file.manifest.chunkIds)).size,
            42
        );
    });
});
