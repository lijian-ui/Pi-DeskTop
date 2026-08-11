import { create } from "zustand";
import type { SkillInfo } from "../../preload/api";
import i18n from "../../shared/i18n/index";

interface ViewingSkill {
  info: SkillInfo;
  content: string;
}

interface SkillState {
  skills: SkillInfo[];
  loading: boolean;
  importing: boolean;
  reading: boolean;
  /** filePath of a skill whose enable/disable toggle is in flight. */
  togglingPath: string | null;
  /** filePath of a skill whose delete is in flight. */
  deletingPath: string | null;
  error: string | null;
  /** The skill currently shown in the detail modal (null = modal closed). */
  viewing: ViewingSkill | null;
  /** Load the skill list from the SDK (user + project skill dirs). */
  load: () => Promise<void>;
  /** Open the OS file picker, import a .zip skill into ~/.pi/skills. */
  importSkill: () => Promise<void>;
  /** Open the detail modal for a skill, reading its SKILL.md content. */
  openSkill: (info: SkillInfo) => Promise<void>;
  /** Close the detail modal. */
  closeSkill: () => void;
  /** Toggle automatic model invocation (disableModelInvocation frontmatter). */
  toggleSkill: (info: SkillInfo) => Promise<void>;
  /** Delete the skill directory (SKILL.md's parent). */
  removeSkill: (info: SkillInfo) => Promise<void>;
  /**
   * Build what gets inserted into the composer when a skill is "selected".
   *
   * PI has two skill mechanisms:
   *  - Automatic (model-driven): the system prompt advertises available skills
   *    (name + description + file location) and the LLM reads SKILL.md itself
   *    via the read tool. Content is NOT pre-loaded.
   *  - Explicit (`/skill:name`): the full file is inlined into the message.
   *
   * A plain selection in the UI should follow the automatic philosophy: we only
   * reference the skill by name and let the model read it on demand. The
   * explicit `/skill:name` inline is reserved for skills with
   * `disableModelInvocation` (which are NOT advertised in the system prompt, so
   * the model can't discover them any other way).
   */
  commandFor: (info: SkillInfo) => string;
}

export const useSkillStore = create<SkillState>((set, get) => ({
  skills: [],
  loading: false,
  importing: false,
  reading: false,
  togglingPath: null,
  deletingPath: null,
  error: null,
  viewing: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const skills = await window.piDesk.listSkills();
      set({ skills });
    } catch (err) {
      console.error("Failed to load skills:", err);
      set({ error: err instanceof Error ? err.message : "Failed to load skills" });
    } finally {
      set({ loading: false });
    }
  },

  importSkill: async () => {
    set({ importing: true, error: null });
    try {
      const result = await window.piDesk.importSkill();
      if (result && result.error) {
        set({ error: result.error });
      } else if (result) {
        // Refresh the list so the new skill shows up immediately.
        await get().load();
      }
    } catch (err) {
      console.error("Failed to import skill:", err);
      set({ error: err instanceof Error ? err.message : "Failed to import skill" });
    } finally {
      set({ importing: false });
    }
  },

  openSkill: async (info: SkillInfo) => {
    set({ reading: true, error: null });
    try {
      const content = await window.piDesk.readSkillFile(info.filePath);
      set({ viewing: { info, content } });
    } catch (err) {
      console.error("Failed to read skill file:", err);
      set({ error: err instanceof Error ? err.message : "Failed to read skill" });
    } finally {
      set({ reading: false });
    }
  },

  closeSkill: () => set({ viewing: null }),

  toggleSkill: async (info: SkillInfo) => {
    set({ togglingPath: info.filePath, error: null });
    // Optimistic flip so the switch responds immediately; roll back on error.
    const prev = get().skills;
    // Backend writes `disableModelInvocation: !enabled` — pass the CURRENT
    // disable flag so the flip lands (passing `!flag` double-negates and the
    // disk value stays unchanged, making the switch snap back).
    const enable = info.disableModelInvocation;
    set({
      skills: prev.map((s) =>
        s.filePath === info.filePath
          ? { ...s, disableModelInvocation: !s.disableModelInvocation }
          : s,
      ),
    });
    try {
      await window.piDesk.setSkillEnabled(info.filePath, enable);
    } catch (err) {
      console.error("Failed to toggle skill:", err);
      set({
        skills: prev,
        error: err instanceof Error ? err.message : "Failed to toggle skill",
      });
    } finally {
      set({ togglingPath: null });
      // No reload on success: the optimistic flip already equals the on-disk
      // value written above. Reloading here could briefly snap the switch back
      // if the IPC response races the reload (the "closes then opens" glitch).
    }
  },

  removeSkill: async (info: SkillInfo) => {
    set({ deletingPath: info.filePath, error: null });
    try {
      await window.piDesk.deleteSkill(info.filePath);
      await get().load();
    } catch (err) {
      console.error("Failed to delete skill:", err);
      set({ error: err instanceof Error ? err.message : "Failed to delete skill" });
    } finally {
      set({ deletingPath: null });
    }
  },

  commandFor: (info: SkillInfo) => {
    if (info.disableModelInvocation) {
      // Not advertised to the model → must be inlined explicitly.
      return `/skill:${info.name}`;
    }
    // Advertised in the system prompt with its file location → the model reads
    // SKILL.md itself. We only reference it so the LLM loads it on demand.
    return i18n.t("skills.usePrefix", { name: info.name });
  },
}));
