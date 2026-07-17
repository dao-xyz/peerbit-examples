import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
    APP_PRODUCTION_SUFFIX,
    CLOUDFLARE_WORKER_NAMESPACE_PREFIX,
    loadCloudflareDeploymentData,
    repoRoot,
    selectCloudflareDeploymentEntries,
    validateRenderedCloudflareConfigSet,
} from "./cloudflare-deployment-policy.mjs";
import {
    createCloudflareWorkersApi,
    isCloudflareAuthenticationEnvironmentVariable,
    isIndeterminateCloudflareMutationError,
    redactCloudflareCredentials,
} from "./cloudflare-workers-api.mjs";
import {
    CLOUDFLARE_ARTIFACT_DIGEST_BINDING,
    artifactBoundVersionMessage,
    revalidateCloudflareArtifactManifest,
    validateCloudflareArtifactDeploymentConfig,
} from "./cloudflare-artifact-manifest.mjs";

const VERSION_ID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FULL_GIT_COMMIT = /^[0-9a-f]{40}$/i;
const PRODUCTION_DEPLOYMENT_ARGUMENTS = new Set(["target", "commit"]);
const PRODUCTION_DEPLOYMENT_USAGE =
    "Usage: deploy-cloudflare-production.mjs --target ID|apps|all --commit SHA";
const MAX_DIAGNOSTIC_LENGTH = 2_000;
const VERSION_TAG = /^[A-Za-z0-9_-]{1,100}$/;
const DNS_HOSTNAME =
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CLOUDFLARE_ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const CLOUDFLARE_RESOURCE_ID = /^(?=.{1,32}$)[A-Za-z0-9_-]+$/;
const WORKER_NAME = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const ZONE_STATUSES = new Set(["initializing", "pending", "active", "moved"]);
const ZONE_TYPES = new Set(["full", "partial", "secondary", "internal"]);
const SHA256_DIGEST = /^[0-9a-f]{64}$/;
const compareCanonicalStrings = (left, right) =>
    left < right ? -1 : left > right ? 1 : 0;
const INDETERMINATE_ACTIVATION_OBSERVATIONS = 12;
const INDETERMINATE_ACTIVATION_DELAY_MS = 2_500;

const productionOrigin = ({ site, policy }) => {
    if (
        policy.kind !== "app" ||
        !Array.isArray(policy.productionHostnames) ||
        policy.productionHostnames.length !== 1
    ) {
        throw new Error(
            `${site.id}: app verification requires exactly one production hostname`
        );
    }
    return `https://${policy.productionHostnames[0]}`;
};

export const productionSmokeEnvironment = (entries) => {
    const byId = new Map(entries.map((entry) => [entry.site.id, entry]));
    const originFor = (id) => {
        const entry = byId.get(id);
        if (!entry) throw new Error(`Missing runtime smoke site ${id}`);
        return productionOrigin(entry);
    };
    return {
        PW_BASE_URL: originFor("files"),
        PW_STREAM_URL: originFor("stream"),
    };
};

export const readBaselineReleaseCommit = async ({
    site,
    policy,
    request = fetch,
}) => {
    if (policy.kind === "redirect") return undefined;

    const releaseUrl = `${productionOrigin({ site, policy })}/release.json`;
    let response;
    try {
        response = await request(releaseUrl, {
            signal: AbortSignal.timeout(15_000),
        });
    } catch (error) {
        throw new Error(
            `${site.id}: could not read rollback release metadata: ${error}`
        );
    }
    if (response.status !== 200) {
        throw new Error(
            `${site.id}: rollback release metadata returned HTTP ${response.status}`
        );
    }

    let release;
    try {
        release = await response.json();
    } catch (error) {
        throw new Error(
            `${site.id}: rollback release metadata is not valid JSON: ${error}`
        );
    }
    if (release?.site !== site.id) {
        throw new Error(`${site.id}: rollback release metadata has wrong site`);
    }
    if (!FULL_GIT_COMMIT.test(release.commit || "")) {
        throw new Error(
            `${site.id}: rollback release metadata requires a full Git commit hash`
        );
    }
    return release.commit;
};

export const readSingleVersionDeployment = (deployment, siteId) => {
    if (!deployment || !Array.isArray(deployment.versions)) {
        throw new Error(
            `${siteId}: Cloudflare returned no deployment versions`
        );
    }
    if (
        deployment.versions.length !== 1 ||
        deployment.versions[0]?.percentage !== 100 ||
        !VERSION_ID.test(deployment.versions[0]?.version_id || "")
    ) {
        throw new Error(
            `${siteId}: production must have exactly one valid version at 100% before deployment`
        );
    }
    return deployment.versions[0].version_id;
};

const validateDeploymentEvidence = (evidence, expectedWorkerName) => {
    if (
        evidence?.workerName !== expectedWorkerName ||
        typeof evidence.workerTag !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(evidence.workerTag) ||
        !VERSION_ID.test(evidence.versionId || "")
    ) {
        throw new Error(
            `${expectedWorkerName}: Wrangler returned invalid deployment ownership evidence`
        );
    }
    return {
        workerName: evidence.workerName,
        workerTag: evidence.workerTag,
        versionId: evidence.versionId,
    };
};

const assertNoWorkersDevOutput = (...values) => {
    if (values.some((value) => /workers\.dev/i.test(String(value || "")))) {
        // Never include the matching output. It contains the Cloudflare
        // account subdomain and may expose a public version Preview URL.
        throw new Error(
            "Wrangler emitted unexpected workers.dev or Worker Preview URL output"
        );
    }
};

const parseWranglerOutputEntries = (output) => {
    const entries = [];
    for (const line of output.split(/\r?\n/)) {
        if (line.trim() === "") continue;
        try {
            const entry = JSON.parse(line);
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                throw new Error("invalid record");
            }
            entries.push(entry);
        } catch {
            throw new Error("Wrangler deployment output is not valid NDJSON");
        }
    }
    return entries;
};

export const parseWranglerVersionUploadOutput = (
    output,
    expectedWorkerName
) => {
    assertNoWorkersDevOutput(output);
    const entries = parseWranglerOutputEntries(output);
    const uploads = entries.filter(({ type }) => type === "version-upload");
    if (uploads.length !== 1) {
        throw new Error(
            `${expectedWorkerName}: Wrangler output requires exactly one version-upload record`
        );
    }
    const upload = uploads[0];
    if (upload.version !== 1 || upload.worker_name_overridden !== false) {
        throw new Error(
            `${expectedWorkerName}: Wrangler version-upload record has unsupported identity metadata`
        );
    }
    return validateDeploymentEvidence(
        {
            workerName: upload.worker_name,
            workerTag: upload.worker_tag,
            versionId: upload.version_id,
        },
        expectedWorkerName
    );
};

export const parseWranglerInitialDeployOutput = (
    output,
    expectedWorkerName
) => {
    assertNoWorkersDevOutput(output);
    const entries = parseWranglerOutputEntries(output);
    const deployments = entries.filter(({ type }) => type === "deploy");
    if (deployments.length !== 1) {
        throw new Error(
            `${expectedWorkerName}: Wrangler output requires exactly one deploy record`
        );
    }
    const deployment = deployments[0];
    if (
        deployment.version !== 1 ||
        deployment.worker_name_overridden !== false ||
        !Array.isArray(deployment.targets) ||
        deployment.targets.length !== 0
    ) {
        throw new Error(
            `${expectedWorkerName}: Wrangler deploy record has unsupported identity or target metadata`
        );
    }
    return validateDeploymentEvidence(
        {
            workerName: deployment.worker_name,
            workerTag: deployment.worker_tag,
            versionId: deployment.version_id,
        },
        expectedWorkerName
    );
};

export const createInvocationVersionTag = ({
    siteId,
    expectedCommit,
    nonce = randomUUID(),
}) => {
    const tag = `peerbit_${siteId}_${expectedCommit.slice(0, 12)}_${nonce}`;
    if (!VERSION_TAG.test(tag)) {
        throw new Error(
            `${siteId}: could not create a safe Worker version tag`
        );
    }
    return tag;
};

export const readWorkerScriptMap = async (
    operations,
    { allowMissingInlineRoutes = false } = {}
) => {
    const scripts = await operations.listWorkerScripts();
    if (
        !(scripts instanceof Map) ||
        [...scripts].some(
            ([scriptName, metadata]) =>
                typeof scriptName !== "string" ||
                scriptName.length === 0 ||
                !metadata ||
                typeof metadata !== "object" ||
                (metadata.tag != null &&
                    (typeof metadata.tag !== "string" ||
                        metadata.tag.length === 0)) ||
                (!Array.isArray(metadata.routes) &&
                    !(allowMissingInlineRoutes && metadata.routes === null)) ||
                (Array.isArray(metadata.routes) &&
                    metadata.routes.some(
                        (route) =>
                            !route ||
                            typeof route !== "object" ||
                            typeof route.id !== "string" ||
                            route.id.length === 0 ||
                            typeof route.pattern !== "string" ||
                            route.pattern.length === 0 ||
                            route.script !== scriptName
                    ))
        )
    ) {
        throw new Error(
            "Cloudflare Worker list operation returned an invalid script map"
        );
    }
    return scripts;
};

export const requireExpectedAccountZoneInventorySha256 = (value) => {
    if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
        throw new Error(
            "CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256 must be an exact lowercase SHA-256 digest"
        );
    }
    return value;
};

export const accountZoneInventorySha256 = (inventory) => {
    if (!Array.isArray(inventory)) {
        throw new Error(
            "Cloudflare account zone identity inventory must be an array"
        );
    }
    const zoneIds = new Set();
    const zoneNames = new Set();
    const identities = inventory.map((zone) => {
        if (
            !zone ||
            typeof zone !== "object" ||
            Array.isArray(zone) ||
            typeof zone.zoneId !== "string" ||
            !CLOUDFLARE_ACCOUNT_ID.test(zone.zoneId || "") ||
            zone.zoneId !== zone.zoneId.toLowerCase() ||
            zoneIds.has(zone.zoneId) ||
            typeof zone.zoneName !== "string" ||
            zone.zoneName !== zone.zoneName.toLowerCase() ||
            zone.zoneName.trim() !== zone.zoneName ||
            !DNS_HOSTNAME.test(zone.zoneName) ||
            zoneNames.has(zone.zoneName)
        ) {
            throw new Error(
                "Cloudflare account zone identity inventory is invalid or ambiguous"
            );
        }
        zoneIds.add(zone.zoneId);
        zoneNames.add(zone.zoneName);
        return { zoneId: zone.zoneId, zoneName: zone.zoneName };
    });
    identities.sort(
        (left, right) =>
            compareCanonicalStrings(left.zoneId, right.zoneId) ||
            compareCanonicalStrings(left.zoneName, right.zoneName)
    );
    return createHash("sha256")
        .update(JSON.stringify(identities), "utf8")
        .digest("hex");
};

export const readAndValidateZoneRouteInventory = async ({
    scripts,
    operations,
    expectedZoneInventorySha256,
}) => {
    const expectedFingerprint = requireExpectedAccountZoneInventorySha256(
        expectedZoneInventorySha256
    );
    const inventory = await operations.listZoneRouteInventory();
    if (!Array.isArray(inventory)) {
        throw new Error(
            "Cloudflare authoritative zone and Worker route inventory is missing"
        );
    }
    const zoneIds = new Set();
    const zoneNames = new Set();
    const routeIds = new Set();
    const routePatterns = new Set();
    const authoritativeByScript = new Map();
    const normalizedZones = [];
    for (const zone of inventory) {
        if (
            !zone ||
            typeof zone !== "object" ||
            Array.isArray(zone) ||
            !CLOUDFLARE_ACCOUNT_ID.test(zone.zoneId || "") ||
            zone.zoneId !== zone.zoneId.toLowerCase() ||
            zoneIds.has(zone.zoneId) ||
            typeof zone.zoneName !== "string" ||
            zone.zoneName !== zone.zoneName.toLowerCase() ||
            zone.zoneName.trim() !== zone.zoneName ||
            !DNS_HOSTNAME.test(zone.zoneName) ||
            zoneNames.has(zone.zoneName) ||
            !ZONE_STATUSES.has(zone.status) ||
            (zone.type !== null && !ZONE_TYPES.has(zone.type)) ||
            !Array.isArray(zone.routes)
        ) {
            throw new Error(
                "Cloudflare authoritative zone inventory is invalid or ambiguous"
            );
        }
        zoneIds.add(zone.zoneId);
        zoneNames.add(zone.zoneName);
        const routes = [];
        for (const route of zone.routes) {
            if (
                !route ||
                typeof route !== "object" ||
                Array.isArray(route) ||
                !CLOUDFLARE_RESOURCE_ID.test(route.id || "") ||
                routeIds.has(route.id) ||
                typeof route.pattern !== "string" ||
                route.pattern.length === 0 ||
                route.pattern.trim() !== route.pattern ||
                routePatterns.has(route.pattern) ||
                (route.script !== null && !WORKER_NAME.test(route.script || ""))
            ) {
                throw new Error(
                    "Cloudflare authoritative Worker route inventory is invalid or ambiguous"
                );
            }
            if (route.script !== null && !scripts.has(route.script)) {
                throw new Error(
                    `Cloudflare authoritative Worker route references unknown script ${route.script}`
                );
            }
            routeIds.add(route.id);
            routePatterns.add(route.pattern);
            const normalized = {
                id: route.id,
                pattern: route.pattern,
                script: route.script,
            };
            routes.push(normalized);
            if (route.script !== null) {
                const attached = authoritativeByScript.get(route.script) ?? [];
                attached.push(normalized);
                authoritativeByScript.set(route.script, attached);
            }
        }
        normalizedZones.push({
            zoneId: zone.zoneId,
            zoneName: zone.zoneName,
            status: zone.status,
            type: zone.type,
            routes: routes.sort((left, right) =>
                left.id.localeCompare(right.id)
            ),
        });
    }

    for (const [workerName, metadata] of scripts) {
        const inlineRoutes = metadata.routes;
        if (inlineRoutes === null) continue;
        if (!Array.isArray(inlineRoutes)) {
            throw new Error(
                `${workerName}: inline Worker route inventory is invalid`
            );
        }
        const authoritative = [...(authoritativeByScript.get(workerName) ?? [])]
            .map(({ id, pattern, script }) => ({ id, pattern, script }))
            .sort((left, right) => left.id.localeCompare(right.id));
        const inline = [...inlineRoutes]
            .map(({ id, pattern, script }) => ({ id, pattern, script }))
            .sort((left, right) => left.id.localeCompare(right.id));
        if (JSON.stringify(inline) !== JSON.stringify(authoritative)) {
            throw new Error(
                `${workerName}: inline Worker routes do not exactly match the authoritative per-zone route inventory`
            );
        }
    }
    const normalizedInventory = normalizedZones.sort((left, right) =>
        left.zoneId.localeCompare(right.zoneId)
    );
    if (
        accountZoneInventorySha256(normalizedInventory) !== expectedFingerprint
    ) {
        throw new Error(
            "Cloudflare account zone identity inventory does not match the independently reviewed fingerprint"
        );
    }
    return normalizedInventory;
};

export const readWorkerDomainInventory = async (operations) => {
    const domains = await operations.listWorkerDomains();
    const ids = new Set();
    const hostnames = new Set();
    if (
        !Array.isArray(domains) ||
        domains.some((domain) => {
            const invalid =
                !domain ||
                typeof domain !== "object" ||
                typeof domain.id !== "string" ||
                domain.id.length === 0 ||
                ids.has(domain.id) ||
                typeof domain.hostname !== "string" ||
                domain.hostname.length === 0 ||
                domain.hostname !== domain.hostname.toLowerCase() ||
                !DNS_HOSTNAME.test(domain.hostname) ||
                hostnames.has(domain.hostname) ||
                typeof domain.service !== "string" ||
                domain.service.length === 0 ||
                typeof domain.environment !== "string" ||
                domain.environment.length === 0 ||
                typeof domain.zoneId !== "string" ||
                domain.zoneId.length === 0 ||
                typeof domain.zoneName !== "string" ||
                domain.zoneName.length === 0;
            if (!invalid) {
                ids.add(domain.id);
                hostnames.add(domain.hostname);
            }
            return invalid;
        })
    ) {
        throw new Error(
            "Cloudflare custom-domain list operation returned an invalid or ambiguous inventory"
        );
    }
    return domains;
};

const managedAppHostname = (hostname) =>
    hostname === APP_PRODUCTION_SUFFIX.slice(1) ||
    hostname.endsWith(APP_PRODUCTION_SUFFIX);

const routeTargetsManagedAppHostname = (pattern) => {
    const authority = pattern
        .trim()
        .toLowerCase()
        .replace(/^[a-z]+:\/\//, "")
        .split("/", 1)[0]
        .replace(/:\d+$/, "")
        .replace(/\.$/, "")
        .replace(/^\*+/, "");
    return managedAppHostname(authority);
};

export const validateProductionAttachmentInventory = ({
    plans,
    scripts,
    domains,
    zoneRouteInventory,
}) => {
    const expectedByHostname = new Map();
    const policyWorkerNames = new Set();
    const policySiteByWorker = new Map();
    for (const plan of plans) {
        policyWorkerNames.add(plan.workerName);
        policyWorkerNames.add(plan.policy.previewWorker);
        policySiteByWorker.set(plan.workerName, plan.site.id);
        policySiteByWorker.set(plan.policy.previewWorker, plan.site.id);
        for (const hostname of plan.policy.productionHostnames) {
            expectedByHostname.set(hostname, plan.workerName);
        }
    }
    const zonesById = new Map(
        zoneRouteInventory.map((zone) => [zone.zoneId, zone])
    );

    for (const plan of plans) {
        const metadata = scripts.get(plan.workerName);
        if (!metadata) {
            throw new Error(
                `${plan.site.id}: production Worker ${plan.workerName} disappeared during attachment validation`
            );
        }
        const expectedHostnames = plan.policy.productionHostnames;
        if (
            !Array.isArray(expectedHostnames) ||
            expectedHostnames.length === 0 ||
            expectedHostnames.some(
                (hostname) =>
                    typeof hostname !== "string" ||
                    hostname.length === 0 ||
                    hostname !== hostname.toLowerCase()
            ) ||
            new Set(expectedHostnames).size !== expectedHostnames.length
        ) {
            throw new Error(
                `${plan.site.id}: production custom-domain policy is invalid`
            );
        }

        const attachedToWorker = domains.filter(
            ({ service }) => service === plan.workerName
        );
        const actualHostnames = attachedToWorker
            .map(({ hostname }) => hostname)
            .sort();
        const expectedSorted = [...expectedHostnames].sort();
        if (
            attachedToWorker.some(
                ({ environment }) => environment !== "production"
            ) ||
            actualHostnames.length !== expectedSorted.length ||
            actualHostnames.some(
                (hostname, index) => hostname !== expectedSorted[index]
            )
        ) {
            throw new Error(
                `${plan.site.id}: ${plan.workerName} custom domains must exactly equal ${JSON.stringify(
                    expectedSorted
                )}; found ${JSON.stringify(actualHostnames)}`
            );
        }

        for (const hostname of expectedHostnames) {
            const attachment = domains.find(
                (domain) => domain.hostname === hostname
            );
            if (
                !attachment ||
                attachment.service !== plan.workerName ||
                attachment.environment !== "production"
            ) {
                throw new Error(
                    `${plan.site.id}: reviewed hostname ${hostname} is not attached to ${plan.workerName}'s production environment`
                );
            }
        }
    }

    for (const [workerName] of scripts) {
        const policyOwned = policyWorkerNames.has(workerName);
        const inManagedNamespace = workerName.startsWith(
            CLOUDFLARE_WORKER_NAMESPACE_PREFIX
        );
        if (inManagedNamespace && !policyOwned) {
            throw new Error(
                `Cloudflare has an unreviewed or retired Worker identity ${workerName} inside the ${CLOUDFLARE_WORKER_NAMESPACE_PREFIX} namespace`
            );
        }
    }

    for (const zone of zoneRouteInventory) {
        for (const route of zone.routes) {
            const policyOwned =
                route.script !== null && policyWorkerNames.has(route.script);
            const managedWorker =
                route.script !== null &&
                route.script.startsWith(CLOUDFLARE_WORKER_NAMESPACE_PREFIX);
            if (
                policyOwned ||
                managedWorker ||
                routeTargetsManagedAppHostname(route.pattern)
            ) {
                const policySite =
                    route.script === null
                        ? undefined
                        : policySiteByWorker.get(route.script);
                throw new Error(
                    `${policySite ? `${policySite}: ` : ""}${route.script ?? "scriptless route"} has unreviewed Worker route attachments in ${zone.zoneName}`
                );
            }
        }
    }

    for (const domain of domains) {
        const domainZone = zonesById.get(domain.zoneId);
        if (!domainZone || domainZone.zoneName !== domain.zoneName) {
            throw new Error(
                `Cloudflare custom domain ${domain.hostname} references a zone outside the authoritative account inventory`
            );
        }
        const expectedWorker = expectedByHostname.get(domain.hostname);
        const managedHostname = managedAppHostname(domain.hostname);
        const policyOwnedWorker = policyWorkerNames.has(domain.service);
        const managedWorker = domain.service.startsWith(
            CLOUDFLARE_WORKER_NAMESPACE_PREFIX
        );
        if (
            (managedHostname || policyOwnedWorker || managedWorker) &&
            (expectedWorker == null ||
                domain.service !== expectedWorker ||
                domain.environment !== "production")
        ) {
            throw new Error(
                `Cloudflare custom domain ${domain.hostname} is not exactly owned by the reviewed production Worker policy`
            );
        }
    }
};

export const readAndValidateWorkerSubdomains = async ({
    plans,
    scripts,
    operations,
}) => {
    const workerNames = new Set(plans.map(({ workerName }) => workerName));
    for (const { policy } of plans) {
        if (scripts.has(policy.previewWorker)) {
            workerNames.add(policy.previewWorker);
        }
    }
    for (const workerName of workerNames) {
        const state = await operations.getWorkerSubdomain(workerName);
        const keys =
            state && typeof state === "object" && !Array.isArray(state)
                ? Object.keys(state).sort()
                : [];
        if (
            keys.length !== 2 ||
            keys[0] !== "enabled" ||
            keys[1] !== "previewsEnabled" ||
            typeof state.enabled !== "boolean" ||
            typeof state.previewsEnabled !== "boolean"
        ) {
            throw new Error(
                `${workerName}: Worker subdomain operation returned invalid or ambiguous state`
            );
        }
        if (state.enabled || state.previewsEnabled) {
            throw new Error(
                `${workerName}: workers.dev and Worker Preview URLs must both be disabled`
            );
        }
    }
};

export const readAndValidateProductionAttachments = async ({
    plans,
    operations,
    scripts: providedScripts,
    expectedZoneInventorySha256,
    expectedZoneRouteInventory,
}) => {
    const scripts =
        providedScripts ??
        (await readWorkerScriptMap(operations, {
            allowMissingInlineRoutes: true,
        }));
    const zoneRouteInventory = await readAndValidateZoneRouteInventory({
        scripts,
        operations,
        expectedZoneInventorySha256,
    });
    if (
        expectedZoneRouteInventory !== undefined &&
        JSON.stringify(zoneRouteInventory) !==
            JSON.stringify(expectedZoneRouteInventory)
    ) {
        throw new Error(
            "Cloudflare authoritative account zone or Worker route inventory changed during production deployment"
        );
    }
    const domains = await readWorkerDomainInventory(operations);
    validateProductionAttachmentInventory({
        plans,
        scripts,
        domains,
        zoneRouteInventory,
    });
    await readAndValidateWorkerSubdomains({ plans, scripts, operations });
    return { scripts, zoneRouteInventory };
};

export const productionWorkerConfig = ({ site, policy, configs }) => {
    if (policy.id !== site.id) {
        throw new Error(
            `${site.id}: Cloudflare policy identity does not match site`
        );
    }
    if (
        typeof policy.productionWorker !== "string" ||
        policy.productionWorker.length === 0
    ) {
        throw new Error(`${site.id}: production Worker identity is missing`);
    }
    const rendered = configs.get(site.id);
    if (!rendered || rendered.config?.name !== policy.productionWorker) {
        throw new Error(
            `${site.id}: rendered production Worker must exactly equal ${policy.productionWorker}`
        );
    }
    return {
        file: rendered.file,
        renderedConfig: rendered.config,
        workerName: policy.productionWorker,
    };
};

const requireWorkerTag = ({ site, workerName, metadata }) => {
    if (typeof metadata?.tag !== "string" || metadata.tag.length === 0) {
        throw new Error(
            `${site.id}: Cloudflare did not provide immutable tag for ${workerName}`
        );
    }
    return metadata.tag;
};

const readRollbackBaseline = async ({
    site,
    policy,
    file,
    workerName,
    workerMetadata,
    operations,
}) => {
    const previousDeployment = await operations.status({
        configFile: file,
        site,
        policy,
        workerName,
    });
    const previousVersion = readSingleVersionDeployment(
        previousDeployment,
        site.id
    );
    const previousCommit = await operations.readReleaseCommit({
        site,
        policy,
    });
    if (policy.kind === "app" && !FULL_GIT_COMMIT.test(previousCommit || "")) {
        throw new Error(
            `${site.id}: production app requires a full rollback release commit`
        );
    }
    return {
        previousVersion,
        previousCommit,
        workerTag: requireWorkerTag({
            site,
            workerName,
            metadata: workerMetadata,
        }),
    };
};

const revalidateRollbackBaseline = async ({
    site,
    policy,
    file,
    workerName,
    baseline,
    operations,
}) => {
    const currentCommit = await operations.readReleaseCommit({ site, policy });
    if (policy.kind === "app" && !FULL_GIT_COMMIT.test(currentCommit || "")) {
        throw new Error(
            `${site.id}: production app requires a full rollback release commit`
        );
    }
    const scripts = await readWorkerScriptMap(operations, {
        allowMissingInlineRoutes: true,
    });
    const currentTag = requireWorkerTag({
        site,
        workerName,
        metadata: scripts.get(workerName),
    });
    const currentDeployment = await operations.status({
        configFile: file,
        site,
        policy,
        workerName,
    });
    const currentVersion = readSingleVersionDeployment(
        currentDeployment,
        site.id
    );
    if (
        currentVersion !== baseline.previousVersion ||
        currentCommit !== baseline.previousCommit ||
        currentTag !== baseline.workerTag
    ) {
        throw new Error(
            `${site.id}: rollback baseline changed after production preflight`
        );
    }
};

const deploymentDiagnostic = (error) =>
    redactCloudflareCredentials(error, deploymentEnvironment).slice(
        0,
        MAX_DIAGNOSTIC_LENGTH
    );

const manualRecoveryDiagnostic = ({ site, workerName, reason }) =>
    `${site.id}: automatic rollback refused: ${reason}; inspect ${workerName}'s active version, routes, custom domains, and public subdomain state in Cloudflare before retrying`;

const dispatchedRollbackDiagnostic = ({
    site,
    workerName,
    reason,
    appliedObserved,
}) =>
    `${site.id}: automatic rollback ${
        appliedObserved
            ? "was applied and observed, but final confirmation failed"
            : "was dispatched and may have been applied, but confirmation failed"
    }: ${reason}; inspect ${workerName}'s active version, routes, custom domains, and public subdomain state in Cloudflare before retrying`;

const validateUploadedVersionOwnership = ({ plan, version }) => {
    if (
        !version ||
        typeof version !== "object" ||
        version.id !== plan.invocation.versionId ||
        version.annotations?.["workers/tag"] !== plan.versionTag
    ) {
        throw new Error(
            `${plan.site.id}: Cloudflare did not return this invocation's exact tagged Worker version`
        );
    }
};

const readActiveVersion = async ({ plan, operations }) =>
    readSingleVersionDeployment(
        await operations.status({
            configFile: plan.file,
            site: plan.site,
            policy: plan.policy,
            workerName: plan.workerName,
        }),
        plan.site.id
    );

const readCurrentWorkerTag = async ({ plan, operations }) => {
    const scripts = await readWorkerScriptMap(operations, {
        allowMissingInlineRoutes: true,
    });
    return requireWorkerTag({
        site: plan.site,
        workerName: plan.workerName,
        metadata: scripts.get(plan.workerName),
    });
};

const readFencedActiveVersionLast = async ({
    plan,
    inventoryPlans,
    operations,
    expectedZoneInventorySha256,
    expectedZoneRouteInventory,
    expectedWorkerTag,
    phase,
}) => {
    await readAndValidateProductionAttachments({
        plans: inventoryPlans,
        operations,
        expectedZoneInventorySha256,
        expectedZoneRouteInventory,
    });
    const currentTag = await readCurrentWorkerTag({ plan, operations });
    if (currentTag !== expectedWorkerTag) {
        throw new Error(`${phase}: immutable Worker tag changed`);
    }
    // Keep the active deployment read last. Runtime verification can take
    // minutes, and an earlier observation cannot prove the final state.
    return readActiveVersion({ plan, operations });
};

const confirmInvocationActive = async ({ plan, operations }) => {
    const currentTag = await readCurrentWorkerTag({ plan, operations });
    if (
        currentTag !== plan.baseline.workerTag ||
        currentTag !== plan.invocation.workerTag
    ) {
        throw new Error(
            `${plan.site.id}: active Worker identity no longer matches this invocation`
        );
    }
    validateUploadedVersionOwnership({
        plan,
        version: await operations.getVersion({
            workerName: plan.workerName,
            versionId: plan.invocation.versionId,
            site: plan.site,
            policy: plan.policy,
        }),
    });
    const activeVersion = await readActiveVersion({ plan, operations });
    if (activeVersion !== plan.invocation.versionId) {
        throw new Error(
            `${plan.site.id}: active version ${activeVersion} does not match this invocation's version ${plan.invocation.versionId}`
        );
    }
};

const observeIndeterminateActivationSettlement = async ({
    plan,
    operations,
}) => {
    const wait =
        operations.waitForActivationSettlement ??
        ((delayMs) =>
            new Promise((resolve) => {
                setTimeout(resolve, delayMs);
            }));
    for (
        let observation = 1;
        observation <= INDETERMINATE_ACTIVATION_OBSERVATIONS;
        observation += 1
    ) {
        const currentTag = await readCurrentWorkerTag({ plan, operations });
        if (
            currentTag !== plan.baseline.workerTag ||
            currentTag !== plan.invocation.workerTag
        ) {
            throw new Error(
                "the immutable Worker tag changed during indeterminate activation settlement"
            );
        }
        const currentVersion = await readActiveVersion({ plan, operations });
        if (currentVersion !== plan.baseline.previousVersion) {
            return currentVersion;
        }
        if (observation < INDETERMINATE_ACTIVATION_OBSERVATIONS) {
            await wait(INDETERMINATE_ACTIVATION_DELAY_MS);
        }
    }
    return plan.baseline.previousVersion;
};

const rollbackExactInvocation = async ({
    plan,
    inventoryPlans,
    operations,
    expectedZoneInventorySha256,
    expectedZoneRouteInventory,
    log,
}) => {
    const { previousVersion, previousCommit, workerTag } = plan.baseline;
    plan.rollbackMutationState = "not-dispatched";
    if (workerTag !== plan.invocation.workerTag) {
        throw new Error(
            "the immutable Worker tag no longer matches the preflight and invocation identity"
        );
    }

    let currentVersion = await readFencedActiveVersionLast({
        plan,
        inventoryPlans,
        operations,
        expectedZoneInventorySha256,
        expectedZoneRouteInventory,
        expectedWorkerTag: workerTag,
        phase: "rollback authorization",
    });
    if (
        currentVersion === previousVersion &&
        plan.indeterminateActivation === true
    ) {
        currentVersion = await observeIndeterminateActivationSettlement({
            plan,
            operations,
        });
    }
    if (currentVersion === previousVersion) {
        await operations.verify({
            site: plan.site,
            policy: plan.policy,
            expectedCommit: previousCommit,
        });
        currentVersion = await readFencedActiveVersionLast({
            plan,
            inventoryPlans,
            operations,
            expectedZoneInventorySha256,
            expectedZoneRouteInventory,
            expectedWorkerTag: workerTag,
            phase: "post-verifier baseline confirmation",
        });
        if (currentVersion === previousVersion) {
            if (plan.indeterminateActivation === true) {
                throw new Error(
                    `activation remains indeterminate after the bounded settlement window; baseline ${previousVersion} was observed and verified, but the original deployment POST may still be applied later`
                );
            }
            return `${plan.site.id}: previous baseline ${previousVersion} remains active and verified; no rollback was necessary`;
        }
        if (plan.indeterminateActivation !== true) {
            throw new Error(
                `active version changed to ${currentVersion} during baseline verification`
            );
        }
    }
    if (currentVersion !== plan.invocation.versionId) {
        throw new Error(
            `active version ${currentVersion} differs from this invocation's version ${plan.invocation.versionId}; another deployment may have won`
        );
    }

    validateUploadedVersionOwnership({
        plan,
        version: await operations.getVersion({
            workerName: plan.workerName,
            versionId: plan.invocation.versionId,
            site: plan.site,
            policy: plan.policy,
        }),
    });

    // Repeat the entire public-attachment and Worker-identity fence before the
    // active-version read immediately preceding mutation. Cloudflare's
    // deployment endpoint has no compare-and-swap precondition.
    const confirmedVersion = await readFencedActiveVersionLast({
        plan,
        inventoryPlans,
        operations,
        expectedZoneInventorySha256,
        expectedZoneRouteInventory,
        expectedWorkerTag: workerTag,
        phase: "final rollback authorization",
    });
    if (confirmedVersion !== plan.invocation.versionId) {
        throw new Error(
            `active version changed to ${confirmedVersion} before rollback authorization`
        );
    }

    log(
        `${plan.site.id}: rolling back invocation ${plan.invocation.versionId} to ${previousVersion}`
    );
    plan.rollbackMutationState = "dispatched";
    let rollbackDeployment;
    try {
        rollbackDeployment = await operations.activate({
            workerName: plan.workerName,
            versionId: previousVersion,
            message: `peerbit-examples ${plan.site.id} automatic rollback to ${previousVersion}`,
            site: plan.site,
            policy: plan.policy,
        });
    } catch (rollbackError) {
        if (!isIndeterminateCloudflareMutationError(rollbackError)) {
            // Ordinary adapter errors are local validation failures that occur
            // before the deployment POST is dispatched.
            plan.rollbackMutationState = "not-dispatched";
        }
        throw rollbackError;
    }
    const rollbackVersion = readSingleVersionDeployment(
        rollbackDeployment,
        plan.site.id
    );
    if (rollbackVersion !== previousVersion) {
        throw new Error(
            `rollback API selected ${rollbackVersion}, expected ${previousVersion}`
        );
    }
    await readAndValidateProductionAttachments({
        plans: inventoryPlans,
        operations,
        expectedZoneInventorySha256,
        expectedZoneRouteInventory,
    });
    const restoredVersion = await readActiveVersion({ plan, operations });
    if (restoredVersion !== previousVersion) {
        throw new Error(
            `rollback dispatch was acknowledged but active-version confirmation observed ${restoredVersion}, expected ${previousVersion}`
        );
    }
    plan.rollbackMutationState = "applied-observed";
    const restoredTag = await readCurrentWorkerTag({ plan, operations });
    if (restoredTag !== workerTag) {
        throw new Error("Worker identity changed while rollback was running");
    }
    await operations.verify({
        site: plan.site,
        policy: plan.policy,
        expectedCommit: previousCommit,
    });
    const finalVersion = await readFencedActiveVersionLast({
        plan,
        inventoryPlans,
        operations,
        expectedZoneInventorySha256,
        expectedZoneRouteInventory,
        expectedWorkerTag: workerTag,
        phase: "post-verifier rollback confirmation",
    });
    if (finalVersion !== previousVersion) {
        throw new Error(
            `post-verifier rollback confirmation observed active version ${finalVersion}, expected exact baseline ${previousVersion}`
        );
    }
    plan.rollbackMutationState = "confirmed";
    log(`${plan.site.id}: previous version restored and verified`);
    return `${plan.site.id}: automatic rollback of this invocation to ${previousVersion} succeeded`;
};

export const deployProductionEntries = async ({
    selectedEntries,
    deploymentEntries,
    configs,
    expectedCommit,
    expectedZoneInventorySha256,
    operations,
    log = console.log,
}) => {
    if (!FULL_GIT_COMMIT.test(expectedCommit || "")) {
        throw new Error(
            "Production deployment requires a full Git commit hash"
        );
    }
    const pinnedZoneInventorySha256 = requireExpectedAccountZoneInventorySha256(
        expectedZoneInventorySha256
    );
    if (!Array.isArray(selectedEntries) || selectedEntries.length === 0) {
        throw new Error(
            "Production deployment requires a non-empty selected entry set"
        );
    }
    if (!Array.isArray(deploymentEntries) || deploymentEntries.length === 0) {
        throw new Error(
            "Production deployment requires explicit non-empty full-policy entries for account-wide attachment validation"
        );
    }
    if (
        deploymentEntries.some(
            (entry) =>
                !entry ||
                typeof entry !== "object" ||
                !entry.site ||
                typeof entry.site !== "object" ||
                typeof entry.site.id !== "string" ||
                entry.site.id.length === 0 ||
                !entry.policy ||
                typeof entry.policy !== "object"
        )
    ) {
        throw new Error(
            "Production deployment full-policy entries are malformed"
        );
    }
    const attachmentPlans = deploymentEntries.map(({ site, policy }) => ({
        site,
        policy,
        ...productionWorkerConfig({ site, policy, configs }),
    }));
    const attachmentPlansById = new Map(
        attachmentPlans.map((plan) => [plan.site.id, plan])
    );
    if (attachmentPlansById.size !== attachmentPlans.length) {
        throw new Error(
            "Production deployment full-policy entries contain duplicate site identities"
        );
    }
    const plans = selectedEntries.map(({ site, policy }) => {
        const plan = attachmentPlansById.get(site.id);
        if (
            !plan ||
            plan.policy.id !== policy.id ||
            plan.workerName !== policy.productionWorker
        ) {
            throw new Error(
                `${site.id}: selected deployment target is outside the full deployment policy`
            );
        }
        return plan;
    });
    const scripts = await readWorkerScriptMap(operations, {
        allowMissingInlineRoutes: true,
    });
    const missingPlans = attachmentPlans.filter(
        ({ workerName }) => !scripts.has(workerName)
    );
    if (missingPlans.length > 0) {
        const missing = missingPlans
            .map(({ site, workerName }) => `${site.id}: ${workerName}`)
            .join(", ");
        throw new Error(
            `Production deploys require pre-provisioned Workers; missing ${missing}. Provision these exact Worker names and their reviewed custom domains from cloudflare/deployment-policy.json in Cloudflare once, then rerun. No deployment was attempted`
        );
    }
    const { zoneRouteInventory: expectedZoneRouteInventory } =
        await readAndValidateProductionAttachments({
            plans: attachmentPlans,
            operations,
            scripts,
            expectedZoneInventorySha256: pinnedZoneInventorySha256,
        });

    const baselines = new Map();
    for (const plan of plans) {
        if (!scripts.has(plan.workerName)) continue;
        baselines.set(
            plan.site.id,
            await readRollbackBaseline({
                ...plan,
                workerMetadata: scripts.get(plan.workerName),
                operations,
            })
        );
    }

    for (const plan of plans) {
        plan.baseline = baselines.get(plan.site.id);
        plan.versionTag = createInvocationVersionTag({
            siteId: plan.site.id,
            expectedCommit,
        });
        const { previousVersion, previousCommit } = plan.baseline;
        log(
            `${plan.site.id}: rollback baseline ${previousVersion}${
                previousCommit ? ` at ${previousCommit}` : ""
            }`
        );
    }

    // Validate every baseline before creating even inactive versions. This
    // keeps multi-app planning fail-closed and avoids uploading to a Worker
    // that was replaced during the initial baseline reads.
    await readAndValidateProductionAttachments({
        plans: attachmentPlans,
        operations,
        expectedZoneInventorySha256: pinnedZoneInventorySha256,
        expectedZoneRouteInventory,
    });
    for (const plan of plans) {
        await revalidateRollbackBaseline({
            ...plan,
            operations,
        });
    }

    // Upload every selected version before changing any live deployment. If a
    // later upload or its ownership evidence fails, all production traffic is
    // still on the captured baselines.
    try {
        for (const plan of plans) {
            // Wrangler can alter workers.dev and Preview URL state as part of
            // an upload. Fence the full account policy immediately before
            // each individual version mutation, not only once per batch.
            await readAndValidateProductionAttachments({
                plans: attachmentPlans,
                operations,
                expectedZoneInventorySha256: pinnedZoneInventorySha256,
                expectedZoneRouteInventory,
            });
            plan.invocation = validateDeploymentEvidence(
                await operations.upload({
                    configFile: plan.file,
                    renderedConfig: plan.renderedConfig,
                    site: plan.site,
                    policy: plan.policy,
                    expectedCommit,
                    versionTag: plan.versionTag,
                }),
                plan.workerName
            );
            await readAndValidateProductionAttachments({
                plans: attachmentPlans,
                operations,
                expectedZoneInventorySha256: pinnedZoneInventorySha256,
                expectedZoneRouteInventory,
            });
            if (plan.invocation.workerTag !== plan.baseline.workerTag) {
                throw new Error(
                    `${plan.site.id}: uploaded version belongs to a replacement Worker identity`
                );
            }
            validateUploadedVersionOwnership({
                plan,
                version: await operations.getVersion({
                    workerName: plan.workerName,
                    versionId: plan.invocation.versionId,
                    site: plan.site,
                    policy: plan.policy,
                }),
            });
            log(
                `${plan.site.id}: uploaded inactive version ${plan.invocation.versionId} with tag ${plan.versionTag}`
            );
        }
    } catch (uploadError) {
        throw new Error(
            `Inactive Worker version upload phase failed: ${deploymentDiagnostic(
                uploadError
            )}. This workflow did not change live production traffic`
        );
    }

    // A deletion/recreation or external deployment during the upload phase
    // invalidates the transaction. Revalidate all apps before the first exact
    // version is promoted.
    try {
        await readAndValidateProductionAttachments({
            plans: attachmentPlans,
            operations,
            expectedZoneInventorySha256: pinnedZoneInventorySha256,
            expectedZoneRouteInventory,
        });
        for (const plan of plans) {
            await revalidateRollbackBaseline({ ...plan, operations });
        }
    } catch (baselineError) {
        throw new Error(
            `Production baseline changed after inactive uploads: ${deploymentDiagnostic(
                baselineError
            )}. No uploaded version was promoted`
        );
    }

    const activatedPlans = [];
    let currentPlan;
    let failurePlan;
    try {
        for (const plan of plans) {
            currentPlan = plan;
            failurePlan = plan;
            await readAndValidateProductionAttachments({
                plans: attachmentPlans,
                operations,
                expectedZoneInventorySha256: pinnedZoneInventorySha256,
                expectedZoneRouteInventory,
            });
            validateUploadedVersionOwnership({
                plan,
                version: await operations.getVersion({
                    workerName: plan.workerName,
                    versionId: plan.invocation.versionId,
                    site: plan.site,
                    policy: plan.policy,
                }),
            });
            await revalidateRollbackBaseline({ ...plan, operations });

            // The deployment remains potentially pending from dispatch until
            // an independent GET positively observes this invocation active.
            // A valid POST response alone is not sufficient because the
            // deployment read can temporarily remain on the baseline.
            plan.indeterminateActivation = true;
            let activated;
            try {
                activated = await operations.activate({
                    workerName: plan.workerName,
                    versionId: plan.invocation.versionId,
                    message: `peerbit-examples ${plan.site.id} ${expectedCommit}`,
                    site: plan.site,
                    policy: plan.policy,
                });
            } catch (activationError) {
                if (!isIndeterminateCloudflareMutationError(activationError)) {
                    // The API adapter reserves ordinary errors for local
                    // validation that failed before it dispatched the POST.
                    plan.indeterminateActivation = false;
                }
                throw activationError;
            }
            const activatedVersion = readSingleVersionDeployment(
                activated,
                plan.site.id
            );
            if (activatedVersion !== plan.invocation.versionId) {
                throw new Error(
                    `${plan.site.id}: activation API selected ${activatedVersion}, expected ${plan.invocation.versionId}`
                );
            }
            await confirmInvocationActive({ plan, operations });
            await readAndValidateProductionAttachments({
                plans: attachmentPlans,
                operations,
                expectedZoneInventorySha256: pinnedZoneInventorySha256,
                expectedZoneRouteInventory,
            });
            plan.indeterminateActivation = false;
            activatedPlans.push(plan);
            await operations.verify({
                site: plan.site,
                policy: plan.policy,
                expectedCommit,
            });
            log(
                `${plan.site.id}: promoted and verified ${plan.invocation.versionId}`
            );
        }

        // Runtime verification can take several minutes. Re-read every app's
        // immutable Worker identity, exact tagged version, active deployment,
        // and read-only attachment inventory before reporting transaction
        // success. A drifted app fails into the same reverse, ownership-scoped
        // unwind path as an ordinary verifier failure.
        for (const plan of activatedPlans) {
            failurePlan = plan;
            await readAndValidateProductionAttachments({
                plans: attachmentPlans,
                operations,
                expectedZoneInventorySha256: pinnedZoneInventorySha256,
                expectedZoneRouteInventory,
            });
            await confirmInvocationActive({ plan, operations });
        }
        return;
    } catch (deploymentError) {
        const messages = [
            `${failurePlan?.site.id ?? "production"}: production rollout failed: ${deploymentDiagnostic(
                deploymentError
            )}`,
        ];
        const rollbackCandidates = [
            ...(currentPlan ? [currentPlan] : []),
            ...activatedPlans.slice().reverse(),
        ];
        const seen = new Set();
        for (const plan of rollbackCandidates) {
            if (seen.has(plan.site.id)) continue;
            seen.add(plan.site.id);
            try {
                messages.push(
                    await rollbackExactInvocation({
                        plan,
                        inventoryPlans: attachmentPlans,
                        operations,
                        expectedZoneInventorySha256: pinnedZoneInventorySha256,
                        expectedZoneRouteInventory,
                        log,
                    })
                );
            } catch (rollbackError) {
                const reason = `this transaction's exact version and tag could not be safely unwound (${deploymentDiagnostic(
                    rollbackError
                )})`;
                if (
                    plan.rollbackMutationState === "dispatched" ||
                    plan.rollbackMutationState === "applied-observed"
                ) {
                    messages.push(
                        dispatchedRollbackDiagnostic({
                            site: plan.site,
                            workerName: plan.workerName,
                            reason,
                            appliedObserved:
                                plan.rollbackMutationState ===
                                "applied-observed",
                        })
                    );
                } else {
                    messages.push(
                        manualRecoveryDiagnostic({
                            site: plan.site,
                            workerName: plan.workerName,
                            reason,
                        })
                    );
                }
            }
        }
        throw new Error(messages.join("\n"));
    }
};

export const withoutCloudflareDeploymentCredentials = (environment) => {
    const sanitized = { ...environment };
    for (const name of Object.keys(sanitized)) {
        if (isCloudflareAuthenticationEnvironmentVariable(name)) {
            delete sanitized[name];
        }
    }
    return sanitized;
};

const deploymentEnvironment = process.env;
const verificationEnvironment = withoutCloudflareDeploymentCredentials(
    process.env
);

export const removeTemporaryWranglerOutput = (
    outputDirectory,
    environment = deploymentEnvironment,
    {
        remove = (directory) =>
            rmSync(directory, { recursive: true, force: true }),
        writeWarning = (value) => process.stderr.write(value),
    } = {}
) => {
    try {
        remove(outputDirectory);
    } catch (error) {
        try {
            writeWarning(
                `Warning: could not remove temporary Wrangler deployment output: ${redactCloudflareCredentials(
                    error,
                    environment
                )}\n`
            );
        } catch {
            // Temporary-file cleanup must never replace the deployment result,
            // even when the process output stream is unavailable.
        }
    }
};

export const runCloudflareCapturedJson = (
    command,
    args,
    environment = deploymentEnvironment,
    { run = spawnSync } = {}
) => {
    const result = run(command, args, {
        cwd: repoRoot,
        env: environment,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error) {
        throw new Error(redactCloudflareCredentials(result.error, environment));
    }
    if (result.status !== 0) {
        throw new Error(
            `${path.basename(command)} ${args.join(" ")} exited ${result.status}: ${redactCloudflareCredentials(
                String(result.stderr || "").trim(),
                environment
            )}`
        );
    }
    try {
        return JSON.parse(String(result.stdout || ""));
    } catch {
        // Never include stdout here. Wrangler may echo a credential in a
        // malformed response, and JSON parser errors otherwise tempt callers
        // to append the original payload to diagnostics.
        throw new Error(
            `${path.basename(command)} ${args.join(" ")} returned malformed JSON output`
        );
    }
};

export const runCloudflareLogged = (
    command,
    args,
    environment = deploymentEnvironment,
    {
        run = spawnSync,
        writeStdout = (value) => process.stdout.write(value),
        writeStderr = (value) => process.stderr.write(value),
    } = {}
) => {
    const result = run(command, args, {
        cwd: repoRoot,
        env: environment,
        encoding: "utf8",
        stdio: ["inherit", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024,
    });
    const hasWorkersDevOutput = /workers\.dev/i.test(
        `${String(result.stdout || "")}\n${String(result.stderr || "")}`
    );
    const stdout = redactCloudflareCredentials(
        result.stdout || "",
        environment
    );
    const stderr = redactCloudflareCredentials(
        result.stderr || "",
        environment
    );
    if (stdout) writeStdout(stdout);
    if (stderr) writeStderr(stderr);
    if (result.error) {
        throw new Error(redactCloudflareCredentials(result.error, environment));
    }
    if (result.status !== 0) {
        throw new Error(
            `${path.basename(command)} ${args.join(" ")} exited ${result.status}`
        );
    }
    return { stdout, stderr, hasWorkersDevOutput };
};

const runInherited = (command, args, env = deploymentEnvironment) => {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        env,
        stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(
            `${path.basename(command)} ${args.join(" ")} exited ${result.status}`
        );
    }
};

const resolveTemporaryConfigPath = ({ configFile, value, label, root }) => {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${label} must be a non-empty path`);
    }
    const resolved = path.resolve(path.dirname(configFile), value);
    const relative = path.relative(root, resolved);
    if (
        relative.length === 0 ||
        relative.startsWith("..") ||
        path.isAbsolute(relative)
    ) {
        throw new Error(`${label} must resolve inside the repository`);
    }
    return resolved;
};

export const createRouteFreeWranglerConfig = ({
    configFile,
    renderedConfig,
    workerName,
    artifact,
    root = repoRoot,
}) => {
    if (
        !renderedConfig ||
        typeof renderedConfig !== "object" ||
        Array.isArray(renderedConfig) ||
        renderedConfig.name !== workerName ||
        renderedConfig.workers_dev !== false ||
        renderedConfig.preview_urls !== false ||
        !Array.isArray(renderedConfig.routes) ||
        renderedConfig.routes.length === 0
    ) {
        throw new Error(
            `${workerName}: canonical production config is not valid for a route-free deployment`
        );
    }
    if ("route" in renderedConfig || "domains" in renderedConfig) {
        throw new Error(
            `${workerName}: canonical production config must not contain alternate route fields`
        );
    }
    if (
        renderedConfig.routes.some(
            (route) =>
                !route ||
                typeof route !== "object" ||
                typeof route.pattern !== "string" ||
                route.custom_domain !== true
        )
    ) {
        throw new Error(
            `${workerName}: canonical production routes must be reviewed custom domains`
        );
    }

    const privateConfig = structuredClone(renderedConfig);
    delete privateConfig.$schema;
    delete privateConfig.routes;
    if (artifact) {
        revalidateCloudflareArtifactManifest(artifact);
        validateCloudflareArtifactDeploymentConfig({
            artifact,
            renderedConfig,
        });
        if (
            artifact.workerName !== workerName ||
            artifact.siteId == null ||
            artifact.manifest?.deploymentConfig?.name !== workerName
        ) {
            throw new Error(
                `${workerName}: reviewed deployment artifact identity is invalid`
            );
        }
        privateConfig.main = artifact.moduleFile;
        privateConfig.no_bundle = true;
        privateConfig.find_additional_modules = false;
        privateConfig.vars = {
            ...(privateConfig.vars ?? {}),
            [CLOUDFLARE_ARTIFACT_DIGEST_BINDING]: artifact.digest,
        };
    } else if ("main" in privateConfig) {
        privateConfig.main = resolveTemporaryConfigPath({
            configFile,
            value: privateConfig.main,
            label: `${workerName}: main`,
            root,
        });
    }
    if (privateConfig.assets) {
        privateConfig.assets.directory = resolveTemporaryConfigPath({
            configFile,
            value: privateConfig.assets.directory,
            label: `${workerName}: assets.directory`,
            root,
        });
    }
    if (
        "routes" in privateConfig ||
        "route" in privateConfig ||
        "domains" in privateConfig
    ) {
        throw new Error(
            `${workerName}: private deployment config must omit all routes`
        );
    }
    return privateConfig;
};

const runWranglerRouteFreeMutation = ({
    wrangler,
    configFile,
    renderedConfig,
    site,
    expectedCommit,
    workerName,
    versionTag,
    artifact,
    command,
    parseOutput,
    temporaryDirectoryPrefix,
    environment = deploymentEnvironment,
    runtime = {},
}) => {
    if (!VERSION_TAG.test(versionTag || "")) {
        throw new Error(
            `${site.id}: Worker version tag is missing or malformed`
        );
    }
    const {
        makeTemporaryDirectory = mkdtempSync,
        writeTemporaryConfig = writeFileSync,
        runLogged = runCloudflareLogged,
        outputExists = existsSync,
        readOutput = readFileSync,
        removeTemporaryDirectory = (directory) =>
            rmSync(directory, { recursive: true, force: true }),
    } = runtime;
    const outputDirectory = makeTemporaryDirectory(
        path.join(tmpdir(), temporaryDirectoryPrefix)
    );
    const privateConfigFile = path.join(outputDirectory, "deploy.json");
    const outputFile = path.join(outputDirectory, "deploy.ndjson");
    try {
        if (artifact) revalidateCloudflareArtifactManifest(artifact);
        const privateConfig = createRouteFreeWranglerConfig({
            configFile,
            renderedConfig,
            workerName,
            artifact,
        });
        writeTemporaryConfig(
            privateConfigFile,
            `${JSON.stringify(privateConfig, null, 2)}\n`,
            {
                encoding: "utf8",
                mode: 0o600,
                flag: "wx",
            }
        );
        let commandError;
        try {
            const commandOutput = runLogged(
                wrangler,
                [
                    ...command,
                    "--config",
                    privateConfigFile,
                    "--strict",
                    ...(artifact ? ["--no-bundle"] : []),
                    "--tag",
                    versionTag,
                    "--message",
                    artifact
                        ? artifactBoundVersionMessage({
                              siteId: site.id,
                              expectedCommit,
                              artifactManifestDigest: artifact.digest,
                          })
                        : `peerbit-examples ${site.id} ${expectedCommit}`,
                ],
                {
                    ...environment,
                    WRANGLER_OUTPUT_FILE_PATH: outputFile,
                },
                {
                    // Capture rather than echo Wrangler's normal version URL.
                    // If public previews are unexpectedly enabled, the URL
                    // contains the account's workers.dev subdomain.
                    writeStdout: () => {},
                    writeStderr: () => {},
                }
            );
            assertNoWorkersDevOutput(
                commandOutput?.hasWorkersDevOutput ? "workers.dev" : "",
                commandOutput?.stdout,
                commandOutput?.stderr
            );
        } catch (error) {
            commandError = error;
        }

        let deploymentEvidence;
        try {
            deploymentEvidence = parseOutput(
                outputExists(outputFile) ? readOutput(outputFile, "utf8") : "",
                workerName
            );
            if (artifact) {
                deploymentEvidence.artifactManifestDigest = artifact.digest;
            }
        } catch (error) {
            if (!commandError) throw error;
        }
        if (commandError) {
            if (deploymentEvidence) {
                commandError.deploymentEvidence = deploymentEvidence;
            }
            throw commandError;
        }
        return deploymentEvidence;
    } finally {
        removeTemporaryWranglerOutput(outputDirectory, environment, {
            remove: removeTemporaryDirectory,
        });
    }
};

export const runWranglerVersionUpload = (input) =>
    runWranglerRouteFreeMutation({
        ...input,
        command: ["versions", "upload"],
        parseOutput: parseWranglerVersionUploadOutput,
        temporaryDirectoryPrefix: "peerbit-wrangler-version-upload-",
    });

export const runWranglerInitialDeploy = (input) =>
    runWranglerRouteFreeMutation({
        ...input,
        command: ["deploy"],
        parseOutput: parseWranglerInitialDeployOutput,
        temporaryDirectoryPrefix: "peerbit-wrangler-initial-deploy-",
    });

export const parseProductionDeploymentArgs = (argv) => {
    const args = new Map();
    if (argv.length % 2 !== 0) {
        throw new Error(PRODUCTION_DEPLOYMENT_USAGE);
    }
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (!key?.startsWith("--") || value == null) {
            throw new Error(PRODUCTION_DEPLOYMENT_USAGE);
        }
        const name = key.slice(2);
        if (!PRODUCTION_DEPLOYMENT_ARGUMENTS.has(name)) {
            throw new Error(
                `Unsupported production deployment argument: ${key}`
            );
        }
        if (args.has(name)) {
            throw new Error(`Duplicate production deployment argument: ${key}`);
        }
        args.set(name, value);
    }

    const target = args.get("target");
    const expectedCommit = args.get("commit");
    if (!target || !/^[a-z][a-z0-9-]*$/.test(target)) {
        throw new Error("Production deployment target is missing or malformed");
    }
    if (!FULL_GIT_COMMIT.test(expectedCommit || "")) {
        throw new Error(
            "Production deployment requires a full Git commit hash"
        );
    }
    return {
        target,
        expectedCommit,
    };
};

export const main = async (argv = process.argv.slice(2)) => {
    const { target, expectedCommit } = parseProductionDeploymentArgs(argv);
    const { entries } = loadCloudflareDeploymentData();
    const selectedEntries = selectCloudflareDeploymentEntries(entries, target);
    const configDirectory = path.join(repoRoot, ".wrangler-config");
    const configs = validateRenderedCloudflareConfigSet({
        directory: configDirectory,
        entries,
        mode: "production",
    });
    const wrangler = path.join(
        repoRoot,
        "tools/wrangler/node_modules/.bin/wrangler"
    );
    const verifier = path.join(repoRoot, "scripts/verify-cloudflare-sites.mjs");
    const runtimeSmokeNames = new Map([
        ["files", "file-share boots and connects to an authoritative relay"],
        ["stream", "streaming preview serves exact MP4 byte ranges"],
    ]);
    const runtimeSmokeEnv = productionSmokeEnvironment(entries);
    const workersApi = createCloudflareWorkersApi({
        accountId: deploymentEnvironment.CLOUDFLARE_ACCOUNT_ID,
        apiToken: deploymentEnvironment.CLOUDFLARE_API_TOKEN,
    });
    const operations = {
        listWorkerScripts: workersApi.listWorkerScripts,
        listZoneRouteInventory: workersApi.listZoneRouteInventory,
        listWorkerDomains: workersApi.listWorkerDomains,
        getWorkerSubdomain: workersApi.getWorkerSubdomain,
        status: ({ workerName }) => workersApi.getCurrentDeployment(workerName),
        getVersion: ({ workerName, versionId }) =>
            workersApi.getWorkerVersion(workerName, versionId),
        upload: ({
            configFile,
            renderedConfig,
            site,
            policy,
            expectedCommit: commit,
            versionTag,
        }) =>
            runWranglerVersionUpload({
                wrangler,
                configFile,
                renderedConfig,
                site,
                expectedCommit: commit,
                workerName: policy.productionWorker,
                versionTag,
            }),
        activate: ({ workerName, versionId, message }) =>
            workersApi.createDeployment({
                workerName,
                versionId,
                message,
            }),
        readReleaseCommit: readBaselineReleaseCommit,
        verify: ({ site, expectedCommit: commit }) => {
            runInherited(
                process.execPath,
                [
                    verifier,
                    "--mode",
                    "production",
                    "--site",
                    site.id,
                    ...(commit ? ["--commit", commit] : []),
                ],
                verificationEnvironment
            );
            const smokeName = runtimeSmokeNames.get(site.id);
            if (smokeName) {
                runInherited(
                    "pnpm",
                    [
                        "--dir",
                        "packages/file-share/frontend",
                        "exec",
                        "playwright",
                        "test",
                        "-c",
                        "playwright.config.ts",
                        "tests/cloudflare-preview.e2e.spec.ts",
                        "--project=chromium",
                        "--workers=1",
                        "--retries=1",
                        "--grep",
                        smokeName,
                    ],
                    {
                        ...verificationEnvironment,
                        PW_CLOUDFLARE_SMOKE: "1",
                        ...runtimeSmokeEnv,
                    }
                );
            }
        },
    };

    await deployProductionEntries({
        selectedEntries,
        deploymentEntries: entries,
        configs,
        expectedCommit,
        expectedZoneInventorySha256:
            deploymentEnvironment.CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256,
        operations,
    });
};

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
