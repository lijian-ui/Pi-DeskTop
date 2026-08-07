import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { usePackageStore } from "../store/package-store";
import styles from "./PackagesPage.module.css";

/** 安装/卸载进度 toast：右下角浮层，3 秒自动消失。 */
export default function PackageToasts() {
  const toast = usePackageStore((s) => s.toast);
  if (!toast) return null;

  return (
    <div className={`${styles.toast} ${styles[`toast_${toast.type}`]}`} role="status">
      {toast.type === "info" && <Loader2 size={14} className={styles.spin} />}
      {toast.type === "success" && <CheckCircle2 size={14} />}
      {toast.type === "error" && <AlertCircle size={14} />}
      <span>{toast.text}</span>
    </div>
  );
}
