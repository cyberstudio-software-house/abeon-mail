# Smart Folders Visibility — Design & Implementation Spec

Date: 2026-06-22
Status: Approved (design)

## Goal

Let the user choose which smart folders appear in the sidebar rail, with a master
"show all / hide all" switch. Default behavior is unchanged: every smart folder visible.

Smart folders are a frontend-only construct (`SMART_FOLDERS` in `MailboxRail.tsx`,
type `SmartFolderKind` in `ipc/bindings.ts`). There are four:
`all_inboxes`, `unread`, `flagged`, `snoozed`.

## Decisions

- Location in Settings: **Appearance** section (next to the existing sidebar/list
  toggles: preview text, sender avatars).
- "Disable all" mechanism: a **master toggle** ("Show smart folders") plus four
  per-folder toggles. When the master is off, the per-folder toggles are disabled
  (greyed) and the whole rail section (including its header) is hidden.
- Out of scope (YAGNI): reordering (drag-and-drop), Rust/DB schema changes,
  filtering the Command Palette / keyboard shortcuts. Hidden smart folders remain
  reachable via shortcuts and the palette — only the rail render is suppressed.

## Data model

Two new settings under the existing `appearance.` namespace, persisted via the
generic key-value store (`set_setting` / `get_settings`) — no migration:

- `appearance.smartFoldersEnabled` → `"true"` / `"false"`. Default `true`.
- `appearance.smartFolderVisibility` → JSON object `Record<SmartFolderKind, boolean>`,
  e.g. `{"all_inboxes":true,"unread":true,"flagged":false,"snoozed":true}`.
  Default: all `true`. One JSON key for the whole map, mirroring the existing
  `shortcuts.overrides` pattern.

Edge case: master on but all four unchecked → rail section hidden (consistent with
"hide all").

## Shared source of truth

New module `src/shared/smartFolders.ts` — the single ordered list of smart folder
kinds + labels, plus the visibility type and its default. Both the rail and the
settings UI import from here so they never drift.

```ts
import type { SmartFolderKind } from "../ipc/bindings";

export const SMART_FOLDER_META: { kind: SmartFolderKind; label: string }[] = [
  { kind: "all_inboxes", label: "All Inboxes" },
  { kind: "unread", label: "Unread" },
  { kind: "flagged", label: "Flagged" },
  { kind: "snoozed", label: "Snoozed" },
];

export type SmartFolderVisibility = Record<SmartFolderKind, boolean>;

export const DEFAULT_SMART_FOLDER_VISIBILITY: SmartFolderVisibility = {
  all_inboxes: true,
  unread: true,
  flagged: true,
  snoozed: true,
};
```

Icons stay in `MailboxRail.tsx` (a `kind → lucide icon` map), since they are a
render concern of the rail, not shared metadata.

## Implementation plan (file by file)

1. **`src/shared/smartFolders.ts`** (new) — as above.

2. **`src/shared/appearance/appearance.ts`**
   - `AppearanceFields`: add `smartFoldersEnabled: boolean` and
     `smartFolderVisibility: SmartFolderVisibility`.
   - `SETTINGS_KEYS`: add `smartFoldersEnabled` and `smartFolderVisibility`.
   - `DEFAULT_APPEARANCE`: `smartFoldersEnabled: true`,
     `smartFolderVisibility: { ...DEFAULT_SMART_FOLDER_VISIBILITY }`.
   - `parseSettings`: handle the boolean key; for the map key, `JSON.parse` defensively
     (try/catch), start from a copy of the default map and overwrite only known kinds
     whose value is a boolean. Malformed JSON → fall back to default map.

3. **`src/app/store.ts`**
   - `UiState`: add `smartFoldersEnabled: boolean`,
     `smartFolderVisibility: SmartFolderVisibility`, plus
     `setSmartFoldersEnabled(value: boolean)` and
     `setSmartFolderVisible(kind: SmartFolderKind, visible: boolean)`.
   - Initial values from `DEFAULT_APPEARANCE`.
   - `setSmartFolderVisible` updates the map immutably:
     `set((s) => ({ smartFolderVisibility: { ...s.smartFolderVisibility, [kind]: visible } }))`.
   - `hydrateAppearance` already does `set(partial)`, so the parsed full map hydrates as-is.

4. **`src/shared/appearance/AppearanceProvider.tsx`**
   - Read the two new store fields + setters.
   - Context value: `setSmartFoldersEnabled(v)` → store + `persist(key, String(v))`.
     `setSmartFolderVisible(kind, v)` → compute `next = { ...smartFolderVisibility, [kind]: v }`,
     call store setter, `persist(visibilityKey, JSON.stringify(next))`.
   - Add both to the context type and the `useMemo` dependency array.

5. **`src/features/settings/AppearanceSection.tsx`**
   - Extend the local `Toggle` with an optional `disabled` prop (greys it via a
     modifier class, no-ops `onChange`, sets `aria-disabled`).
   - New "Smart folders" group: a master `Toggle` ("Show smart folders") then one
     `Toggle` per `SMART_FOLDER_META` entry, each `disabled={!a.smartFoldersEnabled}`,
     `checked={a.smartFolderVisibility[kind]}`,
     `onChange={(v) => a.setSmartFolderVisible(kind, v)}`.

6. **`src/features/mailbox/MailboxRail.tsx`**
   - Remove the local `SMART_FOLDERS` array; add a `kind → icon` map.
   - Read `smartFoldersEnabled` and `smartFolderVisibility` from the store.
   - `const visibleSmartFolders = SMART_FOLDER_META.filter((m) => smartFolderVisibility[m.kind]);`
   - Render the "Smart Folders" header + items only when
     `smartFoldersEnabled && visibleSmartFolders.length > 0`.

7. **CSS** — add a `.appearance-toggle--disabled` rule (reduced opacity,
   `pointer-events: none` on the switch) in the stylesheet that defines
   `.appearance-toggle` (locate during implementation).

## Verification

- Type check / build passes (`npm run build` or project's check).
- Manual: toggling each per-folder switch shows/hides that item in the rail; master
  off hides the whole section and disables the per-folder switches; settings persist
  across app reload; default install shows all four.
