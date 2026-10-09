/**
 * Pi inline extension: registers the `send_file` tool.
 *
 * Explicit outbound file delivery (对标 openclaw 的 message tool + mediaUrl):
 *   model calls send_file(filePath)
 *     → execute validates the file + config switch
 *     → locates the current Pi session path (ctx.sessionManager.getSessionFile())
 *     → hands it to the IM gateway's sendFileToSession, which routes the file
 *       to the owning IM conversation's peer via the adapter's direct sendFile
 *     → returns a structured result so the model knows whether it actually
 *       reached the user (or was ignored on desktop / an unsupported channel).
 *
 * Desktop (non-IM) sessions are ignored — the agent is told the file was not
 * delivered so it can fall back to "just report the path in the reply".
 */
import {
  defineTool,
  type AgentToolResult,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { Type } from "typebox";
import { readSendFileConfigSync } from "./send-file-config";

export interface SendFileParams {
  filePath: string;
}

export interface SendFileResult {
  sent: boolean;
  message: string;
}

function buildResult(text: string, sent: boolean): AgentToolResult<SendFileResult> {
  return { content: [{ type: "text", text }], details: { sent, message: text } };
}

export function createSendFileExtension(): InlineExtension {
  return {
    name: "send-file",
    hidden: false,
    factory: (pi) => {
      if (!readSendFileConfigSync().enabled) return; // master switch off

      pi.registerTool(
        defineTool({
          name: "send_file",
          label: "发送文件给用户",
          description:
            "Send a local file directly to the user in the current chat (over IM the file is delivered by the signed-in bot; in the desktop app the user can see the working directory but does not receive a push). " +
            "Use it when the user explicitly asks for a file, or when you need to hand a generated deliverable (report/image/spreadsheet/code file, etc.) directly to the user. Notes:\n" +
            "- filePath must be the absolute path of a file that already exists on disk; create the file first, then call this tool.\n" +
            "- If the file is missing, exceeds the size limit, or the current session is not an IM chat, the tool returns a send failure — do not claim in your reply that it was sent; instead give the user the path in the message body.",
          promptSnippet:
            "Send a local file directly to the current chat's user (works over IM channels)",
          promptGuidelines: [
            "When the user explicitly asks for a file, or a generated/saved deliverable needs to be handed directly to the user, use send_file (filePath = an absolute path already on disk).",
            "Make sure the file is created before calling; if the file does not exist or the send fails (e.g. the current session is not an IM chat, or the file exceeds the limit), tell the user the send result honestly and just put the file path in the reply body — do not falsely claim it was sent.",
          ],
          parameters: Type.Object(
            {
              filePath: Type.String({ description: "Absolute path of the local file to send (must already exist)." }),
            },
            { required: ["filePath"] },
          ),
          execute: async (
            _toolCallId,
            params,
            _signal,
            _onUpdate,
            ctx,
          ): Promise<AgentToolResult<SendFileResult>> => {
            if (!readSendFileConfigSync().enabled) {
              return buildResult(
                "The send_file tool is currently disabled (sendfile-config.json enabled=false). Give the user the file path in the reply body instead.",
                false,
              );
            }
            const typed = params as unknown as SendFileParams;
            const rawPath = String(typed.filePath ?? "").trim();
            if (!rawPath) {
              return buildResult("send_file is missing the filePath parameter; nothing was sent.", false);
            }
            // Resolve `file://` / normalize, then confirm the file exists.
            const filePath = rawPath.replace(/^file:\/\//, "").trim();
            if (!existsSync(filePath)) {
              return buildResult(
                `File not found: ${basename(filePath)} (${filePath}). Create the file first, or double-check the path.`,
                false,
              );
            }
            const sessionPath =
              (ctx.sessionManager as any)?.getSessionFile?.() ??
              (ctx as any).sessionFile ??
              "";
            if (!sessionPath) {
              return buildResult(
                "Could not determine the current session; the file was not sent. Give the user the file path in the reply body.",
                false,
              );
            }
            // Lazy import to avoid a static cycle (index ↔ session-manager).
            let res: { ok: boolean; message: string };
            try {
              const { getImGateway } = await import("../../index");
              const gateway = getImGateway();
              if (!gateway) {
                return buildResult("The IM gateway is not ready; the file was not sent. Give the user the file path in the reply body.", false);
              }
              res = await gateway.sendFileToSession(sessionPath, filePath);
            } catch (err) {
              console.warn("[send_file] gateway call failed:", err);
              return buildResult(
                `File send error: ${err instanceof Error ? err.message : String(err)}`,
                false,
              );
            }
            if (res.ok) {
              return buildResult(`Successfully sent ${basename(filePath)} to the user.`, true);
            }
            return buildResult(res.message || "The file was not sent.", false);
          },
        }),
      );
    },
  };
}