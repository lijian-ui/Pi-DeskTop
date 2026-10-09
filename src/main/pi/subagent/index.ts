import type { WebContents } from "electron";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { runSubagent, SubagentParams, SubagentEvent } from "./runner";
import { listAgents } from "./agent-discovery";

/**
 * Build the subagent inline extension. Registered on the PARENT session only
 * (via ensureUnit's extensionFactories). Child sessions created inside
 * runSubagent() never receive this extension, so they cannot spawn further
 * subagents — that is the recursion guard.
 *
 * `webContents` forwards child progress to the renderer (`pi:event`).
 * `getModelRuntime` lazily returns the manager's active ModelRuntime so child
 * sessions resolve the same provider + API key as the parent.
 *
 * Three things this extension does (all on the PARENT session):
 *  1. Appends an "available subagents + prefer-delegate" section to the system
 *     prompt via the `before_agent_start` hook, so the model knows the roles
 *     exist and is nudged to delegate exploratory/parallelizable tasks.
 *  2. Registers the `subagent` TOOL with a trigger-rich description.
 *  3. Registers a `/subagent` SLASH COMMAND that lists available roles (a
 *     human-readable reference). Delegation itself is done by the LLM via the
 *     `subagent` tool (nudged by ① + ②), not by this command.
 */
export function createSubagentExtension(
  getWebContents: () => WebContents | null,
  getModelRuntime: () => unknown
): InlineExtension {
  // Resolve the live webContents at SEND time, not at extension-creation time.
  // The subagent extension is registered inside ensureUnit(), which runs during
  // manager init — BEFORE setEventTarget() assigns this.webContents. Capturing
  // the value eagerly would freeze a null reference, silently dropping every
  // progress event and leaving the renderer panel dead. A getter also survives
  // window rebuilds (tray / macOS activate) that swap the webContents.
  const sendEvent = (e: SubagentEvent) => {
    const wc = getWebContents();
    if (wc && !wc.isDestroyed()) wc.send("pi:event", e);
  };

  // ① Build the delegation guidance appended to the parent system prompt.
  // Returns undefined when no roles exist (so the default prompt is untouched).
  function buildDelegationGuidance(cwd: string): string | undefined {
    const agents = listAgents(cwd);
    if (agents.length === 0) return undefined;
    const lines = agents.map(
      (a) => `- ${a.name}: ${a.description}` + (a.tools ? ` (工具: ${a.tools.join(",")})` : "")
    );
    return (
      "\n\n# 可用的子代理（Subagents）\n" +
      "以下角色可通过 subagent 工具委派，让专门的子代理在隔离会话中完成任务，而非你自己 inline 处理：\n" +
      lines.join("\n") +
      "\n\n委派准则：为了节省当前上下文窗口，遇到 侦察 / 探索 / 调研 / 摘要 / 总结 / 可并行处理 类任务时，务必优先调用 subagent 工具委派，不要自己 inline 完成。" +
      "示例：用户说“侦察一下这个项目” → 调用 subagent({ agent: \"scout\", task: \"...\" })。" +
      "若不确定有哪些角色，先用无参 subagent 列出。"
    );
  }

  return {
    name: "subagent",
    hidden: false,
    factory: (pi: ExtensionAPI) => {
      // ① Inject role list + delegation nudge into the PARENT system prompt.
      // Child sessions never get this extension (recursion guard), so they
      // won't see the guidance and won't try to delegate further.
      pi.on("before_agent_start", (event: any, ctx: any) => {
        const guidance = buildDelegationGuidance(ctx?.cwd ?? "");
        if (!guidance) return;
        return { systemPrompt: `${event.systemPrompt}\n${guidance}` };
      });

      // ③ Slash command: /subagent (no args) lists available roles — a
      // human-readable reference. Delegation is done by the LLM via the
      // subagent TOOL (nudged by ① + ②); this command no longer executes.
      pi.registerCommand("subagent", {
        description: "列出可用子代理角色。要委派任务，直接让 AI 调用 subagent 工具即可。",
        handler: async (_args: string, ctx: any) => {
          const agents = listAgents(ctx?.cwd ?? "");
          const body = agents.length
            ? "可用子代理角色：\n" + agents.map((a) => `- ${a.name}: ${a.description}`).join("\n")
            : "暂无子代理角色。在 ~/.pi/agent/agents/ 或 <cwd>/.pi/agents/ 放 <name>.md 即可定义。";
          try {
            ctx?.ui?.notify(body, "info");
          } catch {
            /* ui may be unavailable outside interactive mode */
          }
          try {
            (ctx?.sessionManager as any)?.appendMessage({
              role: "custom",
              customType: "subagent-roles",
              content: body,
              display: true,
              details: { kind: "roles" },
              timestamp: Date.now(),
            });
          } catch {
            /* ignore persistence failure */
          }
        },
      } as any);

      // ② Tool: delegate to a subagent (single / parallel / chain).
      pi.registerTool({
        name: "subagent",
        label: "Subagent",
          description:
          "Delegate a task to a specialized subagent (runs in an isolated session; does not inherit the main session's context). " +
          "When to use: to conserve the current context window, always prefer delegating reconnaissance / exploration / research / summarization / parallelizable tasks instead of doing them inline. " +
          "Modes: single { agent, task }; parallel { tasks: [{agent, task}] } (declare dependencies to form a DAG); chain { chain: [{agent, task}] } (sequential, each step's result feeds the next; equivalent to linear dependencies). " +
          "DAG: give a task in tasks an id, then another task uses dependsOn: [that id] to wait for it; if an upstream task fails, the downstream one is skipped automatically (skipped tasks no longer consume model calls). " +
          "Roles come from Markdown files: ~/.pi/agent/agents and <cwd>/.pi/agents (frontmatter: name, description, tools, thinking, model; body = role instructions, prepended to the subagent's first user message). " +
          "Example: the user says \"scout this project\" → call subagent({ agent: \"scout\", task: \"Scout the structure of E:\\\\Project\\\\pi-desktop\" }). " +
          "If unsure which roles exist, call it with no arguments to list them.",
        promptSnippet:
          "Delegate a task to a specialized subagent running in an isolated session (single / parallel / chain). Use for reconnaissance / exploration / research / summarization / parallelizable work.",
        promptGuidelines: [
          "To conserve the current context window, always prefer delegating reconnaissance / exploration / research / summarization / parallelizable tasks to the subagent tool instead of doing them inline.",
          "When unsure which roles exist, call subagent with no arguments to list the available subagents.",
        ],
        parameters: {
          type: "object",
          properties: {
            agent: { type: "string", description: "Agent role name to delegate to (single mode)." },
            task: { type: "string", description: "Task description for the agent (single mode)." },
            tasks: {
              type: "array",
              description:
                "Parallel / DAG fanout: run multiple agents concurrently. Each item may carry `id` and `dependsOn: [otherId]` to form a dependency graph — a task only starts after its dependencies finish; if a dependency fails/skips, the dependent is auto-skipped.",
              items: {
                type: "object",
                properties: {
                  agent: { type: "string" },
                  task: { type: "string" },
                  id: {
                    type: "string",
                    description: "Stable id so other tasks can reference it via dependsOn.",
                  },
                  dependsOn: {
                    type: "array",
                    items: { type: "string" },
                    description: "Ids of tasks that must finish before this one starts.",
                  },
                },
                required: ["agent", "task"],
              },
            },
            chain: {
              type: "array",
              description:
                "Sequential chain: each step depends on the previous one and receives its output (a linear dependency DAG).",
              items: {
                type: "object",
                properties: { agent: { type: "string" }, task: { type: "string" } },
                required: ["agent", "task"],
              },
            },
          },
          required: [],
          additionalProperties: false,
        } as any,
        async execute(
          _toolCallId: string,
          params: SubagentParams,
          _signal: AbortSignal | undefined,
          onUpdate: ((partial: any) => void) | undefined,
          ctx: any
        ): Promise<any> {
          // No agent specified => list discovered roles so the model can pick.
          if (!params.agent && !params.tasks && !params.chain) {
            const agents = listAgents(ctx.cwd ?? "").map(
              (a) => `- ${a.name}: ${a.description}` + (a.tools ? ` (tools: ${a.tools.join(",")})` : "")
            );
            const body = agents.length
              ? `Available subagent roles:\n${agents.join("\n")}`
              : "No subagent roles found. Define one in ~/.pi/agent/agents/<name>.md (frontmatter: name, description, tools, thinking; body = system prompt).";
            return { content: [{ type: "text", text: body }], details: { isError: false } };
          }
          return runSubagent(params, ctx, onUpdate, sendEvent, getModelRuntime());
        },
      } as any);
    },
  };
}
