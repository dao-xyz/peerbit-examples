import "../../../vitest.setup.ts";
import { appendFileSync } from "node:fs";
import { Peerbit } from "peerbit";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import {
    createShadowRegistry,
    takeShadowFailures,
    type ShadowFailure,
    type ShadowSkip,
} from "./src/readiness/shadow.js";

// Peerbit 5.4.10 (libp2p 3.3.8): a listener closing inside stop() emits
// transport:close, which arms the address manager's 1 s peer-store
// debounce. AddressManager is not Startable, so nothing stops it: it fires
// after stop() resolved, and its peer-store patch arms it-queue's emitEmpty
// and emitIdle through the global setTimeout. Files share a worker's
// globals (isolate:false), so those land in whatever fake clock a later
// file installed (readiness-tap's getTimerCount() of 2 on Windows). Every
// peer a test stops cancels it once the stop settled; a libp2p that renames
// the field makes this a no-op, and peer-stop-timers.test.ts then fails.
const CANCELS_ADDRESS_DEBOUNCE = Symbol.for(
    "@peerbit/shared-fs:test-stop-cancels-address-debounce"
);
type AddressManager = { _updatePeerStoreAddresses?: { stop?(): void } };
const peerbitPrototype = Peerbit.prototype as Peerbit & {
    [CANCELS_ADDRESS_DEBOUNCE]?: true;
};
if (!peerbitPrototype[CANCELS_ADDRESS_DEBOUNCE]) {
    peerbitPrototype[CANCELS_ADDRESS_DEBOUNCE] = true;
    const stop = peerbitPrototype.stop;
    peerbitPrototype.stop = async function (this: Peerbit) {
        try {
            await stop.call(this);
        } finally {
            const libp2p = this.libp2p as unknown as
                | { components?: { addressManager?: AddressManager } }
                | undefined;
            libp2p?.components?.addressManager?._updatePeerStoreAddresses?.stop?.();
        }
    };
}

// K2 shadow check (M1 plan section 7.2): every filesystem close compares the
// maintained readiness state with a fresh build from the index and records a
// difference here. The test running when it was recorded fails; one recorded
// in a suite hook (a describe's afterAll) fails the file's afterAll, not the
// next test. A failure recorded by a runtime another file opened (a leaked
// filesystem) is only reported, so it cannot fail an unrelated file.
const registry = (globalThis.__SFS_READINESS_SHADOW__ ??=
    createShadowRegistry());

let file: string | undefined;
let countsAtStart = { ...registry.counts };

const describeFailures = (failures: ShadowFailure[]) =>
    failures
        .map((failure) => {
            const where = [
                failure.owner.test && `opened in "${failure.owner.test}"`,
                failure.recordedIn.id === undefined &&
                    "recorded in a suite hook",
            ].filter(Boolean);
            return `${failure.message}${where.length > 0 ? ` [${where.join(", ")}]` : ""}`;
        })
        .join("\n");

/** This file's failures of test `test` (all when undefined). */
const takeFailures = (test?: string): ShadowFailure[] => {
    const { mine, foreign } = takeShadowFailures(registry, file, test);
    for (const failure of foreign) {
        console.warn(
            `[readiness shadow] difference recorded by a filesystem opened in ${failure.owner.file}:\n${describeFailures([failure])}`
        );
    }
    return mine;
};

/** Removes and returns the skips of runtimes this file opened. */
const takeSkips = (): ShadowSkip[] => {
    const mine = registry.skips.filter(
        (skip) => skip.owner.file === undefined || skip.owner.file === file
    );
    registry.skips = registry.skips.filter((skip) => !mine.includes(skip));
    return mine;
};

beforeAll((suite: any) => {
    file = suite?.file?.filepath ?? suite?.filepath;
    registry.current = { file };
    countsAtStart = { ...registry.counts };
});

beforeEach((context) => {
    registry.current = { file, test: context.task.name, id: context.task.id };
});

afterEach((context) => {
    const failures = takeFailures(context.task.id);
    registry.current = { file };
    if (failures.length > 0) {
        throw new Error(describeFailures(failures));
    }
});

afterAll(() => {
    const failures = takeFailures();
    const skips = takeSkips();
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
            JSON.stringify({
                file,
                ...counts,
                failures: failures.length,
                skips: skips.map(({ scope, reason }) => ({ scope, reason })),
            }) + "\n"
        );
    }
    registry.current = {};
    if (failures.length > 0) {
        throw new Error(describeFailures(failures));
    }
});
