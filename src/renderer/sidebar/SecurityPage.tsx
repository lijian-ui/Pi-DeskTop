import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import styles from "./SecurityPage.module.css";

interface BashGuardConfig {
  blacklist: string[];
  whitelist: string[];
}

const DEFAULT_BLACKLIST = [
  // ── Unix / Linux / macOS: destructive delete & wipe ──
  "rm\\s+-rf\\s+/\\S*",
  "rm\\s+-rf\\s+~\\S*",
  "rm\\s+-rf\\s+\\.\\S*",
  "rm\\s+-rf\\s+\\*",
  "sudo\\s+rm\\b.*",
  "chmod\\s+777\\b.*",
  "chmod\\s+-R\\s+777\\b.*",
  "chmod\\s+0{3,}\\b.*",
  "chmod\\s+-R\\s+0{3,}\\b.*",
  "chown\\s+-R\\b.*",
  "dd\\s+if=/dev/(zero|random|urandom)\\b.*",
  "mkfs\\b.*",
  "fdisk\\b.*",
  ">\\s*/dev/sd[a-z]\\d*\\b.*",
  "mv\\s+/\\s+/dev.*",
  // ── Unix / Linux / macOS: power & process ──
  "shutdown\\b.*",
  "reboot\\b.*",
  "poweroff\\b.*",
  "halt\\b.*",
  // ── Universal: dynamic eval / code injection ──
  "eval\\b.*",
  "exec\\b.*",
  // ── Universal: download-and-execute (supply-chain risk) ──
  "curl\\s.*\\|\\s*(ba)?sh",
  "wget\\s.*\\|\\s*(ba)?sh",
  // ── Universal: resource exhaustion / fork bomb ──
  ":\\(\\)\\s*\\{\\s*:\\|\\|:\\s*&\\s*\\};\\s*:",
  // ── Universal: skip host-key verification (MITM risk) ──
  "ssh\\s+-o\\s+StrictHostKeyChecking=no\\b.*",
  // ── Universal: destructive VCS / scheduled ops ──
  "git\\s+reset\\s+--hard\\b.*",
  "git\\s+push\\s+--force\\b.*",
  "crontab\\s+-r\\b.*",
  // ── Windows: recursive delete & format ──
  "rmdir\\s+/s\\s+/q\\b.*",
  "rd\\s+/s\\s+/q\\b.*",
  "del\\s+/f\\s+/s\\s+/q\\b.*",
  "format\\b.*",
  "diskpart\\b.*",
  // ── Windows: ransomware-style shadow / log wipe ──
  "vssadmin\\s+delete\\s+shadows\\b.*",
  "cipher\\s+/w\\b.*",
  "wevtutil\\s+cl\\b.*",
  // ── Windows: boot / registry / privilege ──
  "bcdedit\\s+/delete\\b.*",
  "reg\\s+delete\\b.*",
  "takeown\\b.*",
  "icacls\\s+/grant\\b.*",
  "net\\s+user\\s+administrator\\s+/active:yes\\b.*",
  "net\\s+user\\b.*",
  // ── Windows: obfuscated / silent / dangerous PowerShell ──
  "powershell(?:\\.exe)?\\s+-enc\\b.*",
  "powershell(?:\\.exe)?\\s+-nop\\b.*",
  "powershell(?:\\.exe)?\\s+-executionpolicy\\s+bypass\\b.*",
  "powershell(?:\\.exe)?\\s+iex\\b.*",
  "powershell(?:\\.exe)?\\s+invoke-expression\\b.*",
  "powershell(?:\\.exe)?\\s+remove-item\\s+-recurse\\b.*",
  "powershell(?:\\.exe)?\\s+stop-computer\\b.*",
  "powershell(?:\\.exe)?\\s+restart-computer\\b.*",
  "powershell(?:\\.exe)?\\s+set-mppreference\\b.*",
  "powershell(?:\\.exe)?\\s+clear-disk\\b.*",
  "powershell(?:\\.exe)?\\s+format-volume\\b.*",
  "taskkill\\s+/f\\b.*",
  "schtasks\\s+/delete\\b.*",
  // ── macOS: disk erase & backup destroy ──
  "diskutil\\s+eraseDisk\\b.*",
  "diskutil\\s+partitionDisk\\b.*",
  "diskutil\\s+zeroDisk\\b.*",
  "hdiutil\\s+erase\\b.*",
  "tmutil\\s+disable\\b.*",
  "tmutil\\s+delete\\b.*",
  "sudo\\s+nvram\\b.*",
  "sudo\\s+spctl\\s+--master-disable\\b.*",
  "launchctl\\s+unload\\s+-w\\b.*",
  "srm\\b.*",
];

export default function SecurityPage() {
  const { t } = useTranslation();
  const [blacklistText, setBlacklistText] = useState("");
  const [whitelistText, setWhitelistText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadConfig();
  }, []);

  async function loadConfig() {
    try {
      const cfg = await window.piDesk.getBashGuardConfig();
      setBlacklistText((cfg.blacklist ?? DEFAULT_BLACKLIST).join("\n"));
      setWhitelistText((cfg.whitelist ?? []).join("\n"));
    } catch {
      setBlacklistText(DEFAULT_BLACKLIST.join("\n"));
      setWhitelistText("");
    }
    setLoading(false);
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      const blacklist = blacklistText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const whitelist = whitelistText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      await window.piDesk.saveBashGuardConfig({ blacklist, whitelist });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className={styles.loading}>{t("security.loading")}</div>;

  return (
    <div className={styles.page}>
      {/* ── Blacklist section ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{t("security.blacklistTitle")}</h2>
        <p className={styles.sectionDesc}>{t("security.blacklistDesc")}</p>
        <textarea
          className={styles.textarea}
          value={blacklistText}
          onChange={(e) => setBlacklistText(e.target.value)}
          rows={10}
          spellCheck={false}
        />
      </section>

      {/* ── Whitelist section (editable) ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{t("security.whitelistTitle")}</h2>
        <p className={styles.sectionDesc}>{t("security.whitelistDesc")}</p>
        <textarea
          className={styles.textarea}
          value={whitelistText}
          onChange={(e) => setWhitelistText(e.target.value)}
          rows={5}
          spellCheck={false}
          placeholder={t("security.whitelistPlaceholder")}
        />
      </section>

      {/* ── Save button ── */}
      <div className={styles.actions}>
        <button
          className={`${styles.saveBtn} ${saved ? styles.saveBtnSuccess : ""}`}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? t("security.saving") : saved ? t("security.saved") : t("save")}
        </button>
      </div>
    </div>
  );
}
