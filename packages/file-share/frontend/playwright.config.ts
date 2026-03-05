import { defineConfig, devices } from "@playwright/test";
import { execSync } from "node:child_process";

function pickFreePort(host: string): number {
    // Keep this as a single line; passing `\n` to `node -e` can break on some shells.
    const script =
        "const net=require('net');const host=process.argv[1]||'127.0.0.1';const server=net.createServer();server.on('error',()=>process.exit(1));server.listen(0,host,()=>{const addr=server.address();const port=addr&&typeof addr==='object'?addr.port:0;process.stdout.write(String(port||''));server.close();});";
    const out = execSync(
        `${process.execPath} -e ${JSON.stringify(script)} ${host}`,
        { stdio: ["ignore", "pipe", "ignore"] }
    )
        .toString()
        .trim();
    const port = Number(out);
    if (!Number.isInteger(port) || port <= 0) {
        throw new Error(`Failed to pick a free port (got "${out}")`);
    }
    return port;
}

// Use "localhost" by default: the local Peerbit bootstrap server (8082) enforces
// CORS and expects a localhost origin.
const HOST = process.env.HOST || "localhost";
const REQUESTED_PORT =
    process.env.PW_PORT || process.env.E2E_PORT || process.env.PORT;
const PORT = REQUESTED_PORT ? Number(REQUESTED_PORT) : pickFreePort(HOST);
if (!REQUESTED_PORT) process.env.PW_PORT = String(PORT);

const BASE_HTTP = `http://${HOST}:${PORT}`;
process.env.BASE_URL = BASE_HTTP;

// Default to a remote-capable mode: the local bootstrap endpoint is not always
// available in CI/dev environments.
const VITE_MODE = process.env.PW_VITE_MODE || "staging";
const VITE_CONFIG =
    process.env.PW_VITE_CONFIG ||
    (VITE_MODE === "development" ? "" : "--config vite.config.remote.ts");

export default defineConfig({
    testDir: "./tests",
    timeout: 120_000,
    expect: { timeout: 15_000 },
    retries: 0,
    workers: 1,

    use: {
        baseURL: `${BASE_HTTP}/`,
        trace: "retain-on-failure",
        video: "retain-on-failure",
        screenshot: "only-on-failure",
    },

    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

    webServer: {
        command: `pnpm exec vite dev --mode ${VITE_MODE} ${VITE_CONFIG} --port ${PORT} --strictPort --host ${HOST}`,
        url: BASE_HTTP,
        reuseExistingServer: false,
    },
});
