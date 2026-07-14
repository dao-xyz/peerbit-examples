import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const ACCOUNT_AUTH_FLAG = "VITE_SUPABASE_AUTH_ENABLED";
export const ACCOUNT_AUTH_CREDENTIALS = [
    "VITE_SUPABASE_URL",
    "VITE_SUPABASE_ANON_KEY",
];
export const RETIRED_SUPABASE_PROJECT_REF = "gghgdezsgisejiaofnrm";

const textExtensions = new Set([".css", ".html", ".js", ".json", ".mjs"]);

const configured = (value) =>
    typeof value === "string" && value.trim().length > 0;

export const assertAccountAuthDisabledEnvironment = (env) => {
    if (env[ACCOUNT_AUTH_FLAG] !== "false") {
        throw new Error(
            `${ACCOUNT_AUTH_FLAG} must be exactly "false" for Cloudflare builds`
        );
    }

    const exposedCredentials = ACCOUNT_AUTH_CREDENTIALS.filter((name) =>
        configured(env[name])
    );
    if (exposedCredentials.length > 0) {
        throw new Error(
            `Cloudflare builds must not receive account-auth credentials: ${exposedCredentials.join(
                ", "
            )}`
        );
    }
};

export const assertAccountAuthDisabledManifest = (manifest) => {
    const giga = manifest?.staticSites?.find((site) => site.id === "giga");
    if (!giga) throw new Error("Cloudflare manifest is missing the Giga site");
    if (giga.accountAuth !== "disabled") {
        throw new Error(
            'Giga must declare accountAuth: "disabled" in cloudflare/sites.json'
        );
    }
};

const walkTextFiles = (directory) => {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...walkTextFiles(fullPath));
        else if (entry.isFile() && textExtensions.has(path.extname(entry.name)))
            files.push(fullPath);
    }
    return files;
};

export const assertAccountAuthDisabledBuild = (directory) => {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
        throw new Error(`Giga build directory does not exist: ${directory}`);
    }

    const searchable = walkTextFiles(directory)
        .map((file) => readFileSync(file, "utf8"))
        .join("\n");

    if (searchable.includes(RETIRED_SUPABASE_PROJECT_REF)) {
        throw new Error(
            `Giga build contains retired Supabase project ${RETIRED_SUPABASE_PROJECT_REF}`
        );
    }

    const projectUrl = searchable.match(
        /https:\/\/[a-z0-9-]+\.supabase\.(?:co|in)(?=[/"'`\\]|$)/i
    )?.[0];
    if (projectUrl) {
        throw new Error(
            `Giga Cloudflare build contains a Supabase project URL while account auth is disabled: ${projectUrl}`
        );
    }

    if (searchable.includes("sb_publishable_")) {
        throw new Error(
            "Giga Cloudflare build contains a Supabase publishable key while account auth is disabled"
        );
    }
};
