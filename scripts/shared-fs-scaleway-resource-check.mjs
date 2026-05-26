#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCALEWAY_API_BASE_URL = "https://api.scaleway.com";
const DEFAULT_ZONE = "fr-par-1";

const fail = (message) => {
    console.error(`[shared-fs-scaleway-resource-check] ${message}`);
    process.exitCode = 1;
};

const getRepoRoot = () =>
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const loadEnvFile = (filePath) => {
    let raw = "";
    try {
        raw = fs.readFileSync(filePath, "utf8");
    } catch {
        return false;
    }

    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const withoutExport = trimmed.startsWith("export ")
            ? trimmed.slice("export ".length).trim()
            : trimmed;
        const eqIndex = withoutExport.indexOf("=");
        if (eqIndex <= 0) continue;

        const key = withoutExport.slice(0, eqIndex).trim();
        if (!key || String(process.env[key] || "").trim()) continue;

        let value = withoutExport.slice(eqIndex + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        process.env[key] = value;
    }
    return true;
};

const parseArgs = () => {
    const args = process.argv.slice(2);
    const options = {
        repo:
            process.env.GITHUB_REPOSITORY?.split("/").pop() ||
            path.basename(getRepoRoot()),
        zone:
            process.env.SCALEWAY_ZONE ||
            process.env.SCW_DEFAULT_ZONE ||
            DEFAULT_ZONE,
        macMax: null,
        windowsMax: null,
        skipMissingCredentials: false,
    };

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        const next = () => {
            const value = args[++index];
            if (!value) throw new Error(`Missing value for ${arg}`);
            return value;
        };

        switch (arg) {
            case "--repo":
                options.repo = next();
                break;
            case "--zone":
                options.zone = next();
                break;
            case "--mac-prefix":
                options.macPrefix = next();
                break;
            case "--mac-max":
                options.macMax = Number(next());
                break;
            case "--windows-prefix":
                options.windowsPrefix = next();
                break;
            case "--windows-max":
                options.windowsMax = Number(next());
                break;
            case "--skip-missing-credentials":
                options.skipMissingCredentials = true;
                break;
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }

    options.macPrefix =
        options.macPrefix ?? `peerbit-gh-runner-macos-${options.repo}-`;
    options.windowsPrefix =
        options.windowsPrefix ?? `peerbit-gh-runner-windows-${options.repo}-`;

    for (const [key, value] of Object.entries({
        macMax: options.macMax,
        windowsMax: options.windowsMax,
    })) {
        if (value !== null && (!Number.isInteger(value) || value < 0)) {
            throw new Error(`${key} must be a non-negative integer`);
        }
    }

    return options;
};

const scalewayRequest = async (secretKey, endpoint) => {
    const response = await fetch(`${SCALEWAY_API_BASE_URL}${endpoint}`, {
        headers: {
            "X-Auth-Token": secretKey,
            Accept: "application/json",
        },
    });
    if (!response.ok) {
        throw new Error(`${response.status} ${await response.text()}`);
    }
    return response.json();
};

const timestamp = (value) => {
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const listMacServers = async (secretKey, zone, prefix) => {
    const data = await scalewayRequest(
        secretKey,
        `/apple-silicon/v1alpha1/zones/${encodeURIComponent(zone)}/servers`
    );
    return (Array.isArray(data?.servers) ? data.servers : [])
        .map((server) => ({
            id: String(server?.id ?? server?.server?.id ?? ""),
            name: String(server?.name ?? server?.server?.name ?? ""),
            status: String(
                server?.status ?? server?.state ?? server?.phase ?? "unknown"
            ),
            createdAt: timestamp(
                server?.created_at ?? server?.creation_date ?? server?.createdAt
            ),
            deletableAt: timestamp(server?.deletable_at ?? server?.deletableAt),
        }))
        .filter((server) => server.name.startsWith(prefix));
};

const listWindowsServers = async (secretKey, zone, prefix) => {
    const data = await scalewayRequest(
        secretKey,
        `/instance/v1/zones/${encodeURIComponent(zone)}/servers?per_page=100`
    );
    return (Array.isArray(data?.servers) ? data.servers : [])
        .map((server) => ({
            id: String(server?.id ?? ""),
            name: String(server?.name ?? ""),
            status: String(server?.state ?? server?.status ?? "unknown"),
            type: String(server?.commercial_type ?? ""),
            createdAt: timestamp(
                server?.creation_date ?? server?.created_at ?? server?.createdAt
            ),
        }))
        .filter((server) => server.name.startsWith(prefix));
};

const printResources = (label, resources) => {
    console.log(`${label}: ${resources.length}`);
    for (const resource of resources) {
        console.log(JSON.stringify(resource));
    }
};

const main = async () => {
    const explicitEnv = String(
        process.env.PEERBIT_SCALEWAY_ENV_FILE || ""
    ).trim();
    loadEnvFile(
        explicitEnv
            ? path.resolve(getRepoRoot(), explicitEnv)
            : path.join(getRepoRoot(), ".env.scaleway")
    );

    const options = parseArgs();
    const secretKey = String(
        process.env.SECRET_ACCESS_KEY || process.env.SCW_SECRET_KEY || ""
    ).trim();
    if (!secretKey) {
        if (options.skipMissingCredentials) {
            console.log(
                "[shared-fs-scaleway-resource-check] Scaleway credentials are not configured; skipping resource check."
            );
            return;
        }
        throw new Error(
            "Missing Scaleway SECRET_ACCESS_KEY or SCW_SECRET_KEY. Set it directly or through .env.scaleway."
        );
    }

    const [macServers, windowsServers] = await Promise.all([
        listMacServers(secretKey, options.zone, options.macPrefix),
        listWindowsServers(secretKey, options.zone, options.windowsPrefix),
    ]);

    printResources(`macOS servers matching ${options.macPrefix}`, macServers);
    printResources(
        `Windows servers matching ${options.windowsPrefix}`,
        windowsServers
    );

    if (options.macMax !== null && macServers.length > options.macMax) {
        fail(
            `Expected at most ${options.macMax} matching macOS server(s), found ${macServers.length}.`
        );
    }
    if (
        options.windowsMax !== null &&
        windowsServers.length > options.windowsMax
    ) {
        fail(
            `Expected at most ${options.windowsMax} matching Windows server(s), found ${windowsServers.length}.`
        );
    }
};

main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
});
