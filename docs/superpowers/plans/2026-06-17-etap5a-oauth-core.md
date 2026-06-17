# Etap 5A — OAuth Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google OAuth (PKCE + XOAUTH2 + in-memory token manager) to AbeonMail so a user can authenticate with Google through a system browser loopback flow and have their Gmail account added with token-based IMAP/SMTP auth — without changing behavior for existing password accounts.

**Architecture:** `am-auth` gains an `oauth/` submodule (pkce, google constants, HTTP client trait + reqwest impl, token manager). `am-protocols` gains `ImapAuth`/`SmtpAuth` enums replacing the bare `&str` password parameters in `ImapSession::connect` and `send_raw`. `am-sync` gains `auth.rs` (credential source trait + keychain impl) and threads it through every connecting function. `am-app` gains `begin_google_oauth` command (loopback listener, browser open via `tauri-plugin-opener`, code exchange, account creation). Frontend gains a "Sign in with Google" button in `AddAccountWizard`.

**Tech Stack:** Rust (Tokio async, async-imap, lettre, rustls+ring), oauth2 v5, reqwest (rustls-tls + ring, no native-tls), sha2, base64, async-trait, rand; TypeScript/React + Vitest + @testing-library/react; Tauri 2 + tauri-specta + tauri-plugin-opener.

## Global Constraints

- Code identifiers (vars, consts, types, fns) English-only. No code comments — durable notes go to `docs/`.
- Secrets (passwords, refresh tokens, access tokens) ONLY in OS keychain (refresh) or process memory (access). NEVER in DB, logs, events, error messages, or `Debug` impls.
- Node 24 at `$HOME/.nvm/versions/node/v24.14.0/bin` (prepend to PATH for `npm`).
- Rust: `cargo test -p <crate>` per crate; full `cargo test` before merge.
- Frontend: `npm test` (vitest), `npm run gen:bindings` after any command/event/type change touching tauri-specta.
- TLS provider is ring throughout; new HTTP deps must use rustls+ring, not native-tls.
- `git commit` messages follow Conventional Commits; no co-author line; no push.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `Cargo.toml` (workspace) | Modify | Add oauth2, reqwest, sha2, base64, async-trait, rand workspace deps |
| `crates/am-auth/Cargo.toml` | Modify | Depend on new workspace deps |
| `crates/am-auth/src/oauth/mod.rs` | Create | Re-export OAuthTokens, OAuthError, sub-modules |
| `crates/am-auth/src/oauth/pkce.rs` | Create | Pkce struct, generate_pkce(), authorize_url() |
| `crates/am-auth/src/oauth/google.rs` | Create | Google URL constants, GOOGLE_SCOPES, google_client_id() |
| `crates/am-auth/src/oauth/client.rs` | Create | TokenHttp trait, ReqwestHttp, OAuthTokens, OAuthError, exchange_code/refresh_tokens/fetch_email |
| `crates/am-auth/src/oauth/manager.rs` | Create | OAuthTokenManager, in-memory cache, valid_access_token |
| `crates/am-auth/src/lib.rs` | Modify | pub mod oauth |
| `crates/am-protocols/src/imap.rs` | Modify | Add ImapAuth enum (hand-written Debug), change connect() signature, add XOAUTH2 authenticator |
| `crates/am-protocols/src/smtp.rs` | Modify | Add SmtpAuth enum (hand-written Debug), change send_raw() signature, add Mechanism::Xoauth2 branch |
| `crates/am-protocols/Cargo.toml` | Modify | Add base64 dep |
| `crates/am-sync/src/auth.rs` | Create | AccountAuth, CredentialSource trait, KeychainCredentialSource |
| `crates/am-sync/src/service.rs` | Modify | Add SyncError::NeedsReauth + From<OAuthError>; thread creds through all connecting fns |
| `crates/am-sync/src/send.rs` | Modify | Thread creds through drain_outbox, drain_draft_sync |
| `crates/am-sync/src/engine.rs` | Modify | SyncEngine gains creds field; idle_inbox + spawn_account accept creds |
| `crates/am-sync/src/lib.rs` | Modify | pub mod auth |
| `crates/am-sync/Cargo.toml` | Modify | Add async-trait dep |
| `crates/am-app/src/state.rs` | Modify | AppState gains creds: Arc<KeychainCredentialSource> |
| `crates/am-app/src/commands.rs` | Modify | Update add_account to pass creds; add begin_google_oauth command |
| `crates/am-app/src/sink.rs` | No change in T1-T5 | — |
| `crates/am-app/src/lib.rs` | Modify | Register begin_google_oauth in collect_commands! |
| `src/ipc/queries.ts` | Modify | Add useBeginGoogleOauth |
| `src/features/accounts/AddAccountWizard.tsx` | Modify | Add "Sign in with Google" button |
| `src/features/accounts/AddAccountWizard.test.tsx` | Modify | Add test for Google button |

---

### Task 1: am-auth OAuth scaffolding — PKCE, Google constants, OAuthError/OAuthTokens

**Files:**
- Modify: `Cargo.toml` (workspace root)
- Modify: `crates/am-auth/Cargo.toml`
- Modify: `crates/am-auth/src/lib.rs`
- Create: `crates/am-auth/src/oauth/mod.rs`
- Create: `crates/am-auth/src/oauth/pkce.rs`
- Create: `crates/am-auth/src/oauth/google.rs`
- Create: `crates/am-auth/src/oauth/client.rs` (stub — OAuthTokens + OAuthError only, fns in T2)
- Test: (inline in pkce.rs and google.rs)

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `am_auth::oauth::OAuthTokens { access_token: String, refresh_token: Option<String>, expires_at: i64 }`
  - `am_auth::oauth::OAuthError` (Config, Network, InvalidGrant, Keychain variants)
  - `am_auth::oauth::pkce::{Pkce, generate_pkce, authorize_url}`
  - `am_auth::oauth::google::{GOOGLE_AUTH_URI, GOOGLE_TOKEN_URI, GOOGLE_USERINFO_URI, GOOGLE_SCOPES, google_client_id}`

- [ ] **Step 1: Add workspace dependencies**

In `/home/pszweda/projects/cyberstudio/AbeonMail/Cargo.toml`, inside `[workspace.dependencies]`, add:

```toml
oauth2 = { version = "5", default-features = false }
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json"] }
sha2 = "0.10"
base64 = "0.22"
async-trait = "0.1"
rand = "0.8"
```

- [ ] **Step 2: Add deps to am-auth Cargo.toml**

Replace the contents of `crates/am-auth/Cargo.toml` with:

```toml
[package]
name = "am-auth"
edition.workspace = true
version.workspace = true

[dependencies]
serde.workspace = true
specta.workspace = true
thiserror.workspace = true
sha2.workspace = true
base64.workspace = true
rand.workspace = true
async-trait.workspace = true

[target.'cfg(target_os = "linux")'.dependencies]
keyring = { version = "3", features = ["sync-secret-service", "crypto-rust"] }

[target.'cfg(target_os = "macos")'.dependencies]
keyring = { version = "3", features = ["apple-native"] }

[target.'cfg(target_os = "windows")'.dependencies]
keyring = { version = "3", features = ["windows-native"] }
```

Note: `reqwest` is NOT added to am-auth here — it goes in `client.rs` in T2. We add it at that step.

- [ ] **Step 3: Write failing tests for pkce.rs**

Create `crates/am-auth/src/oauth/pkce.rs`:

```rust
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::Rng;
use sha2::{Digest, Sha256};

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub fn generate_pkce() -> Pkce {
    let verifier: String = rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(64)
        .map(char::from)
        .collect();
    let challenge = s256_challenge(&verifier);
    Pkce { verifier, challenge }
}

pub fn authorize_url(
    client_id: &str,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
) -> String {
    use crate::oauth::google::{GOOGLE_AUTH_URI, GOOGLE_SCOPES};
    let scope_enc = urlencoded(GOOGLE_SCOPES);
    let redirect_enc = urlencoded(redirect_uri);
    let challenge_enc = urlencoded(challenge);
    let state_enc = urlencoded(state);
    let client_id_enc = urlencoded(client_id);
    format!(
        "{GOOGLE_AUTH_URI}?client_id={client_id_enc}&redirect_uri={redirect_enc}\
         &response_type=code&scope={scope_enc}&state={state_enc}\
         &code_challenge={challenge_enc}&code_challenge_method=S256\
         &access_type=offline&prompt=consent"
    )
}

fn s256_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let digest = hasher.finalize();
    URL_SAFE_NO_PAD.encode(digest)
}

fn urlencoded(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                out.push_str(&format!("{b:02X}"));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s256_rfc7636_appendix_b_vector() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = s256_challenge(verifier);
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn authorize_url_contains_required_params() {
        let url = authorize_url("MY_CLIENT", "http://127.0.0.1:9999", "CHALLENGE_XYZ", "STATE_ABC");
        assert!(url.contains("client_id=MY_CLIENT"), "missing client_id");
        assert!(url.contains("response_type=code"), "missing response_type");
        assert!(url.contains("code_challenge=CHALLENGE_XYZ"), "missing code_challenge");
        assert!(url.contains("code_challenge_method=S256"), "missing method");
        assert!(url.contains("access_type=offline"), "missing access_type");
        assert!(url.contains("prompt=consent"), "missing prompt");
        assert!(url.contains("state=STATE_ABC"), "missing state");
        assert!(url.contains("redirect_uri="), "missing redirect_uri");
    }

    #[test]
    fn generate_pkce_challenge_matches_verifier() {
        let pkce = generate_pkce();
        let recomputed = s256_challenge(&pkce.verifier);
        assert_eq!(pkce.challenge, recomputed);
    }
}
```

- [ ] **Step 4: Run failing tests**

```bash
cargo test -p am-auth 2>&1 | head -30
```

Expected: compilation error — `crate::oauth::google` not found.

- [ ] **Step 5: Create google.rs**

Create `crates/am-auth/src/oauth/google.rs`:

```rust
use crate::oauth::OAuthError;

pub const GOOGLE_AUTH_URI: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const GOOGLE_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
pub const GOOGLE_USERINFO_URI: &str = "https://www.googleapis.com/oauth2/v3/userinfo";
pub const GOOGLE_SCOPES: &str = "https://mail.google.com/ openid email";

pub fn google_client_id() -> Result<String, OAuthError> {
    std::env::var("ABEONMAIL_GOOGLE_CLIENT_ID")
        .map_err(|_| OAuthError::Config("ABEONMAIL_GOOGLE_CLIENT_ID not set".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_client_id_reads_env() {
        std::env::set_var("ABEONMAIL_GOOGLE_CLIENT_ID", "test-client-id-123");
        let id = google_client_id().unwrap();
        assert_eq!(id, "test-client-id-123");
        std::env::remove_var("ABEONMAIL_GOOGLE_CLIENT_ID");
    }

    #[test]
    fn google_client_id_missing_returns_config_error() {
        std::env::remove_var("ABEONMAIL_GOOGLE_CLIENT_ID");
        let result = google_client_id();
        assert!(matches!(result, Err(OAuthError::Config(_))));
    }
}
```

- [ ] **Step 6: Create client.rs stub (types only)**

Create `crates/am-auth/src/oauth/client.rs`:

```rust
use crate::oauth::OAuthError;

#[derive(Clone)]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64,
}

#[async_trait::async_trait]
pub trait TokenHttp: Send + Sync {
    async fn post_form(
        &self,
        url: &str,
        form: &[(&str, &str)],
    ) -> Result<(u16, String), OAuthError>;
    async fn get_bearer(
        &self,
        url: &str,
        access_token: &str,
    ) -> Result<(u16, String), OAuthError>;
}
```

- [ ] **Step 7: Create oauth/mod.rs**

Create `crates/am-auth/src/oauth/mod.rs`:

```rust
pub mod client;
pub mod google;
pub mod manager;
pub mod pkce;

pub use client::{OAuthTokens, TokenHttp};

#[derive(thiserror::Error, Debug)]
pub enum OAuthError {
    #[error("oauth config error: {0}")]
    Config(String),
    #[error("oauth network error: {0}")]
    Network(String),
    #[error("oauth consent revoked")]
    InvalidGrant,
    #[error("oauth keychain error")]
    Keychain,
}
```

- [ ] **Step 8: Create manager.rs stub**

Create `crates/am-auth/src/oauth/manager.rs`:

```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::oauth::{OAuthError, OAuthTokens, TokenHttp};

pub struct OAuthTokenManager {
    cache: Mutex<HashMap<String, OAuthTokens>>,
    http: Arc<dyn TokenHttp>,
}

impl OAuthTokenManager {
    pub fn new(http: Arc<dyn TokenHttp>) -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
            http,
        }
    }

    pub fn seed(&self, auth_ref: &str, tokens: &OAuthTokens) {
        let mut guard = self.cache.lock().unwrap();
        guard.insert(auth_ref.to_string(), tokens.clone());
    }

    pub async fn valid_access_token(
        &self,
        auth_ref: &str,
        client_id: &str,
        now: i64,
    ) -> Result<String, OAuthError> {
        {
            let guard = self.cache.lock().unwrap();
            if let Some(cached) = guard.get(auth_ref) {
                if cached.expires_at - now > 300 {
                    return Ok(cached.access_token.clone());
                }
            }
        }

        let refresh_token = crate::credentials::load_password(auth_ref)
            .map_err(|_| OAuthError::Keychain)?;

        let new_tokens =
            crate::oauth::client::refresh_tokens(self.http.as_ref(), client_id, &refresh_token)
                .await?;

        {
            let mut guard = self.cache.lock().unwrap();
            guard.insert(auth_ref.to_string(), new_tokens.clone());
        }

        Ok(new_tokens.access_token)
    }
}
```

- [ ] **Step 9: Add pub mod oauth to am-auth lib.rs**

Edit `crates/am-auth/src/lib.rs` — append `pub mod oauth;` at the end of the module declarations:

```rust
pub mod credentials;
pub mod endpoints;
pub mod oauth;
pub mod provider;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("keychain error: {0}")]
    Keychain(String),
    #[error("credential not found")]
    NotFound,
}

impl From<keyring::Error> for AuthError {
    fn from(e: keyring::Error) -> Self {
        match e {
            keyring::Error::NoEntry => AuthError::NotFound,
            other => AuthError::Keychain(other.to_string()),
        }
    }
}
```

- [ ] **Step 10: Add stub for refresh_tokens to client.rs so manager.rs compiles**

Add to `crates/am-auth/src/oauth/client.rs` (after the trait definition):

```rust
pub async fn refresh_tokens(
    _http: &dyn TokenHttp,
    _client_id: &str,
    _refresh_token: &str,
) -> Result<OAuthTokens, OAuthError> {
    Err(OAuthError::Network("not implemented".into()))
}
```

- [ ] **Step 11: Run tests — all pass**

```bash
cargo test -p am-auth
```

Expected output contains:
```
test oauth::pkce::tests::s256_rfc7636_appendix_b_vector ... ok
test oauth::pkce::tests::authorize_url_contains_required_params ... ok
test oauth::pkce::tests::generate_pkce_challenge_matches_verifier ... ok
test oauth::google::tests::google_client_id_reads_env ... ok
test oauth::google::tests::google_client_id_missing_returns_config_error ... ok
```

- [ ] **Step 12: Commit**

```bash
git add Cargo.toml crates/am-auth/Cargo.toml crates/am-auth/src/lib.rs crates/am-auth/src/oauth/
git commit -m "feat(am-auth): add OAuth scaffolding — PKCE S256, Google constants, OAuthTokenManager stub"
```

---

### Task 2: am-auth — TokenHttp trait + ReqwestHttp + exchange_code / refresh_tokens / fetch_email

**Files:**
- Modify: `crates/am-auth/Cargo.toml` (add reqwest)
- Modify: `crates/am-auth/src/oauth/client.rs` (full implementation)

**Interfaces:**
- Consumes: `OAuthTokens`, `OAuthError`, `TokenHttp` from T1
- Produces:
  - `am_auth::oauth::client::ReqwestHttp` (production HTTP impl)
  - `am_auth::oauth::client::exchange_code(http, client_id, code, verifier, redirect_uri) -> Result<OAuthTokens, OAuthError>`
  - `am_auth::oauth::client::refresh_tokens(http, client_id, refresh_token) -> Result<OAuthTokens, OAuthError>`
  - `am_auth::oauth::client::fetch_email(http, access_token) -> Result<String, OAuthError>`

- [ ] **Step 1: Add reqwest to am-auth Cargo.toml**

Add reqwest workspace dep to `crates/am-auth/Cargo.toml` under `[dependencies]`:

```toml
reqwest.workspace = true
tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
```

- [ ] **Step 2: Write failing tests**

Add a `#[cfg(test)]` block at the bottom of `crates/am-auth/src/oauth/client.rs` (before writing the implementation):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    struct FakeHttp {
        responses: std::sync::Mutex<std::collections::VecDeque<(u16, String)>>,
    }

    impl FakeHttp {
        fn new(responses: Vec<(u16, String)>) -> Self {
            Self { responses: std::sync::Mutex::new(responses.into()) }
        }
    }

    #[async_trait::async_trait]
    impl TokenHttp for FakeHttp {
        async fn post_form(
            &self,
            _url: &str,
            _form: &[(&str, &str)],
        ) -> Result<(u16, String), OAuthError> {
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| OAuthError::Network("no more fake responses".into()))
        }

        async fn get_bearer(
            &self,
            _url: &str,
            _access_token: &str,
        ) -> Result<(u16, String), OAuthError> {
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| OAuthError::Network("no more fake responses".into()))
        }
    }

    #[tokio::test]
    async fn exchange_code_parses_tokens() {
        let now = 1_700_000_000i64;
        let body = r#"{"access_token":"ACC","refresh_token":"REF","expires_in":3600}"#;
        let http = FakeHttp::new(vec![(200, body.into())]);
        let tokens = exchange_code_with_now(
            &http,
            "client_id",
            "code_xyz",
            "verifier_abc",
            "http://127.0.0.1:9999",
            now,
        )
        .await
        .unwrap();
        assert_eq!(tokens.access_token, "ACC");
        assert_eq!(tokens.refresh_token.as_deref(), Some("REF"));
        assert_eq!(tokens.expires_at, now + 3600);
    }

    #[tokio::test]
    async fn refresh_invalid_grant_maps_to_error() {
        let body = r#"{"error":"invalid_grant"}"#;
        let http = FakeHttp::new(vec![(400, body.into())]);
        let result =
            refresh_tokens(&http, "client_id", "bad_refresh").await;
        assert!(matches!(result, Err(OAuthError::InvalidGrant)));
    }

    #[tokio::test]
    async fn fetch_email_parses_userinfo() {
        let body = r#"{"email":"user@gmail.com","sub":"12345"}"#;
        let http = FakeHttp::new(vec![(200, body.into())]);
        let email = fetch_email(&http, "some_access_token").await.unwrap();
        assert_eq!(email, "user@gmail.com");
    }
}
```

- [ ] **Step 3: Run to confirm tests fail**

```bash
cargo test -p am-auth oauth::client 2>&1 | grep -E "FAILED|error"
```

Expected: compilation error — `exchange_code_with_now` not found.

- [ ] **Step 4: Write full client.rs implementation**

Replace `crates/am-auth/src/oauth/client.rs` completely:

```rust
use crate::oauth::{OAuthError, OAuthTokens};

#[async_trait::async_trait]
pub trait TokenHttp: Send + Sync {
    async fn post_form(
        &self,
        url: &str,
        form: &[(&str, &str)],
    ) -> Result<(u16, String), OAuthError>;
    async fn get_bearer(
        &self,
        url: &str,
        access_token: &str,
    ) -> Result<(u16, String), OAuthError>;
}

pub struct ReqwestHttp {
    client: reqwest::Client,
}

impl ReqwestHttp {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .use_rustls_tls()
            .build()
            .expect("failed to build reqwest client");
        Self { client }
    }
}

impl Default for ReqwestHttp {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl TokenHttp for ReqwestHttp {
    async fn post_form(
        &self,
        url: &str,
        form: &[(&str, &str)],
    ) -> Result<(u16, String), OAuthError> {
        let resp = self
            .client
            .post(url)
            .form(form)
            .send()
            .await
            .map_err(|e| OAuthError::Network(e.to_string()))?;
        let status = resp.status().as_u16();
        let body = resp
            .text()
            .await
            .map_err(|e| OAuthError::Network(e.to_string()))?;
        Ok((status, body))
    }

    async fn get_bearer(
        &self,
        url: &str,
        access_token: &str,
    ) -> Result<(u16, String), OAuthError> {
        let resp = self
            .client
            .get(url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| OAuthError::Network(e.to_string()))?;
        let status = resp.status().as_u16();
        let body = resp
            .text()
            .await
            .map_err(|e| OAuthError::Network(e.to_string()))?;
        Ok((status, body))
    }
}

pub async fn exchange_code(
    http: &dyn TokenHttp,
    client_id: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<OAuthTokens, OAuthError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    exchange_code_with_now(http, client_id, code, verifier, redirect_uri, now).await
}

pub(crate) async fn exchange_code_with_now(
    http: &dyn TokenHttp,
    client_id: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
    now: i64,
) -> Result<OAuthTokens, OAuthError> {
    use crate::oauth::google::GOOGLE_TOKEN_URI;
    let form = [
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("code", code),
        ("code_verifier", verifier),
        ("redirect_uri", redirect_uri),
    ];
    let (status, body) = http.post_form(GOOGLE_TOKEN_URI, &form).await?;
    parse_token_response(status, &body, now)
}

pub async fn refresh_tokens(
    http: &dyn TokenHttp,
    client_id: &str,
    refresh_token: &str,
) -> Result<OAuthTokens, OAuthError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    use crate::oauth::google::GOOGLE_TOKEN_URI;
    let form = [
        ("grant_type", "refresh_token"),
        ("client_id", client_id),
        ("refresh_token", refresh_token),
    ];
    let (status, body) = http.post_form(GOOGLE_TOKEN_URI, &form).await?;
    parse_token_response(status, &body, now)
}

pub async fn fetch_email(
    http: &dyn TokenHttp,
    access_token: &str,
) -> Result<String, OAuthError> {
    use crate::oauth::google::GOOGLE_USERINFO_URI;
    let (status, body) = http.get_bearer(GOOGLE_USERINFO_URI, access_token).await?;
    if status != 200 {
        return Err(OAuthError::Network(format!("userinfo status {status}")));
    }
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| OAuthError::Network(e.to_string()))?;
    v["email"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| OAuthError::Network("no email field in userinfo".into()))
}

fn parse_token_response(status: u16, body: &str, now: i64) -> Result<OAuthTokens, OAuthError> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| OAuthError::Network(e.to_string()))?;

    if status != 200 {
        let err = v["error"].as_str().unwrap_or("");
        if err == "invalid_grant" {
            return Err(OAuthError::InvalidGrant);
        }
        return Err(OAuthError::Network(format!("token endpoint status {status}: {err}")));
    }

    let access_token = v["access_token"]
        .as_str()
        .ok_or_else(|| OAuthError::Network("missing access_token".into()))?
        .to_string();
    let refresh_token = v["refresh_token"].as_str().map(|s| s.to_string());
    let expires_in = v["expires_in"].as_i64().unwrap_or(3600);
    let expires_at = now + expires_in;

    Ok(OAuthTokens { access_token, refresh_token, expires_at })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeHttp {
        responses: std::sync::Mutex<std::collections::VecDeque<(u16, String)>>,
    }

    impl FakeHttp {
        fn new(responses: Vec<(u16, String)>) -> Self {
            Self { responses: std::sync::Mutex::new(responses.into()) }
        }
    }

    #[async_trait::async_trait]
    impl TokenHttp for FakeHttp {
        async fn post_form(
            &self,
            _url: &str,
            _form: &[(&str, &str)],
        ) -> Result<(u16, String), OAuthError> {
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| OAuthError::Network("no more fake responses".into()))
        }

        async fn get_bearer(
            &self,
            _url: &str,
            _access_token: &str,
        ) -> Result<(u16, String), OAuthError> {
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| OAuthError::Network("no more fake responses".into()))
        }
    }

    #[tokio::test]
    async fn exchange_code_parses_tokens() {
        let now = 1_700_000_000i64;
        let body = r#"{"access_token":"ACC","refresh_token":"REF","expires_in":3600}"#;
        let http = FakeHttp::new(vec![(200, body.into())]);
        let tokens = exchange_code_with_now(
            &http,
            "client_id",
            "code_xyz",
            "verifier_abc",
            "http://127.0.0.1:9999",
            now,
        )
        .await
        .unwrap();
        assert_eq!(tokens.access_token, "ACC");
        assert_eq!(tokens.refresh_token.as_deref(), Some("REF"));
        assert_eq!(tokens.expires_at, now + 3600);
    }

    #[tokio::test]
    async fn refresh_invalid_grant_maps_to_error() {
        let body = r#"{"error":"invalid_grant"}"#;
        let http = FakeHttp::new(vec![(400, body.into())]);
        let result = refresh_tokens(&http, "client_id", "bad_refresh").await;
        assert!(matches!(result, Err(OAuthError::InvalidGrant)));
    }

    #[tokio::test]
    async fn fetch_email_parses_userinfo() {
        let body = r#"{"email":"user@gmail.com","sub":"12345"}"#;
        let http = FakeHttp::new(vec![(200, body.into())]);
        let email = fetch_email(&http, "some_access_token").await.unwrap();
        assert_eq!(email, "user@gmail.com");
    }
}
```

Also add `serde_json` to `crates/am-auth/Cargo.toml` under `[dependencies]`:

```toml
serde_json.workspace = true
```

- [ ] **Step 5: Run tests**

```bash
cargo test -p am-auth
```

Expected output contains:
```
test oauth::client::tests::exchange_code_parses_tokens ... ok
test oauth::client::tests::refresh_invalid_grant_maps_to_error ... ok
test oauth::client::tests::fetch_email_parses_userinfo ... ok
```

- [ ] **Step 6: Commit**

```bash
git add crates/am-auth/
git commit -m "feat(am-auth): implement OAuth HTTP client with FakeHttp-testable exchange/refresh/fetch_email"
```

---

### Task 3: am-auth — OAuthTokenManager full implementation + tests

**Files:**
- Modify: `crates/am-auth/src/oauth/manager.rs`

**Interfaces:**
- Consumes: `OAuthTokens`, `OAuthError`, `TokenHttp` (T1/T2); `credentials::load_password` (existing); `refresh_tokens` (T2)
- Produces:
  - `OAuthTokenManager::new(http: Arc<dyn TokenHttp>) -> Self`
  - `OAuthTokenManager::seed(&self, auth_ref: &str, tokens: &OAuthTokens)`
  - `OAuthTokenManager::valid_access_token(&self, auth_ref: &str, client_id: &str, now: i64) -> Result<String, OAuthError>`

- [ ] **Step 1: Write failing tests in manager.rs**

Replace `crates/am-auth/src/oauth/manager.rs` with:

```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::oauth::{OAuthError, OAuthTokens, TokenHttp};

pub struct OAuthTokenManager {
    cache: Mutex<HashMap<String, OAuthTokens>>,
    http: Arc<dyn TokenHttp>,
}

impl OAuthTokenManager {
    pub fn new(http: Arc<dyn TokenHttp>) -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
            http,
        }
    }

    pub fn seed(&self, auth_ref: &str, tokens: &OAuthTokens) {
        let mut guard = self.cache.lock().unwrap();
        guard.insert(auth_ref.to_string(), tokens.clone());
    }

    pub async fn valid_access_token(
        &self,
        auth_ref: &str,
        client_id: &str,
        now: i64,
    ) -> Result<String, OAuthError> {
        {
            let guard = self.cache.lock().unwrap();
            if let Some(cached) = guard.get(auth_ref) {
                if cached.expires_at - now > 300 {
                    return Ok(cached.access_token.clone());
                }
            }
        }

        let refresh_token = crate::credentials::load_password(auth_ref)
            .map_err(|_| OAuthError::Keychain)?;

        let new_tokens =
            crate::oauth::client::refresh_tokens(self.http.as_ref(), client_id, &refresh_token)
                .await?;

        {
            let mut guard = self.cache.lock().unwrap();
            guard.insert(auth_ref.to_string(), new_tokens.clone());
        }

        Ok(new_tokens.access_token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{delete_password, store_password};
    use crate::oauth::client::TokenHttp;
    use keyring::credential::{
        Credential, CredentialApi, CredentialBuilderApi, CredentialPersistence,
    };
    use std::any::Any;
    use std::collections::VecDeque;

    static STORE: Mutex<Option<HashMap<(String, String), String>>> = Mutex::new(None);
    static INIT: std::sync::Once = std::sync::Once::new();

    fn install_in_mem_builder() {
        INIT.call_once(|| {
            *STORE.lock().unwrap() = Some(HashMap::new());
            keyring::set_default_credential_builder(Box::new(InMemCredBuilder));
        });
    }

    struct InMemCred {
        service: String,
        user: String,
    }

    impl CredentialApi for InMemCred {
        fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
            let pw = String::from_utf8(secret.to_vec())
                .map_err(|_| keyring::Error::BadEncoding(secret.to_vec()))?;
            STORE
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .insert((self.service.clone(), self.user.clone()), pw);
            Ok(())
        }
        fn get_secret(&self) -> keyring::Result<Vec<u8>> {
            STORE
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .get(&(self.service.clone(), self.user.clone()))
                .map(|s| s.as_bytes().to_vec())
                .ok_or(keyring::Error::NoEntry)
        }
        fn delete_credential(&self) -> keyring::Result<()> {
            STORE
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .remove(&(self.service.clone(), self.user.clone()))
                .map(|_| ())
                .ok_or(keyring::Error::NoEntry)
        }
        fn as_any(&self) -> &dyn Any {
            self
        }
    }

    struct InMemCredBuilder;

    impl CredentialBuilderApi for InMemCredBuilder {
        fn build(
            &self,
            _target: Option<&str>,
            service: &str,
            user: &str,
        ) -> keyring::Result<Box<Credential>> {
            Ok(Box::new(InMemCred {
                service: service.to_string(),
                user: user.to_string(),
            }))
        }
        fn as_any(&self) -> &dyn Any {
            self
        }
        fn persistence(&self) -> CredentialPersistence {
            CredentialPersistence::ProcessOnly
        }
    }

    struct FakeHttp {
        calls: Mutex<u32>,
        responses: Mutex<VecDeque<(u16, String)>>,
    }

    impl FakeHttp {
        fn new(responses: Vec<(u16, String)>) -> Self {
            Self {
                calls: Mutex::new(0),
                responses: Mutex::new(responses.into()),
            }
        }
        fn call_count(&self) -> u32 {
            *self.calls.lock().unwrap()
        }
    }

    #[async_trait::async_trait]
    impl TokenHttp for FakeHttp {
        async fn post_form(
            &self,
            _url: &str,
            _form: &[(&str, &str)],
        ) -> Result<(u16, String), OAuthError> {
            *self.calls.lock().unwrap() += 1;
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| OAuthError::Network("no more responses".into()))
        }
        async fn get_bearer(
            &self,
            _url: &str,
            _access_token: &str,
        ) -> Result<(u16, String), OAuthError> {
            *self.calls.lock().unwrap() += 1;
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| OAuthError::Network("no more responses".into()))
        }
    }

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    #[tokio::test]
    async fn cached_not_expired_returns_without_http_call() {
        install_in_mem_builder();
        let _guard = TEST_LOCK.lock().unwrap();

        let http = Arc::new(FakeHttp::new(vec![]));
        let mgr = OAuthTokenManager::new(Arc::clone(&http) as Arc<dyn TokenHttp>);

        let now = 1_700_000_000i64;
        let tokens = OAuthTokens {
            access_token: "CACHED_TOKEN".into(),
            refresh_token: Some("REF".into()),
            expires_at: now + 3600,
        };
        mgr.seed("ref@manager.test", &tokens);

        let result = mgr.valid_access_token("ref@manager.test", "client", now).await.unwrap();
        assert_eq!(result, "CACHED_TOKEN");
        assert_eq!(http.call_count(), 0);
    }

    #[tokio::test]
    async fn expired_triggers_refresh_from_keychain() {
        install_in_mem_builder();
        let _guard = TEST_LOCK.lock().unwrap();

        let auth_ref = "expired@manager.test";
        let _ = delete_password(auth_ref);
        store_password(auth_ref, "my_refresh_token").unwrap();

        let now = 1_700_000_000i64;
        let body = r#"{"access_token":"NEW_TOKEN","expires_in":3600}"#;
        let http = Arc::new(FakeHttp::new(vec![(200, body.into())]));
        let mgr = OAuthTokenManager::new(Arc::clone(&http) as Arc<dyn TokenHttp>);

        let old = OAuthTokens {
            access_token: "OLD".into(),
            refresh_token: None,
            expires_at: now + 100,
        };
        mgr.seed(auth_ref, &old);

        let result = mgr.valid_access_token(auth_ref, "client", now).await.unwrap();
        assert_eq!(result, "NEW_TOKEN");
        assert_eq!(http.call_count(), 1);

        let _ = delete_password(auth_ref);
    }

    #[tokio::test]
    async fn invalid_grant_propagates() {
        install_in_mem_builder();
        let _guard = TEST_LOCK.lock().unwrap();

        let auth_ref = "revoked@manager.test";
        let _ = delete_password(auth_ref);
        store_password(auth_ref, "revoked_token").unwrap();

        let now = 1_700_000_000i64;
        let body = r#"{"error":"invalid_grant"}"#;
        let http = Arc::new(FakeHttp::new(vec![(400, body.into())]));
        let mgr = OAuthTokenManager::new(Arc::clone(&http) as Arc<dyn TokenHttp>);

        let old = OAuthTokens {
            access_token: "OLD".into(),
            refresh_token: None,
            expires_at: now + 100,
        };
        mgr.seed(auth_ref, &old);

        let result = mgr.valid_access_token(auth_ref, "client", now).await;
        assert!(matches!(result, Err(OAuthError::InvalidGrant)));

        let _ = delete_password(auth_ref);
    }
}
```

- [ ] **Step 2: Run tests**

```bash
cargo test -p am-auth oauth::manager
```

Expected output contains:
```
test oauth::manager::tests::cached_not_expired_returns_without_http_call ... ok
test oauth::manager::tests::expired_triggers_refresh_from_keychain ... ok
test oauth::manager::tests::invalid_grant_propagates ... ok
```

- [ ] **Step 3: Commit**

```bash
git add crates/am-auth/src/oauth/manager.rs
git commit -m "feat(am-auth): implement OAuthTokenManager with expiry-buffer refresh and InvalidGrant propagation"
```

---

### Task 4: am-protocols — ImapAuth/SmtpAuth enums + XOAUTH2, update all callers

**Files:**
- Modify: `crates/am-protocols/Cargo.toml` (add base64)
- Modify: `crates/am-protocols/src/imap.rs`
- Modify: `crates/am-protocols/src/smtp.rs`
- Modify: `crates/am-sync/src/service.rs` (wrap password in Password variant)
- Modify: `crates/am-sync/src/send.rs` (wrap password in Password variant)
- Modify: `crates/am-sync/src/engine.rs` (wrap password in Password variant)

**Interfaces:**
- Consumes: nothing from T1-T3
- Produces:
  - `am_protocols::imap::ImapAuth` enum (hand-written redacting Debug) with `Password(String)` and `XOauth2 { user: String, access_token: String }` variants
  - `am_protocols::smtp::SmtpAuth` enum (same variants, hand-written Debug)
  - `ImapSession::connect(config: &ImapConfig, auth: &ImapAuth) -> Result<ImapSession, ProtocolError>`
  - `send_raw(config: &SmtpConfig, auth: &SmtpAuth, from: &str, recipients: &[String], bytes: &[u8]) -> Result<(), ProtocolError>`

- [ ] **Step 1: Add base64 to am-protocols Cargo.toml**

In `crates/am-protocols/Cargo.toml` add under `[dependencies]`:

```toml
base64.workspace = true
```

- [ ] **Step 2: Write failing XOAUTH2 SASL test**

Add to the `#[cfg(test)]` block at bottom of `crates/am-protocols/src/imap.rs`:

```rust
    #[test]
    fn xoauth2_sasl_base64_matches_expected() {
        let user = "user@gmail.com";
        let token = "ya29.some_token";
        let raw = format!("user={user}\x01auth=Bearer {token}\x01\x01");
        use base64::{engine::general_purpose::STANDARD, Engine};
        let encoded = STANDARD.encode(raw.as_bytes());
        assert_eq!(
            encoded,
            base64::engine::general_purpose::STANDARD
                .encode(format!("user=user@gmail.com\x01auth=Bearer ya29.some_token\x01\x01").as_bytes())
        );
        assert!(encoded.contains("=") || !encoded.is_empty());
        let decoded = String::from_utf8(STANDARD.decode(&encoded).unwrap()).unwrap();
        assert!(decoded.contains("user=user@gmail.com"));
        assert!(decoded.contains("auth=Bearer ya29.some_token"));
    }
```

- [ ] **Step 3: Run to confirm it fails**

```bash
cargo test -p am-protocols 2>&1 | grep -E "error|FAILED"
```

Expected: compilation error — `base64` not in scope.

- [ ] **Step 4: Implement ImapAuth and update imap.rs**

Replace the beginning of `crates/am-protocols/src/imap.rs`, adding `ImapAuth` enum and the XOAUTH2 authenticator struct, and changing `connect()`. The file changes are:

1. Add `use base64::{engine::general_purpose::STANDARD, Engine};` import at the top.
2. Add `ImapAuth` enum after the imports:

```rust
#[derive(Clone)]
pub enum ImapAuth {
    Password(String),
    XOauth2 { user: String, access_token: String },
}

impl std::fmt::Debug for ImapAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImapAuth::Password(_) => f.write_str("ImapAuth::Password(***)"),
            ImapAuth::XOauth2 { user, .. } => {
                write!(f, "ImapAuth::XOauth2 {{ user: {user:?}, access_token: *** }}")
            }
        }
    }
}
```

3. Add `Xoauth2Authenticator` struct (private) after the existing `SessionStream` enum:

```rust
struct Xoauth2Authenticator {
    sasl: String,
}

impl Xoauth2Authenticator {
    fn new(user: &str, access_token: &str) -> Self {
        let raw = format!("user={user}\x01auth=Bearer {access_token}\x01\x01");
        Self { sasl: STANDARD.encode(raw.as_bytes()) }
    }
}

impl async_imap::Authenticator for Xoauth2Authenticator {
    type Response = String;
    fn process(&mut self, _challenge: &[u8]) -> Self::Response {
        self.sasl.clone()
    }
}
```

4. Change `ImapSession::connect` signature and body:

```rust
    pub async fn connect(
        config: &ImapConfig,
        auth: &ImapAuth,
    ) -> Result<ImapSession, ProtocolError> {
        let tcp = TcpStream::connect((config.host.as_str(), config.port))
            .await
            .map_err(|e| ProtocolError::Connect(e.to_string()))?;

        if config.tls {
            let connector = build_tls_connector()?;
            let domain = ServerName::try_from(config.host.clone())
                .map_err(|e| ProtocolError::Tls(e.to_string()))?;
            let tls_stream = connector
                .connect(domain, tcp)
                .await
                .map_err(|e| ProtocolError::Tls(e.to_string()))?;
            let client = Client::new(tls_stream);
            let session = authenticate(client, auth).await?;
            Ok(ImapSession {
                session: SessionStream::Tls(Box::new(session)),
                selected_exists: None,
            })
        } else {
            let client = Client::new(tcp);
            let session = authenticate(client, auth).await?;
            Ok(ImapSession {
                session: SessionStream::Plain(Box::new(session)),
                selected_exists: None,
            })
        }
    }
```

5. Replace the `login` free function with an `authenticate` free function:

```rust
async fn authenticate<T>(
    client: Client<T>,
    auth: &ImapAuth,
) -> Result<Session<T>, ProtocolError>
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + std::fmt::Debug + Send,
{
    match auth {
        ImapAuth::Password(pw) => {
            let username = match &client {
                _ => "",
            };
            client
                .login(username, pw)
                .await
                .map_err(|(_, _)| ProtocolError::Auth)
        }
        ImapAuth::XOauth2 { user, access_token } => {
            let authenticator = Xoauth2Authenticator::new(user, access_token);
            client
                .authenticate("XOAUTH2", authenticator)
                .await
                .map_err(|(_, _)| ProtocolError::Auth)
        }
    }
}
```

Wait — the `login` function needs the username from `ImapConfig`, which isn't available inside the free function. The correct approach: pass username from `connect`. Here is the complete replacement for `connect` and `authenticate`:

```rust
    pub async fn connect(
        config: &ImapConfig,
        auth: &ImapAuth,
    ) -> Result<ImapSession, ProtocolError> {
        let tcp = TcpStream::connect((config.host.as_str(), config.port))
            .await
            .map_err(|e| ProtocolError::Connect(e.to_string()))?;

        if config.tls {
            let connector = build_tls_connector()?;
            let domain = ServerName::try_from(config.host.clone())
                .map_err(|e| ProtocolError::Tls(e.to_string()))?;
            let tls_stream = connector
                .connect(domain, tcp)
                .await
                .map_err(|e| ProtocolError::Tls(e.to_string()))?;
            let client = Client::new(tls_stream);
            let session = authenticate(client, &config.username, auth).await?;
            Ok(ImapSession {
                session: SessionStream::Tls(Box::new(session)),
                selected_exists: None,
            })
        } else {
            let client = Client::new(tcp);
            let session = authenticate(client, &config.username, auth).await?;
            Ok(ImapSession {
                session: SessionStream::Plain(Box::new(session)),
                selected_exists: None,
            })
        }
    }
```

And the free function:

```rust
async fn authenticate<T>(
    client: Client<T>,
    username: &str,
    auth: &ImapAuth,
) -> Result<Session<T>, ProtocolError>
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + std::fmt::Debug + Send,
{
    match auth {
        ImapAuth::Password(pw) => client
            .login(username, pw)
            .await
            .map_err(|(_, _)| ProtocolError::Auth),
        ImapAuth::XOauth2 { user, access_token } => {
            let authenticator = Xoauth2Authenticator::new(user, access_token);
            client
                .authenticate("XOAUTH2", authenticator)
                .await
                .map_err(|(_, _)| ProtocolError::Auth)
        }
    }
}
```

Remove the old `login` function entirely.

- [ ] **Step 5: Implement SmtpAuth and update smtp.rs**

Replace `crates/am-protocols/src/smtp.rs` completely:

```rust
use std::str::FromStr;

use base64::{engine::general_purpose::STANDARD, Engine};
use lettre::address::Envelope;
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::transport::smtp::AsyncSmtpTransport;
use lettre::{Address, AsyncTransport, Tokio1Executor};

use crate::error::ProtocolError;

pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub username: String,
}

#[derive(Clone)]
pub enum SmtpAuth {
    Password(String),
    XOauth2 { user: String, access_token: String },
}

impl std::fmt::Debug for SmtpAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SmtpAuth::Password(_) => f.write_str("SmtpAuth::Password(***)"),
            SmtpAuth::XOauth2 { user, .. } => {
                write!(f, "SmtpAuth::XOauth2 {{ user: {user:?}, access_token: *** }}")
            }
        }
    }
}

pub async fn send_raw(
    config: &SmtpConfig,
    auth: &SmtpAuth,
    from: &str,
    recipients: &[String],
    bytes: &[u8],
) -> Result<(), ProtocolError> {
    let from_addr =
        Address::from_str(from).map_err(|e| ProtocolError::Protocol(e.to_string()))?;
    let mut to_addrs = Vec::with_capacity(recipients.len());
    for r in recipients {
        to_addrs.push(Address::from_str(r).map_err(|e| ProtocolError::Protocol(e.to_string()))?);
    }
    let envelope = Envelope::new(Some(from_addr), to_addrs)
        .map_err(|e| ProtocolError::Protocol(e.to_string()))?;

    let builder = if !config.tls {
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&config.host)
    } else if config.port == 587 {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.host)
            .map_err(|e| ProtocolError::Tls(e.to_string()))?
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&config.host)
            .map_err(|e| ProtocolError::Tls(e.to_string()))?
    };

    let transport = match auth {
        SmtpAuth::Password(pw) => builder
            .port(config.port)
            .credentials(Credentials::new(config.username.clone(), pw.clone()))
            .build(),
        SmtpAuth::XOauth2 { user, access_token } => {
            let raw = format!("user={user}\x01auth=Bearer {access_token}\x01\x01");
            let _sasl = STANDARD.encode(raw.as_bytes());
            builder
                .port(config.port)
                .authentication(vec![Mechanism::Xoauth2])
                .credentials(Credentials::new(user.clone(), access_token.clone()))
                .build()
        }
    };

    transport
        .send_raw(&envelope, bytes)
        .await
        .map(|_| ())
        .map_err(|e| ProtocolError::Protocol(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xoauth2_sasl_format_is_correct() {
        let user = "user@gmail.com";
        let token = "ya29.some_token";
        let raw = format!("user={user}\x01auth=Bearer {token}\x01\x01");
        let encoded = STANDARD.encode(raw.as_bytes());
        let decoded = String::from_utf8(STANDARD.decode(&encoded).unwrap()).unwrap();
        assert_eq!(decoded, "user=user@gmail.com\x01auth=Bearer ya29.some_token\x01\x01");
    }

    #[test]
    fn smtp_auth_debug_redacts_password() {
        let auth = SmtpAuth::Password("secret123".into());
        let debug = format!("{auth:?}");
        assert!(!debug.contains("secret123"));
        assert!(debug.contains("***"));
    }

    #[test]
    fn smtp_auth_debug_redacts_token() {
        let auth = SmtpAuth::XOauth2 {
            user: "u@g.com".into(),
            access_token: "tok123".into(),
        };
        let debug = format!("{auth:?}");
        assert!(!debug.contains("tok123"));
        assert!(debug.contains("u@g.com"));
    }
}
```

- [ ] **Step 6: Update am-sync callers to wrap password in Password variant**

In `crates/am-sync/src/service.rs`, every call to `ImapSession::connect(&config, &password)` must become `ImapSession::connect(&config, &ImapAuth::Password(password.clone()))`. Add the import `use am_protocols::imap::ImapAuth;` at the top.

Affected lines (search for `ImapSession::connect`):
- `add_account` function
- `sync_folder` function
- `get_or_fetch_body` function
- `get_or_fetch_recipients` function
- `incremental_sync_folder` function
- `drain_queue` function

For each occurrence, change:

```rust
let mut session = ImapSession::connect(&config, &password).await?;
```

to:

```rust
let mut session = ImapSession::connect(&config, &ImapAuth::Password(password.clone())).await?;
```

And change:

```rust
let password = am_auth::credentials::load_password(&account.email)?;
```

No change needed there — keep loading the password. Only the call site changes.

In `crates/am-sync/src/send.rs`, add `use am_protocols::imap::ImapAuth;` and `use am_protocols::smtp::SmtpAuth;`. Change:

```rust
send_raw(&smtp, &password, &msg.from_address, &recipients, &bytes).await
```

to:

```rust
send_raw(&smtp, &SmtpAuth::Password(password.clone()), &msg.from_address, &recipients, &bytes).await
```

And both `ImapSession::connect(&config, &password)` calls in send.rs become `ImapSession::connect(&config, &ImapAuth::Password(password.clone()))`.

In `crates/am-sync/src/engine.rs`, add `use am_protocols::imap::ImapAuth;`. Change `idle_inbox`:

```rust
let mut session = ImapSession::connect(&config, &password).await.map_err(|_| ())?;
```

to:

```rust
let mut session = ImapSession::connect(&config, &ImapAuth::Password(password)).await.map_err(|_| ())?;
```

- [ ] **Step 7: Run full test suite to confirm compilation and existing tests pass**

```bash
cargo test -p am-protocols && cargo test -p am-sync
```

Expected output: all existing tests pass, plus new XOAUTH2 SASL tests.

- [ ] **Step 8: Commit**

```bash
git add crates/am-protocols/ crates/am-sync/src/service.rs crates/am-sync/src/send.rs crates/am-sync/src/engine.rs
git commit -m "feat(am-protocols): add ImapAuth/SmtpAuth enums with XOAUTH2 support; wrap all callers in Password variant"
```

---

### Task 5: am-sync — auth.rs, CredentialSource trait, thread creds through engine

**Files:**
- Create: `crates/am-sync/src/auth.rs`
- Modify: `crates/am-sync/src/lib.rs`
- Modify: `crates/am-sync/src/service.rs`
- Modify: `crates/am-sync/src/send.rs`
- Modify: `crates/am-sync/src/engine.rs`
- Modify: `crates/am-sync/Cargo.toml`
- Modify: `crates/am-app/src/state.rs`
- Modify: `crates/am-app/src/commands.rs`

**Interfaces:**
- Consumes: `ImapAuth`, `SmtpAuth` (T4); `OAuthTokenManager` (T3); `OAuthError` (T1)
- Produces:
  - `am_sync::auth::AccountAuth` enum (Password / XOauth2)
  - `am_sync::auth::AccountAuth::to_imap() -> ImapAuth`
  - `am_sync::auth::AccountAuth::to_smtp() -> SmtpAuth`
  - `am_sync::auth::CredentialSource` trait: `async fn auth_for(&self, account: &Account) -> Result<AccountAuth, SyncError>`
  - `am_sync::auth::KeychainCredentialSource::new() -> Arc<Self>`
  - `am_sync::service::SyncError::NeedsReauth` variant
  - `SyncEngine::start(db, sink, creds: Arc<dyn CredentialSource>) -> Arc<Self>`
  - `AppState.creds: Arc<KeychainCredentialSource>`

- [ ] **Step 1: Add async-trait to am-sync Cargo.toml**

In `crates/am-sync/Cargo.toml` under `[dependencies]`:

```toml
async-trait.workspace = true
```

- [ ] **Step 2: Write failing test for auth.rs**

Create `crates/am-sync/src/auth.rs`:

```rust
use std::sync::Arc;

use am_core::account::{Account, ProviderType};
use am_protocols::imap::ImapAuth;
use am_protocols::smtp::SmtpAuth;

use crate::service::SyncError;

#[derive(Clone)]
pub enum AccountAuth {
    Password(String),
    XOauth2 { user: String, access_token: String },
}

impl AccountAuth {
    pub fn to_imap(&self) -> ImapAuth {
        match self {
            AccountAuth::Password(pw) => ImapAuth::Password(pw.clone()),
            AccountAuth::XOauth2 { user, access_token } => ImapAuth::XOauth2 {
                user: user.clone(),
                access_token: access_token.clone(),
            },
        }
    }

    pub fn to_smtp(&self) -> SmtpAuth {
        match self {
            AccountAuth::Password(pw) => SmtpAuth::Password(pw.clone()),
            AccountAuth::XOauth2 { user, access_token } => SmtpAuth::XOauth2 {
                user: user.clone(),
                access_token: access_token.clone(),
            },
        }
    }
}

#[async_trait::async_trait]
pub trait CredentialSource: Send + Sync {
    async fn auth_for(&self, account: &Account) -> Result<AccountAuth, SyncError>;
}

pub struct KeychainCredentialSource {
    token_manager: am_auth::oauth::manager::OAuthTokenManager,
    client_id: Option<String>,
}

impl KeychainCredentialSource {
    pub fn new() -> Arc<Self> {
        let http = Arc::new(am_auth::oauth::client::ReqwestHttp::new());
        let token_manager =
            am_auth::oauth::manager::OAuthTokenManager::new(http as Arc<dyn am_auth::oauth::TokenHttp>);
        let client_id = std::env::var("ABEONMAIL_GOOGLE_CLIENT_ID").ok();
        Arc::new(Self { token_manager, client_id })
    }

    pub fn token_manager(&self) -> &am_auth::oauth::manager::OAuthTokenManager {
        &self.token_manager
    }
}

impl Default for KeychainCredentialSource {
    fn default() -> Self {
        let http = Arc::new(am_auth::oauth::client::ReqwestHttp::new());
        let token_manager =
            am_auth::oauth::manager::OAuthTokenManager::new(http as Arc<dyn am_auth::oauth::TokenHttp>);
        let client_id = std::env::var("ABEONMAIL_GOOGLE_CLIENT_ID").ok();
        Self { token_manager, client_id }
    }
}

#[async_trait::async_trait]
impl CredentialSource for KeychainCredentialSource {
    async fn auth_for(&self, account: &Account) -> Result<AccountAuth, SyncError> {
        match account.provider_type {
            ProviderType::ImapPassword => {
                let pw = am_auth::credentials::load_password(&account.email)?;
                Ok(AccountAuth::Password(pw))
            }
            ProviderType::GoogleOauth => {
                let client_id = self
                    .client_id
                    .as_deref()
                    .ok_or_else(|| SyncError::Auth)?;
                let now = crate::service::now_secs();
                let token = self
                    .token_manager
                    .valid_access_token(&account.email, client_id, now)
                    .await
                    .map_err(SyncError::from)?;
                Ok(AccountAuth::XOauth2 {
                    user: account.email.clone(),
                    access_token: token,
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use am_core::account::ProviderType;

    fn fake_account(provider: ProviderType) -> Account {
        Account {
            id: 1,
            email: "test@example.com".into(),
            display_name: "Test".into(),
            provider_type: provider,
            color: None,
            position: 0,
        }
    }

    struct FakeCreds {
        auth: AccountAuth,
    }

    #[async_trait::async_trait]
    impl CredentialSource for FakeCreds {
        async fn auth_for(&self, _account: &Account) -> Result<AccountAuth, SyncError> {
            Ok(self.auth.clone())
        }
    }

    #[tokio::test]
    async fn fake_creds_returns_password() {
        let creds = FakeCreds { auth: AccountAuth::Password("pw".into()) };
        let account = fake_account(ProviderType::ImapPassword);
        let auth = creds.auth_for(&account).await.unwrap();
        assert!(matches!(auth, AccountAuth::Password(_)));
    }

    #[tokio::test]
    async fn fake_creds_returns_xoauth2() {
        let creds = FakeCreds {
            auth: AccountAuth::XOauth2 {
                user: "u@g.com".into(),
                access_token: "tok".into(),
            },
        };
        let account = fake_account(ProviderType::GoogleOauth);
        let auth = creds.auth_for(&account).await.unwrap();
        assert!(matches!(auth, AccountAuth::XOauth2 { .. }));
    }

    #[test]
    fn account_auth_to_imap_password() {
        let a = AccountAuth::Password("pw".into());
        assert!(matches!(a.to_imap(), ImapAuth::Password(_)));
    }

    #[test]
    fn account_auth_to_smtp_xoauth2() {
        let a = AccountAuth::XOauth2 {
            user: "u@g.com".into(),
            access_token: "tok".into(),
        };
        let s = a.to_smtp();
        assert!(matches!(s, SmtpAuth::XOauth2 { .. }));
    }
}
```

- [ ] **Step 3: Add NeedsReauth to SyncError and From<OAuthError>**

In `crates/am-sync/src/service.rs`, add to the `SyncError` enum:

```rust
    #[error("reauth required")]
    NeedsReauth,
```

And add a `From<OAuthError>` impl after the existing `From<am_auth::AuthError>`:

```rust
impl From<am_auth::oauth::OAuthError> for SyncError {
    fn from(e: am_auth::oauth::OAuthError) -> Self {
        match e {
            am_auth::oauth::OAuthError::InvalidGrant => SyncError::NeedsReauth,
            am_auth::oauth::OAuthError::Keychain => SyncError::Keychain,
            other => SyncError::Protocol(other.to_string()),
        }
    }
}
```

Also add `use am_auth::oauth::OAuthError as _OAuthError;` — actually just add the impl block; the type path is sufficient.

- [ ] **Step 4: Add pub mod auth to am-sync lib.rs**

In `crates/am-sync/src/lib.rs`:

```rust
pub mod auth;
pub mod compose;
pub mod engine;
pub mod events;
pub mod send;
pub mod service;

pub use events::{SyncEvent, SyncEventSink};
```

- [ ] **Step 5: Thread creds through service.rs**

The contract says: replace `load_password + ImapSession::connect(&config, &password)` with `creds.auth_for(&account).await? + ImapSession::connect(&config, &auth.to_imap())` in every connecting function.

Add import at top of service.rs: `use crate::auth::CredentialSource;`

Change each function signature to accept `creds: &dyn CredentialSource` and update the body. The complete affected functions (show full signatures and the credential-loading change only; the rest of the function body is unchanged):

**`sync_folder`** — change signature to:
```rust
pub async fn sync_folder(
    db: &Database,
    account_id: i64,
    folder_id: i64,
    creds: &dyn CredentialSource,
    progress: impl Fn(SyncProgress),
) -> Result<usize, SyncError> {
```
Replace:
```rust
    let password = am_auth::credentials::load_password(&account.email)?;
    ...
    let mut session = ImapSession::connect(&config, &ImapAuth::Password(password.clone())).await?;
```
With:
```rust
    let auth = creds.auth_for(&account).await?;
    ...
    let mut session = ImapSession::connect(&config, &auth.to_imap()).await?;
```

**`initial_sync_inbox`** — add `creds: &dyn CredentialSource` param, pass through to `sync_folder`.

**`sync_all_folders`** — add `creds: &dyn CredentialSource` param, pass through to `sync_folder`.

**`get_or_fetch_body`** — add `creds: &dyn CredentialSource`:
```rust
pub async fn get_or_fetch_body(db: &Database, message_id: i64, creds: &dyn CredentialSource) -> Result<MessageBody, SyncError> {
```
Replace the `load_password` + `ImapSession::connect` pair with `auth_for` + `to_imap()`.

**`get_or_fetch_recipients`** — same pattern as `get_or_fetch_body`.

**`incremental_sync_folder`** — add `creds: &dyn CredentialSource`, replace password+connect.

**`drain_queue`** — change signature to `drain_queue(db: &Database, account_id: i64, creds: &dyn CredentialSource, now: i64)` (creds immediately after `account_id`, matching the engine worker call order in 5C); replace password+connect with `auth_for` + `to_imap()`.

**`add_account`** — `add_account` uses `input.password` directly (it's a password-only flow). No creds param needed here; keep using `ImapAuth::Password(input.password.clone())` directly.

- [ ] **Step 6: Thread creds through send.rs**

Add import: `use crate::auth::CredentialSource;`

**`drain_outbox`** — change signature:
```rust
pub async fn drain_outbox(db: &Database, account_id: i64, creds: &dyn CredentialSource, now: i64) -> Result<(), SyncError> {
```
Replace:
```rust
    let password = am_auth::credentials::load_password(&account.email)?;
    ...
    send_raw(&smtp, &SmtpAuth::Password(password.clone()), ...
    ...
    if let Ok(mut session) = ImapSession::connect(&config, &ImapAuth::Password(password.clone())).await {
```
With:
```rust
    let auth = creds.auth_for(&account).await?;
    ...
    send_raw(&smtp, &auth.to_smtp(), ...
    ...
    if let Ok(mut session) = ImapSession::connect(&config, &auth.to_imap()).await {
```

**`drain_draft_sync`** — change signature:
```rust
pub async fn drain_draft_sync(db: &Database, account_id: i64, creds: &dyn CredentialSource, now: i64) -> Result<(), SyncError> {
```
Replace password+connect with `auth_for` + `to_imap()`.

- [ ] **Step 7: Thread creds through engine.rs**

`SyncEngine` gains a `creds` field:

```rust
pub struct SyncEngine {
    db: Arc<Database>,
    sink: Arc<dyn SyncEventSink>,
    creds: Arc<dyn crate::auth::CredentialSource>,
    workers: Mutex<HashMap<i64, mpsc::Sender<()>>>,
}
```

`SyncEngine::start` signature becomes:
```rust
    pub fn start(
        db: Arc<Database>,
        sink: Arc<dyn SyncEventSink>,
        creds: Arc<dyn crate::auth::CredentialSource>,
    ) -> Arc<Self> {
```
Build with `creds` field; pass `Arc::clone(&engine.creds)` (as `Arc<dyn CredentialSource>`) into `spawn_account`.

`spawn_account` passes `Arc::clone(&self.creds)` into the worker closure, where it becomes the `creds` passed to `sync_all_folders`, `drain_queue`, `drain_outbox`, `drain_draft_sync`, `incremental_sync_folder`, and `idle_inbox`.

`idle_inbox` signature becomes:
```rust
async fn idle_inbox(
    db: &Database,
    account_id: i64,
    remote_path: &str,
    creds: &dyn crate::auth::CredentialSource,
) -> Result<bool, ()> {
```
Replace the `load_password` + `ImapSession::connect` pair with `auth_for` + `to_imap()`.

- [ ] **Step 8: Update AppState to hold creds**

Replace `crates/am-app/src/state.rs` completely:

```rust
use std::sync::Arc;

use am_storage::Database;
use am_sync::auth::KeychainCredentialSource;
use am_sync::engine::SyncEngine;

pub struct AppState {
    pub db: Arc<Database>,
    pub engine: std::sync::Mutex<Option<Arc<SyncEngine>>>,
    pub creds: Arc<KeychainCredentialSource>,
}

impl AppState {
    pub fn new(db: Database) -> Self {
        Self {
            db: Arc::new(db),
            engine: std::sync::Mutex::new(None),
            creds: KeychainCredentialSource::new(),
        }
    }
}
```

- [ ] **Step 9: Update src-tauri/src/lib.rs to pass creds to SyncEngine::start**

In `src-tauri/src/lib.rs`, change the engine start line:

```rust
            let engine = am_sync::engine::SyncEngine::start(
                std::sync::Arc::clone(&state.db),
                sink,
                std::sync::Arc::clone(&state.creds) as std::sync::Arc<dyn am_sync::auth::CredentialSource>,
            );
```

- [ ] **Step 10: Update commands.rs — get_message_body and add_account**

In `crates/am-app/src/commands.rs`, `get_message_body` now needs to pass `creds`:

```rust
#[tauri::command]
#[specta::specta]
pub async fn get_message_body(
    state: tauri::State<'_, AppState>,
    message_id: i64,
) -> Result<MessageBody, String> {
    let db: Arc<am_storage::Database> = Arc::clone(&state.db);
    let creds = Arc::clone(&state.creds);
    am_sync::service::get_or_fetch_body(&db, message_id, creds.as_ref())
        .await
        .map_err(|_| "Failed to fetch message body".to_string())
}
```

Similarly, the `add_account` spawn_account call remains the same since `add_account` doesn't use creds. No further changes needed in commands.rs for T5 (begin_google_oauth comes in T6).

- [ ] **Step 11: Run tests**

```bash
cargo test -p am-sync && cargo test -p am-app
```

Expected: all tests pass.

- [ ] **Step 12: Commit**

```bash
git add crates/am-sync/ crates/am-app/src/state.rs crates/am-app/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(am-sync): add CredentialSource trait + KeychainCredentialSource; thread creds through engine"
```

---

### Task 6: am-app — begin_google_oauth command

**Files:**
- Modify: `crates/am-app/src/commands.rs`
- Modify: `crates/am-app/src/lib.rs`
- Modify: `crates/am-app/Cargo.toml` (need tauri-plugin-opener accessible)

**Interfaces:**
- Consumes: `OAuthTokenManager::seed`, `KeychainCredentialSource::token_manager`, `exchange_code`, `fetch_email`, `google_client_id`, `generate_pkce`, `authorize_url`, `store_password` (am-auth); `accounts_repo::insert_account_with_settings`; `SyncEngine::spawn_account`; `CredentialSource` (T5)
- Produces:
  - `commands::begin_google_oauth(state) -> Result<Account, String>` (Tauri command)
  - `commands::run_google_oauth_flow(app: &tauri::AppHandle) -> Result<(am_auth::oauth::client::OAuthTokens, String), String>` (`pub(crate)` shared flow; reused by 5C `begin_reauth`)
  - `parse_redirect_line(line: &str) -> Option<(String, String)>` (pure, testable — returns (code, state))

Note: `tauri-plugin-opener` is already in `src-tauri/Cargo.toml`. The am-app crate does not directly depend on it. The command must use `tauri::AppHandle` to call opener. Add `tauri-plugin-opener` to `crates/am-app/Cargo.toml`.

- [ ] **Step 1: Add tauri-plugin-opener to am-app Cargo.toml**

In `crates/am-app/Cargo.toml`, add:

```toml
tauri-plugin-opener = "2"
```

Check current content first and append the dep.

- [ ] **Step 2: Write failing tests for parse_redirect_line**

In `crates/am-app/src/commands.rs`, add a pub(crate) function and tests (add before the existing `#[cfg(test)]` block):

```rust
pub(crate) fn parse_redirect_line(line: &str) -> Option<(String, String)> {
    let path = line.split_whitespace().nth(1)?;
    let query = path.split_once('?')?.1;
    let mut code = None;
    let mut state = None;
    for part in query.split('&') {
        if let Some(v) = part.strip_prefix("code=") {
            code = Some(url_decode(v));
        } else if let Some(v) = part.strip_prefix("state=") {
            state = Some(url_decode(v));
        }
    }
    Some((code?, state?))
}

fn url_decode(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.bytes().peekable();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let h = chars.next().unwrap_or(b'0');
            let l = chars.next().unwrap_or(b'0');
            let hex = [h, l];
            if let Ok(s) = std::str::from_utf8(&hex) {
                if let Ok(v) = u8::from_str_radix(s, 16) {
                    out.push(v as char);
                    continue;
                }
            }
            out.push('%');
            out.push(h as char);
            out.push(l as char);
        } else if b == b'+' {
            out.push(' ');
        } else {
            out.push(b as char);
        }
    }
    out
}
```

Then add to the `#[cfg(test)]` block:

```rust
    #[test]
    fn parse_redirect_line_extracts_code_and_state() {
        let line = "GET /?code=AUTH_CODE_XYZ&state=CSRF_STATE_123 HTTP/1.1";
        let (code, state) = parse_redirect_line(line).unwrap();
        assert_eq!(code, "AUTH_CODE_XYZ");
        assert_eq!(state, "CSRF_STATE_123");
    }

    #[test]
    fn parse_redirect_line_missing_state_returns_none() {
        let line = "GET /?code=AUTH_CODE_XYZ HTTP/1.1";
        assert!(parse_redirect_line(line).is_none());
    }

    #[test]
    fn parse_redirect_line_bad_format_returns_none() {
        assert!(parse_redirect_line("not a request").is_none());
    }
```

- [ ] **Step 3: Run failing tests**

```bash
cargo test -p am-app parse_redirect_line
```

Expected: PASS (the function is pure and compilable immediately). If there are compile errors in the rest of commands.rs, fix those first.

- [ ] **Step 4: Write begin_google_oauth command**

Add to `crates/am-app/src/commands.rs` (after the imports, add needed imports and the command):

Add to imports:
```rust
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
```

Add the command:

```rust
#[tauri::command]
#[specta::specta]
pub async fn begin_google_oauth(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Account, String> {
    let (tokens, email) = run_google_oauth_flow(&app).await?;

    let refresh_token = tokens
        .refresh_token
        .clone()
        .ok_or_else(|| "No refresh token in Google response".to_string())?;
    am_auth::credentials::store_password(&email, &refresh_token)
        .map_err(|_| "Keychain unavailable".to_string())?;

    let db = Arc::clone(&state.db);
    let endpoints_json = serde_json::json!({
        "imap_host": "imap.gmail.com",
        "imap_port": 993,
        "imap_tls": true,
        "smtp_host": "smtp.gmail.com",
        "smtp_port": 465,
        "smtp_tls": true
    })
    .to_string();

    let new_account = am_core::account::NewAccount {
        email: email.clone(),
        display_name: email.clone(),
        provider_type: am_core::account::ProviderType::GoogleOauth,
        color: None,
    };
    let account =
        am_storage::accounts_repo::insert_account_with_settings(&db, &new_account, &email, &endpoints_json)
            .map_err(|e| e.to_string())?;

    state.creds.token_manager().seed(&email, &tokens);

    if let Some(engine) = state.engine.lock().unwrap().as_ref() {
        engine.spawn_account(account.id);
    }

    Ok(account)
}

pub(crate) async fn run_google_oauth_flow(
    app: &tauri::AppHandle,
) -> Result<(am_auth::oauth::client::OAuthTokens, String), String> {
    let client_id = am_auth::oauth::google::google_client_id()
        .map_err(|_| "Google client ID not configured".to_string())?;

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind loopback: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let pkce = am_auth::oauth::pkce::generate_pkce();
    let csrf_state: String = rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(32)
        .map(char::from)
        .collect();

    let auth_url = am_auth::oauth::pkce::authorize_url(
        &client_id,
        &redirect_uri,
        &pkce.challenge,
        &csrf_state,
    );

    tauri_plugin_opener::open_url(app, &auth_url, None::<&str>)
        .map_err(|e| format!("Failed to open browser: {e}"))?;

    accept_redirect(listener, &csrf_state, &client_id, &pkce.verifier, &redirect_uri).await
}

async fn accept_redirect(
    listener: TcpListener,
    expected_state: &str,
    client_id: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<(am_auth::oauth::client::OAuthTokens, String), String> {
    let accept_timeout = std::time::Duration::from_secs(300);
    let (stream, _) = tokio::time::timeout(accept_timeout, listener.accept())
        .await
        .map_err(|_| "OAuth timeout: browser did not redirect in time".to_string())?
        .map_err(|e| e.to_string())?;

    let (reader, mut writer) = stream.into_split();
    let mut buf_reader = BufReader::new(reader);
    let mut request_line = String::new();
    buf_reader
        .read_line(&mut request_line)
        .await
        .map_err(|e| e.to_string())?;

    let close_html = b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n\
        <html><body><p>Authentication complete. You may close this tab.</p></body></html>";

    let (code, returned_state) = match parse_redirect_line(request_line.trim()) {
        Some(v) => v,
        None => {
            let _ = writer.write_all(
                b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nBad request",
            )
            .await;
            return Err("Invalid redirect request".to_string());
        }
    };

    if returned_state != expected_state {
        let _ = writer
            .write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nState mismatch")
            .await;
        return Err("OAuth state mismatch — possible CSRF".to_string());
    }

    let _ = writer.write_all(close_html).await;

    let http = am_auth::oauth::client::ReqwestHttp::new();
    let tokens =
        am_auth::oauth::client::exchange_code(&http, client_id, &code, verifier, redirect_uri)
            .await
            .map_err(|e| e.to_string())?;

    let email = am_auth::oauth::client::fetch_email(&http, &tokens.access_token)
        .await
        .map_err(|e| e.to_string())?;

    Ok((tokens, email))
}
```

`accept_redirect` returns the full `OAuthTokens` (including the refresh token) plus the
account email. It performs no keychain write and no DB insert — the keychain store and the
account insert/update live in the caller (`begin_google_oauth` for a new account;
`begin_reauth` in 5C for an existing one), which lets each caller pick the right `auth_ref`
and decide insert-vs-update. The `code` is consumed inside `accept_redirect` by
`exchange_code`.

- [ ] **Step 5: Register command in lib.rs**

In `crates/am-app/src/lib.rs`, add `commands::begin_google_oauth` to `collect_commands!`:

```rust
        .commands(collect_commands![
            commands::app_health,
            commands::list_accounts,
            commands::resolve_endpoints,
            commands::add_account,
            commands::begin_google_oauth,
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
        ])
```

- [ ] **Step 6: Run gen:bindings**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm run gen:bindings
```

Expected: exits 0, updates `src/ipc/bindings.ts` to include `beginGoogleOauth`.

- [ ] **Step 7: Run tests**

```bash
cargo test -p am-app
```

Expected: all existing tests + new parse tests pass.

- [ ] **Step 8: Commit**

```bash
git add crates/am-app/ src/ipc/bindings.ts
git commit -m "feat(am-app): add begin_google_oauth command with loopback redirect, CSRF validation, code exchange"
```

---

### Task 7: Frontend — "Sign in with Google" button in AddAccountWizard

**Files:**
- Modify: `src/ipc/queries.ts`
- Modify: `src/features/accounts/AddAccountWizard.tsx`
- Modify: `src/features/accounts/AddAccountWizard.test.tsx`

**Interfaces:**
- Consumes: `commands.beginGoogleOauth` from generated bindings (T6)
- Produces:
  - `useBeginGoogleOauth()` mutation in queries.ts (invalidates `["accounts"]`)
  - "Sign in with Google" button in `AddAccountWizard` calling `useBeginGoogleOauth`

- [ ] **Step 1: Write failing test**

Add to `src/features/accounts/AddAccountWizard.test.tsx`:

Add `mockBeginGoogleOauth` to the mocks section and a new test. First, update the mock at the top:

```typescript
let mockBeginGoogleOauthMutateAsync: ReturnType<typeof vi.fn>;

vi.mock("../../ipc/queries", () => ({
  useResolveEndpoints: () => ({
    mutateAsync: mockResolveMutateAsync,
    isPending: false,
    error: null,
    data: undefined,
  }),
  useAddAccount: () => ({
    mutateAsync: mockAddMutateAsync,
    isPending: false,
    error: null,
    data: undefined,
  }),
  useBeginGoogleOauth: () => ({
    mutateAsync: mockBeginGoogleOauthMutateAsync,
    isPending: false,
    error: null,
    data: undefined,
  }),
}));
```

And in `beforeEach`:

```typescript
  beforeEach(() => {
    mockResolveMutateAsync = vi.fn().mockResolvedValue(fixedEndpoints);
    mockAddMutateAsync = vi.fn().mockResolvedValue(fixedAccount);
    mockBeginGoogleOauthMutateAsync = vi.fn().mockResolvedValue(fixedAccount);
  });
```

Add test:

```typescript
  it("Sign in with Google button invokes beginGoogleOauth", async () => {
    const user = userEvent.setup();
    const onAdded = vi.fn();
    const onClose = vi.fn();

    render(<AddAccountWizard onClose={onClose} onAdded={onAdded} />);

    const googleBtn = screen.getByRole("button", { name: /sign in with google/i });
    expect(googleBtn).toBeTruthy();

    await user.click(googleBtn);

    await waitFor(() => {
      expect(mockBeginGoogleOauthMutateAsync).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(onAdded).toHaveBeenCalledWith(7);
    });
  });
```

- [ ] **Step 2: Run failing test**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm test -- AddAccountWizard 2>&1 | tail -20
```

Expected: FAIL — "Sign in with Google" button not found.

- [ ] **Step 3: Add useBeginGoogleOauth to queries.ts**

Add to `src/ipc/queries.ts`:

```typescript
export function useBeginGoogleOauth() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => commands.beginGoogleOauth().then(unwrap),
    onSuccess: (account: Account) => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      queryClient.invalidateQueries({ queryKey: ["folders", account.id] });
    },
  });
}
```

- [ ] **Step 4: Add "Sign in with Google" button to AddAccountWizard.tsx**

In `src/features/accounts/AddAccountWizard.tsx`, add the import and the button. Import:

```typescript
import { useResolveEndpoints, useAddAccount, useBeginGoogleOauth } from "../../ipc/queries";
```

Inside the component, add after existing hook declarations:

```typescript
  const beginGoogleOauth = useBeginGoogleOauth();
  const [googleError, setGoogleError] = useState<string | null>(null);

  async function handleGoogleSignIn() {
    setGoogleError(null);
    try {
      const account = await beginGoogleOauth.mutateAsync();
      onAdded(account.id);
    } catch (err) {
      setGoogleError(err instanceof Error ? err.message : String(err));
    }
  }
```

In the JSX, within the first step (before the `!endpoints` block buttons area), add a "Sign in with Google" button and a divider. Place it below the password input and above the Cancel/Continue buttons row:

```tsx
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", margin: "var(--space-1) 0" }}>
            <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
            <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>or</span>
            <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
          </div>
          <button
            onClick={handleGoogleSignIn}
            disabled={beginGoogleOauth.isPending}
            aria-label="Sign in with Google"
            style={{
              background: "var(--bg-app)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-sm)",
              color: "var(--text-primary)",
              cursor: beginGoogleOauth.isPending ? "not-allowed" : "pointer",
              fontSize: "14px",
              padding: "var(--space-2) var(--space-4)",
              width: "100%",
              opacity: beginGoogleOauth.isPending ? 0.7 : 1,
            }}
          >
            {beginGoogleOauth.isPending ? "Opening browser…" : "Sign in with Google"}
          </button>
          {googleError && (
            <p style={{ color: "var(--color-error)", fontSize: "13px", margin: 0 }}>{googleError}</p>
          )}
```

- [ ] **Step 5: Run tests**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm test -- AddAccountWizard 2>&1 | tail -20
```

Expected output:
```
✓ happy path: resolves endpoints, shows prefilled fields, calls onAdded with account id
✓ shows error message when add mutation rejects
✓ Sign in with Google button invokes beginGoogleOauth
```

- [ ] **Step 6: Run full test suite**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm test 2>&1 | tail -10
cargo test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/ipc/queries.ts src/features/accounts/AddAccountWizard.tsx src/features/accounts/AddAccountWizard.test.tsx
git commit -m "feat(ui): add Sign in with Google button in AddAccountWizard with useBeginGoogleOauth"
```
