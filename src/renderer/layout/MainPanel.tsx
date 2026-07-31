import { useEffect, useState } from "react";
import ChatPanel from "../chat/ChatPanel";
import SettingsPage from "../sidebar/SettingsPage";
import SkillsPage from "../skills/SkillsPage";
import AutomatePage from "../automate/AutomatePage";
import TerminalPanel from "../chat/TerminalPanel";
import FilePreviewPanel from "../chat/FilePreviewPanel";
import AboutDialog from "../sidebar/AboutDialog";
import { useUIStore } from "../store/ui-store";
import { PanelLeftOpen } from "lucide-react";
import styles from "./MainPanel.module.css";

export default function MainPanel() {
  const mainView = useUIStore((s) => s.mainView);
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const terminalOpen = useUIStore((s) => s.terminalOpen);
  const previewFilePath = useUIStore((s) => s.previewFilePath);
  // Keep the terminal mounted once it has been opened. Closing it only hides
  // the panel (TerminalPanel renders display:none via the `visible` prop) so
  // the xterm instance, IPC subscriptions and the backend PTY all stay alive —
  // a running task keeps its output and survives close/open cycles.
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  useEffect(() => {
    if (terminalOpen) setTerminalMounted(true);
  }, [terminalOpen]);

  useEffect(() => {
    return window.piDesk.onShowAbout(() => setAboutOpen(true));
  }, []);

  return (
    <div className={styles.mainPanel}>
      {!sidebarVisible && (
        <button
          className={styles.expandBtn}
          onClick={toggleSidebar}
          title="展开侧边栏"
        >
          <PanelLeftOpen size={16} />
        </button>
      )}
      <div className={styles.chatRow}>
        <div className={styles.chatArea}>
          {mainView === "settings" ? (
            <SettingsPage />
          ) : mainView === "skills" ? (
            <SkillsPage />
          ) : mainView === "automate" ? (
            <AutomatePage />
          ) : (
            <ChatPanel />
          )}
        </div>
        {/* File preview column (opened from the sidebar file manager).
            Sits to the RIGHT of the chat area — a sibling column like the
            terminal, not an overlay. Persists across view switches. */}
        {previewFilePath && <FilePreviewPanel filePath={previewFilePath} />}
        {terminalMounted && <TerminalPanel visible={terminalOpen} />}
      </div>
      <AboutDialog
        open={aboutOpen}
        appName="Pi Desktop"
        version="0.1.0"
        onClose={() => setAboutOpen(false)}
      />
    </div>
  );
}