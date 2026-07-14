import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import peerbit from "@peerbit/vite";

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react(), peerbit()],
    optimizeDeps: {
        esbuildOptions: {
            target: "es2022",
        },
    },
    build: {
        target: "es2022",
    },
    define: {
        APP_VERSION: JSON.stringify(process.env.npm_package_version),
    },
    base: "/",
});
