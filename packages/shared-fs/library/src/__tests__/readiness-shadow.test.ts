import { randomBytes } from "@peerbit/crypto";
import { describe, expect, it } from "vitest";
import { NamingEvent } from "../model.js";
import { AnchorHost } from "../readiness/anchor-host.js";
import { Cells, cellKey } from "../readiness/cells.js";
import { DIGEST_BYTES, M } from "../readiness/constants.js";
import { digestToHead } from "../readiness/digest.js";
import type { IdKey } from "../readiness/id-map.js";
import type { ScopeState } from "../readiness/runtime.js";
import { NAMESPACE_V1 } from "../readiness/scopes.js";
import { compareScope } from "../readiness/shadow.js";
import { ScopeTap, type IndexedHead } from "../readiness/tap.js";

/**
 * The K2 shadow verdict (M1 plan section 7.2): a difference counts when no
 * event names its rows, whatever other rows do meanwhile, and a row whose
 * event is merely late is waited for, not reported.
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
    const cells = new Cells(M, key[0], key[1]);
    const host = await AnchorHost.create({ mode: "inline" });
    const laneSet = host.open(NAMESPACE_V1.ivTag, { slab: () => tap.map });
    tap.addSink(cells);
    tap.addSink({
        apply: (digest, sign) => laneSet.apply(digest, sign),
        reset: () => laneSet.reset(tap.epoch),
    });
    await tap.seedFromScan();
    const state = {
        descriptor: NAMESPACE_V1,
        tap,
        cells,
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
        arrive,
        close: () => laneSet.close(),
    };
};

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
});
