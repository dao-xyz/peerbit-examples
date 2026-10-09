import { randomBytes } from "@peerbit/crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
    CELL_BYTES,
    DIGEST_BYTES,
    FETCH_MAX,
    LIST_PAGE_HASHES,
    M,
    MAX_ANSWER_BYTES,
    PULL_BATCH,
    PULL_TIMEOUT_MS,
    PUSH_MAX,
    SESSION_IDLE_MS,
    T_SYNC,
} from "../readiness/constants.js";
import { headDigest } from "../readiness/digest.js";
import {
    SCOPE_NAMESPACE_V1,
    SCOPE_TRUST_V1,
    type ScopeId,
} from "../readiness/scopes.js";
import {
    ATTEMPT_DELAYS_MS,
    FIRST_LADDER,
    JoinerSession,
    MAX_RENEWALS,
    SYNC_WINDOW_MS,
    cellPrefix,
    classifyNotice,
    gapEstimate,
    newSessionInit,
    nextSessionInit,
    qualifies,
    type LocalScope,
    type SessionInit,
    type SessionEvents,
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
    NOTICE_REASON,
    OPEN_FLAG_LIST,
    OpenScopeV1,
    OpenV1,
    ProvenanceV1,
    StateNoticeV1,
    encodeReadinessMessage,
    type ReadinessMessage,
} from "../readiness/wire.js";
import {
    JoinerWorld,
    bytesOf,
    copyMessage,
    headOf,
    hex,
    packDigests,
    settle,
    type Entry,
    type FakeScope,
} from "./readiness-joiner-harness.js";

/**
 * The joiner session (M1 plan section 7.3, PR-3 commit 1; design 4.5):
 * against PR-2's real responder, taps and lane sets on fake indexes, with
 * J's real pull queue and explainer, over an in-memory network with fault
 * hooks, on a fake clock. Every contained
 * outcome is checked by the harness's oracle (S_R within J's index plus E
 * at the certificate's sequence point), so no test here can pass on a wrong
 * ready. Design tests 22, 25, 28, 29, 30, 31 (joiner half), 40, 50, 51 and
 * the unit half of 44.
 */

const contained = (outcome: SessionOutcome): SessionResult[] => {
    if (outcome.kind !== "contained") {
        throw new Error(`expected contained, got ${JSON.stringify(outcome)}`);
    }
    return outcome.results;
};

const only = (outcome: SessionOutcome) => {
    const results = contained(outcome);
    expect(results).toHaveLength(1);
    return results[0];
};

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

/** A world with `common` rows on both peers and `rOnly` more on R. */
const world = async (
    options: {
        common?: number;
        rOnly?: number;
        jOnly?: number;
        scopes?: ScopeId[];
    } = {}
) => {
    const w = await JoinerWorld.create({ scopes: options.scopes });
    for (const scope of w.scopeIds) {
        w.rows([w.r, w.j], options.common ?? 20, { scope });
        w.rows([w.r], options.rOnly ?? 0, {
            scope,
            prefix: "r",
            modified: (i) => BigInt(5000 + i),
        });
        w.rows([w.j], options.jOnly ?? 0, {
            scope,
            prefix: "j",
            modified: (i) => BigInt(6000 + i),
        });
    }
    await w.start();
    return w;
};

/** The headers R sent (before any hook). */
const headersSent = (w: JoinerWorld) =>
    w.sentToJ.filter((m): m is HeaderV1 => m instanceof HeaderV1);

describe("readiness joiner session", () => {
    // Every finished session of every world passed the oracle and left no
    // timer armed (the session swallows a listener's error, so the harness
    // records them).
    afterEach(() => {
        for (const w of JoinerWorld.created.splice(0)) {
            w.dispose();
            w.assertClean();
        }
    });

    describe("pure helpers", () => {
        it("gapEstimate counts J's rows at or below R's hlc only, and the above term only with hlcProved", () => {
            expect(
                gapEstimate({
                    countR: 100,
                    countJ: 95,
                    aboveR: 50,
                    aboveJ: 50,
                    hlcProved: 0n,
                })
            ).toBe(5);
            // J's rows above R's hlc are not in `countJ` (the session passes
            // J's count minus k): they leave the peel, so they count on
            // neither side. Design 4.5 step 4 would add k (deviation m).
            expect(
                gapEstimate({
                    countR: 100,
                    countJ: 100,
                    aboveR: 0,
                    aboveJ: 0,
                    hlcProved: 0n,
                })
            ).toBe(0);
            // Equal counts: only the above term sees the gap.
            expect(
                gapEstimate({
                    countR: 100,
                    countJ: 100,
                    aboveR: 40,
                    aboveJ: 40,
                    hlcProved: 7n,
                })
            ).toBe(80);
        });

        it("cellPrefix matches the responder's first flight for every pushed gap", async () => {
            const table: Array<[number, number]> = [
                [0, 64],
                [1, 64],
                [35, 64],
                [36, 96],
                [100, 192],
                [256, 480],
                [1000, 1824],
                [2000, 3616],
                [2275, 4096],
                [5000, 4096],
            ];
            for (const [gap, cells] of table) {
                expect(cellPrefix(gap), `gap ${gap}`).toBe(cells);
            }
            // The responder's private first flight, observed: it pushes
            // min(PUSH_MAX, cellPrefix(gap)) cells for 0 < gap <= T_SYNC.
            for (const gap of [1, 5, 36, 200, T_SYNC, T_SYNC + 1]) {
                const w = await world({ common: 10, rOnly: gap });
                const session = w.session(w.init());
                w.hooks.toR = (m) => (m instanceof CellsReqV1 ? null : m);
                session.start();
                await w.until(() => headersSent(w).length === 1, "header");
                const pushed = headersSent(w)[0].cells.length / CELL_BYTES;
                expect(pushed, `gap ${gap}`).toBe(
                    gap <= T_SYNC ? Math.min(PUSH_MAX, cellPrefix(gap)) : 0
                );
                session.close();
            }
        });

        it("qualifies only a ready full replica of a qualifying source", () => {
            const provenance = (
                overrides: Partial<{
                    writeReady: boolean;
                    source: any;
                    fullReplica: boolean;
                    formatTag: string;
                }>
            ) =>
                new ProvenanceV1({
                    writeReady: true,
                    source: "reconciled",
                    fullReplica: true,
                    phase: "off",
                    openNonce: new Uint8Array(16),
                    ...overrides,
                });
            for (const source of [
                "creator",
                "reconciled",
                "warm",
                "operator",
            ]) {
                expect(qualifies(provenance({ source }))).toBe(true);
            }
            for (const source of ["none", "warm-fresh", "partial-override"]) {
                expect(qualifies(provenance({ source }))).toBe(false);
            }
            expect(qualifies(provenance({ writeReady: false }))).toBe(false);
            expect(qualifies(provenance({ fullReplica: false }))).toBe(false);
            expect(qualifies(provenance({ formatTag: "shared-fs/v9.1" }))).toBe(
                false
            );
        });
    });

    describe("basics", () => {
        it("count 0 is contained{empty} after one round trip", async () => {
            const w = await world({ common: 0, rOnly: 0, jOnly: 3 });
            const { final, sessions } = await w.drive();
            const result = only(final);
            expect(result.mode).toBe("empty");
            expect(result.count).toBe(0);
            expect(result.roundTrips).toBe(1);
            expect(result.qualified).toBe(true);
            expect(w.sent(OpenV1)).toHaveLength(1);
            expect(w.sent(CellsReqV1)).toHaveLength(0);
            expect(w.sent(CloseV1)).toHaveLength(1);
            expect(sessions[0].debug().armedTimers).toBe(0);
        });

        it("count 0 with a non-empty set hash is inconsistent", async () => {
            const w = await world({ common: 4 });
            w.hooks.toJ = (m) => {
                if (m instanceof HeaderV1) m.count = 0;
                return m;
            };
            const { final, outcomes } = await w.drive();
            expect(kinds(outcomes)).toEqual(["excluded:inconsistent"]);
            expect(final).toMatchObject({
                detail: "count 0 with a non-empty set hash",
                scope: SCOPE_NAMESPACE_V1,
            });
        });

        it("identical sets are contained{fast} with no cells request", async () => {
            const w = await world({ common: 50 });
            const { final, sessions } = await w.drive();
            const result = only(final);
            expect(result.mode).toBe("fast");
            expect(result.x).toBe(0);
            expect(result.missingAtStart).toBe(0);
            expect(result.certificates).toBe(1);
            expect(w.sent(CellsReqV1)).toHaveLength(0);
            expect(sessions[0].debug().armedTimers).toBe(0);
        });

        it("J missing 5 rows: pushed cells, one peel, 5 pulled, contained{peel}", async () => {
            const w = await world({ common: 40, rOnly: 5 });
            const { final } = await w.drive();
            const result = only(final);
            expect(result.mode).toBe("peel");
            expect(result.missingAtStart).toBe(5);
            expect(result.pulled).toBe(5);
            expect(result.cells).toBe(64);
            expect(result.roundTrips).toBe(1);
            expect(w.sent(CellsReqV1)).toHaveLength(0);
            expect(headersSent(w)[0].cells.length).toBe(64 * CELL_BYTES);
            expect(w.joins).toHaveLength(1);
            expect(w.joins[0].heads).toHaveLength(5);
            expect(w.joins[0].timeout).toBe(PULL_TIMEOUT_MS);
            expect(w.j.scope().index.size).toBe(45);
        });

        it("J holding rows R lacks: they go to X, nothing is pulled", async () => {
            const w = await world({ common: 30, jOnly: 4 });
            const { final } = await w.drive();
            const result = only(final);
            // J's rows above R's hlc leave the peel and go to X whole.
            expect(result.x).toBe(4);
            expect(result.pulled).toBe(0);
            expect(w.joins).toHaveLength(0);
        });

        it("both scopes in one session: one OPEN, two headers, two results", async () => {
            const w = await world({
                common: 10,
                rOnly: 2,
                scopes: [SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1],
            });
            const { final } = await w.drive();
            const results = contained(final);
            expect(results.map((r) => r.scope)).toEqual([
                SCOPE_NAMESPACE_V1,
                SCOPE_TRUST_V1,
            ]);
            expect(w.sent(OpenV1)).toHaveLength(1);
            expect(w.sent(OpenV1)[0].scopes.map((s) => s.scope)).toEqual([
                SCOPE_NAMESPACE_V1,
                SCOPE_TRUST_V1,
            ]);
            expect(results.every((r) => r.pulled === 2)).toBe(true);
        });

        it("an honest R that does not qualify is contained with qualified false", async () => {
            // A gated joiner, a donor of a source that does not qualify, a
            // partial replica: contained, never qualified (design 2.3(3)).
            for (const provenance of [
                { writeReady: false },
                { source: "none" as const },
                { source: "partial-override" as const },
                { fullReplica: false },
            ]) {
                const w = await world({ common: 10, rOnly: 2 });
                w.provenance = { ...w.provenance, ...provenance };
                const { final } = await w.drive();
                const name = JSON.stringify(provenance);
                expect(only(final).qualified, name).toBe(false);
                expect(only(final).provenance, name).toMatchObject(provenance);
            }
        });

        it("one unqualified header makes every result of the session unqualified", async () => {
            for (const unqualified of [SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1]) {
                const w = await world({
                    common: 10,
                    scopes: [SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1],
                });
                w.hooks.toJ = (m) => {
                    if (m instanceof HeaderV1 && m.scope === unqualified) {
                        m.provenance.writeReady = false;
                    }
                    return m;
                };
                const { final } = await w.drive();
                expect(
                    contained(final).map((r) => r.qualified),
                    `${unqualified}`
                ).toEqual([false, false]);
            }
            // The results a renewal keeps carry the session's flag too.
            const w = await world({
                common: 10,
                rOnly: 2,
                scopes: [SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1],
            });
            w.provenance = { ...w.provenance, writeReady: false };
            w.hooks.toJ = (m) => {
                if (m instanceof HeaderV1 && m.scope === SCOPE_TRUST_V1) {
                    m.anchor = bytesOf("forged");
                }
                return m;
            };
            const session = w.session(w.init());
            session.start();
            await w.until(() => session.outcome !== undefined, "outcome");
            const outcome = session.outcome as Extract<
                SessionOutcome,
                { kind: "renew" }
            >;
            expect(outcome.kind).toBe("renew");
            expect(outcome.results.map((r) => r.qualified)).toEqual([false]);
        });
    });

    describe("oracle", () => {
        it("rejects a contained result J does not back", async () => {
            const w = await world({ common: 10, rOnly: 3 });
            const { final } = await w.drive();
            const result = only(final);
            expect(w.contained).toEqual([result]);
            // R's snapshot held 13 rows; a certificate from before the pulls
            // (seq 0 is the seed) does not back it.
            expect(() => w.oracle({ ...result, seq: 10 })).toThrow(
                /neither indexed nor explained|no certificate/
            );
            expect(() =>
                w.oracle({ ...result, anchor: new Uint8Array(32) })
            ).toThrow(/no snapshot/);
        });
    });

    describe("attempts", () => {
        it("re-sends OPEN at 5 s and 10 s, is silent after 20 s, and a header at 40 s still counts", async () => {
            const w = await world({ common: 10 });
            // Attempt 1 reaches R only at 40 s; the others are lost.
            w.hooks.delayToR = (m) =>
                m instanceof OpenV1 && m.attempt === 1 ? 40_000 : 0;
            w.hooks.toR = (m) =>
                m instanceof OpenV1 && m.attempt > 1 ? null : m;
            const session = w.session(w.init());
            session.start();
            await settle();
            expect(w.sent(OpenV1).map((m) => m.attempt)).toEqual([1]);
            expect(session.debug().armedTimers).toBe(1);
            w.timers.advance(ATTEMPT_DELAYS_MS[0] - 1);
            await settle();
            expect(w.sent(OpenV1)).toHaveLength(1);
            w.timers.advance(1);
            await settle();
            expect(w.sent(OpenV1).map((m) => m.attempt)).toEqual([1, 2]);
            w.timers.advance(ATTEMPT_DELAYS_MS[1]);
            await settle();
            expect(w.sent(OpenV1).map((m) => m.attempt)).toEqual([1, 2, 3]);
            expect(session.state(SCOPE_NAMESPACE_V1)).toBe("asking");
            w.timers.advance(ATTEMPT_DELAYS_MS[2]);
            await settle();
            // 35 s: three attempts went unanswered.
            expect(session.state(SCOPE_NAMESPACE_V1)).toBe("silent");
            expect(session.debug().armedTimers).toBe(0);
            expect(w.sent(OpenV1)).toHaveLength(3);
            // 40 s: the first attempt's header arrives late, and counts.
            w.timers.advance(5_000);
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(only(session.outcome!).mode).toBe("fast");
            expect(session.debug().armedTimers).toBe(0);
        });

        it("resume() on a silent scope starts a new attempt series", async () => {
            const w = await world({ common: 10 });
            w.hooks.toR = (m) => (m instanceof OpenV1 ? null : m);
            const session = w.session(w.init());
            session.start();
            w.timers.advance(35_000);
            await settle();
            expect(session.state(SCOPE_NAMESPACE_V1)).toBe("silent");
            expect(session.debug().armedTimers).toBe(0);
            // A sign of life from R.
            w.hooks.toR = undefined;
            session.resume();
            expect(w.sent(OpenV1).map((m) => m.attempt)).toEqual([1, 2, 3, 4]);
            expect(session.state(SCOPE_NAMESPACE_V1)).toBe("asking");
            expect(session.debug().armedTimers).toBe(1);
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(only(session.outcome!).mode).toBe("fast");
            // resume() on a live, answered session changes nothing.
            session.resume();
            expect(w.sent(OpenV1)).toHaveLength(4);
        });

        describe("onAttempt (PR-3 commit 2, G2-3)", () => {
            /** A session reporting its attempts; the oracle checks its outcome. */
            const attempting = (
                w: JoinerWorld,
                onAttempt?: SessionEvents["onAttempt"]
            ) => {
                const attempts: Array<{ attempt: number; last: boolean }> = [];
                const outcomes: SessionOutcome[] = [];
                const session = new JoinerSession(
                    w.init(),
                    w.ports({
                        onOutcome: (done, outcome) => {
                            w.sessions.delete(done);
                            outcomes.push(outcome);
                            w.checkOutcome(outcome);
                        },
                        onAttempt: (session, info) => {
                            attempts.push(info);
                            onAttempt?.(session, info);
                        },
                    })
                );
                // Routed: R's answers reach it (`JoinerWorld.toJ`).
                w.sessions.add(session);
                return { session, attempts, outcomes };
            };

            it("reports each attempt that ended without a header: 1 and 2 before the next OPEN, 3 as the last, then silent", async () => {
                const w = await world({ common: 10 });
                w.hooks.toR = (m) => (m instanceof OpenV1 ? null : m);
                // Called before the next OPEN goes out, and before the
                // scopes go silent.
                const sentAtCall: number[] = [];
                const stateAtCall: unknown[] = [];
                const { session, attempts } = attempting(w, (s) => {
                    stateAtCall.push(s.state(SCOPE_NAMESPACE_V1));
                    sentAtCall.push(w.sent(OpenV1).length);
                });
                session.start();
                await settle();
                expect(attempts).toEqual([]);
                w.timers.advance(ATTEMPT_DELAYS_MS[0]);
                await settle();
                expect(attempts).toEqual([{ attempt: 1, last: false }]);
                w.timers.advance(ATTEMPT_DELAYS_MS[1]);
                await settle();
                w.timers.advance(ATTEMPT_DELAYS_MS[2]);
                await settle();
                expect(attempts).toEqual([
                    { attempt: 1, last: false },
                    { attempt: 2, last: false },
                    { attempt: 3, last: true },
                ]);
                expect(sentAtCall).toEqual([1, 2, 3]);
                expect(stateAtCall).toEqual(["asking", "asking", "asking"]);
                expect(session.state(SCOPE_NAMESPACE_V1)).toBe("silent");
                expect(session.debug().armedTimers).toBe(0);
                // A resumed series counts from 1 again.
                session.resume();
                w.timers.advance(ATTEMPT_DELAYS_MS[0]);
                await settle();
                expect(attempts.at(-1)).toEqual({ attempt: 1, last: false });
                session.close();
            });

            it("reports nothing once every scope holds a header", async () => {
                const w = await world({ common: 10 });
                const { session, attempts, outcomes } = attempting(w);
                session.start();
                await w.until(() => outcomes.length > 0, "outcome");
                expect(outcomes[0].kind).toBe("contained");
                w.timers.advance(60_000);
                await settle();
                expect(attempts).toEqual([]);
                // A header that arrives before the timer fires also ends
                // the attempts: attempt 1 is answered at 4 s.
                const late = await world({ common: 10 });
                late.hooks.delayToR = (m) => (m instanceof OpenV1 ? 4_000 : 0);
                const second = attempting(late);
                second.session.start();
                await settle();
                expect(late.sent(OpenV1)).toHaveLength(1);
                late.timers.advance(4_000);
                await late.until(() => second.outcomes.length > 0, "outcome");
                late.timers.advance(60_000);
                await settle();
                expect(second.attempts).toEqual([]);
            });

            it("an owner that closes the session in the call stops it: no further OPEN, no timer, no silent", async () => {
                for (const closeAt of [1, 3]) {
                    const w = await world({ common: 10 });
                    w.hooks.toR = (m) => (m instanceof OpenV1 ? null : m);
                    const states: string[] = [];
                    const { session, attempts, outcomes } = attempting(
                        w,
                        (s, info) => {
                            if (info.attempt === closeAt) s.close();
                        }
                    );
                    session.start();
                    for (const delay of ATTEMPT_DELAYS_MS) {
                        w.timers.advance(delay);
                        await settle();
                        states.push(String(session.state(SCOPE_NAMESPACE_V1)));
                    }
                    expect(attempts.map((a) => a.attempt)).toEqual(
                        Array.from({ length: closeAt }, (_, i) => i + 1)
                    );
                    expect(w.sent(OpenV1)).toHaveLength(closeAt);
                    expect(outcomes).toEqual([{ kind: "closed" }]);
                    expect(states).not.toContain("silent");
                    expect(session.debug().armedTimers).toBe(0);
                }
            });

            it("an owner that resumes the session in the call starts one new series, not two OPENs", async () => {
                const w = await world({ common: 10 });
                w.hooks.toR = (m) => (m instanceof OpenV1 ? null : m);
                let resumed = 0;
                const { session, attempts } = attempting(w, (s, info) => {
                    if (info.last && resumed++ === 0) s.resume();
                });
                session.start();
                w.timers.advance(35_000);
                await settle();
                expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
                expect(w.sent(OpenV1).map((m) => m.attempt)).toEqual([
                    1, 2, 3, 4,
                ]);
                expect(session.state(SCOPE_NAMESPACE_V1)).toBe("asking");
                expect(session.debug().armedTimers).toBe(1);
                // A listener that throws changes nothing.
                const v = await world({ common: 10 });
                v.hooks.toR = (m) => (m instanceof OpenV1 ? null : m);
                const throwing = attempting(v, () => {
                    throw new Error("listener bug");
                });
                throwing.session.start();
                v.timers.advance(35_000);
                await settle();
                expect(v.sent(OpenV1)).toHaveLength(3);
                expect(throwing.session.state(SCOPE_NAMESPACE_V1)).toBe(
                    "silent"
                );
                session.close();
            });
        });

        it("a lost cells answer is asked again, then the scope is silent until resume()", async () => {
            const w = await world({ common: 10, rOnly: 300 });
            let drop = true;
            w.hooks.toJ = (m) => (drop && m instanceof CellsV1 ? null : m);
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => w.sent(CellsReqV1).length === 1,
                "cells request"
            );
            expect(session.state(SCOPE_NAMESPACE_V1)).toBe("peeling");
            expect(session.debug().armedTimers).toBe(1);
            w.timers.advance(5_000);
            await settle();
            // The re-sent request counts against R's M-cell cap: 2 x 544.
            expect(w.sent(CellsReqV1)).toHaveLength(2);
            w.timers.advance(10_000);
            await settle();
            expect(w.sent(CellsReqV1)).toHaveLength(3);
            w.timers.advance(20_000);
            await settle();
            expect(session.state(SCOPE_NAMESPACE_V1)).toBe("silent");
            expect(session.debug().armedTimers).toBe(0);
            drop = false;
            session.resume();
            expect(w.sent(CellsReqV1)).toHaveLength(4);
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(only(session.outcome!).pulled).toBe(300);
        });
    });

    describe("errors", () => {
        it("BUSY before any header: busy, and no CloseV1 (R holds nothing)", async () => {
            const w = await world({ common: 5 });
            // J's key already holds R's 4 sessions per peer.
            for (let i = 0; i < 4; i++) {
                w.responder.onMessage(
                    new OpenV1({
                        sessionId: randomBytes(16),
                        attempt: 1,
                        hlcProved: 0n,
                        scopes: [
                            new OpenScopeV1({
                                scope: SCOPE_NAMESPACE_V1,
                                logId: w.r.scope().logId,
                                count: 0,
                                above: 0,
                            }),
                        ],
                    }),
                    w.j.key
                );
            }
            await settle();
            const { final, sessions } = await w.drive();
            expect(final).toEqual({ kind: "busy" });
            expect(w.sent(CloseV1)).toHaveLength(0);
            expect(sessions[0].debug().armedTimers).toBe(0);
            expect(sessions[0].state(SCOPE_NAMESPACE_V1)).toBe("ended");
        });

        it("EXPIRED: renew{expired} and no CloseV1", async () => {
            // Gap 1,200: J asks for 2,176 cells; the answer is lost, and the
            // second attempt passes R's M-cell cap.
            const w = await world({ common: 10, rOnly: 1200 });
            w.hooks.toJ = (m) => (m instanceof CellsV1 ? null : m);
            const session = w.session(w.init());
            session.start();
            await w.until(() => w.sent(CellsReqV1).length === 1, "request");
            expect(w.sent(CellsReqV1)[0]).toMatchObject({ from: 0, to: 2176 });
            w.timers.advance(5_000);
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(session.outcome).toMatchObject({
                kind: "renew",
                reason: "expired",
                list: false,
                scopes: [SCOPE_NAMESPACE_V1],
            });
            expect(w.sent(CloseV1)).toHaveLength(0);
            expect(session.debug().armedTimers).toBe(0);
        });

        it("a session silent on a freeze that outlived R's idle renews on R's EXPIRED", async () => {
            // R is alive but busy: its freeze waits on a replace verify for
            // longer than its 30 s idle after J's last OPEN (a large write
            // under load). R sends J nothing else, so this answer is what
            // re-asks R.
            const w = await world({ common: 5 });
            const tap = w.r.scope().tap;
            let verifying = true;
            let release!: () => void;
            const verified = new Promise<void>(
                (resolve) => (release = resolve)
            );
            Object.defineProperty(tap, "pendingVerify", {
                configurable: true,
                get: () => (verifying ? 1 : 0),
            });
            tap.verifyIdle = () => verified;
            const session = w.session(w.init());
            session.start();
            await w.until(() => w.sent(OpenV1).length === 1, "open");
            await w.timers.advanceSettled(
                ATTEMPT_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)
            );
            expect(w.sent(OpenV1)).toHaveLength(ATTEMPT_DELAYS_MS.length);
            expect(session.state(SCOPE_NAMESPACE_V1)).toBe("silent");
            expect(session.debug().armedTimers).toBe(0);
            await w.timers.advanceSettled(SESSION_IDLE_MS);
            expect(w.responder.debug().sessions).toBe(0);
            expect(session.outcome).toBeUndefined();

            verifying = false;
            release();
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(session.outcome).toMatchObject({
                kind: "renew",
                reason: "expired",
            });
            expect(w.sentToJ.filter((m) => m instanceof HeaderV1)).toEqual([]);
            expect(w.sent(CloseV1)).toHaveLength(0);
            expect(session.debug().armedTimers).toBe(0);
        });

        it("UNSUPPORTED and SCOPE are refusals, never exclusions", async () => {
            const w = await world({ common: 5 });
            w.hooks.toR = (m) => {
                if (m instanceof OpenV1) m.version = 2;
                return m;
            };
            const first = await w.drive();
            expect(first.final).toEqual({
                kind: "refused",
                code: "UNSUPPORTED",
            });
            expect(w.sent(CloseV1)).toHaveLength(0);

            w.hooks.toR = undefined;
            const session = w.session(w.init(), {
                ports: {
                    scope: (id) => {
                        const ports = w.scopePorts(id);
                        return ports && { ...ports, logId: new Uint8Array(32) };
                    },
                },
            });
            session.start();
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(session.outcome).toEqual({ kind: "refused", code: "SCOPE" });
            expect(session.debug().armedTimers).toBe(0);
        });

        it("an ErrorV1 of another session is ignored", async () => {
            const w = await world({ common: 5 });
            w.hooks.toR = (m) => (m instanceof OpenV1 ? null : m);
            const session = w.session(w.init());
            session.start();
            const error = new ErrorV1({
                sessionId: randomBytes(16),
                code: ERROR_CODE.EXPIRED,
            });
            session.onMessage(
                error,
                w.r.hash,
                encodeReadinessMessage(error).length
            );
            expect(session.outcome).toBeUndefined();
            expect(session.debug().dropped).toBe(1);
            session.close();
            expect(session.outcome).toEqual({ kind: "closed" });
            // An OPEN went out, so R may hold the session.
            expect(w.sent(CloseV1)).toHaveLength(1);
        });
    });

    describe("S10 and trust (deviation k, G12)", () => {
        it("posts no certificate while a replace verify is pending", async () => {
            const w = await JoinerWorld.create();
            w.rows([w.r, w.j], 10);
            const x2 = w.row("x", 2000n);
            w.r.scope().receive(x2);
            w.j.scope().receive(x2);
            await w.start();
            const j = w.j.scope();
            // An older entry's event after the newer one the index kept:
            // the tap replaces, then verifies (the read is held open).
            let open!: () => void;
            j.readHeadGate = new Promise((resolve) => (open = resolve));
            j.dispatchOnly(w.row("x", 1000n));
            expect(j.tap.pendingVerify).toBe(1);
            const calls = j.digestNowCalls;
            const session = w.session(w.init());
            session.start();
            await settle(100);
            expect(session.state(SCOPE_NAMESPACE_V1)).toBe("certifying");
            expect(j.digestNowCalls).toBe(calls);
            expect(session.debug().armedTimers).toBe(0);
            j.readHeadGate = undefined;
            open();
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(only(session.outcome!).mode).toBe("fast");
            w.assertClean();
        });

        it("waits for the count check before a certificate", async () => {
            const w = await JoinerWorld.create();
            w.rows([w.r, w.j], 10);
            await w.r.scope().start();
            const j = w.j.scope();
            await j.tap.seedFromScan();
            let open!: () => void;
            j.countGate = new Promise((resolve) => (open = resolve));
            void j.tap.checkCount();
            expect(j.tap.countVerified).toBe(false);
            const session = w.session(w.init());
            session.start();
            await settle(100);
            expect(session.state(SCOPE_NAMESPACE_V1)).toBe("certifying");
            expect(j.digestNowCalls).toBe(0);
            expect(session.debug().armedTimers).toBe(0);
            j.countGate = undefined;
            open();
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(j.tap.countVerified).toBe(true);
            expect(only(session.outcome!).mode).toBe("fast");
            w.assertClean();
        });

        it("an untrusted count waits for J's next change, never a timer", async () => {
            const w = await world({ common: 10 });
            let trusted = false;
            let confirms = 0;
            const session = w.session(w.init(), {
                ports: {
                    scope: (id) => {
                        const ports = w.scopePorts(id)!;
                        const local: LocalScope = Object.create(ports.local);
                        Object.defineProperty(local, "trusted", {
                            get: () => trusted && ports.local.trusted,
                        });
                        local.confirmTrusted = async () => {
                            confirms++;
                            return trusted;
                        };
                        return { ...ports, local };
                    },
                },
            });
            session.start();
            await settle(100);
            expect(session.state(SCOPE_NAMESPACE_V1)).toBe("certifying");
            expect(confirms).toBe(1);
            expect(session.debug().armedTimers).toBe(0);
            // Trusted now, but nothing tells the session: it waits.
            trusted = true;
            await settle(100);
            expect(confirms).toBe(1);
            expect(session.outcome).toBeUndefined();
            // J's next element change (a row R cannot hold) retries.
            w.j.scope().receive(w.row("late", 99_999n));
            await w.until(() => session.outcome !== undefined, "outcome");
            const result = only(session.outcome!);
            expect(result.mode).toBe("fast");
            expect(result.x).toBe(1);
            w.assertClean();
        });

        it("a re-seed of J's tap mid-session rebuilds the peel once J is trusted (R1)", async () => {
            const w = await JoinerWorld.create();
            w.rows([w.r, w.j], 30);
            const missing = w.rows([w.r], 4, {
                prefix: "r",
                modified: (i) => BigInt(5000 + i),
            });
            // J's own rows: two below R's hlc (the peel's X) and two above
            // it (k).
            w.rows([w.j], 2, {
                prefix: "jb",
                modified: (i) => BigInt(100 + i),
            });
            w.rows([w.j], 2, {
                prefix: "ja",
                modified: (i) => BigInt(9000 + i),
            });
            await w.start();
            const j = w.j.scope();
            // Hold the pulls, so the re-seed lands while hashes are pending.
            let open!: () => void;
            const gate = new Promise<void>((resolve) => (open = resolve));
            const pulls = w.pulls.get(SCOPE_NAMESPACE_V1)!;
            const pull = pulls.pull.bind(pulls);
            pulls.pull = async (owner, heads) => {
                await gate;
                return pull(owner, heads);
            };
            const states: string[] = [];
            let atReset: { k: number; xPeel: number } | undefined;
            const session = w.session(w.init(), {
                events: {
                    onState: (done, _, state) => {
                        states.push(state);
                        if (state === "certifying" && !atReset) {
                            atReset = done.debug().scopes[0];
                        }
                    },
                },
            });
            session.start();
            await w.until(
                () => session.debug().scopes[0]!.pending === 4,
                "pending"
            );
            expect(session.state(SCOPE_NAMESPACE_V1)).toBe("draining");
            expect(session.debug().scopes[0]).toMatchObject({ k: 2, xPeel: 2 });
            const mark = states.length;
            // J's index holds one of R's rows its tap never saw (no event):
            // the count check scans again, and the tap re-seeds.
            j.index.set("r0", {
                head: missing[0].head,
                modified: missing[0].modified,
            });
            const check = j.tap.checkCount();
            await w.until(
                () => session.debug().scopes[0]!.pending === 3,
                "re-peeled"
            );
            await check;
            expect(j.tap.stats.rescans).toBe(1);
            expect(j.tap.countVerified).toBe(true);
            // R1: certifying (waits for trust), then the re-peel.
            expect(states.slice(mark)).toEqual([
                "certifying",
                "peeling",
                "draining",
            ]);
            expect(session.debug().scopes[0]!.repeels).toBe(0);
            // The re-seed dropped the peel's X and k; the rebuilt rows
            // counted k again.
            expect(atReset).toMatchObject({ k: 0, xPeel: 0 });
            expect(session.debug().scopes[0]).toMatchObject({ k: 2, xPeel: 2 });
            open();
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(only(session.outcome!).x).toBe(4);
            expect(j.index.size).toBe(38);
            w.assertClean();
        });

        it("a count read that a change raced, then a quiet store: compared again at once, no stride to wait for", async () => {
            const w = await JoinerWorld.create();
            w.rows([w.r, w.j], 10);
            await w.r.scope().start();
            const j = w.j.scope();
            await j.tap.seedFromScan();
            // While `racing` > 0, each count read lands a row of J's (above
            // R's hlc) during the read: the comparison is inconclusive.
            let racing = 0;
            let late = 0;
            const count = j.indexPort.count.bind(j.indexPort);
            j.indexPort.count = async () => {
                const n = await count();
                if (racing > 0) {
                    racing--;
                    j.receive(w.row(`late${late++}`, 90_000n + BigInt(late)));
                }
                return n;
            };
            // J opens under sync: the start's reads and the next one race,
            // and the tap's stride grows.
            racing = 4;
            await j.tap.checkCount();
            await j.tap.countSettled();
            expect(j.tap.countVerified).toBe(false);
            // The session's own comparison races once; then nothing changes.
            racing = 1;
            const session = w.session(w.init());
            session.start();
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(j.tap.countVerified).toBe(true);
            const result = only(session.outcome!);
            expect(result.mode).toBe("fast");
            expect(result.x).toBe(late);
            w.assertClean();
        });
    });

    describe("R answers only from a verified count (deviation k)", () => {
        it("a row R's seed scan missed is scanned again before R freezes, even when R's rescan was raced and R is quiet", async () => {
            const w = await JoinerWorld.create();
            w.rows([w.r, w.j], 5);
            await w.start();
            const r = w.r.scope();
            // A row R's index holds that its scans miss (an OFFSET page a
            // delete shifted, tap.ts): no event ever names it.
            const missed = w.row("missed", 3000n);
            r.log.add(missed.head);
            r.index.set(missed.id!, {
                head: missed.head,
                modified: missed.modified,
            });
            // R's count check scans again, a row of sync arrives during
            // that scan, and it misses the row again.
            const raced = w.row("raced", 2500n);
            const scan = r.indexPort.scan;
            r.indexPort.scan = async function* () {
                let first = true;
                for await (const page of scan()) {
                    if (first) {
                        first = false;
                        r.receive(raced);
                    }
                    yield page.filter((row) => row.key !== "missed");
                }
            };
            w.j.scope().receive(raced);
            await r.tap.checkCount();
            r.indexPort.scan = scan;
            expect(r.tap.countVerified).toBe(false);
            expect(r.tap.stats).toMatchObject({
                rescans: 1,
                exposedRescans: 1,
            });
            // R is quiet from here on: R's freeze compares, reads the same
            // difference twice, and scans again.
            const { final } = await w.drive();
            const result = only(final);
            expect(result.count).toBe(r.index.size);
            expect(result.pulled).toBe(1);
            expect(r.tap.countVerified).toBe(true);
            expect(r.tap.stats.rescans).toBe(2);
            expect(w.j.scope().index.get("missed")?.head).toBe(missed.head);
        });

        it("R holds its answer while its count check is still reading", async () => {
            const w = await JoinerWorld.create();
            w.rows([w.r, w.j], 5);
            await w.start();
            const r = w.r.scope();
            const missed = w.row("missed", 3000n);
            r.log.add(missed.head);
            r.index.set(missed.id!, {
                head: missed.head,
                modified: missed.modified,
            });
            let release!: () => void;
            r.countGate = new Promise<void>((resolve) => (release = resolve));
            const check = r.tap.checkCount();
            await settle();
            expect(r.tap.countVerified).toBe(false);
            const session = w.session(w.init());
            session.start();
            await settle(100);
            // No header from an unverified count.
            expect(w.sentToJ).toHaveLength(0);
            expect(session.outcome).toBeUndefined();
            r.countGate = undefined;
            release();
            await check;
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(only(session.outcome!).pulled).toBe(1);
            expect(w.j.scope().index.get("missed")?.head).toBe(missed.head);
            w.assertClean();
        });
    });

    describe("one session, one freeze (design 2.2(4))", () => {
        const anchorOf = async (scope: FakeScope) =>
            hex(
                await scope.laneSet.digestOf(
                    packDigests(
                        [...scope.index.values()].map(({ head }) =>
                            headDigest(head)
                        )
                    )
                )
            );

        it("a scope's first header from a later freeze than another scope's renews: trust is never older than namespace", async () => {
            const w = await world({
                common: 5,
                scopes: [SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1],
            });
            let phase = 1;
            // Freeze A: the namespace header is lost, trust arrives, and
            // OPEN attempts 2 and 3 are lost on the way to R.
            w.hooks.toJ = (m) =>
                m instanceof HeaderV1 &&
                m.scope === SCOPE_NAMESPACE_V1 &&
                phase === 1
                    ? null
                    : m;
            w.hooks.toR = (m) =>
                m instanceof OpenV1 && m.attempt > 1 && phase === 1 ? null : m;
            // Freeze B: the trust header takes a slow route.
            w.hooks.delayToJ = (m) =>
                m instanceof HeaderV1 &&
                m.scope === SCOPE_TRUST_V1 &&
                phase === 2
                    ? 1000
                    : 0;
            const session = w.session(w.init());
            session.start();
            await settle();
            expect(session.state(SCOPE_TRUST_V1)).toBe("contained");
            expect(session.state(SCOPE_NAMESPACE_V1)).toBe("asking");
            // R ends the idle session at 30 s; J's attempts end at 35 s.
            w.timers.advance(40_000);
            await settle();
            expect(session.state(SCOPE_NAMESPACE_V1)).toBe("silent");
            // A trust change on R after freeze A.
            w.rows([w.r], 1, { scope: SCOPE_TRUST_V1, prefix: "grant-" });
            // R's sign of life: J re-sends OPEN and R freezes again (B).
            phase = 2;
            session.resume();
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(session.outcome).toMatchObject({
                kind: "renew",
                reason: "restarted",
                scopes: [SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1],
                results: [],
            });
            // The next session holds both scopes to one freeze.
            w.hooks.delayToJ = undefined;
            const next = w.session(
                nextSessionInit(session.init, session.outcome!)!
            );
            next.start();
            await w.until(() => next.outcome !== undefined, "outcome");
            const [, trust] = contained(next.outcome!);
            expect(hex(trust.anchor)).toBe(
                await anchorOf(w.r.scope(SCOPE_TRUST_V1))
            );
            expect(w.j.scope(SCOPE_TRUST_V1).index.has("grant-0")).toBe(true);
            w.assertClean();
        });
    });

    describe("T14: J's own state", () => {
        it("a tap that faults while the scope drains ends the session as local-unavailable", async () => {
            const w = await world({ common: 20, rOnly: 3 });
            const j = w.j.scope();
            let open!: () => void;
            const gate = new Promise<void>((resolve) => (open = resolve));
            const pulls = w.pulls.get(SCOPE_NAMESPACE_V1)!;
            const pull = pulls.pull.bind(pulls);
            pulls.pull = async (owner, heads) => {
                await gate;
                return pull(owner, heads);
            };
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => session.debug().scopes[0]!.pending === 3,
                "pending"
            );
            j.tap.faulted = new Error("verify read failed");
            open();
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(session.outcome).toEqual({
                kind: "local-unavailable",
                scope: SCOPE_NAMESPACE_V1,
                detail: "verify read failed",
            });
            // R may hold the session.
            expect(w.sent(CloseV1)).toHaveLength(1);
            expect(w.contained).toEqual([]);
        });

        it("a scope J has not opened is local-unavailable at start, before any OPEN", async () => {
            const w = await world({ common: 5 });
            const session = w.session(w.init(), {
                ports: { scope: () => undefined },
            });
            session.start();
            expect(session.outcome).toEqual({
                kind: "local-unavailable",
                scope: SCOPE_NAMESPACE_V1,
                detail: "scope not open",
            });
            expect(w.sentToR).toHaveLength(0);
        });
    });

    describe("22: lies against R's own header", () => {
        const listWorld = async (common: number, rOnly: number) => {
            const w = await world({ common, rOnly });
            return { w, init: w.init({ list: true }) };
        };

        it("a list shorter than the header's count, marked done", async () => {
            const { w, init } = await listWorld(25, 5);
            w.hooks.toJ = (m) => {
                if (m instanceof ListV1) {
                    m.hashes = m.hashes.slice(0, 20 * DIGEST_BYTES);
                }
                return m;
            };
            const { final, outcomes } = await w.drive({ init });
            expect(kinds(outcomes)).toEqual(["excluded:inconsistent"]);
            expect(final).toMatchObject({
                detail: "the list holds 20 hashes, the header 30",
            });
            expect(w.sent(OpenV1)[0].flags & OPEN_FLAG_LIST).toBe(1);
        });

        it("done forged on page 1 of 3", async () => {
            const { w, init } = await listWorld(4190, 10);
            w.hooks.toJ = (m) => {
                if (m instanceof ListV1 && m.offset === 0) m.done = true;
                return m;
            };
            const { final } = await w.drive({ init });
            expect(final).toMatchObject({
                kind: "excluded",
                reason: "inconsistent",
                detail: `the list holds ${LIST_PAGE_HASHES} hashes, the header 4200`,
            });
            expect(w.sent(ListPageV1)).toHaveLength(1);
        });

        it("a rewritten header anchor is never contained: re-peel, a fresh session, then the list contradicts it", async () => {
            const w = await world({ common: 25, rOnly: 5 });
            w.hooks.toJ = (m) => {
                if (m instanceof HeaderV1) m.anchor = bytesOf("forged anchor");
                return m;
            };
            const { final, outcomes, sessions, inits } = await w.drive();
            expect(kinds(outcomes)).toEqual([
                "renew:mismatch",
                "excluded:inconsistent",
            ]);
            expect(inits.map((init) => init.ladder.stage)).toEqual([
                "first",
                "fresh",
            ]);
            expect(sessions[0].debug().scopes[0]!.repeels).toBe(1);
            expect(final).toMatchObject({
                detail: "the list's set hash differs from the header's",
            });
            expect(w.contained).toEqual([]);
        });

        it("more hashes than the count, a duplicate hash, an empty page before the last", async () => {
            const cases: Array<[string, (m: ListV1) => void, RegExp]> = [
                [
                    "extra",
                    (m) => {
                        const out = new Uint8Array(m.hashes.length + 32);
                        out.set(m.hashes);
                        out.set(bytesOf("extra"), m.hashes.length);
                        m.hashes = out;
                    },
                    /more than the header's 30/,
                ],
                [
                    "duplicate",
                    (m) => m.hashes.copyWithin(32, 0, 32),
                    /set hash differs|duplicate/,
                ],
                [
                    "empty",
                    (m) => {
                        m.hashes = new Uint8Array(0);
                        m.done = false;
                    },
                    /an empty page before the last/,
                ],
            ];
            for (const [name, tamper, detail] of cases) {
                const { w, init } = await listWorld(25, 5);
                w.hooks.toJ = (m) => {
                    if (m instanceof ListV1) tamper(m);
                    return m;
                };
                const { final } = await w.drive({ init });
                expect(final.kind, name).toBe("excluded");
                expect((final as any).reason, name).toBe("inconsistent");
                expect((final as any).detail, name).toMatch(detail);
            }
        });

        it("an answer over 256 KiB", async () => {
            const w = await world({ common: 5, rOnly: 1 });
            let header: HeaderV1 | undefined;
            w.hooks.toJ = (m) => {
                if (m instanceof HeaderV1) {
                    header = m;
                    return null;
                }
                return m;
            };
            const session = w.session(w.init());
            session.start();
            await w.until(() => header !== undefined, "header");
            session.onMessage(header!, w.r.hash, MAX_ANSWER_BYTES + 1);
            expect(session.outcome).toMatchObject({
                kind: "excluded",
                reason: "inconsistent",
                scope: SCOPE_NAMESPACE_V1,
                detail: `oversize answer (${MAX_ANSWER_BYTES + 1} bytes)`,
            });
            // Exactly the cap is an honest size.
            const second = w.session(w.init());
            second.start();
            await settle();
            const copy = copyMessage(header!);
            copy.sessionId = second.sessionId;
            second.onMessage(copy, w.r.hash, MAX_ANSWER_BYTES);
            expect(second.outcome?.kind).not.toBe("excluded");
            second.close();
        });

        it("a contradiction after J re-sent OPEN is not proof: it renews in list mode", async () => {
            const w = await world({
                common: 25,
                rOnly: 5,
                scopes: [SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1],
            });
            let trustHeaders = 0;
            w.hooks.toJ = (m) => {
                if (
                    m instanceof HeaderV1 &&
                    m.scope === SCOPE_TRUST_V1 &&
                    trustHeaders++ === 0
                ) {
                    return null;
                }
                if (m instanceof ListV1) {
                    m.hashes = m.hashes.slice(0, 10 * DIGEST_BYTES);
                }
                return m;
            };
            // The namespace page reaches J after attempt 2 of the OPEN.
            w.hooks.delayToJ = (m) => (m instanceof ListV1 ? 6_000 : 0);
            const session = w.session(w.init({ list: true }));
            session.start();
            await settle(100);
            w.timers.advance(5_000);
            await settle(100);
            expect(w.sent(OpenV1)).toHaveLength(2);
            w.timers.advance(1_000);
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(session.outcome).toMatchObject({
                kind: "renew",
                reason: "restarted",
                list: true,
            });
        });
    });

    describe("25: a hash R named that is not a row of the scope", () => {
        it("a FileChunk named by R's cells is unsubstantiated once fetched", async () => {
            const w = await world({ common: 10 });
            const chunk = w.other("chunk");
            w.plantInR(chunk, "planted");
            const { final } = await w.drive();
            expect(final).toMatchObject({
                kind: "excluded",
                reason: "unsubstantiated",
            });
            expect((final as any).detail).toContain(chunk.head);
            expect(w.joins.flatMap((join) => join.heads)).toEqual([chunk.head]);
        });

        it("the same hash through the list", async () => {
            const w = await world({ common: 10 });
            const chunk = w.other("chunk");
            w.plantInR(chunk, "planted");
            const { final } = await w.drive({ init: w.init({ list: true }) });
            expect(final).toMatchObject({
                kind: "excluded",
                reason: "unsubstantiated",
            });
            expect(w.sent(ListPageV1)).toHaveLength(1);
        });

        it("a not-row entry already in J's log is a lie before any pull", async () => {
            const w = await world({ common: 10 });
            const chunk = w.other("chunk");
            w.plantInR(chunk, "planted");
            w.j.scope().receive(chunk);
            const { final } = await w.drive();
            expect(final).toMatchObject({ reason: "unsubstantiated" });
            expect(w.joins).toHaveLength(0);
        });

        it("an entry J cannot decode never excludes: it stays pending, nothing armed", async () => {
            const w = await world({ common: 10 });
            const garbled = w.other("garbled");
            w.plantInR(garbled, "garbled");
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => session.debug().scopes[0]!.logged === 1,
                "logged"
            );
            await settle(50);
            expect(session.outcome).toBeUndefined();
            expect(session.state(SCOPE_NAMESPACE_V1)).toBe("draining");
            expect(session.debug().armedTimers).toBe(0);
            expect(w.joins.flatMap((join) => join.heads)).toEqual([
                garbled.head,
            ]);
            session.close();
            expect(w.contained).toEqual([]);
        });
    });

    describe("28: false hints are never contained", () => {
        it("a false decode (a phantom J\\R element): re-peel, renew{mismatch}, then a fresh session", async () => {
            const w = await world({ common: 25, rOnly: 5 });
            w.hooks.toJ = JoinerWorld.cellsHook(
                await w.faultyCells({ plant: bytesOf("phantom"), sign: -1 })
            );
            const { outcomes, sessions, inits } = await w.drive();
            expect(kinds(outcomes)).toEqual([
                "renew:mismatch",
                "contained:fast",
            ]);
            expect(sessions[0].debug().scopes[0]!).toMatchObject({
                repeels: 1,
                mismatches: 2,
            });
            expect(inits.map((init) => init.ladder.stage)).toEqual([
                "first",
                "fresh",
            ]);
            expect(w.contained).toHaveLength(1);
        });

        it("a lying cell (one of R's rows hidden): re-peel, renew{mismatch}, then the list", async () => {
            const w = await JoinerWorld.create();
            w.rows([w.r, w.j], 25);
            const hidden = w.rows([w.r], 5, {
                prefix: "r",
                modified: (i) => BigInt(5000 + i),
            });
            await w.start();
            w.hooks.toJ = JoinerWorld.cellsHook(
                await w.faultyCells({ hide: hidden[0] })
            );
            const { outcomes, sessions, inits } = await w.drive();
            expect(kinds(outcomes)).toEqual([
                "renew:mismatch",
                "contained:list",
            ]);
            expect(sessions[0].debug().scopes[0]!.repeels).toBe(1);
            expect(inits.map((init) => init.ladder.stage)).toEqual([
                "first",
                "fresh",
            ]);
            // The hidden row came from the list.
            expect(w.j.scope().index.get("r0")?.head).toBe(hidden[0].head);
        });

        it("a forced collision (R's cells equal J's): renew{mismatch}, then the list", async () => {
            const w = await world({ common: 25, rOnly: 5 });
            w.hooks.toJ = JoinerWorld.cellsHook(
                await w.faultyCells({ as: w.j.scope() })
            );
            const { outcomes, sessions } = await w.drive();
            expect(kinds(outcomes)).toEqual([
                "renew:mismatch",
                "contained:list",
            ]);
            // J's state never moved, so no re-peel.
            expect(sessions[0].debug().scopes[0]!.repeels).toBe(0);
            expect(sessions[1].debug().scopes[0]!.mismatches).toBe(1);
            expect(w.contained).toHaveLength(1);
        });
    });

    describe("29: equal counts, interleaved symmetric difference of 2,000", () => {
        const interleaved = async () => {
            const w = await JoinerWorld.create();
            w.rows([w.r, w.j], 200, { modified: (i) => BigInt(1000 + i) });
            w.rows([w.r], 1000, {
                prefix: "r",
                modified: (i) => BigInt(300_000 + 2 * i),
            });
            w.rows([w.j], 1000, {
                prefix: "j",
                modified: (i) => BigInt(300_000 + 2 * i + 1),
            });
            await w.start();
            return w;
        };

        it("hlcProved = 0: the prefix grows 4x up to 4,096 cells", async () => {
            const w = await interleaved();
            const { final } = await w.drive();
            const result = only(final);
            const requests = w
                .sent(CellsReqV1)
                .map(({ from, to }) => [from, to]);
            expect(requests).toEqual([
                [0, 64],
                [64, 256],
                [256, 1024],
                [1024, 4096],
            ]);
            expect(result.cells).toBe(M);
            expect(result.pulled).toBe(1000);
            // 999 of J's rows from the peel, its newest above R's hlc.
            expect(result.x).toBe(1000);
            expect(result.mode).toBe("peel");
        });

        it("hlcProved below every differing row: one request for 3,616 cells", async () => {
            const w = await interleaved();
            const { final } = await w.drive({ hlcProved: 250_000n });
            const result = only(final);
            expect(w.sent(OpenV1)[0].scopes[0].above).toBe(1000);
            expect(headersSent(w)[0].above).toBe(1000);
            expect(
                w.sent(CellsReqV1).map(({ from, to }) => [from, to])
            ).toEqual([[0, 3616]]);
            expect(result.cells).toBe(3616);
            expect(result.pulled).toBe(1000);
        });
    });

    describe("30: large gaps wait for sync", () => {
        it("asks for no cells while the gap is above 256, then peels", async () => {
            const w = await JoinerWorld.create();
            const old = w.rows([w.r], 5000);
            await w.start();
            w.syncDelivering.add(SCOPE_NAMESPACE_V1);
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => session.state(SCOPE_NAMESPACE_V1) === "waiting-sync",
                "waiting-sync"
            );
            const j = w.j.scope();
            let delivered = 0;
            while (w.sent(CellsReqV1).length === 0) {
                for (let i = 0; i < 125; i++) j.receive(old[delivered++]);
                await settle(5);
                if (5000 - delivered > T_SYNC) {
                    expect(w.sent(CellsReqV1), `${delivered}`).toHaveLength(0);
                }
            }
            expect(5000 - delivered).toBeLessThanOrEqual(T_SYNC);
            expect(w.sent(CellsReqV1)[0]).toMatchObject({
                from: 0,
                to: cellPrefix(5000 - delivered),
            });
            await w.until(() => session.outcome !== undefined, "outcome");
            const result = only(session.outcome!);
            expect(result.mode).toBe("sync-wait");
            expect(result.pulled).toBe(5000 - delivered);
            w.assertClean();
        });

        it("a stalled sync: one window without an arrival, then the list", async () => {
            const w = await JoinerWorld.create();
            w.rows([w.r], 5000);
            await w.start();
            w.syncDelivering.add(SCOPE_NAMESPACE_V1);
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => session.state(SCOPE_NAMESPACE_V1) === "waiting-sync",
                "waiting-sync"
            );
            expect(session.debug().armedTimers).toBe(1);
            w.timers.advance(SYNC_WINDOW_MS);
            await w.until(() => session.outcome !== undefined, "outcome");
            const result = only(session.outcome!);
            expect(result.mode).toBe("list");
            expect(result.pulled).toBe(5000);
            expect(w.sent(CellsReqV1)).toHaveLength(0);
            expect(w.sent(ListPageV1)).toHaveLength(3);
            w.assertClean();
        });

        it("a stalled sync with a gap within FETCH_MAX peels at once", async () => {
            const w = await JoinerWorld.create();
            w.rows([w.r], 1000);
            await w.start();
            w.syncDelivering.add(SCOPE_NAMESPACE_V1);
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => session.state(SCOPE_NAMESPACE_V1) === "waiting-sync",
                "waiting-sync"
            );
            // Arrivals in the window re-arm it.
            w.j.scope().receive(w.row("n-early", 1500n));
            await settle();
            w.timers.advance(SYNC_WINDOW_MS);
            await settle();
            expect(session.state(SCOPE_NAMESPACE_V1)).toBe("waiting-sync");
            w.timers.advance(SYNC_WINDOW_MS);
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(w.sent(CellsReqV1)[0]).toMatchObject({
                from: 0,
                to: cellPrefix(1000),
            });
            expect(only(session.outcome!).mode).toBe("sync-wait");
            expect(1000).toBeLessThanOrEqual(FETCH_MAX);
            w.assertClean();
        });

        it("J's rows above R's hlc are not part of the gap: 300 of them do not make J wait (deviation m)", async () => {
            const w = await JoinerWorld.create();
            w.rows([w.r, w.j], 40);
            w.rows([w.r], 10, {
                prefix: "r",
                modified: (i) => BigInt(5000 + i),
            });
            // A writer's rows that reached J after R froze.
            w.rows([w.j], 300, {
                prefix: "w",
                modified: (i) => BigInt(9000 + i),
            });
            await w.start();
            w.syncDelivering.add(SCOPE_NAMESPACE_V1);
            const states: string[] = [];
            const { final, sessions } = await w.drive({
                onState: (_, __, state) => states.push(state),
            });
            // Design 4.5 step 4 would count them: |50 - (340 - 300)| + 300
            // = 310 > T_SYNC, a wait that a writer keeps open.
            expect(states).not.toContain("waiting-sync");
            expect(sessions[0].debug().scopes[0]).toMatchObject({
                k: 300,
                gapEst: 10,
                m: cellPrefix(10),
            });
            expect(only(final)).toMatchObject({
                mode: "peel",
                pulled: 10,
                x: 300,
            });
        });
    });

    describe("31 (joiner half): replays, foreign sessions and notices", () => {
        it("drops answers of other sessions, logs and signers; a new openNonce renews", async () => {
            const w = await world({ common: 10, rOnly: 2 });
            await w.drive();
            const replayed = copyMessage(headersSent(w)[0]);
            w.rows([w.r], 2, {
                prefix: "later",
                modified: (i) => 9000n + BigInt(i),
            });
            // R's answers are held back; the test delivers by hand.
            w.hooks.toJ = () => null;
            const session = w.session(w.init());
            session.start();
            await w.until(() => headersSent(w).length === 2, "header");
            const header = copyMessage(headersSent(w)[1]);
            const bytes = (m: ReadinessMessage) =>
                encodeReadinessMessage(m).length;
            const send = (m: ReadinessMessage, from = w.r.hash) =>
                session.onMessage(m, from, bytes(m));
            const foreign = copyMessage(header);
            foreign.sessionId = randomBytes(16);
            const otherLog = copyMessage(header);
            otherLog.logId = new Uint8Array(32).fill(9);
            const cells = new CellsV1({
                sessionId: session.sessionId,
                scope: SCOPE_NAMESPACE_V1,
                logId: header.logId,
                from: 0,
                cells: new Uint8Array(64 * CELL_BYTES),
            });
            const list = new ListV1({
                sessionId: session.sessionId,
                scope: SCOPE_NAMESPACE_V1,
                logId: header.logId,
                offset: 0,
                hashes: new Uint8Array(32),
                done: true,
            });
            const notice = new StateNoticeV1({
                provenance: header.provenance,
                reason: NOTICE_REASON.READY,
            });
            send(replayed);
            send(foreign);
            send(otherLog);
            send(header, w.j.hash);
            send(cells);
            send(list);
            send(notice);
            send(copyMessage(w.sent(OpenV1)[1]));
            expect(session.debug().dropped).toBe(8);
            expect(session.state(SCOPE_NAMESPACE_V1)).toBe("asking");
            expect(session.outcome).toBeUndefined();
            // The genuine header, then a duplicate (ignored), then one with
            // another openNonce: R restarted under this id.
            send(header);
            send(copyMessage(header));
            expect(session.debug().dropped).toBe(9);
            const restarted = copyMessage(header);
            restarted.provenance.openNonce = new Uint8Array(16).fill(1);
            send(restarted);
            expect(session.outcome).toMatchObject({
                kind: "renew",
                reason: "restarted",
            });
            // R may hold the session: it is closed.
            expect(w.sent(CloseV1).length).toBe(2);
        });

        it("the same openNonce with another snapshot renews too", async () => {
            const w = await world({ common: 10, rOnly: 2 });
            w.hooks.toJ = () => null;
            const session = w.session(w.init());
            session.start();
            await w.until(() => headersSent(w).length === 1, "header");
            const header = copyMessage(headersSent(w)[0]);
            const bytes = encodeReadinessMessage(header).length;
            session.onMessage(header, w.r.hash, bytes);
            const other = copyMessage(header);
            other.count += 1;
            session.onMessage(other, w.r.hash, bytes);
            expect(session.outcome).toMatchObject({
                kind: "renew",
                reason: "restarted",
            });
        });

        it("classifyNotice: stale for another openNonce, else a trigger", () => {
            const notice = (nonce: Uint8Array) =>
                new StateNoticeV1({
                    provenance: new ProvenanceV1({
                        writeReady: true,
                        source: "creator",
                        fullReplica: true,
                        phase: "off",
                        openNonce: nonce,
                    }),
                    reason: NOTICE_REASON.READY,
                });
            const known = new Uint8Array(16).fill(3);
            expect(classifyNotice(notice(known), known)).toBe("trigger");
            expect(
                classifyNotice(notice(new Uint8Array(16).fill(4)), known)
            ).toBe("stale");
            expect(classifyNotice(notice(known))).toBe("trigger");
        });
    });

    describe("40: superseded is exact, a re-put is required", () => {
        it("J holds the CUT of h1; R lists the re-put h2 of the same id: h2 is pulled", async () => {
            const w = await JoinerWorld.create();
            w.rows([w.r, w.j], 10);
            const h1 = w.row("x", 1000n);
            const cut = w.cut(h1, 1500n);
            const h2 = w.row("x", 2000n);
            for (const entry of [h1, cut, h2]) w.r.scope().receive(entry);
            w.j.scope().receive(h1);
            w.j.scope().receive(cut);
            await w.start();
            w.holdIndex.add(h2.head);
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => session.debug().scopes[0]!.logged === 1,
                "h2 logged"
            );
            // Pulled, logged, not indexed yet: never contained.
            expect(w.joins.flatMap((join) => join.heads)).toEqual([h2.head]);
            await settle(50);
            expect(session.outcome).toBeUndefined();
            w.j.scope().releaseIndex(h2.head);
            await w.until(() => session.outcome !== undefined, "outcome");
            const result = only(session.outcome!);
            expect(result.pulled).toBe(1);
            expect(result.explained).toBe(0);
            expect(w.j.scope().index.get("x")?.head).toBe(h2.head);
            w.assertClean();
        });

        it("a stale R listing the CUT's own target: superseded, never pulled", async () => {
            const w = await JoinerWorld.create();
            w.rows([w.r, w.j], 10);
            const h1 = w.row("x", 1000n);
            const cut = w.cut(h1, 1500n);
            w.r.scope().receive(h1);
            w.j.scope().receive(h1);
            w.j.scope().receive(cut);
            await w.start();
            const { final } = await w.drive();
            const result = only(final);
            expect(result.explained).toBe(1);
            expect(result.explainedBy).toEqual({ superseded: 1 });
            expect(w.joins).toHaveLength(0);
        });
    });

    describe("44 (unit half): a logged entry waits for its change event", () => {
        it("is never pulled and not contained until its index write lands", async () => {
            const w = await world({ common: 10 });
            const held = w.row("held", 5000n);
            w.r.scope().receive(held);
            w.j.scope().receive(held, { holdIndex: true });
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => session.debug().scopes[0]!.logged === 1,
                "logged"
            );
            expect(session.state(SCOPE_NAMESPACE_V1)).toBe("draining");
            expect(session.debug().armedTimers).toBe(0);
            // Another change of J re-classifies it (G9): still logged.
            w.j.scope().receive(w.row("unrelated", 99_000n));
            await settle(50);
            expect(
                w.j.scope().inspected.filter((head) => head === held.head)
            ).toHaveLength(2);
            expect(session.debug().scopes[0]!.logged).toBe(1);
            expect(w.joins).toHaveLength(0);
            w.j.scope().releaseIndex(held.head);
            await w.until(() => session.outcome !== undefined, "outcome");
            const result = only(session.outcome!);
            expect(result.pulled).toBe(0);
            expect(w.joins).toHaveLength(0);
            w.assertClean();
        });
    });

    describe("the pull queue across sessions", () => {
        it("a pull is never refused while the joins of ended sessions run on", async () => {
            const w = await world({ common: 10, rOnly: 3 });
            const queue = w.pulls.get(SCOPE_NAMESPACE_V1)!;
            let open!: () => void;
            w.joinGate = new Promise<void>((resolve) => (open = resolve));
            // Four sessions that ended mid-pull: their full batches stay in
            // flight until their joins settle (up to the join timeout).
            for (const owner of ["a", "b", "c", "d"]) {
                void queue.pull(
                    owner,
                    Array.from({ length: PULL_BATCH }, (_, i) =>
                        headOf(`${owner}${i}`)
                    )
                );
                queue.release(owner);
            }
            expect(queue.rejections.size).toBe(4 * PULL_BATCH);
            const session = w.session(w.init());
            session.start();
            await w.until(() => w.joins.length === 5, "the session's join");
            expect(w.joins[4].heads).toHaveLength(3);
            open();
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(only(session.outcome!).pulled).toBe(3);
            expect(queue.rejections.size).toBe(0);
            w.assertClean();
        });

        /** Two sessions past their fetch renewal, on one phantom R names. */
        const phantomWorld = async () => {
            const w = await JoinerWorld.create();
            w.rows([w.r, w.j], 25);
            await w.start();
            // Each join yields a macrotask, so a retry loop between the two
            // sessions shows as a growing join count instead of a hang.
            Object.defineProperty(w, "joinGate", {
                configurable: true,
                get: () =>
                    new Promise<void>((resolve) => setImmediate(resolve)),
            });
            const phantom: Entry = {
                head: headOf("phantom row"),
                scope: SCOPE_NAMESPACE_V1,
                kind: "row",
                id: "phantom",
                modified: 5100n,
                next: [],
            };
            w.plantInR(phantom, "phantom", 5100n, { logged: false });
            const renewed = (): SessionInit => {
                const init = w.init();
                init.ladder = { ...init.ladder, fetchRenewed: true };
                return init;
            };
            return { w, phantom, renewed };
        };

        it("two sessions waiting on a hash nobody serves never retry each other without an event", async () => {
            const { w, phantom, renewed } = await phantomWorld();
            const a = w.session(renewed());
            a.start();
            await w.until(
                () => a.state(SCOPE_NAMESPACE_V1) === "failed-fetch-wait",
                "a waits"
            );
            const b = w.session(renewed());
            b.start();
            await w.until(
                () => b.state(SCOPE_NAMESPACE_V1) === "failed-fetch-wait",
                "b waits"
            );
            await settle(20);
            const joins = w.joins.length;
            await settle(200);
            expect(w.joins).toHaveLength(joins);
            // One event retries one session once; its batch made no
            // progress, so the other is not retried.
            a.resume();
            await settle(200);
            expect(w.joins.slice(joins).map(({ heads }) => heads)).toEqual([
                [phantom.head],
            ]);
            expect(a.debug().armedTimers + b.debug().armedTimers).toBe(0);
            a.close();
            b.close();
        });

        it("a batch that progressed only by an explanation retries the other session's failed hash once", async () => {
            const { w, phantom, renewed } = await phantomWorld();
            const a = w.session(renewed());
            a.start();
            await w.until(
                () => a.state(SCOPE_NAMESPACE_V1) === "failed-fetch-wait",
                "a waits"
            );
            await settle(20);
            // A new row of R's that J's canPerform refuses for good.
            const bad = w.row("bad", 5200n);
            w.r.scope().receive(bad);
            w.rejected.set(bad.head, { permanent: true, reason: "structure" });
            const joins = w.joins.length;
            const b = w.session(renewed());
            b.start();
            await w.until(
                () => b.state(SCOPE_NAMESPACE_V1) === "failed-fetch-wait",
                "b waits"
            );
            await settle(200);
            expect(
                w.joins.slice(joins).map(({ heads }) => [...heads].sort())
            ).toEqual([[bad.head, phantom.head].sort(), [phantom.head]]);
            expect(b.debug().scopes[0]!.explained).toBe(1);
            a.close();
            b.close();
        });
    });

    describe("an explanation is part of the proof", () => {
        it("a structure label on a refusal a later state reverses explains nothing", async () => {
            const w = await world({ common: 10, rOnly: 2 });
            const [head] = [...w.r.scope().index.values()]
                .map((row) => row.head)
                .filter((h) => !w.j.scope().log.has(h));
            // canPerform's clock-skew bound, labelled `structure` but not
            // permanent: once J's clock catches up the entry is indexed.
            w.rejected.set(head, { permanent: false, reason: "structure" });
            const session = w.session(w.init());
            session.start();
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(session.outcome).toMatchObject({
                kind: "renew",
                reason: "fetch-failed",
            });
            expect(w.contained).toEqual([]);
        });

        it("cells that name a row J holds leave the pending set, so the certificate decides", async () => {
            const w = await JoinerWorld.create();
            const common = w.rows([w.r, w.j], 25);
            w.rows([w.r], 5, {
                prefix: "r",
                modified: (i) => BigInt(5000 + i),
            });
            await w.start();
            // R's cells count one of J's indexed rows twice (a lie, or a
            // corrupt R): the peel names it as R\J.
            w.hooks.toJ = JoinerWorld.cellsHook(
                await w.faultyCells({
                    plant: headDigest(common[3].head),
                    sign: 1,
                })
            );
            const { final, outcomes } = await w.drive();
            expect(kinds(outcomes)).toEqual(["contained:peel"]);
            expect(only(final)).toMatchObject({ pulled: 5, explained: 0 });
            expect(w.joins.flatMap((join) => join.heads)).not.toContain(
                common[3].head
            );
        });

        it("cells that name a row J holds, with a forged anchor: the certificate runs and the ladder starts", async () => {
            const w = await JoinerWorld.create();
            const common = w.rows([w.r, w.j], 25);
            w.rows([w.r], 5, {
                prefix: "r",
                modified: (i) => BigInt(5000 + i),
            });
            await w.start();
            const cells = JoinerWorld.cellsHook(
                await w.faultyCells({
                    plant: headDigest(common[3].head),
                    sign: 1,
                })
            );
            w.hooks.toJ = (m) => {
                if (m instanceof HeaderV1) m.anchor = bytesOf("forged");
                return cells(m);
            };
            const { outcomes } = await w.drive();
            expect(kinds(outcomes)).toEqual([
                "renew:mismatch",
                "excluded:inconsistent",
            ]);
            expect(w.contained).toEqual([]);
        });
    });

    describe("a lookup that fails is no verdict (deviation d)", () => {
        /** The head of the one row R holds and J lacks. */
        const missingOf = (w: JoinerWorld) =>
            [...w.r.scope().index.values()].find(
                ({ head }) => !w.j.scope().log.has(head)
            )!;

        it("keeps the hash pending, never pulled or excluded; R's sign of life retries it in a quiet store", async () => {
            const w = await world({ common: 10, rOnly: 1 });
            const missing = missingOf(w);
            const j = w.j.scope();
            j.throwing.add(missing.head);
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => session.debug().scopes[0]!.retry === 1,
                "retry"
            );
            await settle(50);
            expect(session.outcome).toBeUndefined();
            expect(session.state(SCOPE_NAMESPACE_V1)).toBe("draining");
            expect(session.debug().armedTimers).toBe(0);
            expect(w.joins).toHaveLength(0);
            expect(
                w.pulls.get(SCOPE_NAMESPACE_V1)!.failed(hex(session.sessionId))
            ).toEqual(new Set([missing.head]));
            // The lookups work again and J's store stays quiet: R's next
            // sign of life retries it (no change of J's is needed).
            j.throwing.delete(missing.head);
            session.resume();
            await w.until(() => session.outcome !== undefined, "outcome");
            const result = only(session.outcome!);
            expect(result.pulled).toBe(1);
            expect(w.joins.flatMap((join) => join.heads)).toEqual([
                missing.head,
            ]);
            w.assertClean();
        });

        it("J's next change retries it too", async () => {
            const w = await world({ common: 10, rOnly: 1 });
            const missing = missingOf(w);
            const j = w.j.scope();
            j.throwing.add(missing.head);
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => session.debug().scopes[0]!.retry === 1,
                "retry"
            );
            j.throwing.delete(missing.head);
            j.receive(w.row("unrelated", 99_000n));
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(only(session.outcome!).pulled).toBe(1);
            w.assertClean();
        });

        it("a lookup after the pull that fails waits the same way, and never renews", async () => {
            const w = await world({ common: 10, rOnly: 1 });
            const missing = missingOf(w);
            const j = w.j.scope();
            // The join brings nothing, and the lookups after it fail.
            w.unserved.add(missing.head);
            w.onJoin = () => j.throwing.add(missing.head);
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => session.debug().scopes[0]!.retry === 1,
                "retry"
            );
            await settle(50);
            expect(session.outcome).toBeUndefined();
            expect(session.debug().armedTimers).toBe(0);
            expect(w.joins).toHaveLength(1);
            w.onJoin = undefined;
            j.throwing.delete(missing.head);
            w.unserved.delete(missing.head);
            session.resume();
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(only(session.outcome!).pulled).toBe(2);
            expect(w.joins).toHaveLength(2);
            w.assertClean();
        });
    });

    describe("50: a writer during the join is no chase", () => {
        it("contains on R's snapshot in the first session, new rows in X, no renew, no re-peel", async () => {
            const w = await JoinerWorld.create();
            const old = w.rows([w.r], 2000);
            await w.start();
            w.syncDelivering.add(SCOPE_NAMESPACE_V1);
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => session.state(SCOPE_NAMESPACE_V1) === "waiting-sync",
                "waiting-sync"
            );
            const [r, j] = [w.r.scope(), w.j.scope()];
            let delivered = 0;
            let written = 0;
            // Every 100 ms: R writes 10 rows (100 rows/s) and sync delivers
            // them, plus 50 of R's older rows.
            for (let tick = 0; tick < 400 && !session.outcome; tick++) {
                for (let i = 0; i < 10; i++) {
                    const entry = w.row(
                        `w${written++}`,
                        10_000n + BigInt(written)
                    );
                    r.receive(entry);
                    j.receive(entry);
                }
                for (let i = 0; i < 50 && delivered < old.length; i++) {
                    j.receive(old[delivered++]);
                }
                w.timers.advance(100);
                await settle(10);
            }
            const result = only(session.outcome!);
            expect(result.count).toBe(2000);
            expect(result.x).toBeGreaterThan(0);
            expect(session.debug().scopes[0]!).toMatchObject({
                repeels: 0,
                mismatches: 0,
            });
            expect(result.recoveries).toBe(0);
            // Each new row reached J before the certificate: all in X.
            expect(result.x).toBe(written);
            expect(result.mode).toBe("sync-wait");
            expect(w.sent(CellsReqV1)).toHaveLength(1);
            w.assertClean();
        });
    });

    describe("51: skewed clocks", () => {
        it("rows hours apart: contained, the oracle holds", async () => {
            const base = 1_700_000_000_000_000_000n;
            const hour = 3_600_000_000_000n;
            const w = await JoinerWorld.create();
            // R's own rows 3 h behind, a writer's 3 h ahead; J has part of
            // the writer's rows and 3 rows of a third peer R lacks.
            w.rows([w.r, w.j], 20, {
                modified: (i) => base - 3n * hour + BigInt(i),
            });
            const writer = w.rows([w.r], 10, {
                prefix: "w",
                modified: (i) => base + 3n * hour + BigInt(i),
            });
            for (const entry of writer.slice(0, 5)) w.j.scope().receive(entry);
            w.rows([w.j], 3, {
                prefix: "t",
                modified: (i) => base + BigInt(i),
            });
            await w.start();
            const { final, outcomes } = await w.drive();
            expect(outcomes).toHaveLength(1);
            const result = only(final);
            expect(result.pulled).toBe(5);
            expect(result.x).toBe(3);
        });

        it("a header hlc rewritten low is never contained before the list", async () => {
            const w = await world({ common: 20, rOnly: 3, jOnly: 2 });
            const held = new Set(
                [...w.j.scope().index.values()].map(({ head }) => head)
            );
            w.hooks.toJ = (m) => {
                if (m instanceof HeaderV1) m.hlc = 0n;
                return m;
            };
            const { outcomes, inits } = await w.drive();
            // R's cells name rows J holds, all "above" the forged hlc: they
            // leave the peel and are never classified.
            expect(
                w.j.scope().inspected.filter((head) => held.has(head))
            ).toEqual([]);
            expect(kinds(outcomes)).toEqual([
                "renew:mismatch",
                "contained:list",
            ]);
            expect(inits.map((init) => init.ladder.stage)).toEqual([
                "first",
                "fresh",
            ]);
            expect(w.contained).toHaveLength(1);
            expect(w.contained[0].x).toBe(2);
        });
    });

    describe("the recovery ladder", () => {
        const renew = (
            reason: Extract<SessionOutcome, { kind: "renew" }>["reason"],
            list = false,
            scopes: ScopeId[] = [SCOPE_NAMESPACE_V1]
        ): SessionOutcome => ({
            kind: "renew",
            reason,
            list,
            scopes,
            results: [],
        });
        const first = (): SessionInit => ({
            ...newSessionInit("peer", [SCOPE_TRUST_V1, SCOPE_NAMESPACE_V1], 7n),
        });

        it("nextSessionInit follows the table", () => {
            const init = first();
            expect(init.scopes).toEqual([SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1]);
            expect(init.ladder).toEqual(FIRST_LADDER);
            const table: Array<
                [SessionInit, SessionOutcome, Partial<SessionInit>]
            > = [
                [
                    init,
                    renew("expired"),
                    {
                        list: false,
                        ladder: {
                            stage: "first",
                            fetchRenewed: false,
                            renewals: 1,
                        },
                    },
                ],
                [
                    init,
                    renew("expired", true),
                    {
                        list: true,
                        ladder: {
                            stage: "list",
                            fetchRenewed: false,
                            renewals: 1,
                        },
                    },
                ],
                [
                    init,
                    renew("restarted"),
                    {
                        list: false,
                        ladder: {
                            stage: "first",
                            fetchRenewed: false,
                            renewals: 1,
                        },
                    },
                ],
                [
                    init,
                    renew("mismatch"),
                    {
                        list: false,
                        ladder: {
                            stage: "fresh",
                            fetchRenewed: false,
                            renewals: 1,
                        },
                    },
                ],
                [
                    { ...init, ladder: { ...init.ladder, stage: "fresh" } },
                    renew("mismatch"),
                    {
                        list: true,
                        ladder: {
                            stage: "list",
                            fetchRenewed: false,
                            renewals: 1,
                        },
                    },
                ],
                [
                    init,
                    renew("list"),
                    {
                        list: true,
                        ladder: {
                            stage: "list",
                            fetchRenewed: false,
                            renewals: 1,
                        },
                    },
                ],
                [
                    init,
                    renew("fetch-failed"),
                    {
                        list: false,
                        ladder: {
                            stage: "first",
                            fetchRenewed: true,
                            renewals: 1,
                        },
                    },
                ],
                [
                    {
                        ...init,
                        list: true,
                        ladder: { ...init.ladder, stage: "list" },
                    },
                    renew("expired"),
                    {
                        list: true,
                        ladder: {
                            stage: "list",
                            fetchRenewed: false,
                            renewals: 1,
                        },
                    },
                ],
            ];
            for (const [previous, outcome, expected] of table) {
                const next = nextSessionInit(previous, outcome)!;
                expect(next).toMatchObject({
                    peer: "peer",
                    hlcProved: 7n,
                    ...expected,
                });
                expect(hex(next.sessionId)).not.toBe(hex(previous.sessionId));
                expect(next.sessionId).toHaveLength(16);
            }
            // The scopes of the renewal, namespace first.
            expect(
                nextSessionInit(
                    init,
                    renew("expired", false, [
                        SCOPE_TRUST_V1,
                        SCOPE_NAMESPACE_V1,
                    ])
                )!.scopes
            ).toEqual([SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1]);
            expect(
                nextSessionInit(
                    init,
                    renew("expired", false, [SCOPE_TRUST_V1])
                )!.scopes
            ).toEqual([SCOPE_TRUST_V1]);
            // Anything but a renewal ends the chain.
            for (const outcome of [
                { kind: "contained", results: [] },
                {
                    kind: "excluded",
                    reason: "inconsistent",
                    scope: SCOPE_NAMESPACE_V1,
                    detail: "",
                },
                { kind: "busy" },
                { kind: "refused", code: "SCOPE" },
                {
                    kind: "local-unavailable",
                    scope: SCOPE_NAMESPACE_V1,
                    detail: "",
                },
                { kind: "closed" },
            ] as SessionOutcome[]) {
                expect(nextSessionInit(init, outcome)).toBeUndefined();
            }
        });

        it("parks a chain after MAX_RENEWALS renewals", async () => {
            const init = first();
            const atLimit = {
                ...init,
                ladder: { ...init.ladder, renewals: MAX_RENEWALS - 1 },
            };
            expect(
                nextSessionInit(atLimit, renew("expired"))!.ladder.renewals
            ).toBe(MAX_RENEWALS);
            expect(
                nextSessionInit(
                    {
                        ...init,
                        ladder: { ...init.ladder, renewals: MAX_RENEWALS },
                    },
                    renew("expired")
                )
            ).toBeUndefined();
            // A responder that expires every session (and ends it).
            const w = await world({ common: 5 });
            w.hooks.toJ = (m) => {
                if (!(m instanceof HeaderV1)) return m;
                w.responder.onMessage(
                    new CloseV1({ sessionId: m.sessionId }),
                    w.j.key
                );
                return new ErrorV1({
                    sessionId: m.sessionId,
                    code: ERROR_CODE.EXPIRED,
                });
            };
            const { outcomes } = await w.drive({ maxSessions: 40 });
            expect(outcomes).toHaveLength(MAX_RENEWALS + 1);
            expect(new Set(kinds(outcomes))).toEqual(
                new Set(["renew:expired"])
            );
        });

        it("a namespace renewal reopens trust; a trust renewal keeps the namespace result", async () => {
            const w = await world({
                common: 10,
                rOnly: 2,
                scopes: [SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1],
            });
            // The namespace header's anchor is forged: it never matches.
            w.hooks.toJ = (m) => {
                if (m instanceof HeaderV1 && m.scope === SCOPE_NAMESPACE_V1) {
                    m.anchor = bytesOf("forged");
                }
                return m;
            };
            const session = w.session(w.init());
            session.start();
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(session.outcome).toMatchObject({
                kind: "renew",
                reason: "mismatch",
                scopes: [SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1],
                results: [],
            });

            const v = await world({
                common: 10,
                rOnly: 2,
                scopes: [SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1],
            });
            v.hooks.toJ = (m) => {
                if (m instanceof HeaderV1 && m.scope === SCOPE_TRUST_V1) {
                    m.anchor = bytesOf("forged");
                }
                return m;
            };
            const second = v.session(v.init());
            second.start();
            await v.until(() => second.outcome !== undefined, "outcome");
            const outcome = second.outcome as Extract<
                SessionOutcome,
                { kind: "renew" }
            >;
            expect(outcome).toMatchObject({
                kind: "renew",
                reason: "mismatch",
                scopes: [SCOPE_TRUST_V1],
            });
            expect(outcome.results.map((r) => r.scope)).toEqual([
                SCOPE_NAMESPACE_V1,
            ]);
            expect(v.contained).toHaveLength(1);
            v.assertClean();
        });
    });

    describe("nothing armed while gated without work in flight", () => {
        it("busy: a list page refused while another list session holds R's slot", async () => {
            const w = await world({ common: 25, rOnly: 5 });
            // Another joiner holds R's one list-mode session.
            const other = (await import("@peerbit/crypto")).Ed25519Keypair;
            const key = (await other.create()).publicKey;
            const otherSession = randomBytes(16);
            w.responder.onMessage(
                new OpenV1({
                    sessionId: otherSession,
                    attempt: 1,
                    flags: OPEN_FLAG_LIST,
                    hlcProved: 0n,
                    scopes: [
                        new OpenScopeV1({
                            scope: SCOPE_NAMESPACE_V1,
                            logId: w.r.scope().logId,
                            count: 0,
                            above: 0,
                        }),
                    ],
                }),
                key
            );
            await settle();
            // A fresh-stage session whose peel cannot match goes to the list.
            w.hooks.toJ = JoinerWorld.cellsHook(
                await w.faultyCells({ as: w.j.scope() })
            );
            const init = w.init();
            init.ladder = { ...init.ladder, stage: "fresh" };
            const session = w.session(init);
            w.onNotice = () => session.resume();
            session.start();
            await w.until(
                () => session.state(SCOPE_NAMESPACE_V1) === "busy",
                "busy"
            );
            expect(session.debug().armedTimers).toBe(0);
            expect(session.outcome).toBeUndefined();
            // The other list session ends; R's capacity notice resumes J.
            w.responder.onMessage(
                new CloseV1({ sessionId: otherSession }),
                key
            );
            await w.until(() => session.outcome !== undefined, "outcome");
            expect(w.notices).toHaveLength(1);
            expect(only(session.outcome!).mode).toBe("list");
            expect(w.sent(ListPageV1)).toHaveLength(2);
            w.assertClean();
        });

        it("failed-fetch-wait: a hash nobody serves keeps J gated, never excluded, nothing armed", async () => {
            const w = await JoinerWorld.create();
            w.rows([w.r, w.j], 25);
            const missing = w.rows([w.r], 2, {
                prefix: "r",
                modified: (i) => BigInt(5000 + i),
            });
            await w.start();
            w.unserved.add(missing[1].head);
            // A false decode R\J: a phantom hash in R's cells.
            w.hooks.toJ = JoinerWorld.cellsHook(
                await w.faultyCells({ plant: bytesOf("phantom"), sign: 1 })
            );
            const first = w.session(w.init());
            first.start();
            await w.until(() => first.outcome !== undefined, "outcome");
            expect(first.outcome).toMatchObject({
                kind: "renew",
                reason: "fetch-failed",
            });
            const next = nextSessionInit(first.init, first.outcome!)!;
            expect(next.ladder.fetchRenewed).toBe(true);
            const session = w.session(next);
            session.start();
            await w.until(
                () => session.state(SCOPE_NAMESPACE_V1) === "failed-fetch-wait",
                "failed-fetch-wait"
            );
            expect(session.debug().scopes[0]!.failed).toBe(2);
            expect(session.debug().armedTimers).toBe(0);
            const joins = w.joins.length;
            await settle(50);
            expect(w.joins.length).toBe(joins);
            // R's sign of life retries; the real row arrives, the phantom
            // never does.
            w.unserved.delete(missing[1].head);
            session.resume();
            await w.until(
                () => session.debug().scopes[0]!.failed === 1,
                "one failed"
            );
            expect(w.j.scope().index.get("r1")?.head).toBe(missing[1].head);
            expect(session.state(SCOPE_NAMESPACE_V1)).toBe("failed-fetch-wait");
            expect(session.outcome).toBeUndefined();
            expect(session.debug().armedTimers).toBe(0);
            session.close();
            expect(w.contained).toEqual([]);
        });
    });
});
