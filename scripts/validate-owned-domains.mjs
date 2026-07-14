import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const policyFixtureFiles = new Set([
    "scripts/validate-owned-domains.mjs",
    "cloudflare/owned-domain-policy.test.mjs",
]);
const retiredDirectAppHosts = [
    "stream",
    "music",
    "chat",
    "giga",
    "ml",
    "text",
    "files",
    "chess",
].map((label) => ({
    needle: `${label}.${"peerbit" + ".org"}`,
    description: "retired direct app origin",
}));
const forbiddenReferences = [
    {
        needle: "dao" + ".xyz",
        description: "unowned host or metadata identity",
        allowance: "historical-copyright",
    },
    {
        needle: "giga" + ".place",
        description: "unowned host",
    },
    {
        needle: "." + "test" + ".xyz",
        description: "unsafe public-DNS development suffix",
    },
    {
        needle: "dao-xyz.github" + ".io/peerbit-examples",
        description: "retired GitHub Pages URL",
    },
    {
        needle: "@giga" + "-app/",
        description: "retired Giga package namespace",
        allowance: "historical-giga-changelog",
    },
    {
        needle: "packages/social-media-" + "app",
        description: "retired Giga source tree",
    },
    {
        needle: "peerbit-examples-" + "giga",
        description: "retired Giga Worker",
    },
    {
        needle: "giga.apps." + "peerbit.org",
        description: "retired Giga production origin",
    },
    ...retiredDirectAppHosts,
];
const historicalCopyrightPattern =
    /^\s*Copyright(?: \(c\))? \d{4} dao\.xyz\s*$/i;
const historicalGigaChangelogPattern =
    /^\s*-\s+@giga-app\/[a-z0-9._-]+@\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?\s*$/i;
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
    ".go",
    ".html",
    ".js",
    ".json",
    ".jsonc",
    ".jsx",
    ".md",
    ".mjs",
    ".map",
    ".mod",
    ".patch",
    ".ps1",
    ".sass",
    ".scss",
    ".sh",
    ".sum",
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
    ".wgsl",
]);

const normalizeFile = (file) => file.split(path.sep).join("/");

export const isAllowedHistoricalReference = (file, line, reference) => {
    if (reference.allowance === "historical-copyright") {
        return historicalCopyrightPattern.test(line);
    }
    if (reference.allowance === "historical-giga-changelog") {
        return (
            /(?:^|\/)CHANGELOG\.md$/.test(normalizeFile(file)) &&
            historicalGigaChangelogPattern.test(line)
        );
    }
    return false;
};

const findUnsafeOwnedPathReferences = (normalizedFile) => {
    if (policyFixtureFiles.has(normalizedFile)) return [];

    const findings = new Set();
    const lowerFile = normalizedFile.toLowerCase();
    for (const reference of forbiddenReferences) {
        if (lowerFile.includes(reference.needle)) {
            findings.add(
                `${normalizedFile}: path contains ${reference.description} ${reference.needle}`
            );
        }
    }
    return [...findings];
};

const findUnsafeOwnedContentReferences = (normalizedFile, contents) => {
    if (policyFixtureFiles.has(normalizedFile)) return [];

    const findings = new Set();
    for (const [index, line] of contents.split(/\r?\n/).entries()) {
        const lowerLine = line.toLowerCase();
        for (const reference of forbiddenReferences) {
            if (!lowerLine.includes(reference.needle)) continue;
            if (isAllowedHistoricalReference(normalizedFile, line, reference)) {
                continue;
            }
            findings.add(
                `${normalizedFile}:${index + 1}: contains ${reference.description} ${reference.needle}`
            );
        }
    }
    return [...findings];
};

export const findUnsafeOwnedDomainReferences = (file, contents) => {
    const normalizedFile = normalizeFile(file);
    return [
        ...findUnsafeOwnedPathReferences(normalizedFile),
        ...findUnsafeOwnedContentReferences(normalizedFile, contents),
    ];
};

export const findUnsafeOwnedDomainTreeReferences = (root = repoRoot) => {
    const violations = [];
    const visit = (absolutePath) => {
        const relativePath = normalizeFile(path.relative(root, absolutePath));
        const stat = statSync(absolutePath, { throwIfNoEntry: false });
        if (!stat) return;
        if (stat.isDirectory()) {
            if (ignoredDirectories.has(path.basename(absolutePath))) return;
            for (const name of readdirSync(absolutePath).sort()) {
                visit(path.join(absolutePath, name));
            }
            return;
        }
        if (!stat.isFile()) return;

        violations.push(...findUnsafeOwnedPathReferences(relativePath));

        const extension = path.extname(absolutePath).toLowerCase();
        const basename = path.basename(absolutePath).toLowerCase();
        if (!textExtensions.has(extension) && !basename.includes(".env.")) {
            return;
        }

        violations.push(
            ...findUnsafeOwnedContentReferences(
                relativePath,
                readFileSync(absolutePath, "utf8")
            )
        );
    };

    visit(root);
    return [...new Set(violations)];
};

const main = () => {
    const violations = findUnsafeOwnedDomainTreeReferences();
    if (violations.length > 0) {
        throw new Error(
            `Unsafe or retired project references found:\n${violations.join("\n")}`
        );
    }

    console.log(
        "Validated that source, metadata, and generated text assets avoid unsafe or retired project references"
    );
};

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    main();
}
