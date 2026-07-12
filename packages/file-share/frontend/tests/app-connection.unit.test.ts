import { describe, expect, it } from "vitest";
import {
    getPeerAddressConfiguration,
    getPeerDialOutcome,
    getPeerOverrideAction,
} from "../src/app-connection";

describe("App peer override readiness", () => {
    it("reports direct peer hints separately from bootstrap overrides", () => {
        expect(
            getPeerAddressConfiguration(
                "https://files.test/?peer=peer-a,peer-b&bootstrap=relay#/s/share"
            )
        ).toEqual({ source: "peer", peers: ["peer-a", "peer-b"] });
        expect(
            getPeerAddressConfiguration(
                "https://files.test/?bootstrap=relay#/s/share"
            )
        ).toEqual({ source: "bootstrap", peers: ["relay"] });
    });

    it("reads peer hints from the hash query without losing their source", () => {
        expect(
            getPeerAddressConfiguration(
                "https://files.test/#/s/share?peer=peer-a%2Cpeer-b"
            )
        ).toEqual({ source: "peer", peers: ["peer-a", "peer-b"] });
    });

    it("waits for the peer before declaring supplied hints ready", () => {
        expect(
            getPeerOverrideAction(false, ["/ip4/127.0.0.1/tcp/9000/ws"])
        ).toBe("wait-for-peer");
    });

    it("dials every supplied hint once the peer exists", () => {
        expect(getPeerOverrideAction(true, ["peer-a", "peer-b"])).toBe(
            "dial-explicit-peers"
        );
    });

    it("needs no explicit dial when no hints were supplied", () => {
        expect(getPeerOverrideAction(true, undefined)).toBe(
            "ready-without-explicit-dial"
        );
        expect(getPeerOverrideAction(true, [])).toBe(
            "ready-without-explicit-dial"
        );
    });

    it("waits for every explicit dial before choosing an outcome", () => {
        expect(
            getPeerDialOutcome([{ status: "fulfilled" }, { status: "pending" }])
        ).toBe("pending");
    });

    it("becomes ready after all dials settle when at least one succeeded", () => {
        expect(
            getPeerDialOutcome([
                { status: "rejected" },
                { status: "fulfilled" },
                { status: "rejected" },
            ])
        ).toBe("ready");
    });

    it("fails only after every supplied dial was rejected", () => {
        expect(
            getPeerDialOutcome([{ status: "rejected" }, { status: "rejected" }])
        ).toBe("failed");
    });
});
