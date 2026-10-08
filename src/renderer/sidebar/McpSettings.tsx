import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  McpConfigView,
  McpExposure,
  McpServerDef,
  McpServerView,
} from "../../shared/mcp-types";
import styles from "./McpSettings.module.css";

/**
 * 设置 → MCP 服务器。
 *
 * 服务器定义读写 `~/.pi/agent/mcp.json`（与 CLI / Claude Desktop / Cursor 共享）；
 * 总开关与两个授权白名单读写 `~/.pi/agent/mcp-config.json`（桌面端私有）。
 * 所有写操作都会触发热更新：主进程重建 services 并让运行中的会话 reload。
 */
const EXPOSURES: McpExposure[] = ["codemode", "deferred", "direct", "hidden"];
const EXPOSURE_LABELS: Record<McpExposure, string> = {
  codemode: "codemode（沙箱 JS，最省上下文）",
  deferred: "deferred（先 tool_search 再调用）",
  direct: "direct（全部直接注册）",
  hidden: "hidden（不暴露给模型）",
};

interface ServerDraft {
  name: string;
  type: "stdio" | "http";
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  exposure: McpExposure;
  description: string;
  timeout: string;
}

function kvToText(kv?: Record<string, string>): string {
  if (!kv) return "";
  return Object.entries(kv)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function textToKv(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function draftFrom(name: string, def: McpServerDef): ServerDraft {
  return {
    name,
    type: def.url && !def.command ? "http" : "stdio",
    command: def.command ?? "",
    args: (def.args ?? []).join("\n"),
    env: kvToText(def.env),
    cwd: def.cwd ?? "",
    url: def.url ?? "",
    headers: kvToText(def.headers),
    exposure: def.exposure ?? "codemode",
    description: def.description ?? "",
    timeout: def.timeout != null ? String(def.timeout) : "",
  };
}

function emptyDraft(): ServerDraft {
  return {
    name: "",
    type: "stdio",
    command: "",
    args: "",
    env: "",
    cwd: "",
    url: "",
    headers: "",
    exposure: "codemode",
    description: "",
    timeout: "",
  };
}

function buildDef(d: ServerDraft): McpServerDef {
  const def: McpServerDef = {};
  if (d.type === "http") {
    def.type = "http";
    def.url = d.url.trim();
    const headers = textToKv(d.headers);
    if (headers) def.headers = headers;
  } else {
    def.command = d.command.trim();
    const args = d.args
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (args.length) def.args = args;
    const env = textToKv(d.env);
    if (env) def.env = env;
    if (d.cwd.trim()) def.cwd = d.cwd.trim();
  }
  if (d.exposure !== "codemode") def.exposure = d.exposure;
  if (d.description.trim()) def.description = d.description.trim();
  const timeout = Number(d.timeout);
  if (d.timeout.trim() && Number.isFinite(timeout) && timeout > 0) {
    def.timeout = timeout;
  }
  return def;
}

function summarize(def: McpServerDef): string {
  if (def.url) return def.url;
  const parts = [def.command, ...(def.args ?? [])].filter(Boolean);
  return parts.join(" ") || "—";
}

export default function McpSettings() {
  const { t } = useTranslation();
  const [view, setView] = useState<McpConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [enabled, setEnabled] = useState(true);
  const [autoApprove, setAutoApprove] = useState<string[]>([]);
  const [unattended, setUnattended] = useState<string[]>([]);

  const [draft, setDraft] = useState<ServerDraft | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [formError, setFormError] = useState("");

  const load = useCallback(async () => {
    try {
      const cfg = await window.piDesk.getMcpConfig();
      setView(cfg);
      setEnabled(cfg.enabled);
      setAutoApprove(cfg.autoApproveServers);
      setUnattended(cfg.unattendedServers);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载配置失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(""), 2500);
  };

  const servers = view?.servers ?? [];
  const serverNames = servers.map((s) => s.name);
  /** 走沙箱（codemode）通道且启用的服务器 —— 决定 codemode 工具是否会被激活。 */
  const codemodeServers = servers.filter(
    (s) => (s.config.exposure ?? "codemode") === "codemode" && s.config.enabled !== false,
  );
  const codemodeDisabled = view?.autoEnableCodemode === false;

  async function handleSaveFeature() {
    setBusy(true);
    setError("");
    try {
      await window.piDesk.saveMcpFeature({
        enabled,
        autoApproveServers: autoApprove,
        unattendedServers: unattended,
      });
      flash("已保存");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveServer() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setFormError("请填写服务器名称");
      return;
    }
    if (draft.type === "stdio" && !draft.command.trim()) {
      setFormError("stdio 服务器必须填写 command");
      return;
    }
    if (draft.type === "http" && !draft.url.trim()) {
      setFormError("http 服务器必须填写 url");
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      await window.piDesk.upsertMcpServer({ name, config: buildDef(draft) });
      setDraft(null);
      setEditingName(null);
      flash("已保存服务器");
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function patchServer(name: string, patch: { enabled?: boolean; exposure?: McpExposure }) {
    setBusy(true);
    setError("");
    try {
      await window.piDesk.updateMcpServer(name, patch);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新失败");
    } finally {
      setBusy(false);
    }
  }

  async function removeServer(name: string) {
    if (!window.confirm(`确定删除 MCP 服务器「${name}」？`)) return;
    setBusy(true);
    setError("");
    try {
      await window.piDesk.deleteMcpServer(name);
      flash("已删除");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  const toggleIn = (list: string[], setList: (v: string[]) => void, name: string) => {
    setList(list.includes(name) ? list.filter((n) => n !== name) : [...list, name]);
  };

  const updateDraft = (patch: Partial<ServerDraft>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d));

  if (loading) return <div className={styles.loading}>{t("loading")}</div>;

  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>MCP 服务器</h2>
        <p className={styles.sectionDesc}>
          接入外部 MCP（Model Context Protocol）服务器，把它们的工具与资源交给模型使用。
          服务器定义写入共享的 mcp.json，桌面端只做编辑器。
        </p>

        <label className={styles.row}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>启用 MCP（关闭后不注册扩展，也不会启动任何 MCP 子进程）</span>
        </label>

        {view && <p className={styles.hint}>配置文件：{view.jsonPath}</p>}

        {view && (
          <p className={styles.hint}>
            沙箱通道（codemode）：
            {codemodeServers.length > 0
              ? `${codemodeServers.length} 个服务器在用`
              : "未使用（不会注册该工具，零上下文开销）"}
            {" · "}
            autoEnableCodemode：
            {view.autoEnableCodemode === undefined
              ? "未设置（默认开启）"
              : view.autoEnableCodemode
                ? "已开启"
                : "已关闭"}
          </p>
        )}

        {codemodeDisabled && codemodeServers.length > 0 && (
          <p className={styles.error}>
            autoEnableCodemode 已关闭，但仍有服务器使用 codemode 暴露方式 ——
            这些服务器的工具将无法被调用。请将其暴露方式改为 direct / deferred，
            或移除 mcp.json 中的该设置。
          </p>
        )}

        {view?.errors.length ? (
          <p className={styles.error}>{view.errors.join("；")}</p>
        ) : null}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>服务器</h2>
        <p className={styles.sectionDesc}>
          工具对所有服务器默认按 codemode 暴露（最省上下文）；可逐服务器改暴露方式或单独停用。
        </p>

        {servers.length === 0 && (
          <p className={styles.checkEmpty}>尚未配置任何 MCP 服务器。</p>
        )}

        <div className={styles.cardList}>
          {servers.map((s) => (
            <ServerCard
              key={s.name}
              server={s}
              busy={busy}
              onToggle={(on) => patchServer(s.name, { enabled: on })}
              onExposure={(ex) => patchServer(s.name, { exposure: ex })}
              onEdit={() => {
                setEditingName(s.name);
                setDraft(draftFrom(s.name, s.config));
                setFormError("");
              }}
              onDelete={() => removeServer(s.name)}
            />
          ))}
        </div>

        {draft ? (
          <div className={styles.form}>
            <div className={styles.grid}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>名称</label>
                <input
                  className={styles.input}
                  value={draft.name}
                  disabled={editingName !== null}
                  placeholder="如 filesystem"
                  onChange={(e) => updateDraft({ name: e.target.value })}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>类型</label>
                <select
                  className={styles.select}
                  value={draft.type}
                  onChange={(e) =>
                    updateDraft({ type: e.target.value as ServerDraft["type"] })
                  }
                >
                  <option value="stdio">stdio（本地进程）</option>
                  <option value="http">http（远程服务）</option>
                </select>
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>暴露方式</label>
                <select
                  className={styles.select}
                  value={draft.exposure}
                  onChange={(e) =>
                    updateDraft({ exposure: e.target.value as McpExposure })
                  }
                >
                  {EXPOSURES.map((ex) => (
                    <option key={ex} value={ex}>
                      {EXPOSURE_LABELS[ex]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {draft.type === "stdio" ? (
              <>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>command</label>
                  <input
                    className={styles.input}
                    value={draft.command}
                    placeholder="如 npx"
                    onChange={(e) => updateDraft({ command: e.target.value })}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>args（每行一个参数）</label>
                  <textarea
                    className={styles.textarea}
                    value={draft.args}
                    placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir"}
                    onChange={(e) => updateDraft({ args: e.target.value })}
                  />
                </div>
                <div className={styles.grid}>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>env（每行 KEY=VALUE）</label>
                    <textarea
                      className={styles.textarea}
                      value={draft.env}
                      placeholder="API_KEY=xxx"
                      onChange={(e) => updateDraft({ env: e.target.value })}
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>cwd（可选）</label>
                    <input
                      className={styles.input}
                      value={draft.cwd}
                      placeholder="工作目录"
                      onChange={(e) => updateDraft({ cwd: e.target.value })}
                    />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>url</label>
                  <input
                    className={styles.input}
                    value={draft.url}
                    placeholder="https://example.com/mcp"
                    onChange={(e) => updateDraft({ url: e.target.value })}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>headers（每行 KEY=VALUE）</label>
                  <textarea
                    className={styles.textarea}
                    value={draft.headers}
                    placeholder="Authorization=Bearer xxx"
                    onChange={(e) => updateDraft({ headers: e.target.value })}
                  />
                </div>
              </>
            )}

            <div className={styles.grid}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>说明（可选）</label>
                <input
                  className={styles.input}
                  value={draft.description}
                  onChange={(e) => updateDraft({ description: e.target.value })}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>单次调用超时（秒，可选）</label>
                <input
                  className={styles.input}
                  type="number"
                  min={1}
                  value={draft.timeout}
                  onChange={(e) => updateDraft({ timeout: e.target.value })}
                />
              </div>
            </div>

            {formError && <p className={styles.error}>{formError}</p>}

            <div className={styles.formActions}>
              <button className={styles.saveBtn} onClick={handleSaveServer} disabled={busy}>
                保存服务器
              </button>
              <button
                className={styles.ghostBtn}
                onClick={() => {
                  setDraft(null);
                  setEditingName(null);
                  setFormError("");
                }}
                disabled={busy}
              >
                {t("cancel")}
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.actions}>
            <button
              className={styles.ghostBtn}
              onClick={() => {
                setDraft(emptyDraft());
                setEditingName(null);
                setFormError("");
              }}
            >
              新增服务器
            </button>
          </div>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>授权白名单</h2>
        <p className={styles.sectionDesc}>
          交互式会话里，MCP 工具调用默认需要用户确认；无人值守（定时任务）会话默认一律拒绝。
          这里可以按服务器放宽。
        </p>

        <h3 className={styles.sectionTitle}>常驻授权（交互式会话不再弹窗）</h3>
        <ServerCheckList
          names={serverNames}
          selected={autoApprove}
          onToggle={(n) => toggleIn(autoApprove, setAutoApprove, n)}
        />

        <h3 className={styles.sectionTitle}>无人值守白名单（定时任务可调用）</h3>
        <ServerCheckList
          names={serverNames}
          selected={unattended}
          onToggle={(n) => toggleIn(unattended, setUnattended, n)}
        />

        <div className={styles.actions}>
          <button
            className={`${styles.saveBtn} ${notice ? styles.saveBtnSuccess : ""}`}
            onClick={handleSaveFeature}
            disabled={busy}
          >
            {notice || "保存设置"}
          </button>
        </div>
        {error && <p className={styles.error}>{error}</p>}
      </section>
    </div>
  );
}

function ServerCard({
  server,
  busy,
  onToggle,
  onExposure,
  onEdit,
  onDelete,
}: {
  server: McpServerView;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onExposure: (exposure: McpExposure) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { config } = server;
  const isOff = config.enabled === false;
  const exposure = config.exposure ?? "codemode";
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardName}>{server.name}</span>
        <span className={`${styles.badge} ${isOff ? styles.badgeOff : ""}`}>
          {isOff ? "已停用" : "已启用"}
        </span>
        <span className={styles.badge}>{config.url ? "http" : "stdio"}</span>
        <span className={styles.badge}>{exposure}</span>
      </div>
      <div className={styles.cardMeta}>{summarize(config)}</div>
      {config.description && <div className={styles.cardMeta}>{config.description}</div>}
      <div className={styles.cardActions}>
        <button className={styles.linkBtn} disabled={busy} onClick={onEdit}>
          编辑
        </button>
        <select
          className={styles.linkBtn}
          value={exposure}
          disabled={busy}
          onChange={(e) => onExposure(e.target.value as McpExposure)}
        >
          {EXPOSURES.map((ex) => (
            <option key={ex} value={ex}>
              {ex}
            </option>
          ))}
        </select>
        <button
          className={styles.linkBtn}
          disabled={busy}
          onClick={() => onToggle(isOff)}
        >
          {isOff ? "启用" : "停用"}
        </button>
        <button
          className={`${styles.linkBtn} ${styles.linkBtnDanger}`}
          disabled={busy}
          onClick={onDelete}
        >
          删除
        </button>
      </div>
    </div>
  );
}

function ServerCheckList({
  names,
  selected,
  onToggle,
}: {
  names: string[];
  selected: string[];
  onToggle: (name: string) => void;
}) {
  if (names.length === 0) {
    return <p className={styles.checkEmpty}>尚无服务器。</p>;
  }
  return (
    <div className={styles.checkList}>
      {names.map((n) => (
        <label key={n} className={styles.checkRow}>
          <input
            type="checkbox"
            checked={selected.includes(n)}
            onChange={() => onToggle(n)}
          />
          <span>{n}</span>
        </label>
      ))}
    </div>
  );
}
