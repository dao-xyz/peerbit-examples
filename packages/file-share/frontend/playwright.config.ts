import { execSync } from "node:child_process";
import { defineConfig, devices } from "@playwright/test";

function pickFreePort(host: string): number {
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

function normalizeBaseUrl(url: string): string {
    return url.replace(/#.*$/, "").replace(/\/$/, "");
}

const HOST = process.env.HOST || "127.0.0.1";
const REQUESTED_PORT =
    process.env.PW_PORT || process.env.E2E_PORT || process.env.PORT;
const PORT = REQUESTED_PORT ? Number(REQUESTED_PORT) : pickFreePort(HOST);
if (!REQUESTED_PORT) {
    process.env.PW_PORT = String(PORT);
}

const explicitBaseUrl = process.env.PW_BASE_URL
    ? normalizeBaseUrl(process.env.PW_BASE_URL)
    : undefined;
const viteMode = process.env.PW_VITE_MODE || "development";
const viteConfig = process.env.PW_VITE_CONFIG;
const viteConfigArg = viteConfig ? ` --config ${viteConfig}` : "";
const localProtocol =
    process.env.PW_PROTOCOL ||
    (viteConfig?.includes("remote") ? "https" : "http");
const localBaseUrl = `${localProtocol}://${HOST}:${PORT}`;
const baseURL = explicitBaseUrl || localBaseUrl;
const ignoreHTTPSErrors =
    process.env.PW_IGNORE_HTTPS_ERRORS === "1" ||
    (!explicitBaseUrl && localProtocol === "https");

export default defineConfig({
    testDir: "./tests",
    timeout: 8 * 60 * 1000,
    expect: {
        timeout: 15_000,
    },
    retries: 0,
    reporter: "line",
    workers: 1,
    use: {
        baseURL,
        headless: true,
        ignoreHTTPSErrors,
        screenshot: "only-on-failure",
        trace: "retain-on-failure",
        video: "retain-on-failure",
    },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
    webServer: explicitBaseUrl
          ? undefined
        : {
              command: `pnpm --filter @peerbit/please-lib build && pnpm exec vite dev --mode ${viteMode}${viteConfigArg} --port ${PORT} --strictPort --host ${HOST}`,
              ignoreHTTPSErrors,
              url: localBaseUrl,
              reuseExistingServer: false,
              timeout: 8 * 60 * 1000,
          },
});
