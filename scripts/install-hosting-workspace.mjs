import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const skippedDependency = "node-datachannel";
const policyKeys = [
    "only-built-dependencies",
    "only-built-dependencies-file",
    "never-built-dependencies",
    "allow-builds",
    "dangerously-allow-all-builds",
];

// Hosting bundles use browser WebRTC, not the Node native transport. Keep the
// workspace policy intact for shared-fs/native tests and ordinary installs.
export const hostingInstallArgs = (policy) => {
    for (const key of policyKeys.slice(1)) {
        if (
            policy[key] != null &&
            !(key === "dangerously-allow-all-builds" && policy[key] === false)
        ) {
            throw new Error(`Unsupported hosting build policy: ${key}`);
        }
    }
    const dependencies = policy["only-built-dependencies"];
    if (
        !Array.isArray(dependencies) ||
        dependencies.length < 2 ||
        new Set(dependencies).size !== dependencies.length ||
        dependencies.some(
            (name) =>
                typeof name !== "string" ||
                !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
        ) ||
        !dependencies.includes(skippedDependency)
    ) {
        throw new Error(
            "Hosting requires an explicit package-name build allowlist including node-datachannel"
        );
    }
    return dependencies
        .filter((name) => name !== skippedDependency)
        .map((name) => `--config.only-built-dependencies=${name}`);
};

const runPnpm = (args, { capture = true } = {}) => {
    const result = spawnSync("pnpm", args, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
        shell: process.platform === "win32",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`Hosting pnpm command failed (exit ${result.status})`);
    }
    return result.stdout ?? "";
};

export const installHostingWorkspace = ({
    checkOnly = false,
    run = runPnpm,
} = {}) => {
    const readConfig = (key, flags = []) => {
        const output = run([...flags, "config", "get", key, "--json"]).trim();
        return output ? JSON.parse(output) : undefined;
    };
    const policy = Object.fromEntries(
        policyKeys.map((key) => [key, readConfig(key)])
    );
    const flags = hostingInstallArgs(policy);
    const expected = policy["only-built-dependencies"].filter(
        (name) => name !== skippedDependency
    );
    const effective = readConfig("only-built-dependencies", flags);
    if (JSON.stringify(effective) !== JSON.stringify(expected)) {
        throw new Error("pnpm did not apply the exact hosting build allowlist");
    }
    if (!checkOnly) {
        run([...flags, "install", "--frozen-lockfile"], { capture: false });
    }
    return expected;
};

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
        throw new Error(
            "Usage: node scripts/install-hosting-workspace.mjs [--check]"
        );
    }
    const checkOnly = args[0] === "--check";
    const dependencies = installHostingWorkspace({ checkOnly });
    console.log(
        `${checkOnly ? "Verified" : "Installed"} hosting workspace; build scripts: ${dependencies.join(", ")}; node-datachannel skipped (browser-only job)`
    );
}
