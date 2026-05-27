#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
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
    findRunnerId,
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
const DEFAULT_SERVER_TYPE = "M2-M";

function fail(message) {
    console.error(`[github-scaleway-runner] ${message}`);
    process.exit(1);
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
    console.log("GitHub Actions runner helpers (Scaleway Apple Silicon macOS)");
    console.log("");
    console.log("Usage:");
    console.log("  pnpm scaleway:start");
    console.log("  pnpm scaleway:bootstrap");
    console.log("  pnpm scaleway:stop");
    console.log("  pnpm scaleway:status");
    console.log("  pnpm scaleway:janitor");
    console.log("");
    console.log("Required tooling:");
    console.log("  - GitHub token: GH_TOKEN/GITHUB_TOKEN or `gh auth login`");
    console.log(
        "  - Scaleway credentials: ACCESS_KEY_ID + SECRET_ACCESS_KEY (see .env.scaleway.example)"
    );
    console.log("");
    console.log("Env overrides:");
    console.log("  SCALEWAY_ZONE=fr-par-1                (default: fr-par-1)");
    console.log("  SCALEWAY_SERVER_TYPE=M2-M             (default: M2-M)");
    console.log(
        "  SCALEWAY_PROJECT_ID=<uuid>            (optional; otherwise resolved from the API key default_project_id)"
    );
    console.log(
        "  PEERBIT_SCALEWAY_SSH_KEY_ID=<uuid>    (optional; otherwise creates/reuses a Scaleway SSH key in the project)"
    );
    console.log("  PEERBIT_SCALEWAY_SSH_KEY_NAME=peerbit-gh-runner");
    console.log(
        "  PEERBIT_SCALEWAY_SSH_PUBLIC_KEY=...   (otherwise reads ~/.ssh/*.pub)"
    );
    console.log(
        "  PEERBIT_SCALEWAY_SSH_IDENTITY_FILE=~/.ssh/id_ed25519 (optional; used for ssh bootstrap)"
    );
    console.log(
        "  PEERBIT_SCALEWAY_SSH_USER=m1          (optional; defaults to Scaleway-reported ssh_username)"
    );
    console.log("  PEERBIT_SCALEWAY_SSH_PORT=22          (default: 22)");
    console.log("  PEERBIT_GITHUB_RUNNER_VERSION=2.330.0");
    console.log("  PEERBIT_RUNNER_LABELS=peerbit,scaleway");
    console.log(
        "  PEERBIT_RUNNER_EPHEMERAL=1             (default: 1; runner accepts one job)"
    );
    console.log(
        "  PEERBIT_SCALEWAY_ENABLE_KEXT=1         (default: 1; required for macFUSE)"
    );
    console.log(
        "  PEERBIT_SCALEWAY_REUSE_SERVER=0        (set 1 to reuse a warm Mac host)"
    );
    console.log(
        "  PEERBIT_SCALEWAY_REUSE_POOL=shared-fs  (stable pool name when reusing)"
    );
    console.log(
        "  PEERBIT_SCALEWAY_DELETE_REUSABLE=0     (set 1 to delete reused host in stop)"
    );
    console.log(
        "  PEERBIT_SCALEWAY_JANITOR_MAX_AGE_MS=93600000 (default: 26h)"
    );
    console.log(
        "  PEERBIT_FORCE=1                        (allow stop while runner busy)"
    );
    console.log("");
    console.log("Notes:");
    console.log(
        "  - Apple Silicon servers have minimum lease durations; stopping may still incur charges."
    );
}

function writeGitHubOutput(values) {
    const filePath = String(process.env.GITHUB_OUTPUT || "").trim();
    if (!filePath) return;
    const body = Object.entries(values)
        .map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, " ")}`)
        .join("\n");
    fs.appendFileSync(filePath, `${body}\n`, "utf-8");
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getEnvInt(name, fallback) {
    const raw = String(process.env[name] || "").trim();
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
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

async function scalewayRequest(secretKey, method, endpoint, body) {
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
    const data = await scalewayRequest(
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

function detectPublicKey() {
    const fromEnv = (process.env.PEERBIT_SCALEWAY_SSH_PUBLIC_KEY || "").trim();
    const explicitIdentityFile = (
        process.env.PEERBIT_SCALEWAY_SSH_IDENTITY_FILE || ""
    ).trim();
    if (fromEnv) {
        return {
            publicKey: fromEnv,
            identityFile: explicitIdentityFile || null,
        };
    }

    if (explicitIdentityFile) {
        try {
            const raw = fs
                .readFileSync(`${explicitIdentityFile}.pub`, "utf-8")
                .trim();
            if (raw) {
                return {
                    publicKey: raw,
                    identityFile: explicitIdentityFile,
                };
            }
        } catch {
            // ignore
        }
    }

    const home = process.env.HOME || os.homedir();
    const candidates = [
        path.join(home, ".ssh", "id_ed25519.pub"),
        path.join(home, ".ssh", "id_rsa.pub"),
        path.join(home, ".ssh", "id_ecdsa.pub"),
        path.join(home, ".ssh", "id_dsa.pub"),
    ];

    for (const candidate of candidates) {
        try {
            const raw = fs.readFileSync(candidate, "utf-8").trim();
            if (!raw) continue;

            const identityFile = candidate.endsWith(".pub")
                ? candidate.slice(0, -".pub".length)
                : null;
            if (identityFile) {
                try {
                    fs.accessSync(identityFile, fs.constants.R_OK);
                    return { publicKey: raw, identityFile };
                } catch {
                    return { publicKey: raw, identityFile: null };
                }
            }

            return { publicKey: raw, identityFile: null };
        } catch {
            // ignore
        }
    }

    return { publicKey: "", identityFile: null };
}

function normalizeSshPublicKey(value) {
    const parts = String(value || "")
        .trim()
        .split(/\s+/);
    return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : parts.join(" ");
}

async function ensureScalewaySshKey(secretKey, projectId) {
    const explicitId = String(
        process.env.PEERBIT_SCALEWAY_SSH_KEY_ID || ""
    ).trim();
    if (explicitId) return explicitId;

    const keyName = (
        process.env.PEERBIT_SCALEWAY_SSH_KEY_NAME || "peerbit-gh-runner"
    ).trim();
    const keyMaterial = detectPublicKey();
    const publicKey = keyMaterial.publicKey;
    if (!publicKey) {
        fail(
            [
                "No SSH public key found.",
                "Provide PEERBIT_SCALEWAY_SSH_PUBLIC_KEY, or create ~/.ssh/id_ed25519.pub, or set PEERBIT_SCALEWAY_SSH_KEY_ID to use an existing Scaleway SSH key.",
            ].join("\n")
        );
    }
    const normalizedPublicKey = normalizeSshPublicKey(publicKey);

    const list = await scalewayRequest(
        secretKey,
        "GET",
        `/iam/v1alpha1/ssh-keys?project_id=${encodeURIComponent(projectId)}`
    );
    const keys = Array.isArray(list?.ssh_keys) ? list.ssh_keys : [];
    const match =
        keys.find(
            (item) =>
                normalizeSshPublicKey(item?.public_key) === normalizedPublicKey
        ) ||
        keys.find((item) => String(item?.name || "").trim() === keyName) ||
        null;
    if (match?.id) return match.id;

    const created = await scalewayRequest(
        secretKey,
        "POST",
        "/iam/v1alpha1/ssh-keys",
        {
            project_id: projectId,
            name: keyName,
            public_key: normalizedPublicKey,
        }
    );
    const id = String(created?.id || "").trim();
    if (!id) {
        throw new Error("Scaleway API did not return ssh key id");
    }
    return id;
}

async function resolveOsId(secretKey, zone, serverType) {
    const override = (process.env.SCALEWAY_OS_ID || "").trim();
    if (override) return override;

    const data = await scalewayRequest(
        secretKey,
        "GET",
        `/apple-silicon/v1alpha1/zones/${encodeURIComponent(zone)}/server-types`
    );
    const types = Array.isArray(data?.server_types) ? data.server_types : [];
    const match =
        types.find((item) => String(item?.name || "").trim() === serverType) ||
        null;
    const osId = String(match?.default_os?.id || "").trim();
    if (!osId) {
        fail(
            `Could not resolve default OS id for ${serverType} in ${zone}. Set SCALEWAY_OS_ID to override.`
        );
    }
    return osId;
}

function extractServerId(data) {
    if (!data) return "";
    if (typeof data?.id === "string") return data.id;
    if (typeof data?.server?.id === "string") return data.server.id;
    return "";
}

function extractServerName(data) {
    if (!data) return "";
    if (typeof data?.name === "string") return data.name;
    if (typeof data?.server?.name === "string") return data.server.name;
    return "";
}

function extractServerStatus(server) {
    const candidates = [server?.status, server?.state, server?.phase]
        .map((value) => String(value || "").trim())
        .filter(Boolean);
    return candidates[0] || "unknown";
}

function extractSshUsername(server) {
    const value = String(server?.ssh_username || "").trim();
    return value || "";
}

function extractSudoPassword(server) {
    const value = String(server?.sudo_password || "").trim();
    return value || "";
}

function extractServerHost(server) {
    const candidates = [
        server?.public_ip?.address,
        server?.public_ip?.ip,
        server?.public_ip,
        server?.ip?.address,
        server?.ip,
        server?.ip_address,
        server?.hostname,
    ]
        .map((value) => String(value || "").trim())
        .filter(Boolean);
    return candidates[0] || "";
}

function resolveIdentityFile() {
    const explicit = (
        process.env.PEERBIT_SCALEWAY_SSH_IDENTITY_FILE || ""
    ).trim();
    if (explicit) return explicit;
    const detected = detectPublicKey();
    return detected.identityFile || "";
}

function sshRun({ host, port, user, script }) {
    const identityFile = resolveIdentityFile();
    const target = user ? `${user}@${host}` : host;
    const args = [
        "-p",
        String(port),
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "IdentityAgent=none",
        "-o",
        "BatchMode=yes",
        "-o",
        "PreferredAuthentications=publickey",
        "-o",
        "PasswordAuthentication=no",
        "-o",
        "KbdInteractiveAuthentication=no",
    ];
    if (identityFile) {
        args.push("-i", identityFile);
    }
    args.push(target, "bash", "-s");

    const result = spawnSync("ssh", args, {
        stdio: ["pipe", "inherit", "inherit"],
        encoding: "utf-8",
        input: script,
    });

    if (result.error) {
        throw new Error(`ssh failed: ${result.error.message}`);
    }
    const code = typeof result.status === "number" ? result.status : 1;
    if (code !== 0) throw new Error(`ssh failed (${code})`);
}

function bootstrapScript({
    runnerVersion,
    repoUrl,
    runnerToken,
    runnerName,
    runnerLabels,
    ephemeral,
    forceReconfigure,
}) {
    const ephemeralFlag = ephemeral ? "  --ephemeral \\" : null;
    const runOnce = ephemeral ? "1" : "";
    const reconfigure = forceReconfigure ? "1" : "";
    return [
        "set -euo pipefail",
        `RUNNER_EPHEMERAL=${JSON.stringify(runOnce)}`,
        `RUNNER_RECONFIGURE=${JSON.stringify(reconfigure)}`,
        'RUNNER_DIR=${RUNNER_DIR:-"$HOME/actions-runner"}',
        'mkdir -p "$RUNNER_DIR"',
        'cd "$RUNNER_DIR"',
        "ARCH=$(uname -m)",
        'case "$ARCH" in',
        '  arm64) RUNNER_ARCH="arm64" ;;',
        '  x86_64) RUNNER_ARCH="x64" ;;',
        '  *) echo "Unsupported arch: $ARCH"; exit 1 ;;',
        "esac",
        `RUNNER_VERSION=${JSON.stringify(runnerVersion)}`,
        "if [ ! -f ./config.sh ]; then",
        '  curl -fsSL -o actions-runner.tar.gz "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-osx-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz"',
        "  tar -xzf actions-runner.tar.gz",
        "  rm -f actions-runner.tar.gz",
        "fi",
        "if ! command -v rustup >/dev/null 2>&1; then",
        "  curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable",
        "fi",
        '. "$HOME/.cargo/env"',
        "export RUNNER_ALLOW_RUNASROOT=1",
        'if [ "$RUNNER_RECONFIGURE" = "1" ]; then',
        "  ./svc.sh stop >/dev/null 2>&1 || true",
        "  pkill -f Runner.Listener >/dev/null 2>&1 || true",
        "  pkill -f Runner.Worker >/dev/null 2>&1 || true",
        "  rm -f .runner .credentials .credentials_rsaparams",
        "fi",
        'if [ "$RUNNER_RECONFIGURE" != "1" ] && [ -f .runner ] && pgrep -f "Runner.Listener" >/dev/null 2>&1; then',
        '  echo "[github-scaleway-runner] Runner already configured and running; nothing to do."',
        "  exit 0",
        "fi",
        "./config.sh --unattended --replace \\",
        `  --url ${JSON.stringify(repoUrl)} \\`,
        `  --token ${JSON.stringify(runnerToken)} \\`,
        `  --name ${JSON.stringify(runnerName)} \\`,
        `  --labels ${JSON.stringify(runnerLabels)} \\`,
        ephemeralFlag,
        "  --work _work",
        'if pgrep -f "Runner.Listener" >/dev/null 2>&1; then',
        '  echo "[github-scaleway-runner] Runner already running; skipping start."',
        "  exit 0",
        "fi",
        'if [ "$RUNNER_EPHEMERAL" = "1" ]; then',
        '  echo "[github-scaleway-runner] Starting ephemeral runner via nohup"',
        "  nohup ./run.sh > runner.log 2>&1 &",
        "  exit 0",
        "fi",
        "if ./svc.sh install >/dev/null 2>&1; then",
        "  true",
        "fi",
        "if ./svc.sh start; then",
        "  exit 0",
        "fi",
        'echo "[github-scaleway-runner] svc.sh failed; starting runner via nohup"',
        "nohup ./run.sh > runner.log 2>&1 &",
    ]
        .filter((line) => line != null)
        .join("\n");
}

async function bootstrapRunner(repoInfo, state) {
    const tokens = getGitHubTokens();
    if (tokens.length === 0) {
        fail(
            "Missing GitHub auth. Set GH_TOKEN/GITHUB_TOKEN, or run `gh auth login`."
        );
    }

    const secretKey = getScalewaySecretKey();
    const zone = String(
        state.zone || process.env.SCALEWAY_ZONE || DEFAULT_ZONE
    ).trim();
    const serverId = String(state.serverId || "").trim();
    if (!serverId) {
        fail("Missing server id in state. Re-run pnpm scaleway:start.");
    }

    const server = await scalewayRequest(
        secretKey,
        "GET",
        `/apple-silicon/v1alpha1/zones/${encodeURIComponent(zone)}/servers/${encodeURIComponent(serverId)}`
    );
    const status = extractServerStatus(server);
    const host = extractServerHost(server);
    const sshUsername = extractSshUsername(server);

    if (!host) {
        fail(
            `Scaleway server ${serverId} does not have a host/IP yet (status=${status}). Re-run pnpm scaleway:status and try again.`
        );
    }

    if (
        !["ready", "running", "started", "active"].includes(
            status.toLowerCase()
        )
    ) {
        fail(
            `Scaleway server ${serverId} is not ready yet (status=${status}). Wait a bit and re-run pnpm scaleway:bootstrap.`
        );
    }

    const sshUserOverride = (
        process.env.PEERBIT_SCALEWAY_SSH_USER || ""
    ).trim();
    const sshUser = sshUserOverride || sshUsername || "m1";
    const sshPort = getEnvInt("PEERBIT_SCALEWAY_SSH_PORT", 22);

    const runnerVersion = String(
        state.runnerVersion ||
            process.env.PEERBIT_GITHUB_RUNNER_VERSION ||
            DEFAULT_RUNNER_VERSION
    ).trim();
    const runnerName = String(state.runnerName || "").trim();
    const runnerLabels =
        String(state.runnerLabels || "").trim() ||
        (process.env.PEERBIT_RUNNER_LABELS || "peerbit,scaleway").trim();
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

    if (!runnerName) {
        fail("Missing runnerName in state. Re-run pnpm scaleway:start.");
    }

    console.log(
        "[github-scaleway-runner] Requesting GitHub runner registration token..."
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
        if (hint) {
            fail(hint);
        }
        throw error;
    }

    console.log(
        `[github-scaleway-runner] Bootstrapping GitHub runner over SSH (${sshUser}@${host})...`
    );
    sshRun({
        host,
        port: sshPort,
        user: sshUser,
        script: bootstrapScript({
            runnerVersion,
            repoUrl,
            runnerToken,
            runnerName,
            runnerLabels,
            ephemeral,
            forceReconfigure,
        }),
    });

    const tracker = new ProcessTracker("github-scaleway-runner.json");
    const key = `${repoInfo.owner}/${repoInfo.repo}`;
    tracker.track(key, {
        ...(tracker.list()[key] || {}),
        serverHost: host,
        sshUsername: sshUser,
    });

    console.log(
        "[github-scaleway-runner] Waiting for runner to register with GitHub..."
    );
    const registerWaitMs = getEnvInt(
        "PEERBIT_RUNNER_REGISTER_TIMEOUT_MS",
        10 * 60 * 1000
    );
    const registerPollMs = getEnvInt("PEERBIT_RUNNER_REGISTER_POLL_MS", 5000);
    const registerDeadline = Date.now() + registerWaitMs;
    let runnerId = null;
    while (Date.now() < registerDeadline) {
        runnerId = await findRunnerId(
            tokens,
            repoInfo.owner,
            repoInfo.repo,
            runnerName
        );
        if (runnerId) break;
        await sleep(registerPollMs);
    }

    if (!runnerId) {
        console.warn(
            `[github-scaleway-runner] Runner did not register within ${Math.round(registerWaitMs / 1000)}s. Check the runner service logs on the host, then re-run bootstrap/status.`
        );
        return;
    }

    tracker.track(key, {
        ...(tracker.list()[key] || {}),
        runnerId,
    });

    console.log(
        `[github-scaleway-runner] Runner registered (id ${runnerId}, name ${runnerName}).`
    );
    writeGitHubOutput({
        runner_id: runnerId,
        runner_name: runnerName,
        runner_labels: runnerLabels,
    });
}

async function findReusableServer(secretKey, zone, serverName) {
    const data = await scalewayRequest(
        secretKey,
        "GET",
        `/apple-silicon/v1alpha1/zones/${encodeURIComponent(zone)}/servers`
    );
    const servers = Array.isArray(data?.servers) ? data.servers : [];
    const matches = servers.filter(
        (server) => extractServerName(server) === serverName
    );
    matches.sort((a, b) => serverCreatedAt(b) - serverCreatedAt(a));
    return matches[0] || null;
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
        process.env.SCALEWAY_SERVER_TYPE || DEFAULT_SERVER_TYPE
    ).trim();
    const runnerLabels = (
        process.env.PEERBIT_RUNNER_LABELS || "peerbit,scaleway"
    ).trim();
    const runnerVersion = (
        process.env.PEERBIT_GITHUB_RUNNER_VERSION || DEFAULT_RUNNER_VERSION
    ).trim();
    const ephemeral =
        String(process.env.PEERBIT_RUNNER_EPHEMERAL || "1").trim() !== "0";
    const enableKext =
        String(process.env.PEERBIT_SCALEWAY_ENABLE_KEXT || "1").trim() !== "0";
    const reuseServer =
        String(process.env.PEERBIT_SCALEWAY_REUSE_SERVER || "").trim() === "1";
    const reusePool = sanitizeName(
        process.env.PEERBIT_SCALEWAY_REUSE_POOL || "shared-fs"
    );

    const repoUrl = `https://github.com/${repoInfo.owner}/${repoInfo.repo}`;
    const suffix = crypto.randomBytes(3).toString("hex");
    const runnerName = sanitizeName(
        `peerbit-selfhosted-scaleway-${repoInfo.repo}-${os.hostname()}-${suffix}`
    );
    const serverName = reuseServer
        ? sanitizeName(
              `peerbit-gh-runner-macos-${repoInfo.repo}-${reusePool || "pool"}`
          )
        : sanitizeName(`peerbit-gh-runner-macos-${repoInfo.repo}-${suffix}`);

    const tracker = new ProcessTracker("github-scaleway-runner.json");
    const key = `${repoInfo.owner}/${repoInfo.repo}`;
    const previous = tracker.list()[key] || null;
    const replace =
        String(process.env.PEERBIT_RUNNER_REPLACE || "").trim() === "1";
    if (previous && !replace) {
        fail(
            `A Scaleway runner is already tracked for ${key}. Run pnpm scaleway:stop first, or set PEERBIT_RUNNER_REPLACE=1.`
        );
    }

    const projectId = await resolveProjectId(secretKey);
    let created = reuseServer
        ? await findReusableServer(secretKey, zone, serverName)
        : null;
    const reusedServer = Boolean(created);
    let sshKeyId = "";
    let osId = "";
    if (!created) {
        sshKeyId = await ensureScalewaySshKey(secretKey, projectId);
        osId = await resolveOsId(secretKey, zone, serverType);
    }

    console.log(
        "[github-scaleway-runner] Requesting GitHub runner registration token..."
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
        if (hint) {
            fail(hint);
        }
        throw error;
    }

    if (created) {
        console.log(
            `[github-scaleway-runner] Reusing Scaleway Apple Silicon server ${serverName} (${extractServerId(created)}).`
        );
    } else {
        console.log(
            `[github-scaleway-runner] Creating Scaleway Apple Silicon server ${serverName} (${serverType}, ${zone})...`
        );
        try {
            created = await scalewayRequest(
                secretKey,
                "POST",
                `/apple-silicon/v1alpha1/zones/${encodeURIComponent(zone)}/servers`,
                {
                    project_id: projectId,
                    type: serverType,
                    name: serverName,
                    os_id: osId,
                    ssh_key_ids: [sshKeyId],
                    enable_kext: enableKext,
                }
            );
        } catch (error) {
            const status =
                typeof error?.status === "number" ? error.status : null;
            const body = typeof error?.body === "string" ? error.body : "";
            if (status === 403 && body.includes("quotas_exceeded")) {
                fail(
                    [
                        "Scaleway returned quota exceeded for Apple Silicon servers.",
                        "Open Scaleway console and request/enable Apple Silicon quota for this project, then re-run pnpm scaleway:start.",
                    ].join("\n")
                );
            }
            throw error;
        }
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
        osId,
        sshKeyId,
        runnerName,
        runnerLabels,
        runnerVersion,
        ephemeral,
        enableKext,
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
        `[github-scaleway-runner] Server ${reusedServer ? "selected" : "created"} (id ${serverId}).`
    );
    console.log(
        "[github-scaleway-runner] Waiting for server to become ready..."
    );

    const waitMs = getEnvInt(
        "PEERBIT_SCALEWAY_SERVER_READY_TIMEOUT_MS",
        20 * 60 * 1000
    );
    const pollMs = getEnvInt("PEERBIT_SCALEWAY_SERVER_READY_POLL_MS", 5000);
    const deadline = Date.now() + waitMs;

    let server = null;
    while (Date.now() < deadline) {
        try {
            server = await scalewayRequest(
                secretKey,
                "GET",
                `/apple-silicon/v1alpha1/zones/${encodeURIComponent(zone)}/servers/${encodeURIComponent(serverId)}`
            );
            const status = extractServerStatus(server);
            if (
                ["ready", "running", "started", "active"].includes(
                    status.toLowerCase()
                )
            ) {
                break;
            }
        } catch {
            // ignore and retry
        }
        await sleep(pollMs);
    }

    const latestState = tracker.list()[key] || null;
    if (!latestState) {
        throw new Error(
            "Scaleway runner state disappeared while starting (unexpected)."
        );
    }
    await bootstrapRunner(repoInfo, latestState);

    console.log(
        "Next: pnpm scaleway:enable (routes workflows to self-hosted runners)."
    );
}

async function stopRunner(repoInfo) {
    const tokens = getGitHubTokens();

    const tracker = new ProcessTracker("github-scaleway-runner.json");
    const key = `${repoInfo.owner}/${repoInfo.repo}`;
    const state = tracker.list()[key] || null;
    if (!state) {
        fail(`No tracked Scaleway runner for ${key}.`);
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
                `[github-scaleway-runner] Warning: could not query GitHub runner status (${error instanceof Error ? error.message : String(error)}).`
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
        String(process.env.PEERBIT_SCALEWAY_DELETE_REUSABLE || "").trim() !==
            "1";
    if (releaseReusableServer) {
        console.log(
            `[github-scaleway-runner] Keeping reusable Scaleway server ${state.serverId}; janitor will delete stale pool hosts.`
        );
    } else if (state.serverId && state.zone) {
        console.log(
            `[github-scaleway-runner] Deleting Scaleway server ${state.serverId}...`
        );
        try {
            await scalewayRequest(
                secretKey,
                "DELETE",
                `/apple-silicon/v1alpha1/zones/${encodeURIComponent(state.zone)}/servers/${encodeURIComponent(state.serverId)}`
            );
            deletedServer = true;
        } catch (error) {
            console.warn(
                `[github-scaleway-runner] Warning: could not delete Scaleway server (${error instanceof Error ? error.message : String(error)}).`
            );
        }
    } else {
        console.warn(
            "[github-scaleway-runner] No server id/zone found in state; skipping Scaleway delete."
        );
    }

    if (tokens.length > 0 && resolvedRunnerId) {
        try {
            console.log(
                `[github-scaleway-runner] Removing GitHub runner registration ${resolvedRunnerId}...`
            );
            await deleteRunner(
                tokens,
                repoInfo.owner,
                repoInfo.repo,
                resolvedRunnerId
            );
        } catch (error) {
            console.warn(
                `[github-scaleway-runner] Warning: could not remove runner registration (${error instanceof Error ? error.message : String(error)}).`
            );
        }
    } else if (!resolvedRunnerId) {
        console.log(
            "[github-scaleway-runner] No runner id found; skipping runner deregistration."
        );
    } else {
        console.log(
            "[github-scaleway-runner] No GitHub auth found; skipping runner deregistration."
        );
    }

    if (
        deletedServer ||
        releaseReusableServer ||
        String(process.env.PEERBIT_FORCE_UNTRACK || "").trim() === "1"
    ) {
        tracker.untrack(key);
        console.log("[github-scaleway-runner] Runner stopped.");
    } else {
        console.log(
            "[github-scaleway-runner] Runner state kept because the server was not deleted. Re-run stop later, or set PEERBIT_FORCE_UNTRACK=1 to forget it."
        );
    }
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
        26 * 60 * 60 * 1000
    );
    const cutoff = Date.now() - maxAgeMs;
    const prefix = sanitizeName(`peerbit-gh-runner-macos-${repoInfo.repo}-`);

    const data = await scalewayRequest(
        secretKey,
        "GET",
        `/apple-silicon/v1alpha1/zones/${encodeURIComponent(zone)}/servers`
    );
    const servers = Array.isArray(data?.servers) ? data.servers : [];
    for (const server of servers) {
        const name = extractServerName(server);
        const id = extractServerId(server);
        const createdAt = serverCreatedAt(server);
        if (
            !id ||
            !name.startsWith(prefix) ||
            (createdAt && createdAt > cutoff)
        )
            continue;
        console.log(
            `[github-scaleway-runner] Janitor deleting stale macOS server ${name} (${id})...`
        );
        try {
            await scalewayRequest(
                secretKey,
                "DELETE",
                `/apple-silicon/v1alpha1/zones/${encodeURIComponent(zone)}/servers/${encodeURIComponent(id)}`
            );
        } catch (error) {
            console.warn(
                `[github-scaleway-runner] Warning: could not delete ${name}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    if (tokens.length === 0) return;
    const runnerPrefix = sanitizeName(
        `peerbit-selfhosted-scaleway-${repoInfo.repo}-`
    );
    const runners = await listRunners(tokens, repoInfo.owner, repoInfo.repo);
    for (const runner of runners) {
        const name = String(runner?.name || "");
        if (
            !runner?.id ||
            !name.startsWith(runnerPrefix) ||
            runner?.busy ||
            runner?.status !== "offline"
        )
            continue;
        console.log(
            `[github-scaleway-runner] Janitor removing offline GitHub runner ${name} (${runner.id})...`
        );
        await deleteRunner(tokens, repoInfo.owner, repoInfo.repo, runner.id);
    }
}

async function statusRunner(repoInfo) {
    const tokens = getGitHubTokens();

    const tracker = new ProcessTracker("github-scaleway-runner.json");
    const key = `${repoInfo.owner}/${repoInfo.repo}`;
    const state = tracker.list()[key] || null;
    if (!state) {
        console.log(
            `[github-scaleway-runner] No tracked Scaleway runner for ${key}.`
        );
        process.exitCode = 1;
        return;
    }

    console.log(`[github-scaleway-runner] ${key}`);
    console.log(
        `- Server: ${state.serverName || "unknown"} (id ${state.serverId || "unknown"})`
    );
    console.log(`- Zone: ${state.zone || "unknown"}`);
    console.log(`- Type: ${state.serverType || "unknown"}`);
    if (state.serverHost) {
        console.log(`- Host: ${state.serverHost}`);
    }
    if (state.sshUsername) {
        console.log(`- SSH user: ${state.sshUsername}`);
    }
    console.log(
        `- Runner: ${state.runnerName || "unknown"} (id ${state.runnerId || "unknown"})`
    );
    console.log(`- Labels: ${state.runnerLabels || "unknown"}`);
    console.log("");

    if (state.serverId && state.zone) {
        const secretKey = getScalewaySecretKey();
        try {
            const server = await scalewayRequest(
                secretKey,
                "GET",
                `/apple-silicon/v1alpha1/zones/${encodeURIComponent(state.zone)}/servers/${encodeURIComponent(state.serverId)}`
            );
            const status = extractServerStatus(server);
            const host = extractServerHost(server);
            console.log(
                `[scaleway] status=${status}${host ? ` host=${host}` : ""}`
            );
        } catch (error) {
            console.log(
                `[scaleway] server lookup failed (${error instanceof Error ? error.message : String(error)})`
            );
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
    const name = "PEERBIT_RUNS_ON";
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
        if (hint) {
            fail(hint);
        }
        throw error;
    }
    console.log(
        `[github-scaleway-runner] ${result} repo variable ${name}=${value} for ${repoInfo.owner}/${repoInfo.repo}.`
    );
}

async function disableSelfHosted(repoInfo) {
    const tokens = getGitHubTokens();
    if (tokens.length === 0) {
        fail(
            "Missing GitHub auth. Set GH_TOKEN/GITHUB_TOKEN, or run `gh auth login`."
        );
    }
    const name = "PEERBIT_RUNS_ON";
    try {
        await deleteRepoVariable(tokens, repoInfo.owner, repoInfo.repo, name);
    } catch (error) {
        const hint = explainPatAccessIssue(error);
        if (hint) {
            fail(hint);
        }
        throw error;
    }
    console.log(
        `[github-scaleway-runner] Removed repo variable ${name} for ${repoInfo.owner}/${repoInfo.repo} (workflows will use GitHub-hosted runners).`
    );
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
        case "bootstrap": {
            const tracker = new ProcessTracker("github-scaleway-runner.json");
            const key = `${repoInfo.owner}/${repoInfo.repo}`;
            const state = tracker.list()[key] || null;
            if (!state) {
                fail(
                    `No tracked Scaleway runner for ${key}. Run pnpm scaleway:start first.`
                );
            }
            await bootstrapRunner(repoInfo, state);
            return;
        }
        case "stop":
            await stopRunner(repoInfo);
            return;
        case "status":
            await statusRunner(repoInfo);
            return;
        case "enable":
            await enableSelfHosted(repoInfo);
            return;
        case "disable":
            await disableSelfHosted(repoInfo);
            return;
        case "janitor":
            await janitor(repoInfo);
            return;
        default:
            usage();
            process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
