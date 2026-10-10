import { randomBytes } from "@peerbit/crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
    CELL_BYTES,
    DIGEST_BYTES,
    FETCH_MAX,
    M,
    MAX_ANSWER_BYTES,
    PULL_BATCH,
    T_SYNC,
} from "../readiness/constants.js";
import { headDigest } from "../readiness/digest.js";
import { RejectionRecord } from "../readiness/explain.js";
import { PullQueue } from "../readiness/pull-queue.js";
import {
    SCOPE_NAMESPACE_V1,
    SCOPE_TRUST_V1,
    type ScopeId,
} from "../readiness/scopes.js";
import {
    ATTEMPT_DELAYS_MS,
    cellPrefix,
    localScopeOf,
    type JoinerSession,
    type LocalScope,
    type SessionInit,
    type SessionOutcome,
    type SessionResult,
} from "../readiness/session.js";
import {
    CellsReqV1,
    CellsV1,
    CloseV1,
    ERROR_CODE,
    ErrorV1,
    HeaderV1,
    ListPageV1,
    ListV1,
    OPEN_FLAG_LIST,
    OpenScopeV1,
    OpenV1,
    encodeReadinessMessage,
    type ReadinessMessage,
} from "../readiness/wire.js";
import {
    FakeTimers,
    JoinerWorld,
    bytesOf,
    copyMessage,
    headOf,
    packDigests,
    settle,
    type Entry,
    type FakePeer,
    type FakeScope,
} from "./readiness-joiner-harness.js";

/**
 * The joiner session at its edges (PR-3 commit 1 review): J changing while
 * its cells copy, a classification or a pull is in flight; J's lane set
 * refusing requests; the sink rules after the peel; timers left armed;
 * malformed and mismatched answers; the boundaries of the fast path, the
 * re-peel budget, the gap estimate and the sequence-point guard; errors
 * while listing; and the fallbacks that keep a refused pull or a stable
 * mismatch from looping. Each case pins a rule a planted bug in session.ts
 * would break; every contained outcome still goes through the harness's
 * oracle.
 */

const NS = SCOPE_NAMESPACE_V1;

const kinds = (outcomes: SessionOutcome[]) =>
    outcomes.map((outcome) =>
        outcome.kind === "renew"
            ? `renew:${outcome.reason}`
            : outcome.kind === "contained"
              ? `contained:${outcome.results.map((r) => r.mode).join(",")}`
              : outcome.kind === "excluded"
                ? `excluded:${outcome.reason}`
                : outcome.kind
    );

const only = (outcome: SessionOutcome): SessionResult => {
    if (outcome.kind !== "contained") {
        throw new Error(`expected contained, got ${outcome.kind}`);
    }
    expect(outcome.results).toHaveLength(1);
    return outcome.results[0];
};

/**
 * `common` rows on both peers (wall times 1000+), `rOnly` on R (5000+ by
 * default), and J's own rows below R's hlc (`jBelow`, 100+) or above it
 * (`jAbove`, 8000+).
 */
const build = async (
    options: {
        common?: number;
        rOnly?: number;
        rBase?: number;
        jBelow?: number;
        jAbove?: number;
        scopes?: ScopeId[];
    } = {}
) => {
    const w = await JoinerWorld.create({ scopes: options.scopes });
    const rows = (peers: FakePeer[], n: number, prefix: string, base: number) =>
        w.scopeIds.flatMap((scope) =>
            w.rows(peers, n, {
                scope,
                prefix,
                modified: (i) => BigInt(base + i),
            })
        );
    const common = rows([w.r, w.j], options.common ?? 25, "c", 1000);
    const rOnly = rows([w.r], options.rOnly ?? 0, "r", options.rBase ?? 5000);
    const jBelow = rows([w.j], options.jBelow ?? 0, "jb", 100);
    const jAbove = rows([w.j], options.jAbove ?? 0, "ja", 8000);
    await w.start();
    return { w, common, rOnly, jBelow, jAbove };
};

/** Runs `during` after J's first cells copy is taken, before it answers. */
const duringFirstCopy = (j: FakeScope, during: () => void) => {
    const cellsNow = j.laneSet.cellsNow.bind(j.laneSet);
    let taken = false;
    j.laneSet.cellsNow = () => {
        const copy = cellsNow();
        if (taken) return copy;
        taken = true;
        return {
            seq: copy.seq,
            cells: copy.cells.then((bytes) => {
                during();
                return bytes;
            }),
        };
    };
    return () => taken;
};

/** `fn` once, the first time the session's scope turns certifying. */
const onFirstCertifying = (fn: () => void) => {
    let done = false;
    return {
        onState: (_: JoinerSession, __: unknown, state: string) => {
            if (state !== "certifying" || done) return;
            done = true;
            fn();
        },
        done: () => done,
    };
};

/** A session over ports whose `LocalScope` `patch` adjusts. */
const patchedSession = (
    w: JoinerWorld,
    init: SessionInit,
    patch: (local: LocalScope, real: LocalScope) => void
) =>
    w.session(init, {
        ports: {
            scope: (id) => {
                const ports = w.scopePorts(id)!;
                const local: LocalScope = Object.create(ports.local);
                patch(local, ports.local);
                return { ...ports, local };
            },
        },
    });

const failing = <T>(what: string): Promise<T> => {
    const rejected = Promise.reject<T>(new Error(`${what} refused`));
    rejected.catch(() => {});
    return rejected;
};

const outcomeOf = async (w: JoinerWorld, session: JoinerSession) => {
    await w.until(() => session.outcome !== undefined, "outcome");
    return session.outcome!;
};

describe("readiness joiner session edges", () => {
    afterEach(() => {
        for (const w of JoinerWorld.created.splice(0)) {
            w.dispose();
            w.assertClean();
        }
    });

    describe("J changes while its cells copy is in flight (P3's journal)", () => {
        it("an R row J indexes meanwhile leaves the pending set", async () => {
            const { w, rOnly } = await build({ common: 40, rOnly: 4 });
            const j = w.j.scope();
            const taken = duringFirstCopy(j, () => j.receive(rOnly[0]));
            const { final, sessions } = await w.drive();
            expect(taken()).toBe(true);
            expect(only(final).pulled).toBe(3);
            // Gone from the peel's result itself, never classified.
            expect(j.inspected).not.toContain(rOnly[0].head);
            expect(sessions[0].debug().scopes[NS]).toMatchObject({
                repeels: 0,
                mismatches: 0,
            });
        });

        it("R's row at exactly R's hlc that J loses meanwhile is R's again", async () => {
            // R's own rows are older than the common ones: the newest
            // common row is R's hlc.
            const { w, common } = await build({
                common: 30,
                rOnly: 4,
                rBase: 500,
            });
            const j = w.j.scope();
            const newest = common[common.length - 1];
            duringFirstCopy(j, () => j.receive(w.cut(newest, 9_000n)));
            const { final, sessions } = await w.drive();
            const result = only(final);
            expect(result.hlc).toBe(newest.modified);
            expect(result.explainedBy).toEqual({ superseded: 1 });
            expect(sessions[0].debug().scopes[NS]).toMatchObject({
                repeels: 0,
                mismatches: 0,
            });
        });

        it("a row of J's that R lacks, lost meanwhile, leaves X", async () => {
            const { w, jBelow } = await build({
                common: 30,
                rOnly: 4,
                jBelow: 4,
            });
            const j = w.j.scope();
            duringFirstCopy(j, () => j.receive(w.cut(jBelow[0], 9_000n)));
            const { final, sessions } = await w.drive();
            expect(only(final).x).toBe(3);
            expect(sessions[0].debug().scopes[NS]).toMatchObject({
                repeels: 0,
                mismatches: 0,
            });
        });

        it("a row above R's hlc lost meanwhile never becomes R's", async () => {
            const { w, jAbove } = await build({
                common: 30,
                rOnly: 4,
                jAbove: 4,
            });
            const j = w.j.scope();
            duringFirstCopy(j, () => j.receive(w.cut(jAbove[0], 9_000n)));
            const { final, sessions } = await w.drive();
            expect(only(final).x).toBe(3);
            expect(sessions[0].debug().scopes[NS]).toMatchObject({
                k: 3,
                repeels: 0,
                mismatches: 0,
            });
        });
    });

    describe("J changes while a classification or a pull is in flight (S15)", () => {
        it("rows indexed while the batch is classified are not pulled", async () => {
            const { w, rOnly } = await build({ rOnly: 3 });
            const explainer = w.explainers.get(NS)!;
            const beforePull = explainer.beforePull.bind(explainer);
            let once = false;
            explainer.beforePull = async (heads) => {
                const verdicts = await beforePull(heads);
                if (!once) {
                    once = true;
                    expect(verdicts.map(({ kind }) => kind)).toEqual([
                        "pull",
                        "pull",
                        "pull",
                    ]);
                    for (const entry of rOnly) w.j.scope().receive(entry);
                }
                return verdicts;
            };
            const { final } = await w.drive();
            expect(only(final).pulled).toBe(0);
            expect(w.joins).toHaveLength(0);
        });

        it("rows indexed while the pulled batch is classified need nothing more", async () => {
            const { w, rOnly } = await build({ rOnly: 3 });
            // The join brings nothing; the rows arrive by sync while the
            // batch is classified after it.
            for (const entry of rOnly) w.unserved.add(entry.head);
            const explainer = w.explainers.get(NS)!;
            const afterPull = explainer.afterPull.bind(explainer);
            explainer.afterPull = async (heads, rejections) => {
                const verdicts = await afterPull(heads, rejections);
                for (const entry of rOnly) w.j.scope().receive(entry);
                return verdicts;
            };
            const { final, outcomes } = await w.drive();
            expect(kinds(outcomes)).toEqual(["contained:peel"]);
            expect(only(final).pulled).toBe(3);
            expect(w.joins).toHaveLength(1);
        });

        it("a hash indexed while its batch is classified is progress: the other session's failed hash is retried", async () => {
            const { w } = await build();
            // No index subscription: only the sessions' own events retry.
            const bare = new PullQueue(w.joinPorts(NS), new RejectionRecord());
            w.pulls.get(NS)!.dispose();
            w.pulls.set(NS, bare);
            const phantom: Entry = {
                head: headOf("phantom"),
                scope: NS,
                kind: "row",
                id: "phantom",
                modified: 5100n,
                next: [],
            };
            w.plantInR(phantom, "phantom", 5100n, { logged: false });
            const init = () => {
                const out = w.init();
                out.ladder = { ...out.ladder, fetchRenewed: true };
                return out;
            };
            const a = w.session(init());
            a.start();
            await w.until(() => a.state(NS) === "failed-fetch-wait", "a waits");
            // B's batch is one row that sync indexes while B classifies it.
            const late = w.row("late", 5200n);
            w.r.scope().receive(late);
            w.unserved.add(late.head);
            const explainer = w.explainers.get(NS)!;
            const afterPull = explainer.afterPull.bind(explainer);
            explainer.afterPull = async (heads, rejections) => {
                const verdicts = await afterPull(heads, rejections);
                if (heads.includes(late.head)) w.j.scope().receive(late);
                return verdicts;
            };
            const joins = w.joins.length;
            const b = w.session(init());
            b.start();
            await w.until(() => b.state(NS) === "failed-fetch-wait", "b waits");
            await settle(50);
            expect(
                w.joins.slice(joins).map(({ heads }) => [...heads].sort())
            ).toEqual([[late.head, phantom.head].sort(), [phantom.head]]);
            a.close();
            b.close();
        });
    });

    describe("J's lane set refuses a request (C3)", () => {
        const refuse = (
            j: FakeScope,
            method: "digestNow" | "cellsNow" | "digestOf",
            times: number
        ) => {
            const counter = { calls: 0 };
            if (method === "digestOf") {
                const real = j.laneSet.digestOf.bind(j.laneSet);
                j.laneSet.digestOf = (set) =>
                    ++counter.calls <= times ? failing("digestOf") : real(set);
            } else if (method === "digestNow") {
                const real = j.laneSet.digestNow.bind(j.laneSet);
                j.laneSet.digestNow = (sub, add) => {
                    const out = real(sub, add);
                    if (++counter.calls > times) return out;
                    out.digest.catch(() => {});
                    return { seq: out.seq, digest: failing("digestNow") };
                };
            } else {
                const real = j.laneSet.cellsNow.bind(j.laneSet);
                j.laneSet.cellsNow = () => {
                    const out = real();
                    if (++counter.calls > times) return out;
                    out.cells.catch(() => {});
                    return { seq: out.seq, cells: failing("cellsNow") };
                };
            }
            return counter;
        };

        it("a certificate refused once (a worker respawn) is asked again", async () => {
            const { w } = await build({ rOnly: 3 });
            const calls = refuse(w.j.scope(), "digestNow", 1);
            const { final } = await w.drive();
            expect(only(final).pulled).toBe(3);
            expect(calls.calls).toBe(2);
        });

        it("a certificate refused twice ends the scope as local-unavailable, never a loop", async () => {
            const { w } = await build({ rOnly: 3 });
            const calls = refuse(w.j.scope(), "digestNow", Infinity);
            const { final } = await w.drive();
            expect(final).toMatchObject({
                kind: "local-unavailable",
                scope: NS,
            });
            expect(calls.calls).toBe(2);
        });

        it("a cells copy refused once is taken again; refused twice ends the scope", async () => {
            const once = await build({ rOnly: 3 });
            const first = refuse(once.w.j.scope(), "cellsNow", 1);
            expect(only((await once.w.drive()).final).pulled).toBe(3);
            expect(first.calls).toBe(2);

            const always = await build({ rOnly: 3 });
            const second = refuse(always.w.j.scope(), "cellsNow", Infinity);
            expect((await always.w.drive()).final.kind).toBe(
                "local-unavailable"
            );
            expect(second.calls).toBe(2);
        });

        it("the list's digest refused once is asked again; refused twice ends the scope", async () => {
            const once = await build({ rOnly: 3 });
            const first = refuse(once.w.j.scope(), "digestOf", 1);
            const result = only(
                (await once.w.drive({ init: once.w.init({ list: true }) }))
                    .final
            );
            expect(result.mode).toBe("list");
            expect(first.calls).toBe(2);

            const always = await build({ rOnly: 3 });
            const second = refuse(always.w.j.scope(), "digestOf", Infinity);
            expect(
                (await always.w.drive({ init: always.w.init({ list: true }) }))
                    .final.kind
            ).toBe("local-unavailable");
            expect(second.calls).toBe(2);
        });

        it("the empty set's digest refused once is asked again", async () => {
            const { w } = await build({ common: 0 });
            const calls = refuse(w.j.scope(), "digestOf", 1);
            expect(only((await w.drive()).final).mode).toBe("empty");
            expect(calls.calls).toBe(2);
        });
    });

    describe("J's changes after the peel (D7, D8)", () => {
        it("a pulled row J loses before the certificate is R's again, explained, with no re-peel", async () => {
            const { w, rOnly } = await build({ rOnly: 5 });
            const newest = rOnly[4];
            let cut: Entry | undefined;
            const session = w.session(w.init(), {
                events: {
                    onState: (_, __, state) => {
                        const j = w.j.scope();
                        if (state !== "certifying" || cut) return;
                        if (j.index.get(newest.id!)?.head !== newest.head) {
                            return;
                        }
                        // R's newest row: modified is R's hlc exactly.
                        cut = w.cut(newest, 6000n);
                        j.receive(cut);
                    },
                },
            });
            session.start();
            const result = only(await outcomeOf(w, session));
            expect(cut).toBeDefined();
            expect(result.explainedBy).toEqual({ superseded: 1 });
            expect(session.debug().scopes[NS]).toMatchObject({
                repeels: 0,
                mismatches: 0,
            });
        });

        it("a row of J's that R lacks, lost after the peel, leaves X", async () => {
            const { w, jBelow } = await build({ rOnly: 3, jBelow: 2 });
            const cut = onFirstCertifying(() =>
                w.j.scope().receive(w.cut(jBelow[0], 6000n))
            );
            const session = w.session(w.init(), { events: cut });
            session.start();
            const result = only(await outcomeOf(w, session));
            expect(cut.done()).toBe(true);
            expect(result.x).toBe(1);
            expect(session.debug().scopes[NS]).toMatchObject({
                repeels: 0,
                mismatches: 0,
            });
        });

        it("an explained hash J indexes later leaves E", async () => {
            const { w, rOnly } = await build({ rOnly: 3, jBelow: 2 });
            w.rejected.set(rOnly[0].head, {
                permanent: true,
                reason: "structure",
            });
            const index = onFirstCertifying(() => {
                w.rejected.delete(rOnly[0].head);
                w.j.scope().receive(rOnly[0]);
            });
            const session = w.session(w.init(), { events: index });
            session.start();
            const result = only(await outcomeOf(w, session));
            expect(index.done()).toBe(true);
            expect(result.explained).toBe(0);
            expect(session.debug().scopes[NS]).toMatchObject({
                repeels: 0,
                mismatches: 0,
            });
        });

        describe("list mode", () => {
            it("a row of J's outside R's list, lost, needs nothing", async () => {
                const { w, common, jBelow } = await build({
                    rOnly: 3,
                    jBelow: 2,
                });
                const cut = onFirstCertifying(() =>
                    w.j.scope().receive(w.cut(jBelow[0], 6000n))
                );
                const session = w.session(w.init({ list: true }), {
                    events: cut,
                });
                session.start();
                const result = only(await outcomeOf(w, session));
                expect(cut.done()).toBe(true);
                expect(result).toMatchObject({ mode: "list", x: 1 });
                expect(session.debug().scopes[NS]!.mismatches).toBe(0);
                // Listed rows J holds are never pending, never classified.
                const held = new Set(common.map(({ head }) => head));
                expect(
                    w.j.scope().inspected.filter((head) => held.has(head))
                ).toEqual([]);
            });

            it("a listed row J loses is pending again and explained", async () => {
                const { w, common } = await build({ rOnly: 3, jBelow: 2 });
                const cut = onFirstCertifying(() =>
                    w.j.scope().receive(w.cut(common[0], 6000n))
                );
                const session = w.session(w.init({ list: true }), {
                    events: cut,
                });
                session.start();
                const result = only(await outcomeOf(w, session));
                expect(cut.done()).toBe(true);
                expect(result.explainedBy).toEqual({ superseded: 1 });
                expect(session.debug().scopes[NS]!.mismatches).toBe(0);
            });

            it("an explained hash J indexes later leaves E", async () => {
                const { w, rOnly } = await build({ rOnly: 3, jBelow: 2 });
                w.rejected.set(rOnly[0].head, {
                    permanent: true,
                    reason: "structure",
                });
                const index = onFirstCertifying(() => {
                    w.rejected.delete(rOnly[0].head);
                    w.j.scope().receive(rOnly[0]);
                });
                const session = w.session(w.init({ list: true }), {
                    events: index,
                });
                session.start();
                const result = only(await outcomeOf(w, session));
                expect(index.done()).toBe(true);
                expect(result.explained).toBe(0);
                expect(session.debug().scopes[NS]!.mismatches).toBe(0);
            });
        });

        it("a contained scope ignores J's later changes while the other scope works", async () => {
            const { w, rOnly } = await build({
                rOnly: 2,
                scopes: [SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1],
            });
            // The trust scope's pull is held, so the session stays open.
            let open!: () => void;
            const gate = new Promise<void>((resolve) => (open = resolve));
            const queue = w.pulls.get(SCOPE_TRUST_V1)!;
            const pull = queue.pull.bind(queue);
            queue.pull = async (owner, heads) => {
                await gate;
                return pull(owner, heads);
            };
            const session = w.session(w.init());
            session.start();
            await w.until(() => session.state(NS) === "contained", "contained");
            // J loses a namespace row R holds.
            const pulled = rOnly.find((entry) => entry.scope === NS)!;
            w.j.scope(NS).receive(w.cut(pulled, 9000n));
            await settle();
            expect(session.debug().scopes[NS]).toMatchObject({
                state: "contained",
                pending: 0,
                k: 0,
            });
            open();
            await outcomeOf(w, session);
        });
    });

    describe("a lie anywhere in the batch excludes R (step 11)", () => {
        /** R's rows and a FileChunk R names; the batch order of a dry run. */
        const chunkWorld = async () => {
            const built = await build({ rOnly: 20 });
            const chunk = built.w.other("chunk");
            built.w.plantInR(chunk, "planted", 5100n);
            return { ...built, chunk };
        };

        for (const fetchRenewed of [false, true]) {
            it(`a FileChunk behind a hash nobody serves${fetchRenewed ? ", after the fetch renewal" : ""}`, async () => {
                const dry = await chunkWorld();
                await dry.w.drive();
                const order = dry.w.joins[0].heads;
                expect(order.indexOf(dry.chunk.head)).toBeGreaterThan(0);
                const { w, chunk } = await chunkWorld();
                expect(chunk.head).toBe(dry.chunk.head);
                w.unserved.add(order[0]);
                const init = w.init();
                init.ladder = { ...init.ladder, fetchRenewed };
                const session = w.session(init);
                session.start();
                expect(await outcomeOf(w, session)).toMatchObject({
                    kind: "excluded",
                    reason: "unsubstantiated",
                });
            });
        }

        it("a FileChunk behind a hash parked for trust", async () => {
            const dry = await chunkWorld();
            await dry.w.drive();
            const order = dry.w.joins[0].heads;
            const { w } = await chunkWorld();
            w.rejected.set(order[0], { permanent: false, reason: "untrusted" });
            const session = w.session(w.init());
            session.start();
            expect(await outcomeOf(w, session)).toMatchObject({
                kind: "excluded",
                reason: "unsubstantiated",
            });
        });
    });

    describe("timers: nothing armed without a request in flight", () => {
        it("a cells answer disarms its attempt timer", async () => {
            const { w } = await build({ common: 10, rOnly: 300 });
            let open!: () => void;
            w.joinGate = new Promise<void>((resolve) => (open = resolve));
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => w.joins.length === 1 && session.state(NS) === "draining",
                "draining"
            );
            expect(w.sent(CellsReqV1)).toHaveLength(1);
            expect(session.debug().armedTimers).toBe(0);
            open();
            await outcomeOf(w, session);
        });

        it("a list page disarms its attempt timer", async () => {
            const { w } = await build({ common: 10, rOnly: 30 });
            let open!: () => void;
            w.joinGate = new Promise<void>((resolve) => (open = resolve));
            const session = w.session(w.init({ list: true }));
            session.start();
            await w.until(
                () => w.joins.length === 1 && session.state(NS) === "draining",
                "draining"
            );
            expect(session.debug().armedTimers).toBe(0);
            open();
            await outcomeOf(w, session);
        });

        it("leaving the sync wait disarms its window", async () => {
            const w = await JoinerWorld.create();
            const old = w.rows([w.r], 400);
            await w.start();
            w.syncDelivering.add(NS);
            let open!: () => void;
            w.joinGate = new Promise<void>((resolve) => (open = resolve));
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => session.state(NS) === "waiting-sync",
                "waiting-sync"
            );
            for (const entry of old.slice(0, 300)) w.j.scope().receive(entry);
            await w.until(
                () => w.joins.length === 1 && session.state(NS) === "draining",
                "draining"
            );
            expect(session.debug().armedTimers).toBe(0);
            open();
            await outcomeOf(w, session);
        });

        it("resume() gives a silent request a new series of attempts", async () => {
            const { w } = await build({ common: 10, rOnly: 300 });
            w.hooks.toJ = (m) => (m instanceof CellsV1 ? null : m);
            const delays: number[] = [];
            const set = w.timers.set.bind(w.timers);
            const session = w.session(w.init(), {
                ports: {
                    timers: {
                        set: (fn, ms) => {
                            delays.push(ms);
                            return set(fn, ms);
                        },
                        clear: (handle) => w.timers.clear(handle),
                    },
                },
            });
            session.start();
            await w.until(() => w.sent(CellsReqV1).length === 1, "request");
            for (const ms of ATTEMPT_DELAYS_MS) {
                w.timers.advance(ms);
                await settle();
            }
            expect(session.state(NS)).toBe("silent");
            session.resume();
            expect(w.sent(CellsReqV1)).toHaveLength(4);
            w.timers.advance(ATTEMPT_DELAYS_MS[0]);
            await settle();
            expect(w.sent(CellsReqV1)).toHaveLength(5);
            expect(delays.every((ms) => Number.isFinite(ms))).toBe(true);
            session.close();
        });

        it("the harness clock refuses a delay that is not a number", () => {
            const timers = new FakeTimers();
            expect(() => timers.set(() => {}, undefined as any)).toThrow();
            expect(() => timers.set(() => {}, NaN)).toThrow();
            expect(timers.armed()).toBe(0);
        });
    });

    describe("malformed and mismatched answers are dropped, never proof (2.6 rules 6, 8)", () => {
        /** A session whose R answers are held back; the test delivers. */
        const held = async (options: { list?: boolean; rOnly?: number }) => {
            const { w } = await build({ rOnly: options.rOnly ?? 5 });
            const session = w.session(w.init({ list: options.list }));
            return { w, session };
        };

        it("a list page whose size is not a multiple of 32", async () => {
            const { w, session } = await held({ list: true });
            let first = true;
            w.hooks.toJ = (m) => {
                if (m instanceof ListV1 && first) {
                    first = false;
                    const out = new Uint8Array(m.hashes.length + 1);
                    out.set(m.hashes);
                    m.hashes = out;
                }
                return m;
            };
            session.start();
            await w.until(() => session.debug().dropped >= 1, "dropped");
            await settle();
            expect(session.outcome).toBeUndefined();
            // The attempt timer asks again, and the honest page counts.
            w.timers.advance(ATTEMPT_DELAYS_MS[0]);
            expect(only(await outcomeOf(w, session)).mode).toBe("list");
        });

        for (const [name, tamper] of [
            [
                "another format tag",
                (m: HeaderV1) => (m.provenance.formatTag = "shared-fs/v9.1"),
            ],
            [
                "pushed cells beyond M",
                (m: HeaderV1) => {
                    m.cellsFrom = M - 1;
                    m.cells = new Uint8Array(2 * CELL_BYTES);
                },
            ],
            [
                "ragged pushed cells",
                (m: HeaderV1) => {
                    m.cells = new Uint8Array(CELL_BYTES + 1);
                },
            ],
        ] as const) {
            it(`a header with ${name}`, async () => {
                const { w, session } = await held({});
                w.hooks.toJ = (m) => {
                    if (m instanceof HeaderV1) tamper(m);
                    return m;
                };
                session.start();
                await w.until(() => session.debug().dropped >= 1, "dropped");
                await settle();
                expect(session.outcome).toBeUndefined();
                expect(session.state(NS)).toBe("asking");
                session.close();
            });
        }

        for (const [name, tamper] of [
            [
                "one cell short",
                (m: CellsV1) => {
                    m.cells = m.cells.slice(0, m.cells.length - CELL_BYTES);
                },
            ],
            ["from another offset", (m: CellsV1) => (m.from += 1)],
        ] as const) {
            it(`a cells answer ${name}`, async () => {
                const { w, session } = await held({ rOnly: 300 });
                let first = true;
                w.hooks.toJ = (m) => {
                    if (m instanceof CellsV1 && first) {
                        first = false;
                        tamper(m);
                    }
                    return m;
                };
                session.start();
                await w.until(() => session.debug().dropped >= 1, "dropped");
                await settle();
                expect(w.sent(CellsReqV1)).toHaveLength(1);
                expect(session.state(NS)).toBe("peeling");
                w.timers.advance(ATTEMPT_DELAYS_MS[0]);
                expect(only(await outcomeOf(w, session)).pulled).toBe(300);
                expect(w.sent(CellsReqV1)).toHaveLength(2);
            });
        }

        it("pushed cells that do not start at 0 are not used", async () => {
            const { w } = await build({ common: 40, rOnly: 5 });
            w.hooks.toJ = (m) => {
                if (m instanceof HeaderV1 && m.cells.length > 0) {
                    m.cellsFrom = 8;
                }
                return m;
            };
            const { final } = await w.drive();
            expect(only(final).pulled).toBe(5);
            expect(w.sent(CellsReqV1)[0]).toMatchObject({ from: 0 });
        });

        it("an answer before any OPEN went out is not for this session", async () => {
            const { w } = await build({ rOnly: 2 });
            await w.drive();
            const header = copyMessage(
                w.sentToJ.find((m): m is HeaderV1 => m instanceof HeaderV1)!
            );
            const session = w.session(w.init());
            header.sessionId = session.sessionId;
            session.onMessage(
                header,
                w.r.hash,
                encodeReadinessMessage(header).length
            );
            expect(session.debug().dropped).toBe(1);
            expect(session.state(NS)).toBe("asking");
            session.close();
        });

        it("an ErrorV1 over 256 KiB excludes R on the session's first scope", async () => {
            const { w, session } = await held({});
            w.hooks.toR = (m) => (m instanceof OpenV1 ? null : m);
            session.start();
            const error = new ErrorV1({
                sessionId: session.sessionId,
                code: ERROR_CODE.BUSY,
            });
            session.onMessage(error, w.r.hash, MAX_ANSWER_BYTES + 1);
            expect(session.outcome).toMatchObject({
                kind: "excluded",
                reason: "inconsistent",
                scope: NS,
            });
        });

        it("BUSY after a header with nothing listing is dropped", async () => {
            const { w, session } = await held({});
            w.hooks.toJ = () => null;
            session.start();
            await w.until(() => w.sentToJ.length === 1, "header");
            const header = copyMessage(w.sentToJ[0] as HeaderV1);
            const deliver = (m: ReadinessMessage) =>
                session.onMessage(
                    m,
                    w.r.hash,
                    encodeReadinessMessage(m).length
                );
            deliver(header);
            const state = session.state(NS);
            const dropped = session.debug().dropped;
            deliver(
                new ErrorV1({
                    sessionId: session.sessionId,
                    code: ERROR_CODE.BUSY,
                })
            );
            expect(session.debug().dropped).toBe(dropped + 1);
            expect(session.state(NS)).toBe(state);
            expect(session.outcome).toBeUndefined();
            session.close();
        });
    });

    describe("boundaries", () => {
        it("J holding R's rows plus only rows above R's hlc takes the fast path", async () => {
            const { w } = await build({ common: 30, jAbove: 3 });
            const { final, outcomes } = await w.drive();
            expect(outcomes).toHaveLength(1);
            expect(only(final)).toMatchObject({
                mode: "fast",
                x: 3,
                roundTrips: 1,
            });
            expect(w.sent(CellsReqV1)).toHaveLength(0);
        });

        it("one re-peel per session, however often J changes", async () => {
            const { w } = await build({ rOnly: 5 });
            w.hooks.toJ = (m) => {
                if (m instanceof HeaderV1) m.anchor = bytesOf("forged");
                return m;
            };
            let n = 0;
            const session = w.session(w.init(), {
                events: {
                    onState: (_, __, state) => {
                        if (state !== "certifying") return;
                        n++;
                        w.j
                            .scope()
                            .receive(w.row(`late${n}`, 99_000n + BigInt(n)));
                    },
                },
            });
            session.start();
            expect(await outcomeOf(w, session)).toMatchObject({
                kind: "renew",
                reason: "mismatch",
            });
            expect(session.debug().scopes[NS]!.repeels).toBe(1);
        });

        it("a lane set at another sequence point than the tap is local-unavailable, never contained", async () => {
            const { w } = await build({ common: 10 });
            const session = patchedSession(w, w.init(), (local, real) => {
                local.digestNow = (sub, add) => {
                    const out = real.digestNow(sub, add);
                    return { seq: out.seq + 1, digest: out.digest };
                };
            });
            session.start();
            expect((await outcomeOf(w, session)).kind).toBe(
                "local-unavailable"
            );
        });

        it("a gap of exactly T_SYNC in the sync wait peels at once", async () => {
            const w = await JoinerWorld.create();
            const old = w.rows([w.r], 3000);
            await w.start();
            w.syncDelivering.add(NS);
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => session.state(NS) === "waiting-sync",
                "waiting-sync"
            );
            for (const entry of old.slice(0, 3000 - T_SYNC)) {
                w.j.scope().receive(entry);
            }
            await settle(20);
            expect(w.sent(CellsReqV1)).toHaveLength(1);
            expect(w.sent(CellsReqV1)[0]).toMatchObject({
                to: cellPrefix(T_SYNC),
            });
            session.close();
        });

        it("a gap of exactly FETCH_MAX without sync peels at once", async () => {
            const w = await JoinerWorld.create();
            w.rows([w.r], FETCH_MAX);
            await w.start();
            const session = w.session(w.init());
            session.start();
            await w.until(
                () =>
                    w.sent(CellsReqV1).length > 0 ||
                    session.state(NS) === "waiting-sync",
                "cells or waiting-sync"
            );
            expect(session.state(NS)).not.toBe("waiting-sync");
            expect(w.sent(CellsReqV1)[0]).toMatchObject({
                from: 0,
                to: cellPrefix(FETCH_MAX),
            });
            session.close();
        });

        it("with hlcProved, R's `above` decays by the rows sync delivers, so the wait ends", async () => {
            const w = await JoinerWorld.create();
            w.rows([w.r, w.j], 100);
            const old = w.rows([w.r], 3000, {
                prefix: "r",
                modified: (i) => BigInt(5000 + i),
            });
            await w.start();
            w.syncDelivering.add(NS);
            const session = w.session(w.init({ hlcProved: 2000n }));
            session.start();
            await w.until(
                () => session.state(NS) === "waiting-sync",
                "waiting-sync"
            );
            const j = w.j.scope();
            let delivered = 0;
            while (w.sent(CellsReqV1).length === 0 && delivered < old.length) {
                for (let i = 0; i < 125; i++) j.receive(old[delivered++]);
                await settle(5);
            }
            expect(w.sent(CellsReqV1)).toHaveLength(1);
            expect(3000 - delivered).toBeLessThanOrEqual(T_SYNC);
            session.close();
        });

        it("a writer above R's hlc does not hold a stalled sync wait open", async () => {
            const w = await JoinerWorld.create();
            w.rows([w.r], 3000);
            await w.start();
            w.syncDelivering.add(NS);
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => session.state(NS) === "waiting-sync",
                "waiting-sync"
            );
            let left: number | undefined;
            for (let tick = 0; tick < 200 && left === undefined; tick++) {
                const entry = w.row(`w${tick}`, 10_000n + BigInt(tick));
                w.r.scope().receive(entry);
                w.j.scope().receive(entry);
                w.timers.advance(100);
                await settle(5);
                if (session.state(NS) !== "waiting-sync") left = tick;
            }
            expect(left).toBeDefined();
            expect((left! + 1) * 100).toBeLessThanOrEqual(1100 * 5);
            session.close();
        });

        it("a local change re-classifies at most one batch of logged hashes (D9)", async () => {
            const w = await JoinerWorld.create();
            w.rows([w.r, w.j], 10);
            const held = w.rows([w.r], 300, {
                prefix: "h",
                modified: (i) => BigInt(5000 + i),
            });
            await w.start();
            // J's log holds them, their index writes are held.
            for (const entry of held) {
                w.j.scope().receive(entry, { holdIndex: true });
            }
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => session.debug().scopes[NS]!.logged === 300,
                "logged"
            );
            const j = w.j.scope();
            const before = j.inspected.length;
            j.receive(w.row("unrelated", 99_000n));
            await settle(50);
            expect(j.inspected.length - before).toBe(PULL_BATCH);
            expect(session.debug().scopes[NS]!.logged).toBe(300);
            session.close();
        });

        it("OPEN sends `above` only with hlcProved", async () => {
            const { w } = await build({ common: 10, jAbove: 3 });
            const { final } = await w.drive();
            only(final);
            expect(w.sent(OpenV1)[0].scopes[0].above).toBe(0);
        });
    });

    describe("errors while listing, and BUSY with some headers", () => {
        it("EXPIRED on a page of an in-session list renews in list mode", async () => {
            const { w } = await build({ rOnly: 5 });
            w.hooks.toJ = JoinerWorld.cellsHook(
                await w.faultyCells({ as: w.j.scope() })
            );
            // A writer on R: the page reaches R after R's epoch moved.
            let written = 0;
            w.hooks.toR = (m) => {
                if (m instanceof ListPageV1) {
                    w.rows([w.r], 1, {
                        prefix: `w${written++}-`,
                        modified: () => BigInt(9000 + written),
                    });
                }
                return m;
            };
            const init = w.init();
            init.ladder = { ...init.ladder, stage: "fresh" };
            const { outcomes, inits } = await w.drive({ init });
            expect(outcomes[0]).toMatchObject({
                kind: "renew",
                reason: "expired",
                list: true,
            });
            expect(inits[1]).toMatchObject({
                list: true,
                ladder: { stage: "list" },
            });
            expect(outcomes.at(-1)!.kind).toBe("contained");
        });

        it("BUSY after the namespace header and before the trust header: R holds the session, so no busy outcome", async () => {
            const { w } = await build({
                rOnly: 5,
                scopes: [SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1],
            });
            // Another joiner holds R's one list-mode session.
            const { Ed25519Keypair } = await import("@peerbit/crypto");
            const key = (await Ed25519Keypair.create()).publicKey;
            const other = randomBytes(16);
            w.responder.onMessage(
                new OpenV1({
                    sessionId: other,
                    attempt: 1,
                    flags: OPEN_FLAG_LIST,
                    hlcProved: 0n,
                    scopes: [
                        new OpenScopeV1({
                            scope: NS,
                            logId: w.r.scope().logId,
                            count: 0,
                            above: 0,
                        }),
                    ],
                }),
                key
            );
            await settle();
            const cells = JoinerWorld.cellsHook(
                await w.faultyCells({ as: w.j.scope() })
            );
            // The first trust header is lost; the namespace cells collide,
            // so the fresh-stage namespace scope pages the list.
            let trustHeaders = 0;
            w.hooks.toJ = (m) => {
                if (m instanceof HeaderV1 && m.scope === SCOPE_TRUST_V1) {
                    return trustHeaders++ === 0 ? null : m;
                }
                if (
                    (m instanceof HeaderV1 || m instanceof CellsV1) &&
                    m.scope === NS
                ) {
                    return cells(m);
                }
                return m;
            };
            const init = w.init();
            init.ladder = { ...init.ladder, stage: "fresh" };
            const session = w.session(init);
            w.onNotice = () => session.resume();
            session.start();
            await w.until(() => session.state(NS) === "busy", "busy");
            await settle();
            expect(session.outcome).toBeUndefined();
            expect(session.state(SCOPE_TRUST_V1)).toBe("asking");
            // The OPEN's next attempt brings the trust header; the other
            // list session ends and R's notice resumes the list.
            w.timers.advance(ATTEMPT_DELAYS_MS[0]);
            await settle();
            w.responder.onMessage(new CloseV1({ sessionId: other }), key);
            const results = await outcomeOf(w, session);
            expect(kinds([results])).toEqual(["contained:list,peel"]);
        });

        it("a list-mode session that renews asks list mode again", async () => {
            const { w } = await build({ rOnly: 2 });
            w.hooks.toJ = () => null;
            const session = w.session(w.init({ list: true }));
            session.start();
            await w.until(() => w.sentToJ.length === 1, "header");
            const header = copyMessage(w.sentToJ[0] as HeaderV1);
            const bytes = encodeReadinessMessage(header).length;
            session.onMessage(header, w.r.hash, bytes);
            const restarted = copyMessage(header);
            restarted.provenance.openNonce = new Uint8Array(16).fill(1);
            session.onMessage(restarted, w.r.hash, bytes);
            expect(session.outcome).toMatchObject({
                kind: "renew",
                reason: "restarted",
                list: true,
            });
        });
    });

    describe("fallbacks that never loop", () => {
        it("a pull the queue refuses waits for the queue's next retry event", async () => {
            const { w } = await build({ common: 10, rOnly: 5 });
            const queue = w.pulls.get(NS)!;
            const pull = queue.pull.bind(queue);
            let refusals = 1;
            queue.pull = (owner, heads) => {
                if (refusals-- > 0) throw new Error("refused (a bug)");
                return pull(owner, heads);
            };
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => session.debug().scopes[NS]!.retry === 5,
                "retry"
            );
            await settle(50);
            expect(session.outcome).toBeUndefined();
            expect(w.joins).toHaveLength(0);
            expect(session.debug().armedTimers).toBe(0);
            // R's sign of life.
            session.resume();
            expect(only(await outcomeOf(w, session)).pulled).toBe(10);
        });

        it("a list-mode mismatch while J stays the same waits for J's next change", async () => {
            const { w } = await build({ common: 10 });
            let digests = 0;
            let broken = true;
            const session = patchedSession(
                w,
                w.init({ list: true }),
                (local, real) => {
                    local.digestNow = (sub, add) => {
                        digests++;
                        const out = real.digestNow(sub, add);
                        if (!broken) return out;
                        // A local inconsistency: never R's anchor.
                        return {
                            seq: out.seq,
                            digest: out.digest.then((digest) => {
                                const flipped = digest.slice();
                                flipped[0] ^= 1;
                                return flipped;
                            }),
                        };
                    };
                }
            );
            session.start();
            // The fast path's certificate, then the list's.
            await w.until(
                () => session.debug().scopes[NS]!.mismatches === 1,
                "mismatch"
            );
            await settle(100);
            expect(digests).toBe(2);
            expect(session.state(NS)).toBe("certifying");
            expect(session.debug().armedTimers).toBe(0);
            broken = false;
            w.j.scope().receive(w.row("late", 99_000n));
            expect(only(await outcomeOf(w, session)).mode).toBe("list");
            expect(digests).toBe(3);
        });
    });

    describe("rules no other case reaches", () => {
        it("a list whose set hash matches the header but holds a duplicate is inconsistent", async () => {
            const { w } = await build({ rOnly: 5 });
            const r = w.r.scope();
            const digests = [...r.index.values()].map(({ head }) =>
                headDigest(head)
            );
            const [keep, drop] = [digests[0], digests[1]];
            const tampered = digests.map((digest) =>
                digest === drop ? keep : digest
            );
            const anchor = await r.laneSet.digestOf(packDigests(tampered));
            w.hooks.toJ = (m) => {
                if (m instanceof HeaderV1) m.anchor = anchor;
                if (m instanceof ListV1) {
                    for (let o = 0; o < m.hashes.length; o += DIGEST_BYTES) {
                        if (
                            Buffer.from(
                                m.hashes.subarray(o, o + DIGEST_BYTES)
                            ).equals(Buffer.from(drop))
                        ) {
                            m.hashes.set(keep, o);
                        }
                    }
                }
                return m;
            };
            const { final } = await w.drive({ init: w.init({ list: true }) });
            expect(final).toMatchObject({
                kind: "excluded",
                reason: "inconsistent",
                detail: "a duplicate hash in the list",
            });
        });

        it("R's sign of life retries failed hashes only, never logged ones", async () => {
            const { w, rOnly } = await build({ rOnly: 2 });
            // One row's index write is held on J (logged); the other is
            // never served (failed).
            w.j.scope().receive(rOnly[0], { holdIndex: true });
            w.unserved.add(rOnly[1].head);
            const init = w.init();
            init.ladder = { ...init.ladder, fetchRenewed: true };
            const session = w.session(init);
            session.start();
            await w.until(
                () =>
                    session.debug().scopes[NS]!.logged === 1 &&
                    session.debug().scopes[NS]!.failed === 1,
                "logged and failed"
            );
            const j = w.j.scope();
            const inspected = () =>
                j.inspected.filter((head) => head === rOnly[0].head).length;
            const before = inspected();
            const joins = w.joins.length;
            session.resume();
            await settle(50);
            expect(w.joins.slice(joins).map(({ heads }) => heads)).toEqual([
                [rOnly[1].head],
            ]);
            expect(inspected()).toBe(before);
            session.close();
        });

        it("a row J's index holds before its change event waits for the event, never leaves early", async () => {
            const { w, rOnly } = await build({ rOnly: 1 });
            const j = w.j.scope();
            const [row] = rOnly;
            // Documents wrote the index; the tap has not seen the event.
            j.log.add(row.head);
            j.index.set(row.id!, { head: row.head, modified: row.modified });
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => session.debug().scopes[NS]!.logged === 1,
                "logged"
            );
            await settle(20);
            expect(session.outcome).toBeUndefined();
            expect(session.debug().scopes[NS]!.certificates).toBe(0);
            j.dispatchOnly(row);
            const result = only(await outcomeOf(w, session));
            expect(result).toMatchObject({ pulled: 0, certificates: 1 });
        });

        it("a tap that faults while the scope waits for a logged hash ends the session at J's next change", async () => {
            const { w, rOnly } = await build({ rOnly: 1 });
            w.j.scope().receive(rOnly[0], { holdIndex: true });
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => session.debug().scopes[NS]!.logged === 1,
                "logged"
            );
            const j = w.j.scope();
            j.tap.faulted = new Error("verify read failed");
            j.receive(w.row("unrelated", 99_000n));
            expect(await outcomeOf(w, session)).toEqual({
                kind: "local-unavailable",
                scope: NS,
                detail: "verify read failed",
            });
        });

        it("the list replaces the peel's explanations: E keeps only listed hashes J lacks", async () => {
            const { w } = await build({ rOnly: 5 });
            // R's cells name a phantom J's log supersedes (a CUT of it):
            // the peel explains it, and the certificate cannot match.
            const phantom: Entry = {
                head: headOf("phantom"),
                scope: NS,
                kind: "row",
                id: "phantom",
                modified: 5100n,
                next: [],
            };
            w.blocks.set(phantom.head, phantom);
            w.j.scope().receive(w.cut(phantom, 5200n));
            w.hooks.toJ = JoinerWorld.cellsHook(
                await w.faultyCells({
                    plant: headDigest(phantom.head),
                    sign: 1,
                })
            );
            const init = w.init();
            init.ladder = { ...init.ladder, stage: "fresh" };
            const session = w.session(init);
            session.start();
            const result = only(await outcomeOf(w, session));
            expect(result).toMatchObject({ mode: "list", explained: 0 });
        });

        it("a tap faulted before the session starts: local-unavailable, no OPEN", async () => {
            const { w } = await build({ common: 5 });
            w.j.scope().tap.faulted = new Error("faulted before");
            const session = w.session(w.init());
            session.start();
            expect(session.outcome).toEqual({
                kind: "local-unavailable",
                scope: NS,
                detail: "faulted before",
            });
            expect(w.sentToR).toHaveLength(0);
        });

        it("localScopeOf: a faulted or closed lane set is never trusted", async () => {
            const { w } = await build({ common: 5 });
            const j = w.j.scope();
            const local = localScopeOf(
                {
                    descriptor: j.descriptor,
                    tap: j.tap,
                    laneSet: j.laneSet,
                    logId: j.logId,
                    started: Promise.resolve(),
                },
                w.cellKey
            );
            expect(local.trusted).toBe(true);
            (j.laneSet as any).faulted = new Error("lane set failed");
            expect(local.trusted).toBe(false);
            expect(await local.confirmTrusted()).toBe(false);
            expect(String(local.faulted)).toMatch(/lane set failed/);
            (j.laneSet as any).faulted = undefined;
            expect(local.trusted).toBe(true);
            // The tap's own row of a key, by its head.
            const [id, row] = [...j.index][0];
            expect(local.holds(id, headDigest(row.head))).toBe(true);
            expect(local.holds(id, bytesOf("other"))).toBe(false);
            expect(local.holds("absent", headDigest(row.head))).toBe(false);
        });
    });
});
