import { defineConfig, devices } from "@playwright/test";
import { loadEnv } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load env from this package's .env/.env.local for Playwright (including non-VITE_ vars like TEST_EMAIL)
const envDir = path.dirname(fileURLToPath(import.meta.url));
const mode = process.env.MODE || process.env.NODE_ENV || "test";
const loaded = loadEnv(mode, envDir, "");
for (const [k, v] of Object.entries(loaded)) {
    if (process.env[k] === undefined) process.env[k] = v;
}

// Use a dedicated port to avoid clashing with local dev server defaults
const PORT = Number(process.env.PORT || 5183);
const HOST = process.env.HOST || "localhost";
const BASE_HTTP = `http://${HOST}:${PORT}`;

// Ensure tests that read process.env.BASE_URL get the same host:port
process.env.BASE_URL = BASE_HTTP;
export default defineConfig({
    testDir: "./tests",
    timeout: 60_000,
    expect: { timeout: 10_000 },
    retries: 0,

    use: {
        // Default: persistent mode; tests explicitly opt into ephemeral via URL when needed
        baseURL: `${BASE_HTTP}#/`,
        trace: "retain-on-failure",
        video: "retain-on-failure",
        screenshot: "only-on-failure",
    },

    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
    webServer: {
        // Spawn Vite via pnpm so the workspace-local version is used
        command: `pnpm exec vite dev --port ${PORT} --host ${HOST}`,
        port: PORT,
        reuseExistingServer: false,
    },
    workers: 1,
});
