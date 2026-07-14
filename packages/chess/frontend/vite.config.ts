import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import peerbit from "@peerbit/vite";
// @ts-ignore
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react(), peerbit(), tailwindcss()],
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
});
