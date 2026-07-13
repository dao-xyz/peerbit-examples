import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

import peerbit from "@peerbit/vite";

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react(), peerbit()],
    esbuild: {
        target: "es2022",
        tsconfigRaw: {
            compilerOptions: {
                useDefineForClassFields: true,
            },
        },
    },
    optimizeDeps: {
        esbuildOptions: {
            target: "es2022",
            tsconfigRaw: {
                compilerOptions: {
                    useDefineForClassFields: true,
                },
            },
        },
        // disable all optimizations
    },
    build: {
        target: "es2022",
    },
    define: {
        APP_VERSION: JSON.stringify(process.env.npm_package_version),
    },
});
