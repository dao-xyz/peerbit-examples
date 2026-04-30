import { describe, expect, it } from "vitest";
import { getPeerDialAddresses, withSharePeerHints } from "../src/share-url";

describe("share URL peer hints", () => {
    it("adds normalized peer addresses before the hash route", () => {
        const href = withSharePeerHints(
            "https://files.dao.xyz/#/s/space-address",
            [
                "/dns4/bootstrap/tcp/4003/wss/p2p/a",
                " /dns4/bootstrap/tcp/4003/wss/p2p/a ",
                "/dns4/bootstrap/tcp/4002/p2p/b",
            ]
        );

        const url = new URL(href);
        expect(url.hash).toBe("#/s/space-address");
        expect(url.searchParams.get("peer")).toBe(
            "/dns4/bootstrap/tcp/4003/wss/p2p/a,/dns4/bootstrap/tcp/4002/p2p/b"
        );
    });

    it("does not replace explicit bootstrap URLs", () => {
        const href =
            "https://files.dao.xyz/?bootstrap=/dns4/local#/s/space-address";

        expect(
            withSharePeerHints(href, ["/dns4/bootstrap/tcp/4003/wss/p2p/a"], {
                skipWhenBootstrapPresent: true,
            })
        ).toBe(href);
    });

    it("extracts peer multiaddrs from peerbit-like clients", () => {
        expect(
            getPeerDialAddresses({
                getMultiaddrs: () => [
                    { toString: () => "/dns4/a/tcp/4003/wss/p2p/one" },
                    { toString: () => "/dns4/a/tcp/4003/wss/p2p/one" },
                    "/dns4/b/tcp/4002/p2p/two",
                ],
            })
        ).toEqual(["/dns4/a/tcp/4003/wss/p2p/one", "/dns4/b/tcp/4002/p2p/two"]);
    });
});
