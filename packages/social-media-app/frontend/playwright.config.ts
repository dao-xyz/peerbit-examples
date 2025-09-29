import { defineConfig, devices } from "@playwright/test";

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
        command: `pnpm exec vite --port ${PORT}`,
        url: BASE_HTTP,
        reuseExistingServer: false,
    },
    workers: 1,
});
