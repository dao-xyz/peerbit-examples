import { defineConfig } from "@playwright/test";

const PORT = 4174;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
    testDir: "./tests",
    timeout: 6 * 60 * 1000,
    fullyParallel: false,
    retries: 0,
    reporter: "line",
    use: {
        baseURL: BASE_URL,
        headless: true,
    },
    webServer: {
        command: [
            "pnpm --filter @peerbit/please-lib run build",
            "pnpm --filter file-share run build",
            `pnpm --filter file-share exec vite preview --host 127.0.0.1 --port ${PORT}`,
        ].join(" && "),
        url: BASE_URL,
        reuseExistingServer: true,
        timeout: 8 * 60 * 1000,
    },
});
