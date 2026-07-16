import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
    findForbiddenStaticPeercheckerHost,
    hasAuthoritativeBootstrapEndpoint,
} from "../scripts/static-relay-policy.mjs";

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);

// These are known fixtures, not an exhaustive blocklist. The matcher must
// reject future direct all-hex pins without asserting whether a host is live.
const FORBIDDEN_STATIC_HOST_FIXTURES = [
    "8e0829c4b09e628b2e9f36f79d57f129282012de.peerchecker.com",
    "a14ce7618821147ac2874000609bd4c3ca594d79.peerchecker.com",
    "9b97941c59a57bfe1cb9326c0adec2a1348e6940.peerchecker.com",
    "72e2dee3b6cc99167ecfb6114874cd9bf02f49e3.peerchecker.com",
    "0d028beb98c16f8eca4e1c9fb069dffd7a5a59ec.peerchecker.com",
    "c134ffe.peerchecker.com",
];

test("rejects known and previously unseen direct-hex peerchecker pins", () => {
    for (const host of FORBIDDEN_STATIC_HOST_FIXTURES) {
        assert.equal(findForbiddenStaticPeercheckerHost(host), host);
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
        assert.equal(findForbiddenStaticPeercheckerHost(source), unseenHost);
    }
});

test("does not classify named runtime or reserved lease shapes as static pins", () => {
    const reservedManagedLeaseHost = `p-${"a".repeat(20)}.nodes.peerchecker.com`;
    const canonicalRuntimeReferences = [
        "/dns4/stable-relay.peerchecker.com/tcp/443/wss",
        "https://bootstrap.peerbit.org/bootstrap-5.env",
    ];
    // These shapes are reserved for planned managed-lease support. Their
    // exclusion from the static-pin matcher is not an operational guarantee.
    const reservedManagedLeaseReferences = [
        "https://peerchecker.com/api/dns-leases",
        "https://api.peerchecker.com/dns-leases",
        reservedManagedLeaseHost,
        `/dns4/${reservedManagedLeaseHost}/tcp/443/wss`,
    ];
    const boundaryReferences = [
        "p-abcdef0123456789.peerchecker.com",
        "/dns4/abcdef0123456789.peerchecker.org/tcp/443/wss",
        "/dns4/abcdef0123456789.peerchecker.com.example/tcp/443/wss",
    ];
    for (const source of [
        ...canonicalRuntimeReferences,
        ...reservedManagedLeaseReferences,
        ...boundaryReferences,
    ]) {
        assert.equal(findForbiddenStaticPeercheckerHost(source), undefined);
    }
});

test("does not positively allowlist peerchecker.com for app redirects", () => {
    const renderer = readFileSync(
        path.join(repoRoot, "scripts/render-cloudflare-configs.mjs"),
        "utf8"
    );
    assert.doesNotMatch(renderer, /peerchecker\.com/);
});

test("recognizes only reviewed authoritative bootstrap URL forms", () => {
    assert.equal(
        hasAuthoritativeBootstrapEndpoint(
            "https://bootstrap.peerbit.org/bootstrap-5.env"
        ),
        true
    );
    assert.equal(
        hasAuthoritativeBootstrapEndpoint(
            'const e=`bootstrap${version ? "-" + encodeURIComponent(version) : ""}.env`;return [`https://bootstrap.peerbit.org/${e}`]'
        ),
        true
    );

    for (const source of [
        "https://bootstrap.peerbit.org/",
        "const e=`bootstrap${version}.env`;return [`http://bootstrap.peerbit.org/${e}`]",
        "const e=`bootstrap${version}.txt`;return [`https://bootstrap.peerbit.org/${e}`]",
        "const e=`bootstrap${version}.env`;return [`https://bootstrap.peerbit.org/${other}`]",
    ]) {
        assert.equal(hasAuthoritativeBootstrapEndpoint(source), false);
    }
});
