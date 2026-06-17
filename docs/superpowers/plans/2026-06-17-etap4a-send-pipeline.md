# Etap 4A — Send Pipeline (backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the offline-first outgoing pipeline: a canonical RFC822 message built once, sent via SMTP, and APPENDed to the Sent folder — driven by an outbox queue drained by the existing background worker.

**Architecture:** `am-mime` builds the raw RFC822 bytes (mail-builder); `am-protocols::smtp` sends those bytes via `lettre` `send_raw`; `ImapSession::append` writes the same bytes to Sent. A draft is persisted (messages + message_bodies + attachments); `enqueue_send` queues a `send_message` op; the per-account worker's new `drain_outbox` builds → sends → APPENDs → deletes the draft.

**Tech Stack:** Rust (rusqlite, async-imap 0.11.2, lettre, mail-builder, mail-parser), workspace crates am-core/am-storage/am-mime/am-protocols/am-sync/am-app.

## Global Constraints

- Node >= 24 (`$HOME/.nvm/versions/node/v24.14.0/bin`) for any frontend/binding step (4A is backend; bindings regen at the end).
- English-only identifiers/constants/DB strings. No code comments.
- Conventional Commits; no `Co-Authored-By`; never `git push` unless asked.
- Secrets only in the OS keychain; passwords never logged, never in errors/events/Debug.
- BCC recipients go ONLY into the SMTP envelope — never into the message headers.
- SMTP uses password auth (LOGIN/PLAIN) over TLS, same keychain password as IMAP; rustls/ring provider (matches IMAP, validates certs). XOAUTH2 is Etap 5.
- `am-sync` stays Tauri-free (emits via `SyncEventSink`).
- `cargo test --workspace` green; GreenMail integration tests skip gracefully without Docker (mirror `crates/am-sync/tests/sync_greenmail.rs`).

---

### Task 1: Add lettre + mail-builder dependencies

**Files:**
- Modify: `Cargo.toml` (workspace `[workspace.dependencies]`)
- Modify: `crates/am-mime/Cargo.toml`, `crates/am-protocols/Cargo.toml`

**Interfaces:**
- Produces: `lettre` available to am-protocols; `mail-builder` available to am-mime.

- [ ] **Step 1: Add to `[workspace.dependencies]` in root `Cargo.toml`**

```toml
lettre = { version = "0.11", default-features = false, features = ["smtp-transport", "tokio1-rustls-tls", "ring", "builder", "tokio1"] }
mail-builder = "0.4"
```

VERIFY: confirm the exact lettre 0.11 feature names against `cargo add lettre --dry-run` or docs. The intent: async SMTP transport over rustls with the ring backend (to match am-protocols' existing `rustls` ring features) + the `Message`/`Envelope` builder. If a feature name differs (e.g. the rustls/ring feature is spelled differently in 0.11), adjust to the set that compiles with rustls+ring and async tokio. Do NOT pull in native-tls/openssl.

- [ ] **Step 2: Reference them in the crates**

In `crates/am-mime/Cargo.toml` `[dependencies]` add: `mail-builder = { workspace = true }`.
In `crates/am-protocols/Cargo.toml` `[dependencies]` add: `lettre = { workspace = true }`.

- [ ] **Step 3: Verify the workspace builds**

Run: `cargo build -p am-mime -p am-protocols`
Expected: compiles (no usage yet). If lettre's TLS feature fails to resolve, fix the feature set per the VERIFY note before proceeding.

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml crates/am-mime/Cargo.toml crates/am-protocols/Cargo.toml Cargo.lock
git commit -m "build: add lettre and mail-builder dependencies"
```

---

### Task 2: Migration V4 — BCC column

**Files:**
- Create: `crates/am-storage/src/migrations/V4__outgoing.sql`
- Modify: `crates/am-storage/src/db.rs` (test)

**Interfaces:**
- Produces: `messages.bcc_addresses TEXT NOT NULL DEFAULT '[]'` (to_addresses/cc_addresses already exist).

- [ ] **Step 1: Write the migration**

```sql
ALTER TABLE messages ADD COLUMN bcc_addresses TEXT NOT NULL DEFAULT '[]';
```

- [ ] **Step 2: Write the test in `db.rs` tests module**

```rust
#[test]
fn migration_v4_adds_bcc_column() {
    let db = Database::open_in_memory().unwrap();
    let conn = db.conn();
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('messages') WHERE name = 'bcc_addresses'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}
```

- [ ] **Step 3: Run — expect PASS**

Run: `cargo test -p am-storage migration_v4_adds_bcc_column`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/am-storage/src/migrations/V4__outgoing.sql crates/am-storage/src/db.rs
git commit -m "feat(storage): add V4 migration for bcc column"
```

---

### Task 3: OutgoingMessage domain types

**Files:**
- Create: `crates/am-core/src/outgoing.rs`
- Modify: `crates/am-core/src/lib.rs` (`pub mod outgoing;`)

**Interfaces:**
- Produces:
```rust
pub struct OutgoingAttachment {
    pub filename: String,
    pub mime_type: String,
    pub blob_ref: String,      // path on disk
    pub content_id: Option<String>, // Some(...) => inline (cid:), used in 4C
}
pub struct OutgoingMessage {
    pub from_address: String,
    pub from_name: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub text_body: String,
    pub html_body: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub attachments: Vec<OutgoingAttachment>,
}
```

- [ ] **Step 1: Write the types with derives + a roundtrip test**

```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct OutgoingAttachment {
    pub filename: String,
    pub mime_type: String,
    pub blob_ref: String,
    pub content_id: Option<String>,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct OutgoingMessage {
    pub from_address: String,
    pub from_name: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub text_body: String,
    pub html_body: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub attachments: Vec<OutgoingAttachment>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outgoing_message_roundtrips_through_json() {
        let m = OutgoingMessage {
            from_address: "me@example.com".into(),
            from_name: Some("Me".into()),
            to: vec!["a@x.com".into()],
            cc: vec![],
            bcc: vec!["secret@x.com".into()],
            subject: "Hi".into(),
            text_body: "hello".into(),
            html_body: Some("<p>hello</p>".into()),
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
        };
        let json = serde_json::to_string(&m).unwrap();
        let back: OutgoingMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(m, back);
    }
}
```

Add `pub mod outgoing;` to `crates/am-core/src/lib.rs`.

- [ ] **Step 2: Run — expect PASS**

Run: `cargo test -p am-core outgoing`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/am-core/src/outgoing.rs crates/am-core/src/lib.rs
git commit -m "feat(core): add OutgoingMessage domain types"
```

---

### Task 4: Build canonical RFC822 (am-mime compose)

**Files:**
- Create: `crates/am-mime/src/compose.rs`
- Modify: `crates/am-mime/src/lib.rs` (`pub mod compose;`)

**Interfaces:**
- Consumes: `am_core::outgoing::{OutgoingMessage, OutgoingAttachment}`, `crate::sanitize::sanitize_html`.
- Produces: `build_message(msg: &OutgoingMessage) -> Vec<u8>` — RFC822 bytes; `text/plain` + (sanitized) `text/html` → `multipart/alternative`; with attachments → `multipart/mixed`. BCC is NOT written into headers. Inline (cid:) is handled in 4C and may be ignored here (attachments with `content_id` are still attached as regular parts in 4A).

- [ ] **Step 1: Add `mail-builder` to am-mime (done in Task 1) and write the test**

```rust
#[cfg(test)]
mod tests {
    use super::build_message;
    use am_core::outgoing::{OutgoingMessage, OutgoingAttachment};
    use mail_parser::MessageParser;

    fn base() -> OutgoingMessage {
        OutgoingMessage {
            from_address: "me@example.com".into(),
            from_name: Some("Me Sender".into()),
            to: vec!["rcpt@example.com".into()],
            cc: vec![],
            bcc: vec!["hidden@example.com".into()],
            subject: "Subject Z".into(),
            text_body: "plain body".into(),
            html_body: Some("<p>html body</p>".into()),
            in_reply_to: Some("<parent@example.com>".into()),
            references: vec!["<a@x>".into(), "<parent@example.com>".into()],
            attachments: vec![],
        }
    }

    #[test]
    fn builds_alternative_with_headers_and_bodies() {
        let bytes = build_message(&base());
        let parsed = MessageParser::default().parse(&bytes).unwrap();
        assert_eq!(parsed.subject().unwrap(), "Subject Z");
        assert_eq!(parsed.to().unwrap().first().unwrap().address().unwrap(), "rcpt@example.com");
        assert!(parsed.body_text(0).is_some());
        assert!(parsed.body_html(0).is_some());
    }

    #[test]
    fn bcc_is_not_written_into_headers() {
        let bytes = build_message(&base());
        let text = String::from_utf8_lossy(&bytes).to_lowercase();
        assert!(!text.contains("hidden@example.com"), "BCC leaked into headers");
    }

    #[test]
    fn references_and_in_reply_to_present() {
        let bytes = build_message(&base());
        let parsed = MessageParser::default().parse(&bytes).unwrap();
        assert_eq!(parsed.in_reply_to().as_text().unwrap(), "<parent@example.com>");
    }

    #[test]
    fn attachment_is_included() {
        let mut m = base();
        m.attachments.push(OutgoingAttachment {
            filename: "note.txt".into(),
            mime_type: "text/plain".into(),
            blob_ref: String::new(),
            content_id: None,
        });
        // build_message reads attachment bytes from blob_ref; for the test, point it at a temp file
        let dir = std::env::temp_dir().join(format!("am-attach-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("note.txt");
        std::fs::write(&path, b"ATTACHMENT DATA").unwrap();
        m.attachments[0].blob_ref = path.to_string_lossy().into_owned();
        let bytes = build_message(&m);
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("note.txt"));
    }
}
```

- [ ] **Step 2: Run — expect FAIL** (build_message undefined)

Run: `cargo test -p am-mime compose`
Expected: FAIL.

- [ ] **Step 3: Implement with mail-builder**

```rust
use am_core::outgoing::OutgoingMessage;
use mail_builder::MessageBuilder;
use mail_builder::headers::address::Address;

use crate::sanitize::sanitize_html;

pub fn build_message(msg: &OutgoingMessage) -> Vec<u8> {
    let mut builder = MessageBuilder::new();

    let from = match &msg.from_name {
        Some(name) => Address::new_address(Some(name.clone()), msg.from_address.clone()),
        None => Address::new_address(None::<String>, msg.from_address.clone()),
    };
    builder = builder.from(from);
    builder = builder.to(msg.to.clone());
    if !msg.cc.is_empty() {
        builder = builder.cc(msg.cc.clone());
    }
    builder = builder.subject(msg.subject.clone());
    if let Some(irt) = &msg.in_reply_to {
        builder = builder.in_reply_to(irt.clone());
    }
    if !msg.references.is_empty() {
        builder = builder.references(msg.references.clone());
    }

    builder = builder.text_body(msg.text_body.clone());
    if let Some(html) = &msg.html_body {
        let safe = sanitize_html(html);
        builder = builder.html_body(safe.html);
    }

    for att in &msg.attachments {
        let data = std::fs::read(&att.blob_ref).unwrap_or_default();
        builder = builder.attachment(att.mime_type.clone(), att.filename.clone(), data);
    }

    builder.write_to_vec().unwrap_or_default()
}
```

VERIFY: mail-builder 0.4 API — confirm `MessageBuilder::from/to/cc/subject/in_reply_to/references/text_body/html_body/attachment/write_to_vec` and the `Address` constructor names against docs (`cargo doc -p mail-builder --no-deps`). The `to(Vec<String>)` / address helpers may differ (e.g. `.to(vec![Address::new_address(...)])`); adjust to the real API while keeping behavior: a multipart/alternative message (text + sanitized html), attachments wrapping it in multipart/mixed, BCC omitted, In-Reply-To/References headers present. Note any deviation.

Add `pub mod compose;` to `crates/am-mime/src/lib.rs`.

- [ ] **Step 4: Run — expect PASS**

Run: `cargo test -p am-mime compose`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/am-mime/src/compose.rs crates/am-mime/src/lib.rs
git commit -m "feat(mime): build canonical RFC822 outgoing message"
```

---

### Task 5: SMTP transport + IMAP append

**Files:**
- Create: `crates/am-protocols/src/smtp.rs`
- Modify: `crates/am-protocols/src/lib.rs` (`pub mod smtp;`)
- Modify: `crates/am-protocols/src/imap.rs` (`append`)

**Interfaces:**
- Produces:
```rust
pub struct SmtpConfig { pub host: String, pub port: u16, pub tls: bool, pub username: String }
pub async fn send_raw(config: &SmtpConfig, password: &str, from: &str, recipients: &[String], bytes: &[u8]) -> Result<(), ProtocolError>;
// imap.rs:
impl ImapSession { pub async fn append(&mut self, folder: &str, flags: &str, bytes: &[u8]) -> Result<(), ProtocolError>; }
```

- [ ] **Step 1: Implement `smtp.rs`**

```rust
use std::str::FromStr;

use lettre::address::Envelope;
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::AsyncSmtpTransport;
use lettre::{Address, AsyncTransport, Tokio1Executor};

use crate::error::ProtocolError;

pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub username: String,
}

pub async fn send_raw(
    config: &SmtpConfig,
    password: &str,
    from: &str,
    recipients: &[String],
    bytes: &[u8],
) -> Result<(), ProtocolError> {
    let from_addr = Address::from_str(from).map_err(|e| ProtocolError::Protocol(e.to_string()))?;
    let mut to_addrs = Vec::with_capacity(recipients.len());
    for r in recipients {
        to_addrs.push(Address::from_str(r).map_err(|e| ProtocolError::Protocol(e.to_string()))?);
    }
    let envelope = Envelope::new(Some(from_addr), to_addrs)
        .map_err(|e| ProtocolError::Protocol(e.to_string()))?;

    let builder = if config.tls && config.port == 587 {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.host)
            .map_err(|e| ProtocolError::Tls(e.to_string()))?
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&config.host)
            .map_err(|e| ProtocolError::Tls(e.to_string()))?
    };
    let transport = builder
        .port(config.port)
        .credentials(Credentials::new(config.username.clone(), password.to_string()))
        .build();

    transport
        .send_raw(&envelope, bytes)
        .await
        .map(|_| ())
        .map_err(|e| ProtocolError::Protocol(e.to_string()))
}
```

VERIFY: lettre 0.11 async SMTP API. Confirm `AsyncSmtpTransport::<Tokio1Executor>::relay`/`starttls_relay`, `.port()`, `.credentials()`, `.build()`, and `AsyncTransport::send_raw(&Envelope, &[u8])`. For GreenMail (no TLS, port 3025) a plaintext transport is needed — also add a `builder` branch using `AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&config.host)` when `!config.tls`, so the integration test can connect without TLS. Adjust method names to the installed version; keep the signature fixed.

Add `pub mod smtp;` to `crates/am-protocols/src/lib.rs`.

- [ ] **Step 2: Add `append` to `imap.rs`**

```rust
impl ImapSession {
    pub async fn append(&mut self, folder: &str, flags: &str, bytes: &[u8]) -> Result<(), ProtocolError> {
        match &mut self.session {
            SessionStream::Plain(s) => s.append(folder, bytes).flags(flags).finish().await?,
            SessionStream::Tls(s) => s.append(folder, bytes).flags(flags).finish().await?,
        };
        Ok(())
    }
}
```

VERIFY: async-imap 0.11.2 append API. It is likely a builder: `session.append(mailbox, content)` returning an `AppendCmd` with `.flags(...)` / `.finish().await`, OR a direct `session.append(mailbox, flags, date, content).await`. Inspect `~/.cargo/registry/src/*/async-imap-0.11.2/src/` for the `append` signature and adjust this call to match while keeping `append(&mut self, folder, flags, bytes)`. If flags must be a typed slice rather than a string, accept `&str` here and convert internally.

- [ ] **Step 3: Build**

Run: `cargo build -p am-protocols`
Expected: compiles. (Behavior covered by the 4A-8 GreenMail e2e.)

- [ ] **Step 4: Commit**

```bash
git add crates/am-protocols/src/smtp.rs crates/am-protocols/src/lib.rs crates/am-protocols/src/imap.rs Cargo.lock
git commit -m "feat(protocols): add SMTP send_raw and IMAP append"
```

---

### Task 6: drafts_repo

**Files:**
- Create: `crates/am-storage/src/drafts_repo.rs`
- Modify: `crates/am-storage/src/lib.rs` (`pub mod drafts_repo;`)

**Interfaces:**
- Consumes: `am_core::outgoing::{OutgoingMessage, OutgoingAttachment}`, `folders_repo::upsert_folder`.
- Produces:
```rust
pub fn ensure_drafts_folder(db, account_id: i64) -> Result<i64, StorageError>; // folder_type=drafts, remote_path "Drafts"; idempotent
pub fn save_draft(db, account_id: i64, draft_id: Option<i64>, msg: &OutgoingMessage) -> Result<i64, StorageError>; // upsert messages(draft=1)+message_bodies+attachments; returns draft message id
pub fn get_draft(db, draft_id: i64) -> Result<(i64, OutgoingMessage), StorageError>; // (account_id, message)
pub fn list_draft_ids(db, account_id: i64) -> Result<Vec<i64>, StorageError>;
pub fn delete_draft(db, draft_id: i64) -> Result<(), StorageError>; // cascades bodies/attachments via FK
```

- [ ] **Step 1: Write the test (roundtrip)**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use crate::db::Database;
    use am_core::account::{NewAccount, ProviderType};
    use am_core::outgoing::OutgoingMessage;

    fn acct(db: &Database) -> i64 {
        insert_account(db, &NewAccount {
            email: "me@e.com".into(), display_name: "Me".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap().id
    }

    fn sample() -> OutgoingMessage {
        OutgoingMessage {
            from_address: "me@e.com".into(), from_name: Some("Me".into()),
            to: vec!["a@x.com".into()], cc: vec![], bcc: vec!["b@x.com".into()],
            subject: "Draft S".into(), text_body: "body".into(), html_body: Some("<p>body</p>".into()),
            in_reply_to: None, references: vec![], attachments: vec![],
        }
    }

    #[test]
    fn save_then_get_draft_roundtrips() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let id = save_draft(&db, account_id, None, &sample()).unwrap();
        let (got_account, got) = get_draft(&db, id).unwrap();
        assert_eq!(got_account, account_id);
        assert_eq!(got.subject, "Draft S");
        assert_eq!(got.to, vec!["a@x.com".to_string()]);
        assert_eq!(got.bcc, vec!["b@x.com".to_string()]);
        assert_eq!(got.text_body, "body");
        assert_eq!(got.html_body.as_deref(), Some("<p>body</p>"));
    }

    #[test]
    fn save_with_existing_id_updates_in_place() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let id = save_draft(&db, account_id, None, &sample()).unwrap();
        let mut m = sample();
        m.subject = "Updated".into();
        let id2 = save_draft(&db, account_id, Some(id), &m).unwrap();
        assert_eq!(id, id2);
        assert_eq!(get_draft(&db, id).unwrap().1.subject, "Updated");
        assert_eq!(list_draft_ids(&db, account_id).unwrap().len(), 1);
    }

    #[test]
    fn delete_draft_removes_it() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let id = save_draft(&db, account_id, None, &sample()).unwrap();
        delete_draft(&db, id).unwrap();
        assert!(list_draft_ids(&db, account_id).unwrap().is_empty());
    }
}
```

- [ ] **Step 2: Run — expect FAIL**, then implement

```rust
use rusqlite::params;
use am_core::outgoing::{OutgoingAttachment, OutgoingMessage};
use am_core::folder::FolderType;

use crate::db::{Database, StorageError};
use crate::folders_repo::upsert_folder;

pub fn ensure_drafts_folder(db: &Database, account_id: i64) -> Result<i64, StorageError> {
    Ok(upsert_folder(db, account_id, "Drafts", "Drafts", FolderType::Drafts)?.id)
}

pub fn save_draft(
    db: &Database,
    account_id: i64,
    draft_id: Option<i64>,
    msg: &OutgoingMessage,
) -> Result<i64, StorageError> {
    let folder_id = ensure_drafts_folder(db, account_id)?;
    let to = serde_json::to_string(&msg.to).unwrap_or_else(|_| "[]".into());
    let cc = serde_json::to_string(&msg.cc).unwrap_or_else(|_| "[]".into());
    let bcc = serde_json::to_string(&msg.bcc).unwrap_or_else(|_| "[]".into());
    let references = if msg.references.is_empty() { None } else { Some(msg.references.join(" ")) };

    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let id = match draft_id {
        Some(id) => {
            tx.execute(
                "UPDATE messages SET from_address=?2, from_name=?3, to_addresses=?4, cc_addresses=?5, bcc_addresses=?6, subject=?7, in_reply_to=?8, references_hdr=?9 WHERE id=?1 AND draft=1",
                params![id, msg.from_address, msg.from_name, to, cc, bcc, msg.subject, msg.in_reply_to, references],
            )?;
            id
        }
        None => {
            tx.execute(
                "INSERT INTO messages (account_id, folder_id, from_address, from_name, to_addresses, cc_addresses, bcc_addresses, subject, date, draft, in_reply_to, references_hdr)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?11)",
                params![account_id, folder_id, msg.from_address, msg.from_name, to, cc, bcc, msg.subject, crate::now_unused_placeholder(), msg.in_reply_to, references],
            )?;
            tx.last_insert_rowid()
        }
    };
    tx.execute(
        "INSERT INTO message_bodies (message_id, text_plain, text_html) VALUES (?1, ?2, ?3)
         ON CONFLICT(message_id) DO UPDATE SET text_plain=excluded.text_plain, text_html=excluded.text_html",
        params![id, msg.text_body, msg.html_body],
    )?;
    tx.execute("DELETE FROM attachments WHERE message_id = ?1", params![id])?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO attachments (message_id, filename, mime_type, size, content_id, blob_ref) VALUES (?1, ?2, ?3, 0, ?4, ?5)",
        )?;
        for att in &msg.attachments {
            stmt.execute(params![id, att.filename, att.mime_type, att.content_id, att.blob_ref])?;
        }
    }
    tx.commit()?;
    Ok(id)
}

pub fn get_draft(db: &Database, draft_id: i64) -> Result<(i64, OutgoingMessage), StorageError> {
    let conn = db.conn();
    let (account_id, from_address, from_name, to, cc, bcc, subject, in_reply_to, references): (i64, String, Option<String>, String, String, String, String, Option<String>, Option<String>) =
        conn.query_row(
            "SELECT account_id, from_address, from_name, to_addresses, cc_addresses, bcc_addresses, subject, in_reply_to, references_hdr FROM messages WHERE id=?1 AND draft=1",
            params![draft_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)),
        ).map_err(|e| match e { rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound, o => StorageError::Sqlite(o) })?;
    let (text_body, html_body): (Option<String>, Option<String>) = conn.query_row(
        "SELECT text_plain, text_html FROM message_bodies WHERE message_id=?1",
        params![draft_id], |r| Ok((r.get(0)?, r.get(1)?)),
    ).unwrap_or((None, None));
    let mut attachments = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT filename, mime_type, content_id, blob_ref FROM attachments WHERE message_id=?1")?;
        let rows = stmt.query_map(params![draft_id], |r| Ok(OutgoingAttachment {
            filename: r.get(0)?, mime_type: r.get(1)?, content_id: r.get(2)?, blob_ref: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
        }))?;
        for a in rows { attachments.push(a?); }
    }
    Ok((account_id, OutgoingMessage {
        from_address, from_name,
        to: serde_json::from_str(&to).unwrap_or_default(),
        cc: serde_json::from_str(&cc).unwrap_or_default(),
        bcc: serde_json::from_str(&bcc).unwrap_or_default(),
        subject,
        text_body: text_body.unwrap_or_default(),
        html_body,
        in_reply_to,
        references: references.map(|s| s.split_whitespace().map(String::from).collect()).unwrap_or_default(),
        attachments,
    }))
}

pub fn list_draft_ids(db: &Database, account_id: i64) -> Result<Vec<i64>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare("SELECT id FROM messages WHERE account_id=?1 AND draft=1 ORDER BY id DESC")?;
    let rows = stmt.query_map(params![account_id], |r| r.get::<_, i64>(0))?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

pub fn delete_draft(db: &Database, draft_id: i64) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute("DELETE FROM messages WHERE id=?1 AND draft=1", params![draft_id])?;
    Ok(())
}
```

NOTE: `messages.date` is `NOT NULL`. Replace the `crate::now_unused_placeholder()` call with an actual epoch-seconds value: add a private `fn now_secs() -> i64` to this module (copy the body from `am-sync`'s, using `std::time::SystemTime`) and bind `messages.date` to it on insert. Do not add a `crate::` helper that doesn't exist.

Add `pub mod drafts_repo;` to `crates/am-storage/src/lib.rs`.

- [ ] **Step 3: Run — expect PASS**

Run: `cargo test -p am-storage drafts_repo`
Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
git add crates/am-storage/src/drafts_repo.rs crates/am-storage/src/lib.rs
git commit -m "feat(storage): add drafts_repo (save/get/list/delete)"
```

---

### Task 7: Send orchestration + outbox drain + worker wiring

**Files:**
- Create: `crates/am-sync/src/send.rs`
- Modify: `crates/am-sync/src/lib.rs` (`pub mod send;`)
- Modify: `crates/am-sync/src/service.rs` (filter `drain_queue` to `set_flag` ops)
- Modify: `crates/am-sync/src/engine.rs` (call `drain_outbox` in the worker loop)

**Interfaces:**
- Consumes: `drafts_repo`, `am_mime::compose::build_message`, `am_protocols::smtp::{SmtpConfig, send_raw}`, `ImapSession::append`, `queue_repo`, `folders_repo`, `accounts_repo`, `am_auth::credentials::load_password`, `service::{now_secs, load_endpoints_pub}`.
- Produces:
```rust
pub fn enqueue_send(db, draft_id: i64) -> Result<(), SyncError>;
pub async fn drain_outbox(db, account_id: i64, now: i64) -> Result<(), SyncError>;
```

- [ ] **Step 1: Filter `drain_queue` to flag ops only**

In `service.rs` `drain_queue`, at the top of the `for op in due` loop add (so send ops are left for `drain_outbox`):

```rust
        if op.op_type != "set_flag" {
            continue;
        }
```

- [ ] **Step 2: Implement `send.rs`**

```rust
use am_protocols::smtp::{send_raw, SmtpConfig};
use am_protocols::imap::ImapSession;
use am_storage::{accounts_repo, drafts_repo, folders_repo, queue_repo, Database};
use am_core::folder::FolderType;

use crate::service::{now_secs, load_endpoints_pub, SyncError, imap_config_pub};

const MAX_SEND_ATTEMPTS: i64 = 6;

pub fn enqueue_send(db: &Database, draft_id: i64) -> Result<(), SyncError> {
    let (account_id, _msg) = drafts_repo::get_draft(db, draft_id)?;
    let payload = serde_json::json!({ "draft_id": draft_id }).to_string();
    queue_repo::enqueue(db, account_id, "send_message", &payload)?;
    Ok(())
}

fn smtp_config(endpoints: &am_auth::endpoints::Endpoints, username: &str) -> SmtpConfig {
    SmtpConfig {
        host: endpoints.smtp_host.clone(),
        port: endpoints.smtp_port,
        tls: endpoints.smtp_tls,
        username: username.to_string(),
    }
}

pub async fn drain_outbox(db: &Database, account_id: i64, now: i64) -> Result<(), SyncError> {
    let due = queue_repo::list_due(db, account_id, now)?;
    let send_ops: Vec<_> = due.into_iter().filter(|o| o.op_type == "send_message").collect();
    if send_ops.is_empty() {
        return Ok(());
    }

    let account = accounts_repo::get_account(db, account_id)?;
    let endpoints = load_endpoints_pub(db, account_id)?;
    let password = am_auth::credentials::load_password(&account.email)?;

    for op in send_ops {
        let parsed: serde_json::Value = match serde_json::from_str(&op.payload) {
            Ok(v) => v, Err(_) => { queue_repo::mark_done(db, op.id)?; continue; }
        };
        let draft_id = parsed["draft_id"].as_i64().unwrap_or(0);
        let (_acct, msg) = match drafts_repo::get_draft(db, draft_id) {
            Ok(v) => v, Err(_) => { queue_repo::mark_done(db, op.id)?; continue; }
        };

        let bytes = am_mime::compose::build_message(&msg);
        let mut recipients = msg.to.clone();
        recipients.extend(msg.cc.clone());
        recipients.extend(msg.bcc.clone());

        let smtp = smtp_config(&endpoints, &account.email);
        let send_result = send_raw(&smtp, &password, &msg.from_address, &recipients, &bytes).await;

        match send_result {
            Ok(()) => {
                if let Some(sent) = folders_repo::list_folders(db, account_id)?
                    .into_iter()
                    .find(|f| f.folder_type == FolderType::Sent)
                {
                    let config = imap_config_pub(&endpoints, &account.email);
                    if let Ok(mut session) = ImapSession::connect(&config, &password).await {
                        let _ = session.append(&sent.remote_path, "\\Seen", &bytes).await;
                        let _ = session.logout().await;
                    }
                }
                drafts_repo::delete_draft(db, draft_id)?;
                queue_repo::mark_done(db, op.id)?;
            }
            Err(_) if op.attempts + 1 >= MAX_SEND_ATTEMPTS => queue_repo::mark_done(db, op.id)?,
            Err(_) => {
                let backoff = now + 2i64.pow((op.attempts + 1).min(5) as u32) * 30;
                queue_repo::mark_retry(db, op.id, backoff)?;
            }
        }
    }
    Ok(())
}
```

Add `pub mod send;` to `crates/am-sync/src/lib.rs`.

- [ ] **Step 3: Call `drain_outbox` in the worker loop**

In `engine.rs`, right after the existing `let _ = service::drain_queue(&db, account_id, now).await;` line, add:

```rust
                let _ = service::send::drain_outbox(&db, account_id, now).await;
```

VERIFY the path: `send` is a module of `am-sync` (`crate::send`), referenced from `engine.rs` as `crate::send::drain_outbox` (not `service::send`). Use the correct path that compiles.

- [ ] **Step 4: Build + run am-sync tests**

Run: `cargo build -p am-sync && cargo test -p am-sync`
Expected: compiles; existing tests still pass. (Behavior covered by 4A-8.)

- [ ] **Step 5: Commit**

```bash
git add crates/am-sync/src/send.rs crates/am-sync/src/lib.rs crates/am-sync/src/service.rs crates/am-sync/src/engine.rs
git commit -m "feat(sync): outbox send drain (SMTP + Sent append) and worker wiring"
```

---

### Task 8: enqueue_send command + GreenMail e2e

**Files:**
- Modify: `crates/am-app/src/commands.rs` (`enqueue_send` command)
- Modify: `crates/am-app/src/lib.rs` (register)
- Create: `crates/am-sync/tests/send_greenmail.rs`
- Regenerate: `src/ipc/bindings.ts`

**Interfaces:**
- Consumes: `am_sync::send::{enqueue_send, drain_outbox}`, `drafts_repo::save_draft`.
- Produces command: `enqueue_send(draft_id: i64) -> Result<(), String>`.

- [ ] **Step 1: Add the command**

```rust
#[tauri::command]
#[specta::specta]
pub fn enqueue_send(state: tauri::State<'_, AppState>, draft_id: i64) -> Result<(), String> {
    am_sync::send::enqueue_send(&state.db, draft_id).map_err(|_| "Failed to enqueue send".to_string())
}
```

Register `commands::enqueue_send` in `collect_commands!` in `lib.rs`.

- [ ] **Step 2: Write the GreenMail e2e test**

Reuse the GreenMail scaffolding from `crates/am-sync/tests/sync_greenmail.rs` (copy `install_in_mem_builder`, `InMemCred*`, `docker_available`, container setup). GreenMail's SMTP is port 3025; set the account's `Endpoints.smtp_host/port=127.0.0.1/mapped(3025)`, `smtp_tls=false`. Test outline:

```rust
#[tokio::test]
async fn enqueue_and_drain_sends_and_appends_to_sent() {
    if !docker_available() { eprintln!("docker not available; skipping"); return; }
    install_in_mem_builder();
    // start greenmail exposing IMAP 3143 + SMTP 3025; get mapped ports
    // add_account for sender USER (endpoints: imap mapped 3143 tls=false, smtp mapped 3025 tls=false)
    // ensure a Sent folder exists: folders_repo::upsert_folder(account, "Sent", "Sent", FolderType::Sent)
    // build an OutgoingMessage to a second mailbox "rcpt@localhost", save_draft, enqueue_send
    // drain_outbox(db, account_id, now_secs())
    // assert: queue empty (mark_done), draft deleted, and the message is in Sent (sync the Sent folder, list_by_folder finds the subject)
    // optionally: connect as rcpt and verify delivery
}
```

Expose GreenMail's SMTP port via `.with_exposed_port(ContainerPort::Tcp(3025))` in addition to IMAP. Fill the elided lines by mirroring the existing tests; use `am_sync::send::{enqueue_send, drain_outbox}` and `am_storage::drafts_repo::save_draft`.

- [ ] **Step 3: Run**

Run: `cargo test -p am-sync` (unit always; integration runs only with Docker)
Expected: PASS. With Docker, the message is sent via SMTP and appears in Sent.

- [ ] **Step 4: Regenerate bindings**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npm run gen:bindings
```
Confirm `enqueueSend` appears in `src/ipc/bindings.ts`.

- [ ] **Step 5: Commit**

```bash
git add crates/am-app/src/commands.rs crates/am-app/src/lib.rs crates/am-sync/tests/send_greenmail.rs src/ipc/bindings.ts
git commit -m "feat(app): enqueue_send command and GreenMail send e2e"
```

---

## Self-Review

- **Spec coverage (4A scope):** canonical RFC822 (Task 4), SMTP send + Sent APPEND (Tasks 5,7), outbox + send-op + worker drain (Task 7), draft persistence (Task 6), BCC-only-in-envelope (Task 4 test + Task 7 recipients), password from keychain never logged (Tasks 5,7), e2e GreenMail (Task 8). Composer UI, reply/forward, signatures, server Drafts sync, inline images are 4B/4C.
- **Placeholder scan:** concrete code throughout. VERIFY notes (lettre features/API, mail-builder API, async-imap append, the now_secs helper, the `send` module path) are real correctness checks against installed crates, each with a fixed downstream interface.
- **Type consistency:** `OutgoingMessage`/`OutgoingAttachment` (Task 3) consumed by `compose::build_message` (Task 4), `drafts_repo` (Task 6), `send.rs` (Task 7). `SmtpConfig`/`send_raw` (Task 5) consumed by `send.rs`. `drain_outbox`/`enqueue_send` (Task 7) consumed by engine (Task 7) and the command (Task 8). `drain_queue` op_type filter pairs with `drain_outbox`'s `send_message` filter so neither drops the other's ops.
