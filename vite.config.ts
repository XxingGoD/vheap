import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(projectRoot, "frontend"),
  plugins: [react()],
  build: {
    outDir: path.join(projectRoot, "vheapViews", "dist"),
    emptyOutDir: true,
    sourcemap: false,
    // Keep optional chaining and BigInt support within the baseline of
    // Chromium-based Edge versions commonly shipped with Linux/Windows.
    target: "es2020",
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/socket.io": {
        target: "http://127.0.0.1:8080",
        ws: true,
      },
    },
  },
});
