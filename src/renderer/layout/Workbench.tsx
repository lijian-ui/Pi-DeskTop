import Titlebar from "./Titlebar";
import Sidebar from "./Sidebar";
import MainPanel from "./MainPanel";
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
    </div>
  );
}