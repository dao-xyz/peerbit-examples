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
    assert.doesNotMatch(
        productionWorkflow,
        /initialize_missing_workers|INITIALIZE_MISSING_WORKERS|initialize-missing-workers/
    );
});

test("Cloudflare workflows carry no Supabase build configuration", () => {
    for (const workflow of [previewWorkflow, productionWorkflow]) {
        assert.doesNotMatch(workflow, /VITE_SUPABASE_/);
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
    assert.match(previewWorkflow, /wrangler versions upload/);
});

test("every CI bundle check exercises the inactive versions-upload path", () => {
    for (const workflow of [previewWorkflow, productionWorkflow]) {
        assert.match(workflow, /wrangler versions upload/);
        assert.doesNotMatch(workflow, /wrangler deploy\s*\\\s*\n\s*--config/);
    }
});

test("production deployment remains manually gated", () => {
    assert.match(productionWorkflow, /^on:\n\s+workflow_dispatch:/m);
    assert.doesNotMatch(productionWorkflow, /^\s+(?:push|pull_request):/m);
    assert.match(
        productionWorkflow,
        /inputs\.confirm == 'deploy-peerbit-production'/
    );
    assert.match(productionWorkflow, /environment: cloudflare-production/);
    assert.doesNotMatch(productionWorkflow, /initialize_missing_workers/);
});

test("locked Wrangler is installed before its source contract tests", () => {
    for (const workflow of [previewWorkflow, productionWorkflow]) {
        const install = workflow.indexOf(
            "npm ci --ignore-scripts --no-audit --no-fund --prefix tools/wrangler"
        );
        const safetyTests = workflow.indexOf(
            "node --test cloudflare/*.test.mjs"
        );
        assert.ok(install >= 0);
        assert.ok(safetyTests > install);
    }
});
