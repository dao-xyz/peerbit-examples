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
    commitDiagnostics: [],
    changes: 0,
    clobbered: 0,
    atBound: snapshot(),
    atEnd: snapshot({ at: 120_800 }),
    ...over,
});

describe("cold-start hold diagnosis", () => {
    it("A: the label committed before the bound and the hold did not release", () => {
        expect(
            classifyHold(
                facts({
                    receivedAt: 1_000,
                    committedAt: 1_200,
                    commitDiagnostics: [900],
                    changes: 2,
                    endAt: 30_810,
                })
            )
        ).toEqual({
            code: "A",
            name: "hold detection did not fire",
            text: "the label committed at 1.2 s, but no commit diagnostic released the hold after its change event (1 diagnostics, 0 after it; 0 later change events reset the match)",
        });
        expect(
            classifyHold(facts({ atBound: snapshot({ inIndex: true }) })).code
        ).toBe("A");
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
            text: "the joiner received the label at 1.0 s but had not committed it by the bound: its canPerformEntry was pending from 1.0 s; joining true, in log false; it had not committed when the diagnosis gave up at 120.8 s",
        });
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
