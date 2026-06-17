# Etap 3A — Sync Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decode header text correctly (RFC2047), persist threading headers, back-fill snippet/attachments on body fetch, and sync every folder (not just INBOX).

**Architecture:** Add a `V2` migration for the new columns. Put RFC2047 decoding in `am-mime` (a pure function with unit tests) and consume it from `am-protocols` when mapping ENVELOPE bytes. Generalize the INBOX-only sync into a per-folder routine reused for all folders.

**Tech Stack:** Rust (rusqlite, refinery, async-imap 0.11, mail-parser 0.11, encoding_rs, base64), workspace crates am-core/am-storage/am-mime/am-protocols/am-sync.

## Global Constraints

- Node >= 24 (`$HOME/.nvm/versions/node/v24.14.0/bin`) for any frontend/tooling step — not needed in 3A but applies workspace-wide.
- All identifiers, constants, and DB strings in English. No code comments.
- Conventional Commits; no `Co-Authored-By`; never `git push` unless asked.
- Secrets only in the OS keychain; never log or serialize passwords.
- Tests must pass with `cargo test --workspace`; GreenMail tests skip gracefully when Docker is absent (mirror `crates/am-sync/tests/sync_greenmail.rs`).

---

### Task 1: Migration V2 — new columns + folder sync markers

**Files:**
- Create: `crates/am-storage/src/migrations/V2__etap3_sync.sql`
- Modify: `crates/am-storage/src/db.rs` (add a test)
- Modify: `crates/am-storage/src/folders_repo.rs` (add sync-marker helpers)

**Interfaces:**
- Produces: `folders_repo::set_sync_markers(db, folder_id, uidvalidity, uidnext, highestmodseq: Option<i64>, last_synced_at: i64) -> Result<(), StorageError>`
- Produces: `folders_repo::get_sync_markers(db, folder_id) -> Result<SyncMarkers, StorageError>` where `pub struct SyncMarkers { pub uidvalidity: Option<i64>, pub uidnext: Option<i64>, pub highestmodseq: Option<i64> }`

- [ ] **Step 1: Write the migration SQL**

```sql
ALTER TABLE folders ADD COLUMN highestmodseq INTEGER;
ALTER TABLE folders ADD COLUMN last_synced_at INTEGER;

ALTER TABLE messages ADD COLUMN references_hdr TEXT;
ALTER TABLE messages ADD COLUMN in_reply_to TEXT;
```

- [ ] **Step 2: Write the failing test in `db.rs` tests module**

```rust
#[test]
fn migration_v2_adds_sync_columns() {
    let db = Database::open_in_memory().unwrap();
    let conn = db.conn();
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('folders') WHERE name IN ('highestmodseq','last_synced_at')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 2);
    let msg_cols: i64 = conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('messages') WHERE name IN ('references_hdr','in_reply_to')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(msg_cols, 2);
}
```

- [ ] **Step 3: Run it — expect PASS** (refinery auto-discovers `V2__*.sql`)

Run: `cargo test -p am-storage migration_v2_adds_sync_columns`
Expected: PASS. If FAIL, confirm the file is under `src/migrations/` and named `V2__etap3_sync.sql`.

- [ ] **Step 4: Add the folder sync-marker helpers to `folders_repo.rs`**

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncMarkers {
    pub uidvalidity: Option<i64>,
    pub uidnext: Option<i64>,
    pub highestmodseq: Option<i64>,
}

pub fn set_sync_markers(
    db: &Database,
    folder_id: i64,
    uidvalidity: i64,
    uidnext: i64,
    highestmodseq: Option<i64>,
    last_synced_at: i64,
) -> Result<(), StorageError> {
    let conn = db.conn();
    let changed = conn.execute(
        "UPDATE folders SET uidvalidity = ?2, uidnext = ?3, highestmodseq = ?4, last_synced_at = ?5 WHERE id = ?1",
        params![folder_id, uidvalidity, uidnext, highestmodseq, last_synced_at],
    )?;
    if changed == 0 {
        return Err(StorageError::NotFound);
    }
    Ok(())
}

pub fn get_sync_markers(db: &Database, folder_id: i64) -> Result<SyncMarkers, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT uidvalidity, uidnext, highestmodseq FROM folders WHERE id = ?1",
        params![folder_id],
        |row| {
            Ok(SyncMarkers {
                uidvalidity: row.get(0)?,
                uidnext: row.get(1)?,
                highestmodseq: row.get(2)?,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
        other => StorageError::Sqlite(other),
    })
}
```

- [ ] **Step 5: Write tests for the helpers in `folders_repo.rs` tests module**

```rust
#[test]
fn sync_markers_roundtrip() {
    let db = Database::open_in_memory().unwrap();
    let account = insert_account(&db, &sample_account()).unwrap();
    let folder = upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
    set_sync_markers(&db, folder.id, 555, 42, Some(900), 1718600000).unwrap();
    let markers = get_sync_markers(&db, folder.id).unwrap();
    assert_eq!(markers.uidvalidity, Some(555));
    assert_eq!(markers.uidnext, Some(42));
    assert_eq!(markers.highestmodseq, Some(900));
}

#[test]
fn sync_markers_missing_highestmodseq_is_none() {
    let db = Database::open_in_memory().unwrap();
    let account = insert_account(&db, &sample_account()).unwrap();
    let folder = upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
    set_sync_markers(&db, folder.id, 1, 2, None, 100).unwrap();
    assert_eq!(get_sync_markers(&db, folder.id).unwrap().highestmodseq, None);
}
```

- [ ] **Step 6: Run tests — expect PASS**

Run: `cargo test -p am-storage folders_repo`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/am-storage/src/migrations/V2__etap3_sync.sql crates/am-storage/src/db.rs crates/am-storage/src/folders_repo.rs
git commit -m "feat(storage): add V2 migration and folder sync markers"
```

---

### Task 2: RFC2047 encoded-word decoder in am-mime

**Files:**
- Create: `crates/am-mime/src/rfc2047.rs`
- Modify: `crates/am-mime/src/lib.rs` (add `pub mod rfc2047;`)
- Modify: `crates/am-mime/Cargo.toml` (add `encoding_rs`, `base64`)

**Interfaces:**
- Produces: `am_mime::rfc2047::decode(input: &str) -> String` — decodes any `=?charset?B/Q?...?=` encoded-words in `input`, leaves the rest verbatim, never panics; on unknown charset or malformed token returns that token unchanged.

- [ ] **Step 1: Add dependencies to `crates/am-mime/Cargo.toml`**

```toml
[dependencies]
mail-parser.workspace = true
ammonia.workspace = true
serde.workspace = true
specta.workspace = true
encoding_rs = "0.8"
base64 = "0.22"
```

- [ ] **Step 2: Write the failing tests in `crates/am-mime/src/rfc2047.rs`**

```rust
use base64::Engine;

#[cfg(test)]
mod tests {
    use super::decode;

    #[test]
    fn plain_text_passthrough() {
        assert_eq!(decode("Just a subject"), "Just a subject");
    }

    #[test]
    fn utf8_quoted_printable() {
        assert_eq!(decode("=?utf-8?Q?Hello_=C5=9Awiat?="), "Hello Świat");
    }

    #[test]
    fn utf8_base64() {
        assert_eq!(decode("=?UTF-8?B?SGVsbG8gd29ybGQ=?="), "Hello world");
    }

    #[test]
    fn iso_8859_1_quoted_printable() {
        assert_eq!(decode("=?ISO-8859-1?Q?caf=E9?="), "café");
    }

    #[test]
    fn adjacent_words_join_without_separating_whitespace() {
        assert_eq!(
            decode("=?utf-8?B?SGVsbG8g?= =?utf-8?B?d29ybGQ=?="),
            "Hello world"
        );
    }

    #[test]
    fn mixed_plain_and_encoded() {
        assert_eq!(decode("Re: =?utf-8?Q?test?= done"), "Re: test done");
    }

    #[test]
    fn malformed_token_returned_verbatim() {
        assert_eq!(decode("=?utf-8?X?broken?="), "=?utf-8?X?broken?=");
        assert_eq!(decode("=?notacharset?Q?x?="), "=?notacharset?Q?x?=");
    }
}
```

- [ ] **Step 3: Run — expect FAIL** (`decode` not defined)

Run: `cargo test -p am-mime rfc2047`
Expected: FAIL (cannot find function `decode`).

- [ ] **Step 4: Implement the decoder**

```rust
use base64::Engine;

pub fn decode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    let mut last_was_encoded_word = false;

    while let Some(start) = rest.find("=?") {
        let (before, tail) = rest.split_at(start);
        let between_is_whitespace = before.trim().is_empty() && !before.is_empty();
        if !(last_was_encoded_word && between_is_whitespace) {
            out.push_str(before);
        }

        match parse_encoded_word(tail) {
            Some((decoded, consumed)) => {
                out.push_str(&decoded);
                rest = &tail[consumed..];
                last_was_encoded_word = true;
            }
            None => {
                out.push_str("=?");
                rest = &tail[2..];
                last_was_encoded_word = false;
            }
        }
    }
    out.push_str(rest);
    out
}

fn parse_encoded_word(s: &str) -> Option<(String, usize)> {
    let end = s.find("?=")? + 2;
    let token = &s[..end];
    let inner = &token[2..token.len() - 2];
    let mut parts = inner.splitn(3, '?');
    let charset = parts.next()?;
    let encoding = parts.next()?;
    let payload = parts.next()?;
    if payload.contains('?') {
        return None;
    }

    let bytes = match encoding.to_ascii_uppercase().as_str() {
        "B" => base64::engine::general_purpose::STANDARD
            .decode(payload.trim())
            .ok()?,
        "Q" => decode_q(payload),
        _ => return None,
    };

    let enc = encoding_rs::Encoding::for_label(charset.as_bytes())?;
    let (decoded, _, _) = enc.decode(&bytes);
    Some((decoded.into_owned(), end))
}

fn decode_q(payload: &str) -> Vec<u8> {
    let bytes = payload.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'_' => {
                out.push(b' ');
                i += 1;
            }
            b'=' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(h), Some(l)) => {
                        out.push((h * 16 + l) as u8);
                        i += 3;
                    }
                    _ => {
                        out.push(b'=');
                        i += 1;
                    }
                }
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    out
}
```

Then add `pub mod rfc2047;` to `crates/am-mime/src/lib.rs`.

- [ ] **Step 5: Run — expect PASS**

Run: `cargo test -p am-mime rfc2047`
Expected: PASS (all 7 tests).

- [ ] **Step 6: Commit**

```bash
git add crates/am-mime/src/rfc2047.rs crates/am-mime/src/lib.rs crates/am-mime/Cargo.toml Cargo.lock
git commit -m "feat(mime): add RFC2047 encoded-word decoder"
```

---

### Task 3: Decode headers + capture References/In-Reply-To in am-protocols

**Files:**
- Modify: `crates/am-protocols/Cargo.toml` (depend on `am-mime`)
- Modify: `crates/am-protocols/src/imap.rs` (`FetchedHeader`, `map_header`, fetch query, add `parse_references`)

**Interfaces:**
- Produces (extended struct): `FetchedHeader` gains `pub in_reply_to: Option<String>` and `pub references: Vec<String>`.
- Produces: `parse_references(raw: &str) -> Vec<String>` (pure, unit-tested) — extracts angle-bracketed message-ids from a References header value.

- [ ] **Step 1: Add the am-mime dependency**

In `crates/am-protocols/Cargo.toml` under `[dependencies]` add:

```toml
am-mime = { path = "../am-mime" }
```

- [ ] **Step 2: Write the failing test for `parse_references` in `imap.rs` tests module**

```rust
#[test]
fn parse_references_extracts_all_ids() {
    let raw = "<a@x.com> <b@y.com>\r\n <c@z.com>";
    assert_eq!(
        parse_references(raw),
        vec!["<a@x.com>".to_string(), "<b@y.com>".to_string(), "<c@z.com>".to_string()]
    );
}

#[test]
fn parse_references_empty_when_none() {
    assert!(parse_references("   ").is_empty());
}
```

- [ ] **Step 3: Run — expect FAIL**

Run: `cargo test -p am-protocols parse_references`
Expected: FAIL (function not found).

- [ ] **Step 4: Implement `parse_references` and extend `FetchedHeader`**

Add the struct fields to `FetchedHeader`:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedHeader {
    pub uid: i64,
    pub message_id_hdr: Option<String>,
    pub from_address: String,
    pub from_name: Option<String>,
    pub subject: String,
    pub date: i64,
    pub seen: bool,
    pub flagged: bool,
    pub size: i64,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
}
```

Add the helper:

```rust
fn parse_references(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = raw;
    while let Some(open) = rest.find('<') {
        let after = &rest[open..];
        if let Some(close) = after.find('>') {
            out.push(after[..=close].to_string());
            rest = &after[close + 1..];
        } else {
            break;
        }
    }
    out
}
```

- [ ] **Step 5: Apply RFC2047 decoding in `map_header` and parse the references header**

Replace the `decode_bytes` helper body so decoded header text passes through RFC2047:

```rust
fn decode_bytes(bytes: &[u8]) -> String {
    am_mime::rfc2047::decode(&String::from_utf8_lossy(bytes))
}
```

In `map_header`, derive `in_reply_to` from the envelope and `references` from the fetched header section. Add at the end of `map_header`, before constructing `FetchedHeader`:

```rust
    let in_reply_to = envelope
        .and_then(|e| e.in_reply_to.as_ref())
        .map(|s| decode_bytes(s))
        .filter(|s| !s.trim().is_empty());

    let references = fetch
        .header()
        .map(|h| parse_references(&String::from_utf8_lossy(h)))
        .unwrap_or_default();
```

and include `in_reply_to` and `references` in the returned struct literal.

- [ ] **Step 6: Extend the FETCH query to request the References header**

In `fetch_recent_headers`, change the query line to also peek the References header:

```rust
let query = "(UID ENVELOPE FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER.FIELDS (REFERENCES)])";
```

VERIFY: confirm `Fetch::header()` returns the `HEADER.FIELDS` section bytes for async-imap 0.11. Run a quick check: `cargo doc -p async-imap --no-deps` then grep the generated docs, or inspect `~/.cargo` source for `impl Fetch { pub fn header`. If the accessor differs (e.g. the section is exposed via a different method), adjust Step 5's `fetch.header()` call accordingly; the rest of the task is unaffected.

- [ ] **Step 7: Run protocol tests — expect PASS**

Run: `cargo test -p am-protocols`
Expected: PASS (unit tests; GreenMail test still skips without Docker).

- [ ] **Step 8: Commit**

```bash
git add crates/am-protocols/Cargo.toml crates/am-protocols/src/imap.rs Cargo.lock
git commit -m "feat(protocols): RFC2047-decode headers and capture references"
```

---

### Task 4: Persist threading headers + back-fill snippet/attachments on body fetch

**Files:**
- Modify: `crates/am-core/src/message.rs` (`NewMessageHeader` gains threading fields)
- Modify: `crates/am-storage/src/messages_repo.rs` (insert new columns; add `backfill_body_meta`)
- Create: `crates/am-storage/src/attachments_repo.rs`
- Modify: `crates/am-storage/src/lib.rs` (export `attachments_repo`)
- Modify: `crates/am-sync/src/service.rs` (`header_from_fetch`, `get_or_fetch_body` back-fill)

**Interfaces:**
- Consumes: `am_mime::parse::parse_message` (returns `snippet`, `attachment_names`), `FetchedHeader.in_reply_to/references` (Task 3).
- Produces: `messages_repo::backfill_body_meta(db, message_id, snippet: &str, has_attachments: bool) -> Result<(), StorageError>`
- Produces: `attachments_repo::replace_for_message(db, message_id, names: &[String]) -> Result<(), StorageError>`

- [ ] **Step 1: Extend `NewMessageHeader` in `am-core/src/message.rs`**

Add two fields after `message_id_hdr`:

```rust
    pub in_reply_to: Option<String>,
    pub references_hdr: Option<String>,
```

Update the roundtrip test struct literal and every existing constructor (compiler will point them out: `am-sync/src/service.rs::header_from_fetch`, test helpers in `messages_repo.rs`, `commands.rs` tests). Set both to `None` in test fixtures.

- [ ] **Step 2: Write the failing repo test in `messages_repo.rs`**

```rust
#[test]
fn backfill_body_meta_updates_snippet_and_attachments() {
    let db = Database::open_in_memory().unwrap();
    let folder_id = setup(&db);
    insert_headers(&db, folder_id, &[make_header(1, 1000)]).unwrap();
    let msg = list_by_folder(&db, folder_id, 1, 0).unwrap().into_iter().next().unwrap();
    backfill_body_meta(&db, msg.id, "new snippet", true).unwrap();
    let updated = get_header(&db, msg.id).unwrap();
    assert_eq!(updated.snippet, "new snippet");
    assert!(updated.has_attachments);
}
```

- [ ] **Step 3: Run — expect FAIL**

Run: `cargo test -p am-storage backfill_body_meta_updates`
Expected: FAIL (function not found). NOTE: also update `make_header` in this test module to set `in_reply_to: None, references_hdr: None`.

- [ ] **Step 4: Implement `backfill_body_meta` and extend `insert_headers`**

In `insert_headers`, add the two columns to the INSERT and bindings:

```rust
"INSERT OR IGNORE INTO messages
 (account_id, folder_id, uid, message_id_hdr, in_reply_to, references_hdr, from_address, from_name, subject, date, seen, flagged, has_attachments, size, snippet)
 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
```

```rust
let inserted = stmt.execute(params![
    account_id, folder_id, h.uid, h.message_id_hdr, h.in_reply_to, h.references_hdr,
    h.from_address, h.from_name, h.subject, h.date,
    h.seen as i64, h.flagged as i64, h.has_attachments as i64, h.size, h.snippet
])?;
```

Add the back-fill function:

```rust
pub fn backfill_body_meta(
    db: &Database,
    message_id: i64,
    snippet: &str,
    has_attachments: bool,
) -> Result<(), StorageError> {
    let conn = db.conn();
    let changed = conn.execute(
        "UPDATE messages SET snippet = ?2, has_attachments = ?3 WHERE id = ?1",
        params![message_id, snippet, has_attachments as i64],
    )?;
    if changed == 0 {
        return Err(StorageError::NotFound);
    }
    Ok(())
}
```

- [ ] **Step 5: Create `attachments_repo.rs`**

```rust
use rusqlite::params;

use crate::db::{Database, StorageError};

pub fn replace_for_message(
    db: &Database,
    message_id: i64,
    names: &[String],
) -> Result<(), StorageError> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM attachments WHERE message_id = ?1", params![message_id])?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO attachments (message_id, filename, mime_type, size) VALUES (?1, ?2, '', 0)",
        )?;
        for name in names {
            stmt.execute(params![message_id, name])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use crate::folders_repo::upsert_folder;
    use crate::messages_repo::{insert_headers, list_by_folder};
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::NewMessageHeader;
    use crate::db::Database;

    #[test]
    fn replace_for_message_is_idempotent() {
        let db = Database::open_in_memory().unwrap();
        let account = insert_account(&db, &NewAccount {
            email: "a@b.com".into(), display_name: "A".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        insert_headers(&db, folder.id, &[NewMessageHeader {
            uid: 1, message_id_hdr: None, in_reply_to: None, references_hdr: None,
            from_address: "a@b.com".into(), from_name: None, subject: "s".into(),
            date: 1, seen: false, flagged: false, has_attachments: false, size: 0, snippet: "".into(),
        }]).unwrap();
        let msg = list_by_folder(&db, folder.id, 1, 0).unwrap().into_iter().next().unwrap();
        replace_for_message(&db, msg.id, &["a.pdf".into(), "b.png".into()]).unwrap();
        replace_for_message(&db, msg.id, &["c.txt".into()]).unwrap();
        let conn = db.conn();
        let count: i64 = conn.query_row(
            "SELECT count(*) FROM attachments WHERE message_id = ?1", params![msg.id], |r| r.get(0),
        ).unwrap();
        assert_eq!(count, 1);
    }
}
```

Add `pub mod attachments_repo;` to `crates/am-storage/src/lib.rs`.

- [ ] **Step 6: Back-fill in `get_or_fetch_body` and carry threading headers in `header_from_fetch`**

In `am-sync/src/service.rs`, update `header_from_fetch`:

```rust
fn header_from_fetch(fetched: &FetchedHeader) -> NewMessageHeader {
    NewMessageHeader {
        uid: fetched.uid,
        message_id_hdr: fetched.message_id_hdr.clone(),
        in_reply_to: fetched.in_reply_to.clone(),
        references_hdr: if fetched.references.is_empty() {
            None
        } else {
            Some(fetched.references.join(" "))
        },
        from_address: fetched.from_address.clone(),
        from_name: fetched.from_name.clone(),
        subject: fetched.subject.clone(),
        date: fetched.date,
        seen: fetched.seen,
        flagged: fetched.flagged,
        has_attachments: false,
        size: fetched.size,
        snippet: String::new(),
    }
}
```

In `get_or_fetch_body`, after `messages_repo::store_body(...)`, add:

```rust
    messages_repo::backfill_body_meta(
        db,
        message_id,
        &parsed.snippet,
        !parsed.attachment_names.is_empty(),
    )?;
    am_storage::attachments_repo::replace_for_message(db, message_id, &parsed.attachment_names)?;
```

(`parsed` already holds `snippet` and `attachment_names` from `parse_message`.)

- [ ] **Step 7: Run workspace tests — expect PASS**

Run: `cargo test -p am-core -p am-storage -p am-sync`
Expected: PASS. Fix any remaining `NewMessageHeader` literals the compiler flags.

- [ ] **Step 8: Commit**

```bash
git add crates/am-core/src/message.rs crates/am-storage/src/messages_repo.rs crates/am-storage/src/attachments_repo.rs crates/am-storage/src/lib.rs crates/am-sync/src/service.rs
git commit -m "feat(sync): persist threading headers and back-fill snippet/attachments"
```

---

### Task 5: Generalize sync to every folder

**Files:**
- Modify: `crates/am-sync/src/service.rs` (`sync_folder`, `sync_all_folders`; `add_account` uses all-folders)
- Modify: `crates/am-sync/tests/sync_greenmail.rs` (assert a second folder syncs)

**Interfaces:**
- Produces: `sync_folder(db, account_id, folder_id, progress: impl Fn(SyncProgress)) -> Result<usize, SyncError>`
- Produces: `sync_all_folders(db, account_id, progress: impl Fn(SyncProgress) + Copy) -> Result<usize, SyncError>` (returns total inserted)
- Note: keep `initial_sync_inbox` as a thin wrapper that looks up the INBOX folder id and calls `sync_folder`, so existing callers/tests stay valid.

- [ ] **Step 1: Implement `sync_folder` by extracting the body of `initial_sync_inbox`**

```rust
pub async fn sync_folder(
    db: &Database,
    account_id: i64,
    folder_id: i64,
    progress: impl Fn(SyncProgress),
) -> Result<usize, SyncError> {
    let account = accounts_repo::get_account(db, account_id)?;
    let endpoints = load_endpoints(db, account_id)?;
    let password = am_auth::credentials::load_password(&account.email)?;
    let folder = folders_repo::get_folder(db, folder_id)?;

    let config = imap_config(&endpoints, &account.email);
    let mut session = ImapSession::connect(&config, &password).await?;
    let state = session.select(&folder.remote_path).await?;
    let fetched = session.fetch_recent_headers(INITIAL_SYNC_LIMIT).await?;
    session.logout().await?;

    let headers: Vec<NewMessageHeader> = fetched.iter().map(header_from_fetch).collect();
    let inserted = messages_repo::insert_headers(db, folder.id, &headers)?;

    folders_repo::set_sync_markers(db, folder.id, state.uidvalidity, state.uidnext, None, now_secs())?;
    let unread = fetched.iter().filter(|h| !h.seen).count() as i64;
    folders_repo::set_counts(db, folder.id, unread, state.exists)?;

    progress(SyncProgress {
        account_id,
        folder_id: folder.id,
        fetched: fetched.len() as i64,
        total: state.exists,
    });

    Ok(inserted)
}
```

Add a small time helper near the top of the file:

```rust
fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
```

- [ ] **Step 2: Reduce `initial_sync_inbox` to a wrapper and add `sync_all_folders`**

```rust
pub async fn initial_sync_inbox(
    db: &Database,
    account_id: i64,
    progress: impl Fn(SyncProgress),
) -> Result<usize, SyncError> {
    let folder = folders_repo::list_folders(db, account_id)?
        .into_iter()
        .find(|f| f.remote_path.eq_ignore_ascii_case(INBOX_PATH))
        .ok_or(SyncError::Storage(StorageError::NotFound))?;
    sync_folder(db, account_id, folder.id, progress).await
}

pub async fn sync_all_folders(
    db: &Database,
    account_id: i64,
    progress: impl Fn(SyncProgress) + Copy,
) -> Result<usize, SyncError> {
    let folders = folders_repo::list_folders(db, account_id)?;
    let mut total = 0usize;
    for folder in folders {
        total += sync_folder(db, account_id, folder.id, progress).await?;
    }
    Ok(total)
}
```

- [ ] **Step 3: Point `add_account` at all folders**

In `add_account`, replace `initial_sync_inbox(db, account.id, |_| {}).await?;` with:

```rust
    sync_all_folders(db, account.id, |_| {}).await?;
```

- [ ] **Step 4: Extend the GreenMail test to seed and assert a second folder**

In `crates/am-sync/tests/sync_greenmail.rs`, in `seed_messages`, after the INBOX appends, create and seed a second mailbox:

```rust
    session.create("Archive").await.ok();
    session
        .append("Archive", None, None, raw_message("Archived One", "archive marker ZETA").as_bytes())
        .await
        .expect("append to archive failed");
```

After the existing INBOX assertions in the test body, add:

```rust
    let archive = folders
        .iter()
        .find(|f| f.remote_path.eq_ignore_ascii_case("Archive"))
        .expect("archive folder missing");
    let archive_headers = messages_repo::list_by_folder(&db, archive.id, 50, 0).expect("archive list failed");
    assert_eq!(archive_headers.len(), 1, "expected 1 archived header");
    assert_eq!(archive_headers[0].subject, "Archived One");
```

- [ ] **Step 5: Run unit tests, then the integration test if Docker is available**

Run: `cargo test -p am-sync` (unit + integration; integration self-skips without Docker)
Expected: PASS. If Docker is running, the new Archive assertions must pass too.

- [ ] **Step 6: Commit**

```bash
git add crates/am-sync/src/service.rs crates/am-sync/tests/sync_greenmail.rs
git commit -m "feat(sync): sync every folder, not only INBOX"
```

---

## Self-Review

- **Spec coverage:** RFC2047 (Task 2–3), back-fill snippet/has_attachments + attachment metadata (Task 4), all-folders sync (Task 5), schema for incremental sync `highestmodseq`/`last_synced_at` and threading headers (Task 1, used in 3B/3C). IDLE, incremental algorithm, offline queue, events, threading UI are intentionally in plans 3B/3C.
- **Placeholder scan:** none — each step carries concrete code/SQL/commands. The single VERIFY note (Task 3 Step 6) is a real correctness check against the async-imap API, with a defined fallback, not a deferral.
- **Type consistency:** `NewMessageHeader` gains `in_reply_to`/`references_hdr` (Task 4) and every literal is updated in the same task; `FetchedHeader` gains `in_reply_to`/`references` (Task 3) consumed by `header_from_fetch` (Task 4); `SyncMarkers` fields match between producer and consumers.
