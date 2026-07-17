import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
    inspectCloudflareWorkerVersionSchema,
    parseCloudflareSchemaDiagnosticArgs,
    runCloudflareSchemaDiagnostic,
    summarizeCloudflareValue,
} from "../scripts/inspect-cloudflare-worker-version-schema.mjs";
import {
    loadCloudflareDeploymentData,
    repoRoot,
} from "../scripts/cloudflare-deployment-policy.mjs";

const WORKER = "peerbit-examples-stream";
const VERSION = "6611351f-c286-4b3e-9904-bf51afe74cee";
const ACCOUNT_ID = "a".repeat(32);
const API_TOKEN = "TOKEN_SENTINEL_DO_NOT_LEAK";
const BODY_SENTINEL = "BODY_SENTINEL_DO_NOT_LEAK";
const JWT_SENTINEL = "JWT_SENTINEL_DO_NOT_LEAK";
const NETWORK_SENTINEL = "NETWORK_SENTINEL_DO_NOT_LEAK";
const EXPECTED_URL =
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}` +
    `/workers/scripts/${WORKER}/versions/${VERSION}`;

const jsonResponse = (payload, { status = 200 } = {}) =>
    new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
    });

const successfulPayload = () => ({
    success: true,
    errors: [],
    messages: [BODY_SENTINEL],
    result: {
        id: VERSION,
        number: 2,
        enabled: true,
        nullable: null,
        resources: {
            bindings: [{ name: "ASSETS", type: "assets" }],
            script_runtime: {
                compatibility_date: "2026-07-17",
                assets: {
                    config: {
                        html_handling: "auto-trailing-slash",
                        not_found_handling: "single-page-application",
                        run_worker_first: false,
                    },
                    jwt: JWT_SENTINEL,
                },
                cache_options: { enabled: true },
            },
        },
        cache_options: { enabled: true },
    },
});

const assertRedactedTree = (value, key = "root") => {
    if (typeof value === "boolean") return;
    if (Array.isArray(value)) {
        for (const item of value) assertRedactedTree(item, "array-item");
        return;
    }
    if (value && typeof value === "object") {
        for (const [childKey, childValue] of Object.entries(value)) {
            assertRedactedTree(childValue, childKey);
        }
        return;
    }
    if (typeof value === "string") {
        if (key === "type") {
            assert.ok(
                [
                    "null",
                    "boolean",
                    "string",
                    "number",
                    "array",
                    "object",
                ].includes(value)
            );
            return;
        }
        assert.equal(key, "sha256");
        assert.match(value, /^[0-9a-f]{64}$/);
        return;
    }
    assert.fail(`Unexpected diagnostic leaf at ${key}: ${typeof value}`);
};

test("schema diagnostic makes one exact GET and emits only redacted structure", async () => {
    const calls = [];
    const output = [];
    const request = async (...args) => {
        calls.push(args);
        return jsonResponse(successfulPayload());
    };

    const summary = await runCloudflareSchemaDiagnostic({
        argv: ["--worker", WORKER, "--version", VERSION],
        env: {
            CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
            CLOUDFLARE_PRODUCTION_API_TOKEN: API_TOKEN,
        },
        request,
        write: (line) => output.push(line),
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], EXPECTED_URL);
    assert.deepEqual(
        {
            method: calls[0][1].method,
            headers: calls[0][1].headers,
            redirect: calls[0][1].redirect,
            hasBody: Object.hasOwn(calls[0][1], "body"),
        },
        {
            method: "GET",
            headers: { Authorization: `Bearer ${API_TOKEN}` },
            redirect: "error",
            hasBody: false,
        }
    );
    assert.ok(calls[0][1].signal instanceof AbortSignal);
    assert.equal(output.length, 1);
    assert.deepEqual(JSON.parse(output[0]), summary);
    for (const forbidden of [
        API_TOKEN,
        BODY_SENTINEL,
        JWT_SENTINEL,
        ACCOUNT_ID,
        WORKER,
        VERSION,
        "Bearer",
        "Authorization",
        "auto-trailing-slash",
        "single-page-application",
    ]) {
        assert.doesNotMatch(output[0], new RegExp(forbidden, "u"));
    }
    assert.deepEqual(summary.request, {
        workerMatchedDeploymentPolicy: true,
        versionMatchedStrictUuid: true,
        methodWasGet: true,
        responseVersionMatchedRequest: true,
    });
    assert.deepEqual(summary.comparisons, {
        runtimeAssetsPresent: true,
        runtimeCacheOptionsPresent: true,
        topLevelAssetsPresent: false,
        topLevelCacheOptionsPresent: true,
        runtimeAssetsEqualsTopLevelAssets: false,
        runtimeCacheOptionsEqualsTopLevelCacheOptions: true,
    });
    assert.equal(
        summary.response.fields.resources.fields.script_runtime.fields.assets
            .fields.config.fields.run_worker_first.value,
        false
    );
    assert.equal(
        summary.response.fields.resources.fields.script_runtime.fields
            .cache_options.fields.enabled.value,
        true
    );
    assert.match(summary.response.fields.id.sha256, /^[0-9a-f]{64}$/);
    assertRedactedTree(summary);
});

test("unknown Workers and malformed versions are rejected before fetch", async (t) => {
    const cases = [
        {
            name: "unknown Worker",
            worker: "peerbit-examples-not-reviewed",
            version: VERSION,
            error: /reviewed production deployment policy/,
        },
        {
            name: "non-UUID version",
            worker: WORKER,
            version: "../deployments",
            error: /exact lowercase UUID/,
        },
        {
            name: "uppercase UUID version",
            worker: WORKER,
            version: VERSION.toUpperCase(),
            error: /exact lowercase UUID/,
        },
        {
            name: "uppercase account ID",
            worker: WORKER,
            version: VERSION,
            accountId: "A".repeat(32),
            error: /32 lowercase hexadecimal/,
        },
        {
            name: "short account ID",
            worker: WORKER,
            version: VERSION,
            accountId: "a".repeat(31),
            error: /32 lowercase hexadecimal/,
        },
        {
            name: "empty token",
            worker: WORKER,
            version: VERSION,
            apiToken: "",
            error: /missing or malformed/,
        },
        {
            name: "token containing whitespace",
            worker: WORKER,
            version: VERSION,
            apiToken: "invalid token",
            error: /missing or malformed/,
        },
    ];
    for (const item of cases) {
        await t.test(item.name, async () => {
            let requests = 0;
            await assert.rejects(
                inspectCloudflareWorkerVersionSchema({
                    worker: item.worker,
                    version: item.version,
                    accountId: item.accountId ?? ACCOUNT_ID,
                    apiToken: item.apiToken ?? API_TOKEN,
                    request: async () => {
                        requests += 1;
                        return jsonResponse(successfulPayload());
                    },
                }),
                item.error
            );
            assert.equal(requests, 0);
        });
    }
});

test("API, transport, and body errors never expose credentials or response text", async (t) => {
    const cases = [
        {
            name: "API error body",
            request: async () =>
                jsonResponse(
                    {
                        success: false,
                        errors: [
                            {
                                message: `${BODY_SENTINEL} ${JWT_SENTINEL} ${API_TOKEN}`,
                            },
                        ],
                    },
                    { status: 403 }
                ),
            expected: /HTTP 403/,
        },
        {
            name: "wrong version body",
            request: async () =>
                jsonResponse({
                    success: true,
                    result: { id: BODY_SENTINEL },
                }),
            expected: /different Worker version/,
        },
        {
            name: "malformed body",
            request: async () =>
                new Response(`${BODY_SENTINEL}{`, { status: 200 }),
            expected: /not valid JSON/,
        },
        {
            name: "unreadable body",
            request: async () => ({
                ok: true,
                status: 200,
                text: async () => {
                    throw new Error(BODY_SENTINEL);
                },
            }),
            expected: /body was unreadable/,
        },
        {
            name: "transport error",
            request: async () => {
                throw new Error(
                    `${NETWORK_SENTINEL} ${BODY_SENTINEL} ${JWT_SENTINEL} ${API_TOKEN} ${EXPECTED_URL}`
                );
            },
            expected: /network request failed/,
        },
    ];
    for (const item of cases) {
        await t.test(item.name, async () => {
            let calls = 0;
            let observed;
            try {
                await inspectCloudflareWorkerVersionSchema({
                    worker: WORKER,
                    version: VERSION,
                    accountId: ACCOUNT_ID,
                    apiToken: API_TOKEN,
                    request: async (...args) => {
                        calls += 1;
                        return item.request(...args);
                    },
                });
            } catch (error) {
                observed = error;
            }
            assert.ok(observed instanceof Error);
            assert.match(observed.message, item.expected);
            for (const forbidden of [
                API_TOKEN,
                BODY_SENTINEL,
                JWT_SENTINEL,
                NETWORK_SENTINEL,
                ACCOUNT_ID,
                WORKER,
                VERSION,
                EXPECTED_URL,
            ]) {
                assert.doesNotMatch(
                    observed.message,
                    new RegExp(forbidden, "u")
                );
            }
            assert.equal(calls, 1);
        });
    }
});

test("byte, structure, cycle, and primitive limits fail without exposing values", async (t) => {
    await t.test("UTF-8 response byte cap", async () => {
        const multibyteSentinel = "é".repeat(1_100_000);
        const body = JSON.stringify({
            success: true,
            result: { value: multibyteSentinel },
        });
        assert.ok(body.length < 2 * 1024 * 1024);
        let observed;
        try {
            await inspectCloudflareWorkerVersionSchema({
                worker: WORKER,
                version: VERSION,
                accountId: ACCOUNT_ID,
                apiToken: API_TOKEN,
                request: async () => new Response(body, { status: 200 }),
            });
        } catch (error) {
            observed = error;
        }
        assert.ok(observed instanceof Error);
        assert.match(observed.message, /exceeded safe limits/);
        assert.doesNotMatch(observed.message, /é/);
    });

    const tooDeep = {};
    let cursor = tooDeep;
    for (let index = 0; index < 40; index += 1) {
        cursor.child = {};
        cursor = cursor.child;
    }
    assert.throws(
        () => summarizeCloudflareValue(tooDeep),
        /exceeds safe limits/
    );
    assert.throws(
        () => summarizeCloudflareValue(new Array(10_001).fill(true)),
        /exceeds safe limits/
    );
    assert.throws(
        () =>
            summarizeCloudflareValue(
                Object.fromEntries(
                    Array.from({ length: 1_001 }, (_, index) => [
                        `field_${index}`,
                        true,
                    ])
                )
            ),
        /exceeds safe limits/
    );
    assert.throws(
        () =>
            summarizeCloudflareValue(
                Array.from({ length: 5_000 }, () => new Array(10).fill(true))
            ),
        /exceeds safe limits/
    );
    const cyclic = { safe: true };
    cyclic.self = cyclic;
    assert.throws(
        () => summarizeCloudflareValue(cyclic),
        /encountered invalid JSON/
    );
    for (const unsupported of [
        undefined,
        1n,
        Symbol("secret"),
        () => BODY_SENTINEL,
    ]) {
        assert.throws(
            () => summarizeCloudflareValue(unsupported),
            /encountered invalid JSON/
        );
    }
});

test("CLI accepts only the fixed Worker and version argument surface", () => {
    assert.deepEqual(
        parseCloudflareSchemaDiagnosticArgs([
            "--worker",
            WORKER,
            "--version",
            VERSION,
        ]),
        { worker: WORKER, version: VERSION }
    );
    for (const argv of [
        ["--version", VERSION, "--worker", WORKER],
        ["--worker", WORKER, "--version", VERSION, "--url", "https://x"],
        ["--worker", WORKER, "--method", "POST"],
    ]) {
        assert.throws(
            () => parseCloudflareSchemaDiagnosticArgs(argv),
            /Usage:/
        );
    }
});

test("manual diagnostic workflow is protected and matches the deployment policy", () => {
    const workflow = readFileSync(
        path.join(
            repoRoot,
            ".github/workflows/cloudflare-version-schema-diagnostic.yml"
        ),
        "utf8"
    );
    const script = readFileSync(
        path.join(
            repoRoot,
            "scripts/inspect-cloudflare-worker-version-schema.mjs"
        ),
        "utf8"
    );
    assert.match(workflow, /^on:\n\s+workflow_dispatch:/m);
    assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|schedule):/m);
    assert.match(workflow, /^permissions:\n\s+contents: read$/m);
    assert.match(workflow, /environment: cloudflare-production/);
    assert.match(workflow, /"refs\/heads\/master"/);
    assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(workflow, /persist-credentials: false/);
    assert.match(
        workflow,
        /actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0/
    );
    assert.match(
        workflow,
        /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/
    );
    assert.match(
        workflow,
        /CLOUDFLARE_PRODUCTION_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_PRODUCTION_API_TOKEN \}\}/
    );
    assert.match(
        workflow,
        /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/
    );
    assert.doesNotMatch(workflow, /vars\.CLOUDFLARE_/);
    const workerBlock = workflow.split("            version:", 1)[0];
    const options = [
        ...workerBlock.matchAll(/^\s+- (peerbit-examples-[a-z0-9-]+)$/gm),
    ].map((match) => match[1]);
    assert.deepEqual(
        options,
        loadCloudflareDeploymentData().entries.map(
            ({ policy }) => policy.productionWorker
        )
    );
    assert.equal((script.match(/await request\(/g) ?? []).length, 1);
    assert.equal((script.match(/method: "GET"/g) ?? []).length, 1);
    assert.doesNotMatch(script, /method: "(?:POST|PUT|PATCH|DELETE)"/);
    assert.doesNotMatch(script, /--(?:url|method|body)/);
    assert.match(script, /redirect: "error"/);
    assert.match(
        script,
        /workers\/scripts\/\$\{worker\}\/versions\/\$\{version\}/
    );
});
