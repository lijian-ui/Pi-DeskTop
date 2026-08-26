import { create } from "zustand";
import type { TtsConfig, TtsConfigItem } from "../../preload/api";

interface TtsState {
  config: TtsConfig;
  loaded: boolean;
  load: () => Promise<void>;
  save: (cfg: TtsConfig) => Promise<void>;
  addConfig: (item: TtsConfigItem) => Promise<void>;
  updateConfig: (item: TtsConfigItem) => Promise<void>;
  removeConfig: (id: string) => Promise<void>;
  setActive: (id: string | null) => Promise<void>;
  setStreamEnabled: (enabled: boolean) => Promise<void>;
}

const DEFAULT_CONFIG: TtsConfig = {
  configs: [],
  activeConfigId: null,
  streamEnabled: false,
};

export const useTtsStore = create<TtsState>((set, get) => ({
  config: DEFAULT_CONFIG,
  loaded: false,

  load: async () => {
    try {
      const cfg = await window.piDesk.getTtsConfig();
      set({ config: cfg, loaded: true });
    } catch {
      set({ config: DEFAULT_CONFIG, loaded: true });
    }
  },

  save: async (cfg) => {
    await window.piDesk.saveTtsConfig(cfg);
    set({ config: cfg });
  },

  addConfig: async (item) => {
    const { config } = get();
    const next: TtsConfig = {
      ...config,
      configs: [...config.configs, item],
      activeConfigId: config.activeConfigId ?? item.id,
    };
    await get().save(next);
  },

  updateConfig: async (item) => {
    const { config } = get();
    const next: TtsConfig = {
      ...config,
      configs: config.configs.map((c) => (c.id === item.id ? item : c)),
    };
    await get().save(next);
  },

  removeConfig: async (id) => {
    const { config } = get();
    const next: TtsConfig = {
      ...config,
      configs: config.configs.filter((c) => c.id !== id),
      activeConfigId: config.activeConfigId === id ? null : config.activeConfigId,
    };
    await get().save(next);
  },

  setActive: async (id) => {
    const { config } = get();
    await get().save({ ...config, activeConfigId: id });
  },

  setStreamEnabled: async (enabled) => {
    const { config } = get();
    await get().save({ ...config, streamEnabled: enabled });
  },
}));