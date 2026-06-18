import type { ThemeMode } from "../theme/theme";

export type Density = "comfortable" | "compact" | "dense";

export type AppearanceFields = {
  theme: ThemeMode;
  accent: string;
  density: Density;
  showPreview: boolean;
  showAvatars: boolean;
};

export const SETTINGS_KEYS = {
  theme: "appearance.theme",
  accent: "appearance.accent",
  density: "appearance.density",
  showPreview: "appearance.showPreview",
  showAvatars: "appearance.showAvatars",
} as const;

export const DEFAULT_APPEARANCE: AppearanceFields = {
  theme: "auto",
  accent: "#4f46e5",
  density: "comfortable",
  showPreview: true,
  showAvatars: true,
};

export const THEME_MODES: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "auto", label: "Auto" },
];

export const ACCENT_PRESETS: string[] = [
  "#4f46e5",
  "#7c3aed",
  "#0ea5e9",
  "#10b981",
  "#ef5d3a",
  "#ec4899",
];

export const DENSITIES: { value: Density; label: string; hint: string }[] = [
  { value: "comfortable", label: "Comfortable", hint: "Roomy rows" },
  { value: "compact", label: "Compact", hint: "More on screen" },
  { value: "dense", label: "Dense", hint: "Maximum rows" },
];

const AVATAR_PALETTE = [
  "#4f46e5",
  "#7c3aed",
  "#0ea5e9",
  "#10b981",
  "#ef5d3a",
  "#ec4899",
  "#f59e0b",
  "#0d9488",
];

export function initials(nameOrEmail: string): string {
  const trimmed = nameOrEmail.trim();
  if (!trimmed) return "?";
  const local = trimmed.split("@")[0];
  const words = local.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
}

export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function isThemeMode(v: string): v is ThemeMode {
  return v === "light" || v === "dark" || v === "auto";
}

function isDensity(v: string): v is Density {
  return v === "comfortable" || v === "compact" || v === "dense";
}

export function parseSettings(pairs: [string, string][]): Partial<AppearanceFields> {
  const out: Partial<AppearanceFields> = {};
  for (const [key, value] of pairs) {
    switch (key) {
      case SETTINGS_KEYS.theme:
        if (isThemeMode(value)) out.theme = value;
        break;
      case SETTINGS_KEYS.accent:
        if (ACCENT_PRESETS.includes(value)) out.accent = value;
        break;
      case SETTINGS_KEYS.density:
        if (isDensity(value)) out.density = value;
        break;
      case SETTINGS_KEYS.showPreview:
        out.showPreview = value === "true";
        break;
      case SETTINGS_KEYS.showAvatars:
        out.showAvatars = value === "true";
        break;
      default:
        break;
    }
  }
  return out;
}
