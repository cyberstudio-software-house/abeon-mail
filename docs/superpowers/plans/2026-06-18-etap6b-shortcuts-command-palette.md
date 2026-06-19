# Etap 6b — Keyboard shortcuts + command palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a first-class keyboard-shortcuts subsystem — one action registry driving a keyboard engine, a `Mod+K` command palette, a `?` cheat sheet, and a configurable bindings editor with a Default/Vim profile.

**Architecture:** A pure metadata registry (`registry.ts`) plus a pure binding layer (`bindings.ts`: normalization, profiles, resolution, conflict detection). A `ShortcutsProvider` loads the profile + overrides from the Etap 6a `settings` table, resolves effective bindings, builds a handler map from live hooks/store, mounts a window-level keyboard engine, and renders the palette + cheat sheet. Panes publish what handlers need (`visibleMessageIds`, `replyTargetId`, `composerSend`) into a small store slice.

**Tech Stack:** React 19 + TypeScript, zustand, @tanstack/react-query, `cmdk` (new), vitest + @testing-library/react + happy-dom. Persistence reuses Etap 6a `settings(key,value)` via `commands.getSettings`/`setSetting` — no Rust, no migration.

## Global Constraints

- Frontend only. No Rust, no SQL migration, no new Tauri command (persistence reuses `shortcuts.profile` / `shortcuts.overrides` keys in the existing `settings` table).
- All code identifiers in English. No code comments (document non-obvious decisions in `docs/` only).
- Conventional Commits; do NOT add a co-author; do NOT push.
- `lucide-react` is imported in production but aliased to `src/test/lucide-stub.js` in vitest — if any component adds a NEW lucide icon, add it to the stub or the test suite OOMs. (Pure modules `registry.ts`/`bindings.ts` import NO icons.)
- Binding string format: a step is `e.key` optionally prefixed `Mod+` (Mod = Cmd on macOS, Ctrl elsewhere; `metaKey || ctrlKey`). Shift is encoded by the produced character (`I`, `U`, `G`, `?`, `#`). Sequences join steps with a single space (`"g i"`).
- Conflict semantics: two non-null bindings conflict when one token list equals or is a prefix of the other (`g` conflicts with `g i`).
- Persisted overrides store ONLY deviations from the active profile; resolution is `override ?? profileDefault ?? action.defaultBinding`; an override value of `null` means "deliberately unbound".

---

### Task 1: Action registry

**Files:**
- Create: `src/features/shortcuts/registry.ts`
- Test: `src/features/shortcuts/registry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ActionContext = "global" | "list" | "reader" | "composer"`
  - `type ActionId` (string-literal union of all ids below)
  - `type ActionMeta = { id: ActionId; label: string; contexts: ActionContext[]; defaultBinding: string; enabled: boolean }`
  - `const ACTIONS: ActionMeta[]`
  - `function actionById(id: ActionId): ActionMeta | undefined`

- [ ] **Step 1: Write the failing test**

`src/features/shortcuts/registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ACTIONS, actionById, type ActionId } from "./registry";

describe("ACTIONS registry", () => {
  it("has unique ids", () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every action declares at least one context", () => {
    expect(ACTIONS.every((a) => a.contexts.length > 0)).toBe(true);
  });

  it("placeholder actions are disabled", () => {
    const disabled: ActionId[] = ["archive", "delete", "snooze", "label"];
    for (const id of disabled) {
      expect(actionById(id)?.enabled).toBe(false);
    }
  });

  it("core actions are enabled with their default bindings", () => {
    expect(actionById("command-palette")).toMatchObject({ defaultBinding: "Mod+k", enabled: true });
    expect(actionById("compose")).toMatchObject({ defaultBinding: "c", enabled: true });
    expect(actionById("go-inbox")).toMatchObject({ defaultBinding: "g i", enabled: true });
    expect(actionById("mark-read")).toMatchObject({ defaultBinding: "I", enabled: true });
    expect(actionById("send-message")).toMatchObject({ defaultBinding: "Mod+Enter", enabled: true });
  });

  it("first-message/last-message have no default binding (vim-only)", () => {
    expect(actionById("first-message")?.defaultBinding).toBe("");
    expect(actionById("last-message")?.defaultBinding).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/shortcuts/registry.test.ts`
Expected: FAIL — cannot resolve `./registry`.

- [ ] **Step 3: Write the registry**

`src/features/shortcuts/registry.ts`:

```ts
export type ActionContext = "global" | "list" | "reader" | "composer";

export type ActionId =
  | "command-palette"
  | "cheat-sheet"
  | "compose"
  | "go-inbox"
  | "go-starred"
  | "open-settings"
  | "search"
  | "next-message"
  | "prev-message"
  | "first-message"
  | "last-message"
  | "reply"
  | "reply-all"
  | "forward"
  | "back-to-list"
  | "toggle-flag"
  | "mark-read"
  | "mark-unread"
  | "send-message"
  | "close-composer"
  | "archive"
  | "delete"
  | "snooze"
  | "label";

export type ActionMeta = {
  id: ActionId;
  label: string;
  contexts: ActionContext[];
  defaultBinding: string;
  enabled: boolean;
};

export const ACTIONS: ActionMeta[] = [
  { id: "command-palette", label: "Command palette", contexts: ["global"], defaultBinding: "Mod+k", enabled: true },
  { id: "cheat-sheet", label: "Keyboard shortcuts", contexts: ["global"], defaultBinding: "?", enabled: true },
  { id: "compose", label: "Compose", contexts: ["global"], defaultBinding: "c", enabled: true },
  { id: "go-inbox", label: "Go to All Inboxes", contexts: ["global"], defaultBinding: "g i", enabled: true },
  { id: "go-starred", label: "Go to Flagged", contexts: ["global"], defaultBinding: "g s", enabled: true },
  { id: "open-settings", label: "Settings", contexts: ["global"], defaultBinding: "g ,", enabled: true },
  { id: "search", label: "Search", contexts: ["global"], defaultBinding: "/", enabled: false },
  { id: "next-message", label: "Next message", contexts: ["list"], defaultBinding: "j", enabled: true },
  { id: "prev-message", label: "Previous message", contexts: ["list"], defaultBinding: "k", enabled: true },
  { id: "first-message", label: "First message", contexts: ["list"], defaultBinding: "", enabled: true },
  { id: "last-message", label: "Last message", contexts: ["list"], defaultBinding: "", enabled: true },
  { id: "reply", label: "Reply", contexts: ["reader"], defaultBinding: "r", enabled: true },
  { id: "reply-all", label: "Reply all", contexts: ["reader"], defaultBinding: "a", enabled: true },
  { id: "forward", label: "Forward", contexts: ["reader"], defaultBinding: "f", enabled: true },
  { id: "back-to-list", label: "Back to list", contexts: ["reader"], defaultBinding: "u", enabled: true },
  { id: "toggle-flag", label: "Toggle flag", contexts: ["reader"], defaultBinding: "s", enabled: true },
  { id: "mark-read", label: "Mark read", contexts: ["reader"], defaultBinding: "I", enabled: true },
  { id: "mark-unread", label: "Mark unread", contexts: ["reader"], defaultBinding: "U", enabled: true },
  { id: "send-message", label: "Send", contexts: ["composer"], defaultBinding: "Mod+Enter", enabled: true },
  { id: "close-composer", label: "Close composer", contexts: ["composer"], defaultBinding: "Escape", enabled: true },
  { id: "archive", label: "Archive", contexts: ["reader"], defaultBinding: "e", enabled: false },
  { id: "delete", label: "Delete", contexts: ["reader"], defaultBinding: "#", enabled: false },
  { id: "snooze", label: "Snooze", contexts: ["reader"], defaultBinding: "b", enabled: false },
  { id: "label", label: "Label", contexts: ["reader"], defaultBinding: "l", enabled: false },
];

const BY_ID = new Map<ActionId, ActionMeta>(ACTIONS.map((a) => [a.id, a]));

export function actionById(id: ActionId): ActionMeta | undefined {
  return BY_ID.get(id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/shortcuts/registry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/shortcuts/registry.ts src/features/shortcuts/registry.test.ts
git commit -m "feat(shortcuts): add action registry"
```

---

### Task 2: Binding model, profiles, resolution, conflict detection

**Files:**
- Create: `src/features/shortcuts/bindings.ts`
- Test: `src/features/shortcuts/bindings.test.ts`

**Interfaces:**
- Consumes: `ACTIONS`, `ActionId` from `./registry`.
- Produces:
  - `type Profile = "default" | "vim"`
  - `function eventToStep(e: { key: string; metaKey: boolean; ctrlKey: boolean }): string`
  - `const DEFAULT_BINDINGS: Record<ActionId, string>` and `const VIM_BINDINGS: Record<ActionId, string>`
  - `function resolveBindings(profile: Profile, overrides: Record<string, string | null>): Record<ActionId, string | null>`
  - `function bindingsConflict(a: string, b: string): boolean`
  - `function conflictFor(binding: string, resolved: Record<ActionId, string | null>, exceptId: ActionId): ActionId | null`
  - `function prettyBinding(binding: string, isMac: boolean): string`
  - `const SHORTCUT_KEYS = { profile: "shortcuts.profile", overrides: "shortcuts.overrides" }`
  - `function parseShortcutSettings(pairs: [string, string][]): { profile?: Profile; overrides?: Record<string, string | null> }`

- [ ] **Step 1: Write the failing test**

`src/features/shortcuts/bindings.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  eventToStep,
  resolveBindings,
  bindingsConflict,
  conflictFor,
  prettyBinding,
  parseShortcutSettings,
  SHORTCUT_KEYS,
} from "./bindings";

describe("eventToStep", () => {
  it("plain key", () => {
    expect(eventToStep({ key: "g", metaKey: false, ctrlKey: false })).toBe("g");
  });
  it("shift-produced char encoded by the character itself", () => {
    expect(eventToStep({ key: "I", metaKey: false, ctrlKey: false })).toBe("I");
    expect(eventToStep({ key: "?", metaKey: false, ctrlKey: false })).toBe("?");
  });
  it("ctrl/meta becomes Mod prefix", () => {
    expect(eventToStep({ key: "k", metaKey: false, ctrlKey: true })).toBe("Mod+k");
    expect(eventToStep({ key: "Enter", metaKey: true, ctrlKey: false })).toBe("Mod+Enter");
  });
});

describe("resolveBindings", () => {
  it("default profile uses each action's default binding", () => {
    const r = resolveBindings("default", {});
    expect(r["compose"]).toBe("c");
    expect(r["command-palette"]).toBe("Mod+k");
  });
  it("empty default binding resolves to null", () => {
    expect(resolveBindings("default", {})["first-message"]).toBeNull();
  });
  it("vim profile binds first/last message", () => {
    const r = resolveBindings("vim", {});
    expect(r["first-message"]).toBe("g g");
    expect(r["last-message"]).toBe("G");
    expect(r["next-message"]).toBe("j");
  });
  it("overrides win and null means unbound", () => {
    const r = resolveBindings("default", { compose: "n", reply: null });
    expect(r["compose"]).toBe("n");
    expect(r["reply"]).toBeNull();
  });
  it("ignores unknown override ids", () => {
    const r = resolveBindings("default", { "not-an-action": "z" });
    expect(r["compose"]).toBe("c");
  });
});

describe("bindingsConflict", () => {
  it("equal bindings conflict", () => {
    expect(bindingsConflict("c", "c")).toBe(true);
  });
  it("a sequence prefix conflicts", () => {
    expect(bindingsConflict("g", "g i")).toBe(true);
    expect(bindingsConflict("g i", "g")).toBe(true);
  });
  it("disjoint bindings do not conflict", () => {
    expect(bindingsConflict("g i", "g s")).toBe(false);
    expect(bindingsConflict("c", "r")).toBe(false);
  });
});

describe("conflictFor", () => {
  it("finds the action currently holding a conflicting binding", () => {
    const resolved = resolveBindings("default", {});
    expect(conflictFor("c", resolved, "reply")).toBe("compose");
  });
  it("excludes the action being edited and skips null", () => {
    const resolved = resolveBindings("default", { reply: null });
    expect(conflictFor("c", resolved, "compose")).toBeNull();
  });
});

describe("prettyBinding", () => {
  it("renders Mod and shift letters", () => {
    expect(prettyBinding("Mod+k", true)).toBe("⌘K");
    expect(prettyBinding("Mod+k", false)).toBe("Ctrl+K");
    expect(prettyBinding("I", false)).toBe("Shift+I");
    expect(prettyBinding("g i", false)).toBe("G then I");
  });
});

describe("parseShortcutSettings", () => {
  it("parses profile and overrides JSON, dropping junk", () => {
    const parsed = parseShortcutSettings([
      [SHORTCUT_KEYS.profile, "vim"],
      [SHORTCUT_KEYS.overrides, JSON.stringify({ compose: "n", bogus: "z", reply: null })],
    ]);
    expect(parsed.profile).toBe("vim");
    expect(parsed.overrides).toEqual({ compose: "n", reply: null });
  });
  it("rejects an invalid profile and malformed JSON", () => {
    const parsed = parseShortcutSettings([
      [SHORTCUT_KEYS.profile, "emacs"],
      [SHORTCUT_KEYS.overrides, "{not json"],
    ]);
    expect(parsed.profile).toBeUndefined();
    expect(parsed.overrides).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/shortcuts/bindings.test.ts`
Expected: FAIL — cannot resolve `./bindings`.

- [ ] **Step 3: Write the binding layer**

`src/features/shortcuts/bindings.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/shortcuts/bindings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/shortcuts/bindings.ts src/features/shortcuts/bindings.test.ts
git commit -m "feat(shortcuts): add binding model, profiles, resolution and conflict detection"
```

---

### Task 3: Store slice (action-context + palette/cheat-sheet + shortcuts config)

**Files:**
- Modify: `src/app/store.ts`
- Test: `src/app/store.test.ts` (append new describe blocks)

**Interfaces:**
- Consumes: `type Profile` from `../features/shortcuts/bindings` (type-only import).
- Produces (added to `UiState`): `visibleMessageIds: number[]`, `selectMode: "thread" | "message"`, `replyTargetId: number | null`, `composerSend: (() => void) | null`, `paletteOpen: boolean`, `cheatSheetOpen: boolean`, `shortcutProfile: Profile`, `shortcutOverrides: Record<string, string | null>`, plus setters `setListContext(ids, mode)`, `setReplyTargetId(id)`, `setComposerSend(fn)`, `togglePalette()`, `closePalette()`, `toggleCheatSheet()`, `closeCheatSheet()`, `setShortcutProfile(p)`, `setShortcutOverride(id, binding)`, `resetShortcut(id)`, `hydrateShortcuts(partial)`.

- [ ] **Step 1: Write the failing test**

Append to `src/app/store.test.ts`:

```ts
describe("shortcuts store slice", () => {
  it("setListContext stores ordered ids and mode", () => {
    useUiStore.getState().setListContext([3, 1, 2], "message");
    const s = useUiStore.getState();
    expect(s.visibleMessageIds).toEqual([3, 1, 2]);
    expect(s.selectMode).toBe("message");
  });

  it("palette toggles and closes", () => {
    useUiStore.getState().togglePalette();
    expect(useUiStore.getState().paletteOpen).toBe(true);
    useUiStore.getState().togglePalette();
    expect(useUiStore.getState().paletteOpen).toBe(false);
    useUiStore.setState({ paletteOpen: true });
    useUiStore.getState().closePalette();
    expect(useUiStore.getState().paletteOpen).toBe(false);
  });

  it("cheat sheet toggles and closes", () => {
    useUiStore.getState().toggleCheatSheet();
    expect(useUiStore.getState().cheatSheetOpen).toBe(true);
    useUiStore.getState().closeCheatSheet();
    expect(useUiStore.getState().cheatSheetOpen).toBe(false);
  });

  it("override set / reset and profile change", () => {
    useUiStore.getState().setShortcutProfile("vim");
    useUiStore.getState().setShortcutOverride("compose", "n");
    expect(useUiStore.getState().shortcutProfile).toBe("vim");
    expect(useUiStore.getState().shortcutOverrides.compose).toBe("n");
    useUiStore.getState().resetShortcut("compose");
    expect("compose" in useUiStore.getState().shortcutOverrides).toBe(false);
  });

  it("hydrateShortcuts merges profile and overrides", () => {
    useUiStore.getState().hydrateShortcuts({ profile: "vim", overrides: { reply: null } });
    const s = useUiStore.getState();
    expect(s.shortcutProfile).toBe("vim");
    expect(s.shortcutOverrides.reply).toBeNull();
  });
});
```

Also add a reset of the new fields to the existing `beforeEach` block in `store.test.ts` so blocks stay independent:

```ts
  useUiStore.setState({
    visibleMessageIds: [],
    selectMode: "thread",
    replyTargetId: null,
    composerSend: null,
    paletteOpen: false,
    cheatSheetOpen: false,
    shortcutProfile: "default",
    shortcutOverrides: {},
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/store.test.ts`
Expected: FAIL — `togglePalette is not a function` etc.

- [ ] **Step 3: Extend the store**

In `src/app/store.ts`, add the type-only import near the top:

```ts
import type { Profile } from "../features/shortcuts/bindings";
```

Add these fields to the `UiState` type (after `composer: ComposerState;` and its setters):

```ts
  visibleMessageIds: number[];
  selectMode: "thread" | "message";
  replyTargetId: number | null;
  composerSend: (() => void) | null;
  paletteOpen: boolean;
  cheatSheetOpen: boolean;
  shortcutProfile: Profile;
  shortcutOverrides: Record<string, string | null>;
  setListContext: (ids: number[], mode: "thread" | "message") => void;
  setReplyTargetId: (id: number | null) => void;
  setComposerSend: (fn: (() => void) | null) => void;
  togglePalette: () => void;
  closePalette: () => void;
  toggleCheatSheet: () => void;
  closeCheatSheet: () => void;
  setShortcutProfile: (p: Profile) => void;
  setShortcutOverride: (id: string, binding: string | null) => void;
  resetShortcut: (id: string) => void;
  hydrateShortcuts: (partial: { profile?: Profile; overrides?: Record<string, string | null> }) => void;
```

Add the initial values + implementations inside `create<UiState>((set) => ({ ... }))` (after the `composer` initial value and existing setters):

```ts
  visibleMessageIds: [],
  selectMode: "thread",
  replyTargetId: null,
  composerSend: null,
  paletteOpen: false,
  cheatSheetOpen: false,
  shortcutProfile: "default",
  shortcutOverrides: {},
  setListContext: (ids, mode) => set({ visibleMessageIds: ids, selectMode: mode }),
  setReplyTargetId: (id) => set({ replyTargetId: id }),
  setComposerSend: (fn) => set({ composerSend: fn }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  closePalette: () => set({ paletteOpen: false }),
  toggleCheatSheet: () => set((s) => ({ cheatSheetOpen: !s.cheatSheetOpen })),
  closeCheatSheet: () => set({ cheatSheetOpen: false }),
  setShortcutProfile: (p) => set({ shortcutProfile: p }),
  setShortcutOverride: (id, binding) =>
    set((s) => ({ shortcutOverrides: { ...s.shortcutOverrides, [id]: binding } })),
  resetShortcut: (id) =>
    set((s) => {
      const next = { ...s.shortcutOverrides };
      delete next[id];
      return { shortcutOverrides: next };
    }),
  hydrateShortcuts: (partial) =>
    set((s) => ({
      shortcutProfile: partial.profile ?? s.shortcutProfile,
      shortcutOverrides: partial.overrides ?? s.shortcutOverrides,
    })),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/store.test.ts`
Expected: PASS (existing + new blocks).

- [ ] **Step 5: Commit**

```bash
git add src/app/store.ts src/app/store.test.ts
git commit -m "feat(shortcuts): add action-context, palette and shortcut-config store slice"
```

---

### Task 4: Keyboard engine

**Files:**
- Create: `src/features/shortcuts/useKeyboardEngine.ts`
- Test: `src/features/shortcuts/useKeyboardEngine.test.tsx`

**Interfaces:**
- Consumes: `ACTIONS`, `ActionContext`, `ActionId` from `./registry`; `eventToStep` from `./bindings`.
- Produces:
  - `type EngineOptions = { getResolved: () => Record<ActionId, string | null>; getHandlers: () => Partial<Record<ActionId, () => void>>; getContext: () => ActionContext; sequenceTimeoutMs?: number }`
  - `function useKeyboardEngine(opts: EngineOptions): void`
  - `function isEditableTarget(el: EventTarget | null): boolean` (exported for testing)

- [ ] **Step 1: Write the failing test**

`src/features/shortcuts/useKeyboardEngine.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { useKeyboardEngine } from "./useKeyboardEngine";
import type { ActionId, ActionContext } from "./registry";

afterEach(cleanup);

function Harness({
  resolved,
  handlers,
  context,
}: {
  resolved: Partial<Record<ActionId, string | null>>;
  handlers: Partial<Record<ActionId, () => void>>;
  context: ActionContext;
}) {
  useKeyboardEngine({
    getResolved: () => resolved as Record<ActionId, string | null>,
    getHandlers: () => handlers,
    getContext: () => context,
    sequenceTimeoutMs: 800,
  });
  return (
    <div>
      <input aria-label="field" />
    </div>
  );
}

describe("useKeyboardEngine", () => {
  it("fires a single-key global action", () => {
    const compose = vi.fn();
    render(<Harness resolved={{ compose: "c" }} handlers={{ compose }} context="list" />);
    fireEvent.keyDown(window, { key: "c" });
    expect(compose).toHaveBeenCalledTimes(1);
  });

  it("fires a sequence only after both steps", () => {
    const go = vi.fn();
    render(<Harness resolved={{ "go-inbox": "g i" }} handlers={{ "go-inbox": go }} context="list" />);
    fireEvent.keyDown(window, { key: "g" });
    expect(go).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "i" });
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("respects context: a reader action does not fire in list context", () => {
    const reply = vi.fn();
    render(<Harness resolved={{ reply: "r" }} handlers={{ reply }} context="list" />);
    fireEvent.keyDown(window, { key: "r" });
    expect(reply).not.toHaveBeenCalled();
  });

  it("suppresses single-key shortcuts while typing in an input", () => {
    const compose = vi.fn();
    const { getByLabelText } = render(
      <Harness resolved={{ compose: "c" }} handlers={{ compose }} context="list" />
    );
    const input = getByLabelText("field");
    input.focus();
    fireEvent.keyDown(input, { key: "c" });
    expect(compose).not.toHaveBeenCalled();
  });

  it("still fires Mod chords while typing in an input", () => {
    const palette = vi.fn();
    const { getByLabelText } = render(
      <Harness resolved={{ "command-palette": "Mod+k" }} handlers={{ "command-palette": palette }} context="list" />
    );
    const input = getByLabelText("field");
    input.focus();
    fireEvent.keyDown(input, { key: "k", ctrlKey: true });
    expect(palette).toHaveBeenCalledTimes(1);
  });

  it("ignores disabled actions (no handler registered)", () => {
    render(<Harness resolved={{ archive: "e" }} handlers={{}} context="reader" />);
    expect(() => fireEvent.keyDown(window, { key: "e" })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/shortcuts/useKeyboardEngine.test.tsx`
Expected: FAIL — cannot resolve `./useKeyboardEngine`.

- [ ] **Step 3: Write the engine**

`src/features/shortcuts/useKeyboardEngine.ts`:

```ts
import { useEffect, useRef } from "react";
import { ACTIONS, type ActionContext, type ActionId } from "./registry";
import { eventToStep } from "./bindings";

export type EngineOptions = {
  getResolved: () => Record<ActionId, string | null>;
  getHandlers: () => Partial<Record<ActionId, () => void>>;
  getContext: () => ActionContext;
  sequenceTimeoutMs?: number;
};

const MODIFIER_KEYS = new Set(["Control", "Meta", "Shift", "Alt"]);

export function isEditableTarget(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

function inScope(contexts: ActionContext[], ctx: ActionContext): boolean {
  return contexts.includes(ctx) || contexts.includes("global");
}

function findExact(
  candidate: string,
  ctx: ActionContext,
  resolved: Record<ActionId, string | null>,
  handlers: Partial<Record<ActionId, () => void>>
): ActionId | null {
  let globalMatch: ActionId | null = null;
  for (const a of ACTIONS) {
    if (!a.enabled || !inScope(a.contexts, ctx)) continue;
    if (resolved[a.id] !== candidate || !handlers[a.id]) continue;
    if (a.contexts.includes(ctx) && ctx !== "global") return a.id;
    globalMatch = globalMatch ?? a.id;
  }
  return globalMatch;
}

function isPrefix(
  candidate: string,
  ctx: ActionContext,
  resolved: Record<ActionId, string | null>
): boolean {
  const cand = candidate.split(" ");
  for (const a of ACTIONS) {
    if (!a.enabled || !inScope(a.contexts, ctx)) continue;
    const b = resolved[a.id];
    if (!b) continue;
    const tokens = b.split(" ");
    if (cand.length >= tokens.length) continue;
    if (tokens.slice(0, cand.length).join(" ") === candidate) return true;
  }
  return false;
}

export function useKeyboardEngine(opts: EngineOptions): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const bufferRef = useRef<string[]>([]);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    function clearBuffer() {
      bufferRef.current = [];
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }

    function armTimer() {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      const ms = optsRef.current.sequenceTimeoutMs ?? 800;
      timerRef.current = window.setTimeout(() => {
        bufferRef.current = [];
        timerRef.current = null;
      }, ms);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (MODIFIER_KEYS.has(e.key)) return;
      const step = eventToStep(e);
      const hasMod = step.startsWith("Mod+");
      if (isEditableTarget(e.target) && !hasMod && e.key !== "Escape") return;

      const ctx = optsRef.current.getContext();
      const resolved = optsRef.current.getResolved();
      const handlers = optsRef.current.getHandlers();

      const candidate = [...bufferRef.current, step].join(" ");
      const exact = findExact(candidate, ctx, resolved, handlers);
      if (exact) {
        e.preventDefault();
        clearBuffer();
        handlers[exact]!();
        return;
      }
      if (isPrefix(candidate, ctx, resolved)) {
        bufferRef.current = [...bufferRef.current, step];
        armTimer();
        e.preventDefault();
        return;
      }
      const fresh = findExact(step, ctx, resolved, handlers);
      if (fresh) {
        e.preventDefault();
        clearBuffer();
        handlers[fresh]!();
        return;
      }
      if (isPrefix(step, ctx, resolved)) {
        bufferRef.current = [step];
        armTimer();
        e.preventDefault();
        return;
      }
      clearBuffer();
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      clearBuffer();
    };
  }, []);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/shortcuts/useKeyboardEngine.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/shortcuts/useKeyboardEngine.ts src/features/shortcuts/useKeyboardEngine.test.tsx
git commit -m "feat(shortcuts): add keyboard engine with sequences, context and focus guard"
```

---

### Task 5: ShortcutsProvider, handlers, pane wiring, mount

**Files:**
- Create: `src/features/shortcuts/ShortcutsProvider.tsx`
- Modify: `src/main.tsx` (wrap `<App/>`), `src/features/message-list/MessageListPane.tsx` (publish list context), `src/features/reader/ConversationView.tsx` (publish reply target), `src/features/composer/Composer.tsx` (register send), `src/app/AppShell.test.tsx` (extend store mock)
- Test: `src/features/shortcuts/ShortcutsProvider.test.tsx`

**Interfaces:**
- Consumes: `resolveBindings`, `parseShortcutSettings`, `SHORTCUT_KEYS`, `type Profile` from `./bindings`; `type ActionId` from `./registry`; `useKeyboardEngine` from `./useKeyboardEngine`; `commands` from `../../ipc/bindings`; `useStartReply`, `useSetFlag` from `../../ipc/queries`; `useUiStore` from `../../app/store`; `CommandPalette`, `CheatSheet` (created in Tasks 6 & 7 — until then render `null` placeholders defined inline; Task 6/7 replace them).
- Produces:
  - `type ShortcutsContextValue = { profile: Profile; resolved: Record<ActionId, string | null>; overrides: Record<string, string | null>; setProfile: (p: Profile) => void; setBinding: (id: ActionId, binding: string | null) => void; resetBinding: (id: ActionId) => void }`
  - `function ShortcutsProvider({ children }: { children: ReactNode }): JSX.Element`
  - `function useShortcuts(): ShortcutsContextValue`

> NOTE for implementer: Tasks 6 and 7 create `CommandPalette` and `CheatSheet`. In THIS task, add a local `function PalettePlaceholder() { return null }` and `function CheatSheetPlaceholder() { return null }` and render those; Tasks 6 & 7 swap the imports. Do not block this task on them.

- [ ] **Step 1: Write the failing test**

`src/features/shortcuts/ShortcutsProvider.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../../ipc/bindings", () => ({
  commands: {
    getSettings: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    setSetting: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

const startReply = vi.fn().mockResolvedValue({});
const setFlagMutate = vi.fn();
vi.mock("../../ipc/queries", () => ({
  useStartReply: () => ({ mutateAsync: startReply }),
  useSetFlag: () => ({ mutate: setFlagMutate }),
}));

import { ShortcutsProvider } from "./ShortcutsProvider";
import { useUiStore } from "../../app/store";

beforeEach(() => {
  useUiStore.setState({
    composer: { open: false, draftId: null, prefill: null },
    selectedThreadId: null,
    selectedSmartFolder: null,
    visibleMessageIds: [],
    selectMode: "thread",
    replyTargetId: null,
    paletteOpen: false,
    cheatSheetOpen: false,
    shortcutProfile: "default",
    shortcutOverrides: {},
  });
  startReply.mockClear();
  setFlagMutate.mockClear();
});
afterEach(cleanup);

describe("ShortcutsProvider", () => {
  it("compose shortcut opens the composer", async () => {
    render(<ShortcutsProvider><div /></ShortcutsProvider>);
    fireEvent.keyDown(window, { key: "c" });
    await waitFor(() => expect(useUiStore.getState().composer.open).toBe(true));
  });

  it("Mod+K toggles the palette", () => {
    render(<ShortcutsProvider><div /></ShortcutsProvider>);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(useUiStore.getState().paletteOpen).toBe(true);
  });

  it("j moves selection to the next visible thread", () => {
    useUiStore.setState({ visibleMessageIds: [10, 20, 30], selectMode: "thread", selectedThreadId: 10 });
    render(<ShortcutsProvider><div /></ShortcutsProvider>);
    fireEvent.keyDown(window, { key: "j" });
    expect(useUiStore.getState().selectedThreadId).toBe(20);
  });

  it("reply (reader context) calls startReply with the reply target", async () => {
    useUiStore.setState({ selectedThreadId: 5, replyTargetId: 42 });
    render(<ShortcutsProvider><div /></ShortcutsProvider>);
    fireEvent.keyDown(window, { key: "r" });
    await waitFor(() => expect(startReply).toHaveBeenCalledWith({ messageId: 42, mode: "reply" }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/shortcuts/ShortcutsProvider.test.tsx`
Expected: FAIL — cannot resolve `./ShortcutsProvider`.

- [ ] **Step 3: Write the provider**

`src/features/shortcuts/ShortcutsProvider.tsx`:

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { commands } from "../../ipc/bindings";
import { useStartReply, useSetFlag } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import { resolveBindings, parseShortcutSettings, SHORTCUT_KEYS, type Profile } from "./bindings";
import { type ActionId } from "./registry";
import { useKeyboardEngine } from "./useKeyboardEngine";
import { CommandPalette } from "./CommandPalette";
import { CheatSheet } from "./CheatSheet";

export type ShortcutsContextValue = {
  profile: Profile;
  resolved: Record<ActionId, string | null>;
  overrides: Record<string, string | null>;
  setProfile: (p: Profile) => void;
  setBinding: (id: ActionId, binding: string | null) => void;
  resetBinding: (id: ActionId) => void;
};

const ShortcutsContext = createContext<ShortcutsContextValue | null>(null);

function persistOverrides(overrides: Record<string, string | null>) {
  void commands.setSetting(SHORTCUT_KEYS.overrides, JSON.stringify(overrides)).catch(() => undefined);
}

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const profile = useUiStore((s) => s.shortcutProfile);
  const overrides = useUiStore((s) => s.shortcutOverrides);
  const hydrateShortcuts = useUiStore((s) => s.hydrateShortcuts);
  const setShortcutProfile = useUiStore((s) => s.setShortcutProfile);
  const setShortcutOverride = useUiStore((s) => s.setShortcutOverride);
  const resetShortcut = useUiStore((s) => s.resetShortcut);

  const startReply = useStartReply();
  const setFlag = useSetFlag();

  useEffect(() => {
    let active = true;
    commands
      .getSettings()
      .then((res) => {
        if (active && res.status === "ok") hydrateShortcuts(parseShortcutSettings(res.data));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [hydrateShortcuts]);

  const resolved = useMemo(() => resolveBindings(profile, overrides), [profile, overrides]);

  const move = useCallback((delta: number) => {
    const s = useUiStore.getState();
    const ids = s.visibleMessageIds;
    if (ids.length === 0) return;
    const current = s.selectMode === "thread" ? s.selectedThreadId : s.selectedMessageId;
    const idx = current == null ? -1 : ids.indexOf(current);
    const nextIdx = idx < 0 ? 0 : Math.min(Math.max(idx + delta, 0), ids.length - 1);
    const next = ids[nextIdx];
    if (next == null) return;
    if (s.selectMode === "thread") s.setSelectedThreadId(next);
    else s.setSelectedMessageId(next);
  }, []);

  const jumpTo = useCallback((edge: "first" | "last") => {
    const s = useUiStore.getState();
    const ids = s.visibleMessageIds;
    if (ids.length === 0) return;
    const id = edge === "first" ? ids[0] : ids[ids.length - 1];
    if (s.selectMode === "thread") s.setSelectedThreadId(id);
    else s.setSelectedMessageId(id);
  }, []);

  const doReply = useCallback(
    async (mode: "reply" | "reply_all" | "forward") => {
      const s = useUiStore.getState();
      if (s.replyTargetId == null) return;
      const prefill = await startReply.mutateAsync({ messageId: s.replyTargetId, mode });
      s.openComposer(null, prefill);
    },
    [startReply]
  );

  const setSeen = useCallback(
    (value: boolean) => {
      const s = useUiStore.getState();
      if (s.replyTargetId == null) return;
      setFlag.mutate({ messageId: s.replyTargetId, flag: "seen", value });
    },
    [setFlag]
  );

  const toggleFlag = useCallback(() => {
    const s = useUiStore.getState();
    if (s.replyTargetId == null) return;
    setFlag.mutate({ messageId: s.replyTargetId, flag: "flagged", value: true });
  }, [setFlag]);

  const handlers = useMemo<Partial<Record<ActionId, () => void>>>(() => {
    return {
      "command-palette": () => useUiStore.getState().togglePalette(),
      "cheat-sheet": () => useUiStore.getState().toggleCheatSheet(),
      compose: () => useUiStore.getState().openComposer(null),
      "go-inbox": () => useUiStore.getState().setSelectedSmartFolder("all_inboxes"),
      "go-starred": () => useUiStore.getState().setSelectedSmartFolder("flagged"),
      "open-settings": () => useUiStore.getState().openSettings(),
      "next-message": () => move(1),
      "prev-message": () => move(-1),
      "first-message": () => jumpTo("first"),
      "last-message": () => jumpTo("last"),
      reply: () => void doReply("reply"),
      "reply-all": () => void doReply("reply_all"),
      forward: () => void doReply("forward"),
      "back-to-list": () => useUiStore.getState().setSelectedThreadId(null),
      "toggle-flag": () => toggleFlag(),
      "mark-read": () => setSeen(true),
      "mark-unread": () => setSeen(false),
      "send-message": () => useUiStore.getState().composerSend?.(),
      "close-composer": () => useUiStore.getState().closeComposer(),
    };
  }, [move, jumpTo, doReply, toggleFlag, setSeen]);

  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useKeyboardEngine({
    getResolved: useCallback(() => resolvedRef.current, []),
    getHandlers: useCallback(() => handlersRef.current, []),
    getContext: useCallback(() => {
      const s = useUiStore.getState();
      if (s.composer.open) return "composer";
      if (s.selectedThreadId != null) return "reader";
      return "list";
    }, []),
  });

  const value = useMemo<ShortcutsContextValue>(
    () => ({
      profile,
      resolved,
      overrides,
      setProfile: (p) => {
        setShortcutProfile(p);
        void commands.setSetting(SHORTCUT_KEYS.profile, p).catch(() => undefined);
      },
      setBinding: (id, binding) => {
        setShortcutOverride(id, binding);
        persistOverrides({ ...useUiStore.getState().shortcutOverrides });
      },
      resetBinding: (id) => {
        resetShortcut(id);
        persistOverrides({ ...useUiStore.getState().shortcutOverrides });
      },
    }),
    [profile, resolved, overrides, setShortcutProfile, setShortcutOverride, resetShortcut]
  );

  return (
    <ShortcutsContext.Provider value={value}>
      {children}
      <CommandPalette />
      <CheatSheet />
    </ShortcutsContext.Provider>
  );
}

export function useShortcuts(): ShortcutsContextValue {
  const ctx = useContext(ShortcutsContext);
  if (!ctx) throw new Error("useShortcuts must be used within ShortcutsProvider");
  return ctx;
}
```

Because Tasks 6 & 7 create `CommandPalette`/`CheatSheet`, create minimal stub files now so this task compiles and the provider test passes; Tasks 6 & 7 replace their bodies:

`src/features/shortcuts/CommandPalette.tsx` (stub):

```tsx
export function CommandPalette() {
  return null;
}
```

`src/features/shortcuts/CheatSheet.tsx` (stub):

```tsx
export function CheatSheet() {
  return null;
}
```

- [ ] **Step 4: Run provider test to verify it passes**

Run: `npx vitest run src/features/shortcuts/ShortcutsProvider.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the panes to publish context**

In `src/features/message-list/MessageListPane.tsx`, publish the visible id list + mode. Add `useEffect` import (it currently imports `useRef, useMemo`), grab `setListContext`, and publish after `entries` is computed:

```tsx
import { useRef, useMemo, useEffect } from "react";
```

Add near the other store selectors inside `MessageListPane`:

```tsx
  const setListContext = useUiStore((s) => s.setListContext);
```

Add this effect after the `entries` `useMemo` (it derives the ordered ids from the same raw items, in display order, skipping headers):

```tsx
  useEffect(() => {
    const ids = isSmartMode
      ? (rawItems as SmartMessageRow[]).map((r) => r.message_id)
      : (rawItems as ThreadSummary[]).map((t) => t.thread_id);
    setListContext(ids, isSmartMode ? "message" : "thread");
  }, [rawItems, isSmartMode, setListContext]);
```

In `src/features/reader/ConversationView.tsx`, publish the reply target (the latest message) while a thread is open. Add `useEffect` import and the store setter, and set/clear `replyTargetId`:

```tsx
import { useEffect } from "react";
```

Add inside `ConversationView`, after `const setFlag = useSetFlag();`:

```tsx
  const setReplyTargetId = useUiStore((s) => s.setReplyTargetId);
  const lastId = messages && messages.length > 0 ? messages[messages.length - 1].id : null;
  useEffect(() => {
    setReplyTargetId(lastId);
    return () => setReplyTargetId(null);
  }, [lastId, setReplyTargetId]);
```

> Place this effect ABOVE the early `return` statements? React hooks must not be conditional. The current component early-returns on loading/empty BEFORE hooks would run. Move the two early `return` lines (`if (isLoading) ...` and `if (!messages ...) ...`) to AFTER this `useEffect` so all hooks run unconditionally. `lastId` already guards the null case, so the effect is safe before the returns.

In `src/features/composer/Composer.tsx`, register the send handler so `Mod+Enter` works. Add the store setter and an effect that registers `handleSend` while mounted. Add near the top of `Composer` (after `const closeComposer = useUiStore((s) => s.closeComposer);`):

```tsx
  const setComposerSend = useUiStore((s) => s.setComposerSend);
```

`handleSend` is declared as `async function handleSend()`. Register a stable wrapper after it is defined (function declarations are hoisted, so an effect placed among the other hooks can reference it):

```tsx
  useEffect(() => {
    setComposerSend(() => {
      void handleSend();
    });
    return () => setComposerSend(null);
  }, [setComposerSend]);
```

> If `Composer.tsx` does not already import `useEffect`, add it to the existing `react` import.

- [ ] **Step 6: Mount the provider**

In `src/main.tsx`, wrap `<App/>` with `ShortcutsProvider` (inside `AppearanceProvider`):

```tsx
import { ShortcutsProvider } from "./features/shortcuts/ShortcutsProvider";
```

```tsx
    <QueryProvider>
      <AppearanceProvider>
        <ShortcutsProvider>
          <App />
        </ShortcutsProvider>
      </AppearanceProvider>
    </QueryProvider>
```

- [ ] **Step 7: Keep the store-mocking tests green**

Two existing tests mock `../app/store` (or `../../app/store`) with a literal state object. Adding fields to `UiState` (Task 3) breaks them — `MessageListPane.test` because its literal is typed `UiState` (TypeScript now requires the new fields), and both because the pane effects call store setters that would otherwise be `undefined`.

(a) `src/app/AppShell.test.tsx` — the mock state is an untyped object literal. Add to it (partial is fine):

```ts
      visibleMessageIds: [],
      selectMode: "thread",
      replyTargetId: null,
      setListContext: vi.fn(),
      setReplyTargetId: vi.fn(),
      setComposerSend: vi.fn(),
```

(b) `src/features/message-list/MessageListPane.test.tsx` — the mock `state` is typed `UiState`, so it must list ALL new fields or it fails to compile. Inside the `mockUseUiStore.mockImplementation` `state` literal, add:

```ts
      visibleMessageIds: [],
      selectMode: "thread",
      replyTargetId: null,
      composerSend: null,
      paletteOpen: false,
      cheatSheetOpen: false,
      shortcutProfile: "default",
      shortcutOverrides: {},
      setListContext: vi.fn(),
      setReplyTargetId: vi.fn(),
      setComposerSend: vi.fn(),
      togglePalette: vi.fn(),
      closePalette: vi.fn(),
      toggleCheatSheet: vi.fn(),
      closeCheatSheet: vi.fn(),
      setShortcutProfile: vi.fn(),
      setShortcutOverride: vi.fn(),
      resetShortcut: vi.fn(),
      hydrateShortcuts: vi.fn(),
```

> `ConversationView.test` and `Composer.test` spread the real store via `importOriginal`, so they already have the new fields — no change needed there.
> Note: AppShell.test does NOT mount `ShortcutsProvider` (it renders `AppShell` directly), so no palette/engine wiring is exercised there — only the pane store reads need to resolve.

- [ ] **Step 8: Run the full suite**

Run: `npx vitest run`
Expected: PASS — all prior tests plus the new shortcuts tests. In particular `src/app/AppShell.test.tsx`, `src/features/message-list/MessageListPane.test.tsx`, `src/features/reader/ConversationView.test.tsx`, and `src/features/composer/Composer.test.tsx` stay green.

- [ ] **Step 9: Commit**

```bash
git add src/features/shortcuts/ShortcutsProvider.tsx src/features/shortcuts/ShortcutsProvider.test.tsx \
  src/features/shortcuts/CommandPalette.tsx src/features/shortcuts/CheatSheet.tsx \
  src/main.tsx src/features/message-list/MessageListPane.tsx src/features/message-list/MessageListPane.test.tsx \
  src/features/reader/ConversationView.tsx \
  src/features/composer/Composer.tsx src/app/AppShell.test.tsx
git commit -m "feat(shortcuts): wire ShortcutsProvider, handlers, pane context and engine mount"
```

---

### Task 6: Command palette (cmdk)

**Files:**
- Add dependency: `cmdk`
- Replace stub: `src/features/shortcuts/CommandPalette.tsx`
- Create: `src/features/shortcuts/CommandPalette.css`
- Test: `src/features/shortcuts/CommandPalette.test.tsx`

**Interfaces:**
- Consumes: `useShortcuts` from `./ShortcutsProvider`; `ACTIONS`, `type ActionId` from `./registry`; `prettyBinding` from `./bindings`; `useUiStore` from `../../app/store`; `useAccounts`, `useFolders` from `../../ipc/queries`.
- Produces: `function CommandPalette(): JSX.Element | null` (rendered by `ShortcutsProvider`).

- [ ] **Step 1: Install cmdk**

```bash
npm install cmdk
```

Expected: `cmdk` appears in `package.json` dependencies; `node_modules/cmdk` exists.

- [ ] **Step 2: Write the failing test**

`src/features/shortcuts/CommandPalette.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("./ShortcutsProvider", () => ({
  useShortcuts: () => ({
    profile: "default",
    resolved: { compose: "c", "command-palette": "Mod+k" },
    overrides: {},
    setProfile: vi.fn(),
    setBinding: vi.fn(),
    resetBinding: vi.fn(),
  }),
}));

vi.mock("../../ipc/queries", () => ({
  useAccounts: () => ({ data: [{ id: 1, email: "a@b.c" }] }),
  useFolders: () => ({ data: [{ id: 7, name: "Inbox" }] }),
}));

import { CommandPalette } from "./CommandPalette";
import { useUiStore } from "../../app/store";

beforeEach(() => {
  useUiStore.setState({
    paletteOpen: true,
    selectedAccountId: 1,
    closePalette: vi.fn(),
    openComposer: vi.fn(),
    setSelectedFolderId: vi.fn(),
  });
});
afterEach(cleanup);

describe("CommandPalette", () => {
  it("does not render when closed", () => {
    useUiStore.setState({ paletteOpen: false });
    const { container } = render(<CommandPalette />);
    expect(container.firstChild).toBeNull();
  });

  it("lists enabled actions and folders", () => {
    render(<CommandPalette />);
    expect(screen.getByText("Compose")).toBeTruthy();
    expect(screen.getByText("Inbox")).toBeTruthy();
  });

  it("filters by query", () => {
    render(<CommandPalette />);
    const input = screen.getByPlaceholderText(/type a command/i);
    fireEvent.change(input, { target: { value: "compo" } });
    expect(screen.getByText("Compose")).toBeTruthy();
    expect(screen.queryByText("Inbox")).toBeNull();
  });

  it("running an action closes the palette and invokes its handler", () => {
    const openComposer = vi.fn();
    const closePalette = vi.fn();
    useUiStore.setState({ openComposer, closePalette });
    render(<CommandPalette />);
    fireEvent.click(screen.getByText("Compose"));
    expect(openComposer).toHaveBeenCalled();
    expect(closePalette).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/features/shortcuts/CommandPalette.test.tsx`
Expected: FAIL — palette stub renders nothing / no input.

- [ ] **Step 4: Implement the palette**

Replace `src/features/shortcuts/CommandPalette.tsx`. The `useEffect` for Escape sits ABOVE the `if (!open) return null` guard so hook order is stable:

```tsx
import { useEffect } from "react";
import { Command } from "cmdk";
import { useShortcuts } from "./ShortcutsProvider";
import { ACTIONS, type ActionId } from "./registry";
import { prettyBinding } from "./bindings";
import { useUiStore } from "../../app/store";
import { useFolders } from "../../ipc/queries";
import "./CommandPalette.css";

const IS_MAC =
  typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");

export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  const closePalette = useUiStore((s) => s.closePalette);
  const openComposer = useUiStore((s) => s.openComposer);
  const openSettings = useUiStore((s) => s.openSettings);
  const setSelectedSmartFolder = useUiStore((s) => s.setSelectedSmartFolder);
  const setSelectedFolderId = useUiStore((s) => s.setSelectedFolderId);
  const toggleCheatSheet = useUiStore((s) => s.toggleCheatSheet);
  const selectedAccountId = useUiStore((s) => s.selectedAccountId);
  const { resolved } = useShortcuts();
  const { data: folders } = useFolders(selectedAccountId);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePalette();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closePalette]);

  if (!open) return null;

  const paletteActions: Partial<Record<ActionId, () => void>> = {
    compose: () => openComposer(null),
    "open-settings": () => openSettings(),
    "go-inbox": () => setSelectedSmartFolder("all_inboxes"),
    "go-starred": () => setSelectedSmartFolder("flagged"),
    "cheat-sheet": () => toggleCheatSheet(),
  };

  function run(fn: () => void) {
    closePalette();
    fn();
  }

  const visibleActions = ACTIONS.filter((a) => a.enabled && paletteActions[a.id]);

  return (
    <div className="palette-overlay" onClick={closePalette} role="presentation">
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <Command label="Command palette" loop>
          <Command.Input autoFocus placeholder="Type a command or search…" />
          <Command.List>
            <Command.Empty>No results.</Command.Empty>
            <Command.Group heading="Actions">
              {visibleActions.map((a) => {
                const binding = resolved[a.id];
                return (
                  <Command.Item key={a.id} value={a.label} onSelect={() => run(paletteActions[a.id]!)}>
                    <span>{a.label}</span>
                    {binding && <kbd className="palette__kbd">{prettyBinding(binding, IS_MAC)}</kbd>}
                  </Command.Item>
                );
              })}
            </Command.Group>
            <Command.Group heading="Smart folders">
              <Command.Item value="All Inboxes" onSelect={() => run(() => setSelectedSmartFolder("all_inboxes"))}>
                All Inboxes
              </Command.Item>
              <Command.Item value="Unread" onSelect={() => run(() => setSelectedSmartFolder("unread"))}>
                Unread
              </Command.Item>
              <Command.Item value="Flagged" onSelect={() => run(() => setSelectedSmartFolder("flagged"))}>
                Flagged
              </Command.Item>
            </Command.Group>
            {folders && folders.length > 0 && (
              <Command.Group heading="Folders">
                {folders.map((f) => (
                  <Command.Item
                    key={f.id}
                    value={`folder ${f.name}`}
                    onSelect={() => run(() => setSelectedFolderId(f.id))}
                  >
                    {f.name}
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
```

> The CommandPalette.test mocks `useFolders` (returns `{ data: [{ id: 7, name: "Inbox" }] }`) and `useShortcuts`; it does not mock `useAccounts`, so do not import it.

- [ ] **Step 5: Style the palette**

`src/features/shortcuts/CommandPalette.css`:

```css
.palette-overlay {
  position: fixed;
  inset: 0;
  background: rgba(20, 20, 35, 0.35);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  z-index: 1000;
}
.palette {
  width: min(560px, 92vw);
  background: var(--bg-surface, #fff);
  border: 1px solid var(--rail-border, #e4e4ef);
  border-radius: 12px;
  box-shadow: 0 24px 60px rgba(20, 20, 35, 0.28);
  overflow: hidden;
}
.palette [cmdk-input] {
  width: 100%;
  border: none;
  outline: none;
  padding: 16px 18px;
  font-size: 15px;
  background: transparent;
  color: var(--text-subject, #2a2a40);
  border-bottom: 1px solid var(--rail-border, #e4e4ef);
}
.palette [cmdk-list] {
  max-height: 360px;
  overflow: auto;
  padding: 8px;
}
.palette [cmdk-group-heading] {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--section-label, #aaaabf);
  padding: 8px 10px 4px;
}
.palette [cmdk-item] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 10px;
  border-radius: 8px;
  font-size: 14px;
  color: var(--text-subject, #2a2a40);
  cursor: pointer;
}
.palette [cmdk-item][data-selected="true"] {
  background: var(--selection-bg, #eef0fe);
}
.palette [cmdk-empty] {
  padding: 16px;
  text-align: center;
  color: var(--text-preview, #9090a6);
  font-size: 13px;
}
.palette__kbd {
  font-size: 11px;
  color: var(--text-count, #a0a0b4);
  background: var(--rail-item, #f1f1f8);
  border-radius: 5px;
  padding: 2px 6px;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/features/shortcuts/CommandPalette.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 7: Verify no OOM / suite-wide green and build**

Run: `npx vitest run`
Expected: PASS, no heap OOM. (No new lucide icons were added; if you added any, add them to `src/test/lucide-stub.js`.)

Run: `npm run build`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/features/shortcuts/CommandPalette.tsx \
  src/features/shortcuts/CommandPalette.css src/features/shortcuts/CommandPalette.test.tsx
git commit -m "feat(shortcuts): add command palette built on cmdk"
```

---

### Task 7: Cheat sheet

**Files:**
- Replace stub: `src/features/shortcuts/CheatSheet.tsx`
- Create: `src/features/shortcuts/CheatSheet.css`
- Test: `src/features/shortcuts/CheatSheet.test.tsx`

**Interfaces:**
- Consumes: `useShortcuts` from `./ShortcutsProvider`; `ACTIONS`, `type ActionContext` from `./registry`; `prettyBinding` from `./bindings`; `useUiStore` from `../../app/store`.
- Produces: `function CheatSheet(): JSX.Element | null`.

- [ ] **Step 1: Write the failing test**

`src/features/shortcuts/CheatSheet.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("./ShortcutsProvider", () => ({
  useShortcuts: () => ({
    profile: "default",
    resolved: {
      compose: "c",
      reply: "r",
      "first-message": null,
      archive: "e",
    },
    overrides: {},
    setProfile: vi.fn(),
    setBinding: vi.fn(),
    resetBinding: vi.fn(),
  }),
}));

import { CheatSheet } from "./CheatSheet";
import { useUiStore } from "../../app/store";

beforeEach(() => {
  useUiStore.setState({ cheatSheetOpen: true, closeCheatSheet: vi.fn() });
});
afterEach(cleanup);

describe("CheatSheet", () => {
  it("does not render when closed", () => {
    useUiStore.setState({ cheatSheetOpen: false });
    const { container } = render(<CheatSheet />);
    expect(container.firstChild).toBeNull();
  });

  it("shows actions grouped by context with their bindings", () => {
    render(<CheatSheet />);
    expect(screen.getByText("Compose")).toBeTruthy();
    expect(screen.getByText("Reply")).toBeTruthy();
    expect(screen.getByText("C")).toBeTruthy();
  });

  it("marks disabled actions as coming soon", () => {
    render(<CheatSheet />);
    const archiveRow = screen.getByText("Archive").closest(".cheat-row");
    expect(archiveRow?.className).toContain("cheat-row--disabled");
  });

  it("closes on the close button", () => {
    const closeCheatSheet = vi.fn();
    useUiStore.setState({ closeCheatSheet });
    render(<CheatSheet />);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(closeCheatSheet).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/shortcuts/CheatSheet.test.tsx`
Expected: FAIL — stub renders nothing.

- [ ] **Step 3: Implement the cheat sheet**

Replace `src/features/shortcuts/CheatSheet.tsx`:

```tsx
import { useEffect } from "react";
import { useShortcuts } from "./ShortcutsProvider";
import { ACTIONS, type ActionContext } from "./registry";
import { prettyBinding } from "./bindings";
import { useUiStore } from "../../app/store";
import "./CheatSheet.css";

const IS_MAC =
  typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");

const GROUPS: { context: ActionContext; title: string }[] = [
  { context: "global", title: "Global" },
  { context: "list", title: "Message list" },
  { context: "reader", title: "Reader" },
  { context: "composer", title: "Composer" },
];

export function CheatSheet() {
  const open = useUiStore((s) => s.cheatSheetOpen);
  const closeCheatSheet = useUiStore((s) => s.closeCheatSheet);
  const { resolved } = useShortcuts();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCheatSheet();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeCheatSheet]);

  if (!open) return null;

  return (
    <div className="cheat-overlay" role="dialog" aria-label="Keyboard shortcuts" aria-modal="true">
      <div className="cheat-panel">
        <header className="cheat-header">
          <h2 className="cheat-title">Keyboard shortcuts</h2>
          <button type="button" className="cheat-close" aria-label="Close shortcuts" onClick={closeCheatSheet}>
            ✕
          </button>
        </header>
        <div className="cheat-columns">
          {GROUPS.map((g) => {
            const rows = ACTIONS.filter((a) => a.contexts.includes(g.context));
            if (rows.length === 0) return null;
            return (
              <section key={g.context} className="cheat-section">
                <h3 className="cheat-section__title">{g.title}</h3>
                {rows.map((a) => {
                  const binding = resolved[a.id];
                  return (
                    <div key={a.id} className={`cheat-row${a.enabled ? "" : " cheat-row--disabled"}`}>
                      <span className="cheat-row__label">{a.label}</span>
                      {a.enabled ? (
                        binding ? (
                          <kbd className="cheat-row__kbd">{prettyBinding(binding, IS_MAC)}</kbd>
                        ) : (
                          <span className="cheat-row__none">—</span>
                        )
                      ) : (
                        <span className="cheat-row__soon">Coming soon</span>
                      )}
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Style the cheat sheet**

`src/features/shortcuts/CheatSheet.css`:

```css
.cheat-overlay {
  position: fixed;
  inset: 0;
  background: rgba(20, 20, 35, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.cheat-panel {
  width: min(820px, 94vw);
  max-height: 86vh;
  overflow: auto;
  background: var(--bg-surface, #fff);
  border-radius: 14px;
  box-shadow: 0 24px 70px rgba(20, 20, 35, 0.3);
  padding: 22px 26px 28px;
}
.cheat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;
}
.cheat-title {
  font-size: 18px;
  margin: 0;
  color: var(--text-subject, #2a2a40);
}
.cheat-close {
  border: none;
  background: transparent;
  font-size: 16px;
  cursor: pointer;
  color: var(--icon-muted, #6b6b85);
}
.cheat-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 32px;
}
.cheat-section {
  margin-bottom: 14px;
}
.cheat-section__title {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--section-label, #aaaabf);
  margin: 0 0 8px;
}
.cheat-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 0;
  font-size: 14px;
  color: var(--text-subject, #2a2a40);
}
.cheat-row--disabled {
  opacity: 0.55;
}
.cheat-row__kbd {
  font-size: 12px;
  color: var(--text-count, #a0a0b4);
  background: var(--rail-item, #f1f1f8);
  border-radius: 5px;
  padding: 2px 7px;
}
.cheat-row__none,
.cheat-row__soon {
  font-size: 12px;
  color: var(--text-preview, #9090a6);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/features/shortcuts/CheatSheet.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/features/shortcuts/CheatSheet.tsx src/features/shortcuts/CheatSheet.css \
  src/features/shortcuts/CheatSheet.test.tsx
git commit -m "feat(shortcuts): add cheat sheet generated from the registry"
```

---

### Task 8: Shortcuts settings section (editor)

**Files:**
- Create: `src/features/settings/ShortcutsSection.tsx`
- Create: `src/features/shortcuts/useRecorder.ts`
- Modify: `src/features/settings/SettingsOverlay.tsx` (render the section), `src/features/settings/Settings.css` (append editor styles)
- Test: `src/features/shortcuts/useRecorder.test.tsx`, `src/features/settings/ShortcutsSection.test.tsx`

**Interfaces:**
- Consumes: `useShortcuts` from `../shortcuts/ShortcutsProvider`; `ACTIONS`, `type ActionId` from `../shortcuts/registry`; `conflictFor`, `prettyBinding`, `eventToStep`, `actionById`-equivalent, `type Profile` from `../shortcuts/bindings` + `../shortcuts/registry`.
- Produces:
  - `useRecorder.ts`: `type RecorderState = { recording: boolean; steps: string[] }` and `function useRecorder(onCommit: (binding: string) => void, timeoutMs?: number): { recording: boolean; steps: string[]; start: () => void; cancel: () => void }`
  - `ShortcutsSection.tsx`: `function ShortcutsSection(): JSX.Element`

- [ ] **Step 1: Write the failing test for the recorder**

`src/features/shortcuts/useRecorder.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useRecorder } from "./useRecorder";

afterEach(cleanup);

function Harness({ onCommit }: { onCommit: (b: string) => void }) {
  const rec = useRecorder(onCommit, 50);
  return (
    <div>
      <button onClick={rec.start}>start</button>
      <span data-testid="state">{rec.recording ? "rec" : "idle"}</span>
      <span data-testid="steps">{rec.steps.join(" ")}</span>
    </div>
  );
}

describe("useRecorder", () => {
  it("captures a single chord and commits after the pause", () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    fireEvent.click(screen.getByText("start"));
    expect(screen.getByTestId("state").textContent).toBe("rec");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(onCommit).toHaveBeenCalledWith("Mod+k");
    vi.useRealTimers();
  });

  it("captures a two-step sequence", () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    fireEvent.click(screen.getByText("start"));
    fireEvent.keyDown(window, { key: "g" });
    act(() => {
      vi.advanceTimersByTime(20);
    });
    fireEvent.keyDown(window, { key: "i" });
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(onCommit).toHaveBeenCalledWith("g i");
    vi.useRealTimers();
  });

  it("Escape cancels without committing", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    fireEvent.click(screen.getByText("start"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId("state").textContent).toBe("idle");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/shortcuts/useRecorder.test.tsx`
Expected: FAIL — cannot resolve `./useRecorder`.

- [ ] **Step 3: Implement the recorder**

`src/features/shortcuts/useRecorder.ts`:

```ts
import { useEffect, useRef, useState } from "react";
import { eventToStep } from "./bindings";

const MODIFIER_KEYS = new Set(["Control", "Meta", "Shift", "Alt"]);

export function useRecorder(onCommit: (binding: string) => void, timeoutMs = 800) {
  const [recording, setRecording] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const stepsRef = useRef<string[]>([]);
  const timerRef = useRef<number | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  function clearTimer() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function stop() {
    clearTimer();
    setRecording(false);
    stepsRef.current = [];
    setSteps([]);
  }

  useEffect(() => {
    if (!recording) return;
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        stop();
        return;
      }
      if (MODIFIER_KEYS.has(e.key)) return;
      const next = [...stepsRef.current, eventToStep(e)];
      stepsRef.current = next;
      setSteps(next);
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        const binding = stepsRef.current.join(" ");
        stop();
        if (binding) commitRef.current(binding);
      }, timeoutMs);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, timeoutMs]);

  return {
    recording,
    steps,
    start: () => {
      stepsRef.current = [];
      setSteps([]);
      setRecording(true);
    },
    cancel: stop,
  };
}
```

- [ ] **Step 4: Run recorder test to verify it passes**

Run: `npx vitest run src/features/shortcuts/useRecorder.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing test for the section**

`src/features/settings/ShortcutsSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const setProfile = vi.fn();
const setBinding = vi.fn();
const resetBinding = vi.fn();

vi.mock("../shortcuts/ShortcutsProvider", () => ({
  useShortcuts: () => ({
    profile: "default",
    resolved: {
      compose: "c",
      reply: "r",
      "command-palette": "Mod+k",
    },
    overrides: {},
    setProfile,
    setBinding,
    resetBinding,
  }),
}));

import { ShortcutsSection } from "./ShortcutsSection";

beforeEach(() => {
  setProfile.mockClear();
  setBinding.mockClear();
  resetBinding.mockClear();
});
afterEach(cleanup);

describe("ShortcutsSection", () => {
  it("offers the Default and Vim profiles", () => {
    render(<ShortcutsSection />);
    expect(screen.getByRole("button", { name: "Default" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Vim" })).toBeTruthy();
  });

  it("switching profile calls setProfile", () => {
    render(<ShortcutsSection />);
    fireEvent.click(screen.getByRole("button", { name: "Vim" }));
    expect(setProfile).toHaveBeenCalledWith("vim");
  });

  it("lists actions with their bindings", () => {
    render(<ShortcutsSection />);
    expect(screen.getByText("Compose")).toBeTruthy();
    expect(screen.getByText("Reply")).toBeTruthy();
  });

  it("reset calls resetBinding for the action", () => {
    render(<ShortcutsSection />);
    const composeRow = screen.getByText("Compose").closest(".shortcut-row")!;
    fireEvent.click(composeRow.querySelector("[aria-label='Reset Compose']")!);
    expect(resetBinding).toHaveBeenCalledWith("compose");
  });
});
```

- [ ] **Step 6: Run section test to verify it fails**

Run: `npx vitest run src/features/settings/ShortcutsSection.test.tsx`
Expected: FAIL — cannot resolve `./ShortcutsSection`.

- [ ] **Step 7: Implement the section**

`src/features/settings/ShortcutsSection.tsx`:

```tsx
import { useState } from "react";
import { useShortcuts } from "../shortcuts/ShortcutsProvider";
import { ACTIONS, type ActionId } from "../shortcuts/registry";
import { conflictFor, prettyBinding, type Profile } from "../shortcuts/bindings";
import { actionById } from "../shortcuts/registry";
import { useRecorder } from "../shortcuts/useRecorder";

const IS_MAC =
  typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");

const PROFILES: { value: Profile; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "vim", label: "Vim" },
];

function ShortcutRow({ id }: { id: ActionId }) {
  const { resolved, setBinding } = useShortcuts();
  const { resetBinding } = useShortcuts();
  const meta = actionById(id)!;
  const binding = resolved[id];
  const [pendingConflict, setPendingConflict] = useState<ActionId | null>(null);

  const recorder = useRecorder((captured) => {
    const conflict = conflictFor(captured, resolved, id);
    setPendingConflict(conflict);
    if (conflict) setBinding(conflict, null);
    setBinding(id, captured);
  });

  return (
    <div className={`shortcut-row${meta.enabled ? "" : " shortcut-row--disabled"}`}>
      <span className="shortcut-row__label">{meta.label}</span>
      <div className="shortcut-row__controls">
        {recorder.recording ? (
          <span className="shortcut-row__recording">
            {recorder.steps.length ? prettyBinding(recorder.steps.join(" "), IS_MAC) : "Press keys…"}
          </span>
        ) : binding ? (
          <kbd className="shortcut-row__kbd">{prettyBinding(binding, IS_MAC)}</kbd>
        ) : (
          <span className="shortcut-row__none">—</span>
        )}
        {meta.enabled && (
          <>
            <button
              type="button"
              className="shortcut-row__record"
              aria-label={`Record ${meta.label}`}
              onClick={() => {
                setPendingConflict(null);
                recorder.start();
              }}
            >
              {recorder.recording ? "Cancel" : "Record"}
            </button>
            <button
              type="button"
              className="shortcut-row__reset"
              aria-label={`Reset ${meta.label}`}
              onClick={() => {
                setPendingConflict(null);
                resetBinding(id);
              }}
            >
              Reset
            </button>
          </>
        )}
      </div>
      {pendingConflict && (
        <div className="shortcut-row__conflict" role="status">
          ⚠ Reassigned from {actionById(pendingConflict)?.label}
        </div>
      )}
    </div>
  );
}

export function ShortcutsSection() {
  const { profile, setProfile } = useShortcuts();

  return (
    <div className="shortcuts-section">
      <p className="shortcuts-section__intro">
        Choose a profile and customize key bindings. New bindings override conflicts.
      </p>
      <div className="appearance-field__label">Profile</div>
      <div className="theme-cards">
        {PROFILES.map((p) => (
          <button
            key={p.value}
            type="button"
            aria-pressed={profile === p.value}
            className={`theme-card${profile === p.value ? " theme-card--active" : ""}`}
            onClick={() => setProfile(p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="appearance-field__label">Shortcuts</div>
      <div className="shortcut-list">
        {ACTIONS.map((a) => (
          <ShortcutRow key={a.id} id={a.id} />
        ))}
      </div>
    </div>
  );
}
```

> The conflict UX: when a recorded binding collides, the loser is unbound (`setBinding(conflict, null)`) and the row shows which action was reassigned. Cancelling cancels the recorder; the "Cancel" label only shows while recording (the `start` button doubles as cancel — call `recorder.cancel()` when already recording). Wire that: change the Record button `onClick` to `() => { if (recorder.recording) { recorder.cancel(); } else { setPendingConflict(null); recorder.start(); } }`.

- [ ] **Step 8: Render the section in SettingsOverlay**

In `src/features/settings/SettingsOverlay.tsx`, import the section and render it for the `shortcuts` nav id. Add the import:

```tsx
import { ShortcutsSection } from "./ShortcutsSection";
```

Replace the content conditional:

```tsx
          {active === "appearance" ? (
            <AppearanceSection />
          ) : active === "shortcuts" ? (
            <ShortcutsSection />
          ) : (
            <div className="settings-placeholder">Coming soon</div>
          )}
```

- [ ] **Step 9: Append editor styles**

Append to `src/features/settings/Settings.css`:

```css
.shortcuts-section__intro {
  color: var(--text-preview, #9090a6);
  font-size: 13px;
  margin-bottom: 16px;
}
.shortcut-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.shortcut-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 8px 4px;
  border-bottom: 1px solid var(--rail-border, #eee);
  font-size: 14px;
}
.shortcut-row--disabled {
  opacity: 0.5;
}
.shortcut-row__controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
.shortcut-row__kbd {
  font-size: 12px;
  color: var(--text-count, #a0a0b4);
  background: var(--rail-item, #f1f1f8);
  border-radius: 5px;
  padding: 2px 7px;
}
.shortcut-row__recording {
  font-size: 12px;
  color: var(--accent, #4f46e5);
}
.shortcut-row__none {
  color: var(--text-preview, #9090a6);
}
.shortcut-row__record,
.shortcut-row__reset {
  border: 1px solid var(--rail-border, #e4e4ef);
  background: transparent;
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
  color: var(--text-subject, #2a2a40);
}
.shortcut-row__conflict {
  grid-column: 1 / -1;
  font-size: 12px;
  color: #b4690e;
}
```

- [ ] **Step 10: Run section test + full suite + build**

Run: `npx vitest run src/features/settings/ShortcutsSection.test.tsx`
Expected: PASS (4 tests).

Run: `npx vitest run`
Expected: PASS — entire suite green, no OOM.

Run: `npm run build`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add src/features/shortcuts/useRecorder.ts src/features/shortcuts/useRecorder.test.tsx \
  src/features/settings/ShortcutsSection.tsx src/features/settings/ShortcutsSection.test.tsx \
  src/features/settings/SettingsOverlay.tsx src/features/settings/Settings.css
git commit -m "feat(shortcuts): add shortcuts settings editor with profiles and conflict handling"
```

---

## Notes for the implementer

- The Etap 6a persistence pattern is the template for Tasks 5 & 8: store holds runtime state with pure setters; the provider/hook owns IPC. See `src/shared/appearance/AppearanceProvider.tsx`.
- `commands.getSettings()` returns `{ status: "ok", data: [string, string][] }`; `commands.setSetting(key, value)` returns `{ status: "ok", data: null }`. Both are already generated bindings — no new command.
- `SmartFolderKind` values are `"all_inboxes" | "unread" | "flagged"` (snake_case) — match exactly.
- `MessageFlag` is `"seen" | "flagged"`. mark-read = `setMessageFlags(id, "seen", true)`, mark-unread = `false`.
- Do NOT add lucide icons in pure modules. If a component needs an icon, register it in `src/test/lucide-stub.js` first.
```
