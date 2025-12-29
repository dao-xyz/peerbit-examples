import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import peerbit from "@peerbit/vite";
// @ts-ignore
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [
        react(),
        peerbit(),
        tailwindcss(),
        // Only enable TLS for explicit test flag; default is plain http
        ...(process.env.VITE_TEST_HTTPS === "true" ? [basicSsl()] : []),
    ],
    optimizeDeps: {
        include: ["react", "react-dom", "react/jsx-runtime"],
        esbuildOptions: {
            target: "esnext",
        },
    },
    build: {
        target: "esnext",
    },
    resolve: {
        // Prevent duplicate React copies when using workspace packages / symlinks
        dedupe: ["react", "react-dom"],
    },

    define: {
        "globalThis.COMMIT_HASH": JSON.stringify(
            process.env.SHORT_SHA || "unknown"
        ),
        APP_VERSION: JSON.stringify(process.env.npm_package_version),
    },
    server:
        process.env.VITE_TEST_HTTPS === "true"
            ? {
                  https: true,
                  host: process.env.HOST || "localhost",
              }
            : undefined,
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
