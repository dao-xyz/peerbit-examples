import { defineConfig } from "vitest/config";
import path from "path";
const IGNORE_UNHANDLED = process.env.VITEST_IGNORE_UNHANDLED_ERRORS === "1";
const SHARED = {
    isolate: false,
    sequence: { concurrent: false, shuffle: false } as const,
    hookTimeout: 120_000,
    testTimeout: 120_000,
    bail: 1,
    passWithNoTests: true,
    dangerouslyIgnoreUnhandledErrors: IGNORE_UNHANDLED,
    reporters: process.env.CI ? ["basic", "junit"] : ["default"],
    outputFile: process.env.CI
        ? { junit: "reports/vitest-junit.xml" }
        : undefined,
};

// A file that installs a fake clock (vi.useFakeTimers) is named
// *.isolated.test.ts and runs alone in a fresh process. Under isolate:false
// a worker's earlier files can leave real work running, such as a stopped
// libp2p's peer-store lock queues and debounces, and any timer that work
// arms through the global setTimeout lands in the fake clock.
const ISOLATED = "**/src/__tests__/**/*.isolated.test.ts";
const NODE_EXCLUDE = [
    "**/src/__tests__/**/*.dom.test.ts",
    "**/src/__tests__/**/*.dom.spec.ts",
    "**/node_modules/**",
    "**/frontend/**",
    "**/*.timestamp-*.mjs",
];

// Node project: runs generic + *.node.* (but not *.dom.* or *.isolated.*)
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
        exclude: [...NODE_EXCLUDE, ISOLATED],
        setupFiles: ["./vitest.setup.ts"],
    },
});

// Node project for *.isolated.test.ts: one fresh process per file.
const NODE_ISOLATED = defineConfig({
    test: {
        ...NODE.test,
        name: "node-isolated",
        isolate: true,
        include: [ISOLATED],
        exclude: NODE_EXCLUDE,
    },
});

// jsdom project: only *.dom.*
const JSDOM = defineConfig({
    resolve: {
        // Force a single React instance across the graph
        dedupe: ["react", "react-dom"],
        // (Optional but handy in monorepos) hard alias to root node_modules
        /* alias: {
            react: path.resolve("node_modules/react"),
            "react-dom": path.resolve("node_modules/react-dom"),
        }, */
    },
    optimizeDeps: {
        // Prebundle one copy only
        include: ["react", "react-dom"],
    },
    test: {
        ...SHARED,

        name: "happy-dom",
        environment: "happy-dom",
        globals: true,
        include: [
            "**/src/__tests__/**/*.dom.test.ts",
            "**/src/__tests__/**/*.dom.spec.ts",
        ],
        exclude: [
            "**/node_modules/**",
            "**/frontend/**",
            "**/*.timestamp-*.mjs",
        ],
        setupFiles: ["vitest.setup.ts", "vitest.setup.dom.ts"],
    },
});

export default defineConfig({
    // This keeps your original root behavior available as a project
    test: {
        projects: [/* ROOT, */ NODE, NODE_ISOLATED, JSDOM],
    },
});
