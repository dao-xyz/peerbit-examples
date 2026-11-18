import { describe, expect, it } from "vitest";
import {
    classifyHold,
    type HoldFacts,
    type HoldSnapshot,
} from "./cold-start-hold-diagnosis.js";

const snapshot = (over: Partial<HoldSnapshot> = {}): HoldSnapshot => ({
    at: 30_800,
    inLog: false,
    joining: false,
    inIndex: false,
    connections: 1,
    joinerSeesDonor: true,
    donorSeesJoiner: true,
    ...over,
});

/** A hold that started at 0.8 s and gave up at 120.8 s, nothing seen. */
const facts = (over: Partial<HoldFacts> = {}): HoldFacts => ({
    label: { name: "resumed.txt", hash: "zb2rhLabel", id: "naming:1" },
    holdAt: 800,
    boundAt: 30_800,
    endAt: 120_800,
    checks: 0,
    commitDiagnostics: [],
    changes: 0,
    atBound: snapshot(),
    atEnd: snapshot({ at: 120_800 }),
    ...over,
});

describe("cold-start hold diagnosis", () => {
    it("A: the store held the label by the bound and the hold did not release", () => {
        const stored = snapshot({ inLog: true, inIndex: true });
        expect(
            classifyHold(
                facts({
                    receivedAt: 1_000,
                    changedAt: 1_200,
                    checks: 1,
                    lastCheck: { at: 1_210, inLog: true, inIndex: "error" },
                    changes: 2,
                    endAt: 30_810,
                    atBound: stored,
                })
            )
        ).toEqual({
            code: "A",
            name: "hold detection did not fire",
            text: "the label was in the joiner's log and index at the bound and a change event carried it at 1.2 s, but no store check released the hold (store checks: 1; the last, at 1.2 s, read in log true, in index error)",
        });
        expect(classifyHold(facts({ atBound: stored })).text).toBe(
            "the label was in the joiner's log and index at the bound, but no change event carried it, so the hold never checked the store"
        );
        // A check found it by the bound, though the reads at the bound
        // gave up.
        expect(
            classifyHold(
                facts({
                    receivedAt: 1_000,
                    changedAt: 1_200,
                    committedAt: 1_210,
                    atBound: snapshot({
                        inLog: "timeout",
                        inIndex: "timeout",
                    }),
                })
            ).code
        ).toBe("A");
        // In the log alone, or in the index alone, is not committed.
        for (const atBound of [
            snapshot({ inLog: true }),
            snapshot({ inIndex: true }),
        ]) {
            expect(classifyHold(facts({ atBound })).code).toBe("C");
        }
    });

    it("B: the label never reached the joiner, or only after the bound", () => {
        expect(classifyHold(facts())).toEqual({
            code: "B",
            name: "delivery liveness, upstream",
            text: "no exchange message carried the label to the joiner by the bound and its log lacked it (no message named it; connections 1, joiner sees donor true, donor sees joiner true); it had not committed when the diagnosis gave up at 120.8 s",
        });
        expect(
            classifyHold(
                facts({
                    receivedAt: 41_000,
                    receivedBy: "ExchangeHeadsMessage",
                    committedAt: 41_300,
                    endAt: 41_300,
                })
            ).text
        ).toMatch(
            /; after the bound it arrived at 41\.0 s and committed at 41\.3 s$/
        );
    });

    it("C: the joiner had the label by the bound but had not committed it", () => {
        expect(
            classifyHold(
                facts({
                    receivedAt: 1_000,
                    canPerform: { startAt: 1_000 },
                    atBound: snapshot({ joining: true }),
                })
            )
        ).toEqual({
            code: "C",
            name: "joiner commit",
            text: "the joiner received the label at 1.0 s but had not committed it to the store by the bound: its canPerformEntry was pending from 1.0 s; joining true, in log false, in index false; it had not committed when the diagnosis gave up at 120.8 s",
        });
        // A change event that carried the label before its index write.
        expect(
            classifyHold(
                facts({
                    receivedAt: 1_000,
                    canPerform: {
                        startAt: 1_020,
                        endAt: 1_040,
                        result: "true",
                    },
                    changedAt: 1_300,
                    checks: 4,
                    lastCheck: { at: 29_000, inLog: true, inIndex: false },
                    atBound: snapshot({ inLog: true }),
                })
            ).text
        ).toBe(
            "the joiner received the label at 1.0 s but had not committed it to the store by the bound: its canPerformEntry returned true at 1.0 s; a change event carried it at 1.3 s; joining false, in log true, in index false; it had not committed when the diagnosis gave up at 120.8 s"
        );
        expect(
            classifyHold(
                facts({
                    atBound: snapshot({ inLog: true }),
                    committedAt: 45_000,
                    endAt: 45_000,
                })
            ).text
        ).toMatch(
            /^the label was in the joiner's log at the bound \(by a path not recorded\) .*; after the bound it committed at 45\.0 s$/
        );
    });

    it("is unclassified when the label's hash was not captured and nothing committed", () => {
        expect(
            classifyHold(facts({ label: { name: "resumed.txt" } })).code
        ).toBe("unclassified");
    });
});
