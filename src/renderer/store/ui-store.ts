import { create } from "zustand";

/**
 * A code reference captured from the file-preview panel. The user picks a
 * range of lines; we keep the structured meta (so the composer can render a
 * nice pill) plus the raw `content` (so the real text is what gets sent to the
 * LLM — only the UI differs from a plain-text paste).
 */
export interface CodeAttachment {
  id: string;
  /**
   * Where the reference came from. "file" (default) = file-preview panel,
   * "terminal" = text selected inside the integrated terminal. Terminal refs
   * have no real path/line numbers: filePath holds a fixed marker and
   * startLine/endLine describe the selected line count (1..N).
   */
  kind?: "file" | "terminal";
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
}

interface UIState {
  sidebarVisible: boolean;
  activeItem: "sessions" | "files" | "settings";
  composerText: string;
  /** Structured code references injected from the file-preview panel. */
  codeAttachments: CodeAttachment[];
  mainView: "chat" | "settings" | "skills" | "automate" | "help";
  terminalOpen: boolean;
  terminalWidth: number;

  // In-session content search (Titlebar search box → MessageList locator).
  searchOpen: boolean;
  searchQuery: string;
  searchTrigger: number;
  searchMatchIds: string[];
  searchIndex: number;

  // Sidebar file manager panel: which folder's cwd is being browsed
  // (null = show the normal session list) and which file is previewed in
  // the chat area (null = no preview panel).
  fileManagerCwd: string | null;
  previewFilePath: string | null;
  /** Width (px) of the file preview column on the right of the chat area. */
  previewWidth: number;

  toggleSidebar: () => void;
  setActiveItem: (item: UIState["activeItem"]) => void;
  setComposerText: (text: string) => void;
  addCodeAttachment: (att: Omit<CodeAttachment, "id">) => void;
  removeCodeAttachment: (id: string) => void;
  clearCodeAttachments: () => void;
  setMainView: (view: UIState["mainView"]) => void;
  toggleTerminal: () => void;
  setTerminalOpen: (open: boolean) => void;
  setTerminalWidth: (w: number) => void;

  openSearch: () => void;
  closeSearch: () => void;
  setSearchQuery: (q: string) => void;
  submitSearch: () => void;
  nextMatch: () => void;
  prevMatch: () => void;
  setMatchIds: (ids: string[]) => void;
  setSearchIndex: (i: number) => void;

  openFileManager: (cwd: string) => void;
  closeFileManager: () => void;
  openFilePreview: (path: string) => void;
  closeFilePreview: () => void;
  setPreviewWidth: (w: number) => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarVisible: true,
  activeItem: "sessions",
  composerText: "",
  codeAttachments: [],
  mainView: "chat",
  terminalOpen: false,
  terminalWidth: 460,

  searchOpen: false,
  searchQuery: "",
  searchTrigger: 0,
  searchMatchIds: [],
  searchIndex: 0,

  fileManagerCwd: null,
  previewFilePath: null,
  previewWidth: 520,

  toggleSidebar: () =>
    set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  setActiveItem: (item) => set({ activeItem: item }),
  setComposerText: (text) => set({ composerText: text }),
  addCodeAttachment: (att) =>
    set((state) => {
      // De-dupe: files by path + exact line range; terminal refs by content
      // (their line numbers are synthetic, so only identical text is a dup).
      const dup = state.codeAttachments.some((a) =>
        att.kind === "terminal"
          ? a.kind === "terminal" && a.content === att.content
          : a.kind !== "terminal" &&
            a.filePath === att.filePath &&
            a.startLine === att.startLine &&
            a.endLine === att.endLine
      );
      if (dup) return {};
      const id = `ref-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      return { codeAttachments: [...state.codeAttachments, { ...att, id }] };
    }),
  removeCodeAttachment: (id) =>
    set((state) => ({
      codeAttachments: state.codeAttachments.filter((a) => a.id !== id),
    })),
  clearCodeAttachments: () => set({ codeAttachments: [] }),
  setMainView: (view) => set({ mainView: view }),
  toggleTerminal: () => set((state) => ({ terminalOpen: !state.terminalOpen })),
  setTerminalOpen: (open) => set({ terminalOpen: open }),
  setTerminalWidth: (w) => set({ terminalWidth: w }),

  openSearch: () => set({ searchOpen: true }),
  closeSearch: () =>
    set({
      searchOpen: false,
      searchQuery: "",
      searchTrigger: 0,
      searchMatchIds: [],
      searchIndex: 0,
    }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  submitSearch: () =>
    set((s) => ({
      searchTrigger: s.searchTrigger + 1,
      searchIndex: 0,
      searchMatchIds: [],
    })),
  nextMatch: () =>
    set((s) => {
      if (!s.searchMatchIds.length) return {};
      return { searchIndex: (s.searchIndex + 1) % s.searchMatchIds.length };
    }),
  prevMatch: () =>
    set((s) => {
      if (!s.searchMatchIds.length) return {};
      const n = s.searchMatchIds.length;
      return { searchIndex: (s.searchIndex - 1 + n) % n };
    }),
  setMatchIds: (ids) => set({ searchMatchIds: ids }),
  setSearchIndex: (i) => set({ searchIndex: i }),

  openFileManager: (cwd) => set({ fileManagerCwd: cwd }),
  closeFileManager: () => set({ fileManagerCwd: null }),
  openFilePreview: (path) => set({ previewFilePath: path }),
  closeFilePreview: () => set({ previewFilePath: null }),
  setPreviewWidth: (w) => set({ previewWidth: w }),
}));
