import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    assertAccountAuthDisabledBuild,
    assertAccountAuthDisabledEnvironment,
    assertAccountAuthDisabledManifest,
    RETIRED_SUPABASE_PROJECT_REF,
} from "./account-auth-policy.mjs";

test("accepts an explicit disabled build without credentials", () => {
    assert.doesNotThrow(() =>
        assertAccountAuthDisabledEnvironment({
            VITE_SUPABASE_AUTH_ENABLED: "false",
        })
    );
});

test("requires an explicit disabled flag", () => {
    assert.throws(
        () => assertAccountAuthDisabledEnvironment({}),
        /must be exactly "false"/
    );
    assert.throws(
        () =>
            assertAccountAuthDisabledEnvironment({
                VITE_SUPABASE_AUTH_ENABLED: "true",
            }),
        /must be exactly "false"/
    );
});

test("rejects credentials even when auth is disabled", () => {
    assert.throws(
        () =>
            assertAccountAuthDisabledEnvironment({
                VITE_SUPABASE_AUTH_ENABLED: "false",
                VITE_SUPABASE_URL: "https://example.supabase.co",
                VITE_SUPABASE_ANON_KEY: "stale-key",
            }),
        /VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY/
    );
});

test("requires the Giga manifest to declare disabled account auth", () => {
    assert.doesNotThrow(() =>
        assertAccountAuthDisabledManifest({
            staticSites: [{ id: "giga", accountAuth: "disabled" }],
        })
    );
    assert.throws(
        () =>
            assertAccountAuthDisabledManifest({
                staticSites: [{ id: "giga" }],
            }),
        /accountAuth/
    );
});

test("rejects Supabase configuration in the built assets", (t) => {
    const directory = mkdtempSync(
        path.join(os.tmpdir(), "peerbit-auth-build-")
    );
    t.after(() => rmSync(directory, { force: true, recursive: true }));
    mkdirSync(path.join(directory, "assets"));
    const bundle = path.join(directory, "assets", "app.js");

    writeFileSync(bundle, 'console.log("account auth disabled")');
    assert.doesNotThrow(() => assertAccountAuthDisabledBuild(directory));

    writeFileSync(bundle, `const ref = "${RETIRED_SUPABASE_PROJECT_REF}"`);
    assert.throws(
        () => assertAccountAuthDisabledBuild(directory),
        /retired Supabase project/
    );

    writeFileSync(
        bundle,
        'const url = "https://freshproject.supabase.co/auth/v1"'
    );
    assert.throws(
        () => assertAccountAuthDisabledBuild(directory),
        /contains a Supabase project URL/
    );

    writeFileSync(bundle, 'const key = "sb_publishable_example"');
    assert.throws(
        () => assertAccountAuthDisabledBuild(directory),
        /contains a Supabase publishable key/
    );
});
