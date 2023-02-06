import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],

    build: {
        target: "es2022",
    },
    define: {
        APP_VERSION: JSON.stringify(process.env.npm_package_version),
    },
    base: "/peerbit-examples/",
});
