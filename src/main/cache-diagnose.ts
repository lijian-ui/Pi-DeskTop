/**
 * Cache-hit diagnostics (kept by request — harmless, logs to dev console).
 *
 * Patches globalThis.fetch so every LLM API request logs:
 *   [cache-diag] REQ  <endpoint> sys=<sha16> sysLen=... msgs=... tools=<sha16> toolsN=...
 *   [cache-diag] RESP sse=<bool> hit=<tokens> miss=<tokens> rate=<%>
 *
 * Comparing REQ hashes across turns reveals system/tools instability (which
 * breaks DeepSeek's prefix cache); rate comes from the real API usage.
 */
import { createHash } from "node:crypto";

const LLM_URL_RE = /deepseek|openai|lm.?studio|ollama|api\.aai|localhost:\d+\/v1/i;

function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

const originalFetch = globalThis.fetch;

globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  const input = args[0];
  const init = args[1];
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? "";
  const res = await originalFetch(...(args as [Parameters<typeof fetch>[0], RequestInit | undefined]));

  if (!LLM_URL_RE.test(url)) return res;

  try {
    // Request side: hash system prompt + tools.
    const bodyText = typeof init?.body === "string" ? init.body : "";
    if (bodyText) {
      const body = JSON.parse(bodyText) as {
        messages?: { role: string; content?: unknown }[];
        tools?: unknown[];
      };
      const msgs = body.messages ?? [];
      const sys = msgs.find((m) => m.role === "system")?.content ?? "";
      const sysStr = typeof sys === "string" ? sys : JSON.stringify(sys);
      const toolsStr = JSON.stringify(body.tools ?? []);
      console.warn(
        `[cache-diag] REQ ${url.split("/").pop() ?? url} sys=${sha16(sysStr)} sysLen=${sysStr.length} msgs=${msgs.length} tools=${sha16(toolsStr)} toolsN=${Array.isArray(body.tools) ? body.tools.length : 0}`,
      );
    }
    // Response side: real cache usage. DeepSeek streams (SSE); the usage
    // object arrives in the LAST data: chunk — parse the stream accordingly.
    const cloned = res.clone();
    void cloned
      .text()
      .then((t) => {
        try {
          const hasData = t.includes("\n\n") && /^data:/m.test(t);
          const chunks = t.split("\n\n");
          const usageChunk = chunks
            .filter((c) => c.includes('"usage"'))
            .pop();
          if (!usageChunk) return;
          const jsonStr = usageChunk.replace(/^data:\s*/, "").trim();
          const j = JSON.parse(jsonStr) as {
            usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; prompt_tokens?: number };
          };
          const u = j.usage;
          if (!u) return;
          const hit = u.prompt_cache_hit_tokens ?? 0;
          const miss = u.prompt_cache_miss_tokens ?? (u.prompt_tokens ?? 0) - hit;
          const rate = hit + miss > 0 ? ((100 * hit) / (hit + miss)).toFixed(1) : "n/a";
          console.warn(`[cache-diag] RESP sse=${hasData} hit=${hit} miss=${miss} rate=${rate}%`);
        } catch {
          /* non-JSON or non-usage payload — ignore */
        }
      })
      .catch(() => {});
  } catch {
    /* malformed body — ignore */
  }
  return res;
}) as typeof fetch;
