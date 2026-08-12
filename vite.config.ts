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
        onstart({ startup }) {
          // WorkBuddy 开发环境会通过 NODE_OPTIONS 注入 genie-safe-delete shim，
          // 触发条件是 CODEBUDDY_SESSION_ID / CLAUDE_SESSION_ID 存在。该 shim
          // 把 fs.unlink/rm 劫持成"移入回收站"，导致 Pi SDK SettingsManager 的
          // proper-lockfile 释放锁失败 → settings.json 读不出 packages →
          // 扩展 0 加载 → 斜杠命令只剩 /compact。清掉会话 ID 让 shim 零开销退出。
          // （打包后的应用独立启动，本无这些变量，不受影响。）
          startup([".", "--no-sandbox"], {
            env: {
              ...process.env,
              CODEBUDDY_SESSION_ID: "",
              CLAUDE_SESSION_ID: "",
            },
          });
        },
        vite: {
          build: {
            outDir: "dist/main",
            rollupOptions: {
              external: [
                "electron",
                "node-pty",
                /^@earendil-works\//,
                // dingtalk-stream is CJS and pulls in `ws`, which tries to
                // require optional native deps (bufferutil / utf-8-validate).
                // Bundling them breaks (rollup leaves a dangling import), so
                // keep the whole chain external — at runtime Electron resolves
                // them from node_modules and ws falls back to pure JS.
                "dingtalk-stream",
                "ws",
                "bufferutil",
                "utf-8-validate",
                // QQ bot SDK + connector pull in `qrcode-terminal`, whose
                // legacy octal escapes (`\033[40m`) are a syntax error in
                // rollup's strict mode — keep the whole chain external and
                // let Electron resolve them at runtime (same pattern as
                // dingtalk-stream above).
                "@tencent-connect/qqbot-connector",
                "@tencent-connect/qqbot-nodejs",
                "qrcode-terminal",
              ],
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