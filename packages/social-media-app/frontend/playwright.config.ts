import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "./tests",
    timeout: 60_000,
    expect: { timeout: 10_000 },
    retries: 0,
    use: {
        baseURL: process.env.BASE_URL || "http://localhost:5173",
        trace: "retain-on-failure",
        video: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
    webServer: {
        command: "yarn start",
        url: "http://localhost:5173",
        reuseExistingServer: true,
    },
});
