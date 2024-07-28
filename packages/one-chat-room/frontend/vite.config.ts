import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

import peerbit from "@peerbit/vite";

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react(), peerbit()],
    optimizeDeps: {
        esbuildOptions: {
            target: "esnext",
        },
        // disable all optimizations
    },
    build: {
        target: "esnext",
    },
    define: {
        APP_VERSION: JSON.stringify(process.env.npm_package_version),
    },

    /*  server: fs.existsSync("./.cert/key.pem")
         ? {
               port: 5802,
               https: {
                   key: fs.readFileSync("./.cert/key.pem"),
                   cert: fs.readFileSync("./.cert/cert.pem"),
               },
               host: "chat.test.xyz",
           }
         : undefined, */
});
