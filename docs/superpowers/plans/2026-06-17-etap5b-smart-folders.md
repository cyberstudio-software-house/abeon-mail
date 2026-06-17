# Etap 5B — Smart Folders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three live cross-account smart folders (All Inboxes, Unread, Flagged) — storage queries, Tauri command, frontend store + query + event wiring, and UI list rendering.

**Architecture:** A new `am-core::smart` module holds the `SmartFolderKind` enum and `SmartMessageRow` struct shared across crates. A new `am-storage::smart_repo` module runs three parameterised SQL queries that JOIN `messages`, `folders`, and `accounts`, returning flat paginated results (no cross-account threading — intentionally flat by spec). A new `list_smart_folder` Tauri command exposes this to the frontend. The frontend adds a `selectedSmartFolder` selection state with mutual exclusion, a `useSmartFolder` query hook, event invalidation for `["smart"]`, and rewires `MailboxRail` + `MessageListPane` to render the three enabled smart folder entries with account-colour dots.

**Tech Stack:** Rust (rusqlite, serde, specta, tauri-specta), TypeScript/React (zustand, @tanstack/react-query, @tanstack/react-virtual), Vitest + @testing-library/react

## Global Constraints

- Code identifiers (vars, consts, types, fns) English-only. No code comments — durable notes go to `docs/`.
- Secrets (passwords, refresh tokens, access tokens) ONLY in OS keychain (refresh) or process memory (access). NEVER in DB, logs, events, error messages, or `Debug` impls.
- Node 24 at `$HOME/.nvm/versions/node/v24.14.0/bin` (prepend to PATH for `npm`).
- Rust: `cargo test -p <crate>` per crate; full `cargo test` before merge.
- Frontend: `npm test` (vitest), `npm run gen:bindings` after any command/event/type change touching tauri-specta.
- TLS provider is ring throughout; new HTTP deps must use rustls+ring, not native-tls.
- `git commit` messages follow Conventional Commits; no co-author line; no push.

### Execution order note

5A → **5B** → 5C. 5B owns the V5 migration file. The file contains all three SQL statements so that 5C can consume `requires_reauth` without re-adding it.

---

## File Map

| Action | Path |
|--------|------|
| Create | `crates/am-core/src/smart.rs` |
| Modify | `crates/am-core/src/lib.rs` |
| Create | `crates/am-storage/src/migrations/V5__oauth_smart.sql` |
| Create | `crates/am-storage/src/smart_repo.rs` |
| Modify | `crates/am-storage/src/lib.rs` |
| Modify | `crates/am-app/src/commands.rs` |
| Modify | `crates/am-app/src/lib.rs` |
| Modify | `src/app/store.ts` |
| Modify | `src/ipc/queries.ts` |
| Modify | `src/ipc/events.ts` |
| Modify | `src/features/mailbox/MailboxRail.tsx` |
| Modify | `src/features/mailbox/MailboxRail.test.tsx` |
| Modify | `src/features/message-list/MessageListPane.tsx` |
| Modify | `src/features/message-list/MessageListPane.test.tsx` |

---

### Task 1: `am-core` — `SmartFolderKind` + `SmartMessageRow`

**Files:**
- Create: `crates/am-core/src/smart.rs`
- Modify: `crates/am-core/src/lib.rs`

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `am_core::smart::SmartFolderKind` — `#[serde(rename_all = "snake_case")]` enum with variants `AllInboxes`, `Unread`, `Flagged`
  - `am_core::smart::SmartMessageRow` — struct with fields listed below; re-exported from `am_core`

- [ ] **Step 1: Write the failing test**

Open `crates/am-core/src/smart.rs` (does not exist yet — create it) and write:

```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SmartFolderKind {
    AllInboxes,
    Unread,
    Flagged,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug)]
pub struct SmartMessageRow {
    pub message_id: i64,
    pub account_id: i64,
    pub folder_id: i64,
    pub account_color: Option<String>,
    pub from_address: String,
    pub from_name: Option<String>,
    pub subject: String,
    pub date: i64,
    pub seen: bool,
    pub flagged: bool,
    pub has_attachments: bool,
    pub snippet: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smart_folder_kind_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&SmartFolderKind::AllInboxes).unwrap(),
            "\"all_inboxes\""
        );
        assert_eq!(
            serde_json::to_string(&SmartFolderKind::Unread).unwrap(),
            "\"unread\""
        );
        assert_eq!(
            serde_json::to_string(&SmartFolderKind::Flagged).unwrap(),
            "\"flagged\""
        );
    }

    #[test]
    fn smart_folder_kind_deserializes_snake_case() {
        let k: SmartFolderKind = serde_json::from_str("\"all_inboxes\"").unwrap();
        assert_eq!(k, SmartFolderKind::AllInboxes);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cargo test -p am-core 2>&1 | tail -20
```

Expected: compile error — `am_core::smart` module not found (because `lib.rs` not yet updated).

- [ ] **Step 3: Export the module from `lib.rs`**

Edit `crates/am-core/src/lib.rs`. The current content is:

```rust
pub mod account;
pub mod error;
pub mod folder;
pub mod message;
pub mod outgoing;
pub mod signature;
pub mod thread;
pub mod threading;
```

Add `pub mod smart;` so the file becomes:

```rust
pub mod account;
pub mod error;
pub mod folder;
pub mod message;
pub mod outgoing;
pub mod signature;
pub mod smart;
pub mod thread;
pub mod threading;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p am-core 2>&1 | tail -20
```

Expected output contains:
```
test smart::tests::smart_folder_kind_serializes_snake_case ... ok
test smart::tests::smart_folder_kind_deserializes_snake_case ... ok
```

- [ ] **Step 5: Commit**

```bash
git add crates/am-core/src/smart.rs crates/am-core/src/lib.rs
git commit -m "feat(am-core): add SmartFolderKind and SmartMessageRow"
```

---

### Task 2: V5 migration + `smart_repo` AllInboxes query

**Files:**
- Create: `crates/am-storage/src/migrations/V5__oauth_smart.sql`
- Create: `crates/am-storage/src/smart_repo.rs`
- Modify: `crates/am-storage/src/lib.rs`

**Interfaces:**
- Consumes:
  - `am_core::smart::{SmartFolderKind, SmartMessageRow}` (Task 1)
  - `am_storage::db::{Database, StorageError}`
  - `am_storage::accounts_repo::insert_account`
  - `am_storage::folders_repo::upsert_folder`
  - `am_storage::messages_repo::insert_headers`
  - `am_core::account::{NewAccount, ProviderType}`
  - `am_core::folder::FolderType`
  - `am_core::message::NewMessageHeader`
- Produces:
  - `am_storage::smart_repo::list_smart_folder(db: &Database, kind: SmartFolderKind, limit: i64, offset: i64) -> Result<Vec<SmartMessageRow>, StorageError>` — AllInboxes variant fully implemented; Unread and Flagged stubbed to return empty `Vec` (Task 3 completes them)

#### V5 migration owns all three statements

The migration file is shared with 5C. 5C consumes `requires_reauth` without re-adding it. Create `crates/am-storage/src/migrations/V5__oauth_smart.sql`:

```sql
ALTER TABLE accounts ADD COLUMN requires_reauth INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_messages_seen_date ON messages(seen, date DESC);
CREATE INDEX idx_messages_flagged_date ON messages(flagged, date DESC);
```

- [ ] **Step 1: Write the failing test**

Create `crates/am-storage/src/smart_repo.rs` with the test first (the impl will be added in Step 3):

```rust
use am_core::smart::{SmartFolderKind, SmartMessageRow};
use rusqlite::params;

use crate::db::{Database, StorageError};

pub fn list_smart_folder(
    db: &Database,
    kind: SmartFolderKind,
    limit: i64,
    offset: i64,
) -> Result<Vec<SmartMessageRow>, StorageError> {
    match kind {
        SmartFolderKind::AllInboxes => list_all_inboxes(db, limit, offset),
        SmartFolderKind::Unread => Ok(Vec::new()),
        SmartFolderKind::Flagged => Ok(Vec::new()),
    }
}

fn row_to_smart(row: &rusqlite::Row) -> rusqlite::Result<SmartMessageRow> {
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
    })
}

fn list_all_inboxes(db: &Database, limit: i64, offset: i64) -> Result<Vec<SmartMessageRow>, StorageError> {
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
         ORDER BY m.date DESC
         LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt.query_map(params![limit, offset], row_to_smart)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use crate::folders_repo::upsert_folder;
    use crate::messages_repo::insert_headers;
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::NewMessageHeader;

    fn make_account(db: &Database, email: &str, color: Option<&str>) -> i64 {
        insert_account(
            db,
            &NewAccount {
                email: email.into(),
                display_name: email.into(),
                provider_type: ProviderType::ImapPassword,
                color: color.map(|s| s.to_string()),
            },
        )
        .unwrap()
        .id
    }

    fn make_folder(db: &Database, account_id: i64, name: &str, ft: FolderType) -> i64 {
        upsert_folder(db, account_id, name, name, ft).unwrap().id
    }

    fn make_msg(uid: i64, date: i64, seen: bool, flagged: bool, draft: bool, deleted: bool) -> NewMessageHeader {
        NewMessageHeader {
            uid,
            message_id_hdr: Some(format!("<msg-{uid}@example.com>")),
            in_reply_to: None,
            references_hdr: None,
            from_address: "sender@example.com".into(),
            from_name: Some("Sender".into()),
            subject: format!("Subject {uid}"),
            date,
            seen,
            flagged,
            has_attachments: false,
            size: 512,
            snippet: "preview".into(),
        }
    }

    fn raw_insert_flags(db: &Database, folder_id: i64, uid: i64, draft: bool, deleted: bool) {
        let conn = db.conn();
        conn.execute(
            "UPDATE messages SET draft = ?3, deleted = ?4 WHERE folder_id = ?1 AND uid = ?2",
            params![folder_id, uid, draft as i64, deleted as i64],
        )
        .unwrap();
    }

    #[test]
    fn all_inboxes_cross_account_ordered_date_desc() {
        let db = Database::open_in_memory().unwrap();

        let acc1 = make_account(&db, "a@example.com", Some("#ff0000"));
        let acc2 = make_account(&db, "b@example.com", Some("#00ff00"));

        let inbox1 = make_folder(&db, acc1, "INBOX", FolderType::Inbox);
        let inbox2 = make_folder(&db, acc2, "INBOX", FolderType::Inbox);

        insert_headers(&db, inbox1, &[make_msg(1, 1000, false, false, false, false)]).unwrap();
        insert_headers(&db, inbox2, &[make_msg(2, 3000, false, false, false, false)]).unwrap();
        insert_headers(&db, inbox1, &[make_msg(3, 2000, false, false, false, false)]).unwrap();

        let rows = list_smart_folder(&db, SmartFolderKind::AllInboxes, 10, 0).unwrap();

        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].date, 3000, "first row should be most recent");
        assert_eq!(rows[1].date, 2000);
        assert_eq!(rows[2].date, 1000);

        let row_acc2 = rows.iter().find(|r| r.date == 3000).unwrap();
        assert_eq!(row_acc2.account_id, acc2);
        assert_eq!(row_acc2.account_color.as_deref(), Some("#00ff00"));

        let row_acc1_2000 = rows.iter().find(|r| r.date == 2000).unwrap();
        assert_eq!(row_acc1_2000.account_id, acc1);
        assert_eq!(row_acc1_2000.account_color.as_deref(), Some("#ff0000"));
    }

    #[test]
    fn all_inboxes_excludes_non_inbox_folders() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "c@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        let sent = make_folder(&db, acc, "Sent", FolderType::Sent);

        insert_headers(&db, inbox, &[make_msg(1, 1000, false, false, false, false)]).unwrap();
        insert_headers(&db, sent, &[make_msg(2, 2000, false, false, false, false)]).unwrap();

        let rows = list_smart_folder(&db, SmartFolderKind::AllInboxes, 10, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].date, 1000);
    }

    #[test]
    fn all_inboxes_pagination() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "d@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);

        insert_headers(
            &db,
            inbox,
            &[
                make_msg(1, 1000, false, false, false, false),
                make_msg(2, 3000, false, false, false, false),
                make_msg(3, 2000, false, false, false, false),
            ],
        )
        .unwrap();

        let page1 = list_smart_folder(&db, SmartFolderKind::AllInboxes, 2, 0).unwrap();
        let page2 = list_smart_folder(&db, SmartFolderKind::AllInboxes, 2, 2).unwrap();
        assert_eq!(page1.len(), 2);
        assert_eq!(page2.len(), 1);
        assert_eq!(page1[0].date, 3000);
        assert_eq!(page2[0].date, 1000);
    }

    #[test]
    fn all_inboxes_excludes_draft_and_deleted() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "e@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);

        insert_headers(
            &db,
            inbox,
            &[
                make_msg(1, 1000, false, false, false, false),
                make_msg(2, 2000, false, false, false, false),
                make_msg(3, 3000, false, false, false, false),
            ],
        )
        .unwrap();

        raw_insert_flags(&db, inbox, 2, true, false);
        raw_insert_flags(&db, inbox, 3, false, true);

        let rows = list_smart_folder(&db, SmartFolderKind::AllInboxes, 10, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].message_id > 0, true);
        assert_eq!(rows[0].date, 1000);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cargo test -p am-storage smart_repo 2>&1 | tail -30
```

Expected: compile error — `mod smart_repo` not declared in `lib.rs`, and the V5 migration is missing.

- [ ] **Step 3: Create the migration file**

Create `crates/am-storage/src/migrations/V5__oauth_smart.sql`:

```sql
ALTER TABLE accounts ADD COLUMN requires_reauth INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_messages_seen_date ON messages(seen, date DESC);
CREATE INDEX idx_messages_flagged_date ON messages(flagged, date DESC);
```

- [ ] **Step 4: Register `smart_repo` in `am-storage/src/lib.rs`**

Edit `crates/am-storage/src/lib.rs`. Current content:

```rust
mod db;
pub mod accounts_repo;
pub mod attachments_repo;
pub mod drafts_repo;
pub mod folders_repo;
pub mod messages_repo;
pub mod queue_repo;
pub mod signatures_repo;
pub mod threads_repo;

pub use db::{Database, StorageError};
```

New content:

```rust
mod db;
pub mod accounts_repo;
pub mod attachments_repo;
pub mod drafts_repo;
pub mod folders_repo;
pub mod messages_repo;
pub mod queue_repo;
pub mod signatures_repo;
pub mod smart_repo;
pub mod threads_repo;

pub use db::{Database, StorageError};
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cargo test -p am-storage smart_repo 2>&1 | tail -30
```

Expected output contains lines like:
```
test smart_repo::tests::all_inboxes_cross_account_ordered_date_desc ... ok
test smart_repo::tests::all_inboxes_excludes_non_inbox_folders ... ok
test smart_repo::tests::all_inboxes_pagination ... ok
test smart_repo::tests::all_inboxes_excludes_draft_and_deleted ... ok
```

- [ ] **Step 6: Verify migration test in db.rs still passes**

```bash
cargo test -p am-storage db 2>&1 | tail -10
```

Expected: all db tests pass (the V5 migration runs automatically via `open_in_memory`).

- [ ] **Step 7: Commit**

```bash
git add crates/am-storage/src/migrations/V5__oauth_smart.sql \
        crates/am-storage/src/smart_repo.rs \
        crates/am-storage/src/lib.rs
git commit -m "feat(am-storage): V5 migration and smart_repo AllInboxes query"
```

---

### Task 3: Extend `smart_repo` for Unread and Flagged

**Files:**
- Modify: `crates/am-storage/src/smart_repo.rs`

**Interfaces:**
- Consumes:
  - `list_smart_folder` stub from Task 2
- Produces:
  - `list_smart_folder` fully implemented for all three `SmartFolderKind` variants

- [ ] **Step 1: Write the failing tests**

Add the following tests to the `#[cfg(test)] mod tests` block at the bottom of `crates/am-storage/src/smart_repo.rs` (inside the existing `mod tests { ... }` block, after the last existing test):

```rust
    #[test]
    fn unread_excludes_trash_and_spam() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "f@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        let trash = make_folder(&db, acc, "Trash", FolderType::Trash);
        let spam = make_folder(&db, acc, "Spam", FolderType::Spam);

        insert_headers(&db, inbox, &[make_msg(1, 1000, false, false, false, false)]).unwrap();
        insert_headers(&db, trash, &[make_msg(2, 2000, false, false, false, false)]).unwrap();
        insert_headers(&db, spam, &[make_msg(3, 3000, false, false, false, false)]).unwrap();

        let rows = list_smart_folder(&db, SmartFolderKind::Unread, 10, 0).unwrap();
        assert_eq!(rows.len(), 1, "only inbox unseen message should appear");
        assert_eq!(rows[0].date, 1000);
    }

    #[test]
    fn unread_excludes_seen_messages() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "g@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);

        insert_headers(&db, inbox, &[
            make_msg(1, 1000, true, false, false, false),
            make_msg(2, 2000, false, false, false, false),
        ]).unwrap();

        let rows = list_smart_folder(&db, SmartFolderKind::Unread, 10, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].date, 2000);
        assert!(!rows[0].seen);
    }

    #[test]
    fn unread_excludes_draft_and_deleted() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "h@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);

        insert_headers(&db, inbox, &[
            make_msg(1, 1000, false, false, false, false),
            make_msg(2, 2000, false, false, false, false),
            make_msg(3, 3000, false, false, false, false),
        ]).unwrap();
        raw_insert_flags(&db, inbox, 2, true, false);
        raw_insert_flags(&db, inbox, 3, false, true);

        let rows = list_smart_folder(&db, SmartFolderKind::Unread, 10, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].date, 1000);
    }

    #[test]
    fn flagged_excludes_trash_and_spam() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "i@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        let trash = make_folder(&db, acc, "Trash", FolderType::Trash);
        let spam = make_folder(&db, acc, "Spam", FolderType::Spam);

        insert_headers(&db, inbox, &[make_msg(1, 1000, false, true, false, false)]).unwrap();
        insert_headers(&db, trash, &[make_msg(2, 2000, false, true, false, false)]).unwrap();
        insert_headers(&db, spam, &[make_msg(3, 3000, false, true, false, false)]).unwrap();

        let rows = list_smart_folder(&db, SmartFolderKind::Flagged, 10, 0).unwrap();
        assert_eq!(rows.len(), 1, "only inbox flagged message should appear");
        assert_eq!(rows[0].date, 1000);
    }

    #[test]
    fn flagged_excludes_unflagged_messages() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "j@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);

        insert_headers(&db, inbox, &[
            make_msg(1, 1000, false, false, false, false),
            make_msg(2, 2000, false, true, false, false),
        ]).unwrap();

        let rows = list_smart_folder(&db, SmartFolderKind::Flagged, 10, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].date, 2000);
        assert!(rows[0].flagged);
    }

    #[test]
    fn flagged_excludes_draft_and_deleted() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "k@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);

        insert_headers(&db, inbox, &[
            make_msg(1, 1000, false, true, false, false),
            make_msg(2, 2000, false, true, false, false),
            make_msg(3, 3000, false, true, false, false),
        ]).unwrap();
        raw_insert_flags(&db, inbox, 2, true, false);
        raw_insert_flags(&db, inbox, 3, false, true);

        let rows = list_smart_folder(&db, SmartFolderKind::Flagged, 10, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].date, 1000);
    }

    #[test]
    fn unread_and_flagged_pagination() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "l@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);

        insert_headers(&db, inbox, &[
            make_msg(1, 1000, false, true, false, false),
            make_msg(2, 3000, false, true, false, false),
            make_msg(3, 2000, false, true, false, false),
        ]).unwrap();

        let page1 = list_smart_folder(&db, SmartFolderKind::Flagged, 2, 0).unwrap();
        let page2 = list_smart_folder(&db, SmartFolderKind::Flagged, 2, 2).unwrap();
        assert_eq!(page1.len(), 2);
        assert_eq!(page1[0].date, 3000);
        assert_eq!(page2.len(), 1);
        assert_eq!(page2[0].date, 1000);

        insert_headers(&db, inbox, &[
            make_msg(4, 5000, false, false, false, false),
            make_msg(5, 4000, false, false, false, false),
        ]).unwrap();
        let u_page1 = list_smart_folder(&db, SmartFolderKind::Unread, 2, 0).unwrap();
        assert_eq!(u_page1.len(), 2);
        assert_eq!(u_page1[0].date, 5000);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cargo test -p am-storage smart_repo::tests::unread 2>&1 | tail -20
```

Expected: tests fail — `Unread` and `Flagged` arms return empty `Vec`.

- [ ] **Step 3: Implement `list_unread` and `list_flagged` in `smart_repo.rs`**

Replace the two stub arms in `list_smart_folder` and add the two private functions. The full updated public function plus new private helpers (add these after `list_all_inboxes`):

```rust
pub fn list_smart_folder(
    db: &Database,
    kind: SmartFolderKind,
    limit: i64,
    offset: i64,
) -> Result<Vec<SmartMessageRow>, StorageError> {
    match kind {
        SmartFolderKind::AllInboxes => list_all_inboxes(db, limit, offset),
        SmartFolderKind::Unread => list_unread(db, limit, offset),
        SmartFolderKind::Flagged => list_flagged(db, limit, offset),
    }
}
```

Add after the existing `list_all_inboxes` function:

```rust
fn list_unread(db: &Database, limit: i64, offset: i64) -> Result<Vec<SmartMessageRow>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT m.id, m.account_id, m.folder_id, a.color,
                m.from_address, m.from_name, m.subject, m.date,
                m.seen, m.flagged, m.has_attachments, m.snippet
         FROM messages m
         JOIN folders f ON f.id = m.folder_id
         JOIN accounts a ON a.id = m.account_id
         WHERE m.seen = 0
           AND f.folder_type NOT IN ('trash', 'spam')
           AND m.draft = 0
           AND m.deleted = 0
         ORDER BY m.date DESC
         LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt.query_map(params![limit, offset], row_to_smart)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn list_flagged(db: &Database, limit: i64, offset: i64) -> Result<Vec<SmartMessageRow>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT m.id, m.account_id, m.folder_id, a.color,
                m.from_address, m.from_name, m.subject, m.date,
                m.seen, m.flagged, m.has_attachments, m.snippet
         FROM messages m
         JOIN folders f ON f.id = m.folder_id
         JOIN accounts a ON a.id = m.account_id
         WHERE m.flagged = 1
           AND f.folder_type NOT IN ('trash', 'spam')
           AND m.draft = 0
           AND m.deleted = 0
         ORDER BY m.date DESC
         LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt.query_map(params![limit, offset], row_to_smart)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p am-storage smart_repo 2>&1 | tail -30
```

Expected: all `smart_repo::tests::*` pass.

- [ ] **Step 5: Run the full storage test suite**

```bash
cargo test -p am-storage 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/am-storage/src/smart_repo.rs
git commit -m "feat(am-storage): implement Unread and Flagged smart folder queries"
```

---

### Task 4: `am-app` `list_smart_folder` command

**Files:**
- Modify: `crates/am-app/src/commands.rs`
- Modify: `crates/am-app/src/lib.rs`

**Interfaces:**
- Consumes:
  - `am_storage::smart_repo::list_smart_folder` (Task 3)
  - `am_core::smart::{SmartFolderKind, SmartMessageRow}` (Task 1)
  - `crate::state::AppState`
- Produces:
  - `commands::list_smart_folder` — `#[tauri::command] pub fn list_smart_folder(state, kind: SmartFolderKind, limit: i64, offset: i64) -> Result<Vec<SmartMessageRow>, String>`
  - Registered in `collect_commands![...]` in `lib.rs`

- [ ] **Step 1: Write the command-layer test**

The command is a thin delegator tested by the storage tests. Write a compile-checked smoke test at the bottom of `crates/am-app/src/commands.rs` in the existing `#[cfg(test)] mod tests` block (after the last test):

```rust
    #[test]
    fn list_smart_folder_all_inboxes_returns_empty_for_empty_db() {
        use am_core::smart::SmartFolderKind;
        use am_storage::{accounts_repo, folders_repo, Database};
        use am_core::account::{NewAccount, ProviderType};
        use am_core::folder::FolderType;

        let db = std::sync::Arc::new(Database::open_in_memory().unwrap());
        let acc = accounts_repo::insert_account(
            &db,
            &NewAccount {
                email: "s@example.com".into(),
                display_name: "S".into(),
                provider_type: ProviderType::ImapPassword,
                color: None,
            },
        )
        .unwrap();
        folders_repo::upsert_folder(&db, acc.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();

        let result = am_storage::smart_repo::list_smart_folder(&db, SmartFolderKind::AllInboxes, 100, 0).unwrap();
        assert_eq!(result.len(), 0);
    }
```

- [ ] **Step 2: Run to verify it fails**

```bash
cargo test -p am-app list_smart_folder 2>&1 | tail -20
```

Expected: compile error — `am_storage::smart_repo` might not be in scope, or the test fails because the command function is missing.

- [ ] **Step 3: Add the command to `commands.rs`**

Add the following imports at the top of `crates/am-app/src/commands.rs` (after the existing `use am_storage::...` line):

```rust
use am_core::smart::{SmartFolderKind, SmartMessageRow};
use am_storage::smart_repo;
```

Add the following function anywhere in the command list (e.g., after `list_threads`):

```rust
#[tauri::command]
#[specta::specta]
pub fn list_smart_folder(
    state: tauri::State<'_, AppState>,
    kind: SmartFolderKind,
    limit: i64,
    offset: i64,
) -> Result<Vec<SmartMessageRow>, String> {
    smart_repo::list_smart_folder(&state.db, kind, limit, offset).map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Register in `lib.rs`**

Edit `crates/am-app/src/lib.rs`. Current `collect_commands![...]` block ends with `commands::pick_attachment,`. Add `commands::list_smart_folder,` before the closing `]`:

```rust
pub fn build_specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::app_health,
            commands::list_accounts,
            commands::resolve_endpoints,
            commands::add_account,
            commands::list_folders,
            commands::list_messages,
            commands::get_message_body,
            commands::sanitize_message_html,
            commands::set_message_flags,
            commands::mark_message_seen,
            commands::list_threads,
            commands::list_thread_messages,
            commands::enqueue_send,
            commands::start_reply,
            commands::save_draft,
            commands::get_draft,
            commands::list_drafts,
            commands::discard_draft,
            commands::list_signatures,
            commands::pick_attachment,
            commands::list_smart_folder,
        ])
        .events(collect_events![
            events::SyncProgress,
            events::NewMessages,
            events::MailboxChanged,
        ])
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cargo test -p am-app 2>&1 | tail -10
```

Expected: all am-app tests pass including the new smoke test.

- [ ] **Step 6: Regenerate TypeScript bindings**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm run gen:bindings
```

Expected: exits 0 and `src/ipc/bindings.ts` is updated (the file should now contain `listSmartFolder`, `SmartFolderKind`, and `SmartMessageRow`).

- [ ] **Step 7: Commit**

```bash
git add crates/am-app/src/commands.rs crates/am-app/src/lib.rs src/ipc/bindings.ts
git commit -m "feat(am-app): add list_smart_folder command and regenerate bindings"
```

---

### Task 5: Frontend store + queries + event wiring

**Files:**
- Modify: `src/app/store.ts`
- Modify: `src/ipc/queries.ts`
- Modify: `src/ipc/events.ts`

**Interfaces:**
- Consumes:
  - Generated `commands.listSmartFolder`, `SmartFolderKind`, `SmartMessageRow` from `src/ipc/bindings.ts` (Task 4)
- Produces:
  - `useUiStore` gains `selectedSmartFolder: SmartFolderKind | null`, `setSelectedSmartFolder(kind: SmartFolderKind | null) => void`
  - `setSelectedAccountId` / `setSelectedFolderId` clear `selectedSmartFolder`
  - `setSelectedSmartFolder` clears `selectedAccountId`, `selectedFolderId`, `selectedThreadId`
  - `useSmartFolder(kind: SmartFolderKind | null)` hook at queryKey `["smart", kind]`
  - `useSyncEvents` adds `["smart"]` invalidation in `newMessages` and `mailboxChanged` handlers

- [ ] **Step 1: Write the failing store test**

Create `src/app/store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./store";

beforeEach(() => {
  useUiStore.setState({
    selectedAccountId: null,
    selectedFolderId: null,
    selectedMessageId: null,
    selectedThreadId: null,
    selectedSmartFolder: null,
    density: "comfortable",
    composer: { open: false, draftId: null, prefill: null },
  });
});

describe("selectedSmartFolder mutual exclusion", () => {
  it("setSelectedSmartFolder clears account, folder, and thread selection", () => {
    useUiStore.setState({
      selectedAccountId: 1,
      selectedFolderId: 10,
      selectedThreadId: 5,
    });

    useUiStore.getState().setSelectedSmartFolder("all_inboxes");

    const s = useUiStore.getState();
    expect(s.selectedSmartFolder).toBe("all_inboxes");
    expect(s.selectedAccountId).toBeNull();
    expect(s.selectedFolderId).toBeNull();
    expect(s.selectedThreadId).toBeNull();
  });

  it("setSelectedSmartFolder(null) clears smart folder", () => {
    useUiStore.setState({ selectedSmartFolder: "unread" });
    useUiStore.getState().setSelectedSmartFolder(null);
    expect(useUiStore.getState().selectedSmartFolder).toBeNull();
  });

  it("setSelectedAccountId clears selectedSmartFolder", () => {
    useUiStore.setState({ selectedSmartFolder: "flagged" });
    useUiStore.getState().setSelectedAccountId(2);
    const s = useUiStore.getState();
    expect(s.selectedAccountId).toBe(2);
    expect(s.selectedSmartFolder).toBeNull();
  });

  it("setSelectedFolderId clears selectedSmartFolder", () => {
    useUiStore.setState({ selectedSmartFolder: "unread" });
    useUiStore.getState().setSelectedFolderId(7);
    const s = useUiStore.getState();
    expect(s.selectedFolderId).toBe(7);
    expect(s.selectedSmartFolder).toBeNull();
  });

  it("setSelectedAccountId(null) clears selectedSmartFolder", () => {
    useUiStore.setState({ selectedSmartFolder: "all_inboxes" });
    useUiStore.getState().setSelectedAccountId(null);
    expect(useUiStore.getState().selectedSmartFolder).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm test -- src/app/store.test.ts 2>&1 | tail -30
```

Expected: fails — `selectedSmartFolder` and `setSelectedSmartFolder` do not exist on the store yet.

- [ ] **Step 3: Update `store.ts`**

Replace `src/app/store.ts` with:

```typescript
import { create } from "zustand";
import type { OutgoingMessage, SmartFolderKind } from "../ipc/bindings";

export type Density = "comfortable" | "cozy" | "compact" | "dense";

type ComposerState = {
  open: boolean;
  draftId: number | null;
  prefill: OutgoingMessage | null;
};

export type UiState = {
  selectedAccountId: number | null;
  selectedFolderId: number | null;
  selectedMessageId: number | null;
  selectedThreadId: number | null;
  selectedSmartFolder: SmartFolderKind | null;
  density: Density;
  composer: ComposerState;
  setSelectedAccountId: (id: number | null) => void;
  setSelectedFolderId: (id: number | null) => void;
  setSelectedMessageId: (id: number | null) => void;
  setSelectedThreadId: (id: number | null) => void;
  setSelectedSmartFolder: (kind: SmartFolderKind | null) => void;
  setDensity: (density: Density) => void;
  openComposer: (draftId: number | null, prefill?: OutgoingMessage | null) => void;
  closeComposer: () => void;
};

export const useUiStore = create<UiState>((set) => ({
  selectedAccountId: null,
  selectedFolderId: null,
  selectedMessageId: null,
  selectedThreadId: null,
  selectedSmartFolder: null,
  density: "comfortable",
  composer: { open: false, draftId: null, prefill: null },
  setSelectedAccountId: (id) =>
    set({ selectedAccountId: id, selectedSmartFolder: null }),
  setSelectedFolderId: (id) =>
    set({ selectedFolderId: id, selectedSmartFolder: null }),
  setSelectedMessageId: (id) => set({ selectedMessageId: id }),
  setSelectedThreadId: (id) => set({ selectedThreadId: id }),
  setSelectedSmartFolder: (kind) =>
    set({
      selectedSmartFolder: kind,
      selectedAccountId: null,
      selectedFolderId: null,
      selectedThreadId: null,
    }),
  setDensity: (density) => set({ density }),
  openComposer: (draftId, prefill = null) =>
    set({ composer: { open: true, draftId, prefill } }),
  closeComposer: () =>
    set({ composer: { open: false, draftId: null, prefill: null } }),
}));
```

- [ ] **Step 4: Run store test to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm test -- src/app/store.test.ts 2>&1 | tail -20
```

Expected: all 5 store mutual-exclusion tests pass.

- [ ] **Step 5: Add `useSmartFolder` to `queries.ts`**

Add the following at the end of `src/ipc/queries.ts` (after `useEnqueueSend`):

```typescript
import type { SmartFolderKind, SmartMessageRow } from "./bindings";

export function useSmartFolder(kind: SmartFolderKind | null) {
  return useQuery<SmartMessageRow[]>({
    queryKey: ["smart", kind],
    queryFn: () => commands.listSmartFolder(kind!, 100, 0).then(unwrap),
    enabled: kind != null,
  });
}
```

Note: the `import type { SmartFolderKind, SmartMessageRow }` line should be merged with the existing import from `"./bindings"` at the top of the file. The existing import line is:

```typescript
import type { Account, Endpoints, MessageFlag, OutgoingMessage } from "./bindings";
```

Change it to:

```typescript
import type { Account, Endpoints, MessageFlag, OutgoingMessage, SmartFolderKind, SmartMessageRow } from "./bindings";
```

And add only the `useSmartFolder` function at the bottom (without the extra `import type` line):

```typescript
export function useSmartFolder(kind: SmartFolderKind | null) {
  return useQuery<SmartMessageRow[]>({
    queryKey: ["smart", kind],
    queryFn: () => commands.listSmartFolder(kind!, 100, 0).then(unwrap),
    enabled: kind != null,
  });
}
```

- [ ] **Step 6: Add `["smart"]` invalidation to `events.ts`**

Edit `src/ipc/events.ts`. The `newMessages` handler currently is:

```typescript
    const messagesPromise = events.newMessages.listen((event) => {
      const { account_id, folder_id } = event.payload;
      queryClient.invalidateQueries({ queryKey: ["folders", account_id] });
      queryClient.invalidateQueries({ queryKey: ["messages", folder_id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
    });
```

Change it to:

```typescript
    const messagesPromise = events.newMessages.listen((event) => {
      const { account_id, folder_id } = event.payload;
      queryClient.invalidateQueries({ queryKey: ["folders", account_id] });
      queryClient.invalidateQueries({ queryKey: ["messages", folder_id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["smart"] });
    });
```

The `mailboxChanged` handler currently is:

```typescript
    const mailboxPromise = events.mailboxChanged.listen((event) => {
      const { account_id, folder_id } = event.payload;
      queryClient.invalidateQueries({ queryKey: ["folders", account_id] });
      queryClient.invalidateQueries({ queryKey: ["messages", folder_id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
    });
```

Change it to:

```typescript
    const mailboxPromise = events.mailboxChanged.listen((event) => {
      const { account_id, folder_id } = event.payload;
      queryClient.invalidateQueries({ queryKey: ["folders", account_id] });
      queryClient.invalidateQueries({ queryKey: ["messages", folder_id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["smart"] });
    });
```

- [ ] **Step 7: Run full frontend test suite**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm test 2>&1 | tail -20
```

Expected: all tests pass including the 5 store tests.

- [ ] **Step 8: Commit**

```bash
git add src/app/store.ts src/app/store.test.ts src/ipc/queries.ts src/ipc/events.ts
git commit -m "feat(ui): add selectedSmartFolder to store with mutual exclusion and useSmartFolder query"
```

---

### Task 6: Frontend `MailboxRail` + `MessageListPane`

**Files:**
- Modify: `src/features/mailbox/MailboxRail.tsx`
- Modify: `src/features/mailbox/MailboxRail.test.tsx`
- Modify: `src/features/message-list/MessageListPane.tsx`
- Modify: `src/features/message-list/MessageListPane.test.tsx`

**Interfaces:**
- Consumes:
  - `useUiStore` with `selectedSmartFolder` / `setSelectedSmartFolder` (Task 5)
  - `useSmartFolder(kind)` (Task 5)
  - `SmartMessageRow`, `SmartFolderKind` from bindings (Task 4)
- Produces:
  - `MailboxRail`: 3 enabled smart folder entries (All Inboxes, Unread, Flagged); clicking dispatches `setSelectedSmartFolder`; Snoozed and Drafts removed
  - `MessageListPane`: when `selectedSmartFolder != null`, renders flat smart-folder list with account-colour dot per row; clicking a row calls `setSelectedMessageId`

The smart list is intentionally flat — no cross-account threading. Reader/mark-seen/flag already work per-message via `message_id`/`account_id`; do NOT rebuild them.

- [ ] **Step 1: Write the failing MailboxRail test**

Replace the content of `src/features/mailbox/MailboxRail.test.tsx` with:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockSetSelectedAccountId = vi.fn();
const mockSetSelectedFolderId = vi.fn();
const mockSetSelectedSmartFolder = vi.fn();

vi.mock("../../ipc/queries", () => ({
  useAccounts: vi.fn(),
  useFolders: vi.fn(),
}));

vi.mock("../../app/store", () => ({
  useUiStore: vi.fn(),
}));

vi.mock("../accounts/AddAccountWizard", () => ({
  AddAccountWizard: ({ onClose }: { onClose: () => void; onAdded: (id: number) => void }) => (
    <div data-testid="add-account-wizard">
      <button onClick={onClose}>Close wizard</button>
    </div>
  ),
}));

import { useAccounts, useFolders } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import type { UiState } from "../../app/store";
import { MailboxRail } from "./MailboxRail";

const mockUseAccounts = vi.mocked(useAccounts);
const mockUseFolders = vi.mocked(useFolders);
const mockUseUiStore = vi.mocked(useUiStore);

const singleAccount = {
  id: 1,
  email: "a@x.com",
  display_name: "A",
  color: "#4f46e5",
  position: 0,
  provider_type: "imap_password" as const,
};

const singleFolder = {
  id: 10,
  account_id: 1,
  name: "Inbox",
  folder_type: "inbox" as const,
  unread_count: 2,
  total_count: 5,
  remote_path: "INBOX",
};

function setupStore(selectedAccountId: number | null = 1, selectedSmartFolder: string | null = null) {
  mockUseUiStore.mockImplementation(
    (selector: (s: UiState) => unknown) => {
      const state: UiState = {
        selectedAccountId,
        selectedFolderId: null,
        selectedMessageId: null,
        selectedThreadId: null,
        selectedSmartFolder: selectedSmartFolder as UiState["selectedSmartFolder"],
        density: "comfortable",
        composer: { open: false, draftId: null, prefill: null },
        setSelectedAccountId: mockSetSelectedAccountId,
        setSelectedFolderId: mockSetSelectedFolderId,
        setSelectedMessageId: vi.fn(),
        setSelectedThreadId: vi.fn(),
        setSelectedSmartFolder: mockSetSelectedSmartFolder,
        setDensity: vi.fn(),
        openComposer: vi.fn(),
        closeComposer: vi.fn(),
      };
      return selector ? selector(state) : state;
    }
  );
}

describe("MailboxRail", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders 3 enabled smart folders (no Snoozed or Drafts)", () => {
    setupStore(null);
    mockUseAccounts.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);
    mockUseFolders.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useFolders>);

    render(<MailboxRail />);

    expect(screen.getByText("All Inboxes")).toBeTruthy();
    expect(screen.getByText("Unread")).toBeTruthy();
    expect(screen.getByText("Flagged")).toBeTruthy();
    expect(screen.queryByText("Snoozed")).toBeNull();
    expect(screen.queryByText("Drafts")).toBeNull();

    const allInboxesEl = screen.getByText("All Inboxes");
    expect(allInboxesEl.closest("[aria-disabled]")).toBeNull();
  });

  it("clicking All Inboxes calls setSelectedSmartFolder('all_inboxes')", async () => {
    const user = userEvent.setup();
    setupStore(null);
    mockUseAccounts.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);
    mockUseFolders.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useFolders>);

    render(<MailboxRail />);
    await user.click(screen.getByText("All Inboxes"));
    expect(mockSetSelectedSmartFolder).toHaveBeenCalledWith("all_inboxes");
  });

  it("clicking Unread calls setSelectedSmartFolder('unread')", async () => {
    const user = userEvent.setup();
    setupStore(null);
    mockUseAccounts.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);
    mockUseFolders.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useFolders>);

    render(<MailboxRail />);
    await user.click(screen.getByText("Unread"));
    expect(mockSetSelectedSmartFolder).toHaveBeenCalledWith("unread");
  });

  it("clicking Flagged calls setSelectedSmartFolder('flagged')", async () => {
    const user = userEvent.setup();
    setupStore(null);
    mockUseAccounts.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);
    mockUseFolders.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useFolders>);

    render(<MailboxRail />);
    await user.click(screen.getByText("Flagged"));
    expect(mockSetSelectedSmartFolder).toHaveBeenCalledWith("flagged");
  });

  it("renders account and folder, clicking folder calls setSelectedFolderId", async () => {
    const user = userEvent.setup();
    setupStore(1);
    mockUseAccounts.mockReturnValue({
      data: [singleAccount],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);
    mockUseFolders.mockReturnValue({
      data: [singleFolder],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useFolders>);

    render(<MailboxRail />);
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.getByText("Inbox")).toBeTruthy();
    await user.click(screen.getByText("Inbox"));
    expect(mockSetSelectedFolderId).toHaveBeenCalledWith(10);
  });

  it("renders empty state when no accounts", () => {
    setupStore(null);
    mockUseAccounts.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);
    mockUseFolders.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useFolders>);

    render(<MailboxRail />);
    expect(screen.getByText(/no accounts/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Write the failing MessageListPane test additions**

Replace the content of `src/features/message-list/MessageListPane.test.tsx` with:

```typescript
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const mockSetSelectedThreadId = vi.fn();
const mockSetSelectedMessageId = vi.fn();

vi.mock("../../ipc/queries", () => ({
  useThreads: vi.fn(),
  useSmartFolder: vi.fn(),
}));

vi.mock("../../app/store", () => ({
  useUiStore: vi.fn(),
}));

import { useThreads, useSmartFolder } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import type { UiState, Density } from "../../app/store";
import { MessageListPane } from "./MessageListPane";
import type { ThreadSummary, SmartMessageRow } from "../../ipc/bindings";

const mockUseThreads = vi.mocked(useThreads);
const mockUseSmartFolder = vi.mocked(useSmartFolder);
const mockUseUiStore = vi.mocked(useUiStore);

const sampleThreads: ThreadSummary[] = [
  {
    thread_id: 1,
    account_id: 1,
    subject: "Hello World",
    last_date: 1700000000,
    message_count: 2,
    unread_count: 1,
    participants: ["Alice Smith", "Bob Jones"],
    snippet: "Hello there",
    has_attachments: false,
    flagged: false,
  },
  {
    thread_id: 2,
    account_id: 1,
    subject: "Second thread",
    last_date: 1700001000,
    message_count: 1,
    unread_count: 0,
    participants: ["Carol"],
    snippet: "Second snippet",
    has_attachments: true,
    flagged: true,
  },
];

const sampleSmartRows: SmartMessageRow[] = [
  {
    message_id: 100,
    account_id: 1,
    folder_id: 10,
    account_color: "#ff0000",
    from_address: "alice@example.com",
    from_name: "Alice",
    subject: "Smart Inbox Subject",
    date: 1700000000,
    seen: false,
    flagged: false,
    has_attachments: false,
    snippet: "Smart preview",
  },
  {
    message_id: 101,
    account_id: 2,
    folder_id: 20,
    account_color: "#00ff00",
    from_address: "bob@example.com",
    from_name: null,
    subject: "Another Smart Subject",
    date: 1700001000,
    seen: true,
    flagged: false,
    has_attachments: false,
    snippet: "Another preview",
  },
];

function setupStore(
  selectedFolderId: number | null,
  density: Density = "comfortable",
  selectedSmartFolder: UiState["selectedSmartFolder"] = null
) {
  mockUseUiStore.mockImplementation((selector: (s: UiState) => unknown) => {
    const state: UiState = {
      selectedAccountId: null,
      selectedFolderId,
      selectedMessageId: null,
      selectedThreadId: null,
      selectedSmartFolder,
      density,
      composer: { open: false, draftId: null, prefill: null },
      setSelectedAccountId: vi.fn(),
      setSelectedFolderId: vi.fn(),
      setSelectedMessageId: mockSetSelectedMessageId,
      setSelectedThreadId: mockSetSelectedThreadId,
      setSelectedSmartFolder: vi.fn(),
      setDensity: vi.fn(),
      openComposer: vi.fn(),
      closeComposer: vi.fn(),
    };
    return selector ? selector(state) : state;
  });
}

describe("MessageListPane", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => 600,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get: () => 400,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders thread list with participants and subject visible, clicking row calls setSelectedThreadId", () => {
    setupStore(10);
    mockUseThreads.mockReturnValue({
      data: sampleThreads,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useThreads>);
    mockUseSmartFolder.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useSmartFolder>);

    render(<MessageListPane />);

    expect(screen.getByLabelText("message-list")).toBeTruthy();
    expect(screen.getByText("Alice Smith, Bob Jones")).toBeTruthy();
    expect(screen.getByText("Hello World")).toBeTruthy();

    const firstRow = screen.getByText("Hello World").closest("[data-thread-id]");
    expect(firstRow).toBeTruthy();
    fireEvent.click(firstRow!);
    expect(mockSetSelectedThreadId).toHaveBeenCalledWith(1);
  });

  it("shows select-folder empty state when selectedFolderId and selectedSmartFolder are both null", () => {
    setupStore(null, "comfortable", null);
    mockUseThreads.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useThreads>);
    mockUseSmartFolder.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useSmartFolder>);

    render(<MessageListPane />);

    expect(screen.getByText(/select a folder/i)).toBeTruthy();
  });

  it("shows no-messages empty state when folder is selected but has 0 threads", () => {
    setupStore(10);
    mockUseThreads.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useThreads>);
    mockUseSmartFolder.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useSmartFolder>);

    render(<MessageListPane />);

    expect(screen.getByText(/no messages/i)).toBeTruthy();
  });

  it("shows loading skeleton when isLoading", () => {
    setupStore(10);
    mockUseThreads.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useThreads>);
    mockUseSmartFolder.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useSmartFolder>);

    render(<MessageListPane />);

    const skeletons = document.querySelectorAll(".skeleton-row");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("renders smart folder rows with account colour dots when selectedSmartFolder is set", () => {
    setupStore(null, "comfortable", "all_inboxes");
    mockUseThreads.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useThreads>);
    mockUseSmartFolder.mockReturnValue({
      data: sampleSmartRows,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useSmartFolder>);

    render(<MessageListPane />);

    expect(screen.getByText("Smart Inbox Subject")).toBeTruthy();
    expect(screen.getByText("Another Smart Subject")).toBeTruthy();

    const dots = document.querySelectorAll("[data-account-dot]");
    expect(dots.length).toBe(2);
    expect((dots[0] as HTMLElement).style.background).toBe("rgb(255, 0, 0)");
    expect((dots[1] as HTMLElement).style.background).toBe("rgb(0, 255, 0)");
  });

  it("clicking a smart row calls setSelectedMessageId", () => {
    setupStore(null, "comfortable", "all_inboxes");
    mockUseThreads.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useThreads>);
    mockUseSmartFolder.mockReturnValue({
      data: sampleSmartRows,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useSmartFolder>);

    render(<MessageListPane />);

    const firstRow = screen.getByText("Smart Inbox Subject").closest("[data-message-id]");
    expect(firstRow).toBeTruthy();
    fireEvent.click(firstRow!);
    expect(mockSetSelectedMessageId).toHaveBeenCalledWith(100);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm test -- src/features/mailbox/MailboxRail.test.tsx src/features/message-list/MessageListPane.test.tsx 2>&1 | tail -30
```

Expected: many failures — `setSelectedSmartFolder` not consumed by `MailboxRail`, smart rendering not in `MessageListPane`, `Snoozed`/`Drafts` still present.

- [ ] **Step 4: Update `MailboxRail.tsx`**

Replace the entire content of `src/features/mailbox/MailboxRail.tsx` with:

```typescript
import { useState } from "react";
import { useAccounts, useFolders } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import { AddAccountWizard } from "../accounts/AddAccountWizard";
import type { SmartFolderKind } from "../../ipc/bindings";

const SMART_FOLDERS: { label: string; kind: SmartFolderKind }[] = [
  { label: "All Inboxes", kind: "all_inboxes" },
  { label: "Unread", kind: "unread" },
  { label: "Flagged", kind: "flagged" },
];

interface Props {
  status?: string;
}

export function MailboxRail({ status }: Props) {
  const [wizardOpen, setWizardOpen] = useState(false);

  const selectedAccountId = useUiStore((s) => s.selectedAccountId);
  const selectedFolderId = useUiStore((s) => s.selectedFolderId);
  const selectedSmartFolder = useUiStore((s) => s.selectedSmartFolder);
  const setSelectedAccountId = useUiStore((s) => s.setSelectedAccountId);
  const setSelectedFolderId = useUiStore((s) => s.setSelectedFolderId);
  const setSelectedSmartFolder = useUiStore((s) => s.setSelectedSmartFolder);

  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();
  const { data: folders = [] } = useFolders(selectedAccountId);

  function handleAccountClick(accountId: number) {
    setSelectedAccountId(accountId);
    setSelectedFolderId(null);
  }

  function handleFolderClick(folderId: number, accountId: number) {
    setSelectedAccountId(accountId);
    setSelectedFolderId(folderId);
  }

  function handleAdded(accountId: number) {
    setSelectedAccountId(accountId);
    setWizardOpen(false);
  }

  return (
    <aside
      className="rail"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg-rail)",
        color: "var(--text-on-rail)",
      }}
    >
      <div style={{ padding: "var(--space-4)", fontWeight: 700, fontSize: "15px" }}>
        AbeonMail
      </div>

      <nav style={{ flex: 1, overflowY: "auto" }}>
        <div
          style={{
            padding: "var(--space-2) var(--space-3)",
            fontSize: "11px",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--text-muted)",
            marginTop: "var(--space-2)",
          }}
        >
          Smart Folders
        </div>
        {SMART_FOLDERS.map(({ label, kind }) => (
          <div
            key={kind}
            onClick={() => setSelectedSmartFolder(kind)}
            style={{
              padding: "var(--space-2) var(--space-4)",
              fontSize: "14px",
              borderRadius: "var(--radius-sm)",
              margin: "1px var(--space-2)",
              cursor: "pointer",
              fontWeight: selectedSmartFolder === kind ? 600 : 400,
              color: selectedSmartFolder === kind ? "var(--accent)" : "var(--text-on-rail)",
            }}
          >
            {label}
          </div>
        ))}

        {!accountsLoading && accounts.length > 0 && (
          <>
            <div
              style={{
                padding: "var(--space-2) var(--space-3)",
                fontSize: "11px",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--text-muted)",
                marginTop: "var(--space-3)",
              }}
            >
              Accounts
            </div>
            {accounts.map((account) => (
              <div key={account.id}>
                <div
                  onClick={() => handleAccountClick(account.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-2)",
                    padding: "var(--space-2) var(--space-4)",
                    cursor: "pointer",
                    fontSize: "14px",
                    borderRadius: "var(--radius-sm)",
                    margin: "1px var(--space-2)",
                    fontWeight: selectedAccountId === account.id ? 600 : 400,
                    color:
                      selectedAccountId === account.id
                        ? "var(--accent)"
                        : "var(--text-on-rail)",
                  }}
                >
                  <span
                    style={{
                      width: "8px",
                      height: "8px",
                      borderRadius: "50%",
                      background: account.color ?? "var(--accent)",
                      flexShrink: 0,
                    }}
                  />
                  {account.display_name || account.email}
                </div>

                {selectedAccountId === account.id &&
                  folders.map((folder) => (
                    <div
                      key={folder.id}
                      onClick={() => handleFolderClick(folder.id, account.id)}
                      style={{
                        padding: "var(--space-1) var(--space-4)",
                        paddingLeft: "calc(var(--space-4) + 20px)",
                        cursor: "pointer",
                        fontSize: "13px",
                        borderRadius: "var(--radius-sm)",
                        margin: "1px var(--space-2)",
                        color:
                          selectedFolderId === folder.id
                            ? "var(--accent)"
                            : "var(--text-on-rail)",
                        fontWeight: selectedFolderId === folder.id ? 600 : 400,
                      }}
                    >
                      {folder.name}
                      {folder.unread_count > 0 && (
                        <span
                          style={{ marginLeft: "var(--space-2)", fontSize: "11px", opacity: 0.7 }}
                        >
                          {folder.unread_count}
                        </span>
                      )}
                    </div>
                  ))}
              </div>
            ))}
          </>
        )}

        {!accountsLoading && accounts.length === 0 && (
          <div
            style={{
              padding: "var(--space-4)",
              fontSize: "13px",
              color: "var(--text-muted)",
              textAlign: "center",
            }}
          >
            No accounts yet
          </div>
        )}
      </nav>

      <div style={{ padding: "var(--space-3)" }}>
        <button
          onClick={() => setWizardOpen(true)}
          style={{
            width: "100%",
            background: "var(--accent)",
            border: "none",
            borderRadius: "var(--radius-sm)",
            color: "var(--color-white)",
            cursor: "pointer",
            fontSize: "13px",
            padding: "var(--space-2) var(--space-3)",
          }}
        >
          Add account
        </button>
      </div>

      {status !== undefined && (
        <div
          className="status"
          style={{
            padding: "var(--space-2) var(--space-4)",
            fontSize: "11px",
            color: "var(--text-muted)",
          }}
        >
          IPC: {status}
        </div>
      )}

      {wizardOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
        >
          <AddAccountWizard onClose={() => setWizardOpen(false)} onAdded={handleAdded} />
        </div>
      )}
    </aside>
  );
}
```

- [ ] **Step 5: Update `MessageListPane.tsx`**

Replace the entire content of `src/features/message-list/MessageListPane.tsx` with:

```typescript
import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useThreads, useSmartFolder } from "../../ipc/queries";
import { useUiStore, type Density } from "../../app/store";
import type { ThreadSummary, SmartMessageRow } from "../../ipc/bindings";
import "./MessageListPane.css";

const ROW_HEIGHT: Record<Density, number> = {
  comfortable: 72,
  cozy: 60,
  compact: 48,
  dense: 36,
};

function formatDate(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isToday) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ThreadRow({
  thread,
  isSelected,
  rowHeight,
  onSelect,
}: {
  thread: ThreadSummary;
  isSelected: boolean;
  rowHeight: number;
  onSelect: (id: number) => void;
}) {
  const isUnread = thread.unread_count > 0;

  return (
    <div
      className={`message-row${isUnread ? " message-row--unread" : ""}${isSelected ? " message-row--selected" : ""}`}
      style={{ height: rowHeight }}
      data-thread-id={thread.thread_id}
      onClick={() => onSelect(thread.thread_id)}
      role="option"
      aria-selected={isSelected}
    >
      <div className="message-row__indicators">
        {isUnread && <span className="message-row__unread-dot" aria-label="unread" />}
      </div>
      <div className="message-row__content">
        <div className="message-row__header">
          <span className={`message-row__sender${isUnread ? " message-row__sender--bold" : ""}`}>
            {thread.participants.join(", ")}
          </span>
          <span className="message-row__date">{formatDate(thread.last_date)}</span>
        </div>
        <div className="message-row__meta">
          <span className="message-row__subject">{thread.subject}</span>
          <div className="message-row__badges">
            {thread.flagged && (
              <span className="message-row__flag" aria-label="flagged">
                ⚑
              </span>
            )}
            {thread.message_count > 1 && (
              <span
                className="message-row__count"
                aria-label={`${thread.message_count} messages`}
              >
                {thread.message_count}
              </span>
            )}
            {thread.has_attachments && (
              <span className="message-row__attachment" aria-label="has attachments">
                📎
              </span>
            )}
          </div>
        </div>
        <span className="message-row__snippet">{thread.snippet}</span>
      </div>
    </div>
  );
}

function SmartRow({
  row,
  isSelected,
  rowHeight,
  onSelect,
}: {
  row: SmartMessageRow;
  isSelected: boolean;
  rowHeight: number;
  onSelect: (id: number) => void;
}) {
  const senderLabel = row.from_name ?? row.from_address;

  return (
    <div
      className={`message-row${!row.seen ? " message-row--unread" : ""}${isSelected ? " message-row--selected" : ""}`}
      style={{ height: rowHeight }}
      data-message-id={row.message_id}
      onClick={() => onSelect(row.message_id)}
      role="option"
      aria-selected={isSelected}
    >
      <div className="message-row__indicators">
        {!row.seen && <span className="message-row__unread-dot" aria-label="unread" />}
      </div>
      <div className="message-row__content">
        <div className="message-row__header">
          <span
            style={{ display: "flex", alignItems: "center", gap: "6px" }}
            className={`message-row__sender${!row.seen ? " message-row__sender--bold" : ""}`}
          >
            <span
              data-account-dot
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                background: row.account_color ?? "var(--accent)",
                flexShrink: 0,
              }}
            />
            {senderLabel}
          </span>
          <span className="message-row__date">{formatDate(row.date)}</span>
        </div>
        <div className="message-row__meta">
          <span className="message-row__subject">{row.subject}</span>
          <div className="message-row__badges">
            {row.flagged && (
              <span className="message-row__flag" aria-label="flagged">
                ⚑
              </span>
            )}
            {row.has_attachments && (
              <span className="message-row__attachment" aria-label="has attachments">
                📎
              </span>
            )}
          </div>
        </div>
        <span className="message-row__snippet">{row.snippet}</span>
      </div>
    </div>
  );
}

function SkeletonRow({ height }: { height: number }) {
  return (
    <div className="skeleton-row" style={{ height }}>
      <div className="skeleton-row__sender" />
      <div className="skeleton-row__subject" />
    </div>
  );
}

export function MessageListPane() {
  const selectedFolderId = useUiStore((s) => s.selectedFolderId);
  const selectedSmartFolder = useUiStore((s) => s.selectedSmartFolder);
  const selectedThreadId = useUiStore((s) => s.selectedThreadId);
  const selectedMessageId = useUiStore((s) => s.selectedMessageId);
  const density = useUiStore((s) => s.density);
  const setSelectedThreadId = useUiStore((s) => s.setSelectedThreadId);
  const setSelectedMessageId = useUiStore((s) => s.setSelectedMessageId);

  const { data: threads, isLoading: threadsLoading } = useThreads(selectedFolderId);
  const { data: smartRows, isLoading: smartLoading } = useSmartFolder(selectedSmartFolder);

  const isSmartMode = selectedSmartFolder != null;
  const isLoading = isSmartMode ? smartLoading : threadsLoading;
  const items = isSmartMode ? (smartRows ?? []) : (threads ?? []);
  const hasSelection = isSmartMode ? selectedSmartFolder != null : selectedFolderId != null;

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const rowHeight = ROW_HEIGHT[density] ?? ROW_HEIGHT.comfortable;

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => rowHeight,
    overscan: 5,
  });

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <section className="pane message-list-pane" aria-label="message-list">
      {!hasSelection && (
        <div className="message-list__empty">Select a folder</div>
      )}

      {hasSelection && isLoading && (
        <div className="message-list__scroll" style={{ height: "100%" }}>
          {Array.from({ length: 8 }, (_, i) => (
            <SkeletonRow key={i} height={rowHeight} />
          ))}
        </div>
      )}

      {hasSelection && !isLoading && items.length === 0 && (
        <div className="message-list__empty">No messages</div>
      )}

      {hasSelection && !isLoading && items.length > 0 && (
        <div
          ref={scrollContainerRef}
          className="message-list__scroll"
          style={{ height: "100%", overflow: "auto" }}
          role="listbox"
          aria-label="messages"
        >
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualItems.map((virtualItem) => {
              if (isSmartMode) {
                const row = (items as SmartMessageRow[])[virtualItem.index];
                return (
                  <div
                    key={virtualItem.key}
                    style={{
                      position: "absolute",
                      top: virtualItem.start,
                      left: 0,
                      right: 0,
                      height: virtualItem.size,
                    }}
                  >
                    <SmartRow
                      row={row}
                      isSelected={selectedMessageId === row.message_id}
                      rowHeight={rowHeight}
                      onSelect={setSelectedMessageId}
                    />
                  </div>
                );
              }
              const thread = (items as ThreadSummary[])[virtualItem.index];
              return (
                <div
                  key={virtualItem.key}
                  style={{
                    position: "absolute",
                    top: virtualItem.start,
                    left: 0,
                    right: 0,
                    height: virtualItem.size,
                  }}
                >
                  <ThreadRow
                    thread={thread}
                    isSelected={selectedThreadId === thread.thread_id}
                    rowHeight={rowHeight}
                    onSelect={setSelectedThreadId}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 6: Run all frontend tests**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm test 2>&1 | tail -30
```

Expected: all tests pass including the new MailboxRail smart folder tests and MessageListPane smart rendering tests.

- [ ] **Step 7: Run full Rust test suite**

```bash
cargo test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add \
  src/features/mailbox/MailboxRail.tsx \
  src/features/mailbox/MailboxRail.test.tsx \
  src/features/message-list/MessageListPane.tsx \
  src/features/message-list/MessageListPane.test.tsx
git commit -m "feat(ui): wire smart folders in MailboxRail and MessageListPane"
```
