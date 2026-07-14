import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    loadCloudflareDeploymentData,
    repoRoot,
    selectCloudflareDeploymentEntries,
    validateRenderedCloudflareConfigSet,
} from "./cloudflare-deployment-policy.mjs";

const VERSION_ID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FULL_GIT_COMMIT = /^[0-9a-f]{40}$/i;

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

export const deployProductionEntries = async ({
    selectedEntries,
    configs,
    expectedCommit,
    operations,
    log = console.log,
}) => {
    if (!FULL_GIT_COMMIT.test(expectedCommit || "")) {
        throw new Error(
            "Production deployment requires a full Git commit hash"
        );
    }

    for (const { site, policy } of selectedEntries) {
        const { file } = configs.get(site.id);
        const previousDeployment = await operations.status({
            configFile: file,
            site,
            policy,
        });
        const previousVersion = readSingleVersionDeployment(
            previousDeployment,
            site.id
        );
        const previousCommit = await operations.readReleaseCommit({
            site,
            policy,
        });
        if (
            policy.kind === "app" &&
            !FULL_GIT_COMMIT.test(previousCommit || "")
        ) {
            throw new Error(
                `${site.id}: production app requires a full rollback release commit`
            );
        }
        let deployedVersion;

        log(
            `${site.id}: rollback baseline ${previousVersion}${
                previousCommit ? ` at ${previousCommit}` : ""
            }`
        );
        try {
            await operations.deploy({
                configFile: file,
                site,
                policy,
                expectedCommit,
            });
            const deployed = await operations.status({
                configFile: file,
                site,
                policy,
            });
            deployedVersion = readSingleVersionDeployment(deployed, site.id);
            await operations.verify({
                site,
                policy,
                expectedCommit,
            });
            log(`${site.id}: deployed and verified ${deployedVersion}`);
        } catch (deploymentError) {
            let rollbackError;
            try {
                let currentVersion;
                try {
                    const current = await operations.status({
                        configFile: file,
                        site,
                        policy,
                    });
                    currentVersion = readSingleVersionDeployment(
                        current,
                        site.id
                    );
                } catch {
                    // If status is inconclusive, attempting the known-good
                    // rollback is safer than assuming the failed deploy was
                    // atomic.
                }

                if (currentVersion !== previousVersion) {
                    log(
                        `${site.id}: deployment failed; rolling back to ${previousVersion}`
                    );
                    await operations.rollback({
                        configFile: file,
                        site,
                        policy,
                        versionId: previousVersion,
                    });
                }
                const restored = await operations.status({
                    configFile: file,
                    site,
                    policy,
                });
                const restoredVersion = readSingleVersionDeployment(
                    restored,
                    site.id
                );
                if (restoredVersion !== previousVersion) {
                    throw new Error(
                        `${site.id}: rollback restored ${restoredVersion}, expected ${previousVersion}`
                    );
                }
                await operations.verify({
                    site,
                    policy,
                    expectedCommit: previousCommit,
                });
                log(`${site.id}: previous version restored and verified`);
            } catch (error) {
                rollbackError = error;
            }

            const messages = [
                `${site.id}: production deployment failed: ${deploymentError}`,
            ];
            if (rollbackError) {
                messages.push(
                    `${site.id}: automatic rollback also failed: ${rollbackError}`
                );
            } else {
                messages.push(
                    `${site.id}: automatic rollback to ${previousVersion} succeeded`
                );
            }
            throw new Error(messages.join("\n"));
        }
    }
};

export const withoutCloudflareDeploymentCredentials = (environment) => {
    const sanitized = { ...environment };
    delete sanitized.CLOUDFLARE_API_TOKEN;
    delete sanitized.CLOUDFLARE_ACCOUNT_ID;
    return sanitized;
};

const deploymentEnvironment = process.env;
const verificationEnvironment = withoutCloudflareDeploymentCredentials(
    process.env
);

const runCaptured = (command, args) => {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        env: deploymentEnvironment,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(
            `${path.basename(command)} ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`
        );
    }
    return result.stdout;
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

const parseArgs = (argv) => {
    const args = new Map();
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (!key?.startsWith("--") || value == null) {
            throw new Error(
                "Usage: deploy-cloudflare-production.mjs --target ID|apps|all --commit SHA"
            );
        }
        args.set(key.slice(2), value);
    }
    return args;
};

export const main = async (argv = process.argv.slice(2)) => {
    const args = parseArgs(argv);
    const target = args.get("target");
    const expectedCommit = args.get("commit");
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
    const operations = {
        status: ({ configFile }) =>
            JSON.parse(
                runCaptured(wrangler, [
                    "deployments",
                    "status",
                    "--config",
                    configFile,
                    "--json",
                ])
            ),
        deploy: ({ configFile, site, expectedCommit: commit }) =>
            runInherited(wrangler, [
                "deploy",
                "--config",
                configFile,
                "--strict",
                "--message",
                `peerbit-examples ${site.id} ${commit}`,
            ]),
        rollback: ({ configFile, site, versionId }) =>
            runInherited(wrangler, [
                "rollback",
                versionId,
                "--config",
                configFile,
                "--yes",
                "--message",
                `automatic rollback after failed ${site.id} verification`,
            ]),
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
        configs,
        expectedCommit,
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
