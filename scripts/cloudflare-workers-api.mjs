import { createHash } from "node:crypto";

const CLOUDFLARE_ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const WORKER_NAME = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const DNS_HOSTNAME =
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const VERSION_ID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const CUSTOM_DOMAIN_PAGE_SIZE = 100;
const MAX_CUSTOM_DOMAIN_PAGES = 1_000;
const MAX_CUSTOM_DOMAIN_SNAPSHOT_ATTEMPTS = 3;
const ZONE_PAGE_SIZE = 50;
const MAX_ZONE_PAGES = 1_000;
const REQUIRED_ZONE_ROUTE_SNAPSHOTS = 2;
const MAX_ROUTES_PER_ZONE = 100_000;
const QUEUE_PAGE_SIZE = 100;
const MAX_QUEUE_PAGES = 1_000;
const MAX_QUEUE_SNAPSHOT_ATTEMPTS = 3;
const CLOUDFLARE_RESOURCE_ID = /^(?=.{1,32}$)[A-Za-z0-9_-]+$/;
const QUEUE_NAME = /^(?=.{1,63}$)[A-Za-z0-9_-]+$/;
const ZONE_STATUSES = new Set(["initializing", "pending", "active", "moved"]);
const ZONE_TYPES = new Set(["full", "partial", "secondary", "internal"]);
const MAX_DEPLOYABLE_WORKER_VERSIONS = 10_000;
const WORKERS_DEV_REFERENCE =
    /(?<![a-z0-9-])(?:(?:[a-z][a-z0-9+.-]*:)?\/\/)?(?:[a-z0-9-]+\.)*workers\.dev(?:\.(?![a-z0-9-])|(?![a-z0-9.-]))(?::[0-9]+)?(?:[/?#][^\s<>"']*)?/gi;
const WORKERS_DEV_REDACTION = "[REDACTED_WORKERS_DEV_REFERENCE]";

const canonicalizeJson = (value) => {
    if (Array.isArray(value)) return value.map(canonicalizeJson);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, canonicalizeJson(value[key])])
        );
    }
    return value;
};

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
    const queuesUrl = `${CLOUDFLARE_API_BASE_URL}/accounts/${accountId}/queues`;
    const zonesUrl = `${CLOUDFLARE_API_BASE_URL}/zones`;
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
    const parseSubdomainState = ({
        result,
        operation,
        indeterminateMutation = false,
    }) => {
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
                indeterminateMutation,
            });
        }
        return {
            enabled: result.enabled,
            previewsEnabled: result.previews_enabled,
        };
    };
    const readWorkerDeployments = async (
        workerName,
        operation = `read deployments for ${workerName}`
    ) => {
        const payload = await call({
            operation,
            url: `${workerResourceUrl(workerName)}/deployments`,
        });
        if (!Array.isArray(payload.result?.deployments)) {
            invalidResult({
                operation,
                message: "Cloudflare returned an invalid deployment list",
            });
        }
        return payload.result.deployments;
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
                    !WORKER_NAME.test(script?.id || "") ||
                    scripts.has(script.id) ||
                    (script.tag != null &&
                        (typeof script.tag !== "string" ||
                            script.tag.length === 0)) ||
                    (script.routes != null && !Array.isArray(script.routes)) ||
                    (script.tail_consumers != null &&
                        !Array.isArray(script.tail_consumers)) ||
                    (script.logpush != null &&
                        typeof script.logpush !== "boolean")
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
                const routes = script.routes == null ? null : [];
                if (script.routes != null) {
                    for (const route of script.routes) {
                        const routeScript = route?.script ?? script.id;
                        if (
                            !CLOUDFLARE_RESOURCE_ID.test(route?.id || "") ||
                            routeIds.has(route.id) ||
                            typeof route.pattern !== "string" ||
                            route.pattern.length === 0 ||
                            route.pattern.trim() !== route.pattern ||
                            routePatterns.has(route.pattern) ||
                            routeScript !== script.id
                        ) {
                            throw new CloudflareWorkersApiError({
                                operation: "list account Worker scripts",
                                status: 200,
                                cause: new Error(
                                    "Cloudflare returned an invalid or ambiguous inline Worker route attachment"
                                ),
                                secrets,
                            });
                        }
                        routeIds.add(route.id);
                        routePatterns.add(route.pattern);
                        routes.push({
                            id: route.id,
                            pattern: route.pattern,
                            script: routeScript,
                        });
                    }
                    routes.sort((left, right) =>
                        left.id.localeCompare(right.id)
                    );
                }
                scripts.set(script.id, {
                    tag: script.tag,
                    routes,
                    tailConsumers: structuredClone(script.tail_consumers ?? []),
                    logpush: script.logpush ?? false,
                });
            }
            return scripts;
        },
        listZoneRouteInventory: async () => {
            const operation =
                "list stable authoritative account zone and Worker route inventory";
            const readZoneSnapshot = async () => {
                const zones = [];
                const zoneIds = new Set();
                const zoneNames = new Set();
                let expectedTotalCount;
                let expectedTotalPages;
                let expectedPerPage;

                for (let page = 1; page <= MAX_ZONE_PAGES; page += 1) {
                    const query = new URLSearchParams({
                        "account.id": accountId,
                        page: String(page),
                        per_page: String(ZONE_PAGE_SIZE),
                        type: [...ZONE_TYPES].join(","),
                        order: "name",
                        direction: "asc",
                        match: "all",
                    });
                    const payload = await call({
                        operation,
                        url: `${zonesUrl}?${query}`,
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
                        info.per_page <= ZONE_PAGE_SIZE &&
                        info.count <= info.per_page &&
                        Number.isSafeInteger(info.total_count) &&
                        info.total_count >= 0 &&
                        Number.isSafeInteger(info.total_pages) &&
                        info.total_pages >= 0 &&
                        info.total_pages <= MAX_ZONE_PAGES &&
                        (info.total_count === 0
                            ? info.total_pages === 0 || info.total_pages === 1
                            : info.total_pages ===
                              Math.ceil(info.total_count / info.per_page)) &&
                        page <= Math.max(info.total_pages, 1);
                    if (!validInfo) {
                        invalidResult({
                            operation,
                            message:
                                "Cloudflare returned invalid or ambiguous account-zone pagination",
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
                                "Cloudflare account-zone pagination changed while it was being read",
                        });
                    }

                    for (const zone of result) {
                        const zoneId =
                            typeof zone?.id === "string"
                                ? zone.id.toLowerCase()
                                : undefined;
                        const zoneName =
                            typeof zone?.name === "string"
                                ? zone.name.toLowerCase()
                                : undefined;
                        const zoneAccountId =
                            typeof zone?.account?.id === "string"
                                ? zone.account.id.toLowerCase()
                                : undefined;
                        const zoneType = zone?.type ?? null;
                        if (
                            !zoneId ||
                            !CLOUDFLARE_ACCOUNT_ID.test(zoneId) ||
                            zone.id !== zoneId ||
                            zoneIds.has(zoneId) ||
                            !zoneName ||
                            !DNS_HOSTNAME.test(zoneName) ||
                            zone.name !== zoneName ||
                            zone.name.trim() !== zone.name ||
                            zoneNames.has(zoneName) ||
                            zoneAccountId !== accountId.toLowerCase() ||
                            zone.account.id !== zoneAccountId ||
                            !ZONE_STATUSES.has(zone.status) ||
                            (zoneType !== null && !ZONE_TYPES.has(zoneType))
                        ) {
                            invalidResult({
                                operation,
                                message:
                                    "Cloudflare returned an invalid, duplicate, or wrong-account zone identity",
                            });
                        }
                        zoneIds.add(zoneId);
                        zoneNames.add(zoneName);
                        zones.push({
                            zoneId,
                            zoneName,
                            status: zone.status,
                            type: zoneType,
                        });
                    }
                    if (page >= info.total_pages) break;
                }

                if (
                    expectedTotalCount == null ||
                    expectedTotalPages == null ||
                    zones.length !== expectedTotalCount
                ) {
                    invalidResult({
                        operation,
                        message:
                            "Cloudflare returned an incomplete account-zone inventory",
                    });
                }
                return zones.sort((left, right) =>
                    left.zoneId.localeCompare(right.zoneId)
                );
            };

            const readFullSnapshot = async () => {
                const zones = await readZoneSnapshot();
                const routeIds = new Set();
                const routePatterns = new Set();
                for (const zone of zones) {
                    const payload = await call({
                        operation,
                        url: `${zonesUrl}/${zone.zoneId}/workers/routes`,
                    });
                    if (
                        !Array.isArray(payload.result) ||
                        payload.result.length > MAX_ROUTES_PER_ZONE
                    ) {
                        invalidResult({
                            operation,
                            message:
                                "Cloudflare returned an invalid authoritative Worker route list",
                        });
                    }
                    const routes = [];
                    for (const route of payload.result) {
                        const script = route?.script ?? null;
                        if (
                            !CLOUDFLARE_RESOURCE_ID.test(route?.id || "") ||
                            routeIds.has(route.id) ||
                            typeof route.pattern !== "string" ||
                            route.pattern.length === 0 ||
                            route.pattern.trim() !== route.pattern ||
                            routePatterns.has(route.pattern) ||
                            (script !== null && !WORKER_NAME.test(script))
                        ) {
                            invalidResult({
                                operation,
                                message:
                                    "Cloudflare returned an invalid, duplicate, or ambiguous authoritative Worker route",
                            });
                        }
                        routeIds.add(route.id);
                        routePatterns.add(route.pattern);
                        routes.push({
                            id: route.id,
                            pattern: route.pattern,
                            script,
                        });
                    }
                    zone.routes = routes.sort((left, right) =>
                        left.id.localeCompare(right.id)
                    );
                }
                return zones;
            };

            let previousCanonicalSnapshot;
            for (
                let snapshotNumber = 1;
                snapshotNumber <= REQUIRED_ZONE_ROUTE_SNAPSHOTS;
                snapshotNumber += 1
            ) {
                const snapshot = await readFullSnapshot();
                const canonicalSnapshot = JSON.stringify(snapshot);
                if (
                    snapshotNumber > 1 &&
                    canonicalSnapshot !== previousCanonicalSnapshot
                ) {
                    invalidResult({
                        operation,
                        message:
                            "Cloudflare authoritative zone or Worker route inventory changed between complete snapshots",
                    });
                }
                previousCanonicalSnapshot = canonicalSnapshot;
                if (snapshotNumber === REQUIRED_ZONE_ROUTE_SNAPSHOTS) {
                    return snapshot;
                }
            }
            throw new Error("unreachable zone-route snapshot state");
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
            return parseSubdomainState({ result: payload.result, operation });
        },
        listWorkerSchedules: async (workerName) => {
            const operation = `list Cron Trigger schedules for ${workerName}`;
            const payload = await call({
                operation,
                url: `${workerResourceUrl(workerName)}/schedules`,
            });
            const result = payload.result;
            const keys =
                result && typeof result === "object" && !Array.isArray(result)
                    ? Object.keys(result).sort()
                    : [];
            if (
                keys.length !== 1 ||
                keys[0] !== "schedules" ||
                !Array.isArray(result.schedules)
            ) {
                invalidResult({
                    operation,
                    message:
                        "Cloudflare returned an invalid Cron Trigger schedule list",
                });
            }
            const crons = [];
            const seen = new Set();
            for (const schedule of result.schedules) {
                if (
                    !schedule ||
                    typeof schedule !== "object" ||
                    Array.isArray(schedule) ||
                    typeof schedule.cron !== "string" ||
                    schedule.cron.length === 0 ||
                    seen.has(schedule.cron)
                ) {
                    invalidResult({
                        operation,
                        message:
                            "Cloudflare returned an invalid or ambiguous Cron Trigger schedule",
                    });
                }
                seen.add(schedule.cron);
                crons.push(schedule.cron);
            }
            return crons.sort();
        },
        listQueueConsumerInventory: async () => {
            const operation = "list account Queue consumer attachments";
            const normalizeConsumer = ({ consumer, queueName }) => {
                if (
                    !consumer ||
                    typeof consumer !== "object" ||
                    Array.isArray(consumer) ||
                    !CLOUDFLARE_RESOURCE_ID.test(consumer.consumer_id || "") ||
                    !["worker", "http_pull"].includes(consumer.type) ||
                    (consumer.queue_name != null &&
                        consumer.queue_name !== queueName) ||
                    (consumer.created_on != null &&
                        (typeof consumer.created_on !== "string" ||
                            Number.isNaN(Date.parse(consumer.created_on)))) ||
                    (consumer.dead_letter_queue != null &&
                        typeof consumer.dead_letter_queue !== "string") ||
                    (consumer.settings != null &&
                        (!consumer.settings ||
                            typeof consumer.settings !== "object" ||
                            Array.isArray(consumer.settings))) ||
                    (consumer.type === "worker" &&
                        !WORKER_NAME.test(consumer.script_name || "")) ||
                    (consumer.type === "http_pull" &&
                        consumer.script_name != null)
                ) {
                    invalidResult({
                        operation,
                        message:
                            "Cloudflare returned an invalid Queue consumer attachment",
                    });
                }
                return {
                    consumerId: consumer.consumer_id,
                    type: consumer.type,
                    scriptName:
                        consumer.type === "worker"
                            ? consumer.script_name
                            : null,
                    queueName,
                    deadLetterQueue: consumer.dead_letter_queue ?? "",
                    // Cloudflare does not promise object-key order. Normalize
                    // nested settings so two semantically identical complete
                    // snapshots have one stable ledger representation.
                    settings: canonicalizeJson(consumer.settings ?? {}),
                };
            };
            const readSnapshot = async () => {
                const queues = [];
                const queueIds = new Set();
                const queueNames = new Set();
                let expectedTotalCount;
                let expectedTotalPages;
                let expectedPerPage;

                for (let page = 1; page <= MAX_QUEUE_PAGES; page += 1) {
                    const payload = await call({
                        operation,
                        url: `${queuesUrl}?page=${page}&per_page=${QUEUE_PAGE_SIZE}`,
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
                        info.total_pages <= MAX_QUEUE_PAGES &&
                        (info.total_count === 0
                            ? info.total_pages === 0 || info.total_pages === 1
                            : info.total_pages ===
                              Math.ceil(info.total_count / info.per_page)) &&
                        page <= Math.max(info.total_pages, 1);
                    if (!validInfo) {
                        invalidResult({
                            operation,
                            message:
                                "Cloudflare returned invalid or ambiguous Queue pagination",
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
                                "Cloudflare Queue pagination changed while it was being read",
                        });
                    }

                    for (const queue of result) {
                        if (
                            !queue ||
                            typeof queue !== "object" ||
                            Array.isArray(queue) ||
                            !CLOUDFLARE_RESOURCE_ID.test(
                                queue.queue_id || ""
                            ) ||
                            queueIds.has(queue.queue_id) ||
                            !QUEUE_NAME.test(queue.queue_name || "") ||
                            queueNames.has(queue.queue_name) ||
                            !Number.isSafeInteger(
                                queue.consumers_total_count
                            ) ||
                            queue.consumers_total_count < 0
                        ) {
                            invalidResult({
                                operation,
                                message:
                                    "Cloudflare returned an invalid or ambiguous Queue identity",
                            });
                        }
                        queueIds.add(queue.queue_id);
                        queueNames.add(queue.queue_name);
                        const consumerPayload = await call({
                            operation,
                            url: `${queuesUrl}/${encodeURIComponent(
                                queue.queue_id
                            )}/consumers`,
                        });
                        if (
                            !Array.isArray(consumerPayload.result) ||
                            consumerPayload.result.length !==
                                queue.consumers_total_count
                        ) {
                            invalidResult({
                                operation,
                                message:
                                    "Cloudflare returned an incomplete Queue consumer inventory",
                            });
                        }
                        const consumerIds = new Set();
                        const consumers = consumerPayload.result.map(
                            (consumer) => {
                                const normalized = normalizeConsumer({
                                    consumer,
                                    queueName: queue.queue_name,
                                });
                                if (consumerIds.has(normalized.consumerId)) {
                                    invalidResult({
                                        operation,
                                        message:
                                            "Cloudflare returned a duplicate Queue consumer identity",
                                    });
                                }
                                consumerIds.add(normalized.consumerId);
                                return normalized;
                            }
                        );
                        queues.push({
                            queueId: queue.queue_id,
                            queueName: queue.queue_name,
                            consumers: consumers.sort((left, right) =>
                                left.consumerId.localeCompare(right.consumerId)
                            ),
                        });
                    }
                    if (page >= info.total_pages) break;
                }
                if (
                    expectedTotalCount == null ||
                    expectedTotalPages == null ||
                    queues.length !== expectedTotalCount
                ) {
                    invalidResult({
                        operation,
                        message:
                            "Cloudflare returned an incomplete account Queue inventory",
                    });
                }
                return queues.sort((left, right) =>
                    left.queueId.localeCompare(right.queueId)
                );
            };

            let previousCanonicalSnapshot;
            for (
                let attempt = 1;
                attempt <= MAX_QUEUE_SNAPSHOT_ATTEMPTS;
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
                    "Cloudflare Queue consumer inventory did not remain stable across complete snapshots",
            });
        },
        getWorkerVersionModule: async (workerName, versionId) => {
            const validVersionId = requireVersionId(versionId);
            const operation = `download exact Worker version module for ${workerName} ${validVersionId}`;
            const url = `${workerResourceUrl(workerName)}/content/v2?version=${encodeURIComponent(validVersionId)}`;
            let response;
            try {
                response = await request(url, {
                    headers: { Authorization: `Bearer ${apiToken}` },
                    signal: AbortSignal.timeout(15_000),
                });
            } catch (cause) {
                throw new CloudflareWorkersApiError({
                    operation,
                    cause,
                    secrets,
                });
            }
            if (!response.ok) {
                await parseResponse({ response, operation, secrets });
            }
            if (
                !response.headers
                    .get("content-type")
                    ?.toLowerCase()
                    .startsWith("multipart/form-data")
            ) {
                invalidResult({
                    operation,
                    message:
                        "Cloudflare returned non-multipart exact Worker version content",
                });
            }
            const mainModule = response.headers.get("cf-entrypoint");
            if (
                typeof mainModule !== "string" ||
                mainModule.length === 0 ||
                mainModule.length > 255
            ) {
                invalidResult({
                    operation,
                    message:
                        "Cloudflare returned no unambiguous exact Worker version entrypoint",
                });
            }
            let form;
            try {
                form = await response.formData();
            } catch {
                invalidResult({
                    operation,
                    message:
                        "Cloudflare returned malformed exact Worker version multipart content",
                });
            }
            const parts = [...form.entries()];
            if (
                !WORKER_NAME.test(workerName || "") ||
                parts.length !== 1 ||
                parts[0][0] !== mainModule ||
                typeof parts[0][1] === "string" ||
                typeof parts[0][1]?.arrayBuffer !== "function" ||
                parts[0][1].name !== mainModule ||
                parts[0][1].type !== "application/javascript+module"
            ) {
                invalidResult({
                    operation,
                    message:
                        "Cloudflare returned an additional, missing, or malformed exact Worker version module",
                });
            }
            let bytes;
            try {
                bytes = Buffer.from(await parts[0][1].arrayBuffer());
            } catch {
                invalidResult({
                    operation,
                    message:
                        "Cloudflare exact Worker version module bytes could not be read",
                });
            }
            return {
                name: mainModule,
                contentType: parts[0][1].type,
                size: bytes.length,
                sha256: createHash("sha256").update(bytes).digest("hex"),
            };
        },
        getWorkerDeployments: readWorkerDeployments,
        listDeployableWorkerVersions: async (workerName) => {
            const operation = `list deployable Worker versions for ${workerName}`;
            const payload = await call({
                operation,
                url: `${workerResourceUrl(workerName)}/versions?deployable=true`,
            });
            const items = payload.result?.items;
            if (
                !Array.isArray(items) ||
                items.length > MAX_DEPLOYABLE_WORKER_VERSIONS
            ) {
                invalidResult({
                    operation,
                    message:
                        "Cloudflare returned an invalid deployable Worker version list",
                });
            }
            const versionIds = [];
            const seen = new Set();
            for (const item of items) {
                if (
                    !item ||
                    typeof item !== "object" ||
                    !VERSION_ID.test(item.id || "") ||
                    seen.has(item.id)
                ) {
                    invalidResult({
                        operation,
                        message:
                            "Cloudflare returned an invalid or ambiguous deployable Worker version identity",
                    });
                }
                seen.add(item.id);
                versionIds.push(item.id);
            }
            return versionIds;
        },
        getCurrentDeployment: async (workerName) => {
            const operation = `read active deployment for ${workerName}`;
            const deployments = await readWorkerDeployments(
                workerName,
                operation
            );
            if (
                !deployments[0] ||
                typeof deployments[0] !== "object" ||
                Array.isArray(deployments[0])
            ) {
                invalidResult({
                    operation,
                    message: "Cloudflare returned no active Worker deployment",
                });
            }
            // Cloudflare documents the first item as the deployment actively
            // serving traffic. Returning only it prevents callers from
            // accidentally treating an older history item as current.
            return deployments[0];
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
        disableWorkerSubdomain: async (workerName) => {
            const operation = `disable workers.dev and Preview URLs for ${workerName}`;
            const payload = await call({
                operation,
                url: `${workerResourceUrl(workerName)}/subdomain`,
                method: "POST",
                body: { enabled: false, previews_enabled: false },
            });
            const state = parseSubdomainState({
                result: payload.result,
                operation,
                indeterminateMutation: true,
            });
            if (state.enabled || state.previewsEnabled) {
                invalidResult({
                    operation,
                    message:
                        "Cloudflare did not confirm disabled Worker subdomain state",
                    indeterminateMutation: true,
                });
            }
            return state;
        },
        attachWorkerDomain: async ({ workerName, hostname }) => {
            if (!WORKER_NAME.test(workerName || "")) {
                throw new Error(
                    "Cloudflare Worker name is missing or malformed"
                );
            }
            if (
                typeof hostname !== "string" ||
                hostname !== hostname.toLowerCase() ||
                hostname.trim() !== hostname ||
                !DNS_HOSTNAME.test(hostname)
            ) {
                throw new Error(
                    "Cloudflare custom domain hostname is missing or malformed"
                );
            }
            const operation = `attach reviewed custom domain ${hostname} to ${workerName}`;
            const payload = await call({
                operation,
                url: domainsUrl,
                method: "PUT",
                body: {
                    hostname,
                    service: workerName,
                    environment: "production",
                },
            });
            const result = payload.result;
            if (
                !result ||
                typeof result !== "object" ||
                Array.isArray(result) ||
                typeof result.id !== "string" ||
                result.id.length === 0 ||
                result.hostname !== hostname ||
                result.service !== workerName ||
                result.environment !== "production" ||
                !CLOUDFLARE_ACCOUNT_ID.test(result.zone_id || "") ||
                typeof result.zone_name !== "string" ||
                result.zone_name.length === 0
            ) {
                invalidResult({
                    operation,
                    message:
                        "Cloudflare returned invalid custom-domain attachment evidence",
                    indeterminateMutation: true,
                });
            }
            return {
                id: result.id,
                hostname: result.hostname,
                service: result.service,
                environment: result.environment,
                zoneId: result.zone_id,
                zoneName: result.zone_name.toLowerCase(),
            };
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
