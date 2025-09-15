import { defineConfig } from "vitest/config";

const SHARED = {
    isolate: false,
    sequence: { concurrent: false, shuffle: false } as const,
    hookTimeout: 120_000,
    testTimeout: 120_000,
    bail: 1,
    passWithNoTests: true,
    reporters: process.env.CI ? ["basic", "junit"] : ["default"],
    outputFile: process.env.CI
        ? { junit: "reports/vitest-junit.xml" }
        : undefined,
};

// Node project: runs generic + *.node.* (but not *.dom.*)
const NODE = defineConfig({
    test: {
        ...SHARED,
        name: "node",
        environment: "node",
        include: [
            "**/src/__tests__/**/*.test.ts",
            "**/src/__tests__/**/*.spec.ts",
            "**/src/__tests__/**/*.node.test.ts",
            "**/src/__tests__/**/*.node.spec.ts",
            "src/__tests__/**/*.test.ts",
            "src/__tests__/**/*.spec.ts",
        ],
        exclude: [
            "**/src/__tests__/**/*.dom.test.ts",
            "**/src/__tests__/**/*.dom.spec.ts",
            "node_modules",
            "**/frontend/**",
            "**/*.timestamp-*.mjs",
        ],
        setupFiles: ["./vitest.setup.ts"],
    },
});

// jsdom project: only *.dom.*
const JSDOM = defineConfig({
    test: {
        ...SHARED,
        name: "happy-dom",
        environment: "happy-dom",
        globals: true,
        include: [
            "**/src/__tests__/**/*.dom.test.ts",
            "**/src/__tests__/**/*.dom.spec.ts",
        ],
        exclude: ["node_modules", "**/frontend/**", "**/*.timestamp-*.mjs"],
        setupFiles: ["vitest.setup.ts", "vitest.setup.dom.ts"],
    },
});

export default defineConfig({
    // This keeps your original root behavior available as a project
    test: {
        projects: [/* ROOT, */ NODE, JSDOM],
    },
});
