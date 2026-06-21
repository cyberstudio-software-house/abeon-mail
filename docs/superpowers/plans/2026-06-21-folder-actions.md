# Folder Context-Menu Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dodać do menu kontekstowego folderu akcje: oznacz jako przeczytane, zmień nazwę, usuń, nowy podfolder.

**Architecture:** Hybryda — `mark-as-read` przez `sync_queue` (optymistyczna zmiana DB + enqueue + drain robi bulk IMAP, jak `set_flag`); `rename`/`delete`/`create-subfolder` przez komendy `async` „na żywo" (połączenie IMAP → operacja → `discover_folders()` rekoncyliuje). Pozycje menu filtrowane wg typu folderu.

**Tech Stack:** Rust (am-protocols/async-imap, am-sync, am-storage/rusqlite, am-app/Tauri+specta), React 19 + TS, @tanstack/react-query v5, zustand, vitest + @testing-library/react (happy-dom; lucide-react stubowany w testach).

## Global Constraints

- Brak komentarzy w kodzie; identyfikatory po angielsku.
- Commity: Conventional Commits 1.0.0; bez co-authora; bez `push`.
- Trwałość mark-read przez `sync_queue`; struktura folderów „na żywo" + `discover_folders`. Bez nowych migracji DB.
- Polityka pozycji menu per typ: inbox = mark-read + new-subfolder; custom = wszystkie 5; sent/drafts/trash/spam/archive = mark-read + pin. Rename/delete tylko custom. Pusta lista → menu się nie otwiera.
- Delete zawsze przez ConfirmDialog; błędy operacji „na żywo" pokazywane w toaście (bez cichego połykania).
- Rust testy: `cargo test -p <crate>`. Frontend: `npx vitest run <path>`, typy: `npx tsc --noEmit`.

---

### Task 1: Storage helpers (messages_repo)

**Files:**
- Modify: `crates/am-storage/src/messages_repo.rs` (add 3 fns + tests in existing `#[cfg(test)] mod tests`)

**Interfaces:**
- Produces:
  - `mark_folder_seen(db: &Database, folder_id: i64) -> Result<usize, StorageError>`
  - `thread_ids_in_folder(db: &Database, folder_id: i64) -> Result<Vec<i64>, StorageError>`
  - `delete_by_folder(db: &Database, folder_id: i64) -> Result<usize, StorageError>`

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `crates/am-storage/src/messages_repo.rs` (uses the existing `make_header`/`setup`/`insert_account` helpers in that module):

```rust
    #[test]
    fn mark_folder_seen_clears_unread_and_reports_count() {
        let db = Database::open_in_memory().unwrap();
        let folder = setup(&db);
        insert_headers(&db, folder, &[make_header(1, 1000), make_header(2, 2000)]).unwrap();
        assert_eq!(crate::folders_repo::recount_unread(&db, folder).unwrap(), 2);

        let changed = mark_folder_seen(&db, folder).unwrap();
        assert_eq!(changed, 2);
        assert_eq!(crate::folders_repo::recount_unread(&db, folder).unwrap(), 0);
    }

    #[test]
    fn thread_ids_in_folder_returns_distinct_non_null() {
        let db = Database::open_in_memory().unwrap();
        let folder = setup(&db);
        insert_headers(&db, folder, &[make_header(1, 1000), make_header(2, 2000)]).unwrap();
        let ids = ids_by_uids(&db, folder, &[1, 2]).unwrap();
        db.conn().execute("UPDATE messages SET thread_id = 7 WHERE id IN (?1, ?2)", params![ids[0], ids[1]]).unwrap();

        let threads = thread_ids_in_folder(&db, folder).unwrap();
        assert_eq!(threads, vec![7]);
    }

    #[test]
    fn delete_by_folder_removes_all_rows() {
        let db = Database::open_in_memory().unwrap();
        let folder = setup(&db);
        insert_headers(&db, folder, &[make_header(1, 1000), make_header(2, 2000)]).unwrap();
        let removed = delete_by_folder(&db, folder).unwrap();
        assert_eq!(removed, 2);
        assert_eq!(count_by_folder(&db, folder).unwrap(), 0);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p am-storage messages_repo 2>&1 | tail -20`
Expected: FAIL — `cannot find function mark_folder_seen` / `thread_ids_in_folder` / `delete_by_folder`.

- [ ] **Step 3: Write minimal implementation**

Add these three functions to `crates/am-storage/src/messages_repo.rs` (near `set_flag` / `count_by_folder`):

```rust
pub fn mark_folder_seen(db: &Database, folder_id: i64) -> Result<usize, StorageError> {
    let conn = db.conn();
    Ok(conn.execute(
        "UPDATE messages SET seen = 1 WHERE folder_id = ?1 AND seen = 0 AND deleted = 0 AND draft = 0",
        params![folder_id],
    )?)
}

pub fn thread_ids_in_folder(db: &Database, folder_id: i64) -> Result<Vec<i64>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT DISTINCT thread_id FROM messages WHERE folder_id = ?1 AND thread_id IS NOT NULL",
    )?;
    let rows = stmt.query_map(params![folder_id], |row| row.get::<_, i64>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn delete_by_folder(db: &Database, folder_id: i64) -> Result<usize, StorageError> {
    let conn = db.conn();
    Ok(conn.execute("DELETE FROM messages WHERE folder_id = ?1", params![folder_id])?)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p am-storage messages_repo 2>&1 | tail -20`
Expected: PASS (3 new tests + existing).

- [ ] **Step 5: Commit**

```bash
git add crates/am-storage/src/messages_repo.rs
git commit -m "feat(storage): folder-wide seen, thread-id, and delete helpers"
```

---

### Task 2: Folder path helpers (am-sync)

**Files:**
- Modify: `crates/am-sync/src/service.rs` (add 2 pure fns + a `#[cfg(test)] mod path_tests`)

**Interfaces:**
- Produces:
  - `pub fn rename_path(remote_path: &str, delimiter: &str, new_name: &str) -> String`
  - `pub fn child_path(parent_path: &str, delimiter: &str, name: &str) -> String`

- [ ] **Step 1: Write the failing test**

Add a new test module at the end of `crates/am-sync/src/service.rs`:

```rust
#[cfg(test)]
mod path_tests {
    use super::{child_path, rename_path};

    #[test]
    fn rename_path_replaces_last_segment() {
        assert_eq!(rename_path("Clients/Work", "/", "Job"), "Clients/Job");
        assert_eq!(rename_path("Work", "/", "Job"), "Job");
        assert_eq!(rename_path("A.B.C", ".", "D"), "A.B.D");
    }

    #[test]
    fn child_path_appends_with_delimiter() {
        assert_eq!(child_path("Clients", "/", "Work"), "Clients/Work");
        assert_eq!(child_path("INBOX", ".", "Sub"), "INBOX.Sub");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p am-sync path_tests 2>&1 | tail -20`
Expected: FAIL — `cannot find function rename_path` / `child_path`.

- [ ] **Step 3: Write minimal implementation**

Add to `crates/am-sync/src/service.rs` (module level, near other helpers):

```rust
pub fn rename_path(remote_path: &str, delimiter: &str, new_name: &str) -> String {
    match remote_path.rfind(delimiter) {
        Some(idx) => format!("{}{}", &remote_path[..idx + delimiter.len()], new_name),
        None => new_name.to_string(),
    }
}

pub fn child_path(parent_path: &str, delimiter: &str, name: &str) -> String {
    format!("{parent_path}{delimiter}{name}")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p am-sync path_tests 2>&1 | tail -20`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/am-sync/src/service.rs
git commit -m "feat(sync): folder rename/child path helpers"
```

---

### Task 3: enqueue_mark_folder_read (am-sync)

**Files:**
- Modify: `crates/am-sync/src/service.rs` (add `enqueue_mark_folder_read`; add a test in the existing thread-recompute test module)

**Interfaces:**
- Consumes: `messages_repo::mark_folder_seen`, `messages_repo::thread_ids_in_folder` (Task 1).
- Produces: `pub fn enqueue_mark_folder_read(db: &Database, folder_id: i64) -> Result<(), SyncError>`

The `"mark_folder_read"` drain arm that consumes this op is added in Task 4 (alongside the `ImapSession::mark_all_seen` method it needs), so this task compiles and tests independently.

- [ ] **Step 1: Write the failing test**

Add to the test module in `crates/am-sync/src/service.rs` that already has `seed`/`header`/`assign_threads` (the one containing `enqueue_flag_recomputes_thread_unread_count`):

```rust
    #[test]
    fn enqueue_mark_folder_read_clears_unread_and_enqueues() {
        let db = Database::open_in_memory().unwrap();
        let (acc, folder) = seed(&db);
        messages_repo::insert_headers(&db, folder, &[
            header(1, "a@b.com", "hi"),
            header(2, "c@d.com", "yo"),
        ]).unwrap();
        assign_threads(&db, acc).unwrap();
        folders_repo::set_sync_markers(&db, folder, 100, 3, None, 0).unwrap();

        enqueue_mark_folder_read(&db, folder).unwrap();

        assert_eq!(folders_repo::recount_unread(&db, folder).unwrap(), 0);
        for t in threads_repo::list_for_folder(&db, folder, 50, 0, i64::MAX).unwrap() {
            assert_eq!(t.unread_count, 0);
        }
        let due = queue_repo::list_due(&db, acc, i64::MAX).unwrap();
        assert!(due.iter().any(|op| op.op_type == "mark_folder_read"));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p am-sync enqueue_mark_folder_read 2>&1 | tail -20`
Expected: FAIL — `cannot find function enqueue_mark_folder_read`.

- [ ] **Step 3: Write minimal implementation**

Add to `crates/am-sync/src/service.rs` (near `enqueue_flag`):

```rust
pub fn enqueue_mark_folder_read(db: &Database, folder_id: i64) -> Result<(), SyncError> {
    let folder = folders_repo::get_folder(db, folder_id)?;
    let markers = folders_repo::get_sync_markers(db, folder_id)?;
    let uidvalidity = markers.uidvalidity.unwrap_or(0);

    messages_repo::mark_folder_seen(db, folder_id)?;
    folders_repo::recount_unread(db, folder_id)?;
    for thread_id in messages_repo::thread_ids_in_folder(db, folder_id)? {
        threads_repo::recompute(db, thread_id)?;
    }

    let payload = serde_json::json!({
        "folder_id": folder_id,
        "uidvalidity": uidvalidity,
    })
    .to_string();
    queue_repo::enqueue(db, folder.account_id, "mark_folder_read", &payload)?;
    Ok(())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p am-sync enqueue_mark_folder_read 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/am-sync/src/service.rs
git commit -m "feat(sync): enqueue mark-folder-read with optimistic recompute"
```

---

### Task 4: IMAP client methods + RemoteFolder delimiter + mark-folder-read drain arm

**Files:**
- Modify: `crates/am-protocols/src/imap.rs` (add 3 methods; add `delimiter` to `RemoteFolder`; set it in `map_folder`; update any other `RemoteFolder` literal)
- Modify: `crates/am-sync/src/service.rs` (add the `"mark_folder_read"` arm in `drain_queue`)

**Interfaces:**
- Consumes: the `"mark_folder_read"` queue op produced by `enqueue_mark_folder_read` (Task 3).
- Produces (on `ImapSession`):
  - `pub async fn rename_folder(&mut self, old_path: &str, new_path: &str) -> Result<(), ProtocolError>`
  - `pub async fn delete_folder(&mut self, path: &str) -> Result<(), ProtocolError>`
  - `pub async fn mark_all_seen(&mut self) -> Result<(), ProtocolError>`
  - `RemoteFolder` gains `pub delimiter: String`
  - `drain_queue` handles `op_type == "mark_folder_read"`

- [ ] **Step 1: Add `delimiter` to RemoteFolder and populate it**

In `crates/am-protocols/src/imap.rs`, change the `RemoteFolder` struct to:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteFolder {
    pub remote_path: String,
    pub name: String,
    pub special_use: Option<String>,
    pub delimiter: String,
}
```

In `map_folder`, set the field (the `delimiter` local already exists):

```rust
    RemoteFolder {
        remote_path,
        name: leaf,
        special_use,
        delimiter: delimiter.to_string(),
    }
```

- [ ] **Step 2: Add the three session methods**

Add to the `impl ImapSession` block in `crates/am-protocols/src/imap.rs` (near `store_flag` / `create_folder`):

```rust
    pub async fn rename_folder(&mut self, old_path: &str, new_path: &str) -> Result<(), ProtocolError> {
        match &mut self.session {
            SessionStream::Plain(s) => s.rename(old_path, new_path).await?,
            SessionStream::Tls(s) => s.rename(old_path, new_path).await?,
        }
        Ok(())
    }

    pub async fn delete_folder(&mut self, path: &str) -> Result<(), ProtocolError> {
        match &mut self.session {
            SessionStream::Plain(s) => s.delete(path).await?,
            SessionStream::Tls(s) => s.delete(path).await?,
        }
        Ok(())
    }

    pub async fn mark_all_seen(&mut self) -> Result<(), ProtocolError> {
        let _: Vec<Fetch> = match &mut self.session {
            SessionStream::Plain(s) => s.uid_store("1:*", "+FLAGS.SILENT (\\Seen)").await?.try_collect().await?,
            SessionStream::Tls(s) => s.uid_store("1:*", "+FLAGS.SILENT (\\Seen)").await?.try_collect().await?,
        };
        Ok(())
    }
```

- [ ] **Step 3: Add the mark-folder-read drain arm**

In `drain_queue` (`crates/am-sync/src/service.rs`), inside the `for op in due` loop, immediately AFTER the `if op.op_type == "move_message" { ... continue; }` block and BEFORE `if op.op_type != "set_flag" { continue; }`, insert:

```rust
        if op.op_type == "mark_folder_read" {
            let parsed: serde_json::Value = match serde_json::from_str(&op.payload) {
                Ok(v) => v,
                Err(_) => { queue_repo::mark_done(db, op.id)?; continue; }
            };
            let folder_id = parsed["folder_id"].as_i64().unwrap_or(0);
            let folder = match folders_repo::get_folder(db, folder_id) {
                Ok(f) => f,
                Err(_) => { queue_repo::mark_done(db, op.id)?; continue; }
            };
            if selected.as_deref() != Some(folder.remote_path.as_str()) {
                if session.select(&folder.remote_path).await.is_err() {
                    let backoff = now + 2i64.pow((op.attempts + 1).min(5) as u32) * 30;
                    if op.attempts + 1 >= MAX_QUEUE_ATTEMPTS {
                        queue_repo::mark_done(db, op.id)?;
                    } else {
                        queue_repo::mark_retry(db, op.id, backoff, None)?;
                    }
                    continue;
                }
                selected = Some(folder.remote_path.clone());
            }
            match session.mark_all_seen().await {
                Ok(()) => queue_repo::mark_done(db, op.id)?,
                Err(_) if op.attempts + 1 >= MAX_QUEUE_ATTEMPTS => queue_repo::mark_done(db, op.id)?,
                Err(_) => {
                    let backoff = now + 2i64.pow((op.attempts + 1).min(5) as u32) * 30;
                    queue_repo::mark_retry(db, op.id, backoff, None)?;
                }
            }
            continue;
        }
```

- [ ] **Step 4: Build the crates (catches all RemoteFolder literals)**

Run: `cargo build -p am-protocols 2>&1 | tail -30`
Expected: may FAIL with "missing field `delimiter`" at other `RemoteFolder { ... }` construction sites (e.g. in tests). Add `delimiter: "/".to_string()` to each such literal until it compiles.

Then build the sync crate (drain arm now resolves `mark_all_seen`) and run tests:

Run: `cargo test -p am-protocols 2>&1 | tail -20`
Expected: PASS (existing tests green).

Run: `cargo test -p am-sync 2>&1 | tail -20`
Expected: builds clean; PASS (includes Task 3's `enqueue_mark_folder_read` test).

- [ ] **Step 5: Commit**

```bash
git add crates/am-protocols/src/imap.rs crates/am-sync/src/service.rs
git commit -m "feat(imap): rename/delete folder, bulk mark-seen, delimiter; drain mark-folder-read"
```

---

### Task 5: Live folder service functions (am-sync)

**Files:**
- Modify: `crates/am-sync/src/service.rs` (add 3 async fns)

**Interfaces:**
- Consumes: `rename_path`, `child_path` (Task 2); `ImapSession::{rename_folder, delete_folder}` + `RemoteFolder.delimiter` (Task 4); `messages_repo::delete_by_folder` (Task 1); existing `discover_folders`, `accounts_repo::get_account`, `load_endpoints`, `imap_config`, `auth.to_imap()`.
- Produces:
  - `pub async fn rename_folder(db: &Database, folder_id: i64, new_name: &str, creds: &dyn CredentialSource) -> Result<(), SyncError>`
  - `pub async fn delete_folder(db: &Database, folder_id: i64, creds: &dyn CredentialSource) -> Result<(), SyncError>`
  - `pub async fn create_subfolder(db: &Database, parent_folder_id: i64, name: &str, creds: &dyn CredentialSource) -> Result<(), SyncError>`

- [ ] **Step 1: Implement the three functions**

Add to `crates/am-sync/src/service.rs` (near `discover_folders`):

```rust
pub async fn rename_folder(
    db: &Database,
    folder_id: i64,
    new_name: &str,
    creds: &dyn CredentialSource,
) -> Result<(), SyncError> {
    let folder = folders_repo::get_folder(db, folder_id)?;
    let account = accounts_repo::get_account(db, folder.account_id)?;
    let endpoints = load_endpoints(db, folder.account_id)?;
    let auth = creds.auth_for(&account).await?;
    let config = imap_config(&endpoints, &account.email);
    let mut session = ImapSession::connect(&config, &auth.to_imap()).await?;
    let folders = session.list_folders().await?;
    let delimiter = folders
        .first()
        .map(|f| f.delimiter.clone())
        .unwrap_or_else(|| "/".to_string());
    let new_path = rename_path(&folder.remote_path, &delimiter, new_name);
    session.rename_folder(&folder.remote_path, &new_path).await?;
    session.logout().await?;
    discover_folders(db, folder.account_id, creds).await?;
    Ok(())
}

pub async fn delete_folder(
    db: &Database,
    folder_id: i64,
    creds: &dyn CredentialSource,
) -> Result<(), SyncError> {
    let folder = folders_repo::get_folder(db, folder_id)?;
    let account = accounts_repo::get_account(db, folder.account_id)?;
    let endpoints = load_endpoints(db, folder.account_id)?;
    let auth = creds.auth_for(&account).await?;
    let config = imap_config(&endpoints, &account.email);
    let mut session = ImapSession::connect(&config, &auth.to_imap()).await?;
    session.delete_folder(&folder.remote_path).await?;
    session.logout().await?;
    messages_repo::delete_by_folder(db, folder_id)?;
    folders_repo::delete_folder(db, folder_id)?;
    discover_folders(db, folder.account_id, creds).await?;
    Ok(())
}

pub async fn create_subfolder(
    db: &Database,
    parent_folder_id: i64,
    name: &str,
    creds: &dyn CredentialSource,
) -> Result<(), SyncError> {
    let parent = folders_repo::get_folder(db, parent_folder_id)?;
    let account = accounts_repo::get_account(db, parent.account_id)?;
    let endpoints = load_endpoints(db, parent.account_id)?;
    let auth = creds.auth_for(&account).await?;
    let config = imap_config(&endpoints, &account.email);
    let mut session = ImapSession::connect(&config, &auth.to_imap()).await?;
    let folders = session.list_folders().await?;
    let delimiter = folders
        .first()
        .map(|f| f.delimiter.clone())
        .unwrap_or_else(|| "/".to_string());
    let path = child_path(&parent.remote_path, &delimiter, name);
    session.create_folder(&path).await?;
    session.logout().await?;
    discover_folders(db, parent.account_id, creds).await?;
    Ok(())
}
```

- [ ] **Step 2: Build + existing tests**

Run: `cargo build -p am-sync 2>&1 | tail -30`
Expected: builds clean.

Run: `cargo test -p am-sync 2>&1 | tail -20`
Expected: PASS (existing suite + Tasks 2/3 tests). Note: live IMAP behavior of these three fns is exercised via manual verification / the GreenMail e2e harness, not unit tests (they require a server).

- [ ] **Step 3: Commit**

```bash
git add crates/am-sync/src/service.rs
git commit -m "feat(sync): live rename/delete/create-subfolder with rediscovery"
```

---

### Task 6: Tauri commands + registration + bindings

**Files:**
- Modify: `crates/am-app/src/commands.rs` (4 commands)
- Modify: `crates/am-app/src/lib.rs` (register 4 commands)
- Modify: `src/ipc/bindings.ts` (regenerated, do not hand-edit)

**Interfaces:**
- Consumes: `am_sync::service::{enqueue_mark_folder_read, rename_folder, delete_folder, create_subfolder}` (Tasks 3, 5).
- Produces (TS bindings after regen): `commands.markFolderRead(folderId)`, `commands.renameFolder(folderId, newName)`, `commands.deleteFolder(folderId)`, `commands.createSubfolder(parentFolderId, name)`.

- [ ] **Step 1: Add the four commands**

Add to `crates/am-app/src/commands.rs` (near `set_message_flags` / `archive_messages`):

```rust
#[tauri::command]
#[specta::specta]
pub fn mark_folder_read(state: tauri::State<'_, AppState>, folder_id: i64) -> Result<(), String> {
    am_sync::service::enqueue_mark_folder_read(&state.db, folder_id)
        .map_err(|_| "Failed to mark folder read".to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn rename_folder(
    state: tauri::State<'_, AppState>,
    folder_id: i64,
    new_name: String,
) -> Result<(), String> {
    let db = Arc::clone(&state.db);
    let creds = Arc::clone(&state.creds);
    am_sync::service::rename_folder(&db, folder_id, &new_name, creds.as_ref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_folder(state: tauri::State<'_, AppState>, folder_id: i64) -> Result<(), String> {
    let db = Arc::clone(&state.db);
    let creds = Arc::clone(&state.creds);
    am_sync::service::delete_folder(&db, folder_id, creds.as_ref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn create_subfolder(
    state: tauri::State<'_, AppState>,
    parent_folder_id: i64,
    name: String,
) -> Result<(), String> {
    let db = Arc::clone(&state.db);
    let creds = Arc::clone(&state.creds);
    am_sync::service::create_subfolder(&db, parent_folder_id, &name, creds.as_ref())
        .await
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register the commands**

In `crates/am-app/src/lib.rs`, inside `collect_commands![ ... ]`, add after `commands::list_folders,`:

```rust
    commands::mark_folder_read,
    commands::rename_folder,
    commands::delete_folder,
    commands::create_subfolder,
```

- [ ] **Step 3: Build**

Run: `cargo build -p abeonmail 2>&1 | tail -30`
Expected: builds clean.

- [ ] **Step 4: Regenerate TS bindings**

Run: `npm run gen:bindings`
Expected: `src/ipc/bindings.ts` updated. Verify the four entries exist:

Run: `grep -nE "markFolderRead|renameFolder|deleteFolder|createSubfolder" src/ipc/bindings.ts`
Expected: 4 matches.

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add crates/am-app/src/commands.rs crates/am-app/src/lib.rs src/ipc/bindings.ts
git commit -m "feat(app): folder action commands and bindings"
```

---

### Task 7: Dialog components (TextInputDialog + ConfirmDialog)

**Files:**
- Create: `src/features/mailbox/RailDialogs.tsx`
- Create: `src/features/mailbox/RailDialogs.css`
- Test: `src/features/mailbox/RailDialogs.test.tsx`

**Interfaces:**
- Produces:
  - `TextInputDialog(props: { title: string; initialValue?: string; placeholder?: string; confirmLabel?: string; onConfirm: (value: string) => void; onCancel: () => void })`
  - `ConfirmDialog(props: { title: string; message: string; confirmLabel?: string; onConfirm: () => void; onCancel: () => void })`

- [ ] **Step 1: Write the failing test**

Create `src/features/mailbox/RailDialogs.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TextInputDialog, ConfirmDialog } from "./RailDialogs";

describe("RailDialogs", () => {
  afterEach(() => cleanup());

  it("TextInputDialog confirms the typed value on Enter", () => {
    const onConfirm = vi.fn();
    render(<TextInputDialog title="Nowy podfolder" onConfirm={onConfirm} onCancel={vi.fn()} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Projekty" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith("Projekty");
  });

  it("TextInputDialog prefills initialValue and cancels on Escape", () => {
    const onCancel = vi.fn();
    render(<TextInputDialog title="Zmień nazwę" initialValue="Stara" onConfirm={vi.fn()} onCancel={onCancel} />);
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Stara");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("TextInputDialog does not confirm an empty value", () => {
    const onConfirm = vi.fn();
    render(<TextInputDialog title="Nowy podfolder" onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("ConfirmDialog fires onConfirm when the confirm button is clicked", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog title="Usuń folder" message="Na pewno?" confirmLabel="Usuń" onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Usuń" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/mailbox/RailDialogs.test.tsx`
Expected: FAIL — `Failed to resolve import "./RailDialogs"`.

- [ ] **Step 3: Write implementation**

Create `src/features/mailbox/RailDialogs.tsx`:

```tsx
import { useState } from "react";

export function TextInputDialog({
  title,
  initialValue = "",
  placeholder,
  confirmLabel = "OK",
  onConfirm,
  onCancel,
}: {
  title: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const trimmed = value.trim();

  function confirm() {
    if (trimmed.length === 0) return;
    onConfirm(trimmed);
  }

  return (
    <div className="rail-dialog-overlay" role="presentation" onClick={onCancel}>
      <div className="rail-dialog" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="rail-dialog__title">{title}</div>
        <input
          className="rail-dialog__input"
          autoFocus
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") confirm();
            if (e.key === "Escape") onCancel();
          }}
        />
        <div className="rail-dialog__actions">
          <button type="button" className="rail-dialog__btn" onClick={onCancel}>
            Anuluj
          </button>
          <button
            type="button"
            className="rail-dialog__btn rail-dialog__btn--primary"
            disabled={trimmed.length === 0}
            onClick={confirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "OK",
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="rail-dialog-overlay" role="presentation" onClick={onCancel}>
      <div className="rail-dialog" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="rail-dialog__title">{title}</div>
        <div className="rail-dialog__message">{message}</div>
        <div className="rail-dialog__actions">
          <button type="button" className="rail-dialog__btn" onClick={onCancel}>
            Anuluj
          </button>
          <button type="button" className="rail-dialog__btn rail-dialog__btn--danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Create `src/features/mailbox/RailDialogs.css`:

```css
.rail-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 240;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 14vh;
  background: rgba(0, 0, 0, 0.4);
}
.rail-dialog {
  width: 340px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
  padding: var(--space-4);
}
.rail-dialog__title {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: var(--space-3);
}
.rail-dialog__message {
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: var(--space-4);
}
.rail-dialog__input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  font-size: 14px;
  background: transparent;
  color: inherit;
}
.rail-dialog__input:focus {
  outline: none;
  border-color: var(--accent);
}
.rail-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
.rail-dialog__btn {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  padding: 6px 12px;
  cursor: pointer;
}
.rail-dialog__btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.rail-dialog__btn--primary:disabled {
  opacity: 0.5;
  cursor: default;
}
.rail-dialog__btn--danger {
  background: var(--color-amber-500, #dc2626);
  border-color: var(--color-amber-500, #dc2626);
  color: #fff;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/mailbox/RailDialogs.test.tsx`
Expected: PASS (4 tests).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/features/mailbox/RailDialogs.tsx src/features/mailbox/RailDialogs.css src/features/mailbox/RailDialogs.test.tsx
git commit -m "feat(rail): text-input and confirm dialog components"
```

---

### Task 8: React Query hooks for folder actions

**Files:**
- Modify: `src/ipc/queries.ts` (4 hooks)
- Test: `src/ipc/queries.folder-actions.test.tsx`

**Interfaces:**
- Consumes: `commands.markFolderRead`, `commands.renameFolder`, `commands.deleteFolder`, `commands.createSubfolder` (Task 6).
- Produces: `useMarkFolderRead()`, `useRenameFolder()`, `useCreateSubfolder()`, `useDeleteFolder()`.

- [ ] **Step 1: Write the failing test**

Create `src/ipc/queries.folder-actions.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("./bindings", () => ({
  commands: {
    markFolderRead: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    createSubfolder: vi.fn(),
    refreshUnreadBadge: vi.fn(),
  },
  events: {},
}));

import { commands } from "./bindings";
import { useMarkFolderRead, useRenameFolder, useCreateSubfolder } from "./queries";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("folder action hooks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("markFolderRead calls the command with the folder id", async () => {
    vi.mocked(commands.markFolderRead).mockResolvedValue({ status: "ok", data: null });
    const { result } = renderHook(() => useMarkFolderRead(), { wrapper });
    result.current.mutate(7);
    await waitFor(() => expect(commands.markFolderRead).toHaveBeenCalledWith(7));
  });

  it("renameFolder passes folderId and newName", async () => {
    vi.mocked(commands.renameFolder).mockResolvedValue({ status: "ok", data: null });
    const { result } = renderHook(() => useRenameFolder(), { wrapper });
    result.current.mutate({ folderId: 3, newName: "Job" });
    await waitFor(() => expect(commands.renameFolder).toHaveBeenCalledWith(3, "Job"));
  });

  it("createSubfolder passes parentId and name", async () => {
    vi.mocked(commands.createSubfolder).mockResolvedValue({ status: "ok", data: null });
    const { result } = renderHook(() => useCreateSubfolder(), { wrapper });
    result.current.mutate({ parentId: 5, name: "Sub" });
    await waitFor(() => expect(commands.createSubfolder).toHaveBeenCalledWith(5, "Sub"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ipc/queries.folder-actions.test.tsx`
Expected: FAIL — hooks not exported.

- [ ] **Step 3: Write implementation**

Append to `src/ipc/queries.ts`:

```ts
export function useMarkFolderRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (folderId: number) => commands.markFolderRead(folderId).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["smart"] });
      void commands.refreshUnreadBadge(useUiStore.getState().badgeEnabled);
    },
  });
}

export function useRenameFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ folderId, newName }: { folderId: number; newName: string }) =>
      commands.renameFolder(folderId, newName).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}

export function useCreateSubfolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ parentId, name }: { parentId: number; name: string }) =>
      commands.createSubfolder(parentId, name).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}

export function useDeleteFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (folderId: number) => commands.deleteFolder(folderId).then(unwrap),
    onSuccess: (_data, folderId) => {
      if (useUiStore.getState().selectedFolderId === folderId) {
        useUiStore.getState().setSelectedFolderId(null);
      }
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["smart"] });
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ipc/queries.folder-actions.test.tsx`
Expected: PASS (3 tests).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/queries.ts src/ipc/queries.folder-actions.test.tsx
git commit -m "feat(rail): query hooks for folder actions"
```

---

### Task 9: Wire actions + dialogs + error toast into the rail

**Files:**
- Modify: `src/app/store.ts` (add `errorToast` slice)
- Create: `src/features/mailbox/ErrorToast.tsx`
- Create: `src/features/mailbox/ErrorToast.css`
- Modify: `src/features/mailbox/MailboxRail.tsx` (per-type menu builder, dialog state, ErrorToast)
- Test: `src/features/mailbox/MailboxRail.folder-actions.test.tsx`

**Interfaces:**
- Consumes: `useMarkFolderRead`, `useRenameFolder`, `useCreateSubfolder`, `useDeleteFolder` (Task 8); `TextInputDialog`, `ConfirmDialog` (Task 7); existing `useTogglePinnedFolder`, `isFolderPinned`.
- Produces: store `errorToast: string | null`, `showErrorToast(msg)`, `clearErrorToast()`.

- [ ] **Step 1: Add the errorToast store slice**

In `src/app/store.ts`, add to the `UiState` type (near `undoToast`):

```ts
  errorToast: string | null;
  showErrorToast: (message: string) => void;
  clearErrorToast: () => void;
```

Add to the store initializer (near `undoToast: null`):

```ts
  errorToast: null,
  showErrorToast: (message) => set({ errorToast: message }),
  clearErrorToast: () => set({ errorToast: null }),
```

- [ ] **Step 2: Create the ErrorToast component**

Create `src/features/mailbox/ErrorToast.tsx`:

```tsx
import { useUiStore } from "../../app/store";
import "./ErrorToast.css";

export function ErrorToast() {
  const message = useUiStore((s) => s.errorToast);
  const clearErrorToast = useUiStore((s) => s.clearErrorToast);
  if (!message) return null;
  return (
    <div className="error-toast" role="alert">
      <span className="error-toast__text">{message}</span>
      <button type="button" className="error-toast__close" aria-label="Dismiss" onClick={clearErrorToast}>
        ✕
      </button>
    </div>
  );
}
```

Create `src/features/mailbox/ErrorToast.css`:

```css
.error-toast {
  position: fixed;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 260;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 460px;
  padding: 10px 14px;
  background: var(--color-amber-500, #dc2626);
  color: #fff;
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
  font-size: 13px;
}
.error-toast__close {
  border: none;
  background: transparent;
  color: #fff;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
}
```

- [ ] **Step 3: Write the failing rail test**

Create `src/features/mailbox/MailboxRail.folder-actions.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { Account, Folder } from "../../ipc/bindings";

const markFolderRead = vi.fn();
const renameFolder = vi.fn();
const deleteFolder = vi.fn();
const createSubfolder = vi.fn();
const togglePin = vi.fn();

const accounts: Account[] = [
  { id: 1, email: "a1@x.pl", display_name: "Konto A", provider_type: "imap_password", color: null, position: 1, requires_reauth: false },
];

const foldersByAccount = new Map<number, Folder[]>([
  [1, [
    { id: 10, account_id: 1, remote_path: "INBOX", name: "INBOX", folder_type: "inbox", unread_count: 1, total_count: 3 },
    { id: 11, account_id: 1, remote_path: "Klienci", name: "Klienci", folder_type: "custom", unread_count: 0, total_count: 2 },
  ]],
]);

vi.mock("../../ipc/queries", () => ({
  useAccounts: () => ({ data: accounts, isLoading: false }),
  useFolders: () => ({ data: foldersByAccount.get(1) }),
  useLabels: () => ({ data: [] }),
  useAllAccountFolders: () => foldersByAccount,
  usePinnedMap: () => ({ data: new Map<number, number[]>() }),
  useTogglePinnedFolder: () => ({ mutate: togglePin }),
  useMarkFolderRead: () => ({ mutate: markFolderRead }),
  useRenameFolder: () => ({ mutate: renameFolder }),
  useDeleteFolder: () => ({ mutate: deleteFolder }),
  useCreateSubfolder: () => ({ mutate: createSubfolder }),
}));

vi.mock("../../app/store", () => ({ useUiStore: vi.fn() }));

import { useUiStore } from "../../app/store";
import { MailboxRail } from "./MailboxRail";

const mockUseUiStore = vi.mocked(useUiStore);

function setupStore() {
  mockUseUiStore.mockImplementation((selector: (s: any) => unknown) => {
    const state = {
      selectedAccountId: 1,
      selectedFolderId: null,
      selectedSmartFolder: null,
      selectedLabelId: null,
      searchQuery: "",
      errorToast: null,
      setSelectedAccountId: vi.fn(),
      setSelectedFolderId: vi.fn(),
      setSelectedSmartFolder: vi.fn(),
      setSelectedLabelId: vi.fn(),
      openLabelPicker: vi.fn(),
      openSettings: vi.fn(),
      setSearchQuery: vi.fn(),
      clearSearch: vi.fn(),
      setFocusSearch: vi.fn(),
      showErrorToast: vi.fn(),
      clearErrorToast: vi.fn(),
    };
    return selector ? selector(state) : state;
  });
}

describe("MailboxRail folder actions", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows mark-read + new-subfolder for an inbox, no rename/delete", () => {
    setupStore();
    render(<MailboxRail />);
    fireEvent.contextMenu(screen.getAllByText("INBOX")[0]);
    expect(screen.getByRole("menuitem", { name: "Oznacz jako przeczytane" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Nowy podfolder" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Zmień nazwę" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Usuń" })).toBeNull();
  });

  it("marks a custom folder as read from the menu", () => {
    setupStore();
    render(<MailboxRail />);
    fireEvent.contextMenu(screen.getByText("Klienci"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Oznacz jako przeczytane" }));
    expect(markFolderRead).toHaveBeenCalledWith(11);
  });

  it("renames a custom folder through the text dialog", () => {
    setupStore();
    render(<MailboxRail />);
    fireEvent.contextMenu(screen.getByText("Klienci"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Zmień nazwę" }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Klienci VIP" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(renameFolder).toHaveBeenCalledWith({ folderId: 11, newName: "Klienci VIP" });
  });

  it("deletes a custom folder after confirmation", () => {
    setupStore();
    render(<MailboxRail />);
    fireEvent.contextMenu(screen.getByText("Klienci"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Usuń" }));
    fireEvent.click(screen.getByRole("button", { name: "Usuń folder" }));
    expect(deleteFolder).toHaveBeenCalledWith(11);
  });
});
```

- [ ] **Step 4: Run the rail test to verify it fails**

Run: `npx vitest run src/features/mailbox/MailboxRail.folder-actions.test.tsx`
Expected: FAIL — menu items / dialogs not present yet.

- [ ] **Step 5: Implement the rail wiring**

In `src/features/mailbox/MailboxRail.tsx`:

(a) Extend the queries import to add the four hooks:

```ts
import {
  useAccounts,
  useFolders,
  useLabels,
  useAllAccountFolders,
  usePinnedMap,
  useTogglePinnedFolder,
  useMarkFolderRead,
  useRenameFolder,
  useDeleteFolder,
  useCreateSubfolder,
} from "../../ipc/queries";
```

(b) Add imports for the dialogs, error toast, and a ContextMenuItem type:

```ts
import { TextInputDialog, ConfirmDialog } from "./RailDialogs";
import { ErrorToast } from "./ErrorToast";
import type { ContextMenuItem } from "./RailContextMenu";
```

(c) Add `showErrorToast` to the store selectors inside `MailboxRail` (near the other `useUiStore` selectors):

```ts
  const showErrorToast = useUiStore((s) => s.showErrorToast);
```

(d) Add the action hooks and dialog state inside `MailboxRail` (near `togglePin`):

```ts
  const markFolderRead = useMarkFolderRead();
  const renameFolder = useRenameFolder();
  const deleteFolder = useDeleteFolder();
  const createSubfolder = useCreateSubfolder();
  const [dialog, setDialog] = useState<
    { kind: "rename" | "create" | "delete"; folder: Folder } | null
  >(null);
```

(e) Replace the existing `handleFolderContextMenu` with a per-type builder that opens the menu only when there are items:

```tsx
  function buildFolderMenuItems(folder: Folder): ContextMenuItem[] {
    const type = folder.folder_type;
    const items: ContextMenuItem[] = [];
    items.push({
      label: "Oznacz jako przeczytane",
      onClick: () => markFolderRead.mutate(folder.id),
    });
    if (type !== "inbox") {
      const pinned = isFolderPinned(pinnedMap, folder.account_id, folder.id);
      items.push({
        label: pinned ? "Odepnij" : "Przypnij",
        onClick: () => togglePin.mutate({ accountId: folder.account_id, folderId: folder.id }),
      });
    }
    if (type === "inbox" || type === "custom") {
      items.push({ label: "Nowy podfolder", onClick: () => setDialog({ kind: "create", folder }) });
    }
    if (type === "custom") {
      items.push({ label: "Zmień nazwę", onClick: () => setDialog({ kind: "rename", folder }) });
      items.push({ label: "Usuń", onClick: () => setDialog({ kind: "delete", folder }) });
    }
    return items;
  }

  function handleFolderContextMenu(event: React.MouseEvent, folder: Folder) {
    const items = buildFolderMenuItems(folder);
    if (items.length === 0) return;
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, folder });
  }
```

(f) Change the `menu` state type to carry the folder (replace the previous `menu` state declaration):

```tsx
  const [menu, setMenu] = useState<{ x: number; y: number; folder: Folder } | null>(null);
```

(g) Replace the existing `RailContextMenu` render block (before `</aside>`) with one that uses the builder, plus the dialogs and error toast:

```tsx
      {menu && (
        <RailContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={buildFolderMenuItems(menu.folder)}
        />
      )}
      {dialog?.kind === "create" && (
        <TextInputDialog
          title="Nowy podfolder"
          placeholder="Nazwa folderu"
          confirmLabel="Utwórz"
          onCancel={() => setDialog(null)}
          onConfirm={(name) => {
            createSubfolder.mutate(
              { parentId: dialog.folder.id, name },
              { onError: (e) => showErrorToast(String(e)) },
            );
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "rename" && (
        <TextInputDialog
          title="Zmień nazwę folderu"
          initialValue={decodeImapUtf7(dialog.folder.name)}
          confirmLabel="Zmień nazwę"
          onCancel={() => setDialog(null)}
          onConfirm={(newName) => {
            renameFolder.mutate(
              { folderId: dialog.folder.id, newName },
              { onError: (e) => showErrorToast(String(e)) },
            );
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title="Usuń folder"
          message={`Usunąć folder „${decodeImapUtf7(dialog.folder.name)}" wraz z zawartością? Tej operacji nie można cofnąć.`}
          confirmLabel="Usuń folder"
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            deleteFolder.mutate(dialog.folder.id, { onError: (e) => showErrorToast(String(e)) });
            setDialog(null);
          }}
        />
      )}
      <ErrorToast />
```

(h) The previous `handleFolderContextMenu` already-passed into both `FolderTreeNodes` call sites and the pinned rows stays unchanged (same name). Confirm those call sites still compile.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/features/mailbox/MailboxRail.folder-actions.test.tsx`
Expected: PASS (4 tests).

Run: `npx vitest run`
Expected: full suite green except the pre-existing `useDebouncedValue` fake-timer failures (3, unrelated).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/store.ts src/features/mailbox/ErrorToast.tsx src/features/mailbox/ErrorToast.css src/features/mailbox/MailboxRail.tsx src/features/mailbox/MailboxRail.folder-actions.test.tsx
git commit -m "feat(rail): folder actions in context menu with dialogs and error toast"
```

---

## Self-Review Notes

- **Spec coverage:** mark-as-read (T1 helpers, T3 enqueue, T4 mark_all_seen + drain arm, T6 command, T8 hook, T9 menu); rename (T2 path, T4 imap, T5 service, T6 cmd, T8 hook, T9 dialog); delete (T1 delete_by_folder, T4 imap, T5 service, T6 cmd, T8 hook, T9 confirm); create-subfolder (T2 path, T4 delimiter, T5 service, T6 cmd, T8 hook, T9 dialog). Per-type policy (T9 buildFolderMenuItems). Error toast (T9). Inbox-gets-menu change (T9 removes inbox early-return). All covered.
- **Type consistency:** command names markFolderRead/renameFolder/deleteFolder/createSubfolder consistent across T6 bindings, T8 hooks, T9 mocks. Hook arg shapes: rename `{folderId,newName}`, create `{parentId,name}`, delete `folderId`, markRead `folderId` — consistent T8↔T9. `menu` state carries `folder` (T9 f/g). `ContextMenuItem` reused from RailContextMenu (Task 3 of prior feature, already in repo).
- **Known weak spots (honest):** the live IMAP service fns (T5) and the drain arm IMAP call (T3) are not unit-tested (require a server); verified by `cargo build` + existing suites, with live behavior left to manual/GreenMail e2e. Delete of a folder that has subfolders containing local messages may leave orphaned child rows (discover cleanup only removes empty server-absent folders) — acceptable MVP limitation.
