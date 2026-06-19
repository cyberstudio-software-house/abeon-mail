# Etap 6c — Full-text search (FTS5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Search mail across all accounts via SQLite FTS5 — headers always, body text best-effort — surfaced from a rail search bar (and a palette/`/` shortcut that focus it), results shown in the message-list pane.

**Architecture:** A stored FTS5 table `search_fts` (rowid = `messages.id`) is rebuilt in migration V7. The index is written from `am-storage` by a single canonical `reindex_message` that reconstructs the FTS row from the `messages` / `message_bodies` / `attachments` tables; it is called automatically inside `insert_headers` (envelope sync, same transaction) and from `am-sync::get_or_fetch_body` (body arrival). An `AFTER DELETE` trigger keeps the index clean across cascade deletes. A pure `am-core::search::parse_query` turns user text into a safe FTS5 MATCH string plus a `has:attachment` flag; `am-storage::search_repo::search` runs the query and returns `SmartMessageRow` rows. The frontend reuses the smart-folder flat list for results.

**Tech Stack:** Rust (rusqlite + refinery + FTS5), Tauri + tauri-specta, React 19 + TS, zustand, @tanstack/react-query, vitest.

## Global Constraints

- All code identifiers in English. (Project rule.)
- NO comments in source code; if something non-obvious must be documented, put it in `docs/` (project rule). Do not add explanatory comments to `.rs`/`.ts` files.
- Conventional Commits 1.0.0 for every commit. Do NOT add a co-author trailer. Do NOT push.
- Reuse the existing `SmartMessageRow` type (am-core::smart) for search results — no new IPC type.
- Search is **global**: all accounts, all folders, but EXCLUDE `draft = 1`, `deleted = 1`, and folders whose `folder_type` is `trash` or `spam`.
- Results are ordered `m.date DESC` (recency), never bm25.
- Every free term and operator value is double-quoted (embedded `"` doubled) and suffixed with `*`: a raw term `report` becomes the FTS token `"report"*`. This is the only thing that reaches `MATCH` — never raw user text.
- Operators in 6c: `from:`, `to:`, `subject:`, `has:attachment`. No OR / NOT / NEAR / `in:` / date ranges.
- Do NOT introduce a new lucide-react icon. Reuse the already-imported `Search` icon; use a text `✕` glyph for clear. (A new lucide icon would require editing `src/test/lucide-stub.js` or vitest OOMs.)
- Node 24 toolchain: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`. Frontend tests: `npx vitest run`. Bindings: `npm run gen:bindings`.

---

### Task 1: Migration V7 — rebuild `search_fts` as a stored table + delete trigger

**Files:**
- Create: `crates/am-storage/src/migrations/V7__search_fts.sql`
- Test: `crates/am-storage/src/db.rs` (add a test in the existing `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: nothing.
- Produces: a stored (non-contentless) FTS5 virtual table `search_fts(subject, from_address, to_addresses, body_text, attachment_names)` with `rowid` addressing, plus trigger `messages_ad_fts` that deletes the matching `search_fts` row after a `messages` row is deleted.

Context: V1 created `search_fts` with `content=''` (contentless) and nothing ever populated it. A contentless table cannot be re-indexed without knowing the old column values, which the best-effort body flow does not have. We drop and recreate it as a standard stored table so re-indexing is a plain `DELETE ... WHERE rowid=? ; INSERT`.

- [ ] **Step 1: Write the migration**

Create `crates/am-storage/src/migrations/V7__search_fts.sql`:

```sql
DROP TRIGGER IF EXISTS messages_ad_fts;
DROP TABLE IF EXISTS search_fts;

CREATE VIRTUAL TABLE search_fts USING fts5(
    subject,
    from_address,
    to_addresses,
    body_text,
    attachment_names,
    tokenize = 'unicode61 remove_diacritics 2',
    prefix = '2 3'
);

CREATE TRIGGER messages_ad_fts AFTER DELETE ON messages BEGIN
    DELETE FROM search_fts WHERE rowid = old.id;
END;
```

- [ ] **Step 2: Write the failing test**

Add to the `mod tests` block in `crates/am-storage/src/db.rs`:

```rust
    #[test]
    fn migration_v7_search_fts_is_stored_and_roundtrips() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        conn.execute(
            "INSERT INTO search_fts (rowid, subject, from_address, to_addresses, body_text, attachment_names)
             VALUES (1, 'Quarterly report', 'alice@example.com', '[]', 'hello world', '')",
            [],
        )
        .unwrap();
        let subject: String = conn
            .query_row("SELECT subject FROM search_fts WHERE rowid = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(subject, "Quarterly report");

        let trigger_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name='messages_ad_fts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(trigger_count, 1);
    }
```

(`SELECT subject FROM search_fts` reading back the stored value would fail on a contentless table — this proves the rebuild.)

- [ ] **Step 3: Run the test to verify it passes**

Run: `cargo test -p am-storage migration_v7_search_fts_is_stored_and_roundtrips`
Expected: PASS. (If it fails at migration time with a tokenizer error on `remove_diacritics 2`, the bundled SQLite is too old — fall back to `remove_diacritics 1` in the SQL and re-run. This is not expected; the bundled rusqlite SQLite supports option 2.)

- [ ] **Step 4: Run the full storage suite**

Run: `cargo test -p am-storage`
Expected: PASS (all existing tests still green; the rebuilt table is empty so nothing else is affected).

- [ ] **Step 5: Commit**

```bash
git add crates/am-storage/src/migrations/V7__search_fts.sql crates/am-storage/src/db.rs
git commit -m "feat(storage): rebuild search_fts as stored fts5 table with delete trigger (V7)"
```

---

### Task 2: `am-core::search` — pure query parser

**Files:**
- Create: `crates/am-core/src/search.rs`
- Modify: `crates/am-core/src/lib.rs` (add `pub mod search;`)
- Test: in `crates/am-core/src/search.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `pub struct ParsedQuery { pub fts_match: Option<String>, pub require_attachment: bool }` (derives `Debug, Clone, PartialEq, Eq, Default`).
  - `pub fn parse_query(raw: &str) -> ParsedQuery`.
  - Output token format: each term → `"<escaped>"*` (embedded `"` doubled); operators → `from_address : "<v>"*`, `to_addresses : "<v>"*`, `subject : "<v>"*`; clauses joined with ` AND `. `has:attachment` sets `require_attachment` and adds no clause. Empty input / only-empty-value-operators / only `has:attachment` → `fts_match = None`.

- [ ] **Step 1: Write the failing tests**

Create `crates/am-core/src/search.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_term_is_quoted_and_prefixed() {
        let p = parse_query("report");
        assert_eq!(p.fts_match.as_deref(), Some("\"report\"*"));
        assert!(!p.require_attachment);
    }

    #[test]
    fn multiple_terms_joined_with_and() {
        let p = parse_query("quarterly report");
        assert_eq!(p.fts_match.as_deref(), Some("\"quarterly\"* AND \"report\"*"));
    }

    #[test]
    fn from_to_subject_map_to_columns() {
        let p = parse_query("from:alice to:bob subject:budget");
        assert_eq!(
            p.fts_match.as_deref(),
            Some("from_address : \"alice\"* AND to_addresses : \"bob\"* AND subject : \"budget\"*")
        );
    }

    #[test]
    fn operator_keys_are_case_insensitive() {
        let p = parse_query("From:Alice");
        assert_eq!(p.fts_match.as_deref(), Some("from_address : \"Alice\"*"));
    }

    #[test]
    fn has_attachment_sets_flag_without_clause() {
        let p = parse_query("has:attachment");
        assert_eq!(p.fts_match, None);
        assert!(p.require_attachment);
    }

    #[test]
    fn has_attachment_combines_with_terms() {
        let p = parse_query("invoice has:attachment");
        assert_eq!(p.fts_match.as_deref(), Some("\"invoice\"*"));
        assert!(p.require_attachment);
    }

    #[test]
    fn empty_or_whitespace_yields_none() {
        assert_eq!(parse_query(""), ParsedQuery::default());
        assert_eq!(parse_query("   \t "), ParsedQuery::default());
    }

    #[test]
    fn empty_value_operator_is_skipped() {
        let p = parse_query("from:");
        assert_eq!(p, ParsedQuery::default());
    }

    #[test]
    fn embedded_double_quote_is_escaped() {
        let p = parse_query("a\"b");
        assert_eq!(p.fts_match.as_deref(), Some("\"a\"\"b\"*"));
    }

    #[test]
    fn unknown_operator_is_treated_as_free_term() {
        let p = parse_query("foo:bar");
        assert_eq!(p.fts_match.as_deref(), Some("\"foo:bar\"*"));
    }

    #[test]
    fn has_with_other_value_is_ignored() {
        let p = parse_query("has:something");
        assert_eq!(p, ParsedQuery::default());
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p am-core search`
Expected: FAIL to compile (`parse_query`, `ParsedQuery` not defined).

- [ ] **Step 3: Write the implementation**

Prepend to `crates/am-core/src/search.rs` (above the test module):

```rust
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedQuery {
    pub fts_match: Option<String>,
    pub require_attachment: bool,
}

fn escape_term(value: &str) -> String {
    let escaped = value.replace('"', "\"\"");
    format!("\"{escaped}\"*")
}

pub fn parse_query(raw: &str) -> ParsedQuery {
    let mut clauses: Vec<String> = Vec::new();
    let mut require_attachment = false;

    for token in raw.split_whitespace() {
        match token.split_once(':') {
            Some((key, value)) => {
                let key_lower = key.to_ascii_lowercase();
                match key_lower.as_str() {
                    "from" => {
                        if !value.is_empty() {
                            clauses.push(format!("from_address : {}", escape_term(value)));
                        }
                    }
                    "to" => {
                        if !value.is_empty() {
                            clauses.push(format!("to_addresses : {}", escape_term(value)));
                        }
                    }
                    "subject" => {
                        if !value.is_empty() {
                            clauses.push(format!("subject : {}", escape_term(value)));
                        }
                    }
                    "has" => {
                        if value.eq_ignore_ascii_case("attachment") {
                            require_attachment = true;
                        }
                    }
                    _ => clauses.push(escape_term(token)),
                }
            }
            None => clauses.push(escape_term(token)),
        }
    }

    let fts_match = if clauses.is_empty() {
        None
    } else {
        Some(clauses.join(" AND "))
    };

    ParsedQuery {
        fts_match,
        require_attachment,
    }
}
```

Add to `crates/am-core/src/lib.rs` (keep modules alphabetical — insert after `pub mod outgoing;` / before `pub mod signature;`):

```rust
pub mod search;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p am-core search`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/am-core/src/search.rs crates/am-core/src/lib.rs
git commit -m "feat(core): add FTS query parser with gmail-style operators"
```

---

### Task 3: `am-storage::search_repo` — reindex + search, wired into `insert_headers`

**Files:**
- Create: `crates/am-storage/src/search_repo.rs`
- Modify: `crates/am-storage/src/lib.rs` (add `pub mod search_repo;`)
- Modify: `crates/am-storage/src/smart_repo.rs` (make `row_to_smart` `pub(crate)`)
- Modify: `crates/am-storage/src/messages_repo.rs` (`insert_headers` indexes each inserted row)
- Test: in `crates/am-storage/src/search_repo.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `am_core::search::ParsedQuery`, `am_core::smart::SmartMessageRow`, `crate::smart_repo::row_to_smart`, `crate::db::{Database, StorageError}`.
- Produces:
  - `pub fn reindex_message(db: &Database, message_id: i64) -> Result<(), StorageError>`
  - `pub fn reindex_message_conn(conn: &rusqlite::Connection, message_id: i64) -> rusqlite::Result<()>`
  - `pub fn search(db: &Database, parsed: &ParsedQuery, limit: i64, offset: i64) -> Result<Vec<SmartMessageRow>, StorageError>`
- Side effect: `insert_headers` now calls `reindex_message_conn` for each newly inserted message inside its existing transaction.

- [ ] **Step 1: Make `row_to_smart` reusable**

In `crates/am-storage/src/smart_repo.rs` change the signature:

```rust
pub(crate) fn row_to_smart(row: &rusqlite::Row) -> rusqlite::Result<SmartMessageRow> {
```

(only the visibility changes; body unchanged.)

- [ ] **Step 2: Write the failing tests**

Create `crates/am-storage/src/search_repo.rs`:

```rust
use am_core::search::ParsedQuery;
use am_core::smart::SmartMessageRow;
use rusqlite::{params, Connection, OptionalExtension};

use crate::db::{Database, StorageError};
use crate::smart_repo::row_to_smart;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use crate::folders_repo::upsert_folder;
    use crate::messages_repo::{delete_by_uids, insert_headers, store_body};
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::{MessageBody, NewMessageHeader};
    use am_core::search::parse_query;

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

    fn header(uid: i64, subject: &str, from: &str, has_attachments: bool) -> NewMessageHeader {
        NewMessageHeader {
            uid,
            message_id_hdr: Some(format!("<msg-{uid}@example.com>")),
            in_reply_to: None,
            references_hdr: None,
            from_address: from.into(),
            from_name: Some("Sender".into()),
            subject: subject.into(),
            date: 1000 + uid,
            seen: false,
            flagged: false,
            has_attachments,
            size: 512,
            snippet: "preview".into(),
        }
    }

    fn message_id_for(db: &Database, folder_id: i64, uid: i64) -> i64 {
        let conn = db.conn();
        conn.query_row(
            "SELECT id FROM messages WHERE folder_id = ?1 AND uid = ?2",
            params![folder_id, uid],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn headers_are_searchable_after_insert() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", Some("#ff0000"));
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, "Quarterly report", "alice@example.com", false)]).unwrap();

        let rows = search(&db, &parse_query("report"), 50, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].subject, "Quarterly report");
        assert_eq!(rows[0].account_color.as_deref(), Some("#ff0000"));
    }

    #[test]
    fn from_operator_matches_sender() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[
            header(1, "Hello", "alice@example.com", false),
            header(2, "Hi", "bob@example.com", false),
        ]).unwrap();

        let rows = search(&db, &parse_query("from:alice"), 50, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].from_address, "alice@example.com");
    }

    #[test]
    fn body_is_searchable_only_after_reindex() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, "No keyword here", "a@example.com", false)]).unwrap();
        let id = message_id_for(&db, inbox, 1);

        assert_eq!(search(&db, &parse_query("kangaroo"), 50, 0).unwrap().len(), 0);

        store_body(&db, id, &MessageBody {
            message_id: id,
            text_plain: Some("a wild kangaroo appears".into()),
            text_html: None,
        }).unwrap();
        reindex_message(&db, id).unwrap();

        assert_eq!(search(&db, &parse_query("kangaroo"), 50, 0).unwrap().len(), 1);
    }

    #[test]
    fn diacritics_are_folded() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, "Rapórt roczny", "a@example.com", false)]).unwrap();

        let rows = search(&db, &parse_query("raport"), 50, 0).unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn excludes_trash_spam_draft_deleted() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        let trash = make_folder(&db, acc, "Trash", FolderType::Trash);
        insert_headers(&db, inbox, &[header(1, "findme inbox", "a@example.com", false)]).unwrap();
        insert_headers(&db, trash, &[header(2, "findme trash", "a@example.com", false)]).unwrap();
        insert_headers(&db, inbox, &[header(3, "findme draft", "a@example.com", false)]).unwrap();
        {
            let conn = db.conn();
            conn.execute("UPDATE messages SET draft = 1 WHERE folder_id = ?1 AND uid = 3", params![inbox]).unwrap();
        }

        let rows = search(&db, &parse_query("findme"), 50, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].subject, "findme inbox");
    }

    #[test]
    fn attachment_only_query_lists_attachment_messages() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[
            header(1, "with file", "a@example.com", true),
            header(2, "no file", "a@example.com", false),
        ]).unwrap();

        let rows = search(&db, &parse_query("has:attachment"), 50, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].subject, "with file");
    }

    #[test]
    fn empty_query_returns_nothing() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, "anything", "a@example.com", false)]).unwrap();

        assert_eq!(search(&db, &parse_query(""), 50, 0).unwrap().len(), 0);
    }

    #[test]
    fn delete_removes_from_index_via_trigger() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, "deleteme soon", "a@example.com", false)]).unwrap();
        assert_eq!(search(&db, &parse_query("deleteme"), 50, 0).unwrap().len(), 1);

        delete_by_uids(&db, inbox, &[1]).unwrap();
        assert_eq!(search(&db, &parse_query("deleteme"), 50, 0).unwrap().len(), 0);
    }

    #[test]
    fn results_ordered_date_desc_cross_account() {
        let db = Database::open_in_memory().unwrap();
        let acc1 = make_account(&db, "a@example.com", Some("#111111"));
        let acc2 = make_account(&db, "b@example.com", Some("#222222"));
        let in1 = make_folder(&db, acc1, "INBOX", FolderType::Inbox);
        let in2 = make_folder(&db, acc2, "INBOX", FolderType::Inbox);
        insert_headers(&db, in1, &[header(1, "shared topic old", "a@example.com", false)]).unwrap();
        insert_headers(&db, in2, &[header(2, "shared topic new", "b@example.com", false)]).unwrap();

        let rows = search(&db, &parse_query("shared"), 50, 0).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows[0].date >= rows[1].date);
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p am-storage search_repo`
Expected: FAIL to compile (`search`, `reindex_message`, module not declared).

- [ ] **Step 4: Write the implementation**

Prepend to `crates/am-storage/src/search_repo.rs` (above the `#[cfg(test)]` module):

```rust
pub fn reindex_message_conn(conn: &Connection, message_id: i64) -> rusqlite::Result<()> {
    let (subject, from_address, to_addresses): (String, String, String) = conn.query_row(
        "SELECT subject, from_address, to_addresses FROM messages WHERE id = ?1",
        params![message_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;

    let body_text: String = conn
        .query_row(
            "SELECT COALESCE(text_plain, '') FROM message_bodies WHERE message_id = ?1",
            params![message_id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_default();

    let attachment_names: String = conn.query_row(
        "SELECT COALESCE(group_concat(filename, ' '), '') FROM attachments WHERE message_id = ?1",
        params![message_id],
        |r| r.get(0),
    )?;

    conn.execute("DELETE FROM search_fts WHERE rowid = ?1", params![message_id])?;
    conn.execute(
        "INSERT INTO search_fts (rowid, subject, from_address, to_addresses, body_text, attachment_names)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![message_id, subject, from_address, to_addresses, body_text, attachment_names],
    )?;
    Ok(())
}

pub fn reindex_message(db: &Database, message_id: i64) -> Result<(), StorageError> {
    let conn = db.conn();
    reindex_message_conn(&conn, message_id)?;
    Ok(())
}

pub fn search(
    db: &Database,
    parsed: &ParsedQuery,
    limit: i64,
    offset: i64,
) -> Result<Vec<SmartMessageRow>, StorageError> {
    if parsed.fts_match.is_none() && !parsed.require_attachment {
        return Ok(Vec::new());
    }

    let select = "SELECT m.id, m.account_id, m.folder_id, a.color,
            m.from_address, m.from_name, m.subject, m.date,
            m.seen, m.flagged, m.has_attachments, m.snippet";
    let exclusions =
        "m.draft = 0 AND m.deleted = 0 AND f.folder_type NOT IN ('trash', 'spam')";

    let conn = db.conn();
    let mut out = Vec::new();

    match &parsed.fts_match {
        Some(match_expr) => {
            let attach = if parsed.require_attachment {
                "AND m.has_attachments = 1"
            } else {
                ""
            };
            let sql = format!(
                "{select}
                 FROM search_fts s
                 JOIN messages m ON m.id = s.rowid
                 JOIN folders f ON f.id = m.folder_id
                 JOIN accounts a ON a.id = m.account_id
                 WHERE search_fts MATCH ?1 AND {exclusions} {attach}
                 ORDER BY m.date DESC
                 LIMIT ?2 OFFSET ?3"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![match_expr, limit, offset], row_to_smart)?;
            for r in rows {
                out.push(r?);
            }
        }
        None => {
            let sql = format!(
                "{select}
                 FROM messages m
                 JOIN folders f ON f.id = m.folder_id
                 JOIN accounts a ON a.id = m.account_id
                 WHERE {exclusions} AND m.has_attachments = 1
                 ORDER BY m.date DESC
                 LIMIT ?1 OFFSET ?2"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![limit, offset], row_to_smart)?;
            for r in rows {
                out.push(r?);
            }
        }
    }

    Ok(out)
}
```

Add to `crates/am-storage/src/lib.rs` (after `pub mod queue_repo;`, keeping the existing order sensible — place alphabetically before `pub mod settings_repo;`):

```rust
pub mod search_repo;
```

- [ ] **Step 5: Wire indexing into `insert_headers`**

In `crates/am-storage/src/messages_repo.rs`, modify `insert_headers` to collect inserted ids and reindex them inside the same transaction. Replace the inner insertion block + commit with:

```rust
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let mut count = 0usize;
    let mut inserted_ids: Vec<i64> = Vec::new();
    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO messages
             (account_id, folder_id, uid, message_id_hdr, in_reply_to, references_hdr, from_address, from_name, subject, date, seen, flagged, has_attachments, size, snippet)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        )?;
        for h in headers {
            let inserted = stmt.execute(params![
                account_id,
                folder_id,
                h.uid,
                h.message_id_hdr,
                h.in_reply_to,
                h.references_hdr,
                h.from_address,
                h.from_name,
                h.subject,
                h.date,
                h.seen as i64,
                h.flagged as i64,
                h.has_attachments as i64,
                h.size,
                h.snippet
            ])?;
            if inserted == 1 {
                inserted_ids.push(tx.last_insert_rowid());
            }
            count += inserted;
        }
    }
    for id in &inserted_ids {
        crate::search_repo::reindex_message_conn(&tx, *id)?;
    }
    tx.commit()?;
    Ok(count)
```

(The only changes: declare `inserted_ids`, capture `tx.last_insert_rowid()` when `inserted == 1`, and the reindex loop before `tx.commit()`. The `account_id` lookup above this block is unchanged.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test -p am-storage`
Expected: PASS — the 9 new `search_repo` tests plus all existing storage/smart_repo tests (the latter now also populate the index, which is harmless).

- [ ] **Step 7: Commit**

```bash
git add crates/am-storage/src/search_repo.rs crates/am-storage/src/lib.rs crates/am-storage/src/smart_repo.rs crates/am-storage/src/messages_repo.rs
git commit -m "feat(storage): add search_repo (reindex + query) and index on header insert"
```

---

### Task 4: `am-sync` — reindex body on fetch

**Files:**
- Modify: `crates/am-sync/src/service.rs` (`get_or_fetch_body`, after attachments are stored)

**Interfaces:**
- Consumes: `am_storage::search_repo::reindex_message`.
- Produces: best-effort body coverage — once a message body is fetched and stored, its FTS row is rebuilt to include `text_plain`.

Context: `reindex_message` is fully unit-tested in Task 3 (the `body_is_searchable_only_after_reindex` test exercises exactly this store-body-then-reindex path). This task is the one-line production wiring; it is verified by compilation and the existing `am-sync` suite staying green (the body fetch path needs a live IMAP server, so it has no standalone unit test — its data layer is covered by Task 3).

- [ ] **Step 1: Add the reindex call**

In `crates/am-sync/src/service.rs`, inside `get_or_fetch_body`, immediately after:

```rust
    am_storage::attachments_repo::replace_for_message(db, message_id, &parsed.attachment_names)?;
```

add:

```rust
    am_storage::search_repo::reindex_message(db, message_id)?;
```

(before `Ok(body)`).

- [ ] **Step 2: Build and run the sync suite**

Run: `cargo test -p am-sync`
Expected: PASS (compiles; existing tests including the GreenMail integration tests still green). If GreenMail/Docker is unavailable in the environment, run `cargo build -p am-sync` and `cargo test -p am-sync --lib` and report which integration tests were skipped.

- [ ] **Step 3: Commit**

```bash
git add crates/am-sync/src/service.rs
git commit -m "feat(sync): reindex message body into search index on fetch"
```

---

### Task 5: `am-app` — `search_messages` command + bindings

**Files:**
- Modify: `crates/am-app/src/commands.rs` (add `search_messages`)
- Modify: `crates/am-app/src/lib.rs` (register in `collect_commands!`)
- Modify: `src/ipc/bindings.ts` (regenerated)

**Interfaces:**
- Consumes: `am_core::search::parse_query`, `am_storage::search_repo::search`, `AppState`.
- Produces: Tauri command `search_messages(query: String, limit: i64, offset: i64) -> Result<Vec<SmartMessageRow>, String>`; TS binding `commands.searchMessages(query: string, limit: number, offset: number) => Promise<Result<SmartMessageRow[], string>>`.

- [ ] **Step 1: Add the command**

In `crates/am-app/src/commands.rs`, after `list_smart_folder` (ends at line ~163), add:

```rust
#[tauri::command]
#[specta::specta]
pub fn search_messages(
    state: tauri::State<'_, AppState>,
    query: String,
    limit: i64,
    offset: i64,
) -> Result<Vec<SmartMessageRow>, String> {
    let parsed = am_core::search::parse_query(&query);
    am_storage::search_repo::search(&state.db, &parsed, limit, offset).map_err(|e| e.to_string())
}
```

(`SmartMessageRow` is already imported at the top of `commands.rs` via `smart::{SmartFolderKind, SmartMessageRow}`.)

- [ ] **Step 2: Register the command**

In `crates/am-app/src/lib.rs`, add to the `collect_commands![ ... ]` list (after `commands::list_smart_folder,`):

```rust
            commands::search_messages,
```

- [ ] **Step 3: Build to verify it compiles**

Run: `cargo build -p am-app`
Expected: PASS.

- [ ] **Step 4: Regenerate bindings**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm run gen:bindings`
Expected: `src/ipc/bindings.ts` now contains a `searchMessages` entry. Verify:

Run: `grep -n "searchMessages" src/ipc/bindings.ts`
Expected: at least one match.

- [ ] **Step 5: Commit**

```bash
git add crates/am-app/src/commands.rs crates/am-app/src/lib.rs src/ipc/bindings.ts
git commit -m "feat(app): add searchMessages command and regenerate bindings"
```

---

### Task 6: Frontend store + hooks (`searchQuery`/`searchActive`/`focusSearch`, `useDebouncedValue`, `useSearch`)

**Files:**
- Modify: `src/app/store.ts`
- Create: `src/shared/hooks/useDebouncedValue.ts`
- Modify: `src/ipc/queries.ts` (add `useSearch`)
- Test: `src/app/store.test.ts` (create or extend), `src/shared/hooks/useDebouncedValue.test.ts`

**Interfaces:**
- Consumes: `commands.searchMessages`, `SmartMessageRow`.
- Produces:
  - store fields `searchQuery: string`, `searchActive: boolean`, `focusSearch: (() => void) | null`
  - setters `setSearchQuery(q: string)`, `clearSearch()`, `setFocusSearch(fn: (() => void) | null)`
  - `setSelectedAccountId` / `setSelectedFolderId` / `setSelectedSmartFolder` also clear search (`searchQuery: ""`, `searchActive: false`)
  - `useDebouncedValue<T>(value: T, delayMs: number): T`
  - `useSearch(query: string)` react-query hook → `SmartMessageRow[]`

- [ ] **Step 1: Write failing store + debounce tests**

Create `src/shared/hooks/useDebouncedValue.test.ts`:

```ts
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useDebouncedValue } from "./useDebouncedValue";

describe("useDebouncedValue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the initial value immediately", () => {
    const { result } = renderHook(() => useDebouncedValue("a", 200));
    expect(result.current).toBe("a");
  });

  it("delays updates by the given delay", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 200), {
      initialProps: { v: "a" },
    });
    rerender({ v: "b" });
    expect(result.current).toBe("a");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe("b");
  });
});
```

Create/extend `src/app/store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./store";

describe("search store slice", () => {
  beforeEach(() => {
    useUiStore.setState({
      searchQuery: "",
      searchActive: false,
      selectedFolderId: null,
      selectedSmartFolder: null,
    });
  });

  it("setSearchQuery activates search for non-empty input", () => {
    useUiStore.getState().setSearchQuery("hello");
    expect(useUiStore.getState().searchQuery).toBe("hello");
    expect(useUiStore.getState().searchActive).toBe(true);
  });

  it("setSearchQuery with blank input deactivates search", () => {
    useUiStore.getState().setSearchQuery("   ");
    expect(useUiStore.getState().searchActive).toBe(false);
  });

  it("clearSearch resets query and active flag", () => {
    useUiStore.getState().setSearchQuery("hello");
    useUiStore.getState().clearSearch();
    expect(useUiStore.getState().searchQuery).toBe("");
    expect(useUiStore.getState().searchActive).toBe(false);
  });

  it("selecting a folder clears active search", () => {
    useUiStore.getState().setSearchQuery("hello");
    useUiStore.getState().setSelectedFolderId(5);
    expect(useUiStore.getState().searchActive).toBe(false);
    expect(useUiStore.getState().searchQuery).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/shared/hooks/useDebouncedValue.test.ts src/app/store.test.ts`
Expected: FAIL (module/field not defined).

- [ ] **Step 3: Implement the debounce hook**

Create `src/shared/hooks/useDebouncedValue.ts`:

```ts
import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);

  return debounced;
}
```

- [ ] **Step 4: Extend the store**

In `src/app/store.ts`:

Add to the `UiState` type (after `shortcutOverrides`):

```ts
  searchQuery: string;
  searchActive: boolean;
  focusSearch: (() => void) | null;
```

Add to the setter section of the `UiState` type:

```ts
  setSearchQuery: (q: string) => void;
  clearSearch: () => void;
  setFocusSearch: (fn: (() => void) | null) => void;
```

Add to the store initial state (after `shortcutOverrides: {},`):

```ts
  searchQuery: "",
  searchActive: false,
  focusSearch: null,
```

Add the setters (place near the selection setters):

```ts
  setSearchQuery: (q) => set({ searchQuery: q, searchActive: q.trim().length > 0 }),
  clearSearch: () => set({ searchQuery: "", searchActive: false }),
  setFocusSearch: (fn) => set({ focusSearch: fn }),
```

Update the three selection setters to also clear search:

```ts
  setSelectedAccountId: (id) =>
    set({ selectedAccountId: id, selectedSmartFolder: null, searchQuery: "", searchActive: false }),
  setSelectedFolderId: (id) =>
    set({ selectedFolderId: id, selectedSmartFolder: null, searchQuery: "", searchActive: false }),
  setSelectedSmartFolder: (kind) =>
    set({
      selectedSmartFolder: kind,
      selectedAccountId: null,
      selectedFolderId: null,
      selectedThreadId: null,
      searchQuery: "",
      searchActive: false,
    }),
```

- [ ] **Step 5: Add the `useSearch` hook**

In `src/ipc/queries.ts`, update the react-query import to include `keepPreviousData`:

```ts
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
```

Add the hook (place after `useSmartFolder`):

```ts
export function useSearch(query: string) {
  return useQuery<SmartMessageRow[]>({
    queryKey: ["search", query],
    queryFn: () => commands.searchMessages(query, 100, 0).then(unwrap),
    enabled: query.trim().length > 0,
    placeholderData: keepPreviousData,
  });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/shared/hooks/useDebouncedValue.test.ts src/app/store.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/store.ts src/app/store.test.ts src/shared/hooks/useDebouncedValue.ts src/shared/hooks/useDebouncedValue.test.ts src/ipc/queries.ts
git commit -m "feat(ui): add search store slice, debounce hook, and useSearch query"
```

---

### Task 7: `MailboxRail` — real search input

**Files:**
- Modify: `src/features/mailbox/MailboxRail.tsx`
- Modify: `src/features/mailbox/MailboxRail.css` (add input styles)
- Test: `src/features/mailbox/MailboxRail.test.tsx` (extend)

**Interfaces:**
- Consumes: store `searchQuery`, `setSearchQuery`, `clearSearch`, `setFocusSearch`.
- Produces: a focusable search `<input aria-label="Search mail">` that drives `searchQuery`; registers a focus callback via `setFocusSearch`; `Esc`/`✕` clears.

- [ ] **Step 1: Write the failing test**

Add to `src/features/mailbox/MailboxRail.test.tsx`:

```tsx
  it("typing in the search input updates the store and clears via the clear button", async () => {
    const user = userEvent.setup();
    renderRail();
    const input = screen.getByLabelText("Search mail");
    await user.type(input, "report");
    expect(useUiStore.getState().searchQuery).toBe("report");
    expect(useUiStore.getState().searchActive).toBe(true);

    await user.click(screen.getByLabelText("Clear search"));
    expect(useUiStore.getState().searchQuery).toBe("");
    expect(useUiStore.getState().searchActive).toBe(false);
  });
```

(Use the file's existing render helper and imports — `userEvent`, `screen`, `useUiStore` are already imported in this test file from the Etap-5/6 tests; if a helper named differently than `renderRail` exists, use that one.)

- [ ] **Step 2: Run to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/mailbox/MailboxRail.test.tsx`
Expected: FAIL (`getByLabelText("Search mail")` not found).

- [ ] **Step 3: Replace the placeholder**

In `src/features/mailbox/MailboxRail.tsx`, add store wiring near the other `useUiStore` selectors at the top of the component:

```tsx
  const searchQuery = useUiStore((s) => s.searchQuery);
  const setSearchQuery = useUiStore((s) => s.setSearchQuery);
  const clearSearch = useUiStore((s) => s.clearSearch);
  const setFocusSearch = useUiStore((s) => s.setFocusSearch);
  const searchInputRef = useRef<HTMLInputElement>(null);
```

Register the focus callback (add an effect; `useEffect`/`useRef` are already imported — if not, add them to the React import):

```tsx
  useEffect(() => {
    setFocusSearch(() => searchInputRef.current?.focus());
    return () => setFocusSearch(null);
  }, [setFocusSearch]);
```

Replace the placeholder block:

```tsx
      <div className="rail__search" aria-disabled="true">
        <Search size={15} />
        <span>Search</span>
      </div>
```

with:

```tsx
      <div className="rail__search">
        <Search size={15} />
        <input
          ref={searchInputRef}
          className="rail__search-input"
          type="text"
          value={searchQuery}
          placeholder="Search all mail"
          aria-label="Search mail"
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              clearSearch();
              searchInputRef.current?.blur();
            }
          }}
        />
        {searchQuery.length > 0 && (
          <button
            type="button"
            className="rail__search-clear"
            aria-label="Clear search"
            onClick={() => clearSearch()}
          >
            ✕
          </button>
        )}
      </div>
```

- [ ] **Step 4: Style the input**

In `src/features/mailbox/MailboxRail.css`, add:

```css
.rail__search-input {
  flex: 1;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  outline: none;
  min-width: 0;
}

.rail__search-input::placeholder {
  color: var(--text-preview);
}

.rail__search-clear {
  border: none;
  background: transparent;
  color: var(--icon-muted);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 2px 4px;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/mailbox/MailboxRail.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/mailbox/MailboxRail.tsx src/features/mailbox/MailboxRail.css src/features/mailbox/MailboxRail.test.tsx
git commit -m "feat(ui): turn rail search placeholder into a real search input"
```

---

### Task 8: `MessageListPane` — search-results mode + term highlighting

**Files:**
- Create: `src/features/message-list/highlight.tsx`
- Modify: `src/features/message-list/MessageListPane.tsx`
- Modify: `src/features/message-list/MessageListPane.css` (results banner styles)
- Test: `src/features/message-list/highlight.test.tsx` (create), `src/features/message-list/MessageListPane.test.tsx` (extend)

**Interfaces:**
- Consumes: store `searchActive`, `searchQuery`; `useSearch`, `useDebouncedValue`; existing `SmartRow`.
- Produces: when `searchActive`, the pane renders a results banner (`Results for "<query>"` + count + clear) and the flat `SmartMessageRow` list with free-term matches wrapped in `<mark>`. `extractTerms(query)` and `<Highlight text terms />` are exported from `highlight.tsx`.

- [ ] **Step 1: Write failing highlight tests**

Create `src/features/message-list/highlight.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { extractTerms, Highlight } from "./highlight";

describe("extractTerms", () => {
  it("keeps free terms and drops operators", () => {
    expect(extractTerms("from:alice quarterly report has:attachment")).toEqual([
      "quarterly",
      "report",
    ]);
  });

  it("returns empty for operator-only queries", () => {
    expect(extractTerms("has:attachment")).toEqual([]);
  });
});

describe("Highlight", () => {
  it("wraps matched terms in mark, diacritic-insensitive", () => {
    render(<Highlight text="Rapórt roczny" terms={["raport"]} />);
    const mark = screen.getByText("Rapórt");
    expect(mark.tagName).toBe("MARK");
  });

  it("renders plain text when no terms match", () => {
    const { container } = render(<Highlight text="hello world" terms={["xyz"]} />);
    expect(container.querySelector("mark")).toBeNull();
    expect(container.textContent).toBe("hello world");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/message-list/highlight.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement highlight**

Create `src/features/message-list/highlight.tsx`:

```tsx
import type { ReactNode } from "react";

function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export function extractTerms(query: string): string[] {
  const terms: string[] = [];
  for (const token of query.split(/\s+/)) {
    if (token.length === 0) continue;
    const colon = token.indexOf(":");
    if (colon !== -1) {
      const key = token.slice(0, colon).toLowerCase();
      if (key === "from" || key === "to" || key === "subject" || key === "has") {
        continue;
      }
    }
    terms.push(token);
  }
  return terms;
}

export function Highlight({ text, terms }: { text: string; terms: string[] }): ReactNode {
  const cleaned = terms.map(fold).filter((t) => t.length > 0);
  if (cleaned.length === 0) return text;

  const foldedText = fold(text);
  const ranges: Array<[number, number]> = [];
  for (const term of cleaned) {
    let from = 0;
    while (true) {
      const idx = foldedText.indexOf(term, from);
      if (idx === -1) break;
      ranges.push([idx, idx + term.length]);
      from = idx + term.length;
    }
  }
  if (ranges.length === 0) return text;

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  const parts: ReactNode[] = [];
  let cursor = 0;
  merged.forEach(([start, end], i) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<mark key={i}>{text.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
```

(`fold` over text and terms is diacritic-insensitive; indexing on the folded string preserves offsets because NFD-stripping does not change non-diacritic character counts for the Latin/Polish text we render. Highlighting is best-effort cosmetic — a mismatch never breaks rendering.)

- [ ] **Step 4: Run highlight tests to verify they pass**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/message-list/highlight.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing pane test**

Add to `src/features/message-list/MessageListPane.test.tsx` (reuse the file's existing render/query-client helper and mock of `../../ipc/queries`; the test sets `searchActive` + `searchQuery` in the store and mocks `useSearch` to return one row):

```tsx
  it("shows a results banner and highlighted rows in search mode", () => {
    vi.mocked(useSearch).mockReturnValue({
      data: [
        {
          message_id: 1,
          account_id: 1,
          folder_id: 1,
          account_color: "#ff0000",
          from_address: "alice@example.com",
          from_name: "Alice",
          subject: "Quarterly report",
          date: 1000,
          seen: true,
          flagged: false,
          has_attachments: false,
          snippet: "the report is ready",
        },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useSearch>);

    useUiStore.setState({ searchQuery: "report", searchActive: true });
    renderPane();

    expect(screen.getByText(/Results for/)).toBeInTheDocument();
    const marks = screen.getAllByText("report");
    expect(marks.some((m) => m.tagName === "MARK")).toBe(true);
  });
```

Add `useSearch` to the mocked exports of `../../ipc/queries` in this file (the file already mocks `useThreads`/`useSmartFolder`; add `useSearch: vi.fn()` to that mock and import it).

- [ ] **Step 6: Run to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/message-list/MessageListPane.test.tsx`
Expected: FAIL (no results banner; `useSearch` undefined in mock).

- [ ] **Step 7: Implement search mode in the pane**

In `src/features/message-list/MessageListPane.tsx`:

Update imports:

```tsx
import { useThreads, useSmartFolder, useSearch } from "../../ipc/queries";
import { useDebouncedValue } from "../../shared/hooks/useDebouncedValue";
import { extractTerms, Highlight } from "./highlight";
```

Add store reads + search query inside `MessageListPane` (after the existing `useUiStore` selectors):

```tsx
  const searchActive = useUiStore((s) => s.searchActive);
  const searchQuery = useUiStore((s) => s.searchQuery);
  const clearSearch = useUiStore((s) => s.clearSearch);
  const debouncedQuery = useDebouncedValue(searchQuery, 200);
  const { data: searchRows, isLoading: searchLoading } = useSearch(debouncedQuery);
```

Replace the mode-derivation lines:

```tsx
  const isSmartMode = selectedSmartFolder != null;
  const isLoading = isSmartMode ? smartLoading : threadsLoading;
  const rawItems = isSmartMode ? (smartRows ?? []) : (threads ?? []);
  const hasSelection = isSmartMode ? selectedSmartFolder != null : selectedFolderId != null;
```

with:

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
  const highlightTerms = useMemo(() => extractTerms(debouncedQuery), [debouncedQuery]);
```

Update the `entries` memo to use `isFlatMode` for the smart/flat branch:

```tsx
  const entries = useMemo(
    (): ListEntry<ThreadSummary | SmartMessageRow>[] =>
      hasSelection && !isLoading && rawItems.length > 0
        ? isFlatMode
          ? groupIntoEntries(rawItems as SmartMessageRow[], (r) => (r as SmartMessageRow).date, nowSeconds)
          : groupIntoEntries(rawItems as ThreadSummary[], (t) => (t as ThreadSummary).last_date, nowSeconds)
        : [],
    [rawItems, isFlatMode, nowSeconds, hasSelection, isLoading]
  );
```

Update the `setListContext` effect:

```tsx
  useEffect(() => {
    const ids = isFlatMode
      ? (rawItems as SmartMessageRow[]).map((r) => r.message_id)
      : (rawItems as ThreadSummary[]).map((t) => t.thread_id);
    setListContext(ids, isFlatMode ? "message" : "thread");
  }, [rawItems, isFlatMode, setListContext]);
```

In the render, change the row branch `if (isSmartMode)` to `if (isFlatMode)`, and pass highlight terms to the flat row. Update the `SmartRow` usage:

```tsx
              if (isFlatMode) {
                const row = entry.data as SmartMessageRow;
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
                      showAvatars={showAvatars}
                      showSnippet={showSnippet}
                      onSelect={setSelectedMessageId}
                      highlightTerms={searchActive ? highlightTerms : undefined}
                    />
                  </div>
                );
              }
```

Add a results banner just below the `message-list__header` div (before the `{!hasSelection && ...}` block):

```tsx
      {searchActive && (
        <div className="message-list__search-banner" role="status">
          <span>
            Results for &ldquo;{searchQuery}&rdquo; ({rawItems.length})
          </span>
          <button
            type="button"
            className="message-list__search-clear"
            aria-label="Clear search"
            onClick={() => clearSearch()}
          >
            ✕
          </button>
        </div>
      )}
```

Update the `SmartRow` component signature and the subject/snippet rendering to honor `highlightTerms`:

```tsx
function SmartRow({
  row,
  isSelected,
  rowHeight,
  showAvatars,
  showSnippet,
  onSelect,
  highlightTerms,
}: {
  row: SmartMessageRow;
  isSelected: boolean;
  rowHeight: number;
  showAvatars: boolean;
  showSnippet: boolean;
  onSelect: (id: number) => void;
  highlightTerms?: string[];
}) {
```

In its body, replace the subject span content:

```tsx
            <span className="message-row__subject">
              {highlightTerms ? <Highlight text={row.subject} terms={highlightTerms} /> : row.subject}
            </span>
```

and the snippet span:

```tsx
        {showSnippet && (
          <span className="message-row__snippet">
            {highlightTerms ? <Highlight text={row.snippet} terms={highlightTerms} /> : row.snippet}
          </span>
        )}
```

- [ ] **Step 8: Style the banner**

In `src/features/message-list/MessageListPane.css`, add:

```css
.message-list__search-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 12px;
  font-size: 13px;
  color: var(--text-preview);
  border-bottom: 1px solid var(--border);
}

.message-list__search-clear {
  border: none;
  background: transparent;
  color: var(--icon-muted);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 2px 4px;
}

.message-row__subject mark,
.message-row__snippet mark {
  background: var(--shadow-accent, rgba(99, 102, 241, 0.25));
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
```

(If `--border` is not a defined token, use `var(--rail-border, rgba(0,0,0,0.08))` — check `tokens.css` for the border token name used elsewhere in this file and match it.)

- [ ] **Step 9: Run the pane + full frontend suite**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/message-list/`
Expected: PASS (new search-mode test + existing list tests).

- [ ] **Step 10: Commit**

```bash
git add src/features/message-list/highlight.tsx src/features/message-list/highlight.test.tsx src/features/message-list/MessageListPane.tsx src/features/message-list/MessageListPane.css src/features/message-list/MessageListPane.test.tsx
git commit -m "feat(ui): add search results mode with term highlighting to message list"
```

---

### Task 9: Activate the `search` action + palette entry; final pass

**Files:**
- Modify: `src/features/shortcuts/registry.ts` (enable `search`, relabel)
- Modify: `src/features/shortcuts/ShortcutsProvider.tsx` (handler)
- Modify: `src/features/shortcuts/CommandPalette.tsx` (palette action)
- Test: `src/features/shortcuts/registry.test.ts` (extend or create), `src/features/shortcuts/ShortcutsProvider.test.tsx` (extend if present)

**Interfaces:**
- Consumes: store `focusSearch`.
- Produces: `search` action enabled with binding `/`; its handler calls `focusSearch`; palette shows a "Search mail" item that focuses the rail input.

- [ ] **Step 1: Write the failing registry test**

Add to `src/features/shortcuts/registry.test.ts` (create the file if it does not exist, importing `ACTIONS`, `actionById`):

```ts
import { describe, it, expect } from "vitest";
import { actionById } from "./registry";

describe("search action", () => {
  it("is enabled and bound to /", () => {
    const search = actionById("search");
    expect(search?.enabled).toBe(true);
    expect(search?.defaultBinding).toBe("/");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/shortcuts/registry.test.ts`
Expected: FAIL (`enabled` is `false`).

- [ ] **Step 3: Enable the action**

In `src/features/shortcuts/registry.ts`, change the `search` entry:

```ts
  { id: "search", label: "Search mail", contexts: ["global"], defaultBinding: "/", enabled: true },
```

- [ ] **Step 4: Add the handler**

In `src/features/shortcuts/ShortcutsProvider.tsx`, add to the `handlers` map object (e.g. after `"open-settings"`):

```ts
      search: () => useUiStore.getState().focusSearch?.(),
```

- [ ] **Step 5: Add the palette entry**

In `src/features/shortcuts/CommandPalette.tsx`, add to the `paletteActions` map:

```ts
    search: () => requestAnimationFrame(() => useUiStore.getState().focusSearch?.()),
```

(`requestAnimationFrame` defers the focus until after the palette closes; `useUiStore` is already imported in this file — if not, add `import { useUiStore } from "../../app/store";`.)

- [ ] **Step 6: Run shortcuts + full frontend suite**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run`
Expected: PASS (entire frontend suite green, no OOM).

- [ ] **Step 7: Type-check and build**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm run build`
Expected: `tsc` + `vite build` succeed with no errors.

- [ ] **Step 8: Full workspace test**

Run: `cargo test --workspace`
Expected: PASS (GreenMail integration tests require Docker; if unavailable, note which were skipped and run `cargo test --workspace --lib`).

- [ ] **Step 9: Commit**

```bash
git add src/features/shortcuts/registry.ts src/features/shortcuts/registry.test.ts src/features/shortcuts/ShortcutsProvider.tsx src/features/shortcuts/CommandPalette.tsx
git commit -m "feat(ui): activate search shortcut and command palette entry"
```

---

## Notes for the implementer

- **Spec realization detail:** the design lists two index hooks (`index_message` for headers, `index_body` for body). This plan realizes both with a single canonical `reindex_message` that reconstructs the FTS row from the `messages` / `message_bodies` / `attachments` tables. This is strictly safer (it never indexes stale or empty header fields such as `to_addresses`, which is empty at envelope time and only populated when the body is fetched) and DRY-er. Behavior matches the spec: headers searchable always, body searchable once fetched.
- **Why index inside `insert_headers` (am-storage) rather than at the 3 `am-sync` call sites:** one atomic point of truth, no missed call site, runs in the same transaction as the insert.
- **No new IPC type:** results are `SmartMessageRow`, already exported in bindings.
- **No new lucide icon** is introduced, so `src/test/lucide-stub.js` does not change. If you find yourself importing a new icon, stop and use a text glyph (or add it to the stub) — a new icon left out of the stub OOMs vitest.
