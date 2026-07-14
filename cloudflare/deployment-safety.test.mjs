import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
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
    createRouteFreeWranglerConfig,
    deployProductionEntries as deployProductionEntriesWithPolicy,
    parseWranglerVersionUploadOutput,
    parseProductionDeploymentArgs,
    productionSmokeEnvironment,
    readBaselineReleaseCommit,
    readSingleVersionDeployment,
    removeTemporaryWranglerOutput,
    runCloudflareCapturedJson,
    runCloudflareLogged,
    runWranglerVersionUpload,
    withoutCloudflareDeploymentCredentials,
} from "../scripts/deploy-cloudflare-production.mjs";
import {
    CloudflareWorkersApiError,
    createCloudflareWorkersApi,
    redactCloudflareCredentials,
} from "../scripts/cloudflare-workers-api.mjs";

const clone = (value) => structuredClone(value);
const COMMIT = "a".repeat(40);
const OLD_COMMIT = "b".repeat(40);
const OLD_VERSION = "11111111-1111-4111-8111-111111111111";
const NEW_VERSION = "22222222-2222-4222-8222-222222222222";
const ZONE_ID = "e".repeat(32);
const WORKER_TAGS = new Map([
    ["files", "files-tag-11111111"],
    ["stream", "stream-tag-22222222"],
]);
const CLOUDFLARE_CREDENTIALS = {
    CLOUDFLARE_ACCOUNT_ID: "account-id-secret",
    CLOUDFLARE_API_TOKEN: "api-token-secret",
    CLOUDFLARE_API_KEY: "api-key-secret",
    CLOUDFLARE_EMAIL: "email-secret",
    CLOUDFLARE_ACCESS_CLIENT_ID: "access-client-id-secret",
    CLOUDFLARE_ACCESS_CLIENT_SECRET: "access-client-secret",
    CLOUDFLARE_SERVICE_TOKEN_ID: "service-token-id-secret",
    CLOUDFLARE_SERVICE_TOKEN_SECRET: "service-token-secret",
    CF_ACCOUNT_ID: "legacy-account-secret",
    CF_API_TOKEN: "legacy-token-secret",
    CF_API_KEY: "legacy-key-secret",
    CF_EMAIL: "legacy-email-secret",
    CF_API_BASE_URL: "legacy-base-url-secret",
    WRANGLER_CF_AUTHORIZATION_TOKEN: "wrangler-cf-auth-secret",
    WRANGLER_R2_SQL_AUTH_TOKEN: "r2-sql-secret",
};
const deployment = (versionId, percentage = 100) => ({
    versions: [{ version_id: versionId, percentage }],
});
const workerDomain = (id, overrides = {}) => ({
    id: "domain-" + id,
    hostname: id + ".apps.peerbit.org",
    service: "peerbit-examples-" + id,
    environment: "production",
    zoneId: ZONE_ID,
    zoneName: "peerbit.org",
    ...overrides,
});
const rawWorkerDomain = (id, overrides = {}) => ({
    id: "domain-" + id,
    hostname: id + ".example.com",
    service: "unrelated-worker-" + id,
    environment: "production",
    zone_id: ZONE_ID,
    zone_name: "example.com",
    ...overrides,
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

test("reviewed Worker identities stay inside the managed namespace", () => {
    const { manifest, policy } = loadCloudflareDeploymentData();
    for (const field of ["productionWorker", "previewWorker"]) {
        const changed = clone(policy);
        changed.entries[0][field] = "unrelated-account-worker";
        assert.throws(
            () => validateCloudflareDeploymentPolicy(manifest, changed),
            /inside the reviewed peerbit-examples- namespace/
        );
    }
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

const wranglerVersionUploadRecord = (overrides = {}) =>
    JSON.stringify({
        type: "version-upload",
        version: 1,
        worker_name: "peerbit-examples-files",
        worker_tag: WORKER_TAGS.get("files"),
        version_id: NEW_VERSION,
        worker_name_overridden: false,
        ...overrides,
    });

test("Wrangler structured output provides exact inactive-version ownership evidence", () => {
    assert.deepEqual(
        parseWranglerVersionUploadOutput(
            `${JSON.stringify({ type: "wrangler-session", version: 1 })}\n${wranglerVersionUploadRecord()}\n`,
            "peerbit-examples-files"
        ),
        {
            workerName: "peerbit-examples-files",
            workerTag: WORKER_TAGS.get("files"),
            versionId: NEW_VERSION,
        }
    );
    for (const [output, pattern] of [
        ["", /exactly one version-upload record/],
        ["null", /not valid NDJSON/],
        [
            `${wranglerVersionUploadRecord()}\n${wranglerVersionUploadRecord()}`,
            /exactly one version-upload record/,
        ],
        [
            wranglerVersionUploadRecord({
                worker_name: "peerbit-examples-stream",
            }),
            /invalid deployment ownership evidence/,
        ],
        [
            wranglerVersionUploadRecord({ worker_tag: "bad tag" }),
            /invalid deployment ownership evidence/,
        ],
        [
            wranglerVersionUploadRecord({ version_id: "not-a-version" }),
            /invalid deployment ownership evidence/,
        ],
        [
            wranglerVersionUploadRecord({ worker_name_overridden: true }),
            /unsupported identity metadata/,
        ],
    ]) {
        assert.throws(
            () =>
                parseWranglerVersionUploadOutput(
                    output,
                    "peerbit-examples-files"
                ),
            pattern
        );
    }

    const accountSlug = "private-account-slug";
    let previewFailure;
    try {
        parseWranglerVersionUploadOutput(
            wranglerVersionUploadRecord({
                preview_url: `https://version-files.${accountSlug}.workers.dev`,
            }),
            "peerbit-examples-files"
        );
    } catch (error) {
        previewFailure = error;
    }
    assert.ok(previewFailure instanceof Error);
    assert.match(previewFailure.message, /unexpected workers\.dev/);
    assert.doesNotMatch(previewFailure.message, new RegExp(accountSlug));
});

test("verification children do not receive Cloudflare deployment credentials", () => {
    assert.deepEqual(
        withoutCloudflareDeploymentCredentials({
            PATH: "/bin",
            PW_BASE_URL: "https://files.apps.peerbit.org",
            ...CLOUDFLARE_CREDENTIALS,
        }),
        {
            PATH: "/bin",
            PW_BASE_URL: "https://files.apps.peerbit.org",
        }
    );
    const failure = redactCloudflareCredentials(
        `failed for ${Object.values(CLOUDFLARE_CREDENTIALS).join(" ")}`,
        CLOUDFLARE_CREDENTIALS
    );
    for (const secret of Object.values(CLOUDFLARE_CREDENTIALS)) {
        assert.doesNotMatch(failure, new RegExp(secret));
    }
    assert.equal(
        failure.match(/\[REDACTED\]/g)?.length,
        Object.keys(CLOUDFLARE_CREDENTIALS).length
    );
    const longFailure = redactCloudflareCredentials(
        `${"x".repeat(600)} ${CLOUDFLARE_CREDENTIALS.CLOUDFLARE_API_TOKEN}`,
        CLOUDFLARE_CREDENTIALS
    );
    assert.ok(longFailure.length > 600);
    assert.doesNotMatch(longFailure, /api-token-secret/);
    assert.match(longFailure, /\[REDACTED\]$/);

    const accountId = "0123456789abcdef0123456789abcdef";
    const overlappingToken = `${accountId}-TOKEN-SUFFIX`;
    assert.equal(
        redactCloudflareCredentials(overlappingToken, {
            CLOUDFLARE_ACCOUNT_ID: accountId,
            CLOUDFLARE_API_TOKEN: overlappingToken,
            CF_API_TOKEN: overlappingToken,
        }),
        "[REDACTED]"
    );
});

test("credentialed Wrangler logs and spawn errors never expose Cloudflare credentials", () => {
    const secretText = Object.values(CLOUDFLARE_CREDENTIALS).join(" ");
    let stdout = "";
    let stderr = "";
    assert.throws(
        () =>
            runCloudflareLogged(
                "/tools/wrangler",
                ["deploy"],
                CLOUDFLARE_CREDENTIALS,
                {
                    run: () => ({
                        stdout: `stdout ${secretText}`,
                        stderr: `stderr ${secretText}`,
                        status: 1,
                    }),
                    writeStdout: (value) => {
                        stdout += value;
                    },
                    writeStderr: (value) => {
                        stderr += value;
                    },
                }
            ),
        /wrangler deploy exited 1/
    );
    for (const secret of Object.values(CLOUDFLARE_CREDENTIALS)) {
        assert.doesNotMatch(stdout, new RegExp(secret));
        assert.doesNotMatch(stderr, new RegExp(secret));
    }

    let spawnFailure;
    try {
        runCloudflareLogged(
            "/tools/wrangler",
            ["deploy"],
            CLOUDFLARE_CREDENTIALS,
            {
                run: () => ({
                    stdout: "",
                    stderr: "",
                    error: new Error(`spawn failed ${secretText}`),
                }),
            }
        );
    } catch (error) {
        spawnFailure = error;
    }
    assert.ok(spawnFailure instanceof Error);
    for (const secret of Object.values(CLOUDFLARE_CREDENTIALS)) {
        assert.doesNotMatch(spawnFailure.message, new RegExp(secret));
    }
});

test("temporary Wrangler output cleanup never masks the deployment result", () => {
    let warning = "";
    assert.doesNotThrow(() =>
        removeTemporaryWranglerOutput(
            "/tmp/private-output",
            CLOUDFLARE_CREDENTIALS,
            {
                remove: () => {
                    throw new Error(
                        `cleanup failed ${CLOUDFLARE_CREDENTIALS.CLOUDFLARE_API_TOKEN}`
                    );
                },
                writeWarning: (value) => {
                    warning = value;
                },
            }
        )
    );
    assert.match(
        warning,
        /could not remove temporary Wrangler deployment output/
    );
    assert.match(warning, /\[REDACTED\]/);
    assert.doesNotMatch(
        warning,
        new RegExp(CLOUDFLARE_CREDENTIALS.CLOUDFLARE_API_TOKEN)
    );

    assert.doesNotThrow(() =>
        removeTemporaryWranglerOutput(
            "/tmp/private-output",
            {},
            {
                remove: () => {
                    throw new Error("cleanup failed");
                },
                writeWarning: () => {
                    throw new Error("stderr unavailable");
                },
            }
        )
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

test("Cloudflare Workers API lists the configured account exactly", async () => {
    const accountId = "c".repeat(32);
    const apiToken = "test-token_123";
    const workerName = "peerbit-examples-files";
    const requests = [];
    const api = createCloudflareWorkersApi({
        accountId,
        apiToken,
        request: async (url, init) => {
            requests.push({ url, init });
            return new Response(
                JSON.stringify({
                    success: true,
                    result: [
                        {
                            id: workerName,
                            tag: WORKER_TAGS.get("files"),
                            routes: [],
                            tail_consumers: [
                                { service: "tail-consumer-worker" },
                            ],
                            logpush: true,
                        },
                        {
                            id: "unrelated-account-worker",
                            tag: "unrelated-worker-tag",
                            routes: [],
                        },
                    ],
                }),
                { status: 200 }
            );
        },
    });

    assert.deepEqual(
        [...(await api.listWorkerScripts())],
        [
            [
                workerName,
                {
                    tag: WORKER_TAGS.get("files"),
                    routes: [],
                    tailConsumers: [{ service: "tail-consumer-worker" }],
                    logpush: true,
                },
            ],
            [
                "unrelated-account-worker",
                {
                    tag: "unrelated-worker-tag",
                    routes: [],
                    tailConsumers: [],
                    logpush: false,
                },
            ],
        ]
    );

    const scriptsUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, scriptsUrl);
    assert.equal(requests[0].init.method, "GET");
    assert.equal(requests[0].init.headers.Authorization, `Bearer ${apiToken}`);

    assert.throws(
        () =>
            createCloudflareWorkersApi({
                accountId: "wrong-account",
                apiToken,
            }),
        /exactly 32 hexadecimal characters/
    );
});

test("Cloudflare Workers API reads exact workers.dev and Preview URL state", async () => {
    const accountId = "c".repeat(32);
    const apiToken = "test-token_123";
    const workerName = "peerbit-examples-files";
    const requests = [];
    const api = createCloudflareWorkersApi({
        accountId,
        apiToken,
        request: async (url, init) => {
            requests.push({ url, init });
            return new Response(
                JSON.stringify({
                    success: true,
                    result: { enabled: false, previews_enabled: false },
                }),
                { status: 200 }
            );
        },
    });

    assert.deepEqual(await api.getWorkerSubdomain(workerName), {
        enabled: false,
        previewsEnabled: false,
    });
    assert.equal(requests.length, 1);
    assert.equal(
        requests[0].url,
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/subdomain`
    );
    assert.equal(requests[0].init.method, "GET");
    assert.equal("body" in requests[0].init, false);
    assert.equal(requests[0].init.headers.Authorization, `Bearer ${apiToken}`);
});

test("Worker subdomain API ambiguity and authorization failures fail closed", async () => {
    const accountId = "c".repeat(32);
    const apiToken = "test-token_123";
    const responses = [
        () => new Response("{", { status: 200 }),
        () =>
            new Response(JSON.stringify({ success: true }), {
                status: 200,
            }),
        () =>
            new Response(
                JSON.stringify({
                    success: true,
                    result: { enabled: false },
                }),
                { status: 200 }
            ),
        () =>
            new Response(
                JSON.stringify({
                    success: true,
                    result: {
                        enabled: false,
                        previews_enabled: "false",
                    },
                }),
                { status: 200 }
            ),
        () =>
            new Response(
                JSON.stringify({
                    success: true,
                    result: {
                        enabled: false,
                        previews_enabled: false,
                        account_subdomain: "must-not-be-accepted",
                    },
                }),
                { status: 200 }
            ),
        () =>
            new Response(
                JSON.stringify({
                    success: false,
                    errors: [{ code: 10000, message: "unauthorized" }],
                }),
                { status: 403 }
            ),
    ];

    for (const request of responses) {
        const api = createCloudflareWorkersApi({
            accountId,
            apiToken,
            request,
        });
        await assert.rejects(
            api.getWorkerSubdomain("peerbit-examples-files"),
            (error) =>
                error instanceof CloudflareWorkersApiError &&
                error.details.operation.includes(
                    "workers.dev and Preview URL state"
                )
        );
    }
});

test("Worker subdomain API failures redact complete workers.dev references", async (t) => {
    const accountId = "d".repeat(32);
    const apiToken = "redact-this-token";
    const longTail = "x".repeat(600);
    const httpError = (reference) =>
        new Response(
            JSON.stringify({
                success: false,
                errors: [
                    {
                        code: 10000,
                        message: `${reference} token ${apiToken} account ${accountId} ${longTail}`,
                    },
                ],
            }),
            { status: 403 }
        );
    const fixtures = [
        {
            name: "HTTP error payload",
            reference:
                "https://v-worker.private-account-slug.workers.dev/path?x=1",
            privateParts: ["v-worker", "private-account-slug", "/path?x=1"],
            request: httpError,
        },
        {
            name: "mixed-case transport error",
            reference:
                "HTTPS://V-WorKer.Private-Account-Slug.WoRkErS.DeV:8787/Private-Path?Secret-Query=1#Private-Fragment",
            privateParts: [
                "v-worker",
                "private-account-slug",
                "8787",
                "private-path",
                "secret-query",
                "private-fragment",
            ],
            request: (reference) => {
                throw new Error(
                    `${reference} token ${apiToken} account ${accountId} ${longTail}`
                );
            },
        },
        {
            name: "terminal dot before URL path",
            reference:
                "https://v-worker.private-account-slug.workers.dev./path?x=1#f",
            privateParts: ["v-worker", "private-account-slug", "/path?x=1#f"],
            request: httpError,
        },
        {
            name: "bare hostname with terminal dot",
            reference: "v-worker.private-account-slug.workers.dev.",
            privateParts: ["v-worker", "private-account-slug"],
            request: httpError,
        },
        {
            name: "terminal dot before numeric port",
            reference:
                "https://v-worker.private-account-slug.workers.dev.:8787/path",
            privateParts: ["v-worker", "private-account-slug", "8787", "/path"],
            request: httpError,
        },
    ];

    for (const fixture of fixtures) {
        await t.test(fixture.name, async () => {
            const api = createCloudflareWorkersApi({
                accountId,
                apiToken,
                request: async () => fixture.request(fixture.reference),
            });
            let failure;
            try {
                await api.getWorkerSubdomain("peerbit-examples-files");
            } catch (error) {
                failure = error;
            }

            assert.ok(failure instanceof CloudflareWorkersApiError);
            const normalizedMessage = failure.details.errors[0].message;
            assert.match(failure.message, /\[REDACTED_WORKERS_DEV_REFERENCE\]/);
            assert.match(failure.message, /\[REDACTED\]/);
            assert.doesNotMatch(normalizedMessage, /workers\.dev/i);
            for (const privateValue of [
                fixture.reference,
                ...fixture.privateParts,
                apiToken,
                accountId,
            ]) {
                assert.equal(
                    failure.message
                        .toLowerCase()
                        .includes(privateValue.toLowerCase()),
                    false
                );
            }
            assert.equal(failure.details.indeterminateMutation, false);
        });
    }
});

test("Worker subdomain API diagnostics preserve non-workers.dev boundaries", async () => {
    const visibleReferences = [
        "notworkers.dev",
        "workers.dev.evil",
        "workers.dev-example.com",
        "workers.devil",
    ];
    const api = createCloudflareWorkersApi({
        accountId: "d".repeat(32),
        apiToken: "test-token_123",
        request: async () =>
            new Response(
                JSON.stringify({
                    success: false,
                    errors: [
                        {
                            message: visibleReferences.join(" "),
                        },
                    ],
                }),
                { status: 400 }
            ),
    });
    let failure;
    try {
        await api.getWorkerSubdomain("peerbit-examples-files");
    } catch (error) {
        failure = error;
    }

    assert.ok(failure instanceof CloudflareWorkersApiError);
    const normalizedMessage = failure.details.errors[0].message;
    assert.doesNotMatch(
        normalizedMessage,
        /\[REDACTED_WORKERS_DEV_REFERENCE\]/
    );
    for (const reference of visibleReferences) {
        assert.equal(normalizedMessage.includes(reference), true);
    }
});

test("Cloudflare Workers API exhausts read-only custom-domain pagination", async () => {
    const accountId = "c".repeat(32);
    const apiToken = "test-token_123";
    const requests = [];
    const rawDomains = [
        {
            id: "domain-files",
            hostname: "FILES.APPS.PEERBIT.ORG",
            service: "peerbit-examples-files",
            environment: "production",
            zone_id: ZONE_ID,
            zone_name: "peerbit.org",
        },
        {
            id: "domain-stream",
            hostname: "stream.apps.peerbit.org",
            service: "peerbit-examples-stream",
            environment: "production",
            zone_id: ZONE_ID,
            zone_name: "peerbit.org",
        },
    ];
    const api = createCloudflareWorkersApi({
        accountId,
        apiToken,
        request: async (url, init) => {
            requests.push({ url, init });
            const page = Number(new URL(url).searchParams.get("page"));
            return new Response(
                JSON.stringify({
                    success: true,
                    result: [rawDomains[page - 1]],
                    result_info: {
                        count: 1,
                        page,
                        per_page: 1,
                        total_count: 2,
                        total_pages: 2,
                    },
                }),
                { status: 200 }
            );
        },
    });

    assert.deepEqual(await api.listWorkerDomains(), [
        workerDomain("files"),
        workerDomain("stream"),
    ]);
    assert.deepEqual(
        requests.map(({ url, init }) => [url, init.method]),
        [
            [
                `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains?page=1&per_page=100`,
                "GET",
            ],
            [
                `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains?page=2&per_page=100`,
                "GET",
            ],
            [
                `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains?page=1&per_page=100`,
                "GET",
            ],
            [
                `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains?page=2&per_page=100`,
                "GET",
            ],
        ]
    );
    for (const { init } of requests) {
        assert.equal(init.headers.Authorization, `Bearer ${apiToken}`);
        assert.equal("body" in init, false);
    }
});

test("custom-domain pagination discards a constant-total hybrid snapshot", async () => {
    const accountId = "c".repeat(32);
    const apiToken = "test-token_123";
    const alpha = rawWorkerDomain("alpha");
    const bravo = rawWorkerDomain("bravo");
    const charlie = rawWorkerDomain("charlie");
    const delta = rawWorkerDomain("delta");
    const echo = rawWorkerDomain("echo");
    const snapshots = [
        [
            [alpha, bravo],
            [delta, echo],
        ],
        [
            [bravo, charlie],
            [delta, echo],
        ],
        [
            [bravo, charlie],
            [delta, echo],
        ],
    ];
    let requests = 0;
    const api = createCloudflareWorkersApi({
        accountId,
        apiToken,
        request: async (url) => {
            const page = Number(new URL(url).searchParams.get("page"));
            const snapshot = snapshots[Math.floor(requests / 2)];
            requests += 1;
            return new Response(
                JSON.stringify({
                    success: true,
                    result: snapshot[page - 1],
                    result_info: {
                        count: 2,
                        page,
                        per_page: 2,
                        total_count: 4,
                        total_pages: 2,
                    },
                }),
                { status: 200 }
            );
        },
    });

    assert.deepEqual(
        (await api.listWorkerDomains()).map(({ id }) => id),
        ["domain-bravo", "domain-charlie", "domain-delta", "domain-echo"]
    );
    assert.equal(requests, 6);
});

test("custom-domain pagination fails closed when complete snapshots keep churning", async () => {
    const accountId = "c".repeat(32);
    const apiToken = "test-token_123";
    const alpha = rawWorkerDomain("alpha");
    const bravo = rawWorkerDomain("bravo");
    const charlie = rawWorkerDomain("charlie");
    const delta = rawWorkerDomain("delta");
    const echo = rawWorkerDomain("echo");
    const snapshots = [
        [
            [alpha, bravo],
            [delta, echo],
        ],
        [
            [bravo, charlie],
            [delta, echo],
        ],
    ];
    let requests = 0;
    const api = createCloudflareWorkersApi({
        accountId,
        apiToken,
        request: async (url) => {
            const page = Number(new URL(url).searchParams.get("page"));
            const snapshot = snapshots[Math.floor(requests / 2) % 2];
            requests += 1;
            return new Response(
                JSON.stringify({
                    success: true,
                    result: snapshot[page - 1],
                    result_info: {
                        count: 2,
                        page,
                        per_page: 2,
                        total_count: 4,
                        total_pages: 2,
                    },
                }),
                { status: 200 }
            );
        },
    });

    await assert.rejects(
        api.listWorkerDomains(),
        /did not remain stable across complete snapshots/
    );
    assert.equal(requests, 6);
});

test("custom-domain pagination and API ambiguity fail closed", async () => {
    const accountId = "c".repeat(32);
    const apiToken = "test-token_123";
    const responses = [
        () =>
            new Response(
                JSON.stringify({
                    success: false,
                    errors: [{ code: 10000, message: "forbidden" }],
                }),
                { status: 403 }
            ),
        () =>
            new Response(JSON.stringify({ success: true, result: [] }), {
                status: 200,
            }),
        (url) => {
            const page = Number(new URL(url).searchParams.get("page"));
            return new Response(
                JSON.stringify({
                    success: true,
                    result: [
                        {
                            id: "domain-" + page,
                            hostname: "duplicate.apps.peerbit.org",
                            service: "peerbit-examples-files",
                            environment: "production",
                            zone_id: ZONE_ID,
                            zone_name: "peerbit.org",
                        },
                    ],
                    result_info: {
                        count: 1,
                        page,
                        per_page: 1,
                        total_count: 2,
                        total_pages: 2,
                    },
                }),
                { status: 200 }
            );
        },
        () =>
            new Response(
                JSON.stringify({
                    success: true,
                    result: [
                        rawWorkerDomain("retired", {
                            hostname: "retired.apps.peerbit.org.",
                        }),
                    ],
                    result_info: {
                        count: 1,
                        page: 1,
                        per_page: 100,
                        total_count: 1,
                        total_pages: 1,
                    },
                }),
                { status: 200 }
            ),
    ];

    for (const request of responses) {
        const api = createCloudflareWorkersApi({
            accountId,
            apiToken,
            request,
        });
        await assert.rejects(
            api.listWorkerDomains(),
            (error) =>
                error instanceof CloudflareWorkersApiError &&
                error.details.operation === "list account Worker custom domains"
        );
    }
});

test("attachment inventory source contract is account-scoped and read-only", () => {
    const source = readFileSync(
        path.join(repoRoot, "scripts/cloudflare-workers-api.mjs"),
        "utf8"
    );
    assert.match(
        source,
        /const domainsUrl = `\$\{CLOUDFLARE_API_BASE_URL\}\/accounts\/\$\{accountId\}\/workers\/domains`/
    );
    const domainsStart = source.indexOf("listWorkerDomains: async");
    const domainsEnd = source.indexOf(
        "getCurrentDeployment: async",
        domainsStart
    );
    const domainInventory = source.slice(domainsStart, domainsEnd);
    assert.ok(domainsStart >= 0 && domainsEnd > domainsStart);
    assert.match(domainInventory, /domainsUrl/);
    assert.doesNotMatch(domainInventory, /method\s*:|body\s*:/);
    const subdomainStart = source.indexOf("getWorkerSubdomain: async");
    const subdomainEnd = source.indexOf(
        "getCurrentDeployment: async",
        subdomainStart
    );
    const subdomainInventory = source.slice(subdomainStart, subdomainEnd);
    assert.ok(subdomainStart >= 0 && subdomainEnd > subdomainStart);
    assert.match(subdomainInventory, /\/subdomain/);
    assert.doesNotMatch(subdomainInventory, /method\s*:|body\s*:/);
    assert.match(source, /for \(const route of script\.routes\)/);
    assert.doesNotMatch(source, /\/zones\/\$\{[^}]+\}\/workers\/routes/);
});

test("Cloudflare Workers API reads versions and changes traffic only through deployments", async () => {
    const accountId = "c".repeat(32);
    const apiToken = "test-token_123";
    const workerName = "peerbit-examples-files";
    const requests = [];
    const api = createCloudflareWorkersApi({
        accountId,
        apiToken,
        request: async (url, init) => {
            requests.push({ url, init });
            const isPost = init.method === "POST";
            if (url.endsWith("/versions/" + NEW_VERSION)) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: {
                            id: NEW_VERSION,
                            annotations: { "workers/tag": "invocation-tag" },
                        },
                    }),
                    { status: 200 }
                );
            }
            if (url.endsWith("/deployments") && !isPost) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: { deployments: [deployment(OLD_VERSION)] },
                    }),
                    { status: 200 }
                );
            }
            if (url.endsWith("/deployments") && isPost) {
                const body = JSON.parse(init.body);
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: {
                            id: "44444444-4444-4444-8444-444444444444",
                            strategy: "percentage",
                            versions: body.versions,
                        },
                    }),
                    { status: 200 }
                );
            }
            return new Response("not found", { status: 404 });
        },
    });

    assert.equal(
        (await api.getWorkerVersion(workerName, NEW_VERSION)).id,
        NEW_VERSION
    );
    assert.deepEqual(
        await api.getCurrentDeployment(workerName),
        deployment(OLD_VERSION)
    );
    assert.deepEqual(
        await api.createDeployment({
            workerName,
            versionId: NEW_VERSION,
            message: "promote exact version",
        }),
        {
            id: "44444444-4444-4444-8444-444444444444",
            strategy: "percentage",
            versions: [{ version_id: NEW_VERSION, percentage: 100 }],
        }
    );
    assert.equal(
        (
            await api.createDeployment({
                workerName,
                versionId: OLD_VERSION,
                message: "rollback exact version",
            })
        ).versions[0].version_id,
        OLD_VERSION
    );

    const resourceRoot = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`;
    assert.deepEqual(
        requests.map(({ url, init }) => [url, init.method]),
        [
            [resourceRoot + "/versions/" + NEW_VERSION, "GET"],
            [resourceRoot + "/deployments", "GET"],
            [resourceRoot + "/deployments", "POST"],
            [resourceRoot + "/deployments", "POST"],
        ]
    );
    const promotion = JSON.parse(requests[2].init.body);
    assert.deepEqual(promotion, {
        strategy: "percentage",
        versions: [{ version_id: NEW_VERSION, percentage: 100 }],
        annotations: {
            "workers/message": "promote exact version",
            "workers/triggered_by": "peerbit-production-workflow",
        },
    });
    for (const { url } of requests) {
        assert.doesNotMatch(url, /routes|domains|subdomain|zones/);
    }
});

const ambiguousDeploymentResponseCases = [
    {
        name: "well-formed 400 response",
        status: 400,
        response: () =>
            new Response(
                JSON.stringify({
                    success: false,
                    errors: [{ code: 1000, message: "request rejected" }],
                }),
                { status: 400 }
            ),
    },
    {
        name: "500 response",
        status: 500,
        response: () =>
            new Response(
                JSON.stringify({
                    success: false,
                    errors: [{ code: 1001, message: "internal error" }],
                }),
                { status: 500 }
            ),
    },
    {
        name: "malformed 200 response",
        status: 200,
        response: () => new Response("{", { status: 200 }),
    },
    {
        name: "empty 200 response",
        status: 200,
        response: () => new Response("", { status: 200 }),
    },
    {
        name: "invalid exact-version 200 evidence",
        status: 200,
        response: () =>
            new Response(
                JSON.stringify({
                    success: true,
                    result: {
                        id: "44444444-4444-4444-8444-444444444444",
                        strategy: "percentage",
                        versions: [
                            { version_id: OLD_VERSION, percentage: 100 },
                        ],
                    },
                }),
                { status: 200 }
            ),
    },
];

const captureAmbiguousDeploymentResponse = async (response) => {
    const accountId = "c".repeat(32);
    const apiToken = "test-token_123";
    let requestInit;
    const api = createCloudflareWorkersApi({
        accountId,
        apiToken,
        request: async (_url, init) => {
            requestInit = init;
            return response();
        },
    });
    let failure;
    try {
        await api.createDeployment({
            workerName: "peerbit-examples-files",
            versionId: NEW_VERSION,
            message: "promote exact version",
        });
    } catch (error) {
        failure = error;
    }
    return { failure, requestInit };
};

test("every Create Deployment response failure is indeterminate after POST dispatch", async (t) => {
    for (const fixture of ambiguousDeploymentResponseCases) {
        await t.test(fixture.name, async () => {
            const { failure, requestInit } =
                await captureAmbiguousDeploymentResponse(fixture.response);
            assert.ok(failure instanceof CloudflareWorkersApiError);
            assert.equal(failure.details.status, fixture.status);
            assert.equal(failure.details.indeterminateMutation, true);
            assert.equal(failure.indeterminateMutation, true);
            assert.equal(requestInit.method, "POST");
        });
    }
});

test("Create Deployment local validation failures remain determinate and dispatch nothing", async () => {
    let requests = 0;
    const api = createCloudflareWorkersApi({
        accountId: "c".repeat(32),
        apiToken: "test-token_123",
        request: async () => {
            requests += 1;
            return new Response("not reached", { status: 500 });
        },
    });
    for (const input of [
        {
            workerName: "INVALID WORKER",
            versionId: NEW_VERSION,
            message: "valid",
        },
        {
            workerName: "peerbit-examples-files",
            versionId: "invalid-version",
            message: "valid",
        },
        {
            workerName: "peerbit-examples-files",
            versionId: NEW_VERSION,
            message: "",
        },
    ]) {
        await assert.rejects(api.createDeployment(input), (error) => {
            assert.equal(
                error instanceof CloudflareWorkersApiError &&
                    error.indeterminateMutation === true,
                false
            );
            return true;
        });
    }
    assert.equal(requests, 0);
});

test("a status-less deployment POST failure is classified as indeterminate", async () => {
    const accountId = "c".repeat(32);
    const apiToken = "do-not-leak-this-token";
    const api = createCloudflareWorkersApi({
        accountId,
        apiToken,
        request: async () => {
            throw new Error(`socket closed after request ${apiToken}`);
        },
    });
    let failure;
    try {
        await api.createDeployment({
            workerName: "peerbit-examples-files",
            versionId: NEW_VERSION,
            message: "promote exact version",
        });
    } catch (error) {
        failure = error;
    }
    assert.ok(failure instanceof CloudflareWorkersApiError);
    assert.equal(failure.details.status, null);
    assert.equal(failure.details.indeterminateMutation, true);
    assert.equal(failure.indeterminateMutation, true);
    assert.match(failure.message, /\[REDACTED\]/);
    assert.doesNotMatch(failure.message, new RegExp(apiToken));
});

test("Cloudflare API failures are structured and redact credentials", async () => {
    const accountId = "d".repeat(32);
    const apiToken = "redact-this-token";
    for (const request of [
        async () =>
            new Response(
                JSON.stringify({
                    success: false,
                    errors: [
                        {
                            code: 10000,
                            message: `authentication failed for ${apiToken} in ${accountId}`,
                        },
                    ],
                }),
                { status: 403 }
            ),
        async () => {
            throw new Error(`network failed with ${apiToken} in ${accountId}`);
        },
    ]) {
        const api = createCloudflareWorkersApi({
            accountId,
            apiToken,
            request,
        });
        let failure;
        try {
            await api.listWorkerScripts();
        } catch (error) {
            failure = error;
        }
        assert.ok(failure instanceof CloudflareWorkersApiError);
        assert.doesNotMatch(failure.message, new RegExp(apiToken));
        assert.doesNotMatch(failure.message, new RegExp(accountId));
        assert.match(failure.message, /Cloudflare Workers API error/);
        assert.equal(failure.details.operation, "list account Worker scripts");
        assert.equal(failure.details.indeterminateMutation, false);
        assert.ok(Array.isArray(failure.details.errors));
    }
});

test("production CLI accepts only target and immutable commit", () => {
    assert.deepEqual(
        parseProductionDeploymentArgs([
            "--target",
            "files",
            "--commit",
            COMMIT,
        ]),
        {
            target: "files",
            expectedCommit: COMMIT,
        }
    );
    assert.throws(
        () =>
            parseProductionDeploymentArgs([
                "--target",
                "files",
                "--commit",
                COMMIT,
                "--initialize-missing-workers",
                "true",
            ]),
        /Unsupported production deployment argument/
    );
    assert.throws(
        () =>
            parseProductionDeploymentArgs([
                "--target",
                "files",
                "--target",
                "stream",
                "--commit",
                COMMIT,
            ]),
        /Duplicate production deployment argument/
    );
    assert.throws(
        () =>
            parseProductionDeploymentArgs([
                "--target",
                "files; echo unsafe",
                "--commit",
                COMMIT,
            ]),
        /target is missing or malformed/
    );
    assert.throws(
        () =>
            parseProductionDeploymentArgs([
                "--target",
                "files",
                "--commit",
                "short",
            ]),
        /full Git commit hash/
    );
});

const fixtureEntries = (ids) =>
    ids.map((id) => ({
        site: { id },
        policy: {
            id,
            kind: "app",
            productionWorker: "peerbit-examples-" + id,
            previewWorker: "peerbit-examples-" + id + "-preview",
            productionHostnames: [id + ".apps.peerbit.org"],
        },
    }));
const deployProductionEntries = (options) =>
    deployProductionEntriesWithPolicy({
        deploymentEntries: options.selectedEntries,
        ...options,
    });
const fixtureConfigs = (ids) =>
    new Map(
        ids.map((id) => [
            id,
            {
                file: "/" + id + ".jsonc",
                config: { name: "peerbit-examples-" + id },
            },
        ])
    );
const existingWorkerScripts = (...ids) =>
    new Map(
        ids.map((id) => [
            "peerbit-examples-" + id,
            { tag: WORKER_TAGS.get(id), routes: [] },
        ])
    );
const deploymentEvidence = (
    id,
    { versionId = NEW_VERSION, workerTag = WORKER_TAGS.get(id) } = {}
) => ({
    workerName: "peerbit-examples-" + id,
    workerTag,
    versionId,
});

const STREAM_NEW_VERSION = "33333333-3333-4333-8333-333333333333";
const EXTERNAL_VERSION = "55555555-5555-4555-8555-555555555555";
const newVersionFor = (id) =>
    id === "stream" ? STREAM_NEW_VERSION : NEW_VERSION;
const siteIdFromWorker = (workerName) =>
    workerName.replace("peerbit-examples-", "");

const createRolloutHarness = (ids) => {
    const current = new Map(ids.map((id) => [id, OLD_VERSION]));
    const workerTags = new Map(ids.map((id) => [id, WORKER_TAGS.get(id)]));
    const subdomains = new Map(
        ids.map((id) => [
            "peerbit-examples-" + id,
            { enabled: false, previewsEnabled: false },
        ])
    );
    const versionTags = new Map();
    const events = [];
    const operations = {
        listWorkerScripts: () =>
            new Map(
                ids.map((id) => [
                    "peerbit-examples-" + id,
                    { tag: workerTags.get(id), routes: [] },
                ])
            ),
        listWorkerDomains: () => ids.map((id) => workerDomain(id)),
        getWorkerSubdomain: (workerName) =>
            structuredClone(subdomains.get(workerName)),
        status: ({ site }) => deployment(current.get(site.id)),
        readReleaseCommit: () => OLD_COMMIT,
        upload: ({ site, versionTag, renderedConfig }) => {
            assert.equal(renderedConfig.name, "peerbit-examples-" + site.id);
            events.push("upload:" + site.id);
            versionTags.set(site.id, versionTag);
            return deploymentEvidence(site.id, {
                versionId: newVersionFor(site.id),
                workerTag: workerTags.get(site.id),
            });
        },
        getVersion: ({ workerName, versionId }) => {
            const id = siteIdFromWorker(workerName);
            return {
                id: versionId,
                annotations: { "workers/tag": versionTags.get(id) },
                metadata: { source: "wrangler" },
            };
        },
        activate: ({ site, versionId }) => {
            events.push("activate:" + site.id + ":" + versionId);
            current.set(site.id, versionId);
            return deployment(versionId);
        },
        verify: ({ site, expectedCommit }) => {
            events.push("verify:" + site.id + ":" + expectedCommit);
        },
    };
    return {
        current,
        events,
        operations,
        subdomains,
        versionTags,
        workerTags,
    };
};

test("account-wide attachment validation requires an explicit non-empty full policy", async (t) => {
    for (const fixture of [
        { name: "omitted", include: false },
        { name: "empty", include: true },
    ]) {
        await t.test(fixture.name, async () => {
            let listed = false;
            const options = {
                selectedEntries: fixtureEntries(["files"]),
                configs: fixtureConfigs(["files"]),
                expectedCommit: COMMIT,
                log: () => {},
                operations: {
                    listWorkerScripts: () => {
                        listed = true;
                        return existingWorkerScripts("files");
                    },
                    upload: () => assert.fail("upload must not run"),
                    activate: () => assert.fail("activation must not run"),
                },
            };
            if (fixture.include) options.deploymentEntries = [];
            await assert.rejects(
                deployProductionEntriesWithPolicy(options),
                /explicit non-empty full-policy entries/
            );
            assert.equal(listed, false);
        });
    }
});

test("an empty selected entry set fails before account reads or mutations", async () => {
    let listed = false;
    await assert.rejects(
        deployProductionEntriesWithPolicy({
            selectedEntries: [],
            deploymentEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: {
                listWorkerScripts: () => {
                    listed = true;
                    return existingWorkerScripts("files");
                },
                upload: () => assert.fail("upload must not run"),
                activate: () => assert.fail("activation must not run"),
            },
        }),
        /non-empty selected entry set/
    );
    assert.equal(listed, false);
});

test("a missing production Worker fails closed before every mutation", async () => {
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: {
                listWorkerScripts: () => new Map(),
                status: () => assert.fail("status must not run"),
                readReleaseCommit: () =>
                    assert.fail("release lookup must not run"),
                upload: () => assert.fail("upload must not run"),
                getVersion: () => assert.fail("version lookup must not run"),
                activate: () => assert.fail("activation must not run"),
                verify: () => assert.fail("verify must not run"),
            },
        }),
        /require pre-provisioned Workers.*No deployment was attempted/i
    );
});

test("one missing Worker blocks a mixed selection before baseline reads", async () => {
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files", "stream"]),
            configs: fixtureConfigs(["files", "stream"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: {
                listWorkerScripts: () => existingWorkerScripts("files"),
                status: () => assert.fail("status must not run"),
                readReleaseCommit: () =>
                    assert.fail("release lookup must not run"),
                upload: () => assert.fail("upload must not run"),
            },
        }),
        /missing stream: peerbit-examples-stream/i
    );
});

test("Worker-list API errors never classify a target as missing", async () => {
    let uploaded = false;
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: {
                listWorkerScripts: () => {
                    throw new Error("Cloudflare authorization failed");
                },
                upload: () => {
                    uploaded = true;
                },
            },
        }),
        /Cloudflare authorization failed/
    );
    assert.equal(uploaded, false);
});

test("missing, extra, and wrongly attached custom domains fail before upload", async () => {
    const cases = [
        {
            name: "missing",
            domains: [],
        },
        {
            name: "extra",
            domains: [
                workerDomain("files"),
                workerDomain("legacy", {
                    id: "domain-extra",
                    hostname: "legacy.apps.peerbit.org",
                    service: "peerbit-examples-files",
                }),
            ],
        },
        {
            name: "wrong Worker",
            domains: [
                workerDomain("files", {
                    service: "peerbit-examples-stream",
                }),
            ],
        },
    ];

    for (const fixture of cases) {
        const harness = createRolloutHarness(["files"]);
        harness.operations.listWorkerDomains = () => fixture.domains;
        await assert.rejects(
            deployProductionEntries({
                selectedEntries: fixtureEntries(["files"]),
                configs: fixtureConfigs(["files"]),
                expectedCommit: COMMIT,
                log: () => {},
                operations: harness.operations,
            }),
            /custom domains must exactly equal/,
            fixture.name
        );
        assert.deepEqual(harness.events, [], fixture.name);
    }
});

test("mixed-app hostname swaps fail exact attachment validation", async () => {
    const harness = createRolloutHarness(["files", "stream"]);
    harness.operations.listWorkerDomains = () => [
        workerDomain("files"),
        workerDomain("stream", {
            service: "peerbit-examples-files",
        }),
    ];
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files", "stream"]),
            configs: fixtureConfigs(["files", "stream"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /files: peerbit-examples-files custom domains must exactly equal/
    );
    assert.deepEqual(harness.events, []);
});

test("noncanonical custom-domain hostnames fail closed before upload", async () => {
    const harness = createRolloutHarness(["files"]);
    harness.operations.listWorkerDomains = () => [
        workerDomain("files", {
            hostname: "files.apps.peerbit.org.",
        }),
    ];
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /invalid or ambiguous inventory/
    );
    assert.deepEqual(harness.events, []);
});

test("traditional Worker routes fail exact attachment validation", async () => {
    const harness = createRolloutHarness(["files"]);
    harness.operations.listWorkerScripts = () =>
        new Map([
            [
                "peerbit-examples-files",
                {
                    tag: WORKER_TAGS.get("files"),
                    routes: [
                        {
                            id: "route-legacy",
                            pattern: "peerbit.org/legacy/*",
                            script: "peerbit-examples-files",
                        },
                    ],
                },
            ],
        ]);
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /unreviewed Worker route attachments/
    );
    assert.deepEqual(harness.events, []);
});

test("a targeted deploy rejects retired Workers from the full managed namespace", async () => {
    const harness = createRolloutHarness(["files", "stream"]);
    const listWorkerScripts = harness.operations.listWorkerScripts;
    harness.operations.listWorkerScripts = () =>
        new Map([
            ...listWorkerScripts(),
            [
                "peerbit-examples-retired",
                { tag: "retired-worker-tag", routes: [] },
            ],
        ]);
    harness.operations.listWorkerDomains = () => [
        workerDomain("files"),
        workerDomain("stream"),
        workerDomain("retired"),
    ];

    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            deploymentEntries: fixtureEntries(["files", "stream"]),
            configs: fixtureConfigs(["files", "stream"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /unreviewed or retired Worker identity peerbit-examples-retired/
    );
    assert.deepEqual(harness.events, []);
});

test("a targeted deploy rejects unmanaged ownership of retired app hostnames", async () => {
    const harness = createRolloutHarness(["files", "stream"]);
    const listWorkerScripts = harness.operations.listWorkerScripts;
    harness.operations.listWorkerScripts = () =>
        new Map([
            ...listWorkerScripts(),
            [
                "unrelated-account-worker",
                { tag: "unrelated-worker-tag", routes: [] },
            ],
        ]);
    harness.operations.listWorkerDomains = () => [
        workerDomain("files"),
        workerDomain("stream"),
        workerDomain("retired", {
            service: "unrelated-account-worker",
        }),
    ];

    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            deploymentEntries: fixtureEntries(["files", "stream"]),
            configs: fixtureConfigs(["files", "stream"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /custom domain retired\.apps\.peerbit\.org is not exactly owned/
    );
    assert.deepEqual(harness.events, []);
});

test("a targeted deploy rejects routes on non-selected policy Workers", async () => {
    const harness = createRolloutHarness(["files", "stream"]);
    const listWorkerScripts = harness.operations.listWorkerScripts;
    harness.operations.listWorkerScripts = () => {
        const scripts = listWorkerScripts();
        scripts.get("peerbit-examples-stream").routes.push({
            id: "stream-route",
            pattern: "unrelated.example.com/*",
            script: "peerbit-examples-stream",
        });
        return scripts;
    };

    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            deploymentEntries: fixtureEntries(["files", "stream"]),
            configs: fixtureConfigs(["files", "stream"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /stream: peerbit-examples-stream has unreviewed Worker route attachments/
    );
    assert.deepEqual(harness.events, []);
});

test("routes targeting the managed app suffix are rejected on unrelated Workers", async () => {
    const harness = createRolloutHarness(["files", "stream"]);
    const listWorkerScripts = harness.operations.listWorkerScripts;
    harness.operations.listWorkerScripts = () =>
        new Map([
            ...listWorkerScripts(),
            [
                "unrelated-account-worker",
                {
                    tag: "unrelated-worker-tag",
                    routes: [
                        {
                            id: "managed-suffix-route",
                            pattern: "retired.apps.peerbit.org./*",
                            script: "unrelated-account-worker",
                        },
                    ],
                },
            ],
        ]);

    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            deploymentEntries: fixtureEntries(["files", "stream"]),
            configs: fixtureConfigs(["files", "stream"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /unrelated-account-worker has unreviewed Worker route attachments/
    );
    assert.deepEqual(harness.events, []);
});

test("unrelated account Workers, routes, and domains remain outside deployment policy", async () => {
    const harness = createRolloutHarness(["files", "stream"]);
    const listWorkerScripts = harness.operations.listWorkerScripts;
    harness.operations.listWorkerScripts = () =>
        new Map([
            ...listWorkerScripts(),
            [
                "unrelated-account-worker",
                {
                    tag: "unrelated-worker-tag",
                    routes: [
                        {
                            id: "unrelated-route",
                            pattern: "unrelated.example.com/*",
                            script: "unrelated-account-worker",
                        },
                    ],
                },
            ],
        ]);
    harness.operations.listWorkerDomains = () => [
        workerDomain("files"),
        workerDomain("stream"),
        workerDomain("unrelated", {
            hostname: "unrelated.example.com",
            service: "unrelated-account-worker",
            zoneName: "example.com",
        }),
    ];

    await deployProductionEntries({
        selectedEntries: fixtureEntries(["files"]),
        deploymentEntries: fixtureEntries(["files", "stream"]),
        configs: fixtureConfigs(["files", "stream"]),
        expectedCommit: COMMIT,
        log: () => {},
        operations: harness.operations,
    });
    assert.equal(harness.current.get("files"), NEW_VERSION);
    assert.equal(harness.current.get("stream"), OLD_VERSION);
    assert.equal(harness.events.includes("upload:stream"), false);
});

test("enabled workers.dev or Worker Preview URLs fail before upload", async (t) => {
    for (const state of [
        { name: "workers.dev", enabled: true, previewsEnabled: false },
        { name: "Preview URLs", enabled: false, previewsEnabled: true },
    ]) {
        await t.test(state.name, async () => {
            const harness = createRolloutHarness(["files"]);
            harness.subdomains.set("peerbit-examples-files", {
                enabled: state.enabled,
                previewsEnabled: state.previewsEnabled,
            });
            await assert.rejects(
                deployProductionEntries({
                    selectedEntries: fixtureEntries(["files"]),
                    configs: fixtureConfigs(["files"]),
                    expectedCommit: COMMIT,
                    log: () => {},
                    operations: harness.operations,
                }),
                /workers\.dev and Worker Preview URLs must both be disabled/
            );
            assert.deepEqual(harness.events, []);
        });
    }
});

test("targeted deploys validate public subdomain state on non-selected policy Workers", async () => {
    const harness = createRolloutHarness(["files", "stream"]);
    harness.subdomains.set("peerbit-examples-stream", {
        enabled: false,
        previewsEnabled: true,
    });
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            deploymentEntries: fixtureEntries(["files", "stream"]),
            configs: fixtureConfigs(["files", "stream"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /peerbit-examples-stream: workers\.dev and Worker Preview URLs must both be disabled/
    );
    assert.deepEqual(harness.events, []);
});

test("existing allowlisted preview Workers receive the same public subdomain fence", async () => {
    const harness = createRolloutHarness(["files"]);
    const listWorkerScripts = harness.operations.listWorkerScripts;
    harness.operations.listWorkerScripts = () =>
        new Map([
            ...listWorkerScripts(),
            [
                "peerbit-examples-files-preview",
                { tag: "files-preview-tag", routes: [] },
            ],
        ]);
    harness.subdomains.set("peerbit-examples-files-preview", {
        enabled: true,
        previewsEnabled: false,
    });

    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /peerbit-examples-files-preview: workers\.dev and Worker Preview URLs must both be disabled/
    );
    assert.deepEqual(harness.events, []);
});

test("a public-subdomain flip is caught immediately before a later upload", async () => {
    const harness = createRolloutHarness(["files", "stream"]);
    const getWorkerSubdomain = harness.operations.getWorkerSubdomain;
    let streamReadsAfterFirstUpload = 0;
    harness.operations.getWorkerSubdomain = (workerName) => {
        if (
            workerName === "peerbit-examples-stream" &&
            harness.events.includes("upload:files")
        ) {
            streamReadsAfterFirstUpload += 1;
            if (streamReadsAfterFirstUpload >= 2) {
                return { enabled: false, previewsEnabled: true };
            }
        }
        return getWorkerSubdomain(workerName);
    };

    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files", "stream"]),
            configs: fixtureConfigs(["files", "stream"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /Inactive Worker version upload phase failed.*peerbit-examples-stream: \[REDACTED_WORKERS_DEV_REFERENCE\] and Worker Preview URLs must both be disabled/is
    );
    assert.deepEqual(harness.events, ["upload:files"]);
});

test("custom-domain inventory API failures stop before upload", async () => {
    const harness = createRolloutHarness(["files"]);
    harness.operations.listWorkerDomains = () => {
        throw new Error("Cloudflare custom-domain authorization failed");
    };
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /custom-domain authorization failed/
    );
    assert.deepEqual(harness.events, []);
});

test("all rollback baselines are valid before the first inactive upload", async () => {
    const harness = createRolloutHarness(["files", "stream"]);
    harness.operations.readReleaseCommit = ({ site }) => {
        if (site.id === "stream") {
            throw new Error("release metadata unavailable");
        }
        return OLD_COMMIT;
    };
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files", "stream"]),
            configs: fixtureConfigs(["files", "stream"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /release metadata unavailable/
    );
    assert.deepEqual(harness.events, []);
});

test("a later inactive upload failure leaves all live traffic untouched", async () => {
    const harness = createRolloutHarness(["files", "stream"]);
    const upload = harness.operations.upload;
    harness.operations.upload = (input) => {
        if (input.site.id === "stream") {
            harness.events.push("upload:stream:failed");
            throw new Error("version upload rejected");
        }
        return upload(input);
    };
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files", "stream"]),
            configs: fixtureConfigs(["files", "stream"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /Inactive Worker version upload phase failed.*did not change live production traffic/
    );
    assert.deepEqual(
        harness.current,
        new Map([
            ["files", OLD_VERSION],
            ["stream", OLD_VERSION],
        ])
    );
    assert.equal(
        harness.events.some((event) => event.startsWith("activate:")),
        false
    );
});

test("a Worker deletion and recreation after upload prevents promotion", async () => {
    const harness = createRolloutHarness(["files"]);
    const listWorkerScripts = harness.operations.listWorkerScripts;
    harness.operations.listWorkerScripts = () => {
        if (harness.events.includes("upload:files")) {
            return new Map([
                [
                    "peerbit-examples-files",
                    { tag: "replacement-worker-tag", routes: [] },
                ],
            ]);
        }
        return listWorkerScripts();
    };
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /baseline changed after inactive uploads.*No uploaded version was promoted/is
    );
    assert.deepEqual(harness.events, ["upload:files"]);
    assert.equal(harness.current.get("files"), OLD_VERSION);
});

test("a custom-domain change after inactive upload prevents promotion", async () => {
    const harness = createRolloutHarness(["files"]);
    harness.operations.listWorkerDomains = () => [
        workerDomain("files"),
        ...(harness.events.includes("upload:files")
            ? [
                  workerDomain("legacy", {
                      id: "domain-extra-after-upload",
                      hostname: "legacy.apps.peerbit.org",
                      service: "peerbit-examples-files",
                  }),
              ]
            : []),
    ];
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /Inactive Worker version upload phase failed.*custom domains must exactly equal.*did not change live production traffic/is
    );
    assert.deepEqual(harness.events, ["upload:files"]);
    assert.equal(harness.current.get("files"), OLD_VERSION);
});

test("an external active version after upload prevents exact-version promotion", async () => {
    const harness = createRolloutHarness(["files"]);
    const status = harness.operations.status;
    let statusCalls = 0;
    harness.operations.status = (input) => {
        statusCalls += 1;
        if (statusCalls >= 3) {
            harness.current.set("files", EXTERNAL_VERSION);
        }
        return status(input);
    };
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /baseline changed after inactive uploads.*No uploaded version was promoted/is
    );
    assert.deepEqual(harness.events, ["upload:files"]);
    assert.equal(harness.current.get("files"), EXTERNAL_VERSION);
});

test("invalid version-tag evidence can never authorize promotion", async () => {
    const harness = createRolloutHarness(["files"]);
    harness.operations.getVersion = ({ versionId }) => ({
        id: versionId,
        annotations: { "workers/tag": "not-this-invocation" },
    });
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /exact tagged Worker version.*did not change live production traffic/is
    );
    assert.deepEqual(harness.events, ["upload:files"]);
    assert.equal(harness.current.get("files"), OLD_VERSION);
});

test("every selected version uploads before the first exact promotion", async () => {
    const harness = createRolloutHarness(["files", "stream"]);
    await deployProductionEntries({
        selectedEntries: fixtureEntries(["files", "stream"]),
        configs: fixtureConfigs(["files", "stream"]),
        expectedCommit: COMMIT,
        log: () => {},
        operations: harness.operations,
    });
    assert.deepEqual(harness.events, [
        "upload:files",
        "upload:stream",
        "activate:files:" + NEW_VERSION,
        "verify:files:" + COMMIT,
        "activate:stream:" + STREAM_NEW_VERSION,
        "verify:stream:" + COMMIT,
    ]);
    assert.equal(harness.current.get("files"), NEW_VERSION);
    assert.equal(harness.current.get("stream"), STREAM_NEW_VERSION);
    assert.match(harness.versionTags.get("files"), /^peerbit_files_/);
    assert.match(harness.versionTags.get("stream"), /^peerbit_stream_/);
});

test("final ownership checks catch an earlier app drifting during a later successful verifier", async () => {
    const harness = createRolloutHarness(["files", "stream"]);
    const verify = harness.operations.verify;
    harness.operations.verify = (input) => {
        verify(input);
        if (input.site.id === "stream" && input.expectedCommit === COMMIT) {
            harness.current.set("files", EXTERNAL_VERSION);
        }
    };
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files", "stream"]),
            configs: fixtureConfigs(["files", "stream"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /files: production rollout failed.*active version.*stream: automatic rollback.*files: automatic rollback refused.*another deployment may have won/is
    );
    assert.equal(harness.current.get("files"), EXTERNAL_VERSION);
    assert.equal(harness.current.get("stream"), OLD_VERSION);
    assert.deepEqual(
        harness.events.filter((event) => event.startsWith("activate:")),
        [
            "activate:files:" + NEW_VERSION,
            "activate:stream:" + STREAM_NEW_VERSION,
            "activate:stream:" + OLD_VERSION,
        ]
    );
});

test("final success and rollback fencing include public subdomain state", async () => {
    const harness = createRolloutHarness(["files"]);
    const verify = harness.operations.verify;
    harness.operations.verify = (input) => {
        verify(input);
        if (input.expectedCommit === COMMIT) {
            harness.subdomains.set("peerbit-examples-files", {
                enabled: true,
                previewsEnabled: true,
            });
        }
    };

    let failure;
    try {
        await deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        });
    } catch (error) {
        failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.match(
        failure.message,
        /production rollout failed.*\[REDACTED_WORKERS_DEV_REFERENCE\] and Worker Preview URLs must both be disabled/is
    );
    assert.match(failure.message, /automatic rollback refused/);
    assert.equal(harness.current.get("files"), NEW_VERSION);
    assert.equal(
        harness.events.includes("activate:files:" + OLD_VERSION),
        false
    );
});

test("a later verification failure unwinds the whole rollout in reverse", async () => {
    const harness = createRolloutHarness(["files", "stream"]);
    const verify = harness.operations.verify;
    harness.operations.verify = (input) => {
        verify(input);
        if (input.site.id === "stream" && input.expectedCommit === COMMIT) {
            throw new Error("runtime smoke failed");
        }
    };
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files", "stream"]),
            configs: fixtureConfigs(["files", "stream"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /stream: automatic rollback of this invocation.*files: automatic rollback of this invocation/is
    );
    assert.deepEqual(
        harness.events.filter((event) => event.startsWith("activate:")),
        [
            "activate:files:" + NEW_VERSION,
            "activate:stream:" + STREAM_NEW_VERSION,
            "activate:stream:" + OLD_VERSION,
            "activate:files:" + OLD_VERSION,
        ]
    );
    assert.equal(harness.current.get("files"), OLD_VERSION);
    assert.equal(harness.current.get("stream"), OLD_VERSION);
});

test("a later promotion failure unwinds earlier apps but does not touch its baseline", async () => {
    const harness = createRolloutHarness(["files", "stream"]);
    const activate = harness.operations.activate;
    harness.operations.activate = (input) => {
        if (
            input.site.id === "stream" &&
            input.versionId === STREAM_NEW_VERSION
        ) {
            harness.events.push("activate:stream:failed");
            throw new Error("promotion API failed before mutation");
        }
        return activate(input);
    };
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files", "stream"]),
            configs: fixtureConfigs(["files", "stream"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /stream: previous baseline .* remains active.*files: automatic rollback/is
    );
    assert.equal(harness.current.get("files"), OLD_VERSION);
    assert.equal(harness.current.get("stream"), OLD_VERSION);
    assert.equal(
        harness.events.includes("activate:stream:" + OLD_VERSION),
        false
    );
});

test("baseline-remained-active recovery rechecks the active version after its verifier", async () => {
    const harness = createRolloutHarness(["files"]);
    harness.operations.activate = (input) => {
        if (input.versionId === NEW_VERSION) {
            harness.events.push("activate:files:failed-before-dispatch");
            throw new Error("local activation validation failed");
        }
        assert.fail("a rollback POST must not be dispatched");
    };
    const verify = harness.operations.verify;
    harness.operations.verify = (input) => {
        verify(input);
        if (input.expectedCommit === OLD_COMMIT) {
            harness.current.set("files", EXTERNAL_VERSION);
        }
    };

    let failure;
    try {
        await deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        });
    } catch (error) {
        failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.match(
        failure.message,
        /automatic rollback refused.*active version changed .* during baseline verification/is
    );
    assert.doesNotMatch(failure.message, /no rollback was necessary/i);
    assert.equal(harness.current.get("files"), EXTERNAL_VERSION);
});

test("an indeterminate promotion waits for a delayed mutation and unwinds it", async () => {
    const harness = createRolloutHarness(["files"]);
    const activate = harness.operations.activate;
    const secret = "transport-secret-token";
    let waits = 0;
    harness.operations.activate = (input) => {
        if (input.versionId === NEW_VERSION) {
            harness.events.push("activate:files:indeterminate");
            throw new CloudflareWorkersApiError({
                operation: "activate exact Worker version",
                cause: new Error(`connection lost after POST ${secret}`),
                secrets: [secret],
                indeterminateMutation: true,
            });
        }
        return activate(input);
    };
    harness.operations.waitForActivationSettlement = async () => {
        waits += 1;
        if (waits === 2) {
            harness.current.set("files", NEW_VERSION);
        }
    };

    let failure;
    try {
        await deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        });
    } catch (error) {
        failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /indeterminateMutation":true/);
    assert.match(failure.message, /\[REDACTED\]/);
    assert.doesNotMatch(failure.message, new RegExp(secret));
    assert.match(failure.message, /automatic rollback of this invocation/);
    assert.equal(waits, 2);
    assert.equal(harness.current.get("files"), OLD_VERSION);
    assert.deepEqual(
        harness.events.filter((event) => event.startsWith("activate:")),
        ["activate:files:indeterminate", "activate:files:" + OLD_VERSION]
    );
});

test("a valid 2xx activation that appears during settlement is unwound end to end", async () => {
    const harness = createRolloutHarness(["files"]);
    const activate = harness.operations.activate;
    let waits = 0;
    harness.operations.activate = (input) => {
        if (input.versionId === NEW_VERSION) {
            harness.events.push("activate:files:acknowledged-pending");
            return deployment(NEW_VERSION);
        }
        return activate(input);
    };
    harness.operations.waitForActivationSettlement = async () => {
        waits += 1;
        if (waits === 2) {
            harness.current.set("files", NEW_VERSION);
        }
    };

    let failure;
    try {
        await deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        });
    } catch (error) {
        failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /active version .* does not match/);
    assert.match(failure.message, /automatic rollback of this invocation/);
    assert.equal(waits, 2);
    assert.equal(harness.current.get("files"), OLD_VERSION);
    assert.deepEqual(
        harness.events.filter((event) => event.startsWith("activate:")),
        ["activate:files:acknowledged-pending", "activate:files:" + OLD_VERSION]
    );
});

test("baseline-only settlement remains manual when the lost POST lands later", async () => {
    const harness = createRolloutHarness(["files"]);
    const activate = harness.operations.activate;
    let waits = 0;
    harness.operations.activate = (input) => {
        if (input.versionId === NEW_VERSION) {
            harness.events.push("activate:files:indeterminate");
            throw new CloudflareWorkersApiError({
                operation: "activate exact Worker version",
                cause: new Error("connection lost after deployment POST"),
                secrets: [],
                indeterminateMutation: true,
            });
        }
        return activate(input);
    };
    harness.operations.waitForActivationSettlement = async () => {
        waits += 1;
        if (waits === 11) {
            setTimeout(() => {
                harness.current.set("files", NEW_VERSION);
            }, 0);
        }
    };

    let failure;
    try {
        await deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        });
    } catch (error) {
        failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.match(
        failure.message,
        /automatic rollback refused.*activation remains indeterminate after the bounded settlement window/is
    );
    assert.doesNotMatch(failure.message, /no rollback was necessary/i);
    assert.equal(waits, 11);
    assert.equal(harness.current.get("files"), OLD_VERSION);
    assert.equal(
        harness.events.includes("activate:files:" + OLD_VERSION),
        false
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.current.get("files"), NEW_VERSION);
});

test("a valid deployment response remains pending until GET observes it active", async () => {
    const harness = createRolloutHarness(["files"]);
    const activate = harness.operations.activate;
    let waits = 0;
    harness.operations.activate = (input) => {
        if (input.versionId === NEW_VERSION) {
            harness.events.push("activate:files:acknowledged");
            return deployment(NEW_VERSION);
        }
        return activate(input);
    };
    harness.operations.waitForActivationSettlement = async () => {
        waits += 1;
        if (waits === 11) {
            setTimeout(() => {
                harness.current.set("files", NEW_VERSION);
            }, 0);
        }
    };

    let failure;
    try {
        await deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        });
    } catch (error) {
        failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.match(
        failure.message,
        /active version .* does not match this invocation.*automatic rollback refused.*activation remains indeterminate after the bounded settlement window/is
    );
    assert.doesNotMatch(failure.message, /no rollback was necessary/i);
    assert.equal(waits, 11);
    assert.equal(harness.current.get("files"), OLD_VERSION);
    assert.equal(
        harness.events.includes("activate:files:" + OLD_VERSION),
        false
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.current.get("files"), NEW_VERSION);
});

test("ambiguous Deployment responses stay manual when the POST lands after settlement", async (t) => {
    for (const fixture of ambiguousDeploymentResponseCases) {
        await t.test(fixture.name, async () => {
            const { failure: responseFailure } =
                await captureAmbiguousDeploymentResponse(fixture.response);
            assert.ok(responseFailure instanceof CloudflareWorkersApiError);

            const harness = createRolloutHarness(["files"]);
            const activate = harness.operations.activate;
            let waits = 0;
            harness.operations.activate = (input) => {
                if (input.versionId === NEW_VERSION) {
                    harness.events.push("activate:files:indeterminate");
                    throw responseFailure;
                }
                return activate(input);
            };
            harness.operations.waitForActivationSettlement = async () => {
                waits += 1;
                if (waits === 11) {
                    setTimeout(() => {
                        harness.current.set("files", NEW_VERSION);
                    }, 0);
                }
            };

            let rolloutFailure;
            try {
                await deployProductionEntries({
                    selectedEntries: fixtureEntries(["files"]),
                    configs: fixtureConfigs(["files"]),
                    expectedCommit: COMMIT,
                    log: () => {},
                    operations: harness.operations,
                });
            } catch (error) {
                rolloutFailure = error;
            }
            assert.ok(rolloutFailure instanceof Error);
            assert.match(
                rolloutFailure.message,
                /automatic rollback refused.*activation remains indeterminate after the bounded settlement window/is
            );
            assert.doesNotMatch(
                rolloutFailure.message,
                /no rollback was necessary/i
            );
            assert.equal(waits, 11);
            assert.equal(harness.current.get("files"), OLD_VERSION);
            assert.equal(
                harness.events.includes("activate:files:" + OLD_VERSION),
                false
            );

            await new Promise((resolve) => setTimeout(resolve, 0));
            assert.equal(harness.current.get("files"), NEW_VERSION);
        });
    }
});

test("an external version is never clobbered and earlier owned apps still unwind", async () => {
    const harness = createRolloutHarness(["files", "stream"]);
    const verify = harness.operations.verify;
    harness.operations.verify = (input) => {
        verify(input);
        if (input.site.id === "stream" && input.expectedCommit === COMMIT) {
            harness.current.set("stream", EXTERNAL_VERSION);
            throw new Error("runtime smoke failed after external deployment");
        }
    };
    let failure;
    try {
        await deployProductionEntries({
            selectedEntries: fixtureEntries(["files", "stream"]),
            configs: fixtureConfigs(["files", "stream"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        });
    } catch (error) {
        failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /another deployment may have won/);
    assert.match(failure.message, /files: automatic rollback/);
    assert.equal(harness.current.get("stream"), EXTERNAL_VERSION);
    assert.equal(harness.current.get("files"), OLD_VERSION);
    assert.equal(
        harness.events.includes("activate:stream:" + OLD_VERSION),
        false
    );
});

test("reverse unwind skips an earlier app changed by an external actor", async () => {
    const harness = createRolloutHarness(["files", "stream"]);
    const verify = harness.operations.verify;
    harness.operations.verify = (input) => {
        verify(input);
        if (input.site.id === "stream" && input.expectedCommit === COMMIT) {
            harness.current.set("files", EXTERNAL_VERSION);
            throw new Error("runtime smoke failed");
        }
    };
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files", "stream"]),
            configs: fixtureConfigs(["files", "stream"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /stream: automatic rollback.*files: automatic rollback refused.*another deployment may have won/is
    );
    assert.equal(harness.current.get("stream"), OLD_VERSION);
    assert.equal(harness.current.get("files"), EXTERNAL_VERSION);
    assert.equal(
        harness.events.includes("activate:files:" + OLD_VERSION),
        false
    );
});

test("rollback success requires full policy and active-version confirmation after the verifier", async (t) => {
    const cases = [
        {
            name: "active version drift",
            pattern:
                /post-verifier rollback confirmation observed active version/,
            configure: (harness) => () => {
                harness.current.set("files", EXTERNAL_VERSION);
            },
        },
        {
            name: "custom-domain drift",
            pattern: /custom domains must exactly equal/,
            configure: (harness) => {
                let drifted = false;
                harness.operations.listWorkerDomains = () => [
                    workerDomain("files"),
                    ...(drifted
                        ? [
                              workerDomain("retired", {
                                  id: "rollback-domain-drift",
                                  service: "peerbit-examples-files",
                              }),
                          ]
                        : []),
                ];
                return () => {
                    drifted = true;
                };
            },
        },
        {
            name: "traditional-route drift",
            pattern: /unreviewed Worker route attachments/,
            configure: (harness) => {
                let drifted = false;
                const listWorkerScripts = harness.operations.listWorkerScripts;
                harness.operations.listWorkerScripts = () => {
                    const scripts = listWorkerScripts();
                    if (drifted) {
                        scripts.get("peerbit-examples-files").routes.push({
                            id: "rollback-route-drift",
                            pattern: "files.apps.peerbit.org/*",
                            script: "peerbit-examples-files",
                        });
                    }
                    return scripts;
                };
                return () => {
                    drifted = true;
                };
            },
        },
        {
            name: "public-subdomain drift",
            pattern:
                /\[REDACTED_WORKERS_DEV_REFERENCE\] and Worker Preview URLs must both be disabled/,
            configure: (harness) => () => {
                harness.subdomains.set("peerbit-examples-files", {
                    enabled: false,
                    previewsEnabled: true,
                });
            },
        },
    ];

    for (const fixture of cases) {
        await t.test(fixture.name, async () => {
            const harness = createRolloutHarness(["files"]);
            const introduceDrift = fixture.configure(harness);
            const verify = harness.operations.verify;
            harness.operations.verify = (input) => {
                verify(input);
                if (input.expectedCommit === COMMIT) {
                    throw new Error("runtime verification failed");
                }
                if (input.expectedCommit === OLD_COMMIT) {
                    introduceDrift();
                }
            };

            let failure;
            try {
                await deployProductionEntries({
                    selectedEntries: fixtureEntries(["files"]),
                    configs: fixtureConfigs(["files"]),
                    expectedCommit: COMMIT,
                    log: () => {},
                    operations: harness.operations,
                });
            } catch (error) {
                failure = error;
            }
            assert.ok(failure instanceof Error);
            assert.match(
                failure.message,
                /automatic rollback was applied and observed, but final confirmation failed/i
            );
            assert.match(failure.message, fixture.pattern);
            assert.doesNotMatch(failure.message, /automatic rollback refused/i);
        });
    }
});

test("rollback dispatch ambiguity and delayed visibility use confirmation-failure diagnostics", async (t) => {
    for (const fixture of [
        { name: "ambiguous response", throws: true },
        { name: "valid response with delayed visibility", throws: false },
    ]) {
        await t.test(fixture.name, async () => {
            const harness = createRolloutHarness(["files"]);
            const activate = harness.operations.activate;
            harness.operations.activate = (input) => {
                if (input.versionId !== OLD_VERSION) return activate(input);
                harness.events.push("activate:files:rollback-dispatched");
                setTimeout(() => {
                    harness.current.set("files", OLD_VERSION);
                }, 0);
                if (fixture.throws) {
                    throw new CloudflareWorkersApiError({
                        operation: "rollback exact Worker version",
                        status: 500,
                        payload: {
                            success: false,
                            errors: [{ code: 1001, message: "response lost" }],
                        },
                        secrets: [],
                        indeterminateMutation: true,
                    });
                }
                return deployment(OLD_VERSION);
            };
            const verify = harness.operations.verify;
            harness.operations.verify = (input) => {
                verify(input);
                if (input.expectedCommit === COMMIT) {
                    throw new Error("runtime verification failed");
                }
            };

            let failure;
            try {
                await deployProductionEntries({
                    selectedEntries: fixtureEntries(["files"]),
                    configs: fixtureConfigs(["files"]),
                    expectedCommit: COMMIT,
                    log: () => {},
                    operations: harness.operations,
                });
            } catch (error) {
                failure = error;
            }
            assert.ok(failure instanceof Error);
            assert.match(
                failure.message,
                /automatic rollback was dispatched and may have been applied, but confirmation failed/i
            );
            assert.doesNotMatch(failure.message, /automatic rollback refused/i);
            assert.equal(harness.current.get("files"), NEW_VERSION);
            await new Promise((resolve) => setTimeout(resolve, 0));
            assert.equal(harness.current.get("files"), OLD_VERSION);
        });
    }
});

test("rollback requires the exact invocation version tag at authorization time", async () => {
    const harness = createRolloutHarness(["files"]);
    const getVersion = harness.operations.getVersion;
    let reads = 0;
    harness.operations.getVersion = (input) => {
        reads += 1;
        const version = getVersion(input);
        if (reads >= 4) {
            version.annotations["workers/tag"] = "external-version-tag";
        }
        return version;
    };
    const verify = harness.operations.verify;
    harness.operations.verify = (input) => {
        verify(input);
        if (input.expectedCommit === COMMIT) {
            throw new Error("verification failed");
        }
    };
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /exact version and tag could not be safely unwound.*exact tagged Worker version/is
    );
    assert.equal(harness.current.get("files"), NEW_VERSION);
    assert.equal(
        harness.events.includes("activate:files:" + OLD_VERSION),
        false
    );
});

test("ambiguous rollback status cannot authorize a traffic mutation", async () => {
    const harness = createRolloutHarness(["files"]);
    let verificationFailed = false;
    const status = harness.operations.status;
    harness.operations.status = (input) => {
        if (verificationFailed) {
            return {
                versions: [
                    { version_id: NEW_VERSION, percentage: 50 },
                    { version_id: EXTERNAL_VERSION, percentage: 50 },
                ],
            };
        }
        return status(input);
    };
    const verify = harness.operations.verify;
    harness.operations.verify = (input) => {
        verify(input);
        if (input.expectedCommit === COMMIT) {
            verificationFailed = true;
            throw new Error("verification failed");
        }
    };
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /exact version and tag could not be safely unwound.*exactly one valid version/is
    );
    assert.equal(
        harness.events.includes("activate:files:" + OLD_VERSION),
        false
    );
});

test("a replacement Worker identity blocks automatic rollback", async () => {
    const harness = createRolloutHarness(["files"]);
    const verify = harness.operations.verify;
    harness.operations.verify = (input) => {
        verify(input);
        if (input.expectedCommit === COMMIT) {
            harness.workerTags.set("files", "replacement-worker-tag");
            throw new Error("verification failed after Worker recreation");
        }
    };
    await assert.rejects(
        deployProductionEntries({
            selectedEntries: fixtureEntries(["files"]),
            configs: fixtureConfigs(["files"]),
            expectedCommit: COMMIT,
            log: () => {},
            operations: harness.operations,
        }),
        /exact version and tag could not be safely unwound.*immutable Worker tag/is
    );
    assert.equal(
        harness.events.includes("activate:files:" + OLD_VERSION),
        false
    );
});

test("malformed captured JSON never exposes credentialed stdout", () => {
    const secretOutput =
        '{"token":"' +
        CLOUDFLARE_CREDENTIALS.CLOUDFLARE_API_TOKEN +
        '","account":"' +
        CLOUDFLARE_CREDENTIALS.CLOUDFLARE_ACCOUNT_ID;
    let failure;
    try {
        runCloudflareCapturedJson(
            "/tools/wrangler",
            ["deployments", "status", "--json"],
            CLOUDFLARE_CREDENTIALS,
            {
                run: () => ({
                    status: 0,
                    stdout: secretOutput,
                    stderr: "",
                }),
            }
        );
    } catch (error) {
        failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /returned malformed JSON output/);
    assert.doesNotMatch(
        failure.message,
        new RegExp(CLOUDFLARE_CREDENTIALS.CLOUDFLARE_API_TOKEN)
    );
    assert.doesNotMatch(
        failure.message,
        new RegExp(CLOUDFLARE_CREDENTIALS.CLOUDFLARE_ACCOUNT_ID)
    );
    assert.doesNotMatch(failure.message, /\"token\"/);
});

const canonicalRouteConfig = (id) => ({
    $schema: "../tools/wrangler/node_modules/wrangler/config-schema.json",
    name: "peerbit-examples-" + id,
    compatibility_date: "2026-07-13",
    workers_dev: false,
    preview_urls: false,
    routes: [
        {
            pattern: id + ".apps.peerbit.org",
            custom_domain: true,
        },
    ],
    ...(id === "stream"
        ? {
              main: "../cloudflare/cached-static-assets.mjs",
              cache: { enabled: true, cross_version_cache: false },
          }
        : {}),
    assets: {
        directory:
            id === "stream"
                ? "../packages/media-streaming/video-streaming/frontend/dist"
                : "../packages/file-share/frontend/dist",
        html_handling: "auto-trailing-slash",
        not_found_handling: "none",
    },
});

test("private deployment configs omit routes and retain absolute asset inputs", () => {
    const canonical = canonicalRouteConfig("stream");
    const configFile = path.join(repoRoot, ".wrangler-config", "stream.jsonc");
    const privateConfig = createRouteFreeWranglerConfig({
        configFile,
        renderedConfig: canonical,
        workerName: "peerbit-examples-stream",
    });

    assert.equal("routes" in privateConfig, false);
    assert.equal("route" in privateConfig, false);
    assert.equal("domains" in privateConfig, false);
    assert.equal("$schema" in privateConfig, false);
    assert.equal(
        privateConfig.main,
        path.join(repoRoot, "cloudflare/cached-static-assets.mjs")
    );
    assert.equal(
        privateConfig.assets.directory,
        path.join(
            repoRoot,
            "packages/media-streaming/video-streaming/frontend/dist"
        )
    );
    assert.equal(canonical.routes.length, 1);
    assert.equal(canonical.assets.directory.startsWith("../"), true);
    assert.throws(
        () =>
            createRouteFreeWranglerConfig({
                configFile,
                renderedConfig: {
                    ...canonical,
                    route: "stream.apps.peerbit.org",
                },
                workerName: "peerbit-examples-stream",
            }),
        /must not contain alternate route fields/
    );
    assert.throws(
        () =>
            createRouteFreeWranglerConfig({
                configFile,
                renderedConfig: {
                    ...canonical,
                    domains: ["stream.apps.peerbit.org"],
                },
                workerName: "peerbit-examples-stream",
            }),
        /must not contain alternate route fields/
    );
});

test("Wrangler versions upload receives only a private route-free config", () => {
    const canonical = canonicalRouteConfig("files");
    const canonicalFile = path.join(
        repoRoot,
        ".wrangler-config",
        "files.jsonc"
    );
    let invokedConfigFile;
    const versionTag = "peerbit_files_aaaaaaaaaaaa_test";
    const evidence = runWranglerVersionUpload({
        wrangler: "/tools/wrangler",
        configFile: canonicalFile,
        renderedConfig: canonical,
        site: { id: "files" },
        expectedCommit: COMMIT,
        workerName: "peerbit-examples-files",
        versionTag,
        environment: CLOUDFLARE_CREDENTIALS,
        runtime: {
            runLogged: (command, args, environment) => {
                assert.equal(command, "/tools/wrangler");
                assert.deepEqual(args.slice(0, 2), ["versions", "upload"]);
                assert.equal(args[args.indexOf("--tag") + 1], versionTag);
                assert.equal(
                    args.some((argument) =>
                        [
                            "--route",
                            "--routes",
                            "--domain",
                            "--domains",
                        ].includes(argument)
                    ),
                    false
                );
                invokedConfigFile = args[args.indexOf("--config") + 1];
                assert.notEqual(invokedConfigFile, canonicalFile);
                const invokedConfig = JSON.parse(
                    readFileSync(invokedConfigFile, "utf8")
                );
                assert.equal("routes" in invokedConfig, false);
                assert.equal("route" in invokedConfig, false);
                assert.equal("domains" in invokedConfig, false);
                assert.equal(
                    invokedConfig.assets.directory,
                    path.join(repoRoot, "packages/file-share/frontend/dist")
                );
                assert.equal(statSync(invokedConfigFile).mode & 0o777, 0o600);
                assert.equal(
                    statSync(path.dirname(invokedConfigFile)).mode & 0o077,
                    0
                );
                writeFileSync(
                    environment.WRANGLER_OUTPUT_FILE_PATH,
                    wranglerVersionUploadRecord() + "\n",
                    "utf8"
                );
            },
        },
    });

    assert.deepEqual(evidence, deploymentEvidence("files"));
    assert.ok(invokedConfigFile);
    assert.equal(existsSync(path.dirname(invokedConfigFile)), false);
});

test("unexpected Wrangler Preview URL output fails closed without exposing the account slug", () => {
    const accountSlug = "private-account-slug";
    const previewUrl = `https://version-files.${accountSlug}.workers.dev`;
    let failure;
    try {
        runWranglerVersionUpload({
            wrangler: "/tools/wrangler",
            configFile: path.join(repoRoot, ".wrangler-config", "files.jsonc"),
            renderedConfig: canonicalRouteConfig("files"),
            site: { id: "files" },
            expectedCommit: COMMIT,
            workerName: "peerbit-examples-files",
            versionTag: "peerbit_files_aaaaaaaaaaaa_preview_guard",
            environment: CLOUDFLARE_CREDENTIALS,
            runtime: {
                runLogged: (_command, _args, environment, output) => {
                    assert.equal(typeof output.writeStdout, "function");
                    assert.equal(typeof output.writeStderr, "function");
                    output.writeStdout(previewUrl);
                    output.writeStderr(previewUrl);
                    writeFileSync(
                        environment.WRANGLER_OUTPUT_FILE_PATH,
                        wranglerVersionUploadRecord() + "\n",
                        "utf8"
                    );
                    return { stdout: previewUrl, stderr: "" };
                },
            },
        });
    } catch (error) {
        failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /unexpected workers\.dev/);
    assert.doesNotMatch(failure.message, new RegExp(accountSlug));
    assert.doesNotMatch(failure.message, /version-files/);
});

test("pinned Wrangler version upload cannot invoke route or domain publishers", () => {
    const wranglerPackage = JSON.parse(
        readFileSync(path.join(repoRoot, "tools/wrangler/package.json"), "utf8")
    );
    const wranglerLock = JSON.parse(
        readFileSync(
            path.join(repoRoot, "tools/wrangler/package-lock.json"),
            "utf8"
        )
    );
    assert.equal(wranglerPackage.devDependencies.wrangler, "4.110.0");
    assert.equal(
        wranglerLock.packages["node_modules/wrangler"].version,
        "4.110.0"
    );
    assert.match(
        wranglerLock.packages["node_modules/wrangler"].integrity,
        /^sha512-/
    );

    const bundleFile = path.join(
        repoRoot,
        "tools/wrangler/node_modules/wrangler/wrangler-dist/cli.js"
    );
    assert.equal(
        existsSync(bundleFile),
        true,
        "install the exact locked Wrangler before running safety tests"
    );
    const bundle = readFileSync(bundleFile, "utf8");

    const mergeStart = bundle.indexOf(
        "async function mergeVersionsUploadConfigArgs(args, config2)"
    );
    const mergeEnd = bundle.indexOf(
        "\nfunction cleanupDestination",
        mergeStart
    );
    assert.ok(mergeStart >= 0 && mergeEnd > mergeStart);
    const mergeUpload = bundle.slice(mergeStart, mergeEnd);
    assert.doesNotMatch(mergeUpload, /routes|domains|triggers/);

    const uploadStart = bundle.indexOf(
        "async function versionsUpload(props, config2, buildResult, callbacks)"
    );
    const uploadEnd = bundle.indexOf(
        "\nfunction sanitizeBranchName",
        uploadStart
    );
    assert.ok(uploadStart >= 0 && uploadEnd > uploadStart);
    const upload = bundle.slice(uploadStart, uploadEnd);
    assert.match(upload, /`\$\{workerUrl\}\/versions`[\s\S]*method: "POST"/);
    assert.match(
        upload,
        /Changes to triggers \(routes, custom domains, cron schedules, etc\) must be applied with the command/
    );
    assert.doesNotMatch(upload, /\btriggersDeploy\(/);
    assert.doesNotMatch(upload, /\bpublishRoutes\(|\bpublishCustomDomains\(/);
    assert.doesNotMatch(upload, /\/domains\/records|\/routes/);
});
