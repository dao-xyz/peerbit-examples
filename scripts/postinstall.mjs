#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

if (process.env.PEERBIT_SKIP_ROOT_POSTINSTALL === "1") {
    console.log("Skipping root postinstall (PEERBIT_SKIP_ROOT_POSTINSTALL=1).");
    process.exit(0);
}

const patchPackageBin =
    process.platform === "win32" ? "patch-package.cmd" : "patch-package";
const localPatchPackage = path.join("node_modules", ".bin", patchPackageBin);
const patchPackage = fs.existsSync(localPatchPackage)
    ? localPatchPackage
    : patchPackageBin;
const result = spawnSync(patchPackage, [], {
    stdio: "inherit",
    shell: process.platform === "win32",
});
if (result.error) {
    console.error(result.error);
    process.exit(1);
}
if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
}

const chaiExtendDir = path.join("node_modules", "chai-extend");
fs.mkdirSync(chaiExtendDir, { recursive: true });
fs.copyFileSync("chai-global.js", path.join(chaiExtendDir, "chai-global.js"));
fs.writeFileSync(
    path.join(chaiExtendDir, "package.json"),
    JSON.stringify({ type: "module" }) + "\n"
);
