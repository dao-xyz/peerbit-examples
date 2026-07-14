import assert from "node:assert/strict";
import test from "node:test";
import {
    loadCloudflareDeploymentData,
    selectCloudflareDeploymentEntries,
    validateCloudflareDeploymentPolicy,
    validateRenderedCloudflareConfig,
} from "../scripts/cloudflare-deployment-policy.mjs";
import {
    deployProductionEntries,
    readSingleVersionDeployment,
    withoutCloudflareDeploymentCredentials,
} from "../scripts/deploy-cloudflare-production.mjs";

const clone = (value) => structuredClone(value);
const COMMIT = "a".repeat(40);
const OLD_VERSION = "11111111-1111-4111-8111-111111111111";
const NEW_VERSION = "22222222-2222-4222-8222-222222222222";
const deployment = (versionId, percentage = 100) => ({
    versions: [{ version_id: versionId, percentage }],
});

test("production Workers and hostnames are an exact reviewed allowlist", () => {
    const { manifest, policy, entries } = loadCloudflareDeploymentData();
    assert.equal(entries.length, 9);
    assert.deepEqual(
        selectCloudflareDeploymentEntries(entries, "files").map(
            ({ policy: entry }) => entry
        ),
        [
            {
                id: "files",
                kind: "app",
                productionWorker: "peerbit-examples-files",
                previewWorker: "peerbit-examples-files-preview",
                productionHostnames: ["files.peerbit.org"],
            },
        ]
    );

    const widened = clone(manifest);
    widened.staticSites.find(({ id }) => id === "files").domains = [
        "admin.peerbit.org",
    ];
    assert.throws(
        () => validateCloudflareDeploymentPolicy(widened, policy),
        /must exactly equal \["files\.peerbit\.org"\]/
    );
});

test("preview and production Worker identities cannot overlap", () => {
    const { manifest, policy } = loadCloudflareDeploymentData();
    const crossed = clone(policy);
    crossed.entries[0].previewWorker = crossed.entries[0].productionWorker;
    assert.throws(
        () => validateCloudflareDeploymentPolicy(manifest, crossed),
        /preview and production Workers must differ/
    );
});

test("public previews are disabled", () => {
    const { entries } = loadCloudflareDeploymentData();
    for (const { policy } of entries) {
        assert.notEqual(policy.previewWorker, policy.productionWorker);
    }
});

test("redirects cannot leave the exact production hostname allowlist", () => {
    const { manifest, policy } = loadCloudflareDeploymentData();
    const redirected = clone(policy);
    const legacy = redirected.entries.find(({ id }) => id === "legacy-stream");
    legacy.redirectLocation = "https://example.com/collect";
    const changedManifest = clone(manifest);
    changedManifest.redirects[0].location = legacy.redirectLocation;
    assert.throws(
        () => validateCloudflareDeploymentPolicy(changedManifest, redirected),
        /allowlisted HTTPS production hostname/
    );
});

test("rendered configs cannot cross preview into production", () => {
    const { entries } = loadCloudflareDeploymentData();
    const { policy } = entries.find(({ site }) => site.id === "files");
    const production = {
        name: policy.productionWorker,
        workers_dev: false,
        preview_urls: false,
        routes: [
            {
                pattern: policy.productionHostnames[0],
                custom_domain: true,
            },
        ],
    };
    assert.equal(
        validateRenderedCloudflareConfig({
            config: production,
            policy,
            mode: "production",
        }),
        production
    );
    assert.throws(
        () =>
            validateRenderedCloudflareConfig({
                config: { ...production, name: policy.previewWorker },
                policy,
                mode: "production",
            }),
        /production Worker must exactly equal/
    );
    assert.throws(
        () =>
            validateRenderedCloudflareConfig({
                config: {
                    name: policy.previewWorker,
                    workers_dev: false,
                    preview_urls: false,
                    routes: production.routes,
                },
                policy,
                mode: "preview",
            }),
        /public preview routes are disabled/
    );
    const preview = {
        name: policy.previewWorker,
        workers_dev: false,
        preview_urls: false,
    };
    assert.equal(
        validateRenderedCloudflareConfig({
            config: preview,
            policy,
            mode: "preview",
        }),
        preview
    );
    assert.throws(
        () =>
            validateRenderedCloudflareConfig({
                config: { ...preview, workers_dev: true },
                policy,
                mode: "preview",
            }),
        /workers\.dev must be disabled/
    );
});

test("deployment status must provide one rollbackable version at 100%", () => {
    assert.equal(
        readSingleVersionDeployment(deployment(OLD_VERSION), "files"),
        OLD_VERSION
    );
    assert.throws(
        () =>
            readSingleVersionDeployment(
                {
                    versions: [
                        { version_id: OLD_VERSION, percentage: 50 },
                        { version_id: NEW_VERSION, percentage: 50 },
                    ],
                },
                "files"
            ),
        /exactly one valid version at 100%/
    );
});

test("verification children do not receive Cloudflare deployment credentials", () => {
    assert.deepEqual(
        withoutCloudflareDeploymentCredentials({
            PATH: "/bin",
            CLOUDFLARE_API_TOKEN: "secret",
            CLOUDFLARE_ACCOUNT_ID: "account",
        }),
        { PATH: "/bin" }
    );
});

const fixtureEntries = (ids) =>
    ids.map((id) => ({
        site: { id },
        policy: { id, kind: "app" },
    }));
const fixtureConfigs = (ids) =>
    new Map(ids.map((id) => [id, { file: `/${id}.jsonc` }]));

test("production deploys and verifies each app before touching the next", async () => {
    const events = [];
    const current = new Map([
        ["files", OLD_VERSION],
        ["giga", OLD_VERSION],
    ]);
    await deployProductionEntries({
        selectedEntries: fixtureEntries(["files", "giga"]),
        configs: fixtureConfigs(["files", "giga"]),
        expectedCommit: COMMIT,
        log: () => {},
        operations: {
            status: ({ site }) => deployment(current.get(site.id)),
            deploy: ({ site }) => {
                events.push(`deploy:${site.id}`);
                current.set(site.id, NEW_VERSION);
            },
            verify: ({ site, expectedCommit }) => {
                events.push(`verify:${site.id}:${Boolean(expectedCommit)}`);
            },
            rollback: () => assert.fail("rollback must not run"),
        },
    });
    assert.deepEqual(events, [
        "deploy:files",
        "verify:files:true",
        "deploy:giga",
        "verify:giga:true",
    ]);
});

test("failed verification restores and verifies the previous version", async () => {
    const events = [];
    let current = OLD_VERSION;
    let firstVerification = true;
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files", "giga"]),
            configs: fixtureConfigs(["files", "giga"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: {
                status: () => deployment(current),
                deploy: ({ site }) => {
                    events.push(`deploy:${site.id}`);
                    current = NEW_VERSION;
                },
                verify: ({ site, expectedCommit }) => {
                    events.push(`verify:${site.id}:${Boolean(expectedCommit)}`);
                    if (firstVerification) {
                        firstVerification = false;
                        throw new Error("runtime smoke failed");
                    }
                },
                rollback: ({ site, versionId }) => {
                    events.push(`rollback:${site.id}:${versionId}`);
                    current = versionId;
                },
            },
        }),
        /automatic rollback to .* succeeded/
    );
    assert.equal(current, OLD_VERSION);
    assert.deepEqual(events, [
        "deploy:files",
        "verify:files:true",
        `rollback:files:${OLD_VERSION}`,
        "verify:files:false",
    ]);
});

test("a deploy failure that changed nothing does not create a rollback", async () => {
    const events = [];
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: {
                status: () => deployment(OLD_VERSION),
                deploy: () => {
                    events.push("deploy");
                    throw new Error("upload rejected");
                },
                verify: ({ expectedCommit }) =>
                    events.push(`verify:${Boolean(expectedCommit)}`),
                rollback: () => events.push("rollback"),
            },
        }),
        /automatic rollback to .* succeeded/
    );
    assert.deepEqual(events, ["deploy", "verify:false"]);
});
