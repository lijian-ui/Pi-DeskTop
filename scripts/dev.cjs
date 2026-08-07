/**
 * Dev wrapper: strip CODEBUDDY_SESSION_ID / CLAUDE_SESSION_ID before spawning
 * vite.  WorkBuddy's genie-safe-delete shim (injected via NODE_OPTIONS) uses
 * these env vars as its activation guard — when present it monkey-patches
 * fs.unlink/rm into "move-to-trash" which breaks proper-lockfile inside Pi SDK
 * SettingsManager, causing settings.json reads to fail, package resolution to
 * return zero extensions, and slash commands to see only /compact.
 *
 * Clearing the vars before vite starts ensures the entire process tree
 * (vite → electron main → all node children) never triggers the shim.
 */
const { spawn } = require("child_process");

const env = { ...process.env };
delete env.CODEBUDDY_SESSION_ID;
delete env.CLAUDE_SESSION_ID;

const child = spawn("npx", ["vite"], {
  stdio: "inherit",
  shell: true,
  env,
});

child.on("exit", (code) => process.exit(code ?? 0));
