# Instant body prefetch on new mail — design

## Problem

Offline body prefetch (`spawn_prefetch` → `run_prefetch_batch`) downloads message
bodies for folders the user marked offline, so opening a mail is instant. The task
polls every `PREFETCH_IDLE_INTERVAL` (60 s) and is never woken by events. Two gaps
follow:

1. A freshly arrived mail in a selected folder has its header synced immediately
   (via IDLE) but its body waits up to ~60 s for the next prefetch cycle. Opening it
   in that window blocks on an on-demand fetch.
2. The idle task reconnects to IMAP every 60 s even when there is nothing to download
   (it connects and `SELECT`s each selected folder before discovering zero pending).

Goal: body of a new mail in a selected folder downloads within ~2 s of its header;
enabling offline for a folder starts downloading at once; manual refresh also pulls
bodies. Without changing the "only selected folders" model.

## Approach

Per-account `Notify` for the prefetch task, mirroring the existing `wakeups` /
`sync_now` pattern used to wake the main sync worker. Three triggers signal it.
Rejected: subscribing the prefetch task to `SyncEvent::NewMessages` (couples prefetch
to the UI event layer); shortening the poll interval (wastes IMAP connections, still
not instant).

## Design

### Engine (`crates/am-sync/src/engine.rs`)

- Add `prefetch_wakeups: Mutex<HashMap<i64, Arc<Notify>>>` to `SyncEngine`, mirroring
  `wakeups`.
- `spawn_account` creates a `prefetch_notify`, inserts it into `prefetch_wakeups`, and
  passes a clone both to `spawn_prefetch` and into the worker closure.
- `spawn_prefetch(account_id, token, notify)` gains a `_ = notify.notified() => {}` arm
  in its `select!`, so a signal breaks the sleep and runs `run_prefetch_batch`
  immediately.
- `stop_account` / `shutdown` also remove / clear `prefetch_wakeups`.
- New method `wake_prefetch(&self, account_id)` signals one account's prefetch notify;
  `sync_now()` additionally signals every prefetch notify.

### Trigger 1 — new mail (worker → prefetch)

- `service::incremental_sync_folder` return type changes from `Result<(), SyncError>`
  to `Result<i64, SyncError>` — the number of newly inserted headers. Returns the
  fetched count on the uidvalidity-reset path and `new_count` on the normal path.
- The worker loop, after each folder sync, accumulates the returned counts; if the sum
  for the pass is `> 0`, it calls `prefetch_notify.notify_one()`. A flag-only change
  returns `0`, so it does not wake the task.

### Trigger 2 — manual refresh

- `sync_now()` already iterates `wakeups`; it also iterates `prefetch_wakeups`.

### Trigger 3 — folder toggled to offline

- New Tauri command `wake_prefetch(account_id: i64)` (in `am-app` commands, registered
  in `collect_commands!`), calling `engine.wake_prefetch(account_id)`.
- Frontend: after the prefetch master toggle, the per-folder toggle, and the folder
  modal save write their settings, they call `wake_prefetch(accountId)`.

### Efficiency — cheap pre-check in `run_prefetch_batch`

Before connecting to IMAP, check (DB only) whether any selected folder has pending
work: `!get_backfill_complete(folder_id)` OR `count_without_body(folder_id) > 0`. If
none pending, return `Ok(false)` without opening a session. This makes spurious wakes
free and removes the current every-60-s idle reconnect.

## Testing

- Engine unit test (mirrors `spawn_then_stop_removes_worker...`): `spawn_account`
  registers a `prefetch_wakeups` entry; `wake_prefetch` / `sync_now` signal it without
  panic; `stop_account` / `shutdown` clear it.
- `run_prefetch_batch` pre-check: with prefetch enabled, a selected folder that is
  backfilled and has zero bodies-without-body returns `Ok(false)` and never constructs
  a session (assert via a credential source that panics if `auth_for` is called).
- Update the GreenMail integration test (`tests/sync_greenmail.rs`) and the two worker
  call sites for the new `incremental_sync_folder` return type; assert it returns the
  inserted-header count.

## Non-goals

- No change to which folders are prefetched (still user-selected).
- No new prefetch scheduling/priority between folders.
- `message_bodies.downloaded_at` stays unpopulated (separate cosmetic item).
