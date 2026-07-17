import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { repoRoot } from "../scripts/cloudflare-deployment-policy.mjs";

const readWorkflow = (name) =>
    readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");

const previewWorkflow = readWorkflow("cloudflare-preview.yml");
const productionWorkflow = readWorkflow("cloudflare-production.yml");
const provisioningWorkflow = readWorkflow(
    "cloudflare-production-provision.yml"
);
const versionSchemaDiagnosticWorkflow = readWorkflow(
    "cloudflare-version-schema-diagnostic.yml"
);
const assetRuntimeSchemaDiagnosticWorkflow = readWorkflow(
    "cloudflare-asset-runtime-schema-diagnostic.yml"
);
const fileShareCiWorkflow = readWorkflow("file-share-ci.yml");
const provisioningScript = readFileSync(
    path.join(repoRoot, "scripts/provision-cloudflare-production.mjs"),
    "utf8"
);
const deploymentScript = readFileSync(
    path.join(repoRoot, "scripts/deploy-cloudflare-production.mjs"),
    "utf8"
);

const pinnedWorkflowActions = new Map([
    ["actions/checkout", "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"],
    ["actions/setup-node", "820762786026740c76f36085b0efc47a31fe5020"],
    ["pnpm/action-setup", "0ebf47130e4866e96fce0953f49152a61190b271"],
    ["actions/download-artifact", "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"],
    ["actions/upload-artifact", "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"],
    ["actions/setup-go", "924ae3a1cded613372ab5595356fb5720e22ba16"],
    ["changesets/action", "a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d"],
]);

test("every remote workflow action is pinned to its reviewed commit", () => {
    const workflowsDirectory = path.join(repoRoot, ".github/workflows");
    const observedActions = new Set();

    for (const name of readdirSync(workflowsDirectory).sort()) {
        if (!/\.ya?ml$/.test(name)) {
            continue;
        }
        const workflow = readFileSync(
            path.join(workflowsDirectory, name),
            "utf8"
        );
        for (const [index, line] of workflow.split("\n").entries()) {
            const match = line.match(/^\s*uses:\s*([^\s#]+)/);
            if (!match || match[1].startsWith("./")) {
                continue;
            }
            const action = match[1].match(/^([^@]+)@([0-9a-f]{40})$/);
            assert.ok(
                action,
                `${name}:${index + 1} must pin its remote action to an exact 40-character commit SHA`
            );
            const expectedCommit = pinnedWorkflowActions.get(action[1]);
            assert.equal(
                typeof expectedCommit,
                "string",
                `${name}:${index + 1} uses an unreviewed remote action: ${action[1]}`
            );
            assert.equal(
                action[2],
                expectedCommit,
                `${name}:${index + 1} does not use the reviewed commit for ${action[1]}`
            );
            observedActions.add(action[1]);
        }
    }

    assert.deepEqual(observedActions, new Set(pinnedWorkflowActions.keys()));
});

test("file-share CI tracks both the active benchmark and retired workflow sentinel", () => {
    assert.match(
        readWorkflow("file-share-two-runner-artifact-benchmarks.yml"),
        /^name: File Share Two-Runner Artifact Benchmarks$/m
    );
    for (const workflowPath of [
        ".github/workflows/file-share-benchmarks.yml",
        ".github/workflows/file-share-two-runner-artifact-benchmarks.yml",
        ".github/workflows/file-share-two-runner-benchmarks.yml",
        "scripts/summarize-file-share-benchmarks*.mjs",
    ]) {
        assert.equal(
            fileShareCiWorkflow.split(`- "${workflowPath}"`).length - 1,
            2,
            `${workflowPath} must trigger file-share CI for pull requests and master pushes`
        );
    }
});

const receiptValidationScripts = () => {
    const stepMarker =
        "            - name: Validate SHA-bound dispatch receipt";
    const runMarker = "              run: |\n";
    return provisioningWorkflow
        .split(stepMarker)
        .slice(1)
        .map((block) => {
            const source = block.split(runMarker, 2)[1];
            assert.equal(typeof source, "string");
            const lines = [];
            for (const line of source.split("\n")) {
                if (line.startsWith("                  ")) {
                    lines.push(line.slice(18));
                } else if (line.length === 0) {
                    lines.push("");
                } else {
                    break;
                }
            }
            return lines.join("\n");
        });
};

test("credentialed production shell receives target and commit through env", () => {
    assert.match(
        productionWorkflow,
        /DEPLOY_TARGET: \$\{\{ inputs\.target \}\}/
    );
    assert.match(productionWorkflow, /DEPLOY_COMMIT: \$\{\{ github\.sha \}\}/);
    assert.match(
        productionWorkflow,
        /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/
    );
    assert.match(
        productionWorkflow,
        /CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256 \}\}/
    );
    assert.doesNotMatch(
        productionWorkflow,
        /vars\.(?:CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256)/
    );
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
    for (const workflow of [
        previewWorkflow,
        productionWorkflow,
        provisioningWorkflow,
        versionSchemaDiagnosticWorkflow,
        assetRuntimeSchemaDiagnosticWorkflow,
    ]) {
        assert.doesNotMatch(workflow, /VITE_SUPABASE_/);
    }
});

test("asset runtime schema inspection is bot-only, first-attempt-only, and account-bound", () => {
    assert.match(
        assetRuntimeSchemaDiagnosticWorkflow,
        /"\$GITHUB_ACTOR" != "peerbit-org"/
    );
    assert.match(
        assetRuntimeSchemaDiagnosticWorkflow,
        /"\$GITHUB_TRIGGERING_ACTOR" != "peerbit-org"/
    );
    assert.match(
        assetRuntimeSchemaDiagnosticWorkflow,
        /"\$GITHUB_RUN_ATTEMPT" != "1"/
    );
    assert.match(
        assetRuntimeSchemaDiagnosticWorkflow,
        /CLOUDFLARE_RUNTIME_DIAGNOSTIC_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_RUNTIME_DIAGNOSTIC_API_TOKEN \}\}/
    );
    assert.match(assetRuntimeSchemaDiagnosticWorkflow, /Workers Scripts Read/);
    assert.match(
        assetRuntimeSchemaDiagnosticWorkflow,
        /Zone Read for all account zones/
    );
    assert.doesNotMatch(
        assetRuntimeSchemaDiagnosticWorkflow,
        /Workers Routes Read/
    );
    assert.doesNotMatch(
        assetRuntimeSchemaDiagnosticWorkflow,
        /CLOUDFLARE_PRODUCTION_API_TOKEN/
    );
    assert.match(
        assetRuntimeSchemaDiagnosticWorkflow,
        /CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256 \}\}/
    );
    assert.doesNotMatch(
        assetRuntimeSchemaDiagnosticWorkflow,
        /vars\.CLOUDFLARE_/
    );
});

test("preview hosting is validation-only and has no Cloudflare credentials", () => {
    assert.doesNotMatch(
        previewWorkflow,
        /CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256|\$\{\{\s*secrets\./
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
    assert.match(productionWorkflow, /Zone Read/);
    assert.match(
        productionWorkflow,
        /Workers Routes Read across every account zone/
    );
    assert.doesNotMatch(productionWorkflow, /initialize_missing_workers/);
});

test("locked Wrangler is installed before its source contract tests", () => {
    for (const workflow of [
        previewWorkflow,
        productionWorkflow,
        provisioningWorkflow,
    ]) {
        const install = workflow.indexOf(
            "npm ci --no-audit --no-fund --prefix tools/wrangler"
        );
        const toolchain = workflow.indexOf(
            "node scripts/validate-wrangler-toolchain.mjs"
        );
        const safetyTests = workflow.indexOf(
            "node --test cloudflare/*.test.mjs"
        );
        assert.ok(install >= 0);
        assert.ok(toolchain > install);
        assert.ok(safetyTests > toolchain);
    }
});

test("one-time provisioning is protected, explicit, and serialized with routine deploys", () => {
    assert.match(provisioningWorkflow, /^on:\n\s+workflow_dispatch:/m);
    assert.doesNotMatch(provisioningWorkflow, /^\s+(?:push|pull_request):/m);
    assert.match(
        provisioningWorkflow,
        /planned_commit:\n\s+description:[^\n]+\n\s+required: true\n\s+type: string/
    );
    assert.match(
        provisioningWorkflow,
        /planned_state_digest:\n\s+description:[^\n]+\n\s+required: true\n\s+type: string/
    );
    assert.equal(
        (
            provisioningWorkflow.match(
                /- name: Validate SHA-bound dispatch receipt/g
            ) ?? []
        ).length,
        2
    );
    assert.match(provisioningWorkflow, /if: always\(\)/);
    assert.match(
        provisioningWorkflow,
        /\[\[ ! "\$PROVISION_PLANNED_COMMIT" =~ \^\[0-9a-fA-F\]\{40\}\$ \]\]/
    );
    assert.match(
        provisioningWorkflow,
        /if \[\[ "\$planned_commit" != "\$checked_out_commit" \]\]/
    );
    assert.match(
        provisioningWorkflow,
        /"\$PROVISION_CONFIRM" != "\$confirmation"/
    );
    assert.match(
        provisioningWorkflow,
        /VALIDATE_RESULT: \$\{\{ needs\.validate\.result \}\}/
    );
    assert.equal(
        (provisioningWorkflow.match(/ref: \$\{\{ github\.sha \}\}/g) ?? [])
            .length,
        2
    );
    assert.doesNotMatch(
        provisioningWorkflow,
        /inputs\.confirm == '(?:plan|provision)-peerbit-production'/
    );
    assert.match(provisioningWorkflow, /environment: cloudflare-production/);
    assert.match(provisioningWorkflow, /Zone Read and Workers Routes/);
    assert.match(provisioningWorkflow, /Read across every account zone/);
    assert.match(provisioningWorkflow, /group: cloudflare-examples-production/);
    assert.match(
        provisioningWorkflow,
        /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_PRODUCTION_API_TOKEN \}\}/
    );
    assert.match(
        provisioningWorkflow,
        /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/
    );
    assert.match(
        provisioningWorkflow,
        /CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256 \}\}/
    );
    assert.doesNotMatch(
        provisioningWorkflow,
        /vars\.(?:CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256)/
    );
    assert.match(provisioningWorkflow, /--mode "\$PROVISION_MODE"/);
    assert.match(provisioningWorkflow, /--commit "\$PROVISION_COMMIT"/);
    assert.match(
        provisioningWorkflow,
        /--planned-commit "\$PROVISION_PLANNED_COMMIT"/
    );
    assert.match(
        provisioningWorkflow,
        /--planned-state-digest "\$PROVISION_PLANNED_STATE_DIGEST"/
    );
    assert.match(provisioningWorkflow, /--confirm "\$PROVISION_CONFIRM"/);
    assert.doesNotMatch(
        provisioningWorkflow,
        /--(?:mode|commit|planned-commit|planned-state-digest|confirm)[^\n]*\$\{\{/
    );
});

test("both provisioning jobs reject adversarial commit receipts with a nonzero step", () => {
    const commit = "a".repeat(40);
    const otherCommit = "b".repeat(40);
    const sentinel = "0".repeat(64);
    const digest = "1".repeat(64);
    const receiptScripts = receiptValidationScripts();
    assert.equal(receiptScripts.length, 2);
    const cases = [
        {
            name: "valid plan",
            mode: "plan",
            plannedCommit: commit,
            checkedOutCommit: commit,
            confirm: `plan-peerbit-production-${commit}`,
            stateDigest: sentinel,
            ref: "refs/heads/master",
            succeeds: true,
        },
        {
            name: "valid uppercase receipt",
            mode: "apply",
            plannedCommit: commit.toUpperCase(),
            checkedOutCommit: commit,
            confirm: `provision-peerbit-production-${commit}-${digest}`,
            stateDigest: digest,
            ref: "refs/heads/master",
            succeeds: true,
        },
        {
            name: "short receipt",
            mode: "apply",
            plannedCommit: commit.slice(0, 12),
            checkedOutCommit: commit,
            confirm: `provision-peerbit-production-${commit}`,
            stateDigest: digest,
            ref: "refs/heads/master",
            succeeds: false,
        },
        {
            name: "different planned commit",
            mode: "apply",
            plannedCommit: otherCommit,
            checkedOutCommit: commit,
            confirm: `provision-peerbit-production-${otherCommit}`,
            stateDigest: digest,
            ref: "refs/heads/master",
            succeeds: false,
        },
        {
            name: "generic confirmation",
            mode: "apply",
            plannedCommit: commit,
            checkedOutCommit: commit,
            confirm: "provision-peerbit-production",
            stateDigest: digest,
            ref: "refs/heads/master",
            succeeds: false,
        },
        {
            name: "plan with nonzero state receipt",
            mode: "plan",
            plannedCommit: commit,
            checkedOutCommit: commit,
            confirm: `plan-peerbit-production-${commit}`,
            stateDigest: digest,
            ref: "refs/heads/master",
            succeeds: false,
        },
        {
            name: "apply with plan sentinel",
            mode: "apply",
            plannedCommit: commit,
            checkedOutCommit: commit,
            confirm: `provision-peerbit-production-${commit}-${sentinel}`,
            stateDigest: sentinel,
            ref: "refs/heads/master",
            succeeds: false,
        },
        {
            name: "confirmation bound to another commit",
            mode: "plan",
            plannedCommit: commit,
            checkedOutCommit: commit,
            confirm: `plan-peerbit-production-${otherCommit}`,
            stateDigest: sentinel,
            ref: "refs/heads/master",
            succeeds: false,
        },
        {
            name: "non-master ref",
            mode: "plan",
            plannedCommit: commit,
            checkedOutCommit: commit,
            confirm: `plan-peerbit-production-${commit}`,
            stateDigest: sentinel,
            ref: "refs/heads/not-master",
            succeeds: false,
        },
        {
            name: "invalid mode",
            mode: "destroy",
            plannedCommit: commit,
            checkedOutCommit: commit,
            confirm: `plan-peerbit-production-${commit}`,
            stateDigest: sentinel,
            ref: "refs/heads/master",
            succeeds: false,
        },
        {
            name: "malformed checked-out commit",
            mode: "plan",
            plannedCommit: commit,
            checkedOutCommit: "not-a-commit",
            confirm: `plan-peerbit-production-${commit}`,
            stateDigest: sentinel,
            ref: "refs/heads/master",
            succeeds: false,
        },
    ];

    for (const [jobIndex, script] of receiptScripts.entries()) {
        const jobName = jobIndex === 0 ? "validate" : "provision";
        for (const input of cases) {
            const result = spawnSync("bash", ["-c", script], {
                encoding: "utf8",
                env: {
                    ...process.env,
                    GITHUB_REF: input.ref,
                    PROVISION_MODE: input.mode,
                    PROVISION_CONFIRM: input.confirm,
                    PROVISION_PLANNED_COMMIT: input.plannedCommit,
                    PROVISION_PLANNED_STATE_DIGEST: input.stateDigest,
                    PROVISION_COMMIT: input.checkedOutCommit,
                },
            });
            assert.equal(
                result.status === 0,
                input.succeeds,
                `${jobName}/${input.name}: ${result.stderr}`
            );
        }
    }
});

test("one-time provisioning rebuilds exact bundles and never invokes Worker delete", () => {
    assert.match(
        provisioningWorkflow,
        /node scripts\/render-cloudflare-configs\.mjs --mode production/
    );
    assert.match(provisioningWorkflow, /wrangler versions upload/);
    assert.match(provisioningWorkflow, /--dry-run/);
    assert.match(provisioningScript, /runWranglerInitialDeploy/);
    assert.match(
        provisioningScript,
        /deploy-initial-route-free-private-baseline/
    );
    assert.match(deploymentScript, /command: \["deploy"\]/);
    assert.match(deploymentScript, /deployment\.targets\.length !== 0/);
    assert.equal(
        (
            provisioningWorkflow.match(
                /node scripts\/create-cloudflare-artifact-manifests\.mjs/g
            ) ?? []
        ).length,
        2
    );
    assert.equal(
        (
            provisioningWorkflow.match(
                /output="\$PWD\/\.wrangler-dry-run\/\$\(basename "\$config" \.jsonc\)"/g
            ) ?? []
        ).length,
        2
    );
    assert.equal(
        (provisioningWorkflow.match(/--outdir "\$output"/g) ?? []).length,
        2
    );
    assert.match(
        provisioningWorkflow,
        /node scripts\/provision-cloudflare-production\.mjs/
    );
    assert.match(
        provisioningWorkflow,
        /Install Chromium for live baseline checks\n\s+if: inputs\.mode == 'apply'/
    );
    assert.doesNotMatch(
        provisioningWorkflow,
        /wrangler delete|workers\/scripts\/.*DELETE/
    );
    const lastManifest = provisioningWorkflow.lastIndexOf(
        "node scripts/create-cloudflare-artifact-manifests.mjs"
    );
    const credentialedProvision = provisioningWorkflow.indexOf(
        "CLOUDFLARE_API_TOKEN:"
    );
    assert.ok(lastManifest >= 0);
    assert.ok(credentialedProvision > lastManifest);
    assert.doesNotMatch(
        provisioningWorkflow.slice(
            provisioningWorkflow.indexOf(
                "- name: Rebuild reviewed inputs without deployment credentials"
            ),
            credentialedProvision
        ),
        /CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256/
    );

    const source = readFileSync(
        path.join(repoRoot, "scripts/provision-cloudflare-production.mjs"),
        "utf8"
    );
    assert.doesNotMatch(source, /method:\s*["']DELETE["']/);
    assert.doesNotMatch(source, /wrangler["'],\s*\[[^\]]*["']delete["']/s);
});

test("protected zone fingerprint is omitted from every uncredentialed workflow phase", () => {
    assert.equal(
        (
            productionWorkflow.match(
                /CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256:/g
            ) ?? []
        ).length,
        1
    );
    assert.equal(
        (
            provisioningWorkflow.match(
                /CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256:/g
            ) ?? []
        ).length,
        1
    );
    assert.equal(
        (
            previewWorkflow.match(
                /CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256:/g
            ) ?? []
        ).length,
        0
    );
    assert.doesNotMatch(
        productionWorkflow.slice(
            0,
            productionWorkflow.indexOf("CLOUDFLARE_API_TOKEN:")
        ),
        /CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256/
    );
});

test("every action in Cloudflare workflows is pinned to a full commit", () => {
    for (const workflow of [
        previewWorkflow,
        productionWorkflow,
        provisioningWorkflow,
        versionSchemaDiagnosticWorkflow,
        assetRuntimeSchemaDiagnosticWorkflow,
    ]) {
        const uses = workflow.match(/^\s+-?\s*uses:\s*([^\s#]+)/gm) ?? [];
        assert.ok(uses.length > 0);
        for (const line of uses) {
            assert.match(line, /@[0-9a-f]{40}$/i);
        }
    }
});
