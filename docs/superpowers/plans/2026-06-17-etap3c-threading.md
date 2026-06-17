# Etap 3C — Threading & Conversation UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Depends on plans 3A (threading header columns, snippet back-fill) and 3B (incremental sync, flag commands, live events).

**Goal:** Group messages into conversations by Message-ID/References with a normalized-subject fallback, and present the list as one row per thread with a conversation view in the reader.

**Architecture:** Pure threading logic lives in `am-core` (deterministic, unit-tested). `am-sync` runs an `assign_threads` pass after each insert that links messages and maintains the `threads` table. The list queries `threads` via `messages` for the selected folder; the reader fetches a thread's messages and renders them as a collapsible conversation reusing the existing sanitize + `sandbox=""` rendering.

**Tech Stack:** Rust (rusqlite, am-core/am-storage/am-sync), Tauri 2 + tauri-specta, React 19 + @tanstack/react-query + @tanstack/react-virtual.

## Global Constraints

- Node >= 24 (`$HOME/.nvm/versions/node/v24.14.0/bin`) for frontend/tooling steps.
- English-only identifiers/constants/DB strings. No code comments.
- Conventional Commits; no `Co-Authored-By`; never `git push` unless asked.
- Threading must be deterministic and not depend on insertion order.
- Mail HTML still rendered only via the sanitizer + `sandbox=""` iframe.
- `cargo test --workspace` and `npm test` green.

---

### Task 1: Threading core (pure functions)

**Files:**
- Create: `crates/am-core/src/threading.rs`
- Modify: `crates/am-core/src/lib.rs` (add `pub mod threading;`)

**Interfaces:**
- Produces:
```rust
pub fn normalize_subject(subject: &str) -> String;          // strips reply/forward prefixes, trims, lowercases
pub fn parse_reference_ids(in_reply_to: Option<&str>, references_hdr: Option<&str>) -> Vec<String>;
```

- [ ] **Step 1: Write failing tests in `crates/am-core/src/threading.rs`**

```rust
#[cfg(test)]
mod tests {
    use super::{normalize_subject, parse_reference_ids};

    #[test]
    fn strips_single_reply_prefix() {
        assert_eq!(normalize_subject("Re: Hello"), "hello");
    }

    #[test]
    fn strips_repeated_and_mixed_prefixes() {
        assert_eq!(normalize_subject("Re: Fwd: RE: Project"), "project");
        assert_eq!(normalize_subject("FW: AW: Update"), "update");
    }

    #[test]
    fn keeps_plain_subject() {
        assert_eq!(normalize_subject("  Quarterly Report "), "quarterly report");
    }

    #[test]
    fn empty_after_strip_is_empty() {
        assert_eq!(normalize_subject("Re: "), "");
    }

    #[test]
    fn reference_ids_merge_in_reply_to_and_references() {
        let ids = parse_reference_ids(Some("<a@x>"), Some("<b@y> <c@z>"));
        assert_eq!(ids, vec!["<b@y>".to_string(), "<c@z>".to_string(), "<a@x>".to_string()]);
    }

    #[test]
    fn reference_ids_dedupe() {
        let ids = parse_reference_ids(Some("<a@x>"), Some("<a@x> <b@y>"));
        assert_eq!(ids, vec!["<a@x>".to_string(), "<b@y>".to_string()]);
    }

    #[test]
    fn reference_ids_empty() {
        assert!(parse_reference_ids(None, None).is_empty());
    }
}
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cargo test -p am-core threading`
Expected: FAIL (functions not found).

- [ ] **Step 3: Implement**

```rust
const PREFIXES: &[&str] = &["re", "fwd", "fw", "aw", "wg", "sv", "vs", "antw"];

pub fn normalize_subject(subject: &str) -> String {
    let mut current = subject.trim();
    loop {
        let lower = current.to_ascii_lowercase();
        let mut stripped = false;
        for prefix in PREFIXES {
            let with_colon = format!("{prefix}:");
            if lower.starts_with(&with_colon) {
                current = current[with_colon.len()..].trim_start();
                stripped = true;
                break;
            }
        }
        if !stripped {
            break;
        }
    }
    current.trim().to_ascii_lowercase()
}

pub fn parse_reference_ids(in_reply_to: Option<&str>, references_hdr: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(refs) = references_hdr {
        for token in refs.split_whitespace() {
            if token.starts_with('<') && token.ends_with('>') && !out.contains(&token.to_string()) {
                out.push(token.to_string());
            }
        }
    }
    if let Some(irt) = in_reply_to {
        let t = irt.trim();
        if t.starts_with('<') && t.ends_with('>') && !out.contains(&t.to_string()) {
            out.push(t.to_string());
        }
    }
    out
}
```

Add `pub mod threading;` to `crates/am-core/src/lib.rs`.

- [ ] **Step 4: Run — expect PASS**

Run: `cargo test -p am-core threading`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add crates/am-core/src/threading.rs crates/am-core/src/lib.rs
git commit -m "feat(core): threading subject normalization and reference parsing"
```

---

### Task 2: Thread assignment during sync

**Files:**
- Create: `crates/am-storage/src/threads_repo.rs`
- Modify: `crates/am-storage/src/lib.rs` (export `threads_repo`)
- Modify: `crates/am-storage/src/messages_repo.rs` (`list_unthreaded`, `assign_thread`)
- Modify: `crates/am-sync/src/service.rs` (`assign_threads`, call it after inserts)

**Interfaces:**
- Produces (messages_repo):
```rust
pub struct ThreadingRow { pub id: i64, pub message_id_hdr: Option<String>, pub in_reply_to: Option<String>,
                          pub references_hdr: Option<String>, pub subject: String, pub date: i64 }
pub fn list_unthreaded(db, account_id: i64) -> Result<Vec<ThreadingRow>, StorageError>;
pub fn assign_thread(db, message_id: i64, thread_id: i64) -> Result<(), StorageError>;
```
- Produces (threads_repo):
```rust
pub fn find_by_message_ids(db, account_id: i64, ids: &[String]) -> Result<Option<i64>, StorageError>;
pub fn find_by_subject_root(db, account_id: i64, subject_root: &str) -> Result<Option<i64>, StorageError>;
pub fn create(db, account_id: i64, subject_root: &str, last_date: i64) -> Result<i64, StorageError>;
pub fn recompute(db, thread_id: i64) -> Result<(), StorageError>;   // last_date, message_count, unread_count, subject_root from latest
```
- Produces (service): `assign_threads(db, account_id: i64) -> Result<(), SyncError>`

- [ ] **Step 1: Add `list_unthreaded` + `assign_thread` to `messages_repo.rs` with tests**

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadingRow {
    pub id: i64,
    pub message_id_hdr: Option<String>,
    pub in_reply_to: Option<String>,
    pub references_hdr: Option<String>,
    pub subject: String,
    pub date: i64,
}

pub fn list_unthreaded(db: &Database, account_id: i64) -> Result<Vec<ThreadingRow>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, message_id_hdr, in_reply_to, references_hdr, subject, date
         FROM messages WHERE account_id = ?1 AND thread_id IS NULL ORDER BY date ASC",
    )?;
    let rows = stmt.query_map(params![account_id], |row| {
        Ok(ThreadingRow {
            id: row.get(0)?, message_id_hdr: row.get(1)?, in_reply_to: row.get(2)?,
            references_hdr: row.get(3)?, subject: row.get(4)?, date: row.get(5)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

pub fn assign_thread(db: &Database, message_id: i64, thread_id: i64) -> Result<(), StorageError> {
    let conn = db.conn();
    let changed = conn.execute(
        "UPDATE messages SET thread_id = ?2 WHERE id = ?1",
        params![message_id, thread_id],
    )?;
    if changed == 0 { return Err(StorageError::NotFound); }
    Ok(())
}
```

Test:

```rust
#[test]
fn list_unthreaded_then_assign() {
    let db = Database::open_in_memory().unwrap();
    let folder_id = setup(&db);
    insert_headers(&db, folder_id, &[make_header(1, 100)]).unwrap();
    let account_id = get_header(&db, list_by_folder(&db, folder_id, 1, 0).unwrap()[0].id).unwrap().account_id;
    let unthreaded = list_unthreaded(&db, account_id).unwrap();
    assert_eq!(unthreaded.len(), 1);
    // create a thread row directly for the FK, then assign
    let conn_thread_id = {
        let conn = db.conn();
        conn.execute("INSERT INTO threads (account_id, subject_root, last_date) VALUES (?1, 's', 100)", params![account_id]).unwrap();
        conn.last_insert_rowid()
    };
    assign_thread(&db, unthreaded[0].id, conn_thread_id).unwrap();
    assert!(list_unthreaded(&db, account_id).unwrap().is_empty());
}
```

- [ ] **Step 2: Create `threads_repo.rs`**

```rust
use rusqlite::params;
use crate::db::{Database, StorageError};

pub fn find_by_message_ids(db: &Database, account_id: i64, ids: &[String]) -> Result<Option<i64>, StorageError> {
    if ids.is_empty() {
        return Ok(None);
    }
    let conn = db.conn();
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT thread_id FROM messages
         WHERE account_id = ? AND thread_id IS NOT NULL AND message_id_hdr IN ({placeholders})
         ORDER BY date DESC LIMIT 1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut bind: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(ids.len() + 1);
    bind.push(&account_id);
    for id in ids { bind.push(id); }
    let result = stmt.query_row(bind.as_slice(), |row| row.get::<_, i64>(0));
    match result {
        Ok(id) => Ok(Some(id)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(StorageError::Sqlite(e)),
    }
}

pub fn find_by_subject_root(db: &Database, account_id: i64, subject_root: &str) -> Result<Option<i64>, StorageError> {
    if subject_root.is_empty() {
        return Ok(None);
    }
    let conn = db.conn();
    let result = conn.query_row(
        "SELECT id FROM threads WHERE account_id = ?1 AND subject_root = ?2 ORDER BY last_date DESC LIMIT 1",
        params![account_id, subject_root],
        |row| row.get::<_, i64>(0),
    );
    match result {
        Ok(id) => Ok(Some(id)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(StorageError::Sqlite(e)),
    }
}

pub fn create(db: &Database, account_id: i64, subject_root: &str, last_date: i64) -> Result<i64, StorageError> {
    let conn = db.conn();
    conn.execute(
        "INSERT INTO threads (account_id, subject_root, last_date) VALUES (?1, ?2, ?3)",
        params![account_id, subject_root, last_date],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn recompute(db: &Database, thread_id: i64) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute(
        "UPDATE threads SET
            last_date = COALESCE((SELECT MAX(date) FROM messages WHERE thread_id = ?1), last_date),
            message_count = (SELECT count(*) FROM messages WHERE thread_id = ?1),
            unread_count = (SELECT count(*) FROM messages WHERE thread_id = ?1 AND seen = 0)
         WHERE id = ?1",
        params![thread_id],
    )?;
    Ok(())
}
```

Add `pub mod threads_repo;` to `crates/am-storage/src/lib.rs`.

- [ ] **Step 3: Run storage tests — expect PASS**

Run: `cargo test -p am-storage`
Expected: PASS.

- [ ] **Step 4: Implement `assign_threads` in `am-sync/src/service.rs`**

```rust
use am_core::threading::{normalize_subject, parse_reference_ids};
use am_storage::threads_repo;

pub fn assign_threads(db: &Database, account_id: i64) -> Result<(), SyncError> {
    let pending = messages_repo::list_unthreaded(db, account_id)?;
    let mut touched: std::collections::HashSet<i64> = std::collections::HashSet::new();

    for row in pending {
        let ids = parse_reference_ids(row.in_reply_to.as_deref(), row.references_hdr.as_deref());
        let subject_root = normalize_subject(&row.subject);

        let thread_id = if let Some(existing) = threads_repo::find_by_message_ids(db, account_id, &ids)? {
            existing
        } else if let Some(existing) = threads_repo::find_by_subject_root(db, account_id, &subject_root)? {
            existing
        } else {
            threads_repo::create(db, account_id, &subject_root, row.date)?
        };

        messages_repo::assign_thread(db, row.id, thread_id)?;
        touched.insert(thread_id);
    }

    for thread_id in touched {
        threads_repo::recompute(db, thread_id)?;
    }
    Ok(())
}
```

- [ ] **Step 5: Call `assign_threads` after every insert path**

In `sync_folder` (3A) and `incremental_sync_folder` (3B), after the `insert_headers(...)` calls, add:

```rust
    assign_threads(db, account_id)?;
```

(Place it before the `recount_unread`/`set_counts` calls so thread counts reflect the new state.)

- [ ] **Step 6: Build + run sync tests — expect PASS**

Run: `cargo test -p am-sync`
Expected: PASS (unit; GreenMail self-skips). With Docker, seeded replies group under one thread.

- [ ] **Step 7: Commit**

```bash
git add crates/am-storage/src/threads_repo.rs crates/am-storage/src/messages_repo.rs crates/am-storage/src/lib.rs crates/am-sync/src/service.rs
git commit -m "feat(sync): assign messages to threads during sync"
```

---

### Task 3: Thread list queries + commands

**Files:**
- Create: `crates/am-core/src/thread.rs` (`ThreadSummary`)
- Modify: `crates/am-core/src/lib.rs` (`pub mod thread;`)
- Modify: `crates/am-storage/src/threads_repo.rs` (`list_for_folder`)
- Modify: `crates/am-storage/src/messages_repo.rs` (`list_by_thread`)
- Modify: `crates/am-app/src/commands.rs` (`list_threads`, `list_thread_messages`)
- Modify: `crates/am-app/src/lib.rs` (register commands)

**Interfaces:**
- Produces:
```rust
// am-core
pub struct ThreadSummary {
    pub thread_id: i64, pub account_id: i64, pub subject: String,
    pub last_date: i64, pub message_count: i64, pub unread_count: i64,
    pub participants: Vec<String>, pub snippet: String,
    pub has_attachments: bool, pub flagged: bool,
}
// threads_repo
pub fn list_for_folder(db, folder_id: i64, limit: i64, offset: i64) -> Result<Vec<ThreadSummary>, StorageError>;
// messages_repo
pub fn list_by_thread(db, thread_id: i64) -> Result<Vec<MessageHeader>, StorageError>;
// commands
list_threads(folder_id, limit, offset) -> Result<Vec<ThreadSummary>, String>
list_thread_messages(thread_id) -> Result<Vec<MessageHeader>, String>
```

- [ ] **Step 1: Define `ThreadSummary` in `crates/am-core/src/thread.rs`**

```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct ThreadSummary {
    pub thread_id: i64,
    pub account_id: i64,
    pub subject: String,
    pub last_date: i64,
    pub message_count: i64,
    pub unread_count: i64,
    pub participants: Vec<String>,
    pub snippet: String,
    pub has_attachments: bool,
    pub flagged: bool,
}
```

Add `pub mod thread;` to `crates/am-core/src/lib.rs`.

- [ ] **Step 2: Implement `list_for_folder` in `threads_repo.rs`**

```rust
use am_core::thread::ThreadSummary;

pub fn list_for_folder(db: &Database, folder_id: i64, limit: i64, offset: i64) -> Result<Vec<ThreadSummary>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT t.id, t.account_id, t.subject_root, t.last_date, t.message_count, t.unread_count,
                MAX(m.has_attachments), MAX(m.flagged),
                group_concat(DISTINCT COALESCE(m.from_name, m.from_address)),
                (SELECT snippet FROM messages WHERE thread_id = t.id ORDER BY date DESC LIMIT 1),
                (SELECT subject FROM messages WHERE thread_id = t.id ORDER BY date DESC LIMIT 1)
         FROM threads t
         JOIN messages m ON m.thread_id = t.id
         WHERE t.id IN (SELECT DISTINCT thread_id FROM messages WHERE folder_id = ?1 AND thread_id IS NOT NULL)
         GROUP BY t.id
         ORDER BY t.last_date DESC
         LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![folder_id, limit, offset], |row| {
        let participants_csv: Option<String> = row.get(8)?;
        let latest_subject: Option<String> = row.get(10)?;
        let subject_root: String = row.get(2)?;
        Ok(ThreadSummary {
            thread_id: row.get(0)?,
            account_id: row.get(1)?,
            subject: latest_subject.filter(|s| !s.is_empty()).unwrap_or(subject_root),
            last_date: row.get(3)?,
            message_count: row.get(4)?,
            unread_count: row.get(5)?,
            participants: participants_csv
                .map(|s| s.split(',').map(|p| p.to_string()).collect())
                .unwrap_or_default(),
            snippet: row.get::<_, Option<String>>(9)?.unwrap_or_default(),
            has_attachments: row.get::<_, i64>(6)? != 0,
            flagged: row.get::<_, i64>(7)? != 0,
        })
    })?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}
```

- [ ] **Step 3: Implement `list_by_thread` in `messages_repo.rs`**

```rust
pub fn list_by_thread(db: &Database, thread_id: i64) -> Result<Vec<MessageHeader>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, account_id, folder_id, subject, from_address, from_name, date, seen, flagged, has_attachments, snippet
         FROM messages WHERE thread_id = ?1 ORDER BY date ASC",
    )?;
    let rows = stmt.query_map(params![thread_id], row_to_header)?;
    let mut out = Vec::new();
    for r in rows { out.push(tuple_to_header(r?)); }
    Ok(out)
}
```

- [ ] **Step 4: Write a repo test covering grouping**

Add to `threads_repo.rs` tests: insert one account/folder, two messages with the same `subject_root` thread (assign both to one thread via `create` + `messages_repo::assign_thread`), `recompute`, then assert `list_for_folder` returns one summary with `message_count == 2` and the latest snippet.

```rust
#[test]
fn list_for_folder_groups_thread() {
    let db = Database::open_in_memory().unwrap();
    let account = crate::accounts_repo::insert_account(&db, &am_core::account::NewAccount {
        email: "t@e.com".into(), display_name: "T".into(),
        provider_type: am_core::account::ProviderType::ImapPassword, color: None,
    }).unwrap();
    let folder = crate::folders_repo::upsert_folder(&db, account.id, "INBOX", "Inbox", am_core::folder::FolderType::Inbox).unwrap();
    crate::messages_repo::insert_headers(&db, folder.id, &[
        am_core::message::NewMessageHeader { uid: 1, message_id_hdr: Some("<a@x>".into()), in_reply_to: None, references_hdr: None,
            from_address: "x@e.com".into(), from_name: Some("X".into()), subject: "Hi".into(), date: 100,
            seen: true, flagged: false, has_attachments: false, size: 0, snippet: "first".into() },
        am_core::message::NewMessageHeader { uid: 2, message_id_hdr: Some("<b@x>".into()), in_reply_to: Some("<a@x>".into()), references_hdr: Some("<a@x>".into()),
            from_address: "y@e.com".into(), from_name: Some("Y".into()), subject: "Re: Hi".into(), date: 200,
            seen: false, flagged: true, has_attachments: false, size: 0, snippet: "second".into() },
    ]).unwrap();
    let tid = create(&db, account.id, "hi", 100).unwrap();
    for h in crate::messages_repo::list_by_folder(&db, folder.id, 10, 0).unwrap() {
        crate::messages_repo::assign_thread(&db, h.id, tid).unwrap();
    }
    recompute(&db, tid).unwrap();
    let summaries = list_for_folder(&db, folder.id, 10, 0).unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].message_count, 2);
    assert_eq!(summaries[0].unread_count, 1);
    assert_eq!(summaries[0].snippet, "second");
    assert!(summaries[0].flagged);
}
```

- [ ] **Step 5: Add the commands in `commands.rs` and register them**

```rust
use am_core::thread::ThreadSummary;

#[tauri::command]
#[specta::specta]
pub fn list_threads(
    state: tauri::State<'_, AppState>,
    folder_id: i64,
    limit: i64,
    offset: i64,
) -> Result<Vec<ThreadSummary>, String> {
    am_storage::threads_repo::list_for_folder(&state.db, folder_id, limit, offset).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn list_thread_messages(
    state: tauri::State<'_, AppState>,
    thread_id: i64,
) -> Result<Vec<MessageHeader>, String> {
    messages_repo::list_by_thread(&state.db, thread_id).map_err(|e| e.to_string())
}
```

Register `commands::list_threads, commands::list_thread_messages` in `collect_commands!` in `lib.rs`.

- [ ] **Step 6: Build, regenerate bindings, test**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
cargo test -p am-core -p am-storage -p am-app
npm run gen:bindings
```
Expected: PASS; bindings now expose `listThreads`, `listThreadMessages`, and the `ThreadSummary` type.

- [ ] **Step 7: Commit**

```bash
git add crates/am-core/src/thread.rs crates/am-core/src/lib.rs crates/am-storage/src/threads_repo.rs crates/am-storage/src/messages_repo.rs crates/am-app/src/commands.rs crates/am-app/src/lib.rs src/ipc/bindings.ts
git commit -m "feat(app): thread list and thread-messages queries and commands"
```

---

### Task 4: Thread-grouped list + conversation reader

**Files:**
- Modify: `src/app/store.ts` (`selectedThreadId`)
- Modify: `src/ipc/queries.ts` (`useThreads`, `useThreadMessages`)
- Modify: `src/features/message-list/MessageListPane.tsx` (render threads)
- Create: `src/features/reader/ConversationView.tsx`
- Modify: `src/features/reader/ReaderPane.tsx` (delegate to conversation)
- Modify: `src/features/message-list/MessageListPane.test.tsx` (thread rows)
- Create: `src/features/reader/ConversationView.test.tsx`

**Interfaces:**
- Consumes: generated `commands.listThreads`, `commands.listThreadMessages`, type `ThreadSummary`, plus `useMessageBody`, `useMarkSeen`, `useSetFlag` (3B).

- [ ] **Step 1: Add `selectedThreadId` to the store**

In `store.ts` add to the state type and initial value:

```ts
  selectedThreadId: number | null;
  setSelectedThreadId: (id: number | null) => void;
```

```ts
  selectedThreadId: null,
  setSelectedThreadId: (id) => set({ selectedThreadId: id }),
```

- [ ] **Step 2: Add `useThreads` / `useThreadMessages` to `queries.ts`**

```ts
export function useThreads(folderId: number | null) {
  return useQuery({
    queryKey: ["threads", folderId],
    queryFn: () => commands.listThreads(folderId!, 100, 0).then(unwrap),
    enabled: folderId != null,
  });
}

export function useThreadMessages(threadId: number | null) {
  return useQuery({
    queryKey: ["thread-messages", threadId],
    queryFn: () => commands.listThreadMessages(threadId!).then(unwrap),
    enabled: threadId != null,
  });
}
```

Also update `events.ts` `mailboxChanged`/`syncProgress`/`newMessages` handlers to additionally invalidate `["threads"]` (broad invalidation is fine — list is small):

```ts
      queryClient.invalidateQueries({ queryKey: ["threads"] });
```

- [ ] **Step 3: Render threads in `MessageListPane.tsx`**

Switch the data source from `useMessages` to `useThreads(selectedFolderId)`. Each row now renders a `ThreadSummary`:

```tsx
import { useThreads, useSetFlag } from "../../ipc/queries";
import type { ThreadSummary } from "../../ipc/bindings";

  const { data: threads, isLoading } = useThreads(selectedFolderId);
  const selectedThreadId = useUiStore((s) => s.selectedThreadId);
  const setSelectedThreadId = useUiStore((s) => s.setSelectedThreadId);
  const setFlag = useSetFlag();
```

Rewrite `MessageRow` as `ThreadRow` showing `thread.participants.join(", ")`, `thread.subject`, `thread.snippet`, `formatDate(thread.last_date)`, an unread dot when `thread.unread_count > 0`, the message-count badge when `thread.message_count > 1`, and the flag button (reusing 3B's `onToggleFlag` pattern but targeting the thread's latest message is out of scope — keep the flag button driven by `thread.flagged` and toggle via the conversation view instead; in this list show `thread.flagged` as a static glyph). Selecting a row calls `setSelectedThreadId(thread.thread_id)`. Virtualizer `count` becomes `threads?.length ?? 0`.

- [ ] **Step 4: Create `ConversationView.tsx`**

```tsx
import { useState } from "react";
import { useThreadMessages } from "../../ipc/queries";
import type { MessageHeader } from "../../ipc/bindings";
import { MessageBodyView } from "./MessageBodyView";

export function ConversationView({ threadId }: { threadId: number }) {
  const { data: messages, isLoading } = useThreadMessages(threadId);

  if (isLoading) return <p className="loading-state">Loading…</p>;
  if (!messages || messages.length === 0) return <p className="empty-state">No messages</p>;

  return (
    <div className="conversation" aria-label="conversation">
      {messages.map((m, i) => (
        <ConversationItem key={m.id} message={m} defaultExpanded={i === messages.length - 1} />
      ))}
    </div>
  );
}

function ConversationItem({ message, defaultExpanded }: { message: MessageHeader; defaultExpanded: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <article className={`conversation-item${expanded ? " conversation-item--open" : ""}`}>
      <header className="conversation-item__head" onClick={() => setExpanded((v) => !v)}>
        <span className="conversation-item__sender">{message.from_name || message.from_address}</span>
        <span className="conversation-item__subject">{message.subject}</span>
      </header>
      {expanded && <MessageBodyView messageId={message.id} />}
    </article>
  );
}
```

Extract the body-rendering logic currently in `ReaderPane.tsx` (sanitize → `SafeHtmlFrame`, plain-text `<pre>`, remote-content banner, auto-seen on expand) into a new `src/features/reader/MessageBodyView.tsx` component taking `{ messageId: number }`. It calls `useMessageBody(messageId)`, runs the `["sanitized", messageId]` query, and fires `useMarkSeen().mutate(messageId)` in a `useEffect` keyed on `messageId`. This is the auto-seen point (a message is seen when its body is shown).

- [ ] **Step 5: Reduce `ReaderPane.tsx` to delegate to the conversation**

```tsx
import { useUiStore } from "../../app/store";
import { ConversationView } from "./ConversationView";
import "./reader.css";

export function ReaderPane() {
  const selectedThreadId = useUiStore((s) => s.selectedThreadId);

  if (selectedThreadId == null) {
    return (
      <section className="pane reader-pane" aria-label="reader">
        <p className="empty-state">Select a conversation to read</p>
      </section>
    );
  }

  return (
    <section className="pane reader-pane" aria-label="reader">
      <ConversationView threadId={selectedThreadId} />
    </section>
  );
}
```

- [ ] **Step 6: Update tests**

In `MessageListPane.test.tsx`, mock `commands.listThreads` to return one `ThreadSummary` and assert the participants/subject render and that clicking a row calls `setSelectedThreadId`. Create `ConversationView.test.tsx` mocking `commands.listThreadMessages` to return two headers and asserting both senders render and the last item is expanded (its `MessageBodyView` mounts — mock `getMessageBody`/`sanitizeMessageHtml`). Follow the existing happy-dom + mocked-`./bindings` patterns in `ReaderPane.test.tsx` and `MessageListPane.test.tsx`.

```tsx
// ConversationView.test.tsx — shape
vi.mock("../../ipc/bindings", () => ({
  commands: {
    listThreadMessages: vi.fn().mockResolvedValue({ status: "ok", data: [
      { id: 1, account_id: 1, folder_id: 1, subject: "Hi", from_address: "a@x", from_name: "A", date: 1, seen: true, flagged: false, has_attachments: false, snippet: "" },
      { id: 2, account_id: 1, folder_id: 1, subject: "Re: Hi", from_address: "b@y", from_name: "B", date: 2, seen: false, flagged: false, has_attachments: false, snippet: "" },
    ]}),
    getMessageBody: vi.fn().mockResolvedValue({ status: "ok", data: { message_id: 2, text_plain: "body", text_html: null } }),
    markMessageSeen: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
  events: {},
}));
```

- [ ] **Step 7: Run frontend tests + typecheck/build**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npm test
npm run build
```
Expected: PASS; build (`tsc && vite build`) clean.

- [ ] **Step 8: Commit**

```bash
git add src/app/store.ts src/ipc/queries.ts src/ipc/events.ts src/features/message-list src/features/reader
git commit -m "feat(ui): thread-grouped list and conversation reader"
```

---

## Self-Review

- **Spec coverage:** threading by Message-ID/References + subject fallback (Tasks 1–2), incremental thread maintenance during sync (Task 2 Step 5), `threads`-via-`messages` folder query with no N+1 in the main scan (Task 3, correlated subqueries bounded by page size and indexed by `idx_messages_thread`), thread-grouped list + conversation view in the reader (Task 4). Auto-seen is realized at body-display time in `MessageBodyView` (Task 4 Step 4), consistent with 3B's "opening/expanding a message marks it seen".
- **Placeholder scan:** concrete code/tests/commands throughout; no TBD/TODO.
- **Type consistency:** `ThreadSummary` (am-core, Task 3) is produced by `threads_repo::list_for_folder` and the `list_threads` command and consumed by `useThreads`/`ThreadRow` (Task 4). `ThreadingRow` (Task 2) is produced by `messages_repo::list_unthreaded` and consumed by `assign_threads`. `normalize_subject`/`parse_reference_ids` (Task 1) are consumed only in `assign_threads` (Task 2). `selectedThreadId` (Task 4 Step 1) is consumed by `MessageListPane` and `ReaderPane`. `NewMessageHeader` literals in Task 3's test include the 3A fields `in_reply_to`/`references_hdr`.
