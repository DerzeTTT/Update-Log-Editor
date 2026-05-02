import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  root: "client",
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4317"
    }
  },
  build: {
    outDir: "../dist/client",
    emptyOutDir: true
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["../tests/**/*.{test,spec}.?(c|m)[jt]s?(x)"]
  }
});
