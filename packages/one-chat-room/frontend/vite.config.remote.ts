import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import peerbit from "@peerbit/vite";
import fs from "fs";

const wasmContentTypePlugin = {
    name: "wasm-content-type-plugin",
    configureServer(server) {
        server.middlewares.use((req, res, next) => {
            if (req.url.endsWith(".wasm")) {
                res.setHeader("Content-Type", "application/wasm");
            }
            next();
        });
    },
};

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react(), wasmContentTypePlugin, peerbit()],
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
              port: 5802,
              https: {
                  key: fs.readFileSync("./.cert/key.pem"),
                  cert: fs.readFileSync("./.cert/cert.pem"),
              },
              host: "chat.test.xyz",
          }
        : undefined,
});
