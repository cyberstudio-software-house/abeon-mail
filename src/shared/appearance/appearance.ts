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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hashSeed(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.replace(/(.)/g, "$1$1") : clean;
  const value = parseInt(full, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case rn:
        h = ((gn - bn) / delta) % 6;
        break;
      case gn:
        h = (bn - rn) / delta + 2;
        break;
      default:
        h = (rn - gn) / delta + 4;
    }
    h = (h * 60 + 360) % 360;
  }
  return [h, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ln - c / 2;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
}

function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHsl(r, g, b);
}

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

export type AccentVars = {
  accent: string;
  accentHover: string;
  shadowAccent: string;
};

export function deriveAccentVars(accent: string): AccentVars {
  const [h, s, l] = hexToHsl(accent);
  const [r, g, b] = hexToRgb(accent);
  return {
    accent,
    accentHover: hslToHex(h, s, clamp(l + 6, 0, 100)),
    shadowAccent: `0 6px 14px -6px rgba(${r}, ${g}, ${b}, 0.6)`,
  };
}

const SENDER_TINT_STEPS = [
  { h: 0, s: 0, l: 0 },
  { h: -14, s: 6, l: -9 },
  { h: 12, s: -10, l: 9 },
  { h: -22, s: -4, l: 5 },
  { h: 18, s: 8, l: -6 },
  { h: -8, s: 12, l: 12 },
  { h: 24, s: -8, l: -11 },
  { h: -18, s: 2, l: 7 },
];

export function senderAvatarColor(seed: string, accent: string): string {
  const [h, s, l] = hexToHsl(accent);
  const step = SENDER_TINT_STEPS[hashSeed(seed) % SENDER_TINT_STEPS.length];
  const hue = (h + step.h + 360) % 360;
  const sat = clamp(s + step.s, 35, 90);
  const light = clamp(l + step.l, 40, 64);
  return hslToHex(hue, sat, light);
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
        if (value === "true" || value === "false") out.showPreview = value === "true";
        break;
      case SETTINGS_KEYS.showAvatars:
        if (value === "true" || value === "false") out.showAvatars = value === "true";
        break;
      default:
        break;
    }
  }
  return out;
}
