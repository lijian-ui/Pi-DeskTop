import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron";
import path from "path";

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: "src/main/index.ts",
        vite: {
          build: {
            outDir: "dist/main",
            rollupOptions: {
              external: ["electron", "node-pty", /^@earendil-works\//],
            },
          },
        },
      },
      {
        entry: "src/preload/index.ts",
        onstart({ reload }) {
          reload();
        },
        vite: {
          build: {
            outDir: "dist/preload",
          },
        },
      },
    ]),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});