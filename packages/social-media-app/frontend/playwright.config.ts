import { defineConfig, devices } from "@playwright/test";
import { loadEnv } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

function pickFreePort(host: string): number {
    // Note: keep this as a single line; passing `\n` to `node -e` can break on some shells.
    const script =
        "const net=require('net');const host=process.argv[1]||'127.0.0.1';const server=net.createServer();server.on('error',()=>process.exit(1));server.listen(0,host,()=>{const addr=server.address();const port=addr&&typeof addr==='object'?addr.port:0;process.stdout.write(String(port||''));server.close();});";
    const out = execSync(`${process.execPath} -e ${JSON.stringify(script)} ${host}`, {
        stdio: ["ignore", "pipe", "ignore"],
    })
        .toString()
        .trim();
    const port = Number(out);
    if (!Number.isInteger(port) || port <= 0) {
        throw new Error(`Failed to pick a free port (got "${out}")`);
    }
    return port;
}

// Load env from this package's .env/.env.local for Playwright (including non-VITE_ vars like TEST_EMAIL)
const envDir = path.dirname(fileURLToPath(import.meta.url));
const mode = process.env.MODE || process.env.NODE_ENV || "test";
const loaded = loadEnv(mode, envDir, "");
for (const [k, v] of Object.entries(loaded)) {
    if (process.env[k] === undefined) process.env[k] = v;
}

// Use a dedicated port to avoid clashing with local dev server defaults
// Prefer an explicit IPv4 host to avoid IPv6/localhost resolution mismatches between
// the webServer readiness probe and the browser navigation in Playwright.
const HOST = process.env.HOST || "127.0.0.1";
// Prefer explicit override; otherwise pick a free ephemeral port to avoid collisions
// when multiple Playwright suites run concurrently.
const REQUESTED_PORT =
    process.env.PW_PORT || process.env.E2E_PORT || process.env.PORT;
const PORT = REQUESTED_PORT ? Number(REQUESTED_PORT) : pickFreePort(HOST);
// Playwright loads the config in multiple processes (runner + workers). Persist the
// selected port via env so every process uses the same port within a single run.
if (!REQUESTED_PORT) {
    process.env.PW_PORT = String(PORT);
}
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
        command: `pnpm exec vite dev --port ${PORT} --strictPort --host ${HOST}`,
        // Use an explicit URL to avoid IPv6/localhost port checks conflicting with our IPv4 host.
        url: BASE_HTTP,
        reuseExistingServer: false,
    },
    workers: 1,
});
