import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import peerbit from "@peerbit/vite";
// @ts-ignore
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react(), peerbit(), tailwindcss()],
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
    server: fs.existsSync("./.cert/key.pem")
        ? {
              https: {
                  key: fs.readFileSync("./.cert/key.pem"),
                  cert: fs.readFileSync("./.cert/cert.pem"),
              },
              host: "text.test.xyz",
              port: 5803,
          }
        : undefined,
});
