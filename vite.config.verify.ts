import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron";
import path from "path";

export default defineConfig({
  build: { emptyOutDir: false },
  plugins: [
    react(),
    electron([
      {
        entry: "src/main/index.ts",
        vite: { build: { outDir: "dist-verify/main", emptyOutDir: true, rollupOptions: { external: ["electron", "node-pty", /^@earendil-works\//] } } },
      },
      {
        entry: "src/preload/index.ts",
        onstart({ reload }) { reload(); },
        vite: { build: { outDir: "dist-verify/preload", emptyOutDir: true } },
      },
    ]),
  ],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
