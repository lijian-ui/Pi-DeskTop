import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ScheduledTask } from "./scheduled-tasks";

/**
 * Inject time/date placeholders into the task prompt so a single task
 * definition can reference the current local time without being re-edited.
 */
function renderPrompt(task: ScheduledTask): string {
  const now = new Date();
  const time = now.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const date = now.toLocaleDateString("zh-CN");
  return task.prompt.replaceAll("{time}", time).replaceAll("{date}", date);
}

/**
 * Factory that builds an inline extension per task run. The <scheduled_task>
 * block is appended to the ABSOLUTE END of the assembled system prompt —
 * after Pi's base prompt, <project_context> and the trailing cwd line.
 *
 * Crucially this extension does NOT register soulExtension, so the task
 * session carries no <personality> block: it is a pure executor persona.
 */
export function createScheduledTaskExtension(task: ScheduledTask): InlineExtension {
  return {
    name: `scheduled-task:${task.id}`,
    factory: (pi) => {
      pi.on("before_agent_start", (event) => {
        const block = [
          "<scheduled_task>",
          "你是一个定时任务的执行 Agent。你的任务是：",
          "",
          "## 任务",
          `现在是 ${new Date().toLocaleString("zh-CN")}（本地时间），${renderPrompt(task)}`,
          "",
          "## 规则",
          task.rules ||
            "- 专注于完成分配的任务\n- 完成后给出清晰的总结\n- 使用中文回复",
          "</scheduled_task>",
        ].join("\n");
        return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
      });
    },
  };
}
