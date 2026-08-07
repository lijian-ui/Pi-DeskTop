import { create } from "zustand";

/**
 * Image-related "System Settings" — persisted to localStorage so they survive
 * reloads. These are the knobs behind the composer's image input (compression
 * strength, per-message count cap, per-image size cap). The SDK itself imposes
 * no such limits on inline `prompt(text, {images})` images, so the bounds live
 * entirely on our side.
 */
export interface ImageSettings {
  /** Master switch: when off, images are sent at their original resolution. */
  compressionEnabled: boolean;
  /** JPEG re-encode quality when downscaling (0.3–0.95). */
  compressionQuality: number;
  /** Longest side in px; images larger than this are downscaled (0 = never). */
  compressionMaxSide: number;
  /** Max images that can be attached to a single message. */
  maxCount: number;
  /** Max bytes for a single image before it is rejected. */
  maxBytes: number;
}

export interface SettingsState {
  image: ImageSettings;
  /** Shallow-merge a partial patch into the image settings and persist. */
  setImage: (patch: Partial<ImageSettings>) => void;
}

const DEFAULTS: ImageSettings = {
  compressionEnabled: true,
  compressionQuality: 0.82,
  compressionMaxSide: 1600,
  maxCount: 4,
  maxBytes: 10 * 1024 * 1024,
};

const STORAGE_KEY = "pi-desk:settings";

function loadImageSettings(): ImageSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ImageSettings>;
      // Merge so newly-added fields (or a corrupt/old blob) fall back to defaults.
      return { ...DEFAULTS, ...parsed };
    }
  } catch {
    /* localStorage unavailable or bad JSON — fall back to defaults */
  }
  return { ...DEFAULTS };
}

function persist(img: ImageSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(img));
  } catch {
    /* ignore */
  }
}

export const useImageSettingsStore = create<SettingsState>((set) => ({
  image: loadImageSettings(),

  setImage: (patch) =>
    set((state) => {
      const next = { ...state.image, ...patch };
      persist(next);
      return { image: next };
    }),
}));
