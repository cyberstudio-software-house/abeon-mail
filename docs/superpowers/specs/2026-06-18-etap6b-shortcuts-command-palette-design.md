# Etap 6b — Keyboard shortcuts + command palette (design)

> Sub-etap 6b of Etap 6 (UX power). Implements the full first-class shortcuts
> subsystem from the master spec §6.2: action registry ↔ configurable bindings
> ↔ three consumers (shortcuts, command palette, menu/cheat-sheet).

Master spec: `docs/superpowers/specs/2026-06-17-abeonmail-design.md` §6.2.
Visual source: `docs/templates/AbeonMail.html` (palette/cheat-sheet styled to the
existing design tokens — no template mockup exists for these screens).

## Goal

A single source of truth (action registry) drives the keyboard engine, the
`Mod+K` command palette, the `?` cheat sheet, and the Shortcuts settings editor.
Adding an action in one place makes it appear everywhere. Bindings are
configurable with conflict detection, persisted, and selectable between a
Gmail-style default profile and a Vim profile.

## Scope decisions

- Full §6.2 vision: configurable bindings + conflict detection + persistence +
  Vim profile + command palette + cheat sheet + Shortcuts settings editor.
- Command palette built on `cmdk` (new dependency).
- Persistence reuses the Etap 6a `settings(key, value)` table — zero Rust /
  migration changes.
- Full Gmail action set registered from day one; actions whose backend does not
  exist yet (archive/delete/search/snooze/label) are registered as disabled
  (`enabled: () => false`): greyed in palette/cheat-sheet, key reserved, no `run`.
- Conflict UX: warn + allow override (non-blocking).

This sub-etap is frontend-only. No Rust, no migration, no new Tauri command.

## Architecture

```
ACTIONS (registry — static metadata)
    │  id, label, group, context, defaultBinding, icon, enabled
    ├──→ resolveBindings(profile, overrides) ──→ effective binding map
    │
    ├──→ KeyboardEngine   (key listener, sequences, context, focus-guard)
    ├──→ CommandPalette   (cmdk: actions + folders + smart folders)
    ├──→ CheatSheet        (? — generated from registry)
    └──→ ShortcutsSection  (bindings editor in settings)
```

The registry holds **metadata only** — it does not import React Query or the
store, so it stays pure and unit-testable. Execution flows through a
`handlers: Record<ActionId, () => void>` map built inside `ShortcutsProvider`
from live hooks/store. Engine, palette and cheat-sheet consume metadata;
execution calls `handlers[id]`.

## Data model

### Action

```ts
type ActionContext = "global" | "list" | "reader" | "composer";

type Action = {
  id: ActionId;
  label: string;
  group: string;            // cheat-sheet / palette grouping
  context: ActionContext;
  defaultBinding: string;   // normalized binding string (see below)
  icon: LucideIcon;
  enabled: (ctx: ActionEnvironment) => boolean;
};
```

`ActionEnvironment` carries the live state an `enabled` predicate needs
(e.g. whether a thread is selected). Disabled placeholder actions use
`enabled: () => false`.

### Binding (normalized string)

- Chords: `"Mod+k"`, `"Shift+I"`, `"Ctrl+Enter"`.
- Sequences: space-separated steps, each step a key combo: `"g i"`, `"g s"`,
  `"g g"`.
- `Mod` = `Cmd` on macOS, `Ctrl` elsewhere (resolved at match time).
- Sequences are core (Gmail `gi`/`gs` need them), so the Vim profile does not
  add engine capability — only a different default table.

### Profiles

- `DEFAULT_BINDINGS` — Gmail-style (table below).
- `VIM_BINDINGS` — same engine; `j`/`k` retained, adds `g g` (first message) and
  `Shift+G` (last message); the rest shared with default.
- A profile is an alternative default table. The user override layer applies on
  top of whichever profile is active.

### Persistence (reuse Etap 6a settings)

- `shortcuts.profile` = `"default" | "vim"`.
- `shortcuts.overrides` = JSON `{ actionId: binding | null }` — only deviations
  from the profile default; `null` = deliberately unbound (orphaned by a
  conflict override).
- Resolution: `override ?? profileDefault ?? action.defaultBinding`.
- Whitelist/validate on load like Etap 6a `parseSettings` (unknown action ids
  and malformed bindings are dropped, not thrown).

## Keyboard engine

- Global listener (capture phase). Sequence buffer with ~800 ms timeout;
  `Escape` clears the buffer.
- **Context** derived from store: `composer.open` → `composer`;
  `selectedThreadId` (reader visible) → `reader`; otherwise `list`. `global` is
  always active. Match order: active context first, then `global`.
- **Focus-guard**: when focus is in `input` / `textarea` / `contenteditable`
  (TipTap, palette/settings fields), single-key shortcuts are suppressed; only
  modifier chords (`Mod+K`, `Mod+Enter`) and `Escape` pass through.
- **Action-context slice** (store): panes publish what handlers need —
  `visibleMessageIds: number[]` (from `MessageListPane`, for `j`/`k`) and
  `replyTargetId: number | null` (from `ConversationView`, for `r`/`a`/`f`/`s`).
  Handlers read from this slice; panes remain the source of their own data and
  the engine stays decoupled.

## Action set

| id | default binding | context | state |
|---|---|---|---|
| `command-palette` | `Mod+K` | global | enabled |
| `cheat-sheet` | `?` | global | enabled |
| `compose` | `c` | global | enabled |
| `go-inbox` | `g i` | global | enabled |
| `go-starred` | `g s` | global | enabled (smart Flagged) |
| `open-settings` | `g ,` | global | enabled |
| `next-message` | `j` | list/reader | enabled |
| `prev-message` | `k` | list/reader | enabled |
| `first-message` | (none / vim `g g`) | list/reader | enabled |
| `last-message` | (none / vim `Shift+G`) | list/reader | enabled |
| `toggle-flag` | `s` | reader | enabled |
| `mark-read` | `Shift+I` | reader | enabled |
| `mark-unread` | `Shift+U` | reader | enabled |
| `reply` | `r` | reader | enabled |
| `reply-all` | `a` | reader | enabled |
| `forward` | `f` | reader | enabled |
| `back-to-list` | `u` | reader | enabled |
| `send-message` | `Mod+Enter` | composer | enabled |
| `close-composer` | `Escape` | composer | enabled |
| `archive` | `e` | reader | disabled (future etap) |
| `delete` | `#` | reader | disabled (future etap) |
| `search` | `/` | global | disabled (6c) |
| `snooze` | `b` | reader | disabled (6e) |
| `label` | `l` | reader | disabled (6d) |

Two refinements made during planning (data/architecture-driven):

- `toggle-flag` / `mark-read` / `mark-unread` are **reader-context only**. They need
  a concrete `messageId`; a thread row in the list has no single message id,
  whereas the open conversation publishes its latest message as `replyTargetId`.
  List-context flagging is deferred.
- `open-message` (Enter) is **dropped**; `j`/`k` already move the selection, which
  opens the reader (Gmail-like navigate-and-open). In its place `first-message` /
  `last-message` are added — unbound in the Default profile, bound to `g g` /
  `Shift+G` in the Vim profile so that profile has real distinguishing actions.
- The four navigation actions (`next`/`prev`/`first`/`last-message`) are active in
  BOTH `list` and `reader` contexts. Because selecting a thread opens it in the
  reader (the reader is the active context while browsing), navigation must keep
  working there; otherwise `j`/`k` would die the moment a conversation opened.
  `getContext` is `composer` (if composer open) → `reader` (if `selectedThreadId`
  set) → `list`.

## Command palette (cmdk)

- `Mod+K` opens a modal. Sections: **Actions** (enabled only, binding shown
  trailing), **Folders** (from `listFolders` per account), **Smart folders**
  (All Inboxes / Unread / Flagged). cmdk handles fuzzy filtering, grouping and
  keyboard nav. `Enter` runs the handler / navigates; `Escape` closes. Styled
  with project CSS using `tokens.css`.

## Cheat sheet (`?`)

- `role=dialog` modal, grouped by context (Global / List / Reader / Composer),
  generated from the registry + currently resolved bindings (always fresh;
  disabled actions greyed). Esc / ✕ closes.

## Shortcuts settings section

- Profile selector (Default / Vim).
- Action list grouped: label + current binding + "Record" (captures the next
  chord/sequence) + reset-to-default.
- **Conflict: warn + allow override** — inline "⚠ conflict with <action>"; on
  save the new binding wins and the other action gets `null` (no shortcut).
  Conflict detection also covers sequence prefixes (`g` vs `g i`).
- Persists via `setSetting` (debounced); hydration like `useAppearance`.

## File structure

- `src/features/shortcuts/registry.ts` — `ActionId`, `Action`, `ACTIONS`, groups.
- `src/features/shortcuts/bindings.ts` — binding normalization, `DEFAULT_BINDINGS`,
  `VIM_BINDINGS`, `resolveBindings`, conflict detection (incl. sequence prefix).
- `src/features/shortcuts/useKeyboardEngine.ts` — global listener, sequence
  buffer/timeout, context detection, focus-guard, dispatch.
- `src/features/shortcuts/ShortcutsProvider.tsx` — loads profile + overrides from
  settings (mirrors `useAppearance`), builds the handler map, mounts the engine,
  exposes the `useShortcuts()` context (resolved bindings + persisting setters),
  renders the palette + cheat sheet.
- `src/features/shortcuts/useRecorder.ts` — captures a chord/sequence for the
  settings editor (same buffer/timeout model as the engine).
- `src/features/shortcuts/CommandPalette.tsx` + `CommandPalette.css`.
- `src/features/shortcuts/CheatSheet.tsx` + `CheatSheet.css`.
- `src/features/settings/ShortcutsSection.tsx` — bindings editor.
- `src/app/store.ts` — add action-context slice (`visibleMessageIds`,
  `selectMode`, `replyTargetId`, `composerSend`), palette/cheat-sheet open flags,
  shortcut profile + overrides runtime state (pure setters; persistence in
  `ShortcutsProvider`).
- `src/test/lucide-stub.js` — add every new lucide icon used (else vitest OOM).

## Testing

- Unit: binding normalization; `resolveBindings`; conflict detection (incl.
  sequence prefix `g` vs `g i`); sequence engine (buffer / timeout / reset);
  focus-guard; context derivation from store.
- Component: palette filtering and section composition; cheat-sheet generation
  from registry; conflict warning in the editor.
- Infra: `cmdk` dependency added; new lucide icons added to `lucide-stub.js`.

## Implementation plan staging

1. Action registry + binding model + profiles (pure TS, tests).
2. `resolveBindings` + conflict detection (tests).
3. Keyboard engine (sequences, context, focus-guard) + action-context store slice.
4. `ShortcutsProvider` + handler map + pane wiring (`visibleMessageIds`,
   `replyTargetId`).
5. Command palette (cmdk).
6. Cheat sheet (`?`).
7. Shortcuts settings section (editor + conflicts + profile + persistence).
8. Fidelity / a11y check; verify cheat sheet is generated end-to-end from the
   registry.

## Deferred (out of 6b)

- Real `run` for archive/delete/search/snooze/label — wired in their own etaps
  (6c search, 6d labels, 6e snooze; archive/delete when those backends land).
- Per-window / compose-in-separate-window shortcuts (Etap 7 scope).
