import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    APP_PRODUCTION_SUFFIX,
    CLOUDFLARE_WORKER_NAMESPACE_PREFIX,
    loadCloudflareDeploymentData,
    repoRoot,
    validateRenderedCloudflareConfig,
    validateRenderedCloudflareConfigSet,
} from "./cloudflare-deployment-policy.mjs";
import {
    createCloudflareWorkersApi,
    redactCloudflareCredentials,
} from "./cloudflare-workers-api.mjs";
import {
    productionWorkerConfig,
    productionSmokeEnvironment,
    readAndValidateProductionAttachments,
    readSingleVersionDeployment,
    readWorkerDomainInventory,
    readWorkerScriptMap,
    runWranglerVersionUpload,
    withoutCloudflareDeploymentCredentials,
} from "./deploy-cloudflare-production.mjs";
import {
    CLOUDFLARE_ARTIFACT_DIGEST_BINDING,
    artifactBoundVersionMessage,
    loadCloudflareArtifactManifestSet,
    validateActiveWorkerModule,
} from "./cloudflare-artifact-manifest.mjs";

const FULL_GIT_COMMIT = /^[0-9a-f]{40}$/i;
const CLOUDFLARE_ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const VERSION_ID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_TAG = /^[A-Za-z0-9_-]{1,100}$/;
const INVOCATION_NONCE = /^[0-9a-f]{32}$/;
const STATE_DIGEST = /^[0-9a-f]{64}$/;
const WORKER_NAME = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MAX_DIAGNOSTIC_LENGTH = 2_000;
const RETIRED_LEGACY_WORKER = "peerbit-examples-legacy-stream-preview";

export const PROVISIONING_CONFIRMATION_PREFIXES = Object.freeze({
    plan: "plan-peerbit-production",
    apply: "provision-peerbit-production",
});

export const PROVISIONING_PLAN_STATE_SENTINEL = "0".repeat(64);

export const productionProvisioningConfirmation = ({
    mode,
    plannedCommit,
    plannedStateDigest,
}) => {
    if (mode !== "plan" && mode !== "apply") {
        throw new Error("Provisioning mode must be plan or apply");
    }
    if (!FULL_GIT_COMMIT.test(plannedCommit || "")) {
        throw new Error(
            "Provisioning requires an explicit full planned commit receipt"
        );
    }
    if (mode === "apply" && !STATE_DIGEST.test(plannedStateDigest || "")) {
        throw new Error(
            "Apply requires the exact SHA-256 state digest emitted by the reviewed plan"
        );
    }
    return `${PROVISIONING_CONFIRMATION_PREFIXES[mode]}-${plannedCommit.toLowerCase()}${
        mode === "apply" ? `-${plannedStateDigest.toLowerCase()}` : ""
    }`;
};

const REVIEWED_PROVISIONING_TARGETS = Object.freeze([
    [
        "stream",
        "peerbit-examples-stream",
        "stream.apps.peerbit.org",
        "peerbit-examples-stream-preview",
    ],
    [
        "music",
        "peerbit-examples-music",
        "music.apps.peerbit.org",
        "peerbit-examples-music-preview",
    ],
    [
        "chat",
        "peerbit-examples-chat",
        "chat.apps.peerbit.org",
        "peerbit-examples-chat-preview",
    ],
    [
        "ml",
        "peerbit-examples-ml",
        "ml.apps.peerbit.org",
        "peerbit-examples-ml-preview",
    ],
    [
        "text",
        "peerbit-examples-text",
        "text.apps.peerbit.org",
        "peerbit-examples-text-preview",
    ],
    [
        "files",
        "peerbit-examples-files",
        "files.apps.peerbit.org",
        "peerbit-examples-files-preview",
    ],
    [
        "chess",
        "peerbit-examples-chess",
        "chess.apps.peerbit.org",
        "peerbit-examples-chess-preview",
    ],
]);

const expectedVersionMessage = ({
    siteId,
    expectedCommit,
    artifactManifestDigest,
}) =>
    artifactBoundVersionMessage({
        siteId,
        expectedCommit,
        artifactManifestDigest,
    });

export const createProvisioningVersionTag = ({
    siteId,
    expectedCommit,
    invocationNonce,
}) => {
    if (!/^[a-z][a-z0-9-]*$/.test(siteId || "")) {
        throw new Error("Provisioning site identity is missing or malformed");
    }
    if (!FULL_GIT_COMMIT.test(expectedCommit || "")) {
        throw new Error("Provisioning requires a full Git commit hash");
    }
    if (!INVOCATION_NONCE.test(invocationNonce || "")) {
        throw new Error(
            `${siteId}: provisioning invocation nonce is missing or malformed`
        );
    }
    const tag = `peerbit_bootstrap_${siteId}_${expectedCommit
        .toLowerCase()
        .slice(0, 12)}_${invocationNonce}`;
    if (!VERSION_TAG.test(tag)) {
        throw new Error(`${siteId}: provisioning version tag is malformed`);
    }
    return tag;
};

const validateProvisioningEntries = (entries) => {
    if (!Array.isArray(entries)) {
        throw new Error("Production provisioning policy is missing");
    }
    const actual = entries.map(({ site, policy }) => [
        site?.id,
        policy?.productionWorker,
        Array.isArray(policy?.productionHostnames) &&
        policy.productionHostnames.length === 1
            ? policy.productionHostnames[0]
            : undefined,
        policy?.previewWorker,
    ]);
    if (
        JSON.stringify(actual) !== JSON.stringify(REVIEWED_PROVISIONING_TARGETS)
    ) {
        throw new Error(
            "Production provisioning targets no longer exactly match the reviewed seven-application allowlist"
        );
    }
    if (
        entries.some(
            ({ site, policy }) =>
                policy.kind !== "app" ||
                policy.id !== site.id ||
                site.worker !== policy.productionWorker ||
                !Array.isArray(site.domains) ||
                site.domains.length !== 1 ||
                site.domains[0] !== policy.productionHostnames[0]
        )
    ) {
        throw new Error(
            "Production provisioning requires seven exact app policy entries"
        );
    }
    const productionWorkers = new Set(
        entries.map(({ policy }) => policy.productionWorker)
    );
    const previewWorkers = entries.map(({ policy }) => policy.previewWorker);
    if (
        new Set(previewWorkers).size !== entries.length ||
        previewWorkers.some(
            (workerName) =>
                !WORKER_NAME.test(workerName || "") ||
                !workerName.startsWith(CLOUDFLARE_WORKER_NAMESPACE_PREFIX) ||
                productionWorkers.has(workerName)
        )
    ) {
        throw new Error(
            "Production provisioning requires seven unique reviewed preview Worker identities"
        );
    }
    return entries;
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

const validateProvisioningAttachmentInventory = ({
    entries,
    scripts,
    domains,
}) => {
    const expectedByHostname = new Map();
    const expectedProductionWorkers = new Set();
    const expectedPreviewWorkers = new Set();
    for (const { policy } of entries) {
        expectedProductionWorkers.add(policy.productionWorker);
        expectedPreviewWorkers.add(policy.previewWorker);
        expectedByHostname.set(
            policy.productionHostnames[0],
            policy.productionWorker
        );
    }
    const policyWorkers = new Set([
        ...expectedProductionWorkers,
        ...expectedPreviewWorkers,
    ]);

    for (const [workerName, metadata] of scripts) {
        const inManagedNamespace = workerName.startsWith(
            CLOUDFLARE_WORKER_NAMESPACE_PREFIX
        );
        if (inManagedNamespace && !policyWorkers.has(workerName)) {
            if (workerName === RETIRED_LEGACY_WORKER) {
                throw new Error(
                    `${RETIRED_LEGACY_WORKER} still exists; provisioning is blocked until the separate retired-Worker cleanup plan is reviewed and executed`
                );
            }
            throw new Error(
                `Cloudflare has an unreviewed Worker identity ${workerName} inside the managed namespace`
            );
        }
        const managedRoutes = metadata.routes.filter(({ pattern }) =>
            routeTargetsManagedAppHostname(pattern)
        );
        if (
            metadata.routes.length > 0 &&
            (inManagedNamespace ||
                policyWorkers.has(workerName) ||
                managedRoutes.length > 0)
        ) {
            throw new Error(
                `${workerName} has unreviewed traditional Worker route attachments`
            );
        }
        if (
            (metadata.tailConsumers?.length ?? 0) > 0 ||
            metadata.logpush === true
        ) {
            throw new Error(
                `${workerName} has unreviewed Tail Worker consumers or Logpush enabled`
            );
        }
        if (
            !Array.isArray(metadata.tailConsumers ?? []) ||
            typeof (metadata.logpush ?? false) !== "boolean"
        ) {
            throw new Error(
                `${workerName} has invalid or ambiguous non-versioned attachment metadata`
            );
        }
    }

    for (const domain of domains) {
        const expectedWorker = expectedByHostname.get(domain.hostname);
        const managedHostname = managedAppHostname(domain.hostname);
        const policyWorker = policyWorkers.has(domain.service);
        const managedWorker = domain.service.startsWith(
            CLOUDFLARE_WORKER_NAMESPACE_PREFIX
        );
        if (
            (managedHostname || policyWorker || managedWorker) &&
            (expectedWorker == null ||
                domain.service !== expectedWorker ||
                domain.environment !== "production")
        ) {
            throw new Error(
                `Cloudflare custom domain ${domain.hostname} is outside the exact provisioning policy`
            );
        }
        if (expectedWorker && !scripts.has(expectedWorker)) {
            throw new Error(
                `${domain.hostname} is attached to a production Worker that is absent from the Worker inventory`
            );
        }
    }

    for (const { site, policy } of entries) {
        const attached = domains.filter(
            ({ service }) => service === policy.productionWorker
        );
        if (
            attached.length > 1 ||
            attached.some(
                ({ hostname, environment }) =>
                    hostname !== policy.productionHostnames[0] ||
                    environment !== "production"
            )
        ) {
            throw new Error(
                `${site.id}: production Worker has custom domains outside its one reviewed hostname`
            );
        }
    }
};

const validateSubdomainState = (workerName, state) => {
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
            `${workerName}: Worker subdomain state is invalid or ambiguous`
        );
    }
    return state;
};

const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, canonicalize(value[key])])
        );
    }
    return value;
};

const sha256Canonical = (value) =>
    createHash("sha256")
        .update(JSON.stringify(canonicalize(value)))
        .digest("hex");

const sameCanonicalValue = (left, right) =>
    JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));

const isPlainObject = (value) => {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
};

const assertExactObjectKeys = (value, allowedKeys, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} is missing or malformed`);
    }
    const extra = Object.keys(value).filter((key) => !allowedKeys.has(key));
    if (extra.length > 0) {
        throw new Error(
            `${label} contains unreviewed fields ${extra.sort().join(", ")}`
        );
    }
};

const normalizeVersionLimits = ({ runtime, renderedConfig, siteId }) => {
    const hasLimits = Object.hasOwn(runtime, "limits");
    const expectsLimits = Object.hasOwn(renderedConfig, "limits");
    if (expectsLimits) {
        if (
            !isPlainObject(renderedConfig.limits) ||
            !hasLimits ||
            !isPlainObject(runtime.limits) ||
            !sameCanonicalValue(runtime.limits, renderedConfig.limits)
        ) {
            throw new Error(
                `${siteId}: exact Worker version limits do not match the reviewed config`
            );
        }
        return runtime.limits;
    }
    // Wrangler 4.110 and Cloudflare can serialize the default no-limits state
    // either by omitting the field or as an exact empty object. Normalize only
    // those two representations; any actual limit remains an unreviewed policy.
    if (
        hasLimits &&
        (!isPlainObject(runtime.limits) ||
            Reflect.ownKeys(runtime.limits).length !== 0)
    ) {
        throw new Error(
            `${siteId}: exact Worker version limits do not match the reviewed config`
        );
    }
    return {};
};

const validateVersionResources = ({
    version,
    renderedConfig,
    siteId,
    artifactManifestDigest,
}) => {
    const resources = version?.resources;
    const script = resources?.script;
    const runtime = resources?.script_runtime;
    const bindings = resources?.bindings;
    if (
        !resources ||
        typeof resources !== "object" ||
        Array.isArray(resources) ||
        !script ||
        typeof script !== "object" ||
        Array.isArray(script) ||
        typeof script.etag !== "string" ||
        script.etag.length === 0 ||
        script.etag.length > 512 ||
        !runtime ||
        typeof runtime !== "object" ||
        Array.isArray(runtime) ||
        !Array.isArray(bindings)
    ) {
        throw new Error(
            `${siteId}: exact Worker version resource evidence is missing or malformed`
        );
    }
    assertExactObjectKeys(
        resources,
        new Set(["bindings", "script", "script_runtime"]),
        `${siteId}: exact Worker version resources`
    );
    assertExactObjectKeys(
        script,
        new Set([
            "etag",
            "handlers",
            "last_deployed_from",
            "named_handlers",
            "placement",
            "placement_mode",
        ]),
        `${siteId}: exact Worker version script resource`
    );
    assertExactObjectKeys(
        runtime,
        new Set([
            "compatibility_date",
            "compatibility_flags",
            "limits",
            "migration_tag",
            "usage_model",
        ]),
        `${siteId}: exact Worker version runtime resource`
    );
    const handlers = script.handlers ?? [];
    const namedHandlers = script.named_handlers ?? [];
    if (
        !Array.isArray(handlers) ||
        new Set(handlers).size !== handlers.length ||
        handlers.some((handler) => handler !== "fetch") ||
        !handlers.includes("fetch") ||
        !Array.isArray(namedHandlers) ||
        namedHandlers.length !== 0
    ) {
        throw new Error(
            `${siteId}: exact Worker version event handlers do not match the reviewed config`
        );
    }

    if (
        renderedConfig.compatibility_date != null &&
        runtime.compatibility_date !== renderedConfig.compatibility_date
    ) {
        throw new Error(
            `${siteId}: exact Worker version has the wrong compatibility date`
        );
    }
    const expectedFlags = [
        ...(renderedConfig.compatibility_flags ?? []),
    ].sort();
    if (!Array.isArray(runtime.compatibility_flags ?? [])) {
        throw new Error(
            `${siteId}: exact Worker version has malformed compatibility flags`
        );
    }
    const actualFlags = [...(runtime.compatibility_flags ?? [])].sort();
    if (JSON.stringify(actualFlags) !== JSON.stringify(expectedFlags)) {
        throw new Error(
            `${siteId}: exact Worker version has the wrong compatibility flags`
        );
    }

    const normalizedLimits = normalizeVersionLimits({
        runtime,
        renderedConfig,
        siteId,
    });
    if (
        Object.hasOwn(renderedConfig, "migrations") ||
        Object.hasOwn(runtime, "migration_tag")
    ) {
        throw new Error(
            `${siteId}: Durable Object migrations are outside the reviewed static-app runtime contract`
        );
    }
    const actualPlacement =
        script.placement ??
        (script.placement_mode == null
            ? undefined
            : { mode: script.placement_mode });
    if (
        (script.placement != null && script.placement_mode != null) ||
        !sameCanonicalValue(actualPlacement, renderedConfig.placement)
    ) {
        throw new Error(
            `${siteId}: exact Worker version placement does not match the reviewed config`
        );
    }
    const expectedUsageModel = renderedConfig.usage_model;
    if (
        expectedUsageModel == null
            ? runtime.usage_model != null && runtime.usage_model !== "standard"
            : runtime.usage_model !== expectedUsageModel
    ) {
        throw new Error(
            `${siteId}: exact Worker version usage model does not match the reviewed config`
        );
    }

    const expectsCache = Object.hasOwn(renderedConfig, "cache");
    const hasCache = Object.hasOwn(version, "cache_options");
    if (
        expectsCache !== hasCache ||
        (hasCache &&
            !sameCanonicalValue(version.cache_options, renderedConfig.cache))
    ) {
        throw new Error(
            `${siteId}: exact Worker version cache options do not match the reviewed config`
        );
    }
    if (hasCache) {
        assertExactObjectKeys(
            version.cache_options,
            new Set(["enabled", "cross_version_cache"]),
            `${siteId}: exact Worker version cache options`
        );
        if (
            typeof version.cache_options.enabled !== "boolean" ||
            (version.cache_options.cross_version_cache != null &&
                typeof version.cache_options.cross_version_cache !== "boolean")
        ) {
            throw new Error(
                `${siteId}: exact Worker version cache options are malformed`
            );
        }
    }

    const expectedVars = new Map(
        Object.entries(renderedConfig.vars ?? {}).map(([name, value]) => [
            name,
            String(value),
        ])
    );
    expectedVars.set(
        CLOUDFLARE_ARTIFACT_DIGEST_BINDING,
        artifactManifestDigest
    );
    const seenBindings = new Set();
    const observedVars = new Map();
    const observedAssets = [];
    const expectedAssetsBinding = renderedConfig.assets?.binding;
    // The seven reviewed configs declare only plain-text vars and, for
    // Worker-first asset sites, the exact assets binding. Imported JS/Wasm
    // modules are script resources, not Wrangler binding declarations.
    const safeEmbeddedTypes = new Set(["assets", "plain_text"]);
    for (const binding of bindings) {
        if (
            !binding ||
            typeof binding !== "object" ||
            Array.isArray(binding) ||
            typeof binding.name !== "string" ||
            binding.name.length === 0 ||
            typeof binding.type !== "string" ||
            binding.type.length === 0 ||
            seenBindings.has(binding.name) ||
            !safeEmbeddedTypes.has(binding.type)
        ) {
            throw new Error(
                `${siteId}: exact Worker version contains an unreviewed service, queue, secret, storage, or duplicate binding`
            );
        }
        seenBindings.add(binding.name);
        if (binding.type === "assets") {
            observedAssets.push(binding.name);
        }
        if (binding.type === "plain_text") {
            if (typeof binding.text !== "string") {
                throw new Error(
                    `${siteId}: exact Worker version plain-text binding is malformed`
                );
            }
            observedVars.set(binding.name, binding.text);
        }
    }
    if (
        JSON.stringify(observedAssets.sort()) !==
        JSON.stringify(
            expectedAssetsBinding == null ? [] : [expectedAssetsBinding]
        )
    ) {
        throw new Error(
            `${siteId}: exact Worker version assets binding does not match the reviewed config`
        );
    }
    if (
        JSON.stringify([...observedVars].sort()) !==
        JSON.stringify([...expectedVars].sort())
    ) {
        throw new Error(
            `${siteId}: exact Worker version plain-text bindings do not match the reviewed config`
        );
    }
    return sha256Canonical({
        resources: {
            ...resources,
            script_runtime: {
                ...runtime,
                limits: normalizedLimits,
            },
        },
        cacheOptions: hasCache ? version.cache_options : null,
        // This receipt binds the reviewed assets behavior and byte inventory;
        // exhaustive live verification proves that contract after activation.
        artifactManifestDigest,
    });
};

const validateProvisioningVersion = ({
    version,
    versionId,
    versionTag,
    siteId,
    expectedCommit,
    renderedConfig,
    artifactManifestDigest,
}) => {
    if (
        !version ||
        typeof version !== "object" ||
        Array.isArray(version) ||
        version.id !== versionId ||
        version.annotations?.["workers/tag"] !== versionTag ||
        version.annotations?.["workers/message"] !==
            expectedVersionMessage({
                siteId,
                expectedCommit,
                artifactManifestDigest,
            })
    ) {
        throw new Error(
            `${siteId}: Worker version does not carry the exact provisioning release identity`
        );
    }
    return {
        version,
        fingerprint: validateVersionResources({
            version,
            renderedConfig,
            siteId,
            artifactManifestDigest,
        }),
    };
};

const readCurrentVersion = ({ deployments, siteId }) => {
    if (!Array.isArray(deployments)) {
        throw new Error(`${siteId}: Worker deployment inventory is malformed`);
    }
    if (deployments.length === 0) return undefined;
    if (
        !deployments[0] ||
        typeof deployments[0] !== "object" ||
        Array.isArray(deployments[0])
    ) {
        throw new Error(`${siteId}: active Worker deployment is malformed`);
    }
    return readSingleVersionDeployment(deployments[0], siteId);
};

const readActiveServiceAttachmentInventory = async ({
    entries,
    scripts,
    operations,
}) => {
    const policyWorkers = new Set(
        entries.flatMap(({ policy }) => [
            policy.productionWorker,
            policy.previewWorker,
        ])
    );
    const inventory = [];
    for (const workerName of [...scripts.keys()].sort()) {
        const activeVersionId = readCurrentVersion({
            deployments: await operations.getWorkerDeployments(workerName),
            siteId: workerName,
        });
        if (!activeVersionId) {
            inventory.push({ workerName, activeVersionId: null, services: [] });
            continue;
        }
        const version = await operations.getWorkerVersion(
            workerName,
            activeVersionId
        );
        const bindings = version?.resources?.bindings;
        if (!Array.isArray(bindings)) {
            throw new Error(
                `${workerName}: active version binding inventory is missing or ambiguous`
            );
        }
        const handlers = version.resources?.script?.handlers ?? [];
        const namedHandlers = version.resources?.script?.named_handlers ?? [];
        if (
            policyWorkers.has(workerName) &&
            (!Array.isArray(handlers) ||
                handlers.some((handler) => handler !== "fetch") ||
                !Array.isArray(namedHandlers) ||
                namedHandlers.length > 0)
        ) {
            throw new Error(
                `${workerName}: managed active version has an unreviewed queue, scheduled, email, tail, or other event handler`
            );
        }
        const services = [];
        for (const binding of bindings) {
            if (!binding || typeof binding !== "object") {
                throw new Error(
                    `${workerName}: active version binding inventory is malformed`
                );
            }
            if (
                policyWorkers.has(workerName) &&
                ["queue", "service", "service_binding"].includes(binding.type)
            ) {
                throw new Error(
                    `${workerName}: managed Worker has an unreviewed queue or service binding`
                );
            }
            if (["service", "service_binding"].includes(binding.type)) {
                const service = binding.service ?? binding.service_name;
                if (!WORKER_NAME.test(service || "")) {
                    throw new Error(
                        `${workerName}: active service binding target is malformed`
                    );
                }
                services.push(service);
                if (policyWorkers.has(service)) {
                    throw new Error(
                        `${workerName}: active service binding is an unreviewed inbound attachment to ${service}`
                    );
                }
            }
        }
        inventory.push({
            workerName,
            activeVersionId,
            services: services.sort(),
        });
    }
    return inventory;
};

const validateQueueConsumerInventory = ({ entries, inventory }) => {
    const policyWorkers = new Set(
        entries.flatMap(({ policy }) => [
            policy.productionWorker,
            policy.previewWorker,
        ])
    );
    const queueIds = new Set();
    const queueNames = new Set();
    if (!Array.isArray(inventory)) {
        throw new Error("Cloudflare Queue consumer inventory is missing");
    }
    const normalizedQueues = [];
    for (const queue of inventory) {
        if (
            !queue ||
            typeof queue !== "object" ||
            Array.isArray(queue) ||
            typeof queue.queueId !== "string" ||
            queue.queueId.length === 0 ||
            queueIds.has(queue.queueId) ||
            typeof queue.queueName !== "string" ||
            queue.queueName.length === 0 ||
            queueNames.has(queue.queueName) ||
            !Array.isArray(queue.consumers)
        ) {
            throw new Error(
                "Cloudflare Queue consumer inventory is invalid or ambiguous"
            );
        }
        queueIds.add(queue.queueId);
        queueNames.add(queue.queueName);
        const consumerIds = new Set();
        const normalizedConsumers = [];
        for (const consumer of queue.consumers) {
            if (
                !consumer ||
                typeof consumer !== "object" ||
                typeof consumer.consumerId !== "string" ||
                consumer.consumerId.length === 0 ||
                consumerIds.has(consumer.consumerId) ||
                !["worker", "http_pull"].includes(consumer.type) ||
                consumer.queueName !== queue.queueName ||
                (consumer.type === "worker" &&
                    !WORKER_NAME.test(consumer.scriptName || "")) ||
                (consumer.type === "http_pull" &&
                    consumer.scriptName !== null) ||
                typeof consumer.deadLetterQueue !== "string" ||
                !consumer.settings ||
                typeof consumer.settings !== "object" ||
                Array.isArray(consumer.settings)
            ) {
                throw new Error(
                    "Cloudflare Queue consumer inventory is invalid or ambiguous"
                );
            }
            consumerIds.add(consumer.consumerId);
            if (
                consumer.type === "worker" &&
                policyWorkers.has(consumer.scriptName)
            ) {
                throw new Error(
                    `${consumer.scriptName}: unreviewed Cloudflare Queue consumer attachment on ${queue.queueName}`
                );
            }
            normalizedConsumers.push({
                consumerId: consumer.consumerId,
                type: consumer.type,
                scriptName: consumer.scriptName,
                queueName: queue.queueName,
                deadLetterQueue: consumer.deadLetterQueue,
                settings: canonicalize(consumer.settings),
            });
        }
        normalizedQueues.push({
            queueId: queue.queueId,
            queueName: queue.queueName,
            consumers: normalizedConsumers.sort((left, right) =>
                left.consumerId.localeCompare(right.consumerId)
            ),
        });
    }
    return normalizedQueues.sort((left, right) =>
        left.queueId.localeCompare(right.queueId)
    );
};

export const inspectProductionProvisioning = async ({
    entries,
    configs,
    artifacts,
    expectedCommit,
    operations,
    invocationNonce,
    invocationCandidates = new Map(),
}) => {
    validateProvisioningEntries(entries);
    if (!FULL_GIT_COMMIT.test(expectedCommit || "")) {
        throw new Error("Provisioning requires a full Git commit hash");
    }
    if (!(configs instanceof Map) || configs.size !== entries.length) {
        throw new Error(
            "Provisioning requires every rendered production config"
        );
    }
    if (!(artifacts instanceof Map) || artifacts.size !== entries.length) {
        throw new Error(
            "Provisioning requires every pre-credential artifact manifest"
        );
    }
    if (invocationNonce != null && !INVOCATION_NONCE.test(invocationNonce)) {
        throw new Error("Provisioning invocation nonce is malformed");
    }
    if (!(invocationCandidates instanceof Map)) {
        throw new Error(
            "Provisioning invocation candidate ledger is malformed"
        );
    }
    const configPlans = entries.map(({ site, policy }) => {
        const artifact = artifacts.get(site.id);
        if (
            !artifact ||
            artifact.siteId !== site.id ||
            artifact.workerName !== policy.productionWorker ||
            artifact.commit !== expectedCommit.toLowerCase() ||
            !STATE_DIGEST.test(artifact.digest || "")
        ) {
            throw new Error(
                `${site.id}: pre-credential artifact manifest is missing or malformed`
            );
        }
        const plan = {
            site,
            policy,
            artifact,
            artifactManifestDigest: artifact.digest,
            ...productionWorkerConfig({ site, policy, configs }),
        };
        validateRenderedCloudflareConfig({
            config: plan.renderedConfig,
            policy,
            mode: "production",
        });
        if (typeof plan.file !== "string" || plan.file.length === 0) {
            throw new Error(`${site.id}: rendered config path is missing`);
        }
        return plan;
    });
    const scripts = await readWorkerScriptMap(operations);
    const domains = await readWorkerDomainInventory(operations);
    validateProvisioningAttachmentInventory({ entries, scripts, domains });
    const activeServiceAttachments = await readActiveServiceAttachmentInventory(
        {
            entries,
            scripts,
            operations,
        }
    );
    const queueConsumerInventory = validateQueueConsumerInventory({
        entries,
        inventory: await operations.listQueueConsumerInventory(),
    });

    const previewPlans = [];
    for (const { site, policy } of entries) {
        const metadata = scripts.get(policy.previewWorker);
        if (!metadata) {
            previewPlans.push({
                site,
                policy,
                workerName: policy.previewWorker,
                workerExists: false,
                workerTag: undefined,
                subdomainState: undefined,
                schedules: [],
                actions: [],
            });
            continue;
        }
        if (typeof metadata.tag !== "string" || metadata.tag.length === 0) {
            throw new Error(
                `${policy.previewWorker}: existing preview Worker has no immutable identity tag`
            );
        }
        const subdomainState = validateSubdomainState(
            policy.previewWorker,
            await operations.getWorkerSubdomain(policy.previewWorker)
        );
        const schedules = await operations.listWorkerSchedules(
            policy.previewWorker
        );
        if (!Array.isArray(schedules) || schedules.length > 0) {
            throw new Error(
                `${policy.previewWorker}: Cron Trigger schedules must be empty`
            );
        }
        previewPlans.push({
            site,
            policy,
            workerName: policy.previewWorker,
            workerExists: true,
            workerTag: metadata.tag,
            subdomainState,
            schedules,
            actions:
                subdomainState.enabled || subdomainState.previewsEnabled
                    ? ["disable-public-subdomains"]
                    : [],
        });
    }

    const plans = [];
    for (const configPlan of configPlans) {
        const { site, policy, workerName } = configPlan;
        const hostname = policy.productionHostnames[0];
        const domain = domains.find(
            ({ hostname: value }) => value === hostname
        );
        const metadata = scripts.get(workerName);
        const versionTag = invocationNonce
            ? createProvisioningVersionTag({
                  siteId: site.id,
                  expectedCommit,
                  invocationNonce,
              })
            : undefined;
        const invocationCandidate = invocationCandidates.get(site.id);
        if (!metadata) {
            if (invocationCandidate) {
                throw new Error(
                    `${site.id}: same-invocation upload evidence names a Worker absent from inventory`
                );
            }
            plans.push({
                ...configPlan,
                hostname,
                versionTag,
                workerExists: false,
                workerTag: undefined,
                subdomainState: undefined,
                schedules: [],
                deployableVersionIds: [],
                quarantinedVersionIds: [],
                activeVersionId: undefined,
                versionId: undefined,
                versionFingerprint: undefined,
                active: false,
                domainAttached: false,
                actions: [
                    "upload-fresh-route-free-version",
                    "disable-uploaded-public-subdomains",
                    "activate-exact-version-100-percent",
                    "attach-reviewed-custom-domain",
                    "verify-live-release",
                ],
            });
            continue;
        }
        if (typeof metadata.tag !== "string" || metadata.tag.length === 0) {
            throw new Error(
                `${site.id}: existing production Worker has no immutable identity tag`
            );
        }
        const subdomainState = validateSubdomainState(
            workerName,
            await operations.getWorkerSubdomain(workerName)
        );
        const deployments = await operations.getWorkerDeployments(workerName);
        const activeVersionId = readCurrentVersion({
            deployments,
            siteId: site.id,
        });
        const deployableVersionIds =
            await operations.listDeployableWorkerVersions(workerName);
        if (
            !Array.isArray(deployableVersionIds) ||
            new Set(deployableVersionIds).size !==
                deployableVersionIds.length ||
            deployableVersionIds.some(
                (versionId) => !VERSION_ID.test(versionId || "")
            ) ||
            (activeVersionId && !deployableVersionIds.includes(activeVersionId))
        ) {
            throw new Error(
                `${site.id}: deployable Worker version inventory is invalid or incomplete`
            );
        }
        if (domain && !activeVersionId) {
            throw new Error(
                `${site.id}: reviewed custom domain is attached before an exact active baseline exists`
            );
        }
        const schedules = await operations.listWorkerSchedules(workerName);
        if (!Array.isArray(schedules) || schedules.length > 0) {
            throw new Error(
                `${workerName}: Cron Trigger schedules must be empty`
            );
        }
        let versionId;
        let versionFingerprint;
        if (invocationCandidate) {
            if (
                invocationCandidate.workerName !== workerName ||
                invocationCandidate.workerTag !== metadata.tag ||
                invocationCandidate.versionTag !== versionTag ||
                invocationCandidate.artifactManifestDigest !==
                    configPlan.artifactManifestDigest ||
                !VERSION_ID.test(invocationCandidate.versionId || "") ||
                !deployableVersionIds.includes(invocationCandidate.versionId)
            ) {
                throw new Error(
                    `${site.id}: same-invocation Wrangler upload evidence does not match the exact Worker inventory`
                );
            }
            versionId = invocationCandidate.versionId;
            const { fingerprint: runtimeFingerprint } =
                validateProvisioningVersion({
                    version: await operations.getWorkerVersion(
                        workerName,
                        versionId
                    ),
                    versionId,
                    versionTag,
                    siteId: site.id,
                    expectedCommit,
                    renderedConfig: configPlan.renderedConfig,
                    artifactManifestDigest: configPlan.artifactManifestDigest,
                });
            const observedModule = await operations.getWorkerVersionModule(
                workerName,
                versionId
            );
            validateActiveWorkerModule({
                artifact: configPlan.artifact,
                observed: observedModule,
            });
            versionFingerprint = sha256Canonical({
                runtimeFingerprint,
                module: observedModule,
            });
            if (
                invocationCandidate.versionFingerprint != null &&
                invocationCandidate.versionFingerprint !== versionFingerprint
            ) {
                throw new Error(
                    `${site.id}: exact uploaded Worker version resource fingerprint changed`
                );
            }
        }
        const actions = [];
        if (subdomainState.enabled || subdomainState.previewsEnabled) {
            actions.push("disable-existing-public-subdomains");
        }
        if (!invocationCandidate) {
            actions.push(
                "upload-fresh-route-free-version",
                "disable-uploaded-public-subdomains"
            );
        }
        if (activeVersionId !== versionId)
            actions.push("activate-exact-version-100-percent");
        if (!domain) actions.push("attach-reviewed-custom-domain");
        actions.push("verify-live-release");
        plans.push({
            ...configPlan,
            hostname,
            versionTag,
            workerExists: true,
            workerTag: metadata.tag,
            subdomainState,
            schedules,
            deployableVersionIds,
            quarantinedVersionIds: deployableVersionIds.filter(
                (candidateId) =>
                    candidateId !== activeVersionId && candidateId !== versionId
            ),
            activeVersionId,
            versionId,
            versionFingerprint,
            active: versionId != null && activeVersionId === versionId,
            domainAttached: Boolean(domain),
            actions,
        });
    }
    return {
        plans,
        previewPlans,
        scripts,
        domains,
        activeServiceAttachments,
        queueConsumerInventory,
    };
};

const nullable = (value) => value ?? null;

export const productionProvisioningStateDigest = ({
    inspection,
    expectedCommit,
    accountId,
}) => {
    if (!FULL_GIT_COMMIT.test(expectedCommit || "")) {
        throw new Error("Provisioning state digest requires a full Git commit");
    }
    if (!CLOUDFLARE_ACCOUNT_ID.test(accountId || "")) {
        throw new Error(
            "Provisioning state digest requires an exact Cloudflare account ID"
        );
    }
    const state = {
        schema: 2,
        expectedCommit: expectedCommit.toLowerCase(),
        accountId: accountId.toLowerCase(),
        scripts: [...inspection.scripts]
            .map(([workerName, metadata]) => ({
                workerName,
                workerTag: nullable(metadata.tag),
                routes: [...metadata.routes].sort((left, right) =>
                    left.id.localeCompare(right.id)
                ),
                tailConsumers: metadata.tailConsumers ?? [],
                logpush: metadata.logpush ?? false,
            }))
            .sort((left, right) =>
                left.workerName.localeCompare(right.workerName)
            ),
        domains: [...inspection.domains].sort((left, right) =>
            left.id.localeCompare(right.id)
        ),
        activeServiceAttachments: inspection.activeServiceAttachments,
        queueConsumerInventory: inspection.queueConsumerInventory,
        production: inspection.plans.map((plan) => ({
            site: plan.site.id,
            workerName: plan.workerName,
            workerExists: plan.workerExists,
            workerTag: nullable(plan.workerTag),
            subdomainState: nullable(plan.subdomainState),
            schedules: plan.schedules,
            activeVersionId: nullable(plan.activeVersionId),
            deployableVersionIds: [...plan.deployableVersionIds].sort(),
            domainAttached: plan.domainAttached,
            hostname: plan.hostname,
            artifactManifestDigest: plan.artifactManifestDigest,
        })),
        preview: inspection.previewPlans.map((plan) => ({
            site: plan.site.id,
            workerName: plan.workerName,
            workerExists: plan.workerExists,
            workerTag: nullable(plan.workerTag),
            subdomainState: nullable(plan.subdomainState),
            schedules: plan.schedules,
        })),
    };
    return sha256Canonical(state);
};

const planSummary = (plans, previewPlans) => {
    const previewBySite = new Map(
        previewPlans.map((plan) => [plan.site.id, plan])
    );
    return plans.map(
        ({
            site,
            workerName,
            workerTag,
            hostname,
            actions,
            activeVersionId,
            deployableVersionIds,
            quarantinedVersionIds,
            domainAttached,
            artifactManifestDigest,
        }) => {
            const preview = previewBySite.get(site.id);
            if (!preview) {
                throw new Error(
                    `Missing preview provisioning plan for ${site.id}`
                );
            }
            return {
                site: site.id,
                worker: workerName,
                workerTag: workerTag ?? null,
                hostname,
                actions,
                activeVersionId: activeVersionId ?? null,
                deployableVersionIds,
                quarantinedVersionIds,
                domainAttached,
                artifactManifestDigest,
                previewWorker: preview.workerName,
                previewExists: preview.workerExists,
                previewActions: preview.actions,
            };
        }
    );
};

const diagnostic = (error, maxLength = MAX_DIAGNOSTIC_LENGTH) =>
    redactCloudflareCredentials(error, process.env).slice(0, maxLength);

const manualRecoveryError = ({ site, workerName, operation, error }) =>
    new Error(
        `${site.id}: ${operation} could not be proved by exact Cloudflare GET postconditions (${diagnostic(
            error
        )}); do not retry mutations blindly. Inspect ${workerName}'s versions, active deployment, routes, custom domain, and public subdomain state before rerunning the read-only plan`
    );

const failedUploadRecoveryError = ({
    site,
    workerName,
    uploadError,
    proofError,
    exactCleanupError,
    cleanupFenceError,
}) => {
    const details = [
        uploadError
            ? `upload response: ${diagnostic(uploadError, 750)}`
            : undefined,
        `post-upload proof: ${diagnostic(proofError, 750)}`,
        exactCleanupError
            ? `exact-name public-URL failure cleanup was not proved: ${diagnostic(
                  exactCleanupError,
                  750
              )}`
            : "exact-name public-URL failure cleanup was proved false/false by GET",
        cleanupFenceError
            ? `post-cleanup invocation fence was not proved: ${diagnostic(
                  cleanupFenceError,
                  750
              )}`
            : "post-cleanup invocation fence was proved",
    ].filter(Boolean);
    return new Error(
        `${site.id}: route-free version upload could not be proved safely (${details.join(
            "; "
        )}); do not retry mutations blindly. Inspect ${workerName}'s versions, active deployment, routes, custom domain, and public subdomain state before rerunning the read-only plan`
    );
};

const disableAndConfirm = async ({ plan, operations, log, force }) => {
    if (
        !force &&
        plan.subdomainState &&
        !plan.subdomainState.enabled &&
        !plan.subdomainState.previewsEnabled
    ) {
        return;
    }
    let mutationError;
    try {
        await operations.disableWorkerSubdomain(plan.workerName);
    } catch (error) {
        mutationError = error;
    }
    let state;
    try {
        state = validateSubdomainState(
            plan.workerName,
            await operations.getWorkerSubdomain(plan.workerName)
        );
    } catch (error) {
        throw manualRecoveryError({
            site: plan.site,
            workerName: plan.workerName,
            operation: "public-subdomain disable",
            error: mutationError ?? error,
        });
    }
    if (state.enabled || state.previewsEnabled) {
        throw manualRecoveryError({
            site: plan.site,
            workerName: plan.workerName,
            operation: "public-subdomain disable",
            error:
                mutationError ?? new Error("disabled state was not observed"),
        });
    }
    if (mutationError) {
        log(
            `${plan.site.id}: ambiguous public-subdomain response was resolved by an exact disabled-state GET`
        );
    }
};

const inspect = (context) => inspectProductionProvisioning(context);

const planFor = (inspection, siteId) => {
    const plan = inspection.plans.find(({ site }) => site.id === siteId);
    if (!plan) throw new Error(`Missing provisioning plan for ${siteId}`);
    return plan;
};

const previewPlanFor = (inspection, siteId) => {
    const plan = inspection.previewPlans.find(({ site }) => site.id === siteId);
    if (!plan)
        throw new Error(`Missing preview provisioning plan for ${siteId}`);
    return plan;
};

const assertSamePreviewInventory = (before, after, phase) => {
    for (const beforePlan of before.previewPlans) {
        const afterPlan = previewPlanFor(after, beforePlan.site.id);
        if (
            afterPlan.workerExists !== beforePlan.workerExists ||
            afterPlan.workerTag !== beforePlan.workerTag
        ) {
            throw new Error(
                `${beforePlan.workerName}: preview Worker identity changed ${phase}`
            );
        }
    }
};

const assertSameQueueConsumerInventory = (before, after, phase) => {
    if (
        JSON.stringify(after.queueConsumerInventory) !==
        JSON.stringify(before.queueConsumerInventory)
    ) {
        throw new Error(
            `Cloudflare Queue consumer attachment inventory changed ${phase}`
        );
    }
};

const productionLedgerState = (plan) => ({
    siteId: plan.site.id,
    workerName: plan.workerName,
    workerExists: plan.workerExists,
    workerTag: plan.workerTag,
    activeVersionId: plan.activeVersionId,
    deployableVersionIds: [...plan.deployableVersionIds],
    versionId: plan.versionId,
    versionFingerprint: plan.versionFingerprint,
    artifactManifestDigest: plan.artifactManifestDigest,
    active: plan.active,
    domainAttached: plan.domainAttached,
});

const createProductionLedger = (inspection) =>
    new Map(
        inspection.plans.map((plan) => [
            plan.site.id,
            productionLedgerState(plan),
        ])
    );

const productionLedgerFor = (ledger, siteId) => {
    const state = ledger.get(siteId);
    if (!state) {
        throw new Error(`Missing invocation production ledger for ${siteId}`);
    }
    return state;
};

const assertProductionLedger = (
    ledger,
    inspection,
    { skipSiteId, phase } = {}
) => {
    if (
        !(ledger instanceof Map) ||
        ledger.size !== inspection.plans.length ||
        new Set(inspection.plans.map(({ site }) => site.id)).size !==
            inspection.plans.length
    ) {
        throw new Error("Invocation production ledger is incomplete");
    }
    for (const plan of inspection.plans) {
        if (plan.site.id === skipSiteId) continue;
        const expected = productionLedgerFor(ledger, plan.site.id);
        const actual = productionLedgerState(plan);
        for (const field of [
            "workerName",
            "workerExists",
            "workerTag",
            "activeVersionId",
            "deployableVersionIds",
            "versionId",
            "versionFingerprint",
            "artifactManifestDigest",
            "active",
            "domainAttached",
        ]) {
            if (
                JSON.stringify(actual[field]) !==
                JSON.stringify(expected[field])
            ) {
                throw new Error(
                    `${plan.site.id}: invocation production ledger changed ${field}${phase ? ` ${phase}` : ""}`
                );
            }
        }
    }
};

const disabledPublicState = (state) =>
    state && !state.enabled && !state.previewsEnabled;

const assertAllManagedPublicUrlsDisabled = (
    inspection,
    phase,
    { allowProductionWorker } = {}
) => {
    for (const plan of inspection.previewPlans) {
        if (plan.workerExists && !disabledPublicState(plan.subdomainState)) {
            throw new Error(
                `${plan.workerName}: existing preview Worker must have workers.dev and Preview URLs disabled ${phase}`
            );
        }
    }
    for (const plan of inspection.plans) {
        if (
            plan.workerExists &&
            plan.workerName !== allowProductionWorker &&
            !disabledPublicState(plan.subdomainState)
        ) {
            throw new Error(
                `${plan.workerName}: existing production Worker must have workers.dev and Preview URLs disabled ${phase}`
            );
        }
    }
};

const validateUploadEvidence = ({ plan, evidence }) => {
    if (
        !evidence ||
        evidence.workerName !== plan.workerName ||
        evidence.workerTag !== plan.workerTag ||
        evidence.versionId !== plan.versionId ||
        evidence.artifactManifestDigest !== plan.artifactManifestDigest
    ) {
        throw new Error(
            `${plan.site.id}: Wrangler upload evidence does not match the exact GET-confirmed Worker identity and version`
        );
    }
};

const confirmActiveWorkerModule = async ({
    site,
    policy,
    versionId,
    artifact,
    operations,
}) => {
    try {
        const observed = await operations.getWorkerVersionModule(
            policy.productionWorker,
            versionId
        );
        validateActiveWorkerModule({
            artifact,
            observed,
        });
        return observed;
    } catch (error) {
        throw manualRecoveryError({
            site,
            workerName: policy.productionWorker,
            operation: "exact active Worker version module-set proof",
            error,
        });
    }
};

const finalVerify = async ({
    entries,
    configs,
    artifacts,
    expectedCommit,
    operations,
    invocationCandidates,
}) => {
    const attachmentPlans = entries.map(({ site, policy }) => ({
        site,
        policy,
        ...productionWorkerConfig({ site, policy, configs }),
    }));
    const initialScripts = await readAndValidateProductionAttachments({
        plans: attachmentPlans,
        operations,
    });
    const identities = new Map();
    const versions = new Map();
    for (const { site, policy } of entries) {
        const metadata = initialScripts.get(policy.productionWorker);
        if (typeof metadata?.tag !== "string" || metadata.tag.length === 0) {
            throw new Error(`${site.id}: final Worker identity is missing`);
        }
        identities.set(site.id, metadata.tag);
        const deployments = await operations.getWorkerDeployments(
            policy.productionWorker
        );
        const versionId = readCurrentVersion({ deployments, siteId: site.id });
        if (!versionId) {
            throw new Error(`${site.id}: final active deployment is missing`);
        }
        const candidate = invocationCandidates.get(site.id);
        if (!candidate || candidate.versionId !== versionId) {
            throw new Error(
                `${site.id}: final active version was not created and proved by this apply invocation`
            );
        }
        const { renderedConfig } = productionWorkerConfig({
            site,
            policy,
            configs,
        });
        const { fingerprint: runtimeFingerprint } = validateProvisioningVersion(
            {
                version: await operations.getWorkerVersion(
                    policy.productionWorker,
                    versionId
                ),
                versionId,
                versionTag: candidate.versionTag,
                siteId: site.id,
                expectedCommit,
                renderedConfig,
                artifactManifestDigest: candidate.artifactManifestDigest,
            }
        );
        const observedModule = await confirmActiveWorkerModule({
            site,
            policy,
            versionId,
            artifact: artifacts.get(site.id),
            operations,
        });
        const fingerprint = sha256Canonical({
            runtimeFingerprint,
            module: observedModule,
        });
        if (fingerprint !== candidate.versionFingerprint) {
            throw new Error(
                `${site.id}: final Worker version resource fingerprint changed`
            );
        }
        versions.set(site.id, versionId);
    }

    for (const { site, policy } of entries) {
        try {
            await operations.verify({
                site,
                policy,
                expectedCommit,
                artifact: artifacts.get(site.id),
            });
        } catch (error) {
            throw manualRecoveryError({
                site,
                workerName: policy.productionWorker,
                operation:
                    "exhaustive live artifact verification after activation",
                error,
            });
        }
    }

    const finalScripts = await readAndValidateProductionAttachments({
        plans: attachmentPlans,
        operations,
    });
    for (const { site, policy } of entries) {
        if (
            finalScripts.get(policy.productionWorker)?.tag !==
            identities.get(site.id)
        ) {
            throw new Error(
                `${site.id}: immutable Worker identity changed during live verification`
            );
        }
        const deployments = await operations.getWorkerDeployments(
            policy.productionWorker
        );
        const versionId = readCurrentVersion({ deployments, siteId: site.id });
        if (versionId !== versions.get(site.id)) {
            throw new Error(
                `${site.id}: exact active version changed during live verification`
            );
        }
        const candidate = invocationCandidates.get(site.id);
        const { renderedConfig } = productionWorkerConfig({
            site,
            policy,
            configs,
        });
        const { fingerprint: runtimeFingerprint } = validateProvisioningVersion(
            {
                version: await operations.getWorkerVersion(
                    policy.productionWorker,
                    versionId
                ),
                versionId,
                versionTag: candidate.versionTag,
                siteId: site.id,
                expectedCommit,
                renderedConfig,
                artifactManifestDigest: candidate.artifactManifestDigest,
            }
        );
        const observedModule = await confirmActiveWorkerModule({
            site,
            policy,
            versionId,
            artifact: artifacts.get(site.id),
            operations,
        });
        if (
            sha256Canonical({
                runtimeFingerprint,
                module: observedModule,
            }) !== candidate.versionFingerprint
        ) {
            throw new Error(
                `${site.id}: exact active runtime or module changed during live verification`
            );
        }
    }
};

export const provisionProductionEntries = async ({
    entries,
    configs,
    artifacts,
    expectedCommit,
    accountId,
    mode,
    plannedStateDigest,
    operations,
    log = console.log,
}) => {
    if (mode !== "plan" && mode !== "apply") {
        throw new Error("Provisioning mode must be plan or apply");
    }
    if (!CLOUDFLARE_ACCOUNT_ID.test(accountId || "")) {
        throw new Error(
            "Provisioning requires the exact Cloudflare account identity"
        );
    }
    const invocationNonce =
        mode === "apply" ? randomBytes(16).toString("hex") : undefined;
    const invocationCandidates = new Map();
    const context = {
        entries,
        configs,
        artifacts,
        expectedCommit,
        operations,
        invocationNonce,
        invocationCandidates,
    };
    const initial = await inspect(context);
    const observedStateDigest = productionProvisioningStateDigest({
        inspection: initial,
        expectedCommit,
        accountId,
    });
    if (mode === "apply" && plannedStateDigest == null) {
        throw new Error(
            "Provisioning apply requires the exact state digest emitted by a reviewed plan"
        );
    }
    if (plannedStateDigest != null) {
        if (!STATE_DIGEST.test(plannedStateDigest)) {
            throw new Error(
                "Provisioning apply state receipt must be a lowercase SHA-256 digest"
            );
        }
        if (plannedStateDigest !== observedStateDigest) {
            throw new Error(
                `Cloudflare provisioning state changed after review (planned ${plannedStateDigest}, observed ${observedStateDigest}); run and review a new plan`
            );
        }
    }
    const summary = planSummary(initial.plans, initial.previewPlans);
    log(
        `${mode === "plan" ? "Read-only" : "Confirmed"} Cloudflare production provisioning plan for ${expectedCommit} with PLAN_STATE_SHA256=${observedStateDigest}: ${JSON.stringify(
            summary
        )}`
    );
    if (mode === "plan") {
        log("Read-only plan complete; no Cloudflare mutations were dispatched");
        Object.defineProperty(summary, "stateDigest", {
            value: observedStateDigest,
            enumerable: false,
        });
        return summary;
    }

    const productionLedger = createProductionLedger(initial);
    const assertPinnedInspection = (
        inspection,
        {
            phase,
            skipProductionSiteId,
            requirePublicFence = false,
            allowProductionWorker,
        } = {}
    ) => {
        assertProductionLedger(productionLedger, inspection, {
            skipSiteId: skipProductionSiteId,
            phase,
        });
        assertSamePreviewInventory(initial, inspection, phase);
        assertSameQueueConsumerInventory(initial, inspection, phase);
        if (requirePublicFence) {
            assertAllManagedPublicUrlsDisabled(inspection, phase, {
                allowProductionWorker,
            });
        }
        return inspection;
    };
    const readPinnedInspection = async (options) =>
        assertPinnedInspection(await inspect(context), options);
    const readFencedInspection = (phase) =>
        readPinnedInspection({ phase, requirePublicFence: true });

    const stopAfterFailedUploadProof = async ({
        before,
        uploadError,
        proofError,
    }) => {
        let exactCleanupError;
        try {
            // Even when the upload's Worker identity cannot be learned, the
            // exact reviewed Worker name is independently pinned. Disabling
            // its two public URL surfaces is privacy-reducing and must happen
            // before this failed invocation exits.
            await disableAndConfirm({
                plan: before,
                operations,
                log,
                force: true,
            });
        } catch (error) {
            exactCleanupError = error;
        }

        let cleanupFenceError;
        try {
            // Do not learn the failed upload's identity or version. Every
            // other production ledger entry and every preview identity stays
            // pinned, while the complete public-URL fence includes the
            // current exact Worker if it appeared.
            assertPinnedInspection(await inspect(context), {
                phase: "after failed route-free upload cleanup",
                skipProductionSiteId: before.site.id,
                requirePublicFence: true,
            });
        } catch (error) {
            cleanupFenceError = error;
        }

        throw failedUploadRecoveryError({
            site: before.site,
            workerName: before.workerName,
            uploadError,
            proofError,
            exactCleanupError,
            cleanupFenceError,
        });
    };

    const disableDuringPreflight = async ({ plan, selectAfter }) => {
        await disableAndConfirm({
            plan,
            operations,
            log,
            force: false,
        });
        try {
            const inspection = await readPinnedInspection({
                phase: "after a public-URL preflight mutation",
            });
            const after = selectAfter(inspection);
            if (
                !after.workerExists ||
                !disabledPublicState(after.subdomainState)
            ) {
                throw new Error(
                    `${plan.workerName}: exact disabled public-URL state was not retained`
                );
            }
        } catch (error) {
            throw manualRecoveryError({
                site: plan.site,
                workerName: plan.workerName,
                operation: "public-URL preflight",
                error,
            });
        }
    };

    // Inventory and immutable production state were pinned by the initial
    // inspection. Disable every existing preview and production public URL
    // before any upload, activation, or domain attachment. Missing Workers are
    // never created by this phase.
    for (const { site } of entries) {
        const inspection = await readPinnedInspection({
            phase: "before a preview public-URL preflight mutation",
        });
        const preview = previewPlanFor(inspection, site.id);
        if (
            !preview.workerExists ||
            disabledPublicState(preview.subdomainState)
        ) {
            continue;
        }
        await disableDuringPreflight({
            plan: preview,
            selectAfter: (after) => previewPlanFor(after, site.id),
        });
    }
    for (const { site } of entries) {
        const inspection = await readPinnedInspection({
            phase: "before a production public-URL preflight mutation",
        });
        const production = planFor(inspection, site.id);
        if (
            !production.workerExists ||
            disabledPublicState(production.subdomainState)
        ) {
            continue;
        }
        await disableDuringPreflight({
            plan: production,
            selectAfter: (after) => planFor(after, site.id),
        });
    }
    await readFencedInspection(
        "before the first production deployment mutation"
    );

    for (const { site } of entries) {
        const before = planFor(
            await readFencedInspection("before a route-free version upload"),
            site.id
        );
        if (!before.active && !before.versionId) {
            const pinnedBefore = productionLedgerFor(productionLedger, site.id);
            let uploadEvidence;
            let uploadError;
            try {
                uploadEvidence = await operations.upload({
                    configFile: before.file,
                    renderedConfig: before.renderedConfig,
                    site: before.site,
                    policy: before.policy,
                    expectedCommit,
                    versionTag: before.versionTag,
                    artifact: before.artifact,
                });
            } catch (error) {
                uploadError = error;
                uploadEvidence = error?.deploymentEvidence;
            }
            let afterUpload;
            let uploadProofError;
            try {
                if (
                    !uploadEvidence ||
                    uploadEvidence.workerName !== before.workerName ||
                    typeof uploadEvidence.workerTag !== "string" ||
                    uploadEvidence.workerTag.length === 0 ||
                    !VERSION_ID.test(uploadEvidence.versionId || "") ||
                    uploadEvidence.artifactManifestDigest !==
                        before.artifactManifestDigest ||
                    (before.workerExists &&
                        uploadEvidence.workerTag !== before.workerTag)
                ) {
                    throw new Error(
                        "same-invocation structured Wrangler upload evidence is missing or malformed"
                    );
                }
                invocationCandidates.set(site.id, {
                    ...uploadEvidence,
                    versionTag: before.versionTag,
                });
                const afterInspection = assertPinnedInspection(
                    await inspect(context),
                    {
                        phase: "after a route-free version upload",
                        skipProductionSiteId: site.id,
                        requirePublicFence: true,
                        // Wrangler can transiently expose only the Worker it
                        // just uploaded. It is disabled immediately below.
                        allowProductionWorker: before.workerName,
                    }
                );
                afterUpload = planFor(afterInspection, site.id);
                const expectedVersionIds = [
                    ...pinnedBefore.deployableVersionIds,
                    afterUpload.versionId,
                ].sort();
                if (
                    !afterUpload.workerExists ||
                    !afterUpload.versionId ||
                    afterUpload.active ||
                    afterUpload.activeVersionId !==
                        pinnedBefore.activeVersionId ||
                    pinnedBefore.deployableVersionIds.includes(
                        afterUpload.versionId
                    ) ||
                    JSON.stringify(
                        [...afterUpload.deployableVersionIds].sort()
                    ) !== JSON.stringify(expectedVersionIds) ||
                    afterUpload.domainAttached !==
                        pinnedBefore.domainAttached ||
                    (pinnedBefore.workerExists &&
                        afterUpload.workerTag !== pinnedBefore.workerTag) ||
                    (!pinnedBefore.workerExists &&
                        (typeof afterUpload.workerTag !== "string" ||
                            afterUpload.workerTag.length === 0))
                ) {
                    throw new Error(
                        "exact inactive uploaded Worker/version transition was not observed"
                    );
                }
                validateUploadEvidence({
                    plan: afterUpload,
                    evidence: uploadEvidence,
                });
                invocationCandidates.get(site.id).versionFingerprint =
                    afterUpload.versionFingerprint;
                Object.assign(
                    productionLedgerFor(productionLedger, site.id),
                    productionLedgerState(afterUpload)
                );
                assertProductionLedger(productionLedger, afterInspection, {
                    phase: "after learning the exact Wrangler-owned upload",
                });
            } catch (error) {
                uploadProofError = error;
            }
            if (uploadProofError) {
                invocationCandidates.delete(site.id);
                await stopAfterFailedUploadProof({
                    before,
                    uploadError,
                    proofError: uploadProofError,
                });
            }
            if (uploadError) {
                log(
                    `${site.id}: ambiguous upload response was resolved by matching Wrangler evidence and exact Worker/version/tag GETs`
                );
            }
            // This is the only allowed public-URL transient: the current
            // freshly uploaded Worker. No other mutation can occur before its
            // immediate disable and the restored invocation-wide fence.
            await disableAndConfirm({
                plan: afterUpload,
                operations,
                log,
                force: true,
            });
            try {
                await readFencedInspection(
                    "after the freshly uploaded Worker public-URL disable"
                );
            } catch (error) {
                throw manualRecoveryError({
                    site: before.site,
                    workerName: before.workerName,
                    operation: "post-upload public-URL disable",
                    error,
                });
            }
        }

        const ready = planFor(
            await readFencedInspection("before an exact 100% activation"),
            site.id
        );
        if (!ready.versionId) {
            throw new Error(
                `${site.id}: exact provisioning version is missing`
            );
        }
        if (!ready.active) {
            const pinnedBefore = productionLedgerFor(productionLedger, site.id);
            let activation;
            let activationError;
            try {
                activation = await operations.activate({
                    workerName: ready.workerName,
                    versionId: ready.versionId,
                    message: `peerbit-examples ${site.id} initial 100% production baseline ${expectedCommit}`,
                });
            } catch (error) {
                activationError = error;
            }
            if (activation) {
                const activatedVersion = readSingleVersionDeployment(
                    activation,
                    site.id
                );
                if (activatedVersion !== ready.versionId) {
                    activationError = new Error(
                        `activation selected ${activatedVersion}, expected ${ready.versionId}`
                    );
                }
            }
            let afterActivation;
            try {
                const afterInspection = assertPinnedInspection(
                    await inspect(context),
                    {
                        phase: "after an exact 100% activation",
                        skipProductionSiteId: site.id,
                        requirePublicFence: true,
                    }
                );
                afterActivation = planFor(afterInspection, site.id);
                if (
                    !afterActivation.workerExists ||
                    afterActivation.workerTag !== pinnedBefore.workerTag ||
                    afterActivation.versionId !== pinnedBefore.versionId ||
                    !afterActivation.active ||
                    afterActivation.domainAttached !==
                        pinnedBefore.domainAttached
                ) {
                    throw new Error("exact active version was not observed");
                }
                pinnedBefore.activeVersionId = pinnedBefore.versionId;
                pinnedBefore.active = true;
                assertProductionLedger(productionLedger, afterInspection, {
                    phase: "after recording the exact owned activation",
                });
            } catch (error) {
                throw manualRecoveryError({
                    site: ready.site,
                    workerName: ready.workerName,
                    operation: "exact 100% activation",
                    error,
                });
            }
            if (activationError) {
                log(
                    `${site.id}: ambiguous activation response was resolved by an exact 100% active-version GET`
                );
            }
            await confirmActiveWorkerModule({
                site: ready.site,
                policy: ready.policy,
                versionId: ready.versionId,
                artifact: ready.artifact,
                operations,
            });
            await readFencedInspection(
                "after the exact active Worker version module-set proof"
            );
        }
    }

    for (const { site } of entries) {
        const before = planFor(
            await readFencedInspection("before a custom-domain attachment"),
            site.id
        );
        if (!before.active) {
            throw new Error(
                `${site.id}: custom domain cannot be attached before an exact active baseline exists`
            );
        }
        if (before.domainAttached) continue;
        const pinnedBefore = productionLedgerFor(productionLedger, site.id);
        let attachment;
        let attachmentError;
        try {
            attachment = await operations.attachDomain({
                workerName: before.workerName,
                hostname: before.hostname,
            });
        } catch (error) {
            attachmentError = error;
        }
        if (
            attachment &&
            (attachment.hostname !== before.hostname ||
                attachment.service !== before.workerName ||
                attachment.environment !== "production")
        ) {
            attachmentError = new Error(
                "custom-domain mutation returned the wrong attachment"
            );
        }
        try {
            const afterInspection = assertPinnedInspection(
                await inspect(context),
                {
                    phase: "after a custom-domain attachment",
                    skipProductionSiteId: site.id,
                    requirePublicFence: true,
                }
            );
            const after = planFor(afterInspection, site.id);
            if (
                !after.workerExists ||
                after.workerTag !== pinnedBefore.workerTag ||
                after.versionId !== pinnedBefore.versionId ||
                after.active !== pinnedBefore.active ||
                !after.domainAttached
            ) {
                throw new Error("exact custom domain was not observed");
            }
            pinnedBefore.domainAttached = true;
            assertProductionLedger(productionLedger, afterInspection, {
                phase: "after recording the exact owned custom domain",
            });
        } catch (error) {
            throw manualRecoveryError({
                site: before.site,
                workerName: before.workerName,
                operation: "reviewed custom-domain attachment",
                error,
            });
        }
        if (attachmentError) {
            log(
                `${site.id}: ambiguous domain response was resolved by a stable exact custom-domain inventory GET`
            );
        }
    }

    await readFencedInspection("before final live verification");
    await finalVerify({
        entries,
        configs,
        artifacts,
        expectedCommit,
        operations,
        invocationCandidates,
    });
    const finalInspection = await readFencedInspection(
        "after final live verification"
    );
    log(
        `Provisioned and verified ${entries.length} exact Cloudflare production Workers at 100% for ${expectedCommit}`
    );
    return planSummary(finalInspection.plans, finalInspection.previewPlans);
};

export const parseProductionProvisioningArgs = (argv) => {
    const allowed = new Set([
        "mode",
        "commit",
        "planned-commit",
        "planned-state-digest",
        "confirm",
    ]);
    if (argv.length !== 10) {
        throw new Error(
            "Usage: provision-cloudflare-production.mjs --mode plan|apply --commit SHA --planned-commit SHA --planned-state-digest SHA256_OR_PLAN_SENTINEL --confirm STATE_BOUND_PHRASE"
        );
    }
    const args = new Map();
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (!key?.startsWith("--") || value == null) {
            throw new Error("Production provisioning arguments are malformed");
        }
        const name = key.slice(2);
        if (!allowed.has(name) || args.has(name)) {
            throw new Error(
                `Unsupported or duplicate provisioning argument ${key}`
            );
        }
        args.set(name, value);
    }
    const mode = args.get("mode");
    const expectedCommit = args.get("commit");
    const plannedCommit = args.get("planned-commit");
    const plannedStateDigest = args.get("planned-state-digest");
    const confirmation = args.get("confirm");
    if (mode !== "plan" && mode !== "apply") {
        throw new Error("Provisioning mode must be plan or apply");
    }
    if (!FULL_GIT_COMMIT.test(expectedCommit || "")) {
        throw new Error("Provisioning requires a full Git commit hash");
    }
    if (!FULL_GIT_COMMIT.test(plannedCommit || "")) {
        throw new Error(
            "Provisioning requires an explicit full planned commit receipt"
        );
    }
    const normalizedExpectedCommit = expectedCommit.toLowerCase();
    const normalizedPlannedCommit = plannedCommit.toLowerCase();
    if (normalizedPlannedCommit !== normalizedExpectedCommit) {
        throw new Error(
            "The explicit planned commit receipt must equal the checked-out commit"
        );
    }
    if (
        !STATE_DIGEST.test(plannedStateDigest || "") ||
        (mode === "plan" &&
            plannedStateDigest !== PROVISIONING_PLAN_STATE_SENTINEL) ||
        (mode === "apply" &&
            plannedStateDigest === PROVISIONING_PLAN_STATE_SENTINEL)
    ) {
        throw new Error(
            mode === "plan"
                ? `Plan requires the state-digest sentinel ${PROVISIONING_PLAN_STATE_SENTINEL}`
                : "Apply requires the nonzero SHA-256 state digest emitted by the reviewed plan"
        );
    }
    const requiredConfirmation = productionProvisioningConfirmation({
        mode,
        plannedCommit: normalizedPlannedCommit,
        plannedStateDigest,
    });
    if (confirmation !== requiredConfirmation) {
        throw new Error(
            `${mode} requires the exact SHA-bound confirmation phrase ${requiredConfirmation}`
        );
    }
    return {
        mode,
        expectedCommit: normalizedExpectedCommit,
        plannedCommit: normalizedPlannedCommit,
        plannedStateDigest,
    };
};

const runVerifier = ({ site, expectedCommit, artifact }) => {
    const verifier = path.join(repoRoot, "scripts/verify-cloudflare-sites.mjs");
    const result = spawnSync(
        process.execPath,
        [
            verifier,
            "--mode",
            "production",
            "--site",
            site.id,
            "--commit",
            expectedCommit,
            "--artifact-manifest-digest",
            artifact.digest,
        ],
        {
            cwd: repoRoot,
            env: withoutCloudflareDeploymentCredentials(process.env),
            stdio: "inherit",
        }
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(
            `${site.id}: production runtime verifier exited ${result.status}`
        );
    }
};

const runProductionBrowserSmoke = ({ site, runtimeSmokeEnvironment }) => {
    const smokeNames = new Map([
        ["files", "file-share boots and connects to an authoritative relay"],
        ["stream", "streaming preview serves exact MP4 byte ranges"],
    ]);
    const smokeName = smokeNames.get(site.id);
    if (!smokeName) return;
    const result = spawnSync(
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
            cwd: repoRoot,
            env: {
                ...withoutCloudflareDeploymentCredentials(process.env),
                PW_CLOUDFLARE_SMOKE: "1",
                ...runtimeSmokeEnvironment,
            },
            stdio: "inherit",
        }
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(
            `${site.id}: production browser smoke exited ${result.status}`
        );
    }
};

export const main = async (argv = process.argv.slice(2)) => {
    const { mode, expectedCommit, plannedStateDigest } =
        parseProductionProvisioningArgs(argv);
    const { entries } = loadCloudflareDeploymentData();
    validateProvisioningEntries(entries);
    const configs = validateRenderedCloudflareConfigSet({
        directory: path.join(repoRoot, ".wrangler-config"),
        entries,
        mode: "production",
    });
    const artifacts = loadCloudflareArtifactManifestSet({
        entries,
        configs,
        expectedCommit,
    });
    const workersApi = createCloudflareWorkersApi({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        apiToken: process.env.CLOUDFLARE_API_TOKEN,
    });
    const wrangler = path.join(
        repoRoot,
        "tools/wrangler/node_modules/.bin/wrangler"
    );
    const runtimeSmokeEnvironment = productionSmokeEnvironment(entries);
    const operations = {
        listWorkerScripts: workersApi.listWorkerScripts,
        listWorkerDomains: workersApi.listWorkerDomains,
        getWorkerSubdomain: workersApi.getWorkerSubdomain,
        listWorkerSchedules: workersApi.listWorkerSchedules,
        listQueueConsumerInventory: workersApi.listQueueConsumerInventory,
        getWorkerDeployments: workersApi.getWorkerDeployments,
        listDeployableWorkerVersions: workersApi.listDeployableWorkerVersions,
        getWorkerVersion: workersApi.getWorkerVersion,
        getWorkerVersionModule: workersApi.getWorkerVersionModule,
        disableWorkerSubdomain: workersApi.disableWorkerSubdomain,
        attachDomain: workersApi.attachWorkerDomain,
        activate: workersApi.createDeployment,
        upload: ({
            configFile,
            renderedConfig,
            site,
            policy,
            expectedCommit: commit,
            versionTag,
            artifact,
        }) =>
            runWranglerVersionUpload({
                wrangler,
                configFile,
                renderedConfig,
                site,
                expectedCommit: commit,
                workerName: policy.productionWorker,
                versionTag,
                artifact,
            }),
        verify: (input) => {
            runVerifier(input);
            runProductionBrowserSmoke({
                site: input.site,
                runtimeSmokeEnvironment,
            });
        },
    };
    await provisionProductionEntries({
        entries,
        configs,
        artifacts,
        expectedCommit,
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        mode,
        ...(mode === "apply" ? { plannedStateDigest } : {}),
        operations,
    });
};

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    main().catch((error) => {
        console.error(diagnostic(error));
        process.exitCode = 1;
    });
}
