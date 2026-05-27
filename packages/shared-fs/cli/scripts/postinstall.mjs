#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (process.env.PEERBIT_SHARED_FS_SKIP_NATIVE_POSTINSTALL === "1") {
    process.exit(0);
}

const isGlobalInstall =
    process.env.npm_config_global === "true" ||
    process.env.npm_config_global === "1" ||
    process.env.npm_config_location === "global";

if (!isGlobalInstall) {
    process.exit(0);
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const installer = join(packageRoot, "lib", "esm", "install-native-adapter.js");

if (!existsSync(installer)) {
    process.exit(0);
}

const result = spawnSync(
    process.execPath,
    [installer, "--if-needed", "--quiet"],
    { stdio: "inherit" }
);

if (result.error || result.status !== 0) {
    console.warn(
        "peerbit-fs native adapter auto-install skipped; run `peerbit-fs install-adapter` after install."
    );
}
