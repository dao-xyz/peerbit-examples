import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { loadCloudflareDeploymentData } from "./cloudflare-deployment-policy.mjs";

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const VERSION_ID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const API_BASE_URL = "https://api.cloudflare.com/client/v4";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SUMMARY_DEPTH = 32;
const MAX_SUMMARY_NODES = 50_000;
const MAX_OBJECT_KEYS = 1_000;
const MAX_ARRAY_ITEMS = 10_000;

const hashPrimitive = (type, value) =>
    createHash("sha256").update(type).update("\0").update(value).digest("hex");

const primitiveText = (value) => {
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new Error(
                "Cloudflare schema diagnostic encountered invalid JSON"
            );
        }
        if (Object.is(value, -0)) return "-0";
    }
    return JSON.stringify(value);
};

export const summarizeCloudflareValue = (root) => {
    let nodes = 0;
    const seen = new WeakSet();
    const summarize = (value, depth) => {
        nodes += 1;
        if (nodes > MAX_SUMMARY_NODES || depth > MAX_SUMMARY_DEPTH) {
            throw new Error(
                "Cloudflare schema diagnostic response exceeds safe limits"
            );
        }
        if (value === null) return { type: "null" };
        if (typeof value === "boolean") {
            return { type: "boolean", value };
        }
        if (typeof value === "string" || typeof value === "number") {
            return {
                type: typeof value,
                sha256: hashPrimitive(typeof value, primitiveText(value)),
            };
        }
        if (Array.isArray(value)) {
            if (seen.has(value)) {
                throw new Error(
                    "Cloudflare schema diagnostic encountered invalid JSON"
                );
            }
            seen.add(value);
            if (value.length > MAX_ARRAY_ITEMS) {
                throw new Error(
                    "Cloudflare schema diagnostic response exceeds safe limits"
                );
            }
            return {
                type: "array",
                items: value.map((item) => summarize(item, depth + 1)),
            };
        }
        if (typeof value === "object") {
            if (seen.has(value)) {
                throw new Error(
                    "Cloudflare schema diagnostic encountered invalid JSON"
                );
            }
            seen.add(value);
            const keys = Object.keys(value).sort();
            if (keys.length > MAX_OBJECT_KEYS) {
                throw new Error(
                    "Cloudflare schema diagnostic response exceeds safe limits"
                );
            }
            return {
                type: "object",
                fields: Object.fromEntries(
                    keys.map((key) => [key, summarize(value[key], depth + 1)])
                ),
            };
        }
        throw new Error(
            "Cloudflare schema diagnostic encountered invalid JSON"
        );
    };
    return summarize(root, 0);
};

const hasOwn = (value, key) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, key);

const runtimeFacts = (result) => {
    const runtime = result?.resources?.script_runtime;
    const runtimeIsObject =
        runtime !== null &&
        typeof runtime === "object" &&
        !Array.isArray(runtime);
    const runtimeAssetsPresent = runtimeIsObject && hasOwn(runtime, "assets");
    const runtimeCacheOptionsPresent =
        runtimeIsObject && hasOwn(runtime, "cache_options");
    const topLevelAssetsPresent = hasOwn(result, "assets");
    const topLevelCacheOptionsPresent = hasOwn(result, "cache_options");
    return {
        runtimeAssetsPresent,
        runtimeCacheOptionsPresent,
        topLevelAssetsPresent,
        topLevelCacheOptionsPresent,
        runtimeAssetsEqualsTopLevelAssets:
            runtimeAssetsPresent &&
            topLevelAssetsPresent &&
            isDeepStrictEqual(runtime.assets, result.assets),
        runtimeCacheOptionsEqualsTopLevelCacheOptions:
            runtimeCacheOptionsPresent &&
            topLevelCacheOptionsPresent &&
            isDeepStrictEqual(runtime.cache_options, result.cache_options),
    };
};

const parseSuccessfulResponse = async (response) => {
    let raw;
    try {
        raw = await response.text();
    } catch {
        throw new Error(
            "Cloudflare version schema diagnostic failed: response body was unreadable"
        );
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
        throw new Error(
            "Cloudflare version schema diagnostic failed: response exceeded safe limits"
        );
    }
    let payload;
    try {
        payload = raw.trim() === "" ? undefined : JSON.parse(raw);
    } catch {
        throw new Error(
            "Cloudflare version schema diagnostic failed: response was not valid JSON"
        );
    }
    if (!response.ok || payload?.success !== true) {
        const status = Number.isInteger(response.status)
            ? response.status
            : "unknown";
        throw new Error(
            `Cloudflare version schema diagnostic failed: API request was not successful (HTTP ${status})`
        );
    }
    if (
        !payload.result ||
        typeof payload.result !== "object" ||
        Array.isArray(payload.result)
    ) {
        throw new Error(
            "Cloudflare version schema diagnostic failed: result was missing or malformed"
        );
    }
    return payload.result;
};

const allowedProductionWorkers = () =>
    new Set(
        loadCloudflareDeploymentData().entries.map(
            ({ policy }) => policy.productionWorker
        )
    );

export const inspectCloudflareWorkerVersionSchema = async ({
    worker,
    version,
    accountId,
    apiToken,
    request = fetch,
}) => {
    if (!allowedProductionWorkers().has(worker)) {
        throw new Error(
            "Worker must exactly match a reviewed production deployment policy entry"
        );
    }
    if (!VERSION_ID.test(version || "")) {
        throw new Error("Worker version must be an exact lowercase UUID");
    }
    if (!ACCOUNT_ID.test(accountId || "")) {
        throw new Error(
            "CLOUDFLARE_ACCOUNT_ID must be exactly 32 lowercase hexadecimal characters"
        );
    }
    if (
        typeof apiToken !== "string" ||
        apiToken.length === 0 ||
        /\s/.test(apiToken)
    ) {
        throw new Error(
            "CLOUDFLARE_PRODUCTION_API_TOKEN is missing or malformed"
        );
    }

    const url = `${API_BASE_URL}/accounts/${accountId}/workers/scripts/${worker}/versions/${version}`;
    let response;
    try {
        response = await request(url, {
            method: "GET",
            headers: { Authorization: `Bearer ${apiToken}` },
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
        });
    } catch {
        throw new Error(
            "Cloudflare version schema diagnostic failed: network request failed"
        );
    }
    const result = await parseSuccessfulResponse(response);
    if (result.id !== version) {
        throw new Error(
            "Cloudflare version schema diagnostic failed: response identified a different Worker version"
        );
    }
    return {
        request: {
            workerMatchedDeploymentPolicy: true,
            versionMatchedStrictUuid: true,
            methodWasGet: true,
            responseVersionMatchedRequest: true,
        },
        comparisons: runtimeFacts(result),
        response: summarizeCloudflareValue(result),
    };
};

export const parseCloudflareSchemaDiagnosticArgs = (argv) => {
    if (
        argv.length !== 4 ||
        argv[0] !== "--worker" ||
        argv[2] !== "--version"
    ) {
        throw new Error(
            "Usage: inspect-cloudflare-worker-version-schema.mjs --worker <reviewed-production-worker> --version <lowercase-uuid>"
        );
    }
    return { worker: argv[1], version: argv[3] };
};

export const runCloudflareSchemaDiagnostic = async ({
    argv = process.argv.slice(2),
    env = process.env,
    request = fetch,
    write = (line) => console.log(line),
} = {}) => {
    const { worker, version } = parseCloudflareSchemaDiagnosticArgs(argv);
    const summary = await inspectCloudflareWorkerVersionSchema({
        worker,
        version,
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        apiToken: env.CLOUDFLARE_PRODUCTION_API_TOKEN,
        request,
    });
    write(JSON.stringify(summary));
    return summary;
};

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    try {
        await runCloudflareSchemaDiagnostic();
    } catch (error) {
        console.error(
            error instanceof Error
                ? error.message
                : "Cloudflare version schema diagnostic failed"
        );
        process.exitCode = 1;
    }
}
