const CLOUDFLARE_ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const DNS_HOSTNAME =
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const VERSION_ID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const CUSTOM_DOMAIN_PAGE_SIZE = 100;
const MAX_CUSTOM_DOMAIN_PAGES = 1_000;
const MAX_CUSTOM_DOMAIN_SNAPSHOT_ATTEMPTS = 3;
const WORKERS_DEV_REFERENCE =
    /(?<![a-z0-9-])(?:(?:[a-z][a-z0-9+.-]*:)?\/\/)?(?:[a-z0-9-]+\.)*workers\.dev(?![a-z0-9.-])(?::[0-9]+)?(?:[/?#][^\s<>"']*)?/gi;
const WORKERS_DEV_REDACTION = "[REDACTED_WORKERS_DEV_REFERENCE]";

const redactText = (value, secrets, { maxLength } = {}) => {
    const text = value instanceof Error ? value.message : String(value);
    const orderedSecrets = [
        ...new Set(
            secrets.filter(
                (secret) => typeof secret === "string" && secret.length > 0
            )
        ),
    ].sort((left, right) => right.length - left.length);
    const redactSecrets = (segment) => {
        let result = segment;
        for (const secret of orderedSecrets) {
            result = result.replaceAll(secret, "[REDACTED]");
        }
        return result;
    };
    const redacted = [];
    let cursor = 0;
    for (const match of text.matchAll(WORKERS_DEV_REFERENCE)) {
        redacted.push(redactSecrets(text.slice(cursor, match.index)));
        redacted.push(WORKERS_DEV_REDACTION);
        cursor = match.index + match[0].length;
    }
    redacted.push(redactSecrets(text.slice(cursor)));
    const result = redacted.join("");
    return Number.isSafeInteger(maxLength)
        ? result.slice(0, maxLength)
        : result;
};

const normalizedErrors = ({ payload, cause, secrets }) => {
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    const normalized = errors.slice(0, 5).map((error) => ({
        ...(Number.isSafeInteger(error?.code) ? { code: error.code } : {}),
        message: redactText(
            error?.message ?? "Unspecified API error",
            secrets,
            {
                maxLength: 500,
            }
        ),
    }));
    if (normalized.length === 0 && cause) {
        normalized.push({
            message: redactText(cause, secrets, { maxLength: 500 }),
        });
    }
    if (normalized.length === 0) {
        normalized.push({ message: "Unspecified API error" });
    }
    return normalized;
};

export class CloudflareWorkersApiError extends Error {
    constructor({
        operation,
        status,
        payload,
        cause,
        secrets,
        indeterminateMutation = false,
    }) {
        const details = {
            operation,
            status: Number.isInteger(status) ? status : null,
            indeterminateMutation: indeterminateMutation === true,
            errors: normalizedErrors({ payload, cause, secrets }),
        };
        super(`Cloudflare Workers API error: ${JSON.stringify(details)}`);
        this.name = "CloudflareWorkersApiError";
        this.details = details;
        this.indeterminateMutation = details.indeterminateMutation;
    }
}

export const isIndeterminateCloudflareMutationError = (error) =>
    error instanceof CloudflareWorkersApiError &&
    error.indeterminateMutation === true;

const parseResponse = async ({
    response,
    operation,
    secrets,
    mutationDispatched = false,
}) => {
    let payload;
    try {
        const raw = await response.text();
        payload = raw.trim() === "" ? undefined : JSON.parse(raw);
    } catch {
        throw new CloudflareWorkersApiError({
            operation,
            status: response.status,
            cause: new Error("Cloudflare returned malformed JSON"),
            secrets,
            // A response-body failure after dispatch cannot prove whether the
            // mutation was accepted before the response became unreadable.
            indeterminateMutation: mutationDispatched,
        });
    }

    if (!response.ok || (payload && payload.success !== true)) {
        throw new CloudflareWorkersApiError({
            operation,
            status: response.status,
            payload,
            secrets,
            // Cloudflare does not expose at-most-once or non-application
            // evidence for this mutation. Once the POST has been dispatched,
            // no response failure is safe evidence that it was not applied.
            indeterminateMutation: mutationDispatched,
        });
    }
    if (!payload) {
        throw new CloudflareWorkersApiError({
            operation,
            status: response.status,
            cause: new Error("Cloudflare returned an empty response"),
            secrets,
            indeterminateMutation: mutationDispatched,
        });
    }
    return payload;
};

export const createCloudflareWorkersApi = ({
    accountId,
    apiToken,
    request = fetch,
}) => {
    if (!CLOUDFLARE_ACCOUNT_ID.test(accountId || "")) {
        throw new Error(
            "CLOUDFLARE_ACCOUNT_ID must be exactly 32 hexadecimal characters"
        );
    }
    if (
        typeof apiToken !== "string" ||
        apiToken.length === 0 ||
        /\s/.test(apiToken)
    ) {
        throw new Error("CLOUDFLARE_API_TOKEN is missing or malformed");
    }
    const scriptsUrl = `${CLOUDFLARE_API_BASE_URL}/accounts/${accountId}/workers/scripts`;
    const domainsUrl = `${CLOUDFLARE_API_BASE_URL}/accounts/${accountId}/workers/domains`;
    const secrets = [apiToken, accountId];
    const call = async ({ operation, url, method = "GET", body }) => {
        let response;
        try {
            response = await request(url, {
                method,
                headers: {
                    Authorization: `Bearer ${apiToken}`,
                    ...(body === undefined
                        ? {}
                        : { "Content-Type": "application/json" }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(15_000),
            });
        } catch (cause) {
            throw new CloudflareWorkersApiError({
                operation,
                cause,
                secrets,
                // Once a mutation request has left the client, a transport
                // failure cannot prove whether Cloudflare accepted it. GET
                // failures are observational and therefore never carry this
                // marker.
                indeterminateMutation: method !== "GET",
            });
        }
        return parseResponse({
            response,
            operation,
            secrets,
            mutationDispatched: method !== "GET",
        });
    };

    const invalidResult = ({
        operation,
        message,
        indeterminateMutation = false,
    }) => {
        throw new CloudflareWorkersApiError({
            operation,
            status: 200,
            cause: new Error(message),
            secrets,
            indeterminateMutation,
        });
    };
    const workerResourceUrl = (workerName) => {
        if (!WORKER_NAME.test(workerName || "")) {
            throw new Error("Cloudflare Worker name is missing or malformed");
        }
        return `${scriptsUrl}/${workerName}`;
    };
    const requireVersionId = (versionId) => {
        if (!VERSION_ID.test(versionId || "")) {
            throw new Error(
                "Cloudflare Worker version ID is missing or malformed"
            );
        }
        return versionId;
    };

    return {
        listWorkerScripts: async () => {
            const payload = await call({
                operation: "list account Worker scripts",
                url: scriptsUrl,
            });
            if (!Array.isArray(payload.result)) {
                throw new CloudflareWorkersApiError({
                    operation: "list account Worker scripts",
                    status: 200,
                    cause: new Error(
                        "Cloudflare returned no Worker script list"
                    ),
                    secrets,
                });
            }
            const scripts = new Map();
            for (const script of payload.result) {
                if (
                    typeof script?.id !== "string" ||
                    script.id.length === 0 ||
                    scripts.has(script.id) ||
                    (script.tag != null &&
                        (typeof script.tag !== "string" ||
                            script.tag.length === 0)) ||
                    !Array.isArray(script.routes)
                ) {
                    throw new CloudflareWorkersApiError({
                        operation: "list account Worker scripts",
                        status: 200,
                        cause: new Error(
                            "Cloudflare returned an invalid Worker script identity"
                        ),
                        secrets,
                    });
                }
                const routeIds = new Set();
                const routePatterns = new Set();
                const routes = [];
                for (const route of script.routes) {
                    if (
                        typeof route?.id !== "string" ||
                        route.id.length === 0 ||
                        routeIds.has(route.id) ||
                        typeof route.pattern !== "string" ||
                        route.pattern.length === 0 ||
                        routePatterns.has(route.pattern) ||
                        route.script !== script.id
                    ) {
                        throw new CloudflareWorkersApiError({
                            operation: "list account Worker scripts",
                            status: 200,
                            cause: new Error(
                                "Cloudflare returned an invalid or ambiguous Worker route attachment"
                            ),
                            secrets,
                        });
                    }
                    routeIds.add(route.id);
                    routePatterns.add(route.pattern);
                    routes.push({
                        id: route.id,
                        pattern: route.pattern,
                        script: route.script,
                    });
                }
                scripts.set(script.id, { tag: script.tag, routes });
            }
            return scripts;
        },
        listWorkerDomains: async () => {
            const operation = "list account Worker custom domains";
            const readSnapshot = async () => {
                const domains = [];
                const domainIds = new Set();
                const hostnames = new Set();
                let expectedTotalCount;
                let expectedTotalPages;
                let expectedPerPage;

                for (let page = 1; page <= MAX_CUSTOM_DOMAIN_PAGES; page += 1) {
                    const payload = await call({
                        operation,
                        url: `${domainsUrl}?page=${page}&per_page=${CUSTOM_DOMAIN_PAGE_SIZE}`,
                    });
                    const result = payload.result;
                    const info = payload.result_info;
                    const validInfo =
                        Array.isArray(result) &&
                        info &&
                        typeof info === "object" &&
                        Number.isSafeInteger(info.count) &&
                        info.count >= 0 &&
                        info.count === result.length &&
                        Number.isSafeInteger(info.page) &&
                        info.page === page &&
                        Number.isSafeInteger(info.per_page) &&
                        info.per_page > 0 &&
                        info.count <= info.per_page &&
                        Number.isSafeInteger(info.total_count) &&
                        info.total_count >= 0 &&
                        Number.isSafeInteger(info.total_pages) &&
                        info.total_pages >= 0 &&
                        info.total_pages <= MAX_CUSTOM_DOMAIN_PAGES &&
                        (info.total_count === 0
                            ? info.total_pages === 0 || info.total_pages === 1
                            : info.total_pages ===
                              Math.ceil(info.total_count / info.per_page)) &&
                        page <= Math.max(info.total_pages, 1);
                    if (!validInfo) {
                        invalidResult({
                            operation,
                            message:
                                "Cloudflare returned invalid or ambiguous custom-domain pagination",
                        });
                    }

                    expectedTotalCount ??= info.total_count;
                    expectedTotalPages ??= info.total_pages;
                    expectedPerPage ??= info.per_page;
                    if (
                        info.total_count !== expectedTotalCount ||
                        info.total_pages !== expectedTotalPages ||
                        info.per_page !== expectedPerPage
                    ) {
                        invalidResult({
                            operation,
                            message:
                                "Cloudflare custom-domain pagination changed while it was being read",
                        });
                    }

                    for (const domain of result) {
                        const hostname =
                            typeof domain?.hostname === "string"
                                ? domain.hostname.toLowerCase()
                                : undefined;
                        if (
                            typeof domain?.id !== "string" ||
                            domain.id.length === 0 ||
                            domainIds.has(domain.id) ||
                            !hostname ||
                            !DNS_HOSTNAME.test(hostname) ||
                            domain.hostname.trim() !== domain.hostname ||
                            hostnames.has(hostname) ||
                            !WORKER_NAME.test(domain.service || "") ||
                            typeof domain.environment !== "string" ||
                            domain.environment.length === 0 ||
                            !CLOUDFLARE_ACCOUNT_ID.test(domain.zone_id || "") ||
                            typeof domain.zone_name !== "string" ||
                            domain.zone_name.length === 0
                        ) {
                            invalidResult({
                                operation,
                                message:
                                    "Cloudflare returned an invalid or ambiguous custom-domain attachment",
                            });
                        }
                        domainIds.add(domain.id);
                        hostnames.add(hostname);
                        domains.push({
                            id: domain.id,
                            hostname,
                            service: domain.service,
                            environment: domain.environment,
                            zoneId: domain.zone_id,
                            zoneName: domain.zone_name.toLowerCase(),
                        });
                    }

                    if (page >= info.total_pages) break;
                }

                if (
                    expectedTotalCount == null ||
                    expectedTotalPages == null ||
                    domains.length !== expectedTotalCount
                ) {
                    invalidResult({
                        operation,
                        message:
                            "Cloudflare returned an incomplete custom-domain inventory",
                    });
                }
                return domains.sort((left, right) =>
                    left.id.localeCompare(right.id)
                );
            };

            let previousCanonicalSnapshot;
            for (
                let attempt = 1;
                attempt <= MAX_CUSTOM_DOMAIN_SNAPSHOT_ATTEMPTS;
                attempt += 1
            ) {
                const snapshot = await readSnapshot();
                const canonicalSnapshot = JSON.stringify(snapshot);
                if (canonicalSnapshot === previousCanonicalSnapshot) {
                    return snapshot;
                }
                previousCanonicalSnapshot = canonicalSnapshot;
            }
            invalidResult({
                operation,
                message:
                    "Cloudflare custom-domain inventory did not remain stable across complete snapshots",
            });
        },
        getWorkerSubdomain: async (workerName) => {
            const operation = `read workers.dev and Preview URL state for ${workerName}`;
            const payload = await call({
                operation,
                url: `${workerResourceUrl(workerName)}/subdomain`,
            });
            const result = payload.result;
            const keys =
                result && typeof result === "object" && !Array.isArray(result)
                    ? Object.keys(result).sort()
                    : [];
            if (
                keys.length !== 2 ||
                keys[0] !== "enabled" ||
                keys[1] !== "previews_enabled" ||
                typeof result.enabled !== "boolean" ||
                typeof result.previews_enabled !== "boolean"
            ) {
                invalidResult({
                    operation,
                    message:
                        "Cloudflare returned invalid or ambiguous Worker subdomain state",
                });
            }
            return {
                enabled: result.enabled,
                previewsEnabled: result.previews_enabled,
            };
        },
        getCurrentDeployment: async (workerName) => {
            const operation = `read active deployment for ${workerName}`;
            const payload = await call({
                operation,
                url: `${workerResourceUrl(workerName)}/deployments`,
            });
            if (
                !Array.isArray(payload.result?.deployments) ||
                !payload.result.deployments[0] ||
                typeof payload.result.deployments[0] !== "object"
            ) {
                invalidResult({
                    operation,
                    message: "Cloudflare returned no active Worker deployment",
                });
            }
            // Cloudflare documents the first item as the deployment actively
            // serving traffic. Returning only it prevents callers from
            // accidentally treating an older history item as current.
            return payload.result.deployments[0];
        },
        getWorkerVersion: async (workerName, versionId) => {
            const validVersionId = requireVersionId(versionId);
            const operation = `read Worker version ${validVersionId} for ${workerName}`;
            const payload = await call({
                operation,
                url: `${workerResourceUrl(workerName)}/versions/${validVersionId}`,
            });
            if (
                !payload.result ||
                typeof payload.result !== "object" ||
                payload.result.id !== validVersionId
            ) {
                invalidResult({
                    operation,
                    message: "Cloudflare returned the wrong Worker version",
                });
            }
            return payload.result;
        },
        createDeployment: async ({ workerName, versionId, message }) => {
            const validVersionId = requireVersionId(versionId);
            if (
                typeof message !== "string" ||
                message.length === 0 ||
                new TextEncoder().encode(message).byteLength > 1_000
            ) {
                throw new Error(
                    "Cloudflare deployment message is missing or too long"
                );
            }
            const operation = `activate Worker version ${validVersionId} for ${workerName}`;
            const payload = await call({
                operation,
                url: `${workerResourceUrl(workerName)}/deployments`,
                method: "POST",
                body: {
                    strategy: "percentage",
                    versions: [{ version_id: validVersionId, percentage: 100 }],
                    annotations: {
                        "workers/message": message,
                        "workers/triggered_by": "peerbit-production-workflow",
                    },
                },
            });
            const result = payload.result;
            if (
                !result ||
                typeof result !== "object" ||
                !VERSION_ID.test(result.id || "") ||
                result.strategy !== "percentage" ||
                !Array.isArray(result.versions) ||
                result.versions.length !== 1 ||
                result.versions[0]?.version_id !== validVersionId ||
                result.versions[0]?.percentage !== 100
            ) {
                invalidResult({
                    operation,
                    message:
                        "Cloudflare returned invalid exact-version deployment evidence",
                    indeterminateMutation: true,
                });
            }
            return result;
        },
    };
};

export const isCloudflareAuthenticationEnvironmentVariable = (name) =>
    name.startsWith("CLOUDFLARE_") ||
    name.startsWith("CF_") ||
    name === "WRANGLER_CF_AUTHORIZATION_TOKEN" ||
    name === "WRANGLER_R2_SQL_AUTH_TOKEN";

export const redactCloudflareCredentials = (value, environment) =>
    redactText(
        value,
        Object.entries(environment)
            .filter(([name]) =>
                isCloudflareAuthenticationEnvironmentVariable(name)
            )
            .map(([, secret]) => secret)
    );
