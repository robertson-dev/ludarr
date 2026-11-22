import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// the ludarr admin UI; dev: `bun run dev` serves on :7980 and proxies the API to a running ludarr on :7979
export default defineConfig({
  plugins: [react()],
  build: { outDir: "../public", emptyOutDir: true },
  server: {
    port: 7980,
    proxy: { "/api": { target: process.env.LUDARR_URL || "http://localhost:7979", changeOrigin: true } },
  },
});
