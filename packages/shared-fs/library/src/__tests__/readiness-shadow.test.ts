import { randomBytes } from "@peerbit/crypto";
import { describe, expect, it } from "vitest";
import { NamingEvent } from "../model.js";
import { AnchorHost } from "../readiness/anchor-host.js";
import { cellKey } from "../readiness/cells.js";
import { DIGEST_BYTES, M } from "../readiness/constants.js";
import { digestToHead } from "../readiness/digest.js";
import type { IdKey } from "../readiness/id-map.js";
import type { ScopeState } from "../readiness/runtime.js";
import {
    NAMESPACE_V1,
    SCOPE_NAMESPACE_V1,
    type ScopeId,
} from "../readiness/scopes.js";
import {
    compareScope,
    createShadowRegistry,
    runSessionShadowCheck,
    runShadowCheck,
    takeShadowFailures,
    type ShadowRegistry,
} from "../readiness/shadow.js";
import { CloseFault, ScopeTap, type IndexedHead } from "../readiness/tap.js";

/**
 * The K2 shadow verdict (M1 plan section 7.2): a difference counts when no
 * event names its rows, whatever other rows do meanwhile, and a row whose
 * event is merely late is waited for, not reported. A scope the check could
 * not compare fails like a difference unless the close caused it, and a
 * failure fails the test that was running when it was recorded.
 */

const head = () => digestToHead(randomBytes(DIGEST_BYTES));

const naming = (id: string, h: string, modified = 1n) => {
    const value = Object.create(NamingEvent.prototype);
    value.id = id;
    value.__context = { head: h, modified };
    return value;
};

const change = (added: unknown[], removed: unknown[] = []) => ({
    detail: { added, removed },
});

/** A scope on a fake index; `afterScan` runs at the end of every scan. */
const scope = async () => {
    const rows = new Map<string, IndexedHead>();
    const hooks: { afterScan?: (scan: number) => void } = {};
    let scans = 0;
    const port = {
        readHead: async (key: IdKey) => {
            await Promise.resolve();
            return rows.get(key as string);
        },
        scan: async function* () {
            await Promise.resolve();
            const scan = ++scans;
            yield [...rows].map(([key, row]) => ({ key, ...row }));
            hooks.afterScan?.(scan);
        },
        count: async () => rows.size,
    };
    const tap = new ScopeTap(NAMESPACE_V1, port);
    const key = cellKey("shadow-test");
    const host = await AnchorHost.create({ mode: "inline" });
    const laneSet = host.open(NAMESPACE_V1.ivTag, {
        slab: () => tap.map,
        cells: { m: M, k0: key[0], k1: key[1] },
    });
    tap.addSink({
        apply: (digest, sign) => laneSet.apply(digest, sign),
        reset: () => laneSet.reset(tap.epoch),
    });
    await tap.seedFromScan();
    const state = {
        descriptor: NAMESPACE_V1,
        tap,
        laneSet,
        logId: new Uint8Array(32),
        started: Promise.resolve(),
    } as ScopeState;
    /** A row in the index whose event is dispatched now. */
    const arrive = (id: string) => {
        const h = head();
        rows.set(id, { head: h, modified: 1n });
        tap.onChange(change([naming(id, h)]));
    };
    return {
        rows,
        hooks,
        tap,
        state,
        key,
        host,
        arrive,
        close: () => laneSet.close(),
    };
};

/** The close-path check of one scope into `registry`. */
const check = (
    s: Awaited<ReturnType<typeof scope>>,
    registry: ShadowRegistry,
    eventWaitMs = 50
) =>
    runShadowCheck(
        {
            address: "shadow-test",
            anchorHost: s.host,
            cellKey: s.key,
            scopeStates: () => [s.state],
        },
        registry,
        undefined,
        { eventWaitMs }
    );

describe("readiness shadow verdict", () => {
    it("reports a real difference while other rows keep arriving", async () => {
        const s = await scope();
        for (let i = 0; i < 5; i++) s.arrive(`n${i}`);
        // A row only the map holds (no index row, no event to come).
        s.tap.onChange(change([naming("ghost", head())]));
        // An unrelated arrival during every scan.
        s.hooks.afterScan = (scan) => s.arrive(`t${scan}`);
        const outcome = await compareScope(s.state, s.key, {
            eventWaitMs: 100,
        });
        expect(outcome.kind).toBe("different");
        expect((outcome as any).difference).toMatch(/maintained only: /);
        s.close();
    });

    it("reports a real difference while late batches keep arriving", async () => {
        /**
         * Every scan sees one row indexed whose event comes 20 ms after it
         * (a remote batch indexes before it dispatches); each event wakes
         * the wait.
         */
        const lateStream = (s: Awaited<ReturnType<typeof scope>>) => {
            const timers: ReturnType<typeof setTimeout>[] = [];
            let n = 0;
            const index = () => {
                const id = `late${++n}`;
                const h = head();
                s.rows.set(id, { head: h, modified: 2n });
                return { id, h };
            };
            let pending = index();
            s.hooks.afterScan = () => {
                const { id, h } = pending;
                timers.push(
                    setTimeout(
                        () => s.tap.onChange(change([naming(id, h, 2n)])),
                        20
                    )
                );
                pending = index();
            };
            return () => timers.forEach(clearTimeout);
        };
        const s = await scope();
        for (let i = 0; i < 5; i++) s.arrive(`n${i}`);
        // A row only the map holds: no event will ever name it.
        s.tap.onChange(change([naming("ghost", head())]));
        const stop = lateStream(s);
        const registry = createShadowRegistry();
        try {
            const [outcome] = await check(s, registry, 300);
            expect(outcome.kind).toBe("different");
            expect((outcome as any).difference).toMatch(
                /maintained only: .*no event named them in 300 ms/
            );
            expect(registry.counts).toMatchObject({ failed: 1, unstable: 0 });
        } finally {
            stop();
        }
        s.close();

        // The same stream alone: in flight, never a failure.
        const quiet = await scope();
        for (let i = 0; i < 5; i++) quiet.arrive(`n${i}`);
        const stopQuiet = lateStream(quiet);
        const other = createShadowRegistry();
        try {
            const [outcome] = await check(quiet, other, 300);
            expect(outcome.kind).not.toBe("different");
            expect(other.counts.failed).toBe(0);
        } finally {
            stopQuiet();
        }
        quiet.close();
    });

    it("waits for a row whose event is late instead of reporting it", async () => {
        const s = await scope();
        for (let i = 0; i < 5; i++) s.arrive(`n${i}`);
        // Indexed now, its event dispatched 60 ms later (a slow batch).
        const h = head();
        s.rows.set("late", { head: h, modified: 2n });
        const timer = setTimeout(
            () => s.tap.onChange(change([naming("late", h, 2n)])),
            60
        );
        try {
            const outcome = await compareScope(s.state, s.key);
            expect(outcome).toMatchObject({ kind: "equal" });
        } finally {
            clearTimeout(timer);
        }
        s.close();
    });

    it("reports a late add beyond the tap's removal bound (RECENT_REMOVALS)", async () => {
        const s = await scope();
        s.arrive("x");
        for (let i = 0; i < 4096; i++) s.arrive(`n${i}`);
        // A delete racing a re-put of x (tap.ts class comment): the index
        // lost the row, and the re-put's add comes after 4,096 other
        // removals, so the tap no longer verifies it.
        const remove = (id: string) => {
            const h = s.rows.get(id)!.head;
            s.rows.delete(id);
            s.tap.onChange(change([], [naming(id, h)]));
        };
        remove("x");
        for (let i = 0; i < 4096; i++) remove(`n${i}`);
        s.tap.onChange(change([naming("x", head(), 2n)]));
        await s.tap.verifyIdle();
        expect(s.tap.stats.readdVerifies).toBe(0);
        const outcome = await compareScope(s.state, s.key, {
            eventWaitMs: 50,
        });
        expect(outcome.kind).toBe("different");
        expect((outcome as any).difference).toMatch(
            /count 1, index 0 \(delta 1\); maintained only: /
        );
        s.close();
    });

    it("reports a quiet difference after the wait and an equal set at once", async () => {
        const s = await scope();
        for (let i = 0; i < 5; i++) s.arrive(`n${i}`);
        const started = Date.now();
        expect(await compareScope(s.state, s.key)).toMatchObject({
            kind: "equal",
            attempts: 1,
        });
        expect(Date.now() - started).toBeLessThan(1_000);
        // An index row the map never got: a missing row.
        s.rows.set("lost", { head: head(), modified: 1n });
        const outcome = await compareScope(s.state, s.key, {
            eventWaitMs: 50,
        });
        expect(outcome.kind).toBe("different");
        expect((outcome as any).difference).toMatch(
            /count 5, index 6 \(delta -1\); 1 rows differ \(missing [0-9a-f]{16}\)/
        );
        s.close();
    });

    it("reports cells the lane set keeps that no longer match its rows", async () => {
        const s = await scope();
        for (let i = 0; i < 5; i++) s.arrive(`n${i}`);
        // Every row matches; only the cells (here inline, in a worker
        // otherwise) drifted.
        s.state.laneSet.cellsInline![0] ^= 1;
        const outcome = await compareScope(s.state, s.key);
        expect(outcome).toMatchObject({
            kind: "different",
            difference: "cells differ",
        });
        s.close();
    });

    it("fails a scope it could not compare unless the close caused it", async () => {
        // A failed verify read faults the tap; the map then also lost a
        // row. Skipping silently would hide both.
        const faulted = await scope();
        for (let i = 0; i < 5; i++) faulted.arrive(`n${i}`);
        (faulted.tap.port as any).readHead = async () => {
            throw new Error("simulated read failure");
        };
        // A replace: its verify reads the index.
        faulted.tap.onChange(change([naming("n0", head())]));
        await faulted.tap.verifiesSettled();
        expect(faulted.tap.faulted).toBeDefined();
        faulted.tap.map.delete("n1");
        let registry = createShadowRegistry();
        await check(faulted, registry);
        expect(registry.counts).toMatchObject({ skipped: 0, failed: 1 });
        expect(registry.failures[0].message).toMatch(
            /namespace-v1 of shadow-test was not compared: tap faulted: simulated read failure/
        );
        faulted.close();

        // An error inside the check itself.
        const broken = await scope();
        broken.arrive("n0");
        (broken.state.laneSet as any).digestOf = () => {
            throw new TypeError("oracle bug");
        };
        registry = createShadowRegistry();
        await check(broken, registry);
        expect(registry.failures.map((failure) => failure.message)).toEqual([
            expect.stringMatching(/was not compared: error: oracle bug/),
        ]);
        broken.close();

        // Caused by the close: a verify it would not wait for, and a start
        // it overtook. Counted and kept with its reason, not failed.
        const moving = await scope();
        moving.arrive("n0");
        moving.tap.faulted = new CloseFault(
            "replace verify still moving when the close began"
        );
        const starting = await scope();
        (starting.state as any).tap = new ScopeTap(
            NAMESPACE_V1,
            starting.tap.port
        );
        registry = createShadowRegistry();
        await check(moving, registry);
        await check(starting, registry);
        expect(registry.failures).toEqual([]);
        expect(registry.counts.skipped).toBe(2);
        expect(registry.skips.map((skip) => skip.reason)).toEqual([
            "tap faulted: replace verify still moving when the close began",
            "tap buffering",
        ]);
        moving.close();
        starting.close();
    });

    it("checks the scopes a session contained, stamped with the joining test", async () => {
        const s = await scope();
        for (let i = 0; i < 3; i++) s.arrive(`n${i}`);
        const program = {};
        const runtime = {
            address: "session-test",
            anchorHost: s.host,
            cellKey: s.key,
            program,
            blocked: false,
            disposed: false,
            scope: (id: ScopeId) =>
                id === SCOPE_NAMESPACE_V1 ? s.state : undefined,
        };
        const scopes = new Set<ScopeId>([SCOPE_NAMESPACE_V1]);
        const joining = { file: "a.test.ts", test: "join", id: "t1" };
        const registry = createShadowRegistry();
        // Opened in another test than the one whose join contained it.
        registry.live.set(runtime, { file: "a.test.ts", test: "open" });
        await runSessionShadowCheck(runtime, registry, scopes, joining, {
            eventWaitMs: 50,
        });
        expect(registry.counts).toMatchObject({
            checks: 1,
            sessionChecks: 1,
            compared: 1,
            failed: 0,
        });

        // A difference fails the joining test, with the session's prefix.
        s.tap.map.delete("n0");
        registry.current = { file: "a.test.ts", test: "later", id: "t2" };
        await runSessionShadowCheck(runtime, registry, scopes, joining, {
            eventWaitMs: 50,
        });
        expect(registry.counts).toMatchObject({
            checks: 2,
            sessionChecks: 2,
            failed: 1,
        });
        expect(registry.failures).toEqual([
            expect.objectContaining({
                owner: { file: "a.test.ts", test: "open" },
                recordedIn: joining,
                scope: "namespace-v1",
                message: expect.stringMatching(
                    /^readiness shadow \(session\): namespace-v1 of session-test differs from its index/
                ),
            }),
        ]);
        expect(takeShadowFailures(registry, "a.test.ts", "t2").mine).toEqual(
            []
        );
        expect(
            takeShadowFailures(registry, "a.test.ts", "t1").mine
        ).toHaveLength(1);

        // Left to the close-path check: a blocked (closing) runtime, an
        // opted-out filesystem, a scope it no longer holds.
        const left = createShadowRegistry();
        await runSessionShadowCheck(
            { ...runtime, blocked: true },
            left,
            scopes,
            joining
        );
        left.optedOut.add(program);
        await runSessionShadowCheck(runtime, left, scopes, joining);
        await runSessionShadowCheck(
            { ...runtime, program: undefined, scope: () => undefined },
            createShadowRegistry(),
            scopes,
            joining
        );
        expect(left.counts).toMatchObject({ checks: 0, failed: 0 });
        expect(left.failures).toEqual([]);
        s.close();
    });

    it("leaves a difference recorded in a suite hook to the file, not the next test", async () => {
        const s = await scope();
        for (let i = 0; i < 3; i++) s.arrive(`n${i}`);
        s.tap.map.delete("n0");
        const registry = createShadowRegistry();
        // A describe's afterAll closes a filesystem its beforeAll opened:
        // no test is running.
        registry.current = { file: "a.test.ts" };
        await check(s, registry);
        // Recorded during a test.
        registry.current = { file: "a.test.ts", test: "A1", id: "t1" };
        await check(s, registry);
        registry.failures.push({
            ...registry.failures[0],
            owner: { file: "other.test.ts" },
        });
        expect(registry.failures).toHaveLength(3);

        // The next test (t2) takes nothing of this file.
        let taken = takeShadowFailures(registry, "a.test.ts", "t2");
        expect(taken.mine).toEqual([]);
        expect(taken.foreign).toHaveLength(1);
        taken = takeShadowFailures(registry, "a.test.ts", "t1");
        expect(taken.mine.map((failure) => failure.recordedIn.id)).toEqual([
            "t1",
        ]);
        // The file's end takes the hook's one.
        taken = takeShadowFailures(registry, "a.test.ts");
        expect(taken.mine).toHaveLength(1);
        expect(taken.mine[0].recordedIn).toEqual({ file: "a.test.ts" });
        expect(registry.failures).toEqual([]);
        s.close();
    });
});
