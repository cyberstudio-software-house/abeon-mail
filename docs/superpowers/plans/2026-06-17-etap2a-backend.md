# AbeonMail Etap 2A (Backend: konto IMAP + initial sync) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zbudować backend Etapu 2: dodanie konta IMAP (hasło + autokonfiguracja + keychain), wykrycie folderów, initial sync nagłówków Inboxa do SQLite, pobieranie treści wiadomości on-demand z sanityzacją HTML — wszystko testowane na realnym serwerze IMAP (GreenMail w kontenerze).

**Architecture:** Rozszerzamy gruby rdzeń Rust o brakujące crate'y: `am-protocols` (IMAP), `am-mime` (parsowanie + sanityzacja), `am-auth` (keychain + endpointy), `am-sync` (orkiestracja). Sekrety trafiają wyłącznie do keychaina OS; baza trzyma `auth_ref`. Komendy Tauri wystawiają operacje do frontu (Etap 2B). Frontend nigdy nie dotyka serwera bezpośrednio.

**Tech Stack:** tokio, async-imap, mail-parser, ammonia, keyring, testcontainers (GreenMail), rusqlite, tauri-specta. Wersje pinów z Etapu 1: specta/tauri-specta `=2.0.0-rc.25`, specta-typescript `=0.0.12`. Node ≥ 24.

## Global Constraints

- English identifiers; NO comments in code (no `--` in SQL).
- Conventional Commits 1.0.0; NO `Co-Authored-By` line; push only on request.
- Offline-first: SQLite is source of truth; frontend reaches backend only via Tauri commands.
- **Secrets ONLY in OS keychain (`keyring` crate). The DB stores only `auth_ref`. Never log a password/token.**
- HTML mail is untrusted: sanitize in Rust (`ammonia`), block remote resources by default.
- `ProviderType` DB string mapping is the single source in `am-core` (`as_db_str`/`from_db_str`) — reuse it; do not reintroduce a second vocabulary.
- All IPC types derive `Serialize, Deserialize, specta::Type`; one shared `specta` version across the workspace.
- Reuse Etap 1 schema (tables already exist: `folders`, `messages`, `message_bodies`, `attachments`). Add a migration ONLY if a column is genuinely missing; prefer reusing existing columns.
- Tauri 2; Rust edition 2021. Tests must be pristine (no warnings). Integration tests requiring Docker must be gated so the suite degrades gracefully where Docker is absent (see Task 4).

---

## File Structure

- `crates/am-storage/src/folders_repo.rs` — folder upsert/list/get, counts.
- `crates/am-storage/src/messages_repo.rs` — header insert (batch), list by folder, get, body get/store, flag update.
- `crates/am-core/src/message.rs` — extend with `MessageBody`, `ParsedAddress`, and any shared DTOs (e.g. `SyncProgress`).
- `crates/am-mime/` — new crate: `src/lib.rs`, `src/parse.rs` (RFC822 → ParsedMessage), `src/sanitize.rs` (ammonia + remote-image blocking).
- `crates/am-auth/` — new crate: `src/lib.rs`, `src/endpoints.rs` (provider table + pattern resolver), `src/credentials.rs` (keyring), `src/provider.rs` (PasswordProvider).
- `crates/am-protocols/` — new crate: `src/lib.rs`, `src/imap.rs` (client), `src/error.rs`.
- `crates/am-sync/` — new crate: `src/lib.rs`, `src/service.rs` (add account + initial sync + body fetch).
- `crates/am-app/src/commands.rs` — extend with real account/folder/message commands.
- `crates/am-app/src/events.rs` — new: event payload types + emit helpers.
- `src-tauri/src/lib.rs` — spawn sync, emit events, manage a sync handle; `src-tauri/tauri.conf.json` — harden CSP.

---

## Task 1: am-storage — folders & messages repositories

**Files:**
- Create: `crates/am-storage/src/folders_repo.rs`, `crates/am-storage/src/messages_repo.rs`
- Modify: `crates/am-storage/src/lib.rs` (add `pub mod folders_repo; pub mod messages_repo;`)
- Modify: `crates/am-core/src/message.rs` (add `MessageBody` struct)
- Test: inline `#[cfg(test)]` in both repo files (in-memory DB).

**Interfaces:**
- Consumes: `am_storage::Database`, `am_core::{folder::*, message::*, account::*}`.
- Produces:
  - `folders_repo::upsert_folder(db, account_id: i64, remote_path: &str, name: &str, folder_type: FolderType) -> Result<Folder, StorageError>` (insert or update on `(account_id, remote_path)`).
  - `folders_repo::list_folders(db, account_id: i64) -> Result<Vec<Folder>, StorageError>`.
  - `folders_repo::get_folder(db, id: i64) -> Result<Folder, StorageError>`.
  - `folders_repo::set_uid_state(db, folder_id: i64, uidvalidity: i64, uidnext: i64) -> Result<(), StorageError>`.
  - `messages_repo::insert_headers(db, folder_id: i64, headers: &[NewMessageHeader]) -> Result<usize, StorageError>` (batch insert in one transaction; ignore conflicts on `(folder_id, uid)`).
  - `messages_repo::list_by_folder(db, folder_id: i64, limit: i64, offset: i64) -> Result<Vec<MessageHeader>, StorageError>` (ordered `date DESC`).
  - `messages_repo::get_header(db, id: i64) -> Result<MessageHeader, StorageError>`.
  - `messages_repo::get_body(db, message_id: i64) -> Result<Option<MessageBody>, StorageError>`.
  - `messages_repo::store_body(db, message_id: i64, body: &MessageBody) -> Result<(), StorageError>`.
  - `messages_repo::message_uid(db, message_id: i64) -> Result<(i64, i64), StorageError>` (returns `(folder_id, uid)`).
- `NewMessageHeader` struct (in `am-core::message`): `{ uid: i64, message_id_hdr: Option<String>, from_address: String, from_name: Option<String>, subject: String, date: i64, seen: bool, flagged: bool, has_attachments: bool, size: i64, snippet: String }`.
- `MessageBody` struct (in `am-core::message`, derives Serialize/Deserialize/specta::Type/Clone/Debug/PartialEq): `{ message_id: i64, text_plain: Option<String>, text_html: Option<String> }`.

- [ ] **Step 1: Add `MessageBody` and `NewMessageHeader` to `am-core::message` (RED via storage test)**

In `crates/am-core/src/message.rs` add (no comments):

```rust
#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct NewMessageHeader {
    pub uid: i64,
    pub message_id_hdr: Option<String>,
    pub from_address: String,
    pub from_name: Option<String>,
    pub subject: String,
    pub date: i64,
    pub seen: bool,
    pub flagged: bool,
    pub has_attachments: bool,
    pub size: i64,
    pub snippet: String,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct MessageBody {
    pub message_id: i64,
    pub text_plain: Option<String>,
    pub text_html: Option<String>,
}
```

- [ ] **Step 2: Write failing tests for folders_repo and messages_repo**

Create `crates/am-storage/src/folders_repo.rs` and `crates/am-storage/src/messages_repo.rs` with `#[cfg(test)] mod tests` covering: upsert is idempotent on `(account_id, remote_path)`; `list_folders` returns inserted; `insert_headers` batch inserts N and is conflict-safe on duplicate `(folder_id, uid)`; `list_by_folder` returns `date DESC` and respects limit/offset; `store_body` + `get_body` round-trips; `get_body` returns `None` when absent. Each test seeds an account+folder via existing repos. Use `Database::open_in_memory()`.

Provide function signatures with `todo!()` bodies first; run to confirm RED.

Run: `cargo test -p am-storage` → Expected: FAIL (todo!/unimplemented).

- [ ] **Step 3: Implement both repositories**

Implement all functions with fully parameterized SQL (`params!`/`?N`), one transaction for `insert_headers` (use `conn.unchecked_transaction()` or `INSERT OR IGNORE`), `INSERT OR IGNORE INTO messages(...) VALUES(...)` keyed on the `UNIQUE(folder_id, uid)` constraint, and `INSERT INTO message_bodies(...) ON CONFLICT(message_id) DO UPDATE SET ...` for `store_body`. Map `QueryReturnedNoRows` → `StorageError::NotFound`. Reuse `ProviderType`/existing row-mapping patterns from `accounts_repo`. Wire modules in `lib.rs`.

- [ ] **Step 4: Run tests — GREEN, pristine**

Run: `cargo test -p am-storage` → Expected: PASS, no warnings. Run `cargo test -p am-core` → still PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/am-storage crates/am-core
git commit -m "feat(storage): add folders and messages repositories"
```

---

## Task 2: am-mime — parse RFC822 + sanitize HTML

**Files:**
- Create: `crates/am-mime/Cargo.toml`, `crates/am-mime/src/lib.rs`, `crates/am-mime/src/parse.rs`, `crates/am-mime/src/sanitize.rs`
- Modify: root `Cargo.toml` (members + `mail-parser`, `ammonia` in `[workspace.dependencies]`)
- Test: inline tests with sample raw emails + malicious HTML.

**Interfaces:**
- Consumes: `am-core` (for `NewMessageHeader`-adjacent data), `mail-parser`, `ammonia`.
- Produces:
  - `am_mime::parse::ParsedMessage { message_id_hdr: Option<String>, from_address: String, from_name: Option<String>, subject: String, date: i64, text_plain: Option<String>, text_html: Option<String>, attachment_names: Vec<String>, snippet: String }`.
  - `am_mime::parse::parse_message(raw: &[u8]) -> ParsedMessage` (never panics on malformed input; missing fields → sensible defaults; `snippet` = first ~150 chars of plain text or stripped html).
  - `am_mime::sanitize::SanitizedHtml { html: String, blocked_remote_content: bool }`.
  - `am_mime::sanitize::sanitize_html(raw_html: &str) -> SanitizedHtml` — strips scripts/event-handlers/forms; removes/neutralizes remote resource URLs (`img[src^=http]`, `link`, `background`, CSS `url(...)`) setting `blocked_remote_content=true` when any were present; keeps safe inline content; forces links to `rel="noopener noreferrer"` and `target="_blank"`.

- [ ] **Step 1: Crate + workspace wiring**

`crates/am-mime/Cargo.toml`:

```toml
[package]
name = "am-mime"
edition.workspace = true
version.workspace = true

[dependencies]
mail-parser = { workspace = true }
ammonia = { workspace = true }

[dev-dependencies]
```

Add to root `[workspace.dependencies]`: `mail-parser = "0.9"`, `ammonia = "4"`. Add `"crates/am-mime"` to members. (Adapt `mail-parser` major to the latest compatible; the implementer should `cargo add mail-parser ammonia -p am-mime` and pin the resolved versions into `[workspace.dependencies]`.)

- [ ] **Step 2: Write failing tests**

In `parse.rs` tests: feed a small multipart raw email (text/plain + text/html + one attachment) as a byte literal; assert `from_address`, `subject`, both bodies extracted, `attachment_names` contains the filename, `snippet` non-empty. Add a malformed-input test asserting `parse_message(b"garbage")` does not panic and returns defaults.

In `sanitize.rs` tests: assert `<script>alert(1)</script>` is removed; an `onclick=` attribute is stripped; `<img src="http://tracker/x.png">` sets `blocked_remote_content=true` and the remote src is removed/neutralized; an inline `<b>` survives; a link gets `rel`/`target` applied.

Run: `cargo test -p am-mime` → FAIL.

- [ ] **Step 3: Implement parse + sanitize**

`parse.rs`: use `mail_parser::MessageParser::default().parse(raw)`, extract text bodies via the parser API (adapt to the installed `mail-parser` API: `message.body_text(0)`, `message.body_html(0)`, `message.from()`, `message.subject()`, `message.date()`, attachments iterator). Compute `snippet` from plain text (or `ammonia::clean` + strip tags of html) truncated to 150 chars on a char boundary.

`sanitize.rs`: configure an `ammonia::Builder` that denies `script`/`style`/`iframe`/`object`/`embed`/`form`, strips all `on*` attributes, and use a URL filter / attribute filter to drop remote `src`/`href` to external resources for images while allowing `cid:` and `data:` images; detect whether any remote resource was present to set `blocked_remote_content`. Apply `link_rel("noopener noreferrer")`. Return `SanitizedHtml`.

- [ ] **Step 4: GREEN, pristine**

Run: `cargo test -p am-mime` → PASS, no warnings.

- [ ] **Step 5: Commit**

```bash
git add crates/am-mime Cargo.toml Cargo.lock
git commit -m "feat(mime): add rfc822 parser and html sanitizer"
```

---

## Task 3: am-auth — endpoint resolver + keychain credentials

**Files:**
- Create: `crates/am-auth/Cargo.toml`, `crates/am-auth/src/lib.rs`, `crates/am-auth/src/endpoints.rs`, `crates/am-auth/src/credentials.rs`, `crates/am-auth/src/provider.rs`
- Modify: root `Cargo.toml` (members + `keyring` in `[workspace.dependencies]`)
- Test: inline tests for resolver; keychain tests use `keyring`'s mock store.

**Interfaces:**
- Produces:
  - `am_auth::endpoints::Endpoints { imap_host: String, imap_port: u16, imap_tls: bool, smtp_host: String, smtp_port: u16, smtp_tls: bool }` (derives Serialize/Deserialize/specta::Type/Clone/Debug/PartialEq).
  - `am_auth::endpoints::resolve(email: &str) -> Endpoints` — known-provider table (gmail.com, googlemail.com → imap.gmail.com:993 tls, smtp.gmail.com:465; icloud.com/me.com/mac.com → imap.mail.me.com:993, smtp.mail.me.com:587; outlook/hotmail/live → outlook.office365.com:993, smtp.office365.com:587) else pattern guess `imap.<domain>:993` / `smtp.<domain>:465` with TLS true.
  - `am_auth::credentials::store_password(account_ref: &str, password: &str) -> Result<(), AuthError>` and `load_password(account_ref) -> Result<String, AuthError>` and `delete_password(account_ref) -> Result<(), AuthError>` using the `keyring` crate, service name `"AbeonMail"`.
  - `am_auth::AuthError` (thiserror).
- The `account_ref` (keychain key) convention: the email address (also stored as `accounts.auth_ref`).

- [ ] **Step 1: Crate + workspace wiring**

`keyring = "3"` in `[workspace.dependencies]` (enable a default cross-platform store). Add `"crates/am-auth"` to members. For tests, enable keyring's mock keystore (in keyring v3 use `keyring::set_default_credential_builder(keyring::mock::default_credential_builder())` in a test setup, or the `apple-native`/`linux-native` features for real). The implementer should configure the `keyring` features so that: (a) tests use the mock store and never touch the real OS keychain; (b) the production build uses the platform-native store. Document the chosen feature set in the report.

- [ ] **Step 2: Write failing tests**

`endpoints.rs` tests: `resolve("a@gmail.com")` → imap.gmail.com:993 tls true; `resolve("a@unknown-domain.example")` → imap.unknown-domain.example:993 tls true. `credentials.rs` test (with mock store): `store_password("a@x.com","secret")` then `load_password("a@x.com") == "secret"`; `delete_password` then `load_password` errors.

Run: `cargo test -p am-auth` → FAIL.

- [ ] **Step 3: Implement resolver + credentials + PasswordProvider**

Implement `resolve` with a `match` on the lowercased domain. Implement credentials via `keyring::Entry::new("AbeonMail", account_ref)?` `.set_password` / `.get_password` / `.delete_credential`. `provider.rs`: a thin `PasswordProvider { email, endpoints }` with `fn endpoints(&self) -> &Endpoints`.

- [ ] **Step 4: GREEN, pristine**

Run: `cargo test -p am-auth` → PASS, no warnings. Confirm tests used the mock keystore (no real keychain prompts).

- [ ] **Step 5: Commit**

```bash
git add crates/am-auth Cargo.toml Cargo.lock
git commit -m "feat(auth): add endpoint resolver and keychain credential storage"
```

---

## Task 4: am-protocols — IMAP client (+ GreenMail integration test)

**Files:**
- Create: `crates/am-protocols/Cargo.toml`, `crates/am-protocols/src/lib.rs`, `crates/am-protocols/src/imap.rs`, `crates/am-protocols/src/error.rs`
- Create: `crates/am-protocols/tests/imap_greenmail.rs` (integration test, Docker-gated)
- Modify: root `Cargo.toml` (members + `async-imap`, `tokio`, TLS + `testcontainers` in `[workspace.dependencies]`/dev)

**Interfaces:**
- Produces (all async, on `tokio`):
  - `am_protocols::imap::ImapConfig { host: String, port: u16, tls: bool, username: String }` (password passed separately to `connect`, never stored in the struct beyond the call).
  - `am_protocols::imap::FetchedHeader { uid: i64, message_id_hdr: Option<String>, from_address: String, from_name: Option<String>, subject: String, date: i64, seen: bool, flagged: bool, size: i64 }`.
  - `am_protocols::imap::RemoteFolder { remote_path: String, name: String, special_use: Option<String> }`.
  - `am_protocols::imap::ImapSession` with:
    - `connect(config: &ImapConfig, password: &str) -> Result<ImapSession, ProtocolError>`
    - `list_folders(&mut self) -> Result<Vec<RemoteFolder>, ProtocolError>`
    - `select(&mut self, remote_path: &str) -> Result<MailboxState, ProtocolError>` where `MailboxState { uidvalidity: i64, uidnext: i64, exists: i64 }`
    - `fetch_recent_headers(&mut self, limit: u32) -> Result<Vec<FetchedHeader>, ProtocolError>` (most recent `limit` messages of the selected mailbox)
    - `fetch_body(&mut self, uid: i64) -> Result<Vec<u8>, ProtocolError>` (raw RFC822 of `BODY[]`)
    - `logout(self) -> Result<(), ProtocolError>`
  - `am_protocols::error::ProtocolError` (thiserror; variants for connect/auth/io/protocol).

- [ ] **Step 1: Crate + deps**

Add to `[workspace.dependencies]`: `tokio = { version = "1", features = ["rt-multi-thread","net","macros","io-util","time"] }`, `async-imap = { version = "0.10", default-features = false, features = ["runtime-tokio"] }`, `futures = "0.3"`, and a TLS stack (`tokio-rustls` + `rustls` + `webpki-roots`, or `async-native-tls`). Dev: `testcontainers = "0.23"`. The implementer must adapt versions to what resolves and pin them. The IMAP client connection is generic over the stream so it supports both TLS (prod) and plain TCP (tests).

- [ ] **Step 2: Write the GreenMail integration test (Docker-gated)**

`crates/am-protocols/tests/imap_greenmail.rs`: start a GreenMail container via `testcontainers` (image `greenmail/standalone`, expose IMAP plain port 3143 and SMTP 3025; GreenMail auto-creates users on login). The test:
1. Skips gracefully if Docker is unavailable — gate with a helper that probes Docker and returns early with an eprintln (so CI without Docker is green). Name the helper `docker_available()`.
2. Connects with `tls=false` to the mapped IMAP port as user `test@localhost` / password `test`.
3. Appends a couple of raw test messages to INBOX (via a second IMAP APPEND, or seed via GreenMail's API/SMTP), `select("INBOX")`, asserts `exists >= 1`, `fetch_recent_headers` returns headers with the expected subject, and `fetch_body(uid)` returns bytes containing the body text.

Run: `cargo test -p am-protocols` → FAIL (client not implemented).

- [ ] **Step 3: Implement the IMAP client**

Implement `connect` (build plain `TcpStream` or TLS stream per `config.tls`, `async_imap::Client::new(stream)`, `.login(username, password)`), `list_folders` (`session.list(None, Some("*"))` mapped to `RemoteFolder`, detect special-use from flags), `select` (map `Mailbox` to `MailboxState`), `fetch_recent_headers` (compute sequence range for the last `limit`, `FETCH (UID ENVELOPE FLAGS RFC822.SIZE)`, map to `FetchedHeader`; parse `INTERNALDATE`/envelope date to a unix timestamp), `fetch_body` (`FETCH uid BODY[]` via `uid_fetch`), `logout`. Adapt all calls to the installed `async-imap` API (it returns streams — collect with `futures::TryStreamExt`). Keep passwords out of any `Debug`/log.

- [ ] **Step 4: GREEN (with Docker), pristine**

Run: `cargo test -p am-protocols` → PASS when Docker present (the test pulls `greenmail/standalone` on first run — allow time). Confirm the Docker-gating helper makes the test a no-op (still green) when Docker is absent.

- [ ] **Step 5: Commit**

```bash
git add crates/am-protocols Cargo.toml Cargo.lock
git commit -m "feat(protocols): add async imap client with greenmail integration test"
```

---

## Task 5: am-sync — add account + initial sync + body fetch

**Files:**
- Create: `crates/am-sync/Cargo.toml`, `crates/am-sync/src/lib.rs`, `crates/am-sync/src/service.rs`
- Create: `crates/am-sync/tests/sync_greenmail.rs` (Docker-gated integration test)
- Modify: root `Cargo.toml` (members)

**Interfaces:**
- Consumes: `am-core`, `am-storage`, `am-protocols`, `am-mime`, `am-auth`.
- Produces:
  - `am_sync::service::AddAccountInput { email: String, display_name: String, password: String, endpoints: am_auth::endpoints::Endpoints }`.
  - `am_sync::service::add_account(db: &Database, input: AddAccountInput) -> Result<Account, SyncError>` — stores password in keychain (`am_auth::credentials::store_password(&email, &password)`), inserts `accounts` row (provider `ImapPassword`, `auth_ref = email`, endpoints into `settings` JSON), connects IMAP, discovers folders (upsert), then `initial_sync_inbox`.
  - `am_sync::service::initial_sync_inbox(db: &Database, account_id: i64, progress: impl Fn(SyncProgress)) -> Result<usize, SyncError>` — selects INBOX, fetches recent N (e.g. 200) headers via `am-protocols`, parses envelopes, batch-inserts via `messages_repo`, updates folder UID state + counts; calls `progress` callback.
  - `am_sync::service::get_or_fetch_body(db: &Database, message_id: i64) -> Result<MessageBody, SyncError>` — returns cached body if present; else looks up `(folder_id, uid)` + account creds, fetches raw via IMAP, parses with `am-mime`, stores via `messages_repo::store_body`, returns it.
  - `am_core::message::SyncProgress { account_id: i64, folder_id: i64, fetched: i64, total: i64 }` (add to am-core; derives the IPC traits).
  - `am_sync::service::SyncError` (thiserror; wraps storage/protocol/mime/auth errors WITHOUT leaking secrets).

- [ ] **Step 1: Crate + SyncProgress type + workspace wiring**

Add `SyncProgress` to `am-core::message`. Add `"crates/am-sync"` to members. `am-sync` deps: path deps to am-core/am-storage/am-protocols/am-mime/am-auth + tokio.

- [ ] **Step 2: Write the GreenMail integration test (Docker-gated)**

`tests/sync_greenmail.rs`: reuse the `docker_available()` gate. Start GreenMail, seed 3 messages into a user's INBOX, then call `add_account` with `tls=false` endpoints pointing at the container, assert: an `accounts` row exists, folders include INBOX, `messages_repo::list_by_folder(inbox)` returns 3 headers, and `get_or_fetch_body(first_id)` returns a body whose `text_plain` or `text_html` contains the expected text. Use a temp-file SQLite DB (or in-memory) created via `Database`.

Run: `cargo test -p am-sync` → FAIL.

- [ ] **Step 3: Implement the sync service**

Implement `add_account`, `initial_sync_inbox`, `get_or_fetch_body` per interfaces. Serialize endpoints into `accounts.settings` JSON; load them back for body fetch. Load the password from keychain for each connection. Map envelope `from`/`subject`/`date`/flags into `NewMessageHeader` (snippet from a lightweight fetch or left empty until body fetch — for Etap 2 set snippet from envelope subject-adjacent text or empty; document choice). Ensure no secret is ever placed in `SyncError` messages.

- [ ] **Step 4: GREEN (with Docker), pristine**

Run: `cargo test -p am-sync` → PASS with Docker; no-op-green without. Run `cargo test --workspace` → all prior tests still pass.

- [ ] **Step 5: Commit**

```bash
git add crates/am-sync crates/am-core Cargo.toml Cargo.lock
git commit -m "feat(sync): add account onboarding, initial inbox sync, and body fetch"
```

---

## Task 6: am-app — real commands + events

**Files:**
- Modify: `crates/am-app/src/commands.rs`, `crates/am-app/src/state.rs`, `crates/am-app/src/lib.rs`
- Create: `crates/am-app/src/events.rs`
- Modify: `crates/am-app/Cargo.toml` (add am-sync, am-auth, am-mime path deps)

**Interfaces:**
- Produces (commands; all `#[tauri::command] #[specta::specta]`):
  - `resolve_endpoints(email: String) -> Endpoints` (wraps `am_auth::endpoints::resolve`).
  - `add_account(state, email, display_name, password, endpoints) -> Result<Account, String>` (delegates to `am_sync::service::add_account`; spawns/awaits initial sync; never returns the password).
  - `list_folders(state, account_id: i64) -> Result<Vec<Folder>, String>`.
  - `list_messages(state, folder_id: i64, limit: i64, offset: i64) -> Result<Vec<MessageHeader>, String>`.
  - `get_message_body(state, message_id: i64) -> Result<MessageBody, String>` (delegates to `get_or_fetch_body`).
  - `sanitize_message_html(html: String) -> SanitizedHtml` (wraps `am_mime::sanitize::sanitize_html`).
  - Keep existing `app_health`, `list_accounts`.
- Events (`events.rs`): typed payloads `SyncProgress`, `NewMessages { account_id, folder_id, count }`, registered via tauri-specta `collect_events!` so they appear in generated bindings.
- `AppState` gains whatever handle is needed (the `Database` is already there; sync functions take `&Database`).

- [ ] **Step 1: Write failing tests for command-delegated logic**

In `commands.rs` tests (no Tauri runtime needed): test `resolve_endpoints` returns gmail endpoints for a gmail address; test that the storage-backed path used by `list_messages`/`get_message_body` works against an in-memory DB seeded via repos (call the underlying repo/sync helpers the commands delegate to). Keep tests on the real DB path, not mocks.

Run: `cargo test -p am-app` → FAIL for the new tests.

- [ ] **Step 2: Implement commands + events; register in builder**

Implement the commands delegating to `am-sync`/`am-auth`/`am-mime`/repos. Add `events.rs` with the event types. Update `build_specta_builder()` to `.commands(collect_commands![...])` (all commands) and `.events(collect_events![...])`. Add path deps. Map errors to strings WITHOUT leaking secrets (generic message for auth failures).

- [ ] **Step 3: GREEN + workspace build**

Run: `cargo test -p am-app` → PASS, pristine. `cargo build --workspace` → clean.

- [ ] **Step 4: Commit**

```bash
git add crates/am-app
git commit -m "feat(app): add real account, folder, message commands and sync events"
```

---

## Task 7: src-tauri wiring + CSP hardening + regenerate bindings

**Files:**
- Modify: `src-tauri/src/lib.rs` (spawn initial sync off the UI thread; mount events; emit progress)
- Modify: `src-tauri/tauri.conf.json` (replace `csp: null` with a strict policy)
- Modify (generated): `src/ipc/bindings.ts` via `npm run gen:bindings`

**Interfaces:**
- Consumes: `am_app::build_specta_builder` (now with events).
- Produces: a binary that compiles with the new commands/events; `bindings.ts` exposing the new commands + event listeners.

- [ ] **Step 1: Harden CSP in tauri.conf.json**

Set `app.security.csp` to a strict policy allowing only self + the sanitized-content needs, e.g.:

```json
"csp": "default-src 'self'; img-src 'self' data: asset: https://asset.localhost; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'"
```

Adapt to what the app actually needs to render (the reader iframe is added in Etap 2B; keep `frame-src 'self'` and sandbox there). Verify the app still builds and the existing shell renders (cargo build; npm run build).

- [ ] **Step 2: Wire sync spawning + event mounting**

Ensure `builder.mount_events(app)` is present (from Etap 1). The `add_account` command already triggers initial sync synchronously within the command (acceptable for Etap 2); if long, spawn via `tauri::async_runtime::spawn` and emit `sync_progress` events through the app handle. Keep the change minimal and compiling.

- [ ] **Step 3: Regenerate bindings + verify**

Run (with Node 24 on PATH): `npm run gen:bindings`. Confirm `src/ipc/bindings.ts` now contains `resolveEndpoints`, `addAccount` (new signature), `listFolders`, `listMessages`, `getMessageBody`, `sanitizeMessageHtml`, and the `events` object with `syncProgress`/`newMessages`. Run `cargo build --workspace` and `npm run build` → clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri src/ipc/bindings.ts
git commit -m "feat(tauri): harden csp, mount sync events, regenerate bindings"
```

---

## Self-Review

**Spec coverage (Etap 2 backend portion):**
- Add account (password) + autodiscovery → Task 3 (resolver), Task 5 (add_account), Task 6 (commands).
- Keychain credential storage → Task 3, Task 5.
- Folder discovery + initial INBOX header sync → Task 4 (list/select/fetch), Task 5 (initial_sync_inbox), Task 1 (repos).
- On-demand body fetch + parse → Task 4 (fetch_body), Task 2 (parse), Task 5 (get_or_fetch_body).
- HTML sanitization + remote-image blocking + CSP → Task 2 (sanitize), Task 6 (command), Task 7 (CSP).
- Type-safe IPC for new commands/events → Task 6 (collect_commands/events), Task 7 (bindings).
- Offline-first/secrets-in-keychain/no-secret-leak → enforced across Tasks 3/5/6 (Global Constraints).

**Deferred to Etap 2B (frontend):** account-add wizard UI, folder list rail, virtualized message list, reader with sandboxed iframe + "load remote images" UX, @tanstack/query data layer + event wiring.

**Placeholder scan:** No "TBD"/"TODO". Crate-API adaptation points (async-imap, mail-parser, keyring, testcontainers) are explicit, bounded instructions to match the installed version — the same pattern that worked for tauri-specta in Etap 1 — not unfilled gaps.

**Type consistency:** `NewMessageHeader`/`MessageBody`/`SyncProgress` defined in `am-core` (Tasks 1/5) and consumed by storage/sync/app. `Endpoints` defined in `am-auth` (Task 3), consumed by sync/app/bindings. `FetchedHeader`/`RemoteFolder`/`MailboxState` defined in `am-protocols` (Task 4), consumed by sync (Task 5). Repo signatures in Task 1 match calls in Task 5.

## Note on Docker-gated tests

Integration tests (Tasks 4, 5) require Docker to pull `greenmail/standalone`. They must self-skip (stay green) when Docker is unavailable so `cargo test --workspace` never fails on a Docker-less machine. The controller will run them with Docker present to get real coverage.
