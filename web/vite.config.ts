import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  base: "./",                                    // relative asset URLs: the same build works at "/" and at "/agentnet/"
  plugins: [vue()],
  build: { outDir: "dist", emptyOutDir: true, assetsDir: "assets" },
  server: { port: 5196, proxy: { "/v1": "http://127.0.0.1:3196", "/api": "http://127.0.0.1:3196" } },
});
