import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    assertAccountAuthDisabledBuild,
    assertAccountAuthDisabledEnvironment,
    assertAccountAuthDisabledManifest,
} from "../cloudflare/account-auth-policy.mjs";

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--dist")) {
    throw new Error(
        "Usage: validate-cloudflare-account-auth.mjs [--dist DIRECTORY]"
    );
}

assertAccountAuthDisabledEnvironment(process.env);
assertAccountAuthDisabledManifest(
    JSON.parse(
        readFileSync(path.join(repoRoot, "cloudflare/sites.json"), "utf8")
    )
);

if (args.length === 2) {
    assertAccountAuthDisabledBuild(path.resolve(repoRoot, args[1]));
}

console.log(
    `Giga Cloudflare account auth is explicitly disabled${
        args.length === 2 ? " and the build contains no Supabase project" : ""
    }.`
);
