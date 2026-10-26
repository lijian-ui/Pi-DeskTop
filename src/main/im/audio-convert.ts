import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { app } from "electron";

// Resolve a usable ffmpeg binary. @ffmpeg-installer/ffmpeg hosts its prebuilt
// binary on the npm registry (NOT GitHub), so it installs in restricted networks
// where ffmpeg-static (which fetches from GitHub's CDN) times out. Fall back to a
// bare `ffmpeg` on PATH when the package is absent.
const require = createRequire(import.meta.url);
let ffmpegPath: string | null = null;
try {
  const inst = require("@ffmpeg-installer/ffmpeg");
  ffmpegPath = inst && inst.path ? inst.path : null;
} catch {
  ffmpegPath = null;
}
// In a packaged build, require("@ffmpeg-installer/ffmpeg").path resolves inside
// app.asar — a read-only archive where the binary cannot be executed. electron-builder's
// asarUnpack extracts the real exe to app.asar.unpacked, so rewrite the path there.
let FFMPEG_BIN = ffmpegPath ?? "ffmpeg";
if (app.isPackaged && ffmpegPath && ffmpegPath.includes("app.asar")) {
  const unpacked = ffmpegPath.replace("app.asar", "app.asar.unpacked");
  if (existsSync(unpacked)) FFMPEG_BIN = unpacked;
}

let ffmpegChecked = false;
let ffmpegAvailable = false;

/** Detect whether ffmpeg is available. */
export function isFfmpegAvailable(): boolean {
  if (ffmpegChecked) return ffmpegAvailable;
  try {
    execFileSync(FFMPEG_BIN, ["-version"], { stdio: "ignore", timeout: 3000 });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
  ffmpegChecked = true;
  console.log("[ffmpeg] availability=", ffmpegAvailable, "bin=", FFMPEG_BIN, "resolvedPath=", ffmpegPath);
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
    execFileSync(FFMPEG_BIN, [
      "-i", inPath,
      "-c:a", "libopus",
      "-b:a", "64k",
      "-ar", "48000",
      "-ac", "1",
      "-f", "ogg",
      outPath,
    ], { stdio: "ignore", timeout: 30000 });
    return readFileSync(outPath);
  } catch (e) {
    console.warn("[ffmpeg] wavToOpus failed", e);
    return null;
  } finally {
    try { unlinkSync(inPath); } catch { /* ignore */ }
    try { unlinkSync(outPath); } catch { /* ignore */ }
  }
}

/**
 * Convert a WAV audio buffer to AMR-NB format (required by DingTalk voice
 * messages). Returns the AMR buffer, or null if ffmpeg is unavailable or the
 * build lacks the amr_nb encoder (libopencore_amrnb).
 */
export function wavToAmr(wavBuffer: Buffer): Buffer | null {
  if (!isFfmpegAvailable()) return null;
  const inPath = join(tmpdir(), `tts-in-${Date.now()}.wav`);
  const outPath = join(tmpdir(), `tts-out-${Date.now()}.amr`);
  try {
    writeFileSync(inPath, wavBuffer);
    execFileSync(FFMPEG_BIN, [
      "-i", inPath,
      "-c:a", "amr_nb",
      "-ar", "8000",
      "-ac", "1",
      outPath,
    ], { stdio: "ignore", timeout: 30000 });
    return readFileSync(outPath);
  } catch (e) {
    console.warn("[ffmpeg] wavToAmr failed", e);
    return null;
  } finally {
    try { unlinkSync(inPath); } catch { /* ignore */ }
    try { unlinkSync(outPath); } catch { /* ignore */ }
  }
}

/**
 * Exact duration from a WAV header (TTS returns standard PCM WAV).
 *
 * Why not parse the transcoded file: AMR has no duration metadata, so ffmpeg can
 * only "estimate from bitrate" (`Estimating duration from bitrate, this may be
 * inaccurate`). DingTalk's sampleAudio needs a duration in ms; a declared value
 * far off the real length makes the desktop client refuse to play.
 *
 * Returns 0 when the header can't be parsed (callers fall back to ffmpeg).
 */
export function wavDurationMs(wav: Buffer): number {
  try {
    if (wav.length < 44) return 0;
    if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") return 0;
    let offset = 12;
    let byteRate = 0;
    let dataSize = 0;
    while (offset + 8 <= wav.length) {
      const id = wav.toString("ascii", offset, offset + 4);
      const size = wav.readUInt32LE(offset + 4);
      if (id === "fmt " && offset + 20 <= wav.length) {
        byteRate = wav.readUInt32LE(offset + 16);
      } else if (id === "data") {
        dataSize = Math.min(size, wav.length - offset - 8);
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (byteRate <= 0 || dataSize <= 0) return 0;
    return Math.round((dataSize / byteRate) * 1000);
  } catch {
    return 0;
  }
}

/**
 * Probe an audio file's duration in milliseconds via ffmpeg (`-i` prints it to
 * stderr). Falls back to 0 when ffmpeg is unavailable / the file can't be read.
 * DingTalk's sampleAudio template needs the duration as a milliseconds string.
 */
export function getAudioDurationMs(filePath: string): number {
  if (!isFfmpegAvailable()) return 0;
  let stderr = "";
  let duration = 0;
  try {
    execFileSync(FFMPEG_BIN, ["-i", filePath], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 10_000,
    });
  } catch (e: any) {
    // ffmpeg -i with no output file exits non-zero — the duration is on stderr.
    stderr =
      (e?.stderr?.toString?.() ?? "") ||
      (e?.output?.[2]?.toString?.() ?? "");
  }
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)(?:\.(\d+))?/);
  if (!m) {
    console.warn("[ffmpeg] getAudioDurationMs: no Duration parsed; stderr tail=", stderr.slice(-200));
    return 0;
  }
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const frac = m[4] ? `0.${m[4]}` : "0";
  duration = Math.round((h * 3600 + min * 60 + s + parseFloat(frac)) * 1000);
  return duration;
}