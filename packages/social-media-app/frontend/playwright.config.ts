import { defineConfig, devices } from "@playwright/test";

// Use a non-default port to avoid clashing with local dev
const PORT = Number(process.env.PORT || 5190);
const HOST = process.env.HOST || "localhost";
const BASE_HTTP = `http://${HOST}:${PORT}`;

// Ensure tests that read process.env.BASE_URL get the same host:port
process.env.BASE_URL = process.env.BASE_URL || BASE_HTTP;

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
        // Use package script with forwarded flag to respect local vite config
        command: `yarn start -- --port ${PORT}`,
        url: BASE_HTTP,
        reuseExistingServer: true,
    },
    workers: 1,
});
