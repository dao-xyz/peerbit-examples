import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { repoRoot } from "../scripts/cloudflare-deployment-policy.mjs";

const readWorkflow = (name) =>
    readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");

const previewWorkflow = readWorkflow("cloudflare-preview.yml");
const productionWorkflow = readWorkflow("cloudflare-production.yml");

test("credentialed production shell receives target and commit through env", () => {
    assert.match(
        productionWorkflow,
        /DEPLOY_TARGET: \$\{\{ inputs\.target \}\}/
    );
    assert.match(productionWorkflow, /DEPLOY_COMMIT: \$\{\{ github\.sha \}\}/);
    assert.match(productionWorkflow, /--target "\$DEPLOY_TARGET"/);
    assert.match(productionWorkflow, /--commit "\$DEPLOY_COMMIT"/);
    assert.doesNotMatch(
        productionWorkflow,
        /--target[^\n]*\$\{\{[^\n]*inputs\.target/
    );
    assert.doesNotMatch(
        productionWorkflow,
        /--commit[^\n]*\$\{\{[^\n]*github\.sha/
    );
});

test("Cloudflare workflows explicitly disable account auth and carry no credentials", () => {
    for (const workflow of [previewWorkflow, productionWorkflow]) {
        assert.match(workflow, /VITE_SUPABASE_AUTH_ENABLED: "false"/);
        assert.doesNotMatch(workflow, /^\s*VITE_SUPABASE_(?:URL|ANON_KEY):/m);
    }
});

test("preview hosting is validation-only and has no Cloudflare credentials", () => {
    assert.doesNotMatch(
        previewWorkflow,
        /CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|\$\{\{\s*secrets\./
    );
    assert.doesNotMatch(
        previewWorkflow,
        /environment:\s*cloudflare-production/
    );
    assert.match(previewWorkflow, /--dry-run/);
});

test("production deployment remains manually gated", () => {
    assert.match(productionWorkflow, /^on:\n\s+workflow_dispatch:/m);
    assert.doesNotMatch(productionWorkflow, /^\s+(?:push|pull_request):/m);
    assert.match(
        productionWorkflow,
        /inputs\.confirm == 'deploy-peerbit-production'/
    );
    assert.match(productionWorkflow, /environment: cloudflare-production/);
});
