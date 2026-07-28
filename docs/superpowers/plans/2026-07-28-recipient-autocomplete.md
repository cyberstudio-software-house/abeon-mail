# Recipient Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Suggest recipient addresses from correspondence history while the user types in the composer's To / Cc / Bcc fields.

**Architecture:** A materialized contact index lives in the existing (currently unused) `contacts_cache` table. It is fed at ingestion time from Sent-folder envelopes and from locally sent mail, backfilled once from the local database, and completed by a one-time `ENVELOPE`-only re-scan of Sent folders. The composer queries it through a new `suggest_contacts` command.

**Tech Stack:** Rust (rusqlite 0.31 bundled SQLite 3.45, refinery migrations, tauri-specta commands, async-imap), React 18 + TypeScript, TanStack Query, Vitest + Testing Library.

Design doc: `docs/superpowers/specs/2026-07-28-recipient-autocomplete-design.md`

## Global Constraints

- No comments in code. If something needs explaining, it goes into `docs/`.
- All identifiers, strings and test names in English.
- Conventional Commits 1.0.0 for every commit. No `Co-Authored-By` trailer.
- Never append to an already-committed migration file. Refinery aborts on
  divergent checksums, so a changed `V18` would break every database that
  already applied it. New SQL always goes into a new `V<n>` file.
- Recipient chips store the **bare lowercase address**, never `Name <addr>`.
  `OutgoingMessage.to/cc/bcc` (`crates/am-core/src/outgoing.rs:37`) feeds both
  `mail_builder`'s `.to()` and the SMTP `RCPT TO` list
  (`crates/am-sync/src/send.rs:216`); a display name inside that string would
  corrupt the envelope.
- Contact upserts are best-effort. A failure is logged with `eprintln!` and
  skipped — it must never fail message ingestion or sending.
- Test baseline: the suite has 12 known pre-existing frontend failures
  (ConversationView reply-button ×3, useDebouncedValue fake-timers ×3,
  store.test sending-counter ×6). Do not chase them.
- Run frontend tests from the main checkout with `npx vitest run <path>`.
  Running plain `npx vitest run` from a worktree double-counts test copies.

---

### Task 1: Contact index schema and upsert

**Files:**
- Create: `crates/am-storage/src/migrations/V18__contacts.sql`
- Create: `crates/am-storage/src/contacts_repo.rs`
- Modify: `crates/am-storage/src/lib.rs` (add `pub mod contacts_repo;`)
- Test: `crates/am-storage/src/contacts_repo.rs` (inline `#[cfg(test)] mod tests`)
- Test: `crates/am-storage/src/db.rs` (migration assertion, follows
  `migration_v14_adds_is_html_column` at the end of the existing test module)

**Interfaces:**
- Consumes: `crate::db::{Database, StorageError}`, the existing
  `contacts_cache` table from `V1__initial_schema.sql:94`
  (`id, account_id, email, name, avatar_ref`, `UNIQUE(account_id, email)`,
  `account_id` cascades on account delete).
- Produces:
  - `pub struct ContactSuggestion { pub email: String, pub name: Option<String>, pub exchange_count: i64, pub last_contact_at: i64 }`
  - `pub fn fold_text(input: &str) -> String`
  - `pub fn normalize_search_key(name: Option<&str>, email: &str) -> String`
  - `pub fn upsert_contact(db: &Database, account_id: i64, email: &str, name: Option<&str>, contacted_at: i64) -> Result<(), StorageError>`

- [ ] **Step 1: Write the migration**

Create `crates/am-storage/src/migrations/V18__contacts.sql`:

```sql
ALTER TABLE contacts_cache ADD COLUMN exchange_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts_cache ADD COLUMN last_contact_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts_cache ADD COLUMN search_key TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_contacts_search ON contacts_cache(search_key);
```

- [ ] **Step 2: Write the failing migration test**

Append to the existing `mod tests` in `crates/am-storage/src/db.rs`:

```rust
    #[test]
    fn migration_v18_adds_contact_index_columns() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        let cols: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('contacts_cache')
                 WHERE name IN ('exchange_count','last_contact_at','search_key')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cols, 3);
        let idx: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='idx_contacts_search'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx, 1);
    }
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `cargo test -p am-storage migration_v18 -- --nocapture`
Expected: PASS. (The migration file is already in place, so this test guards
the schema rather than driving it.)

- [ ] **Step 4: Write the failing repo tests**

Create `crates/am-storage/src/contacts_repo.rs` containing only the test module
for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use am_core::account::{NewAccount, ProviderType};

    fn seed_account(db: &Database, email: &str) -> i64 {
        insert_account(
            db,
            &NewAccount {
                email: email.into(),
                display_name: "Owner".into(),
                provider_type: ProviderType::ImapPassword,
                color: None,
            },
        )
        .unwrap()
        .id
    }

    fn stored(db: &Database, email: &str) -> (Option<String>, i64, i64, String) {
        let conn = db.conn();
        conn.query_row(
            "SELECT name, exchange_count, last_contact_at, search_key
             FROM contacts_cache WHERE email = ?1",
            rusqlite::params![email],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap()
    }

    #[test]
    fn fold_text_lowercases_and_strips_diacritics() {
        assert_eq!(fold_text("Łukasz ŻÓŁĆ"), "lukasz zolc");
        assert_eq!(fold_text("Jan@Firma.PL"), "jan@firma.pl");
        assert_eq!(fold_text("Straße"), "strasse");
    }

    #[test]
    fn normalize_search_key_joins_name_and_email() {
        assert_eq!(
            normalize_search_key(Some("Łukasz Nowak"), "L.Nowak@firma.pl"),
            "lukasz nowak l.nowak@firma.pl"
        );
        assert_eq!(normalize_search_key(None, "a@b.pl"), "a@b.pl");
        assert_eq!(normalize_search_key(Some("   "), "a@b.pl"), "a@b.pl");
    }

    #[test]
    fn upsert_inserts_lowercased_contact_with_count_one() {
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db, "me@example.com");

        upsert_contact(&db, account_id, "Jan@Firma.PL", Some("Jan Kowalski"), 5_000).unwrap();

        let (name, count, last, key) = stored(&db, "jan@firma.pl");
        assert_eq!(name.as_deref(), Some("Jan Kowalski"));
        assert_eq!(count, 1);
        assert_eq!(last, 5_000);
        assert_eq!(key, "jan kowalski jan@firma.pl");
    }

    #[test]
    fn upsert_increments_count_and_keeps_latest_date() {
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db, "me@example.com");

        upsert_contact(&db, account_id, "jan@firma.pl", Some("Jan"), 9_000).unwrap();
        upsert_contact(&db, account_id, "jan@firma.pl", Some("Jan"), 1_000).unwrap();

        let (_, count, last, _) = stored(&db, "jan@firma.pl");
        assert_eq!(count, 2);
        assert_eq!(last, 9_000);
    }

    #[test]
    fn upsert_learns_a_name_later_and_never_clears_a_known_one() {
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db, "me@example.com");

        upsert_contact(&db, account_id, "jan@firma.pl", None, 1_000).unwrap();
        let (name, _, _, key) = stored(&db, "jan@firma.pl");
        assert_eq!(name, None);
        assert_eq!(key, "jan@firma.pl");

        upsert_contact(&db, account_id, "jan@firma.pl", Some("Jan Kowalski"), 2_000).unwrap();
        let (name, _, _, key) = stored(&db, "jan@firma.pl");
        assert_eq!(name.as_deref(), Some("Jan Kowalski"));
        assert_eq!(key, "jan kowalski jan@firma.pl");

        upsert_contact(&db, account_id, "jan@firma.pl", None, 3_000).unwrap();
        let (name, _, _, key) = stored(&db, "jan@firma.pl");
        assert_eq!(name.as_deref(), Some("Jan Kowalski"));
        assert_eq!(key, "jan kowalski jan@firma.pl");
    }

    #[test]
    fn upsert_skips_malformed_addresses() {
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db, "me@example.com");

        for bad in ["", "  ", "nodomain", "@firma.pl", "jan@", "jan kowalski@firma.pl"] {
            upsert_contact(&db, account_id, bad, None, 1_000).unwrap();
        }

        let conn = db.conn();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM contacts_cache", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
```

Register the module in `crates/am-storage/src/lib.rs`, keeping the list
alphabetical — insert `pub mod contacts_repo;` between `pub mod attachments_repo;`
and `pub mod drafts_repo;`.

- [ ] **Step 5: Run the tests to verify they fail**

Run: `cargo test -p am-storage contacts_repo`
Expected: FAIL to compile — `fold_text`, `normalize_search_key` and
`upsert_contact` are not defined.

- [ ] **Step 6: Write the implementation**

Prepend to `crates/am-storage/src/contacts_repo.rs`, above the test module:

```rust
use rusqlite::params;

use crate::db::{Database, StorageError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContactSuggestion {
    pub email: String,
    pub name: Option<String>,
    pub exchange_count: i64,
    pub last_contact_at: i64,
}

fn fold_char(c: char) -> char {
    match c {
        'ą' => 'a',
        'ć' => 'c',
        'ę' => 'e',
        'ł' => 'l',
        'ń' => 'n',
        'ó' => 'o',
        'ś' => 's',
        'ż' | 'ź' => 'z',
        'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' => 'a',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'í' | 'ì' | 'î' | 'ï' => 'i',
        'ò' | 'ô' | 'ö' | 'õ' => 'o',
        'ú' | 'ù' | 'û' | 'ü' => 'u',
        'ç' => 'c',
        'ñ' => 'n',
        'ý' | 'ÿ' => 'y',
        other => other,
    }
}

pub fn fold_text(input: &str) -> String {
    let lowered = input.to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    for c in lowered.chars() {
        if c == 'ß' {
            out.push_str("ss");
        } else {
            out.push(fold_char(c));
        }
    }
    out
}

pub fn normalize_search_key(name: Option<&str>, email: &str) -> String {
    let name = name.map(str::trim).filter(|n| !n.is_empty());
    let email = email.trim();
    match name {
        Some(name) => fold_text(&format!("{name} {email}")),
        None => fold_text(email),
    }
}

fn is_valid_address(email: &str) -> bool {
    if email.contains(char::is_whitespace) {
        return false;
    }
    match email.find('@') {
        Some(at) => at > 0 && at + 1 < email.len(),
        None => false,
    }
}

pub fn upsert_contact(
    db: &Database,
    account_id: i64,
    email: &str,
    name: Option<&str>,
    contacted_at: i64,
) -> Result<(), StorageError> {
    let email = email.trim().to_lowercase();
    if !is_valid_address(&email) {
        return Ok(());
    }
    let name = name.map(str::trim).filter(|n| !n.is_empty());
    let search_key = normalize_search_key(name, &email);

    let conn = db.conn();
    conn.execute(
        "INSERT INTO contacts_cache (account_id, email, name, exchange_count, last_contact_at, search_key)
         VALUES (?1, ?2, ?3, 1, ?4, ?5)
         ON CONFLICT(account_id, email) DO UPDATE SET
             exchange_count = contacts_cache.exchange_count + 1,
             last_contact_at = max(contacts_cache.last_contact_at, excluded.last_contact_at),
             name = COALESCE(excluded.name, contacts_cache.name),
             search_key = CASE
                 WHEN excluded.name IS NULL AND contacts_cache.name IS NOT NULL
                 THEN contacts_cache.search_key
                 ELSE excluded.search_key
             END",
        params![account_id, email, name, contacted_at, search_key],
    )?;
    Ok(())
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cargo test -p am-storage contacts_repo`
Expected: PASS, 5 tests.

- [ ] **Step 8: Commit**

```bash
git add crates/am-storage/src/migrations/V18__contacts.sql \
        crates/am-storage/src/contacts_repo.rs \
        crates/am-storage/src/lib.rs \
        crates/am-storage/src/db.rs
git commit -m "feat(contacts): add contact index schema and upsert"
```

---

### Task 2: Suggestion query and ranking

**Files:**
- Modify: `crates/am-storage/src/contacts_repo.rs`
- Test: `crates/am-storage/src/contacts_repo.rs` (inline test module)

**Interfaces:**
- Consumes: `upsert_contact`, `fold_text`, `ContactSuggestion` from Task 1.
- Produces:
  `pub fn suggest(db: &Database, query: &str, account_id: Option<i64>, limit: u32, now: i64) -> Result<Vec<ContactSuggestion>, StorageError>`

- [ ] **Step 1: Write the failing tests**

Append inside the existing `mod tests` in
`crates/am-storage/src/contacts_repo.rs`:

```rust
    const NOW: i64 = 1_800_000_000;
    const DAY: i64 = 86_400;

    #[test]
    fn suggest_returns_nothing_for_an_empty_query() {
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db, "me@example.com");
        upsert_contact(&db, account_id, "jan@firma.pl", None, NOW).unwrap();

        assert!(suggest(&db, "", None, 8, NOW).unwrap().is_empty());
        assert!(suggest(&db, "   ", None, 8, NOW).unwrap().is_empty());
    }

    #[test]
    fn suggest_matches_name_and_address_ignoring_diacritics() {
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db, "me@example.com");
        upsert_contact(&db, account_id, "l.nowak@firma.pl", Some("Łukasz Nowak"), NOW).unwrap();

        assert_eq!(suggest(&db, "lukasz", None, 8, NOW).unwrap().len(), 1);
        assert_eq!(suggest(&db, "ŁUKASZ", None, 8, NOW).unwrap().len(), 1);
        assert_eq!(suggest(&db, "nowak@fir", None, 8, NOW).unwrap().len(), 1);
        assert!(suggest(&db, "kowalski", None, 8, NOW).unwrap().is_empty());
    }

    #[test]
    fn suggest_merges_the_same_address_across_accounts() {
        let db = Database::open_in_memory().unwrap();
        let work = seed_account(&db, "work@example.com");
        let home = seed_account(&db, "home@example.com");
        upsert_contact(&db, work, "jan@firma.pl", None, NOW).unwrap();
        upsert_contact(&db, home, "jan@firma.pl", Some("Jan Kowalski"), NOW).unwrap();

        let found = suggest(&db, "jan", None, 8, NOW).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name.as_deref(), Some("Jan Kowalski"));
        assert_eq!(found[0].exchange_count, 2);
    }

    #[test]
    fn suggest_ranks_the_sending_account_first() {
        let db = Database::open_in_memory().unwrap();
        let work = seed_account(&db, "work@example.com");
        let home = seed_account(&db, "home@example.com");
        upsert_contact(&db, home, "anna@dom.pl", None, NOW).unwrap();
        upsert_contact(&db, home, "anna@dom.pl", None, NOW).unwrap();
        upsert_contact(&db, work, "anna@praca.pl", None, NOW).unwrap();

        let found = suggest(&db, "anna", Some(work), 8, NOW).unwrap();
        assert_eq!(found[0].email, "anna@praca.pl");
    }

    #[test]
    fn suggest_ranks_prefix_matches_before_infix_matches() {
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db, "me@example.com");
        upsert_contact(&db, account_id, "biuro@nowak.pl", None, NOW).unwrap();
        upsert_contact(&db, account_id, "biuro@nowak.pl", None, NOW).unwrap();
        upsert_contact(&db, account_id, "nowak@firma.pl", None, NOW).unwrap();

        let found = suggest(&db, "nowak", None, 8, NOW).unwrap();
        assert_eq!(found[0].email, "nowak@firma.pl");
    }

    #[test]
    fn suggest_ranks_recent_contacts_before_frequent_stale_ones() {
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db, "me@example.com");
        for _ in 0..10 {
            upsert_contact(&db, account_id, "stale@firma.pl", None, NOW - 400 * DAY).unwrap();
        }
        upsert_contact(&db, account_id, "fresh@firma.pl", None, NOW - DAY).unwrap();

        let found = suggest(&db, "firma", None, 8, NOW).unwrap();
        assert_eq!(found[0].email, "fresh@firma.pl");
    }

    #[test]
    fn suggest_breaks_ties_within_a_bucket_by_exchange_count() {
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db, "me@example.com");
        upsert_contact(&db, account_id, "rare@firma.pl", None, NOW - DAY).unwrap();
        for _ in 0..3 {
            upsert_contact(&db, account_id, "often@firma.pl", None, NOW - 2 * DAY).unwrap();
        }

        let found = suggest(&db, "firma", None, 8, NOW).unwrap();
        assert_eq!(found[0].email, "often@firma.pl");
    }

    #[test]
    fn suggest_treats_wildcards_as_literal_text_and_honours_the_limit() {
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db, "me@example.com");
        upsert_contact(&db, account_id, "a@firma.pl", None, NOW).unwrap();
        upsert_contact(&db, account_id, "b@firma.pl", None, NOW).unwrap();

        assert!(suggest(&db, "%", None, 8, NOW).unwrap().is_empty());
        assert!(suggest(&db, "_", None, 8, NOW).unwrap().is_empty());
        assert_eq!(suggest(&db, "firma", None, 1, NOW).unwrap().len(), 1);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p am-storage contacts_repo`
Expected: FAIL to compile — `suggest` is not defined.

- [ ] **Step 3: Write the implementation**

Append to the non-test part of `crates/am-storage/src/contacts_repo.rs`:

```rust
const RECENT_WINDOW_SECS: i64 = 30 * 86_400;
const STALE_WINDOW_SECS: i64 = 365 * 86_400;

fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

pub fn suggest(
    db: &Database,
    query: &str,
    account_id: Option<i64>,
    limit: u32,
    now: i64,
) -> Result<Vec<ContactSuggestion>, StorageError> {
    let normalized = fold_text(query.trim());
    if normalized.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = escape_like(&normalized);

    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT email,
                MAX(name) AS name,
                SUM(exchange_count) AS exchange_count,
                MAX(last_contact_at) AS last_contact_at
         FROM contacts_cache
         WHERE search_key LIKE '%' || ?1 || '%' ESCAPE '\\'
         GROUP BY email
         ORDER BY MAX(CASE WHEN account_id = ?2 THEN 1 ELSE 0 END) DESC,
                  MAX(CASE WHEN search_key LIKE ?1 || '%' ESCAPE '\\'
                             OR email LIKE ?1 || '%' ESCAPE '\\'
                           THEN 1 ELSE 0 END) DESC,
                  MAX(CASE WHEN last_contact_at >= ?3 THEN 2
                           WHEN last_contact_at >= ?4 THEN 1
                           ELSE 0 END) DESC,
                  SUM(exchange_count) DESC,
                  MAX(last_contact_at) DESC
         LIMIT ?5",
    )?;
    let rows = stmt
        .query_map(
            params![
                pattern,
                account_id.unwrap_or(-1),
                now - RECENT_WINDOW_SECS,
                now - STALE_WINDOW_SECS,
                limit
            ],
            |r| {
                Ok(ContactSuggestion {
                    email: r.get(0)?,
                    name: r.get(1)?,
                    exchange_count: r.get(2)?,
                    last_contact_at: r.get(3)?,
                })
            },
        )?
        .collect::<Result<Vec<_>, rusqlite::Error>>()?;
    Ok(rows)
}
```

Note: `"ESCAPE '\\'"` in a Rust string literal produces `ESCAPE '\'` in SQL,
which is what SQLite expects.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p am-storage contacts_repo`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add crates/am-storage/src/contacts_repo.rs
git commit -m "feat(contacts): rank suggestions by account, prefix, recency and frequency"
```

---

### Task 3: Backfill from the local database

**Files:**
- Create: `crates/am-storage/src/migrations/V19__contacts_backfill.sql`
- Modify: `crates/am-storage/src/maintenance.rs`
- Modify: `src-tauri/src/lib.rs:61` (call the new maintenance pass)
- Test: `crates/am-storage/src/maintenance.rs` (inline test module)

**Interfaces:**
- Consumes: `contacts_repo::normalize_search_key` (Task 1),
  `contacts_repo::suggest` (Task 2, used by the test).
- Produces: `pub fn fill_contact_search_keys(db: &Database) -> Result<usize, StorageError>`

- [ ] **Step 1: Write the backfill migration**

Create `crates/am-storage/src/migrations/V19__contacts_backfill.sql`:

```sql
INSERT INTO contacts_cache (account_id, email, name, exchange_count, last_contact_at, search_key)
SELECT f.account_id, lower(j.value), NULL, count(*), max(m.date), ''
FROM messages m
JOIN folders f ON f.id = m.folder_id AND f.folder_type = 'sent'
JOIN json_each(m.to_addresses) j
WHERE instr(j.value, '@') > 1
GROUP BY f.account_id, lower(j.value)
ON CONFLICT(account_id, email) DO UPDATE SET
    exchange_count = contacts_cache.exchange_count + excluded.exchange_count,
    last_contact_at = max(contacts_cache.last_contact_at, excluded.last_contact_at);

INSERT INTO contacts_cache (account_id, email, name, exchange_count, last_contact_at, search_key)
SELECT f.account_id, lower(j.value), NULL, count(*), max(m.date), ''
FROM messages m
JOIN folders f ON f.id = m.folder_id AND f.folder_type = 'sent'
JOIN json_each(m.cc_addresses) j
WHERE instr(j.value, '@') > 1
GROUP BY f.account_id, lower(j.value)
ON CONFLICT(account_id, email) DO UPDATE SET
    exchange_count = contacts_cache.exchange_count + excluded.exchange_count,
    last_contact_at = max(contacts_cache.last_contact_at, excluded.last_contact_at);

INSERT INTO contacts_cache (account_id, email, name, exchange_count, last_contact_at, search_key)
SELECT f.account_id, lower(m.from_address), max(m.from_name), count(*), max(m.date), ''
FROM messages m
JOIN folders f ON f.id = m.folder_id
WHERE m.answered = 1 AND instr(m.from_address, '@') > 1
GROUP BY f.account_id, lower(m.from_address)
ON CONFLICT(account_id, email) DO UPDATE SET
    exchange_count = contacts_cache.exchange_count + excluded.exchange_count,
    last_contact_at = max(contacts_cache.last_contact_at, excluded.last_contact_at),
    name = COALESCE(contacts_cache.name, excluded.name);
```

- [ ] **Step 2: Write the failing test**

Append to `crates/am-storage/src/maintenance.rs`, inside its `#[cfg(test)] mod tests`
(create the module at the end of the file if it does not exist, with
`use super::*;`):

```rust
    #[test]
    fn fill_contact_search_keys_indexes_backfilled_rows() {
        use crate::accounts_repo::insert_account;
        use crate::contacts_repo::suggest;
        use am_core::account::{NewAccount, ProviderType};

        let db = Database::open_in_memory().unwrap();
        let account = insert_account(
            &db,
            &NewAccount {
                email: "me@example.com".into(),
                display_name: "Me".into(),
                provider_type: ProviderType::ImapPassword,
                color: None,
            },
        )
        .unwrap();
        {
            let conn = db.conn();
            conn.execute(
                "INSERT INTO contacts_cache (account_id, email, name, exchange_count, last_contact_at, search_key)
                 VALUES (?1, 'l.nowak@firma.pl', 'Łukasz Nowak', 3, 1000, '')",
                rusqlite::params![account.id],
            )
            .unwrap();
        }

        assert!(suggest(&db, "lukasz", None, 8, 5_000).unwrap().is_empty());

        let filled = fill_contact_search_keys(&db).unwrap();
        assert_eq!(filled, 1);

        let found = suggest(&db, "lukasz", None, 8, 5_000).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].email, "l.nowak@firma.pl");

        assert_eq!(fill_contact_search_keys(&db).unwrap(), 0);
    }

    #[test]
    fn migration_v19_backfills_sent_recipients_and_answered_senders() {
        use crate::accounts_repo::insert_account;
        use crate::folders_repo::upsert_folder;
        use crate::messages_repo::{insert_headers, store_recipients};
        use am_core::account::{NewAccount, ProviderType};
        use am_core::folder::FolderType;
        use am_core::message::NewMessageHeader;

        let db = Database::open_in_memory().unwrap();
        let account = insert_account(
            &db,
            &NewAccount {
                email: "me@example.com".into(),
                display_name: "Me".into(),
                provider_type: ProviderType::ImapPassword,
                color: None,
            },
        )
        .unwrap();
        let sent = upsert_folder(&db, account.id, "Sent", "Sent", FolderType::Sent)
            .unwrap()
            .id;
        let inbox = upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox)
            .unwrap()
            .id;

        let header = |uid: i64, from: &str, answered: bool| NewMessageHeader {
            uid,
            message_id_hdr: None,
            in_reply_to: None,
            references_hdr: None,
            from_address: from.into(),
            from_name: Some("Sender".into()),
            subject: "S".into(),
            date: 1_000,
            seen: true,
            flagged: false,
            answered,
            has_attachments: false,
            size: 0,
            snippet: String::new(),
        };

        insert_headers(&db, sent, &[header(1, "me@example.com", false)]).unwrap();
        insert_headers(&db, inbox, &[header(2, "Anna@Dom.pl", true)]).unwrap();
        insert_headers(&db, inbox, &[header(3, "spam@ads.com", false)]).unwrap();

        let sent_msg = crate::messages_repo::ids_by_uids(&db, sent, &[1]).unwrap()[0];
        store_recipients(
            &db,
            sent_msg,
            &["Jan@Firma.PL".into()],
            &["biuro@firma.pl".into()],
        )
        .unwrap();

        {
            let conn = db.conn();
            conn.execute_batch(include_str!("migrations/V19__contacts_backfill.sql"))
                .unwrap();
        }
        fill_contact_search_keys(&db).unwrap();

        assert_eq!(
            crate::contacts_repo::suggest(&db, "jan@firma.pl", None, 8, 5_000)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            crate::contacts_repo::suggest(&db, "biuro@firma.pl", None, 8, 5_000)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            crate::contacts_repo::suggest(&db, "anna@dom.pl", None, 8, 5_000)
                .unwrap()
                .len(),
            1
        );
        assert!(crate::contacts_repo::suggest(&db, "spam@ads.com", None, 8, 5_000)
            .unwrap()
            .is_empty());
    }
```

Note on why the test replays the SQL by hand: `Database::open_in_memory()`
already ran V19 before the test inserted any messages, so at that point the
migration had nothing to backfill. `execute_batch` on the same file re-runs the
exact production SQL against the seeded data. This also proves the statements
are safely re-runnable, which the `ON CONFLICT` clauses are designed for.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p am-storage maintenance`
Expected: FAIL to compile — `fill_contact_search_keys` is not defined.

- [ ] **Step 4: Write the implementation**

Append to `crates/am-storage/src/maintenance.rs`:

```rust
pub fn fill_contact_search_keys(db: &Database) -> Result<usize, StorageError> {
    let rows = {
        let conn = db.conn();
        let mut stmt = conn.prepare(
            "SELECT id, email, name FROM contacts_cache WHERE search_key = ''",
        )?;
        stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, rusqlite::Error>>()?
    };

    let conn = db.conn();
    let mut updated = 0usize;
    for (id, email, name) in rows {
        let key = crate::contacts_repo::normalize_search_key(name.as_deref(), &email);
        conn.execute(
            "UPDATE contacts_cache SET search_key = ?2 WHERE id = ?1",
            params![id, key],
        )?;
        updated += 1;
    }
    Ok(updated)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p am-storage maintenance`
Expected: PASS.

- [ ] **Step 6: Call the pass at startup**

In `src-tauri/src/lib.rs`, directly after the existing
`am_storage::maintenance::redecode_legacy_headers(...)` call at line 61, add:

```rust
                let _ = am_storage::maintenance::fill_contact_search_keys(&db);
```

Match the surrounding error-handling style: read the two lines around line 61
first and mirror whatever they do with the `Result`.

- [ ] **Step 7: Verify the whole storage crate still builds and passes**

Run: `cargo test -p am-storage`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add crates/am-storage/src/migrations/V19__contacts_backfill.sql \
        crates/am-storage/src/maintenance.rs \
        src-tauri/src/lib.rs
git commit -m "feat(contacts): backfill the index from sent recipients and answered senders"
```

---

### Task 4: Carry To/Cc through the IMAP envelope

**Files:**
- Modify: `crates/am-protocols/src/imap.rs` (`FetchedHeader` at line 55,
  `map_header` at line 605, test module at line 700)
- Test: `crates/am-protocols/src/imap.rs` (inline test module)

**Interfaces:**
- Consumes: `async_imap::imap_proto::Address` (re-exported by async-imap 0.11),
  the existing `decode_bytes` helper at `crates/am-protocols/src/imap.rs:675`.
- Produces:
  - `pub struct EnvelopeAddress { pub address: String, pub name: Option<String> }`
  - `FetchedHeader.to: Vec<EnvelopeAddress>` and `FetchedHeader.cc: Vec<EnvelopeAddress>`

- [ ] **Step 1: Write the failing test**

Append inside `mod tests` in `crates/am-protocols/src/imap.rs`:

```rust
    #[test]
    fn envelope_addresses_builds_address_and_decodes_name() {
        use async_imap::imap_proto::Address;
        use std::borrow::Cow;

        let list = vec![
            Address {
                name: Some(Cow::Borrowed(b"=?UTF-8?Q?=C5=81ukasz?=".as_slice())),
                adl: None,
                mailbox: Some(Cow::Borrowed(b"l.nowak".as_slice())),
                host: Some(Cow::Borrowed(b"firma.pl".as_slice())),
            },
            Address {
                name: None,
                adl: None,
                mailbox: Some(Cow::Borrowed(b"biuro".as_slice())),
                host: Some(Cow::Borrowed(b"firma.pl".as_slice())),
            },
        ];

        let parsed = envelope_addresses(Some(&list));

        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].address, "l.nowak@firma.pl");
        assert_eq!(parsed[0].name.as_deref(), Some("Łukasz"));
        assert_eq!(parsed[1].address, "biuro@firma.pl");
        assert_eq!(parsed[1].name, None);
    }

    #[test]
    fn envelope_addresses_skips_entries_without_a_host() {
        use async_imap::imap_proto::Address;
        use std::borrow::Cow;

        let list = vec![Address {
            name: None,
            adl: None,
            mailbox: Some(Cow::Borrowed(b"undisclosed-recipients".as_slice())),
            host: None,
        }];

        assert!(envelope_addresses(Some(&list)).is_empty());
        assert!(envelope_addresses(None).is_empty());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p am-protocols envelope_addresses`
Expected: FAIL to compile — `envelope_addresses` is not defined.

- [ ] **Step 3: Write the implementation**

Add the struct next to `FetchedHeader` in `crates/am-protocols/src/imap.rs`:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvelopeAddress {
    pub address: String,
    pub name: Option<String>,
}
```

Add the two fields to `FetchedHeader`, after `from_name`:

```rust
    pub to: Vec<EnvelopeAddress>,
    pub cc: Vec<EnvelopeAddress>,
```

Add the helper next to `decode_bytes`:

```rust
fn envelope_addresses(
    list: Option<&Vec<async_imap::imap_proto::Address<'_>>>,
) -> Vec<EnvelopeAddress> {
    let Some(list) = list else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|addr| {
            let mailbox = addr.mailbox.as_ref().map(|s| decode_bytes(s))?;
            let host = addr.host.as_ref().map(|s| decode_bytes(s))?;
            if mailbox.is_empty() || host.is_empty() {
                return None;
            }
            Some(EnvelopeAddress {
                address: format!("{mailbox}@{host}"),
                name: addr
                    .name
                    .as_ref()
                    .map(|s| decode_bytes(s))
                    .filter(|n| !n.trim().is_empty()),
            })
        })
        .collect()
}
```

In `map_header`, after the `from_address` / `from_name` block, add:

```rust
    let to = envelope_addresses(envelope.and_then(|e| e.to.as_ref()));
    let cc = envelope_addresses(envelope.and_then(|e| e.cc.as_ref()));
```

and set `to` and `cc` in the returned `FetchedHeader` literal.

- [ ] **Step 4: Fix the existing FetchedHeader literals**

`FetchedHeader` is constructed in tests at `crates/am-sync/src/service.rs:1434`
and `:1459`. Add `to: Vec::new(), cc: Vec::new(),` to each.

Run: `cargo build --workspace`
Expected: builds. If any other literal is reported as missing fields, add the
same two lines there.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p am-protocols envelope_addresses`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add crates/am-protocols/src/imap.rs crates/am-sync/src/service.rs
git commit -m "feat(imap): expose envelope To and Cc addresses on fetched headers"
```

---

### Task 5: Harvest contacts during Sent-folder sync

**Files:**
- Create: `crates/am-sync/src/contacts.rs`
- Modify: `crates/am-sync/src/lib.rs` (add `pub mod contacts;`)
- Modify: `crates/am-sync/src/service.rs` (funnel the four `insert_headers`
  call sites at lines 354, 583, 599, 700 through one helper)
- Test: `crates/am-sync/src/contacts.rs` (inline test module)

**Interfaces:**
- Consumes: `am_protocols::imap::{EnvelopeAddress, FetchedHeader}` (Task 4),
  `am_storage::contacts_repo::upsert_contact` (Task 1),
  `am_core::folder::{Folder, FolderType}`.
- Produces:
  - `pub fn harvest_sent_headers(db: &Database, account_id: i64, fetched: &[FetchedHeader])`
  - `fn ingest_headers(db: &Database, folder: &Folder, fetched: &[FetchedHeader]) -> Result<usize, SyncError>`
    (private to `service.rs`)

- [ ] **Step 1: Write the failing test**

Create `crates/am-sync/src/contacts.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use am_core::account::{NewAccount, ProviderType};
    use am_protocols::imap::EnvelopeAddress;
    use am_storage::accounts_repo::insert_account;
    use am_storage::contacts_repo::suggest;

    fn header(uid: i64, to: Vec<EnvelopeAddress>, cc: Vec<EnvelopeAddress>) -> FetchedHeader {
        FetchedHeader {
            uid,
            message_id_hdr: None,
            from_address: "me@example.com".into(),
            from_name: None,
            to,
            cc,
            subject: "S".into(),
            date: 4_000,
            seen: true,
            flagged: false,
            answered: false,
            size: 0,
            in_reply_to: None,
            references: Vec::new(),
        }
    }

    fn address(addr: &str, name: Option<&str>) -> EnvelopeAddress {
        EnvelopeAddress {
            address: addr.into(),
            name: name.map(str::to_string),
        }
    }

    #[test]
    fn harvest_stores_to_and_cc_with_names() {
        let db = Database::open_in_memory().unwrap();
        let account = insert_account(
            &db,
            &NewAccount {
                email: "me@example.com".into(),
                display_name: "Me".into(),
                provider_type: ProviderType::ImapPassword,
                color: None,
            },
        )
        .unwrap();

        harvest_sent_headers(
            &db,
            account.id,
            &[header(
                1,
                vec![address("Jan@Firma.PL", Some("Jan Kowalski"))],
                vec![address("biuro@firma.pl", None)],
            )],
        );

        let found = suggest(&db, "jan", None, 8, 5_000).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].email, "jan@firma.pl");
        assert_eq!(found[0].name.as_deref(), Some("Jan Kowalski"));
        assert_eq!(found[0].last_contact_at, 4_000);

        assert_eq!(suggest(&db, "biuro", None, 8, 5_000).unwrap().len(), 1);
    }

    #[test]
    fn harvest_survives_a_malformed_address() {
        let db = Database::open_in_memory().unwrap();
        let account = insert_account(
            &db,
            &NewAccount {
                email: "me@example.com".into(),
                display_name: "Me".into(),
                provider_type: ProviderType::ImapPassword,
                color: None,
            },
        )
        .unwrap();

        harvest_sent_headers(
            &db,
            account.id,
            &[header(
                1,
                vec![address("broken", None), address("ok@firma.pl", None)],
                Vec::new(),
            )],
        );

        assert_eq!(suggest(&db, "ok@firma.pl", None, 8, 5_000).unwrap().len(), 1);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p am-sync harvest`
Expected: FAIL to compile — module not registered, `harvest_sent_headers`
missing.

- [ ] **Step 3: Write the implementation**

Prepend to `crates/am-sync/src/contacts.rs`:

```rust
use am_protocols::imap::FetchedHeader;
use am_storage::{contacts_repo, Database};

pub fn harvest_sent_headers(db: &Database, account_id: i64, fetched: &[FetchedHeader]) {
    for header in fetched {
        for addr in header.to.iter().chain(header.cc.iter()) {
            if let Err(e) = contacts_repo::upsert_contact(
                db,
                account_id,
                &addr.address,
                addr.name.as_deref(),
                header.date,
            ) {
                eprintln!("contact upsert failed ({}): {e}", addr.address);
            }
        }
    }
}
```

Register the module in `crates/am-sync/src/lib.rs` alongside the existing
`pub mod` entries.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p am-sync harvest`
Expected: PASS, 2 tests.

- [ ] **Step 5: Funnel the header ingestion sites**

Add to `crates/am-sync/src/service.rs`, next to `header_from_fetch`:

```rust
fn ingest_headers(
    db: &Database,
    folder: &am_core::folder::Folder,
    fetched: &[FetchedHeader],
) -> Result<usize, SyncError> {
    let headers: Vec<NewMessageHeader> = fetched.iter().map(header_from_fetch).collect();
    let inserted = messages_repo::insert_headers(db, folder.id, &headers)?;
    if folder.folder_type == am_core::folder::FolderType::Sent {
        crate::contacts::harvest_sent_headers(db, folder.account_id, fetched);
    }
    Ok(inserted)
}
```

Replace these four sites, each of which currently maps `fetched` into `headers`
and calls `messages_repo::insert_headers`:

1. `sync_folder` (around line 352-354) — has `folder` in scope.
2. `incremental_sync_folder`, uidvalidity-reset branch (around line 581-583) —
   has `folder` in scope; it returns `headers.len()`, so capture the result of
   `ingest_headers` into a local and return that.
3. `incremental_sync_folder`, new-uids branch (around line 597-599).
4. `run_prefetch_batch`, backfill branch (around line 698-700).

Each becomes:

```rust
        let inserted = ingest_headers(db, &folder, &fetched)?;
```

with the surrounding `let headers: Vec<NewMessageHeader> = ...` line deleted.
Where the old code used `headers.len()`, use `inserted`.

- [ ] **Step 6: Verify the crate builds and its tests pass**

Run: `cargo test -p am-sync`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/am-sync/src/contacts.rs crates/am-sync/src/lib.rs crates/am-sync/src/service.rs
git commit -m "feat(contacts): harvest recipients while syncing sent folders"
```

---

### Task 6: Record contacts on a successful local send

**Files:**
- Modify: `crates/am-sync/src/contacts.rs`
- Modify: `crates/am-sync/src/send.rs` (the `Ok(())` arm at line 224)
- Test: `crates/am-sync/src/contacts.rs` (inline test module)

**Interfaces:**
- Consumes: `am_core::outgoing::OutgoingMessage` (fields `to`, `cc`, `bcc`,
  all `Vec<String>`), `contacts_repo::upsert_contact`.
- Produces: `pub fn record_sent_message(db: &Database, account_id: i64, msg: &OutgoingMessage, now: i64)`

- [ ] **Step 1: Write the failing test**

Append inside `mod tests` in `crates/am-sync/src/contacts.rs`:

```rust
    #[test]
    fn record_sent_message_stores_every_recipient_class() {
        use am_core::outgoing::OutgoingMessage;

        let db = Database::open_in_memory().unwrap();
        let account = insert_account(
            &db,
            &NewAccount {
                email: "me@example.com".into(),
                display_name: "Me".into(),
                provider_type: ProviderType::ImapPassword,
                color: None,
            },
        )
        .unwrap();

        let msg = OutgoingMessage {
            from_address: "me@example.com".into(),
            from_name: None,
            to: vec!["Jan@Firma.PL".into()],
            cc: vec!["biuro@firma.pl".into()],
            bcc: vec!["ukryty@firma.pl".into()],
            subject: "S".into(),
            text_body: String::new(),
            html_body: None,
            in_reply_to: None,
            references: Vec::new(),
            attachments: Vec::new(),
        };

        record_sent_message(&db, account.id, &msg, 7_000);

        for email in ["jan@firma.pl", "biuro@firma.pl", "ukryty@firma.pl"] {
            let found = suggest(&db, email, None, 8, 9_000).unwrap();
            assert_eq!(found.len(), 1, "{email} should be suggested");
            assert_eq!(found[0].last_contact_at, 7_000);
        }
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p am-sync record_sent_message`
Expected: FAIL to compile — `record_sent_message` is not defined.

- [ ] **Step 3: Write the implementation**

Append to the non-test part of `crates/am-sync/src/contacts.rs`:

```rust
use am_core::outgoing::OutgoingMessage;

pub fn record_sent_message(db: &Database, account_id: i64, msg: &OutgoingMessage, now: i64) {
    for address in msg.to.iter().chain(msg.cc.iter()).chain(msg.bcc.iter()) {
        if let Err(e) = contacts_repo::upsert_contact(db, account_id, address, None, now) {
            eprintln!("contact upsert failed ({address}): {e}");
        }
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p am-sync record_sent_message`
Expected: PASS.

- [ ] **Step 5: Wire it into the send path**

In `crates/am-sync/src/send.rs`, inside the `Ok(())` arm, immediately after
`sink.emit(SyncEvent::SendSucceeded { account_id });` (line 226), add:

```rust
                crate::contacts::record_sent_message(db, account_id, &msg, now_secs());
```

`now_secs` is already imported in this file (it is used by
`handle_send_failure`); if it is not, use `crate::service::now_secs()`.

- [ ] **Step 6: Verify the crate builds and its tests pass**

Run: `cargo test -p am-sync`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/am-sync/src/contacts.rs crates/am-sync/src/send.rs
git commit -m "feat(contacts): record recipients immediately after a successful send"
```

---

### Task 7: One-time envelope re-scan of Sent folders

**Files:**
- Modify: `crates/am-sync/src/contacts.rs` (cursor helpers)
- Modify: `crates/am-sync/src/service.rs` (`run_contacts_backfill_batch`)
- Modify: `crates/am-sync/src/engine.rs` (`spawn_prefetch` loop, line 198-224)
- Test: `crates/am-sync/src/contacts.rs` (inline test module)

**Interfaces:**
- Consumes: `ImapSession::{select, search_all_uids, fetch_headers_by_uids}`
  (`crates/am-protocols/src/imap.rs:340,350`),
  `am_storage::settings_repo::{get_setting, set_setting}`,
  `harvest_sent_headers` (Task 5).
- Produces:
  - `pub fn contacts_cursor_key(folder_id: i64) -> String`
  - `pub fn next_backfill_uids(cursor: Option<&str>, server_uids: &[i64], batch: usize) -> Vec<i64>`
  - `pub async fn run_contacts_backfill_batch(db: &Database, account_id: i64, creds: &dyn CredentialSource) -> Result<bool, SyncError>`

- [ ] **Step 1: Write the failing test for the cursor logic**

Append inside `mod tests` in `crates/am-sync/src/contacts.rs`:

```rust
    #[test]
    fn contacts_cursor_key_is_per_folder() {
        assert_eq!(contacts_cursor_key(12), "contacts.backfill.12");
    }

    #[test]
    fn next_backfill_uids_starts_from_the_highest_uid() {
        let uids = vec![1, 2, 3, 4, 5];
        assert_eq!(next_backfill_uids(None, &uids, 2), vec![5, 4]);
    }

    #[test]
    fn next_backfill_uids_resumes_below_the_cursor() {
        let uids = vec![1, 2, 3, 4, 5];
        assert_eq!(next_backfill_uids(Some("4"), &uids, 2), vec![3, 2]);
    }

    #[test]
    fn next_backfill_uids_is_empty_when_done_or_exhausted() {
        let uids = vec![1, 2, 3];
        assert!(next_backfill_uids(Some("done"), &uids, 10).is_empty());
        assert!(next_backfill_uids(Some("1"), &uids, 10).is_empty());
        assert!(next_backfill_uids(None, &[], 10).is_empty());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p am-sync backfill_uids`
Expected: FAIL to compile — helpers not defined.

- [ ] **Step 3: Write the cursor helpers**

Append to the non-test part of `crates/am-sync/src/contacts.rs`:

```rust
pub const CONTACTS_BACKFILL_BATCH: usize = 500;
pub const CONTACTS_BACKFILL_DONE: &str = "done";

pub fn contacts_cursor_key(folder_id: i64) -> String {
    format!("contacts.backfill.{folder_id}")
}

pub fn next_backfill_uids(cursor: Option<&str>, server_uids: &[i64], batch: usize) -> Vec<i64> {
    if cursor == Some(CONTACTS_BACKFILL_DONE) {
        return Vec::new();
    }
    let ceiling = cursor.and_then(|c| c.parse::<i64>().ok());
    let mut pending: Vec<i64> = server_uids
        .iter()
        .copied()
        .filter(|uid| ceiling.is_none_or(|c| *uid < c))
        .collect();
    pending.sort_unstable_by(|a, b| b.cmp(a));
    pending.truncate(batch);
    pending
}
```

If the toolchain rejects `is_none_or`, use
`ceiling.map_or(true, |c| *uid < c)` instead.

Descending order means the newest mail is indexed first, so suggestions are
useful before the pass finishes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p am-sync backfill_uids`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the batch runner**

Append to `crates/am-sync/src/service.rs`:

```rust
pub async fn run_contacts_backfill_batch(
    db: &Database,
    account_id: i64,
    creds: &dyn CredentialSource,
) -> Result<bool, SyncError> {
    use crate::contacts::{
        contacts_cursor_key, next_backfill_uids, CONTACTS_BACKFILL_BATCH, CONTACTS_BACKFILL_DONE,
    };

    let pending: Vec<_> = folders_repo::list_folders(db, account_id)?
        .into_iter()
        .filter(|f| f.folder_type == am_core::folder::FolderType::Sent)
        .filter(|f| {
            am_storage::settings_repo::get_setting(db, &contacts_cursor_key(f.id))
                .ok()
                .flatten()
                .as_deref()
                != Some(CONTACTS_BACKFILL_DONE)
        })
        .collect();
    if pending.is_empty() {
        return Ok(false);
    }

    let account = accounts_repo::get_account(db, account_id)?;
    let endpoints = load_endpoints(db, account_id)?;
    let auth = creds.auth_for(&account).await?;
    let config = imap_config(&endpoints, &account.email);
    let mut session = ImapSession::connect(&config, &auth.to_imap()).await?;

    let mut did_work = false;
    for folder in pending {
        if session.select(&folder.remote_path).await.is_err() {
            continue;
        }
        let server_uids = session.search_all_uids().await?;
        let cursor = am_storage::settings_repo::get_setting(db, &contacts_cursor_key(folder.id))?;
        let batch = next_backfill_uids(cursor.as_deref(), &server_uids, CONTACTS_BACKFILL_BATCH);
        if batch.is_empty() {
            am_storage::settings_repo::set_setting(
                db,
                &contacts_cursor_key(folder.id),
                CONTACTS_BACKFILL_DONE,
            )?;
            continue;
        }

        let fetched = session.fetch_headers_by_uids(&batch).await?;
        crate::contacts::harvest_sent_headers(db, account_id, &fetched);
        let lowest = batch.iter().copied().min().unwrap_or(0);
        am_storage::settings_repo::set_setting(
            db,
            &contacts_cursor_key(folder.id),
            &lowest.to_string(),
        )?;
        did_work = true;
    }

    let _ = session.logout().await;
    Ok(did_work)
}
```

- [ ] **Step 6: Wire it into the prefetch worker**

In `crates/am-sync/src/engine.rs`, inside `spawn_prefetch`'s loop, replace the
`let did_work = match service::run_prefetch_batch(...)` block with:

```rust
                let contacts_worked =
                    match service::run_contacts_backfill_batch(&db, account_id, creds.as_ref()).await {
                        Ok(worked) => worked,
                        Err(_) => false,
                    };
                let prefetch_worked = match service::run_prefetch_batch(&db, account_id, creds.as_ref(), sink.as_ref()).await {
                    Ok(worked) => worked,
                    Err(service::SyncError::NeedsReauth) => {
                        let _ = am_storage::accounts_repo::set_requires_reauth(&db, account_id, true);
                        sink.emit(crate::events::SyncEvent::AuthChanged { account_id, requires_reauth: true });
                        return;
                    }
                    Err(_) => false,
                };
                let did_work = contacts_worked || prefetch_worked;
```

The contacts pass swallows `NeedsReauth` deliberately: prefetch runs right after
and already handles reauth, and a contact backfill must never be the thing that
flags an account as broken.

- [ ] **Step 7: Verify the crate builds and its tests pass**

Run: `cargo test -p am-sync`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add crates/am-sync/src/contacts.rs crates/am-sync/src/service.rs crates/am-sync/src/engine.rs
git commit -m "feat(contacts): backfill sent-folder history with an envelope-only rescan"
```

---

### Task 8: Expose suggest_contacts to the frontend

**Files:**
- Modify: `crates/am-app/src/commands.rs`
- Modify: `crates/am-app/src/lib.rs` (`collect_commands!`)
- Modify: `src/ipc/bindings.ts` (generated — do not hand-edit)
- Test: `crates/am-app/src/commands.rs` is not unit-tested; verification is the
  generated binding plus `cargo build`.

**Interfaces:**
- Consumes: `am_storage::contacts_repo::suggest` (Task 2),
  `am_sync::service::now_secs`.
- Produces:
  - Rust: `pub struct ContactSuggestion { email, name, exchange_count, last_contact_at }`
  - TypeScript: `commands.suggestContacts(query: string, accountId: number | null, limit: number)`
    returning `Result<ContactSuggestion[], string>` where
    `ContactSuggestion = { email: string, name: string | null, exchange_count: number, last_contact_at: number }`

- [ ] **Step 1: Write the command**

Append to `crates/am-app/src/commands.rs`, next to `message_recipients`
(line 211-226) so it follows the same shape:

```rust
#[derive(serde::Serialize, serde::Deserialize, specta::Type)]
pub struct ContactSuggestion {
    pub email: String,
    pub name: Option<String>,
    pub exchange_count: i64,
    pub last_contact_at: i64,
}

#[tauri::command]
#[specta::specta]
pub fn suggest_contacts(
    state: tauri::State<'_, AppState>,
    query: String,
    account_id: Option<i64>,
    limit: u32,
) -> Result<Vec<ContactSuggestion>, String> {
    let found = am_storage::contacts_repo::suggest(
        &state.db,
        &query,
        account_id,
        limit.min(50),
        am_sync::service::now_secs(),
    )
    .map_err(|e| e.to_string())?;
    Ok(found
        .into_iter()
        .map(|c| ContactSuggestion {
            email: c.email,
            name: c.name,
            exchange_count: c.exchange_count,
            last_contact_at: c.last_contact_at,
        })
        .collect())
}
```

- [ ] **Step 2: Register the command**

In `crates/am-app/src/lib.rs`, add `commands::suggest_contacts,` to the
`collect_commands!` list, directly after `commands::message_recipients,`.

- [ ] **Step 3: Regenerate the bindings**

Run: `npm run gen:bindings`
Expected: `src/ipc/bindings.ts` gains `suggestContacts` and the
`ContactSuggestion` type.

- [ ] **Step 4: Verify the build**

Run: `cargo build --workspace && npx tsc --noEmit`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add crates/am-app/src/commands.rs crates/am-app/src/lib.rs src/ipc/bindings.ts
git commit -m "feat(contacts): add suggest_contacts command"
```

---

### Task 9: Suggestion query hook

**Files:**
- Modify: `src/ipc/queries.ts`
- Test: `src/ipc/queries.test.ts` — check whether this file exists first
  (`ls src/ipc`); if it does not, put the test in
  `src/features/composer/RecipientField.test.tsx` in Task 10 instead and skip
  steps 1-3 here.

**Interfaces:**
- Consumes: `commands.suggestContacts` (Task 8),
  `useDebouncedValue` (`src/shared/hooks/useDebouncedValue.ts`),
  the local `unwrap` helper in `queries.ts:23`.
- Produces: `export function useContactSuggestions(query: string, accountId: number | null)`
  returning a TanStack query whose `data` is `ContactSuggestion[]`.

- [ ] **Step 1: Write the hook**

Append to `src/ipc/queries.ts`, following the shape of `useThreadForMessage`
(line 54):

```ts
export function useContactSuggestions(query: string, accountId: number | null) {
  const debounced = useDebouncedValue(query, 120);
  return useQuery({
    queryKey: ["contact-suggestions", debounced, accountId],
    queryFn: () => commands.suggestContacts(debounced, accountId, 8).then(unwrap),
    enabled: debounced.trim().length > 0,
    placeholderData: keepPreviousData,
  });
}
```

Add the import at the top of the file:

```ts
import { useDebouncedValue } from "../shared/hooks/useDebouncedValue";
```

- [ ] **Step 2: Verify types**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/ipc/queries.ts
git commit -m "feat(composer): add contact suggestion query hook"
```

---

### Task 10: Recipient field dropdown

**Files:**
- Modify: `src/features/composer/RecipientField.tsx`
- Modify: `src/features/composer/Composer.tsx:378,393,394` (pass `accountId`)
- Modify: `src/features/composer/composer.css` (styles after `.recipient-input`
  at line 168)
- Create: `src/features/composer/RecipientField.test.tsx`

**Interfaces:**
- Consumes: `useContactSuggestions` (Task 9), `ContactSuggestion` type from
  `src/ipc/bindings` (Task 8).
- Produces: `RecipientField` props gain `accountId: number | null`.

- [ ] **Step 1: Write the failing tests**

Create `src/features/composer/RecipientField.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const suggestContacts = vi.fn();

vi.mock("../../ipc/bindings", () => ({
  commands: {
    suggestContacts: (...args: unknown[]) => suggestContacts(...args),
  },
  events: {},
}));

import { RecipientField } from "./RecipientField";

function ok(data: unknown) {
  return Promise.resolve({ status: "ok", data });
}

function renderField(recipients: string[] = [], onChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RecipientField label="To" recipients={recipients} onChange={onChange} accountId={7} />
    </QueryClientProvider>,
  );
  return { input: screen.getByLabelText("To"), onChange };
}

afterEach(() => {
  cleanup();
  suggestContacts.mockReset();
});

describe("RecipientField suggestions", () => {
  it("shows matching contacts with name and address", async () => {
    suggestContacts.mockReturnValue(
      ok([{ email: "jan@firma.pl", name: "Jan Kowalski", exchange_count: 3, last_contact_at: 1 }]),
    );
    const { input } = renderField();

    fireEvent.change(input, { target: { value: "jan" } });

    const option = await screen.findByRole("option");
    expect(option.textContent).toContain("Jan Kowalski");
    expect(option.textContent).toContain("jan@firma.pl");
  });

  it("adds only the bare address when a suggestion is chosen", async () => {
    suggestContacts.mockReturnValue(
      ok([{ email: "jan@firma.pl", name: "Jan Kowalski", exchange_count: 3, last_contact_at: 1 }]),
    );
    const { input, onChange } = renderField();

    fireEvent.change(input, { target: { value: "jan" } });
    await screen.findByRole("option");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith(["jan@firma.pl"]);
  });

  it("still adds a typed address that is not in the history", async () => {
    suggestContacts.mockReturnValue(ok([]));
    const { input, onChange } = renderField();

    fireEvent.change(input, { target: { value: "nowy@nikt.pl" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith(["nowy@nikt.pl"]);
  });

  it("hides contacts that are already chips", async () => {
    suggestContacts.mockReturnValue(
      ok([
        { email: "jan@firma.pl", name: null, exchange_count: 1, last_contact_at: 1 },
        { email: "biuro@firma.pl", name: null, exchange_count: 1, last_contact_at: 1 },
      ]),
    );
    const { input } = renderField(["jan@firma.pl"]);

    fireEvent.change(input, { target: { value: "firma" } });

    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("biuro@firma.pl");
  });

  it("closes the list on Escape without adding anything", async () => {
    suggestContacts.mockReturnValue(
      ok([{ email: "jan@firma.pl", name: null, exchange_count: 1, last_contact_at: 1 }]),
    );
    const { input, onChange } = renderField();

    fireEvent.change(input, { target: { value: "jan" } });
    await screen.findByRole("option");
    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("option")).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stays usable when the suggestion query fails", async () => {
    suggestContacts.mockReturnValue(Promise.resolve({ status: "error", error: "boom" }));
    const { input, onChange } = renderField();

    fireEvent.change(input, { target: { value: "jan" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith(["jan"]);
  });
});
```

Note: the assertions use `element.textContent` rather than
`toHaveTextContent`, because this repo does not install
`@testing-library/jest-dom`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/composer/RecipientField.test.tsx`
Expected: FAIL — `RecipientField` does not accept `accountId` and renders no
options.

- [ ] **Step 3: Rewrite the component**

Replace the whole of `src/features/composer/RecipientField.tsx`:

```tsx
import { useState, KeyboardEvent } from "react";
import { useContactSuggestions } from "../../ipc/queries";

type Props = {
  label: string;
  recipients: string[];
  onChange: (recipients: string[]) => void;
  accountId: number | null;
};

const MAX_SUGGESTIONS = 8;

export function RecipientField({ label, recipients, onChange, accountId }: Props) {
  const [inputValue, setInputValue] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dismissed, setDismissed] = useState(false);

  const { data: suggestions } = useContactSuggestions(dismissed ? "" : inputValue, accountId);
  const chosen = new Set(recipients.map((r) => r.trim().toLowerCase()));
  const visible = (suggestions ?? [])
    .filter((s) => !chosen.has(s.email))
    .slice(0, MAX_SUGGESTIONS);
  const isOpen = !dismissed && visible.length > 0;

  function addRecipient(value: string) {
    const trimmed = value.trim();
    if (trimmed && !recipients.includes(trimmed)) {
      onChange([...recipients, trimmed]);
    }
    setInputValue("");
    setActiveIndex(-1);
    setDismissed(false);
  }

  function removeRecipient(index: number) {
    onChange(recipients.filter((_, i) => i !== index));
  }

  function handleChange(value: string) {
    setInputValue(value);
    setActiveIndex(-1);
    setDismissed(false);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (isOpen && e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % visible.length);
      return;
    }
    if (isOpen && e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? visible.length - 1 : i - 1));
      return;
    }
    if (isOpen && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDismissed(true);
      setActiveIndex(-1);
      return;
    }
    if (e.key === "Enter" || e.key === "," || (e.key === "Tab" && activeIndex >= 0)) {
      if (isOpen && activeIndex >= 0) {
        e.preventDefault();
        addRecipient(visible[activeIndex].email);
        return;
      }
      if (e.key === "Tab") {
        return;
      }
      e.preventDefault();
      addRecipient(inputValue);
      return;
    }
    if (e.key === "Backspace" && inputValue === "" && recipients.length > 0) {
      removeRecipient(recipients.length - 1);
    }
  }

  function handleBlur() {
    if (inputValue.trim()) {
      addRecipient(inputValue);
    }
    setDismissed(true);
  }

  return (
    <div className="recipient-field">
      <span className="recipient-label">{label}</span>
      <div className="recipient-chips">
        {recipients.map((r, i) => (
          <span key={r} className="recipient-chip">
            {r}
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove ${r}`}
              onClick={() => removeRecipient(i)}
            >
              ×
            </button>
          </span>
        ))}
        <div className="recipient-input-wrap">
          <input
            type="text"
            className="recipient-input"
            aria-label={label}
            role="combobox"
            aria-expanded={isOpen}
            aria-autocomplete="list"
            value={inputValue}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            placeholder={recipients.length === 0 ? `Add ${label.toLowerCase()}...` : ""}
          />
          {isOpen && (
            <ul className="recipient-suggestions" role="listbox">
              {visible.map((s, i) => (
                <li
                  key={s.email}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={i === activeIndex ? "suggestion active" : "suggestion"}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addRecipient(s.email);
                  }}
                >
                  {s.name && <span className="suggestion-name">{s.name}</span>}
                  <span className="suggestion-email">{s.email}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
```

`onMouseDown` with `preventDefault` is deliberate: `onClick` would fire after
the input's `blur`, which commits the typed text and closes the list first.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/composer/RecipientField.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Pass the account through the composer**

In `src/features/composer/Composer.tsx`, add `accountId={fromAccountId}` to all
three `RecipientField` usages (lines 378, 393, 394). `fromAccountId` is already
in scope (declared at line 45).

- [ ] **Step 6: Style the dropdown**

Append to `src/features/composer/composer.css`, matching the existing custom
properties used by `.recipient-chip` (read lines 114-175 first and reuse the
same variables rather than inventing colors):

```css
.recipient-input-wrap {
  position: relative;
  flex: 1;
  min-width: 12rem;
}

.recipient-suggestions {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 40;
  margin: 0.25rem 0 0;
  padding: 0.25rem 0;
  list-style: none;
  min-width: 18rem;
  max-width: 100%;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.18);
}

.recipient-suggestions .suggestion {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.35rem 0.6rem;
  cursor: pointer;
}

.recipient-suggestions .suggestion.active {
  background: var(--surface-hover);
}

.suggestion-name {
  font-size: 0.85rem;
}

.suggestion-email {
  font-size: 0.78rem;
  opacity: 0.7;
}
```

If `--surface-raised`, `--surface-hover` or `--border` are not the names this
file uses, substitute the equivalents already present in `composer.css`.

- [ ] **Step 7: Run the composer test suite**

Run: `npx vitest run src/features/composer && npx tsc --noEmit`
Expected: PASS. `Composer.test.tsx` mocks `../../ipc/bindings`; if it fails
because `suggestContacts` is missing from the mock, add
`suggestContacts: vi.fn().mockResolvedValue({ status: "ok", data: [] }),` to
that mock's `commands` object.

- [ ] **Step 8: Commit**

```bash
git add src/features/composer/RecipientField.tsx \
        src/features/composer/RecipientField.test.tsx \
        src/features/composer/Composer.tsx \
        src/features/composer/Composer.test.tsx \
        src/features/composer/composer.css
git commit -m "feat(composer): suggest recipients from correspondence history"
```

---

### Task 11: Full verification

**Files:** none modified unless a failure is found.

- [ ] **Step 1: Run the Rust suite**

Run: `cargo test --workspace`
Expected: PASS.

- [ ] **Step 2: Run the frontend suite**

Run: `npx vitest run`
Expected: PASS except the 12 known pre-existing failures listed in Global
Constraints. Compare the failure list against that baseline; anything new is a
regression to fix before finishing.

- [ ] **Step 3: Type-check and build**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed.

- [ ] **Step 4: Manual smoke test**

Run: `npm run tauri dev`

Verify:
1. Open the composer, type three letters of somebody you have written to —
   suggestions appear.
2. `↓` then `Enter` adds a chip containing the bare address.
3. Typing a brand-new address and pressing `Enter` still adds it.
4. Send a message to a new address, then open a fresh composer and type its
   first letters — it is suggested immediately.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix(contacts): <what was wrong>"
```
