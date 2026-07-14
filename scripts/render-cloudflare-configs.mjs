import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, "cloudflare/sites.json"), "utf8")
);

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!key?.startsWith("--") || value == null) {
        throw new Error(
            "Usage: render-cloudflare-configs.mjs --mode preview|production [--output PATH]"
        );
    }
    args.set(key.slice(2), value);
}

const mode = args.get("mode");
if (mode !== "preview" && mode !== "production") {
    throw new Error("--mode must be preview or production");
}
const outputDirectory = path.resolve(
    repoRoot,
    args.get("output") || ".wrangler-config"
);
const outputRelative = path.relative(repoRoot, outputDirectory);
if (outputRelative.startsWith("..") || path.isAbsolute(outputRelative)) {
    throw new Error(
        "Generated Wrangler configs must stay inside the repository"
    );
}

const allEntries = [...manifest.staticSites, ...manifest.redirects];
const ownedProductionDomains = ["peerbit.org", "peerchecker.com"];
const appProductionSuffix = ".apps.peerbit.org";
const appProductionDomainPattern =
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.apps\.peerbit\.org$/;
const isOwnedProductionDomain = (domain) =>
    ownedProductionDomains.some(
        (owned) => domain === owned || domain.endsWith(`.${owned}`)
    );
const ids = new Set();
const workers = new Set();
const previewWorkers = new Set();
const domains = new Set();
for (const entry of allEntries) {
    if (!/^[a-z0-9-]+$/.test(entry.id))
        throw new Error(`Invalid site id ${entry.id}`);
    if (!/^[a-z0-9-]{1,63}$/.test(entry.worker)) {
        throw new Error(`Invalid Worker name ${entry.worker}`);
    }
    if (ids.has(entry.id)) throw new Error(`Duplicate site id ${entry.id}`);
    if (workers.has(entry.worker))
        throw new Error(`Duplicate Worker ${entry.worker}`);
    const previewWorker = `${entry.worker}-preview`;
    if (!/^[a-z0-9-]{1,63}$/.test(previewWorker)) {
        throw new Error(`Invalid preview Worker name ${previewWorker}`);
    }
    if (previewWorkers.has(previewWorker)) {
        throw new Error(`Duplicate preview Worker ${previewWorker}`);
    }
    ids.add(entry.id);
    workers.add(entry.worker);
    previewWorkers.add(previewWorker);
    for (const domain of entry.domains) {
        if (!isOwnedProductionDomain(domain)) {
            throw new Error(`Production domain is not approved: ${domain}`);
        }
        if (domains.has(domain)) throw new Error(`Duplicate domain ${domain}`);
        domains.add(domain);
    }
    if ("directory" in entry && (entry.script || entry.workerFirst)) {
        if (
            !entry.script ||
            !Array.isArray(entry.workerFirst) ||
            entry.workerFirst.length === 0 ||
            entry.workerFirst.some(
                (pattern) =>
                    typeof pattern !== "string" || !pattern.startsWith("/")
            )
        ) {
            throw new Error(
                `${entry.id}: workerFirst requires a script and absolute path patterns`
            );
        }
    }
}

for (const redirect of manifest.redirects) {
    const location = new URL(redirect.location);
    if (
        location.protocol !== "https:" ||
        !isOwnedProductionDomain(location.hostname)
    ) {
        throw new Error(
            `Redirect target is not an approved HTTPS domain: ${redirect.location}`
        );
    }
    if (![301, 302, 303, 307, 308].includes(redirect.status)) {
        throw new Error(`Unsupported redirect status: ${redirect.status}`);
    }
}

for (const site of manifest.staticSites) {
    for (const domain of site.domains) {
        if (!appProductionDomainPattern.test(domain)) {
            throw new Error(
                `Static app domain must use one label under *${appProductionSuffix}: ${domain}`
            );
        }
    }
}

for (const redirect of manifest.redirects) {
    const location = new URL(redirect.location);
    if (!location.hostname.endsWith(appProductionSuffix)) {
        throw new Error(
            `Legacy redirect target must use *${appProductionSuffix}: ${redirect.location}`
        );
    }
}

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

const relativeFromOutput = (target) => {
    const relative = path.relative(
        outputDirectory,
        path.resolve(repoRoot, target)
    );
    return relative.split(path.sep).join("/");
};
const baseConfig = (entry) => ({
    $schema: relativeFromOutput(
        "tools/wrangler/node_modules/wrangler/config-schema.json"
    ),
    // Preview and production deployments must never share a Worker service.
    // Once custom domains are attached, updating the same service would make a
    // preview deployment a production change even if no routes were rendered.
    name: mode === "preview" ? `${entry.worker}-preview` : entry.worker,
    compatibility_date: manifest.compatibilityDate,
    workers_dev: mode === "preview",
    preview_urls: false,
    ...(mode === "production"
        ? {
              routes: entry.domains.map((domain) => ({
                  pattern: domain,
                  custom_domain: true,
              })),
          }
        : {}),
});

for (const site of manifest.staticSites) {
    const config = {
        ...baseConfig(site),
        ...(site.script
            ? {
                  main: relativeFromOutput(site.script),
                  cache: {
                      enabled: true,
                      cross_version_cache: false,
                  },
                  vars: {
                      RANGE_MEDIA_PATHS: JSON.stringify(site.workerFirst),
                  },
              }
            : {}),
        assets: {
            directory: relativeFromOutput(site.directory),
            html_handling: "auto-trailing-slash",
            not_found_handling: "none",
            ...(site.script
                ? {
                      binding: "ASSETS",
                      run_worker_first: site.workerFirst,
                  }
                : {}),
        },
    };
    writeFileSync(
        path.join(outputDirectory, `${site.id}.jsonc`),
        `${JSON.stringify(config, null, 2)}\n`,
        "utf8"
    );
}

for (const redirect of manifest.redirects) {
    const config = {
        ...baseConfig(redirect),
        main: relativeFromOutput(redirect.script),
        vars: {
            CANONICAL_STREAM_URL: redirect.location,
            REDIRECT_STATUS: String(redirect.status),
        },
    };
    writeFileSync(
        path.join(outputDirectory, `${redirect.id}.jsonc`),
        `${JSON.stringify(config, null, 2)}\n`,
        "utf8"
    );
}

console.log(
    `Rendered ${allEntries.length} ${mode} configs in ${outputRelative}`
);
