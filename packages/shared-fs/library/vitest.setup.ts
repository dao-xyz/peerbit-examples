import "../../../vitest.setup.ts";
import { appendFileSync } from "node:fs";
import { Peerbit } from "peerbit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import {
    createShadowRegistry,
    takeShadowFailures,
    type ShadowFailure,
    type ShadowSkip,
} from "./src/readiness/shadow.js";

// Fake clocks. A libp2p node keeps work running after its stop() resolved,
// and that work arms timers through the global setTimeout. On Peerbit
// 5.4.10 (libp2p 3.3.8) it includes the address manager's 1 s debounce
// (below), a pubsub route query's 5 s timeout, and peer-store locks that
// peer:disconnect handlers take while the node stops, which complete
// through it-queue's 1 ms emitEmpty and emitIdle. Files share a worker's
// globals (isolate:false), so such a timer lands in whatever fake clock a
// later file installed (readiness-tap's getTimerCount() read 2 on
// Windows). vi.useFakeTimers() therefore throws unless this process ran
// only the calling file, a *.isolated.test.ts that the root config's
// node-isolated project starts in a fresh process, and has created no
// peer yet. No node then exists that could arm a timer in the fake clock,
// whatever libp2p leaves running.
const FAKE_CLOCK_STATE = Symbol.for("@peerbit/shared-fs:test-fake-clock");
interface FakeClockState {
    /** Test files this process ran, in order. */
    files: string[];
    /** Peerbit.create() calls in this process. */
    peers: number;
}
const fakeClock: FakeClockState = ((globalThis as any)[FAKE_CLOCK_STATE] ??= {
    files: [],
    peers: 0,
});
const fakeClockHazard = (): string | undefined => {
    const file = expect.getState().testPath ?? "an unknown file";
    if (!/\.isolated\.test\.ts$/.test(file)) {
        return `${file} is not a *.isolated.test.ts file, so it shares its process with other files`;
    }
    const others = fakeClock.files.filter((other) => other !== file);
    if (others.length > 0) {
        return `this process also ran ${others.join(", ")}`;
    }
    if (fakeClock.peers > 0) {
        return `this process already created ${fakeClock.peers} peer(s)`;
    }
};
const GUARDS_FAKE_CLOCK = Symbol.for(
    "@peerbit/shared-fs:test-guards-fake-clock"
);
const guarded = vi as typeof vi & { [GUARDS_FAKE_CLOCK]?: true };
if (!guarded[GUARDS_FAKE_CLOCK]) {
    guarded[GUARDS_FAKE_CLOCK] = true;
    const useFakeTimers = vi.useFakeTimers;
    vi.useFakeTimers = function (this: typeof vi, ...args) {
        const hazard = fakeClockHazard();
        if (hazard) {
            throw new Error(
                `vi.useFakeTimers(): ${hazard}. A timer that a libp2p node arms after its stop would land in this fake clock.`
            );
        }
        return useFakeTimers.apply(this, args);
    };
}
const COUNTS_PEERS = Symbol.for("@peerbit/shared-fs:test-counts-peers");
const peerbitClass = Peerbit as typeof Peerbit & { [COUNTS_PEERS]?: true };
if (!peerbitClass[COUNTS_PEERS]) {
    peerbitClass[COUNTS_PEERS] = true;
    const create = Peerbit.create;
    peerbitClass.create = function (
        this: typeof Peerbit,
        ...args: Parameters<typeof Peerbit.create>
    ) {
        fakeClock.peers++;
        return create.apply(this, args);
    };
}

// Peerbit 5.4.10 (libp2p 3.3.8): a listener closing inside stop() emits
// transport:close, which arms the address manager's 1 s peer-store
// debounce. AddressManager is not Startable, so nothing stops it: it fires
// after stop() resolved, keeps the process alive 1 s longer and runs its
// peer-store patch while a later file runs. Every peer a test stops cancels
// it once the stop settled. Fake clocks do not depend on this (see above);
// a libp2p that renames the field makes it a no-op.
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
    fakeClock.files.push(file ?? "an unknown file");
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
