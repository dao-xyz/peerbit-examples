import { Ed25519Keypair } from "@peerbit/crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CELL_BYTES, PULL_TIMEOUT_MS } from "../readiness/constants.js";
import { headDigest } from "../readiness/digest.js";
import {
    SCOPE_NAMESPACE_V1,
    SCOPE_TRUST_V1,
    type ScopeId,
} from "../readiness/scopes.js";
import {
    cellPrefix,
    nextSessionInit,
    type SessionOutcome,
    type SessionResult,
    type SessionState,
} from "../readiness/session.js";
import { HeaderV1, ListPageV1, ListV1, OpenV1 } from "../readiness/wire.js";
import {
    FakeTrust,
    JoinerWorld,
    bytesOf,
    headOf,
    hex,
    packDigests,
    settle,
    type Entry,
    type FakePeer,
    type FakeScope,
} from "./readiness-joiner-harness.js";

/**
 * The joiner session end to end, in memory (M1 plan section 7.3 item 1):
 * J's session against PR-2's real responder on R, real taps on fake indexes
 * on both sides, lane sets of a real anchor host (inline, and a worker
 * thread), every message through the wire codec (each layout encoded,
 * decoded and encoded again to the same bytes), J's real pull queue on a
 * fake join that copies entries from R's log, and J's real explainer on
 * J's fake log and index. Nothing in between is a fake of a readiness
 * module.
 *
 * Every contained outcome is checked by the harness's oracle against the
 * fake stores (R's snapshot within J's index plus E at the certificate's
 * sequence point). Where a case names R's anchor, it computes it on its
 * own: the digest of R's index rows as listed, not as maintained.
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
        throw new Error(`expected contained, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.results).toHaveLength(1);
    return outcome.results[0];
};

/** The anchor of a scope's index rows, from the list (not the lanes). */
const anchorOf = async (scope: FakeScope) =>
    hex(
        await scope.laneSet.digestOf(
            packDigests(
                [...scope.index.values()].map(({ head }) => headDigest(head))
            )
        )
    );

/** A peer's index of one scope: id to head. */
const indexOf = (peer: FakePeer, scope: ScopeId = NS) =>
    new Map([...peer.scope(scope).index].map(([id, row]) => [id, row.head]));

/** Messages that crossed the wire, by class, each way. */
const wireOf = (w: JoinerWorld) => ({
    toR: Object.fromEntries(w.wire.toR),
    toJ: Object.fromEntries(w.wire.toJ),
});

const headersSent = (w: JoinerWorld) =>
    w.sentToJ.filter((m): m is HeaderV1 => m instanceof HeaderV1);

describe.each(["inline", "worker"] as const)(
    "readiness session end to end (%s anchor host)",
    (mode) => {
        afterEach(() => {
            for (const w of JoinerWorld.created.splice(0)) {
                // The host never fell back: a worker case ran on the worker.
                expect(w.host.mode).toBe(mode);
                expect(w.host.stats.failures).toBe(0);
                w.dispose();
                w.assertClean();
            }
        });

        /**
         * `common` rows on both peers (wall times 1000+), `rOnly` on R
         * (5000+), and J's own rows: `jAbove` newer than any of R's
         * (8000+), `jBelow` older (100+).
         */
        const build = async (
            options: {
                common?: number;
                rOnly?: number;
                jAbove?: number;
                jBelow?: number;
                scopes?: ScopeId[];
            } = {}
        ) => {
            const w = await JoinerWorld.create({
                mode,
                scopes: options.scopes,
            });
            const rows = (
                peers: FakePeer[],
                n: number,
                prefix: string,
                base: number
            ) =>
                w.scopeIds.flatMap((scope) =>
                    w.rows(peers, n, {
                        scope,
                        prefix,
                        modified: (i) => BigInt(base + i),
                    })
                );
            const common = rows([w.r, w.j], options.common ?? 40, "c", 1000);
            const rOnly = rows([w.r], options.rOnly ?? 0, "r", 5000);
            const jAbove = rows([w.j], options.jAbove ?? 0, "ja", 8000);
            const jBelow = rows([w.j], options.jBelow ?? 0, "jb", 100);
            await w.start();
            expect(w.host.mode).toBe(mode);
            return { w, common, rOnly, jAbove, jBelow };
        };

        it("d = 0: the fast path contains in one round trip, nothing pulled", async () => {
            const { w } = await build({ common: 40 });
            const anchor = await anchorOf(w.r.scope());
            const { final, outcomes } = await w.drive();
            expect(kinds(outcomes)).toEqual(["contained:fast"]);
            const result = only(final);
            expect(result).toMatchObject({
                count: 40,
                hlc: 1039n,
                qualified: true,
                x: 0,
                pulled: 0,
                explained: 0,
                missingAtStart: 0,
                certificates: 1,
                roundTrips: 1,
                recoveries: 0,
            });
            expect(hex(result.anchor)).toBe(anchor);
            // No gap, so R pushed no cells and J asked for none.
            expect(headersSent(w)[0].cells).toHaveLength(0);
            expect(wireOf(w)).toEqual({
                toR: { OpenV1: 1, CloseV1: 1 },
                toJ: { HeaderV1: 1 },
            });
            expect(w.joins).toHaveLength(0);
            expect(w.pulls.get(NS)!.stats.batches).toBe(0);
            expect(w.contained).toEqual([result]);
        });

        it("d = 10: one peel, 10 pulled, contained with the certificate equal to R's anchor", async () => {
            const { w, rOnly } = await build({ common: 40, rOnly: 10 });
            const anchor = await anchorOf(w.r.scope());
            const { final, outcomes } = await w.drive();
            expect(kinds(outcomes)).toEqual(["contained:peel"]);
            const result = only(final);
            expect(result).toMatchObject({
                count: 50,
                hlc: 5009n,
                missingAtStart: 10,
                pulled: 10,
                x: 0,
                explained: 0,
                cells: cellPrefix(10),
                certificates: 1,
                roundTrips: 1,
                recoveries: 0,
            });
            // R's first flight carried every cell the peel needed.
            expect(headersSent(w)[0].cells).toHaveLength(
                cellPrefix(10) * CELL_BYTES
            );
            expect(wireOf(w)).toEqual({
                toR: { OpenV1: 1, CloseV1: 1 },
                toJ: { HeaderV1: 1 },
            });
            // One batch through the real queue: exactly R's 10 rows.
            expect(w.joins).toHaveLength(1);
            expect(new Set(w.joins[0].heads)).toEqual(
                new Set(rOnly.map(({ head }) => head))
            );
            expect(w.joins[0].timeout).toBe(PULL_TIMEOUT_MS);
            const queue = w.pulls.get(NS)!;
            expect(queue.stats).toMatchObject({
                batches: 1,
                joined: 10,
                deduped: 0,
                joinErrors: 0,
            });
            expect(queue.inFlightHeads).toBe(0);
            expect(queue.rejections.size).toBe(0);
            // The certificate is equality here (X and E empty): R's D_R,
            // the anchor of R's rows as listed, and J's own anchor now.
            expect(hex(result.anchor)).toBe(anchor);
            expect(hex(await w.j.scope().laneSet.digestNow().digest)).toBe(
                anchor
            );
            expect(indexOf(w.j)).toEqual(indexOf(w.r));
        });

        it("J's own rows: those above R's hlc (k) leave the peel, those below are its J\\R, all go to X", async () => {
            const { w, rOnly, jAbove, jBelow } = await build({
                common: 30,
                rOnly: 6,
                jAbove: 5,
                jBelow: 3,
            });
            const before = indexOf(w.r);
            const { final, outcomes, sessions } = await w.drive();
            expect(kinds(outcomes)).toEqual(["contained:peel"]);
            const result = only(final);
            expect(result).toMatchObject({
                count: 36,
                hlc: 5005n,
                pulled: 6,
                x: 8,
                // The count estimate: 36 - (38 - 5); J's 3 older rows
                // offset 3 of R's.
                missingAtStart: 3,
            });
            expect(sessions[0].debug().scopes[NS]).toMatchObject({
                k: 5,
                xPeel: 3,
                repeels: 0,
                mismatches: 0,
            });
            // J gained R's rows and kept its own; R is unchanged.
            for (const entry of [...rOnly, ...jAbove, ...jBelow]) {
                expect(w.j.scope().index.get(entry.id!)?.head).toBe(entry.head);
            }
            expect(indexOf(w.r)).toEqual(before);
        });

        it("R writes during the session: R's snapshot is contained, the new rows go to X, an update is superseded and an older re-put explained", async () => {
            const { w, rOnly } = await build({ common: 40, rOnly: 10 });
            const [r, j] = [w.r.scope(), w.j.scope()];
            const anchor = await anchorOf(r);
            let written = 0;
            /** A write on R; sync delivers it to J when `synced`. */
            const write = (
                synced: boolean,
                options: {
                    id?: string;
                    modified?: bigint;
                    next?: string[];
                } = {}
            ) => {
                const n = written++;
                const entry = w.row(
                    options.id ?? `w${n}`,
                    options.modified ?? 20_000n + BigInt(n),
                    NS,
                    options.next
                );
                r.receive(entry);
                if (synced) j.receive(entry);
                return entry;
            };
            let update: Entry | undefined;
            let reput: Entry | undefined;
            // R froze its snapshot and its header is on the way: R writes 6
            // rows (sync delivers 4), updates r3 (the update names r3), and
            // another writer's newer put of r7 reaches both.
            w.hooks.toJ = (m) => {
                if (m instanceof HeaderV1 && !update) {
                    for (let i = 0; i < 6; i++) write(i < 4);
                    update = write(true, {
                        id: "r3",
                        modified: 30_000n,
                        next: [rOnly[3].head],
                    });
                    reput = write(true, { id: "r7", modified: 30_001n });
                }
                return m;
            };
            // While J pulls, R writes 3 more rows and sync delivers them.
            w.onJoin = () => {
                if (written === 8) for (let i = 0; i < 3; i++) write(true);
            };
            const { final, outcomes, sessions } = await w.drive();
            expect(kinds(outcomes)).toEqual(["contained:peel"]);
            const result = only(final);
            expect(result).toMatchObject({
                count: 50,
                hlc: 5009n,
                pulled: 9,
                explained: 2,
                explainedBy: { superseded: 1, "ignored-older": 1 },
                // 4 + 3 new rows, the update and the re-put.
                x: 9,
                recoveries: 0,
            });
            expect(sessions[0].debug().scopes[NS]).toMatchObject({
                repeels: 0,
                mismatches: 0,
            });
            // R's snapshot, not R's state now.
            expect(hex(result.anchor)).toBe(anchor);
            expect(await anchorOf(r)).not.toBe(anchor);
            // r3 was never pulled (J holds the update that names it); r7
            // was pulled, and Documents kept the newer re-put.
            const pulled = w.joins.flatMap(({ heads }) => heads);
            expect(pulled).toHaveLength(9);
            expect(pulled).not.toContain(rOnly[3].head);
            expect(j.index.get("r3")?.head).toBe(update!.head);
            expect(j.index.get("r7")?.head).toBe(reput!.head);
            expect(j.log.has(rOnly[7].head)).toBe(true);
        });

        it("R deletes a row J holds during the session: one re-peel, the row is superseded by the CUT", async () => {
            const { w, common } = await build({ common: 40, rOnly: 10 });
            const [r, j] = [w.r.scope(), w.j.scope()];
            let cut: Entry | undefined;
            w.onJoin = () => {
                if (cut) return;
                cut = w.cut(common[0], 25_000n);
                r.receive(cut);
                j.receive(cut);
            };
            const { final, outcomes, sessions } = await w.drive();
            expect(kinds(outcomes)).toEqual(["contained:peel"]);
            const result = only(final);
            expect(result).toMatchObject({
                pulled: 10,
                explained: 1,
                explainedBy: { superseded: 1 },
                certificates: 2,
                recoveries: 1,
            });
            expect(sessions[0].debug().scopes[NS]).toMatchObject({
                repeels: 1,
                mismatches: 1,
            });
            expect(j.index.has(common[0].id!)).toBe(false);
            // The deleted row was never pulled.
            expect(w.joins).toHaveLength(1);
        });

        it("R retires a row between its snapshot and J's pull (case 15): the fetch fails, one fresh session, whose snapshot lacks the row", async () => {
            const { w, rOnly } = await build({ common: 40, rOnly: 10 });
            const [r, j] = [w.r.scope(), w.j.scope()];
            const retired = rOnly[2];
            // As J's pull starts, R deletes the row and its GC drops the
            // entry. Sync has not brought the CUT to J, so the row is not
            // superseded on J, and nobody can serve it.
            let cut: Entry | undefined;
            w.onJoin = () => {
                if (cut) return;
                cut = w.cut(retired, 25_000n);
                r.receive(cut);
                r.log.delete(retired.head);
            };
            const { final, outcomes, inits } = await w.drive();
            expect(kinds(outcomes)).toEqual([
                "renew:fetch-failed",
                "contained:fast",
            ]);
            expect(inits.map((init) => init.ladder)).toEqual([
                { stage: "first", fetchRenewed: false, renewals: 0 },
                { stage: "first", fetchRenewed: true, renewals: 1 },
            ]);
            // R's first snapshot named the row; the fresh one does not.
            const [first, fresh] = headersSent(w);
            const retiredDigest = hex(headDigest(retired.head));
            expect(r.snapshots.get(hex(first.anchor))!.has(retiredDigest)).toBe(
                true
            );
            expect(r.snapshots.get(hex(fresh.anchor))!.has(retiredDigest)).toBe(
                false
            );
            const result = only(final);
            expect(result).toMatchObject({
                count: 49,
                pulled: 0,
                x: 0,
                explained: 0,
                recoveries: 1,
            });
            expect(hex(result.anchor)).toBe(await anchorOf(r));
            expect(hex(result.anchor)).not.toBe(hex(first.anchor));
            // One batch of R's 10 rows: 9 arrived, the retired one never.
            expect(w.joins).toHaveLength(1);
            expect(new Set(w.joins[0].heads)).toEqual(
                new Set(rOnly.map(({ head }) => head))
            );
            expect(j.log.has(retired.head)).toBe(false);
            expect(j.index.has(retired.id!)).toBe(false);
            // The oracle accepted the result against R's fresh snapshot.
            expect(w.contained).toEqual([result]);
            expect(indexOf(w.j)).toEqual(indexOf(w.r));
        });

        it("a forced cell collision: re-peel, a fresh session, then the list", async () => {
            const { w, rOnly } = await build({ common: 25, rOnly: 5 });
            const j = w.j.scope();
            // R's cells replaced by J's own: every peel finds nothing.
            w.hooks.toJ = JoinerWorld.cellsHook(await w.faultyCells({ as: j }));
            // Sync delivers one of R's rows as J's first certificate
            // starts, so J moved since the peel and the re-peel runs.
            let synced = false;
            const { final, outcomes, sessions, inits } = await w.drive({
                onState: (_, __, state: SessionState) => {
                    if (state !== "certifying" || synced) return;
                    synced = true;
                    j.receive(rOnly[0]);
                },
            });
            expect(kinds(outcomes)).toEqual([
                "renew:mismatch",
                "contained:list",
            ]);
            expect(inits.map((init) => init.ladder.stage)).toEqual([
                "first",
                "fresh",
            ]);
            expect(sessions[0].debug().scopes[NS]).toMatchObject({
                repeels: 1,
                mismatches: 2,
            });
            expect(sessions[1].debug().scopes[NS]).toMatchObject({
                repeels: 0,
                mismatches: 1,
            });
            const result = only(final);
            expect(result).toMatchObject({
                mode: "list",
                pulled: 4,
                x: 0,
                recoveries: 1,
            });
            expect(w.sent(ListPageV1)).toHaveLength(1);
            expect(w.wire.toJ.get("ListV1")).toBe(1);
            // Nothing was contained on a hint.
            expect(w.contained).toEqual([result]);
            expect(indexOf(w.j)).toEqual(indexOf(w.r));
        });

        it("both scopes in one OPEN: trust after namespace, both contained", async () => {
            const { w } = await build({
                common: 10,
                rOnly: 3,
                scopes: [SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1],
            });
            const anchors = [
                await anchorOf(w.r.scope(SCOPE_NAMESPACE_V1)),
                await anchorOf(w.r.scope(SCOPE_TRUST_V1)),
            ];
            const { final } = await w.drive();
            if (final.kind !== "contained") throw new Error(final.kind);
            expect(final.results.map((r) => r.scope)).toEqual([
                SCOPE_NAMESPACE_V1,
                SCOPE_TRUST_V1,
            ]);
            expect(final.results.map((r) => hex(r.anchor))).toEqual(anchors);
            expect(final.results.map((r) => r.pulled)).toEqual([3, 3]);
            expect(w.sent(OpenV1)).toHaveLength(1);
            expect(w.wire.toJ.get("HeaderV1")).toBe(2);
            for (const scope of w.scopeIds) {
                expect(indexOf(w.j, scope)).toEqual(indexOf(w.r, scope));
            }
        });

        it("two sessions share J's pull queue: a row in flight is joined once", async () => {
            const { w, rOnly } = await build({ common: 40, rOnly: 10 });
            const queue = w.pulls.get(NS)!;
            // A slow donor: the first batch stays in flight.
            let open!: () => void;
            w.joinGate = new Promise<void>((resolve) => (open = resolve));
            const sessions = [w.session(w.init()), w.session(w.init())];
            for (const session of sessions) session.start();
            await w.until(
                () => queue.inFlightHeads === 10 && queue.stats.deduped === 10,
                "the second session rides on the first batch"
            );
            expect(w.joins).toHaveLength(1);
            expect(sessions.map((s) => s.state(NS))).toEqual([
                "draining",
                "draining",
            ]);
            open();
            await w.until(
                () => sessions.every((s) => s.outcome !== undefined),
                "outcomes"
            );
            const results = sessions.map((s) => only(s.outcome!));
            expect(results.map((r) => r.pulled)).toEqual([10, 10]);
            expect(results[0].anchor).toEqual(results[1].anchor);
            expect(queue.stats).toMatchObject({
                batches: 1,
                joined: 10,
                deduped: 10,
            });
            expect(new Set(w.joins[0].heads)).toEqual(
                new Set(rOnly.map(({ head }) => head))
            );
            expect(w.wire.toR.get("OpenV1")).toBe(2);
            expect(w.contained).toHaveLength(2);
        });

        it("canPerform rejections reach the explainer through the real queue: a structural one is explained, an untrusted one parks the row", async () => {
            const { w, rOnly } = await build({ common: 30, rOnly: 4 });
            w.rejected.set(rOnly[0].head, {
                permanent: true,
                reason: "structure",
            });
            w.rejected.set(rOnly[1].head, {
                permanent: false,
                reason: "untrusted",
            });
            const session = w.session(w.init());
            session.start();
            await w.until(
                () => session.debug().scopes[NS]!.trustPending === 1,
                "trust-pending"
            );
            await settle();
            expect(session.outcome).toBeUndefined();
            expect(session.state(NS)).toBe("draining");
            expect(session.debug().scopes[NS]).toMatchObject({
                pending: 1,
                trustPending: 1,
                explained: 1,
            });
            expect(session.debug().armedTimers).toBe(0);
            // The queue tracked the batch's heads only while it ran.
            const queue = w.pulls.get(NS)!;
            expect(queue.rejections.size).toBe(0);
            expect(queue.inFlightHeads).toBe(0);
            // The signer becomes trusted (commit 3 calls `reclassify` on a
            // trust change): the parked row is pulled again and indexed.
            w.rejected.delete(rOnly[1].head);
            session.reclassify();
            await w.until(() => session.outcome !== undefined, "outcome");
            const result = only(session.outcome!);
            expect(result).toMatchObject({
                pulled: 5,
                explained: 1,
                explainedBy: { "rejected-structure": 1 },
            });
            expect(w.joins.map(({ heads }) => heads.length)).toEqual([4, 1]);
            expect(w.j.scope().index.has(rOnly[0].id!)).toBe(false);
            expect(w.j.scope().index.get(rOnly[1].id!)?.head).toBe(
                rOnly[1].head
            );
        });

        it("X1: a namespace row refused for a key R's trust snapshot never grants is rejected-untrusted once the trust run contains, and the certificate matches with it in E", async () => {
            const { w, rOnly } = await build({
                common: 10,
                rOnly: 2,
                scopes: [SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1],
            });
            const [refused] = rOnly;
            expect(refused.scope).toBe(NS);
            const writer = (await Ed25519Keypair.create()).publicKey;
            w.rejected.set(refused.head, {
                permanent: false,
                reason: "untrusted",
                signers: [writer],
            });
            const anchors = [
                await anchorOf(w.r.scope(SCOPE_NAMESPACE_V1)),
                await anchorOf(w.r.scope(SCOPE_TRUST_V1)),
            ];
            // J's trust view: R's trust run is the only trust scope that
            // counts, and the writer is in no row of it.
            const trust = new FakeTrust();
            const session = w.session(w.init(), { ports: { trust } });
            trust.contained = () =>
                session.state(SCOPE_TRUST_V1) === "contained";
            session.start();
            await w.until(() => session.outcome !== undefined, "outcome");
            const outcome = session.outcome!;
            if (outcome.kind !== "contained") throw new Error(outcome.kind);
            const [namespace, trustResult] = outcome.results;
            expect(outcome.results.map((r) => hex(r.anchor))).toEqual(anchors);
            expect(namespace).toMatchObject({
                pulled: 2,
                explained: 1,
                explainedBy: { "rejected-untrusted": 1 },
                untrusted: { heads: 1, checkedAt: 0 },
            });
            expect(
                namespace.untrusted!.signers.map((k) => k.hashcode())
            ).toEqual([writer.hashcode()]);
            expect(trustResult).toMatchObject({ pulled: 2, explained: 0 });
            expect(trustResult.untrusted).toBeUndefined();
            // The oracle accepted both: R's refused row is in E, never in
            // J's index.
            expect(w.contained).toEqual(outcome.results);
            expect(w.j.scope(NS).index.has(refused.id!)).toBe(false);
            expect(indexOf(w.j, SCOPE_TRUST_V1)).toEqual(
                indexOf(w.r, SCOPE_TRUST_V1)
            );
            expect(session.debug().armedTimers).toBe(0);
        });

        describe("a lying responder is never contained", () => {
            /** Every state any session of the world entered. */
            const watch = () => {
                const states: SessionState[] = [];
                return {
                    states,
                    onState: (_: unknown, __: unknown, state: SessionState) =>
                        states.push(state),
                };
            };

            const neverContained = (
                w: JoinerWorld,
                states: SessionState[],
                outcomes: SessionOutcome[]
            ) => {
                expect(states).not.toContain("contained");
                expect(outcomes.map(({ kind }) => kind)).not.toContain(
                    "contained"
                );
                expect(w.contained).toEqual([]);
            };

            it("a forged anchor: renew{mismatch}, then the list proves the lie", async () => {
                const { w } = await build({ common: 25, rOnly: 5 });
                w.hooks.toJ = (m) => {
                    if (m instanceof HeaderV1) m.anchor = bytesOf("forged");
                    return m;
                };
                const { states, onState } = watch();
                const { final, outcomes } = await w.drive({ onState });
                expect(kinds(outcomes)).toEqual([
                    "renew:mismatch",
                    "excluded:inconsistent",
                ]);
                expect(final).toMatchObject({
                    detail: "the list's set hash differs from the header's",
                });
                neverContained(w, states, outcomes);
            });

            it("a list that swaps one hash (the count unchanged)", async () => {
                const { w } = await build({ common: 25, rOnly: 5 });
                w.hooks.toJ = (m) => {
                    if (m instanceof ListV1) {
                        m.hashes.set(bytesOf("swapped"), 0);
                    }
                    return m;
                };
                const { states, onState } = watch();
                const { final, outcomes } = await w.drive({
                    init: w.init({ list: true }),
                    onState,
                });
                expect(kinds(outcomes)).toEqual(["excluded:inconsistent"]);
                expect(final).toMatchObject({
                    detail: "the list's set hash differs from the header's",
                });
                expect(w.wire.toJ.get("ListV1")).toBe(1);
                neverContained(w, states, outcomes);
            });

            it("count 0 with a non-empty set hash", async () => {
                const { w } = await build({ common: 25, rOnly: 5 });
                w.hooks.toJ = (m) => {
                    if (m instanceof HeaderV1) m.count = 0;
                    return m;
                };
                const { states, onState } = watch();
                const { outcomes } = await w.drive({ onState });
                expect(kinds(outcomes)).toEqual(["excluded:inconsistent"]);
                neverContained(w, states, outcomes);
            });

            it("a FileChunk R names as a row: unsubstantiated once fetched", async () => {
                const { w } = await build({ common: 25, rOnly: 5 });
                const chunk = w.other("chunk");
                w.plantInR(chunk, "planted", 5100n);
                const { states, onState } = watch();
                const { final, outcomes } = await w.drive({ onState });
                expect(kinds(outcomes)).toEqual(["excluded:unsubstantiated"]);
                expect((final as { detail: string }).detail).toContain(
                    chunk.head
                );
                expect(w.joins.flatMap(({ heads }) => heads)).toContain(
                    chunk.head
                );
                neverContained(w, states, outcomes);
            });

            it("a row nobody can serve keeps J gated: never contained, never excluded, nothing armed", async () => {
                const { w } = await build({ common: 25, rOnly: 2 });
                // R's index holds a head no log has (a phantom element).
                const phantom: Entry = {
                    head: headOf("phantom row"),
                    scope: NS,
                    kind: "row",
                    id: "phantom",
                    modified: 5100n,
                    next: [],
                };
                w.plantInR(phantom, "phantom", 5100n, { logged: false });
                const { states, onState } = watch();
                const first = w.session(w.init(), { events: { onState } });
                first.start();
                await w.until(() => first.outcome !== undefined, "outcome");
                expect(first.outcome).toMatchObject({
                    kind: "renew",
                    reason: "fetch-failed",
                });
                const second = w.session(
                    nextSessionInit(first.init, first.outcome!)!,
                    { events: { onState } }
                );
                second.start();
                await w.until(
                    () => second.state(NS) === "failed-fetch-wait",
                    "failed-fetch-wait"
                );
                // Nothing is retried without an event. R's sign of life and
                // J's own change each retry the pull once (the real queue's
                // retry listener and index subscription); neither makes J
                // contained.
                const joins = w.joins.length;
                await settle();
                expect(w.joins).toHaveLength(joins);
                second.resume();
                await settle();
                expect(w.joins).toHaveLength(joins + 1);
                w.j.scope().receive(w.row("late", 99_000n));
                await settle();
                expect(w.joins).toHaveLength(joins + 2);
                expect(w.joins.slice(joins).map(({ heads }) => heads)).toEqual([
                    [phantom.head],
                    [phantom.head],
                ]);
                expect(second.state(NS)).toBe("failed-fetch-wait");
                expect(second.outcome).toBeUndefined();
                expect(second.debug().scopes[NS]).toMatchObject({
                    pending: 1,
                    failed: 1,
                });
                expect(second.debug().armedTimers).toBe(0);
                // The real rows arrived; only the phantom is missing.
                expect(w.j.scope().index.size).toBe(28);
                second.close();
                neverContained(w, states, [first.outcome!, second.outcome!]);
            });
        });
    }
);
