import vue from "@vitejs/plugin-vue";
import peerbit from "@peerbit/vite";
import { defineConfig } from "vite";

export default defineConfig({
    plugins: [vue(), peerbit()],
    optimizeDeps: {
        esbuildOptions: {
            target: "esnext",
        },
    },
    build: {
        target: "esnext",
    },
});
