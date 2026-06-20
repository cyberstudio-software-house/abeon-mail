# Archive & Delete (server-synced) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `e` archive and `#` delete email conversations, synced to the server (the message leaves the Inbox on the server and lands in Archive/Trash), from the reader and from list multi-select, with an Undo bar.

**Architecture:** Reuse the existing `sync_queue` op pattern (like `set_flag`). A command optimistically hides the message locally (`deleted = 1`) and enqueues a `move_message` op scheduled `UNDO_GRACE_SECS` in the future via `next_retry_at`. The engine's existing `drain_queue` gains a branch that performs the server move (COPY + STORE `\Deleted` + EXPUNGE), auto-creating the target folder if missing. Undo deletes the still-pending op and un-hides the row.

**Tech Stack:** Rust (rusqlite, async-imap 0.11.2, tokio), Tauri + specta commands, React + @tanstack/react-query + zustand, vitest.

## Global Constraints

- All code identifiers in English; **no code comments** (project rule). Document rationale in `docs/` only.
- Conventional Commits 1.0.0; do **not** add a Co-Authored-By line; do **not** push.
- `UNDO_GRACE_SECS = 8` (Rust, `am-sync`) and frontend `UNDO_TIMEOUT_MS = 8000` must stay equal.
- Auto-created folder names: `"Archive"` and `"Trash"` (root of the mailbox).
- The move primitive is COPY + STORE `\Deleted` + EXPUNGE (uniform, no MOVE-capability detection); works on Gmail (`[Gmail]/All Mail` already maps to `FolderType::Archive`) and generic IMAP. `UID MOVE` is a deferred optimization.
- Bindings are generated, never hand-edited: regenerate with `npm run gen:bindings`.
- Node 24 toolchain (`$HOME/.nvm/versions/node/v24.14.0/bin` on PATH) for `npm`.

---

## Task 1: `deleted = 1` actually hides a message (storage)

Add a soft-hide setter and make the folder/reader list queries exclude deleted rows. Today `smart_repo`, `labels_repo`, and `search_repo` exclude `deleted = 0`, but `threads_repo::list_for_folder` (inclusion subquery), `messages_repo::list_by_folder`, and `messages_repo::list_by_thread` do not. Without this, an archived thread stays visible in the folder view.

**Files:**
- Modify: `crates/am-storage/src/messages_repo.rs` (add `set_deleted`; fix `list_by_folder`, `list_by_thread`)
- Modify: `crates/am-storage/src/threads_repo.rs` (fix `list_for_folder` inclusion subquery)
- Test: same files' `#[cfg(test)]` modules

**Interfaces:**
- Produces: `messages_repo::set_deleted(db: &Database, message_id: i64, value: bool) -> Result<(), StorageError>`

- [ ] **Step 1: Write the failing test for `set_deleted` + folder/thread hiding**

Add to `crates/am-storage/src/messages_repo.rs` test module:

```rust
    #[test]
    fn set_deleted_hides_from_folder_and_thread_lists() {
        use am_core::message::NewMessageHeader;
        let db = Database::open_in_memory().unwrap();
        let account = crate::accounts_repo::insert_account(&db, &NewAccount {
            email: "d@e.com".into(), display_name: "D".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = crate::folders_repo::upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        let h = |uid: i64, msgid: &str| NewMessageHeader {
            uid, message_id_hdr: Some(msgid.into()), in_reply_to: None, references_hdr: None,
            from_address: "s@e.com".into(), from_name: None, subject: "S".into(), date: uid,
            seen: false, flagged: false, has_attachments: false, size: 1, snippet: "x".into(),
        };
        insert_headers(&db, folder.id, &[h(1, "<a@e>"), h(2, "<b@e>")]).unwrap();
        let ids: Vec<i64> = list_by_folder(&db, folder.id, 50, 0, i64::MAX).unwrap().iter().map(|m| m.id).collect();
        assert_eq!(ids.len(), 2);
        let tid = crate::threads_repo::create(&db, account.id, "S", 2).unwrap();
        for id in &ids { assign_thread(&db, *id, tid).unwrap(); }

        set_deleted(&db, ids[0], true).unwrap();

        assert_eq!(list_by_folder(&db, folder.id, 50, 0, i64::MAX).unwrap().len(), 1);
        assert_eq!(list_by_thread(&db, tid).unwrap().len(), 1);
        set_deleted(&db, ids[0], false).unwrap();
        assert_eq!(list_by_folder(&db, folder.id, 50, 0, i64::MAX).unwrap().len(), 2);
    }
```

Need imports in the test module: ensure `use am_core::account::{NewAccount, ProviderType};` and `use am_core::folder::FolderType;` are present (add if missing).

- [ ] **Step 2: Run it; verify it fails**

Run: `cargo test -p am-storage set_deleted_hides_from_folder_and_thread_lists`
Expected: FAIL — `set_deleted` not found (won't compile).

- [ ] **Step 3: Implement `set_deleted` and add the `deleted = 0` filters**

In `crates/am-storage/src/messages_repo.rs`, add after `set_flag` (around line 29):

```rust
pub fn set_deleted(db: &Database, message_id: i64, value: bool) -> Result<(), StorageError> {
    let conn = db.conn();
    let changed = conn.execute(
        "UPDATE messages SET deleted = ?2 WHERE id = ?1",
        params![message_id, value as i64],
    )?;
    if changed == 0 {
        return Err(StorageError::NotFound);
    }
    Ok(())
}
```

In `list_by_folder`, change the WHERE line from:
```rust
         FROM messages WHERE folder_id = ?1 AND draft = 0
```
to:
```rust
         FROM messages WHERE folder_id = ?1 AND draft = 0 AND deleted = 0
```

In `list_by_thread`, both `WHERE thread_id = ?1 AND draft = 0` occurrences become `WHERE thread_id = ?1 AND draft = 0 AND deleted = 0`.

- [ ] **Step 4: Write the failing test for `list_for_folder` thread exclusion**

Add to `crates/am-storage/src/threads_repo.rs` test module (mirror `list_for_folder_groups_thread`):

```rust
    #[test]
    fn list_for_folder_excludes_fully_deleted_thread() {
        let db = Database::open_in_memory().unwrap();
        let account = crate::accounts_repo::insert_account(&db, &sample_account()).unwrap();
        let folder = crate::folders_repo::upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        crate::messages_repo::insert_headers(&db, folder.id, &[make_header(1, 100, "<x@e>")]).unwrap();
        let headers = crate::messages_repo::list_by_folder(&db, folder.id, 10, 0, i64::MAX).unwrap();
        let tid = create(&db, account.id, "hi", 100).unwrap();
        for h in &headers { crate::messages_repo::assign_thread(&db, h.id, tid).unwrap(); }
        assert_eq!(list_for_folder(&db, folder.id, 10, 0, i64::MAX).unwrap().len(), 1);

        crate::messages_repo::set_deleted(&db, headers[0].id, true).unwrap();
        assert_eq!(list_for_folder(&db, folder.id, 10, 0, i64::MAX).unwrap().len(), 0);
    }
```

If `sample_account`/`make_header` are not in the threads_repo test module, reuse the ones already defined there (they are — see `list_for_folder_groups_thread`).

- [ ] **Step 5: Run it; verify it fails**

Run: `cargo test -p am-storage list_for_folder_excludes_fully_deleted_thread`
Expected: FAIL — second assertion gets 1, expected 0.

- [ ] **Step 6: Fix the `list_for_folder` inclusion subquery**

In `crates/am-storage/src/threads_repo.rs` `list_for_folder`, change the inclusion subquery from:
```rust
         WHERE t.id IN (SELECT DISTINCT thread_id FROM messages
                        WHERE folder_id = ?1 AND thread_id IS NOT NULL AND draft = 0
                          AND (snooze_wake_at IS NULL OR snooze_wake_at <= ?4))
```
to:
```rust
         WHERE t.id IN (SELECT DISTINCT thread_id FROM messages
                        WHERE folder_id = ?1 AND thread_id IS NOT NULL AND draft = 0 AND deleted = 0
                          AND (snooze_wake_at IS NULL OR snooze_wake_at <= ?4))
```

- [ ] **Step 7: Run the storage suite**

Run: `cargo test -p am-storage`
Expected: PASS (all, including both new tests).

- [ ] **Step 8: Commit**

```bash
git add crates/am-storage/src/messages_repo.rs crates/am-storage/src/threads_repo.rs
git commit -m "fix(storage): exclude deleted rows from folder/thread lists; add set_deleted"
```

---

## Task 2: `folders_repo::find_by_type`

Resolve an account's folder of a given type (Archive/Trash target).

**Files:**
- Modify: `crates/am-storage/src/folders_repo.rs`
- Test: same file

**Interfaces:**
- Produces: `folders_repo::find_by_type(db: &Database, account_id: i64, folder_type: FolderType) -> Result<Option<Folder>, StorageError>`

- [ ] **Step 1: Write the failing test**

Add to the `folders_repo` test module:

```rust
    #[test]
    fn find_by_type_returns_matching_or_none() {
        let db = Database::open_in_memory().unwrap();
        let account = insert_account(&db, &sample_account()).unwrap();
        upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        let arch = upsert_folder(&db, account.id, "Archive", "Archive", FolderType::Archive).unwrap();
        assert_eq!(find_by_type(&db, account.id, FolderType::Archive).unwrap().map(|f| f.id), Some(arch.id));
        assert!(find_by_type(&db, account.id, FolderType::Trash).unwrap().is_none());
    }
```

- [ ] **Step 2: Run it; verify it fails**

Run: `cargo test -p am-storage find_by_type_returns_matching_or_none`
Expected: FAIL — `find_by_type` not found.

- [ ] **Step 3: Implement `find_by_type`**

Add to `crates/am-storage/src/folders_repo.rs` (after `list_folders`):

```rust
pub fn find_by_type(db: &Database, account_id: i64, folder_type: FolderType) -> Result<Option<Folder>, StorageError> {
    let ft_str = folder_type_to_str(&folder_type);
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, account_id, remote_path, name, folder_type, unread_count, total_count
         FROM folders WHERE account_id = ?1 AND folder_type = ?2 ORDER BY id ASC LIMIT 1",
    )?;
    let mut rows = stmt.query_map(params![account_id, ft_str], row_to_folder)?;
    match rows.next() {
        Some(r) => Ok(Some(tuple_to_folder(r?)?)),
        None => Ok(None),
    }
}
```

- [ ] **Step 4: Run it; verify it passes**

Run: `cargo test -p am-storage find_by_type_returns_matching_or_none`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/am-storage/src/folders_repo.rs
git commit -m "feat(storage): add folders_repo::find_by_type"
```

---

## Task 3: `queue_repo` delayed enqueue + pending lookup

Delayed enqueue powers the undo window; the pending lookup powers undo cancellation.

**Files:**
- Modify: `crates/am-storage/src/queue_repo.rs`
- Test: same file

**Interfaces:**
- Produces:
  - `queue_repo::enqueue_at(db: &Database, account_id: i64, op_type: &str, payload: &str, next_retry_at: i64) -> Result<i64, StorageError>`
  - `queue_repo::list_pending_by_type(db: &Database, account_id: i64, op_type: &str) -> Result<Vec<QueuedOp>, StorageError>`

- [ ] **Step 1: Write the failing tests**

Add to the `queue_repo` test module:

```rust
    #[test]
    fn enqueue_at_delays_until_due() {
        let db = Database::open_in_memory().unwrap();
        let a = acc(&db);
        enqueue_at(&db, a, "move_message", "{}", 500).unwrap();
        assert!(list_due(&db, a, 100).unwrap().is_empty());
        assert_eq!(list_due(&db, a, 600).unwrap().len(), 1);
    }

    #[test]
    fn list_pending_by_type_filters() {
        let db = Database::open_in_memory().unwrap();
        let a = acc(&db);
        enqueue(&db, a, "set_flag", "{}").unwrap();
        let mv = enqueue_at(&db, a, "move_message", "{\"message_id\":7}", 0).unwrap();
        let pending = list_pending_by_type(&db, a, "move_message").unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, mv);
    }
```

- [ ] **Step 2: Run them; verify they fail**

Run: `cargo test -p am-storage enqueue_at_delays_until_due list_pending_by_type_filters`
Expected: FAIL — functions not found.

- [ ] **Step 3: Implement both functions**

Add to `crates/am-storage/src/queue_repo.rs` (after `enqueue`):

```rust
pub fn enqueue_at(db: &Database, account_id: i64, op_type: &str, payload: &str, next_retry_at: i64) -> Result<i64, StorageError> {
    let conn = db.conn();
    conn.execute(
        "INSERT INTO sync_queue (account_id, op_type, payload, state, attempts, next_retry_at) VALUES (?1, ?2, ?3, 'pending', 0, ?4)",
        params![account_id, op_type, payload, next_retry_at],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_pending_by_type(db: &Database, account_id: i64, op_type: &str) -> Result<Vec<QueuedOp>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, account_id, op_type, payload, attempts FROM sync_queue
         WHERE account_id = ?1 AND op_type = ?2 AND state = 'pending' ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![account_id, op_type], |row| {
        Ok(QueuedOp {
            id: row.get(0)?, account_id: row.get(1)?, op_type: row.get(2)?,
            payload: row.get(3)?, attempts: row.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}
```

- [ ] **Step 4: Run them; verify they pass**

Run: `cargo test -p am-storage enqueue_at_delays_until_due list_pending_by_type_filters`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/am-storage/src/queue_repo.rs
git commit -m "feat(storage): add delayed enqueue_at and list_pending_by_type to sync queue"
```

---

## Task 4: `am-protocols` `move_uid` + `create_folder`

IMAP move primitive and folder creation. Verified by build here; exercised live in Task 6.

**Files:**
- Modify: `crates/am-protocols/src/imap.rs` (add two methods inside `impl ImapSession`)

**Interfaces:**
- Produces:
  - `ImapSession::move_uid(&mut self, src_folder: &str, uid: i64, dst_folder: &str) -> Result<(), ProtocolError>`
  - `ImapSession::create_folder(&mut self, name: &str) -> Result<(), ProtocolError>`

- [ ] **Step 1: Implement `move_uid` (modeled on `delete_uid`)**

Add to `crates/am-protocols/src/imap.rs` right after `delete_uid` (around line 360):

```rust
    pub async fn move_uid(&mut self, src_folder: &str, uid: i64, dst_folder: &str) -> Result<(), ProtocolError> {
        let uid_str = uid.to_string();
        let del = "+FLAGS (\\Deleted)";
        match &mut self.session {
            SessionStream::Plain(s) => {
                s.select(src_folder).await?;
                s.uid_copy(&uid_str, dst_folder).await?;
                let _: Vec<_> = s.uid_store(&uid_str, del).await?.try_collect().await?;
                s.expunge().await?.try_collect::<Vec<_>>().await?;
            }
            SessionStream::Tls(s) => {
                s.select(src_folder).await?;
                s.uid_copy(&uid_str, dst_folder).await?;
                let _: Vec<_> = s.uid_store(&uid_str, del).await?.try_collect().await?;
                s.expunge().await?.try_collect::<Vec<_>>().await?;
            }
        }
        Ok(())
    }

    pub async fn create_folder(&mut self, name: &str) -> Result<(), ProtocolError> {
        match &mut self.session {
            SessionStream::Plain(s) => s.create(name).await?,
            SessionStream::Tls(s) => s.create(name).await?,
        }
        Ok(())
    }
```

- [ ] **Step 2: Build to verify it compiles**

Run: `cargo build -p am-protocols`
Expected: builds clean (no warnings about unused — both are `pub`).

- [ ] **Step 3: Commit**

```bash
git add crates/am-protocols/src/imap.rs
git commit -m "feat(protocols): add IMAP move_uid (copy+delete+expunge) and create_folder"
```

---

## Task 5: `am-sync` `enqueue_move` + `undo_move`

Optimistic hide + delayed enqueue, and the undo reversal. Pure DB-side logic, unit-testable in-memory.

**Files:**
- Modify: `crates/am-sync/src/service.rs`
- Test: `crates/am-sync/src/service.rs` (`#[cfg(test)]` — reuse the existing `rules_engine_tests` module or add a new `move_tests` module)

**Interfaces:**
- Consumes: `folders_repo::find_by_type`, `messages_repo::set_deleted`, `queue_repo::enqueue_at`, `queue_repo::list_pending_by_type`, `queue_repo::mark_done`.
- Produces:
  - `pub enum MoveTarget { Archive, Trash }` with `pub fn folder_type(&self) -> FolderType` and `pub fn as_str(&self) -> &'static str`
  - `pub fn enqueue_move(db: &Database, message_id: i64, target: MoveTarget, now: i64) -> Result<(), SyncError>`
  - `pub fn undo_move(db: &Database, message_ids: &[i64]) -> Result<(), SyncError>`
  - `pub const UNDO_GRACE_SECS: i64 = 8;`

- [ ] **Step 1: Write the failing tests**

Add a new test module at the bottom of `crates/am-sync/src/service.rs`:

```rust
#[cfg(test)]
mod move_tests {
    use super::*;
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::NewMessageHeader;
    use am_storage::{accounts_repo, folders_repo, messages_repo, queue_repo, Database};

    fn header(uid: i64) -> NewMessageHeader {
        NewMessageHeader {
            uid, message_id_hdr: Some(format!("<m{uid}@e>")), in_reply_to: None, references_hdr: None,
            from_address: "s@e.com".into(), from_name: None, subject: "S".into(), date: uid,
            seen: false, flagged: false, has_attachments: false, size: 1, snippet: "x".into(),
        }
    }

    fn setup() -> (Database, i64, i64) {
        let db = Database::open_in_memory().unwrap();
        let account = accounts_repo::insert_account(&db, &NewAccount {
            email: "m@e.com".into(), display_name: "M".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap();
        let inbox = folders_repo::upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        folders_repo::set_sync_markers(&db, inbox.id, 100, 2, None, 0).unwrap();
        messages_repo::insert_headers(&db, inbox.id, &[header(1)]).unwrap();
        let mid = messages_repo::list_by_folder(&db, inbox.id, 10, 0, i64::MAX).unwrap()[0].id;
        (db, account.id, mid)
    }

    #[test]
    fn enqueue_move_hides_and_schedules_delayed_op() {
        let (db, account_id, mid) = setup();
        enqueue_move(&db, mid, MoveTarget::Archive, 1000).unwrap();
        let inbox = folders_repo::find_by_type(&db, account_id, FolderType::Inbox).unwrap().unwrap();
        assert!(messages_repo::list_by_folder(&db, inbox.id, 10, 0, i64::MAX).unwrap().is_empty());
        assert!(queue_repo::list_due(&db, account_id, 1000).unwrap().is_empty());
        let due = queue_repo::list_due(&db, account_id, 1000 + UNDO_GRACE_SECS).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].op_type, "move_message");
    }

    #[test]
    fn undo_move_unhides_and_cancels_pending_op() {
        let (db, account_id, mid) = setup();
        enqueue_move(&db, mid, MoveTarget::Archive, 1000).unwrap();
        undo_move(&db, &[mid]).unwrap();
        let inbox = folders_repo::find_by_type(&db, account_id, FolderType::Inbox).unwrap().unwrap();
        assert_eq!(messages_repo::list_by_folder(&db, inbox.id, 10, 0, i64::MAX).unwrap().len(), 1);
        assert!(queue_repo::list_pending_by_type(&db, account_id, "move_message").unwrap().is_empty());
    }
}
```

- [ ] **Step 2: Run them; verify they fail**

Run: `cargo test -p am-sync move_tests`
Expected: FAIL — `enqueue_move`/`MoveTarget`/`undo_move`/`UNDO_GRACE_SECS` not found.

- [ ] **Step 3: Implement `MoveTarget`, constants, `enqueue_move`, `undo_move`**

Add near `MAX_QUEUE_ATTEMPTS` (top of `service.rs`):

```rust
pub const UNDO_GRACE_SECS: i64 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveTarget {
    Archive,
    Trash,
}

impl MoveTarget {
    pub fn folder_type(&self) -> FolderType {
        match self {
            MoveTarget::Archive => FolderType::Archive,
            MoveTarget::Trash => FolderType::Trash,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            MoveTarget::Archive => "archive",
            MoveTarget::Trash => "trash",
        }
    }
    pub fn default_folder_name(&self) -> &'static str {
        match self {
            MoveTarget::Archive => "Archive",
            MoveTarget::Trash => "Trash",
        }
    }
}
```

Add (near `enqueue_flag`):

```rust
pub fn enqueue_move(db: &Database, message_id: i64, target: MoveTarget, now: i64) -> Result<(), SyncError> {
    let loc = messages_repo::locate(db, message_id)?;
    let markers = folders_repo::get_sync_markers(db, loc.folder_id)?;
    let uidvalidity = markers.uidvalidity.unwrap_or(0);

    messages_repo::set_deleted(db, message_id, true)?;
    folders_repo::recount_unread(db, loc.folder_id)?;
    if let Some(thread_id) = loc.thread_id {
        threads_repo::recompute(db, thread_id)?;
    }

    let payload = serde_json::json!({
        "message_id": message_id,
        "folder_id": loc.folder_id,
        "uid": loc.uid,
        "uidvalidity": uidvalidity,
        "target_type": target.as_str(),
    })
    .to_string();
    queue_repo::enqueue_at(db, loc.account_id, "move_message", &payload, now + UNDO_GRACE_SECS)?;
    Ok(())
}

pub fn undo_move(db: &Database, message_ids: &[i64]) -> Result<(), SyncError> {
    let mut accounts: Vec<i64> = Vec::new();
    for &mid in message_ids {
        if let Ok(loc) = messages_repo::locate(db, mid) {
            if !accounts.contains(&loc.account_id) {
                accounts.push(loc.account_id);
            }
        }
    }
    for account_id in accounts {
        let ops = queue_repo::list_pending_by_type(db, account_id, "move_message")?;
        for op in ops {
            let parsed: serde_json::Value = match serde_json::from_str(&op.payload) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let mid = parsed["message_id"].as_i64().unwrap_or(-1);
            if !message_ids.contains(&mid) {
                continue;
            }
            queue_repo::mark_done(db, op.id)?;
            messages_repo::set_deleted(db, mid, false)?;
            if let Ok(loc) = messages_repo::locate(db, mid) {
                folders_repo::recount_unread(db, loc.folder_id)?;
                if let Some(thread_id) = loc.thread_id {
                    threads_repo::recompute(db, thread_id)?;
                }
            }
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Run them; verify they pass**

Run: `cargo test -p am-sync move_tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/am-sync/src/service.rs
git commit -m "feat(sync): enqueue_move/undo_move with optimistic hide and undo grace window"
```

---

## Task 6: `drain_queue` move branch + live GreenMail e2e

The engine executes the queued move: resolve or create the target folder, then move on the server. Verified by a live GreenMail integration test (requires Docker).

**Files:**
- Modify: `crates/am-sync/src/service.rs` (`drain_queue`)
- Test: `crates/am-sync/tests/sync_greenmail.rs` (new `#[tokio::test]`)

**Interfaces:**
- Consumes: `ImapSession::move_uid`, `ImapSession::create_folder`, `folders_repo::find_by_type`, `folders_repo::upsert_folder`.

- [ ] **Step 1: Add the move branch to `drain_queue`**

In `crates/am-sync/src/service.rs`, inside `drain_queue`'s `for op in due` loop, replace the early guard:

```rust
        if op.op_type != "set_flag" {
            continue;
        }
```
with:
```rust
        if op.op_type == "move_message" {
            drain_one_move(db, &mut session, op.account_id, &op, now).await?;
            selected = None;
            continue;
        }
        if op.op_type != "set_flag" {
            continue;
        }
```

Then add this free function below `drain_queue` (same file):

```rust
async fn drain_one_move(
    db: &Database,
    session: &mut ImapSession,
    account_id: i64,
    op: &am_storage::queue_repo::QueuedOp,
    now: i64,
) -> Result<(), SyncError> {
    let parsed: serde_json::Value = match serde_json::from_str(&op.payload) {
        Ok(v) => v,
        Err(_) => { queue_repo::mark_done(db, op.id)?; return Ok(()); }
    };
    let folder_id = parsed["folder_id"].as_i64().unwrap_or(0);
    let uid = parsed["uid"].as_i64().unwrap_or(0);
    let payload_validity = parsed["uidvalidity"].as_i64().unwrap_or(-1);
    let target = match parsed["target_type"].as_str() {
        Some("archive") => MoveTarget::Archive,
        Some("trash") => MoveTarget::Trash,
        _ => { queue_repo::mark_done(db, op.id)?; return Ok(()); }
    };

    let src = match folders_repo::get_folder(db, folder_id) {
        Ok(f) => f,
        Err(_) => { queue_repo::mark_done(db, op.id)?; return Ok(()); }
    };
    match folders_repo::get_sync_markers(db, folder_id).ok().and_then(|m| m.uidvalidity) {
        Some(v) if v == payload_validity => {}
        _ => { queue_repo::mark_done(db, op.id)?; return Ok(()); }
    }

    let dst = match folders_repo::find_by_type(db, account_id, target.folder_type())? {
        Some(f) => f,
        None => {
            let name = target.default_folder_name();
            if session.create_folder(name).await.is_err() {
                return retry_or_drop(db, op, now);
            }
            folders_repo::upsert_folder(db, account_id, name, name, target.folder_type())?
        }
    };

    match session.move_uid(&src.remote_path, uid, &dst.remote_path).await {
        Ok(()) => { queue_repo::mark_done(db, op.id)?; Ok(()) }
        Err(_) => retry_or_drop(db, op, now),
    }
}

fn retry_or_drop(db: &Database, op: &am_storage::queue_repo::QueuedOp, now: i64) -> Result<(), SyncError> {
    if op.attempts + 1 >= MAX_QUEUE_ATTEMPTS {
        queue_repo::mark_done(db, op.id)?;
    } else {
        let backoff = now + 2i64.pow((op.attempts + 1).min(5) as u32) * 30;
        queue_repo::mark_retry(db, op.id, backoff, None)?;
    }
    Ok(())
}
```

- [ ] **Step 2: Build the workspace**

Run: `cargo build -p am-sync`
Expected: builds clean.

- [ ] **Step 3: Write the live e2e test**

In `crates/am-sync/tests/sync_greenmail.rs`, add a new test. Reuse the **exact** container + seed + `add_account` setup block from `add_account_syncs_inbox_and_fetches_body` (the `GenericImage` startup, `seed_messages(port)`, building `input`, and `service::add_account(&db, input)` returning `account`) as the preamble. Then:

```rust
#[tokio::test]
async fn archive_moves_message_out_of_inbox() {
    // PREAMBLE: copy the container startup + seed_messages(port) + add_account
    // block from add_account_syncs_inbox_and_fetches_body, producing:
    //   let db: Database, let account: Account, let creds (InMemCredBuilder-based).
    // (Server starts with INBOX seeded; add_account has synced INBOX.)

    let inbox = folders_repo::find_by_type(&db, account.id, FolderType::Inbox)
        .unwrap()
        .expect("inbox");
    let first = messages_repo::list_by_folder(&db, inbox.id, 50, 0, i64::MAX).unwrap()[0].id;

    am_sync::service::enqueue_move(&db, first, am_sync::service::MoveTarget::Archive, 0).unwrap();
    am_sync::service::drain_queue(&db, account.id, creds.as_ref(), am_sync::service::UNDO_GRACE_SECS)
        .await
        .expect("drain_queue failed");

    am_sync::service::discover_folders(&db, account.id, creds.as_ref()).await.ok();
    let archive = folders_repo::find_by_type(&db, account.id, FolderType::Archive)
        .unwrap()
        .expect("archive folder should exist after auto-create");
    am_sync::service::sync_all_folders(&db, account.id, creds.as_ref(), &sink_noop()).await.ok();

    let inbox_after = messages_repo::list_by_folder(&db, inbox.id, 50, 0, i64::MAX).unwrap();
    assert!(inbox_after.is_empty(), "message should have left INBOX");
    let archive_after = messages_repo::list_by_folder(&db, archive.id, 50, 0, i64::MAX).unwrap();
    assert_eq!(archive_after.len(), 1, "message should be in Archive");
}
```

Use whatever no-op sink and `sync_all_folders` signature the other tests in this file already use (match their call form exactly — e.g. the `seed_messages`/sink helpers in scope). If `discover_folders`/`sync_all_folders` are not `pub`, drain alone moved it server-side; assert via a fresh IMAP `list_by_folder` after re-sync the same way the existing `Archive` assertion at the bottom of the file does (lines ~249-255).

- [ ] **Step 4: Run the e2e test (needs Docker)**

Run: `cargo test -p am-sync --test sync_greenmail archive_moves_message_out_of_inbox -- --nocapture`
Expected: PASS. If Docker Hub image pull fails (known infra flake), record that and verify `cargo build` + the rest of the suite instead.

- [ ] **Step 5: Run the full sync suite**

Run: `cargo test -p am-sync`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/am-sync/src/service.rs crates/am-sync/tests/sync_greenmail.rs
git commit -m "feat(sync): drain move_message ops with auto-create target folder"
```

---

## Task 7: `am-app` commands + bindings

Expose `archive_messages`, `delete_messages`, `undo_move`.

**Files:**
- Modify: `crates/am-app/src/commands.rs` (add three commands)
- Modify: `crates/am-app/src/lib.rs` (register in `collect_commands!`)
- Modify: `src/ipc/bindings.ts` (regenerated, do not hand-edit)

**Interfaces:**
- Produces (JS): `commands.archiveMessages(messageIds)`, `commands.deleteMessages(messageIds)`, `commands.undoMove(messageIds)` — each `Promise<{status:"ok",data:null}|{status:"error",error:string}>`.

- [ ] **Step 1: Add the three commands**

In `crates/am-app/src/commands.rs`, after `set_message_flags`:

```rust
#[tauri::command]
#[specta::specta]
pub fn archive_messages(
    state: tauri::State<'_, AppState>,
    message_ids: Vec<i64>,
) -> Result<(), String> {
    let now = am_sync::service::now_secs();
    for id in message_ids {
        am_sync::service::enqueue_move(&state.db, id, am_sync::service::MoveTarget::Archive, now)
            .map_err(|_| "Failed to archive".to_string())?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn delete_messages(
    state: tauri::State<'_, AppState>,
    message_ids: Vec<i64>,
) -> Result<(), String> {
    let now = am_sync::service::now_secs();
    for id in message_ids {
        am_sync::service::enqueue_move(&state.db, id, am_sync::service::MoveTarget::Trash, now)
            .map_err(|_| "Failed to delete".to_string())?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn undo_move(
    state: tauri::State<'_, AppState>,
    message_ids: Vec<i64>,
) -> Result<(), String> {
    am_sync::service::undo_move(&state.db, &message_ids).map_err(|_| "Failed to undo".to_string())
}
```

- [ ] **Step 2: Register the commands**

In `crates/am-app/src/lib.rs`, inside `collect_commands![ ... ]`, after `commands::set_message_flags,` add:

```rust
            commands::archive_messages,
            commands::delete_messages,
            commands::undo_move,
```

- [ ] **Step 3: Build the app crate**

Run: `cargo build -p abeonmail`
Expected: builds clean.

- [ ] **Step 4: Regenerate bindings**

Run: `npm run gen:bindings`
Expected: `src/ipc/bindings.ts` now contains `archiveMessages`, `deleteMessages`, `undoMove`.

- [ ] **Step 5: Commit**

```bash
git add crates/am-app/src/commands.rs crates/am-app/src/lib.rs src/ipc/bindings.ts
git commit -m "feat(app): archive_messages/delete_messages/undo_move commands"
```

---

## Task 8: Enable archive/delete in the shortcut registry

**Files:**
- Modify: `src/features/shortcuts/registry.ts:58-59`
- Modify: `src/features/shortcuts/registry.test.ts`
- Modify: `src/features/shortcuts/CheatSheet.test.tsx`

- [ ] **Step 1: Update the failing registry test**

In `src/features/shortcuts/registry.test.ts`, the test `placeholder actions are disabled` lists `["archive", "delete"]`. Replace that test with an enabled assertion:

```typescript
  it("archive and delete are enabled in reader and list", () => {
    for (const id of ["archive", "delete"] as ActionId[]) {
      const a = actionById(id);
      expect(a?.enabled).toBe(true);
      expect(a?.contexts).toContain("reader");
      expect(a?.contexts).toContain("list");
    }
  });
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npx vitest run src/features/shortcuts/registry.test.ts`
Expected: FAIL — `enabled` is `false`, contexts lack `list`.

- [ ] **Step 3: Enable the actions**

In `src/features/shortcuts/registry.ts`, change lines 58-59 to:

```typescript
  { id: "archive", label: "Archive", contexts: ["reader", "list"], defaultBinding: "e", enabled: true },
  { id: "delete", label: "Delete", contexts: ["reader", "list"], defaultBinding: "#", enabled: true },
```

- [ ] **Step 4: Fix the CheatSheet test**

In `src/features/shortcuts/CheatSheet.test.tsx`, the test `marks disabled actions as coming soon` asserts the `Archive` row has class `cheat-row--disabled`. Archive is no longer disabled. Change that test to use a still-disabled action, or assert Archive is **not** disabled:

```typescript
  it("does not mark archive as coming soon", () => {
    render(<CheatSheet />);
    const archiveRow = screen.getByText("Archive").closest(".cheat-row");
    expect(archiveRow?.className).not.toContain("cheat-row--disabled");
  });
```

- [ ] **Step 5: Run the shortcut tests**

Run: `npx vitest run src/features/shortcuts/registry.test.ts src/features/shortcuts/CheatSheet.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/shortcuts/registry.ts src/features/shortcuts/registry.test.ts src/features/shortcuts/CheatSheet.test.tsx
git commit -m "feat(shortcuts): enable archive (e) and delete (#) in reader and list"
```

---

## Task 9: Frontend mutation hooks

**Files:**
- Modify: `src/ipc/queries.ts`

**Interfaces:**
- Produces: `useArchive()`, `useDelete()`, `useUndoMove()` — each a mutation whose `mutate`/`mutateAsync` takes `{ messageIds: number[] }`.

- [ ] **Step 1: Add the hooks**

In `src/ipc/queries.ts`, add (near `useSnooze`):

```typescript
function invalidateAfterMove(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ["threads"] });
  queryClient.invalidateQueries({ queryKey: ["thread-messages"] });
  queryClient.invalidateQueries({ queryKey: ["messages"] });
  queryClient.invalidateQueries({ queryKey: ["smart"] });
  queryClient.invalidateQueries({ queryKey: ["labels-for-messages"] });
  queryClient.invalidateQueries({ queryKey: ["messages-by-label"] });
  queryClient.invalidateQueries({ queryKey: ["folders"] });
  void commands.refreshUnreadBadge(useUiStore.getState().badgeEnabled);
}

export function useArchive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageIds }: { messageIds: number[] }) =>
      commands.archiveMessages(messageIds).then(unwrap),
    onSuccess: () => invalidateAfterMove(queryClient),
  });
}

export function useDelete() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageIds }: { messageIds: number[] }) =>
      commands.deleteMessages(messageIds).then(unwrap),
    onSuccess: () => invalidateAfterMove(queryClient),
  });
}

export function useUndoMove() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageIds }: { messageIds: number[] }) =>
      commands.undoMove(messageIds).then(unwrap),
    onSuccess: () => invalidateAfterMove(queryClient),
  });
}
```

- [ ] **Step 2: Typecheck/build**

Run: `npm run build`
Expected: tsc + vite build clean (`unwrap` and `commands` are already imported/defined in this file).

- [ ] **Step 3: Commit**

```bash
git add src/ipc/queries.ts
git commit -m "feat(queries): useArchive/useDelete/useUndoMove mutation hooks"
```

---

## Task 10: Undo store slice + UndoBar component

**Files:**
- Modify: `src/app/store.ts` (undo slice)
- Create: `src/features/shortcuts/UndoBar.tsx`
- Create: `src/features/shortcuts/UndoBar.css`
- Modify: `src/features/shortcuts/ShortcutsProvider.tsx` (mount `<UndoBar />`)
- Test: `src/features/shortcuts/UndoBar.test.tsx`

**Interfaces:**
- Produces (store): `undoToast: { kind: "archive" | "delete"; messageIds: number[] } | null`; `showUndoToast(kind, messageIds)`; `clearUndoToast()`.
- Produces: `export const UNDO_TIMEOUT_MS = 8000;` (in `UndoBar.tsx`).

- [ ] **Step 1: Add the store slice**

In `src/app/store.ts`, add to the state type (near the snooze picker fields):

```typescript
  undoToast: { kind: "archive" | "delete"; messageIds: number[] } | null;
  showUndoToast: (kind: "archive" | "delete", messageIds: number[]) => void;
  clearUndoToast: () => void;
```

In the store creator, add the initial value and setters (near `openSnoozePicker`):

```typescript
  undoToast: null,
  showUndoToast: (kind, messageIds) => set({ undoToast: { kind, messageIds } }),
  clearUndoToast: () => set({ undoToast: null }),
```

- [ ] **Step 2: Write the failing UndoBar test**

Create `src/features/shortcuts/UndoBar.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { UndoBar } from "./UndoBar";
import { useUiStore } from "../../app/store";

const mockUndo = vi.fn();
vi.mock("../../ipc/queries", () => ({
  useUndoMove: () => ({ mutate: mockUndo }),
}));

describe("UndoBar", () => {
  beforeEach(() => {
    mockUndo.mockReset();
    useUiStore.setState({ undoToast: null });
  });

  it("renders nothing when no toast", () => {
    const { container } = render(<UndoBar />);
    expect(container.firstChild).toBeNull();
  });

  it("shows label and calls undo on click", () => {
    useUiStore.setState({ undoToast: { kind: "archive", messageIds: [1, 2] } });
    render(<UndoBar />);
    expect(screen.getByText(/Archived/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    expect(mockUndo).toHaveBeenCalledWith({ messageIds: [1, 2] });
    expect(useUiStore.getState().undoToast).toBeNull();
  });
});
```

- [ ] **Step 3: Run it; verify it fails**

Run: `npx vitest run src/features/shortcuts/UndoBar.test.tsx`
Expected: FAIL — `UndoBar` module not found.

- [ ] **Step 4: Implement UndoBar**

Create `src/features/shortcuts/UndoBar.tsx`:

```tsx
import { useEffect } from "react";
import { useUiStore } from "../../app/store";
import { useUndoMove } from "../../ipc/queries";
import "./UndoBar.css";

export const UNDO_TIMEOUT_MS = 8000;

export function UndoBar() {
  const toast = useUiStore((s) => s.undoToast);
  const clearUndoToast = useUiStore((s) => s.clearUndoToast);
  const undoMove = useUndoMove();

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => clearUndoToast(), UNDO_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [toast, clearUndoToast]);

  if (!toast) return null;

  const label = toast.kind === "archive" ? "Archived" : "Deleted";

  function onUndo() {
    if (!toast) return;
    undoMove.mutate({ messageIds: toast.messageIds });
    clearUndoToast();
  }

  return (
    <div className="undo-bar" role="status">
      <span className="undo-bar__label">{label}</span>
      <button type="button" className="undo-bar__action" aria-label="Undo" onClick={onUndo}>
        Undo
      </button>
    </div>
  );
}
```

Create `src/features/shortcuts/UndoBar.css`:

```css
.undo-bar {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 16px;
  border-radius: 8px;
  background: #1f2330;
  color: #fff;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.3);
  z-index: 1000;
}
.undo-bar__action {
  background: none;
  border: none;
  color: var(--accent, #6f86ff);
  font-weight: 600;
  cursor: pointer;
}
```

- [ ] **Step 5: Mount UndoBar**

In `src/features/shortcuts/ShortcutsProvider.tsx`, add the import and render it next to the other global overlays:

```tsx
import { UndoBar } from "./UndoBar";
```
and inside the returned provider JSX, after `<SnoozePicker />`:
```tsx
      <UndoBar />
```

- [ ] **Step 6: Run the test; verify it passes**

Run: `npx vitest run src/features/shortcuts/UndoBar.test.tsx`
Expected: PASS.

If `toBeTruthy`/`toBeNull` assertions need jest-dom and it is not configured, the project convention uses plain `.toBeTruthy()` and `expect(container.firstChild).toBeNull()` — keep as written (no jest-dom import).

- [ ] **Step 7: Commit**

```bash
git add src/app/store.ts src/features/shortcuts/UndoBar.tsx src/features/shortcuts/UndoBar.css src/features/shortcuts/UndoBar.test.tsx src/features/shortcuts/ShortcutsProvider.tsx
git commit -m "feat(shortcuts): undo bar with grace-window cancellation"
```

---

## Task 11: ShortcutsProvider archive/delete handlers

Wire the `archive`/`delete` actions to the hooks, operating on the selection (list) or the whole thread (reader), then show the undo bar and navigate back.

**Files:**
- Modify: `src/features/shortcuts/ShortcutsProvider.tsx`
- Test: `src/features/shortcuts/ShortcutsProvider.test.tsx` (add cases) — or a focused new test file `ShortcutsProvider.move.test.tsx`

**Interfaces:**
- Consumes: `useArchive`, `useDelete` from queries; store `showUndoToast`, `clearSelection`, `setSelectedThreadId`, `selectionActive`, `selectedMessageIds`, `selectedThreadId`; RQ cache `["thread-messages", id]`.

- [ ] **Step 1: Write the failing handler test**

Create `src/features/shortcuts/ShortcutsProvider.move.test.tsx`:

```tsx
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ShortcutsProvider } from "./ShortcutsProvider";
import { useUiStore } from "../../app/store";

const archiveMutate = vi.fn();
const deleteMutate = vi.fn();
vi.mock("../../ipc/queries", async (orig) => {
  const actual = await orig<typeof import("../../ipc/queries")>();
  return {
    ...actual,
    useArchive: () => ({ mutate: archiveMutate }),
    useDelete: () => ({ mutate: deleteMutate }),
  };
});

function setup() {
  const qc = new QueryClient();
  qc.setQueryData(["thread-messages", 42], [{ id: 100 }, { id: 101 }]);
  render(
    <QueryClientProvider client={qc}>
      <ShortcutsProvider><div /></ShortcutsProvider>
    </QueryClientProvider>
  );
}

describe("archive/delete shortcuts", () => {
  beforeEach(() => {
    archiveMutate.mockReset();
    deleteMutate.mockReset();
    useUiStore.setState({ selectionActive: false, selectedMessageIds: [], selectedThreadId: 42, undoToast: null });
  });

  it("e archives the whole thread in reader and shows undo", () => {
    setup();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
    expect(archiveMutate).toHaveBeenCalledWith({ messageIds: [100, 101] });
    expect(useUiStore.getState().undoToast).toEqual({ kind: "archive", messageIds: [100, 101] });
    expect(useUiStore.getState().selectedThreadId).toBeNull();
  });

  it("# deletes the active selection in list", () => {
    useUiStore.setState({ selectionActive: true, selectedMessageIds: [7, 8], selectedThreadId: null });
    setup();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "#", bubbles: true }));
    expect(deleteMutate).toHaveBeenCalledWith({ messageIds: [7, 8] });
    expect(useUiStore.getState().undoToast).toEqual({ kind: "delete", messageIds: [7, 8] });
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npx vitest run src/features/shortcuts/ShortcutsProvider.move.test.tsx`
Expected: FAIL — no archive handler; nothing called.

- [ ] **Step 3: Implement the handlers**

In `src/features/shortcuts/ShortcutsProvider.tsx`:

Add hook imports at the top from queries:
```tsx
import { useStartReply, useSetFlag, useSetSeen, useArchive, useDelete } from "../../ipc/queries";
```
Instantiate them near the other mutations:
```tsx
  const archive = useArchive();
  const del = useDelete();
```

Add a shared callback near `setSeen`:
```tsx
  const doMove = useCallback(
    (kind: "archive" | "delete") => {
      const s = useUiStore.getState();
      let ids: number[] = [];
      if (s.selectionActive && s.selectedMessageIds.length > 0) {
        ids = s.selectedMessageIds;
      } else if (s.selectedThreadId != null) {
        const messages = queryClient.getQueryData<{ id: number }[]>(["thread-messages", s.selectedThreadId]);
        ids = (messages ?? []).map((m) => m.id);
      }
      if (ids.length === 0) return;
      if (kind === "archive") archive.mutate({ messageIds: ids });
      else del.mutate({ messageIds: ids });
      s.showUndoToast(kind, ids);
      if (s.selectionActive) s.clearSelection();
      if (s.selectedThreadId != null) s.setSelectedThreadId(null);
    },
    [archive, del, queryClient]
  );
```

Add the handlers in the `handlers` map (near `snooze`):
```tsx
      archive: () => doMove("archive"),
      delete: () => doMove("delete"),
```

Add `doMove` to the `useMemo` dependency array of `handlers` (alongside `move, jumpTo, doReply, toggleFlag, setSeen`).

- [ ] **Step 4: Run it; verify it passes**

Run: `npx vitest run src/features/shortcuts/ShortcutsProvider.move.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/shortcuts/ShortcutsProvider.tsx src/features/shortcuts/ShortcutsProvider.move.test.tsx
git commit -m "feat(shortcuts): wire archive/delete handlers to thread and selection"
```

---

## Task 12: Wire the ConversationView action-bar buttons

**Files:**
- Modify: `src/features/reader/ConversationView.tsx`
- Test: `src/features/reader/ConversationView.test.tsx` (add an assertion that the Archive button is no longer `aria-disabled` and calls archive)

**Interfaces:**
- Consumes: `useArchive`, `useDelete`, store `showUndoToast`, `setSelectedThreadId`.

- [ ] **Step 1: Write the failing test**

Add to `src/features/reader/ConversationView.test.tsx` a case asserting the Archive button is actionable. Mock queries' `useArchive` to capture the call (follow the file's existing mock style for `useSetFlag`). Minimal assertion:

```tsx
  it("archive button is enabled", () => {
    // render ConversationView with a thread of messages (reuse this file's existing render helper)
    const btn = screen.getByLabelText("Archive");
    expect(btn.getAttribute("aria-disabled")).not.toBe("true");
  });
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npx vitest run src/features/reader/ConversationView.test.tsx`
Expected: FAIL — button still has `aria-disabled="true"`.

- [ ] **Step 3: Wire the buttons**

In `src/features/reader/ConversationView.tsx`:

Instantiate the hooks near the existing `setFlag`/`setSeen`:
```tsx
  const archive = useArchive();
  const del = useDelete();
  const showUndoToast = useUiStore((s) => s.showUndoToast);
  const setSelectedThreadId = useUiStore((s) => s.setSelectedThreadId);
```
(Add `useArchive, useDelete` to the existing `../../ipc/queries` import.)

Add a helper inside the component:
```tsx
  function moveThread(kind: "archive" | "delete") {
    const ids = (messages ?? []).map((m) => m.id);
    if (ids.length === 0) return;
    if (kind === "archive") archive.mutate({ messageIds: ids });
    else del.mutate({ messageIds: ids });
    showUndoToast(kind, ids);
    setSelectedThreadId(null);
  }
```

Replace the Archive button (lines ~92-94):
```tsx
        <button type="button" className="reader__icon" aria-label="Archive" onClick={() => moveThread("archive")}>
          <Archive size={18} />
        </button>
```
Replace the Delete button (lines ~111-113):
```tsx
        <button type="button" className="reader__icon" aria-label="Delete" onClick={() => moveThread("delete")}>
          <Trash2 size={18} />
        </button>
```

- [ ] **Step 4: Run it; verify it passes**

Run: `npx vitest run src/features/reader/ConversationView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/reader/ConversationView.tsx src/features/reader/ConversationView.test.tsx
git commit -m "feat(reader): wire Archive/Delete action-bar buttons"
```

---

## Task 13: Stable Archive/Trash folder typing (corrective)

**Why (discovered during Task 6):** `folder_type_for` classifies a folder as `Archive`/`Trash` only by IMAP SPECIAL-USE (`\Archive`/`\Trash`). Servers that omit those attributes — including Gmail, whose All Mail advertises `\All` (deliberately mapped to `Custom`) — leave the account with no `FolderType::Archive`. The archive feature then auto-creates an "Archive" folder, but on the next `discover_folders` its type is recomputed back to `Custom`, so `find_by_type(Archive)` returns `None` again and repeat archiving breaks. Fix the root: recognize Gmail All Mail (`\All`) as the archive target and add a leaf-name fallback for `Archive`/`Trash`, so the type is stable across syncs. (User decision: "A + Gmail via All Mail".)

**Files:**
- Modify: `crates/am-sync/src/service.rs` (`folder_type_for` + its tests)
- Modify: `crates/am-sync/tests/sync_greenmail.rs` (drop the Task 6 workaround; assert post-sync stability)

**Interfaces:**
- Changes the behavior of the private `folder_type_for(remote_path, special_use)`; no signature change.

- [ ] **Step 1: Update the failing unit test for `\All` and add name-fallback tests**

In `crates/am-sync/src/service.rs` tests, change the existing assertion `folder_type_for("All", Some("\\All"))` from `FolderType::Custom` to `FolderType::Archive`. Add:

```rust
        assert_eq!(folder_type_for("[Gmail]/All Mail", Some("\\All")), FolderType::Archive);
        assert_eq!(folder_type_for("Archive", None), FolderType::Archive);
        assert_eq!(folder_type_for("INBOX.Archive", None), FolderType::Archive);
        assert_eq!(folder_type_for("Trash", None), FolderType::Trash);
        assert_eq!(folder_type_for("Deleted Items", None), FolderType::Trash);
        assert_eq!(folder_type_for("Projects", None), FolderType::Custom);
        assert_eq!(folder_type_for("Sent", Some("\\Sent")), FolderType::Sent);
```

- [ ] **Step 2: Run them; verify they fail**

Run: `cargo test -p am-sync folder_type`
Expected: FAIL — `\All` still maps to Custom; name fallback absent.

- [ ] **Step 3: Implement the root fix**

Replace `folder_type_for` in `crates/am-sync/src/service.rs` with:

```rust
fn folder_type_for(remote_path: &str, special_use: Option<&str>) -> FolderType {
    if remote_path.eq_ignore_ascii_case(INBOX_PATH) {
        return FolderType::Inbox;
    }
    match special_use {
        Some("\\Sent") => return FolderType::Sent,
        Some("\\Drafts") => return FolderType::Drafts,
        Some("\\Trash") => return FolderType::Trash,
        Some("\\Junk") => return FolderType::Spam,
        Some("\\Archive") | Some("\\All") => return FolderType::Archive,
        _ => {}
    }
    let leaf = remote_path.rsplit(['/', '.']).next().unwrap_or(remote_path);
    if leaf.eq_ignore_ascii_case("Archive") {
        return FolderType::Archive;
    }
    if leaf.eq_ignore_ascii_case("Trash") || leaf.eq_ignore_ascii_case("Deleted Items") {
        return FolderType::Trash;
    }
    FolderType::Custom
}
```

- [ ] **Step 4: Run them; verify they pass**

Run: `cargo test -p am-sync folder_type`
Expected: PASS.

- [ ] **Step 5: Strengthen the e2e (remove the Task 6 workaround)**

In `crates/am-sync/tests/sync_greenmail.rs`, in `archive_moves_message_out_of_inbox`, the Task 6 version captured `find_by_type(Archive)` immediately after `drain_queue` to dodge the type-flip. Now the type must survive discovery. Reorder so the Archive assertion happens AFTER the re-sync/discovery step, and assert the type is stable:

```rust
    am_sync::service::drain_queue(&db, account.id, creds.as_ref(), am_sync::service::UNDO_GRACE_SECS)
        .await
        .expect("drain_queue failed");
    // re-sync the same way the existing Archive test does (discover + sync_all_folders)
    let archive = folders_repo::find_by_type(&db, account.id, FolderType::Archive)
        .unwrap()
        .expect("Archive type must survive folder discovery");
    let archive_after = messages_repo::list_by_folder(&db, archive.id, 50, 0, i64::MAX).unwrap();
    assert_eq!(archive_after.len(), 1);
```

Keep the INBOX assertion (length 2, archived subject absent). Use the file's actual re-sync entry point (mirror the existing Archive-folder test); do not invent function names. No code comments in the final test — the inline note above is guidance only.

- [ ] **Step 6: Run the suite (Docker e2e self-skips if unavailable)**

Run: `cargo test -p am-sync` (and, if Docker present, `cargo test -p am-sync --test sync_greenmail archive_moves_message_out_of_inbox -- --nocapture`)
Expected: PASS / self-skip.

- [ ] **Step 7: Commit**

```bash
git add crates/am-sync/src/service.rs crates/am-sync/tests/sync_greenmail.rs
git commit -m "fix(sync): classify Gmail All Mail and named Archive/Trash folders by type"
```

---

## Final verification

- [ ] **Run the whole Rust workspace**

Run: `cargo test --workspace`
Expected: PASS (GreenMail Docker tests may be skipped if Docker Hub pull fails — note it if so).

- [ ] **Run the whole frontend suite + build**

Run: `npx vitest run` then `npm run build`
Expected: all tests PASS; tsc + vite build clean.

- [ ] **Manual smoke (optional, real app)**

Open a thread, press `e` → it leaves the inbox, an "Archived — Undo" bar shows; click Undo within ~8s → it returns. Press `#` on a thread → "Deleted — Undo". In a smart/label/search list, multi-select and press `e` → selected messages archived.
