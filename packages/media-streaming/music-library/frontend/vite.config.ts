import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import peerbit from "@peerbit/vite";
// @ts-ignore
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react(), peerbit(), tailwindcss()],
    resolve: {
        // The workspace contains multiple Peerbit release generations. Keep
        // cryptographic key classes singleton within this browser bundle so
        // Borsh's runtime class checks see the same constructor identity.
        dedupe: ["@peerbit/crypto"],
    },
    optimizeDeps: {
        esbuildOptions: {
            target: "esnext",
        },
    },
    build: {
        target: "esnext",
    },
    define: {
        APP_VERSION: JSON.stringify(process.env.npm_package_version),
    },
});
