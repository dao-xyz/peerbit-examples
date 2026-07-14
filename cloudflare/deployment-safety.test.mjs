import assert from "node:assert/strict";
import test from "node:test";
import {
    loadCloudflareDeploymentData,
    repoRoot,
    resolveCloudflareConfigOutputDirectory,
    selectCloudflareDeploymentEntries,
    validateCloudflareDeploymentPolicy,
    validateRenderedCloudflareConfig,
} from "../scripts/cloudflare-deployment-policy.mjs";
import {
    deployProductionEntries,
    productionSmokeEnvironment,
    readBaselineReleaseCommit,
    readSingleVersionDeployment,
    withoutCloudflareDeploymentCredentials,
} from "../scripts/deploy-cloudflare-production.mjs";

const clone = (value) => structuredClone(value);
const COMMIT = "a".repeat(40);
const OLD_COMMIT = "b".repeat(40);
const OLD_VERSION = "11111111-1111-4111-8111-111111111111";
const NEW_VERSION = "22222222-2222-4222-8222-222222222222";
const deployment = (versionId, percentage = 100) => ({
    versions: [{ version_id: versionId, percentage }],
});

test("production Workers and hostnames are an exact reviewed allowlist", () => {
    const { manifest, policy, entries } = loadCloudflareDeploymentData();
    assert.equal(entries.length, 7);
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
                productionHostnames: ["files.apps.peerbit.org"],
            },
        ]
    );

    const widened = clone(manifest);
    widened.staticSites.find(({ id }) => id === "files").domains = [
        "admin.peerbit.org",
    ];
    assert.throws(
        () => validateCloudflareDeploymentPolicy(widened, policy),
        /must exactly equal \["files\.apps\.peerbit\.org"\]/
    );
});

test("policy and manifest cannot jointly move an app outside apps.peerbit.org", () => {
    const { manifest, policy } = loadCloudflareDeploymentData();
    const changedManifest = clone(manifest);
    changedManifest.staticSites.find(({ id }) => id === "files").domains = [
        "files.example.com",
    ];
    const changedPolicy = clone(policy);
    changedPolicy.entries.find(({ id }) => id === "files").productionHostnames =
        ["files.example.com"];

    assert.throws(
        () =>
            validateCloudflareDeploymentPolicy(changedManifest, changedPolicy),
        /one label under \*\.apps\.peerbit\.org/
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

test("renderer output cannot resolve to the repository root", () => {
    assert.throws(
        () =>
            resolveCloudflareConfigOutputDirectory({
                root: repoRoot,
                output: ".",
            }),
        /non-root directory inside the repository/
    );
    assert.throws(
        () =>
            resolveCloudflareConfigOutputDirectory({
                root: repoRoot,
                output: "",
            }),
        /non-root directory inside the repository/
    );
    assert.throws(
        () =>
            resolveCloudflareConfigOutputDirectory({
                root: repoRoot,
                output: "../outside",
            }),
        /non-root directory inside the repository/
    );
});

test("retired peerchecker redirects cannot be selected for deployment", () => {
    const { manifest, entries } = loadCloudflareDeploymentData();
    assert.deepEqual(manifest.redirects, []);
    assert.throws(
        () => selectCloudflareDeploymentEntries(entries, "legacy-redirect"),
        /Unsupported Cloudflare deployment target/
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

test("runtime smoke origins come from the exact production policy", () => {
    const { entries } = loadCloudflareDeploymentData();
    assert.deepEqual(productionSmokeEnvironment(entries), {
        PW_BASE_URL: "https://files.apps.peerbit.org",
        PW_STREAM_URL: "https://stream.apps.peerbit.org",
    });
});

test("captures a full baseline release commit from the production app", async () => {
    const { entries } = loadCloudflareDeploymentData();
    const { site, policy } = entries.find(
        ({ site: entry }) => entry.id === "files"
    );
    let requestedUrl;
    const commit = await readBaselineReleaseCommit({
        site,
        policy,
        request: async (url) => {
            requestedUrl = url;
            return {
                status: 200,
                json: async () => ({ site: "files", commit: OLD_COMMIT }),
            };
        },
    });
    assert.equal(requestedUrl, "https://files.apps.peerbit.org/release.json");
    assert.equal(commit, OLD_COMMIT);

    await assert.rejects(
        readBaselineReleaseCommit({
            site,
            policy,
            request: async () => ({
                status: 200,
                json: async () => ({ site: "files", commit: "short" }),
            }),
        }),
        /full Git commit hash/
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
        ["stream", OLD_VERSION],
    ]);
    await deployProductionEntries({
        selectedEntries: fixtureEntries(["files", "stream"]),
        configs: fixtureConfigs(["files", "stream"]),
        expectedCommit: COMMIT,
        log: () => {},
        operations: {
            status: ({ site }) => deployment(current.get(site.id)),
            readReleaseCommit: () => OLD_COMMIT,
            deploy: ({ site }) => {
                events.push(`deploy:${site.id}`);
                current.set(site.id, NEW_VERSION);
            },
            verify: ({ site, expectedCommit }) => {
                events.push(`verify:${site.id}:${expectedCommit}`);
            },
            rollback: () => assert.fail("rollback must not run"),
        },
    });
    assert.deepEqual(events, [
        "deploy:files",
        `verify:files:${COMMIT}`,
        "deploy:stream",
        `verify:stream:${COMMIT}`,
    ]);
});

test("an app deploy is blocked without a baseline release commit", async () => {
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: {
                status: () => deployment(OLD_VERSION),
                readReleaseCommit: () => undefined,
                deploy: () => assert.fail("deploy must not run"),
                verify: () => assert.fail("verify must not run"),
                rollback: () => assert.fail("rollback must not run"),
            },
        }),
        /requires a full rollback release commit/
    );
});

test("failed verification restores and verifies the previous version", async () => {
    const events = [];
    let current = OLD_VERSION;
    let firstVerification = true;
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files", "stream"]),
            configs: fixtureConfigs(["files", "stream"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: {
                status: () => deployment(current),
                readReleaseCommit: () => OLD_COMMIT,
                deploy: ({ site }) => {
                    events.push(`deploy:${site.id}`);
                    current = NEW_VERSION;
                },
                verify: ({ site, expectedCommit }) => {
                    events.push(`verify:${site.id}:${expectedCommit}`);
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
        `verify:files:${COMMIT}`,
        `rollback:files:${OLD_VERSION}`,
        `verify:files:${OLD_COMMIT}`,
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
                readReleaseCommit: () => OLD_COMMIT,
                deploy: () => {
                    events.push("deploy");
                    throw new Error("upload rejected");
                },
                verify: ({ expectedCommit }) =>
                    events.push(`verify:${expectedCommit}`),
                rollback: () => events.push("rollback"),
            },
        }),
        /automatic rollback to .* succeeded/
    );
    assert.deepEqual(events, ["deploy", `verify:${OLD_COMMIT}`]);
});
