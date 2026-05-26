#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const packages = ["packages/shared-fs/library", "packages/shared-fs/cli"];

for (const packageDir of packages) {
    fs.rmSync(path.join(packageDir, "lib"), {
        force: true,
        recursive: true,
    });
}

for (const packageDir of packages) {
    const tsconfig = path.join(packageDir, "tsconfig.json");
    const result = spawnSync(
        "pnpm",
        ["--package=typescript@5.6.3", "dlx", "tsc", "-p", tsconfig],
        {
            shell: process.platform === "win32",
            stdio: "inherit",
        }
    );
    if (result.error) {
        console.error(result.error);
        process.exit(1);
    }
    if ((result.status ?? 1) !== 0) {
        process.exit(result.status ?? 1);
    }
}
