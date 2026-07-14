import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

export const APP_PRODUCTION_SUFFIX = ".apps.peerbit.org";
export const APP_PRODUCTION_HOSTNAME_PATTERN =
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.apps\.peerbit\.org$/;

export const resolveCloudflareConfigOutputDirectory = ({
    output,
    root = repoRoot,
}) => {
    const outputDirectory = path.resolve(root, output ?? ".wrangler-config");
    const outputRelative = path.relative(root, outputDirectory);
    if (
        outputRelative.length === 0 ||
        outputRelative.startsWith("..") ||
        path.isAbsolute(outputRelative)
    ) {
        throw new Error(
            "Generated Wrangler configs must use a non-root directory inside the repository"
        );
    }
    return { outputDirectory, outputRelative };
};

export const loadCloudflareDeploymentData = ({
    manifestFile = path.join(repoRoot, "cloudflare/sites.json"),
    policyFile = path.join(repoRoot, "cloudflare/deployment-policy.json"),
} = {}) => {
    const manifest = readJson(manifestFile);
    const policy = readJson(policyFile);
    const entries = validateCloudflareDeploymentPolicy(manifest, policy);
    return { manifest, policy, entries };
};

const assertStringArrayEqual = (actual, expected, label) => {
    if (
        !Array.isArray(actual) ||
        actual.length !== expected.length ||
        actual.some((value, index) => value !== expected[index])
    ) {
        throw new Error(
            `${label} must exactly equal ${JSON.stringify(expected)}`
        );
    }
};

const assertHostname = (hostname, label) => {
    if (
        typeof hostname !== "string" ||
        hostname.length > 253 ||
        !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
            hostname
        )
    ) {
        throw new Error(`${label} is not an exact lowercase hostname`);
    }
};

export const validateCloudflareDeploymentPolicy = (manifest, policy) => {
    if (manifest?.schemaVersion !== 1) {
        throw new Error("cloudflare/sites.json schemaVersion must be 1");
    }
    if (policy?.schemaVersion !== 1 || !Array.isArray(policy.entries)) {
        throw new Error(
            "cloudflare/deployment-policy.json schemaVersion must be 1"
        );
    }
    if (
        !Array.isArray(manifest.staticSites) ||
        !Array.isArray(manifest.redirects)
    ) {
        throw new Error("Cloudflare site manifest entries must be arrays");
    }

    const manifestEntries = [
        ...manifest.staticSites.map((entry) => ({ ...entry, kind: "app" })),
        ...manifest.redirects.map((entry) => ({
            ...entry,
            kind: "redirect",
        })),
    ];
    const policies = new Map();
    const productionWorkers = new Set();
    const previewWorkers = new Set();
    const productionHostnames = new Set();
    for (const entry of policy.entries) {
        if (!/^[a-z0-9-]+$/.test(entry?.id || "")) {
            throw new Error(`Invalid deployment policy id ${entry?.id}`);
        }
        if (policies.has(entry.id)) {
            throw new Error(`Duplicate deployment policy id ${entry.id}`);
        }
        if (entry.kind !== "app" && entry.kind !== "redirect") {
            throw new Error(`${entry.id}: deployment kind is unsupported`);
        }
        if (!/^[a-z0-9-]{1,63}$/.test(entry.productionWorker || "")) {
            throw new Error(`${entry.id}: invalid production Worker`);
        }
        if (!/^[a-z0-9-]{1,63}$/.test(entry.previewWorker || "")) {
            throw new Error(`${entry.id}: invalid preview Worker`);
        }
        if (entry.productionWorker === entry.previewWorker) {
            throw new Error(
                `${entry.id}: preview and production Workers must differ`
            );
        }
        if (productionWorkers.has(entry.productionWorker)) {
            throw new Error(
                `${entry.id}: duplicate production Worker ${entry.productionWorker}`
            );
        }
        if (previewWorkers.has(entry.previewWorker)) {
            throw new Error(
                `${entry.id}: duplicate preview Worker ${entry.previewWorker}`
            );
        }
        if (
            productionWorkers.has(entry.previewWorker) ||
            previewWorkers.has(entry.productionWorker)
        ) {
            throw new Error(
                `${entry.id}: preview and production Worker allowlists overlap`
            );
        }
        if (
            !Array.isArray(entry.productionHostnames) ||
            entry.productionHostnames.length === 0
        ) {
            throw new Error(
                `${entry.id}: productionHostnames must not be empty`
            );
        }
        for (const hostname of entry.productionHostnames) {
            assertHostname(hostname, `${entry.id}: ${hostname}`);
            if (
                entry.kind === "app" &&
                !APP_PRODUCTION_HOSTNAME_PATTERN.test(hostname)
            ) {
                throw new Error(
                    `${entry.id}: app production hostname must use one label under *${APP_PRODUCTION_SUFFIX}`
                );
            }
            if (productionHostnames.has(hostname)) {
                throw new Error(
                    `${entry.id}: duplicate production hostname ${hostname}`
                );
            }
            productionHostnames.add(hostname);
        }
        policies.set(entry.id, entry);
        productionWorkers.add(entry.productionWorker);
        previewWorkers.add(entry.previewWorker);
    }

    if (manifestEntries.length !== policies.size) {
        throw new Error(
            "Deployment policy must contain exactly one entry for every site"
        );
    }

    const manifestIds = new Set();
    for (const entry of manifestEntries) {
        if (manifestIds.has(entry.id)) {
            throw new Error(`Duplicate site id ${entry.id}`);
        }
        manifestIds.add(entry.id);
        const allowed = policies.get(entry.id);
        if (!allowed) {
            throw new Error(`${entry.id}: missing exact deployment policy`);
        }
        if (allowed.kind !== entry.kind) {
            throw new Error(
                `${entry.id}: deployment kind must exactly equal ${entry.kind}`
            );
        }
        if (allowed.productionWorker !== entry.worker) {
            throw new Error(
                `${entry.id}: Worker must exactly equal ${allowed.productionWorker}`
            );
        }
        if (allowed.previewWorker !== `${entry.worker}-preview`) {
            throw new Error(
                `${entry.id}: preview Worker must exactly equal ${entry.worker}-preview`
            );
        }
        assertStringArrayEqual(
            entry.domains,
            allowed.productionHostnames,
            `${entry.id}: production hostnames`
        );
        if (entry.kind === "redirect") {
            let redirectUrl;
            try {
                redirectUrl = new URL(allowed.redirectLocation);
            } catch {
                throw new Error(`${entry.id}: redirect location is invalid`);
            }
            if (
                redirectUrl.protocol !== "https:" ||
                redirectUrl.username ||
                redirectUrl.password ||
                redirectUrl.port ||
                !productionHostnames.has(redirectUrl.hostname)
            ) {
                throw new Error(
                    `${entry.id}: redirect must use an allowlisted HTTPS production hostname`
                );
            }
            if (!APP_PRODUCTION_HOSTNAME_PATTERN.test(redirectUrl.hostname)) {
                throw new Error(
                    `${entry.id}: redirect target must use one label under *${APP_PRODUCTION_SUFFIX}`
                );
            }
            if (![301, 302, 303, 307, 308].includes(allowed.redirectStatus)) {
                throw new Error(`${entry.id}: redirect status is unsupported`);
            }
            if (entry.location !== allowed.redirectLocation) {
                throw new Error(
                    `${entry.id}: redirect location must exactly equal ${allowed.redirectLocation}`
                );
            }
            if (entry.status !== allowed.redirectStatus) {
                throw new Error(
                    `${entry.id}: redirect status must exactly equal ${allowed.redirectStatus}`
                );
            }
        }
    }
    for (const id of policies.keys()) {
        if (!manifestIds.has(id)) {
            throw new Error(`${id}: deployment policy entry has no site`);
        }
    }

    return manifestEntries.map((entry) => ({
        site: entry,
        policy: policies.get(entry.id),
    }));
};

const assertRoutesEqual = (routes, hostnames, label) => {
    if (!Array.isArray(routes) || routes.length !== hostnames.length) {
        throw new Error(`${label}: routes do not match exact allowlist`);
    }
    routes.forEach((route, index) => {
        if (
            route?.pattern !== hostnames[index] ||
            route?.custom_domain !== true ||
            Object.keys(route).some(
                (key) => !["pattern", "custom_domain"].includes(key)
            )
        ) {
            throw new Error(
                `${label}: route must exactly equal ${hostnames[index]}`
            );
        }
    });
};

export const validateRenderedCloudflareConfig = ({ config, policy, mode }) => {
    if (mode !== "preview" && mode !== "production") {
        throw new Error("Cloudflare config mode must be preview or production");
    }
    const expectedWorker =
        mode === "preview" ? policy.previewWorker : policy.productionWorker;
    if (config?.name !== expectedWorker) {
        throw new Error(
            `${policy.id}: ${mode} Worker must exactly equal ${expectedWorker}`
        );
    }
    if (config.preview_urls !== false) {
        throw new Error(`${policy.id}: preview_urls must be disabled`);
    }
    if (config.workers_dev !== false) {
        throw new Error(`${policy.id}: workers.dev must be disabled`);
    }
    if (mode === "preview") {
        if ("routes" in config) {
            throw new Error(`${policy.id}: public preview routes are disabled`);
        }
    } else {
        assertRoutesEqual(config.routes, policy.productionHostnames, policy.id);
    }
    return config;
};

export const validateRenderedCloudflareConfigSet = ({
    directory,
    entries,
    mode,
}) => {
    const expectedFiles = entries.map(({ site }) => `${site.id}.jsonc`).sort();
    const actualFiles = readdirSync(directory)
        .filter((file) => file.endsWith(".jsonc"))
        .sort();
    assertStringArrayEqual(
        actualFiles,
        expectedFiles,
        `${mode} generated config files`
    );
    const configs = new Map();
    for (const { site, policy } of entries) {
        const file = path.join(directory, `${site.id}.jsonc`);
        const config = readJson(file);
        validateRenderedCloudflareConfig({ config, policy, mode });
        configs.set(site.id, { file, config, site, policy });
    }
    return configs;
};

export const selectCloudflareDeploymentEntries = (entries, target) => {
    const appEntries = entries.filter(({ policy }) => policy.kind === "app");
    const redirectEntries = entries.filter(
        ({ policy }) => policy.kind === "redirect"
    );
    if (target === "apps") return appEntries;
    if (target === "legacy-redirect") return redirectEntries;
    if (target === "all") return entries;
    const selected = entries.filter(({ site }) => site.id === target);
    if (selected.length !== 1) {
        throw new Error(`Unsupported Cloudflare deployment target: ${target}`);
    }
    return selected;
};
