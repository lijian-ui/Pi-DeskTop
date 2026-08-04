#!/usr/bin/env node
// Cross-platform Electron build wrapper.
//
// Why this exists:
//   node-pty is a native (N-API) module. On Windows its npm-published prebuild
//   loads fine inside Electron 35, so no rebuild is needed. On macOS the
//   published darwin prebuild loads but fails at runtime with
//   "posix_spawnp failed" under Electron 35's Node 22 runtime, because the
//   prebuilt binary was compiled against a different spawn implementation.
//   The fix is to rebuild node-pty against the *bundled* Electron headers.
//
//   electron-builder's `npmRebuild` is a global flag only (it cannot be set per
//   platform), and enabling it globally would force a node-gyp build on Windows
//   too — which fails on machines without VS/Python. So we rebuild node-pty
//   *manually, only on macOS*, and keep electron-builder's npmRebuild:false.
//
// Usage (same args you'd pass to electron-builder):
//   node scripts/build-electron.mjs --mac --x64 --arm64
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const args = process.argv.slice(2);

function run(bin, binArgs, opts = {}) {
  const result = spawnSync(bin, binArgs, {
    stdio: "inherit",
    shell: true,
    cwd: root,
    ...opts,
  });
  if (result.error) {
    console.error(`Failed to spawn ${bin}:`, result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`Command failed: ${bin} ${binArgs.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

// On macOS, rebuild node-pty against the locally installed Electron before
// packaging. We resolve the local CLI via `npx` so it works cross-platform
// (on Windows the .bin launcher lacks a .cmd extension when spawned directly).
if (platform() === "darwin") {
  console.log("[build] macOS: rebuilding node-pty against bundled Electron...");
  run("npx", ["electron-rebuild", "-f", "-w", "node-pty"]);
} else {
  console.log(
    `[build] ${platform()} detected: skipping node-pty rebuild (using prebuilt binary).`
  );
}

// Hand off to electron-builder with whatever args were passed through.
run("npx", ["electron-builder", ...args]);
