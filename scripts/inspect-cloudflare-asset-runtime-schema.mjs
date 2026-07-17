import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { loadCloudflareDeploymentData } from "./cloudflare-deployment-policy.mjs";
import { createCloudflareWorkersApi } from "./cloudflare-workers-api.mjs";
import {
    accountZoneInventorySha256,
    requireExpectedAccountZoneInventorySha256,
} from "./deploy-cloudflare-production.mjs";

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const API_BASE_URL = "https://api.cloudflare.com/client/v4";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_BOUNDED_COUNT = 1_000;

export const ASSET_RUNTIME_DIAGNOSTIC_MODE = "active";
export const ASSET_RUNTIME_DIAGNOSTIC_WORKER = "peerbit-examples-text-preview";

const EXPECTED_POLICY_IDENTITY = Object.freeze({
    siteId: "text",
    siteKind: "app",
    siteWorker: "peerbit-examples-text",
    siteDirectory: "packages/text-document/frontend/dist",
    siteDomains: Object.freeze(["text.apps.peerbit.org"]),
    siteHasScript: false,
    siteHasWorkerFirst: false,
    policyId: "text",
    policyKind: "app",
    productionWorker: "peerbit-examples-text",
    previewWorker: ASSET_RUNTIME_DIAGNOSTIC_WORKER,
    productionHostnames: Object.freeze(["text.apps.peerbit.org"]),
});

const EXPECTED_RAW_HEADERS = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

/assets/*
  Cache-Control: public, max-age=31556952, immutable
`;

const EXPECTED_HEADERS = Object.freeze({
    rules: Object.freeze({
        "/*": Object.freeze({
            set: Object.freeze({
                "referrer-policy": "strict-origin-when-cross-origin",
                "x-content-type-options": "nosniff",
            }),
            unset: Object.freeze([]),
        }),
        "/assets/*": Object.freeze({
            set: Object.freeze({
                "cache-control": "public, max-age=31556952, immutable",
            }),
            unset: Object.freeze([]),
        }),
    }),
    version: 2,
});

const RESOURCE_FIELDS = new Set(["bindings", "script", "script_runtime"]);
const SCRIPT_FIELDS = new Set([
    "etag",
    "handlers",
    "last_deployed_from",
    "named_handlers",
    "placement",
    "placement_mode",
]);
const RUNTIME_FIELDS = new Set([
    "assets",
    "cache_options",
    "compatibility_date",
    "compatibility_flags",
    "limits",
    "usage_model",
]);
const ASSET_FIELDS = new Set([
    "headers",
    "html_handling",
    "not_found_handling",
    "raw_headers",
    "raw_run_worker_first",
    "serve_directly",
    "static_routing",
]);
const HEADER_FIELDS = new Set(["rules", "version"]);
const REVIEWED_HEADER_RULES = new Set(["/*", "/assets/*"]);
const STATIC_ROUTING_FIELDS = new Set(["user_worker"]);

const isPlainObject = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);

const hasOwn = (value, key) =>
    isPlainObject(value) && Object.hasOwn(value, key);

const boundedArrayCount = (value) => {
    if (!Array.isArray(value)) return 0;
    if (value.length > MAX_BOUNDED_COUNT) {
        throw new Error(
            "Cloudflare asset runtime schema diagnostic failed: response exceeds safe count limits"
        );
    }
    return value.length;
};

const boundedFieldCounts = (value, knownFields) => {
    if (!isPlainObject(value)) {
        return { fieldCount: 0, knownFieldCount: 0, unknownFieldCount: 0 };
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_BOUNDED_COUNT) {
        throw new Error(
            "Cloudflare asset runtime schema diagnostic failed: response exceeds safe count limits"
        );
    }
    const knownFieldCount = keys.filter((key) => knownFields.has(key)).length;
    return {
        fieldCount: keys.length,
        knownFieldCount,
        unknownFieldCount: keys.length - knownFieldCount,
    };
};

const exactClassification = (object, key, expected) => {
    if (!hasOwn(object, key)) return "absent";
    return isDeepStrictEqual(object[key], expected)
        ? "exact-reviewed"
        : "other";
};

const emptyArrayClassification = (object, key, exact) => {
    if (!hasOwn(object, key)) return "absent";
    return Array.isArray(object[key]) && object[key].length === 0
        ? exact
        : "other";
};

const activeDeploymentEvidence = (result) => {
    const active = Array.isArray(result?.deployments)
        ? result.deployments[0]
        : undefined;
    if (
        !isPlainObject(active) ||
        !UUID.test(active.id || "") ||
        !Array.isArray(active.versions) ||
        active.versions.length !== 1 ||
        !UUID.test(active.versions[0]?.version_id || "") ||
        active.versions[0]?.percentage !== 100
    ) {
        throw new Error(
            "Cloudflare asset runtime schema diagnostic failed: active deployment was not one exact version at 100%"
        );
    }
    return {
        deploymentId: active.id,
        versionId: active.versions[0].version_id,
    };
};

const fixedRuntimeShape = (version) => {
    const resources = isPlainObject(version) ? version.resources : undefined;
    const script = isPlainObject(resources) ? resources.script : undefined;
    const runtime = isPlainObject(resources)
        ? resources.script_runtime
        : undefined;
    const assets = isPlainObject(runtime) ? runtime.assets : undefined;
    const headers = isPlainObject(assets) ? assets.headers : undefined;
    const rules = isPlainObject(headers) ? headers.rules : undefined;
    const staticRouting = isPlainObject(assets)
        ? assets.static_routing
        : undefined;
    const bindings = isPlainObject(resources) ? resources.bindings : undefined;
    const rawRunWorkerFirst = isPlainObject(assets)
        ? assets.raw_run_worker_first
        : undefined;
    const userWorker = isPlainObject(staticRouting)
        ? staticRouting.user_worker
        : undefined;
    const resourceCounts = boundedFieldCounts(resources, RESOURCE_FIELDS);
    const scriptCounts = boundedFieldCounts(script, SCRIPT_FIELDS);
    const runtimeCounts = boundedFieldCounts(runtime, RUNTIME_FIELDS);
    const assetCounts = boundedFieldCounts(assets, ASSET_FIELDS);
    const headerCounts = boundedFieldCounts(headers, HEADER_FIELDS);
    const headerRuleCounts = boundedFieldCounts(rules, REVIEWED_HEADER_RULES);
    const staticRoutingCounts = boundedFieldCounts(
        staticRouting,
        STATIC_ROUTING_FIELDS
    );

    return {
        topLevel: {
            assetsDuplicatePresent: hasOwn(version, "assets"),
            cacheOptionsDuplicatePresent: hasOwn(version, "cache_options"),
        },
        resources: {
            present: hasOwn(version, "resources"),
            isObject: isPlainObject(resources),
            fieldCount: resourceCounts.fieldCount,
            knownFieldCount: resourceCounts.knownFieldCount,
            unknownFieldCount: resourceCounts.unknownFieldCount,
            bindingsPresent: hasOwn(resources, "bindings"),
            bindingsIsArray: Array.isArray(bindings),
            bindingsCount: boundedArrayCount(bindings),
            scriptPresent: hasOwn(resources, "script"),
            scriptIsObject: isPlainObject(script),
            scriptFieldCount: scriptCounts.fieldCount,
            scriptKnownFieldCount: scriptCounts.knownFieldCount,
            scriptUnknownFieldCount: scriptCounts.unknownFieldCount,
            fetchHandlerClassification: !hasOwn(script, "handlers")
                ? "absent"
                : isDeepStrictEqual(script.handlers, ["fetch"])
                  ? "exact-fetch-only"
                  : "other",
            namedHandlersClassification: emptyArrayClassification(
                script,
                "named_handlers",
                "exact-empty"
            ),
        },
        scriptRuntime: {
            present: hasOwn(resources, "script_runtime"),
            isObject: isPlainObject(runtime),
            fieldCount: runtimeCounts.fieldCount,
            knownFieldCount: runtimeCounts.knownFieldCount,
            unknownFieldCount: runtimeCounts.unknownFieldCount,
            compatibilityDateClassification: exactClassification(
                runtime,
                "compatibility_date",
                "2026-07-13"
            ),
            usageModelClassification: exactClassification(
                runtime,
                "usage_model",
                "standard"
            ),
            compatibilityFlagsClassification: emptyArrayClassification(
                runtime,
                "compatibility_flags",
                "exact-empty"
            ),
            limitsClassification: !hasOwn(runtime, "limits")
                ? "absent"
                : isPlainObject(runtime.limits) &&
                    Object.keys(runtime.limits).length === 0
                  ? "exact-empty-object"
                  : "other",
            cacheOptionsClassification: !hasOwn(runtime, "cache_options")
                ? "absent"
                : isDeepStrictEqual(runtime.cache_options, {
                        enabled: true,
                        cross_version_cache: false,
                    })
                  ? "exact-enabled-no-cross-version"
                  : "other",
            assetsPresent: hasOwn(runtime, "assets"),
        },
        assets: {
            present: hasOwn(runtime, "assets"),
            isObject: isPlainObject(assets),
            fieldCount: assetCounts.fieldCount,
            knownFieldCount: assetCounts.knownFieldCount,
            unknownFieldCount: assetCounts.unknownFieldCount,
            headersClassification: exactClassification(
                assets,
                "headers",
                EXPECTED_HEADERS
            ),
            headersFieldCount: headerCounts.fieldCount,
            headersKnownFieldCount: headerCounts.knownFieldCount,
            headersUnknownFieldCount: headerCounts.unknownFieldCount,
            headerRulesFieldCount: headerRuleCounts.fieldCount,
            headerRulesKnownFieldCount: headerRuleCounts.knownFieldCount,
            headerRulesUnknownFieldCount: headerRuleCounts.unknownFieldCount,
            htmlHandlingClassification: exactClassification(
                assets,
                "html_handling",
                "auto-trailing-slash"
            ),
            notFoundHandlingClassification: exactClassification(
                assets,
                "not_found_handling",
                "none"
            ),
            rawHeadersClassification: exactClassification(
                assets,
                "raw_headers",
                EXPECTED_RAW_HEADERS
            ),
            rawRunWorkerFirstClassification: emptyArrayClassification(
                assets,
                "raw_run_worker_first",
                "exact-empty"
            ),
            rawRunWorkerFirstCount: boundedArrayCount(rawRunWorkerFirst),
            serveDirectlyClassification: !hasOwn(assets, "serve_directly")
                ? "absent"
                : assets.serve_directly === true
                  ? "exact-true"
                  : "other",
            staticRoutingClassification: !hasOwn(assets, "static_routing")
                ? "absent"
                : isPlainObject(staticRouting) &&
                    Object.keys(staticRouting).length === 1 &&
                    Array.isArray(staticRouting.user_worker) &&
                    staticRouting.user_worker.length === 0
                  ? "exact-empty-user-worker"
                  : "other",
            staticRoutingFieldCount: staticRoutingCounts.fieldCount,
            staticRoutingKnownFieldCount: staticRoutingCounts.knownFieldCount,
            staticRoutingUnknownFieldCount:
                staticRoutingCounts.unknownFieldCount,
            staticRoutingUserWorkerCount: boundedArrayCount(userWorker),
        },
    };
};

const parseSuccessfulReadOnlyResponse = async (response) => {
    let raw;
    try {
        raw = await response.text();
    } catch {
        throw new Error(
            "Cloudflare asset runtime schema diagnostic failed: response body was unreadable"
        );
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
        throw new Error(
            "Cloudflare asset runtime schema diagnostic failed: response exceeded safe limits"
        );
    }
    let payload;
    try {
        payload = raw.trim() === "" ? undefined : JSON.parse(raw);
    } catch {
        throw new Error(
            "Cloudflare asset runtime schema diagnostic failed: response was not valid JSON"
        );
    }
    if (!response.ok || payload?.success !== true) {
        const status = Number.isInteger(response.status)
            ? response.status
            : "unknown";
        throw new Error(
            `Cloudflare asset runtime schema diagnostic failed: API request was not successful (HTTP ${status})`
        );
    }
    if (!isPlainObject(payload.result)) {
        throw new Error(
            "Cloudflare asset runtime schema diagnostic failed: result was missing or malformed"
        );
    }
    return payload.result;
};

const exactReadOnlyWorkerGet = async ({
    url,
    runtimeDiagnosticApiToken,
    request,
}) => {
    let response;
    try {
        response = await request(url, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${runtimeDiagnosticApiToken}`,
            },
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
        });
    } catch {
        throw new Error(
            "Cloudflare asset runtime schema diagnostic failed: network request failed"
        );
    }
    return parseSuccessfulReadOnlyResponse(response);
};

const requireExactAssetPreviewPolicy = (deploymentData) => {
    if (!Array.isArray(deploymentData?.entries)) {
        throw new Error(
            "Asset runtime schema diagnostic requires the exact reviewed deployment policy"
        );
    }
    const matches = deploymentData.entries.filter(
        ({ policy }) =>
            policy?.previewWorker === ASSET_RUNTIME_DIAGNOSTIC_WORKER
    );
    if (matches.length !== 1) {
        throw new Error(
            "Asset runtime schema diagnostic requires the exact reviewed deployment policy"
        );
    }
    const { site, policy } = matches[0];
    const identity = {
        siteId: site?.id,
        siteKind: site?.kind,
        siteWorker: site?.worker,
        siteDirectory: site?.directory,
        siteDomains: Array.isArray(site?.domains)
            ? [...site.domains]
            : undefined,
        siteHasScript: Object.hasOwn(site ?? {}, "script"),
        siteHasWorkerFirst: Object.hasOwn(site ?? {}, "workerFirst"),
        policyId: policy?.id,
        policyKind: policy?.kind,
        productionWorker: policy?.productionWorker,
        previewWorker: policy?.previewWorker,
        productionHostnames: Array.isArray(policy?.productionHostnames)
            ? [...policy.productionHostnames]
            : undefined,
    };
    if (!isDeepStrictEqual(identity, EXPECTED_POLICY_IDENTITY)) {
        throw new Error(
            "Asset runtime schema diagnostic requires the exact reviewed asset-only preview Worker policy"
        );
    }
    return identity;
};

const requireReadOnlyCredentials = ({
    accountId,
    runtimeDiagnosticApiToken,
}) => {
    if (!ACCOUNT_ID.test(accountId || "")) {
        throw new Error(
            "CLOUDFLARE_ACCOUNT_ID must be exactly 32 lowercase hexadecimal characters"
        );
    }
    if (
        typeof runtimeDiagnosticApiToken !== "string" ||
        runtimeDiagnosticApiToken.length === 0 ||
        /\s/.test(runtimeDiagnosticApiToken)
    ) {
        throw new Error(
            "Cloudflare read-only API token is missing or malformed"
        );
    }
};

const requireReviewedAccountIdentity = async ({
    accountId,
    runtimeDiagnosticApiToken,
    expectedAccountZoneInventorySha256,
    request,
}) => {
    const expectedFingerprint = requireExpectedAccountZoneInventorySha256(
        expectedAccountZoneInventorySha256
    );
    const { listZoneRouteInventory } = createCloudflareWorkersApi({
        accountId,
        apiToken: runtimeDiagnosticApiToken,
        request,
    });
    let inventory;
    try {
        inventory = await listZoneRouteInventory();
    } catch {
        throw new Error(
            "Cloudflare account identity validation failed without authorizing a Worker read"
        );
    }
    if (accountZoneInventorySha256(inventory) !== expectedFingerprint) {
        throw new Error(
            "Cloudflare account identity does not match the independently reviewed fingerprint"
        );
    }
};

export const inspectActiveAssetRuntimeSchema = async ({
    mode,
    worker,
    accountId,
    runtimeDiagnosticApiToken,
    expectedAccountZoneInventorySha256,
    request = fetch,
    loadPolicy = loadCloudflareDeploymentData,
}) => {
    if (mode !== ASSET_RUNTIME_DIAGNOSTIC_MODE) {
        throw new Error(
            "Asset runtime schema diagnostic mode must exactly equal active"
        );
    }
    if (worker !== ASSET_RUNTIME_DIAGNOSTIC_WORKER) {
        throw new Error(
            "Worker must exactly match the single reviewed asset-only preview Worker"
        );
    }
    const initialPolicyIdentity = requireExactAssetPreviewPolicy(loadPolicy());
    const requireStablePolicy = () => {
        const current = requireExactAssetPreviewPolicy(loadPolicy());
        if (!isDeepStrictEqual(initialPolicyIdentity, current)) {
            throw new Error(
                "Asset runtime schema diagnostic failed: reviewed Worker policy changed during the read sequence"
            );
        }
    };
    requireReadOnlyCredentials({ accountId, runtimeDiagnosticApiToken });
    await requireReviewedAccountIdentity({
        accountId,
        runtimeDiagnosticApiToken,
        expectedAccountZoneInventorySha256,
        request,
    });
    requireStablePolicy();

    const workerUrl = `${API_BASE_URL}/accounts/${accountId}/workers/scripts/${ASSET_RUNTIME_DIAGNOSTIC_WORKER}`;
    const firstDeploymentResult = await exactReadOnlyWorkerGet({
        url: `${workerUrl}/deployments`,
        runtimeDiagnosticApiToken,
        request,
    });
    const firstEvidence = activeDeploymentEvidence(firstDeploymentResult);
    requireStablePolicy();

    const versionResult = await exactReadOnlyWorkerGet({
        url: `${workerUrl}/versions/${firstEvidence.versionId}`,
        runtimeDiagnosticApiToken,
        request,
    });
    if (versionResult.id !== firstEvidence.versionId) {
        throw new Error(
            "Cloudflare asset runtime schema diagnostic failed: response identified a different active Worker version"
        );
    }
    requireStablePolicy();

    const finalDeploymentResult = await exactReadOnlyWorkerGet({
        url: `${workerUrl}/deployments`,
        runtimeDiagnosticApiToken,
        request,
    });
    const finalEvidence = activeDeploymentEvidence(finalDeploymentResult);
    if (!isDeepStrictEqual(firstEvidence, finalEvidence)) {
        throw new Error(
            "Cloudflare asset runtime schema diagnostic failed: active deployment changed around the exact version read"
        );
    }
    requireStablePolicy();

    return {
        evidence: {
            activeModeMatched: true,
            workerMatchedExactAssetPreviewPolicy: true,
            accountIdentityMatchedReviewedFingerprint: true,
            policyStableAcrossReadSequence: true,
            activeDeploymentMatchedSingleFullTrafficVersion: true,
            deploymentStableAroundVersionRead: true,
            workerMethodsWereGet: true,
            responseVersionMatchedActiveDeployment: true,
        },
        shape: fixedRuntimeShape(versionResult),
    };
};

export const parseAssetRuntimeSchemaDiagnosticArgs = (argv) => {
    if (
        argv.length !== 4 ||
        argv[0] !== "--mode" ||
        argv[1] !== ASSET_RUNTIME_DIAGNOSTIC_MODE ||
        argv[2] !== "--worker" ||
        argv[3] !== ASSET_RUNTIME_DIAGNOSTIC_WORKER
    ) {
        throw new Error(
            `Usage: inspect-cloudflare-asset-runtime-schema.mjs --mode ${ASSET_RUNTIME_DIAGNOSTIC_MODE} --worker ${ASSET_RUNTIME_DIAGNOSTIC_WORKER}`
        );
    }
    return { mode: argv[1], worker: argv[3] };
};

export const runAssetRuntimeSchemaDiagnostic = async ({
    argv = process.argv.slice(2),
    env = process.env,
    request = fetch,
    loadPolicy = loadCloudflareDeploymentData,
    write = (line) => console.log(line),
} = {}) => {
    const { mode, worker } = parseAssetRuntimeSchemaDiagnosticArgs(argv);
    const summary = await inspectActiveAssetRuntimeSchema({
        mode,
        worker,
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        runtimeDiagnosticApiToken: env.CLOUDFLARE_RUNTIME_DIAGNOSTIC_API_TOKEN,
        expectedAccountZoneInventorySha256:
            env.CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256,
        request,
        loadPolicy,
    });
    write(JSON.stringify(summary));
    return summary;
};

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    try {
        await runAssetRuntimeSchemaDiagnostic();
    } catch (error) {
        console.error(
            error instanceof Error
                ? error.message
                : "Cloudflare asset runtime schema diagnostic failed"
        );
        process.exitCode = 1;
    }
}
