import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const toolRoot = path.join(repoRoot, "tools/wrangler");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const packageJson = readJson(path.join(toolRoot, "package.json"));
const packageLock = readJson(path.join(toolRoot, "package-lock.json"));
const installedEsbuild = readJson(
    path.join(toolRoot, "node_modules/esbuild/package.json")
);
const expectedWrangler = packageJson.devDependencies?.wrangler;
const lockedWrangler = packageLock.packages?.["node_modules/wrangler"]?.version;
const lockedEsbuild = packageLock.packages?.["node_modules/esbuild"]?.version;

if (
    expectedWrangler !== "4.110.0" ||
    lockedWrangler !== expectedWrangler ||
    typeof lockedEsbuild !== "string" ||
    installedEsbuild.version !== lockedEsbuild
) {
    throw new Error(
        "Locked Wrangler/esbuild package versions are inconsistent"
    );
}

const exactVersion = (command, args, expected, label) => {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        encoding: "utf8",
        env: process.env,
    });
    if (result.error) throw result.error;
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (result.status !== 0 || !output.split(/\s+/).includes(expected)) {
        throw new Error(
            `${label} executable does not match its locked package version ${expected}`
        );
    }
};

exactVersion(
    path.join(toolRoot, "node_modules/.bin/esbuild"),
    ["--version"],
    lockedEsbuild,
    "esbuild"
);
exactVersion(
    path.join(toolRoot, "node_modules/.bin/wrangler"),
    ["--version"],
    expectedWrangler,
    "Wrangler"
);

console.log(
    `Validated Wrangler ${expectedWrangler} with matching esbuild ${lockedEsbuild}`
);
