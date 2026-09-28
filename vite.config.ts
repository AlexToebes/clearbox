/// <reference types="vitest/config" />
import path from "node:path";
import process from "node:process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Browser demo mode (`pnpm dev:demo`, i.e. `vite --mode demo`; see
      // `src/dev/demoServices.ts`) swaps in a `Services` built from fake
      // platform edges (auth, Gmail, the database) instead of the real
      // Tauri-backed ones — everything above that (UI, scan, SQL) runs
      // unmodified. This key must come before the general "@" one below so
      // it's matched first; it's a no-op outside `mode === "demo"`, so a
      // production build never resolves it and never bundles demo code.
      ...(mode === "demo"
        ? {
            "@/app/services": path.resolve(
              import.meta.dirname,
              "./src/dev/demoServices.ts",
            ),
          }
        : {}),
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  // sqlite-wasm ships its own Wasm/worker loading that Vite's dependency
  // pre-bundler shouldn't try to optimize (see the package's own Vite
  // guidance) — only relevant in demo mode, which is the only place it's
  // imported (`src/dev/wasmDb.ts`).
  ...(mode === "demo"
    ? { optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] } }
    : {}),

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
}));
