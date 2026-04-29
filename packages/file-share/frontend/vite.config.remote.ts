import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import peerbit from "@peerbit/vite";
// @ts-ignore
import tailwindcss from "@tailwindcss/vite";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const workspaceModule = (specifier: string) =>
    path.join(workspaceRoot, "node_modules", ...specifier.split("/"));

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react(), peerbit(), tailwindcss()],
    esbuild: {
        keepNames: true,
    },
    resolve: {
        /* peerbit-benchmark-vite */
        alias: {
            react: workspaceModule("react"),
            "react-dom": workspaceModule("react-dom"),
            "@dao-xyz/borsh": workspaceModule("@dao-xyz/borsh"),
        },
        dedupe: [
            "react",
            "react-dom",
            "@dao-xyz/borsh",
            "peerbit",
            "@peerbit/crypto",
            "@peerbit/document",
            "@peerbit/document-interface",
            "@peerbit/shared-log",
            "@peerbit/rpc",
            "@peerbit/indexer-interface",
            "@peerbit/indexer-sqlite3",
            "@peerbit/indexer-simple",
            "@peerbit/indexer-cache",
            "@peerbit/log",
            "@peerbit/program",
            "@peerbit/program-react",
            "@peerbit/pubsub",
            "@peerbit/react",
            "@peerbit/stream",
            "@peerbit/stream-interface",
            "@peerbit/trusted-network",
        ],
    },
    optimizeDeps: {
        include: [
            "peerbit",
            "@peerbit/crypto",
            "@peerbit/document",
            "@peerbit/react",
            "@peerbit/rpc",
            "@peerbit/shared-log",
            "@peerbit/stream",
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
