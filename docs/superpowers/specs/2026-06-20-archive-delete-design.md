# Archive & Delete (server-synced) — Design

**Date:** 2026-06-20
**Status:** Approved design, pending implementation plan
**Fills deferred debt:** Etap 6b "real run for archive/delete (no backend)".

## Problem

The `e` keyboard shortcut ("Archive") does nothing. Investigation showed archive
was never implemented — it is an intentional placeholder:

- `registry.ts`: `archive` and `delete` actions have `enabled: false`; the keyboard
  engine skips disabled actions (`useKeyboardEngine.ts` `if (!a.enabled ...) continue`).
- `ShortcutsProvider.tsx`: no `archive`/`delete` entry in the `handlers` map.
- Backend: no IMAP MOVE/COPY operation and no Tauri command to move a message.

This is not a regression; the feature must be built end-to-end.

## Goals

- `e` archives and `#` deletes, **synced to the server** (the message leaves the
  Inbox on the server and appears in Archive/Trash on every device).
- Works from the **reader** (whole conversation) and from the **list** (multi-select
  in flat smart/label/search modes, and the selected thread in folder view).
- **Auto-create** the Archive/Trash folder on the server when the account lacks one.
- **Undo bar** after the action.

## Non-goals (deferred)

- Server-side undo after the move has executed (undo only reverses a still-pending op).
- Advance-to-next-message navigation after archiving (returns to list for MVP).
- IMAP keyword / Gmail-label archive nuances beyond folder MOVE.
- Precise `UID EXPUNGE` (the COPY fallback expunges all `\Deleted`, same known debt as
  `delete_uid`).

## Approach

Extend the existing operation queue (`sync_queue`) with a new op type
`move_message`, mirroring how flags work (`set_flag`):

1. The command optimistically **hides** the message locally (`deleted = 1`) and
   enqueues a `move_message` op.
2. The op is scheduled to run after a short **undo grace period**
   (`UNDO_GRACE_SECS`, ~8s) via `next_retry_at`, so Undo never has to reverse a
   server move.
3. The engine drains the queue on its poll cadence; the new branch performs the
   server MOVE with retry/backoff (same as flags).

Rejected alternatives:
- **Synchronous MOVE in the command** — blocks the UI, no offline/retry, inconsistent
  with the flag path.
- **Separate `drain_moves` loop** — duplicates the connect/select boilerplate that
  `drain_queue` already owns.

### Why optimistic `deleted = 1` (not a local folder move)

A message's `uid` is server-assigned **per folder**; we do not know its uid in the
Archive folder until that folder syncs. So locally we only hide the source row.
`insert_headers` uses `INSERT OR IGNORE`, so a racing Inbox sync cannot un-hide the
row (it already exists), and incremental flag sync never touches the `deleted`
column. The moved copy appears when the Archive/Trash folder next syncs.

**The `deleted` filter is not uniform — three list queries must be fixed first.**
`smart_repo` (all smart folders), `labels_repo::list_messages_by_label`, and
`search_repo` already exclude `deleted = 0`. But the folder/reader path does **not**:
- `threads_repo::list_for_folder` — its thread-inclusion subquery filters `draft = 0`
  and snooze, but **not** `deleted`, so an all-archived thread would still appear in
  the folder list. (CRITICAL — this is the folder-view hide.)
- `messages_repo::list_by_folder` — no `deleted` filter.
- `messages_repo::list_by_thread` — no `deleted` filter (reader body list).

Adding `AND deleted = 0` to these three is a prerequisite task. Flat-mode multi-select
(smart/label/search) already hides correctly; folder/reader archive operates on whole
threads, so the `list_for_folder` fix is what makes the archived thread vanish.

### Gmail

Folder discovery already maps `[Gmail]/All Mail` → `FolderType::Archive`. A MOVE
INBOX → All Mail is, for Gmail, exactly "remove the INBOX label" = archive. Delete →
`FolderType::Trash` = `[Gmail]/Trash`. No Gmail-specific code path; the auto-create
branch never triggers for Gmail (both folders always exist).

## Components

### 1. `am-protocols` (`imap.rs`)

```
pub async fn move_uid(&mut self, src_folder: &str, uid: i64, dst_folder: &str)
    -> Result<(), ProtocolError>
```
- SELECT `src_folder`.
- Prefer `UID MOVE` (RFC 6851) when the server advertises the `MOVE` capability.
- Fallback: `uid_copy(uid, dst)` → `uid_store(uid, "+FLAGS (\\Deleted)")` → `expunge`
  (the pattern already used by `delete_uid`).

```
pub async fn create_folder(&mut self, name: &str) -> Result<(), ProtocolError>
```
- Thin wrapper over async-imap `create`, used by the auto-create branch.

### 2. `am-storage`

- `folders_repo::find_by_type(db, account_id, FolderType) -> Result<Option<Folder>>`
  — resolve the Archive/Trash target.
- `messages_repo::set_deleted(db, message_id, value: bool) -> Result<()>` — soft
  hide/un-hide (callers also `recount_unread` + `threads_repo::recompute`).
- `queue_repo::enqueue_at(db, account_id, op_type, payload, next_retry_at)` — enqueue
  a `pending` op whose first attempt is delayed (sets `next_retry_at`); reuses the
  existing column already honored by `list_due`.
- `queue_repo::list_pending_moves(db, account_id) -> Result<Vec<QueuedOp>>` (or reuse
  a generic pending lister) — used by Undo to find and delete still-pending ops.

### 3. `am-sync` (`service.rs`)

```
pub enum MoveTarget { Archive, Trash }

pub fn enqueue_move(db, message_id, target: MoveTarget, now) -> Result<(), SyncError>
```
- `locate` the message; optimistic `set_deleted(true)` + `recount_unread` +
  `threads_repo::recompute`.
- `queue_repo::enqueue_at(account_id, "move_message", payload, now + UNDO_GRACE_SECS)`.
- Payload: `{ message_id, folder_id, uid, uidvalidity, target_type }`.

```
pub fn undo_move(db, message_ids: &[i64]) -> Result<(), SyncError>
```
- For each still-pending `move_message` op matching a message_id: `queue_repo::mark_done`
  (delete the op) + `set_deleted(false)` + recount/recompute. No-op for ops already
  drained (the undo bar is gone by then).

`drain_queue` — add a branch for `op_type == "move_message"` inside the existing
loop (shares the one IMAP session):
- Parse payload; validate source folder `uidvalidity` (drop the op on mismatch, like
  flags).
- Resolve the target: `find_by_type(account, target_type)`; if `None`,
  `create_folder("Archive" | "Trash")` then `upsert_folder` locally with that
  `folder_type`, and use the new `remote_path`.
- `move_uid(src.remote_path, uid, dst.remote_path)` → `mark_done` on success;
  `mark_retry` with the existing backoff, `mark_done` after `MAX_QUEUE_ATTEMPTS`.

### 4. `am-app`

- `archive_messages(message_ids: Vec<i64>) -> Result<(), String>`
- `delete_messages(message_ids: Vec<i64>) -> Result<(), String>`
- `undo_move(message_ids: Vec<i64>) -> Result<(), String>`

Each command computes `now` via `am_sync::service::now_secs()`, groups ids by account
through `messages_repo::locate`, and calls the matching `enqueue_move` / `undo_move`.
Regenerate `bindings.ts`.

### 5. Frontend (`src/`)

- `registry.ts`: `archive` → `enabled: true`, `contexts: ["reader", "list"]`;
  `delete` → `enabled: true`, `contexts: ["reader", "list"]`. CheatSheet/CommandPalette
  pick these up automatically.
- `queries.ts`: `useArchive()`, `useDelete()`, `useUndoMove()` — invalidate
  threads / messages / smart folders / folder list (counts).
- `ShortcutsProvider.tsx`: `archive`/`delete` handlers in the `snooze` style —
  - if `selectionActive && selectedMessageIds.length > 0` → those ids;
  - else if `selectedThreadId != null` → **all** message ids of the thread (from RQ
    cache `["thread-messages", selectedThreadId]`, as `setSeen` does);
  - after the action: in reader `setSelectedThreadId(null)`, in list `clearSelection()`;
    then show the undo bar.
- Undo bar: store slice `undoToast { kind, messageIds, expiresAt } | null` +
  setter/clear; a global `UndoBar` component (mounted in `ShortcutsProvider` next to
  the pickers) shows "Archived — Undo" / "Deleted — Undo", auto-dismisses after the
  grace window, and calls `useUndoMove()` on click.
- `ConversationView.tsx`: the Archive/Delete buttons in the action bar stop being
  `aria-disabled` and call the same handlers.

## Data flow

```
e / # / button
  → command archive_messages / delete_messages
    → enqueue_move (per message): set_deleted(1) + enqueue op at now+GRACE
  → UI: row vanishes, undo bar appears
  ... GRACE elapses (or Undo clicked) ...
  Undo:  undo_move → delete pending op + set_deleted(0)  → row returns
  No undo: engine drain → resolve/create target → move_uid → server moved
           → later Inbox sync expunges source row; Archive/Trash sync inserts copy
```

## Error handling

- Missing target folder → auto-create at drain (`IMAP CREATE` + local `upsert_folder`),
  named `Archive` / `Trash`.
- MOVE failure → retry with backoff; after `MAX_QUEUE_ATTEMPTS` the op is dropped and
  the message stays hidden (accepted MVP trade-off, matches the flag path).
- COPY fallback `expunge` removes all `\Deleted` messages in the source folder (known
  `delete_uid` debt, same here).
- Undo after the grace window → no pending op to cancel; the message is already moving
  server-side (undo bar is already gone).

## Testing

- Rust unit: `find_by_type`; `set_deleted` (hide + recount); `enqueue_move` (optimistic
  hide + delayed queue entry with correct `next_retry_at`); `undo_move` (deletes pending
  op + un-hides); `drain_queue` move branch payload parsing + target resolution.
- GreenMail integration: archive a message → gone from INBOX, present in Archive;
  delete → present in Trash; auto-create path when the folder is absent.
- Frontend (vitest): `archive` handler archives the whole thread in reader and the
  selection in list; registry/CheatSheet show the actions enabled; undo bar appears and
  `useUndoMove` is called on click.

## Constants

- `UNDO_GRACE_SECS` (am-sync, the delay applied to `next_retry_at`) and the
  frontend undo-bar timeout must agree (~8s). The Rust constant is the source of
  truth; the frontend keeps a matching `UNDO_TIMEOUT_MS`. This document records the
  relationship so the two stay aligned.
