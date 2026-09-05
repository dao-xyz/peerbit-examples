import assert from "node:assert/strict";
import { test } from "node:test";
import {
    campaignPlan,
    assertMatchedCohort,
} from "./shared-fs-batch-matched-campaign.mjs";

test("fixed 16 cells balance source, authorization, method order and pair adjacency", () => {
    const plan = campaignPlan();
    assert.equal(plan.length, 16);
    assert.deepEqual(
        plan.map((cell) => cell.id),
        Array.from({ length: 16 }, (_, i) => i + 1)
    );
    for (const auth of ["anonymous", "root-key"]) {
        for (const source of ["baseline", "candidate"]) {
            for (const order of ["sequential-first", "batch-first"]) {
                assert.equal(
                    plan.filter(
                        (cell) =>
                            cell.auth === auth &&
                            cell.source === source &&
                            cell.order === order
                    ).length,
                    2
                );
            }
        }
    }
    for (let i = 0; i < plan.length; i += 2) {
        assert.equal(plan[i].pair, plan[i + 1].pair);
        assert.equal(plan[i].auth, plan[i + 1].auth);
        assert.equal(plan[i].order, plan[i + 1].order);
        assert.notEqual(plan[i].source, plan[i + 1].source);
    }
});

test("cohort mismatch fails before measurement even if paths stay unchanged", () => {
    const baseline = {
        lockSha256: "same-lock",
        manifestSha256: "same-manifest",
        dependencies: [
            {
                name: "peerbit",
                version: "5.3.35",
                entry: "/same/entry",
                entrySha256: "same-code",
            },
        ],
    };
    assert.doesNotThrow(() =>
        assertMatchedCohort({ baseline, candidate: structuredClone(baseline) })
    );
    for (const change of [
        (value) => {
            value.lockSha256 = "different";
        },
        (value) => {
            value.manifestSha256 = "different";
        },
        (value) => {
            value.dependencies[0].version = "different";
        },
        (value) => {
            value.dependencies[0].entry = "/different/entry";
        },
        (value) => {
            value.dependencies[0].entrySha256 = "different";
        },
    ]) {
        const candidate = structuredClone(baseline);
        change(candidate);
        assert.throws(() => assertMatchedCohort({ baseline, candidate }));
    }
});
