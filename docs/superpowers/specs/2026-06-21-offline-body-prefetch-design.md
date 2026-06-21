# Offline Body Prefetch (per-account, per-folder) — Design

**Date:** 2026-06-21
**Status:** Approved design, pending implementation plan
**Branch context:** built on `feat/folder-actions` (folder context menu already exists).

## Problem

Message bodies are fetched **lazily** today: `service::get_or_fetch_body` runs only
when the user opens a message (`getMessageBody` command). Until then, only headers
are stored locally. Consequences:

- Reading a message offline that was never opened online is impossible.
- The project's stated tenet is **offline-first — "SQLite is the source of truth"** —
  but bodies are not part of that local source of truth until manually opened.

We want an **opt-in, per-account** capability to download message bodies in the
background, with **per-folder** selection of what to download. Headers keep arriving
first (as today); bodies fill in afterward, in the background.

## Goals

- A **per-account master toggle** ("download bodies for offline") — the per-account
  option the user asked for.
- **Per-folder selection** — the user explicitly picks which folders get prefetched
  (checkbox per folder), via the folder **context menu** (per-folder) plus a master
  toggle and folder list in **Settings → Accounts**.
- **Full offline archive** for selected folders: download bodies for **every** message
  on the server in that folder — including messages **older** than the current
  `INITIAL_SYNC_LIMIT` (200), which requires backfilling older **headers** too.
- Runs **asynchronously in the background**: headers first (unchanged), bodies after.
- **Resumable** across app restarts; **paced** so it never starves the foreground or
  hammers the server.
- A **lightweight progress indicator** (e.g. "Downloading bodies: 1200 / 5000"),
  driven by a backend progress event.

## Non-goals (deferred)

- **Attachment blobs.** Prefetch stores message **text** (`text_html` / `text_plain`)
  and attachment **metadata** only. Attachment files stay on-demand (today's behavior).
- **Pause / resume controls** per account (only a progress indicator; no user stop button).
- Configurable depth limits ("last N days / N messages") — scope is **full archive**.
- Server-side state; this is a local cache decision only.
- Prefetch for smart folders / labels / search (those are views over real folders).

## Locked decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Folder selection granularity | **Checkbox per folder** |
| Prefetch scope | **Full offline archive** (incl. older-header backfill) |
| Content scope | **Text bodies only** (HTML + plain); attachments on-demand |
| Progress UX | **Lightweight progress indicator** (no pause/resume) |
| UI placement | **Folder context menu** (per-folder) **+ master in Settings → Accounts** |

## Approach

### Two-phase background prefetch, in a dedicated per-account task

`spawn_account` already starts one sync task per account in `engine.rs`. We add a
**second task per account** — `spawn_prefetch(account_id, token)` — sharing the same
`CancellationToken` (so `stop_account` / `shutdown` cancel both). It owns its **own
IMAP connection**, independent of the sync loop.

Why a separate task and not a step in the sync loop: the sync loop blocks on
`idle_inbox` for up to `IDLE_TIMEOUT` (1500 s). A prefetch step inside it would drain
the archive at roughly one batch per poll/IDLE cycle. A dedicated task drains
continuously with its own pacing.

The prefetch task loop, per cycle:

1. Read the account **master toggle** from `settings` key `prefetch.bodies.<account_id>`.
   If off → sleep `PREFETCH_IDLE_INTERVAL` and re-check.
2. Read `settings` key `prefetch.folders.<account_id>` → JSON array of selected folder ids.
3. For each selected folder still present locally, run **one bounded batch** of work:
   - **Phase A — header backfill.** If `folders.backfill_complete = 0`:
     `search_all_uids` (server) − `list_uids` (local) = missing UIDs. Fetch headers
     for up to `BACKFILL_BATCH` of them via `fetch_headers_by_uids`, `insert_headers`,
     `assign_threads`. When no missing UIDs remain → `set_backfill_complete(folder, true)`.
   - **Phase B — bodies.** `uids_without_body(folder, BODY_BATCH)` → select the folder
     once, `fetch_bodies(uids)` in **one held session**, then for each: parse, store
     body, set `body_state = 'downloaded'`, backfill snippet/has-attachments, replace
     attachment metadata, store recipients, reindex FTS.
4. Emit `PrefetchProgress { account_id, done, total }`.
5. If a cycle did real work → short pace pause (`PREFETCH_WORK_PAUSE`) and loop again.
   If nothing was due across all folders → sleep `PREFETCH_IDLE_INTERVAL`.

**Resumability is free**: all state lives in the DB (`messages.body_state`,
`folders.backfill_complete`). A restart resumes exactly where it stopped.

### Reusing existing primitives

- Header backfill needs **no new protocol method**: `search_all_uids` and
  `fetch_headers_by_uids` already exist.
- Body persistence reuses the exact store sequence already in `fetch_and_store_body`
  (parse → `store_body` → `backfill_body_meta` → `attachments_repo::replace_for_message`
  → `store_recipients` → `search_repo::reindex_message`). This is extracted into a
  shared `persist_body(db, message_id, raw)` helper so lazy-fetch and prefetch share
  one code path (and both start setting `body_state`).

## Data model

### Storage decision (revised during planning)

The user-facing selection — the **master toggle** and the **per-folder list** — lives
in the existing global `settings(key, value)` table under **per-account keys**, the
pattern this branch already uses for `images.autoload.<account_id>` and for pinned
folders (`pinned.<account_id>` → JSON folder-id array). This was chosen over an
`accounts.settings` JSON merge or a new `folders` column because:

- `accounts.settings` JSON is **already occupied by the IMAP/SMTP `Endpoints`**
  (`service::add_account` / `update_account` serialize `Endpoints` into it, and
  `load_endpoints` deserializes it) — writing prefetch keys there risks clobbering
  endpoints.
- The `settings`-table-with-per-account-key pattern is established and read/written via
  the **existing** `getSettings` / `setSetting` commands — so **no new Tauri command**
  is needed, and the core `Folder` type is untouched.

Keys:
- `prefetch.bodies.<account_id>` → `"true"` / `"false"` — master toggle (mirrors
  `images.autoload.<account_id>`).
- `prefetch.folders.<account_id>` → JSON array of folder ids, e.g. `"[3,7]"` (mirrors
  pinned-folders storage).

### Migration `V13__prefetch.sql` (backend bookkeeping only)

```sql
ALTER TABLE folders ADD COLUMN backfill_complete INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_messages_body_state ON messages(folder_id, body_state);
```

- `backfill_complete` — header-backfill cursor (avoid re-running `UID SEARCH ALL` +
  full diff every cycle once a folder is fully backfilled). This is **sync bookkeeping**
  like `uidnext`, not a user preference, so it belongs on the row, not in `settings`.
  Reset to 0 on a uidvalidity resync (the folder was wiped and re-fetched, so older
  headers may be missing again).
- `idx_messages_body_state` — makes `uids_without_body` cheap inside the loop.

No `accounts` and no core `Folder` schema/type change.

### Repos

- **`folders_repo`**: `set_backfill_complete(folder_id, bool)`,
  `get_backfill_complete(folder_id) -> bool` (backend-only; **not** added to the `Folder`
  row mapping or core type).
- **`messages_repo`**: `uids_without_body(folder_id, limit) -> Vec<(message_id, uid)>`
  (`WHERE body_state = 'none'`), `count_without_body(folder_id) -> i64`.
  `store_body` now also sets `body_state = 'downloaded'` in the same statement.
- **`settings_repo`**: reused as-is (`get_setting` / `set_setting`); am-sync reads the
  two prefetch keys via `am_storage::settings_repo::get_setting`.

## Backend

### am-protocols

New `ImapSession::fetch_bodies(uids: &[i64]) -> Result<Vec<(i64, Vec<u8>)>, ProtocolError>`
— one `UID FETCH <set> BODY.PEEK[]` for the batch, returning `(uid, raw)` pairs.
(`BODY.PEEK[]` so prefetch never sets `\Seen` on the server — it must not mark mail read.)

### am-sync

- **Pure helpers (unit-testable):**
  - `prefetch::is_enabled(value: Option<String>) -> bool` — parses the
    `prefetch.bodies.<id>` setting (`Some("true")` → true, else false).
  - `prefetch::parse_folder_ids(value: Option<String>) -> Vec<i64>` — parses the
    `prefetch.folders.<id>` JSON array (bad/None → empty).
  - `prefetch::missing_uids(local: &[i64], server: &[i64]) -> Vec<i64>` — set difference
    (server − local), the Phase-A backfill work-list.
- `service::persist_body(db, message_id, raw: &[u8])` — extracted shared store path:
  parse → `store_body` → `backfill_body_meta` → `attachments_repo::replace_for_message`
  → `store_recipients` → `search_repo::reindex_message`. `fetch_and_store_body` is
  refactored to call it.
- `service::run_prefetch_batch(db, account_id, creds, sink) -> Result<bool, SyncError>`
  — reads the two settings keys; if disabled returns `Ok(false)`. For each selected
  folder runs one bounded Phase A (header backfill, `set_backfill_complete` when drained)
  + Phase B (one held session, `fetch_bodies`, `persist_body` each, emit
  `PrefetchProgress`). Returns whether it did work (drives the loop's pace-vs-idle choice).
  `NeedsReauth` propagates and flips `requires_reauth` (same pattern as the sync loop).
- `incremental_sync_folder` uidvalidity-resync branch additionally calls
  `set_backfill_complete(folder_id, false)`.
- `engine::SyncEngine::spawn_prefetch(account_id, token)` — the dedicated task; mirrors
  the `NeedsReauth` handling in `spawn_account`. Called from `spawn_account` so both
  tasks share the token. Constants: `PREFETCH_WORK_PAUSE` (~2 s),
  `PREFETCH_IDLE_INTERVAL` (~60 s — so a toggle takes effect within a minute),
  `BACKFILL_BATCH` (~200), `BODY_BATCH` (~20).

### am-app

- **No new command** — folder selection and the master toggle use the existing
  `getSettings` / `setSetting` commands (same as pinned folders / image autoload).
- New event `PrefetchProgress { account_id, done, total }`: `events.rs` struct +
  `sink.rs` match arm + `lib.rs` `collect_events!` registration, mirroring `SyncProgress`
  / `SnoozeWoke`. Adding the `SyncEvent::PrefetchProgress` variant forces the `sink.rs`
  exhaustive match to handle it (keeps the workspace green).
- Bindings regenerated (`npm run gen:bindings`) for the new event type.

All persistence reuses the existing `getSettings` / `setSetting` commands; the data
helpers mirror `src/features/mailbox/pinned.ts` and `useImageAutoload`.

- **`src/features/mailbox/prefetch.ts`** (new, mirrors `pinned.ts`): `prefetchBodiesKey`
  /`prefetchFoldersKey` builders, `parsePrefetchFoldersMap(all)` → `Map<accountId,
  Set<folderId>>`, `isFolderPrefetched(map, accountId, folderId)`, `togglePrefetchedIds`.
- **queries.ts**: `usePrefetchFoldersMap()` (reads `getSettings`, parses), plus
  `useToggleFolderPrefetch()` and `useAccountPrefetch(accountId)` /
  `useSetAccountPrefetch()` mutations — each built on `getSettings` / `setSetting`,
  exactly like `useTogglePinnedFolder` and `useImageAutoload` / `useSetImageAutoload`.
- **Folder context menu** (`MailboxRail.buildFolderMenuItems`): add an item whose label
  flips on state — `isFolderPrefetched` → "Nie pobieraj treści offline" else
  "Pobieraj treść offline" — calling `useToggleFolderPrefetch` (Polish labels match the
  existing menu items "Przypnij" / "Zmień nazwę").
- **Settings → Accounts** (`AccountsSection`): per-account master toggle (a `role=switch`
  mirroring `AccountImageToggle`) + the account's folder list with prefetch checkboxes
  (each row toggles `prefetch.folders.<id>`).
- **Progress indicator**: a subtle line in the rail footer fed by a `prefetchProgress`
  event listener writing a small Zustand slice (`prefetchProgress: Record<accountId,
  {done,total}>`), e.g. "Downloading bodies: 1200 / 5000". Hidden when `done >= total`.

## Pacing, limits, correctness

- **One held connection per body batch** — never connect-per-message (today's lazy path
  opens a fresh connection each time; fine for one message, fatal for thousands).
- `BODY_BATCH` small (~20) + `PREFETCH_WORK_PAUSE` between batches → bounded memory and
  a cooperative footprint on the server and the foreground.
- `BACKFILL_BATCH` larger (~200) since header fetches are light.
- Prefetch uses `BODY.PEEK[]` — **must not** flip `\Seen`.
- Concurrency: prefetch and the sync loop both write `messages` for the same account.
  Writes go through the existing `Database` mutex; `insert_headers` is
  `INSERT OR IGNORE`, `store_body` is an upsert — both idempotent and safe to interleave.

## Edge cases

- **uidvalidity resync** (folder wiped + re-fetched in `incremental_sync_folder`):
  reset `backfill_complete = 0` so older headers are re-backfilled. Bodies for
  surviving messages remain (`body_state` persists per row; wiped rows simply restart).
- **Folder unselected** (removed from `prefetch.folders.<id>`): prefetch stops touching
  it; already downloaded bodies stay (no eviction in MVP).
- **`\Noselect` / unselectable folders**: `select` fails → that folder is skipped this
  cycle (same skip-on-error tolerance as `sync_all_folders`); never aborts the account.
- **Master off**: task idles; folder flags are preserved for when it's re-enabled.
- **Body fetch fails** for a UID (deleted server-side mid-run): skip it; the next
  incremental sync reconciles the vanished row.
- **Full folder resync** drops `body_state` with the deleted rows — re-downloaded on the
  next prefetch pass (acceptable, self-healing).

## Testing

- **am-storage**: `set_backfill_complete` / `get_backfill_complete` roundtrip;
  `uids_without_body` (returns only `body_state='none'`, respects limit) +
  `count_without_body`; `store_body` flips `body_state` to `'downloaded'`.
- **am-sync pure helpers**: `prefetch::is_enabled`, `parse_folder_ids`, `missing_uids`
  (unit tests, no IO).
- **am-sync integration (GreenMail)**: `run_prefetch_batch` over a real folder — Phase A
  backfills missing headers and sets `backfill_complete`; Phase B persists bodies, marks
  `downloaded`, and leaves server `\Seen` unset (BODY.PEEK); master-off → `Ok(false)`.
- **am-app**: the event struct is covered like `SnoozeWoke` (struct-field test); no new
  command to test.
- **Frontend**: `prefetch.ts` helpers (parse/toggle/isFolderPrefetched); context-menu
  toggle item label flips and calls the mutation; Settings → Accounts master + folder
  checkboxes; progress indicator renders from a `prefetchProgress` event and hides at
  completion.
- **Integration (GreenMail, if available)**: select a folder, run prefetch, assert
  bodies land locally (`get_body` non-null) for messages never opened, and `\Seen`
  is **not** set on the server (BODY.PEEK).

## Deferred / backlog

- Attachment-blob prefetch (true full offline including files).
- Pause/resume + per-folder progress detail; configurable depth (last N days / N msgs).
- Eviction / cache-size cap for downloaded bodies.
- Smarter batching via a real `UID FETCH` body-set vs per-UID; backpressure on slow links.
- Prefetch metrics surface (bytes downloaded, ETA).
