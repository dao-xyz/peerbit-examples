import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
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
              host: "filedrop.test.xyz",
              port: 5803,
          }
        : undefined,
});
