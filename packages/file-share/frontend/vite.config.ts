import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import peerbit from "@peerbit/vite";
// @ts-ignore
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react(), peerbit(), tailwindcss()],
    esbuild: {
        keepNames: true,
    },
    resolve: {
        dedupe: [
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

    /*  server: fs.existsSync("./.cert/key.pem")
         ? {
               https: {
                   key: fs.readFileSync("./.cert/key.pem"),
                   cert: fs.readFileSync("./.cert/cert.pem"),
               },
               host: "meet.dao.xyz",
           }
         : undefined, */
});
