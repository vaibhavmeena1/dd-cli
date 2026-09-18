import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import config from "./config.json" with { type: "json" };

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: config.VITE_BASE_PATH,
  server: {
    port: config.port,
  },
  preview: {
    port: config.port,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@config": path.resolve(import.meta.dirname, "./config.json"),
    },
  },
});
