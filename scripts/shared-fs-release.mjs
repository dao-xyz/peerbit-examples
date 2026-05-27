#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const dryRun = process.argv.includes("--dry-run");
const skipValidation = process.argv.includes("--skip-validation");
const repo = process.env.GITHUB_REPOSITORY ?? "dao-xyz/peerbit-examples";
const nativeWorkflowId = "shared-fs-native-adapter-release.yml";
const nativeTargets = [
    "darwin-arm64.tar.gz",
    "darwin-x64.tar.gz",
    "linux-arm64.tar.gz",
    "linux-x64.tar.gz",
    "win32-x64.zip",
];
const releasePackages = [
    {
        dir: "packages/shared-fs/library",
        jsonPath: "packages/shared-fs/library/package.json",
    },
    {
        dir: "packages/shared-fs/cli",
        jsonPath: "packages/shared-fs/cli/package.json",
    },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readJson = (relativePath) =>
    JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));

const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, {
        cwd: options.cwd ?? repoRoot,
        env: {
            ...process.env,
            ...options.env,
        },
        shell: process.platform === "win32",
        stdio: "inherit",
    });
    if (result.error) {
        throw result.error;
    }
    if ((result.status ?? 1) !== 0) {
        throw new Error(
            `${command} ${args.join(" ")} failed with exit code ${
                result.status ?? 1
            }`
        );
    }
};

const capture = (command, args, options = {}) => {
    const result = spawnSync(command, args, {
        cwd: options.cwd ?? repoRoot,
        env: {
            ...process.env,
            ...options.env,
        },
        encoding: "utf8",
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) {
        throw result.error;
    }
    return {
        ok: (result.status ?? 1) === 0,
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    };
};

const hasNpmToken = () =>
    Boolean(process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN);

const githubToken = () => process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

const githubApi = async (route, options = {}) => {
    const headers = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.headers ?? {}),
    };
    const token = githubToken();
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(`https://api.github.com${route}`, {
        method: options.method ?? "GET",
        headers,
        body:
            options.body === undefined
                ? undefined
                : JSON.stringify(options.body),
    });

    if (options.allowNotFound && response.status === 404) {
        return undefined;
    }

    if (!response.ok) {
        const body = await response.text();
        throw new Error(
            `GitHub API ${options.method ?? "GET"} ${route} failed with ${
                response.status
            }: ${body}`
        );
    }

    if (response.status === 204) {
        return undefined;
    }

    return response.json();
};

const getNativeRelease = (tag) =>
    githubApi(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
        allowNotFound: true,
    });

const expectedNativeAssets = () =>
    nativeTargets.map((target) => `peerbit-shared-fs-native-${target}`);

const missingNativeAssets = (release) => {
    if (!release) {
        return expectedNativeAssets();
    }
    const actual = new Set((release.assets ?? []).map((asset) => asset.name));
    return expectedNativeAssets().filter((asset) => !actual.has(asset));
};

const resolveRef = () => {
    if (process.env.GITHUB_REF_NAME) {
        return process.env.GITHUB_REF_NAME;
    }
    if (process.env.GITHUB_REF?.startsWith("refs/heads/")) {
        return process.env.GITHUB_REF.slice("refs/heads/".length);
    }
    return "master";
};

const dispatchNativeWorkflow = async (tag) => {
    if (!githubToken()) {
        throw new Error(
            "GITHUB_TOKEN or GH_TOKEN is required to dispatch the native adapter release workflow."
        );
    }

    const ref = resolveRef();
    const startedAt = Date.now() - 30_000;
    const workflowId = encodeURIComponent(nativeWorkflowId);
    console.log(`Dispatching native adapter release workflow for ${tag}...`);
    await githubApi(
        `/repos/${repo}/actions/workflows/${workflowId}/dispatches`,
        {
            method: "POST",
            body: {
                ref,
                inputs: {
                    tag,
                    publish_release: "true",
                },
            },
        }
    );

    const deadline = Date.now() + 60 * 60_000;
    let runId;

    while (Date.now() < deadline) {
        const runs = await githubApi(
            `/repos/${repo}/actions/workflows/${workflowId}/runs?event=workflow_dispatch&branch=${encodeURIComponent(
                ref
            )}&per_page=20`
        );
        const matches = (runs.workflow_runs ?? [])
            .filter((run) => new Date(run.created_at).getTime() >= startedAt)
            .filter(
                (run) =>
                    run.display_title?.includes(tag) ||
                    run.name === "Shared FS Native Adapter Release"
            )
            .sort(
                (a, b) =>
                    new Date(b.created_at).getTime() -
                    new Date(a.created_at).getTime()
            );

        if (!runId && matches[0]) {
            runId = matches[0].id;
            console.log(`Native adapter workflow run: ${matches[0].html_url}`);
        }

        if (runId) {
            const run = await githubApi(`/repos/${repo}/actions/runs/${runId}`);
            if (run.status === "completed") {
                if (run.conclusion !== "success") {
                    throw new Error(
                        `Native adapter workflow ${run.html_url} completed with ${run.conclusion}.`
                    );
                }
                return;
            }
        }

        await sleep(15_000);
    }

    throw new Error(
        `Timed out waiting for native adapter workflow for ${tag}.`
    );
};

const ensureNativeAdapterRelease = async (tag) => {
    const release = await getNativeRelease(tag);
    const missing = missingNativeAssets(release);
    if (missing.length === 0) {
        console.log(`Native adapter release ${tag} has all expected assets.`);
        return;
    }

    if (dryRun) {
        throw new Error(
            `Native adapter release ${tag} is missing assets in dry-run mode: ${missing.join(
                ", "
            )}`
        );
    }

    console.log(
        `Native adapter release ${tag} is missing assets: ${missing.join(", ")}`
    );
    await dispatchNativeWorkflow(tag);

    for (let attempt = 0; attempt < 12; attempt += 1) {
        const updatedRelease = await getNativeRelease(tag);
        const stillMissing = missingNativeAssets(updatedRelease);
        if (stillMissing.length === 0) {
            console.log(`Native adapter release ${tag} is ready.`);
            return;
        }
        await sleep(10_000);
    }

    throw new Error(`Native adapter release ${tag} did not become ready.`);
};

const packagePublished = (packageName, version) => {
    const result = capture("npm", [
        "view",
        `${packageName}@${version}`,
        "version",
        "--json",
    ]);
    if (!result.ok) {
        return false;
    }
    const value = result.stdout.trim();
    if (!value) {
        return false;
    }
    try {
        return JSON.parse(value) === version;
    } catch {
        return value.replace(/^"|"$/g, "") === version;
    }
};

const runPackInstallSmoke = () => {
    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "peerbit-shared-fs-release-")
    );
    const packDir = path.join(tempDir, "packs");
    const projectDir = path.join(tempDir, "project");
    const nativeDir = path.join(tempDir, "native-adapter");
    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    try {
        run("pnpm", [
            "--filter",
            "@peerbit/shared-fs",
            "pack",
            "--pack-destination",
            packDir,
        ]);
        run("pnpm", [
            "--filter",
            "@peerbit/shared-fs-cli",
            "pack",
            "--pack-destination",
            packDir,
        ]);

        const files = fs.readdirSync(packDir);
        const libraryPack = files.find((file) =>
            /^peerbit-shared-fs-[0-9].*\.tgz$/.test(file)
        );
        const cliPack = files.find((file) =>
            /^peerbit-shared-fs-cli-.*\.tgz$/.test(file)
        );
        if (!libraryPack || !cliPack) {
            throw new Error(`Expected package tarballs in ${packDir}.`);
        }

        run("npm", ["init", "-y"], { cwd: projectDir });
        run(
            "npm",
            [
                "install",
                "--ignore-scripts",
                path.join(packDir, libraryPack),
                path.join(packDir, cliPack),
            ],
            { cwd: projectDir }
        );
        run(
            process.execPath,
            [
                "-e",
                "import('@peerbit/shared-fs').then((m) => { if (typeof m.openSharedFs !== 'function') throw new Error('openSharedFs export missing'); })",
            ],
            { cwd: projectDir }
        );
        run(
            process.execPath,
            [
                path.join(
                    projectDir,
                    "node_modules/@peerbit/shared-fs-cli/lib/esm/bin.js"
                ),
                "install-adapter",
                "--prefix",
                nativeDir,
                "--print-path",
            ],
            { cwd: projectDir }
        );
    } finally {
        if (!process.env.KEEP_SHARED_FS_RELEASE_TMP) {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    }
};

const runValidations = () => {
    run("pnpm", [
        "-r",
        "--sort",
        "--filter",
        "@peerbit/shared-fs",
        "--filter",
        "@peerbit/shared-fs-cli",
        "run",
        "build",
    ]);
    run("pnpm", ["--filter", "@peerbit/shared-fs-cli", "run", "test"]);
    runPackInstallSmoke();
};

const publishPackages = (packages, unpublished) => {
    if (!dryRun && !hasNpmToken()) {
        throw new Error(
            "NPM_TOKEN or NODE_AUTH_TOKEN is required to publish shared-fs packages."
        );
    }

    for (const pkg of packages) {
        if (!dryRun && !unpublished.includes(pkg)) {
            console.log(`${pkg.name}@${pkg.version} is already published.`);
            continue;
        }

        const args = ["publish", "--access", "public", "--no-git-checks"];
        if (dryRun) {
            args.push("--dry-run");
        }
        run("pnpm", args, { cwd: path.join(repoRoot, pkg.dir) });
    }
};

const packages = releasePackages.map((pkg) => ({
    ...pkg,
    ...readJson(pkg.jsonPath),
}));

const versions = new Set(packages.map((pkg) => pkg.version));
if (versions.size !== 1) {
    throw new Error(
        `Shared-fs packages must use the same version: ${packages
            .map((pkg) => `${pkg.name}@${pkg.version}`)
            .join(", ")}`
    );
}

const version = packages[0].version;
const tag = `shared-fs-native-v${version}`;
console.log(
    `Preparing shared-fs release ${version}${dryRun ? " (dry run)" : ""}.`
);

const unpublished = dryRun
    ? packages
    : packages.filter((pkg) => !packagePublished(pkg.name, pkg.version));

if (!dryRun && unpublished.length === 0) {
    console.log("Shared-fs package versions are already published.");
    process.exit(0);
}

if (!dryRun && !hasNpmToken()) {
    throw new Error(
        "NPM_TOKEN or NODE_AUTH_TOKEN is required to publish shared-fs packages."
    );
}

await ensureNativeAdapterRelease(tag);
if (!skipValidation) {
    runValidations();
}
publishPackages(packages, unpublished);
