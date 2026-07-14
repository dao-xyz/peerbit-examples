import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, "cloudflare/sites.json"), "utf8")
);

test("keeps first-party apps in the apps.peerbit.org namespace", () => {
    const temporaryRoot = mkdtempSync(
        path.join(repoRoot, ".cloudflare-domain-test-")
    );
    const output = path.join(temporaryRoot, "configs");

    try {
        execFileSync(
            process.execPath,
            [
                "scripts/render-cloudflare-configs.mjs",
                "--mode",
                "production",
                "--output",
                output,
            ],
            { cwd: repoRoot, stdio: "pipe" }
        );

        for (const site of manifest.staticSites) {
            assert.ok(site.domains.length > 0);
            for (const domain of site.domains) {
                assert.match(domain, /^[a-z0-9-]+\.apps\.peerbit\.org$/);
            }

            const config = JSON.parse(
                readFileSync(path.join(output, `${site.id}.jsonc`), "utf8")
            );
            assert.equal(config.workers_dev, false);
            assert.equal(config.preview_urls, false);
            assert.deepEqual(
                config.routes,
                site.domains.map((domain) => ({
                    pattern: domain,
                    custom_domain: true,
                }))
            );
        }

        const legacy = manifest.redirects.find(
            (redirect) => redirect.id === "legacy-stream"
        );
        assert.ok(legacy);
        assert.equal(legacy.location, "https://stream.apps.peerbit.org/#/");
        const legacyConfig = JSON.parse(
            readFileSync(path.join(output, "legacy-stream.jsonc"), "utf8")
        );
        assert.deepEqual(legacyConfig.routes, [
            {
                pattern: "stream.peerchecker.com",
                custom_domain: true,
            },
        ]);
        assert.equal(
            legacyConfig.vars.CANONICAL_STREAM_URL,
            "https://stream.apps.peerbit.org/#/"
        );
    } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
    }
});
