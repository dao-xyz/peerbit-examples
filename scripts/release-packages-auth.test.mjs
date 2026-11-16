import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as authModule from "./release-packages-auth.mjs";
import {
    TRUSTED_PUBLISHING_NPM_VERSION,
    npmCanUseTrustedPublishing,
    npmPublishAuth,
} from "./release-packages-auth.mjs";

// What a GitHub Actions job granted `id-token: write` sees.
const idTokenEnv = {
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/request",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
};
const npm11 = "11.19.1";
const npm10 = "10.9.8";

test("publishes with an npm token when one is set", () => {
    for (const env of [
        { NPM_TOKEN: "npm-token" },
        { NODE_AUTH_TOKEN: "npm-token" },
        { NPM_TOKEN: "npm-token", NODE_AUTH_TOKEN: "npm-token" },
    ]) {
        for (const npmVersion of [npm10, npm11, undefined]) {
            assert.deepEqual(npmPublishAuth(env, npmVersion), {
                ok: true,
                trustedPublishing: false,
                summary: "the npm token",
            });
        }
    }
});

test("publishes with trusted publishing when the job can request an id-token", () => {
    assert.deepEqual(npmPublishAuth(idTokenEnv, npm11), {
        ok: true,
        trustedPublishing: true,
        summary: `npm trusted publishing (npm ${npm11})`,
    });
    // A missing secret reaches the job as an empty string.
    assert.deepEqual(
        npmPublishAuth(
            { ...idTokenEnv, NPM_TOKEN: "", NODE_AUTH_TOKEN: "" },
            TRUSTED_PUBLISHING_NPM_VERSION
        ),
        {
            ok: true,
            trustedPublishing: true,
            summary: `npm trusted publishing (npm ${TRUSTED_PUBLISHING_NPM_VERSION})`,
        }
    );
});

test("keeps a set npm token as the fallback for trusted publishing", () => {
    for (const token of [{ NPM_TOKEN: "t" }, { NODE_AUTH_TOKEN: "t" }]) {
        assert.deepEqual(npmPublishAuth({ ...idTokenEnv, ...token }, npm11), {
            ok: true,
            trustedPublishing: true,
            summary: `npm trusted publishing (npm ${npm11}), with the npm token as fallback`,
        });
    }
});

test("refuses without a token or an id-token, naming both", () => {
    for (const env of [
        {},
        { NPM_TOKEN: "", NODE_AUTH_TOKEN: "" },
        // Both id-token variables are needed to request one.
        {
            ACTIONS_ID_TOKEN_REQUEST_URL:
                idTokenEnv.ACTIONS_ID_TOKEN_REQUEST_URL,
        },
        {
            ACTIONS_ID_TOKEN_REQUEST_TOKEN:
                idTokenEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
        },
    ]) {
        const auth = npmPublishAuth(env, npm11);
        assert.equal(auth.ok, false);
        assert.match(auth.reason, /trusted publishing/);
        assert.match(auth.reason, /id-token: write/);
        assert.match(auth.reason, /NPM_TOKEN or NODE_AUTH_TOKEN/);
    }
});

test("refuses trusted publishing with an npm that predates it", () => {
    for (const npmVersion of [npm10, "11.4.2", "11.5.0", "", undefined]) {
        const auth = npmPublishAuth(idTokenEnv, npmVersion);
        assert.equal(auth.ok, false, String(npmVersion));
        assert.match(auth.reason, /needs npm 11\.5\.1 or later/);
        assert.match(auth.reason, /NPM_TOKEN or NODE_AUTH_TOKEN/);
    }
    // A token still publishes, and the summary says why it is not OIDC.
    assert.deepEqual(npmPublishAuth({ ...idTokenEnv, NPM_TOKEN: "t" }, npm10), {
        ok: true,
        trustedPublishing: false,
        summary: `the npm token: npm ${npm10} predates trusted publishing (11.5.1)`,
    });
});

test("compares npm versions part by part", () => {
    for (const version of ["11.5.1", "11.5.2", "11.6.0", "11.10.0", "12.0.0"]) {
        assert.equal(npmCanUseTrustedPublishing(version), true, version);
    }
    assert.equal(npmCanUseTrustedPublishing("11.19.1\n"), true);
    for (const version of ["11.5.0", "11.4.10", "10.99.99", "9.9.4"]) {
        assert.equal(npmCanUseTrustedPublishing(version), false, version);
    }
    for (const version of [undefined, "", "eleven", "11.5"]) {
        assert.equal(npmCanUseTrustedPublishing(version), false, version);
    }
});

// Importing the release script would run a release, so check its import of
// this module by reading it.
test("the release script imports names this module exports", async () => {
    const script = await readFile(
        new URL("./release-packages.mjs", import.meta.url),
        "utf8"
    );
    const imported = script.match(
        /import \{([^}]+)\} from "\.\/release-packages-auth\.mjs";/
    );
    assert.ok(imported, "release-packages.mjs imports release-packages-auth");
    for (const name of imported[1].split(",")) {
        if (name.trim()) {
            assert.ok(name.trim() in authModule, name.trim());
        }
    }
});
