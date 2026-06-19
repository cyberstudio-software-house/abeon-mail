# Etap 6e Snooze Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local snooze — hide a message/thread until a chosen time, then return it to the inbox marked unread, with a dedicated "Snoozed" view; triggered from the reader (whole conversation) and from flat-mode list multi-select.

**Architecture:** Per-message `snooze_wake_at` timestamp (column exists since V1). Setting it hides messages/threads from inbox/folder/smart/label views via a `now`-parameterized SQL filter. A dedicated tokio "wake-sweeper" task (60 s tick) clears elapsed timestamps, marks woken messages unread, recomputes thread unread counts, and emits a refresh event. A new `SmartFolderKind::Snoozed` lists currently-snoozed messages with their wake time. No server/IMAP sync.

**Tech Stack:** Rust (rusqlite, refinery migrations, tokio), Tauri 2 + tauri-specta, React 19/TS, zustand, @tanstack/react-query v5, vitest + @testing-library/react + happy-dom.

## Global Constraints

- All code identifiers (variables, functions, types) in English. No other language at code level.
- No code comments in source. If something must be documented, put it in `docs/`.
- Communicate with the user in Polish; commit messages follow Conventional Commits 1.0.0.
- Never add Claude as co-author. Never `git push` unless explicitly asked.
- Never `git add .` — stage explicit paths only (a gitignored `client_secret_*.json` / `.env` with OAuth secrets must never be committed).
- Snooze is local-only: no IMAP/Gmail-label sync, no flow through the offline write-queue.
- Time convention: pass `now: i64` (Unix seconds) as a parameter to repo functions (mirroring `queue_repo::list_due`); commands compute it via `am_sync::service::now_secs()`. No inline `strftime('%s','now')`.
- Hiding scope: snoozed messages disappear from inbox/folder, smart folders, and label views; they remain visible in search and in the Snoozed view.
- Wake behavior: automatic wake sets `snooze_wake_at = NULL` AND `seen = 0`. Manual unsnooze sets only `snooze_wake_at = NULL` (no `seen` change).
- Test infra: any NEW lucide icon used in app code MUST be added to `src/test/lucide-stub.js` or vitest OOMs. Tests use `.toBeTruthy()`/`.toBeNull()` (no jest-dom). Frontend tests: `npx vitest run <file>` with Node 24 on PATH: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`. Build: `npm run build`. Bindings: `npm run gen:bindings`.

---

### Task 1: am-core — Snoozed kind + snooze_wake_at row field

**Files:**
- Modify: `crates/am-core/src/smart.rs`
- Modify: `crates/am-storage/src/smart_repo.rs:19-34` (`row_to_smart`)
- Test: `crates/am-core/src/smart.rs` (inline `#[cfg(test)]`)

**Interfaces:**
- Produces: `SmartFolderKind::Snoozed` (serializes `"snoozed"`); `SmartMessageRow.snooze_wake_at: Option<i64>`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `crates/am-core/src/smart.rs`:

```rust
    #[test]
    fn smart_folder_kind_snoozed_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&SmartFolderKind::Snoozed).unwrap(),
            "\"snoozed\""
        );
        let k: SmartFolderKind = serde_json::from_str("\"snoozed\"").unwrap();
        assert_eq!(k, SmartFolderKind::Snoozed);
    }

    #[test]
    fn smart_message_row_has_snooze_wake_at() {
        let row = SmartMessageRow {
            message_id: 1,
            account_id: 1,
            folder_id: 1,
            account_color: None,
            from_address: "a@b.c".into(),
            from_name: None,
            subject: "s".into(),
            date: 0,
            seen: false,
            flagged: false,
            has_attachments: false,
            snippet: String::new(),
            snooze_wake_at: Some(123),
        };
        assert_eq!(row.snooze_wake_at, Some(123));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p am-core smart`
Expected: FAIL — `no variant named Snoozed` / missing field `snooze_wake_at`.

- [ ] **Step 3: Add the variant and field**

In `crates/am-core/src/smart.rs`, add `Snoozed` to the enum:

```rust
pub enum SmartFolderKind {
    AllInboxes,
    Unread,
    Flagged,
    Snoozed,
}
```

Add the field at the end of `SmartMessageRow`:

```rust
    pub snippet: String,
    pub snooze_wake_at: Option<i64>,
}
```

- [ ] **Step 4: Fix the shared constructor**

In `crates/am-storage/src/smart_repo.rs`, in `row_to_smart`, add the field (existing SELECTs do not select it, so default to `None`):

```rust
        has_attachments: row.get::<_, i64>(10)? != 0,
        snippet: row.get(11)?,
        snooze_wake_at: None,
    })
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p am-core smart && cargo test -p am-storage --lib`
Expected: PASS (am-storage still compiles; all SmartMessageRow built via `row_to_smart`).

- [ ] **Step 6: Regenerate bindings**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm run gen:bindings`
Expected: `src/ipc/bindings.ts` now has `snooze_wake_at: number | null` on `SmartMessageRow` and `"snoozed"` in `SmartFolderKind`.

- [ ] **Step 7: Commit**

```bash
git add crates/am-core/src/smart.rs crates/am-storage/src/smart_repo.rs src/ipc/bindings.ts
git commit -m "feat(snooze): add Snoozed smart-folder kind and snooze_wake_at row field"
```

---

### Task 2: am-storage — V9 index + snooze_repo set/clear

**Files:**
- Create: `crates/am-storage/src/migrations/V9__snooze.sql`
- Create: `crates/am-storage/src/snooze_repo.rs`
- Modify: `crates/am-storage/src/lib.rs` (register `pub mod snooze_repo;` alphabetically)
- Test: `crates/am-storage/src/snooze_repo.rs` (inline `#[cfg(test)]`)

**Interfaces:**
- Produces: `snooze_repo::snooze_messages(db, ids: &[i64], wake_at: i64) -> Result<(), StorageError>`; `snooze_repo::unsnooze_messages(db, ids: &[i64]) -> Result<(), StorageError>`.
- Consumes: `Database`, `StorageError` from `crate::db`.

- [ ] **Step 1: Create the migration**

Create `crates/am-storage/src/migrations/V9__snooze.sql`:

```sql
CREATE INDEX idx_messages_snooze ON messages(snooze_wake_at)
WHERE snooze_wake_at IS NOT NULL;
```

- [ ] **Step 2: Write the failing test**

Create `crates/am-storage/src/snooze_repo.rs` with only the test module first:

```rust
use rusqlite::params;

use crate::db::{Database, StorageError};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use crate::folders_repo::upsert_folder;
    use crate::messages_repo::insert_headers;
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::NewMessageHeader;

    fn setup(db: &Database) -> i64 {
        let acc = insert_account(db, &NewAccount {
            email: "s@e.com".into(), display_name: "S".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap();
        upsert_folder(db, acc.id, "INBOX", "Inbox", FolderType::Inbox).unwrap().id
    }

    fn header(uid: i64) -> NewMessageHeader {
        NewMessageHeader {
            uid, message_id_hdr: Some(format!("<m{uid}@x>")), in_reply_to: None, references_hdr: None,
            from_address: "a@b.c".into(), from_name: None, subject: format!("S{uid}"), date: 1000,
            seen: true, flagged: false, has_attachments: false, size: 0, snippet: String::new(),
        }
    }

    fn wake_of(db: &Database, msg_id: i64) -> Option<i64> {
        db.conn().query_row(
            "SELECT snooze_wake_at FROM messages WHERE id = ?1",
            params![msg_id], |r| r.get(0),
        ).unwrap()
    }

    #[test]
    fn snooze_then_unsnooze_sets_and_clears_wake_at() {
        let db = Database::open_in_memory().unwrap();
        let folder = setup(&db);
        insert_headers(&db, folder, &[header(1)]).unwrap();
        let id: i64 = db.conn().query_row("SELECT id FROM messages WHERE uid = 1", [], |r| r.get(0)).unwrap();

        snooze_messages(&db, &[id], 5000).unwrap();
        assert_eq!(wake_of(&db, id), Some(5000));

        unsnooze_messages(&db, &[id]).unwrap();
        assert_eq!(wake_of(&db, id), None);
    }

    #[test]
    fn snooze_empty_ids_is_noop() {
        let db = Database::open_in_memory().unwrap();
        snooze_messages(&db, &[], 5000).unwrap();
        unsnooze_messages(&db, &[]).unwrap();
    }

    #[test]
    fn snooze_does_not_change_seen() {
        let db = Database::open_in_memory().unwrap();
        let folder = setup(&db);
        insert_headers(&db, folder, &[header(1)]).unwrap();
        let id: i64 = db.conn().query_row("SELECT id FROM messages WHERE uid = 1", [], |r| r.get(0)).unwrap();
        snooze_messages(&db, &[id], 5000).unwrap();
        let seen: i64 = db.conn().query_row("SELECT seen FROM messages WHERE id = ?1", params![id], |r| r.get(0)).unwrap();
        assert_eq!(seen, 1, "snooze must not touch seen");
    }
}
```

Register the module — in `crates/am-storage/src/lib.rs` add (alphabetical position, after `smart_repo` or wherever `s*` modules sit):

```rust
pub mod snooze_repo;
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test -p am-storage snooze_repo`
Expected: FAIL — `cannot find function snooze_messages` / `unsnooze_messages`.

- [ ] **Step 4: Implement set/clear**

In `crates/am-storage/src/snooze_repo.rs`, above the test module:

```rust
pub fn snooze_messages(db: &Database, ids: &[i64], wake_at: i64) -> Result<(), StorageError> {
    if ids.is_empty() {
        return Ok(());
    }
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    {
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("UPDATE messages SET snooze_wake_at = ? WHERE id IN ({placeholders})");
        let mut stmt = tx.prepare(&sql)?;
        let mut bind: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(ids.len() + 1);
        bind.push(&wake_at);
        for id in ids {
            bind.push(id);
        }
        stmt.execute(bind.as_slice())?;
    }
    tx.commit()?;
    Ok(())
}

pub fn unsnooze_messages(db: &Database, ids: &[i64]) -> Result<(), StorageError> {
    if ids.is_empty() {
        return Ok(());
    }
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    {
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("UPDATE messages SET snooze_wake_at = NULL WHERE id IN ({placeholders})");
        let mut stmt = tx.prepare(&sql)?;
        let bind: Vec<&dyn rusqlite::ToSql> = ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        stmt.execute(bind.as_slice())?;
    }
    tx.commit()?;
    Ok(())
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p am-storage snooze_repo`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add crates/am-storage/src/migrations/V9__snooze.sql crates/am-storage/src/snooze_repo.rs crates/am-storage/src/lib.rs
git commit -m "feat(snooze): V9 index + snooze_repo set/clear wake timestamps"
```

---

### Task 3: am-storage — list_snoozed + wake_due

**Files:**
- Modify: `crates/am-storage/src/snooze_repo.rs`
- Test: `crates/am-storage/src/snooze_repo.rs` (inline)

**Interfaces:**
- Consumes: `snooze_messages` (Task 2); `am_core::smart::SmartMessageRow` (Task 1).
- Produces: `snooze_repo::list_snoozed(db, now: i64, limit: i64, offset: i64) -> Result<Vec<SmartMessageRow>, StorageError>` (returns rows with `snooze_wake_at` populated, ORDER BY wake ASC); `snooze_repo::wake_due(db, now: i64) -> Result<i64, StorageError>` (clears elapsed, sets `seen=0`, recomputes thread `unread_count`, returns count woken).

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `crates/am-storage/src/snooze_repo.rs`:

```rust
    use am_core::smart::SmartMessageRow;

    fn ids_for(db: &Database) -> Vec<i64> {
        let conn = db.conn();
        let mut stmt = conn.prepare("SELECT id FROM messages ORDER BY uid").unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, i64>(0)).unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    #[test]
    fn list_snoozed_returns_future_only_sorted_ascending() {
        let db = Database::open_in_memory().unwrap();
        let folder = setup(&db);
        insert_headers(&db, folder, &[header(1), header(2), header(3)]).unwrap();
        let ids = ids_for(&db);
        snooze_messages(&db, &[ids[0]], 9000).unwrap();
        snooze_messages(&db, &[ids[1]], 7000).unwrap();
        snooze_messages(&db, &[ids[2]], 1000).unwrap();

        let rows: Vec<SmartMessageRow> = list_snoozed(&db, 5000, 10, 0).unwrap();
        assert_eq!(rows.len(), 2, "the elapsed one (1000) is excluded");
        assert_eq!(rows[0].snooze_wake_at, Some(7000), "ascending by wake time");
        assert_eq!(rows[1].snooze_wake_at, Some(9000));
    }

    #[test]
    fn wake_due_clears_and_marks_unread_and_counts() {
        let db = Database::open_in_memory().unwrap();
        let folder = setup(&db);
        insert_headers(&db, folder, &[header(1), header(2)]).unwrap();
        let ids = ids_for(&db);
        snooze_messages(&db, &[ids[0]], 1000).unwrap();
        snooze_messages(&db, &[ids[1]], 9000).unwrap();

        let count = wake_due(&db, 5000).unwrap();
        assert_eq!(count, 1, "only the elapsed message wakes");

        let conn = db.conn();
        let (wake0, seen0): (Option<i64>, i64) = conn.query_row(
            "SELECT snooze_wake_at, seen FROM messages WHERE id = ?1", params![ids[0]],
            |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(wake0, None);
        assert_eq!(seen0, 0, "woken message is marked unread");

        let wake1: Option<i64> = conn.query_row(
            "SELECT snooze_wake_at FROM messages WHERE id = ?1", params![ids[1]], |r| r.get(0)).unwrap();
        assert_eq!(wake1, Some(9000), "future message stays snoozed");
    }

    #[test]
    fn wake_due_recomputes_thread_unread_count() {
        let db = Database::open_in_memory().unwrap();
        let folder = setup(&db);
        insert_headers(&db, folder, &[header(1)]).unwrap();
        let ids = ids_for(&db);
        let tid = crate::threads_repo::create(&db, 1, "t", 1000).unwrap();
        crate::messages_repo::assign_thread(&db, ids[0], tid).unwrap();
        crate::threads_repo::recompute(&db, tid).unwrap();
        snooze_messages(&db, &[ids[0]], 1000).unwrap();

        wake_due(&db, 5000).unwrap();

        let unread: i64 = db.conn().query_row(
            "SELECT unread_count FROM threads WHERE id = ?1", params![tid], |r| r.get(0)).unwrap();
        assert_eq!(unread, 1, "thread unread_count reflects the now-unread woken message");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p am-storage snooze_repo`
Expected: FAIL — `cannot find function list_snoozed` / `wake_due`.

- [ ] **Step 3: Implement list_snoozed and wake_due**

Add to `crates/am-storage/src/snooze_repo.rs` (note `use am_core::smart::SmartMessageRow;` at the top of the file alongside the existing `use`):

At the top of the file change the imports to:

```rust
use am_core::smart::SmartMessageRow;
use rusqlite::params;

use crate::db::{Database, StorageError};
```

Then add the functions above the test module:

```rust
pub fn list_snoozed(
    db: &Database,
    now: i64,
    limit: i64,
    offset: i64,
) -> Result<Vec<SmartMessageRow>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT m.id, m.account_id, m.folder_id, a.color,
                m.from_address, m.from_name, m.subject, m.date,
                m.seen, m.flagged, m.has_attachments, m.snippet, m.snooze_wake_at
         FROM messages m
         JOIN accounts a ON a.id = m.account_id
         WHERE m.snooze_wake_at IS NOT NULL
           AND m.snooze_wake_at > ?1
           AND m.draft = 0
           AND m.deleted = 0
         ORDER BY m.snooze_wake_at ASC
         LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![now, limit, offset], |row| {
        Ok(SmartMessageRow {
            message_id: row.get(0)?,
            account_id: row.get(1)?,
            folder_id: row.get(2)?,
            account_color: row.get(3)?,
            from_address: row.get(4)?,
            from_name: row.get(5)?,
            subject: row.get(6)?,
            date: row.get(7)?,
            seen: row.get::<_, i64>(8)? != 0,
            flagged: row.get::<_, i64>(9)? != 0,
            has_attachments: row.get::<_, i64>(10)? != 0,
            snippet: row.get(11)?,
            snooze_wake_at: row.get(12)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn wake_due(db: &Database, now: i64) -> Result<i64, StorageError> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let thread_ids: Vec<i64> = {
        let mut stmt = tx.prepare(
            "SELECT DISTINCT thread_id FROM messages
             WHERE snooze_wake_at IS NOT NULL AND snooze_wake_at <= ?1 AND thread_id IS NOT NULL",
        )?;
        let rows = stmt.query_map(params![now], |r| r.get::<_, i64>(0))?;
        let mut v = Vec::new();
        for r in rows {
            v.push(r?);
        }
        v
    };
    let count = tx.execute(
        "UPDATE messages SET snooze_wake_at = NULL, seen = 0
         WHERE snooze_wake_at IS NOT NULL AND snooze_wake_at <= ?1",
        params![now],
    )?;
    for tid in &thread_ids {
        tx.execute(
            "UPDATE threads SET unread_count =
                (SELECT count(*) FROM messages WHERE thread_id = ?1 AND seen = 0)
             WHERE id = ?1",
            params![tid],
        )?;
    }
    tx.commit()?;
    Ok(count as i64)
}
```

Note: `unread_count` is updated inline inside the transaction. Do NOT call `threads_repo::recompute` here — it opens a second `db.conn()`, which deadlocks against the held `MutexGuard`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p am-storage snooze_repo`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add crates/am-storage/src/snooze_repo.rs
git commit -m "feat(snooze): list_snoozed view query and wake_due sweeper"
```

---

### Task 4: am-storage — hide snoozed from list views + Snoozed arm

**Files:**
- Modify: `crates/am-storage/src/threads_repo.rs:56-94`
- Modify: `crates/am-storage/src/messages_repo.rs:200-218`
- Modify: `crates/am-storage/src/smart_repo.rs` (`list_smart_folder`, `list_all_inboxes`, `list_unread`, `list_flagged`)
- Modify: `crates/am-storage/src/labels_repo.rs:111-137` (`list_messages_by_label`)
- Modify: `crates/am-app/src/commands.rs` (`list_threads`, `list_messages`, `list_smart_folder`, `list_messages_by_label` — pass `now`)
- Test: `crates/am-storage/src/smart_repo.rs`, `crates/am-storage/src/threads_repo.rs` (inline)

**Interfaces:**
- Consumes: `snooze_repo::list_snoozed` (Task 3); `am_sync::service::now_secs()` (existing).
- Produces (signature changes — all gain a trailing `now: i64`):
  - `threads_repo::list_for_folder(db, folder_id, limit, offset, now)`
  - `messages_repo::list_by_folder(db, folder_id, limit, offset, now)`
  - `smart_repo::list_smart_folder(db, kind, limit, offset, now)` (and private `list_all_inboxes/list_unread/list_flagged` gain `now`)
  - `labels_repo::list_messages_by_label(db, label_id, limit, offset, now)`

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `crates/am-storage/src/smart_repo.rs`:

```rust
    fn raw_set_snooze(db: &Database, folder_id: i64, uid: i64, wake: i64) {
        db.conn().execute(
            "UPDATE messages SET snooze_wake_at = ?3 WHERE folder_id = ?1 AND uid = ?2",
            params![folder_id, uid, wake],
        ).unwrap();
    }

    #[test]
    fn all_inboxes_hides_future_snoozed_shows_elapsed() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "snz@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[
            make_msg(1, 1000, false, false, false, false),
            make_msg(2, 2000, false, false, false, false),
        ]).unwrap();
        raw_set_snooze(&db, inbox, 1, 9000);
        raw_set_snooze(&db, inbox, 2, 3000);

        let rows = list_smart_folder(&db, SmartFolderKind::AllInboxes, 10, 0, 5000).unwrap();
        assert_eq!(rows.len(), 1, "future-snoozed hidden, elapsed shown");
        assert_eq!(rows[0].date, 2000);
    }

    #[test]
    fn snoozed_kind_lists_future_snoozed_ascending() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "snz2@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[
            make_msg(1, 1000, false, false, false, false),
            make_msg(2, 2000, false, false, false, false),
        ]).unwrap();
        raw_set_snooze(&db, inbox, 1, 9000);
        raw_set_snooze(&db, inbox, 2, 7000);

        let rows = list_smart_folder(&db, SmartFolderKind::Snoozed, 10, 0, 5000).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].snooze_wake_at, Some(7000));
        assert_eq!(rows[1].snooze_wake_at, Some(9000));
    }
```

Add to the `tests` module in `crates/am-storage/src/threads_repo.rs`:

```rust
    #[test]
    fn list_for_folder_hides_thread_when_all_messages_snoozed() {
        let db = Database::open_in_memory().unwrap();
        let account = crate::accounts_repo::insert_account(&db, &am_core::account::NewAccount {
            email: "th@e.com".into(), display_name: "T".into(),
            provider_type: am_core::account::ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = crate::folders_repo::upsert_folder(&db, account.id, "INBOX", "Inbox", am_core::folder::FolderType::Inbox).unwrap();
        crate::messages_repo::insert_headers(&db, folder.id, &[make_header(1, 100, "<a@x>")]).unwrap();
        let tid = create(&db, account.id, "hi", 100).unwrap();
        for h in crate::messages_repo::list_by_folder(&db, folder.id, 10, 0, 5000).unwrap() {
            crate::messages_repo::assign_thread(&db, h.id, tid).unwrap();
        }
        recompute(&db, tid).unwrap();

        let visible = list_for_folder(&db, folder.id, 10, 0, 5000).unwrap();
        assert_eq!(visible.len(), 1, "thread visible before snooze");

        db.conn().execute("UPDATE messages SET snooze_wake_at = 9000 WHERE folder_id = ?1", params![folder.id]).unwrap();
        let hidden = list_for_folder(&db, folder.id, 10, 0, 5000).unwrap();
        assert_eq!(hidden.len(), 0, "thread hidden when all messages future-snoozed");

        let woke = list_for_folder(&db, folder.id, 10, 0, 9001).unwrap();
        assert_eq!(woke.len(), 1, "thread reappears once wake time elapsed");
    }
```

- [ ] **Step 2: Run tests to verify they fail (and reveal call-site breakage)**

Run: `cargo test -p am-storage smart_repo && cargo test -p am-storage threads_repo`
Expected: FAIL — arity mismatch (`list_smart_folder`/`list_for_folder`/`list_by_folder` called with the new `now` arg) and `no variant Snoozed` arm.

- [ ] **Step 3: Add the filter to messages_repo::list_by_folder**

Replace the body of `list_by_folder` in `crates/am-storage/src/messages_repo.rs`:

```rust
pub fn list_by_folder(
    db: &Database,
    folder_id: i64,
    limit: i64,
    offset: i64,
    now: i64,
) -> Result<Vec<MessageHeader>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, account_id, folder_id, subject, from_address, from_name, date, seen, flagged, has_attachments, snippet
         FROM messages WHERE folder_id = ?1 AND draft = 0
           AND (snooze_wake_at IS NULL OR snooze_wake_at <= ?4)
         ORDER BY date DESC LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![folder_id, limit, offset, now], row_to_header)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(tuple_to_header(r?));
    }
    Ok(out)
}
```

- [ ] **Step 4: Add the filter to threads_repo::list_for_folder**

Change the signature and the inclusion subquery in `crates/am-storage/src/threads_repo.rs`:

```rust
pub fn list_for_folder(db: &Database, folder_id: i64, limit: i64, offset: i64, now: i64) -> Result<Vec<ThreadSummary>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT t.id, t.account_id, t.subject_root, t.last_date, t.message_count, t.unread_count,
                MAX(m.has_attachments), MAX(m.flagged),
                group_concat(DISTINCT COALESCE(m.from_name, m.from_address)),
                (SELECT snippet FROM messages WHERE thread_id = t.id ORDER BY date DESC LIMIT 1),
                (SELECT subject FROM messages WHERE thread_id = t.id ORDER BY date DESC LIMIT 1)
         FROM threads t
         JOIN messages m ON m.thread_id = t.id
         WHERE t.id IN (SELECT DISTINCT thread_id FROM messages
                        WHERE folder_id = ?1 AND thread_id IS NOT NULL AND draft = 0
                          AND (snooze_wake_at IS NULL OR snooze_wake_at <= ?4))
           AND m.draft = 0
         GROUP BY t.id
         ORDER BY t.last_date DESC
         LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![folder_id, limit, offset, now], |row| {
```

(The closure body that builds `ThreadSummary` is unchanged.)

- [ ] **Step 5: Add the filter + Snoozed arm to smart_repo**

In `crates/am-storage/src/smart_repo.rs`, change `list_smart_folder`:

```rust
pub fn list_smart_folder(
    db: &Database,
    kind: SmartFolderKind,
    limit: i64,
    offset: i64,
    now: i64,
) -> Result<Vec<SmartMessageRow>, StorageError> {
    match kind {
        SmartFolderKind::AllInboxes => list_all_inboxes(db, limit, offset, now),
        SmartFolderKind::Unread => list_unread(db, limit, offset, now),
        SmartFolderKind::Flagged => list_flagged(db, limit, offset, now),
        SmartFolderKind::Snoozed => crate::snooze_repo::list_snoozed(db, now, limit, offset),
    }
}
```

For each of `list_all_inboxes`, `list_unread`, `list_flagged`: add `now: i64` as the last param, add `AND (m.snooze_wake_at IS NULL OR m.snooze_wake_at <= ?3)` immediately before `ORDER BY`, and change the bind to `params![limit, offset, now]`. Example for `list_all_inboxes`:

```rust
fn list_all_inboxes(db: &Database, limit: i64, offset: i64, now: i64) -> Result<Vec<SmartMessageRow>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT m.id, m.account_id, m.folder_id, a.color,
                m.from_address, m.from_name, m.subject, m.date,
                m.seen, m.flagged, m.has_attachments, m.snippet
         FROM messages m
         JOIN folders f ON f.id = m.folder_id
         JOIN accounts a ON a.id = m.account_id
         WHERE f.folder_type = 'inbox'
           AND m.draft = 0
           AND m.deleted = 0
           AND (m.snooze_wake_at IS NULL OR m.snooze_wake_at <= ?3)
         ORDER BY m.date DESC
         LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt.query_map(params![limit, offset, now], row_to_smart)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
```

Apply the identical change (add `now` param, `AND (m.snooze_wake_at IS NULL OR m.snooze_wake_at <= ?3)` before `ORDER BY`, bind `params![limit, offset, now]`) to `list_unread` and `list_flagged`.

Then update the EXISTING smart_repo tests: every `list_smart_folder(&db, KIND, limit, offset)` call gains a trailing `now` large enough not to hide anything — use `i64::MAX`. For example `list_smart_folder(&db, SmartFolderKind::AllInboxes, 10, 0)` becomes `list_smart_folder(&db, SmartFolderKind::AllInboxes, 10, 0, i64::MAX)`. Update all such calls in the test module.

- [ ] **Step 6: Add the filter to labels_repo::list_messages_by_label**

In `crates/am-storage/src/labels_repo.rs`, change the signature to add `now: i64`, add `AND (m.snooze_wake_at IS NULL OR m.snooze_wake_at <= ?4)` before `ORDER BY`, and bind `params![label_id, limit, offset, now]`:

```rust
pub fn list_messages_by_label(db: &Database, label_id: i64, limit: i64, offset: i64, now: i64) -> Result<Vec<SmartMessageRow>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT m.id, m.account_id, m.folder_id, a.color,
                m.from_address, m.from_name, m.subject, m.date,
                m.seen, m.flagged, m.has_attachments, m.snippet
         FROM message_labels ml
         JOIN messages m ON m.id = ml.message_id
         JOIN accounts a ON a.id = m.account_id
         WHERE ml.label_id = ?1
           AND m.draft = 0
           AND m.deleted = 0
           AND (m.snooze_wake_at IS NULL OR m.snooze_wake_at <= ?4)
         ORDER BY m.date DESC
         LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![label_id, limit, offset, now], row_to_smart)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
```

(Keep the actual SELECT/JOIN text as it currently is if it differs in column aliasing; only add the `now` param, the snooze condition before `ORDER BY`, and the `now` bind.) Update existing labels_repo tests that call `list_messages_by_label(...)` to pass a trailing `i64::MAX`.

- [ ] **Step 7: Update am-app command call sites**

In `crates/am-app/src/commands.rs`, make the four list commands compute and pass `now`. Add `use am_sync::service::now_secs;` if not present (or call fully-qualified `am_sync::service::now_secs()`):

```rust
#[tauri::command]
#[specta::specta]
pub fn list_threads(
    state: tauri::State<'_, AppState>,
    folder_id: i64,
    limit: i64,
    offset: i64,
) -> Result<Vec<ThreadSummary>, String> {
    am_storage::threads_repo::list_for_folder(&state.db, folder_id, limit, offset, am_sync::service::now_secs())
        .map_err(|e| e.to_string())
}
```

Apply the same pattern (trailing `am_sync::service::now_secs()`) to `list_messages` (which calls `messages_repo::list_by_folder`), `list_smart_folder` (calls `smart_repo::list_smart_folder`), and `list_messages_by_label` (calls `labels_repo::list_messages_by_label`).

- [ ] **Step 8: Run tests to verify they pass**

Run: `cargo test -p am-storage && cargo build -p abeonmail`
Expected: PASS (storage tests green) and am-app builds with the new arities.

- [ ] **Step 9: Commit**

```bash
git add crates/am-storage/src/threads_repo.rs crates/am-storage/src/messages_repo.rs crates/am-storage/src/smart_repo.rs crates/am-storage/src/labels_repo.rs crates/am-app/src/commands.rs
git commit -m "feat(snooze): hide future-snoozed messages from list views, add Snoozed arm"
```

---

### Task 5: wake event pipeline — am-sync SnoozeWoke + sweeper + am-app plumbing

**Files:**
- Modify: `crates/am-sync/src/events.rs` (add `SyncEvent::SnoozeWoke`)
- Modify: `crates/am-sync/src/engine.rs` (add `WAKE_SWEEP_INTERVAL`, `run_wake_sweep`, `spawn_wake_sweeper`, call it in `start`)
- Modify: `crates/am-app/src/events.rs` (add `SnoozeWoke` event struct)
- Modify: `crates/am-app/src/sink.rs` (add match arm)
- Modify: `crates/am-app/src/lib.rs` (register `events::SnoozeWoke` in `collect_events!`)
- Test: `crates/am-sync/src/engine.rs` (inline), `crates/am-app/src/sink.rs` (inline)

**Interfaces:**
- Consumes: `snooze_repo::wake_due` (Task 3); `service::now_secs` (existing).
- Produces: `SyncEvent::SnoozeWoke { count: i64 }`; `engine::run_wake_sweep(db: &Database, sink: &dyn SyncEventSink)`; am-app event `SnoozeWoke { count: i64 }` emitted to the frontend as `snoozeWoke`.

- [ ] **Step 1: Write the failing test (am-sync)**

Add to the `tests` module in `crates/am-sync/src/engine.rs`:

```rust
    use am_storage::{accounts_repo, folders_repo, snooze_repo};
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::NewMessageHeader;
    use crate::events::RecordingSink;

    fn seed_due_message(db: &Database) {
        let acc = accounts_repo::insert_account(db, &NewAccount {
            email: "w@e.com".into(), display_name: "W".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = folders_repo::upsert_folder(db, acc.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        am_storage::messages_repo::insert_headers(db, folder.id, &[NewMessageHeader {
            uid: 1, message_id_hdr: Some("<w1@x>".into()), in_reply_to: None, references_hdr: None,
            from_address: "a@b.c".into(), from_name: None, subject: "S".into(), date: 100,
            seen: true, flagged: false, has_attachments: false, size: 0, snippet: String::new(),
        }]).unwrap();
        let id: i64 = db.conn().query_row("SELECT id FROM messages WHERE uid = 1", [], |r| r.get(0)).unwrap();
        snooze_repo::snooze_messages(db, &[id], 1000).unwrap();
    }

    #[test]
    fn run_wake_sweep_emits_when_messages_wake() {
        let db = Database::open_in_memory().unwrap();
        seed_due_message(&db);
        let sink = RecordingSink::new();
        run_wake_sweep_at(&db, &sink, 5000);
        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], crate::events::SyncEvent::SnoozeWoke { count: 1 }));
    }

    #[test]
    fn run_wake_sweep_silent_when_nothing_due() {
        let db = Database::open_in_memory().unwrap();
        let sink = RecordingSink::new();
        run_wake_sweep_at(&db, &sink, 5000);
        assert_eq!(sink.events.lock().unwrap().len(), 0);
    }
```

(The test uses a `now`-injectable `run_wake_sweep_at` helper for determinism; `run_wake_sweep` is the production wrapper that supplies `service::now_secs()`.)

- [ ] **Step 2: Add the SyncEvent variant**

In `crates/am-sync/src/events.rs`, add to the enum:

```rust
pub enum SyncEvent {
    Progress { account_id: i64, folder_id: i64, fetched: i64, total: i64 },
    NewMessages { account_id: i64, folder_id: i64, count: i64 },
    MailboxChanged { account_id: i64, folder_id: i64 },
    AuthChanged { account_id: i64, requires_reauth: bool },
    SnoozeWoke { count: i64 },
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test -p am-sync run_wake_sweep`
Expected: FAIL — `cannot find function run_wake_sweep_at`.

- [ ] **Step 4: Implement the sweeper**

In `crates/am-sync/src/engine.rs`, add near the top constants:

```rust
pub const WAKE_SWEEP_INTERVAL: Duration = Duration::from_secs(60);
```

Add these free functions (outside the `impl`):

```rust
pub fn run_wake_sweep_at(db: &Database, sink: &dyn SyncEventSink, now: i64) {
    match am_storage::snooze_repo::wake_due(db, now) {
        Ok(count) if count > 0 => {
            sink.emit(crate::events::SyncEvent::SnoozeWoke { count });
        }
        _ => {}
    }
}

pub fn run_wake_sweep(db: &Database, sink: &dyn SyncEventSink) {
    run_wake_sweep_at(db, sink, service::now_secs());
}
```

Add a method on `SyncEngine` and call it from `start`:

```rust
    pub fn spawn_wake_sweeper(self: &Arc<Self>) {
        let db = Arc::clone(&self.db);
        let sink = Arc::clone(&self.sink);
        tokio::spawn(async move {
            loop {
                run_wake_sweep(&db, sink.as_ref());
                tokio::time::sleep(WAKE_SWEEP_INTERVAL).await;
            }
        });
    }
```

In `start`, after the account loop and before `engine`:

```rust
        if let Ok(accounts) = accounts_repo::list_accounts(&engine.db) {
            for account in accounts {
                engine.spawn_account(account.id);
            }
        }
        engine.spawn_wake_sweeper();
        engine
```

- [ ] **Step 5: Run am-sync tests**

Run: `cargo test -p am-sync`
Expected: PASS (new sweeper tests green; existing engine tests unaffected).

- [ ] **Step 6: Add the am-app event + sink arm + registration, and a sink test**

In `crates/am-app/src/events.rs`, add:

```rust
#[derive(Serialize, Deserialize, Clone, Debug, specta::Type, tauri_specta::Event)]
pub struct SnoozeWoke {
    pub count: i64,
}
```

In `crates/am-app/src/sink.rs`, import `SnoozeWoke` and add the match arm:

```rust
use crate::events::{AccountAuthChanged, MailboxChanged, NewMessages, SnoozeWoke, SyncProgress};
```
```rust
            SyncEvent::SnoozeWoke { count } => {
                let _ = SnoozeWoke { count }.emit(&self.app);
            }
```

Add to the `tests` module in `crates/am-app/src/sink.rs`:

```rust
    #[test]
    fn snooze_woke_event_struct_has_count() {
        let ev = crate::events::SnoozeWoke { count: 3 };
        assert_eq!(ev.count, 3);
    }
```

In `crates/am-app/src/lib.rs`, register the event:

```rust
        .events(collect_events![
            events::SyncProgress,
            events::NewMessages,
            events::MailboxChanged,
            events::AccountAuthChanged,
            events::SnoozeWoke,
        ])
```

- [ ] **Step 7: Regenerate bindings and run am-app tests**

Run: `cargo test -p abeonmail && export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm run gen:bindings`
Expected: PASS; `src/ipc/bindings.ts` now exposes the `snoozeWoke` event and a `SnoozeWoke` type.

- [ ] **Step 8: Commit**

```bash
git add crates/am-sync/src/events.rs crates/am-sync/src/engine.rs crates/am-app/src/events.rs crates/am-app/src/sink.rs crates/am-app/src/lib.rs src/ipc/bindings.ts
git commit -m "feat(snooze): wake-sweeper task and SnoozeWoke event pipeline"
```

---

### Task 6: am-app — snooze/unsnooze commands

**Files:**
- Modify: `crates/am-app/src/commands.rs`
- Modify: `crates/am-app/src/lib.rs` (register the two commands)
- Test: `crates/am-app/src/commands.rs` (inline, following existing am-app command-smoke style if present)

**Interfaces:**
- Consumes: `snooze_repo::{snooze_messages, unsnooze_messages}` (Task 2).
- Produces: commands `snooze_messages(message_ids: Vec<i64>, wake_at: i64)`, `unsnooze_messages(message_ids: Vec<i64>)` → TS `snoozeMessages`, `unsnoozeMessages`.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `crates/am-app/src/commands.rs` (mirror the existing am-app command tests — if they construct `AppState` from an in-memory DB, reuse that helper). If am-app command tests call the underlying repo through a shared `AppState`, write:

```rust
    #[test]
    fn snooze_and_unsnooze_roundtrip_through_repo() {
        let db = am_storage::Database::open_in_memory().unwrap();
        let acc = am_storage::accounts_repo::insert_account(&db, &am_core::account::NewAccount {
            email: "c@e.com".into(), display_name: "C".into(),
            provider_type: am_core::account::ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = am_storage::folders_repo::upsert_folder(&db, acc.id, "INBOX", "Inbox", am_core::folder::FolderType::Inbox).unwrap();
        am_storage::messages_repo::insert_headers(&db, folder.id, &[am_core::message::NewMessageHeader {
            uid: 1, message_id_hdr: Some("<c1@x>".into()), in_reply_to: None, references_hdr: None,
            from_address: "a@b.c".into(), from_name: None, subject: "S".into(), date: 100,
            seen: true, flagged: false, has_attachments: false, size: 0, snippet: String::new(),
        }]).unwrap();
        let id: i64 = db.conn().query_row("SELECT id FROM messages WHERE uid = 1", [], |r| r.get(0)).unwrap();

        am_storage::snooze_repo::snooze_messages(&db, &[id], 9000).unwrap();
        let snoozed = am_storage::snooze_repo::list_snoozed(&db, 5000, 10, 0).unwrap();
        assert_eq!(snoozed.len(), 1);

        am_storage::snooze_repo::unsnooze_messages(&db, &[id]).unwrap();
        let after = am_storage::snooze_repo::list_snoozed(&db, 5000, 10, 0).unwrap();
        assert_eq!(after.len(), 0);
    }
```

(This validates the repo contract the commands wrap. If am-app has a `State`-based command harness in its existing tests, prefer calling the commands directly through it; otherwise this repo-level test is sufficient coverage for the thin command wrappers.)

- [ ] **Step 2: Run test to verify it fails or passes-trivially**

Run: `cargo test -p abeonmail snooze_and_unsnooze`
Expected: PASS only if repo functions exist (they do, Task 2/3). This test guards the wrapped contract; proceed to add the commands.

- [ ] **Step 3: Add the commands**

In `crates/am-app/src/commands.rs`:

```rust
#[tauri::command]
#[specta::specta]
pub fn snooze_messages(
    state: tauri::State<'_, AppState>,
    message_ids: Vec<i64>,
    wake_at: i64,
) -> Result<(), String> {
    am_storage::snooze_repo::snooze_messages(&state.db, &message_ids, wake_at).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn unsnooze_messages(
    state: tauri::State<'_, AppState>,
    message_ids: Vec<i64>,
) -> Result<(), String> {
    am_storage::snooze_repo::unsnooze_messages(&state.db, &message_ids).map_err(|e| e.to_string())
}
```

In `crates/am-app/src/lib.rs`, add to `collect_commands!`:

```rust
            commands::snooze_messages,
            commands::unsnooze_messages,
```

- [ ] **Step 4: Build, test, regenerate bindings**

Run: `cargo test -p abeonmail && export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm run gen:bindings`
Expected: PASS; `src/ipc/bindings.ts` exposes `snoozeMessages` and `unsnoozeMessages`.

- [ ] **Step 5: Commit**

```bash
git add crates/am-app/src/commands.rs crates/am-app/src/lib.rs src/ipc/bindings.ts
git commit -m "feat(snooze): snooze_messages and unsnooze_messages commands"
```

---

### Task 7: Frontend store — snooze picker slice

**Files:**
- Modify: `src/app/store.ts`
- Test: `src/app/store.test.ts` (add cases; if the file does not exist, create it following the label-picker store tests pattern)

**Interfaces:**
- Produces: `snoozePickerOpen: boolean`, `snoozePickerTargetIds: number[]`, `openSnoozePicker(ids: number[])`, `closeSnoozePicker()`.

- [ ] **Step 1: Write the failing test**

Add to `src/app/store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./store";

describe("snooze picker slice", () => {
  beforeEach(() => {
    useUiStore.getState().closeSnoozePicker();
  });

  it("opens with target ids and closes clearing them", () => {
    useUiStore.getState().openSnoozePicker([3, 7]);
    expect(useUiStore.getState().snoozePickerOpen).toBe(true);
    expect(useUiStore.getState().snoozePickerTargetIds).toEqual([3, 7]);

    useUiStore.getState().closeSnoozePicker();
    expect(useUiStore.getState().snoozePickerOpen).toBe(false);
    expect(useUiStore.getState().snoozePickerTargetIds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/app/store.test.ts`
Expected: FAIL — `openSnoozePicker is not a function`.

- [ ] **Step 3: Implement the slice**

In `src/app/store.ts`, add to the `UiState` type (near `labelPickerOpen`):

```ts
  snoozePickerOpen: boolean;
  snoozePickerTargetIds: number[];
```
and to the actions block:
```ts
  openSnoozePicker: (ids: number[]) => void;
  closeSnoozePicker: () => void;
```

Add to the store defaults (near `labelPickerOpen: false`):

```ts
  snoozePickerOpen: false,
  snoozePickerTargetIds: [],
```

Add the action implementations (near `closeLabelPicker`):

```ts
  openSnoozePicker: (ids) => set({ snoozePickerOpen: true, snoozePickerTargetIds: ids }),
  closeSnoozePicker: () => set({ snoozePickerOpen: false, snoozePickerTargetIds: [] }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/app/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/store.ts src/app/store.test.ts
git commit -m "feat(snooze): store slice for snooze picker target ids"
```

---

### Task 8: Frontend queries — useSnooze / useUnsnooze

**Files:**
- Modify: `src/ipc/queries.ts`
- Test: `src/ipc/queries.snooze.test.tsx` (create; mirror the label mutation invalidation tests)

**Interfaces:**
- Consumes: `commands.snoozeMessages`, `commands.unsnoozeMessages` (Task 6).
- Produces: `useSnooze()` (mutation `{ messageIds: number[]; wakeAt: number }`), `useUnsnooze()` (mutation `number[]`). Both invalidate `threads`, `messages`, `smart`, `labels-for-messages`, `messages-by-label`.

- [ ] **Step 1: Write the failing test**

Create `src/ipc/queries.snooze.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { commands } from "./bindings";
import { useSnooze, useUnsnooze } from "./queries";

vi.mock("./bindings", () => ({
  commands: {
    snoozeMessages: vi.fn(() => Promise.resolve({ status: "ok", data: null })),
    unsnoozeMessages: vi.fn(() => Promise.resolve({ status: "ok", data: null })),
  },
}));

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useSnooze / useUnsnooze", () => {
  beforeEach(() => vi.clearAllMocks());

  it("snooze calls command and invalidates list keys", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useSnooze(), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync({ messageIds: [5], wakeAt: 9000 });
    });
    expect(commands.snoozeMessages).toHaveBeenCalledWith([5], 9000);
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ queryKey: ["smart"] });
      expect(spy).toHaveBeenCalledWith({ queryKey: ["threads"] });
    });
  });

  it("unsnooze calls command", async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useUnsnooze(), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync([5]);
    });
    expect(commands.unsnoozeMessages).toHaveBeenCalledWith([5]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/ipc/queries.snooze.test.tsx`
Expected: FAIL — `useSnooze is not exported`.

- [ ] **Step 3: Implement the hooks**

Add to `src/ipc/queries.ts`:

```ts
export function useSnooze() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageIds, wakeAt }: { messageIds: number[]; wakeAt: number }) =>
      commands.snoozeMessages(messageIds, wakeAt).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["smart"] });
      queryClient.invalidateQueries({ queryKey: ["labels-for-messages"] });
      queryClient.invalidateQueries({ queryKey: ["messages-by-label"] });
    },
  });
}

export function useUnsnooze() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (messageIds: number[]) => commands.unsnoozeMessages(messageIds).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["smart"] });
      queryClient.invalidateQueries({ queryKey: ["labels-for-messages"] });
      queryClient.invalidateQueries({ queryKey: ["messages-by-label"] });
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/ipc/queries.snooze.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/queries.ts src/ipc/queries.snooze.test.tsx
git commit -m "feat(snooze): useSnooze and useUnsnooze query hooks"
```

---

### Task 9: Snooze presets util + SnoozePicker component

**Files:**
- Create: `src/shared/snooze/snooze.ts`
- Create: `src/features/snooze/SnoozePicker.tsx`
- Create: `src/features/snooze/SnoozePicker.css`
- Modify: `src/features/shortcuts/ShortcutsProvider.tsx` (mount `<SnoozePicker />`)
- Modify: `src/test/lucide-stub.js` (add `Calendar`)
- Test: `src/shared/snooze/snooze.test.ts`, `src/features/snooze/SnoozePicker.test.tsx`

**Interfaces:**
- Produces: `nextWeekdayAt(now: Date, weekday: number, hour: number): number` (epoch seconds), `tomorrowAt(now: Date, hour: number): number`, `presetTimestamp(kind: SnoozePresetKind, now: Date): number`, `formatWakeTime(epochSeconds: number): string`, `SNOOZE_PRESETS` (ordered list of `{ kind, label }`). `SnoozePresetKind = "later_today" | "tomorrow" | "this_weekend" | "next_week"`.
- Consumes: `useSnooze` (Task 8), store `snoozePickerOpen`/`snoozePickerTargetIds`/`closeSnoozePicker` (Task 7).

- [ ] **Step 1: Write the failing util test**

Create `src/shared/snooze/snooze.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { nextWeekdayAt, tomorrowAt, presetTimestamp, formatWakeTime } from "./snooze";

// Reference instant: Friday 2026-06-19 10:00 local.
const FRIDAY = new Date(2026, 5, 19, 10, 0, 0);

describe("snooze presets", () => {
  it("later_today is now + 3h", () => {
    const ts = presetTimestamp("later_today", FRIDAY);
    expect(ts).toBe(Math.floor(FRIDAY.getTime() / 1000) + 3 * 3600);
  });

  it("tomorrow is next day at 08:00 local", () => {
    const ts = tomorrowAt(FRIDAY, 8);
    const d = new Date(ts * 1000);
    expect(d.getDate()).toBe(20);
    expect(d.getHours()).toBe(8);
    expect(d.getMinutes()).toBe(0);
  });

  it("this_weekend is the upcoming Saturday 08:00", () => {
    const ts = nextWeekdayAt(FRIDAY, 6, 8);
    const d = new Date(ts * 1000);
    expect(d.getDay()).toBe(6);
    expect(d.getDate()).toBe(20);
    expect(d.getHours()).toBe(8);
  });

  it("next_week is the upcoming Monday 08:00", () => {
    const ts = nextWeekdayAt(FRIDAY, 1, 8);
    const d = new Date(ts * 1000);
    expect(d.getDay()).toBe(1);
    expect(d.getDate()).toBe(22);
    expect(d.getHours()).toBe(8);
  });

  it("nextWeekdayAt advances a full week when target is today but hour passed", () => {
    const satMorning = new Date(2026, 5, 20, 9, 0, 0); // Saturday 09:00, after 08:00
    const ts = nextWeekdayAt(satMorning, 6, 8);
    const d = new Date(ts * 1000);
    expect(d.getDate()).toBe(27); // next Saturday
  });

  it("formatWakeTime returns a non-empty string", () => {
    expect(formatWakeTime(Math.floor(FRIDAY.getTime() / 1000)).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/shared/snooze/snooze.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the util**

Create `src/shared/snooze/snooze.ts`:

```ts
export type SnoozePresetKind = "later_today" | "tomorrow" | "this_weekend" | "next_week";

export const SNOOZE_PRESETS: { kind: SnoozePresetKind; label: string }[] = [
  { kind: "later_today", label: "Later today" },
  { kind: "tomorrow", label: "Tomorrow" },
  { kind: "this_weekend", label: "This weekend" },
  { kind: "next_week", label: "Next week" },
];

function toEpochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export function tomorrowAt(now: Date, hour: number): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour, 0, 0, 0);
  return toEpochSeconds(d);
}

export function nextWeekdayAt(now: Date, weekday: number, hour: number): number {
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  while (candidate.getDay() !== weekday || candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return toEpochSeconds(candidate);
}

export function presetTimestamp(kind: SnoozePresetKind, now: Date): number {
  switch (kind) {
    case "later_today":
      return toEpochSeconds(now) + 3 * 3600;
    case "tomorrow":
      return tomorrowAt(now, 8);
    case "this_weekend":
      return nextWeekdayAt(now, 6, 8);
    case "next_week":
      return nextWeekdayAt(now, 1, 8);
  }
}

export function formatWakeTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
```

- [ ] **Step 4: Run util test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/shared/snooze/snooze.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing component test**

Add `Calendar` to `src/test/lucide-stub.js`:

```js
exports.Calendar = Icon;
```

Create `src/features/snooze/SnoozePicker.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useUiStore } from "../../app/store";
import { SnoozePicker } from "./SnoozePicker";

const snoozeMutate = vi.fn();
vi.mock("../../ipc/queries", () => ({
  useSnooze: () => ({ mutate: snoozeMutate }),
}));

function renderPicker() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <SnoozePicker />
    </QueryClientProvider>
  );
}

describe("SnoozePicker", () => {
  beforeEach(() => {
    snoozeMutate.mockClear();
    useUiStore.getState().closeSnoozePicker();
  });

  it("renders nothing when closed", () => {
    const { container } = renderPicker();
    expect(container.firstChild).toBeNull();
  });

  it("clicking a preset snoozes the target ids with a future timestamp", () => {
    useUiStore.getState().openSnoozePicker([5]);
    renderPicker();
    fireEvent.click(screen.getByText("Later today"));
    expect(snoozeMutate).toHaveBeenCalledTimes(1);
    const arg = snoozeMutate.mock.calls[0][0];
    expect(arg.messageIds).toEqual([5]);
    expect(arg.wakeAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(useUiStore.getState().snoozePickerOpen).toBe(false);
  });

  it("does nothing when there are no target ids", () => {
    useUiStore.getState().openSnoozePicker([]);
    renderPicker();
    fireEvent.click(screen.getByText("Tomorrow"));
    expect(snoozeMutate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run component test to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/snooze/SnoozePicker.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement the component**

Create `src/features/snooze/SnoozePicker.css`:

```css
.snooze-picker-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  background: rgba(0, 0, 0, 0.25);
  z-index: 60;
}
.snooze-picker {
  width: 320px;
  background: var(--surface);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  padding: 8px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
}
.snooze-picker__item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  background: none;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text);
  text-align: left;
}
.snooze-picker__item:hover {
  background: var(--surface-hover);
}
.snooze-picker__custom {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
}
.snooze-picker__custom input {
  flex: 1;
}
```

Create `src/features/snooze/SnoozePicker.tsx`:

```tsx
import { useState } from "react";
import { Clock, Calendar } from "lucide-react";
import { useUiStore } from "../../app/store";
import { useSnooze } from "../../ipc/queries";
import { SNOOZE_PRESETS, presetTimestamp, type SnoozePresetKind } from "../../shared/snooze/snooze";
import "./SnoozePicker.css";

export function SnoozePicker() {
  const open = useUiStore((s) => s.snoozePickerOpen);
  const targetIds = useUiStore((s) => s.snoozePickerTargetIds);
  const closeSnoozePicker = useUiStore((s) => s.closeSnoozePicker);
  const snooze = useSnooze();
  const [custom, setCustom] = useState("");

  if (!open) return null;

  function apply(wakeAt: number) {
    if (targetIds.length === 0) {
      closeSnoozePicker();
      return;
    }
    snooze.mutate({ messageIds: targetIds, wakeAt });
    closeSnoozePicker();
  }

  function applyPreset(kind: SnoozePresetKind) {
    apply(presetTimestamp(kind, new Date()));
  }

  function applyCustom() {
    if (!custom) return;
    const ms = new Date(custom).getTime();
    if (Number.isNaN(ms)) return;
    apply(Math.floor(ms / 1000));
  }

  return (
    <div className="snooze-picker-overlay" role="presentation" onClick={closeSnoozePicker}>
      <div className="snooze-picker" role="dialog" aria-label="Snooze until" onClick={(e) => e.stopPropagation()}>
        {SNOOZE_PRESETS.map((p) => (
          <button key={p.kind} type="button" className="snooze-picker__item" onClick={() => applyPreset(p.kind)}>
            <Clock size={15} />
            <span>{p.label}</span>
          </button>
        ))}
        <div className="snooze-picker__custom">
          <Calendar size={15} />
          <input
            type="datetime-local"
            aria-label="Pick date and time"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
          <button type="button" onClick={applyCustom}>Set</button>
        </div>
      </div>
    </div>
  );
}
```

Mount it in `src/features/shortcuts/ShortcutsProvider.tsx`: add the import and render alongside `<LabelPicker />`:

```tsx
import { SnoozePicker } from "../snooze/SnoozePicker";
```
```tsx
      <CommandPalette />
      <CheatSheet />
      <LabelPicker />
      <SnoozePicker />
```

- [ ] **Step 8: Run component test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/snooze/SnoozePicker.test.tsx`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/shared/snooze/snooze.ts src/shared/snooze/snooze.test.ts src/features/snooze/SnoozePicker.tsx src/features/snooze/SnoozePicker.css src/features/snooze/SnoozePicker.test.tsx src/features/shortcuts/ShortcutsProvider.tsx src/test/lucide-stub.js
git commit -m "feat(snooze): preset util and SnoozePicker popover"
```

---

### Task 10: MailboxRail — live Snoozed entry

**Files:**
- Modify: `src/features/mailbox/MailboxRail.tsx:51-55` (add Snoozed to `SMART_FOLDERS`), `:439-442` (remove placeholder)
- Test: `src/features/mailbox/MailboxRail.test.tsx` (add a case; reuse the existing test setup)

**Interfaces:**
- Consumes: `setSelectedSmartFolder("snoozed")` (store), `SmartFolderKind` (`"snoozed"`).

- [ ] **Step 1: Write the failing test**

Add to `src/features/mailbox/MailboxRail.test.tsx` (follow the file's existing render helper and mocks):

```tsx
  it("renders a Snoozed smart folder and selects it on click", () => {
    renderRail();
    const snoozed = screen.getByText("Snoozed");
    fireEvent.click(snoozed);
    expect(useUiStore.getState().selectedSmartFolder).toBe("snoozed");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/mailbox/MailboxRail.test.tsx`
Expected: FAIL — the placeholder "Snoozed" div is `aria-disabled` and has no click handler, so `selectedSmartFolder` stays `null`.

- [ ] **Step 3: Add Snoozed to SMART_FOLDERS and remove the placeholder**

In `src/features/mailbox/MailboxRail.tsx`, extend the constant:

```tsx
const SMART_FOLDERS: { label: string; kind: SmartFolderKind; Icon: React.ElementType }[] = [
  { label: "All Inboxes", kind: "all_inboxes", Icon: Layers },
  { label: "Unread", kind: "unread", Icon: MailOpen },
  { label: "Flagged", kind: "flagged", Icon: Flag },
  { label: "Snoozed", kind: "snoozed", Icon: Clock },
];
```

Delete the placeholder block at lines 439-442:

```tsx
        <div className="rail__item" aria-disabled="true">
          <Clock size={15} className="rail__item-icon" />
          <span className="rail__item-label">Snoozed</span>
        </div>
```

(Keep the `Clock` import — it is now used by `SMART_FOLDERS`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/mailbox/MailboxRail.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/mailbox/MailboxRail.tsx src/features/mailbox/MailboxRail.test.tsx
git commit -m "feat(snooze): live Snoozed entry in the mailbox rail"
```

---

### Task 11: MessageListPane — snooze toolbar + wake-time row label

**Files:**
- Modify: `src/features/message-list/MessageListPane.tsx`
- Test: `src/features/message-list/MessageListPane.test.tsx` (add cases)

**Interfaces:**
- Consumes: `openSnoozePicker` (store, Task 7), `useUnsnooze` (Task 8), `formatWakeTime` (Task 9), `SmartMessageRow.snooze_wake_at` (Task 1).

- [ ] **Step 1: Write the failing test**

Add to `src/features/message-list/MessageListPane.test.tsx` (use the file's existing `setupStore` / render helpers; the snippet below shows the assertions — adapt the arrange step to the file's mock conventions for `useSmartFolder`):

```tsx
  it("selection toolbar shows Snooze in a flat non-snoozed view and opens the picker", () => {
    // arrange: smart folder = "unread", selectionActive with one selected id (per file's helpers)
    // ...render...
    const snoozeBtn = screen.getByRole("button", { name: "Snooze" });
    fireEvent.click(snoozeBtn);
    expect(useUiStore.getState().snoozePickerOpen).toBe(true);
  });

  it("selection toolbar shows Unsnooze in the Snoozed view", () => {
    // arrange: selectedSmartFolder = "snoozed", selectionActive, one selected id
    // ...render...
    expect(screen.getByRole("button", { name: "Unsnooze" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Snooze" })).toBeNull();
  });

  it("renders a wake-time label for rows with snooze_wake_at", () => {
    // arrange: useSmartFolder("snoozed") returns one row with snooze_wake_at set
    // ...render...
    expect(screen.getByTestId("snooze-wake").textContent?.length).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/message-list/MessageListPane.test.tsx`
Expected: FAIL — no Snooze/Unsnooze buttons; no wake-time element.

- [ ] **Step 3: Wire the store/query handles**

In `MessageListPane.tsx`, add near the other store selectors (around line 235):

```tsx
  const openSnoozePicker = useUiStore((s) => s.openSnoozePicker);
```
add the import and the unsnooze hook:
```tsx
import { useThreads, useSmartFolder, useSearch, useLabelsForMessages, useMessagesByLabel, useLabels, useUnsnooze } from "../../ipc/queries";
import { formatWakeTime } from "../../shared/snooze/snooze";
```
```tsx
  const unsnooze = useUnsnooze();
  const isSnoozedView = isSmartMode && selectedSmartFolder === "snoozed";
```

- [ ] **Step 4: Update the selection toolbar**

Replace the `Label`/`Cancel` button group inside `message-list__selection-bar` so it offers Snooze (flat non-snoozed views) or Unsnooze (Snoozed view), keeping the existing Label button:

```tsx
      {isFlatMode && selectionActive && (
        <div className="message-list__selection-bar" role="toolbar" aria-label="Selection actions">
          <span>{selectedMessageIds.length} selected</span>
          <button
            type="button"
            disabled={selectedMessageIds.length === 0}
            onClick={() => openLabelPicker(selectedMessageIds)}
          >
            Label
          </button>
          {isSnoozedView ? (
            <button
              type="button"
              disabled={selectedMessageIds.length === 0}
              onClick={() => {
                unsnooze.mutate(selectedMessageIds);
                clearSelection();
              }}
            >
              Unsnooze
            </button>
          ) : (
            <button
              type="button"
              disabled={selectedMessageIds.length === 0}
              onClick={() => openSnoozePicker(selectedMessageIds)}
            >
              Snooze
            </button>
          )}
          <button type="button" onClick={() => clearSelection()}>
            Cancel
          </button>
        </div>
      )}
```

- [ ] **Step 5: Render the wake-time label in SmartRow**

Add a prop to `SmartRow`'s parameter list and type:

```tsx
  wakeAt,
}: {
  // ...existing props...
  wakeAt?: number | null;
}) {
```

Render it inside `message-row__badges`, after the `LabelChips`:

```tsx
            {labels && labels.length > 0 && <LabelChips labels={labels} />}
            {wakeAt != null && (
              <span className="message-row__snooze" data-testid="snooze-wake">
                {formatWakeTime(wakeAt)}
              </span>
            )}
```

Pass it where `SmartRow` is rendered (around line 440):

```tsx
                      labels={labelsByMessage.get(row.message_id)}
                      wakeAt={row.snooze_wake_at}
                      selectable={selectionActive}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/message-list/MessageListPane.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/message-list/MessageListPane.tsx src/features/message-list/MessageListPane.test.tsx
git commit -m "feat(snooze): list selection Snooze/Unsnooze actions and wake-time label"
```

---

### Task 12: ConversationView — enable the reader Snooze button

**Files:**
- Modify: `src/features/reader/ConversationView.tsx:46-48`
- Test: `src/features/reader/ConversationView.test.tsx` (add a case; reuse existing setup)

**Interfaces:**
- Consumes: `openSnoozePicker` (store). Snoozes the WHOLE conversation — passes every displayed message id.

- [ ] **Step 1: Write the failing test**

Add to `src/features/reader/ConversationView.test.tsx` (mirror the file's mock of `useThreadMessages`; assume a thread with message ids `[10, 11]`):

```tsx
  it("Snooze button opens the picker for all messages in the conversation", () => {
    // arrange: useThreadMessages returns two messages with ids 10 and 11
    // ...render <ConversationView threadId={1} />...
    fireEvent.click(screen.getByRole("button", { name: "Snooze" }));
    expect(useUiStore.getState().snoozePickerOpen).toBe(true);
    expect(useUiStore.getState().snoozePickerTargetIds).toEqual([10, 11]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/reader/ConversationView.test.tsx`
Expected: FAIL — the Snooze button is `aria-disabled` with no handler.

- [ ] **Step 3: Wire the button**

In `ConversationView.tsx`, add the store action near the existing `openLabelPicker`:

```tsx
  const openSnoozePicker = useUiStore((s) => s.openSnoozePicker);
```

Replace the placeholder Snooze button (lines 46-48):

```tsx
        <button
          type="button"
          className="reader__icon"
          aria-label="Snooze"
          onClick={() => openSnoozePicker(messages.map((m) => m.id))}
        >
          <Clock size={18} />
        </button>
```

(`messages` is in scope after the early returns; the toolbar renders only when messages exist.)

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/reader/ConversationView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/reader/ConversationView.tsx src/features/reader/ConversationView.test.tsx
git commit -m "feat(snooze): reader Snooze button snoozes the whole conversation"
```

---

### Task 13: Shortcut + command palette + wake event listener + cross-suite mocks

**Files:**
- Modify: `src/features/shortcuts/registry.ts:60` (enable `snooze`, add `list` context)
- Modify: `src/features/shortcuts/ShortcutsProvider.tsx` (add `snooze` handler)
- Modify: `src/ipc/events.ts` (listen `snoozeWoke`)
- Modify: `src/app/AppShell.test.tsx` (add `useSnooze`/`useUnsnooze` to its queries mock and `snoozePickerOpen`/`snoozePickerTargetIds`/`openSnoozePicker`/`closeSnoozePicker` to its store mock if it mocks the store)
- Test: `src/features/shortcuts/registry.test.ts` (or the existing shortcuts test), `src/ipc/events.test.ts` if present

**Interfaces:**
- Consumes: store `openSnoozePicker`, `selectionActive`, `selectedMessageIds`, `replyTargetId`; query keys for invalidation.

- [ ] **Step 1: Write the failing tests**

Add to `src/features/shortcuts/registry.test.ts` (or wherever ACTIONS is asserted):

```ts
  it("snooze action is enabled and available in reader and list", () => {
    const snooze = ACTIONS.find((a) => a.id === "snooze")!;
    expect(snooze.enabled).toBe(true);
    expect(snooze.contexts).toContain("reader");
    expect(snooze.contexts).toContain("list");
    expect(snooze.defaultBinding).toBe("b");
  });
```

(Ensure `ACTIONS` is imported in that test file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/shortcuts/registry.test.ts`
Expected: FAIL — `snooze.enabled` is `false`, contexts is `["reader"]`.

- [ ] **Step 3: Enable the action**

In `src/features/shortcuts/registry.ts`, change the snooze line:

```ts
  { id: "snooze", label: "Snooze", contexts: ["reader", "list"], defaultBinding: "b", enabled: true },
```

- [ ] **Step 4: Add the handler**

In `src/features/shortcuts/ShortcutsProvider.tsx`, add to the `handlers` map (next to `label`):

```tsx
      snooze: () => {
        const s = useUiStore.getState();
        if (s.selectionActive && s.selectedMessageIds.length > 0) {
          s.openSnoozePicker(s.selectedMessageIds);
        } else if (s.replyTargetId != null) {
          s.openSnoozePicker([s.replyTargetId]);
        }
      },
```

- [ ] **Step 5: Add the wake event listener**

In `src/ipc/events.ts`, add a `snoozeWoke` listener inside the `useEffect`, and clean it up in the return:

```ts
    const snoozeWokePromise = events.snoozeWoke.listen(() => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["smart"] });
    });
```
```ts
    return () => {
      progressPromise.then((unlisten) => unlisten());
      messagesPromise.then((unlisten) => unlisten());
      mailboxPromise.then((unlisten) => unlisten());
      authChangedPromise.then((unlisten) => unlisten());
      snoozeWokePromise.then((unlisten) => unlisten());
    };
```

- [ ] **Step 6: Update cross-suite mocks**

In `src/app/AppShell.test.tsx`, if it mocks `../ipc/queries`, add `useSnooze: () => ({ mutate: vi.fn() })` and `useUnsnooze: () => ({ mutate: vi.fn() })`. If it mocks the store object literal, add `snoozePickerOpen: false`, `snoozePickerTargetIds: []`, `openSnoozePicker: vi.fn()`, `closeSnoozePicker: vi.fn()`. (Match the exact mock style already in that file.)

- [ ] **Step 7: Run the full frontend suite**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run`
Expected: PASS across all suites (catches cross-suite mock gaps that single-file runs miss).

- [ ] **Step 8: Build the frontend**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm run build`
Expected: tsc + vite succeed (no unused imports, no type errors).

- [ ] **Step 9: Commit**

```bash
git add src/features/shortcuts/registry.ts src/features/shortcuts/ShortcutsProvider.tsx src/ipc/events.ts src/app/AppShell.test.tsx src/features/shortcuts/registry.test.ts
git commit -m "feat(snooze): enable snooze shortcut, command palette entry, and wake event refresh"
```

---

## Final verification (run after all tasks)

- [ ] `cargo test --workspace --lib --bins` — all Rust unit/lib/bin tests pass (GreenMail Docker integration tests are orthogonal; this etap does not touch am-protocols/am-sync IMAP paths beyond the new sweeper).
- [ ] `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run` — full frontend suite passes.
- [ ] `npm run build` — clean.
- [ ] Manual smoke (optional): snooze a thread from the reader → it leaves the inbox and appears under Snoozed with a wake time; multi-select snooze from a smart folder; Unsnooze from the Snoozed view restores it; a past-due wake clears it back to the inbox marked unread within ~60 s.
