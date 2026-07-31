import { writeFileSync } from "node:fs";
import { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";

/**
 * Self-contained HTML exporter for a historical session.
 *
 * The SDK's own `exportSessionToHtml` is not re-exported from the package root
 * (its exports map blocks deep imports), so we build the export ourselves from
 * the exported `SessionManager` API. We read the active branch via
 * `buildContextEntries()` and render a clean, dependency-free HTML document.
 */

function escapeHtml(text: unknown): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === "text" && b.text)
      .map((b: any) => b.text)
      .join("\n");
  }
  return "";
}

function extractThinking(content: any): string {
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === "thinking" && b.thinking)
      .map((b: any) => b.thinking)
      .join("\n");
  }
  return "";
}

function formatToolCall(name: string, args: any): string {
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return String(args ?? "");
  }
}

const CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f6f7f9;
    color: #1f2328;
    line-height: 1.6;
  }
  .wrap { max-width: 820px; margin: 0 auto; padding: 32px 20px 80px; }
  header.session-head {
    border-bottom: 1px solid #e3e6ea;
    padding-bottom: 16px;
    margin-bottom: 24px;
  }
  header.session-head h1 { font-size: 22px; margin: 0 0 8px; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px 18px; font-size: 13px; color: #57606a; }
  .meta b { color: #1f2328; font-weight: 600; }
  .msg { display: flex; gap: 12px; margin: 18px 0; }
  .avatar {
    flex: 0 0 32px; height: 32px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 13px; color: #fff;
  }
  .avatar.user { background: #2f6feb; }
  .avatar.assistant { background: #16a34a; }
  .avatar.tool { background: #b45309; }
  .bubble { flex: 1; min-width: 0; }
  .role { font-size: 12px; font-weight: 600; color: #57606a; margin-bottom: 4px; }
  .body {
    background: #fff; border: 1px solid #e3e6ea; border-radius: 10px;
    padding: 12px 14px; white-space: pre-wrap; word-wrap: break-word;
    font-size: 14px;
  }
  .thinking {
    margin-top: 8px; font-size: 13px; color: #6b7280;
    border-left: 3px solid #d0d7de; padding: 6px 10px; background: #f6f8fa;
    border-radius: 0 6px 6px 0; white-space: pre-wrap;
  }
  .toolcall {
    margin-top: 8px; border: 1px solid #eadbc8; background: #fdf8f1;
    border-radius: 8px; padding: 8px 10px; font-size: 13px;
  }
  .toolcall .tname { font-weight: 600; color: #b45309; }
  .toolcall pre { margin: 6px 0 0; background: #fff; border: 1px solid #eadbc8;
    border-radius: 6px; padding: 8px; overflow-x: auto; font-size: 12px; }
  .empty-note { color: #8b949e; font-style: italic; }
  footer { margin-top: 40px; text-align: center; font-size: 12px; color: #8b949e; }
`;

export async function exportSessionToHtmlFile(
  sessionPath: string,
  outputPath: string
): Promise<string> {
  const sm = PiSessionManager.open(sessionPath);
  const header = sm.getHeader();
  const entries = sm.buildContextEntries();

  // Map toolCallId -> tool result (output + error flag) from toolResult entries.
  const toolResults = new Map<string, { output: string; isError: boolean }>();
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "toolResult") {
      const msg = entry.message;
      const text = extractText(msg.content);
      toolResults.set(msg.toolCallId ?? "", {
        output: text,
        isError: !!msg.isError,
      });
    }
  }

  const title =
    sm.getSessionName() ||
    (header?.id ? String(header.id) : "Pi Session") ||
    "Pi Session";

  const messagesHtml: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;

    if (msg.role === "user") {
      const text = extractText(msg.content).trim();
      if (!text) continue;
      messagesHtml.push(`
        <div class="msg">
          <div class="avatar user">U</div>
          <div class="bubble">
            <div class="role">You</div>
            <div class="body">${escapeHtml(text)}</div>
          </div>
        </div>`);
      continue;
    }

    if (msg.role === "assistant") {
      const text = extractText(msg.content).trim();
      const thinking = extractThinking(msg.content).trim();
      const toolCalls = Array.isArray(msg.content)
        ? (msg.content.filter((b: any) => b && b.type === "toolCall") as Array<{
            id: string;
            name: string;
            arguments: any;
          }>)
        : [];

      if (!text && !thinking && toolCalls.length === 0) continue;

      let inner = "";
      if (text) inner += `<div class="body">${escapeHtml(text)}</div>`;
      if (thinking)
        inner += `<div class="thinking">${escapeHtml(thinking)}</div>`;

      for (const call of toolCalls) {
        const result = toolResults.get(call.id);
        const argsJson = formatToolCall(call.name, call.arguments);
        let toolHtml = `
          <div class="toolcall">
            <span class="tname">${escapeHtml(call.name || "tool")}</span>
            <pre>${escapeHtml(argsJson)}</pre>`;
        if (result && result.output) {
          toolHtml += `<pre style="${
            result.isError ? "border-color:#f1b0b0;" : ""
          }">${escapeHtml(result.output)}</pre>`;
        }
        toolHtml += `</div>`;
        inner += toolHtml;
      }

      messagesHtml.push(`
        <div class="msg">
          <div class="avatar assistant">AI</div>
          <div class="bubble">
            <div class="role">Assistant</div>
            ${inner || '<div class="empty-note">(no text)</div>'}
          </div>
        </div>`);
      continue;
    }

    if (msg.role === "bashExecution") {
      const cmd = String(msg.command ?? "");
      const out = String(msg.output ?? "");
      if (!cmd && !out) continue;
      messagesHtml.push(`
        <div class="msg">
          <div class="avatar tool">$</div>
          <div class="bubble">
            <div class="role">Bash</div>
            <div class="toolcall"><pre>$${escapeHtml(cmd)}</pre>${
        out ? `<pre>${escapeHtml(out)}</pre>` : ""
      }</div>
          </div>
        </div>`);
      continue;
    }

    // toolResult entries are rendered alongside their tool call above.
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — Pi Session Export</title>
<style>${CSS}</style>
</head>
<body>
  <div class="wrap">
    <header class="session-head">
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">
        ${
          header?.timestamp
            ? `<span><b>Date:</b> ${escapeHtml(
                new Date(header.timestamp).toLocaleString()
              )}</span>`
            : ""
        }
        <span><b>Messages:</b> ${messagesHtml.length}</span>
        <span><b>Session ID:</b> ${escapeHtml(String(header?.id ?? ""))}</span>
      </div>
    </header>
    ${messagesHtml.join("\n") || '<p class="empty-note">This session is empty.</p>'}
    <footer>Exported from Pi Desktop</footer>
  </div>
</body>
</html>`;

  writeFileSync(outputPath, html, "utf-8");
  return outputPath;
}
