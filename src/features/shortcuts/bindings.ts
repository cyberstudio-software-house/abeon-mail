import { ACTIONS, type ActionId } from "./registry";

export type Profile = "default" | "vim";

export function eventToStep(e: { key: string; metaKey: boolean; ctrlKey: boolean }): string {
  const mod = e.metaKey || e.ctrlKey;
  return mod ? `Mod+${e.key}` : e.key;
}

export const DEFAULT_BINDINGS: Record<ActionId, string> = Object.fromEntries(
  ACTIONS.map((a) => [a.id, a.defaultBinding])
) as Record<ActionId, string>;

export const VIM_BINDINGS: Record<ActionId, string> = {
  ...DEFAULT_BINDINGS,
  "first-message": "g g",
  "last-message": "G",
};

const VALID_IDS = new Set<string>(ACTIONS.map((a) => a.id));

export function resolveBindings(
  profile: Profile,
  overrides: Record<string, string | null>
): Record<ActionId, string | null> {
  const base = profile === "vim" ? VIM_BINDINGS : DEFAULT_BINDINGS;
  const out = {} as Record<ActionId, string | null>;
  for (const a of ACTIONS) {
    const b = base[a.id];
    out[a.id] = b ? b : null;
  }
  for (const [id, binding] of Object.entries(overrides)) {
    if (VALID_IDS.has(id)) out[id as ActionId] = binding;
  }
  return out;
}

export function bindingsConflict(a: string, b: string): boolean {
  const ta = a.split(" ");
  const tb = b.split(" ");
  const n = Math.min(ta.length, tb.length);
  for (let i = 0; i < n; i += 1) {
    if (ta[i] !== tb[i]) return false;
  }
  return true;
}

export function conflictFor(
  binding: string,
  resolved: Record<ActionId, string | null>,
  exceptId: ActionId
): ActionId | null {
  for (const a of ACTIONS) {
    if (a.id === exceptId) continue;
    const other = resolved[a.id];
    if (other && bindingsConflict(binding, other)) return a.id;
  }
  return null;
}

function prettyStep(step: string, isMac: boolean): string {
  const mod = isMac ? "⌘" : "Ctrl+";
  if (step.startsWith("Mod+")) {
    const key = step.slice(4);
    return `${mod}${key.length === 1 ? key.toUpperCase() : key}`;
  }
  if (step.length === 1 && step >= "A" && step <= "Z") return `Shift+${step}`;
  if (step.length === 1 && step >= "a" && step <= "z") return step.toUpperCase();
  return step;
}

export function prettyBinding(binding: string, isMac: boolean): string {
  return binding
    .split(" ")
    .map((s) => prettyStep(s, isMac))
    .join(" then ");
}

export const SHORTCUT_KEYS = {
  profile: "shortcuts.profile",
  overrides: "shortcuts.overrides",
} as const;

function isProfile(v: string): v is Profile {
  return v === "default" || v === "vim";
}

export function parseShortcutSettings(
  pairs: [string, string][]
): { profile?: Profile; overrides?: Record<string, string | null> } {
  const out: { profile?: Profile; overrides?: Record<string, string | null> } = {};
  for (const [key, value] of pairs) {
    if (key === SHORTCUT_KEYS.profile) {
      if (isProfile(value)) out.profile = value;
    } else if (key === SHORTCUT_KEYS.overrides) {
      try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        const clean: Record<string, string | null> = {};
        for (const [id, b] of Object.entries(parsed)) {
          if (!VALID_IDS.has(id)) continue;
          if (b === null || typeof b === "string") clean[id] = b;
        }
        out.overrides = clean;
      } catch {
        /* malformed JSON: leave overrides undefined */
      }
    }
  }
  return out;
}
