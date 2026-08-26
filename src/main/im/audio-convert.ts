import { execFileSync, execSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let ffmpegChecked = false;
let ffmpegAvailable = false;

/** Detect whether ffmpeg is available on the system PATH. */
export function isFfmpegAvailable(): boolean {
  if (ffmpegChecked) return ffmpegAvailable;
  try {
    execSync("ffmpeg -version", { stdio: "ignore", timeout: 3000 });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
  ffmpegChecked = true;
  return ffmpegAvailable;
}

/**
 * Convert a WAV audio buffer to OGG/Opus format (required by Feishu).
 * Returns the Opus buffer, or null if ffmpeg is unavailable / conversion fails.
 */
export function wavToOpus(wavBuffer: Buffer): Buffer | null {
  if (!isFfmpegAvailable()) return null;
  const inPath = join(tmpdir(), `tts-in-${Date.now()}.wav`);
  const outPath = join(tmpdir(), `tts-out-${Date.now()}.opus`);
  try {
    writeFileSync(inPath, wavBuffer);
    execFileSync("ffmpeg", [
      "-i", inPath,
      "-c:a", "libopus",
      "-b:a", "64k",
      "-ar", "48000",
      "-ac", "1",
      outPath,
    ], { stdio: "ignore", timeout: 30000 });
    return readFileSync(outPath);
  } catch {
    return null;
  } finally {
    try { unlinkSync(inPath); } catch { /* ignore */ }
    try { unlinkSync(outPath); } catch { /* ignore */ }
  }
}