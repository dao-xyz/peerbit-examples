#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCompactedOutput } from "./compact-emitted-javascript.mjs";

const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const rootLicense = await readFile(
    path.join(repositoryRoot, "LICENSE"),
    "utf8"
);

const packages = [
    {
        directory: "packages/shared-fs/library",
        name: "@peerbit/shared-fs",
        maxUnpackedBytes: 2_750_000,
        requiredPaths: [
            "LICENSE",
            "README.md",
            "package.json",
            "lib/esm/index.d.ts",
            "lib/esm/index.js",
            "src/index.ts",
        ],
        expectedShebangs: {},
    },
    {
        directory: "packages/shared-fs/cli",
        name: "@peerbit/shared-fs-cli",
        maxUnpackedBytes: 325_000,
        requiredPaths: [
            "LICENSE",
            "README.md",
            "package.json",
            "lib/esm/bin.js",
            "lib/esm/index.d.ts",
            "lib/esm/index.js",
            "lib/esm/install-native-adapter.js",
            "scripts/postinstall.mjs",
            "src/bin.ts",
            "src/index.ts",
            "src/install-native-adapter.ts",
        ],
        expectedSideEffects: [
            "./lib/esm/bin.js",
            "./lib/esm/install-native-adapter.js",
            "./scripts/postinstall.mjs",
            "./src/bin.ts",
            "./src/install-native-adapter.ts",
        ],
        expectedShebangs: {
            "bin.js": "#!/usr/bin/env node",
            "cross-os-interop.js": "#!/usr/bin/env node",
            "install-native-adapter.js": "#!/usr/bin/env node",
        },
    },
];

const normalizePath = (value) => value.replaceAll("\\", "/");

const comparePaths = (left, right) =>
    left < right ? -1 : left > right ? 1 : 0;

const formatBytes = (value) => new Intl.NumberFormat("en-US").format(value);

const fail = (packageName, message) => {
    throw new Error(`${packageName}: ${message}`);
};

const packManifest = (directory, packageName) => {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = spawnSync(
        npm,
        ["pack", "--dry-run", "--json", "--ignore-scripts"],
        {
            cwd: path.join(repositoryRoot, directory),
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            shell: process.platform === "win32",
        }
    );

    if (result.error) {
        fail(packageName, `could not run npm pack: ${result.error.message}`);
    }
    if (result.status !== 0) {
        fail(
            packageName,
            `npm pack exited with ${result.status}: ${(result.stderr || result.stdout).trim()}`
        );
    }

    let parsed;
    try {
        parsed = JSON.parse(result.stdout);
    } catch (error) {
        fail(
            packageName,
            `npm pack returned invalid JSON: ${error instanceof Error ? error.message : error}`
        );
    }
    if (!Array.isArray(parsed) || parsed.length !== 1) {
        fail(packageName, "npm pack returned an unexpected manifest");
    }
    return parsed[0];
};

const pnpmPackPaths = (packageName) => {
    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const result = spawnSync(
        pnpm,
        ["--filter", packageName, "pack", "--dry-run", "--json"],
        {
            cwd: repositoryRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            shell: process.platform === "win32",
        }
    );

    if (result.error) {
        fail(packageName, `could not run pnpm pack: ${result.error.message}`);
    }
    if (result.status !== 0) {
        fail(
            packageName,
            `pnpm pack exited with ${result.status}: ${(result.stderr || result.stdout).trim()}`
        );
    }

    let parsed;
    try {
        parsed = JSON.parse(result.stdout);
    } catch (error) {
        fail(
            packageName,
            `pnpm pack returned invalid JSON: ${error instanceof Error ? error.message : error}`
        );
    }
    if (parsed?.name !== packageName || !Array.isArray(parsed.files)) {
        fail(packageName, "pnpm pack returned an unexpected manifest");
    }
    return parsed.files
        .map((file) => normalizePath(file.path))
        .sort(comparePaths);
};

const forbiddenReason = (filePath) => {
    if (/(^|\/)__tests__(\/|$)/.test(filePath) || /\.test\./.test(filePath)) {
        return "test artifact";
    }
    if (/\.(?:bench|protocol|worker)\./.test(filePath)) {
        return "benchmark/protocol/worker artifact";
    }
    if (/(^|\/)native(\/|$)/.test(filePath)) {
        return "native adapter source tree";
    }
    if (/\.(?:dll|dylib|exe|node|so)$/i.test(filePath)) {
        return "native binary";
    }
    if (filePath.includes("cross-os-interop")) {
        return "cross-OS CI driver";
    }
};

for (const specification of packages) {
    const packageRoot = path.join(repositoryRoot, specification.directory);
    const packageJson = JSON.parse(
        await readFile(path.join(packageRoot, "package.json"), "utf8")
    );
    if (packageJson.name !== specification.name) {
        fail(
            specification.name,
            `manifest name is ${JSON.stringify(packageJson.name)}`
        );
    }

    await verifyCompactedOutput({
        outputDirectory: path.join(packageRoot, "lib", "esm"),
        expectedShebangs: specification.expectedShebangs,
    });

    const packageLicense = await readFile(
        path.join(packageRoot, "LICENSE"),
        "utf8"
    );
    if (packageLicense !== rootLicense) {
        fail(specification.name, "LICENSE differs from the repository license");
    }

    const manifest = packManifest(specification.directory, specification.name);
    const files = manifest.files.map((file) => ({
        path: normalizePath(file.path),
        size: file.size,
    }));
    files.sort((left, right) => comparePaths(left.path, right.path));
    const paths = files.map((file) => file.path);
    const pathSet = new Set(paths);

    if (pathSet.size !== paths.length) {
        fail(specification.name, "npm pack reported duplicate paths");
    }
    for (const requiredPath of specification.requiredPaths) {
        if (!pathSet.has(requiredPath)) {
            fail(specification.name, `missing required path ${requiredPath}`);
        }
    }
    for (const filePath of paths) {
        const reason = forbiddenReason(filePath);
        if (reason) {
            fail(specification.name, `contains ${reason}: ${filePath}`);
        }
    }

    const pnpmPaths = pnpmPackPaths(specification.name);
    if (JSON.stringify(pnpmPaths) !== JSON.stringify(paths)) {
        const pnpmPathSet = new Set(pnpmPaths);
        const onlyInNpm = paths.filter(
            (filePath) => !pnpmPathSet.has(filePath)
        );
        const onlyInPnpm = pnpmPaths.filter(
            (filePath) => !pathSet.has(filePath)
        );
        fail(
            specification.name,
            `npm and pnpm pack manifests differ (npm only: ${onlyInNpm.join(", ") || "none"}; pnpm only: ${onlyInPnpm.join(", ") || "none"})`
        );
    }

    const calculatedUnpackedBytes = files.reduce(
        (total, file) => total + file.size,
        0
    );
    if (calculatedUnpackedBytes !== manifest.unpackedSize) {
        fail(
            specification.name,
            `unpacked size ${formatBytes(manifest.unpackedSize)} does not match file sum ${formatBytes(calculatedUnpackedBytes)}`
        );
    }
    if (calculatedUnpackedBytes > specification.maxUnpackedBytes) {
        fail(
            specification.name,
            `unpacked size ${formatBytes(calculatedUnpackedBytes)} exceeds budget ${formatBytes(specification.maxUnpackedBytes)}`
        );
    }

    if (specification.expectedSideEffects) {
        if (
            JSON.stringify(packageJson.sideEffects) !==
            JSON.stringify(specification.expectedSideEffects)
        ) {
            fail(
                specification.name,
                "sideEffects allowlist changed unexpectedly"
            );
        }
        for (const sideEffectPath of specification.expectedSideEffects) {
            const packedPath = normalizePath(sideEffectPath).replace(
                /^\.\//,
                ""
            );
            if (!pathSet.has(packedPath)) {
                fail(
                    specification.name,
                    `sideEffects path is not packed: ${sideEffectPath}`
                );
            }
        }
    }

    console.log(
        `${specification.name}: ${paths.length} files, ${formatBytes(calculatedUnpackedBytes)} unpacked bytes (budget ${formatBytes(specification.maxUnpackedBytes)})`
    );
}
