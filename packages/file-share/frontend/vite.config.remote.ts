import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";

import peerbit from "@peerbit/vite";
// @ts-ignore
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react(), peerbit(), tailwindcss()],
    resolve: {
        // Ensure a single instance of Peerbit packages across workspace boundaries.
        dedupe: [
            "peerbit",
            "@peerbit/crypto",
            "@peerbit/document",
            "@peerbit/document-interface",
            "@peerbit/shared-log",
            "@peerbit/indexer-interface",
            "@peerbit/indexer-sqlite3",
            "@peerbit/indexer-simple",
            "@peerbit/indexer-cache",
            "@peerbit/log",
            "@peerbit/program",
            "@peerbit/program-react",
            "@peerbit/pubsub",
            "@peerbit/stream-interface",
            "@peerbit/stream",
            "@peerbit/trusted-network",
            "@peerbit/react",
        ],
    },
    optimizeDeps: {
        // Prebundle the Peerbit stack to avoid thousands of module requests on first load.
        include: [
            "peerbit",
            "@peerbit/crypto",
            "@peerbit/document",
            "@peerbit/shared-log",
            "@peerbit/stream",
            "@peerbit/react",
        ],
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
