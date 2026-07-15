import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findStaticPeercheckerRelayHost } from "../scripts/static-relay-policy.mjs";

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);

// These are historical fixtures, not an exhaustive blocklist. The matcher
// must reject future hex-labelled relay leases without a code change.
const RETIRED_RELAY_HOST_FIXTURES = [
    "8e0829c4b09e628b2e9f36f79d57f129282012de.peerchecker.com",
    "a14ce7618821147ac2874000609bd4c3ca594d79.peerchecker.com",
    "9b97941c59a57bfe1cb9326c0adec2a1348e6940.peerchecker.com",
    "72e2dee3b6cc99167ecfb6114874cd9bf02f49e3.peerchecker.com",
    "0d028beb98c16f8eca4e1c9fb069dffd7a5a59ec.peerchecker.com",
    "c134ffe.peerchecker.com",
];

test("rejects historical and previously unseen static peerchecker relay hosts", () => {
    for (const host of RETIRED_RELAY_HOST_FIXTURES) {
        assert.equal(findStaticPeercheckerRelayHost(host), host);
    }

    const unseenHost = "abcdef0123456789.peerchecker.com";
    const representations = [
        `https://${unseenHost}/relay`,
        `/dns/${unseenHost}/tcp/443/wss`,
        `/dns6/${unseenHost}/tcp/443/wss`,
        `/dnsaddr/${unseenHost}/p2p/peer-id`,
        String.raw`\/dns4\/${unseenHost}\/tcp\/443\/wss`,
        encodeURIComponent(`/dns4/${unseenHost}/tcp/443/wss`),
    ];
    for (const source of representations) {
        assert.equal(findStaticPeercheckerRelayHost(source), unseenHost);
    }
});

test("keeps operational peerchecker DNS lease and bootstrap references valid", () => {
    const leaseHost = `p-${"a".repeat(20)}.nodes.peerchecker.com`;
    const allowedReferences = [
        "https://peerchecker.com/api/dns-leases",
        "https://api.peerchecker.com/dns-leases",
        leaseHost,
        `/dns4/${leaseHost}/tcp/443/wss`,
        "p-abcdef0123456789.peerchecker.com",
        "/dns4/stable-relay.peerchecker.com/tcp/443/wss",
        "/dns4/abcdef0123456789.peerchecker.org/tcp/443/wss",
        "/dns4/abcdef0123456789.peerchecker.com.example/tcp/443/wss",
        "https://bootstrap.peerbit.org/bootstrap-5.env",
    ];
    for (const source of allowedReferences) {
        assert.equal(findStaticPeercheckerRelayHost(source), undefined);
    }
});

test("does not positively allowlist peerchecker.com for app redirects", () => {
    const renderer = readFileSync(
        path.join(repoRoot, "scripts/render-cloudflare-configs.mjs"),
        "utf8"
    );
    assert.doesNotMatch(renderer, /peerchecker\.com/);
});
