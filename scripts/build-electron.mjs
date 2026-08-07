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
//   Per-arch builds (--arm64 / --x64):
//     node-pty loads its native binary by trying, in order, build/Release,
//     build/Debug, then prebuilds/<platform>-<arch>, falling through on error
//     (see lib/utils.js loadNativeModule). When BOTH --arm64 and --x64 are
//     requested we rebuild node-pty once per arch, drop each result into
//     prebuilds/darwin-<arch>/pty.node, and DELETE build/Release so every
//     packaged app resolves its own arch from prebuilds. This keeps both
//     .dmg/.zip working on their respective Macs.
//
// Usage (same args you'd pass to electron-builder):
//   node scripts/build-electron.mjs --mac --x64 --arm64
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";

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

if (platform() === "darwin") {
  const archArgs = args.filter((a) => a === "--arm64" || a === "--x64");
  if (archArgs.length >= 2) {
    // Multi-arch: rebuild once per requested arch, stash into prebuilds/,
    // then remove build/Release so each packaged app picks its own arch.
    for (const a of archArgs) {
      const arch = a.replace(/^--/, "");
      console.log(`[build] macOS: rebuilding node-pty for ${arch}...`);
      run("npx", ["electron-rebuild", "-f", "-w", "node-pty", "--arch", arch]);
      const src = join(root, "node_modules/node-pty/build/Release/pty.node");
      const destDir = join(root, `node_modules/node-pty/prebuilds/darwin-${arch}`);
      mkdirSync(destDir, { recursive: true });
      copyFileSync(src, join(destDir, "pty.node"));
      console.log(`[build]   -> ${join(destDir, "pty.node")}`);
    }
    rmSync(join(root, "node_modules/node-pty/build"), { recursive: true, force: true });
    console.log("[build] removed build/Release — node-pty now resolves per-arch from prebuilds/.");
  } else {
    // Single-arch (or no explicit arch): rebuild for the requested/current arch.
    const single = archArgs.length === 1 ? archArgs[0].replace(/^--/, "") : undefined;
    console.log(
      `[build] macOS: rebuilding node-pty${single ? ` for ${single}` : " against bundled Electron"}...`
    );
    run(
      "npx",
      single
        ? ["electron-rebuild", "-f", "-w", "node-pty", "--arch", single]
        : ["electron-rebuild", "-f", "-w", "node-pty"]
    );
  }
} else {
  console.log(
    `[build] ${platform()} detected: skipping node-pty rebuild (using prebuilt binary).`
  );
}

// Hand off to electron-builder with whatever args were passed through.
run("npx", ["electron-builder", ...args]);
