# Offline Body Prefetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, per-account, per-folder background prefetch that downloads message text bodies (full offline archive) after headers arrive.

**Architecture:** A dedicated per-account async task in the sync engine (sharing the account's `CancellationToken`, own IMAP connection) runs two phases per cycle — backfill older headers, then batch-fetch missing bodies with `BODY.PEEK[]` — paced and resumable via DB state (`messages.body_state`, `folders.backfill_complete`). Selection lives in the existing `settings` table under per-account keys (no new Tauri command); a `PrefetchProgress` event drives a lightweight indicator.

**Tech Stack:** Rust (rusqlite + refinery, async-imap, tokio), Tauri 2 + tauri-specta, React + TypeScript + @tanstack/react-query + Zustand.

**Spec:** `docs/superpowers/specs/2026-06-21-offline-body-prefetch-design.md`

## Global Constraints

- **Code identifiers English only**; **no code comments** (user rule). Important rationale goes in `docs/`.
- **Folder context-menu labels are Polish** to match the existing menu (`"Przypnij"`, `"Zmień nazwę"`).
- **Node ≥ 24** for the frontend toolchain (`$HOME/.nvm/versions/node/v24.14.0/bin`). `npm run gen:bindings` runs `cargo run -p abeonmail --bin export_bindings`.
- **Workspace must stay green after every task** — adding a `SyncEvent` variant requires updating the exhaustive match in `am-app/src/sink.rs` in the same task.
- **Storage keys:** master = `prefetch.bodies.<account_id>` (`"true"`/`"false"`); folder list = `prefetch.folders.<account_id>` (JSON array of folder ids).
- **`BODY.PEEK[]`** for prefetch — must never set `\Seen`.
- Conventional Commits; no co-author trailer; do not push.
- Frontend tests: if a new `lucide-react` icon is used in a component under test, add it to `src/test/lucide-stub.js` (this feature uses no new icons — toggles/indicator are text/switch).

## File Structure

**Backend (Rust):**
- `crates/am-storage/src/migrations/V13__prefetch.sql` — new: `folders.backfill_complete` + `idx_messages_body_state`.
- `crates/am-storage/src/folders_repo.rs` — `set_backfill_complete` / `get_backfill_complete`.
- `crates/am-storage/src/messages_repo.rs` — `store_body` flips `body_state`; `uids_without_body`; `count_without_body`.
- `crates/am-sync/src/events.rs` — `SyncEvent::PrefetchProgress` variant.
- `crates/am-app/src/events.rs` / `sink.rs` / `lib.rs` — `PrefetchProgress` event struct, sink arm, registration.
- `crates/am-protocols/src/imap.rs` — `fetch_bodies` (`BODY.PEEK[]`).
- `crates/am-sync/src/prefetch.rs` — new: pure helpers (`is_enabled`, `parse_folder_ids`, `missing_uids`).
- `crates/am-sync/src/lib.rs` — `pub mod prefetch;`.
- `crates/am-sync/src/service.rs` — `persist_body`, `run_prefetch_batch`, uidvalidity-resync reset.
- `crates/am-sync/src/engine.rs` — `spawn_prefetch` + wire into `spawn_account`.
- `crates/am-sync/tests/sync_greenmail.rs` — prefetch integration test.

**Frontend (TS):**
- `src/features/mailbox/prefetch.ts` — new: settings-key helpers (mirror `pinned.ts`).
- `src/ipc/queries.ts` — `usePrefetchFoldersMap`, `useToggleFolderPrefetch`, `useAccountPrefetch`, `useSetAccountPrefetch`.
- `src/features/mailbox/MailboxRail.tsx` — context-menu toggle + footer progress indicator.
- `src/features/settings/AccountsSection.tsx` — master toggle + folder checkbox list.
- `src/app/store.ts` — `prefetchProgress` slice.
- `src/ipc/events.ts` — `prefetchProgress` listener.

---

## Task 1: Migration V13 (backend bookkeeping schema)

**Files:**
- Create: `crates/am-storage/src/migrations/V13__prefetch.sql`
- Test: `crates/am-storage/src/db.rs` (tests module)

**Interfaces:**
- Produces: a `folders.backfill_complete INTEGER NOT NULL DEFAULT 0` column and an `idx_messages_body_state` index, available to all later repo tasks.

- [ ] **Step 1: Write the failing test** in `crates/am-storage/src/db.rs`, inside `mod tests`:

```rust
    #[test]
    fn migration_v13_adds_backfill_and_body_state_index() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        let col: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('folders') WHERE name = 'backfill_complete'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(col, 1);
        let idx: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='idx_messages_body_state'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx, 1);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p am-storage migration_v13 -- --nocapture`
Expected: FAIL (migration file does not exist → `backfill_complete` column missing → `col == 0`).

- [ ] **Step 3: Create the migration** `crates/am-storage/src/migrations/V13__prefetch.sql`:

```sql
ALTER TABLE folders ADD COLUMN backfill_complete INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_messages_body_state ON messages(folder_id, body_state);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p am-storage migration_v13`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/am-storage/src/migrations/V13__prefetch.sql crates/am-storage/src/db.rs
git commit -m "feat(storage): V13 backfill_complete column and body_state index"
```

---

## Task 2: folders_repo backfill_complete accessors

**Files:**
- Modify: `crates/am-storage/src/folders_repo.rs`
- Test: same file (`mod tests`)

**Interfaces:**
- Consumes: Task 1 migration.
- Produces:
  - `folders_repo::set_backfill_complete(db: &Database, folder_id: i64, value: bool) -> Result<(), StorageError>`
  - `folders_repo::get_backfill_complete(db: &Database, folder_id: i64) -> Result<bool, StorageError>`

- [ ] **Step 1: Write the failing test** (append to `mod tests` in `folders_repo.rs`):

```rust
    #[test]
    fn backfill_complete_roundtrips_and_defaults_false() {
        let db = Database::open_in_memory().unwrap();
        let account = insert_account(&db, &sample_account()).unwrap();
        let folder = upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        assert!(!get_backfill_complete(&db, folder.id).unwrap());
        set_backfill_complete(&db, folder.id, true).unwrap();
        assert!(get_backfill_complete(&db, folder.id).unwrap());
        set_backfill_complete(&db, folder.id, false).unwrap();
        assert!(!get_backfill_complete(&db, folder.id).unwrap());
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p am-storage backfill_complete_roundtrips`
Expected: FAIL (`set_backfill_complete` / `get_backfill_complete` not defined).

- [ ] **Step 3: Implement** (add after `set_sync_markers` / near `recount_unread` in `folders_repo.rs`):

```rust
pub fn set_backfill_complete(db: &Database, folder_id: i64, value: bool) -> Result<(), StorageError> {
    let conn = db.conn();
    let changed = conn.execute(
        "UPDATE folders SET backfill_complete = ?2 WHERE id = ?1",
        params![folder_id, value as i64],
    )?;
    if changed == 0 {
        return Err(StorageError::NotFound);
    }
    Ok(())
}

pub fn get_backfill_complete(db: &Database, folder_id: i64) -> Result<bool, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT backfill_complete FROM folders WHERE id = ?1",
        params![folder_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|v| v != 0)
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
        other => StorageError::Sqlite(other),
    })
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p am-storage backfill_complete_roundtrips`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/am-storage/src/folders_repo.rs
git commit -m "feat(storage): folders_repo backfill_complete accessors"
```

---

## Task 3: messages_repo body_state cursor + pending-body queries

**Files:**
- Modify: `crates/am-storage/src/messages_repo.rs`
- Test: same file (`mod tests`)

**Interfaces:**
- Produces:
  - `store_body` now sets `messages.body_state = 'downloaded'` for the message.
  - `messages_repo::uids_without_body(db, folder_id: i64, limit: i64) -> Result<Vec<(i64, i64)>, StorageError>` → `(message_id, uid)` pairs, non-draft non-deleted, `body_state = 'none'`, newest UID first, capped at `limit`.
  - `messages_repo::count_without_body(db, folder_id: i64) -> Result<i64, StorageError>`.

- [ ] **Step 1: Write the failing test** (append to `mod tests` in `messages_repo.rs`). If a header-builder helper already exists in this module's tests, reuse it; otherwise this self-contained version works:

```rust
    #[test]
    fn body_state_tracks_download_and_pending_queries() {
        use am_core::account::{NewAccount, ProviderType};
        use am_core::folder::FolderType;
        use am_core::message::{MessageBody, NewMessageHeader};

        let db = Database::open_in_memory().unwrap();
        let account = crate::accounts_repo::insert_account(&db, &NewAccount {
            email: "p@e.com".into(), display_name: "P".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = crate::folders_repo::upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        let h = |uid: i64| NewMessageHeader {
            uid, message_id_hdr: Some(format!("<m{uid}@e>")), in_reply_to: None, references_hdr: None,
            from_address: "s@e.com".into(), from_name: None, subject: "S".into(), date: uid,
            seen: false, flagged: false, has_attachments: false, size: 1, snippet: String::new(),
        };
        insert_headers(&db, folder.id, &[h(1), h(2)]).unwrap();

        assert_eq!(count_without_body(&db, folder.id).unwrap(), 2);
        let pending = uids_without_body(&db, folder.id, 10).unwrap();
        assert_eq!(pending.len(), 2);
        assert_eq!(pending[0].1, 2);

        let first_id = pending[0].0;
        store_body(&db, first_id, &MessageBody {
            message_id: first_id, text_plain: Some("hi".into()), text_html: None,
        }).unwrap();

        assert_eq!(count_without_body(&db, folder.id).unwrap(), 1);
        assert!(get_body(&db, first_id).unwrap().is_some());
        assert_eq!(uids_without_body(&db, folder.id, 10).unwrap().len(), 1);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p am-storage body_state_tracks_download`
Expected: FAIL (`uids_without_body` / `count_without_body` undefined; `store_body` does not flip state).

- [ ] **Step 3: Modify `store_body`** to also set the cursor:

```rust
pub fn store_body(db: &Database, message_id: i64, body: &MessageBody) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute(
        "INSERT INTO message_bodies (message_id, text_plain, text_html)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(message_id) DO UPDATE SET text_plain = excluded.text_plain, text_html = excluded.text_html",
        params![message_id, body.text_plain, body.text_html],
    )?;
    conn.execute(
        "UPDATE messages SET body_state = 'downloaded' WHERE id = ?1",
        params![message_id],
    )?;
    Ok(())
}
```

  Then add the two queries (next to `list_uids` / `count_by_folder`):

```rust
pub fn uids_without_body(db: &Database, folder_id: i64, limit: i64) -> Result<Vec<(i64, i64)>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, uid FROM messages
         WHERE folder_id = ?1 AND draft = 0 AND deleted = 0 AND body_state = 'none'
         ORDER BY uid DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![folder_id, limit], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn count_without_body(db: &Database, folder_id: i64) -> Result<i64, StorageError> {
    let conn = db.conn();
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM messages
         WHERE folder_id = ?1 AND draft = 0 AND deleted = 0 AND body_state = 'none'",
        params![folder_id],
        |row| row.get::<_, i64>(0),
    )?)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p am-storage body_state_tracks_download`
Expected: PASS. Also run `cargo test -p am-storage` to confirm no regression in body/search tests.

- [ ] **Step 5: Commit**

```bash
git add crates/am-storage/src/messages_repo.rs
git commit -m "feat(storage): body_state download cursor and pending-body queries"
```

---

## Task 4: PrefetchProgress event (end-to-end, workspace stays green)

**Files:**
- Modify: `crates/am-sync/src/events.rs` (variant)
- Modify: `crates/am-app/src/events.rs` (struct)
- Modify: `crates/am-app/src/sink.rs` (match arm + import)
- Modify: `crates/am-app/src/lib.rs` (`collect_events!`)
- Modify: `src/ipc/bindings.ts` (regenerated)
- Test: `crates/am-sync/src/events.rs` (variant test)

**Interfaces:**
- Produces: `SyncEvent::PrefetchProgress { account_id: i64, done: i64, total: i64 }` (am-sync) and the front-end event `events.prefetchProgress` with payload `{ account_id, done, total }`.

- [ ] **Step 1: Write the failing test** (append to `mod tests` in `crates/am-sync/src/events.rs`):

```rust
    #[test]
    fn prefetch_progress_variant_stores_fields() {
        let ev = SyncEvent::PrefetchProgress { account_id: 1, done: 5, total: 10 };
        assert_eq!(ev, SyncEvent::PrefetchProgress { account_id: 1, done: 5, total: 10 });
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p am-sync prefetch_progress_variant`
Expected: FAIL (variant does not exist → does not compile).

- [ ] **Step 3: Add the variant** in `crates/am-sync/src/events.rs` enum `SyncEvent` (after `SendFailed`):

```rust
    PrefetchProgress { account_id: i64, done: i64, total: i64 },
```

  Add the front-end event struct in `crates/am-app/src/events.rs` (after `SendFailed`):

```rust
#[derive(Serialize, Deserialize, Clone, Debug, specta::Type, tauri_specta::Event)]
pub struct PrefetchProgress {
    pub account_id: i64,
    pub done: i64,
    pub total: i64,
}
```

  In `crates/am-app/src/sink.rs`, extend the import and add the arm:

```rust
use crate::events::{AccountAuthChanged, MailboxChanged, NewMessages, PrefetchProgress, SendFailed, SnoozeWoke, SyncProgress};
```

```rust
            SyncEvent::PrefetchProgress { account_id, done, total } => {
                let _ = PrefetchProgress { account_id, done, total }.emit(&self.app);
            }
```

  In `crates/am-app/src/lib.rs`, add to `collect_events!` (after `events::SendFailed,`):

```rust
            events::PrefetchProgress,
```

- [ ] **Step 4: Run to verify it passes & workspace builds**

Run: `cargo test -p am-sync prefetch_progress_variant && cargo build --workspace`
Expected: PASS + clean build (the exhaustive `match` in `sink.rs` now handles every variant).

- [ ] **Step 5: Regenerate bindings**

Run: `npm run gen:bindings`
Expected: `src/ipc/bindings.ts` gains a `PrefetchProgress` type and `events.prefetchProgress`. Confirm with `git diff --stat src/ipc/bindings.ts`.

- [ ] **Step 6: Commit**

```bash
git add crates/am-sync/src/events.rs crates/am-app/src/events.rs crates/am-app/src/sink.rs crates/am-app/src/lib.rs src/ipc/bindings.ts
git commit -m "feat(app): PrefetchProgress sync event end-to-end"
```

---

## Task 5: am-protocols batch body fetch (BODY.PEEK[])

**Files:**
- Modify: `crates/am-protocols/src/imap.rs`

**Interfaces:**
- Produces: `ImapSession::fetch_bodies(&mut self, uids: &[i64]) -> Result<Vec<(i64, Vec<u8>)>, ProtocolError>` — issues one `UID FETCH <set> BODY.PEEK[]`, returns `(uid, raw_rfc822)` pairs; never sets `\Seen`.

This method needs a live IMAP server to exercise, so (like the existing `fetch_body`) it has no unit test; its behavior is verified by the GreenMail integration test in Task 7. The verification here is a clean compile.

- [ ] **Step 1: Implement** `fetch_bodies` in `crates/am-protocols/src/imap.rs`, immediately after `fetch_body`:

```rust
    pub async fn fetch_bodies(&mut self, uids: &[i64]) -> Result<Vec<(i64, Vec<u8>)>, ProtocolError> {
        if uids.is_empty() {
            return Ok(Vec::new());
        }
        let set = uids
            .iter()
            .map(|u| u.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let fetches: Vec<Fetch> = match &mut self.session {
            SessionStream::Plain(s) => {
                let stream = s.uid_fetch(&set, "BODY.PEEK[]").await?;
                stream.try_collect().await?
            }
            SessionStream::Tls(s) => {
                let stream = s.uid_fetch(&set, "BODY.PEEK[]").await?;
                stream.try_collect().await?
            }
        };
        let mut out = Vec::new();
        for f in &fetches {
            if let (Some(uid), Some(body)) = (f.uid, f.body()) {
                out.push((uid as i64, body.to_vec()));
            }
        }
        Ok(out)
    }
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo build -p am-protocols`
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add crates/am-protocols/src/imap.rs
git commit -m "feat(protocols): fetch_bodies batch BODY.PEEK fetch"
```

---

## Task 6: am-sync prefetch helpers + persist_body refactor

**Files:**
- Create: `crates/am-sync/src/prefetch.rs`
- Modify: `crates/am-sync/src/lib.rs` (`pub mod prefetch;`)
- Modify: `crates/am-sync/src/service.rs` (`persist_body`, refactor `fetch_and_store_body`)
- Test: `crates/am-sync/src/prefetch.rs` (`mod tests`) and `crates/am-sync/src/service.rs` (`mod tests`)

**Interfaces:**
- Consumes: Task 3 (`store_body` cursor).
- Produces:
  - `prefetch::is_enabled(value: Option<String>) -> bool`
  - `prefetch::parse_folder_ids(value: Option<String>) -> Vec<i64>`
  - `prefetch::missing_uids(local: &[i64], server: &[i64]) -> Vec<i64>`
  - `service::persist_body(db: &Database, message_id: i64, raw: &[u8]) -> Result<MessageBody, SyncError>` (`pub(crate)`).

- [ ] **Step 1: Write failing tests** — create `crates/am-sync/src/prefetch.rs` with helpers stubbed to wrong values plus tests, OR write tests first then implement. Use this file body:

```rust
use std::collections::HashSet;

pub fn is_enabled(value: Option<String>) -> bool {
    matches!(value.as_deref(), Some("true"))
}

pub fn parse_folder_ids(value: Option<String>) -> Vec<i64> {
    match value {
        Some(s) => serde_json::from_str::<Vec<i64>>(&s).unwrap_or_default(),
        None => Vec::new(),
    }
}

pub fn missing_uids(local: &[i64], server: &[i64]) -> Vec<i64> {
    let local_set: HashSet<i64> = local.iter().copied().collect();
    server.iter().copied().filter(|u| !local_set.contains(u)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_enabled_only_true_string() {
        assert!(is_enabled(Some("true".into())));
        assert!(!is_enabled(Some("false".into())));
        assert!(!is_enabled(Some("1".into())));
        assert!(!is_enabled(None));
    }

    #[test]
    fn parse_folder_ids_handles_valid_junk_and_none() {
        assert_eq!(parse_folder_ids(Some("[3,7]".into())), vec![3, 7]);
        assert_eq!(parse_folder_ids(Some("not json".into())), Vec::<i64>::new());
        assert_eq!(parse_folder_ids(None), Vec::<i64>::new());
    }

    #[test]
    fn missing_uids_returns_server_minus_local() {
        assert_eq!(missing_uids(&[2, 3], &[1, 2, 3, 4]), vec![1, 4]);
        assert_eq!(missing_uids(&[1, 2], &[1, 2]), Vec::<i64>::new());
    }
}
```

  Register the module — add to `crates/am-sync/src/lib.rs`:

```rust
pub mod prefetch;
```

- [ ] **Step 2: Run to verify the helpers pass**

Run: `cargo test -p am-sync prefetch::`
Expected: PASS (3 tests).

- [ ] **Step 3: Extract `persist_body` in `service.rs`** — add this function and rewrite `fetch_and_store_body` to call it:

```rust
pub(crate) fn persist_body(db: &Database, message_id: i64, raw: &[u8]) -> Result<MessageBody, SyncError> {
    let parsed = am_mime::parse::parse_message(raw);
    let body = MessageBody {
        message_id,
        text_plain: parsed.text_plain,
        text_html: parsed.text_html,
    };
    messages_repo::store_body(db, message_id, &body)?;
    messages_repo::backfill_body_meta(db, message_id, &parsed.snippet, !parsed.attachment_names.is_empty())?;
    am_storage::attachments_repo::replace_for_message(db, message_id, &parsed.attachments)?;
    messages_repo::store_recipients(db, message_id, &parsed.to, &parsed.cc)?;
    am_storage::search_repo::reindex_message(db, message_id)?;
    Ok(body)
}
```

  Replace the body of `fetch_and_store_body` (keep its signature) with:

```rust
async fn fetch_and_store_body(db: &Database, message_id: i64, creds: &dyn CredentialSource) -> Result<MessageBody, SyncError> {
    let (folder_id, uid) = messages_repo::message_uid(db, message_id)?;
    let folder = folders_repo::get_folder(db, folder_id)?;
    let account = accounts_repo::get_account(db, folder.account_id)?;
    let endpoints = load_endpoints(db, folder.account_id)?;

    let auth = creds.auth_for(&account).await?;
    let config = imap_config(&endpoints, &account.email);
    let mut session = ImapSession::connect(&config, &auth.to_imap()).await?;
    session.select(&folder.remote_path).await?;
    let raw = session.fetch_body(uid).await?;
    session.logout().await?;

    persist_body(db, message_id, &raw)
}
```

- [ ] **Step 4: Write a `persist_body` unit test** (append to `mod tests` in `service.rs`, ~line 1212):

```rust
    #[test]
    fn persist_body_stores_text_and_flips_state() {
        use am_core::account::{NewAccount, ProviderType};
        use am_core::folder::FolderType;
        use am_core::message::NewMessageHeader;

        let db = Database::open_in_memory().unwrap();
        let account = accounts_repo::insert_account(&db, &NewAccount {
            email: "x@e.com".into(), display_name: "X".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = folders_repo::upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        messages_repo::insert_headers(&db, folder.id, &[NewMessageHeader {
            uid: 1, message_id_hdr: Some("<m1@e>".into()), in_reply_to: None, references_hdr: None,
            from_address: "s@e.com".into(), from_name: None, subject: "S".into(), date: 1,
            seen: false, flagged: false, has_attachments: false, size: 1, snippet: String::new(),
        }]).unwrap();
        let id = messages_repo::list_by_folder(&db, folder.id, 10, 0, i64::MAX).unwrap()[0].id;

        let raw = b"From: s@e.com\r\nTo: x@e.com\r\nSubject: S\r\n\r\nHello prefetch body\r\n";
        let body = persist_body(&db, id, raw).unwrap();
        assert!(body.text_plain.unwrap_or_default().contains("Hello prefetch body"));
        assert!(messages_repo::get_body(&db, id).unwrap().is_some());
        assert_eq!(messages_repo::count_without_body(&db, folder.id).unwrap(), 0);
    }
```

  Run: `cargo test -p am-sync persist_body_stores_text`
  Expected: PASS. Confirm no regression: `cargo test -p am-sync` (the existing `fetch_and_store_body` path still compiles & GreenMail tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add crates/am-sync/src/prefetch.rs crates/am-sync/src/lib.rs crates/am-sync/src/service.rs
git commit -m "feat(sync): prefetch helpers and shared persist_body"
```

---

## Task 7: am-sync run_prefetch_batch + uidvalidity reset + integration test

**Files:**
- Modify: `crates/am-sync/src/service.rs` (constants, `run_prefetch_batch`, resync reset)
- Test: `crates/am-sync/tests/sync_greenmail.rs`

**Interfaces:**
- Consumes: Tasks 2, 3, 5, 6 + the `PrefetchProgress` variant (Task 4).
- Produces: `service::run_prefetch_batch(db: &Database, account_id: i64, creds: &dyn CredentialSource, sink: &dyn SyncEventSink) -> Result<bool, SyncError>` (returns `true` if it did work this call).

- [ ] **Step 1: Add the constants** near the other limits in `service.rs` (after `const INITIAL_SYNC_LIMIT: u32 = 200;`):

```rust
const BACKFILL_BATCH: usize = 200;
const BODY_BATCH: i64 = 20;
```

- [ ] **Step 2: Implement `run_prefetch_batch`** (add it after `incremental_sync_folder` in `service.rs`):

```rust
pub async fn run_prefetch_batch(
    db: &Database,
    account_id: i64,
    creds: &dyn CredentialSource,
    sink: &dyn SyncEventSink,
) -> Result<bool, SyncError> {
    let enabled = crate::prefetch::is_enabled(
        am_storage::settings_repo::get_setting(db, &format!("prefetch.bodies.{account_id}"))?,
    );
    if !enabled {
        return Ok(false);
    }
    let selected = crate::prefetch::parse_folder_ids(
        am_storage::settings_repo::get_setting(db, &format!("prefetch.folders.{account_id}"))?,
    );
    if selected.is_empty() {
        return Ok(false);
    }

    let account = accounts_repo::get_account(db, account_id)?;
    let endpoints = load_endpoints(db, account_id)?;
    let auth = creds.auth_for(&account).await?;
    let config = imap_config(&endpoints, &account.email);
    let mut session = ImapSession::connect(&config, &auth.to_imap()).await?;

    let mut did_work = false;
    for folder_id in selected {
        let folder = match folders_repo::get_folder(db, folder_id) {
            Ok(f) => f,
            Err(_) => continue,
        };
        if session.select(&folder.remote_path).await.is_err() {
            continue;
        }

        if !folders_repo::get_backfill_complete(db, folder_id)? {
            let server_uids = session.search_all_uids().await?;
            let local_uids = messages_repo::list_uids(db, folder_id)?;
            let missing = crate::prefetch::missing_uids(&local_uids, &server_uids);
            if missing.is_empty() {
                folders_repo::set_backfill_complete(db, folder_id, true)?;
            } else {
                let batch: Vec<i64> = missing.into_iter().take(BACKFILL_BATCH).collect();
                let fetched = session.fetch_headers_by_uids(&batch).await?;
                let headers: Vec<NewMessageHeader> = fetched.iter().map(header_from_fetch).collect();
                messages_repo::insert_headers(db, folder_id, &headers)?;
                assign_threads(db, account_id)?;
                did_work = true;
            }
        }

        let pending = messages_repo::uids_without_body(db, folder_id, BODY_BATCH)?;
        if !pending.is_empty() {
            let uids: Vec<i64> = pending.iter().map(|(_, uid)| *uid).collect();
            let bodies = session.fetch_bodies(&uids).await?;
            let by_uid: std::collections::HashMap<i64, Vec<u8>> = bodies.into_iter().collect();
            for (message_id, uid) in &pending {
                if let Some(raw) = by_uid.get(uid) {
                    let _ = persist_body(db, *message_id, raw);
                }
            }
            did_work = true;
        }

        let total = messages_repo::count_by_folder(db, folder_id)?;
        let remaining = messages_repo::count_without_body(db, folder_id)?;
        sink.emit(SyncEvent::PrefetchProgress {
            account_id,
            done: total - remaining,
            total,
        });
    }

    let _ = session.logout().await;
    Ok(did_work)
}
```

- [ ] **Step 3: Reset backfill on uidvalidity resync** — in `incremental_sync_folder`, inside the `if markers.uidvalidity != Some(state.uidvalidity)` branch (right after `messages_repo::delete_by_folder(db, folder_id)?;`), add:

```rust
        folders_repo::set_backfill_complete(db, folder_id, false)?;
```

- [ ] **Step 4: Verify it compiles**

Run: `cargo build -p am-sync`
Expected: clean build.

- [ ] **Step 5: Write the GreenMail integration test** — append to `crates/am-sync/tests/sync_greenmail.rs`. It reuses the file's existing helpers (`install_in_mem_builder`, `docker_available`, `seed_inbox_only`, `IMAP_PORT`, container setup). Add `am_sync::events::NoopSink` use at call site:

```rust
#[tokio::test]
async fn prefetch_downloads_bodies_without_marking_seen() {
    if !docker_available() {
        eprintln!("docker is not available; skipping greenmail prefetch integration test");
        return;
    }

    install_in_mem_builder();

    let image = GenericImage::new("greenmail/standalone", "latest")
        .with_wait_for(WaitFor::message_on_stdout("Starting GreenMail standalone"))
        .with_exposed_port(ContainerPort::Tcp(IMAP_PORT))
        .with_env_var(
            "GREENMAIL_OPTS",
            "-Dgreenmail.setup.test.all -Dgreenmail.auth.disabled -Dgreenmail.verbose -Dgreenmail.hostname=0.0.0.0",
        );

    let container = image.start().await.expect("failed to start greenmail container");
    let mapped_port = container
        .get_host_port_ipv4(ContainerPort::Tcp(IMAP_PORT))
        .await
        .expect("failed to get mapped imap port");

    tokio::time::sleep(Duration::from_millis(500)).await;
    seed_inbox_only(mapped_port).await;

    let endpoints = Endpoints {
        imap_host: "127.0.0.1".to_string(),
        imap_port: mapped_port,
        imap_tls: false,
        smtp_host: "127.0.0.1".to_string(),
        smtp_port: 0,
        smtp_tls: false,
    };
    let db = Database::open_in_memory().expect("db open failed");
    let account = service::add_account(&db, AddAccountInput {
        email: USER.to_string(),
        display_name: "Sync User".to_string(),
        password: PASSWORD.to_string(),
        endpoints,
    }).await.expect("add_account failed");

    let inbox = folders_repo::find_by_type(&db, account.id, FolderType::Inbox)
        .unwrap()
        .expect("inbox folder missing");

    // No bodies fetched yet (headers only after add_account).
    assert_eq!(messages_repo::count_without_body(&db, inbox.id).unwrap(), 3);

    // Enable prefetch for this account + the inbox folder.
    am_storage::settings_repo::set_setting(&db, &format!("prefetch.bodies.{}", account.id), "true").unwrap();
    am_storage::settings_repo::set_setting(
        &db,
        &format!("prefetch.folders.{}", account.id),
        &format!("[{}]", inbox.id),
    ).unwrap();

    let creds = am_sync::auth::KeychainCredentialSource::new();
    let sink = am_sync::events::NoopSink;
    let worked = service::run_prefetch_batch(&db, account.id, creds.as_ref(), &sink)
        .await
        .expect("run_prefetch_batch failed");
    assert!(worked, "prefetch should have done work");

    // All 3 bodies present, backfill marked complete.
    assert_eq!(messages_repo::count_without_body(&db, inbox.id).unwrap(), 0);
    assert!(folders_repo::get_backfill_complete(&db, inbox.id).unwrap());
    let headers = messages_repo::list_by_folder(&db, inbox.id, 50, 0, i64::MAX).unwrap();
    for h in &headers {
        assert!(service::get_or_fetch_body(&db, h.id, creds.as_ref()).await.unwrap().text_plain.is_some());
    }

    // BODY.PEEK must NOT have set \Seen: re-sync flags from the server and assert unseen.
    service::incremental_sync_folder(&db, account.id, inbox.id, creds.as_ref(), &sink)
        .await
        .expect("incremental sync failed");
    let after = messages_repo::list_by_folder(&db, inbox.id, 50, 0, i64::MAX).unwrap();
    assert!(after.iter().all(|h| !h.seen), "prefetch must not mark messages seen");

    // Disabled account → no-op.
    am_storage::settings_repo::set_setting(&db, &format!("prefetch.bodies.{}", account.id), "false").unwrap();
    assert!(!service::run_prefetch_batch(&db, account.id, creds.as_ref(), &sink).await.unwrap());
}
```

  Note: `NoopSink` is defined in `am-sync/src/events.rs` and is **not** `#[cfg(test)]`, so it is usable from the integration test (`am_sync::events::NoopSink`). `KeychainCredentialSource::new()` returns an `Arc<...>`; `.as_ref()` yields `&dyn CredentialSource` (same pattern as the existing tests).

- [ ] **Step 6: Run the integration test** (requires Docker)

Run: `cargo test -p am-sync --test sync_greenmail prefetch_downloads_bodies -- --nocapture`
Expected: PASS when Docker is available; otherwise it prints the skip line and returns (consistent with the other GreenMail tests).

- [ ] **Step 7: Commit**

```bash
git add crates/am-sync/src/service.rs crates/am-sync/tests/sync_greenmail.rs
git commit -m "feat(sync): run_prefetch_batch archive backfill + body prefetch"
```

---

## Task 8: engine — dedicated per-account prefetch task

**Files:**
- Modify: `crates/am-sync/src/engine.rs`

**Interfaces:**
- Consumes: `service::run_prefetch_batch` (Task 7).
- Produces: a background prefetch task spawned per account in `spawn_account`, cancelled by the account's shared `CancellationToken`.

This wiring spawns a long-lived tokio task with IO; like the existing per-account sync task it is verified by build + the existing engine tests (which use `FakeCreds`; prefetch reads the disabled-by-default setting and idles) rather than a new deterministic unit test.

- [ ] **Step 1: Add the pacing constants** near the top of `engine.rs` (after `WAKE_SWEEP_INTERVAL`):

```rust
pub const PREFETCH_IDLE_INTERVAL: Duration = Duration::from_secs(60);
pub const PREFETCH_WORK_PAUSE: Duration = Duration::from_secs(2);
```

- [ ] **Step 2: Add `spawn_prefetch`** as a method on `SyncEngine` (place after `spawn_account`):

```rust
    pub fn spawn_prefetch(self: &Arc<Self>, account_id: i64, token: CancellationToken) {
        let db = Arc::clone(&self.db);
        let sink = Arc::clone(&self.sink);
        let creds = Arc::clone(&self.creds);
        tokio::spawn(async move {
            loop {
                if token.is_cancelled() {
                    break;
                }
                let did_work = match service::run_prefetch_batch(&db, account_id, creds.as_ref(), sink.as_ref()).await {
                    Ok(worked) => worked,
                    Err(service::SyncError::NeedsReauth) => {
                        let _ = am_storage::accounts_repo::set_requires_reauth(&db, account_id, true);
                        sink.emit(crate::events::SyncEvent::AuthChanged { account_id, requires_reauth: true });
                        return;
                    }
                    Err(_) => false,
                };
                let pause = if did_work { PREFETCH_WORK_PAUSE } else { PREFETCH_IDLE_INTERVAL };
                tokio::select! {
                    _ = tokio::time::sleep(pause) => {},
                    _ = token.cancelled() => break,
                }
            }
        });
    }
```

- [ ] **Step 3: Wire it into `spawn_account`** — in `spawn_account`, after the `workers.lock()` guard block (which inserts the token and early-returns if the worker already exists) and before the existing `tokio::spawn(async move { ... })` sync loop, add:

```rust
        self.spawn_prefetch(account_id, token.clone());
```

- [ ] **Step 4: Verify build + existing engine/sync tests**

Run: `cargo test -p am-sync` and `cargo build --workspace`
Expected: clean; `spawn_then_stop_removes_worker_and_token_is_cancelled` and `shutdown_cancels_all_tokens` still pass (the shared token cancels the prefetch task too).

- [ ] **Step 5: Commit**

```bash
git add crates/am-sync/src/engine.rs
git commit -m "feat(sync): dedicated per-account body prefetch task"
```

---

## Task 9: frontend data layer — prefetch.ts + queries

**Files:**
- Create: `src/features/mailbox/prefetch.ts`
- Modify: `src/ipc/queries.ts`
- Test: `src/features/mailbox/prefetch.test.ts`

**Interfaces:**
- Produces (prefetch.ts): `prefetchBodiesKey(accountId)`, `prefetchFoldersKey(accountId)`, `parsePrefetchFoldersMap(settings): Map<number, number[]>`, `togglePrefetchedIds(ids, folderId)`, `isFolderPrefetched(map, accountId, folderId)`, `parseAccountPrefetch(settings, accountId): boolean`.
- Produces (queries.ts): `usePrefetchFoldersMap()`, `useToggleFolderPrefetch()`, `useAccountPrefetch(accountId)`, `useSetAccountPrefetch()`.

- [ ] **Step 1: Write failing tests** — create `src/features/mailbox/prefetch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  isFolderPrefetched,
  parseAccountPrefetch,
  parsePrefetchFoldersMap,
  prefetchBodiesKey,
  prefetchFoldersKey,
  togglePrefetchedIds,
} from "./prefetch";

describe("prefetch settings helpers", () => {
  it("builds per-account keys", () => {
    expect(prefetchBodiesKey(5)).toBe("prefetch.bodies.5");
    expect(prefetchFoldersKey(5)).toBe("prefetch.folders.5");
  });

  it("parses the folders map and ignores junk", () => {
    const map = parsePrefetchFoldersMap([
      ["prefetch.folders.1", "[3,7]"],
      ["prefetch.folders.2", "not json"],
      ["other", "x"],
    ]);
    expect(map.get(1)).toEqual([3, 7]);
    expect(isFolderPrefetched(map, 1, 3)).toBe(true);
    expect(isFolderPrefetched(map, 1, 9)).toBe(false);
    expect(isFolderPrefetched(map, 2, 1)).toBe(false);
  });

  it("toggles folder ids", () => {
    expect(togglePrefetchedIds([3], 7)).toEqual([3, 7]);
    expect(togglePrefetchedIds([3, 7], 7)).toEqual([3]);
  });

  it("parses the master toggle", () => {
    expect(parseAccountPrefetch([["prefetch.bodies.1", "true"]], 1)).toBe(true);
    expect(parseAccountPrefetch([["prefetch.bodies.1", "false"]], 1)).toBe(false);
    expect(parseAccountPrefetch([], 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/features/mailbox/prefetch.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/features/mailbox/prefetch.ts` (mirrors `pinned.ts`):

```ts
const BODIES_KEY_PREFIX = "prefetch.bodies.";
const FOLDERS_KEY_PREFIX = "prefetch.folders.";

export function prefetchBodiesKey(accountId: number): string {
  return `${BODIES_KEY_PREFIX}${accountId}`;
}

export function prefetchFoldersKey(accountId: number): string {
  return `${FOLDERS_KEY_PREFIX}${accountId}`;
}

export function parsePrefetchFoldersMap(settings: [string, string][]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const [key, value] of settings) {
    if (!key.startsWith(FOLDERS_KEY_PREFIX)) continue;
    const accountId = Number(key.slice(FOLDERS_KEY_PREFIX.length));
    if (!Number.isInteger(accountId)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) {
      map.set(accountId, parsed.filter((x): x is number => typeof x === "number"));
    }
  }
  return map;
}

export function togglePrefetchedIds(ids: number[], folderId: number): number[] {
  return ids.includes(folderId) ? ids.filter((id) => id !== folderId) : [...ids, folderId];
}

export function isFolderPrefetched(
  map: Map<number, number[]>,
  accountId: number,
  folderId: number,
): boolean {
  return map.get(accountId)?.includes(folderId) ?? false;
}

export function parseAccountPrefetch(settings: [string, string][], accountId: number): boolean {
  const key = prefetchBodiesKey(accountId);
  const found = settings.find(([k]) => k === key);
  return found ? found[1] === "true" : false;
}
```

- [ ] **Step 4: Add the query hooks** to `src/ipc/queries.ts`. First extend the prefetch import line at the top:

```ts
import {
  parsePrefetchFoldersMap,
  prefetchFoldersKey,
  togglePrefetchedIds,
  prefetchBodiesKey,
} from "../features/mailbox/prefetch";
```

  Then add the hooks (near `useTogglePinnedFolder` / `useImageAutoload`):

```ts
export function usePrefetchFoldersMap() {
  return useQuery({
    queryKey: ["prefetch-folders"],
    queryFn: () =>
      commands.getSettings().then(unwrap).then((all) => parsePrefetchFoldersMap(all)),
  });
}

export function useToggleFolderPrefetch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ accountId, folderId }: { accountId: number; folderId: number }) => {
      const all = await commands.getSettings().then(unwrap);
      const current = parsePrefetchFoldersMap(all).get(accountId) ?? [];
      const next = togglePrefetchedIds(current, folderId);
      await commands.setSetting(prefetchFoldersKey(accountId), JSON.stringify(next)).then(unwrap);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prefetch-folders"] });
    },
  });
}

export function useAccountPrefetch(accountId: number | null) {
  return useQuery({
    queryKey: ["prefetch-bodies", accountId],
    queryFn: () =>
      commands.getSettings().then(unwrap).then((all) => {
        const key = prefetchBodiesKey(accountId as number);
        const found = all.find(([k]) => k === key);
        return found ? found[1] === "true" : false;
      }),
    enabled: accountId != null,
  });
}

export function useSetAccountPrefetch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, value }: { accountId: number; value: boolean }) =>
      commands.setSetting(prefetchBodiesKey(accountId), value ? "true" : "false").then(unwrap),
    onSuccess: (_data, { accountId }) => {
      queryClient.invalidateQueries({ queryKey: ["prefetch-bodies", accountId] });
    },
  });
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/features/mailbox/prefetch.test.ts && npm run build`
Expected: PASS + clean tsc/vite build.

- [ ] **Step 6: Commit**

```bash
git add src/features/mailbox/prefetch.ts src/features/mailbox/prefetch.test.ts src/ipc/queries.ts
git commit -m "feat(mailbox): prefetch settings helpers and query hooks"
```

---

## Task 10: folder context-menu toggle

**Files:**
- Modify: `src/features/mailbox/MailboxRail.tsx`
- Test: `src/features/mailbox/MailboxRail.folder-actions.test.tsx`

**Interfaces:**
- Consumes: `usePrefetchFoldersMap`, `useToggleFolderPrefetch`, `isFolderPrefetched`.

- [ ] **Step 1: Write a failing test** — append to `MailboxRail.folder-actions.test.tsx` a case asserting that right-clicking a custom folder shows a "Pobieraj treść offline" item, and that clicking it calls the toggle. Mirror the existing folder-actions test setup (it already renders `MailboxRail` with a mocked store/queries and opens the context menu). Minimal assertion:

```tsx
  it("offers an offline-prefetch toggle in the folder context menu", async () => {
    renderRail(); // existing helper in this file
    await openFolderContextMenu("Projects"); // existing helper that right-clicks a custom folder
    expect(screen.getByRole("menuitem", { name: /Pobieraj treść offline/i })).toBeTruthy();
  });
```

  If this file has no such helpers, follow the pattern already used by `MailboxRail.pinned.test.tsx` (it right-clicks a folder and asserts the "Przypnij" menuitem) and copy its render/setup verbatim, swapping the asserted label.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/features/mailbox/MailboxRail.folder-actions.test.tsx`
Expected: FAIL (no such menu item).

- [ ] **Step 3: Implement** — in `MailboxRail.tsx`:

  Add hooks near the existing `usePinnedMap()` / `useTogglePinnedFolder()` (around line 192):

```tsx
  const prefetchMap = usePrefetchFoldersMap().data ?? new Map<number, number[]>();
  const toggleFolderPrefetch = useToggleFolderPrefetch();
```

  Add the imports (extend the queries import block and the pinned import block):

```tsx
  usePrefetchFoldersMap,
  useToggleFolderPrefetch,
```

```tsx
import { selectInboxes, selectPinnedByAccount, isFolderPinned } from "./pinned";
import { isFolderPrefetched } from "./prefetch";
```

  Append an item inside `buildFolderMenuItems(folder)` (before `return items;`):

```tsx
    const prefetched = isFolderPrefetched(prefetchMap, folder.account_id, folder.id);
    items.push({
      label: prefetched ? "Nie pobieraj treści offline" : "Pobieraj treść offline",
      onClick: () =>
        toggleFolderPrefetch.mutate({ accountId: folder.account_id, folderId: folder.id }),
    });
```

- [ ] **Step 4: Run to verify it passes + typecheck**

Run: `npx vitest run src/features/mailbox/MailboxRail.folder-actions.test.tsx && npm run build`
Expected: PASS + clean build. If the full suite needs the new query mocked, add `usePrefetchFoldersMap`/`useToggleFolderPrefetch` to the test's `vi.mock("../../ipc/queries", ...)` like the pinned hooks.

- [ ] **Step 5: Commit**

```bash
git add src/features/mailbox/MailboxRail.tsx src/features/mailbox/MailboxRail.folder-actions.test.tsx
git commit -m "feat(rail): offline-prefetch toggle in folder context menu"
```

---

## Task 11: Settings → Accounts master toggle + folder list

**Files:**
- Modify: `src/features/settings/AccountsSection.tsx`
- Test: `src/features/settings/AccountsSection.test.tsx`

**Interfaces:**
- Consumes: `useAccountPrefetch`, `useSetAccountPrefetch`, `usePrefetchFoldersMap`, `useToggleFolderPrefetch`, `useFolders`/`useAllAccountFolders`.

- [ ] **Step 1: Write a failing test** — append to `AccountsSection.test.tsx`. Mirror the file's existing render (it mocks `../../ipc/queries`). Assert the master switch renders and toggles:

```tsx
  it("renders the offline-prefetch master switch", () => {
    renderSection(); // existing helper / inline render used by other tests in this file
    expect(
      screen.getByRole("switch", { name: /Download message bodies for offline/i }),
    ).toBeTruthy();
  });
```

  Ensure the test's queries mock returns `useAccountPrefetch: () => ({ data: false })`, `useSetAccountPrefetch: () => ({ mutate: vi.fn() })`, `usePrefetchFoldersMap: () => ({ data: new Map() })`, `useToggleFolderPrefetch: () => ({ mutate: vi.fn() })`, and a `useFolders`/`useAllAccountFolders` returning an empty list — matching how this file already stubs `useImageAutoload`/`useSetImageAutoload`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/features/settings/AccountsSection.test.tsx`
Expected: FAIL (no such switch).

- [ ] **Step 3: Implement** — add a `AccountPrefetchControls` component in `AccountsSection.tsx` (mirrors `AccountImageToggle`) and render it next to `<AccountImageToggle .../>`:

```tsx
import {
  useAccounts,
  useReorderAccounts,
  useRemoveAccount,
  useBeginReauth,
  useUpdateAccount,
  useAccountEndpoints,
  useImageAutoload,
  useSetImageAutoload,
  useAccountPrefetch,
  useSetAccountPrefetch,
  usePrefetchFoldersMap,
  useToggleFolderPrefetch,
  useFolders,
} from "../../ipc/queries";
import { isFolderPrefetched } from "../mailbox/prefetch";
```

```tsx
function AccountPrefetchControls({ accountId, email }: { accountId: number; email: string }) {
  const { data: enabled = false } = useAccountPrefetch(accountId);
  const setEnabled = useSetAccountPrefetch();
  const { data: folders = [] } = useFolders(accountId);
  const prefetchMap = usePrefetchFoldersMap().data ?? new Map<number, number[]>();
  const toggleFolder = useToggleFolderPrefetch();

  return (
    <div className="accounts-settings__prefetch">
      <div className="appearance-toggle">
        <div className="appearance-toggle__text">
          <div className="appearance-toggle__label">Download message bodies for offline</div>
          <div className="appearance-toggle__hint">
            Bodies for the selected folders download in the background after headers.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`Download message bodies for offline for ${email}`}
          className={`switch${enabled ? " switch--on" : ""}`}
          onClick={() => setEnabled.mutate({ accountId, value: !enabled })}
        >
          <span className="switch__knob" />
        </button>
      </div>

      {enabled && (
        <ul className="accounts-settings__prefetch-folders">
          {folders.map((folder) => (
            <li key={folder.id}>
              <label className="accounts-settings__check">
                <input
                  type="checkbox"
                  aria-label={`Prefetch ${folder.name}`}
                  checked={isFolderPrefetched(prefetchMap, accountId, folder.id)}
                  onChange={() => toggleFolder.mutate({ accountId, folderId: folder.id })}
                />
                <span>{folder.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

  Render it under the existing image toggle inside the account `<li>`:

```tsx
            <AccountImageToggle accountId={account.id} email={account.email} />
            <AccountPrefetchControls accountId={account.id} email={account.email} />
```

  `useFolders(accountId: number | null)` already exists in `queries.ts` (line 50; backs `listFolders(account_id)`) — used directly here.

- [ ] **Step 4: Run to verify it passes + typecheck**

Run: `npx vitest run src/features/settings/AccountsSection.test.tsx && npm run build`
Expected: PASS + clean build.

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/AccountsSection.tsx src/features/settings/AccountsSection.test.tsx
git commit -m "feat(settings): offline-prefetch master toggle and folder selection"
```

---

## Task 12: progress indicator — store slice, event listener, rail footer

**Files:**
- Modify: `src/app/store.ts`
- Modify: `src/ipc/events.ts`
- Modify: `src/features/mailbox/MailboxRail.tsx`
- Test: `src/ipc/events.test.tsx`

**Interfaces:**
- Consumes: `events.prefetchProgress` (Task 4 bindings).
- Produces: store `prefetchProgress: Record<number, { done: number; total: number }>` + `setPrefetchProgress(accountId, done, total)`; a rail-footer line for the selected account when `done < total`.

- [ ] **Step 1: Add the store slice** — in `src/app/store.ts`:

  In the `UiState` interface (near `notificationsEnabled`):

```ts
  prefetchProgress: Record<number, { done: number; total: number }>;
  setPrefetchProgress: (accountId: number, done: number, total: number) => void;
```

  In the `create<UiState>((set) => ({ ... }))` initializer (near the notifications defaults):

```ts
  prefetchProgress: {},
```

  And the setter (near `setNotificationsEnabled`):

```ts
  setPrefetchProgress: (accountId, done, total) =>
    set((s) => ({ prefetchProgress: { ...s.prefetchProgress, [accountId]: { done, total } } })),
```

- [ ] **Step 2: Write a failing test** — append to `src/ipc/events.test.tsx` a case that captures the `prefetchProgress` listener and asserts the store is updated. Mirror the existing `vi.hoisted` listener-capture used for `newMessages`:

```tsx
  it("records prefetch progress into the store", async () => {
    renderWithEvents(); // existing helper that mounts useSyncEvents
    const payload = { account_id: 1, done: 4, total: 10 };
    await emitPrefetchProgress(payload); // invokes the captured events.prefetchProgress listener
    expect(useUiStore.getState().prefetchProgress[1]).toEqual({ done: 4, total: 10 });
  });
```

  Extend the file's `vi.mock("./bindings", ...)` so `events.prefetchProgress.listen` captures its callback into a hoisted ref (same shape as the existing `events.newMessages.listen` mock), and add an `emitPrefetchProgress` helper that calls it with `{ payload }`.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/ipc/events.test.tsx`
Expected: FAIL (no listener wired; store field undefined).

- [ ] **Step 4: Add the listener** in `src/ipc/events.ts` (inside `useSyncEvents`, alongside the others):

```ts
    const prefetchPromise = events.prefetchProgress.listen((event) => {
      const { account_id, done, total } = event.payload;
      useUiStore.getState().setPrefetchProgress(account_id, done, total);
      queryClient.invalidateQueries({ queryKey: ["messages"] });
    });
```

  And in the cleanup return:

```ts
      prefetchPromise.then((unlisten) => unlisten());
```

- [ ] **Step 5: Add the footer indicator** in `MailboxRail.tsx` — read the slice and the selected/header account, render a line in `<footer className="rail__footer">` when there is in-progress work:

```tsx
  const prefetchProgress = useUiStore((s) => s.prefetchProgress);
```

```tsx
      <footer className="rail__footer">
        {headerAccount && prefetchProgress[headerAccount.id] &&
          prefetchProgress[headerAccount.id].done < prefetchProgress[headerAccount.id].total && (
            <div className="rail__prefetch-status" role="status">
              Downloading bodies: {prefetchProgress[headerAccount.id].done} /{" "}
              {prefetchProgress[headerAccount.id].total}
            </div>
          )}
        {/* existing footer buttons unchanged */}
```

  (Keep the existing Add-account and Settings buttons; only add the status line above them.)

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/ipc/events.test.tsx && npm run build`
Expected: PASS + clean build. If `MailboxRail.test.tsx` mocks the store, add `prefetchProgress: {}` and `setPrefetchProgress: vi.fn()` to its `UiState` mock to satisfy tsc.

- [ ] **Step 7: Commit**

```bash
git add src/app/store.ts src/ipc/events.ts src/features/mailbox/MailboxRail.tsx src/ipc/events.test.tsx
git commit -m "feat(rail): background prefetch progress indicator"
```

---

## Final Verification

- [ ] `cargo test --workspace` (incl. GreenMail integration when Docker is available) — green.
- [ ] `npm run build` (tsc + vite) — clean.
- [ ] `npx vitest run` — all frontend tests green.
- [ ] Manual smoke (optional, real account): enable prefetch for an account + a folder in Settings → Accounts; within ~1 min the rail footer shows "Downloading bodies: n / m"; open a never-opened message offline and confirm its body renders; confirm the message stays unread on the server.

## Self-Review Notes (for the executor)

- Storage is the `settings` table (per-account keys), **not** `accounts.settings` (which holds endpoints) and **not** a new `folders` column for selection. Only `folders.backfill_complete` is a column (backend bookkeeping).
- `BODY.PEEK[]` is mandatory in `fetch_bodies` — a plain `BODY[]` would mark mail read.
- Adding the `SyncEvent::PrefetchProgress` variant (Task 4) and its `sink.rs` arm must land together or the workspace won't build.
- `persist_body` is the single shared store path; `fetch_and_store_body` (lazy) and `run_prefetch_batch` (background) both call it, so both set `body_state`.
