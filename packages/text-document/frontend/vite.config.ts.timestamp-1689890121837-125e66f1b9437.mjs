// vite.config.ts
import { defineConfig } from "file:///Users/admin/git/peerbit-examples/node_modules/vite/dist/node/index.js";
import react from "file:///Users/admin/git/peerbit-examples/node_modules/@vitejs/plugin-react/dist/index.mjs";
var vite_config_default = defineConfig({
  plugins: [react()],
  build: {
    target: "esnext"
  },
  define: {
    APP_VERSION: JSON.stringify(process.env.npm_package_version)
  }
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
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvVXNlcnMvYWRtaW4vZ2l0L3BlZXJiaXQtZXhhbXBsZXMvcGFja2FnZXMvdGV4dC1kb2N1bWVudC9mcm9udGVuZFwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL1VzZXJzL2FkbWluL2dpdC9wZWVyYml0LWV4YW1wbGVzL3BhY2thZ2VzL3RleHQtZG9jdW1lbnQvZnJvbnRlbmQvdml0ZS5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL1VzZXJzL2FkbWluL2dpdC9wZWVyYml0LWV4YW1wbGVzL3BhY2thZ2VzL3RleHQtZG9jdW1lbnQvZnJvbnRlbmQvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcsIGxvYWRFbnYgfSBmcm9tIFwidml0ZVwiO1xuaW1wb3J0IHJlYWN0IGZyb20gXCJAdml0ZWpzL3BsdWdpbi1yZWFjdFwiO1xuaW1wb3J0IGZzIGZyb20gXCJmc1wiO1xuXG4vLyBodHRwczovL3ZpdGVqcy5kZXYvY29uZmlnL1xuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcbiAgICBwbHVnaW5zOiBbcmVhY3QoKV0sXG4gICAgYnVpbGQ6IHtcbiAgICAgICAgdGFyZ2V0OiBcImVzbmV4dFwiLFxuICAgIH0sXG4gICAgZGVmaW5lOiB7XG4gICAgICAgIEFQUF9WRVJTSU9OOiBKU09OLnN0cmluZ2lmeShwcm9jZXNzLmVudi5ucG1fcGFja2FnZV92ZXJzaW9uKSxcbiAgICB9LFxuICAgIC8qICBzZXJ2ZXI6IGZzLmV4aXN0c1N5bmMoXCIuLy5jZXJ0L2tleS5wZW1cIilcbiAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgaHR0cHM6IHtcbiAgICAgICAgICAgICAgICAgICBrZXk6IGZzLnJlYWRGaWxlU3luYyhcIi4vLmNlcnQva2V5LnBlbVwiKSxcbiAgICAgICAgICAgICAgICAgICBjZXJ0OiBmcy5yZWFkRmlsZVN5bmMoXCIuLy5jZXJ0L2NlcnQucGVtXCIpLFxuICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgIGhvc3Q6IFwibWVldC5kYW8ueHl6XCIsXG4gICAgICAgICAgIH1cbiAgICAgICAgIDogdW5kZWZpbmVkLCAqL1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQXFYLFNBQVMsb0JBQTZCO0FBQzNaLE9BQU8sV0FBVztBQUlsQixJQUFPLHNCQUFRLGFBQWE7QUFBQSxFQUN4QixTQUFTLENBQUMsTUFBTSxDQUFDO0FBQUEsRUFDakIsT0FBTztBQUFBLElBQ0gsUUFBUTtBQUFBLEVBQ1o7QUFBQSxFQUNBLFFBQVE7QUFBQSxJQUNKLGFBQWEsS0FBSyxVQUFVLFFBQVEsSUFBSSxtQkFBbUI7QUFBQSxFQUMvRDtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQVVKLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
