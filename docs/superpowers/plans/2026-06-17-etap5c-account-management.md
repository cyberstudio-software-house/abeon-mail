# 5C — Account Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add remove-account, re-auth on OAuth expiry, and drag-and-drop reordering — covering the Rust storage/sync/app layers and the React frontend — so users can manage accounts without a restart.

**Architecture:** The engine's worker registry is upgraded from `mpsc::Sender<()>` to `CancellationToken` (tokio-util) so workers are cancellable at any await point; `remove_account` cancels the worker, deletes the keychain secret (tolerating absent entries), then CASCADE-deletes the DB row. Re-auth wires an `AuthChanged` event from the worker through the sink to the frontend, where a per-account badge triggers a re-run of the OAuth flow. Reordering is a single DB transaction writing `position` = index.

**Tech Stack:** Rust (tokio-util CancellationToken, rusqlite transactions), Tauri 2 + tauri-specta, React 19 + Zustand + TanStack Query 5, @dnd-kit for drag-and-drop, Vitest + Testing Library.

## Global Constraints

- Code identifiers (vars, consts, types, fns) English-only. No code comments — durable notes go to `docs/`.
- Secrets (passwords, refresh tokens, access tokens) ONLY in OS keychain (refresh) or process memory (access). NEVER in DB, logs, events, error messages, or `Debug` impls.
- Node 24 at `$HOME/.nvm/versions/node/v24.14.0/bin` (prepend to PATH for `npm`).
- Rust: `cargo test -p <crate>` per crate; full `cargo test` before merge.
- Frontend: `npm test` (vitest), `npm run gen:bindings` after any command/event/type change touching tauri-specta.
- TLS provider is ring throughout; new HTTP deps must use rustls+ring, not native-tls.
- `git commit` messages follow Conventional Commits; no co-author line; no push.

## Prerequisite facts (already done — DO NOT re-implement)

- **5A** added: `SyncError::NeedsReauth`, `From<OAuthError>` mapping `InvalidGrant → NeedsReauth`, the `CredentialSource` / `AccountAuth` / `KeychainCredentialSource` machinery, `AppState.creds: Arc<KeychainCredentialSource>`, `SyncEngine::start(db, sink, creds)`, and `creds: &dyn CredentialSource` threaded through the worker. `begin_google_oauth` command exists.
- **5B** created migration `V5__oauth_smart.sql` which **already** added `accounts.requires_reauth INTEGER NOT NULL DEFAULT 0` and the two message indexes. **5C must NOT add another migration for `requires_reauth`** — the column exists; 5C only reads/writes it.

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `crates/am-core/src/account.rs` | Modify | Add `requires_reauth: bool` to `Account` |
| `crates/am-storage/src/accounts_repo.rs` | Modify | Extend tuple to 7 columns; `set_requires_reauth`; `reorder_accounts` |
| `crates/am-sync/Cargo.toml` | Modify | Add `tokio-util` dependency |
| `crates/am-sync/src/engine.rs` | Modify | Replace `mpsc::Sender<()>` with `CancellationToken`; add `stop_account`; update `shutdown` |
| `crates/am-sync/src/events.rs` | Modify | Add `SyncEvent::AuthChanged` variant |
| `crates/am-app/src/events.rs` | Modify | Add `AccountAuthChanged` struct |
| `crates/am-app/src/sink.rs` | Modify | Bridge `SyncEvent::AuthChanged → AccountAuthChanged` |
| `crates/am-app/src/commands.rs` | Modify | Add `remove_account`, `reorder_accounts`, `begin_reauth` commands |
| `crates/am-app/src/lib.rs` | Modify | Register new commands + event in `collect_commands!` / `collect_events!` |
| `src/ipc/queries.ts` | Modify | Add `useRemoveAccount`, `useReorderAccounts`, `useBeginReauth` |
| `src/ipc/events.ts` | Modify | Listen `accountAuthChanged`; add `["smart"]` invalidation to existing handlers |
| `src/app/store.ts` | Modify | (already extended by 5B for `selectedSmartFolder`; verify `setSelectedAccountId` clears it) |
| `src/features/mailbox/MailboxRail.tsx` | Modify | Remove button + confirm dialog; reauth badge; DnD reordering |
| `src/features/mailbox/MailboxRail.test.tsx` | Modify | Tests for remove, reauth badge, reorder |

---

### Task 1: am-core Account gains `requires_reauth` + am-storage tuple extended to 7 columns

**Files:**
- Modify: `crates/am-core/src/account.rs`
- Modify: `crates/am-storage/src/accounts_repo.rs`

**Interfaces:**
- Consumes: existing `Account` struct (6 fields), `row_to_account` returning a 6-tuple, `tuple_to_account` mapping it; `V5__oauth_smart.sql` already added the `requires_reauth` column.
- Produces:
  - `Account { ..., requires_reauth: bool }` — all downstream consumers of `Account` get this new field.
  - `set_requires_reauth(db: &Database, id: i64, value: bool) -> Result<(), StorageError>` — used in T3 (worker) and T5 (`begin_reauth`).
  - `reorder_accounts(db: &Database, ordered_ids: &[i64]) -> Result<(), StorageError>` — used in T5 (`reorder_accounts` command).

- [ ] **Step 1: Write failing tests**

In `crates/am-storage/src/accounts_repo.rs`, inside the existing `#[cfg(test)] mod tests` block, add at the end:

```rust
    #[test]
    fn requires_reauth_defaults_false() {
        let db = Database::open_in_memory().unwrap();
        let created = insert_account(&db, &sample()).unwrap();
        assert!(!created.requires_reauth);
    }

    #[test]
    fn set_requires_reauth_round_trips() {
        let db = Database::open_in_memory().unwrap();
        let created = insert_account(&db, &sample()).unwrap();
        set_requires_reauth(&db, created.id, true).unwrap();
        let fetched = get_account(&db, created.id).unwrap();
        assert!(fetched.requires_reauth);
        set_requires_reauth(&db, created.id, false).unwrap();
        let fetched2 = get_account(&db, created.id).unwrap();
        assert!(!fetched2.requires_reauth);
    }

    #[test]
    fn reorder_accounts_reorders_by_position() {
        let db = Database::open_in_memory().unwrap();
        let a = insert_account(&db, &NewAccount {
            email: "a@example.com".into(),
            display_name: "A".into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        }).unwrap();
        let b = insert_account(&db, &NewAccount {
            email: "b@example.com".into(),
            display_name: "B".into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        }).unwrap();
        let c = insert_account(&db, &NewAccount {
            email: "c@example.com".into(),
            display_name: "C".into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        }).unwrap();
        reorder_accounts(&db, &[c.id, a.id, b.id]).unwrap();
        let list = list_accounts(&db).unwrap();
        assert_eq!(list[0].id, c.id);
        assert_eq!(list[1].id, a.id);
        assert_eq!(list[2].id, b.id);
    }

    #[test]
    fn reorder_accounts_is_transactional_on_unknown_id() {
        let db = Database::open_in_memory().unwrap();
        let a = insert_account(&db, &NewAccount {
            email: "a@example.com".into(),
            display_name: "A".into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        }).unwrap();
        let original_list = list_accounts(&db).unwrap();
        let result = reorder_accounts(&db, &[a.id, 9999]);
        assert!(result.is_err());
        let after_list = list_accounts(&db).unwrap();
        assert_eq!(original_list[0].position, after_list[0].position);
    }
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cargo test -p am-storage 2>&1 | grep -E "FAILED|error\[E"
```

Expected: compilation errors about missing `requires_reauth` field and missing functions `set_requires_reauth`, `reorder_accounts`.

- [ ] **Step 3: Add `requires_reauth: bool` to `Account` in am-core**

Replace the entire `Account` struct in `crates/am-core/src/account.rs`:

```rust
#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct Account {
    pub id: i64,
    pub email: String,
    pub display_name: String,
    pub provider_type: ProviderType,
    pub color: Option<String>,
    pub position: i64,
    pub requires_reauth: bool,
}
```

Also update the existing JSON round-trip test in `crates/am-core/src/account.rs` to include the new field:

```rust
    #[test]
    fn account_roundtrips_through_json() {
        let account = Account {
            id: 1,
            email: "a@example.com".into(),
            display_name: "A".into(),
            provider_type: ProviderType::ImapPassword,
            color: Some("#4f46e5".into()),
            position: 0,
            requires_reauth: false,
        };
        let json = serde_json::to_string(&account).unwrap();
        let back: Account = serde_json::from_str(&json).unwrap();
        assert_eq!(account, back);
    }
```

- [ ] **Step 4: Update `row_to_account`, `tuple_to_account`, every SELECT, `set_requires_reauth`, and `reorder_accounts` in am-storage**

Replace the entire `crates/am-storage/src/accounts_repo.rs` file:

```rust
use am_core::account::{Account, NewAccount, ProviderType};
use rusqlite::params;

use crate::db::{Database, StorageError};


fn row_to_account(row: &rusqlite::Row) -> rusqlite::Result<(i64, String, String, String, Option<String>, i64, i64)> {
    Ok((
        row.get::<_, i64>(0)?,
        row.get::<_, String>(1)?,
        row.get::<_, String>(2)?,
        row.get::<_, String>(3)?,
        row.get::<_, Option<String>>(4)?,
        row.get::<_, i64>(5)?,
        row.get::<_, i64>(6)?,
    ))
}

fn tuple_to_account(
    (id, email, display_name, provider, color, position, requires_reauth): (i64, String, String, String, Option<String>, i64, i64),
) -> Result<Account, StorageError> {
    Ok(Account {
        id,
        email,
        display_name,
        provider_type: ProviderType::from_db_str(&provider)
            .ok_or_else(|| StorageError::InvalidData(format!("unknown provider type: {provider}")))?,
        color,
        position,
        requires_reauth: requires_reauth != 0,
    })
}

pub fn insert_account(db: &Database, new: &NewAccount) -> Result<Account, StorageError> {
    let conn = db.conn();
    conn.execute(
        "INSERT INTO accounts (email, display_name, provider_type, color, position)
         VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(position) + 1, 0) FROM accounts))",
        params![
            new.email,
            new.display_name,
            new.provider_type.as_db_str(),
            new.color
        ],
    )?;
    let id = conn.last_insert_rowid();
    drop(conn);
    get_account(db, id)
}

pub fn insert_account_with_settings(
    db: &Database,
    new: &NewAccount,
    auth_ref: &str,
    settings: &str,
) -> Result<Account, StorageError> {
    let conn = db.conn();
    conn.execute(
        "INSERT INTO accounts (email, display_name, provider_type, auth_ref, settings, color, position)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, (SELECT COALESCE(MAX(position) + 1, 0) FROM accounts))",
        params![
            new.email,
            new.display_name,
            new.provider_type.as_db_str(),
            auth_ref,
            settings,
            new.color
        ],
    )?;
    let id = conn.last_insert_rowid();
    drop(conn);
    get_account(db, id)
}

pub fn get_account_settings(db: &Database, id: i64) -> Result<String, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT settings FROM accounts WHERE id = ?1",
        params![id],
        |row| row.get::<_, String>(0),
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
        other => StorageError::Sqlite(other),
    })
}

pub fn get_account_auth_ref(db: &Database, id: i64) -> Result<String, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT auth_ref FROM accounts WHERE id = ?1",
        params![id],
        |row| row.get::<_, String>(0),
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
        other => StorageError::Sqlite(other),
    })
}

pub fn get_account(db: &Database, id: i64) -> Result<Account, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT id, email, display_name, provider_type, color, position, requires_reauth
         FROM accounts WHERE id = ?1",
        params![id],
        row_to_account,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
        other => StorageError::Sqlite(other),
    })
    .and_then(tuple_to_account)
}

pub fn list_accounts(db: &Database) -> Result<Vec<Account>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, email, display_name, provider_type, color, position, requires_reauth
         FROM accounts ORDER BY position ASC",
    )?;
    let rows = stmt.query_map([], row_to_account)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(tuple_to_account(r?)?);
    }
    Ok(out)
}

pub fn delete_account(db: &Database, id: i64) -> Result<(), StorageError> {
    let conn = db.conn();
    let changed = conn.execute("DELETE FROM accounts WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(StorageError::NotFound);
    }
    Ok(())
}

pub fn set_requires_reauth(db: &Database, id: i64, value: bool) -> Result<(), StorageError> {
    let conn = db.conn();
    let changed = conn.execute(
        "UPDATE accounts SET requires_reauth = ?1 WHERE id = ?2",
        params![value as i64, id],
    )?;
    if changed == 0 {
        return Err(StorageError::NotFound);
    }
    Ok(())
}

pub fn reorder_accounts(db: &Database, ordered_ids: &[i64]) -> Result<(), StorageError> {
    let mut conn = db.conn();
    let tx = conn.transaction()?;
    for (index, &id) in ordered_ids.iter().enumerate() {
        let changed = tx.execute(
            "UPDATE accounts SET position = ?1 WHERE id = ?2",
            params![index as i64, id],
        )?;
        if changed == 0 {
            return Err(StorageError::NotFound);
        }
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> NewAccount {
        NewAccount {
            email: "user@example.com".into(),
            display_name: "User".into(),
            provider_type: ProviderType::ImapPassword,
            color: Some("#4f46e5".into()),
        }
    }

    #[test]
    fn insert_then_list_returns_account() {
        let db = Database::open_in_memory().unwrap();
        let created = insert_account(&db, &sample()).unwrap();
        assert_eq!(created.email, "user@example.com");
        let all = list_accounts(&db).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, created.id);
    }

    #[test]
    fn get_missing_account_returns_not_found() {
        let db = Database::open_in_memory().unwrap();
        let err = get_account(&db, 999).unwrap_err();
        assert!(matches!(err, StorageError::NotFound));
    }

    #[test]
    fn delete_removes_account() {
        let db = Database::open_in_memory().unwrap();
        let created = insert_account(&db, &sample()).unwrap();
        delete_account(&db, created.id).unwrap();
        assert!(list_accounts(&db).unwrap().is_empty());
    }

    #[test]
    fn delete_missing_account_returns_not_found() {
        let db = Database::open_in_memory().unwrap();
        let err = delete_account(&db, 999).unwrap_err();
        assert!(matches!(err, StorageError::NotFound));
    }

    #[test]
    fn insert_with_settings_stores_auth_ref_and_settings() {
        let db = Database::open_in_memory().unwrap();
        let created =
            insert_account_with_settings(&db, &sample(), "user@example.com", "{\"k\":1}").unwrap();
        let settings = get_account_settings(&db, created.id).unwrap();
        assert_eq!(settings, "{\"k\":1}");
        let auth_ref = get_account_auth_ref(&db, created.id).unwrap();
        assert_eq!(auth_ref, "user@example.com");
    }

    #[test]
    fn get_settings_missing_account_returns_not_found() {
        let db = Database::open_in_memory().unwrap();
        let err = get_account_settings(&db, 999).unwrap_err();
        assert!(matches!(err, StorageError::NotFound));
    }

    #[test]
    fn provider_type_round_trips_through_db() {
        let db = Database::open_in_memory().unwrap();
        let variants = [ProviderType::ImapPassword, ProviderType::GoogleOauth];
        for variant in variants {
            let new = NewAccount {
                email: format!("{}@example.com", variant.as_db_str()),
                display_name: "Test".into(),
                provider_type: variant.clone(),
                color: None,
            };
            let created = insert_account(&db, &new).unwrap();
            let fetched = get_account(&db, created.id).unwrap();
            assert_eq!(fetched.provider_type, variant);
        }
    }

    #[test]
    fn requires_reauth_defaults_false() {
        let db = Database::open_in_memory().unwrap();
        let created = insert_account(&db, &sample()).unwrap();
        assert!(!created.requires_reauth);
    }

    #[test]
    fn set_requires_reauth_round_trips() {
        let db = Database::open_in_memory().unwrap();
        let created = insert_account(&db, &sample()).unwrap();
        set_requires_reauth(&db, created.id, true).unwrap();
        let fetched = get_account(&db, created.id).unwrap();
        assert!(fetched.requires_reauth);
        set_requires_reauth(&db, created.id, false).unwrap();
        let fetched2 = get_account(&db, created.id).unwrap();
        assert!(!fetched2.requires_reauth);
    }

    #[test]
    fn reorder_accounts_reorders_by_position() {
        let db = Database::open_in_memory().unwrap();
        let a = insert_account(&db, &NewAccount {
            email: "a@example.com".into(),
            display_name: "A".into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        }).unwrap();
        let b = insert_account(&db, &NewAccount {
            email: "b@example.com".into(),
            display_name: "B".into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        }).unwrap();
        let c = insert_account(&db, &NewAccount {
            email: "c@example.com".into(),
            display_name: "C".into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        }).unwrap();
        reorder_accounts(&db, &[c.id, a.id, b.id]).unwrap();
        let list = list_accounts(&db).unwrap();
        assert_eq!(list[0].id, c.id);
        assert_eq!(list[1].id, a.id);
        assert_eq!(list[2].id, b.id);
    }

    #[test]
    fn reorder_accounts_is_transactional_on_unknown_id() {
        let db = Database::open_in_memory().unwrap();
        let a = insert_account(&db, &NewAccount {
            email: "a@example.com".into(),
            display_name: "A".into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        }).unwrap();
        let original_list = list_accounts(&db).unwrap();
        let result = reorder_accounts(&db, &[a.id, 9999]);
        assert!(result.is_err());
        let after_list = list_accounts(&db).unwrap();
        assert_eq!(original_list[0].position, after_list[0].position);
    }
}
```

- [ ] **Step 5: Fix all callers of `Account` struct literal construction**

Any place in the codebase that constructs `Account { ... }` directly (not via `get_account`/`list_accounts`) now needs `requires_reauth: false`. Run:

```bash
grep -rn "Account {" crates/ --include="*.rs" | grep -v "NewAccount"
```

For each hit that is a struct literal, add `requires_reauth: false` to the field list. The main location is `crates/am-app/src/commands.rs` test helpers — update any `Account { id: ..., ... }` literals there.

- [ ] **Step 6: Run tests**

```bash
cargo test -p am-core && cargo test -p am-storage
```

Expected: all tests pass, including `requires_reauth_defaults_false`, `set_requires_reauth_round_trips`, `reorder_accounts_reorders_by_position`, `reorder_accounts_is_transactional_on_unknown_id`.

- [ ] **Step 7: Commit**

```bash
git add crates/am-core/src/account.rs crates/am-storage/src/accounts_repo.rs
git commit -m "feat(storage): add requires_reauth to Account, set_requires_reauth, reorder_accounts"
```

---

### Task 2: SyncEngine worker cancellation via CancellationToken

**Files:**
- Modify: `crates/am-sync/Cargo.toml`
- Modify: `crates/am-sync/src/engine.rs`

**Interfaces:**
- Consumes: existing `SyncEngine` with `workers: Mutex<HashMap<i64, mpsc::Sender<()>>>` and `spawn_account` / `shutdown`. 5A's `start(db, sink, creds)` signature (already in place from 5A).
- Produces:
  - `SyncEngine::stop_account(&self, account_id: i64)` — cancels the worker token and removes the entry from the workers map. Used in T4 (`remove_account`) and T5 (`begin_reauth`).
  - `SyncEngine::shutdown(&self)` — cancels all tokens (replacing the old clear-map approach).
  - Workers now use `CancellationToken` so the poll sleep AND the IDLE wait are both interruptible.

- [ ] **Step 1: Add tokio-util to am-sync Cargo.toml**

In `crates/am-sync/Cargo.toml`, in the `[dependencies]` section, add after `tokio.workspace = true`:

```toml
tokio-util = { version = "0.7", features = ["rt"] }
```

- [ ] **Step 2: Write failing unit test for stop_account**

In `crates/am-sync/src/engine.rs`, add at the end of the file a new test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use am_storage::Database;
    use crate::events::NoopSink;

    struct FakeCreds;

    #[async_trait::async_trait]
    impl crate::auth::CredentialSource for FakeCreds {
        async fn auth_for(&self, _account: &am_core::account::Account) -> Result<crate::auth::AccountAuth, crate::service::SyncError> {
            Err(crate::service::SyncError::CredentialMissing)
        }
    }

    #[tokio::test]
    async fn spawn_then_stop_removes_worker_and_token_is_cancelled() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let sink = Arc::new(NoopSink);
        let creds: Arc<dyn crate::auth::CredentialSource> = Arc::new(FakeCreds);
        let engine = SyncEngine::start(Arc::clone(&db), sink, creds);

        let token = tokio_util::sync::CancellationToken::new();
        {
            let mut guard = engine.workers.lock().unwrap();
            guard.insert(42, token.clone());
        }

        engine.stop_account(42);

        assert!(token.is_cancelled());
        assert!(!engine.workers.lock().unwrap().contains_key(&42));
    }

    #[tokio::test]
    async fn shutdown_cancels_all_tokens() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let sink = Arc::new(NoopSink);
        let creds: Arc<dyn crate::auth::CredentialSource> = Arc::new(FakeCreds);
        let engine = SyncEngine::start(Arc::clone(&db), sink, creds);

        let t1 = tokio_util::sync::CancellationToken::new();
        let t2 = tokio_util::sync::CancellationToken::new();
        {
            let mut guard = engine.workers.lock().unwrap();
            guard.insert(1, t1.clone());
            guard.insert(2, t2.clone());
        }

        engine.shutdown();

        assert!(t1.is_cancelled());
        assert!(t2.is_cancelled());
    }
}
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
cargo test -p am-sync 2>&1 | grep -E "FAILED|error\[E"
```

Expected: compilation errors about `CancellationToken` not in scope, `stop_account` not found, wrong type in `workers` map.

- [ ] **Step 4: Rewrite engine.rs to use CancellationToken**

Replace the entire `crates/am-sync/src/engine.rs`:

```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use am_protocols::imap::{IdleOutcome, ImapSession};
use am_storage::{accounts_repo, folders_repo, Database};
use tokio_util::sync::CancellationToken;

use crate::auth::CredentialSource;
use crate::events::SyncEventSink;
use crate::service::{self, imap_config_pub, load_endpoints_pub};

pub const POLL_INTERVAL: Duration = Duration::from_secs(300);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(1500);
const INBOX_PATH: &str = "INBOX";

pub struct SyncEngine {
    db: Arc<Database>,
    sink: Arc<dyn SyncEventSink>,
    creds: Arc<dyn CredentialSource>,
    workers: Mutex<HashMap<i64, CancellationToken>>,
}

impl SyncEngine {
    pub fn start(
        db: Arc<Database>,
        sink: Arc<dyn SyncEventSink>,
        creds: Arc<dyn CredentialSource>,
    ) -> Arc<Self> {
        let engine = Arc::new(Self {
            db,
            sink,
            creds,
            workers: Mutex::new(HashMap::new()),
        });
        if let Ok(accounts) = accounts_repo::list_accounts(&engine.db) {
            for account in accounts {
                engine.spawn_account(account.id);
            }
        }
        engine
    }

    pub fn spawn_account(self: &Arc<Self>, account_id: i64) {
        let token = CancellationToken::new();
        {
            let mut guard = self.workers.lock().unwrap();
            if guard.contains_key(&account_id) {
                return;
            }
            guard.insert(account_id, token.clone());
        }
        let db = Arc::clone(&self.db);
        let sink = Arc::clone(&self.sink);
        let creds = Arc::clone(&self.creds);
        tokio::spawn(async move {
            let _ = service::sync_all_folders(&db, account_id, creds.as_ref(), |_| {}).await;
            loop {
                let now = service::now_secs();
                let _ = service::drain_queue(&db, account_id, creds.as_ref(), now).await;
                let _ = crate::send::drain_outbox(&db, account_id, creds.as_ref(), now).await;
                let _ = crate::send::drain_draft_sync(&db, account_id, creds.as_ref(), now).await;
                if let Ok(folders) = folders_repo::list_folders(&db, account_id) {
                    for folder in &folders {
                        if !folder.remote_path.eq_ignore_ascii_case(INBOX_PATH) {
                            let _ = service::incremental_sync_folder(
                                &db,
                                account_id,
                                folder.id,
                                sink.as_ref(),
                                creds.as_ref(),
                            )
                            .await;
                        }
                    }
                    if let Some(inbox) = folders
                        .iter()
                        .find(|f| f.remote_path.eq_ignore_ascii_case(INBOX_PATH))
                    {
                        let _ = service::incremental_sync_folder(
                            &db,
                            account_id,
                            inbox.id,
                            sink.as_ref(),
                            creds.as_ref(),
                        )
                        .await;
                        let idled = idle_inbox(&db, account_id, &inbox.remote_path, creds.as_ref(), token.clone()).await;
                        if matches!(idled, Ok(true)) {
                            continue;
                        }
                    }
                }
                tokio::select! {
                    _ = tokio::time::sleep(POLL_INTERVAL) => {},
                    _ = token.cancelled() => break,
                }
            }
        });
    }

    pub fn stop_account(&self, account_id: i64) {
        let mut guard = self.workers.lock().unwrap();
        if let Some(token) = guard.remove(&account_id) {
            token.cancel();
        }
    }

    pub fn shutdown(&self) {
        let mut guard = self.workers.lock().unwrap();
        for (_, token) in guard.drain() {
            token.cancel();
        }
    }
}

async fn idle_inbox(
    db: &Database,
    account_id: i64,
    remote_path: &str,
    creds: &dyn CredentialSource,
    token: CancellationToken,
) -> Result<bool, ()> {
    let account = accounts_repo::get_account(db, account_id).map_err(|_| ())?;
    let endpoints = load_endpoints_pub(db, account_id).map_err(|_| ())?;
    let auth = creds.auth_for(&account).await.map_err(|_| ())?;
    let config = imap_config_pub(&endpoints, &account.email);
    let mut session = ImapSession::connect(&config, &auth.to_imap()).await.map_err(|_| ())?;
    let caps = session.server_caps().await.map_err(|_| ())?;
    if !caps.idle {
        let _ = session.logout().await;
        return Ok(false);
    }
    session.select(remote_path).await.map_err(|_| ())?;
    tokio::select! {
        result = session.idle_wait(IDLE_TIMEOUT) => {
            match result {
                Ok((session_after, outcome)) => {
                    let _ = session_after.logout().await;
                    Ok(matches!(outcome, IdleOutcome::Changed))
                }
                Err(_) => Err(()),
            }
        }
        _ = token.cancelled() => {
            let _ = session.logout().await;
            Err(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use am_storage::Database;
    use crate::events::NoopSink;

    struct FakeCreds;

    #[async_trait::async_trait]
    impl crate::auth::CredentialSource for FakeCreds {
        async fn auth_for(&self, _account: &am_core::account::Account) -> Result<crate::auth::AccountAuth, crate::service::SyncError> {
            Err(crate::service::SyncError::CredentialMissing)
        }
    }

    #[tokio::test]
    async fn spawn_then_stop_removes_worker_and_token_is_cancelled() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let sink = Arc::new(NoopSink);
        let creds: Arc<dyn crate::auth::CredentialSource> = Arc::new(FakeCreds);
        let engine = SyncEngine::start(Arc::clone(&db), sink, creds);

        let token = CancellationToken::new();
        {
            let mut guard = engine.workers.lock().unwrap();
            guard.insert(42, token.clone());
        }

        engine.stop_account(42);

        assert!(token.is_cancelled());
        assert!(!engine.workers.lock().unwrap().contains_key(&42));
    }

    #[tokio::test]
    async fn shutdown_cancels_all_tokens() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let sink = Arc::new(NoopSink);
        let creds: Arc<dyn crate::auth::CredentialSource> = Arc::new(FakeCreds);
        let engine = SyncEngine::start(Arc::clone(&db), sink, creds);

        let t1 = CancellationToken::new();
        let t2 = CancellationToken::new();
        {
            let mut guard = engine.workers.lock().unwrap();
            guard.insert(1, t1.clone());
            guard.insert(2, t2.clone());
        }

        engine.shutdown();

        assert!(t1.is_cancelled());
        assert!(t2.is_cancelled());
    }
}
```

> **Note on `idle_wait` signature:** The existing `ImapSession::idle_wait` returns `(ImapSession, IdleOutcome)` in a tuple after completion. The `tokio::select!` on the IDLE branch destructures this. If 5A changed the signature, adjust accordingly — the key requirement is that the `token.cancelled()` arm causes an early exit.

- [ ] **Step 5: Run tests**

```bash
cargo test -p am-sync 2>&1 | grep -E "test .* ok|FAILED|error"
```

Expected: `spawn_then_stop_removes_worker_and_token_is_cancelled ... ok` and `shutdown_cancels_all_tokens ... ok`. The full workspace may have compile errors from `service.rs` functions that need `creds` added — those are resolved in service.rs by 5A; if 5A is complete, just run `cargo test -p am-sync`.

- [ ] **Step 6: Commit**

```bash
git add crates/am-sync/Cargo.toml crates/am-sync/src/engine.rs
git commit -m "feat(sync): replace mpsc stop channel with CancellationToken, add stop_account"
```

---

### Task 3: SyncEvent::AuthChanged + AccountAuthChanged tauri event + sink bridge + worker wiring

**Files:**
- Modify: `crates/am-sync/src/events.rs`
- Modify: `crates/am-sync/src/engine.rs` (worker emits AuthChanged on NeedsReauth)
- Modify: `crates/am-app/src/events.rs`
- Modify: `crates/am-app/src/sink.rs`
- Modify: `crates/am-app/src/lib.rs`

**Interfaces:**
- Consumes: `SyncEvent` enum (3 variants), `SyncEventSink` trait; `AppEventSink` bridging in `sink.rs`; `events.rs` structs with `tauri_specta::Event`; `collect_events!` in `lib.rs`.
- Produces:
  - `SyncEvent::AuthChanged { account_id: i64, requires_reauth: bool }` — emitted by the engine worker when `SyncError::NeedsReauth` is returned from a service call.
  - `AccountAuthChanged { account_id: i64, requires_reauth: bool }` (tauri event) — registered in `collect_events!`; frontend listens to invalidate `["accounts"]`.
  - `set_requires_reauth(db, id, true/false)` called by the worker (from T1) before emitting.

- [ ] **Step 1: Write failing test for sink mapping**

In `crates/am-app/src/sink.rs`, there is no test module yet. We will add one after implementation. First, write a compile-time test by adding to the bottom of `crates/am-app/src/sink.rs` (AFTER the existing impl):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::AccountAuthChanged;

    #[test]
    fn auth_changed_event_struct_has_correct_fields() {
        let ev = AccountAuthChanged { account_id: 7, requires_reauth: true };
        assert_eq!(ev.account_id, 7);
        assert!(ev.requires_reauth);
    }
}
```

- [ ] **Step 2: Run to confirm it fails**

```bash
cargo test -p am-app 2>&1 | grep -E "FAILED|error\[E"
```

Expected: error about `AccountAuthChanged` not found.

- [ ] **Step 3: Add `SyncEvent::AuthChanged` to am-sync events.rs**

Replace the entire `crates/am-sync/src/events.rs`:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncEvent {
    Progress { account_id: i64, folder_id: i64, fetched: i64, total: i64 },
    NewMessages { account_id: i64, folder_id: i64, count: i64 },
    MailboxChanged { account_id: i64, folder_id: i64 },
    AuthChanged { account_id: i64, requires_reauth: bool },
}

pub trait SyncEventSink: Send + Sync {
    fn emit(&self, event: SyncEvent);
}

#[derive(Default)]
pub struct NoopSink;

impl SyncEventSink for NoopSink {
    fn emit(&self, _event: SyncEvent) {}
}

#[cfg(test)]
pub struct RecordingSink {
    pub events: std::sync::Mutex<Vec<SyncEvent>>,
}

#[cfg(test)]
impl RecordingSink {
    pub fn new() -> Self {
        Self { events: std::sync::Mutex::new(Vec::new()) }
    }
}

#[cfg(test)]
impl SyncEventSink for RecordingSink {
    fn emit(&self, event: SyncEvent) {
        self.events.lock().unwrap().push(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_sink_collects_events() {
        let sink = RecordingSink::new();
        sink.emit(SyncEvent::MailboxChanged { account_id: 1, folder_id: 2 });
        assert_eq!(sink.events.lock().unwrap().len(), 1);
    }

    #[test]
    fn auth_changed_variant_stores_fields() {
        let ev = SyncEvent::AuthChanged { account_id: 5, requires_reauth: true };
        assert_eq!(ev, SyncEvent::AuthChanged { account_id: 5, requires_reauth: true });
    }
}
```

- [ ] **Step 4: Add `AccountAuthChanged` to am-app events.rs**

In `crates/am-app/src/events.rs`, append at the end:

```rust
#[derive(Serialize, Deserialize, Clone, Debug, specta::Type, tauri_specta::Event)]
pub struct AccountAuthChanged {
    pub account_id: i64,
    pub requires_reauth: bool,
}
```

- [ ] **Step 5: Bridge AuthChanged in am-app sink.rs**

Replace the entire `crates/am-app/src/sink.rs`:

```rust
use am_sync::{SyncEvent, SyncEventSink};
use tauri::AppHandle;
use tauri_specta::Event;

use crate::events::{AccountAuthChanged, MailboxChanged, NewMessages, SyncProgress};

pub struct AppEventSink {
    pub app: AppHandle,
}

impl SyncEventSink for AppEventSink {
    fn emit(&self, event: SyncEvent) {
        match event {
            SyncEvent::Progress { account_id, folder_id, fetched, total } => {
                let _ = SyncProgress { account_id, folder_id, fetched, total }.emit(&self.app);
            }
            SyncEvent::NewMessages { account_id, folder_id, count } => {
                let _ = NewMessages { account_id, folder_id, count }.emit(&self.app);
            }
            SyncEvent::MailboxChanged { account_id, folder_id } => {
                let _ = MailboxChanged { account_id, folder_id }.emit(&self.app);
            }
            SyncEvent::AuthChanged { account_id, requires_reauth } => {
                let _ = AccountAuthChanged { account_id, requires_reauth }.emit(&self.app);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::AccountAuthChanged;

    #[test]
    fn auth_changed_event_struct_has_correct_fields() {
        let ev = AccountAuthChanged { account_id: 7, requires_reauth: true };
        assert_eq!(ev.account_id, 7);
        assert!(ev.requires_reauth);
    }
}
```

- [ ] **Step 6: Register AccountAuthChanged in lib.rs collect_events!**

In `crates/am-app/src/lib.rs`, change:

```rust
        .events(collect_events![
            events::SyncProgress,
            events::NewMessages,
            events::MailboxChanged,
        ])
```

to:

```rust
        .events(collect_events![
            events::SyncProgress,
            events::NewMessages,
            events::MailboxChanged,
            events::AccountAuthChanged,
        ])
```

- [ ] **Step 7: Wire AuthChanged emission in the engine worker**

In `crates/am-sync/src/engine.rs`, in the `spawn_account` worker loop, after the call to `service::sync_all_folders`, wrap the error handling so that `NeedsReauth` triggers `set_requires_reauth` + `sink.emit(AuthChanged)`. The relevant section of the worker body (inside `tokio::spawn`) should read:

```rust
        tokio::spawn(async move {
            if let Err(e) = service::sync_all_folders(&db, account_id, creds.as_ref(), |_| {}).await {
                if matches!(e, service::SyncError::NeedsReauth) {
                    let _ = am_storage::accounts_repo::set_requires_reauth(&db, account_id, true);
                    sink.emit(crate::events::SyncEvent::AuthChanged { account_id, requires_reauth: true });
                    return;
                }
            }
            loop {
                let now = service::now_secs();
                if let Err(e) = service::drain_queue(&db, account_id, creds.as_ref(), now).await {
                    if matches!(e, service::SyncError::NeedsReauth) {
                        let _ = am_storage::accounts_repo::set_requires_reauth(&db, account_id, true);
                        sink.emit(crate::events::SyncEvent::AuthChanged { account_id, requires_reauth: true });
                        return;
                    }
                }
                let _ = crate::send::drain_outbox(&db, account_id, creds.as_ref(), now).await;
                let _ = crate::send::drain_draft_sync(&db, account_id, creds.as_ref(), now).await;
                if let Ok(folders) = folders_repo::list_folders(&db, account_id) {
                    for folder in &folders {
                        if !folder.remote_path.eq_ignore_ascii_case(INBOX_PATH) {
                            if let Err(e) = service::incremental_sync_folder(
                                &db,
                                account_id,
                                folder.id,
                                sink.as_ref(),
                                creds.as_ref(),
                            )
                            .await {
                                if matches!(e, service::SyncError::NeedsReauth) {
                                    let _ = am_storage::accounts_repo::set_requires_reauth(&db, account_id, true);
                                    sink.emit(crate::events::SyncEvent::AuthChanged { account_id, requires_reauth: true });
                                    return;
                                }
                            }
                        }
                    }
                    if let Some(inbox) = folders
                        .iter()
                        .find(|f| f.remote_path.eq_ignore_ascii_case(INBOX_PATH))
                    {
                        if let Err(e) = service::incremental_sync_folder(
                            &db,
                            account_id,
                            inbox.id,
                            sink.as_ref(),
                            creds.as_ref(),
                        )
                        .await {
                            if matches!(e, service::SyncError::NeedsReauth) {
                                let _ = am_storage::accounts_repo::set_requires_reauth(&db, account_id, true);
                                sink.emit(crate::events::SyncEvent::AuthChanged { account_id, requires_reauth: true });
                                return;
                            }
                        }
                        let idled = idle_inbox(&db, account_id, &inbox.remote_path, creds.as_ref(), token.clone()).await;
                        if matches!(idled, Ok(true)) {
                            continue;
                        }
                    }
                }
                tokio::select! {
                    _ = tokio::time::sleep(POLL_INTERVAL) => {},
                    _ = token.cancelled() => break,
                }
            }
        });
```

- [ ] **Step 8: Run tests**

```bash
cargo test -p am-sync && cargo test -p am-app
```

Expected: all existing tests pass plus `auth_changed_variant_stores_fields` and `auth_changed_event_struct_has_correct_fields`.

- [ ] **Step 9: Commit**

```bash
git add crates/am-sync/src/events.rs crates/am-sync/src/engine.rs crates/am-app/src/events.rs crates/am-app/src/sink.rs crates/am-app/src/lib.rs
git commit -m "feat(sync): add AuthChanged event, bridge to AccountAuthChanged tauri event"
```

---

### Task 4: `remove_account` command

**Files:**
- Modify: `crates/am-app/src/commands.rs`
- Modify: `crates/am-app/src/lib.rs`

**Interfaces:**
- Consumes:
  - `engine.stop_account(account_id: i64)` (T2)
  - `accounts_repo::get_account_auth_ref(db, id) -> Result<String, StorageError>` (T1)
  - `am_auth::credentials::delete_password(auth_ref: &str) -> Result<(), AuthError>` (existing, absent-key must not abort)
  - `accounts_repo::delete_account(db, id) -> Result<(), StorageError>` (existing, ON DELETE CASCADE)
- Produces:
  - `pub async fn remove_account(state, account_id: i64) -> Result<(), String>` — registered in `collect_commands!`.

- [ ] **Step 1: Write failing test**

In `crates/am-app/src/commands.rs`, inside the existing `#[cfg(test)] mod tests` block, add:

```rust
    use am_auth::credentials::{store_password, delete_password};

    fn install_in_mem_keyring() {
        use keyring::credential::{
            Credential, CredentialApi, CredentialBuilderApi, CredentialPersistence,
        };
        use std::any::Any;
        use std::collections::HashMap;
        use std::sync::{Mutex, Once};

        static STORE: Mutex<Option<HashMap<(String, String), String>>> = Mutex::new(None);
        static INIT: Once = Once::new();

        INIT.call_once(|| {
            *STORE.lock().unwrap() = Some(HashMap::new());

            #[derive(Debug)]
            struct InMemCred { service: String, user: String }
            impl CredentialApi for InMemCred {
                fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
                    let pw = String::from_utf8(secret.to_vec())
                        .map_err(|_| keyring::Error::BadEncoding(secret.to_vec()))?;
                    STORE.lock().unwrap().as_mut().unwrap()
                        .insert((self.service.clone(), self.user.clone()), pw);
                    Ok(())
                }
                fn get_secret(&self) -> keyring::Result<Vec<u8>> {
                    STORE.lock().unwrap().as_ref().unwrap()
                        .get(&(self.service.clone(), self.user.clone()))
                        .map(|s| s.as_bytes().to_vec())
                        .ok_or(keyring::Error::NoEntry)
                }
                fn delete_credential(&self) -> keyring::Result<()> {
                    STORE.lock().unwrap().as_mut().unwrap()
                        .remove(&(self.service.clone(), self.user.clone()))
                        .map(|_| ())
                        .ok_or(keyring::Error::NoEntry)
                }
                fn as_any(&self) -> &dyn Any { self }
            }

            struct InMemCredBuilder;
            impl CredentialBuilderApi for InMemCredBuilder {
                fn build(&self, _target: Option<&str>, service: &str, user: &str) -> keyring::Result<Box<Credential>> {
                    Ok(Box::new(InMemCred { service: service.to_string(), user: user.to_string() }))
                }
                fn as_any(&self) -> &dyn Any { self }
                fn persistence(&self) -> CredentialPersistence { CredentialPersistence::ProcessOnly }
            }

            keyring::set_default_credential_builder(Box::new(InMemCredBuilder));
        });
    }

    #[test]
    fn remove_account_deletes_row_and_keychain_secret() {
        install_in_mem_keyring();
        let db = Database::open_in_memory().unwrap();
        let created = accounts_repo::insert_account_with_settings(
            &db,
            &NewAccount {
                email: "rm@example.com".into(),
                display_name: "Rm".into(),
                provider_type: ProviderType::ImapPassword,
                color: None,
            },
            "rm@example.com",
            "{}",
        ).unwrap();
        store_password("rm@example.com", "secret").unwrap();
        let auth_ref = accounts_repo::get_account_auth_ref(&db, created.id).unwrap();
        let _ = delete_password(&auth_ref);
        delete_password(&auth_ref).unwrap_err();
        accounts_repo::delete_account(&db, created.id).unwrap();
        let err = accounts_repo::get_account(&db, created.id).unwrap_err();
        assert!(matches!(err, am_storage::db::StorageError::NotFound));
    }

    #[test]
    fn remove_missing_account_errors_cleanly() {
        let db = Database::open_in_memory().unwrap();
        let err = accounts_repo::delete_account(&db, 9999).unwrap_err();
        assert!(matches!(err, am_storage::db::StorageError::NotFound));
    }
```

- [ ] **Step 2: Run to confirm compilation**

```bash
cargo test -p am-app 2>&1 | grep -E "error\[E|FAILED"
```

Expected: error about missing `remove_account` command (once we try to use it from frontend, the test logic itself should compile since it uses existing fns).

- [ ] **Step 3: Implement `remove_account` in commands.rs**

In `crates/am-app/src/commands.rs`, add after the `add_account` function:

```rust
#[tauri::command]
#[specta::specta]
pub async fn remove_account(
    state: tauri::State<'_, AppState>,
    account_id: i64,
) -> Result<(), String> {
    if let Some(engine) = state.engine.lock().unwrap().as_ref() {
        engine.stop_account(account_id);
    }

    let auth_ref = accounts_repo::get_account_auth_ref(&state.db, account_id)
        .unwrap_or_default();

    if !auth_ref.is_empty() {
        match am_auth::credentials::delete_password(&auth_ref) {
            Ok(()) => {}
            Err(am_auth::AuthError::NotFound) => {}
            Err(e) => return Err(e.to_string()),
        }
    }

    accounts_repo::delete_account(&state.db, account_id).map_err(|e| e.to_string())
}
```

Also update the `use` imports at the top of `commands.rs` to include `get_account_auth_ref`:

The existing import line is:
```rust
use am_storage::{accounts_repo, drafts_repo, folders_repo, messages_repo, signatures_repo};
```
It stays as-is; `get_account_auth_ref` is accessed via `accounts_repo::get_account_auth_ref`.

- [ ] **Step 4: Register remove_account in lib.rs**

In `crates/am-app/src/lib.rs`, in `collect_commands!`, add `commands::remove_account,` after `commands::add_account,`.

- [ ] **Step 5: Run tests**

```bash
cargo test -p am-app
```

Expected: all tests pass, including `remove_account_deletes_row_and_keychain_secret` and `remove_missing_account_errors_cleanly`.

- [ ] **Step 6: Commit**

```bash
git add crates/am-app/src/commands.rs crates/am-app/src/lib.rs
git commit -m "feat(app): add remove_account command with keychain cleanup and cascade delete"
```

---

### Task 5: `reorder_accounts` and `begin_reauth` commands

**Files:**
- Modify: `crates/am-app/src/commands.rs`
- Modify: `crates/am-app/src/lib.rs`

**Interfaces:**
- Consumes:
  - `accounts_repo::reorder_accounts(db, ordered_ids: &[i64]) -> Result<(), StorageError>` (T1)
  - `accounts_repo::set_requires_reauth(db, id, false)` (T1)
  - `engine.stop_account(account_id)` (T2), `engine.spawn_account(account_id)` (existing)
  - `run_google_oauth_flow(app: &tauri::AppHandle) -> Result<(am_auth::oauth::client::OAuthTokens, String), String>` — 5A's `pub(crate)` shared OAuth flow in `commands.rs` (PKCE + loopback + exchange + email fetch; no keychain write, no DB insert). `begin_reauth` calls it directly (same module), then stores the refresh token under `account.email`, seeds the token manager, and clears `requires_reauth`.
  - `state.creds.token_manager().seed(auth_ref, &tokens)` — `AppState.creds: Arc<KeychainCredentialSource>` (5A), `token_manager()` exposes `seed`.
- Produces:
  - `pub fn reorder_accounts(state, ordered_ids: Vec<i64>) -> Result<(), String>`
  - `pub async fn begin_reauth(state, account_id: i64) -> Result<(), String>`
  - Both registered in `collect_commands!`.

- [ ] **Step 1: Write failing tests**

In `crates/am-app/src/commands.rs` tests block, add:

```rust
    #[test]
    fn reorder_accounts_command_reorders_in_db() {
        let db = Database::open_in_memory().unwrap();
        let a = accounts_repo::insert_account(&db, &NewAccount {
            email: "a@example.com".into(),
            display_name: "A".into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        }).unwrap();
        let b = accounts_repo::insert_account(&db, &NewAccount {
            email: "b@example.com".into(),
            display_name: "B".into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        }).unwrap();
        accounts_repo::reorder_accounts(&db, &[b.id, a.id]).unwrap();
        let list = accounts_repo::list_accounts(&db).unwrap();
        assert_eq!(list[0].id, b.id);
        assert_eq!(list[1].id, a.id);
    }
```

- [ ] **Step 2: Run to confirm**

```bash
cargo test -p am-app test::reorder_accounts_command_reorders_in_db 2>&1 | grep -E "ok|FAILED"
```

Expected: PASS (this is a pure storage test, should pass immediately given T1 is done).

- [ ] **Step 3: Implement reorder_accounts in commands.rs**

In `crates/am-app/src/commands.rs`, add after `remove_account`:

```rust
#[tauri::command]
#[specta::specta]
pub fn reorder_accounts(
    state: tauri::State<'_, AppState>,
    ordered_ids: Vec<i64>,
) -> Result<(), String> {
    accounts_repo::reorder_accounts(&state.db, &ordered_ids).map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Implement begin_reauth in commands.rs**

`begin_reauth` re-runs the Google OAuth flow for an existing account. It reuses the OAuth logic from `begin_google_oauth` (5A). The key difference: rather than inserting a new account row, it overwrites the keychain secret and clears `requires_reauth`, then restarts the worker.

Add after `reorder_accounts`:

```rust
#[tauri::command]
#[specta::specta]
pub async fn begin_reauth(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    account_id: i64,
) -> Result<(), String> {
    let account = accounts_repo::get_account(&state.db, account_id)
        .map_err(|e| e.to_string())?;

    let (new_tokens, email) = run_google_oauth_flow(&app).await?;

    if email != account.email {
        return Err("Signed-in Google account does not match this account".to_string());
    }

    let refresh_token = new_tokens
        .refresh_token
        .clone()
        .ok_or_else(|| "No refresh token in Google response".to_string())?;
    am_auth::credentials::store_password(&account.email, &refresh_token)
        .map_err(|_| "Keychain unavailable".to_string())?;

    state.creds.token_manager().seed(&account.email, &new_tokens);

    accounts_repo::set_requires_reauth(&state.db, account_id, false)
        .map_err(|e| e.to_string())?;

    if let Some(engine) = state.engine.lock().unwrap().as_ref() {
        engine.stop_account(account_id);
        engine.spawn_account(account_id);
    }

    Ok(())
}
```

> **Dependency on 5A (resolved):** 5A provides `pub(crate) async fn run_google_oauth_flow(app: &tauri::AppHandle) -> Result<(am_auth::oauth::client::OAuthTokens, String), String>` in `crates/am-app/src/commands.rs` (PKCE + loopback + code exchange + email fetch; no keychain write, no DB insert). Because `begin_reauth` lives in the same `commands` module, call it directly as `run_google_oauth_flow(&app)`. `auth_ref` equals `account.email` for every account (set at insert time), so the refresh token is stored under `account.email`. `AppState.creds` is `Arc<KeychainCredentialSource>` (non-optional) as added by 5A, and `KeychainCredentialSource::token_manager()` exposes `seed`. The email-match guard prevents binding a different Google account's tokens to this row.

- [ ] **Step 5: Register both commands in lib.rs**

In `crates/am-app/src/lib.rs`, in `collect_commands!`, add:

```rust
            commands::reorder_accounts,
            commands::begin_reauth,
```

after `commands::remove_account,`.

- [ ] **Step 6: Run tests**

```bash
cargo test -p am-app
```

Expected: all tests pass.

- [ ] **Step 7: Regenerate bindings**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm run gen:bindings
```

Expected: exits 0, updates `src/ipc/bindings.ts` to include `removeAccount`, `reorderAccounts`, `beginReauth`, `accountAuthChanged`.

- [ ] **Step 8: Commit**

```bash
git add crates/am-app/src/commands.rs crates/am-app/src/lib.rs src/ipc/bindings.ts
git commit -m "feat(app): add reorder_accounts and begin_reauth commands"
```

---

### Task 6: Frontend — queries, events, MailboxRail with remove/reauth/reorder

**Files:**
- Modify: `src/ipc/queries.ts`
- Modify: `src/ipc/events.ts`
- Modify: `src/features/mailbox/MailboxRail.tsx`
- Modify: `src/features/mailbox/MailboxRail.test.tsx`

**Interfaces:**
- Consumes:
  - `commands.removeAccount(accountId: number)` — from generated bindings (T5).
  - `commands.reorderAccounts(orderedIds: number[])` — from generated bindings (T5).
  - `commands.beginReauth(accountId: number)` — from generated bindings (T5).
  - `events.accountAuthChanged.listen(cb)` — from generated bindings (T3).
  - `useUiStore` state: `selectedAccountId`, `setSelectedAccountId`. (5B may have already added `selectedSmartFolder`; if not, this task does not add it — only 5B owns that field.)
  - `@dnd-kit/core` and `@dnd-kit/sortable` — must be installed if not already present.
- Produces:
  - `useRemoveAccount()` mutation hook — invalidates `["accounts"]`, clears selection if removed account was selected.
  - `useReorderAccounts()` mutation hook — invalidates `["accounts"]`.
  - `useBeginReauth()` mutation hook — invalidates `["accounts"]` on success.
  - `useSyncEvents` extended to listen `accountAuthChanged` and invalidate `["accounts"]`.
  - `MailboxRail` with: remove button per account (confirm dialog), "⚠ Reconnect" badge when `account.requires_reauth`, drag-and-drop reordering calling `useReorderAccounts`.

- [ ] **Step 1: Install @dnd-kit if not already installed**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm ls @dnd-kit/core 2>/dev/null | grep -q dnd-kit || npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

Expected: exits 0. If already installed, silently succeeds.

- [ ] **Step 2: Write failing tests in MailboxRail.test.tsx**

Replace the entire `src/features/mailbox/MailboxRail.test.tsx` with:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockSetSelectedAccountId = vi.fn();
const mockSetSelectedFolderId = vi.fn();
const mockRemoveAccount = vi.fn();
const mockBeginReauth = vi.fn();
const mockReorderAccounts = vi.fn();

vi.mock("../../ipc/queries", () => ({
  useAccounts: vi.fn(),
  useFolders: vi.fn(),
  useRemoveAccount: vi.fn(),
  useBeginReauth: vi.fn(),
  useReorderAccounts: vi.fn(),
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

import { useAccounts, useFolders, useRemoveAccount, useBeginReauth, useReorderAccounts } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import type { UiState } from "../../app/store";
import { MailboxRail } from "./MailboxRail";

const mockUseAccounts = vi.mocked(useAccounts);
const mockUseFolders = vi.mocked(useFolders);
const mockUseRemoveAccount = vi.mocked(useRemoveAccount);
const mockUseBeginReauth = vi.mocked(useBeginReauth);
const mockUseReorderAccounts = vi.mocked(useReorderAccounts);
const mockUseUiStore = vi.mocked(useUiStore);

const accountWithReauth = {
  id: 1,
  email: "a@x.com",
  display_name: "A",
  color: "#4f46e5",
  position: 0,
  requires_reauth: true,
  provider_type: "google_oauth" as const,
};

const accountNormal = {
  id: 2,
  email: "b@x.com",
  display_name: "B",
  color: "#10b981",
  position: 1,
  requires_reauth: false,
  provider_type: "imap_password" as const,
};

function setupStore(selectedAccountId: number | null = 1) {
  mockUseUiStore.mockImplementation(
    (selector: (s: UiState) => unknown) => {
      const state: UiState = {
        selectedAccountId,
        selectedFolderId: null,
        selectedMessageId: null,
        selectedThreadId: null,
        density: "comfortable",
        composer: { open: false, draftId: null, prefill: null },
        setSelectedAccountId: mockSetSelectedAccountId,
        setSelectedFolderId: mockSetSelectedFolderId,
        setSelectedMessageId: vi.fn(),
        setSelectedThreadId: vi.fn(),
        setDensity: vi.fn(),
        openComposer: vi.fn(),
        closeComposer: vi.fn(),
      };
      return selector ? selector(state) : state;
    }
  );
}

function setupMutations() {
  mockUseRemoveAccount.mockReturnValue({
    mutate: mockRemoveAccount,
    isPending: false,
  } as unknown as ReturnType<typeof useRemoveAccount>);

  mockUseBeginReauth.mockReturnValue({
    mutate: mockBeginReauth,
    isPending: false,
  } as unknown as ReturnType<typeof useBeginReauth>);

  mockUseReorderAccounts.mockReturnValue({
    mutate: mockReorderAccounts,
    isPending: false,
  } as unknown as ReturnType<typeof useReorderAccounts>);

  mockUseFolders.mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof useFolders>);
}

describe("MailboxRail", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows reauth badge when account.requires_reauth is true", () => {
    setupStore(1);
    setupMutations();
    mockUseAccounts.mockReturnValue({
      data: [accountWithReauth],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);

    render(<MailboxRail />);

    expect(screen.getByText("⚠ Reconnect")).toBeTruthy();
  });

  it("clicking Reconnect badge calls beginReauth with account id", async () => {
    const user = userEvent.setup();
    setupStore(1);
    setupMutations();
    mockUseAccounts.mockReturnValue({
      data: [accountWithReauth],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);

    render(<MailboxRail />);

    await user.click(screen.getByText("⚠ Reconnect"));

    expect(mockBeginReauth).toHaveBeenCalledWith(1);
  });

  it("no reauth badge when account.requires_reauth is false", () => {
    setupStore(2);
    setupMutations();
    mockUseAccounts.mockReturnValue({
      data: [accountNormal],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);

    render(<MailboxRail />);

    expect(screen.queryByText("⚠ Reconnect")).toBeNull();
  });

  it("shows confirm dialog when remove button clicked, calls removeAccount on confirm", async () => {
    const user = userEvent.setup();
    setupStore(1);
    setupMutations();
    mockUseAccounts.mockReturnValue({
      data: [accountWithReauth],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);

    render(<MailboxRail />);

    await user.click(screen.getByRole("button", { name: /remove account a/i }));

    expect(screen.getByText(/permanently remove/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /confirm/i }));

    expect(mockRemoveAccount).toHaveBeenCalledWith(1);
  });

  it("cancelling remove dialog does not call removeAccount", async () => {
    const user = userEvent.setup();
    setupStore(1);
    setupMutations();
    mockUseAccounts.mockReturnValue({
      data: [accountWithReauth],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);

    render(<MailboxRail />);

    await user.click(screen.getByRole("button", { name: /remove account a/i }));
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(mockRemoveAccount).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm test -- --reporter=verbose src/features/mailbox/MailboxRail.test.tsx 2>&1 | grep -E "FAIL|pass"
```

Expected: failures about `useRemoveAccount`, `useBeginReauth`, `useReorderAccounts` not exported from queries, and missing UI elements.

- [ ] **Step 4: Add mutation hooks to queries.ts**

In `src/ipc/queries.ts`, append at the end:

```ts
export function useRemoveAccount() {
  const queryClient = useQueryClient();
  const store = useUiStore.getState();
  return useMutation({
    mutationFn: (accountId: number) =>
      commands.removeAccount(accountId).then(unwrap),
    onSuccess: (_data, accountId) => {
      if (store.selectedAccountId === accountId) {
        store.setSelectedAccountId(null);
        store.setSelectedFolderId(null);
      }
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
}

export function useReorderAccounts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (orderedIds: number[]) =>
      commands.reorderAccounts(orderedIds).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
}

export function useBeginReauth() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accountId: number) =>
      commands.beginReauth(accountId).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
}
```

Also add the `useUiStore` import at the top of `queries.ts`:

```ts
import { useUiStore } from "../app/store";
```

- [ ] **Step 5: Update events.ts to listen accountAuthChanged + add smart folder invalidation**

Replace the entire `src/ipc/events.ts`:

```ts
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { events } from "./bindings";

export function useSyncEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const progressPromise = events.syncProgress.listen((event) => {
      const { account_id, folder_id } = event.payload;
      queryClient.invalidateQueries({ queryKey: ["folders", account_id] });
      queryClient.invalidateQueries({ queryKey: ["messages", folder_id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["smart"] });
    });

    const messagesPromise = events.newMessages.listen((event) => {
      const { account_id, folder_id } = event.payload;
      queryClient.invalidateQueries({ queryKey: ["folders", account_id] });
      queryClient.invalidateQueries({ queryKey: ["messages", folder_id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["smart"] });
    });

    const mailboxPromise = events.mailboxChanged.listen((event) => {
      const { account_id, folder_id } = event.payload;
      queryClient.invalidateQueries({ queryKey: ["folders", account_id] });
      queryClient.invalidateQueries({ queryKey: ["messages", folder_id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["smart"] });
    });

    const authChangedPromise = events.accountAuthChanged.listen(() => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    });

    return () => {
      progressPromise.then((unlisten) => unlisten());
      messagesPromise.then((unlisten) => unlisten());
      mailboxPromise.then((unlisten) => unlisten());
      authChangedPromise.then((unlisten) => unlisten());
    };
  }, [queryClient]);
}
```

- [ ] **Step 6: Rewrite MailboxRail.tsx with remove button, reauth badge, and DnD reorder**

Replace the entire `src/features/mailbox/MailboxRail.tsx`:

```tsx
import { useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  useAccounts,
  useFolders,
  useRemoveAccount,
  useBeginReauth,
  useReorderAccounts,
} from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import { AddAccountWizard } from "../accounts/AddAccountWizard";
import type { Account } from "../../ipc/bindings";

const SMART_FOLDERS = [
  { label: "All Inboxes" },
  { label: "Unread" },
  { label: "Flagged" },
];

interface RemoveConfirmProps {
  account: Account;
  onConfirm: () => void;
  onCancel: () => void;
}

function RemoveConfirmDialog({ account, onConfirm, onCancel }: RemoveConfirmProps) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
      }}
    >
      <div
        style={{
          background: "var(--bg-surface)",
          borderRadius: "var(--radius-md)",
          padding: "var(--space-6)",
          maxWidth: 380,
          width: "100%",
        }}
      >
        <p style={{ marginBottom: "var(--space-4)", fontSize: "14px" }}>
          Permanently remove <strong>{account.display_name || account.email}</strong>? This deletes all
          locally cached messages and cannot be undone.
        </p>
        <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            aria-label="Cancel"
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              padding: "var(--space-1) var(--space-3)",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            aria-label="Confirm"
            style={{
              background: "var(--color-red-600, #dc2626)",
              border: "none",
              borderRadius: "var(--radius-sm)",
              color: "white",
              padding: "var(--space-1) var(--space-3)",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

interface SortableAccountRowProps {
  account: Account;
  isSelected: boolean;
  onAccountClick: (id: number) => void;
  onRemoveClick: (account: Account) => void;
  onReauthClick: (id: number) => void;
  children?: React.ReactNode;
}

function SortableAccountRow({
  account,
  isSelected,
  onAccountClick,
  onRemoveClick,
  onReauthClick,
  children,
}: SortableAccountRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: account.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-2) var(--space-4)",
          cursor: "pointer",
          fontSize: "14px",
          borderRadius: "var(--radius-sm)",
          margin: "1px var(--space-2)",
          fontWeight: isSelected ? 600 : 400,
          color: isSelected ? "var(--accent)" : "var(--text-on-rail)",
        }}
      >
        <span
          {...attributes}
          {...listeners}
          style={{ cursor: "grab", padding: "0 2px", color: "var(--text-muted)" }}
          aria-label={`Drag to reorder ${account.display_name || account.email}`}
        >
          ⠿
        </span>
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: account.color ?? "var(--accent)",
            flexShrink: 0,
          }}
          onClick={() => onAccountClick(account.id)}
        />
        <span style={{ flex: 1 }} onClick={() => onAccountClick(account.id)}>
          {account.display_name || account.email}
        </span>
        {account.requires_reauth && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onReauthClick(account.id);
            }}
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              fontSize: "12px",
              color: "var(--color-amber-500, #f59e0b)",
              padding: "0 2px",
            }}
          >
            ⚠ Reconnect
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemoveClick(account);
          }}
          aria-label={`Remove account ${account.display_name || account.email}`}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: "12px",
            color: "var(--text-muted)",
            padding: "0 2px",
            opacity: 0.5,
          }}
        >
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}

interface Props {
  status?: string;
}

export function MailboxRail({ status }: Props) {
  const [wizardOpen, setWizardOpen] = useState(false);
  const [confirmAccount, setConfirmAccount] = useState<Account | null>(null);

  const selectedAccountId = useUiStore((s) => s.selectedAccountId);
  const selectedFolderId = useUiStore((s) => s.selectedFolderId);
  const setSelectedAccountId = useUiStore((s) => s.setSelectedAccountId);
  const setSelectedFolderId = useUiStore((s) => s.setSelectedFolderId);

  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();
  const { data: folders = [] } = useFolders(selectedAccountId);
  const removeAccount = useRemoveAccount();
  const beginReauth = useBeginReauth();
  const reorderAccounts = useReorderAccounts();

  const sensors = useSensors(useSensor(PointerSensor));

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

  function handleRemoveClick(account: Account) {
    setConfirmAccount(account);
  }

  function handleRemoveConfirm() {
    if (confirmAccount) {
      removeAccount.mutate(confirmAccount.id);
    }
    setConfirmAccount(null);
  }

  function handleRemoveCancel() {
    setConfirmAccount(null);
  }

  function handleReauthClick(accountId: number) {
    beginReauth.mutate(accountId);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = accounts.findIndex((a) => a.id === active.id);
    const newIndex = accounts.findIndex((a) => a.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(accounts, oldIndex, newIndex);
    reorderAccounts.mutate(reordered.map((a) => a.id));
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
        {SMART_FOLDERS.map(({ label }) => (
          <div
            key={label}
            style={{
              padding: "var(--space-2) var(--space-4)",
              fontSize: "14px",
              borderRadius: "var(--radius-sm)",
              margin: "1px var(--space-2)",
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
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={accounts.map((a) => a.id)}
                strategy={verticalListSortingStrategy}
              >
                {accounts.map((account) => (
                  <SortableAccountRow
                    key={account.id}
                    account={account}
                    isSelected={selectedAccountId === account.id}
                    onAccountClick={handleAccountClick}
                    onRemoveClick={handleRemoveClick}
                    onReauthClick={handleReauthClick}
                  >
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
                  </SortableAccountRow>
                ))}
              </SortableContext>
            </DndContext>
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

      {confirmAccount && (
        <RemoveConfirmDialog
          account={confirmAccount}
          onConfirm={handleRemoveConfirm}
          onCancel={handleRemoveCancel}
        />
      )}
    </aside>
  );
}
```

- [ ] **Step 7: Run frontend tests**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm test -- --reporter=verbose src/features/mailbox/MailboxRail.test.tsx
```

Expected output includes:
```
✓ shows reauth badge when account.requires_reauth is true
✓ clicking Reconnect badge calls beginReauth with account id
✓ no reauth badge when account.requires_reauth is false
✓ shows confirm dialog when remove button clicked, calls removeAccount on confirm
✓ cancelling remove dialog does not call removeAccount
```

- [ ] **Step 8: Run full frontend test suite**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm test
```

Expected: all tests pass.

- [ ] **Step 9: Run full Rust test suite**

```bash
cargo test
```

Expected: all workspace crates pass.

- [ ] **Step 10: Commit**

```bash
git add src/ipc/queries.ts src/ipc/events.ts src/features/mailbox/MailboxRail.tsx src/features/mailbox/MailboxRail.test.tsx
git commit -m "feat(ui): add remove account confirm, reauth badge, drag-and-drop reorder in MailboxRail"
```

---

## Self-Review checklist

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Remove account: stop worker, delete keychain secret, DELETE row, ON DELETE CASCADE | T2 (stop), T4 (command) |
| `account_id → CancellationToken` registry; resolves IDLE cancellation tech-debt | T2 |
| `requires_reauth` column read/write | T1 |
| Worker sets `requires_reauth = 1`, emits `accountAuthChanged` on `NeedsReauth` | T3 |
| "⚠ Reconnect" marker per account in rail | T6 |
| Re-auth re-runs OAuth flow for existing account, overwrites refresh token, clears flag, restarts worker | T5 |
| `reorderAccounts` — single transaction, `position` = index | T1 (repo) + T5 (command) |
| Drag-and-drop rail | T6 |
| UI confirm before remove | T6 |
| Secrets never in logs/events/error messages | T3 (AuthChanged carries no token), T4 (`delete_password` failure tolerated without leaking) |
| `gen:bindings` after any tauri-specta change | T5 step 7 |
| Frontend invalidates `["accounts"]` on `accountAuthChanged` | T6 (events.ts) |
| `["smart"]` invalidation added to existing sync event handlers | T6 (events.ts) |

**Placeholder scan:** None found — all steps include complete code.

**Type consistency:**
- `requires_reauth: bool` in `Account` (T1) matches usage in `set_requires_reauth(db, id, bool)` (T1), sink test (T3), and frontend `account.requires_reauth` (T6).
- `stop_account(account_id: i64)` defined in T2, called in T4 and T5.
- `get_account_auth_ref` defined in T1, called in T4 (`remove_account`). `begin_reauth` (T5) uses `account.email` as the keychain key (equal to `auth_ref` by construction).
- `AccountAuthChanged { account_id: i64, requires_reauth: bool }` defined in T3 events.rs, matched in sink.rs T3 and events.ts T6.
- `useRemoveAccount` / `useReorderAccounts` / `useBeginReauth` defined in T6 queries.ts, mocked in T6 test.
