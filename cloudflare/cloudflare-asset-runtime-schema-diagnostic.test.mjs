import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
    ASSET_RUNTIME_DIAGNOSTIC_MODE,
    ASSET_RUNTIME_DIAGNOSTIC_WORKER,
    inspectActiveAssetRuntimeSchema,
    parseAssetRuntimeSchemaDiagnosticArgs,
    runAssetRuntimeSchemaDiagnostic,
} from "../scripts/inspect-cloudflare-asset-runtime-schema.mjs";
import {
    loadCloudflareDeploymentData,
    repoRoot,
} from "../scripts/cloudflare-deployment-policy.mjs";
import { accountZoneInventorySha256 } from "../scripts/deploy-cloudflare-production.mjs";

const MODE = ASSET_RUNTIME_DIAGNOSTIC_MODE;
const WORKER = ASSET_RUNTIME_DIAGNOSTIC_WORKER;
const DEPLOYMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_DEPLOYMENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const VERSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_VERSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACCOUNT_ID = "a".repeat(32);
const WRONG_ACCOUNT_ID = "f".repeat(32);
const ZONE_ID = "e".repeat(32);
const ZONE_NAME = "peerbit.org";
const API_TOKEN = "TOKEN_SENTINEL_DO_NOT_LEAK";
const BODY_SENTINEL = "BODY_SENTINEL_DO_NOT_LEAK";
const DYNAMIC_KEY = "PRIVATE_DYNAMIC_KEY_DO_NOT_LEAK";
const LOW_ENTROPY_STRING = "x";
const LOW_ENTROPY_NUMBER = 42;
const POLICY_SENTINEL = "POLICY_SENTINEL_DO_NOT_LEAK";
const EXPECTED_ACCOUNT_FINGERPRINT = accountZoneInventorySha256([
    { zoneId: ZONE_ID, zoneName: ZONE_NAME },
]);
const WORKER_URL =
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}` +
    `/workers/scripts/${WORKER}`;
const DEPLOYMENTS_URL = `${WORKER_URL}/deployments`;
const VERSION_URL = `${WORKER_URL}/versions/${VERSION}`;
const ZONE_ROUTES_URL =
    `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}` + "/workers/routes";

const RAW_HEADERS = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

/assets/*
  Cache-Control: public, max-age=31556952, immutable
`;

const reviewedHeaders = () => ({
    rules: {
        "/*": {
            set: {
                "referrer-policy": "strict-origin-when-cross-origin",
                "x-content-type-options": "nosniff",
            },
            unset: [],
        },
        "/assets/*": {
            set: {
                "cache-control": "public, max-age=31556952, immutable",
            },
            unset: [],
        },
    },
    version: 2,
});

const jsonResponse = (payload, { status = 200 } = {}) =>
    new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
    });

const deploymentPayload = ({
    deploymentId = DEPLOYMENT,
    versionId = VERSION,
    percentage = 100,
    versions,
} = {}) => ({
    success: true,
    errors: [],
    messages: [BODY_SENTINEL],
    result: {
        deployments: [
            {
                id: deploymentId,
                versions: versions ?? [{ version_id: versionId, percentage }],
            },
            {
                id: OTHER_DEPLOYMENT,
                versions: [{ version_id: OTHER_VERSION, percentage: 100 }],
            },
        ],
    },
});

const versionPayload = ({ mutate } = {}) => {
    const payload = {
        success: true,
        errors: [],
        messages: [BODY_SENTINEL],
        result: {
            id: VERSION,
            number: LOW_ENTROPY_NUMBER,
            metadata: {
                [DYNAMIC_KEY]: LOW_ENTROPY_STRING,
            },
            resources: {
                bindings: [
                    {
                        name: LOW_ENTROPY_STRING,
                        type: LOW_ENTROPY_STRING,
                    },
                ],
                script: {
                    etag: LOW_ENTROPY_STRING,
                    handlers: ["fetch"],
                    named_handlers: [],
                    [DYNAMIC_KEY]: LOW_ENTROPY_STRING,
                },
                script_runtime: {
                    assets: {
                        headers: reviewedHeaders(),
                        html_handling: "auto-trailing-slash",
                        not_found_handling: "none",
                        raw_headers: RAW_HEADERS,
                        raw_run_worker_first: [],
                        serve_directly: true,
                        static_routing: { user_worker: [] },
                        [DYNAMIC_KEY]: LOW_ENTROPY_STRING,
                    },
                    compatibility_date: "2026-07-13",
                    usage_model: "standard",
                    [DYNAMIC_KEY]: LOW_ENTROPY_NUMBER,
                },
            },
            [DYNAMIC_KEY]: LOW_ENTROPY_STRING,
        },
    };
    mutate?.(payload.result);
    return payload;
};

const zonePayload = ({ zoneAccountId = ACCOUNT_ID } = {}) => ({
    success: true,
    result: [
        {
            id: ZONE_ID,
            name: ZONE_NAME,
            status: "active",
            type: "full",
            account: { id: zoneAccountId, name: LOW_ENTROPY_STRING },
        },
    ],
    result_info: {
        count: 1,
        page: 1,
        per_page: 50,
        total_count: 1,
        total_pages: 1,
    },
});

const createReadOnlyRequestHarness = ({
    firstDeployment = deploymentPayload(),
    finalDeployment = firstDeployment,
    version = versionPayload(),
    zoneAccountId = ACCOUNT_ID,
} = {}) => {
    const calls = [];
    let deploymentReads = 0;
    const request = async (url, init = {}) => {
        calls.push([url, init]);
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/zones")) {
            return jsonResponse(zonePayload({ zoneAccountId }));
        }
        if (url === ZONE_ROUTES_URL) {
            return jsonResponse({ success: true, result: [] });
        }
        if (url === DEPLOYMENTS_URL) {
            deploymentReads += 1;
            return jsonResponse(
                deploymentReads === 1 ? firstDeployment : finalDeployment
            );
        }
        if (url === VERSION_URL) return jsonResponse(version);
        throw new Error(`Unexpected request target: ${url}`);
    };
    return {
        calls,
        request,
        workerCalls: () =>
            calls.filter(([url]) => url.includes("/workers/scripts/")),
        accountCalls: () =>
            calls.filter(([url]) => !url.includes("/workers/scripts/")),
    };
};

const invocation = ({ request, loadPolicy, overrides = {} }) => ({
    mode: MODE,
    worker: WORKER,
    accountId: ACCOUNT_ID,
    runtimeDiagnosticApiToken: API_TOKEN,
    expectedAccountZoneInventorySha256: EXPECTED_ACCOUNT_FINGERPRINT,
    request,
    ...(loadPolicy ? { loadPolicy } : {}),
    ...overrides,
});

const leafValues = (root) => {
    const leaves = [];
    const visit = (value) => {
        if (value && typeof value === "object") {
            assert.equal(Array.isArray(value), false);
            for (const child of Object.values(value)) visit(child);
        } else {
            leaves.push(value);
        }
    };
    visit(root);
    return leaves;
};

const REVIEWED_CLASSIFICATIONS = new Set([
    "absent",
    "other",
    "exact-reviewed",
    "exact-empty",
    "exact-empty-object",
    "exact-enabled-no-cross-version",
    "exact-fetch-only",
    "exact-true",
    "exact-empty-user-worker",
]);

const assertFixedSafeLeaves = (summary) => {
    for (const value of leafValues(summary)) {
        if (typeof value === "boolean") continue;
        if (typeof value === "number") {
            assert.ok(Number.isSafeInteger(value));
            assert.ok(value >= 0 && value <= 1_000);
            continue;
        }
        assert.equal(typeof value, "string");
        assert.ok(
            REVIEWED_CLASSIFICATIONS.has(value),
            `Unexpected diagnostic classification ${JSON.stringify(value)}`
        );
    }
};

test("read-only diagnostic binds the account and brackets one exact version with stable deployments", async () => {
    const harness = createReadOnlyRequestHarness();
    const output = [];
    let policyReads = 0;
    const summary = await runAssetRuntimeSchemaDiagnostic({
        argv: ["--mode", MODE, "--worker", WORKER],
        env: {
            CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
            CLOUDFLARE_RUNTIME_DIAGNOSTIC_API_TOKEN: API_TOKEN,
            CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256:
                EXPECTED_ACCOUNT_FINGERPRINT,
        },
        request: harness.request,
        loadPolicy: () => {
            policyReads += 1;
            return loadCloudflareDeploymentData();
        },
        write: (line) => output.push(line),
    });

    assert.equal(policyReads, 5);
    assert.equal(harness.accountCalls().length, 4);
    assert.deepEqual(
        harness.workerCalls().map(([url]) => url),
        [DEPLOYMENTS_URL, VERSION_URL, DEPLOYMENTS_URL]
    );
    assert.ok(
        harness.calls.every(([, init]) => init.method === "GET"),
        "every account and Worker operation must remain GET-only"
    );
    assert.ok(harness.calls.every(([, init]) => !Object.hasOwn(init, "body")));
    for (const [, init] of harness.workerCalls()) {
        assert.equal(init.redirect, "error");
        assert.deepEqual(init.headers, {
            Authorization: `Bearer ${API_TOKEN}`,
        });
    }
    assert.equal(output.length, 1);
    assert.deepEqual(JSON.parse(output[0]), summary);
    assert.deepEqual(summary.evidence, {
        activeModeMatched: true,
        workerMatchedExactAssetPreviewPolicy: true,
        accountIdentityMatchedReviewedFingerprint: true,
        policyStableAcrossReadSequence: true,
        activeDeploymentMatchedSingleFullTrafficVersion: true,
        deploymentStableAroundVersionRead: true,
        workerMethodsWereGet: true,
        responseVersionMatchedActiveDeployment: true,
    });
    assert.deepEqual(summary.shape.topLevel, {
        assetsDuplicatePresent: false,
        cacheOptionsDuplicatePresent: false,
    });
    assert.deepEqual(
        {
            present: summary.shape.scriptRuntime.present,
            isObject: summary.shape.scriptRuntime.isObject,
            fieldCount: summary.shape.scriptRuntime.fieldCount,
            knownFieldCount: summary.shape.scriptRuntime.knownFieldCount,
            unknownFieldCount: summary.shape.scriptRuntime.unknownFieldCount,
            assetsPresent: summary.shape.scriptRuntime.assetsPresent,
        },
        {
            present: true,
            isObject: true,
            fieldCount: 4,
            knownFieldCount: 3,
            unknownFieldCount: 1,
            assetsPresent: true,
        }
    );
    assert.deepEqual(
        {
            present: summary.shape.assets.present,
            isObject: summary.shape.assets.isObject,
            fieldCount: summary.shape.assets.fieldCount,
            knownFieldCount: summary.shape.assets.knownFieldCount,
            unknownFieldCount: summary.shape.assets.unknownFieldCount,
            rawRunWorkerFirstClassification:
                summary.shape.assets.rawRunWorkerFirstClassification,
            staticRoutingClassification:
                summary.shape.assets.staticRoutingClassification,
        },
        {
            present: true,
            isObject: true,
            fieldCount: 8,
            knownFieldCount: 7,
            unknownFieldCount: 1,
            rawRunWorkerFirstClassification: "exact-empty",
            staticRoutingClassification: "exact-empty-user-worker",
        }
    );
    assert.equal(summary.shape.assets.headersClassification, "exact-reviewed");
    assert.equal(
        summary.shape.assets.rawHeadersClassification,
        "exact-reviewed"
    );
    assert.equal(
        summary.shape.scriptRuntime.cacheOptionsClassification,
        "absent"
    );
    assertFixedSafeLeaves(summary);

    const serialized = output[0];
    for (const forbidden of [
        API_TOKEN,
        BODY_SENTINEL,
        ACCOUNT_ID,
        ZONE_ID,
        ZONE_NAME,
        EXPECTED_ACCOUNT_FINGERPRINT,
        WORKER,
        DEPLOYMENT,
        VERSION,
        OTHER_DEPLOYMENT,
        OTHER_VERSION,
        DYNAMIC_KEY,
        RAW_HEADERS,
        "sha256",
        "metadata",
        "etag",
    ]) {
        assert.doesNotMatch(serialized, new RegExp(forbidden, "u"));
    }
    const leaves = leafValues(summary);
    assert.equal(leaves.includes(LOW_ENTROPY_STRING), false);
    assert.equal(leaves.includes(LOW_ENTROPY_NUMBER), false);
});

test("routing classifications disclose no route values", async (t) => {
    const cases = [
        {
            name: "absent routing fields",
            mutate: (version) => {
                delete version.resources.script_runtime.assets
                    .raw_run_worker_first;
                delete version.resources.script_runtime.assets.static_routing;
            },
            expectedRaw: "absent",
            expectedStatic: "absent",
            expectedCount: 0,
        },
        {
            name: "nonempty routing fields",
            mutate: (version) => {
                version.resources.script_runtime.assets.raw_run_worker_first = [
                    LOW_ENTROPY_STRING,
                ];
                version.resources.script_runtime.assets.static_routing = {
                    user_worker: [LOW_ENTROPY_STRING],
                };
            },
            expectedRaw: "other",
            expectedStatic: "other",
            expectedCount: 1,
        },
    ];
    for (const item of cases) {
        await t.test(item.name, async () => {
            const harness = createReadOnlyRequestHarness({
                version: versionPayload({ mutate: item.mutate }),
            });
            const summary = await inspectActiveAssetRuntimeSchema(
                invocation({ request: harness.request })
            );
            assert.equal(
                summary.shape.assets.rawRunWorkerFirstClassification,
                item.expectedRaw
            );
            assert.equal(
                summary.shape.assets.staticRoutingClassification,
                item.expectedStatic
            );
            assert.equal(
                summary.shape.assets.rawRunWorkerFirstCount,
                item.expectedCount
            );
            assert.equal(
                summary.shape.assets.staticRoutingUserWorkerCount,
                item.expectedCount
            );
            assert.equal(
                leafValues(summary).includes(LOW_ENTROPY_STRING),
                false
            );
            assertFixedSafeLeaves(summary);
        });
    }
});

test("mode, Worker, and read-only credentials fail before every request", async (t) => {
    const cases = [
        {
            name: "non-active mode",
            overrides: { mode: "exact" },
            error: /mode must exactly equal active/,
        },
        {
            name: "different reviewed preview Worker",
            overrides: { worker: "peerbit-examples-files-preview" },
            error: /single reviewed asset-only preview Worker/,
        },
        {
            name: "arbitrary Worker",
            overrides: { worker: "unrelated-worker" },
            error: /single reviewed asset-only preview Worker/,
        },
        {
            name: "uppercase account ID",
            overrides: { accountId: "A".repeat(32) },
            error: /32 lowercase hexadecimal/,
        },
        {
            name: "empty token",
            overrides: { runtimeDiagnosticApiToken: "" },
            error: /read-only API token is missing or malformed/,
        },
        {
            name: "token with whitespace",
            overrides: { runtimeDiagnosticApiToken: "invalid token" },
            error: /read-only API token is missing or malformed/,
        },
    ];
    for (const item of cases) {
        await t.test(item.name, async () => {
            let requests = 0;
            await assert.rejects(
                inspectActiveAssetRuntimeSchema(
                    invocation({
                        request: async () => {
                            requests += 1;
                            return jsonResponse(zonePayload());
                        },
                        overrides: item.overrides,
                    })
                ),
                item.error
            );
            assert.equal(requests, 0);
        });
    }
});

test("account fingerprint and wrong-account failures precede every Worker endpoint", async (t) => {
    await t.test("missing fingerprint", async () => {
        let requests = 0;
        await assert.rejects(
            inspectActiveAssetRuntimeSchema(
                invocation({
                    request: async () => {
                        requests += 1;
                        return jsonResponse(zonePayload());
                    },
                    overrides: {
                        expectedAccountZoneInventorySha256: undefined,
                    },
                })
            ),
            /must be an exact lowercase SHA-256 digest/
        );
        assert.equal(requests, 0);
    });

    await t.test("malformed fingerprint", async () => {
        let requests = 0;
        await assert.rejects(
            inspectActiveAssetRuntimeSchema(
                invocation({
                    request: async () => {
                        requests += 1;
                        return jsonResponse(zonePayload());
                    },
                    overrides: {
                        expectedAccountZoneInventorySha256: "F".repeat(64),
                    },
                })
            ),
            /must be an exact lowercase SHA-256 digest/
        );
        assert.equal(requests, 0);
    });

    await t.test("fingerprint mismatch", async () => {
        const harness = createReadOnlyRequestHarness();
        await assert.rejects(
            inspectActiveAssetRuntimeSchema(
                invocation({
                    request: harness.request,
                    overrides: {
                        expectedAccountZoneInventorySha256: "0".repeat(64),
                    },
                })
            ),
            /does not match the independently reviewed fingerprint/
        );
        assert.equal(harness.accountCalls().length, 4);
        assert.equal(harness.workerCalls().length, 0);
    });

    await t.test("wrong-account zone", async () => {
        const harness = createReadOnlyRequestHarness({
            zoneAccountId: WRONG_ACCOUNT_ID,
        });
        await assert.rejects(
            inspectActiveAssetRuntimeSchema(
                invocation({ request: harness.request })
            ),
            /account identity validation failed/
        );
        assert.equal(harness.accountCalls().length, 1);
        assert.equal(harness.workerCalls().length, 0);
    });
});

test("account and Worker read failures redact credentials and response values", async (t) => {
    const cases = [
        {
            name: "account API failure",
            makeRequest: () => {
                const calls = [];
                return {
                    calls,
                    request: async (url, init) => {
                        calls.push([url, init]);
                        return jsonResponse(
                            {
                                success: false,
                                errors: [
                                    {
                                        message: `${API_TOKEN} ${ACCOUNT_ID} ${BODY_SENTINEL}`,
                                    },
                                ],
                            },
                            { status: 403 }
                        );
                    },
                };
            },
            error: /account identity validation failed/,
            workerCalls: 0,
        },
        {
            name: "deployment transport failure",
            makeRequest: () => {
                const harness = createReadOnlyRequestHarness();
                return {
                    calls: harness.calls,
                    request: async (url, init) => {
                        if (url === DEPLOYMENTS_URL) {
                            harness.calls.push([url, init]);
                            throw new Error(
                                `${API_TOKEN} ${ACCOUNT_ID} ${BODY_SENTINEL}`
                            );
                        }
                        return harness.request(url, init);
                    },
                };
            },
            error: /network request failed/,
            workerCalls: 1,
        },
        {
            name: "version API failure",
            makeRequest: () => {
                const harness = createReadOnlyRequestHarness();
                return {
                    calls: harness.calls,
                    request: async (url, init) => {
                        if (url === VERSION_URL) {
                            harness.calls.push([url, init]);
                            return jsonResponse(
                                {
                                    success: false,
                                    errors: [
                                        {
                                            message: `${API_TOKEN} ${ACCOUNT_ID} ${BODY_SENTINEL}`,
                                        },
                                    ],
                                },
                                { status: 403 }
                            );
                        }
                        return harness.request(url, init);
                    },
                };
            },
            error: /HTTP 403/,
            workerCalls: 2,
        },
    ];
    for (const item of cases) {
        await t.test(item.name, async () => {
            const harness = item.makeRequest();
            let observed;
            try {
                await inspectActiveAssetRuntimeSchema(
                    invocation({ request: harness.request })
                );
            } catch (error) {
                observed = error;
            }
            assert.ok(observed instanceof Error);
            assert.match(observed.message, item.error);
            for (const forbidden of [
                API_TOKEN,
                ACCOUNT_ID,
                BODY_SENTINEL,
                EXPECTED_ACCOUNT_FINGERPRINT,
                WORKER,
                DEPLOYMENT,
                VERSION,
            ]) {
                assert.doesNotMatch(
                    observed.message,
                    new RegExp(forbidden, "u")
                );
            }
            assert.equal(
                harness.calls.filter(([url]) =>
                    url.includes("/workers/scripts/")
                ).length,
                item.workerCalls
            );
        });
    }
});

test("version byte and fixed-count limits fail without emitting response data", async (t) => {
    await t.test("UTF-8 byte limit", async () => {
        const harness = createReadOnlyRequestHarness();
        const output = [];
        const request = async (url, init) => {
            if (url === VERSION_URL) {
                harness.calls.push([url, init]);
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: {
                            id: VERSION,
                            value: "é".repeat(1_100_000),
                        },
                    }),
                    { status: 200 }
                );
            }
            return harness.request(url, init);
        };
        await assert.rejects(
            runAssetRuntimeSchemaDiagnostic({
                argv: ["--mode", MODE, "--worker", WORKER],
                env: {
                    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
                    CLOUDFLARE_RUNTIME_DIAGNOSTIC_API_TOKEN: API_TOKEN,
                    CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256:
                        EXPECTED_ACCOUNT_FINGERPRINT,
                },
                request,
                write: (line) => output.push(line),
            }),
            /response exceeded safe limits/
        );
        assert.equal(harness.workerCalls().length, 2);
        assert.deepEqual(output, []);
    });

    await t.test("unknown-field count limit", async () => {
        const limitedKeySentinel = "PRIVATE_COUNTED_KEY_DO_NOT_LEAK";
        const harness = createReadOnlyRequestHarness({
            version: versionPayload({
                mutate: (version) => {
                    const assets = version.resources.script_runtime.assets;
                    for (let index = 0; index < 1_001; index += 1) {
                        assets[`${limitedKeySentinel}_${index}`] = index;
                    }
                },
            }),
        });
        const output = [];
        let observed;
        try {
            await runAssetRuntimeSchemaDiagnostic({
                argv: ["--mode", MODE, "--worker", WORKER],
                env: {
                    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
                    CLOUDFLARE_RUNTIME_DIAGNOSTIC_API_TOKEN: API_TOKEN,
                    CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256:
                        EXPECTED_ACCOUNT_FINGERPRINT,
                },
                request: harness.request,
                write: (line) => output.push(line),
            });
        } catch (error) {
            observed = error;
        }
        assert.ok(observed instanceof Error);
        assert.match(observed.message, /response exceeds safe count limits/);
        assert.doesNotMatch(
            observed.message,
            new RegExp(limitedKeySentinel, "u")
        );
        assert.equal(harness.workerCalls().length, 3);
        assert.deepEqual(output, []);
    });
});

test("deployment or policy drift around the version read emits no evidence", async (t) => {
    const driftCases = [
        {
            name: "deployment ID drift",
            finalDeployment: deploymentPayload({
                deploymentId: OTHER_DEPLOYMENT,
            }),
        },
        {
            name: "version ID drift",
            finalDeployment: deploymentPayload({ versionId: OTHER_VERSION }),
        },
    ];
    for (const item of driftCases) {
        await t.test(item.name, async () => {
            const harness = createReadOnlyRequestHarness({
                finalDeployment: item.finalDeployment,
            });
            const output = [];
            await assert.rejects(
                runAssetRuntimeSchemaDiagnostic({
                    argv: ["--mode", MODE, "--worker", WORKER],
                    env: {
                        CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
                        CLOUDFLARE_RUNTIME_DIAGNOSTIC_API_TOKEN: API_TOKEN,
                        CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256:
                            EXPECTED_ACCOUNT_FINGERPRINT,
                    },
                    request: harness.request,
                    write: (line) => output.push(line),
                }),
                /active deployment changed around the exact version read/
            );
            assert.deepEqual(
                harness.workerCalls().map(([url]) => url),
                [DEPLOYMENTS_URL, VERSION_URL, DEPLOYMENTS_URL]
            );
            assert.deepEqual(output, []);
        });
    }

    await t.test("policy drift after version GET", async () => {
        const harness = createReadOnlyRequestHarness();
        let policyReads = 0;
        const output = [];
        await assert.rejects(
            runAssetRuntimeSchemaDiagnostic({
                argv: ["--mode", MODE, "--worker", WORKER],
                env: {
                    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
                    CLOUDFLARE_RUNTIME_DIAGNOSTIC_API_TOKEN: API_TOKEN,
                    CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256:
                        EXPECTED_ACCOUNT_FINGERPRINT,
                },
                request: harness.request,
                loadPolicy: () => {
                    policyReads += 1;
                    const data = structuredClone(
                        loadCloudflareDeploymentData()
                    );
                    if (policyReads === 4) {
                        data.entries.find(
                            ({ site }) => site.id === "text"
                        ).site.directory = POLICY_SENTINEL;
                    }
                    return data;
                },
                write: (line) => output.push(line),
            }),
            /exact reviewed asset-only preview Worker policy/
        );
        assert.deepEqual(
            harness.workerCalls().map(([url]) => url),
            [DEPLOYMENTS_URL, VERSION_URL]
        );
        assert.deepEqual(output, []);
    });

    await t.test("policy drift during final deployment GET", async () => {
        const harness = createReadOnlyRequestHarness();
        let policyReads = 0;
        const output = [];
        await assert.rejects(
            runAssetRuntimeSchemaDiagnostic({
                argv: ["--mode", MODE, "--worker", WORKER],
                env: {
                    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
                    CLOUDFLARE_RUNTIME_DIAGNOSTIC_API_TOKEN: API_TOKEN,
                    CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256:
                        EXPECTED_ACCOUNT_FINGERPRINT,
                },
                request: harness.request,
                loadPolicy: () => {
                    policyReads += 1;
                    const data = structuredClone(
                        loadCloudflareDeploymentData()
                    );
                    if (policyReads === 5) {
                        data.entries.find(
                            ({ site }) => site.id === "text"
                        ).site.directory = POLICY_SENTINEL;
                    }
                    return data;
                },
                write: (line) => output.push(line),
            }),
            /exact reviewed asset-only preview Worker policy/
        );
        assert.deepEqual(
            harness.workerCalls().map(([url]) => url),
            [DEPLOYMENTS_URL, VERSION_URL, DEPLOYMENTS_URL]
        );
        assert.deepEqual(output, []);
    });
});

test("ambiguous deployment and wrong-version evidence fail closed", async (t) => {
    const cases = [
        {
            name: "split traffic",
            firstDeployment: deploymentPayload({
                versions: [
                    { version_id: VERSION, percentage: 50 },
                    { version_id: OTHER_VERSION, percentage: 50 },
                ],
            }),
            expectedWorkerCalls: 1,
            error: /not one exact version at 100%/,
        },
        {
            name: "wrong exact version response",
            version: versionPayload({
                mutate: (result) => {
                    result.id = OTHER_VERSION;
                },
            }),
            expectedWorkerCalls: 2,
            error: /different active Worker version/,
        },
        {
            name: "ambiguous final deployment",
            finalDeployment: deploymentPayload({ percentage: 99 }),
            expectedWorkerCalls: 3,
            error: /not one exact version at 100%/,
        },
    ];
    for (const item of cases) {
        await t.test(item.name, async () => {
            const harness = createReadOnlyRequestHarness(item);
            await assert.rejects(
                inspectActiveAssetRuntimeSchema(
                    invocation({ request: harness.request })
                ),
                item.error
            );
            assert.equal(
                harness.workerCalls().length,
                item.expectedWorkerCalls
            );
        });
    }
});

test("CLI exposes only the fixed active asset-preview surface", () => {
    assert.deepEqual(
        parseAssetRuntimeSchemaDiagnosticArgs([
            "--mode",
            MODE,
            "--worker",
            WORKER,
        ]),
        { mode: MODE, worker: WORKER }
    );
    for (const argv of [
        ["--worker", WORKER, "--mode", MODE],
        ["--mode", "exact", "--worker", WORKER],
        ["--mode", MODE, "--worker", "peerbit-examples-files-preview"],
        ["--mode", MODE, "--worker", WORKER, "--url", "https://x"],
        ["--mode", MODE, "--worker", WORKER, "--method", "POST"],
    ]) {
        assert.throws(
            () => parseAssetRuntimeSchemaDiagnosticArgs(argv),
            /Usage:/
        );
    }
});

test("manual workflow is bot-only, first-attempt-only, account-bound, and non-mutating", () => {
    const workflow = readFileSync(
        path.join(
            repoRoot,
            ".github/workflows/cloudflare-asset-runtime-schema-diagnostic.yml"
        ),
        "utf8"
    );
    const script = readFileSync(
        path.join(
            repoRoot,
            "scripts/inspect-cloudflare-asset-runtime-schema.mjs"
        ),
        "utf8"
    );
    assert.match(workflow, /^on:\n\s+workflow_dispatch:/m);
    assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|schedule):/m);
    assert.match(workflow, /^permissions:\n\s+contents: read$/m);
    assert.match(workflow, /environment: cloudflare-production/);
    assert.match(workflow, /"workflow_dispatch"/);
    assert.match(workflow, /"refs\/heads\/master"/);
    assert.match(workflow, /"\$GITHUB_ACTOR" != "peerbit-org"/);
    assert.match(workflow, /"\$GITHUB_TRIGGERING_ACTOR" != "peerbit-org"/);
    assert.match(workflow, /"\$GITHUB_RUN_ATTEMPT" != "1"/);
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
        /CLOUDFLARE_RUNTIME_DIAGNOSTIC_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_RUNTIME_DIAGNOSTIC_API_TOKEN \}\}/
    );
    assert.doesNotMatch(workflow, /CLOUDFLARE_PRODUCTION_API_TOKEN/);
    assert.match(
        workflow,
        /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/
    );
    assert.match(
        workflow,
        /CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256 \}\}/
    );
    assert.doesNotMatch(workflow, /vars\.CLOUDFLARE_/);
    assert.match(workflow, /mode:[\s\S]*?options:\n\s+- active\n\s+worker:/);
    assert.match(
        workflow,
        /worker:[\s\S]*?options:\n\s+- peerbit-examples-text-preview\n\npermissions:/
    );
    assert.equal(
        (script.match(/await exactReadOnlyWorkerGet\(/g) ?? []).length,
        3
    );
    assert.equal((script.match(/method: "GET"/g) ?? []).length, 1);
    assert.doesNotMatch(script, /method: "(?:POST|PUT|PATCH|DELETE)"/);
    assert.doesNotMatch(script, /--(?:url|method|body|version)/);
    assert.match(script, /await listZoneRouteInventory\(\)/);
    assert.match(script, /accountZoneInventorySha256\(inventory\)/);
    assert.match(script, /`\$\{workerUrl\}\/deployments`/g);
    assert.match(
        script,
        /`\$\{workerUrl\}\/versions\/\$\{firstEvidence\.versionId\}`/
    );
});

test("workflow gate executes only for the bot's first manual master attempt", () => {
    const workflow = readFileSync(
        path.join(
            repoRoot,
            ".github/workflows/cloudflare-asset-runtime-schema-diagnostic.yml"
        ),
        "utf8"
    );
    const marker =
        "            - name: Require reviewed default branch and manual dispatch\n" +
        "              shell: bash\n" +
        "              run: |\n";
    const block = workflow.split(marker, 2)[1];
    assert.equal(typeof block, "string");
    const lines = [];
    for (const line of block.split("\n")) {
        if (line.startsWith("                  ")) {
            lines.push(line.slice(18));
        } else if (line.length === 0) {
            lines.push("");
        } else {
            break;
        }
    }
    const source = lines.join("\n");
    const baseEnvironment = {
        ...process.env,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_ACTOR: "peerbit-org",
        GITHUB_TRIGGERING_ACTOR: "peerbit-org",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_REF: "refs/heads/master",
    };
    const run = (overrides = {}) =>
        spawnSync("bash", ["-c", source], {
            env: { ...baseEnvironment, ...overrides },
            encoding: "utf8",
        });

    assert.equal(run().status, 0);
    for (const overrides of [
        { GITHUB_EVENT_NAME: "push" },
        { GITHUB_ACTOR: "marcus-pousette" },
        { GITHUB_TRIGGERING_ACTOR: "marcus-pousette" },
        { GITHUB_RUN_ATTEMPT: "2" },
        { GITHUB_REF: "refs/heads/not-master" },
    ]) {
        assert.notEqual(run(overrides).status, 0);
    }
});
