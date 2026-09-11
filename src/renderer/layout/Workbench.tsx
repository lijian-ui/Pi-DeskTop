import Titlebar from "./Titlebar";
import Sidebar from "./Sidebar";
import MainPanel from "./MainPanel";
import ExtensionNotice from "../components/ExtensionNotice";
import { useUIStore } from "../store/ui-store";
import styles from "./Workbench.module.css";

export default function Workbench() {
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);

  return (
    <div className={styles.workbench}>
      <Titlebar />
      <div className={styles.body}>
        {sidebarVisible && <Sidebar />}
        <MainPanel />
      </div>
      {/* Extension slash-command output (ctx.ui.notify) — global, app-level. */}
      <ExtensionNotice />
    </div>
  );
}