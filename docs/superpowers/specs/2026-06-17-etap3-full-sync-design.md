# Etap 3 — Full IMAP Sync (design)

Status: approved for planning
Date: 2026-06-17
Builds on: Etap 1 (foundation), Etap 2A/2B (read-only inbox).

## Goal

Turn the read-only single-folder inbox into a properly synchronizing,
multi-folder, threaded mail client with background push, live UI updates,
and write-back of read/flag state — all offline-first (SQLite is the source
of truth).

## Scope (locked decisions)

- Full Etap 3: all folders, incremental sync, IDLE push, offline write
  queue, threading, progress events, RFC2047 decode, snippet/attachment
  back-fill.
- Write-back operations this etap: auto-seen on open + manual read/unread +
  star (flag). No move/delete yet.
- Freshness model: persistent IDLE on INBOX + interval poll for other
  folders; short-lived connections for sync/body-fetch/queue-drain; polling
  fallback when the server lacks IDLE.
- Threading: Message-ID ↔ In-Reply-To/References linkage with normalized
  subject fallback, built incrementally, per account.
- Thread grouping is shown directly in the message list (one row per
  conversation), with a conversation view in the reader.

## Architecture

### Sync engine boundary

`am-sync` must not depend on Tauri. Introduce a `SyncEventSink` trait in
`am-sync`; `am-app` provides an implementation that calls
`app_handle.emit(...)`. The engine stays fully testable without Tauri and
the "thick Rust core / thin React" boundary stays sharp.

- `SyncEngine` (in `am-sync`) manages a per-account `AccountSyncWorker`
  (a `tokio` task).
- Connection model:
  - Persistent connection — IDLE on INBOX (push of new mail).
  - Short-lived on-demand connection — folder sync, body fetch, offline
    queue drain. Created by a small connection factory (no elaborate pool).
- Interval timer (default 5 min, stored in account `settings`) drives
  incremental polling of non-INBOX folders.
- Fallback: when the server does not advertise `IDLE` in CAPABILITY, poll
  INBOX too.
- Lifecycle: workers start on `addAccount` and on app startup (for existing
  accounts); graceful shutdown closes connections.

### Incremental sync (per folder)

- `SELECT` → read `UIDVALIDITY`, `UIDNEXT`, `HIGHESTMODSEQ`.
- `UIDVALIDITY` changed → invalidate folder, full resync (UIDs changed
  meaning).
- CONDSTORE available (CAPABILITY) and stored `highestmodseq` present →
  `FETCH … (FLAGS) (CHANGEDSINCE modseq)` (flag changes) +
  `UID SEARCH UID uidnext:*` (new messages). QRESYNC vanished-set is
  best-effort depending on `async-imap 0.11` support; when unavailable,
  deletion detection uses the fallback path.
- Fallback (no CONDSTORE): new = range `uidnext..*`; flag changes =
  `FETCH FLAGS` over the known range + diff; deletions = compare
  `UID SEARCH ALL` against the local UID set (expensive → run on a slower
  cadence, not every poll).
- On success persist `uidnext`/`highestmodseq`/`last_synced_at`/`sync_state`
  on the folder.

## Data model (migration V2)

Refinery applies migrations incrementally, so add `V2__*.sql` without
touching V1 (safe for existing DBs).

- `folders`: add `highestmodseq INTEGER`, `last_synced_at INTEGER`.
- `messages`: add `references_hdr TEXT`, `in_reply_to TEXT` (needed to
  (re)thread when a parent arrives later).
- `threads`, `sync_queue` already exist and suffice.

## Threading

- During sync fetch `Message-ID`, `In-Reply-To`, `References`.
- Link by `Message-ID ↔ In-Reply-To/References` (reliable); fallback to
  grouping by normalized subject (strip `Re:`/`Fwd:` etc.) within the
  account.
- `threads` table maintained incrementally (`last_date`, `message_count`,
  `unread_count`). Re-thread when a parent message arrives.
- Pure, deterministic threading logic with full unit tests over header
  permutations.

## Offline queue + write actions

- Consumer: auto-seen on open + manual read/unread + star.
- UI action → optimistic local update (`messages.seen/flagged`) → row in
  `sync_queue` (`op_type="set_flag"`, payload
  `{folder_id, uid, uidvalidity, flag, value}`).
- Worker drains: `SELECT` + `UID STORE ±FLAGS`. Backoff (`attempts`,
  `next_retry_at`); states `pending → inflight → done/failed`.
- Safety: if payload `uidvalidity` ≠ current → drop the op (never write to
  the wrong UID).

## Events (live UI updates)

- `syncProgress { accountId, folderId?, phase, done, total }` — actually
  emitted now (today only declared).
- `newMessages { accountId, folderId, count }`.
- `mailboxChanged { accountId, folderId }` — after flag/count changes so the
  UI refreshes unread counts.
- Frontend already subscribes to the first two; add handling + react-query
  invalidation for the third.

## RFC2047 + back-fill

- `am-mime`: decode encoded-words (`=?utf-8?Q?…?=`) for `subject` and
  `from-name` from the ENVELOPE path (mojibake today). Prefer a small
  dedicated decoder in `am-mime` (charset + Q/B) with tests; avoid a heavy
  new dependency if practical.
- Back-fill on body fetch: parse MIME → compute `snippet` (cleaned start of
  text/plain) and `has_attachments`, persist attachment metadata.

## Frontend

Thread grouping changes the list unit from "messages in a folder" to
"threads having ≥1 message in that folder". A thread is per-account but can
span folders, so the folder list queries `threads` via `messages` with
`folder_id = ?`, ordered by `threads.last_date` (using
`idx_threads_account_lastdate` + `idx_messages_thread`). This keeps the
query cheap on large mailboxes.

- New command `listThreads { folderId, limit, offset }` → thread rows:
  `subject_root`, `last_date`, `message_count`, `unread_count`, participants,
  latest snippet, aggregate `has_attachments`. Becomes the default list
  source (existing `listMessages` stays for internal paths/tests).
- `listThreadMessages { threadId }` → reader shows the whole conversation
  (chronological).
- Virtualized list renders threads; unread badge = `thread.unread_count`;
  message-count badge per thread.
- New commands `markMessageSeen` / `setMessageFlags`.
- Reader: auto-seen on open (opening/expanding messages marks them seen,
  queued to server); read/unread + star toggles at message and thread level
  (bulk action on a thread).
- All folders: list already works per folder; live counts are added.

## Testing & quality gate (security / performance / clean code)

- GreenMail (Docker) integration: incremental sync, new mail, flag changes
  via the queue, multi-folder, UIDVALIDITY reset.
- Unit: threading (header permutations), RFC2047 (charset/Q/B/malformed),
  flag diff, queue backoff.
- Performance: index-backed queries (`idx_messages_folder_date`,
  `idx_threads_account_lastdate`, `idx_sync_queue_state_retry`); batched
  header fetches; no N+1 when building threads or thread-list rows.
- Security: no password leakage in logs/events; drop queued ops on
  UIDVALIDITY change; mail content still rendered only via sanitizer +
  `sandbox=""` iframe.

## Out of scope (later etaps)

- Sending / composer (Etap 4).
- Move/delete write-back, multi-account orchestration UI, OAuth (Etap 4/5).
- Full-text search UI, labels, snooze, density UI (Etap 6).
