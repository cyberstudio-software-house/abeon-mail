# Etap 6d — Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local, cross-account message labels: create/edit/delete with color, apply from the reader and from a list multi-select, browse a label as a flat message list in the rail, and manage labels in Settings — with no server/IMAP sync.

**Architecture:** Wake the dormant V1 `labels`/`message_labels` tables, redesigned global (no `account_id`). A thin `labels_repo` in `am-storage` + Tauri commands in `am-app`. Frontend adds a store slice (selected label + multi-select + picker state), react-query hooks, a `LabelChips` renderer, a global `LabelPicker` popover, a rail Labels section, a Settings Labels section, and shortcut/palette wiring. Label chips are sourced through one batch query (`labelsForMessages`), not by widening row structs.

**Tech Stack:** Rust (rusqlite + refinery migrations, tauri-specta), React 19 + TypeScript, zustand, @tanstack/react-query v5, @tanstack/react-virtual, vitest + @testing-library/react + happy-dom.

## Global Constraints

- All code identifiers (variables, functions, types, files) in **English** only.
- **No code comments** in source. Document non-obvious decisions in `docs/` only.
- Labels are **local-only** (SQLite). No IMAP/sync changes whatsoever.
- Labels are **global** (cross-account): the `labels` table has **no** `account_id`, `UNIQUE(name)`.
- Conventional Commits for every commit. Do **not** add a co-author. Do **not** push.
- Never `git add .` — stage explicit paths only (`.env` with OAuth secrets is gitignored and must never be committed).
- Frontend tests run under Node 24: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"` then `npx vitest run`.
- Tests use `.toBeTruthy()` / `.toBeNull()` (no jest-dom matchers). Border token is `--border-subtle`.
- Any **new** lucide icon used in app code MUST be added to `src/test/lucide-stub.js` or vitest OOMs.
- `list_messages_by_label` excludes only `draft=1`/`deleted=1` (NOT trash/spam — labelling is explicit user intent). `row_to_smart` (in `smart_repo`) is already `pub(crate)` and reused.
- `db.conn()` returns a `MutexGuard<Connection>` (`std::Mutex`, non-reentrant — never re-lock while holding it). `&Transaction` derefs to `&Connection`. Foreign keys are ON (cascades work).

---

### Task 1: Migration V8 + `am-core::Label` + `labels_repo` CRUD

**Files:**
- Create: `crates/am-storage/src/migrations/V8__labels.sql`
- Create: `crates/am-core/src/label.rs`
- Modify: `crates/am-core/src/lib.rs` (add `pub mod label;`)
- Create + Test: `crates/am-storage/src/labels_repo.rs`
- Modify: `crates/am-storage/src/lib.rs` (add `pub mod labels_repo;`)

**Interfaces:**
- Consumes: `crate::db::{Database, StorageError}`; test helpers pattern from `smart_repo.rs` (`insert_account`, `NewAccount`, `ProviderType`).
- Produces:
  - `am_core::label::Label { id: i64, name: String, color: String }`
  - `labels_repo::list_labels(db: &Database) -> Result<Vec<Label>, StorageError>`
  - `labels_repo::create_label(db: &Database, name: &str, color: &str) -> Result<Label, StorageError>`
  - `labels_repo::rename_label(db: &Database, id: i64, name: &str) -> Result<(), StorageError>`
  - `labels_repo::set_label_color(db: &Database, id: i64, color: &str) -> Result<(), StorageError>`
  - `labels_repo::delete_label(db: &Database, id: i64) -> Result<(), StorageError>`

- [ ] **Step 1: Write the migration**

`crates/am-storage/src/migrations/V8__labels.sql`:

```sql
DROP TABLE IF EXISTS message_labels;
DROP TABLE IF EXISTS labels;

CREATE TABLE labels (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE message_labels (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, label_id)
);

CREATE INDEX idx_message_labels_label ON message_labels(label_id);
```

- [ ] **Step 2: Add the core type**

`crates/am-core/src/label.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct Label {
    pub id: i64,
    pub name: String,
    pub color: String,
}
```

Add to `crates/am-core/src/lib.rs` alphabetically (between `folder` and `message`):

```rust
pub mod label;
```

- [ ] **Step 3: Register the storage module**

Add to `crates/am-storage/src/lib.rs` alphabetically (between `folders_repo` and `messages_repo`):

```rust
pub mod labels_repo;
```

- [ ] **Step 4: Write the failing CRUD tests**

`crates/am-storage/src/labels_repo.rs` (test module only for now):

```rust
use am_core::label::Label;
use rusqlite::params;

use crate::db::{Database, StorageError};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_and_list_labels_ordered() {
        let db = Database::open_in_memory().unwrap();
        create_label(&db, "Work", "#4f46e5").unwrap();
        create_label(&db, "Personal", "#10b981").unwrap();

        let labels = list_labels(&db).unwrap();
        assert_eq!(labels.len(), 2);
        assert_eq!(labels[0].name, "Personal");
        assert_eq!(labels[1].name, "Work");
        assert_eq!(labels[1].color, "#4f46e5");
        assert!(labels[0].id > 0);
    }

    #[test]
    fn create_label_rejects_duplicate_name() {
        let db = Database::open_in_memory().unwrap();
        create_label(&db, "Work", "#4f46e5").unwrap();
        assert!(create_label(&db, "Work", "#10b981").is_err());
    }

    #[test]
    fn rename_and_recolor_label() {
        let db = Database::open_in_memory().unwrap();
        let l = create_label(&db, "Work", "#4f46e5").unwrap();
        rename_label(&db, l.id, "Job").unwrap();
        set_label_color(&db, l.id, "#ec4899").unwrap();

        let labels = list_labels(&db).unwrap();
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].name, "Job");
        assert_eq!(labels[0].color, "#ec4899");
    }

    #[test]
    fn delete_label_removes_row() {
        let db = Database::open_in_memory().unwrap();
        let l = create_label(&db, "Temp", "#0ea5e9").unwrap();
        delete_label(&db, l.id).unwrap();
        assert_eq!(list_labels(&db).unwrap().len(), 0);
    }
}
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `cargo test -p am-storage labels_repo`
Expected: FAIL — `create_label`, `list_labels`, etc. not found.

- [ ] **Step 6: Implement the CRUD functions**

Insert above the `#[cfg(test)]` module in `crates/am-storage/src/labels_repo.rs`:

```rust
pub fn list_labels(db: &Database) -> Result<Vec<Label>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare("SELECT id, name, color FROM labels ORDER BY position, name")?;
    let rows = stmt.query_map([], |r| {
        Ok(Label { id: r.get(0)?, name: r.get(1)?, color: r.get(2)? })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn create_label(db: &Database, name: &str, color: &str) -> Result<Label, StorageError> {
    let conn = db.conn();
    conn.execute(
        "INSERT INTO labels (name, color) VALUES (?1, ?2)",
        params![name, color],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Label { id, name: name.to_string(), color: color.to_string() })
}

pub fn rename_label(db: &Database, id: i64, name: &str) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute("UPDATE labels SET name = ?2 WHERE id = ?1", params![id, name])?;
    Ok(())
}

pub fn set_label_color(db: &Database, id: i64, color: &str) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute("UPDATE labels SET color = ?2 WHERE id = ?1", params![id, color])?;
    Ok(())
}

pub fn delete_label(db: &Database, id: i64) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute("DELETE FROM labels WHERE id = ?1", params![id])?;
    Ok(())
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cargo test -p am-storage labels_repo`
Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
git add crates/am-storage/src/migrations/V8__labels.sql crates/am-core/src/label.rs crates/am-core/src/lib.rs crates/am-storage/src/labels_repo.rs crates/am-storage/src/lib.rs
git commit -m "feat(labels): V8 global labels schema + am-core Label + repo CRUD"
```

---

### Task 2: `labels_repo` message associations

**Files:**
- Modify + Test: `crates/am-storage/src/labels_repo.rs`

**Interfaces:**
- Consumes: `create_label` (Task 1); `crate::smart_repo::row_to_smart`; `am_core::smart::SmartMessageRow`; test helpers `insert_account`/`upsert_folder`/`insert_headers` (see `smart_repo.rs` tests for exact shapes).
- Produces:
  - `set_message_labels(db: &Database, label_id: i64, message_ids: &[i64], applied: bool) -> Result<(), StorageError>`
  - `labels_for_messages(db: &Database, message_ids: &[i64]) -> Result<Vec<(i64, Label)>, StorageError>`
  - `list_messages_by_label(db: &Database, label_id: i64, limit: i64, offset: i64) -> Result<Vec<SmartMessageRow>, StorageError>`

- [ ] **Step 1: Add imports + test helpers to the test module**

In `crates/am-storage/src/labels_repo.rs`, change the top imports to:

```rust
use am_core::label::Label;
use am_core::smart::SmartMessageRow;
use rusqlite::{params, params_from_iter};

use crate::db::{Database, StorageError};
use crate::smart_repo::row_to_smart;
```

Inside `mod tests`, add helpers (mirrors `smart_repo.rs`):

```rust
    use crate::accounts_repo::insert_account;
    use crate::folders_repo::upsert_folder;
    use crate::messages_repo::insert_headers;
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::NewMessageHeader;

    fn make_account(db: &Database, email: &str, color: Option<&str>) -> i64 {
        insert_account(db, &NewAccount {
            email: email.into(),
            display_name: email.into(),
            provider_type: ProviderType::ImapPassword,
            color: color.map(|s| s.to_string()),
        }).unwrap().id
    }

    fn make_folder(db: &Database, account_id: i64, name: &str, ft: FolderType) -> i64 {
        upsert_folder(db, account_id, name, name, ft).unwrap().id
    }

    fn header(uid: i64, subject: &str, date: i64) -> NewMessageHeader {
        NewMessageHeader {
            uid,
            message_id_hdr: Some(format!("<msg-{uid}@example.com>")),
            in_reply_to: None,
            references_hdr: None,
            from_address: "sender@example.com".into(),
            from_name: Some("Sender".into()),
            subject: subject.into(),
            date,
            seen: false,
            flagged: false,
            has_attachments: false,
            size: 100,
            snippet: "preview".into(),
        }
    }

    fn message_id_for(db: &Database, folder_id: i64, uid: i64) -> i64 {
        let conn = db.conn();
        conn.query_row(
            "SELECT id FROM messages WHERE folder_id = ?1 AND uid = ?2",
            params![folder_id, uid],
            |r| r.get(0),
        ).unwrap()
    }
```

- [ ] **Step 2: Write the failing association tests**

Append inside `mod tests`:

```rust
    #[test]
    fn apply_and_remove_message_labels_idempotent() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, "Hello", 1000)]).unwrap();
        let mid = message_id_for(&db, inbox, 1);
        let label = create_label(&db, "Work", "#4f46e5").unwrap();

        set_message_labels(&db, label.id, &[mid], true).unwrap();
        set_message_labels(&db, label.id, &[mid], true).unwrap();
        let pairs = labels_for_messages(&db, &[mid]).unwrap();
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].0, mid);
        assert_eq!(pairs[0].1.name, "Work");

        set_message_labels(&db, label.id, &[mid], false).unwrap();
        set_message_labels(&db, label.id, &[mid], false).unwrap();
        assert_eq!(labels_for_messages(&db, &[mid]).unwrap().len(), 0);
    }

    #[test]
    fn labels_for_messages_empty_ids_returns_empty() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(labels_for_messages(&db, &[]).unwrap().len(), 0);
    }

    #[test]
    fn list_messages_by_label_cross_account_ordered_desc() {
        let db = Database::open_in_memory().unwrap();
        let acc1 = make_account(&db, "a@example.com", Some("#111111"));
        let acc2 = make_account(&db, "b@example.com", Some("#222222"));
        let in1 = make_folder(&db, acc1, "INBOX", FolderType::Inbox);
        let in2 = make_folder(&db, acc2, "INBOX", FolderType::Inbox);
        insert_headers(&db, in1, &[header(1, "old", 1000)]).unwrap();
        insert_headers(&db, in2, &[header(2, "new", 3000)]).unwrap();
        let m1 = message_id_for(&db, in1, 1);
        let m2 = message_id_for(&db, in2, 2);
        let label = create_label(&db, "Shared", "#0ea5e9").unwrap();
        set_message_labels(&db, label.id, &[m1, m2], true).unwrap();

        let rows = list_messages_by_label(&db, label.id, 50, 0).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].date, 3000);
        assert_eq!(rows[0].account_id, acc2);
        assert_eq!(rows[1].date, 1000);
    }

    #[test]
    fn list_messages_by_label_excludes_draft_and_deleted() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, "live", 1000), header(2, "draft", 2000), header(3, "deleted", 3000)]).unwrap();
        let m1 = message_id_for(&db, inbox, 1);
        let m2 = message_id_for(&db, inbox, 2);
        let m3 = message_id_for(&db, inbox, 3);
        let label = create_label(&db, "L", "#10b981").unwrap();
        set_message_labels(&db, label.id, &[m1, m2, m3], true).unwrap();
        {
            let conn = db.conn();
            conn.execute("UPDATE messages SET draft = 1 WHERE id = ?1", params![m2]).unwrap();
            conn.execute("UPDATE messages SET deleted = 1 WHERE id = ?1", params![m3]).unwrap();
        }

        let rows = list_messages_by_label(&db, label.id, 50, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].subject, "live");
    }

    #[test]
    fn deleting_message_cascades_message_labels() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, "Hello", 1000)]).unwrap();
        let mid = message_id_for(&db, inbox, 1);
        let label = create_label(&db, "Work", "#4f46e5").unwrap();
        set_message_labels(&db, label.id, &[mid], true).unwrap();

        crate::messages_repo::delete_by_uids(&db, inbox, &[1]).unwrap();
        assert_eq!(labels_for_messages(&db, &[mid]).unwrap().len(), 0);
        assert_eq!(list_labels(&db).unwrap().len(), 1);
    }
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p am-storage labels_repo`
Expected: FAIL — `set_message_labels`, `labels_for_messages`, `list_messages_by_label` not found.

- [ ] **Step 4: Implement the association functions**

Append after `delete_label` in `crates/am-storage/src/labels_repo.rs`:

```rust
pub fn set_message_labels(
    db: &Database,
    label_id: i64,
    message_ids: &[i64],
    applied: bool,
) -> Result<(), StorageError> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    {
        if applied {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?1, ?2)",
            )?;
            for &mid in message_ids {
                stmt.execute(params![mid, label_id])?;
            }
        } else {
            let mut stmt = tx.prepare(
                "DELETE FROM message_labels WHERE message_id = ?1 AND label_id = ?2",
            )?;
            for &mid in message_ids {
                stmt.execute(params![mid, label_id])?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn labels_for_messages(
    db: &Database,
    message_ids: &[i64],
) -> Result<Vec<(i64, Label)>, StorageError> {
    if message_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = (1..=message_ids.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT ml.message_id, l.id, l.name, l.color
         FROM message_labels ml
         JOIN labels l ON l.id = ml.label_id
         WHERE ml.message_id IN ({placeholders})
         ORDER BY l.position, l.name"
    );
    let conn = db.conn();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(message_ids.iter()), |r| {
        Ok((
            r.get::<_, i64>(0)?,
            Label { id: r.get(1)?, name: r.get(2)?, color: r.get(3)? },
        ))
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn list_messages_by_label(
    db: &Database,
    label_id: i64,
    limit: i64,
    offset: i64,
) -> Result<Vec<SmartMessageRow>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT m.id, m.account_id, m.folder_id, a.color,
                m.from_address, m.from_name, m.subject, m.date,
                m.seen, m.flagged, m.has_attachments, m.snippet
         FROM message_labels ml
         JOIN messages m ON m.id = ml.message_id
         JOIN folders f ON f.id = m.folder_id
         JOIN accounts a ON a.id = m.account_id
         WHERE ml.label_id = ?1
           AND m.draft = 0
           AND m.deleted = 0
         ORDER BY m.date DESC
         LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![label_id, limit, offset], row_to_smart)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p am-storage labels_repo`
Expected: PASS (9 tests total in this file).

- [ ] **Step 6: Commit**

```bash
git add crates/am-storage/src/labels_repo.rs
git commit -m "feat(labels): message association queries in labels_repo"
```

---

### Task 3: `am-app` commands + bindings

**Files:**
- Modify: `crates/am-app/src/commands.rs`
- Modify: `crates/am-app/src/lib.rs` (register in `collect_commands!`)
- Generated: `src/ipc/bindings.ts` (via `npm run gen:bindings`)

**Interfaces:**
- Consumes: `labels_repo::*` (Tasks 1–2); `am_core::label::Label`; `am_core::smart::SmartMessageRow`; `AppState` (`state.db`).
- Produces Tauri commands (camelCased in bindings): `listLabels`, `createLabel`, `renameLabel`, `setLabelColor`, `deleteLabel`, `setMessageLabels`, `labelsForMessages`, `listMessagesByLabel`.

- [ ] **Step 1: Write the failing command test**

Append inside the `mod tests` block in `crates/am-app/src/commands.rs` (uses the in-memory DB pattern already there):

```rust
    #[test]
    fn label_repo_roundtrip_via_storage() {
        use am_storage::labels_repo;
        let db = Database::open_in_memory().unwrap();
        let created = labels_repo::create_label(&db, "Work", "#4f46e5").unwrap();
        let all = labels_repo::list_labels(&db).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, created.id);
        assert_eq!(all[0].name, "Work");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p abeonmail label_repo_roundtrip_via_storage`
Expected: FAIL — `labels_repo` not found in `am_storage` import scope of the test (or compile error until module is wired). If it already compiles (Task 1 exported the module), the test passes immediately; in that case proceed — this test guards the storage surface the commands depend on.

- [ ] **Step 3: Add the commands**

In `crates/am-app/src/commands.rs`, extend the existing `am_core` use block to include `label::Label`:

```rust
use am_core::{
    account::Account,
    folder::Folder,
    label::Label,
    message::{MessageBody, MessageFlag, MessageHeader},
    outgoing::{OutgoingAttachment, OutgoingMessage},
    signature::Signature,
    smart::{SmartFolderKind, SmartMessageRow},
    thread::ThreadSummary,
};
```

Extend the `am_storage` use block to include `labels_repo`:

```rust
use am_storage::{accounts_repo, drafts_repo, folders_repo, labels_repo, messages_repo, settings_repo, signatures_repo, smart_repo};
```

Add the commands (place after `search_messages`):

```rust
#[tauri::command]
#[specta::specta]
pub fn list_labels(state: tauri::State<'_, AppState>) -> Result<Vec<Label>, String> {
    labels_repo::list_labels(&state.db).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn create_label(
    state: tauri::State<'_, AppState>,
    name: String,
    color: String,
) -> Result<Label, String> {
    labels_repo::create_label(&state.db, &name, &color).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn rename_label(
    state: tauri::State<'_, AppState>,
    id: i64,
    name: String,
) -> Result<(), String> {
    labels_repo::rename_label(&state.db, id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn set_label_color(
    state: tauri::State<'_, AppState>,
    id: i64,
    color: String,
) -> Result<(), String> {
    labels_repo::set_label_color(&state.db, id, &color).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn delete_label(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    labels_repo::delete_label(&state.db, id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn set_message_labels(
    state: tauri::State<'_, AppState>,
    label_id: i64,
    message_ids: Vec<i64>,
    applied: bool,
) -> Result<(), String> {
    labels_repo::set_message_labels(&state.db, label_id, &message_ids, applied)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn labels_for_messages(
    state: tauri::State<'_, AppState>,
    message_ids: Vec<i64>,
) -> Result<Vec<(i64, Label)>, String> {
    labels_repo::labels_for_messages(&state.db, &message_ids).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn list_messages_by_label(
    state: tauri::State<'_, AppState>,
    label_id: i64,
    limit: i64,
    offset: i64,
) -> Result<Vec<SmartMessageRow>, String> {
    labels_repo::list_messages_by_label(&state.db, label_id, limit, offset)
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Register in the specta builder**

In `crates/am-app/src/lib.rs`, add to `collect_commands![ ... ]` after `commands::search_messages,`:

```rust
            commands::list_labels,
            commands::create_label,
            commands::rename_label,
            commands::set_label_color,
            commands::delete_label,
            commands::set_message_labels,
            commands::labels_for_messages,
            commands::list_messages_by_label,
```

- [ ] **Step 5: Run the workspace tests + regenerate bindings**

Run: `cargo test -p abeonmail label_repo_roundtrip_via_storage`
Expected: PASS.

Run: `npm run gen:bindings`
Expected: exits 0; `src/ipc/bindings.ts` now contains a `Label` type and `listLabels`/`createLabel`/`renameLabel`/`setLabelColor`/`deleteLabel`/`setMessageLabels`/`labelsForMessages`/`listMessagesByLabel` functions. Verify with:

Run: `grep -c "labelsForMessages\|listMessagesByLabel\|createLabel" src/ipc/bindings.ts`
Expected: ≥ 3.

- [ ] **Step 6: Commit**

```bash
git add crates/am-app/src/commands.rs crates/am-app/src/lib.rs src/ipc/bindings.ts
git commit -m "feat(labels): tauri commands + regenerated bindings"
```

---

### Task 4: Frontend store slice + label color palette

**Files:**
- Create: `src/shared/labels/labels.ts`
- Create + Test: `src/shared/labels/labels.test.ts`
- Modify: `src/app/store.ts`
- Modify: `src/app/store.test.ts`

**Interfaces:**
- Produces (palette): `LABEL_COLORS: string[]`, `nextLabelColor(used: string[]): string`.
- Produces (store fields): `selectedLabelId: number | null`, `selectionActive: boolean`, `selectedMessageIds: number[]`, `labelPickerOpen: boolean`, `labelPickerTargetIds: number[]`.
- Produces (store actions): `setSelectedLabelId(id)`, `toggleSelectionMode()`, `toggleMessageSelected(id)`, `clearSelection()`, `selectAll(ids)`, `openLabelPicker(ids)`, `closeLabelPicker()`.
- Behavior: `setSelectedLabelId(id)` clears smart folder / folder / account / thread / search and clears selection. Existing `setSelectedAccountId`/`setSelectedFolderId`/`setSelectedSmartFolder`/`setSearchQuery` ALSO clear `selectedLabelId`.

- [ ] **Step 1: Write the palette + test**

`src/shared/labels/labels.ts`:

```ts
export const LABEL_COLORS: string[] = [
  "#4f46e5",
  "#7c3aed",
  "#0ea5e9",
  "#10b981",
  "#ef5d3a",
  "#ec4899",
  "#f59e0b",
  "#0d9488",
];

export function nextLabelColor(used: string[]): string {
  const free = LABEL_COLORS.find((c) => !used.includes(c));
  return free ?? LABEL_COLORS[used.length % LABEL_COLORS.length];
}
```

`src/shared/labels/labels.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { LABEL_COLORS, nextLabelColor } from "./labels";

describe("nextLabelColor", () => {
  it("returns the first color when none are used", () => {
    expect(nextLabelColor([])).toBe(LABEL_COLORS[0]);
  });

  it("skips used colors", () => {
    expect(nextLabelColor([LABEL_COLORS[0], LABEL_COLORS[1]])).toBe(LABEL_COLORS[2]);
  });

  it("wraps when all colors are used", () => {
    const all = [...LABEL_COLORS];
    expect(LABEL_COLORS.includes(nextLabelColor(all))).toBe(true);
  });
});
```

- [ ] **Step 2: Run palette test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/shared/labels/labels.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 3: Write the failing store tests**

Append to `src/app/store.test.ts`:

```ts
describe("labels store slice", () => {
  beforeEach(() => {
    useUiStore.setState({
      selectedAccountId: null,
      selectedFolderId: null,
      selectedSmartFolder: null,
      selectedThreadId: null,
      selectedLabelId: null,
      searchQuery: "",
      searchActive: false,
      selectionActive: false,
      selectedMessageIds: [],
      labelPickerOpen: false,
      labelPickerTargetIds: [],
    });
  });

  it("setSelectedLabelId clears other views and selection", () => {
    useUiStore.setState({ selectedSmartFolder: "unread", selectionActive: true, selectedMessageIds: [1, 2] });
    useUiStore.getState().setSelectedLabelId(7);
    const s = useUiStore.getState();
    expect(s.selectedLabelId).toBe(7);
    expect(s.selectedSmartFolder).toBeNull();
    expect(s.selectionActive).toBe(false);
    expect(s.selectedMessageIds.length).toBe(0);
  });

  it("selecting another view clears selectedLabelId", () => {
    useUiStore.getState().setSelectedLabelId(7);
    useUiStore.getState().setSelectedSmartFolder("flagged");
    expect(useUiStore.getState().selectedLabelId).toBeNull();
  });

  it("toggleMessageSelected adds and removes ids", () => {
    useUiStore.getState().toggleMessageSelected(5);
    expect(useUiStore.getState().selectedMessageIds).toEqual([5]);
    useUiStore.getState().toggleMessageSelected(5);
    expect(useUiStore.getState().selectedMessageIds).toEqual([]);
  });

  it("toggleSelectionMode off clears selection", () => {
    useUiStore.getState().toggleSelectionMode();
    useUiStore.getState().toggleMessageSelected(1);
    expect(useUiStore.getState().selectionActive).toBe(true);
    useUiStore.getState().toggleSelectionMode();
    expect(useUiStore.getState().selectionActive).toBe(false);
    expect(useUiStore.getState().selectedMessageIds).toEqual([]);
  });

  it("openLabelPicker stores target ids", () => {
    useUiStore.getState().openLabelPicker([3, 4]);
    expect(useUiStore.getState().labelPickerOpen).toBe(true);
    expect(useUiStore.getState().labelPickerTargetIds).toEqual([3, 4]);
    useUiStore.getState().closeLabelPicker();
    expect(useUiStore.getState().labelPickerOpen).toBe(false);
    expect(useUiStore.getState().labelPickerTargetIds).toEqual([]);
  });
});
```

(If `store.test.ts` lacks `beforeEach`/`describe` imports, add `import { describe, it, expect, beforeEach } from "vitest";` and `import { useUiStore } from "./store";` at the top if not already present.)

- [ ] **Step 4: Run store tests to verify they fail**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/app/store.test.ts`
Expected: FAIL — `setSelectedLabelId` etc. not functions.

- [ ] **Step 5: Add the fields and actions to the store**

In `src/app/store.ts`, add to the `UiState` type (after `selectedSmartFolder`):

```ts
  selectedLabelId: number | null;
```

Add (after `focusSearch`):

```ts
  selectionActive: boolean;
  selectedMessageIds: number[];
  labelPickerOpen: boolean;
  labelPickerTargetIds: number[];
```

Add to the actions section of the type:

```ts
  setSelectedLabelId: (id: number | null) => void;
  toggleSelectionMode: () => void;
  toggleMessageSelected: (id: number) => void;
  clearSelection: () => void;
  selectAll: (ids: number[]) => void;
  openLabelPicker: (ids: number[]) => void;
  closeLabelPicker: () => void;
```

In the `create` initial state, add (after `selectedSmartFolder: null,`):

```ts
  selectedLabelId: null,
```

and (after `focusSearch: null,`):

```ts
  selectionActive: false,
  selectedMessageIds: [],
  labelPickerOpen: false,
  labelPickerTargetIds: [],
```

Update the existing mutual-exclusion setters to also clear `selectedLabelId`:

```ts
  setSelectedAccountId: (id) =>
    set({ selectedAccountId: id, selectedSmartFolder: null, selectedLabelId: null, searchQuery: "", searchActive: false }),
  setSelectedFolderId: (id) =>
    set({ selectedFolderId: id, selectedSmartFolder: null, selectedLabelId: null, searchQuery: "", searchActive: false }),
  setSelectedSmartFolder: (kind) =>
    set({
      selectedSmartFolder: kind,
      selectedLabelId: null,
      selectedAccountId: null,
      selectedFolderId: null,
      selectedThreadId: null,
      searchQuery: "",
      searchActive: false,
    }),
  setSearchQuery: (q) => set({ searchQuery: q, searchActive: q.trim().length > 0, selectedLabelId: null }),
```

Add the new actions (place after `setFocusSearch`):

```ts
  setSelectedLabelId: (id) =>
    set({
      selectedLabelId: id,
      selectedSmartFolder: null,
      selectedAccountId: null,
      selectedFolderId: null,
      selectedThreadId: null,
      searchQuery: "",
      searchActive: false,
      selectionActive: false,
      selectedMessageIds: [],
    }),
  toggleSelectionMode: () =>
    set((s) => ({
      selectionActive: !s.selectionActive,
      selectedMessageIds: s.selectionActive ? [] : s.selectedMessageIds,
    })),
  toggleMessageSelected: (id) =>
    set((s) => ({
      selectedMessageIds: s.selectedMessageIds.includes(id)
        ? s.selectedMessageIds.filter((x) => x !== id)
        : [...s.selectedMessageIds, id],
    })),
  clearSelection: () => set({ selectionActive: false, selectedMessageIds: [] }),
  selectAll: (ids) => set({ selectionActive: true, selectedMessageIds: ids }),
  openLabelPicker: (ids) => set({ labelPickerOpen: true, labelPickerTargetIds: ids }),
  closeLabelPicker: () => set({ labelPickerOpen: false, labelPickerTargetIds: [] }),
```

- [ ] **Step 6: Run store tests to verify they pass**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/app/store.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/labels/labels.ts src/shared/labels/labels.test.ts src/app/store.ts src/app/store.test.ts
git commit -m "feat(labels): store slice + label color palette"
```

---

### Task 5: react-query hooks

**Files:**
- Modify: `src/ipc/queries.ts`
- Modify: `src/ipc/queries.test.tsx`

**Interfaces:**
- Consumes: `commands.{listLabels,createLabel,renameLabel,setLabelColor,deleteLabel,setMessageLabels,labelsForMessages,listMessagesByLabel}`; `Label`, `SmartMessageRow` from bindings.
- Produces hooks: `useLabels()`, `useMessagesByLabel(labelId)`, `useLabelsForMessages(ids)`, `useCreateLabel()`, `useRenameLabel()`, `useSetLabelColor()`, `useDeleteLabel()`, `useSetMessageLabels()`.

- [ ] **Step 1: Write the failing hook tests**

Append to `src/ipc/queries.test.tsx` (follow the file's existing mock pattern for `commands`; the snippet below assumes `vi.mock("./bindings", ...)` exposes a `commands` object — add the new methods to that mock). Add:

```tsx
describe("label hooks", () => {
  it("useLabels fetches labels", async () => {
    (commands.listLabels as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [{ id: 1, name: "Work", color: "#4f46e5" }],
    });
    const { result } = renderHook(() => useLabels(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0].name).toBe("Work");
  });

  it("useLabelsForMessages is disabled for empty ids", () => {
    const { result } = renderHook(() => useLabelsForMessages([]), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("useMessagesByLabel is disabled when labelId is null", () => {
    const { result } = renderHook(() => useMessagesByLabel(null), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
  });
});
```

Ensure the imports at the top of the test include the new hook names from `"./queries"` and that the `commands` mock object includes `listLabels`, `labelsForMessages`, `listMessagesByLabel`, `createLabel`, `renameLabel`, `setLabelColor`, `deleteLabel`, `setMessageLabels` as `vi.fn()`.

- [ ] **Step 2: Run hook tests to verify they fail**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/ipc/queries.test.tsx`
Expected: FAIL — hooks not exported.

- [ ] **Step 3: Implement the hooks**

In `src/ipc/queries.ts`, add `Label` to the type import:

```ts
import type { Account, Endpoints, Label, MessageFlag, OutgoingMessage, SmartFolderKind, SmartMessageRow } from "./bindings";
```

Append at the end of the file:

```ts
export function useLabels() {
  return useQuery<Label[]>({
    queryKey: ["labels"],
    queryFn: () => commands.listLabels().then(unwrap),
  });
}

export function useMessagesByLabel(labelId: number | null) {
  return useQuery<SmartMessageRow[]>({
    queryKey: ["messages-by-label", labelId],
    queryFn: () => commands.listMessagesByLabel(labelId!, 100, 0).then(unwrap),
    enabled: labelId != null,
  });
}

export function useLabelsForMessages(ids: number[]) {
  const sorted = [...ids].sort((a, b) => a - b);
  return useQuery<[number, Label][]>({
    queryKey: ["labels-for-messages", sorted],
    queryFn: () => commands.labelsForMessages(sorted).then(unwrap),
    enabled: sorted.length > 0,
  });
}

export function useCreateLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, color }: { name: string; color: string }) =>
      commands.createLabel(name, color).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["labels"] });
    },
  });
}

export function useRenameLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      commands.renameLabel(id, name).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["labels"] });
      queryClient.invalidateQueries({ queryKey: ["labels-for-messages"] });
    },
  });
}

export function useSetLabelColor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, color }: { id: number; color: string }) =>
      commands.setLabelColor(id, color).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["labels"] });
      queryClient.invalidateQueries({ queryKey: ["labels-for-messages"] });
    },
  });
}

export function useDeleteLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => commands.deleteLabel(id).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["labels"] });
      queryClient.invalidateQueries({ queryKey: ["labels-for-messages"] });
      queryClient.invalidateQueries({ queryKey: ["messages-by-label"] });
    },
  });
}

export function useSetMessageLabels() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ labelId, messageIds, applied }: { labelId: number; messageIds: number[]; applied: boolean }) =>
      commands.setMessageLabels(labelId, messageIds, applied).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["labels-for-messages"] });
      queryClient.invalidateQueries({ queryKey: ["messages-by-label"] });
    },
  });
}
```

- [ ] **Step 4: Run hook tests to verify they pass**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/ipc/queries.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/queries.ts src/ipc/queries.test.tsx
git commit -m "feat(labels): react-query hooks for labels"
```

---

### Task 6: LabelChips component + chips in message list

**Files:**
- Create + Test: `src/features/labels/LabelChips.tsx`, `src/features/labels/LabelChips.test.tsx`
- Create: `src/features/labels/LabelChips.css`
- Modify: `src/features/message-list/MessageListPane.tsx`

**Interfaces:**
- Consumes: `Label` from bindings; `useLabelsForMessages` (Task 5).
- Produces: `LabelChips({ labels }: { labels: Label[] })`.

- [ ] **Step 1: Write the failing LabelChips test**

`src/features/labels/LabelChips.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { LabelChips } from "./LabelChips";

describe("LabelChips", () => {
  it("renders a chip per label", () => {
    const { getByText } = render(
      <LabelChips labels={[{ id: 1, name: "Work", color: "#4f46e5" }, { id: 2, name: "Urgent", color: "#ef5d3a" }]} />
    );
    expect(getByText("Work")).toBeTruthy();
    expect(getByText("Urgent")).toBeTruthy();
  });

  it("renders nothing for empty labels", () => {
    const { container } = render(<LabelChips labels={[]} />);
    expect(container.querySelector(".label-chip")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/labels/LabelChips.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement LabelChips + CSS**

`src/features/labels/LabelChips.tsx`:

```tsx
import type { Label } from "../../ipc/bindings";
import "./LabelChips.css";

export function LabelChips({ labels }: { labels: Label[] }) {
  if (labels.length === 0) return null;
  return (
    <span className="label-chips">
      {labels.map((l) => (
        <span key={l.id} className="label-chip" style={{ backgroundColor: l.color }}>
          {l.name}
        </span>
      ))}
    </span>
  );
}
```

`src/features/labels/LabelChips.css`:

```css
.label-chips {
  display: inline-flex;
  gap: 4px;
  flex-wrap: wrap;
  align-items: center;
}

.label-chip {
  font-size: 10px;
  line-height: 1;
  color: #fff;
  padding: 2px 6px;
  border-radius: 999px;
  white-space: nowrap;
}
```

- [ ] **Step 4: Wire chips into the message list**

In `src/features/message-list/MessageListPane.tsx`:

Add imports:

```tsx
import { useThreads, useSmartFolder, useSearch, useMessagesByLabel, useLabelsForMessages } from "../../ipc/queries";
import { LabelChips } from "../labels/LabelChips";
import type { ThreadSummary, SmartMessageRow, Label } from "../../ipc/bindings";
```

Add a `labels?: Label[]` prop to `SmartRow` (extend its prop type and signature) and render chips inside `message-row__badges` after the attachment span:

```tsx
            {labels && labels.length > 0 && <LabelChips labels={labels} />}
```

In the `MessageListPane` body, after `highlightTerms` is computed, derive the visible flat ids and fetch labels:

```tsx
  const flatMessageIds = useMemo(
    () => (isFlatMode ? (rawItems as SmartMessageRow[]).map((r) => r.message_id) : []),
    [rawItems, isFlatMode]
  );
  const { data: labelPairs } = useLabelsForMessages(flatMessageIds);
  const labelsByMessage = useMemo(() => {
    const map = new Map<number, Label[]>();
    for (const [mid, label] of labelPairs ?? []) {
      const arr = map.get(mid) ?? [];
      arr.push(label);
      map.set(mid, arr);
    }
    return map;
  }, [labelPairs]);
```

Pass to `SmartRow` in the render (both the flat-mode branch already present):

```tsx
                    <SmartRow
                      row={row}
                      isSelected={selectedMessageId === row.message_id}
                      rowHeight={rowHeight}
                      showAvatars={showAvatars}
                      showSnippet={showSnippet}
                      onSelect={setSelectedMessageId}
                      highlightTerms={searchActive ? highlightTerms : undefined}
                      labels={labelsByMessage.get(row.message_id)}
                    />
```

NOTE: `isFlatMode` is referenced by `flatMessageIds` before its declaration in the current file order — keep `flatMessageIds`/`labelPairs`/`labelsByMessage` AFTER the existing `isFlatMode`/`rawItems` declarations (they are declared near the top of the function body; insert the new block right after the `highlightTerms` memo).

- [ ] **Step 5: Run tests to verify they pass**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/labels/LabelChips.test.tsx src/features/message-list/MessageListPane.test.tsx`
Expected: PASS. If `MessageListPane.test.tsx` mocks `../../ipc/queries`, add `useMessagesByLabel: () => ({ data: undefined })` and `useLabelsForMessages: () => ({ data: undefined })` to that mock.

- [ ] **Step 6: Commit**

```bash
git add src/features/labels/LabelChips.tsx src/features/labels/LabelChips.css src/features/labels/LabelChips.test.tsx src/features/message-list/MessageListPane.tsx
git commit -m "feat(labels): LabelChips and chips in the message list"
```

---

### Task 7: LabelPicker popover

**Files:**
- Create + Test: `src/features/labels/LabelPicker.tsx`, `src/features/labels/LabelPicker.test.tsx`
- Create: `src/features/labels/LabelPicker.css`
- Modify: `src/features/shortcuts/ShortcutsProvider.tsx` (mount `<LabelPicker />` globally)
- Modify: `src/test/lucide-stub.js` (add `Tag`, `Plus`, `Check`)

**Interfaces:**
- Consumes: store `labelPickerOpen`, `labelPickerTargetIds`, `closeLabelPicker`; `useLabels`, `useLabelsForMessages`, `useCreateLabel`, `useSetMessageLabels`; `nextLabelColor`, `LABEL_COLORS`.
- Produces: `LabelPicker()` — a global popover, returns null when `!labelPickerOpen`.
- Behavior: shows all labels with a checkbox reflecting whether ALL target messages already have it; toggling calls `setMessageLabels({labelId, messageIds: targetIds, applied})`. A text input filters labels; pressing Enter when the trimmed text matches no existing label creates it (`nextLabelColor` of existing colors) and applies it to the targets.

- [ ] **Step 1: Add the icons to the lucide stub**

Append to `src/test/lucide-stub.js`:

```js
exports.Tag = Icon;
exports.Plus = Icon;
exports.Check = Icon;
```

- [ ] **Step 2: Write the failing LabelPicker test**

`src/features/labels/LabelPicker.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LabelPicker } from "./LabelPicker";
import { useUiStore } from "../../app/store";
import { commands } from "../../ipc/bindings";

vi.mock("../../ipc/bindings", () => ({
  commands: {
    listLabels: vi.fn().mockResolvedValue({ status: "ok", data: [{ id: 1, name: "Work", color: "#4f46e5" }] }),
    labelsForMessages: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    createLabel: vi.fn().mockResolvedValue({ status: "ok", data: { id: 2, name: "New", color: "#10b981" } }),
    setMessageLabels: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("LabelPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ labelPickerOpen: true, labelPickerTargetIds: [10] });
  });

  it("renders existing labels and toggles them", async () => {
    const { getByText } = wrap(<LabelPicker />);
    await waitFor(() => expect(getByText("Work")).toBeTruthy());
    fireEvent.click(getByText("Work"));
    await waitFor(() =>
      expect(commands.setMessageLabels).toHaveBeenCalledWith(1, [10], true)
    );
  });

  it("creates a new label on Enter when no match", async () => {
    const { getByLabelText } = wrap(<LabelPicker />);
    const input = getByLabelText("Filter or create label");
    fireEvent.change(input, { target: { value: "Urgent" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(commands.createLabel).toHaveBeenCalled());
  });

  it("returns null when closed", () => {
    useUiStore.setState({ labelPickerOpen: false, labelPickerTargetIds: [] });
    const { container } = wrap(<LabelPicker />);
    expect(container.querySelector(".label-picker")).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/labels/LabelPicker.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement LabelPicker + CSS**

`src/features/labels/LabelPicker.tsx`:

```tsx
import { useState } from "react";
import { Check } from "lucide-react";
import { useUiStore } from "../../app/store";
import {
  useLabels,
  useLabelsForMessages,
  useCreateLabel,
  useSetMessageLabels,
} from "../../ipc/queries";
import { nextLabelColor } from "../../shared/labels/labels";
import "./LabelPicker.css";

export function LabelPicker() {
  const open = useUiStore((s) => s.labelPickerOpen);
  const targetIds = useUiStore((s) => s.labelPickerTargetIds);
  const closeLabelPicker = useUiStore((s) => s.closeLabelPicker);
  const [filter, setFilter] = useState("");

  const { data: labels = [] } = useLabels();
  const { data: pairs = [] } = useLabelsForMessages(open ? targetIds : []);
  const createLabel = useCreateLabel();
  const setMessageLabels = useSetMessageLabels();

  if (!open) return null;

  const appliedCount = new Map<number, number>();
  for (const [, label] of pairs) {
    appliedCount.set(label.id, (appliedCount.get(label.id) ?? 0) + 1);
  }
  const isFullyApplied = (labelId: number) =>
    targetIds.length > 0 && appliedCount.get(labelId) === targetIds.length;

  const trimmed = filter.trim();
  const visible = labels.filter((l) => l.name.toLowerCase().includes(trimmed.toLowerCase()));
  const exactMatch = labels.some((l) => l.name.toLowerCase() === trimmed.toLowerCase());

  function toggle(labelId: number) {
    setMessageLabels.mutate({ labelId, messageIds: targetIds, applied: !isFullyApplied(labelId) });
  }

  async function createAndApply() {
    if (!trimmed || exactMatch) return;
    const color = nextLabelColor(labels.map((l) => l.color));
    const created = await createLabel.mutateAsync({ name: trimmed, color });
    setMessageLabels.mutate({ labelId: created.id, messageIds: targetIds, applied: true });
    setFilter("");
  }

  return (
    <div className="label-picker-overlay" role="presentation" onClick={closeLabelPicker}>
      <div className="label-picker" role="dialog" aria-label="Apply labels" onClick={(e) => e.stopPropagation()}>
        <input
          className="label-picker__input"
          autoFocus
          type="text"
          value={filter}
          aria-label="Filter or create label"
          placeholder="Filter or create label"
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void createAndApply();
            if (e.key === "Escape") closeLabelPicker();
          }}
        />
        <ul className="label-picker__list">
          {visible.map((l) => (
            <li key={l.id}>
              <button type="button" className="label-picker__item" onClick={() => toggle(l.id)}>
                <span className="label-picker__dot" style={{ backgroundColor: l.color }} />
                <span className="label-picker__name">{l.name}</span>
                {isFullyApplied(l.id) && <Check size={14} className="label-picker__check" />}
              </button>
            </li>
          ))}
          {trimmed && !exactMatch && (
            <li>
              <button type="button" className="label-picker__item label-picker__create" onClick={() => void createAndApply()}>
                Create &ldquo;{trimmed}&rdquo;
              </button>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
```

`src/features/labels/LabelPicker.css`:

```css
.label-picker-overlay {
  position: fixed;
  inset: 0;
  z-index: 220;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  background: rgba(0, 0, 0, 0.4);
}

.label-picker {
  width: 320px;
  max-height: 60vh;
  overflow: auto;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}

.label-picker__input {
  width: 100%;
  box-sizing: border-box;
  border: none;
  border-bottom: 1px solid var(--border-subtle);
  padding: var(--space-3);
  font-size: 14px;
  background: transparent;
  color: inherit;
}

.label-picker__input:focus {
  outline: none;
}

.label-picker__list {
  list-style: none;
  margin: 0;
  padding: var(--space-1);
}

.label-picker__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  background: transparent;
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  font-size: 13px;
  color: inherit;
  border-radius: var(--radius-sm);
}

.label-picker__item:hover {
  background: var(--selection-bg);
}

.label-picker__dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.label-picker__name {
  flex: 1;
  text-align: left;
}

.label-picker__create {
  color: var(--accent);
}
```

- [ ] **Step 5: Mount LabelPicker globally**

In `src/features/shortcuts/ShortcutsProvider.tsx`, add the import:

```tsx
import { LabelPicker } from "../labels/LabelPicker";
```

and render it next to the other global overlays:

```tsx
    <ShortcutsContext.Provider value={value}>
      {children}
      <CommandPalette />
      <CheatSheet />
      <LabelPicker />
    </ShortcutsContext.Provider>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/labels/LabelPicker.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/features/labels/LabelPicker.tsx src/features/labels/LabelPicker.css src/features/labels/LabelPicker.test.tsx src/features/shortcuts/ShortcutsProvider.tsx src/test/lucide-stub.js
git commit -m "feat(labels): global LabelPicker popover with create-on-type"
```

---

### Task 8: Rail Labels section

**Files:**
- Modify: `src/features/mailbox/MailboxRail.tsx`
- Modify: `src/features/mailbox/MailboxRail.test.tsx`

**Interfaces:**
- Consumes: `useLabels` (Task 5); store `selectedLabelId`, `setSelectedLabelId`, `openLabelPicker`; `Tag`/`Plus` lucide icons.
- Replaces: the `<div className="rail__section">Labels</div>` + `Coming soon` placeholder block.

- [ ] **Step 1: Write the failing rail test**

Append to `src/features/mailbox/MailboxRail.test.tsx` (this suite uses the REAL zustand store — see existing setup). Add a test that mocks `useLabels`:

```tsx
it("renders labels and selects one on click", async () => {
  // The suite already mocks ../../ipc/queries; ensure useLabels returns one label.
  const { findByText } = renderRail(); // use the suite's existing render helper
  const chip = await findByText("Work");
  fireEvent.click(chip);
  expect(useUiStore.getState().selectedLabelId).toBe(1);
});
```

In the suite's `vi.mock("../../ipc/queries", ...)`, add:

```tsx
  useLabels: () => ({ data: [{ id: 1, name: "Work", color: "#4f46e5" }] }),
```

(If the suite renders `MailboxRail` directly without a helper, render it inside the existing providers used by the other tests.)

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/mailbox/MailboxRail.test.tsx`
Expected: FAIL — "Work" not found (still "Coming soon").

- [ ] **Step 3: Implement the rail Labels section**

In `src/features/mailbox/MailboxRail.tsx`:

Add to the lucide import block: `Tag, Plus`.

Add to the hooks import: `useLabels`.

Add store selectors inside the component (near the other `useUiStore` calls):

```tsx
  const selectedLabelId = useUiStore((s) => s.selectedLabelId);
  const setSelectedLabelId = useUiStore((s) => s.setSelectedLabelId);
  const openLabelPicker = useUiStore((s) => s.openLabelPicker);
  const { data: labels = [] } = useLabels();
```

Replace the placeholder block:

```tsx
        <div className="rail__section">Labels</div>
        <div className="rail__placeholder" aria-disabled="true">Coming soon</div>
```

with:

```tsx
        <div className="rail__section">Labels</div>
        {labels.map((label) => (
          <div
            key={label.id}
            className={`rail__item${selectedLabelId === label.id ? " rail__item--active" : ""}`}
            onClick={() => setSelectedLabelId(label.id)}
          >
            <span
              className="rail__label-dot"
              style={{ background: label.color }}
              aria-hidden="true"
            />
            <span className="rail__item-label">{label.name}</span>
          </div>
        ))}
        <div
          className="rail__item rail__new-label"
          onClick={() => openLabelPicker([])}
          role="button"
        >
          <Plus size={15} className="rail__item-icon" />
          <span className="rail__item-label">New label</span>
        </div>
```

(`openLabelPicker([])` opens the picker with no target messages — the user can still create labels there; creating with empty targets simply registers the label.)

Add to `src/features/mailbox/MailboxRail.css`:

```css
.rail__label-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  margin: 0 2px;
}
```

(Use the `Tag` import for the section if you prefer an icon header; not required.)

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/mailbox/MailboxRail.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/mailbox/MailboxRail.tsx src/features/mailbox/MailboxRail.test.tsx src/features/mailbox/MailboxRail.css
git commit -m "feat(labels): rail Labels section with live list + new label"
```

---

### Task 9: Label-view mode in the message list

**Files:**
- Modify: `src/features/message-list/MessageListPane.tsx`
- Modify: `src/features/message-list/MessageListPane.test.tsx`

**Interfaces:**
- Consumes: store `selectedLabelId`; `useMessagesByLabel` (Task 5); `useLabels` for the banner name.
- Behavior: when `selectedLabelId != null` (and not searching), render that label's messages as a flat `SmartRow` list with a banner `Label: <name> (<count>)`.

- [ ] **Step 1: Write the failing test**

Append to `src/features/message-list/MessageListPane.test.tsx`:

```tsx
it("renders label-view messages when a label is selected", () => {
  // Configure mocks: useMessagesByLabel returns one row, useLabels returns the label.
  useUiStore.setState({
    selectedFolderId: null,
    selectedSmartFolder: null,
    selectedLabelId: 1,
    searchActive: false,
    searchQuery: "",
  });
  const { getByText } = renderPane(); // suite's render helper
  expect(getByText(/Label: Work/)).toBeTruthy();
});
```

Extend the suite's `vi.mock("../../ipc/queries", ...)` so that:

```tsx
  useMessagesByLabel: (id: number | null) =>
    id === 1
      ? { data: [{ message_id: 99, account_id: 1, folder_id: 1, account_color: "#4f46e5", from_address: "a@b.com", from_name: "A", subject: "Tagged", date: 1000, seen: true, flagged: false, has_attachments: false, snippet: "" }], isLoading: false }
      : { data: undefined, isLoading: false },
  useLabels: () => ({ data: [{ id: 1, name: "Work", color: "#4f46e5" }] }),
  useLabelsForMessages: () => ({ data: [] }),
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/message-list/MessageListPane.test.tsx`
Expected: FAIL — banner not rendered.

- [ ] **Step 3: Implement label-view mode**

In `src/features/message-list/MessageListPane.tsx`:

Add store selector and hooks near the other selectors:

```tsx
  const selectedLabelId = useUiStore((s) => s.selectedLabelId);
```

Add to the queries import: `useLabels`. Add hook calls after the existing `useSearch` line:

```tsx
  const { data: labelRows, isLoading: labelLoading } = useMessagesByLabel(selectedLabelId);
  const { data: allLabels } = useLabels();
```

Update the mode resolution. Replace the existing block:

```tsx
  const isSmartMode = !searchActive && selectedSmartFolder != null;
  const isFlatMode = searchActive || isSmartMode;
  const isLoading = searchActive ? searchLoading : isSmartMode ? smartLoading : threadsLoading;
  const rawItems = searchActive
    ? (searchRows ?? [])
    : isSmartMode
      ? (smartRows ?? [])
      : (threads ?? []);
  const hasSelection = searchActive
    ? true
    : isSmartMode
      ? selectedSmartFolder != null
      : selectedFolderId != null;
```

with:

```tsx
  const isLabelMode = !searchActive && selectedLabelId != null;
  const isSmartMode = !searchActive && !isLabelMode && selectedSmartFolder != null;
  const isFlatMode = searchActive || isLabelMode || isSmartMode;
  const isLoading = searchActive
    ? searchLoading
    : isLabelMode
      ? labelLoading
      : isSmartMode
        ? smartLoading
        : threadsLoading;
  const rawItems = searchActive
    ? (searchRows ?? [])
    : isLabelMode
      ? (labelRows ?? [])
      : isSmartMode
        ? (smartRows ?? [])
        : (threads ?? []);
  const hasSelection = searchActive
    ? true
    : isLabelMode
      ? selectedLabelId != null
      : isSmartMode
        ? selectedSmartFolder != null
        : selectedFolderId != null;
  const activeLabel = allLabels?.find((l) => l.id === selectedLabelId);
```

Add the banner after the existing `searchActive` banner block:

```tsx
      {isLabelMode && activeLabel && (
        <div className="message-list__search-banner" role="status">
          <span>
            Label: {activeLabel.name} ({rawItems.length})
          </span>
        </div>
      )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/message-list/MessageListPane.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/message-list/MessageListPane.tsx src/features/message-list/MessageListPane.test.tsx
git commit -m "feat(labels): label-view flat message list with banner"
```

---

### Task 10: Multi-select + selection toolbar

**Files:**
- Modify: `src/features/message-list/MessageListPane.tsx`
- Modify: `src/features/message-list/MessageListPane.css`
- Modify: `src/features/message-list/MessageListPane.test.tsx`

**Interfaces:**
- Consumes: store `selectionActive`, `selectedMessageIds`, `toggleSelectionMode`, `toggleMessageSelected`, `clearSelection`, `openLabelPicker`.
- Behavior: multi-select is available only in flat (message) modes. A "Select" toggle in the list header enters/leaves the mode; each flat row shows a checkbox; a selection toolbar shows the count, a "Label" button (`openLabelPicker(selectedMessageIds)`), and "Cancel" (`clearSelection`).

- [ ] **Step 1: Write the failing test**

Append to `src/features/message-list/MessageListPane.test.tsx`:

```tsx
it("selects rows and opens the picker with selected ids", () => {
  useUiStore.setState({
    selectedFolderId: null,
    selectedSmartFolder: "unread",
    selectedLabelId: null,
    searchActive: false,
    searchQuery: "",
    selectionActive: false,
    selectedMessageIds: [],
  });
  const { getByLabelText, getByText } = renderPane();
  fireEvent.click(getByText("Select"));
  expect(useUiStore.getState().selectionActive).toBe(true);
  fireEvent.click(getByLabelText("Select message"));
  expect(useUiStore.getState().selectedMessageIds.length).toBe(1);
  fireEvent.click(getByText("Label"));
  expect(useUiStore.getState().labelPickerOpen).toBe(true);
});
```

(Ensure the suite's `useSmartFolder` mock for `"unread"` returns at least one `SmartMessageRow`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/message-list/MessageListPane.test.tsx`
Expected: FAIL — no "Select" button.

- [ ] **Step 3: Implement multi-select**

In `src/features/message-list/MessageListPane.tsx`:

Add store selectors:

```tsx
  const selectionActive = useUiStore((s) => s.selectionActive);
  const selectedMessageIds = useUiStore((s) => s.selectedMessageIds);
  const toggleSelectionMode = useUiStore((s) => s.toggleSelectionMode);
  const toggleMessageSelected = useUiStore((s) => s.toggleMessageSelected);
  const clearSelection = useUiStore((s) => s.clearSelection);
  const openLabelPicker = useUiStore((s) => s.openLabelPicker);
```

Extend `SmartRow` props with `selectable: boolean`, `selected: boolean`, `onToggleSelect: (id: number) => void`, and render a checkbox at the start of `message-row__indicators`:

```tsx
        {selectable && (
          <input
            type="checkbox"
            aria-label="Select message"
            checked={selected}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleSelect(row.message_id)}
          />
        )}
```

Add a "Select" toggle to the list header (next to the `message-list__sort` span), shown only in flat modes:

```tsx
        {isFlatMode && (
          <button
            type="button"
            className="message-list__select-toggle"
            onClick={() => toggleSelectionMode()}
          >
            {selectionActive ? "Done" : "Select"}
          </button>
        )}
```

Add the selection toolbar after the banners:

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
          <button type="button" onClick={() => clearSelection()}>
            Cancel
          </button>
        </div>
      )}
```

Pass the new props in the flat-mode `SmartRow` render:

```tsx
                      selectable={selectionActive}
                      selected={selectedMessageIds.includes(row.message_id)}
                      onToggleSelect={toggleMessageSelected}
```

Add to `src/features/message-list/MessageListPane.css`:

```css
.message-list__selection-bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
  font-size: 13px;
}

.message-list__selection-bar button {
  border: 1px solid var(--border-subtle);
  background: transparent;
  border-radius: var(--radius-sm);
  padding: 2px 10px;
  cursor: pointer;
  font-size: 13px;
  color: inherit;
}

.message-list__selection-bar button:disabled {
  opacity: 0.5;
  cursor: default;
}

.message-list__select-toggle {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  color: var(--accent);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/message-list/MessageListPane.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/message-list/MessageListPane.tsx src/features/message-list/MessageListPane.css src/features/message-list/MessageListPane.test.tsx
git commit -m "feat(labels): list multi-select + selection toolbar"
```

---

### Task 11: Reader integration (chips + Tag button)

**Files:**
- Modify: `src/features/reader/ConversationView.tsx`
- Modify: `src/features/reader/ConversationView.test.tsx` (create if absent)

**Interfaces:**
- Consumes: store `openLabelPicker`; `useLabelsForMessages` (Task 5); `LabelChips` (Task 6); `Tag` lucide icon (already in stub from Task 7).
- Behavior: a `Tag` button in the toolbar opens the picker for the thread's last message; chips for the last message render in the subject row.

- [ ] **Step 1: Write the failing test**

`src/features/reader/ConversationView.test.tsx` (if the file exists, append the `it` block and extend mocks):

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConversationView } from "./ConversationView";
import { useUiStore } from "../../app/store";

vi.mock("../../ipc/queries", () => ({
  useThreadMessages: () => ({
    data: [{ id: 5, from_address: "a@b.com", from_name: "A", subject: "Hi", date: 1000, flagged: false }],
    isLoading: false,
  }),
  useStartReply: () => ({ mutateAsync: vi.fn() }),
  useSetFlag: () => ({ mutate: vi.fn() }),
  useLabelsForMessages: () => ({ data: [[5, { id: 1, name: "Work", color: "#4f46e5" }]] }),
}));

describe("ConversationView labels", () => {
  beforeEach(() => {
    useUiStore.setState({ labelPickerOpen: false, labelPickerTargetIds: [] });
  });

  it("shows chips and opens picker for the last message", () => {
    const qc = new QueryClient();
    const { getByText, getByLabelText } = render(
      <QueryClientProvider client={qc}>
        <ConversationView threadId={1} />
      </QueryClientProvider>
    );
    expect(getByText("Work")).toBeTruthy();
    fireEvent.click(getByLabelText("Label"));
    expect(useUiStore.getState().labelPickerOpen).toBe(true);
    expect(useUiStore.getState().labelPickerTargetIds).toEqual([5]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/reader/ConversationView.test.tsx`
Expected: FAIL — no "Label" button / no chips.

- [ ] **Step 3: Implement reader integration**

In `src/features/reader/ConversationView.tsx`:

Add to the lucide import: `Tag`. Add imports:

```tsx
import { useLabelsForMessages } from "../../ipc/queries";
import { LabelChips } from "../labels/LabelChips";
```

Add store selector and hook (after the existing `setFlag`):

```tsx
  const openLabelPicker = useUiStore((s) => s.openLabelPicker);
```

After `const last = messages[messages.length - 1];`, add:

```tsx
  const labelPairs = useLabelsForMessages([last.id]);
  const lastLabels = (labelPairs.data ?? []).map(([, label]) => label);
```

Add a `Tag` button to the toolbar (before the `reader__spacer`):

```tsx
        <button
          type="button"
          className="reader__icon"
          aria-label="Label"
          onClick={() => openLabelPicker([last.id])}
        >
          <Tag size={18} />
        </button>
```

Render chips under the subject row (after the closing `</div>` of `reader__subject-row`):

```tsx
          {lastLabels.length > 0 && (
            <div className="reader__labels">
              <LabelChips labels={lastLabels} />
            </div>
          )}
```

Add to `src/features/reader/reader.css`:

```css
.reader__labels {
  margin: 4px 0 8px;
}
```

NOTE: `useLabelsForMessages([last.id])` is called after the early returns for loading/empty — this keeps hook order stable because `last` only exists past those returns; if your reviewer flags conditional hooks, move the `useLabelsForMessages` call above the early returns and guard with `messages?.length` by passing `lastId ? [lastId] : []`.

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/reader/ConversationView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/reader/ConversationView.tsx src/features/reader/ConversationView.test.tsx src/features/reader/reader.css
git commit -m "feat(labels): reader chips + Tag button opens picker"
```

---

### Task 12: Shortcut + command palette wiring + Settings Labels section

**Files:**
- Modify: `src/features/shortcuts/registry.ts` (enable `label`)
- Modify: `src/features/shortcuts/ShortcutsProvider.tsx` (add `label` handler)
- Modify: `src/features/shortcuts/CommandPalette.tsx` (add "Label" item)
- Modify: `src/features/shortcuts/registry.test.ts`
- Create + Test: `src/features/settings/LabelsSection.tsx`, `src/features/settings/LabelsSection.test.tsx`
- Modify: `src/features/settings/SettingsOverlay.tsx` (route a `labels` section)

**Interfaces:**
- Consumes: store `openLabelPicker`, `replyTargetId`, `selectionActive`, `selectedMessageIds`; `useLabels`, `useCreateLabel`, `useRenameLabel`, `useSetLabelColor`, `useDeleteLabel`; `LABEL_COLORS`, `nextLabelColor`.

- [ ] **Step 1: Enable the `label` action + test**

In `src/features/shortcuts/registry.ts`, change the `label` descriptor:

```ts
  { id: "label", label: "Label", contexts: ["reader", "list"], defaultBinding: "l", enabled: true },
```

In `src/features/shortcuts/registry.test.ts`, add:

```ts
it("label action is enabled and bound to l", () => {
  const a = actionById("label");
  expect(a?.enabled).toBe(true);
  expect(a?.defaultBinding).toBe("l");
});
```

- [ ] **Step 2: Add the handler**

In `src/features/shortcuts/ShortcutsProvider.tsx`, add a `label` entry to the `handlers` map:

```tsx
      label: () => {
        const s = useUiStore.getState();
        if (s.selectionActive && s.selectedMessageIds.length > 0) {
          s.openLabelPicker(s.selectedMessageIds);
        } else if (s.replyTargetId != null) {
          s.openLabelPicker([s.replyTargetId]);
        }
      },
```

- [ ] **Step 3: Add the palette item**

In `src/features/shortcuts/CommandPalette.tsx`, add to `paletteActions`:

```tsx
    label: () => {
      const s = useUiStore.getState();
      if (s.selectionActive && s.selectedMessageIds.length > 0) s.openLabelPicker(s.selectedMessageIds);
      else if (s.replyTargetId != null) s.openLabelPicker([s.replyTargetId]);
    },
```

(`label` is in `["reader","list"]` contexts and now enabled, so the existing `visibleActions` filter — `a.enabled && paletteActions[a.id]` — will include it automatically.)

- [ ] **Step 4: Write the failing Settings Labels test**

`src/features/settings/LabelsSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LabelsSection } from "./LabelsSection";
import { commands } from "../../ipc/bindings";

vi.mock("../../ipc/bindings", () => ({
  commands: {
    listLabels: vi.fn().mockResolvedValue({ status: "ok", data: [{ id: 1, name: "Work", color: "#4f46e5" }] }),
    createLabel: vi.fn().mockResolvedValue({ status: "ok", data: { id: 2, name: "New", color: "#10b981" } }),
    renameLabel: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    setLabelColor: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    deleteLabel: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("LabelsSection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists labels and creates a new one", async () => {
    const { getByText, getByLabelText } = wrap(<LabelsSection />);
    await waitFor(() => expect(getByText("Work")).toBeTruthy());
    fireEvent.change(getByLabelText("New label name"), { target: { value: "Urgent" } });
    fireEvent.click(getByText("Add label"));
    await waitFor(() => expect(commands.createLabel).toHaveBeenCalled());
  });

  it("deletes a label", async () => {
    const { getByText, getByLabelText } = wrap(<LabelsSection />);
    await waitFor(() => expect(getByText("Work")).toBeTruthy());
    fireEvent.click(getByLabelText("Delete label Work"));
    await waitFor(() => expect(commands.deleteLabel).toHaveBeenCalledWith(1));
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/shortcuts/registry.test.ts src/features/settings/LabelsSection.test.tsx`
Expected: FAIL — `LabelsSection` not found; registry test passes only after Step 1.

- [ ] **Step 6: Implement LabelsSection**

`src/features/settings/LabelsSection.tsx`:

```tsx
import { useState } from "react";
import { Trash2 } from "lucide-react";
import {
  useLabels,
  useCreateLabel,
  useRenameLabel,
  useSetLabelColor,
  useDeleteLabel,
} from "../../ipc/queries";
import { LABEL_COLORS, nextLabelColor } from "../../shared/labels/labels";

export function LabelsSection() {
  const { data: labels = [] } = useLabels();
  const createLabel = useCreateLabel();
  const renameLabel = useRenameLabel();
  const setLabelColor = useSetLabelColor();
  const deleteLabel = useDeleteLabel();
  const [newName, setNewName] = useState("");

  function add() {
    const name = newName.trim();
    if (!name) return;
    const color = nextLabelColor(labels.map((l) => l.color));
    createLabel.mutate({ name, color });
    setNewName("");
  }

  return (
    <div className="settings-section">
      <ul className="labels-settings__list">
        {labels.map((label) => (
          <li key={label.id} className="labels-settings__row">
            <select
              aria-label={`Color for ${label.name}`}
              value={label.color}
              onChange={(e) => setLabelColor.mutate({ id: label.id, color: e.target.value })}
            >
              {LABEL_COLORS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input
              type="text"
              aria-label={`Rename ${label.name}`}
              defaultValue={label.name}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== label.name) renameLabel.mutate({ id: label.id, name: v });
              }}
            />
            <button
              type="button"
              aria-label={`Delete label ${label.name}`}
              onClick={() => deleteLabel.mutate(label.id)}
            >
              <Trash2 size={15} />
            </button>
          </li>
        ))}
      </ul>
      <div className="labels-settings__add">
        <input
          type="text"
          aria-label="New label name"
          placeholder="New label name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button type="button" onClick={add}>
          Add label
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Route the Settings section**

In `src/features/settings/SettingsOverlay.tsx`:

Add `"labels"` to the `SettingsSection` union, add it to `NAV` (after `appearance`):

```ts
  | "labels"
```

```ts
  { id: "labels", label: "Labels" },
```

Import and render:

```tsx
import { LabelsSection } from "./LabelsSection";
```

```tsx
          {active === "appearance" ? (
            <AppearanceSection />
          ) : active === "labels" ? (
            <LabelsSection />
          ) : active === "shortcuts" ? (
            <ShortcutsSection />
          ) : (
            <div className="settings-placeholder">Coming soon</div>
          )}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/shortcuts/registry.test.ts src/features/settings/LabelsSection.test.tsx`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/features/shortcuts/registry.ts src/features/shortcuts/ShortcutsProvider.tsx src/features/shortcuts/CommandPalette.tsx src/features/shortcuts/registry.test.ts src/features/settings/LabelsSection.tsx src/features/settings/LabelsSection.test.tsx src/features/settings/SettingsOverlay.tsx
git commit -m "feat(labels): label shortcut, palette item, and Settings Labels section"
```

---

### Task 13: Full verification + docs

**Files:**
- Modify: `docs/superpowers/specs/2026-06-19-etap6d-labels-design.md` (append an "Implementation notes (as built)" section if anything deviated)

- [ ] **Step 1: Full Rust suite**

Run: `cargo test --workspace`
Expected: PASS (existing 224 + new labels tests). The 4 GreenMail Docker integration tests require Docker; if unavailable, note it and run `cargo test --workspace --exclude <integration>` only if the repo already gates them.

- [ ] **Step 2: Full frontend suite**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run`
Expected: PASS, no OOM (confirms lucide stub covers `Tag`/`Plus`/`Check`).

- [ ] **Step 3: Type-check + build**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm run build`
Expected: tsc + vite build clean.

- [ ] **Step 4: Record as-built notes**

If implementation deviated from the spec (e.g., multi-select scoped to flat modes only), append a short "Implementation notes (as built)" section to the design spec documenting it. Multi-select is **not** available in thread/folder mode — labelling threads happens via the reader; document this as accepted MVP scope.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-06-19-etap6d-labels-design.md
git commit -m "docs(labels): record as-built notes for etap 6d"
```

---

## Self-Review

**Spec coverage:**
- Migration V8 global tables → Task 1. ✓
- `am-core::Label` → Task 1. ✓
- `labels_repo` CRUD → Task 1; associations (`set_message_labels`, `labels_for_messages`, `list_messages_by_label`) → Task 2. ✓
- `am-app` commands + bindings → Task 3. ✓
- Store slice (selectedLabelId mutual-exclusion + multi-select + picker state) → Task 4. ✓
- queries hooks → Task 5. ✓
- LabelChips + chips in list → Task 6; chips in reader → Task 11. ✓
- LabelPicker (type-to-create + toggle) → Task 7. ✓
- Rail Labels section → Task 8. ✓
- Label-view flat list + banner → Task 9. ✓
- Multi-select + selection toolbar → Task 10. ✓
- Settings → Labels CRUD → Task 12. ✓
- Shortcut `l` + palette item → Task 12. ✓
- Color palette → Task 4. ✓
- Test-infra (lucide `Tag`/`Plus`/`Check`) → Task 7. ✓
- Deferred (no IMAP sync) → honored throughout; thread-mode multi-select scoping documented in Task 13. ✓

**Type consistency:** Command names match between Rust (`list_labels`→`listLabels`, etc.), bindings, and hook calls. `labels_for_messages` returns `Vec<(i64, Label)>` → bindings `[number, Label][]` → consumed as `[number, Label][]` in `useLabelsForMessages`, `LabelPicker`, `ConversationView`, and `MessageListPane`. Store field/action names (`selectedLabelId`, `selectionActive`, `selectedMessageIds`, `openLabelPicker`, etc.) are used identically across Tasks 4/8/9/10/11/12.

**Placeholder scan:** No TBD/TODO; every code step has complete code. ConversationView conditional-hook caveat is called out explicitly in Task 11.
