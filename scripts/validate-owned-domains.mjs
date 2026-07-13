import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const forbiddenHosts = ["dao" + ".xyz", "giga" + ".place"];
const legalAttributionFiles = new Set([
    "LICENSE",
    "LICENSE-MIT",
    "packages/text-document/LICENSE",
]);
const ignoredDirectories = new Set([
    ".git",
    "node_modules",
    "coverage",
    "playwright-report",
    "test-results",
]);
const textExtensions = new Set([
    "",
    ".css",
    ".cjs",
    ".env",
    ".html",
    ".js",
    ".json",
    ".jsonc",
    ".jsx",
    ".md",
    ".mjs",
    ".map",
    ".sass",
    ".scss",
    ".sh",
    ".svelte",
    ".svg",
    ".ts",
    ".tsx",
    ".txt",
    ".toml",
    ".vue",
    ".xml",
    ".yaml",
    ".yml",
]);

const violations = [];
const visit = (absolutePath) => {
    const relativePath = path
        .relative(repoRoot, absolutePath)
        .split(path.sep)
        .join("/");
    const stat = statSync(absolutePath, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
        if (ignoredDirectories.has(path.basename(absolutePath))) return;
        for (const name of readdirSync(absolutePath)) {
            visit(path.join(absolutePath, name));
        }
        return;
    }
    if (
        !stat.isFile() ||
        legalAttributionFiles.has(relativePath) ||
        (!textExtensions.has(path.extname(absolutePath)) &&
            !path.basename(absolutePath).includes(".env."))
    ) {
        return;
    }

    let contents = readFileSync(absolutePath, "utf8");
    if (path.basename(absolutePath) === "package.json") {
        const manifest = JSON.parse(contents);
        // Package authorship is historical provenance, not a network target.
        // It follows a separate legal/release process from host ownership.
        delete manifest.author;
        contents = JSON.stringify(manifest);
    }
    contents = contents.toLowerCase();
    for (const host of forbiddenHosts) {
        if (contents.includes(host)) {
            violations.push(`${relativePath}: contains unowned host ${host}`);
        }
    }
};

visit(repoRoot);

if (violations.length > 0) {
    throw new Error(
        `Unowned domain references found:\n${violations.join("\n")}`
    );
}

console.log(
    "Validated that source and generated text assets use owned domains"
);
