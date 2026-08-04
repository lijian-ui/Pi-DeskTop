/**
 * Centralized, data-driven content for the Help & Feedback page.
 * Kept separate from the components so the page stays modular: adding a FAQ
 * entry or a resource link is a one-line edit here, no component changes.
 */

/** The project's GitHub repository. Single source of truth for all repo links. */
export const GITHUB_REPO = "https://github.com/lijian-ui/Pi-DeskTop";

export interface Bilingual {
  zh: string;
  en: string;
}

export interface FaqItem {
  id: string;
  q: Bilingual;
  a: Bilingual;
}

export const FAQ_ITEMS: FaqItem[] = [
  {
    id: "what",
    q: {
      zh: "Pi Desktop 是什么？",
      en: "What is Pi Desktop?",
    },
    a: {
      zh: "它是 Pi 编程代理的桌面客户端，把对话、技能、自动化与集成终端整合进一个熟悉的桌面界面。底层由 Pi Agent SDK 驱动，支持本地与云端模型。",
      en: "A desktop client for the Pi coding agent. It brings chat, skills, automation and an integrated terminal into a single, familiar desktop UI, powered by the Pi Agent SDK with support for both local and cloud models.",
    },
  },
  {
    id: "model",
    q: {
      zh: "如何配置模型？",
      en: "How do I configure a model?",
    },
    a: {
      zh: "打开「设置 → 模型」，添加 OpenAI 兼容端点（如本机的 LM Studio、Ollama），或填入 API Key 类型的供应商。配置仅保存在本机。",
      en: "Open Settings → Models, then add an OpenAI-compatible endpoint (e.g. a local LM Studio or Ollama server), or fill in an API-key provider. Configuration is stored only on this machine.",
    },
  },
  {
    id: "terminal",
    q: {
      zh: "终端打不开 / 报错怎么办？",
      en: "The terminal won't open / errors out — what do I do?",
    },
    a: {
      zh: "Windows 需安装 Git Bash 或 PowerShell；macOS 默认使用 zsh。若报 posix_spawnp failed，请重新构建以针对本机 Electron 重编 node-pty（Mac 上运行 npm run build:electron 会自动处理）。",
      en: "On Windows you need Git Bash or PowerShell installed; macOS uses zsh by default. If you see “posix_spawnp failed”, rebuild so node-pty is recompiled against your local Electron — on macOS, npm run build:electron does this automatically.",
    },
  },
  {
    id: "update",
    q: {
      zh: "如何更新到新版本？",
      en: "How do I update to a new version?",
    },
    a: {
      zh: "在「关于」对话框点击「检查更新」，应用也会在启动时自动检测 Gitee 上的新版本并提示下载。仅安装版（Setup）支持应用内自动更新，绿色版需手动替换。",
      en: "Click “Check for Updates” in the About dialog; the app also auto-detects new versions on Gitee at launch. In-app auto-update only works for the installed (Setup) build — the portable build must be replaced manually.",
    },
  },
  {
    id: "data",
    q: {
      zh: "我的数据存在哪里？",
      en: "Where is my data stored?",
    },
    a: {
      zh: "会话记录与配置都在本机的 ~/.pi/agent/ 目录，不会上传到任何服务器。模型 API Key 也仅保存在本机。",
      en: "Sessions and configuration live in ~/.pi/agent/ on your machine and are never uploaded to any server. Model API keys are stored locally only.",
    },
  },
];

export interface HelpLink {
  id: string;
  /** i18n key for the visible label. */
  labelKey: string;
  url: string;
  /** Optional i18n key for a one-line description. */
  descKey?: string;
}

/** Feedback actions — all routed to the GitHub repo. */
export const FEEDBACK_LINKS: HelpLink[] = [
  {
    id: "bug",
    labelKey: "help.feedback.bug",
    url: `${GITHUB_REPO}/issues/new?template=bug_report`,
    descKey: "help.feedback.bug.desc",
  },
  {
    id: "feature",
    labelKey: "help.feedback.feature",
    url: `${GITHUB_REPO}/issues/new?template=feature_request`,
    descKey: "help.feedback.feature.desc",
  },
];

/** External documentation / resources. */
export const RESOURCE_LINKS: HelpLink[] = [
  { id: "pi", labelKey: "help.resources.pi", url: "https://pi.dev", descKey: "help.resources.desc" },
  { id: "packages", labelKey: "help.resources.packages", url: "https://pi.dev/packages" },
  { id: "releases", labelKey: "help.resources.releases", url: `${GITHUB_REPO}/releases` },
];
