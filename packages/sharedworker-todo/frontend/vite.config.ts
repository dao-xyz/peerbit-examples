import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import peerbit from "@peerbit/vite";

export default defineConfig({
    plugins: [react(), peerbit()],
    worker: {
        format: "es",
    },
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
    },
    build: {
        target: "es2022",
    },
    define: {
        APP_VERSION: JSON.stringify(process.env.npm_package_version),
    },
});
