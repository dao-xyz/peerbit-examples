import "../../../vitest.setup.ts";
import { appendFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import {
    createShadowRegistry,
    type ShadowFailure,
} from "./src/readiness/shadow.js";

// K2 shadow check (M1 plan section 7.2): every filesystem close compares the
// maintained readiness state with a fresh build from the index and records a
// difference here. The test whose filesystem recorded it fails; a failure
// recorded by a runtime another file opened (a leaked filesystem) is only
// reported, so it cannot fail an unrelated file.
const registry = (globalThis.__SFS_READINESS_SHADOW__ ??=
    createShadowRegistry());

let file: string | undefined;
let countsAtStart = { ...registry.counts };

const describeFailures = (failures: ShadowFailure[]) =>
    failures
        .map(
            (failure) =>
                `${failure.message}${failure.owner.test ? ` [opened in "${failure.owner.test}"]` : ""}`
        )
        .join("\n");

/** Removes and returns this file's failures; reports other files' ones. */
const takeFailures = (): ShadowFailure[] => {
    const mine: ShadowFailure[] = [];
    for (const failure of registry.failures.splice(0)) {
        if (failure.owner.file === undefined || failure.owner.file === file) {
            mine.push(failure);
        } else {
            console.warn(
                `[readiness shadow] difference recorded by a filesystem opened in ${failure.owner.file}:\n${describeFailures([failure])}`
            );
        }
    }
    return mine;
};

beforeAll((suite: any) => {
    file = suite?.file?.filepath ?? suite?.filepath;
    registry.current = { file };
    countsAtStart = { ...registry.counts };
});

beforeEach((context) => {
    registry.current = { file, test: context.task.name };
});

afterEach(() => {
    const failures = takeFailures();
    registry.current = { file };
    if (failures.length > 0) {
        throw new Error(describeFailures(failures));
    }
});

afterAll(() => {
    const failures = takeFailures();
    const report = process.env.PEERBIT_SHARED_FS_SHADOW_REPORT;
    if (report) {
        const counts = Object.fromEntries(
            Object.entries(registry.counts).map(([key, value]) => [
                key,
                value - (countsAtStart as any)[key],
            ])
        );
        appendFileSync(
            report,
            JSON.stringify({ file, ...counts, failures: failures.length }) +
                "\n"
        );
    }
    registry.current = {};
    if (failures.length > 0) {
        throw new Error(describeFailures(failures));
    }
});
