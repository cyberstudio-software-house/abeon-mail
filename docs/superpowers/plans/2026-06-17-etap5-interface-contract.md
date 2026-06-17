# Etap 5 — Shared Interface Contract

This is the single source of truth for the names, signatures, and types shared across
plans 5A/5B/5C. Every plan task must use these exact identifiers. Spec:
`docs/superpowers/specs/2026-06-17-etap5-oauth-multiaccount-smartfolders-design.md`.

## Carry-over global constraints (all tasks)

- Code identifiers (vars, consts, types, fns) English-only. No code comments — durable
  notes go to `docs/`.
- Secrets (passwords, refresh tokens, access tokens) ONLY in OS keychain (refresh) or
  process memory (access). NEVER in DB, logs, events, error messages, or `Debug` impls.
- Node 24 at `$HOME/.nvm/versions/node/v24.14.0/bin` (prepend to PATH for `npm`).
- Rust: `cargo test -p <crate>` per crate; full `cargo test` before merge.
- Frontend: `npm test` (vitest), `npm run gen:bindings` after any command/event/type
  change touching tauri-specta.
- TLS provider is ring throughout; new HTTP deps must use rustls+ring, not native-tls.
- `git commit` messages follow Conventional Commits; no co-author line; no push.

## am-protocols (changed in 5A)

```rust
// crates/am-protocols/src/imap.rs
#[derive(Clone)]
pub enum ImapAuth {
    Password(String),
    XOauth2 { user: String, access_token: String },
}
impl ImapAuth {
    // no Debug that prints secrets; derive Debug is FORBIDDEN. Hand-write a redacting Debug.
}
impl ImapSession {
    // SIGNATURE CHANGE: was connect(config, password: &str)
    pub async fn connect(config: &ImapConfig, auth: &ImapAuth) -> Result<ImapSession, ProtocolError>;
}

// crates/am-protocols/src/smtp.rs
#[derive(Clone)]
pub enum SmtpAuth {
    Password(String),
    XOauth2 { user: String, access_token: String },
}
// SIGNATURE CHANGE: was send_raw(config, password: &str, from, recipients, bytes)
pub async fn send_raw(
    config: &SmtpConfig,
    auth: &SmtpAuth,
    from: &str,
    recipients: &[String],
    bytes: &[u8],
) -> Result<(), ProtocolError>;
```

XOAUTH2 SASL initial response (both IMAP and SMTP): the bytes
`format!("user={user}\x01auth=Bearer {token}\x01\x01")`, then base64 (standard, padded).
- IMAP: `client.authenticate("XOAUTH2", authenticator)` where `authenticator` implements
  `async_imap::Authenticator` and returns that base64 string from `process`.
- SMTP: lettre `Mechanism::Xoauth2` + `Credentials::new(user, access_token)` (lettre builds
  the SASL string itself); set `.authentication(vec![Mechanism::Xoauth2])` on the builder.

## am-auth OAuth (added in 5A)

```rust
// crates/am-auth/src/oauth/mod.rs  (also google.rs, pkce.rs, client.rs, manager.rs)
#[derive(Clone)]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64, // epoch seconds, absolute
}

#[derive(thiserror::Error, Debug)]
pub enum OAuthError {
    #[error("oauth config error: {0}")] Config(String),
    #[error("oauth network error: {0}")] Network(String),
    #[error("oauth consent revoked")] InvalidGrant,
    #[error("oauth keychain error")] Keychain,
}

// google.rs constants
pub const GOOGLE_AUTH_URI: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const GOOGLE_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
pub const GOOGLE_USERINFO_URI: &str = "https://www.googleapis.com/oauth2/v3/userinfo";
pub const GOOGLE_SCOPES: &str = "https://mail.google.com/ openid email";
pub fn google_client_id() -> Result<String, OAuthError>; // reads env ABEONMAIL_GOOGLE_CLIENT_ID

// pkce.rs
pub struct Pkce { pub verifier: String, pub challenge: String } // S256
pub fn generate_pkce() -> Pkce;
pub fn authorize_url(client_id: &str, redirect_uri: &str, challenge: &str, state: &str) -> String;

// client.rs — network calls injectable for tests via the TokenHttp trait
#[async_trait::async_trait]
pub trait TokenHttp: Send + Sync {
    async fn post_form(&self, url: &str, form: &[(&str, &str)]) -> Result<(u16, String), OAuthError>;
    async fn get_bearer(&self, url: &str, access_token: &str) -> Result<(u16, String), OAuthError>;
}
pub struct ReqwestHttp; // production impl using reqwest (rustls)
pub async fn exchange_code(http: &dyn TokenHttp, client_id: &str, code: &str, verifier: &str, redirect_uri: &str) -> Result<OAuthTokens, OAuthError>;
pub async fn refresh_tokens(http: &dyn TokenHttp, client_id: &str, refresh_token: &str) -> Result<OAuthTokens, OAuthError>;
pub async fn fetch_email(http: &dyn TokenHttp, access_token: &str) -> Result<String, OAuthError>;

// manager.rs — in-memory access-token cache keyed by auth_ref; refresh-token from keychain
pub struct OAuthTokenManager { /* Arc<Mutex<HashMap<String, OAuthTokens>>> + Arc<dyn TokenHttp> */ }
impl OAuthTokenManager {
    pub fn new(http: Arc<dyn TokenHttp>) -> Self;
    pub fn seed(&self, auth_ref: &str, tokens: &OAuthTokens);
    // returns a valid access token, refreshing (via keychain refresh token) if <300s remain.
    pub async fn valid_access_token(&self, auth_ref: &str, client_id: &str, now: i64) -> Result<String, OAuthError>;
}
```

Refresh-token keychain key = `accounts.auth_ref` (same column already used for passwords).
`store_password`/`load_password`/`delete_password` in `am-auth::credentials` store the
refresh token for OAuth accounts (reuse as-is).

## am-sync credential source (added in 5A)

```rust
// crates/am-sync/src/auth.rs
#[derive(Clone)]
pub enum AccountAuth {
    Password(String),
    XOauth2 { user: String, access_token: String },
}
impl AccountAuth {
    pub fn to_imap(&self) -> am_protocols::imap::ImapAuth;
    pub fn to_smtp(&self) -> am_protocols::smtp::SmtpAuth;
}

#[async_trait::async_trait]
pub trait CredentialSource: Send + Sync {
    async fn auth_for(&self, account: &am_core::account::Account) -> Result<AccountAuth, SyncError>;
}

// production impl, holds the token manager (shared via Arc so the cache persists)
pub struct KeychainCredentialSource { /* token_manager: OAuthTokenManager, client_id: Option<String> */ }
impl KeychainCredentialSource {
    pub fn new() -> Arc<Self>; // builds ReqwestHttp-backed token manager; reads client_id lazily
}
```

`SyncError` gains: `#[error("reauth required")] NeedsReauth`. `From<OAuthError>` maps
`OAuthError::InvalidGrant -> SyncError::NeedsReauth`, others -> `SyncError::Auth`/`Protocol`.

### Service/engine signature changes (5A)

Every sync function that connects gains a `creds: &dyn CredentialSource` parameter and
replaces `load_password(&account.email)? + ImapSession::connect(&config, &password)` with
`let auth = creds.auth_for(&account).await?; ImapSession::connect(&config, &auth.to_imap())`.
Affected (verify at implementation time):
- `service::sync_all_folders`, `incremental_sync_folder`, `drain_queue`, `add_account`,
  `get_or_fetch_body`, `get_or_fetch_recipients`, `idle_inbox` (engine.rs)
- `send::drain_outbox`, `send::drain_draft_sync` (SMTP send_raw uses `auth.to_smtp()`)

`SyncEngine` holds `creds: Arc<dyn CredentialSource>` (added to `start`) and passes
`self.creds.as_ref()` into the worker calls. `AppState` holds `creds: Arc<KeychainCredentialSource>`
shared with the engine and reused by the OAuth command for `seed`.

## am-core additions

```rust
// crates/am-core/src/account.rs — Account gains:
pub requires_reauth: bool,   // 5C; defaults false

// crates/am-core/src/smart.rs (new) — 5B
#[derive(Serialize, Deserialize, Type, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SmartFolderKind { AllInboxes, Unread, Flagged }

#[derive(Serialize, Deserialize, Type, Clone, Debug)]
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
```

## am-storage

- Migration `crates/am-storage/src/migrations/V5__oauth_smart.sql`:
  - `ALTER TABLE accounts ADD COLUMN requires_reauth INTEGER NOT NULL DEFAULT 0;`
  - `CREATE INDEX idx_messages_seen_date ON messages(seen, date DESC);`
  - `CREATE INDEX idx_messages_flagged_date ON messages(flagged, date DESC);`
- `accounts_repo`: every `SELECT ... FROM accounts` adds `requires_reauth`; `row_to_account`
  tuple gains a 7th `i64` (0/1) → `Account.requires_reauth`. New fns:
  - `set_requires_reauth(db, id: i64, value: bool) -> Result<(), StorageError>`
  - `reorder_accounts(db, ordered_ids: &[i64]) -> Result<(), StorageError>` (one transaction,
    sets `position` = index).
- `smart_repo` (new, `crates/am-storage/src/smart_repo.rs`):
  - `list_smart_folder(db, kind: SmartFolderKind, limit: i64, offset: i64) -> Result<Vec<SmartMessageRow>, StorageError>`
  - All queries `JOIN folders` for `folder_type`, select `accounts.color`, `WHERE draft = 0
    AND deleted = 0`, `ORDER BY messages.date DESC LIMIT ? OFFSET ?`.
    - AllInboxes: `folders.folder_type = 'inbox'`
    - Unread: `messages.seen = 0 AND folders.folder_type NOT IN ('trash','spam')`
    - Flagged: `messages.flagged = 1 AND folders.folder_type NOT IN ('trash','spam')`

## am-app commands + events

```rust
// 5A
#[tauri::command] pub async fn begin_google_oauth(state) -> Result<Account, String>;
// 5B
#[tauri::command] pub fn list_smart_folder(state, kind: SmartFolderKind, limit: i64, offset: i64) -> Result<Vec<SmartMessageRow>, String>;
// 5C
#[tauri::command] pub async fn remove_account(state, account_id: i64) -> Result<(), String>;
#[tauri::command] pub fn reorder_accounts(state, ordered_ids: Vec<i64>) -> Result<(), String>;
#[tauri::command] pub async fn begin_reauth(state, account_id: i64) -> Result<(), String>;

// event (5C) — crates/am-app/src/events.rs
#[derive(...tauri_specta::Event)] pub struct AccountAuthChanged { pub account_id: i64, pub requires_reauth: bool }
```
Register every new command in `collect_commands![...]` and `AccountAuthChanged` in
`collect_events![...]` in `crates/am-app/src/lib.rs`. The engine emits `AccountAuthChanged`
through a new `SyncEvent::AuthChanged { account_id, requires_reauth }` variant bridged in
`crates/am-app/src/sink.rs`.

## Frontend (TS) — bindings regenerated via `npm run gen:bindings`

- `src/app/store.ts`: add `selectedSmartFolder: SmartFolderKind | null` + setter.
  Selecting a smart folder clears `selectedAccountId/selectedFolderId/selectedThreadId`;
  selecting an account/folder clears `selectedSmartFolder`.
- `src/ipc/queries.ts`: `useSmartFolder(kind)` (queryKey `["smart", kind]`, calls
  `commands.listSmartFolder(kind, 100, 0)`), `useRemoveAccount`, `useReorderAccounts`,
  `useBeginGoogleOauth`, `useBeginReauth`.
- `src/ipc/events.ts`: listen `events.accountAuthChanged` → invalidate `["accounts"]`;
  add `["smart"]` invalidation to the newMessages + mailboxChanged handlers.
- `src/features/message-list/MessageListPane.tsx`: when `selectedSmartFolder != null`,
  render the flat `useSmartFolder` list (rows show account color dot) instead of `useThreads`.
- `src/features/mailbox/MailboxRail.tsx`: 3 live smart folders (remove `aria-disabled`/
  `opacity`; drop Snoozed + Drafts); per-account remove button (confirm dialog) + reauth
  badge ("⚠ Reconnect") + drag-and-drop reorder.
- `src/features/accounts/AddAccountWizard.tsx`: "Sign in with Google" button calling
  `useBeginGoogleOauth`.
