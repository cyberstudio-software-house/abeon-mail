# Mark as read — timing setting + manual control

Date: 2026-06-20
Status: design approved, ready for implementation plan

## Problem

There is no Settings option controlling *when* a message is marked as read, and
no discoverable manual way to mark a conversation read/unread. Today the only
mechanism is an implicit auto-mark in `MessageBodyView` that fires on body render
for the **last** message of a thread only (`shouldMarkSeen={m.id === last.id}`),
plus the `Shift+I` / `Shift+U` shortcuts (reader context, last message only).
Result: messages a user actually reads (older ones expanded in a thread) stay
"unread", and there is no visible control.

## Decisions (locked with the user)

- **Configurable timing mode**: `immediate` / `delay` (after N seconds of viewing) / `never` (manual only).
- **Auto-mark scope**: whole conversation on open (all messages in the thread, not just the last).
- **Manual control surfaces**: reader toolbar button **and** list multi-select toolbar; existing `Shift+I` / `Shift+U` shortcuts kept and aligned to the new whole-conversation semantics.
- **Default mode**: `immediate` (preserves current de-facto behavior).
- **No new nav section**: the setting lives inside the existing **General** section.
- **Frontend-only**: built on the V6 `settings` key/value store and the existing `set_message_flags(id, "seen", bool)` command (which already queues the IMAP flag). Zero migration, zero Rust changes, zero bindings regeneration.

## Architecture

### Data layer — extend the General domain

Reuse the Etap 7c General pattern (`shared/general/general.ts` + General store slice + `GeneralProvider`). Add two keys under the `general.*` namespace:

- `general.markReadMode` → `"immediate" | "delay" | "never"`, default `"immediate"`.
- `general.markReadDelaySeconds` → integer `1..=60`, default `2`.

Changes:
- `shared/general/general.ts`: extend `MarkReadMode` type, `GENERAL_KEYS`, `DEFAULT_GENERAL`, and `parseGeneralSettings` (whitelist mode value; clamp/validate delay to an int in 1–60, fall back to default on junk).
- `store.ts` General slice: add `markReadMode`, `markReadDelaySeconds` + setters; extend `hydrateGeneral` with **explicit per-field mapping** (key → store field) — not `set(partial)` — per the snooze hydration bug lesson from 7c.
- `GeneralProvider.tsx`: already calls `hydrateGeneral` after `getSettings`; map the two new keys there.

*Rejected alternative*: dedicated `ReadingProvider` + new "Reading" nav entry. Rejected as YAGNI — two controls do not warrant a new top-level section; General is the natural home for behavioral prefs (it already holds time format + default account).

### Reader behavior — lift auto-mark into ConversationView

Move auto-mark logic out of `MessageBodyView` (per-message, tied to body render) into `ConversationView` (knows the whole thread).

- `MessageBodyView.tsx`: remove the `shouldMarkSeen` prop and its `useMarkSeen` effect — component becomes purely presentational.
- `ConversationView.tsx`: new effect keyed on `threadId` with a **ref guard "once per thread open"**:
  - read `markReadMode` / `markReadDelaySeconds` from the store (reactive selectors);
  - `never` → do nothing;
  - `immediate` → after messages load, mark all **unread** messages (`messages.filter(m => !m.seen)`) as seen;
  - `delay` → `setTimeout(delay * 1000)`; clear the timer on thread change / unmount so a brief open does not mark;
  - the guard ensures the effect runs **once per thread open**, so a manual "mark unread" on the open thread is not immediately re-marked read (classic re-mark bug).

### Manual control — reader + list + shortcuts

- **Reader toolbar** (`ConversationView`): one toggle button. If the thread has any unread message → action "Mark as read" (icon `MailOpen`); else → "Mark as unread" (icon `Mail`). Operates on the whole conversation. `aria-label` reflects the current action.
- **List multi-select toolbar** (`MessageListPane`): two buttons "Mark read" / "Mark unread" (mirroring the Snooze/Unsnooze pattern), operating on `selectedMessageIds` (flat-mode selection, consistent with existing multi-select scope).
- **Shortcuts** (`ShortcutsProvider`): update the `setSeen(value)` handler (bound to `mark-read` = `Shift+I`, `mark-unread` = `Shift+U`) to act on the **whole open conversation** by reading the `["thread-messages", selectedThreadId]` react-query cache (precedent: the existing `toggle-flag` handler reads that cache).
- **Shared mutation** `useSetSeen({ ids, value })` in `queries.ts`: loops `setMessageFlags(id, "seen", value)` over `ids`, then a single `onSuccess` invalidating `messages` / `folders` / `threads` / `thread-messages` / `smart` and calling `refreshUnreadBadge`. Reused by reader, list, and shortcuts. (Server-side batched seen command deferred — N is small per thread/selection.)

### Settings UI

`GeneralSection.tsx` gains a **Reading** group:
- "Mark messages as read" — three theme-card buttons (reuse the time-format card styling from 7c): *Immediately* / *After a delay* / *Never*.
- When *After a delay* is selected, show a number input "seconds" (1–60) bound to `markReadDelaySeconds`.

No new CSS (reuse `appearance-section` / `theme-card` classes, as 7c did).

## Files touched

Edit only (no new source files; the reading data stays in `general.ts`):
- `src/shared/general/general.ts`
- `src/app/store.ts`
- `src/shared/general/GeneralProvider.tsx`
- `src/features/settings/GeneralSection.tsx`
- `src/features/reader/ConversationView.tsx`
- `src/features/reader/MessageBodyView.tsx`
- `src/features/shortcuts/ShortcutsProvider.tsx`
- `src/features/message-list/MessageListPane.tsx`
- `src/ipc/queries.ts`
- `src/test/lucide-stub.js` (add `Mail`, `MailOpen`)

## Testing

- `general.ts` parse/defaults: valid modes, junk → default, delay clamping/validation.
- Store `hydrateGeneral`: explicit-mapping assertions (fails under a `set(partial)` regression), mirroring `store.test.ts` from 7c.
- `ConversationView`:
  - `immediate` marks all unread messages once on open;
  - `never` marks nothing;
  - `delay` uses fake timers — marks after the delay, does not mark if unmounted before;
  - guard: a manual "mark unread" after auto-mark is not re-marked read.
- `MessageListPane`: multi-select "Mark read" / "Mark unread" call `useSetSeen` with the selected ids and the right value.
- Mock hygiene: extend the `UiState` literal in `MessageListPane.test` and the store mock in `AppShell.test` with the two new General fields (the recurring latent-build-breaker — vitest stays green, only `tsc`/`npm run build` catches it).
- `lucide-stub.js`: add `Mail`, `MailOpen` (tests OOM otherwise).

## Out of scope / deferred

- Server-side batched `set_messages_seen(ids, value)` command (client loop is fine at thread/selection scale).
- Per-account read settings.
- "Mark read on scroll past" / preview-pane semantics (no preview pane in this app).
- Marking read on list selection without opening the reader.

## Notes

- The working tree already carries unrelated uncommitted changes (`AccountsSection`, `V11__attachments_content.sql`, `AttachmentsBar`, etc.). This feature is independent and builds on the current working-tree versions of `ConversationView.tsx` / `MessageBodyView.tsx`.
