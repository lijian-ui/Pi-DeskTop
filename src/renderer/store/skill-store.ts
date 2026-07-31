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
