# AbeonMail Etap 1 (Fundament) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Postawić działający szkielet AbeonMail: workspace Rust + SQLite ze schematem v1 + typowany kontrakt IPC (generacja typów do TS) + shell UI 3-panelowy z design tokenami light/dark, kończąc na end-to-end roundtrip Rust↔React.

**Architecture:** Gruby rdzeń Rust (workspace wielocrate'owy) jest właścicielem prawdy; React jest cienką warstwą prezentacji komunikującą się przez komendy Tauri (`invoke`) i eventy (`emit`/`listen`). Typy DTO i sygnatury komend definiowane raz w Rust i generowane do TypeScript przez tauri-specta — kontrakt IPC jest type-safe po obu stronach.

**Tech Stack:** Tauri 2, Rust (tokio, rusqlite + bundled SQLite/FTS5, refinery, specta, tauri-specta), React 18 + TypeScript + Vite, @tanstack/query, zustand, design tokens (CSS variables), Plus Jakarta Sans.

## Global Constraints

- Cel wydajności: start do interaktywnego shella < 1 s; UI renderuje z lokalnych danych, nigdy nie czeka na sieć (w tym etapie brak sieci — fundament).
- Język kodu: wszystkie identyfikatory (zmienne, funkcje, typy, nazwy plików) po angielsku.
- Bez komentarzy w kodzie; istotne decyzje trafiają do `docs/`.
- Commity: Conventional Commits 1.0.0; bez linii Co-Authored-By; push tylko na wyraźną prośbę.
- Frontend nigdy nie woła serwera poczty bezpośrednio — wyłącznie przez komendy Tauri.
- Sekrety nigdy w bazie ani w plikach — tylko keychain OS (dotyczy późniejszych etapów; tu schemat trzyma jedynie `auth_ref`).
- Brand accent indigo `#4f46e5` / `#6366f1`; neutralne lawendowe; ciemne powierzchnie `#1a1a2e`/`#2a2a40`; font Plus Jakarta Sans. Motywy: light / dark / auto.
- Tauri 2.x, Rust edition 2021, Node 20+, specta v2 + tauri-specta v2.

---

## File Structure

**Rust workspace (root `Cargo.toml` = workspace):**
- `crates/am-core/` — typy domenowe + błędy. Pliki: `src/lib.rs`, `src/account.rs`, `src/folder.rs`, `src/message.rs`, `src/error.rs`.
- `crates/am-storage/` — SQLite, migracje, repozytoria. Pliki: `src/lib.rs`, `src/db.rs`, `src/migrations/V1__initial_schema.sql`, `src/accounts_repo.rs`.
- `crates/am-app/` — fasada Tauri: stan aplikacji + komendy. Pliki: `src/lib.rs`, `src/state.rs`, `src/commands.rs`.
- `src-tauri/` — bootstrap binarki: `Cargo.toml`, `tauri.conf.json`, `build.rs`, `src/main.rs`, `src/lib.rs`, `bin/export_bindings.rs`.

**Front (React, `src/`):**
- `src/ipc/bindings.ts` — generowane przez tauri-specta (NIE edytować ręcznie).
- `src/ipc/client.ts` — typowany wrapper na komendy/eventy.
- `src/shared/theme/tokens.css` — design tokens (CSS variables) light/dark.
- `src/shared/theme/ThemeProvider.tsx` — provider + hook `useTheme`.
- `src/shared/theme/theme.ts` — typy i logika rozwiązywania motywu (light/dark/auto).
- `src/app/AppShell.tsx` — layout 3-panelowy + szyna nawigacji.
- `src/app/shell.css` — style shella (grid 3-panelowy, gęstość).
- `src/features/*/` — placeholdery paneli (mailbox/message-list/reader) na tym etapie statyczne.
- `src/main.tsx`, `src/App.tsx` — entry + montaż providerów.

**Konfiguracja front:** `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `vitest.config.ts`.

---

## Task 1: Scaffold projektu (Tauri 2 + React + Vite + workspace) i git init

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`
- Create: `Cargo.toml` (workspace root), `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/build.rs`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`
- Create: `.gitignore`

**Interfaces:**
- Consumes: nic (start projektu).
- Produces: uruchamialna aplikacja Tauri 2 z pustym oknem; workspace Rust gotowy na dodawanie crate'ów.

- [ ] **Step 1: Inicjalizacja repo i scaffold Tauri 2 + React-TS**

```bash
cd /home/pszweda/projects/cyberstudio/AbeonMail
git init
npm create tauri-app@latest . -- --template react-ts --manager npm --yes
```

Jeśli katalog nie jest pusty (są `docs/`), użyj wariantu interaktywnego i wskaż bieżący katalog, zachowując `docs/`. Po scaffoldzie usuń przykładową zawartość `src/App.tsx` (zastąpimy w Step 4).

- [ ] **Step 2: Zamień root `Cargo.toml` na workspace**

Plik `Cargo.toml` (root):

```toml
[workspace]
members = ["src-tauri", "crates/am-core", "crates/am-storage", "crates/am-app"]
resolver = "2"

[workspace.package]
edition = "2021"
version = "0.1.0"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
specta = { version = "2.0.0-rc.20", features = ["derive"] }
thiserror = "1"
rusqlite = { version = "0.31", features = ["bundled"] }
refinery = { version = "0.8", features = ["rusqlite"] }
```

- [ ] **Step 3: Smoke build Rust + front**

Run:
```bash
npm install
cargo build
npm run build
```
Expected: oba buildy kończą się bez błędów (workspace kompiluje pustą binarkę Tauri; Vite buduje front).

- [ ] **Step 4: Minimalny `src/App.tsx` i `src/main.tsx`**

`src/App.tsx`:

```tsx
export default function App() {
  return <div id="app-root">AbeonMail</div>;
}
```

`src/main.tsx`:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 5: Uruchom aplikację (smoke)**

Run: `npm run tauri dev`
Expected: otwiera się okno z napisem "AbeonMail". Zamknij po weryfikacji.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold tauri 2 + react workspace"
```

---

## Task 2: am-core — typy domenowe i błędy

**Files:**
- Create: `crates/am-core/Cargo.toml`, `crates/am-core/src/lib.rs`, `crates/am-core/src/account.rs`, `crates/am-core/src/folder.rs`, `crates/am-core/src/message.rs`, `crates/am-core/src/error.rs`
- Test: testy inline w modułach (`#[cfg(test)]`).

**Interfaces:**
- Consumes: nic.
- Produces:
  - `am_core::account::Account { id: i64, email: String, display_name: String, provider_type: ProviderType, color: Option<String>, position: i64 }`
  - `am_core::account::NewAccount { email: String, display_name: String, provider_type: ProviderType, color: Option<String> }`
  - `am_core::account::ProviderType` (enum: `ImapPassword`, `GoogleOauth`)
  - `am_core::folder::{Folder, FolderType}`
  - `am_core::message::MessageHeader` (lekki DTO listy)
  - `am_core::error::CoreError` (thiserror)
  - Wszystkie typy: `#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]`.

- [ ] **Step 1: `Cargo.toml` crate'a**

`crates/am-core/Cargo.toml`:

```toml
[package]
name = "am-core"
edition.workspace = true
version.workspace = true

[dependencies]
serde.workspace = true
specta.workspace = true
thiserror.workspace = true
```

- [ ] **Step 2: Napisz failing test dla serializacji `Account`**

`crates/am-core/src/account.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderType {
    ImapPassword,
    GoogleOauth,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct Account {
    pub id: i64,
    pub email: String,
    pub display_name: String,
    pub provider_type: ProviderType,
    pub color: Option<String>,
    pub position: i64,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct NewAccount {
    pub email: String,
    pub display_name: String,
    pub provider_type: ProviderType,
    pub color: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_roundtrips_through_json() {
        let account = Account {
            id: 1,
            email: "a@example.com".into(),
            display_name: "A".into(),
            provider_type: ProviderType::ImapPassword,
            color: Some("#4f46e5".into()),
            position: 0,
        };
        let json = serde_json::to_string(&account).unwrap();
        let back: Account = serde_json::from_str(&json).unwrap();
        assert_eq!(account, back);
    }
}
```

Dodaj `serde_json` do dev-deps w `crates/am-core/Cargo.toml`:

```toml
[dev-dependencies]
serde_json.workspace = true
```

- [ ] **Step 3: Uruchom test — ma nie skompilować się bez `lib.rs`**

Run: `cargo test -p am-core`
Expected: FAIL — `account` module nie jest podpięty w `lib.rs`.

- [ ] **Step 4: Dodaj pozostałe moduły i `lib.rs`**

`crates/am-core/src/folder.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FolderType {
    Inbox,
    Sent,
    Drafts,
    Trash,
    Spam,
    Archive,
    Custom,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct Folder {
    pub id: i64,
    pub account_id: i64,
    pub remote_path: String,
    pub name: String,
    pub folder_type: FolderType,
    pub unread_count: i64,
    pub total_count: i64,
}
```

`crates/am-core/src/message.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct MessageHeader {
    pub id: i64,
    pub account_id: i64,
    pub folder_id: i64,
    pub subject: String,
    pub from_address: String,
    pub from_name: Option<String>,
    pub date: i64,
    pub seen: bool,
    pub flagged: bool,
    pub has_attachments: bool,
    pub snippet: String,
}
```

`crates/am-core/src/error.rs`:

```rust
#[derive(thiserror::Error, Debug)]
pub enum CoreError {
    #[error("not found")]
    NotFound,
    #[error("invalid input: {0}")]
    InvalidInput(String),
}
```

`crates/am-core/src/lib.rs`:

```rust
pub mod account;
pub mod error;
pub mod folder;
pub mod message;
```

- [ ] **Step 5: Uruchom test — PASS**

Run: `cargo test -p am-core`
Expected: PASS (`account_roundtrips_through_json`).

- [ ] **Step 6: Commit**

```bash
git add crates/am-core
git commit -m "feat(core): add domain types for account, folder, message"
```

---

## Task 3: am-storage — połączenie SQLite i migracja schematu v1

**Files:**
- Create: `crates/am-storage/Cargo.toml`, `crates/am-storage/src/lib.rs`, `crates/am-storage/src/db.rs`
- Create: `crates/am-storage/src/migrations/V1__initial_schema.sql`
- Test: testy inline w `db.rs`.

**Interfaces:**
- Consumes: `am-core` (typy domenowe).
- Produces:
  - `am_storage::db::Database` z `Database::open_in_memory() -> Result<Database, StorageError>` oraz `Database::open(path: &str) -> Result<Database, StorageError>`.
  - `Database` udostępnia `pub(crate) fn conn(&self) -> std::sync::MutexGuard<rusqlite::Connection>`.
  - `am_storage::StorageError` (thiserror) z wariantami `Sqlite(rusqlite::Error)`, `Migration(String)`, `NotFound`.

- [ ] **Step 1: `Cargo.toml` crate'a**

`crates/am-storage/Cargo.toml`:

```toml
[package]
name = "am-storage"
edition.workspace = true
version.workspace = true

[dependencies]
am-core = { path = "../am-core" }
rusqlite.workspace = true
refinery.workspace = true
thiserror.workspace = true
serde_json.workspace = true
```

- [ ] **Step 2: Napisz failing test — otwarcie DB tworzy tabele**

`crates/am-storage/src/db.rs`:

```rust
use std::sync::Mutex;
use rusqlite::Connection;

refinery::embed_migrations!("src/migrations");

#[derive(thiserror::Error, Debug)]
pub enum StorageError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error("migration error: {0}")]
    Migration(String),
    #[error("not found")]
    NotFound,
}

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn open_in_memory() -> Result<Self, StorageError> {
        let mut conn = Connection::open_in_memory()?;
        migrations::runner()
            .run(&mut conn)
            .map_err(|e| StorageError::Migration(e.to_string()))?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn open(path: &str) -> Result<Self, StorageError> {
        let mut conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        migrations::runner()
            .run(&mut conn)
            .map_err(|e| StorageError::Migration(e.to_string()))?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub(crate) fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("db mutex poisoned")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_in_memory_creates_accounts_table() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='accounts'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
}
```

- [ ] **Step 3: Uruchom test — FAIL (brak migracji / lib.rs)**

Run: `cargo test -p am-storage`
Expected: FAIL — brak pliku migracji oraz `db` niepodpięty w `lib.rs`.

- [ ] **Step 4: Dodaj migrację schematu v1**

`crates/am-storage/src/migrations/V1__initial_schema.sql`:

```sql
CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    auth_ref TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    color TEXT,
    position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE folders (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    remote_path TEXT NOT NULL,
    name TEXT NOT NULL,
    folder_type TEXT NOT NULL,
    uidvalidity INTEGER,
    uidnext INTEGER,
    unread_count INTEGER NOT NULL DEFAULT 0,
    total_count INTEGER NOT NULL DEFAULT 0,
    sync_state TEXT NOT NULL DEFAULT 'idle',
    UNIQUE(account_id, remote_path)
);

CREATE TABLE threads (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    subject_root TEXT NOT NULL,
    last_date INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    unread_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    uid INTEGER,
    message_id_hdr TEXT,
    thread_id INTEGER REFERENCES threads(id) ON DELETE SET NULL,
    from_address TEXT NOT NULL,
    from_name TEXT,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL DEFAULT '',
    date INTEGER NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0,
    flagged INTEGER NOT NULL DEFAULT 0,
    answered INTEGER NOT NULL DEFAULT 0,
    draft INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    snippet TEXT NOT NULL DEFAULT '',
    body_state TEXT NOT NULL DEFAULT 'none',
    snooze_wake_at INTEGER,
    UNIQUE(folder_id, uid)
);

CREATE TABLE message_bodies (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    mime_structure TEXT NOT NULL DEFAULT '{}',
    text_plain TEXT,
    text_html TEXT,
    downloaded_at INTEGER
);

CREATE TABLE attachments (
    id INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    content_id TEXT,
    blob_ref TEXT,
    downloaded INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE labels (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT,
    UNIQUE(account_id, name)
);

CREATE TABLE message_labels (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, label_id)
);

CREATE TABLE contacts_cache (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT,
    avatar_ref TEXT,
    UNIQUE(account_id, email)
);

CREATE TABLE signatures (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    html TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sync_queue (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    op_type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER
);

CREATE VIRTUAL TABLE search_fts USING fts5(
    subject,
    from_text,
    to_text,
    body_text,
    attachment_names,
    content=''
);

CREATE INDEX idx_messages_folder_date ON messages(folder_id, date DESC);
CREATE INDEX idx_messages_thread ON messages(thread_id);
CREATE INDEX idx_messages_account_seen ON messages(account_id, seen);
```

`crates/am-storage/src/lib.rs`:

```rust
mod db;
pub mod accounts_repo;

pub use db::{Database, StorageError};
```

Uwaga: `accounts_repo` powstaje w Task 4. Aby Task 3 kompilował się samodzielnie, w tym kroku utwórz pusty plik `crates/am-storage/src/accounts_repo.rs` z treścią `// placeholder` zastąpioną pustą linią (bez komentarza) — moduł i tak zostanie wypełniony w Task 4. Alternatywnie tymczasowo usuń `pub mod accounts_repo;` z `lib.rs` w tym kroku i dodaj go w Task 4 Step 4. Wybierz drugą opcję, by uniknąć pustego pliku:

`crates/am-storage/src/lib.rs` (wersja Task 3):

```rust
mod db;

pub use db::{Database, StorageError};
```

- [ ] **Step 5: Uruchom test — PASS**

Run: `cargo test -p am-storage`
Expected: PASS (`open_in_memory_creates_accounts_table`).

- [ ] **Step 6: Commit**

```bash
git add crates/am-storage
git commit -m "feat(storage): add sqlite database with v1 schema migration"
```

---

## Task 4: am-storage — repozytorium kont (CRUD)

**Files:**
- Create: `crates/am-storage/src/accounts_repo.rs`
- Modify: `crates/am-storage/src/lib.rs` (dodanie `pub mod accounts_repo;`)
- Test: testy inline w `accounts_repo.rs`.

**Interfaces:**
- Consumes: `am_storage::Database`, `am_core::account::{Account, NewAccount, ProviderType}`.
- Produces:
  - `am_storage::accounts_repo::insert_account(db: &Database, new: &NewAccount) -> Result<Account, StorageError>`
  - `am_storage::accounts_repo::list_accounts(db: &Database) -> Result<Vec<Account>, StorageError>`
  - `am_storage::accounts_repo::get_account(db: &Database, id: i64) -> Result<Account, StorageError>`
  - `am_storage::accounts_repo::delete_account(db: &Database, id: i64) -> Result<(), StorageError>`

- [ ] **Step 1: Napisz failing test — insert + list round-trip**

`crates/am-storage/src/accounts_repo.rs`:

```rust
use am_core::account::{Account, NewAccount, ProviderType};
use rusqlite::params;

use crate::db::{Database, StorageError};

fn provider_to_str(p: &ProviderType) -> &'static str {
    match p {
        ProviderType::ImapPassword => "imappassword",
        ProviderType::GoogleOauth => "googleoauth",
    }
}

fn provider_from_str(s: &str) -> Result<ProviderType, StorageError> {
    match s {
        "imappassword" => Ok(ProviderType::ImapPassword),
        "googleoauth" => Ok(ProviderType::GoogleOauth),
        _ => Err(StorageError::NotFound),
    }
}

pub fn insert_account(db: &Database, new: &NewAccount) -> Result<Account, StorageError> {
    let conn = db.conn();
    conn.execute(
        "INSERT INTO accounts (email, display_name, provider_type, color, position)
         VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(position) + 1, 0) FROM accounts))",
        params![
            new.email,
            new.display_name,
            provider_to_str(&new.provider_type),
            new.color
        ],
    )?;
    let id = conn.last_insert_rowid();
    drop(conn);
    get_account(db, id)
}

pub fn get_account(db: &Database, id: i64) -> Result<Account, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT id, email, display_name, provider_type, color, position
         FROM accounts WHERE id = ?1",
        params![id],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
            ))
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
        other => StorageError::Sqlite(other),
    })
    .and_then(|(id, email, display_name, provider, color, position)| {
        Ok(Account {
            id,
            email,
            display_name,
            provider_type: provider_from_str(&provider)?,
            color,
            position,
        })
    })
}

pub fn list_accounts(db: &Database) -> Result<Vec<Account>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, email, display_name, provider_type, color, position
         FROM accounts ORDER BY position ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, i64>(5)?,
        ))
    })?;
    let mut out = Vec::new();
    for r in rows {
        let (id, email, display_name, provider, color, position) = r?;
        out.push(Account {
            id,
            email,
            display_name,
            provider_type: provider_from_str(&provider)?,
            color,
            position,
        });
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
}
```

- [ ] **Step 2: Podłącz moduł w `lib.rs`**

`crates/am-storage/src/lib.rs`:

```rust
mod db;
pub mod accounts_repo;

pub use db::{Database, StorageError};
```

- [ ] **Step 3: Uruchom testy — FAIL przed implementacją? (tu implementacja jest w Step 1)**

Run: `cargo test -p am-storage`
Expected: PASS — trzy testy repozytorium oraz test z Task 3.

Uwaga TDD: kod i testy dodaliśmy razem, bo to jeden spójny moduł CRUD; jeśli wolisz ściśle red-green, najpierw wklej tylko blok `#[cfg(test)]` z `super::*` i sygnatury funkcji z `todo!()`, uruchom (FAIL), potem wypełnij ciała (PASS).

- [ ] **Step 4: Commit**

```bash
git add crates/am-storage
git commit -m "feat(storage): add accounts repository with crud"
```

---

## Task 5: am-app — stan aplikacji i komendy IPC

**Files:**
- Create: `crates/am-app/Cargo.toml`, `crates/am-app/src/lib.rs`, `crates/am-app/src/state.rs`, `crates/am-app/src/commands.rs`
- Test: testy inline w `commands.rs` (logika niezależna od Tauri).

**Interfaces:**
- Consumes: `am-core`, `am-storage`.
- Produces:
  - `am_app::state::AppState { db: am_storage::Database }`
  - Komendy Tauri (w `commands.rs`), oznaczone `#[tauri::command]` i `#[specta::specta]`:
    - `app_health() -> String` (zwraca `"ok"`)
    - `list_accounts(state: tauri::State<AppState>) -> Result<Vec<Account>, String>`
    - `add_account(state, new: NewAccount) -> Result<Account, String>`
  - `am_app::build_specta_builder() -> tauri_specta::Builder<tauri::Wry>` — wspólny builder używany przez bootstrap (Task 6) i eksporter (Task 7).

- [ ] **Step 1: `Cargo.toml` crate'a**

`crates/am-app/Cargo.toml`:

```toml
[package]
name = "am-app"
edition.workspace = true
version.workspace = true

[dependencies]
am-core = { path = "../am-core" }
am-storage = { path = "../am-storage" }
serde.workspace = true
specta.workspace = true
specta-typescript = "0.0.7"
tauri = { version = "2", features = [] }
tauri-specta = { version = "2.0.0-rc.21", features = ["derive", "typescript"] }
```

- [ ] **Step 2: Stan aplikacji**

`crates/am-app/src/state.rs`:

```rust
use am_storage::Database;

pub struct AppState {
    pub db: Database,
}

impl AppState {
    pub fn new(db: Database) -> Self {
        Self { db }
    }
}
```

- [ ] **Step 3: Napisz failing test — logika `add_account` przez warstwę storage**

`crates/am-app/src/commands.rs`:

```rust
use am_core::account::{Account, NewAccount};
use am_storage::accounts_repo;

use crate::state::AppState;

#[tauri::command]
#[specta::specta]
pub fn app_health() -> String {
    "ok".to_string()
}

#[tauri::command]
#[specta::specta]
pub fn list_accounts(state: tauri::State<'_, AppState>) -> Result<Vec<Account>, String> {
    accounts_repo::list_accounts(&state.db).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn add_account(
    state: tauri::State<'_, AppState>,
    new: NewAccount,
) -> Result<Account, String> {
    accounts_repo::insert_account(&state.db, &new).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use am_core::account::ProviderType;
    use am_storage::Database;

    #[test]
    fn add_account_persists_via_repo() {
        let db = Database::open_in_memory().unwrap();
        let new = NewAccount {
            email: "x@example.com".into(),
            display_name: "X".into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        };
        let created = accounts_repo::insert_account(&db, &new).unwrap();
        let all = accounts_repo::list_accounts(&db).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(created.email, "x@example.com");
    }
}
```

- [ ] **Step 4: `lib.rs` + builder specta**

`crates/am-app/src/lib.rs`:

```rust
pub mod commands;
pub mod state;

use tauri_specta::{collect_commands, Builder};

pub fn build_specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![
        commands::app_health,
        commands::list_accounts,
        commands::add_account,
    ])
}
```

- [ ] **Step 5: Uruchom test — PASS**

Run: `cargo test -p am-app`
Expected: PASS (`add_account_persists_via_repo`).

- [ ] **Step 6: Commit**

```bash
git add crates/am-app
git commit -m "feat(app): add app state and ipc commands for accounts"
```

---

## Task 6: Bootstrap Tauri — rejestracja komend i inicjalizacja DB

**Files:**
- Modify: `src-tauri/Cargo.toml` (zależności na `am-app`, `tauri-specta`)
- Modify: `src-tauri/src/lib.rs` (montaż buildera, stan, ścieżka DB)
- Modify: `src-tauri/src/main.rs` (wywołanie `run()`)

**Interfaces:**
- Consumes: `am_app::{build_specta_builder, state::AppState}`, `am_storage::Database`.
- Produces: działająca binarka Tauri z zarejestrowanymi komendami i stanem `AppState` w app data dir.

- [ ] **Step 1: Zależności bootstrapu**

`src-tauri/Cargo.toml` — dodaj do `[dependencies]`:

```toml
am-app = { path = "../crates/am-app" }
am-storage = { path = "../crates/am-storage" }
tauri-specta = { version = "2.0.0-rc.21", features = ["derive", "typescript"] }
tauri = { version = "2", features = [] }
```

- [ ] **Step 2: `lib.rs` bootstrapu**

`src-tauri/src/lib.rs`:

```rust
use am_app::{build_specta_builder, state::AppState};
use am_storage::Database;
use tauri::Manager;

pub fn run() {
    let builder = build_specta_builder();

    tauri::Builder::default()
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            let dir = app.path().app_data_dir().expect("no app data dir");
            std::fs::create_dir_all(&dir).expect("cannot create app data dir");
            let db_path = dir.join("abeonmail.db");
            let db = Database::open(db_path.to_str().expect("non-utf8 db path"))
                .expect("cannot open database");
            app.manage(AppState::new(db));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

`src-tauri/src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    app_lib::run();
}
```

Uwaga: nazwa crate'a biblioteki to ta z `src-tauri/Cargo.toml` (`[lib] name`). Jeśli scaffold nadał `app_lib`, użyj `app_lib::run()`; w razie innej nazwy dostosuj `main.rs`.

- [ ] **Step 3: Build i uruchomienie (smoke)**

Run: `npm run tauri dev`
Expected: aplikacja startuje; w katalogu app data powstaje `abeonmail.db`. Brak panik w konsoli.

- [ ] **Step 4: Commit**

```bash
git add src-tauri
git commit -m "feat(tauri): register ipc commands and initialize database"
```

---

## Task 7: Generacja typowanych bindings TS (tauri-specta)

**Files:**
- Create: `src-tauri/bin/export_bindings.rs`
- Modify: `src-tauri/Cargo.toml` (sekcja `[[bin]]`)
- Modify: `package.json` (skrypt `gen:bindings`)
- Create (generowane): `src/ipc/bindings.ts`
- Create: `src/ipc/client.ts`
- Test: `src/ipc/client.test.ts` (Vitest)

**Interfaces:**
- Consumes: `am_app::build_specta_builder`.
- Produces:
  - Plik `src/ipc/bindings.ts` z funkcjami `commands.appHealth()`, `commands.listAccounts()`, `commands.addAccount(new)` oraz typami `Account`, `NewAccount`, `ProviderType`.
  - `src/ipc/client.ts` re-eksportujący `commands` i typy pod stabilnym importem `@/ipc/client`.

- [ ] **Step 1: Eksporter bindings jako binarka**

`src-tauri/bin/export_bindings.rs`:

```rust
use specta_typescript::Typescript;

fn main() {
    am_app::build_specta_builder()
        .export(Typescript::default(), "../src/ipc/bindings.ts")
        .expect("failed to export typescript bindings");
}
```

`src-tauri/Cargo.toml` — dodaj:

```toml
[[bin]]
name = "export_bindings"
path = "bin/export_bindings.rs"
```

Dodaj zależność `specta-typescript = "0.0.7"` do `src-tauri/Cargo.toml` jeśli jeszcze jej nie ma.

- [ ] **Step 2: Skrypt npm**

`package.json` — w `"scripts"` dodaj:

```json
"gen:bindings": "cargo run -p app --bin export_bindings"
```

Uwaga: zamień `-p app` na nazwę pakietu z `src-tauri/Cargo.toml` (`[package] name`). Jeśli to `app`, zostaw.

- [ ] **Step 3: Wygeneruj bindings**

Run: `npm run gen:bindings`
Expected: powstaje/aktualizuje się `src/ipc/bindings.ts` zawierający `export const commands` z `appHealth`, `listAccounts`, `addAccount` oraz typy `Account`, `NewAccount`, `ProviderType`.

- [ ] **Step 4: Napisz failing test dla wrappera klienta**

`src/ipc/client.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "app_health") return "ok";
    return null;
  }),
}));

import { health } from "./client";

describe("ipc client", () => {
  it("health returns ok from app_health command", async () => {
    await expect(health()).resolves.toBe("ok");
  });
});
```

- [ ] **Step 5: Uruchom test — FAIL (brak `client.ts`/`health`)**

Run: `npx vitest run src/ipc/client.test.ts`
Expected: FAIL — `health` nie istnieje.

- [ ] **Step 6: Implementuj `client.ts`**

`src/ipc/client.ts`:

```ts
import { commands } from "./bindings";

export type { Account, NewAccount, ProviderType } from "./bindings";
export { commands };

export async function health(): Promise<string> {
  return commands.appHealth();
}
```

Jeśli `commands.appHealth()` w wygenerowanym pliku zwraca opakowany wynik (tauri-specta), dostosuj `health` do realnego kształtu (np. `await commands.appHealth()` zwracające `string`). Zweryfikuj sygnaturę w `bindings.ts` po Step 3.

- [ ] **Step 7: Uruchom test — PASS**

Run: `npx vitest run src/ipc/client.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/bin src-tauri/Cargo.toml package.json src/ipc
git commit -m "feat(ipc): generate typed bindings and add ipc client wrapper"
```

---

## Task 8: Design tokens (light/dark) i ThemeProvider

**Files:**
- Create: `src/shared/theme/tokens.css`, `src/shared/theme/theme.ts`, `src/shared/theme/ThemeProvider.tsx`
- Create: `src/shared/theme/theme.test.tsx`
- Modify: `index.html` (preconnect + import fontu Plus Jakarta Sans)
- Modify: `src/main.tsx` (import `tokens.css`, owinięcie `ThemeProvider`)

**Interfaces:**
- Consumes: nic.
- Produces:
  - `theme.ts`: typ `ThemeMode = "light" | "dark" | "auto"`; `resolveTheme(mode: ThemeMode, prefersDark: boolean): "light" | "dark"`.
  - `ThemeProvider.tsx`: komponent `ThemeProvider` ustawiający `document.documentElement.dataset.theme`; hook `useTheme(): { mode, setMode, resolved }`.

- [ ] **Step 1: Tokeny CSS (z szablonów)**

`src/shared/theme/tokens.css`:

```css
:root {
  --font-sans: "Plus Jakarta Sans", system-ui, -apple-system, sans-serif;

  --accent: #4f46e5;
  --accent-hover: #6366f1;
  --accent-sky: #0ea5e9;
  --accent-pink: #ec4899;

  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
}

:root[data-theme="light"] {
  --bg-app: #f3f3f8;
  --bg-surface: #ffffff;
  --bg-rail: #1a1a2e;
  --bg-elevated: #f8f8fc;
  --border-subtle: #e6e6ee;
  --text-primary: #1a1a2e;
  --text-secondary: #55556c;
  --text-muted: #9a9ab0;
  --text-on-rail: #efeff7;
}

:root[data-theme="dark"] {
  --bg-app: #1a1a2e;
  --bg-surface: #2a2a40;
  --bg-rail: #11111d;
  --bg-elevated: #2a2a40;
  --border-subtle: #3a3a52;
  --text-primary: #efeff7;
  --text-secondary: #b4b4c8;
  --text-muted: #9090a6;
  --text-on-rail: #efeff7;
}

html, body, #root {
  height: 100%;
  margin: 0;
}

body {
  font-family: var(--font-sans);
  background: var(--bg-app);
  color: var(--text-primary);
}
```

- [ ] **Step 2: Font w `index.html`**

`index.html` — w `<head>` dodaj:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap"
  rel="stylesheet"
/>
```

- [ ] **Step 3: Napisz failing test dla `resolveTheme`**

`src/shared/theme/theme.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { resolveTheme } from "./theme";

describe("resolveTheme", () => {
  it("returns the explicit mode when not auto", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows system preference when auto", () => {
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("auto", false)).toBe("light");
  });
});
```

- [ ] **Step 4: Uruchom test — FAIL**

Run: `npx vitest run src/shared/theme/theme.test.tsx`
Expected: FAIL — `theme.ts` nie istnieje.

- [ ] **Step 5: Implementuj `theme.ts` i `ThemeProvider.tsx`**

`src/shared/theme/theme.ts`:

```ts
export type ThemeMode = "light" | "dark" | "auto";
export type ResolvedTheme = "light" | "dark";

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === "auto") {
    return prefersDark ? "dark" : "light";
  }
  return mode;
}
```

`src/shared/theme/ThemeProvider.tsx`:

```tsx
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { resolveTheme, type ResolvedTheme, type ThemeMode } from "./theme";

type ThemeContextValue = {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  resolved: ResolvedTheme;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>("auto");
  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const resolved = useMemo(() => resolveTheme(mode, prefersDark), [mode, prefersDark]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const value = useMemo(() => ({ mode, setMode, resolved }), [mode, resolved]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
```

- [ ] **Step 6: Uruchom test — PASS**

Run: `npx vitest run src/shared/theme/theme.test.tsx`
Expected: PASS.

- [ ] **Step 7: Podłącz w `main.tsx`**

`src/main.tsx`:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./shared/theme/ThemeProvider";
import "./shared/theme/tokens.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
```

- [ ] **Step 8: Commit**

```bash
git add src/shared/theme index.html src/main.tsx
git commit -m "feat(ui): add light/dark design tokens and theme provider"
```

---

## Task 9: Shell 3-panelowy + integracja end-to-end IPC

**Files:**
- Create: `src/app/AppShell.tsx`, `src/app/shell.css`
- Create: `src/features/mailbox/MailboxRail.tsx`, `src/features/message-list/MessageListPane.tsx`, `src/features/reader/ReaderPane.tsx`
- Modify: `src/App.tsx`
- Create: `src/app/AppShell.test.tsx`

**Interfaces:**
- Consumes: `health` z `@/ipc/client`, `useTheme`.
- Produces: `AppShell` renderujący trzy panele (rail / lista / reader) i pokazujący status IPC z `app_health` (dowód działania pełnego potoku Rust↔React).

- [ ] **Step 1: Style shella**

`src/app/shell.css`:

```css
.shell {
  display: grid;
  grid-template-columns: 248px minmax(320px, 1fr) minmax(360px, 1.4fr);
  height: 100%;
}

.shell[data-density="compact"] {
  grid-template-columns: 220px minmax(280px, 1fr) minmax(320px, 1.4fr);
}

.rail {
  background: var(--bg-rail);
  color: var(--text-on-rail);
  padding: var(--space-4);
}

.pane {
  background: var(--bg-surface);
  border-left: 1px solid var(--border-subtle);
  padding: var(--space-4);
  overflow: auto;
}

.status {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: var(--space-4);
}
```

- [ ] **Step 2: Placeholdery paneli**

`src/features/mailbox/MailboxRail.tsx`:

```tsx
export function MailboxRail({ status }: { status: string }) {
  return (
    <aside className="rail">
      <strong>AbeonMail</strong>
      <nav>
        <div>All Inboxes</div>
        <div>Unread</div>
        <div>Flagged</div>
        <div>Snoozed</div>
        <div>Drafts</div>
      </nav>
      <div className="status">IPC: {status}</div>
    </aside>
  );
}
```

`src/features/message-list/MessageListPane.tsx`:

```tsx
export function MessageListPane() {
  return (
    <section className="pane" aria-label="message-list">
      <h2>Inbox</h2>
    </section>
  );
}
```

`src/features/reader/ReaderPane.tsx`:

```tsx
export function ReaderPane() {
  return (
    <section className="pane" aria-label="reader">
      <p>Wybierz wiadomość</p>
    </section>
  );
}
```

- [ ] **Step 3: Napisz failing test dla `AppShell`**

`src/app/AppShell.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("../ipc/client", () => ({
  health: vi.fn(async () => "ok"),
}));

vi.mock("../shared/theme/ThemeProvider", () => ({
  useTheme: () => ({ mode: "light", setMode: vi.fn(), resolved: "light" }),
}));

import { AppShell } from "./AppShell";

describe("AppShell", () => {
  it("renders three panes and shows ipc status", async () => {
    render(<AppShell />);
    expect(screen.getByLabelText("message-list")).toBeTruthy();
    expect(screen.getByLabelText("reader")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("IPC: ok")).toBeTruthy());
  });
});
```

- [ ] **Step 4: Uruchom test — FAIL**

Run: `npx vitest run src/app/AppShell.test.tsx`
Expected: FAIL — `AppShell` nie istnieje.

- [ ] **Step 5: Implementuj `AppShell`**

`src/app/AppShell.tsx`:

```tsx
import { useEffect, useState } from "react";
import "./shell.css";
import { health } from "../ipc/client";
import { MailboxRail } from "../features/mailbox/MailboxRail";
import { MessageListPane } from "../features/message-list/MessageListPane";
import { ReaderPane } from "../features/reader/ReaderPane";

export function AppShell() {
  const [status, setStatus] = useState("…");

  useEffect(() => {
    let active = true;
    health()
      .then((s) => active && setStatus(s))
      .catch(() => active && setStatus("error"));
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="shell" data-density="comfortable">
      <MailboxRail status={status} />
      <MessageListPane />
      <ReaderPane />
    </div>
  );
}
```

`src/App.tsx`:

```tsx
import { AppShell } from "./app/AppShell";

export default function App() {
  return <AppShell />;
}
```

- [ ] **Step 6: Uruchom test — PASS**

Run: `npx vitest run src/app/AppShell.test.tsx`
Expected: PASS.

- [ ] **Step 7: Weryfikacja end-to-end w aplikacji**

Run: `npm run tauri dev`
Expected: okno pokazuje trzy panele; w railu widnieje "IPC: ok" (komenda `app_health` z Rust dotarła do React). Przełączenie `prefers-color-scheme` w systemie zmienia motyw.

- [ ] **Step 8: Commit**

```bash
git add src/app src/features src/App.tsx
git commit -m "feat(ui): add three-pane app shell with end-to-end ipc status"
```

---

## Self-Review

**Spec coverage (Etap 1 = workspace + schemat DB + kontrakt IPC + shell UI z tokenami):**
- Workspace wielocrate'owy → Task 1, 2, 3, 5 (am-core, am-storage, am-app, src-tauri).
- Schemat DB v1 (sekcja 3 specyfikacji) → Task 3 (wszystkie tabele, FTS5, indeksy) + Task 4 (pierwsze repozytorium).
- Kontrakt IPC type-safe (tauri-specta) → Task 5 (komendy + builder), Task 6 (rejestracja), Task 7 (generacja TS + klient).
- Design tokeny light/dark z szablonów (sekcja 7) → Task 8 (indigo accent, lawendowe neutralne, ciemne powierzchnie, Plus Jakarta Sans, light/dark/auto).
- Shell 3-panelowy + smart folders placeholder (sekcja 6.1) → Task 9.
- Cel wydajności/architektura "front renderuje z lokalnych danych, IPC type-safe" → udowodnione end-to-end w Task 9 Step 7.

Świadomie poza zakresem Etapu 1 (kolejne etapy): sieć (IMAP/SMTP/POP), sync, OAuth, composer, skróty, search, snooze, ustawienia — zgodnie z planem etapów w specyfikacji.

**Placeholder scan:** Brak "TBD/TODO/implement later". Jedyne uwagi to instrukcje dostosowania nazw pakietu/lib do wyniku scaffoldu Tauri (`app` / `app_lib`) — to świadome punkty weryfikacji środowiska, nie luki w kodzie.

**Type consistency:** `Account`/`NewAccount`/`ProviderType` spójne w am-core (Task 2) → repozytorium (Task 4) → komendy (Task 5) → bindings TS (Task 7). `Database::open_in_memory`/`open` i `StorageError` spójne między Task 3 a 4/5. `resolveTheme(mode, prefersDark)` spójne między Task 8 testem a implementacją. `health()` spójne między Task 7 a 9.

## Uwaga wersji bibliotek

Wersje `specta`/`tauri-specta`/`specta-typescript` to release-candidate'y z ekosystemu Tauri 2 i mogą wymagać dopasowania do najnowszych kompatybilnych wydań w momencie wykonania (sprawdź `cargo add tauri-specta specta specta-typescript` i wyrównaj wersje). API `build_specta_builder` / `Typescript::default()` / `collect_commands!` jest stabilne w linii v2-rc; w razie zmian dostosuj wyłącznie Task 5/7.
```
