import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        include: ["src/__tests__/**/*.spec.ts", "src/__tests__/**/*.spec.tsx"],
        environment: "jsdom",
        isolate: false,
        hookTimeout: 15_000,
        testTimeout: 15_000,
        passWithNoTests: true,
        reporters: process.env.CI ? ["basic", "junit"] : ["default"],
        outputFile: process.env.CI
            ? { junit: "reports/frontend-vitest-junit.xml" }
            : undefined,
    },
});
