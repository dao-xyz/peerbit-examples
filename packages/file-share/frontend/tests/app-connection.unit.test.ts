import { afterEach, describe, expect, it, vi } from "vitest";
import {
    dialPeerWithTimeout,
    getLocalShareFallbackOutcome,
    getPeerAddressConfiguration,
    getPeerDialOutcome,
    getPeerOverrideAction,
    getShareAddressFromHref,
} from "../src/app-connection";

describe("App peer override readiness", () => {
    afterEach(() => vi.useRealTimers());

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

    it("extracts a local fallback address only from an exact share route", () => {
        expect(
            getShareAddressFromHref(
                "https://files.test/?peer=writer#/s/zb2rhSaved%2Dshare"
            )
        ).toBe("zb2rhSaved-share");
        expect(
            getShareAddressFromHref(
                "https://files.test/#/s/zb2rhSaved-share?peer=writer"
            )
        ).toBe("zb2rhSaved-share");
        expect(getShareAddressFromHref("https://files.test/#/")).toBe(
            undefined
        );
        expect(
            getShareAddressFromHref("https://files.test/#/s/share/child")
        ).toBe(undefined);
        expect(getShareAddressFromHref("https://files.test/#/s/%E0%A4%A")).toBe(
            undefined
        );
        expect(
            getShareAddressFromHref("https://files.test/#/s/saved%2Fchild")
        ).toBe(undefined);
    });

    it("uses a saved descriptor only for failed direct peer hints", () => {
        expect(
            getLocalShareFallbackOutcome({
                source: "peer",
                shareAddress: "saved-share",
                localProgramAvailable: true,
            })
        ).toBe("ready-local");
        expect(
            getLocalShareFallbackOutcome({
                source: "peer",
                shareAddress: "saved-share",
                localProgramAvailable: false,
            })
        ).toBe("failed");
        expect(
            getLocalShareFallbackOutcome({
                source: "bootstrap",
                shareAddress: "saved-share",
                localProgramAvailable: true,
            })
        ).toBe("failed");
        expect(
            getLocalShareFallbackOutcome({
                source: "peer",
                shareAddress: undefined,
                localProgramAvailable: true,
            })
        ).toBe("failed");
    });

    it("bounds a dial even when the dial implementation never settles", async () => {
        vi.useFakeTimers();
        let dialSignal: AbortSignal | undefined;
        const result = dialPeerWithTimeout(
            async (_address, options) => {
                dialSignal = options.signal;
                await new Promise(() => {});
            },
            "peer-a",
            25
        );
        const rejection = expect(result).rejects.toMatchObject({
            name: "PeerDialTimeoutError",
        });

        await vi.advanceTimersByTimeAsync(25);
        await rejection;
        expect(dialSignal?.aborted).toBe(true);
    });
});
