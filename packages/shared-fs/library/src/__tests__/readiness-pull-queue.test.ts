import { describe, expect, it } from "vitest";
import { PULL_BATCH, PULL_TIMEOUT_MS } from "../readiness/constants.js";
import { RejectionRecord } from "../readiness/explain.js";
import {
    PullQueue,
    type PullPorts,
    type PullReport,
} from "../readiness/pull-queue.js";

/**
 * The joiner's pull queue (M1 plan section 7.3, design 4.5 steps 7-8): one
 * batch of at most 256 per owner, a hash in flight once across owners, a
 * join error in the report instead of a rejection, failed heads retried on
 * events only, and rejections tracked while a batch runs. The join is a
 * fake whose calls the test settles by hand.
 */

interface JoinCall {
    heads: string[];
    timeout: number;
    resolve(): void;
    reject(error: unknown): void;
}

const fakeLog = () => {
    const calls: JoinCall[] = [];
    const listeners = new Set<() => void>();
    const ports: PullPorts = {
        join: (heads, { timeout }) =>
            new Promise<void>((resolve, reject) =>
                calls.push({ heads: [...heads], timeout, resolve, reject })
            ),
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    return {
        calls,
        listeners,
        ports,
        /** One local index change of the scope. */
        change: () => {
            for (const listener of [...listeners]) listener();
        },
    };
};

const heads = (n: number, prefix = "h") =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}`);

/** Every pending microtask and promise continuation has run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A report promise and whether it resolved yet. */
const watch = (promise: Promise<PullReport>) => {
    const state: { report?: PullReport; rejected?: unknown } = {};
    promise.then(
        (report) => (state.report = report),
        (error) => (state.rejected = error ?? "rejected")
    );
    return state;
};

describe("readiness pull queue", () => {
    it("refuses more than a batch of heads and a second batch of one owner", async () => {
        const log = fakeLog();
        const queue = new PullQueue(log.ports, new RejectionRecord());
        expect(queue.batch).toBe(PULL_BATCH);
        expect(PULL_BATCH).toBe(256);

        expect(() => queue.pull("a", heads(PULL_BATCH + 1))).toThrow(
            /exceeds the batch of 256/
        );
        expect(queue.busy("a")).toBe(false);
        expect(log.calls).toHaveLength(0);

        const first = queue.pull("a", heads(PULL_BATCH));
        expect(queue.busy("a")).toBe(true);
        expect(() => queue.pull("a", ["other"])).toThrow(/in flight/);
        // Another owner is not affected.
        const second = queue.pull("b", ["other"]);
        expect(log.calls.map((call) => call.heads.length)).toEqual([256, 1]);

        log.calls[0].resolve();
        log.calls[1].resolve();
        await first;
        await second;
        // In flight until the owner classified its report.
        expect(queue.busy("a")).toBe(true);
        expect(() => queue.pull("a", ["next"])).toThrow(/in flight/);
        queue.settled("a", false);
        expect(queue.busy("a")).toBe(false);
        void queue.pull("a", ["next"]);
        expect(log.calls).toHaveLength(3);
        expect(queue.stats).toMatchObject({ batches: 3, joined: 258 });

        const small = new PullQueue(log.ports, new RejectionRecord(), {
            batch: 4,
        });
        expect(() => small.pull("a", heads(5))).toThrow(
            /exceeds the batch of 4/
        );
        void small.pull("a", heads(4));
    });

    it("joins every batch with the 10 s timeout and reports a join error without rejecting", async () => {
        const log = fakeLog();
        const queue = new PullQueue(log.ports, new RejectionRecord());
        expect(queue.timeoutMs).toBe(PULL_TIMEOUT_MS);
        expect(PULL_TIMEOUT_MS).toBe(10_000);

        const failing = watch(queue.pull("a", ["h1", "h2"]));
        expect(log.calls[0]).toMatchObject({
            heads: ["h1", "h2"],
            timeout: 10_000,
        });
        const timeout = new Error("join timed out");
        log.calls[0].reject(timeout);
        await flush();
        expect(failing.rejected).toBeUndefined();
        expect(failing.report).toEqual({
            heads: ["h1", "h2"],
            rejections: new Map(),
            joined: 2,
            error: timeout,
        });
        expect(queue.stats.joinErrors).toBe(1);
        expect(queue.inFlightHeads).toBe(0);

        // A clean join reports no error at all.
        queue.settled("a", false);
        const clean = watch(queue.pull("a", ["h3"]));
        log.calls[1].resolve();
        await flush();
        expect(clean.report).toBeDefined();
        expect("error" in clean.report!).toBe(false);

        // A join that throws, or rejects with nothing, is a join error too.
        const throwing = new PullQueue(
            {
                join: () => {
                    throw new Error("sync failure");
                },
            },
            new RejectionRecord(),
            { timeoutMs: 1234 }
        );
        const thrown = await throwing.pull("a", ["h1"]);
        expect((thrown.error as Error).message).toBe("sync failure");
        expect(throwing.inFlightHeads).toBe(0);

        let seenTimeout = 0;
        const empty = new PullQueue(
            {
                join: (_heads, { timeout }) => {
                    seenTimeout = timeout;
                    return Promise.reject(undefined);
                },
            },
            new RejectionRecord(),
            { timeoutMs: 1234 }
        );
        const rejected = await empty.pull("a", ["h1"]);
        expect(seenTimeout).toBe(1234);
        expect(rejected.error).toBeInstanceOf(Error);
    });

    it("reports the owner's own join error before one of a batch its heads rode on", async () => {
        const log = fakeLog();
        const queue = new PullQueue(log.ports, new RejectionRecord());
        void queue.pull("a", ["h1"]);
        // B rides on A's batch for h1 and joins h2 itself.
        const report = watch(queue.pull("b", ["h1", "h2"]));
        const [first, own] = log.calls;
        const riding = new Error("a's join failed");
        const mine = new Error("b's join failed");
        own.reject(mine);
        first.reject(riding);
        await flush();
        expect(report.report?.error).toBe(mine);
        expect(report.report?.joined).toBe(1);
    });

    it("keeps a throwing retry listener inside the queue", async () => {
        // The index subscription runs in the tap's sink, which does not
        // catch: a listener's error must not escape.
        const log = fakeLog();
        const queue = new PullQueue(log.ports, new RejectionRecord());
        void queue.pull("a", ["h1"]);
        log.calls[0].resolve();
        await flush();
        let calls = 0;
        queue.onRetry("a", () => {
            calls++;
            throw new Error("listener bug");
        });
        queue.fail("a", ["h1"]);
        expect(() => queue.settled("a", false)).not.toThrow();
        expect(() => log.change()).not.toThrow();
        expect(calls).toBe(1);
        // Another owner's progress retries it, and that does not throw
        // either.
        void queue.pull("b", ["h2"]);
        log.calls[1].resolve();
        await flush();
        queue.fail("a", ["h1"]);
        expect(() => queue.settled("b", true)).not.toThrow();
        expect(calls).toBe(2);
    });

    it("joins a head in flight once and makes the second owner wait for that batch", async () => {
        const log = fakeLog();
        const queue = new PullQueue(log.ports, new RejectionRecord());
        const a = watch(queue.pull("a", ["h1", "h2"]));
        const b = watch(queue.pull("b", ["h2", "h3"]));
        expect(log.calls.map((call) => call.heads)).toEqual([
            ["h1", "h2"],
            ["h3"],
        ]);
        expect(queue.stats.deduped).toBe(1);
        expect(queue.inFlightHeads).toBe(3);

        // B's own batch settles first: its report still waits for A's.
        log.calls[1].resolve();
        await flush();
        expect(b.report).toBeUndefined();
        expect(queue.inFlightHeads).toBe(2);

        log.calls[0].resolve();
        await flush();
        expect(a.report).toMatchObject({ heads: ["h1", "h2"], joined: 2 });
        expect(b.report).toMatchObject({ heads: ["h2", "h3"], joined: 1 });
        expect(queue.inFlightHeads).toBe(0);

        // Once A's batch settled, the same head is joined again.
        const c = watch(queue.pull("c", ["h2"]));
        expect(log.calls[2].heads).toEqual(["h2"]);
        // A pull whose every head rides on another batch joins nothing.
        const d = watch(queue.pull("d", ["h2"]));
        expect(log.calls).toHaveLength(3);
        log.calls[2].resolve();
        await flush();
        expect(c.report?.joined).toBe(1);
        expect(d.report?.joined).toBe(0);

        // A head named twice in one pull is joined once.
        const e = watch(queue.pull("e", ["h4", "h4"]));
        expect(log.calls[3].heads).toEqual(["h4"]);
        log.calls[3].resolve();
        await flush();
        expect(e.report).toMatchObject({ heads: ["h4", "h4"], joined: 1 });

        // A rider whose carrier failed reports that batch's error.
        const f = watch(queue.pull("f", ["h5"]));
        const g = watch(queue.pull("g", ["h5"]));
        const failure = new Error("carrier failed");
        log.calls[4].reject(failure);
        await flush();
        expect(f.report?.error).toBe(failure);
        expect(g.report?.error).toBe(failure);
        expect(g.report?.joined).toBe(0);
    });

    it("handles pulls made inside a join: other owners ride, its own owner is due", async () => {
        // The join indexes a row at once (an index change inside the call),
        // and the retry listeners run right there.
        const finishes: Array<() => void> = [];
        let changes!: () => void;
        const joins: string[][] = [];
        const queue = new PullQueue(
            {
                join: (batch) => {
                    joins.push([...batch]);
                    changes();
                    return new Promise<void>((resolve) =>
                        finishes.push(resolve)
                    );
                },
                subscribe: (listener) => {
                    changes = listener;
                    return () => {};
                },
            },
            new RejectionRecord()
        );
        const inner: Record<string, ReturnType<typeof watch>[]> = {
            a: [],
            b: [],
        };
        for (const [owner, head] of [
            ["b", "h1"],
            ["a", "ha"],
        ]) {
            const pulled = queue.pull(owner, [head]);
            finishes[finishes.length - 1]();
            await pulled;
            queue.fail(owner, [head]);
            queue.settled(owner, false);
        }
        for (const owner of ["a", "b"]) {
            queue.onRetry(owner, (retried) => {
                inner[owner].push(watch(queue.pull(owner, retried)));
            });
        }
        expect(joins).toEqual([["h1"], ["ha"]]);

        const outer = watch(queue.pull("a", ["h1"]));
        // B pulled h1 inside A's join and rode on it; A itself is due.
        expect(joins).toEqual([["h1"], ["ha"], ["h1"]]);
        expect(inner.b).toHaveLength(1);
        expect(inner.a).toHaveLength(0);
        expect(queue.stats.deduped).toBe(1);
        await flush();
        expect(inner.b[0].report).toBeUndefined();

        finishes[2]();
        await flush();
        expect(outer.report).toMatchObject({ joined: 1 });
        expect(inner.b[0].report).toMatchObject({ heads: ["h1"], joined: 0 });
        queue.settled("a", true);
        expect(inner.a).toHaveLength(1);
        expect(joins[3]).toEqual(["ha"]);
    });

    it("reports the rejections recorded while its batches ran, then releases them", async () => {
        const log = fakeLog();
        const record = new RejectionRecord();
        const queue = new PullQueue(log.ports, record);
        const a = watch(queue.pull("a", ["h1", "h2"]));
        const b = watch(queue.pull("b", ["h2", "h3"]));
        expect(record.size).toBe(3);
        for (const head of ["h1", "h2", "h3"]) {
            expect(record.tracked(head)).toBe(true);
        }

        // The canPerform hook during the joins.
        expect(
            record.note("h1", { permanent: true, reason: "structure" })
        ).toBe(true);
        expect(
            record.note("h2", { permanent: false, reason: "untrusted" })
        ).toBe(true);
        expect(
            record.note("h3", { permanent: false, reason: "transient" })
        ).toBe(true);
        expect(
            record.note("pushed", { permanent: true, reason: "structure" })
        ).toBe(false);

        log.calls[0].resolve();
        log.calls[1].resolve();
        await flush();
        expect(a.report?.rejections).toEqual(
            new Map([
                ["h1", { permanent: true, reason: "structure" }],
                ["h2", { permanent: false, reason: "untrusted" }],
            ])
        );
        expect(b.report?.rejections).toEqual(
            new Map([
                ["h2", { permanent: false, reason: "untrusted" }],
                ["h3", { permanent: false, reason: "transient" }],
            ])
        );
        expect(record.size).toBe(0);
        expect(record.tracked("h1")).toBe(false);

        // A later join of the same head starts with no record.
        queue.settled("a", false);
        const again = watch(queue.pull("a", ["h1"]));
        log.calls[2].resolve();
        await flush();
        expect(again.report?.rejections.size).toBe(0);
    });

    it("a released owner's batch still in flight never refuses another owner's pull", async () => {
        // An owner ends mid-pull (its join runs on, up to its timeout) and
        // four live owners pull distinct heads: five full batches tracked.
        const log = fakeLog();
        const record = new RejectionRecord();
        const queue = new PullQueue(log.ports, record);
        const reports = ["a", "b", "c", "d", "e"].map((owner) => {
            const report = watch(queue.pull(owner, heads(PULL_BATCH, owner)));
            if (owner === "a") queue.release("a");
            return report;
        });
        expect(log.calls).toHaveLength(5);
        expect(record.size).toBe(5 * PULL_BATCH);
        expect(["b", "c", "d", "e"].map((owner) => queue.busy(owner))).toEqual([
            true,
            true,
            true,
            true,
        ]);
        for (const call of log.calls) call.resolve();
        await flush();
        expect(reports.every(({ report }) => report?.error === undefined)).toBe(
            true
        );
        expect(record.size).toBe(0);
    });

    it("keeps failed heads per owner and hands them back on retry(owner)", async () => {
        const log = fakeLog();
        const queue = new PullQueue(log.ports, new RejectionRecord());
        const report = queue.pull("a", ["h1", "h2"]);
        log.calls[0].resolve();
        await report;
        queue.fail("a", ["h1"]);
        queue.settled("a", false);
        expect([...queue.failed("a")]).toEqual(["h1"]);

        const handed: string[][] = [];
        const off = queue.onRetry("a", (retried) => handed.push(retried));
        queue.retry("unknown");
        expect(handed).toEqual([]);
        queue.retry("a");
        expect(handed).toEqual([["h1"]]);
        expect(queue.failed("a").size).toBe(0);
        expect(queue.stats.retries).toBe(1);
        // Nothing failed: nothing to hand back.
        queue.retry("a");
        expect(handed).toHaveLength(1);

        // An owner that never pulled has no failed set.
        queue.fail("never", ["x"]);
        expect(queue.failed("never").size).toBe(0);

        // Without a listener the failed heads stay.
        off();
        queue.fail("a", ["h2"]);
        queue.retry("a");
        expect(handed).toHaveLength(1);
        expect([...queue.failed("a")]).toEqual(["h2"]);

        // Pulling a failed head again takes it out of the failed set.
        void queue.pull("a", ["h2"]);
        expect(queue.failed("a").size).toBe(0);
    });

    it("retries idle owners on an index change and owners in flight once they settle", async () => {
        const log = fakeLog();
        const queue = new PullQueue(log.ports, new RejectionRecord());
        expect(log.listeners.size).toBe(1);
        const handed: Array<[string, string[]]> = [];
        for (const owner of ["a", "b"]) {
            const pulled = queue.pull(owner, [`${owner}-old`]);
            log.calls[log.calls.length - 1].resolve();
            await pulled;
            queue.fail(owner, [`${owner}-failed`]);
            queue.settled(owner, false);
            queue.onRetry(owner, (retried) => handed.push([owner, retried]));
        }
        // B has a batch in flight.
        const b = queue.pull("b", ["b-new"]);

        log.change();
        expect(handed).toEqual([["a", ["a-failed"]]]);
        expect([...queue.failed("b")]).toEqual(["b-failed"]);

        log.calls[log.calls.length - 1].resolve();
        await b;
        // Still classifying: due, not retried yet.
        expect(handed).toHaveLength(1);
        queue.settled("b", false);
        expect(handed).toEqual([
            ["a", ["a-failed"]],
            ["b", ["b-failed"]],
        ]);

        // noteIndexChange is the same trigger without the subscription.
        queue.fail("a", ["a-again"]);
        queue.noteIndexChange();
        expect(handed[2]).toEqual(["a", ["a-again"]]);
    });

    it("retries other owners after a batch that made progress and never loops on a hash nobody serves", async () => {
        let joins = 0;
        const served = new Set(["hc"]);
        const ports: PullPorts = {
            join: async (batch) => {
                joins++;
                await Promise.resolve();
                if (!batch.every((head) => served.has(head))) {
                    throw new Error("timeout");
                }
            },
        };
        const queue = new PullQueue(ports, new RejectionRecord());
        // A session: on a retry, pull again at once; every head it did not
        // get fails again, and a batch without progress reports none.
        const session = (owner: string) => {
            const run = async (batch: string[]) => {
                const report = await queue.pull(owner, batch);
                const failed = report.heads.filter((head) => !served.has(head));
                queue.fail(owner, failed);
                queue.settled(owner, failed.length < report.heads.length);
            };
            queue.onRetry(owner, (retried) => void run(retried));
            return run;
        };
        const runA = session("a");
        const runB = session("b");
        const runC = session("c");
        await runA(["nobody"]);
        await runB(["nobody"]);
        await flush();
        expect(joins).toBe(2);
        expect([...queue.failed("a")]).toEqual(["nobody"]);
        expect([...queue.failed("b")]).toEqual(["nobody"]);

        // C's batch made progress: A and B are retried, once.
        await runC(["hc"]);
        for (let i = 0; i < 20; i++) await flush();
        // C's join, then one join for the unservable head (B rode on A's).
        expect(joins).toBe(4);
        expect(queue.stats.deduped).toBe(1);
        expect([...queue.failed("a")]).toEqual(["nobody"]);
        expect([...queue.failed("b")]).toEqual(["nobody"]);
        expect(queue.busy("a")).toBe(false);
        expect(queue.busy("b")).toBe(false);

        // A batch that made progress does not retry its own owner.
        served.add("ha");
        queue.fail("a", ["nobody-a"]);
        await runA(["ha"]);
        for (let i = 0; i < 20; i++) await flush();
        expect(joins).toBe(6);
        expect(queue.failed("a").has("nobody-a")).toBe(true);
    });

    it("settles once per pull", async () => {
        const log = fakeLog();
        const queue = new PullQueue(log.ports, new RejectionRecord());
        const handed: string[][] = [];
        const pulled = queue.pull("b", ["hb"]);
        log.calls[0].resolve();
        await pulled;
        queue.fail("b", ["hb"]);
        queue.settled("b", false);
        queue.onRetry("b", (retried) => handed.push(retried));

        // A has no batch in flight: its progress means nothing.
        queue.onRetry("a", () => {});
        queue.settled("a", true);
        expect(handed).toEqual([]);

        const a = queue.pull("a", ["ha"]);
        log.calls[1].resolve();
        await a;
        queue.settled("a", true);
        expect(handed).toEqual([["hb"]]);
        queue.fail("b", ["hb"]);
        // A second settled of the same pull retries nobody again.
        queue.settled("a", true);
        expect(handed).toHaveLength(1);
        expect([...queue.failed("b")]).toEqual(["hb"]);
    });

    it("lets a retry listener pull again at once", async () => {
        const log = fakeLog();
        const queue = new PullQueue(log.ports, new RejectionRecord());
        const pulled = queue.pull("a", ["h1"]);
        log.calls[0].resolve();
        await pulled;
        queue.fail("a", ["h1"]);
        const errors: unknown[] = [];
        queue.onRetry("a", (retried) => {
            try {
                void queue.pull("a", retried);
            } catch (error) {
                errors.push(error);
            }
        });
        // Due while classifying, retried inside settled().
        queue.retry("a");
        queue.settled("a", false);
        expect(errors).toEqual([]);
        expect(log.calls.map((call) => call.heads)).toEqual([["h1"], ["h1"]]);
        expect(queue.busy("a")).toBe(true);
    });

    it("keeps a released owner's batch for the owners waiting on it", async () => {
        const log = fakeLog();
        const queue = new PullQueue(log.ports, new RejectionRecord());
        const handed: string[][] = [];
        queue.onRetry("a", (retried) => handed.push(retried));
        const a = watch(queue.pull("a", ["h1"]));
        const b = watch(queue.pull("b", ["h1"]));
        queue.fail("a", ["old"]);

        queue.release("a");
        expect(queue.busy("a")).toBe(false);
        expect(queue.failed("a").size).toBe(0);
        expect(log.calls).toHaveLength(1);

        log.calls[0].resolve();
        await flush();
        expect(b.report).toMatchObject({ heads: ["h1"], joined: 0 });
        // The released owner's report still resolves; later calls for it
        // change nothing.
        expect(a.report).toMatchObject({ heads: ["h1"], joined: 1 });
        queue.fail("a", ["late"]);
        queue.settled("a", true);
        queue.retry("a");
        expect(queue.failed("a").size).toBe(0);
        expect(handed).toEqual([]);
    });

    it("unsubscribes on dispose and lets pending reports resolve", async () => {
        const log = fakeLog();
        const queue = new PullQueue(log.ports, new RejectionRecord());
        const handed: string[][] = [];
        const pending = watch(queue.pull("a", ["h1"]));
        queue.onRetry("a", (retried) => handed.push(retried));
        queue.fail("a", ["h0"]);

        queue.dispose();
        queue.dispose();
        expect(log.listeners.size).toBe(0);
        expect(queue.busy("a")).toBe(false);
        queue.retry();
        expect(handed).toEqual([]);

        // A pull after dispose joins nothing and reports at once.
        const late = await queue.pull("b", ["h2"]);
        expect(log.calls).toHaveLength(1);
        expect(late.joined).toBe(0);
        expect(late.error).toBeInstanceOf(Error);

        log.calls[0].resolve();
        await flush();
        expect(pending.report).toMatchObject({ heads: ["h1"], joined: 1 });
    });
});
