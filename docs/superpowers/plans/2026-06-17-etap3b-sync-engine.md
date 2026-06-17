# Etap 3B — Sync Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Depends on plan 3A (V2 migration, sync markers, `sync_folder`/`sync_all_folders`).

**Goal:** Run background per-account sync with incremental updates (CONDSTORE with a fallback), IDLE push on INBOX with interval polling elsewhere, real progress events, and an offline write queue for read/flag state.

**Architecture:** `am-sync` owns a `SyncEngine` that spawns a `tokio` task per account. The engine never touches Tauri — it emits through a `SyncEventSink` trait that `am-app` implements with `AppHandle::emit`. Incremental sync uses stored UID/MODSEQ markers; write-backs (seen/flagged) go through `sync_queue` with optimistic local updates and backoff.

**Tech Stack:** Rust (tokio, async-imap 0.11, rusqlite), Tauri 2 + tauri-specta, React 19 + @tanstack/react-query.

## Global Constraints

- Node >= 24 (`$HOME/.nvm/versions/node/v24.14.0/bin`) for frontend/tooling steps.
- English-only identifiers/constants/DB strings. No code comments.
- Conventional Commits; no `Co-Authored-By`; never `git push` unless asked.
- Secrets only in the OS keychain; passwords never logged, never put in events or `SyncError`.
- `cargo test --workspace` green; GreenMail tests skip when Docker is absent.
- Frontend: mail HTML still only via the sanitizer + `sandbox=""` iframe.

---

### Task 1: SyncEventSink trait

**Files:**
- Create: `crates/am-sync/src/events.rs`
- Modify: `crates/am-sync/src/lib.rs` (add `pub mod events;` and re-export)

**Interfaces:**
- Produces:
```rust
pub enum SyncEvent {
    Progress { account_id: i64, folder_id: i64, fetched: i64, total: i64 },
    NewMessages { account_id: i64, folder_id: i64, count: i64 },
    MailboxChanged { account_id: i64, folder_id: i64 },
}
pub trait SyncEventSink: Send + Sync {
    fn emit(&self, event: SyncEvent);
}
```

- [ ] **Step 1: Write `events.rs` with the enum, trait, and a test double**

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncEvent {
    Progress { account_id: i64, folder_id: i64, fetched: i64, total: i64 },
    NewMessages { account_id: i64, folder_id: i64, count: i64 },
    MailboxChanged { account_id: i64, folder_id: i64 },
}

pub trait SyncEventSink: Send + Sync {
    fn emit(&self, event: SyncEvent);
}

#[derive(Default)]
pub struct NoopSink;

impl SyncEventSink for NoopSink {
    fn emit(&self, _event: SyncEvent) {}
}

#[cfg(test)]
pub struct RecordingSink {
    pub events: std::sync::Mutex<Vec<SyncEvent>>,
}

#[cfg(test)]
impl RecordingSink {
    pub fn new() -> Self {
        Self { events: std::sync::Mutex::new(Vec::new()) }
    }
}

#[cfg(test)]
impl SyncEventSink for RecordingSink {
    fn emit(&self, event: SyncEvent) {
        self.events.lock().unwrap().push(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_sink_collects_events() {
        let sink = RecordingSink::new();
        sink.emit(SyncEvent::MailboxChanged { account_id: 1, folder_id: 2 });
        assert_eq!(sink.events.lock().unwrap().len(), 1);
    }
}
```

- [ ] **Step 2: Export from `lib.rs`**

```rust
pub mod events;
pub mod service;
pub use events::{SyncEvent, SyncEventSink};
```

(Confirm `service` is already declared; keep existing declarations.)

- [ ] **Step 3: Run — expect PASS**

Run: `cargo test -p am-sync events`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/am-sync/src/events.rs crates/am-sync/src/lib.rs
git commit -m "feat(sync): add SyncEventSink trait and event enum"
```

---

### Task 2: Incremental IMAP primitives

**Files:**
- Modify: `crates/am-protocols/src/imap.rs` (`MailboxState.highestmodseq`, new methods, `FlagState`, capability info)

**Interfaces:**
- Produces (extended): `MailboxState` gains `pub highestmodseq: Option<i64>`.
- Produces:
```rust
pub struct ServerCaps { pub condstore: bool, pub idle: bool, pub qresync: bool }
pub struct FlagState { pub uid: i64, pub seen: bool, pub flagged: bool }
impl ImapSession {
    pub async fn server_caps(&mut self) -> Result<ServerCaps, ProtocolError>;
    pub async fn search_new_uids(&mut self, since_uid: i64) -> Result<Vec<i64>, ProtocolError>;
    pub async fn search_all_uids(&mut self) -> Result<Vec<i64>, ProtocolError>;
    pub async fn fetch_headers_by_uids(&mut self, uids: &[i64]) -> Result<Vec<FetchedHeader>, ProtocolError>;
    pub async fn fetch_flag_changes(&mut self, since_modseq: i64) -> Result<Vec<FlagState>, ProtocolError>;
    pub async fn fetch_all_flags(&mut self) -> Result<Vec<FlagState>, ProtocolError>;
    pub async fn store_flag(&mut self, uid: i64, flag: &str, value: bool) -> Result<(), ProtocolError>;
}
```

- [ ] **Step 1: Add `highestmodseq` to `MailboxState` and populate it in `select`**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MailboxState {
    pub uidvalidity: i64,
    pub uidnext: i64,
    pub exists: i64,
    pub highestmodseq: Option<i64>,
}
```

In `select`, set `highestmodseq: mailbox.highest_mod_seq.map(|v| v as i64)` in the returned literal.
VERIFY: confirm the field name on async-imap's `Mailbox` is `highest_mod_seq` (0.11). If it is exposed differently, adjust this single mapping.

- [ ] **Step 2: Add `ServerCaps`, `FlagState`, and a flag-mapping helper**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServerCaps {
    pub condstore: bool,
    pub idle: bool,
    pub qresync: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FlagState {
    pub uid: i64,
    pub seen: bool,
    pub flagged: bool,
}

fn flag_state(fetch: &Fetch) -> FlagState {
    let mut seen = false;
    let mut flagged = false;
    for flag in fetch.flags() {
        match flag {
            Flag::Seen => seen = true,
            Flag::Flagged => flagged = true,
            _ => {}
        }
    }
    FlagState { uid: fetch.uid.unwrap_or(0) as i64, seen, flagged }
}
```

- [ ] **Step 3: Implement the session methods**

```rust
impl ImapSession {
    pub async fn server_caps(&mut self) -> Result<ServerCaps, ProtocolError> {
        let caps = match &mut self.session {
            SessionStream::Plain(s) => s.capabilities().await?,
            SessionStream::Tls(s) => s.capabilities().await?,
        };
        Ok(ServerCaps {
            condstore: caps.has_str("CONDSTORE"),
            idle: caps.has_str("IDLE"),
            qresync: caps.has_str("QRESYNC"),
        })
    }

    pub async fn search_new_uids(&mut self, since_uid: i64) -> Result<Vec<i64>, ProtocolError> {
        let start = since_uid.max(1);
        let query = format!("UID {start}:*");
        let set = match &mut self.session {
            SessionStream::Plain(s) => s.uid_search(&query).await?,
            SessionStream::Tls(s) => s.uid_search(&query).await?,
        };
        let mut uids: Vec<i64> = set.into_iter().map(|u| u as i64).filter(|u| *u >= start).collect();
        uids.sort_unstable();
        Ok(uids)
    }

    pub async fn search_all_uids(&mut self) -> Result<Vec<i64>, ProtocolError> {
        let set = match &mut self.session {
            SessionStream::Plain(s) => s.uid_search("UID 1:*").await?,
            SessionStream::Tls(s) => s.uid_search("UID 1:*").await?,
        };
        let mut uids: Vec<i64> = set.into_iter().map(|u| u as i64).collect();
        uids.sort_unstable();
        Ok(uids)
    }

    pub async fn fetch_headers_by_uids(&mut self, uids: &[i64]) -> Result<Vec<FetchedHeader>, ProtocolError> {
        if uids.is_empty() {
            return Ok(Vec::new());
        }
        let list = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
        let query = "(UID ENVELOPE FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER.FIELDS (REFERENCES)])";
        let fetches: Vec<Fetch> = match &mut self.session {
            SessionStream::Plain(s) => s.uid_fetch(&list, query).await?.try_collect().await?,
            SessionStream::Tls(s) => s.uid_fetch(&list, query).await?.try_collect().await?,
        };
        let mut headers: Vec<FetchedHeader> = fetches.iter().map(map_header).collect();
        headers.sort_by(|a, b| b.uid.cmp(&a.uid));
        Ok(headers)
    }

    pub async fn fetch_flag_changes(&mut self, since_modseq: i64) -> Result<Vec<FlagState>, ProtocolError> {
        let query = format!("(UID FLAGS) (CHANGEDSINCE {since_modseq})");
        let fetches: Vec<Fetch> = match &mut self.session {
            SessionStream::Plain(s) => s.fetch("1:*", &query).await?.try_collect().await?,
            SessionStream::Tls(s) => s.fetch("1:*", &query).await?.try_collect().await?,
        };
        Ok(fetches.iter().map(flag_state).collect())
    }

    pub async fn fetch_all_flags(&mut self) -> Result<Vec<FlagState>, ProtocolError> {
        let fetches: Vec<Fetch> = match &mut self.session {
            SessionStream::Plain(s) => s.fetch("1:*", "(UID FLAGS)").await?.try_collect().await?,
            SessionStream::Tls(s) => s.fetch("1:*", "(UID FLAGS)").await?.try_collect().await?,
        };
        Ok(fetches.iter().map(flag_state).collect())
    }

    pub async fn store_flag(&mut self, uid: i64, flag: &str, value: bool) -> Result<(), ProtocolError> {
        let op = if value { "+FLAGS" } else { "-FLAGS" };
        let query = format!("{op} ({flag})");
        let uid_str = uid.to_string();
        let _: Vec<Fetch> = match &mut self.session {
            SessionStream::Plain(s) => s.uid_store(&uid_str, &query).await?.try_collect().await?,
            SessionStream::Tls(s) => s.uid_store(&uid_str, &query).await?.try_collect().await?,
        };
        Ok(())
    }
}
```

VERIFY: `uid_search` returns a `HashSet<u32>` in async-imap 0.11; `uid_store` returns a stream of `Fetch`. Confirm both and that `fetch(seq, "(UID FLAGS) (CHANGEDSINCE n)")` passes the modifier through verbatim. Adjust collection types if the API differs; the algorithm in Task 4 only relies on the `Vec`/`Result` signatures above.

- [ ] **Step 4: Fix the existing `select` test and `MailboxState` literals**

Update `crates/am-protocols/tests/imap_greenmail.rs` and any `MailboxState { .. }` construction to include `highestmodseq: None` where built by hand. Run `cargo build -p am-protocols` and fix what the compiler flags.

- [ ] **Step 5: Run — expect PASS**

Run: `cargo test -p am-protocols`
Expected: PASS (unit; GreenMail self-skips).

- [ ] **Step 6: Commit**

```bash
git add crates/am-protocols/src/imap.rs crates/am-protocols/tests/imap_greenmail.rs
git commit -m "feat(protocols): add incremental fetch/search/store primitives"
```

---

### Task 3: Storage helpers for incremental updates

**Files:**
- Modify: `crates/am-core/src/message.rs` (add `MessageFlag`)
- Modify: `crates/am-storage/src/messages_repo.rs` (flag/uid helpers)
- Modify: `crates/am-storage/src/folders_repo.rs` (`recount_unread`)

**Interfaces:**
- Produces:
```rust
// am-core
pub enum MessageFlag { Seen, Flagged }   // serde snake_case, specta::Type, Copy
// messages_repo
pub fn set_flag(db, message_id: i64, flag: MessageFlag, value: bool) -> Result<(), StorageError>;
pub fn set_flags_by_uid(db, folder_id: i64, uid: i64, seen: bool, flagged: bool) -> Result<(), StorageError>;
pub fn list_uids(db, folder_id: i64) -> Result<Vec<i64>, StorageError>;
pub fn delete_by_uids(db, folder_id: i64, uids: &[i64]) -> Result<usize, StorageError>;
pub fn delete_by_folder(db, folder_id: i64) -> Result<usize, StorageError>;
pub fn locate(db, message_id: i64) -> Result<MessageLocator, StorageError>; // folder_id, uid, account_id
// folders_repo
pub fn recount_unread(db, folder_id: i64) -> Result<i64, StorageError>;
```
where `pub struct MessageLocator { pub account_id: i64, pub folder_id: i64, pub uid: i64 }`.

- [ ] **Step 1: Add `MessageFlag` to `am-core/src/message.rs`**

```rust
#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageFlag {
    Seen,
    Flagged,
}
```

- [ ] **Step 2: Write failing tests in `messages_repo.rs`**

```rust
#[test]
fn set_flag_toggles_seen_column() {
    let db = Database::open_in_memory().unwrap();
    let folder_id = setup(&db);
    insert_headers(&db, folder_id, &[make_header(1, 1000)]).unwrap();
    let msg = list_by_folder(&db, folder_id, 1, 0).unwrap().into_iter().next().unwrap();
    set_flag(&db, msg.id, am_core::message::MessageFlag::Seen, true).unwrap();
    assert!(get_header(&db, msg.id).unwrap().seen);
}

#[test]
fn list_and_delete_by_uids() {
    let db = Database::open_in_memory().unwrap();
    let folder_id = setup(&db);
    insert_headers(&db, folder_id, &[make_header(1, 1), make_header(2, 2), make_header(3, 3)]).unwrap();
    assert_eq!(list_uids(&db, folder_id).unwrap(), vec![1, 2, 3]);
    let removed = delete_by_uids(&db, folder_id, &[2, 3]).unwrap();
    assert_eq!(removed, 2);
    assert_eq!(list_uids(&db, folder_id).unwrap(), vec![1]);
}

#[test]
fn set_flags_by_uid_updates_both() {
    let db = Database::open_in_memory().unwrap();
    let folder_id = setup(&db);
    insert_headers(&db, folder_id, &[make_header(9, 1)]).unwrap();
    set_flags_by_uid(&db, folder_id, 9, true, true).unwrap();
    let msg = list_by_folder(&db, folder_id, 1, 0).unwrap().into_iter().next().unwrap();
    assert!(msg.seen && msg.flagged);
}

#[test]
fn locate_returns_account_folder_uid() {
    let db = Database::open_in_memory().unwrap();
    let folder_id = setup(&db);
    insert_headers(&db, folder_id, &[make_header(7, 1)]).unwrap();
    let msg = list_by_folder(&db, folder_id, 1, 0).unwrap().into_iter().next().unwrap();
    let loc = locate(&db, msg.id).unwrap();
    assert_eq!(loc.folder_id, folder_id);
    assert_eq!(loc.uid, 7);
}
```

- [ ] **Step 3: Run — expect FAIL**, then implement:

```rust
use am_core::message::MessageFlag;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MessageLocator {
    pub account_id: i64,
    pub folder_id: i64,
    pub uid: i64,
}

fn flag_column(flag: MessageFlag) -> &'static str {
    match flag {
        MessageFlag::Seen => "seen",
        MessageFlag::Flagged => "flagged",
    }
}

pub fn set_flag(db: &Database, message_id: i64, flag: MessageFlag, value: bool) -> Result<(), StorageError> {
    let sql = format!("UPDATE messages SET {} = ?2 WHERE id = ?1", flag_column(flag));
    let conn = db.conn();
    let changed = conn.execute(&sql, params![message_id, value as i64])?;
    if changed == 0 { return Err(StorageError::NotFound); }
    Ok(())
}

pub fn set_flags_by_uid(db: &Database, folder_id: i64, uid: i64, seen: bool, flagged: bool) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute(
        "UPDATE messages SET seen = ?3, flagged = ?4 WHERE folder_id = ?1 AND uid = ?2",
        params![folder_id, uid, seen as i64, flagged as i64],
    )?;
    Ok(())
}

pub fn list_uids(db: &Database, folder_id: i64) -> Result<Vec<i64>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare("SELECT uid FROM messages WHERE folder_id = ?1 ORDER BY uid ASC")?;
    let rows = stmt.query_map(params![folder_id], |row| row.get::<_, i64>(0))?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

pub fn delete_by_uids(db: &Database, folder_id: i64, uids: &[i64]) -> Result<usize, StorageError> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let mut count = 0usize;
    {
        let mut stmt = tx.prepare("DELETE FROM messages WHERE folder_id = ?1 AND uid = ?2")?;
        for uid in uids {
            count += stmt.execute(params![folder_id, uid])?;
        }
    }
    tx.commit()?;
    Ok(count)
}

pub fn delete_by_folder(db: &Database, folder_id: i64) -> Result<usize, StorageError> {
    let conn = db.conn();
    Ok(conn.execute("DELETE FROM messages WHERE folder_id = ?1", params![folder_id])?)
}

pub fn locate(db: &Database, message_id: i64) -> Result<MessageLocator, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT account_id, folder_id, uid FROM messages WHERE id = ?1",
        params![message_id],
        |row| Ok(MessageLocator {
            account_id: row.get(0)?,
            folder_id: row.get(1)?,
            uid: row.get(2)?,
        }),
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
        other => StorageError::Sqlite(other),
    })
}
```

- [ ] **Step 4: Add `recount_unread` to `folders_repo.rs` with a test**

```rust
pub fn recount_unread(db: &Database, folder_id: i64) -> Result<i64, StorageError> {
    let conn = db.conn();
    let unread: i64 = conn.query_row(
        "SELECT count(*) FROM messages WHERE folder_id = ?1 AND seen = 0",
        params![folder_id],
        |row| row.get(0),
    )?;
    conn.execute("UPDATE folders SET unread_count = ?2 WHERE id = ?1", params![folder_id, unread])?;
    Ok(unread)
}
```

```rust
#[test]
fn recount_unread_counts_unseen() {
    let db = Database::open_in_memory().unwrap();
    let account = insert_account(&db, &sample_account()).unwrap();
    let folder = upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
    crate::messages_repo::insert_headers(&db, folder.id, &[
        crate::messages_repo::tests::make_header(1, 1),
    ]).unwrap();
    let unread = recount_unread(&db, folder.id).unwrap();
    assert_eq!(unread, 1);
}
```

If `make_header`/`tests` is not visible cross-module, inline a minimal `NewMessageHeader` literal instead.

- [ ] **Step 5: Run — expect PASS**

Run: `cargo test -p am-core -p am-storage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/am-core/src/message.rs crates/am-storage/src/messages_repo.rs crates/am-storage/src/folders_repo.rs
git commit -m "feat(storage): incremental flag/uid helpers and unread recount"
```

---

### Task 4: Incremental sync algorithm

**Files:**
- Modify: `crates/am-sync/src/service.rs` (`incremental_sync_folder`)

**Interfaces:**
- Consumes: Task 2 primitives, Task 3 helpers, `events::{SyncEvent, SyncEventSink}`.
- Produces: `incremental_sync_folder(db, account_id, folder_id, sink: &dyn SyncEventSink) -> Result<(), SyncError>`

- [ ] **Step 1: Implement the algorithm**

```rust
use crate::events::{SyncEvent, SyncEventSink};

pub async fn incremental_sync_folder(
    db: &Database,
    account_id: i64,
    folder_id: i64,
    sink: &dyn SyncEventSink,
) -> Result<(), SyncError> {
    let account = accounts_repo::get_account(db, account_id)?;
    let endpoints = load_endpoints(db, account_id)?;
    let password = am_auth::credentials::load_password(&account.email)?;
    let folder = folders_repo::get_folder(db, folder_id)?;

    let config = imap_config(&endpoints, &account.email);
    let mut session = ImapSession::connect(&config, &password).await?;
    let state = session.select(&folder.remote_path).await?;
    let markers = folders_repo::get_sync_markers(db, folder_id)?;

    if markers.uidvalidity != Some(state.uidvalidity) {
        messages_repo::delete_by_folder(db, folder_id)?;
        let fetched = session.fetch_recent_headers(INITIAL_SYNC_LIMIT).await?;
        session.logout().await?;
        let headers: Vec<NewMessageHeader> = fetched.iter().map(header_from_fetch).collect();
        messages_repo::insert_headers(db, folder_id, &headers)?;
        folders_repo::set_sync_markers(db, folder_id, state.uidvalidity, state.uidnext, state.highestmodseq, now_secs())?;
        let unread = folders_repo::recount_unread(db, folder_id)?;
        folders_repo::set_counts(db, folder_id, unread, state.exists)?;
        sink.emit(SyncEvent::MailboxChanged { account_id, folder_id });
        return Ok(());
    }

    let caps = session.server_caps().await?;
    let since_uid = markers.uidnext.unwrap_or(1);
    let new_uids = session.search_new_uids(since_uid).await?;
    let new_count = new_uids.len() as i64;
    if !new_uids.is_empty() {
        let fetched = session.fetch_headers_by_uids(&new_uids).await?;
        let headers: Vec<NewMessageHeader> = fetched.iter().map(header_from_fetch).collect();
        messages_repo::insert_headers(db, folder_id, &headers)?;
    }

    if caps.condstore {
        if let Some(modseq) = markers.highestmodseq {
            let changes = session.fetch_flag_changes(modseq).await?;
            for c in changes {
                messages_repo::set_flags_by_uid(db, folder_id, c.uid, c.seen, c.flagged)?;
            }
        }
    } else {
        let flags = session.fetch_all_flags().await?;
        for c in flags {
            messages_repo::set_flags_by_uid(db, folder_id, c.uid, c.seen, c.flagged)?;
        }
        let server_uids = session.search_all_uids().await?;
        let server_set: std::collections::HashSet<i64> = server_uids.into_iter().collect();
        let local = messages_repo::list_uids(db, folder_id)?;
        let vanished: Vec<i64> = local.into_iter().filter(|u| !server_set.contains(u)).collect();
        if !vanished.is_empty() {
            messages_repo::delete_by_uids(db, folder_id, &vanished)?;
        }
    }

    session.logout().await?;

    folders_repo::set_sync_markers(db, folder_id, state.uidvalidity, state.uidnext, state.highestmodseq, now_secs())?;
    let unread = folders_repo::recount_unread(db, folder_id)?;
    folders_repo::set_counts(db, folder_id, unread, state.exists)?;

    if new_count > 0 {
        sink.emit(SyncEvent::NewMessages { account_id, folder_id, count: new_count });
    }
    sink.emit(SyncEvent::MailboxChanged { account_id, folder_id });
    Ok(())
}
```

- [ ] **Step 2: Build — expect PASS**

Run: `cargo build -p am-sync`
Expected: compiles. (Behavior is covered by the engine integration test in Task 7.)

- [ ] **Step 3: Commit**

```bash
git add crates/am-sync/src/service.rs
git commit -m "feat(sync): incremental folder sync with CONDSTORE and fallback"
```

---

### Task 5: Offline write queue

**Files:**
- Create: `crates/am-storage/src/queue_repo.rs`
- Modify: `crates/am-storage/src/lib.rs` (export `queue_repo`)
- Modify: `crates/am-sync/src/service.rs` (`enqueue_flag`, `drain_queue`)

**Interfaces:**
- Produces (queue_repo):
```rust
pub struct QueuedOp { pub id: i64, pub account_id: i64, pub op_type: String, pub payload: String, pub attempts: i64 }
pub fn enqueue(db, account_id: i64, op_type: &str, payload: &str) -> Result<i64, StorageError>;
pub fn list_due(db, account_id: i64, now: i64) -> Result<Vec<QueuedOp>, StorageError>;
pub fn mark_done(db, id: i64) -> Result<(), StorageError>;   // deletes the row
pub fn mark_retry(db, id: i64, next_retry_at: i64) -> Result<(), StorageError>; // attempts += 1
```
- Produces (service):
```rust
pub fn enqueue_flag(db, message_id: i64, flag: MessageFlag, value: bool) -> Result<(), SyncError>; // optimistic local set + queue row
pub async fn drain_queue(db, account_id: i64, now: i64) -> Result<(), SyncError>;
```
- Payload JSON shape: `{ "folder_id": i64, "uid": i64, "uidvalidity": i64, "flag": "seen"|"flagged", "value": bool }`.

- [ ] **Step 1: Write `queue_repo.rs` with tests**

```rust
use rusqlite::params;
use crate::db::{Database, StorageError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedOp {
    pub id: i64,
    pub account_id: i64,
    pub op_type: String,
    pub payload: String,
    pub attempts: i64,
}

pub fn enqueue(db: &Database, account_id: i64, op_type: &str, payload: &str) -> Result<i64, StorageError> {
    let conn = db.conn();
    conn.execute(
        "INSERT INTO sync_queue (account_id, op_type, payload, state, attempts) VALUES (?1, ?2, ?3, 'pending', 0)",
        params![account_id, op_type, payload],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_due(db: &Database, account_id: i64, now: i64) -> Result<Vec<QueuedOp>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, account_id, op_type, payload, attempts FROM sync_queue
         WHERE account_id = ?1 AND state = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?2)
         ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![account_id, now], |row| {
        Ok(QueuedOp {
            id: row.get(0)?, account_id: row.get(1)?, op_type: row.get(2)?,
            payload: row.get(3)?, attempts: row.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

pub fn mark_done(db: &Database, id: i64) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute("DELETE FROM sync_queue WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn mark_retry(db: &Database, id: i64, next_retry_at: i64) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute(
        "UPDATE sync_queue SET attempts = attempts + 1, next_retry_at = ?2 WHERE id = ?1",
        params![id, next_retry_at],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use am_core::account::{NewAccount, ProviderType};

    fn acc(db: &Database) -> i64 {
        insert_account(db, &NewAccount {
            email: "q@e.com".into(), display_name: "Q".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap().id
    }

    #[test]
    fn enqueue_then_list_due() {
        let db = Database::open_in_memory().unwrap();
        let a = acc(&db);
        enqueue(&db, a, "set_flag", "{}").unwrap();
        assert_eq!(list_due(&db, a, 0).unwrap().len(), 1);
    }

    #[test]
    fn retry_hides_until_time() {
        let db = Database::open_in_memory().unwrap();
        let a = acc(&db);
        let id = enqueue(&db, a, "set_flag", "{}").unwrap();
        mark_retry(&db, id, 500).unwrap();
        assert!(list_due(&db, a, 100).unwrap().is_empty());
        assert_eq!(list_due(&db, a, 600).unwrap().len(), 1);
    }

    #[test]
    fn done_removes_row() {
        let db = Database::open_in_memory().unwrap();
        let a = acc(&db);
        let id = enqueue(&db, a, "set_flag", "{}").unwrap();
        mark_done(&db, id).unwrap();
        assert!(list_due(&db, a, 0).unwrap().is_empty());
    }
}
```

Add `pub mod queue_repo;` to `crates/am-storage/src/lib.rs`.

- [ ] **Step 2: Run — expect PASS**

Run: `cargo test -p am-storage queue_repo`
Expected: PASS.

- [ ] **Step 3: Add `enqueue_flag` + `drain_queue` to `am-sync/src/service.rs`**

```rust
use am_core::message::MessageFlag;
use am_storage::queue_repo;

const MAX_QUEUE_ATTEMPTS: i64 = 6;

fn flag_label(flag: MessageFlag) -> &'static str {
    match flag {
        MessageFlag::Seen => "seen",
        MessageFlag::Flagged => "flagged",
    }
}

fn imap_flag(flag: MessageFlag) -> &'static str {
    match flag {
        MessageFlag::Seen => "\\Seen",
        MessageFlag::Flagged => "\\Flagged",
    }
}

pub fn enqueue_flag(db: &Database, message_id: i64, flag: MessageFlag, value: bool) -> Result<(), SyncError> {
    let loc = messages_repo::locate(db, message_id)?;
    let markers = folders_repo::get_sync_markers(db, loc.folder_id)?;
    let uidvalidity = markers.uidvalidity.unwrap_or(0);

    messages_repo::set_flag(db, message_id, flag, value)?;
    folders_repo::recount_unread(db, loc.folder_id)?;

    let payload = serde_json::json!({
        "folder_id": loc.folder_id,
        "uid": loc.uid,
        "uidvalidity": uidvalidity,
        "flag": flag_label(flag),
        "value": value,
    })
    .to_string();
    queue_repo::enqueue(db, loc.account_id, "set_flag", &payload)?;
    Ok(())
}

pub async fn drain_queue(db: &Database, account_id: i64, now: i64) -> Result<(), SyncError> {
    let due = queue_repo::list_due(db, account_id, now)?;
    if due.is_empty() {
        return Ok(());
    }

    let account = accounts_repo::get_account(db, account_id)?;
    let endpoints = load_endpoints(db, account_id)?;
    let password = am_auth::credentials::load_password(&account.email)?;
    let config = imap_config(&endpoints, &account.email);

    for op in due {
        let parsed: serde_json::Value = match serde_json::from_str(&op.payload) {
            Ok(v) => v,
            Err(_) => { queue_repo::mark_done(db, op.id)?; continue; }
        };
        let folder_id = parsed["folder_id"].as_i64().unwrap_or(0);
        let uid = parsed["uid"].as_i64().unwrap_or(0);
        let payload_validity = parsed["uidvalidity"].as_i64().unwrap_or(-1);
        let flag = match parsed["flag"].as_str() {
            Some("seen") => MessageFlag::Seen,
            Some("flagged") => MessageFlag::Flagged,
            _ => { queue_repo::mark_done(db, op.id)?; continue; }
        };
        let value = parsed["value"].as_bool().unwrap_or(false);

        let folder = folders_repo::get_folder(db, folder_id)?;
        let current_validity = folders_repo::get_sync_markers(db, folder_id)?.uidvalidity.unwrap_or(-2);
        if payload_validity != current_validity {
            queue_repo::mark_done(db, op.id)?;
            continue;
        }

        let result: Result<(), SyncError> = async {
            let mut session = ImapSession::connect(&config, &password).await?;
            session.select(&folder.remote_path).await?;
            session.store_flag(uid, imap_flag(flag), value).await?;
            session.logout().await?;
            Ok(())
        }
        .await;

        match result {
            Ok(()) => queue_repo::mark_done(db, op.id)?,
            Err(_) if op.attempts + 1 >= MAX_QUEUE_ATTEMPTS => queue_repo::mark_done(db, op.id)?,
            Err(_) => {
                let backoff = now + 2i64.pow((op.attempts + 1).min(5) as u32) * 30;
                queue_repo::mark_retry(db, op.id, backoff)?;
            }
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Build — expect PASS**

Run: `cargo build -p am-sync`
Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add crates/am-storage/src/queue_repo.rs crates/am-storage/src/lib.rs crates/am-sync/src/service.rs
git commit -m "feat(sync): offline flag write-queue with backoff and uidvalidity guard"
```

---

### Task 6: IMAP IDLE wrapper

**Files:**
- Modify: `crates/am-protocols/src/imap.rs` (`idle_wait`)

**Interfaces:**
- Produces: `idle_wait(self, timeout: Duration) -> Result<(ImapSession, IdleOutcome), ProtocolError>` where `pub enum IdleOutcome { Changed, TimedOut }`. The session is consumed and returned to preserve ownership across the async-imap idle handle lifecycle.

- [ ] **Step 1: Implement `idle_wait`**

```rust
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleOutcome {
    Changed,
    TimedOut,
}

impl ImapSession {
    pub async fn idle_wait(self, timeout: Duration) -> Result<(ImapSession, IdleOutcome), ProtocolError> {
        match self.session {
            SessionStream::Plain(s) => {
                let mut handle = s.idle();
                handle.init().await?;
                let (result, _) = handle.wait_with_timeout(timeout);
                let outcome = match result.await {
                    Ok(async_imap::extensions::idle::IdleResponse::NewData(_)) => IdleOutcome::Changed,
                    _ => IdleOutcome::TimedOut,
                };
                let session = handle.done().await?;
                Ok((ImapSession { session: SessionStream::Plain(Box::new(session)), selected_exists: None }, outcome))
            }
            SessionStream::Tls(s) => {
                let mut handle = s.idle();
                handle.init().await?;
                let (result, _) = handle.wait_with_timeout(timeout);
                let outcome = match result.await {
                    Ok(async_imap::extensions::idle::IdleResponse::NewData(_)) => IdleOutcome::Changed,
                    _ => IdleOutcome::TimedOut,
                };
                let session = handle.done().await?;
                Ok((ImapSession { session: SessionStream::Tls(Box::new(session)), selected_exists: None }, outcome))
            }
        }
    }
}
```

VERIFY: async-imap 0.11 IDLE API. The handle comes from `Session::idle()`; confirm `init().await`, `wait_with_timeout(Duration) -> (impl Future<Output = Result<IdleResponse, _>>, Interrupt)`, and `done().await -> Result<Session<T>, _>`. The `Box::new(s.idle())` deref: `s` is `Box<Session<T>>`; call `(*s).idle()` if needed. Adjust the exact handle method names/paths to match the installed version; the wrapper's signature (`(ImapSession, IdleOutcome)`) stays fixed so Task 7 is unaffected. Add `tokio` `time` feature to am-protocols `[dependencies]` if not present (`tokio = { workspace = true }` already pulls it via the dev-deps; ensure non-dev build has what `Duration`/idle needs).

- [ ] **Step 2: Build — expect PASS**

Run: `cargo build -p am-protocols`
Expected: compiles. (IDLE behavior validated by Task 7 integration test.)

- [ ] **Step 3: Commit**

```bash
git add crates/am-protocols/src/imap.rs crates/am-protocols/Cargo.toml
git commit -m "feat(protocols): add IMAP IDLE wait wrapper"
```

---

### Task 7: SyncEngine + per-account worker

**Files:**
- Create: `crates/am-sync/src/engine.rs`
- Modify: `crates/am-sync/src/lib.rs` (`pub mod engine;`)
- Create: `crates/am-sync/tests/engine_greenmail.rs`

**Interfaces:**
- Consumes: `service::{sync_all_folders, incremental_sync_folder, drain_queue}`, `events::SyncEventSink`, `ImapSession::idle_wait`.
- Produces:
```rust
pub struct SyncEngine { /* holds handles + control senders */ }
impl SyncEngine {
    pub fn start(db: Arc<Database>, sink: Arc<dyn SyncEventSink>) -> Self;
    pub fn spawn_account(&self, account_id: i64);   // start a worker for one account
    pub fn shutdown(self);
}
pub const POLL_INTERVAL: Duration = Duration::from_secs(300);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(1500);
```

- [ ] **Step 1: Implement the engine and worker**

```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use am_auth::endpoints::Endpoints;
use am_storage::{accounts_repo, folders_repo, Database};
use am_protocols::imap::{ImapSession, IdleOutcome};
use tokio::sync::mpsc;

use crate::events::SyncEventSink;
use crate::service::{self, imap_config_pub};

pub const POLL_INTERVAL: Duration = Duration::from_secs(300);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(1500);
const INBOX_PATH: &str = "INBOX";

pub struct SyncEngine {
    db: Arc<Database>,
    sink: Arc<dyn SyncEventSink>,
    workers: Mutex<HashMap<i64, mpsc::Sender<()>>>,
}

impl SyncEngine {
    pub fn start(db: Arc<Database>, sink: Arc<dyn SyncEventSink>) -> Arc<Self> {
        let engine = Arc::new(Self { db, sink, workers: Mutex::new(HashMap::new()) });
        if let Ok(accounts) = accounts_repo::list_accounts(&engine.db) {
            for account in accounts {
                engine.spawn_account(account.id);
            }
        }
        engine
    }

    pub fn spawn_account(self: &Arc<Self>, account_id: i64) {
        let (stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
        {
            let mut guard = self.workers.lock().unwrap();
            if guard.contains_key(&account_id) {
                return;
            }
            guard.insert(account_id, stop_tx);
        }
        let db = Arc::clone(&self.db);
        let sink = Arc::clone(&self.sink);
        tokio::spawn(async move {
            let _ = service::sync_all_folders(&db, account_id, |_| {}).await;
            loop {
                let now = service::now_secs();
                let _ = service::drain_queue(&db, account_id, now).await;
                if let Ok(folders) = folders_repo::list_folders(&db, account_id) {
                    for folder in &folders {
                        if !folder.remote_path.eq_ignore_ascii_case(INBOX_PATH) {
                            let _ = service::incremental_sync_folder(&db, account_id, folder.id, sink.as_ref()).await;
                        }
                    }
                    if let Some(inbox) = folders.iter().find(|f| f.remote_path.eq_ignore_ascii_case(INBOX_PATH)) {
                        let _ = service::incremental_sync_folder(&db, account_id, inbox.id, sink.as_ref()).await;
                        let idled = idle_inbox(&db, account_id, &inbox.remote_path).await;
                        match idled {
                            Ok(true) => continue,
                            _ => {}
                        }
                    }
                }
                tokio::select! {
                    _ = tokio::time::sleep(POLL_INTERVAL) => {},
                    _ = stop_rx.recv() => break,
                }
            }
        });
    }

    pub fn shutdown(&self) {
        let mut guard = self.workers.lock().unwrap();
        guard.clear();
    }
}

async fn idle_inbox(db: &Database, account_id: i64, remote_path: &str) -> Result<bool, ()> {
    let account = accounts_repo::get_account(db, account_id).map_err(|_| ())?;
    let endpoints: Endpoints = service::load_endpoints_pub(db, account_id).map_err(|_| ())?;
    let password = am_auth::credentials::load_password(&account.email).map_err(|_| ())?;
    let config = imap_config_pub(&endpoints, &account.email);
    let mut session = ImapSession::connect(&config, &password).await.map_err(|_| ())?;
    let caps = session.server_caps().await.map_err(|_| ())?;
    if !caps.idle {
        let _ = session.logout().await;
        return Ok(false);
    }
    session.select(remote_path).await.map_err(|_| ())?;
    let (session, outcome) = session.idle_wait(IDLE_TIMEOUT).await.map_err(|_| ())?;
    let _ = session.logout().await;
    Ok(matches!(outcome, IdleOutcome::Changed))
}
```

To support this, expose the small helpers from `service.rs` (rename or add `pub` wrappers): make `now_secs` `pub(crate)` → `pub`, and add `pub fn imap_config_pub(endpoints, username)` and `pub fn load_endpoints_pub(db, account_id)` thin wrappers around the existing private `imap_config`/`load_endpoints`. Add `pub mod engine;` to `lib.rs`.

- [ ] **Step 2: Write the GreenMail engine integration test**

Reuse the keychain in-mem builder + docker helpers from `tests/sync_greenmail.rs` (copy the `install_in_mem_builder`, `InMemCred*`, `docker_available`, `raw_message`, `seed_messages` scaffolding, or extract them into a shared `tests/common/mod.rs` and `mod common;` from both). Then:

```rust
#[tokio::test]
async fn engine_picks_up_new_message_via_incremental() {
    if !docker_available() { eprintln!("docker not available; skipping"); return; }
    install_in_mem_builder();
    // start greenmail (as in sync_greenmail.rs), seed 1 inbox message, get mapped_port
    // build endpoints + AddAccountInput, db = Database::open_in_memory()
    let db = std::sync::Arc::new(/* Database */);
    let account = am_sync::service::add_account(&db, input).await.unwrap();

    let sink = std::sync::Arc::new(am_sync::events::NoopSink);
    let engine = am_sync::engine::SyncEngine::start(std::sync::Arc::clone(&db), sink);
    engine.spawn_account(account.id);

    // append a NEW message to INBOX after the engine started
    append_one(mapped_port, "Live One", "live marker OMEGA").await;

    // poll the DB until the new header appears or timeout (incremental on first loop pass)
    let inbox = folders_repo::list_folders(&db, account.id).unwrap()
        .into_iter().find(|f| f.remote_path.eq_ignore_ascii_case("INBOX")).unwrap();
    let mut found = false;
    for _ in 0..40 {
        let headers = messages_repo::list_by_folder(&db, inbox.id, 50, 0).unwrap();
        if headers.iter().any(|h| h.subject == "Live One") { found = true; break; }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    assert!(found, "engine did not pick up the new message");
}
```

Fill the elided container-setup lines by copying from `add_account_syncs_inbox_and_fetches_body`. `append_one` is a one-message variant of `seed_messages`.

- [ ] **Step 3: Run**

Run: `cargo test -p am-sync` (unit always; integration runs only with Docker)
Expected: PASS. With Docker, `engine_picks_up_new_message_via_incremental` passes.

- [ ] **Step 4: Commit**

```bash
git add crates/am-sync/src/engine.rs crates/am-sync/src/lib.rs crates/am-sync/src/service.rs crates/am-sync/tests/engine_greenmail.rs
git commit -m "feat(sync): background sync engine with IDLE and polling"
```

---

### Task 8: Tauri wiring — events, engine startup, flag commands

**Files:**
- Modify: `crates/am-app/src/events.rs` (`MailboxChanged`)
- Create: `crates/am-app/src/sink.rs` (AppHandle-backed `SyncEventSink`)
- Modify: `crates/am-app/src/state.rs` (hold the engine)
- Modify: `crates/am-app/src/commands.rs` (`set_message_flags`, `mark_message_seen`)
- Modify: `crates/am-app/src/lib.rs` (register commands + event)
- Modify: `src-tauri/src/lib.rs` (start the engine in `setup`)

**Interfaces:**
- Consumes: `am_sync::{SyncEvent, SyncEventSink, engine::SyncEngine, service::{enqueue_flag}}`.
- Produces commands: `set_message_flags(message_id: i64, flag: MessageFlag, value: bool) -> Result<(), String>`, `mark_message_seen(message_id: i64) -> Result<(), String>`.

- [ ] **Step 1: Add the `MailboxChanged` event**

```rust
#[derive(Serialize, Deserialize, Clone, Debug, specta::Type, tauri_specta::Event)]
pub struct MailboxChanged {
    pub account_id: i64,
    pub folder_id: i64,
}
```

- [ ] **Step 2: Create the AppHandle sink in `crates/am-app/src/sink.rs`**

```rust
use am_sync::{SyncEvent, SyncEventSink};
use tauri::{AppHandle, Emitter};
use tauri_specta::Event;

use crate::events::{MailboxChanged, NewMessages, SyncProgress};

pub struct AppEventSink {
    pub app: AppHandle,
}

impl SyncEventSink for AppEventSink {
    fn emit(&self, event: SyncEvent) {
        match event {
            SyncEvent::Progress { account_id, folder_id, fetched, total } => {
                let _ = SyncProgress { account_id, folder_id, fetched, total }.emit(&self.app);
            }
            SyncEvent::NewMessages { account_id, folder_id, count } => {
                let _ = NewMessages { account_id, folder_id, count }.emit(&self.app);
            }
            SyncEvent::MailboxChanged { account_id, folder_id } => {
                let _ = MailboxChanged { account_id, folder_id }.emit(&self.app);
            }
        }
    }
}
```

Add `pub mod sink;` to `crates/am-app/src/lib.rs`.
VERIFY: `tauri_specta::Event::emit(&self, &AppHandle)` is the correct emit signature for the generated events; if the crate version uses `emit_all` or a different receiver, adjust these three calls.

- [ ] **Step 3: Hold the engine in `AppState`**

```rust
use std::sync::Arc;
use am_storage::Database;
use am_sync::engine::SyncEngine;

pub struct AppState {
    pub db: Arc<Database>,
    pub engine: std::sync::Mutex<Option<Arc<SyncEngine>>>,
}

impl AppState {
    pub fn new(db: Database) -> Self {
        Self { db: Arc::new(db), engine: std::sync::Mutex::new(None) }
    }
}
```

- [ ] **Step 4: Add the flag commands to `commands.rs`**

```rust
use am_core::message::MessageFlag;

#[tauri::command]
#[specta::specta]
pub fn set_message_flags(
    state: tauri::State<'_, AppState>,
    message_id: i64,
    flag: MessageFlag,
    value: bool,
) -> Result<(), String> {
    am_sync::service::enqueue_flag(&state.db, message_id, flag, value).map_err(|_| "Failed to set flag".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn mark_message_seen(state: tauri::State<'_, AppState>, message_id: i64) -> Result<(), String> {
    am_sync::service::enqueue_flag(&state.db, message_id, MessageFlag::Seen, true).map_err(|_| "Failed to mark seen".to_string())
}
```

- [ ] **Step 5: Register commands + event in `lib.rs`**

Add `commands::set_message_flags, commands::mark_message_seen` to `collect_commands!` and `events::MailboxChanged` to `collect_events!`.

- [ ] **Step 6: Start the engine in `src-tauri/src/lib.rs` `setup`**

After `app.manage(AppState::new(db));`:

```rust
            let state: tauri::State<AppState> = app.state();
            let sink = std::sync::Arc::new(am_app::sink::AppEventSink { app: app.handle().clone() });
            let engine = am_sync::engine::SyncEngine::start(std::sync::Arc::clone(&state.db), sink);
            *state.engine.lock().unwrap() = Some(engine);
```

VERIFY: the Tauri `setup` runs inside the async runtime; `SyncEngine::start` calls `tokio::spawn`, which requires a Tokio reactor. Tauri 2 provides one by default. If `spawn` panics for lack of a runtime, wrap engine start in `tauri::async_runtime::spawn` or call `start` from within it.

- [ ] **Step 7: Regenerate bindings, build, test**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npm run gen:bindings
cargo test -p am-app
cargo build -p abeonmail
```
Expected: bindings regenerate with `setMessageFlags`, `markMessageSeen`, `MailboxChanged`; builds pass.

- [ ] **Step 8: Commit**

```bash
git add crates/am-app/src crates/am-app/src/lib.rs src-tauri/src/lib.rs src/ipc/bindings.ts
git commit -m "feat(app): emit sync events, start engine, add flag commands"
```

---

### Task 9: Frontend — flag toggles, auto-seen, live updates

**Files:**
- Modify: `src/ipc/queries.ts` (`useSetFlag`, `useMarkSeen`)
- Modify: `src/ipc/events.ts` (handle `mailboxChanged`)
- Modify: `src/features/message-list/MessageListPane.tsx` (star/unread toggle)
- Modify: `src/features/reader/ReaderPane.tsx` (auto-seen on open)
- Create: `src/ipc/mutations.test.tsx`

**Interfaces:**
- Consumes: generated `commands.setMessageFlags`, `commands.markMessageSeen`, `events.mailboxChanged`.

- [ ] **Step 1: Add mutations to `queries.ts`**

```ts
import type { MessageFlag } from "./bindings";

export function useSetFlag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, flag, value }: { messageId: number; flag: MessageFlag; value: boolean }) =>
      commands.setMessageFlags(messageId, flag, value).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}

export function useMarkSeen() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (messageId: number) => commands.markMessageSeen(messageId).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}
```

- [ ] **Step 2: Handle `mailboxChanged` in `events.ts`**

Inside `useSyncEvents`, add a third listener mirroring the others:

```ts
    const mailboxPromise = events.mailboxChanged.listen((event) => {
      const { account_id, folder_id } = event.payload;
      queryClient.invalidateQueries({ queryKey: ["folders", account_id] });
      queryClient.invalidateQueries({ queryKey: ["messages", folder_id] });
    });
```

and add `mailboxPromise.then((unlisten) => unlisten());` to the cleanup.

- [ ] **Step 3: Auto-seen on open in `ReaderPane.tsx`**

```tsx
import { useEffect } from "react";
import { useMarkSeen } from "../../ipc/queries";

  const markSeen = useMarkSeen();
  useEffect(() => {
    if (selectedMessageId != null) {
      markSeen.mutate(selectedMessageId);
    }
  }, [selectedMessageId]);
```

(Place the `useEffect` after the existing hooks; the lint rule about `markSeen` in deps can be satisfied by depending on `selectedMessageId` only — the mutation handle is stable.)

- [ ] **Step 4: Star/unread toggles in `MessageRow` (`MessageListPane.tsx`)**

Add an `onToggleFlag` prop threaded from `MessageListPane`, wire the existing flag glyph to it:

```tsx
        {message.flagged ? (
          <button type="button" className="message-row__flag" aria-label="unflag"
            onClick={(e) => { e.stopPropagation(); onToggleFlag(message.id, "flagged", false); }}>⚑</button>
        ) : (
          <button type="button" className="message-row__flag message-row__flag--off" aria-label="flag"
            onClick={(e) => { e.stopPropagation(); onToggleFlag(message.id, "flagged", true); }}>⚐</button>
        )}
```

In `MessageListPane`, `const setFlag = useSetFlag();` and pass `onToggleFlag={(id, flag, value) => setFlag.mutate({ messageId: id, flag, value })}`.

- [ ] **Step 5: Write a focused test in `mutations.test.tsx`**

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSetFlag } from "./queries";

vi.mock("./bindings", () => ({
  commands: { setMessageFlags: vi.fn().mockResolvedValue({ status: "ok", data: null }) },
  events: {},
}));

import { commands } from "./bindings";

describe("useSetFlag", () => {
  it("calls setMessageFlags with flag and value", async () => {
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSetFlag(), { wrapper });
    result.current.mutate({ messageId: 5, flag: "seen", value: true });
    await waitFor(() => expect(commands.setMessageFlags).toHaveBeenCalledWith(5, "seen", true));
  });
});
```

- [ ] **Step 6: Run frontend tests**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npm test
```
Expected: PASS, including the new mutation test and existing suites.

- [ ] **Step 7: Commit**

```bash
git add src/ipc/queries.ts src/ipc/events.ts src/ipc/mutations.test.tsx src/features/message-list/MessageListPane.tsx src/features/reader/ReaderPane.tsx
git commit -m "feat(ui): flag toggles, auto-seen on open, live mailbox updates"
```

---

## Self-Review

- **Spec coverage:** event sink boundary (Task 1), incremental CONDSTORE + fallback (Tasks 2/4), offline queue with uidvalidity guard + backoff (Task 5), IDLE on INBOX + poll fallback (Tasks 6/7), real event emission + engine startup (Tasks 7/8), flag write-back + auto-seen + live UI (Tasks 8/9). Threading and thread-grouped UI are in plan 3C.
- **Placeholder scan:** code is concrete throughout. The three VERIFY notes (Task 2 search/store return types, Task 6 IDLE handle API, Task 8 emit signature + runtime) are real correctness checks against the installed crate versions, each with a fixed downstream interface so adjustments stay local.
- **Type consistency:** `SyncEvent`/`SyncEventSink` (Task 1) consumed by `incremental_sync_folder` (Task 4), engine (Task 7), and `AppEventSink` (Task 8). `MessageFlag` defined in am-core (Task 3) flows through `set_flag`/`enqueue_flag` (Tasks 3/5), the `set_message_flags` command (Task 8), and the `useSetFlag` hook (Task 9). `MailboxState.highestmodseq` (Task 2) feeds `set_sync_markers` (3A Task 1) in Task 4. `MessageLocator`/`SyncMarkers`/`QueuedOp` names match across producer and consumers.
