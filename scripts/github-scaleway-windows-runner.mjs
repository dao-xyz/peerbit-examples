#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { ProcessTracker } from "./lib/process-tracker.mjs";
import {
    deleteRepoVariable,
    deleteRunner,
    detectRepoFromGit,
    explainPatAccessIssue,
    getGitHubTokens,
    getRunnerRegistrationToken,
    listRunners,
    upsertRepoVariable,
} from "./lib/github.mjs";

const SCALEWAY_API_BASE_URL = "https://api.scaleway.com";
const ENV_GITHUB_FILE_DEFAULT = ".env.github";
const ENV_SCALEWAY_FILE_DEFAULT = ".env.scaleway";

const DEFAULT_RUNNER_VERSION = "2.330.0";
const DEFAULT_ZONE = "fr-par-1";
const DEFAULT_SERVER_TYPE = "POP2-2C-8G-WIN";

function fail(message) {
    console.error(`[github-scaleway-windows-runner] ${message}`);
    process.exit(1);
}

function runCapture(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...options,
    });
    if (result.error) {
        throw new Error(
            `${command} ${args.join(" ")} failed to start: ${result.error instanceof Error ? result.error.message : String(result.error)}`
        );
    }
    const code = result.status ?? result.code ?? 1;
    if (code !== 0) {
        const stderr =
            typeof result.stderr === "string" ? result.stderr.trim() : "";
        const stdout =
            typeof result.stdout === "string" ? result.stdout.trim() : "";
        throw new Error(
            `${command} ${args.join(" ")} failed with exit code ${code}${stderr ? `\n${stderr}` : stdout ? `\n${stdout}` : ""}`
        );
    }
    return typeof result.stdout === "string" ? result.stdout : "";
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function supportsAdminPasswordEncryption(serverType) {
    const normalized = String(serverType || "").toUpperCase();
    return normalized.includes("POP2") && normalized.includes("-WIN");
}

function getRepoRoot() {
    const scriptPath = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(scriptPath), "..");
}

function loadEnvFile(filePath) {
    let raw = "";
    try {
        raw = fs.readFileSync(filePath, "utf-8");
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
        if (!key) continue;
        if (key in process.env && String(process.env[key] || "").trim())
            continue;

        let value = withoutExport.slice(eqIndex + 1).trim();
        if (
            (value.startsWith('"') &&
                value.endsWith('"') &&
                value.length >= 2) ||
            (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
        ) {
            value = value.slice(1, -1);
        }
        process.env[key] = value;
    }

    return true;
}

function loadGitHubEnv() {
    const explicit = (process.env.PEERBIT_GITHUB_ENV_FILE || "").trim();
    const root = getRepoRoot();
    const candidate = explicit
        ? path.resolve(root, explicit)
        : path.join(root, ENV_GITHUB_FILE_DEFAULT);
    loadEnvFile(candidate);
}

function loadScalewayEnv() {
    const explicit = (process.env.PEERBIT_SCALEWAY_ENV_FILE || "").trim();
    const root = getRepoRoot();
    const candidate = explicit
        ? path.resolve(root, explicit)
        : path.join(root, ENV_SCALEWAY_FILE_DEFAULT);
    loadEnvFile(candidate);
}

function usage() {
    console.log("GitHub Actions runner helpers (Scaleway Windows VM)");
    console.log("");
    console.log("Usage:");
    console.log("  pnpm scaleway:windows:start");
    console.log("  pnpm scaleway:windows:bootstrap");
    console.log("  pnpm scaleway:windows:stop");
    console.log("  pnpm scaleway:windows:status");
    console.log("  pnpm scaleway:windows:janitor");
    console.log("  pnpm scaleway:windows:images");
    console.log("  pnpm scaleway:windows:admin-password");
    console.log("");
    console.log("Required tooling:");
    console.log("  - GitHub token: GH_TOKEN/GITHUB_TOKEN or `gh auth login`");
    console.log(
        "  - Scaleway credentials: ACCESS_KEY_ID + SECRET_ACCESS_KEY (see .env.scaleway.example)"
    );
    console.log("");
    console.log("Env overrides:");
    console.log(
        "  SCALEWAY_ZONE=fr-par-1                     (default: fr-par-1)"
    );
    console.log(
        "  SCALEWAY_PROJECT_ID=<uuid>                 (optional; otherwise resolved from the API key default_project_id)"
    );
    console.log(
        "  SCALEWAY_WINDOWS_SERVER_TYPE=POP2-2C-8G-WIN (default: POP2-2C-8G-WIN)"
    );
    console.log(
        "  SCALEWAY_WINDOWS_IMAGE=<id>                (optional; auto-detects Windows Server 2022 Core if unset)"
    );
    console.log("  SCALEWAY_WINDOWS_ROOT_GB=100               (default: 100)");
    console.log(
        "  PEERBIT_SCALEWAY_SSH_KEY_ID=<uuid>         (optional; used for Windows admin password encryption on POP2-WIN)"
    );
    console.log("  PEERBIT_SCALEWAY_SSH_KEY_NAME=peerbit-gh-runner");
    console.log(
        "  PEERBIT_SCALEWAY_SSH_PUBLIC_KEY=...        (otherwise reads ~/.ssh/*.pub)"
    );
    console.log(
        "  PEERBIT_SCALEWAY_SSH_IDENTITY_FILE=~/.ssh/peerbit_scaleway_rsa (used by SSH bootstrap + admin-password)"
    );
    console.log(
        "  PEERBIT_SCALEWAY_SSH_AUTHORIZED_KEY=...    (optional; SSH key to authorize on the VM for debug)"
    );
    console.log(
        "  PEERBIT_WINDOWS_SSH_USER=Administrator     (default: Administrator)"
    );
    console.log(
        "  PEERBIT_WINDOWS_ENABLE_SSH=1               (default: 1; restricts inbound to your public IP)"
    );
    console.log(
        "  PEERBIT_WINDOWS_SSH_REMOTE_ADDRESS=<ip>    (optional; overrides auto-detected public IP)"
    );
    console.log("  PEERBIT_WINDOWS_ENABLE_WINRM=0             (default: 0)");
    console.log(
        "  PEERBIT_WINDOWS_WINRM_REMOTE_ADDRESS=<ip>  (optional; overrides auto-detected public IP)"
    );
    console.log(
        "  PEERBIT_WINDOWS_SKIP_DEPENDENCIES=1        (start default: 1; bootstrap default: 0)"
    );
    console.log("  PEERBIT_GITHUB_RUNNER_VERSION=2.330.0");
    console.log("  PEERBIT_RUNNER_LABELS=peerbit,scaleway");
    console.log(
        "  PEERBIT_RUNNER_EPHEMERAL=1                  (default: 1; runner accepts one job)"
    );
    console.log(
        "  PEERBIT_SCALEWAY_WINDOWS_REUSE_SERVER=0     (set 1 to reuse a warm Windows host)"
    );
    console.log(
        "  PEERBIT_SCALEWAY_WINDOWS_REUSE_POOL=shared-fs (stable pool name when reusing)"
    );
    console.log(
        "  PEERBIT_SCALEWAY_WINDOWS_DELETE_REUSABLE=0  (set 1 to delete reused host in stop)"
    );
    console.log("  PEERBIT_SCALEWAY_JANITOR_MAX_AGE_MS=7200000 (default: 2h)");
    console.log(
        "  PEERBIT_FORCE=1                             (allow stop while runner busy)"
    );
    console.log("");
    console.log("Notes:");
    console.log(
        "  - This script creates a Windows Instance and bootstraps it over SSH (no cloudbase-init required)."
    );
    console.log(
        "  - Start defaults to a fast runner-only bootstrap; run `bootstrap` to install build dependencies (Git + VS Build Tools + Rust)."
    );
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeGitHubOutput(values) {
    const filePath = String(process.env.GITHUB_OUTPUT || "").trim();
    if (!filePath) return;
    const body = Object.entries(values)
        .map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, " ")}`)
        .join("\n");
    fs.appendFileSync(filePath, `${body}\n`, "utf-8");
}

function looksLikeIpv4(value) {
    const ip = String(value || "").trim();
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return false;
    const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
    return (
        parts.length === 4 &&
        parts.every((part) => Number.isFinite(part) && part >= 0 && part <= 255)
    );
}

async function detectPublicIp() {
    const endpoints = [
        {
            url: "https://1.1.1.1/cdn-cgi/trace",
            parse: (text) =>
                text
                    .split(/\r?\n/)
                    .find((line) => line.startsWith("ip="))
                    ?.slice(3) || "",
        },
        { url: "https://api.ipify.org/", parse: (text) => text.trim() },
        { url: "https://ifconfig.me/ip", parse: (text) => text.trim() },
    ];

    for (const { url, parse } of endpoints) {
        try {
            const res = await fetch(url, { method: "GET" });
            if (!res.ok) continue;
            const text = await res.text().catch(() => "");
            const ip = parse(text).trim();
            if (looksLikeIpv4(ip)) return ip;
        } catch {
            // ignore
        }
    }

    return "";
}

async function waitForTcpPort({ host, port, timeoutMs, pollMs, label }) {
    const deadline = Date.now() + timeoutMs;
    const attemptTimeoutMs = Math.min(5000, pollMs);

    while (Date.now() < deadline) {
        const ok = await new Promise((resolve) => {
            const socket = new net.Socket();
            const done = (value) => {
                try {
                    socket.destroy();
                } catch {
                    // ignore
                }
                resolve(value);
            };

            socket.setTimeout(attemptTimeoutMs);
            socket.once("error", () => done(false));
            socket.once("timeout", () => done(false));
            socket.connect(port, host, () => done(true));
        });

        if (ok) return;
        await sleep(pollMs);
    }

    throw new Error(
        `Timed out waiting for ${label || "tcp"} on ${host}:${port}.`
    );
}

function getEnvInt(name, fallback) {
    const raw = String(process.env[name] || "").trim();
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function detectIdentityFile() {
    const fromEnv = String(
        process.env.PEERBIT_SCALEWAY_SSH_IDENTITY_FILE || ""
    ).trim();
    if (fromEnv) return fromEnv;

    const home = process.env.HOME || os.homedir();
    const candidates = [
        path.join(home, ".ssh", "peerbit_scaleway_rsa"),
        path.join(home, ".ssh", "id_rsa"),
    ];
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch {
            // ignore
        }
    }
    return "";
}

function getWindowsSshUser() {
    return (
        (process.env.PEERBIT_WINDOWS_SSH_USER || "Administrator").trim() ||
        "Administrator"
    );
}

function runPowerShellOverSsh({ host, script }) {
    const identityFile = detectIdentityFile();
    if (!identityFile) {
        fail(
            [
                "Missing SSH identity file for Windows runner bootstrap.",
                "Set PEERBIT_SCALEWAY_SSH_IDENTITY_FILE=~/.ssh/peerbit_scaleway_rsa (or another private key that exists in your Scaleway Project SSH keys).",
            ].join("\n")
        );
    }

    const user = getWindowsSshUser();
    const args = [
        "-i",
        identityFile,
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        `${user}@${host}`,
        "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -",
    ];

    const result = spawnSync("ssh", args, {
        input: script,
        encoding: "utf8",
        stdio: ["pipe", "inherit", "inherit"],
    });
    if (result.error) {
        throw new Error(
            `ssh failed to start: ${result.error instanceof Error ? result.error.message : String(result.error)}`
        );
    }
    const code = result.status ?? result.code ?? 1;
    if (code !== 0) {
        throw new Error(`ssh exited with code ${code}`);
    }
}

function getScalewayAccessKeyId() {
    const accessKey = (
        process.env.ACCESS_KEY_ID ||
        process.env.SCW_ACCESS_KEY ||
        ""
    ).trim();
    if (!accessKey) {
        fail(
            "Missing Scaleway ACCESS_KEY_ID (or SCW_ACCESS_KEY). Set it in .env.scaleway."
        );
    }
    return accessKey;
}

function getScalewaySecretKey() {
    const secretKey = (
        process.env.SECRET_ACCESS_KEY ||
        process.env.SCW_SECRET_KEY ||
        ""
    ).trim();
    if (!secretKey) {
        fail(
            "Missing Scaleway SECRET_ACCESS_KEY (or SCW_SECRET_KEY). Set it in .env.scaleway."
        );
    }
    return secretKey;
}

async function scalewayJson(secretKey, method, endpoint, body) {
    const url = `${SCALEWAY_API_BASE_URL}${endpoint}`;
    const headers = {
        "X-Auth-Token": secretKey,
        Accept: "application/json",
    };
    const init = { method, headers };
    if (body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        const error = new Error(
            `${method} ${endpoint} failed (${response.status}): ${text || response.statusText}`
        );
        error.status = response.status;
        error.body = text;
        throw error;
    }
    if (response.status === 204) return null;
    const text = await response.text().catch(() => "");
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

async function resolveProjectId(secretKey) {
    const override = (
        process.env.SCALEWAY_PROJECT_ID ||
        process.env.SCW_DEFAULT_PROJECT_ID ||
        ""
    ).trim();
    if (override) return override;

    const accessKey = getScalewayAccessKeyId();
    const data = await scalewayJson(
        secretKey,
        "GET",
        `/iam/v1alpha1/api-keys/${encodeURIComponent(accessKey)}`
    );
    const projectId = String(data?.default_project_id || "").trim();
    if (!projectId) {
        fail(
            "Scaleway API key did not return default_project_id. Set SCALEWAY_PROJECT_ID in .env.scaleway."
        );
    }
    return projectId;
}

function sanitizeName(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, "")
        .slice(0, 60);
}

function readPublicKeyFile(filePath) {
    try {
        return fs.readFileSync(filePath, "utf-8").trim();
    } catch {
        return "";
    }
}

function detectPublicKey(identityFile = "") {
    const fromEnv = (process.env.PEERBIT_SCALEWAY_SSH_PUBLIC_KEY || "").trim();
    if (fromEnv) return fromEnv;

    const identity = identityFile || detectIdentityFile();
    if (identity) {
        const fromIdentity = readPublicKeyFile(`${identity}.pub`);
        if (fromIdentity) return fromIdentity;
    }

    const home = process.env.HOME || os.homedir();
    const sshDir = path.join(home, ".ssh");
    try {
        const entries = fs.readdirSync(sshDir, { withFileTypes: true });
        const pubFiles = entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".pub"))
            .map((entry) => path.join(sshDir, entry.name));

        for (const candidate of pubFiles) {
            try {
                const raw = fs.readFileSync(candidate, "utf-8").trim();
                if (raw.startsWith("ssh-rsa ")) return raw;
            } catch {
                // ignore
            }
        }
    } catch {
        // ignore
    }

    const candidates = [
        path.join(sshDir, "id_rsa.pub"),
        path.join(sshDir, "id_ed25519.pub"),
        path.join(sshDir, "id_ecdsa.pub"),
        path.join(sshDir, "id_dsa.pub"),
    ];

    for (const candidate of candidates) {
        try {
            const raw = fs.readFileSync(candidate, "utf-8").trim();
            if (raw) return raw;
        } catch {
            // ignore
        }
    }

    return "";
}

function normalizeSshPublicKey(value) {
    const parts = String(value || "")
        .trim()
        .split(/\s+/);
    return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : parts.join(" ");
}

async function ensureScalewaySshKey(secretKey, projectId, publicKey) {
    const explicitId = String(
        process.env.PEERBIT_SCALEWAY_SSH_KEY_ID || ""
    ).trim();
    if (explicitId) return explicitId;

    const keyName = (
        process.env.PEERBIT_SCALEWAY_SSH_KEY_NAME || "peerbit-gh-runner"
    ).trim();
    if (!publicKey) {
        fail(
            [
                "No SSH public key found.",
                "Provide PEERBIT_SCALEWAY_SSH_PUBLIC_KEY, or create an SSH key and set PEERBIT_SCALEWAY_SSH_IDENTITY_FILE to it, or set PEERBIT_SCALEWAY_SSH_KEY_ID to use an existing Scaleway SSH key.",
            ].join("\n")
        );
    }
    const normalizedPublicKey = normalizeSshPublicKey(publicKey);

    const list = await scalewayJson(
        secretKey,
        "GET",
        `/iam/v1alpha1/ssh-keys?project_id=${encodeURIComponent(projectId)}`
    );
    const keys = Array.isArray(list?.ssh_keys) ? list.ssh_keys : [];
    const matchByKey =
        keys.find(
            (item) =>
                normalizeSshPublicKey(item?.public_key) === normalizedPublicKey
        ) || null;
    if (matchByKey?.id) return matchByKey.id;

    const matchByName =
        keys.find((item) => String(item?.name || "").trim() === keyName) ||
        null;
    const createName =
        matchByName &&
        normalizeSshPublicKey(matchByName?.public_key) !== normalizedPublicKey
            ? `${keyName}-alt-${crypto.randomBytes(2).toString("hex")}`
            : keyName;

    const created = await scalewayJson(
        secretKey,
        "POST",
        "/iam/v1alpha1/ssh-keys",
        {
            project_id: projectId,
            name: createName,
            public_key: normalizedPublicKey,
        }
    );
    const id = String(created?.id || "").trim();
    if (!id) {
        throw new Error("Scaleway API did not return ssh key id");
    }
    return id;
}

function extractServer(data) {
    if (!data) return null;
    if (data.server && typeof data.server === "object") return data.server;
    return data;
}

function extractServerId(data) {
    const server = extractServer(data);
    return String(server?.id || "").trim();
}

function extractServerName(data) {
    const server = extractServer(data);
    return String(server?.name || "").trim();
}

function extractServerStatus(server) {
    const candidates = [server?.state, server?.status, server?.phase]
        .map((value) => String(value || "").trim())
        .filter(Boolean);
    return (candidates[0] || "unknown").toLowerCase();
}

function extractServerPublicIp(server) {
    const candidates = [
        server?.public_ip?.address,
        server?.public_ip?.ip,
        Array.isArray(server?.public_ips)
            ? server.public_ips[0]?.address
            : null,
    ]
        .map((value) => String(value || "").trim())
        .filter(Boolean);
    return candidates[0] || "";
}

function extractServerHost(server) {
    const ip = extractServerPublicIp(server);
    if (ip) return ip;
    const candidates = [server?.hostname, server?.dns]
        .map((value) => String(value || "").trim())
        .filter(Boolean);
    return candidates[0] || "";
}

function escapePowerShell(value) {
    return String(value || "").replaceAll("'", "''");
}

async function getInstanceServer(secretKey, zone, serverId) {
    return extractServer(
        await scalewayJson(
            secretKey,
            "GET",
            `/instance/v1/zones/${encodeURIComponent(zone)}/servers/${encodeURIComponent(serverId)}`
        )
    );
}

async function runInstanceAction(secretKey, zone, serverId, action) {
    await scalewayJson(
        secretKey,
        "POST",
        `/instance/v1/zones/${encodeURIComponent(zone)}/servers/${encodeURIComponent(serverId)}/action`,
        { action }
    );
}

async function restartInstance(secretKey, zone, serverId) {
    const server = await getInstanceServer(secretKey, zone, serverId);
    const status = extractServerStatus(server);
    const actions =
        status === "running" ? ["reboot", "poweron"] : ["poweron", "reboot"];
    for (const action of actions) {
        try {
            console.log(
                `[github-scaleway-windows-runner] Sending instance action: ${action}...`
            );
            await runInstanceAction(secretKey, zone, serverId, action);
            return;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            console.warn(
                `[github-scaleway-windows-runner] Warning: action ${action} failed (${message}).`
            );
        }
    }
    fail(
        `Could not start/reboot server ${serverId}; check Scaleway console for its state.`
    );
}

async function waitForInstanceReady({
    secretKey,
    zone,
    serverId,
    tracker,
    trackerKey,
}) {
    const readyWaitMs = getEnvInt(
        "PEERBIT_SCALEWAY_SERVER_READY_TIMEOUT_MS",
        25 * 60 * 1000
    );
    const readyPollMs = getEnvInt(
        "PEERBIT_SCALEWAY_SERVER_READY_POLL_MS",
        5000
    );
    const readyDeadline = Date.now() + readyWaitMs;

    while (Date.now() < readyDeadline) {
        const server = await getInstanceServer(secretKey, zone, serverId);
        const state = extractServerStatus(server);
        const ip = extractServerPublicIp(server);
        if (ip) {
            tracker.track(trackerKey, {
                ...(tracker.list()[trackerKey] || {}),
                serverHost: ip,
            });
        }
        if (state === "running" && ip) {
            return { server, ip };
        }
        await sleep(readyPollMs);
    }

    const server = await getInstanceServer(secretKey, zone, serverId).catch(
        () => null
    );
    const state = extractServerStatus(server);
    const ip = extractServerPublicIp(server);
    fail(
        `Server did not become running with a public IP in time (status=${state}${ip ? ` ip=${ip}` : ""}). Check Scaleway console and re-run status/bootstrap.`
    );
}

async function waitForInstanceStopped({ secretKey, zone, serverId }) {
    const waitMs = getEnvInt(
        "PEERBIT_SCALEWAY_SERVER_STOP_TIMEOUT_MS",
        10 * 60 * 1000
    );
    const pollMs = getEnvInt("PEERBIT_SCALEWAY_SERVER_STOP_POLL_MS", 5000);
    const deadline = Date.now() + waitMs;

    while (Date.now() < deadline) {
        const state = extractServerStatus(
            await getInstanceServer(secretKey, zone, serverId)
        );
        if (state === "stopped") return;
        await sleep(pollMs);
    }

    const state = extractServerStatus(
        await getInstanceServer(secretKey, zone, serverId).catch(() => null)
    );
    throw new Error(
        `Server ${serverId} did not stop within ${Math.round(waitMs / 1000)}s (status=${state}).`
    );
}

function readUserDataTemplate() {
    const repoRoot = getRepoRoot();
    const templatePath = path.join(
        repoRoot,
        "scripts",
        "scaleway",
        "user-data.github-runner.ps1"
    );
    return fs.readFileSync(templatePath, "utf-8");
}

function renderUserData(template, replacements) {
    let out = template;
    for (const [key, value] of Object.entries(replacements)) {
        out = out.replaceAll(`{{${key}}}`, String(value));
    }
    return out;
}

async function resolveWindowsImage(secretKey, zone, projectId) {
    const raw = (
        process.env.SCALEWAY_WINDOWS_IMAGE ||
        process.env.SCALEWAY_IMAGE ||
        process.env.SCW_IMAGE ||
        ""
    ).trim();
    if (raw) return raw;

    console.log(
        "[github-scaleway-windows-runner] No SCALEWAY_WINDOWS_IMAGE provided; trying to locate a public Windows Server 2022 Core image..."
    );
    const data = await scalewayJson(
        secretKey,
        "GET",
        `/instance/v1/zones/${encodeURIComponent(zone)}/images?per_page=100&public=true&arch=x86_64&name=${encodeURIComponent("Windows")}`
    );
    const images = Array.isArray(data?.images) ? data.images : [];
    const core = images.filter((image) =>
        /windows server 2022 core/i.test(String(image?.name || ""))
    );
    core.sort((a, b) =>
        String(b?.creation_date || "").localeCompare(
            String(a?.creation_date || "")
        )
    );

    const match =
        core[0] ||
        images.find((image) => /windows/i.test(String(image?.name || ""))) ||
        null;
    if (!match?.id) {
        fail(
            [
                "Could not auto-detect a Windows image in this zone.",
                "Set SCALEWAY_WINDOWS_IMAGE=<image-id-or-label> in .env.scaleway, or run pnpm scaleway:windows:images to list options.",
            ].join("\n")
        );
    }
    console.warn(
        `[github-scaleway-windows-runner] Using detected image: ${match.name} (${match.id}). Set SCALEWAY_WINDOWS_IMAGE to pin it.`
    );
    return match.id;
}

async function listWindowsImages(secretKey, zone, projectId) {
    const data = await scalewayJson(
        secretKey,
        "GET",
        `/instance/v1/zones/${encodeURIComponent(zone)}/images?per_page=100&public=true&arch=x86_64&name=${encodeURIComponent("Windows")}`
    );
    const images = Array.isArray(data?.images) ? data.images : [];
    if (images.length === 0) {
        console.log(
            `[github-scaleway-windows-runner] No public Windows images found in ${zone}.`
        );
        return;
    }
    console.log(`[github-scaleway-windows-runner] Windows images in ${zone}:`);
    for (const image of images) {
        console.log(`- ${image.name} (${image.id})`);
    }
    console.log("");
    console.log(
        "Set SCALEWAY_WINDOWS_IMAGE=<id> in .env.scaleway to select one."
    );
}

async function findReusableServer(secretKey, zone, serverName) {
    const data = await scalewayJson(
        secretKey,
        "GET",
        `/instance/v1/zones/${encodeURIComponent(zone)}/servers?per_page=100`
    );
    const servers = Array.isArray(data?.servers) ? data.servers : [];
    const matches = servers.filter(
        (server) => extractServerName(server) === serverName
    );
    matches.sort((a, b) => serverCreatedAt(b) - serverCreatedAt(a));
    return matches[0] || null;
}

async function waitForRunnerOnline({
    tokens,
    owner,
    repo,
    runnerName,
    timeoutMs,
    pollMs,
}) {
    const deadline = Date.now() + timeoutMs;
    let runnerId = null;
    let lastStatus = "not registered";

    while (Date.now() < deadline) {
        const runners = await listRunners(tokens, owner, repo);
        const match =
            runners.find((runner) => runner?.name === runnerName) || null;
        if (match?.id) {
            runnerId = match.id;
            lastStatus = String(match.status || "unknown");
            if (lastStatus === "online") return match;
        }
        await sleep(pollMs);
    }

    if (runnerId) {
        throw new Error(
            `Runner ${runnerName} registered as ${runnerId}, but did not come online within ${Math.round(timeoutMs / 1000)}s (last status: ${lastStatus}).`
        );
    }

    throw new Error(
        `Runner ${runnerName} did not register within ${Math.round(timeoutMs / 1000)}s.`
    );
}

async function startRunner(repoInfo) {
    const tokens = getGitHubTokens();
    if (tokens.length === 0) {
        fail(
            "Missing GitHub auth. Set GH_TOKEN/GITHUB_TOKEN, or run `gh auth login`."
        );
    }

    const secretKey = getScalewaySecretKey();
    const zone = (process.env.SCALEWAY_ZONE || DEFAULT_ZONE).trim();
    const serverType = (
        process.env.SCALEWAY_WINDOWS_SERVER_TYPE ||
        process.env.SCALEWAY_SERVER_TYPE ||
        DEFAULT_SERVER_TYPE
    ).trim();
    const runnerLabels = (
        process.env.PEERBIT_RUNNER_LABELS || "peerbit,scaleway"
    ).trim();
    const runnerVersion = (
        process.env.PEERBIT_GITHUB_RUNNER_VERSION || DEFAULT_RUNNER_VERSION
    ).trim();
    const ephemeral =
        String(process.env.PEERBIT_RUNNER_EPHEMERAL || "1").trim() !== "0";
    const rootGb = getEnvInt("SCALEWAY_WINDOWS_ROOT_GB", 100);
    const reuseServer =
        String(
            process.env.PEERBIT_SCALEWAY_WINDOWS_REUSE_SERVER ||
                process.env.PEERBIT_SCALEWAY_REUSE_SERVER ||
                ""
        ).trim() === "1";
    const reusePool = sanitizeName(
        process.env.PEERBIT_SCALEWAY_WINDOWS_REUSE_POOL ||
            process.env.PEERBIT_SCALEWAY_REUSE_POOL ||
            "shared-fs"
    );
    const forceReconfigure =
        reuseServer ||
        String(process.env.PEERBIT_RUNNER_RECONFIGURE || "").trim() === "1";

    const enableSsh =
        String(process.env.PEERBIT_WINDOWS_ENABLE_SSH || "1").trim() !== "0";
    const enableWinrm =
        String(process.env.PEERBIT_WINDOWS_ENABLE_WINRM || "").trim() === "1";
    const skipDependencies =
        String(process.env.PEERBIT_WINDOWS_SKIP_DEPENDENCIES || "1").trim() !==
        "0";
    const skipHeavyDependencies =
        String(
            process.env.PEERBIT_WINDOWS_SKIP_HEAVY_DEPENDENCIES || ""
        ).trim() === "1";
    const publicKey = detectPublicKey();
    const sshAuthorizedKey =
        String(process.env.PEERBIT_SCALEWAY_SSH_AUTHORIZED_KEY || "").trim() ||
        publicKey;
    let sshRemoteAddress = String(
        process.env.PEERBIT_WINDOWS_SSH_REMOTE_ADDRESS || ""
    ).trim();
    let winrmRemoteAddress = String(
        process.env.PEERBIT_WINDOWS_WINRM_REMOTE_ADDRESS || ""
    ).trim();

    if (
        (enableSsh && !sshRemoteAddress) ||
        (enableWinrm && !winrmRemoteAddress)
    ) {
        const auto = await detectPublicIp();
        if (!sshRemoteAddress) sshRemoteAddress = auto;
        if (!winrmRemoteAddress) winrmRemoteAddress = auto;
    }

    if (enableSsh && !sshAuthorizedKey) {
        console.warn(
            "[github-scaleway-windows-runner] Warning: PEERBIT_WINDOWS_ENABLE_SSH=1 but no SSH public key was detected; SSH will not be configured."
        );
    }
    if (enableSsh && !sshRemoteAddress) {
        console.warn(
            "[github-scaleway-windows-runner] Warning: could not auto-detect your public IP; set PEERBIT_WINDOWS_SSH_REMOTE_ADDRESS to enable SSH firewall access."
        );
    }

    const repoUrl = `https://github.com/${repoInfo.owner}/${repoInfo.repo}`;
    const suffix = crypto.randomBytes(3).toString("hex");
    const runnerName = sanitizeName(
        `peerbit-win-${repoInfo.repo}-${reusePool || "pool"}-${suffix}`
    );
    const serverName = reuseServer
        ? sanitizeName(
              `peerbit-gh-runner-windows-${repoInfo.repo}-${reusePool || "pool"}`
          )
        : sanitizeName(`peerbit-gh-runner-windows-${repoInfo.repo}-${suffix}`);

    const tracker = new ProcessTracker("github-scaleway-windows-runner.json");
    const key = `${repoInfo.owner}/${repoInfo.repo}`;
    const previous = tracker.list()[key] || null;
    const replace =
        String(process.env.PEERBIT_RUNNER_REPLACE || "").trim() === "1";
    if (previous && !replace) {
        fail(
            `A Scaleway Windows runner is already tracked for ${key}. Run pnpm scaleway:windows:stop first, or set PEERBIT_RUNNER_REPLACE=1.`
        );
    }

    const projectId = await resolveProjectId(secretKey);
    const supportsEncryption = supportsAdminPasswordEncryption(serverType);
    if (enableSsh && !publicKey) {
        fail(
            [
                "No SSH public key found for connecting to the Windows runner.",
                "Generate one with: ssh-keygen -t rsa -b 4096 -f ~/.ssh/peerbit_scaleway_rsa -N ''",
                "Or set PEERBIT_SCALEWAY_SSH_PUBLIC_KEY / PEERBIT_SCALEWAY_SSH_AUTHORIZED_KEY.",
            ].join("\n")
        );
    }

    let created = reuseServer
        ? await findReusableServer(secretKey, zone, serverName)
        : null;
    const reusedServer = Boolean(created);
    let sshKeyId = "";
    let image = "";

    if (created) {
        console.log(
            `[github-scaleway-windows-runner] Reusing Scaleway Instance ${serverName} (${extractServerId(created)}).`
        );
    } else {
        image = await resolveWindowsImage(secretKey, zone, projectId);
        if (publicKey) {
            sshKeyId = await ensureScalewaySshKey(
                secretKey,
                projectId,
                publicKey
            );
        }

        const encryptAdminPassword =
            supportsEncryption &&
            publicKey &&
            publicKey.startsWith("ssh-rsa ") &&
            Boolean(sshKeyId);

        if (
            supportsEncryption &&
            (!publicKey || !publicKey.startsWith("ssh-rsa "))
        ) {
            console.warn(
                [
                    `[github-scaleway-windows-runner] Note: ${serverType} supports admin password encryption, but no RSA SSH public key was detected.`,
                    "Windows password encryption requires an RSA key (ssh-rsa).",
                    "Generate one with: ssh-keygen -t rsa -b 4096 -f ~/.ssh/peerbit_scaleway_rsa -N ''",
                    "Then re-run, or set PEERBIT_SCALEWAY_SSH_PUBLIC_KEY to your RSA public key.",
                    "Continuing without admin password encryption.",
                ].join("\n")
            );
        }

        if (!supportsEncryption) {
            console.warn(
                `[github-scaleway-windows-runner] Note: ${serverType} does not support admin password encryption via SSH key (only POP2-WIN).`
            );
        }

        console.log(
            `[github-scaleway-windows-runner] Creating Scaleway Instance ${serverName} (${serverType}, ${zone})...`
        );
        const serverPayload = {
            name: serverName,
            project: projectId,
            commercial_type: serverType,
            dynamic_ip_required: true,
            image,
            volumes: {
                0: {
                    size: rootGb * 1000 * 1000 * 1000,
                },
            },
            tags: [
                "peerbit",
                "github-runner",
                "scaleway",
                "windows",
                ...(enableSsh ? ["with-ssh"] : []),
            ],
        };
        if (encryptAdminPassword && sshKeyId) {
            serverPayload.admin_password_encryption_ssh_key_id = sshKeyId;
        }

        created = await scalewayJson(
            secretKey,
            "POST",
            `/instance/v1/zones/${encodeURIComponent(zone)}/servers`,
            serverPayload
        );
    }

    const serverId = extractServerId(created);
    if (!serverId) {
        throw new Error("Scaleway API did not return server id");
    }

    tracker.track(key, {
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        repoUrl,
        zone,
        projectId,
        serverId,
        serverName: extractServerName(created) || serverName,
        serverType,
        image,
        sshKeyId: sshKeyId || null,
        runnerName,
        runnerLabels,
        runnerVersion,
        ephemeral,
        reuseServer,
        reusedServer,
        runnerId: null,
        serverHost: null,
    });
    writeGitHubOutput({
        server_id: serverId,
        server_name: serverName,
        runner_name: runnerName,
        runner_labels: runnerLabels,
        server_reused: reusedServer ? "1" : "0",
    });

    console.log(
        `[github-scaleway-windows-runner] Server ${reusedServer ? "selected" : "created"} (id ${serverId}).`
    );

    await restartInstance(secretKey, zone, serverId);
    console.log(
        "[github-scaleway-windows-runner] Waiting for server to become ready..."
    );
    const { ip } = await waitForInstanceReady({
        secretKey,
        zone,
        serverId,
        tracker,
        trackerKey: key,
    });

    if (!enableSsh) {
        fail(
            "Windows runner bootstrap requires SSH. Set PEERBIT_WINDOWS_ENABLE_SSH=1."
        );
    }

    const sshWaitMs = getEnvInt(
        "PEERBIT_WINDOWS_SSH_READY_TIMEOUT_MS",
        10 * 60 * 1000
    );
    const sshPollMs = getEnvInt("PEERBIT_WINDOWS_SSH_READY_POLL_MS", 5000);
    console.log(
        `[github-scaleway-windows-runner] Waiting for SSH to become reachable (timeout ${Math.round(sshWaitMs / 60000)}m)...`
    );
    await waitForTcpPort({
        host: ip,
        port: 22,
        timeoutMs: sshWaitMs,
        pollMs: sshPollMs,
        label: "ssh",
    });

    console.log(
        "[github-scaleway-windows-runner] Requesting GitHub runner registration token..."
    );
    let runnerToken = "";
    try {
        runnerToken = await getRunnerRegistrationToken(
            tokens,
            repoInfo.owner,
            repoInfo.repo
        );
    } catch (error) {
        const hint = explainPatAccessIssue(error);
        if (hint) fail(hint);
        throw error;
    }

    const script = renderUserData(readUserDataTemplate(), {
        RUNNER_VERSION: escapePowerShell(runnerVersion),
        REPO_URL: escapePowerShell(repoUrl),
        RUNNER_TOKEN: escapePowerShell(runnerToken),
        RUNNER_NAME: escapePowerShell(runnerName),
        RUNNER_LABELS: escapePowerShell(runnerLabels),
        RUNNER_EPHEMERAL: ephemeral ? "1" : "",
        RUNNER_RECONFIGURE: forceReconfigure ? "1" : "",
        ENABLE_SSH: enableSsh ? "1" : "",
        SSH_AUTHORIZED_KEY: escapePowerShell(sshAuthorizedKey),
        SSH_REMOTE_ADDRESS: escapePowerShell(sshRemoteAddress),
        ENABLE_WINRM: enableWinrm ? "1" : "",
        WINRM_REMOTE_ADDRESS: escapePowerShell(winrmRemoteAddress),
        SKIP_DEPENDENCIES: skipDependencies ? "1" : "",
        SKIP_HEAVY_DEPENDENCIES: skipHeavyDependencies ? "1" : "",
    });

    console.log(
        "[github-scaleway-windows-runner] Bootstrapping runner over SSH..."
    );
    runPowerShellOverSsh({ host: ip, script });

    const registerWaitMs = getEnvInt(
        "PEERBIT_RUNNER_REGISTER_TIMEOUT_MS",
        10 * 60 * 1000
    );
    const registerPollMs = getEnvInt("PEERBIT_RUNNER_REGISTER_POLL_MS", 5000);
    console.log(
        `[github-scaleway-windows-runner] Waiting for runner to register and come online with GitHub (timeout ${Math.round(registerWaitMs / 60000)}m)...`
    );
    const runner = await waitForRunnerOnline({
        tokens,
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        runnerName,
        timeoutMs: registerWaitMs,
        pollMs: registerPollMs,
    });

    tracker.track(key, { ...(tracker.list()[key] || {}), runnerId: runner.id });
    console.log(
        `[github-scaleway-windows-runner] Runner online (id ${runner.id}, name ${runnerName}).`
    );
    writeGitHubOutput({
        runner_id: runner.id,
        runner_name: runnerName,
        runner_labels: runnerLabels,
    });
    console.log(
        "Next: pnpm scaleway:windows:enable (routes workflows to self-hosted runners)."
    );
}

async function bootstrapRunner(repoInfo) {
    const tokens = getGitHubTokens();
    if (tokens.length === 0) {
        fail(
            "Missing GitHub auth. Set GH_TOKEN/GITHUB_TOKEN, or run `gh auth login`."
        );
    }

    const tracker = new ProcessTracker("github-scaleway-windows-runner.json");
    const key = `${repoInfo.owner}/${repoInfo.repo}`;
    const state = tracker.list()[key] || null;
    if (!state) {
        fail(
            `No tracked Scaleway Windows runner for ${key}. Run pnpm scaleway:windows:start first.`
        );
    }

    const secretKey = getScalewaySecretKey();
    const zone = String(
        state.zone || process.env.SCALEWAY_ZONE || DEFAULT_ZONE
    ).trim();
    const serverId = String(state.serverId || "").trim();
    if (!serverId) {
        fail(
            "Tracked runner is missing serverId; run pnpm scaleway:windows:stop then start again."
        );
    }

    const runnerVersion = String(
        state.runnerVersion ||
            process.env.PEERBIT_GITHUB_RUNNER_VERSION ||
            DEFAULT_RUNNER_VERSION
    ).trim();
    const runnerLabels = String(
        state.runnerLabels ||
            process.env.PEERBIT_RUNNER_LABELS ||
            "peerbit,scaleway"
    ).trim();
    const runnerName = String(state.runnerName || "").trim();
    const ephemeral =
        String(
            state.ephemeral ?? process.env.PEERBIT_RUNNER_EPHEMERAL ?? "1"
        ).trim() !== "0";
    const forceReconfigure =
        Boolean(state.reuseServer) ||
        String(process.env.PEERBIT_RUNNER_RECONFIGURE || "").trim() === "1";
    const repoUrl = String(
        state.repoUrl || `https://github.com/${repoInfo.owner}/${repoInfo.repo}`
    ).trim();

    const enableSsh =
        String(process.env.PEERBIT_WINDOWS_ENABLE_SSH || "1").trim() !== "0";
    const enableWinrm =
        String(process.env.PEERBIT_WINDOWS_ENABLE_WINRM || "").trim() === "1";
    const skipDependencies =
        String(process.env.PEERBIT_WINDOWS_SKIP_DEPENDENCIES || "").trim() ===
        "1";
    const skipHeavyDependencies =
        String(
            process.env.PEERBIT_WINDOWS_SKIP_HEAVY_DEPENDENCIES || ""
        ).trim() === "1";
    const publicKey = detectPublicKey();
    const sshAuthorizedKey =
        String(process.env.PEERBIT_SCALEWAY_SSH_AUTHORIZED_KEY || "").trim() ||
        publicKey;
    let sshRemoteAddress = String(
        process.env.PEERBIT_WINDOWS_SSH_REMOTE_ADDRESS || ""
    ).trim();
    let winrmRemoteAddress = String(
        process.env.PEERBIT_WINDOWS_WINRM_REMOTE_ADDRESS || ""
    ).trim();

    if (
        (enableSsh && !sshRemoteAddress) ||
        (enableWinrm && !winrmRemoteAddress)
    ) {
        const auto = await detectPublicIp();
        if (!sshRemoteAddress) sshRemoteAddress = auto;
        if (!winrmRemoteAddress) winrmRemoteAddress = auto;
    }

    if (enableSsh && !sshRemoteAddress) {
        console.warn(
            "[github-scaleway-windows-runner] Warning: could not auto-detect your public IP; set PEERBIT_WINDOWS_SSH_REMOTE_ADDRESS to enable SSH firewall access."
        );
    }

    if (!runnerName) {
        fail(
            "Tracked runner is missing runnerName; run pnpm scaleway:windows:stop then start again."
        );
    }

    const force = String(process.env.PEERBIT_FORCE || "").trim() === "1";
    if (tokens.length > 0 && !force) {
        try {
            const runners = await listRunners(
                tokens,
                repoInfo.owner,
                repoInfo.repo
            );
            const match =
                (state.runnerId &&
                    runners.find((runner) => runner?.id === state.runnerId)) ||
                (runnerName &&
                    runners.find((runner) => runner?.name === runnerName)) ||
                null;
            if (match?.id && !state.runnerId) {
                tracker.track(key, {
                    ...(tracker.list()[key] || {}),
                    runnerId: match.id,
                });
            }
            if (match?.busy) {
                fail(
                    "Runner is currently busy. Set PEERBIT_FORCE=1 to bootstrap anyway (will interrupt the job)."
                );
            }
        } catch (error) {
            console.warn(
                `[github-scaleway-windows-runner] Warning: could not query GitHub runner status (${error instanceof Error ? error.message : String(error)}).`
            );
        }
    }

    if (!enableSsh) {
        fail(
            "Windows runner bootstrap requires SSH. Set PEERBIT_WINDOWS_ENABLE_SSH=1."
        );
    }

    const server = await getInstanceServer(secretKey, zone, serverId);
    const host =
        extractServerPublicIp(server) || extractServerHost(server) || "";
    if (host) {
        tracker.track(key, {
            ...(tracker.list()[key] || {}),
            serverHost: host,
        });
    }
    if (!host) {
        fail(
            "Could not determine server public IP. Check Scaleway console and re-run status."
        );
    }

    const sshWaitMs = getEnvInt(
        "PEERBIT_WINDOWS_SSH_READY_TIMEOUT_MS",
        10 * 60 * 1000
    );
    const sshPollMs = getEnvInt("PEERBIT_WINDOWS_SSH_READY_POLL_MS", 5000);
    console.log(
        `[github-scaleway-windows-runner] Waiting for SSH to become reachable (timeout ${Math.round(sshWaitMs / 60000)}m)...`
    );
    await waitForTcpPort({
        host,
        port: 22,
        timeoutMs: sshWaitMs,
        pollMs: sshPollMs,
        label: "ssh",
    });

    console.log(
        "[github-scaleway-windows-runner] Requesting GitHub runner registration token..."
    );
    let runnerToken = "";
    try {
        runnerToken = await getRunnerRegistrationToken(
            tokens,
            repoInfo.owner,
            repoInfo.repo
        );
    } catch (error) {
        const hint = explainPatAccessIssue(error);
        if (hint) fail(hint);
        throw error;
    }

    const script = renderUserData(readUserDataTemplate(), {
        RUNNER_VERSION: escapePowerShell(runnerVersion),
        REPO_URL: escapePowerShell(repoUrl),
        RUNNER_TOKEN: escapePowerShell(runnerToken),
        RUNNER_NAME: escapePowerShell(runnerName),
        RUNNER_LABELS: escapePowerShell(runnerLabels),
        RUNNER_EPHEMERAL: ephemeral ? "1" : "",
        RUNNER_RECONFIGURE: forceReconfigure ? "1" : "",
        ENABLE_SSH: enableSsh ? "1" : "",
        SSH_AUTHORIZED_KEY: escapePowerShell(sshAuthorizedKey),
        SSH_REMOTE_ADDRESS: escapePowerShell(sshRemoteAddress),
        ENABLE_WINRM: enableWinrm ? "1" : "",
        WINRM_REMOTE_ADDRESS: escapePowerShell(winrmRemoteAddress),
        SKIP_DEPENDENCIES: skipDependencies ? "1" : "",
        SKIP_HEAVY_DEPENDENCIES: skipHeavyDependencies ? "1" : "",
    });

    console.log(
        "[github-scaleway-windows-runner] Bootstrapping runner over SSH..."
    );
    runPowerShellOverSsh({ host, script });

    const registerWaitMs = getEnvInt(
        "PEERBIT_RUNNER_REGISTER_TIMEOUT_MS",
        10 * 60 * 1000
    );
    const registerPollMs = getEnvInt("PEERBIT_RUNNER_REGISTER_POLL_MS", 5000);
    console.log(
        `[github-scaleway-windows-runner] Waiting for runner to register and come online with GitHub (timeout ${Math.round(registerWaitMs / 60000)}m)...`
    );
    const runner = await waitForRunnerOnline({
        tokens,
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        runnerName,
        timeoutMs: registerWaitMs,
        pollMs: registerPollMs,
    });

    tracker.track(key, { ...(tracker.list()[key] || {}), runnerId: runner.id });
    console.log(
        `[github-scaleway-windows-runner] Runner online (id ${runner.id}, name ${runnerName}).`
    );
    writeGitHubOutput({
        runner_id: runner.id,
        runner_name: runnerName,
        runner_labels: runnerLabels,
    });
    console.log(
        "Next: pnpm scaleway:windows:enable (routes workflows to self-hosted runners)."
    );
}

async function stopRunner(repoInfo) {
    const tokens = getGitHubTokens();

    const tracker = new ProcessTracker("github-scaleway-windows-runner.json");
    const key = `${repoInfo.owner}/${repoInfo.repo}`;
    const state = tracker.list()[key] || null;
    if (!state) {
        fail(`No tracked Scaleway Windows runner for ${key}.`);
    }

    const secretKey = getScalewaySecretKey();
    const force = String(process.env.PEERBIT_FORCE || "").trim() === "1";

    let runnerBusy = false;
    let resolvedRunnerId = state.runnerId;
    if (tokens.length > 0) {
        try {
            const runners = await listRunners(
                tokens,
                repoInfo.owner,
                repoInfo.repo
            );
            const match =
                (resolvedRunnerId &&
                    runners.find(
                        (runner) => runner?.id === resolvedRunnerId
                    )) ||
                (state.runnerName &&
                    runners.find(
                        (runner) => runner?.name === state.runnerName
                    )) ||
                null;
            if (match?.id) resolvedRunnerId = match.id;
            runnerBusy = Boolean(match?.busy);
        } catch (error) {
            console.warn(
                `[github-scaleway-windows-runner] Warning: could not query GitHub runner status (${error instanceof Error ? error.message : String(error)}).`
            );
        }
    }

    if (runnerBusy && !force) {
        fail(
            "Runner is currently busy. Set PEERBIT_FORCE=1 to stop anyway (will interrupt the job)."
        );
    }

    let deletedServer = false;
    const releaseReusableServer =
        Boolean(state.reuseServer) &&
        String(
            process.env.PEERBIT_SCALEWAY_WINDOWS_DELETE_REUSABLE ||
                process.env.PEERBIT_SCALEWAY_DELETE_REUSABLE ||
                ""
        ).trim() !== "1";
    if (state.serverId && state.zone) {
        const zone = String(state.zone).trim();
        const serverId = String(state.serverId).trim();

        console.log(
            `[github-scaleway-windows-runner] Powering off Scaleway server ${serverId}...`
        );
        try {
            await runInstanceAction(secretKey, zone, serverId, "poweroff");
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            console.warn(
                `[github-scaleway-windows-runner] Warning: could not send poweroff (${message}).`
            );
        }

        try {
            await waitForInstanceStopped({ secretKey, zone, serverId });
        } catch (error) {
            console.warn(
                `[github-scaleway-windows-runner] Warning: server did not reach stopped state (${error instanceof Error ? error.message : String(error)}).`
            );
        }

        if (releaseReusableServer) {
            console.log(
                `[github-scaleway-windows-runner] Keeping reusable Scaleway server ${serverId} powered off; janitor will delete stale pool hosts.`
            );
        } else {
            console.log(
                `[github-scaleway-windows-runner] Deleting Scaleway server ${serverId}...`
            );
            try {
                await scalewayJson(
                    secretKey,
                    "DELETE",
                    `/instance/v1/zones/${encodeURIComponent(zone)}/servers/${encodeURIComponent(serverId)}`
                );
                deletedServer = true;
            } catch (error) {
                console.warn(
                    `[github-scaleway-windows-runner] Warning: could not delete Scaleway server (${error instanceof Error ? error.message : String(error)}).`
                );
            }
        }
    } else {
        console.warn(
            "[github-scaleway-windows-runner] No server id/zone found in state; skipping Scaleway delete."
        );
    }

    if (tokens.length > 0 && resolvedRunnerId) {
        try {
            console.log(
                `[github-scaleway-windows-runner] Removing GitHub runner registration ${resolvedRunnerId}...`
            );
            await deleteRunner(
                tokens,
                repoInfo.owner,
                repoInfo.repo,
                resolvedRunnerId
            );
        } catch (error) {
            console.warn(
                `[github-scaleway-windows-runner] Warning: could not remove runner registration (${error instanceof Error ? error.message : String(error)}).`
            );
        }
    } else if (!resolvedRunnerId) {
        console.log(
            "[github-scaleway-windows-runner] No runner id found; skipping runner deregistration."
        );
    } else {
        console.log(
            "[github-scaleway-windows-runner] No GitHub auth found; skipping runner deregistration."
        );
    }

    if (
        deletedServer ||
        releaseReusableServer ||
        String(process.env.PEERBIT_FORCE_UNTRACK || "").trim() === "1"
    ) {
        tracker.untrack(key);
        console.log("[github-scaleway-windows-runner] Runner stopped.");
    } else {
        console.log(
            "[github-scaleway-windows-runner] Runner state kept because the server was not deleted. Re-run stop later, or set PEERBIT_FORCE_UNTRACK=1 to forget it."
        );
    }
}

async function statusRunner(repoInfo) {
    const tokens = getGitHubTokens();

    const tracker = new ProcessTracker("github-scaleway-windows-runner.json");
    const key = `${repoInfo.owner}/${repoInfo.repo}`;
    const state = tracker.list()[key] || null;
    if (!state) {
        console.log(
            `[github-scaleway-windows-runner] No tracked Scaleway Windows runner for ${key}.`
        );
        process.exitCode = 1;
        return;
    }

    console.log(`[github-scaleway-windows-runner] ${key}`);
    console.log(
        `- Server: ${state.serverName || "unknown"} (id ${state.serverId || "unknown"})`
    );
    console.log(`- Zone: ${state.zone || "unknown"}`);
    console.log(`- Type: ${state.serverType || "unknown"}`);
    console.log(`- Image: ${state.image || "unknown"}`);
    if (state.serverHost) {
        console.log(`- Host: ${state.serverHost}`);
    }
    console.log(
        `- Runner: ${state.runnerName || "unknown"} (id ${state.runnerId || "unknown"})`
    );
    console.log(`- Labels: ${state.runnerLabels || "unknown"}`);
    console.log("");

    let resolvedHost = String(state.serverHost || "").trim();
    if (state.serverId && state.zone) {
        const secretKey = getScalewaySecretKey();
        try {
            const server = extractServer(
                await scalewayJson(
                    secretKey,
                    "GET",
                    `/instance/v1/zones/${encodeURIComponent(state.zone)}/servers/${encodeURIComponent(state.serverId)}`
                )
            );
            const status = extractServerStatus(server);
            const host = extractServerHost(server);
            if (host && !resolvedHost) resolvedHost = host;
            const encrypted = server?.admin_password_encrypted_value
                ? "yes"
                : "no";
            console.log(
                `[scaleway] status=${status}${host ? ` host=${host}` : ""} admin_password_encrypted=${encrypted}`
            );
        } catch (error) {
            console.log(
                `[scaleway] server lookup failed (${error instanceof Error ? error.message : String(error)})`
            );
        }
    }

    if (resolvedHost) {
        try {
            await waitForTcpPort({
                host: resolvedHost,
                port: 22,
                timeoutMs: 1500,
                pollMs: 500,
                label: "ssh",
            });
            console.log("[ssh] port=22 reachable");
        } catch {
            console.log("[ssh] port=22 unreachable");
        }
    }

    if (tokens.length > 0) {
        try {
            const runners = await listRunners(
                tokens,
                repoInfo.owner,
                repoInfo.repo
            );
            const match =
                (state.runnerId &&
                    runners.find((runner) => runner?.id === state.runnerId)) ||
                (state.runnerName &&
                    runners.find(
                        (runner) => runner?.name === state.runnerName
                    )) ||
                null;
            if (match) {
                console.log(
                    `[github] status=${match.status} busy=${match.busy ? "true" : "false"}`
                );
            } else {
                console.log("[github] runner not found");
            }
        } catch (error) {
            console.log(
                `[github] runner lookup failed (${error instanceof Error ? error.message : String(error)})`
            );
        }
    } else {
        console.log(
            "[github] no token available (set GH_TOKEN/GITHUB_TOKEN or run `gh auth login`)"
        );
    }
}

async function enableSelfHosted(repoInfo) {
    const tokens = getGitHubTokens();
    if (tokens.length === 0) {
        fail(
            "Missing GitHub auth. Set GH_TOKEN/GITHUB_TOKEN, or run `gh auth login`."
        );
    }
    const name = "PEERBIT_WINDOWS_RUNS_ON";
    const value = "self-hosted";
    let result = "";
    try {
        result = await upsertRepoVariable(
            tokens,
            repoInfo.owner,
            repoInfo.repo,
            name,
            value
        );
    } catch (error) {
        const hint = explainPatAccessIssue(error);
        if (hint) fail(hint);
        throw error;
    }
    console.log(
        `[github-scaleway-windows-runner] ${result} repo variable ${name}=${value} for ${repoInfo.owner}/${repoInfo.repo}.`
    );
    console.log(
        "[github-scaleway-windows-runner] Note: linux/macos self-hosted routing is controlled by PEERBIT_RUNS_ON."
    );
}

async function disableSelfHosted(repoInfo) {
    const tokens = getGitHubTokens();
    if (tokens.length === 0) {
        fail(
            "Missing GitHub auth. Set GH_TOKEN/GITHUB_TOKEN, or run `gh auth login`."
        );
    }
    const name = "PEERBIT_WINDOWS_RUNS_ON";
    try {
        await deleteRepoVariable(tokens, repoInfo.owner, repoInfo.repo, name);
    } catch (error) {
        const hint = explainPatAccessIssue(error);
        if (hint) fail(hint);
        throw error;
    }
    console.log(
        `[github-scaleway-windows-runner] Removed repo variable ${name} for ${repoInfo.owner}/${repoInfo.repo} (Windows jobs will use GitHub-hosted runners).`
    );
}

async function writeAdminPassword(repoInfo) {
    const tracker = new ProcessTracker("github-scaleway-windows-runner.json");
    const key = `${repoInfo.owner}/${repoInfo.repo}`;
    const state = tracker.list()[key] || null;
    if (!state) {
        fail(
            `No tracked Scaleway Windows runner for ${key}. Run pnpm scaleway:windows:start first.`
        );
    }

    const zone = String(
        state.zone || process.env.SCALEWAY_ZONE || DEFAULT_ZONE
    ).trim();
    const serverId = String(state.serverId || "").trim();
    if (!serverId) {
        fail(
            "Tracked runner is missing serverId; run pnpm scaleway:windows:stop then start again."
        );
    }

    const secretKey = getScalewaySecretKey();
    const server = await getInstanceServer(secretKey, zone, serverId);
    const encrypted = String(
        server?.admin_password_encrypted_value || ""
    ).trim();
    if (!encrypted) {
        fail(
            [
                "Scaleway did not return admin_password_encrypted_value for this instance.",
                "This usually means the instance was not created with admin_password_encryption_ssh_key_id, or the image/type does not support it.",
            ].join("\n")
        );
    }

    const identityFile = detectIdentityFile();
    if (!identityFile) {
        fail(
            [
                "No RSA private key found for decrypting the Windows Administrator password.",
                "Set PEERBIT_SCALEWAY_SSH_IDENTITY_FILE=~/.ssh/peerbit_scaleway_rsa (or point to the RSA key you used for admin password encryption).",
            ].join("\n")
        );
    }

    const repoRoot = getRepoRoot();
    const outDir = path.join(repoRoot, "tmp", "scaleway-windows");
    ensureDir(outDir);

    const encryptedPath = path.join(outDir, "admin-password.b64");
    fs.writeFileSync(encryptedPath, `${encrypted}\n`, "utf8");

    const workDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "peerbit-scaleway-key-")
    );
    const tmpKeyPath = path.join(workDir, "key");
    fs.copyFileSync(identityFile, tmpKeyPath);

    // Node 22+ / OpenSSL 3 restricts PKCS#1 v1.5 privateDecrypt, so we use openssl pkeyutl.
    // Convert OpenSSH private key format to PEM if needed.
    try {
        runCapture("ssh-keygen", [
            "-p",
            "-m",
            "PEM",
            "-f",
            tmpKeyPath,
            "-N",
            "",
            "-P",
            "",
        ]);
    } catch (error) {
        fail(
            `Failed to convert RSA key to PEM for openssl. Ensure ${identityFile} is an RSA private key (ssh-keygen -t rsa).\n${error instanceof Error ? error.message : String(error)}`
        );
    }

    const encBytes = Buffer.from(encrypted, "base64");
    const encBinPath = path.join(workDir, "enc.bin");
    fs.writeFileSync(encBinPath, encBytes);

    const passwordPath = path.join(outDir, "admin-password.txt");
    try {
        runCapture("openssl", [
            "pkeyutl",
            "-decrypt",
            "-inkey",
            tmpKeyPath,
            "-pkeyopt",
            "rsa_padding_mode:pkcs1",
            "-in",
            encBinPath,
            "-out",
            passwordPath,
        ]);
    } catch (error) {
        fail(
            `Failed to decrypt admin password with openssl. Ensure the RSA key matches the SSH key used for admin password encryption.\n${error instanceof Error ? error.message : String(error)}`
        );
    } finally {
        try {
            fs.rmSync(workDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
    }

    try {
        fs.chmodSync(passwordPath, 0o600);
    } catch {
        // best-effort on non-posix fs
    }

    const host = String(
        state.serverHost || extractServerHost(server) || ""
    ).trim();
    console.log(
        `[github-scaleway-windows-runner] Saved Administrator password to ${path.relative(repoRoot, passwordPath)}`
    );
    if (host) {
        console.log(
            `[github-scaleway-windows-runner] RDP: ${host}:3389 (user: Administrator)`
        );
    }
    console.log(
        "[github-scaleway-windows-runner] Note: do not commit tmp/scaleway-windows/* (contains sensitive data)."
    );
}

function parseTimestamp(value) {
    const timestamp = Date.parse(String(value || ""));
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function serverCreatedAt(server) {
    return (
        parseTimestamp(server?.created_at) ||
        parseTimestamp(server?.creation_date) ||
        parseTimestamp(server?.createdAt) ||
        parseTimestamp(server?.created)
    );
}

async function janitor(repoInfo) {
    const secretKey = getScalewaySecretKey();
    const tokens = getGitHubTokens();
    const zone = (process.env.SCALEWAY_ZONE || DEFAULT_ZONE).trim();
    const maxAgeMs = getEnvInt(
        "PEERBIT_SCALEWAY_JANITOR_MAX_AGE_MS",
        2 * 60 * 60 * 1000
    );
    const cutoff = Date.now() - maxAgeMs;
    const prefix = sanitizeName(`peerbit-gh-runner-windows-${repoInfo.repo}-`);

    const data = await scalewayJson(
        secretKey,
        "GET",
        `/instance/v1/zones/${encodeURIComponent(zone)}/servers?per_page=100`
    );
    const servers = Array.isArray(data?.servers) ? data.servers : [];
    for (const raw of servers) {
        const server = extractServer(raw);
        const name = String(server?.name || "");
        const id = String(server?.id || "");
        const createdAt = serverCreatedAt(server);
        if (
            !id ||
            !name.startsWith(prefix) ||
            (createdAt && createdAt > cutoff)
        )
            continue;
        console.log(
            `[github-scaleway-windows-runner] Janitor deleting stale Windows server ${name} (${id})...`
        );
        try {
            await runInstanceAction(secretKey, zone, id, "poweroff");
        } catch {
            // best effort before delete
        }
        try {
            await scalewayJson(
                secretKey,
                "DELETE",
                `/instance/v1/zones/${encodeURIComponent(zone)}/servers/${encodeURIComponent(id)}`
            );
        } catch (error) {
            console.warn(
                `[github-scaleway-windows-runner] Warning: could not delete ${name}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    if (tokens.length === 0) return;
    const runnerPrefixes = [
        sanitizeName(`peerbit-selfhosted-scaleway-windows-${repoInfo.repo}-`),
        sanitizeName(`peerbit-win-${repoInfo.repo}-`),
    ];
    const runners = await listRunners(tokens, repoInfo.owner, repoInfo.repo);
    for (const runner of runners) {
        const name = String(runner?.name || "");
        if (
            !runner?.id ||
            !runnerPrefixes.some((prefix) => name.startsWith(prefix)) ||
            runner?.busy ||
            runner?.status !== "offline"
        )
            continue;
        console.log(
            `[github-scaleway-windows-runner] Janitor removing offline GitHub runner ${name} (${runner.id})...`
        );
        await deleteRunner(tokens, repoInfo.owner, repoInfo.repo, runner.id);
    }
}

async function main() {
    loadGitHubEnv();
    loadScalewayEnv();

    const [command = "help"] = process.argv.slice(2);
    const repoInfo = detectRepoFromGit();
    if (!repoInfo) {
        fail(
            "Could not detect GitHub repo from git remote origin. Run from a cloned GitHub repo with origin set."
        );
    }

    if (command === "help" || command === "--help" || command === "-h") {
        usage();
        process.exitCode = 1;
        return;
    }

    switch (command) {
        case "start":
            await startRunner(repoInfo);
            return;
        case "bootstrap":
            await bootstrapRunner(repoInfo);
            return;
        case "stop":
            await stopRunner(repoInfo);
            return;
        case "status":
            await statusRunner(repoInfo);
            return;
        case "images": {
            const secretKey = getScalewaySecretKey();
            const zone = (process.env.SCALEWAY_ZONE || DEFAULT_ZONE).trim();
            const projectId = await resolveProjectId(secretKey);
            await listWindowsImages(secretKey, zone, projectId);
            return;
        }
        case "enable":
            await enableSelfHosted(repoInfo);
            return;
        case "disable":
            await disableSelfHosted(repoInfo);
            return;
        case "admin-password":
            await writeAdminPassword(repoInfo);
            return;
        case "janitor":
            await janitor(repoInfo);
            return;
        default:
            usage();
            fail(`Unknown command: ${command}`);
    }
}

main().catch((error) => {
    console.error(
        error instanceof Error ? (error.stack ?? error.message) : error
    );
    process.exitCode = 1;
});
