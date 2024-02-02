import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    optimizeDeps: {
        esbuildOptions: {
            target: "esnext",
        },
        exclude: ["@peerbit/any-store"], // https://github.com/vitejs/vite/issues/11672
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
