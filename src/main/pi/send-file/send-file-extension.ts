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
            "把一个本地文件直接发送给当前聊天中的用户（IM 场景通过扫码登录的机器人/网页机器人发送文件消息；桌面场景用户也能看到工作目录但不会收到文件推送）。" +
            "用于用户明确索要某个文件、或你需要把生成的交付物（报告/图片/表格/代码文件等）直接递给用户时。用法注意：\n" +
            "- filePath 必须是文件已生成并落盘后的绝对路径；先创建好文件再调用。\n" +
            "- 若文件不存在/超大小限制/当前不是 IM 会话，工具会返回发送失败——此时不要在回复里谎称已发送，改为在正文里把路径给用户即可。",
          promptSnippet:
            "Send a local file directly to the current chat's user (works over IM channels)",
          promptGuidelines: [
            "用户明确要某个文件、或需要把生成/保存的交付物直接递交给用户时，用 send_file（filePath=已落盘的绝对路径）。",
            "先确保文件已经创建好再调用；如果文件不存在或发送失败（如当前不是 IM 会话、文件超限），如实告诉用户发送结果，把文件路径放到回复正文里即可，不要谎称已发送。",
          ],
          parameters: Type.Object(
            {
              filePath: Type.String({ description: "要发送的本地文件绝对路径（必须先已存在）。" }),
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
                "send_file 工具当前未启用（sendfile-config.json enabled=false）。请在回复正文中把文件路径给用户。",
                false,
              );
            }
            const typed = params as unknown as SendFileParams;
            const rawPath = String(typed.filePath ?? "").trim();
            if (!rawPath) {
              return buildResult("send_file 缺少 filePath 参数，无法发送。", false);
            }
            // Resolve `file://` / normalize, then confirm the file exists.
            const filePath = rawPath.replace(/^file:\/\//, "").trim();
            if (!existsSync(filePath)) {
              return buildResult(
                `文件不存在：${basename(filePath)}（${filePath}）。请先创建该文件，或确认路径无误。`,
                false,
              );
            }
            const sessionPath =
              (ctx.sessionManager as any)?.getSessionFile?.() ??
              (ctx as any).sessionFile ??
              "";
            if (!sessionPath) {
              return buildResult(
                "无法确定当前会话，文件未发送。请在回复正文中给出文件路径。",
                false,
              );
            }
            // Lazy import to avoid a static cycle (index ↔ session-manager).
            let res: { ok: boolean; message: string };
            try {
              const { getImGateway } = await import("../../index");
              const gateway = getImGateway();
              if (!gateway) {
                return buildResult("IM 网关未就绪，文件未发送。请在回复正文中给出文件路径。", false);
              }
              res = await gateway.sendFileToSession(sessionPath, filePath);
            } catch (err) {
              console.warn("[send_file] gateway call failed:", err);
              return buildResult(
                `文件发送异常：${err instanceof Error ? err.message : String(err)}`,
                false,
              );
            }
            if (res.ok) {
              return buildResult(`已成功将 ${basename(filePath)} 发送给用户。`, true);
            }
            return buildResult(res.message || "文件未发送。", false);
          },
        }),
      );
    },
  };
}