# Etap 7e — Rules & Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local per-account rules engine — conditions → actions — that runs automatically on new INBOX mail during sync and applies label / mark-read / flag / snooze actions.

**Architecture:** Pure matching logic + types in `am-core` (`rule_matches`), CRUD + JSON storage in `am-storage` (`rules_repo`, migration V10), the apply engine + sync hook in `am-sync` (`apply_rules_to_messages`), commands in `am-app`, and a `RulesSection` settings UI. Conditions/actions are stored as JSON columns. Rules run only on `folder_type = inbox` incremental new mail; the full/initial sync does not trigger them.

**Tech Stack:** Rust (rusqlite, serde_json, refinery), Tauri/specta IPC, React 19 + @tanstack/react-query + vitest.

## Global Constraints

- All code identifiers in English. NO comments in source files. (CLAUDE.md)
- Conventional Commits 1.0.0. Do NOT add a co-author. Do NOT push. (CLAUDE.md)
- Never `git add .` — stage explicit paths only.
- Local-only: no IMAP move/copy. Move-to-folder/archive is OUT of scope (deferred).
- Rules are per-account (`rules.account_id`), run only on `folder_type = inbox` incremental new mail.
- `rule_matches` returns `false` for a rule with zero conditions; the UI rejects saving a rule with zero conditions or zero actions.
- Snooze action value = hours (string); `wake_at = now + hours*3600`, fallback 24 when unparseable/≤0.
- Enum serde uses `#[serde(rename_all = "snake_case")]` (matches existing `FolderType`/`MessageFlag`). Frontend literals therefore are: ConditionField `from`/`subject`/`recipient`/`has_attachment`; ConditionOp `contains`/`is`; RuleActionKind `label`/`mark_read`/`flag`/`snooze`; MatchType `all`/`any`.
- After any Rust/IPC change: `npm run gen:bindings`. After any frontend task: `npx vitest run` AND `npm run build` (tsc typechecks test files; `noUnusedLocals` ON). New lucide icons → `src/test/lucide-stub.js`.
- Node 24 PATH: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`. Rust tests: `cargo test -p <crate>`.

---

### Task 1: am-core rule types + `rule_matches` + snooze helper

**Files:**
- Create: `crates/am-core/src/rule.rs`
- Modify: `crates/am-core/src/lib.rs` (add `pub mod rule;`)

**Interfaces:**
- Produces: enums `ConditionField`/`ConditionOp`/`RuleActionKind`/`MatchType`; structs `RuleCondition`/`RuleAction`/`Rule`/`RuleInput`/`RuleMessage`; `rule_matches(&Rule, &RuleMessage) -> bool`; `snooze_wake_at(now: i64, value: &str) -> i64`.

- [ ] **Step 1: Add the module declaration**

In `crates/am-core/src/lib.rs`, add `pub mod rule;` in alphabetical position (after `pub mod outgoing;` / before `pub mod search;`):

```rust
pub mod rule;
```

- [ ] **Step 2: Write the failing test (inside the new module file)**

Create `crates/am-core/src/rule.rs` with the types AND tests, but write the tests first conceptually — the full file in Step 3 includes this `#[cfg(test)]` module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn msg() -> RuleMessage {
        RuleMessage {
            from_address: "alice@work.com".into(),
            from_name: Some("Alice Smith".into()),
            subject: "Quarterly Report".into(),
            recipients: vec!["team@work.com".into(), "me@home.com".into()],
            has_attachments: true,
        }
    }

    fn rule(match_type: MatchType, conditions: Vec<RuleCondition>) -> Rule {
        Rule {
            id: 1, account_id: 1, name: "r".into(), enabled: true,
            match_type, conditions, actions: vec![], position: 0,
        }
    }

    fn cond(field: ConditionField, op: ConditionOp, value: &str) -> RuleCondition {
        RuleCondition { field, op, value: value.into() }
    }

    #[test]
    fn from_matches_address_and_name_case_insensitively() {
        assert!(rule_matches(&rule(MatchType::All, vec![cond(ConditionField::From, ConditionOp::Contains, "WORK.COM")]), &msg()));
        assert!(rule_matches(&rule(MatchType::All, vec![cond(ConditionField::From, ConditionOp::Contains, "alice smith")]), &msg()));
        assert!(!rule_matches(&rule(MatchType::All, vec![cond(ConditionField::From, ConditionOp::Is, "bob@work.com")]), &msg()));
    }

    #[test]
    fn subject_contains_and_is() {
        assert!(rule_matches(&rule(MatchType::All, vec![cond(ConditionField::Subject, ConditionOp::Contains, "report")]), &msg()));
        assert!(!rule_matches(&rule(MatchType::All, vec![cond(ConditionField::Subject, ConditionOp::Is, "report")]), &msg()));
        assert!(rule_matches(&rule(MatchType::All, vec![cond(ConditionField::Subject, ConditionOp::Is, "quarterly report")]), &msg()));
    }

    #[test]
    fn recipient_matches_any_of_to_or_cc() {
        assert!(rule_matches(&rule(MatchType::All, vec![cond(ConditionField::Recipient, ConditionOp::Contains, "home.com")]), &msg()));
        assert!(!rule_matches(&rule(MatchType::All, vec![cond(ConditionField::Recipient, ConditionOp::Contains, "nope.com")]), &msg()));
    }

    #[test]
    fn has_attachment_boolean() {
        assert!(rule_matches(&rule(MatchType::All, vec![cond(ConditionField::HasAttachment, ConditionOp::Is, "true")]), &msg()));
        assert!(!rule_matches(&rule(MatchType::All, vec![cond(ConditionField::HasAttachment, ConditionOp::Is, "false")]), &msg()));
    }

    #[test]
    fn all_requires_every_condition_any_requires_one() {
        let c = vec![
            cond(ConditionField::Subject, ConditionOp::Contains, "report"),
            cond(ConditionField::From, ConditionOp::Contains, "nobody"),
        ];
        assert!(!rule_matches(&rule(MatchType::All, c.clone()), &msg()));
        assert!(rule_matches(&rule(MatchType::Any, c), &msg()));
    }

    #[test]
    fn empty_conditions_never_match() {
        assert!(!rule_matches(&rule(MatchType::All, vec![]), &msg()));
        assert!(!rule_matches(&rule(MatchType::Any, vec![]), &msg()));
    }

    #[test]
    fn conditions_round_trip_through_json() {
        let conditions = vec![cond(ConditionField::From, ConditionOp::Is, "a@b.c")];
        let json = serde_json::to_string(&conditions).unwrap();
        let back: Vec<RuleCondition> = serde_json::from_str(&json).unwrap();
        assert_eq!(conditions, back);
    }

    #[test]
    fn action_kind_serializes_snake_case() {
        assert_eq!(serde_json::to_string(&RuleActionKind::MarkRead).unwrap(), "\"mark_read\"");
    }

    #[test]
    fn snooze_wake_at_uses_hours_with_fallback() {
        assert_eq!(snooze_wake_at(1000, "2"), 1000 + 2 * 3600);
        assert_eq!(snooze_wake_at(1000, "bad"), 1000 + 24 * 3600);
        assert_eq!(snooze_wake_at(1000, "0"), 1000 + 24 * 3600);
    }
}
```

- [ ] **Step 3: Write the full module**

Replace the contents of `crates/am-core/src/rule.rs` so the types precede the `#[cfg(test)]` block from Step 2:

```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConditionField {
    From,
    Subject,
    Recipient,
    HasAttachment,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConditionOp {
    Contains,
    Is,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct RuleCondition {
    pub field: ConditionField,
    pub op: ConditionOp,
    pub value: String,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuleActionKind {
    Label,
    MarkRead,
    Flag,
    Snooze,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct RuleAction {
    pub kind: RuleActionKind,
    pub value: String,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchType {
    All,
    Any,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct Rule {
    pub id: i64,
    pub account_id: i64,
    pub name: String,
    pub enabled: bool,
    pub match_type: MatchType,
    pub conditions: Vec<RuleCondition>,
    pub actions: Vec<RuleAction>,
    pub position: i64,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct RuleInput {
    pub name: String,
    pub enabled: bool,
    pub match_type: MatchType,
    pub conditions: Vec<RuleCondition>,
    pub actions: Vec<RuleAction>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RuleMessage {
    pub from_address: String,
    pub from_name: Option<String>,
    pub subject: String,
    pub recipients: Vec<String>,
    pub has_attachments: bool,
}

fn text_matches(op: ConditionOp, haystack: &str, needle: &str) -> bool {
    let h = haystack.to_lowercase();
    let n = needle.to_lowercase();
    match op {
        ConditionOp::Contains => h.contains(&n),
        ConditionOp::Is => h == n,
    }
}

fn condition_matches(cond: &RuleCondition, msg: &RuleMessage) -> bool {
    match cond.field {
        ConditionField::From => {
            text_matches(cond.op, &msg.from_address, &cond.value)
                || msg
                    .from_name
                    .as_deref()
                    .map(|name| text_matches(cond.op, name, &cond.value))
                    .unwrap_or(false)
        }
        ConditionField::Subject => text_matches(cond.op, &msg.subject, &cond.value),
        ConditionField::Recipient => msg
            .recipients
            .iter()
            .any(|r| text_matches(cond.op, r, &cond.value)),
        ConditionField::HasAttachment => {
            let want = cond.value.eq_ignore_ascii_case("true");
            msg.has_attachments == want
        }
    }
}

pub fn rule_matches(rule: &Rule, msg: &RuleMessage) -> bool {
    if rule.conditions.is_empty() {
        return false;
    }
    match rule.match_type {
        MatchType::All => rule.conditions.iter().all(|c| condition_matches(c, msg)),
        MatchType::Any => rule.conditions.iter().any(|c| condition_matches(c, msg)),
    }
}

pub fn snooze_wake_at(now: i64, value: &str) -> i64 {
    let hours = value
        .trim()
        .parse::<i64>()
        .ok()
        .filter(|h| *h > 0)
        .unwrap_or(24);
    now + hours * 3600
}
```

(append the `#[cfg(test)] mod tests { ... }` block from Step 2 at the end.)

- [ ] **Step 4: Run the tests**

Run: `cargo test -p am-core rule`
Expected: all rule tests PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/am-core/src/rule.rs crates/am-core/src/lib.rs
git commit -m "feat(rules): am-core rule types and matching predicate"
```

---

### Task 2: V10 migration + `rules_repo` + message helpers

**Files:**
- Create: `crates/am-storage/src/migrations/V10__rules.sql`
- Create: `crates/am-storage/src/rules_repo.rs`
- Modify: `crates/am-storage/src/lib.rs` (add `pub mod rules_repo;`)
- Modify: `crates/am-storage/src/messages_repo.rs` (add `ids_by_uids` + `rule_message`)

**Interfaces:**
- Consumes: `am_core::rule::{Rule, RuleInput, RuleCondition, RuleAction, MatchType, RuleMessage}`.
- Produces: `rules_repo::{list_rules, create_rule, update_rule, set_rule_enabled, delete_rule}`; `messages_repo::{ids_by_uids, rule_message}`.

- [ ] **Step 1: Create the migration**

Create `crates/am-storage/src/migrations/V10__rules.sql`:

```sql
CREATE TABLE rules (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    match_type TEXT NOT NULL DEFAULT 'all',
    conditions TEXT NOT NULL DEFAULT '[]',
    actions TEXT NOT NULL DEFAULT '[]',
    position INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_rules_account ON rules(account_id, position);
```

- [ ] **Step 2: Add the module declaration**

In `crates/am-storage/src/lib.rs`, add (alongside the other `pub mod *_repo;` lines):

```rust
pub mod rules_repo;
```

- [ ] **Step 3: Write the failing rules_repo test**

Create `crates/am-storage/src/rules_repo.rs` — the full file below includes this `#[cfg(test)]` module. The tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use am_core::account::{NewAccount, ProviderType};
    use am_core::rule::{ConditionField, ConditionOp, MatchType, RuleAction, RuleActionKind, RuleCondition};

    fn setup(db: &Database) -> i64 {
        insert_account(db, &NewAccount {
            email: "s@e.com".into(), display_name: "S".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap().id
    }

    fn input(name: &str) -> RuleInput {
        RuleInput {
            name: name.into(),
            enabled: true,
            match_type: MatchType::All,
            conditions: vec![RuleCondition { field: ConditionField::From, op: ConditionOp::Contains, value: "a@b.c".into() }],
            actions: vec![RuleAction { kind: RuleActionKind::Flag, value: String::new() }],
        }
    }

    #[test]
    fn create_then_list_round_trips_and_orders_by_position() {
        let db = Database::open_in_memory().unwrap();
        let acc = setup(&db);
        let r0 = create_rule(&db, acc, &input("first")).unwrap();
        let r1 = create_rule(&db, acc, &input("second")).unwrap();
        assert_eq!(r0.position, 0);
        assert_eq!(r1.position, 1);
        let rules = list_rules(&db, acc).unwrap();
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].name, "first");
        assert_eq!(rules[0].conditions.len(), 1);
        assert_eq!(rules[0].conditions[0].value, "a@b.c");
        assert_eq!(rules[0].actions[0].kind, RuleActionKind::Flag);
    }

    #[test]
    fn update_replaces_fields() {
        let db = Database::open_in_memory().unwrap();
        let acc = setup(&db);
        let r = create_rule(&db, acc, &input("name")).unwrap();
        let mut changed = input("renamed");
        changed.match_type = MatchType::Any;
        changed.actions = vec![RuleAction { kind: RuleActionKind::MarkRead, value: String::new() }];
        update_rule(&db, r.id, &changed).unwrap();
        let rules = list_rules(&db, acc).unwrap();
        assert_eq!(rules[0].name, "renamed");
        assert_eq!(rules[0].match_type, MatchType::Any);
        assert_eq!(rules[0].actions[0].kind, RuleActionKind::MarkRead);
    }

    #[test]
    fn set_enabled_and_delete() {
        let db = Database::open_in_memory().unwrap();
        let acc = setup(&db);
        let r = create_rule(&db, acc, &input("x")).unwrap();
        set_rule_enabled(&db, r.id, false).unwrap();
        assert!(!list_rules(&db, acc).unwrap()[0].enabled);
        delete_rule(&db, r.id).unwrap();
        assert!(list_rules(&db, acc).unwrap().is_empty());
    }
}
```

- [ ] **Step 4: Write the rules_repo implementation**

Put this ABOVE the `#[cfg(test)]` block in `crates/am-storage/src/rules_repo.rs`:

```rust
use am_core::rule::{MatchType, Rule, RuleAction, RuleCondition, RuleInput};
use rusqlite::params;

use crate::db::{Database, StorageError};

fn match_type_to_str(m: MatchType) -> &'static str {
    match m {
        MatchType::All => "all",
        MatchType::Any => "any",
    }
}

fn match_type_from_str(s: &str) -> MatchType {
    if s == "any" {
        MatchType::Any
    } else {
        MatchType::All
    }
}

fn parse_conditions(s: &str) -> Vec<RuleCondition> {
    serde_json::from_str(s).unwrap_or_default()
}

fn parse_actions(s: &str) -> Vec<RuleAction> {
    serde_json::from_str(s).unwrap_or_default()
}

pub fn list_rules(db: &Database, account_id: i64) -> Result<Vec<Rule>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, account_id, name, enabled, match_type, conditions, actions, position
         FROM rules WHERE account_id = ?1 ORDER BY position ASC, id ASC",
    )?;
    let rows = stmt.query_map(params![account_id], |r| {
        let match_type: String = r.get(4)?;
        let conditions: String = r.get(5)?;
        let actions: String = r.get(6)?;
        Ok(Rule {
            id: r.get(0)?,
            account_id: r.get(1)?,
            name: r.get(2)?,
            enabled: r.get::<_, i64>(3)? != 0,
            match_type: match_type_from_str(&match_type),
            conditions: parse_conditions(&conditions),
            actions: parse_actions(&actions),
            position: r.get(7)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn create_rule(db: &Database, account_id: i64, input: &RuleInput) -> Result<Rule, StorageError> {
    let conditions = serde_json::to_string(&input.conditions)
        .map_err(|e| StorageError::InvalidData(e.to_string()))?;
    let actions = serde_json::to_string(&input.actions)
        .map_err(|e| StorageError::InvalidData(e.to_string()))?;
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let position: i64 = tx.query_row(
        "SELECT COUNT(*) FROM rules WHERE account_id = ?1",
        params![account_id],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT INTO rules (account_id, name, enabled, match_type, conditions, actions, position)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            account_id,
            input.name,
            input.enabled as i64,
            match_type_to_str(input.match_type),
            conditions,
            actions,
            position
        ],
    )?;
    let id = tx.last_insert_rowid();
    tx.commit()?;
    Ok(Rule {
        id,
        account_id,
        name: input.name.clone(),
        enabled: input.enabled,
        match_type: input.match_type,
        conditions: input.conditions.clone(),
        actions: input.actions.clone(),
        position,
    })
}

pub fn update_rule(db: &Database, id: i64, input: &RuleInput) -> Result<(), StorageError> {
    let conditions = serde_json::to_string(&input.conditions)
        .map_err(|e| StorageError::InvalidData(e.to_string()))?;
    let actions = serde_json::to_string(&input.actions)
        .map_err(|e| StorageError::InvalidData(e.to_string()))?;
    let conn = db.conn();
    conn.execute(
        "UPDATE rules SET name = ?2, enabled = ?3, match_type = ?4, conditions = ?5, actions = ?6 WHERE id = ?1",
        params![
            id,
            input.name,
            input.enabled as i64,
            match_type_to_str(input.match_type),
            conditions,
            actions
        ],
    )?;
    Ok(())
}

pub fn set_rule_enabled(db: &Database, id: i64, enabled: bool) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute("UPDATE rules SET enabled = ?2 WHERE id = ?1", params![id, enabled as i64])?;
    Ok(())
}

pub fn delete_rule(db: &Database, id: i64) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute("DELETE FROM rules WHERE id = ?1", params![id])?;
    Ok(())
}
```

- [ ] **Step 5: Run the rules_repo tests**

Run: `cargo test -p am-storage rules_repo`
Expected: PASS (3 tests).

- [ ] **Step 6: Add the message helpers (with tests)**

In `crates/am-storage/src/messages_repo.rs`, append these two functions (after `locate`):

```rust
pub fn ids_by_uids(db: &Database, folder_id: i64, uids: &[i64]) -> Result<Vec<i64>, StorageError> {
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    let conn = db.conn();
    let placeholders = uids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id FROM messages WHERE folder_id = ? AND uid IN ({placeholders}) ORDER BY uid ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut bind: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(uids.len() + 1);
    bind.push(&folder_id);
    for u in uids {
        bind.push(u);
    }
    let rows = stmt.query_map(bind.as_slice(), |r| r.get::<_, i64>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn rule_message(db: &Database, message_id: i64) -> Result<am_core::rule::RuleMessage, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT from_address, from_name, subject, has_attachments, to_addresses, cc_addresses
         FROM messages WHERE id = ?1",
        params![message_id],
        |r| {
            let to_json: String = r.get(4)?;
            let cc_json: String = r.get(5)?;
            let mut recipients: Vec<String> = serde_json::from_str(&to_json).unwrap_or_default();
            let cc: Vec<String> = serde_json::from_str(&cc_json).unwrap_or_default();
            recipients.extend(cc);
            Ok(am_core::rule::RuleMessage {
                from_address: r.get(0)?,
                from_name: r.get(1)?,
                subject: r.get(2)?,
                recipients,
                has_attachments: r.get::<_, i64>(3)? != 0,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
        other => StorageError::Sqlite(other),
    })
}

#[cfg(test)]
mod rule_helpers_tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use crate::folders_repo::upsert_folder;
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::NewMessageHeader;

    fn header(uid: i64) -> NewMessageHeader {
        NewMessageHeader {
            uid, message_id_hdr: None, in_reply_to: None, references_hdr: None,
            from_address: "a@b.c".into(), from_name: Some("AB".into()), subject: format!("S{uid}"),
            date: 1000, seen: false, flagged: false, has_attachments: true, size: 0, snippet: String::new(),
        }
    }

    #[test]
    fn ids_by_uids_and_rule_message() {
        let db = Database::open_in_memory().unwrap();
        let acc = insert_account(&db, &NewAccount {
            email: "s@e.com".into(), display_name: "S".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = upsert_folder(&db, acc.id, "INBOX", "Inbox", FolderType::Inbox).unwrap().id;
        insert_headers(&db, folder, &[header(1), header(2)]).unwrap();

        let ids = ids_by_uids(&db, folder, &[1, 2]).unwrap();
        assert_eq!(ids.len(), 2);

        let view = rule_message(&db, ids[0]).unwrap();
        assert_eq!(view.from_address, "a@b.c");
        assert_eq!(view.from_name.as_deref(), Some("AB"));
        assert!(view.has_attachments);
    }
}
```

- [ ] **Step 7: Run the message-helper tests + the whole crate**

Run: `cargo test -p am-storage`
Expected: all PASS (existing + new).

- [ ] **Step 8: Commit**

```bash
git add crates/am-storage/src/migrations/V10__rules.sql crates/am-storage/src/rules_repo.rs crates/am-storage/src/lib.rs crates/am-storage/src/messages_repo.rs
git commit -m "feat(rules): V10 migration, rules_repo CRUD, message helpers"
```

---

### Task 3: `am-sync` apply engine + inbox sync hook

**Files:**
- Modify: `crates/am-sync/src/service.rs` (add `apply_rules_to_messages` + `apply_action` + the hook in `incremental_sync_folder`; add `labels_repo`/`rules_repo`/`snooze_repo` imports + `am_core::rule` usage)

**Interfaces:**
- Consumes: `rules_repo::list_rules`, `messages_repo::{ids_by_uids, rule_message}`, `labels_repo::set_message_labels`, `snooze_repo::snooze_messages`, `enqueue_flag`, `am_core::rule::{rule_matches, snooze_wake_at, RuleAction, RuleActionKind}`, `am_core::message::MessageFlag`, `am_core::folder::FolderType`.
- Produces: `apply_rules_to_messages(db, account_id, message_ids: &[i64], now: i64) -> Result<(), SyncError>`.

- [ ] **Step 1: Write the failing test**

Add this test module at the end of `crates/am-sync/src/service.rs` (if a `#[cfg(test)]` module already exists, add these as new `#[test]` fns inside it instead; otherwise add a new module):

```rust
#[cfg(test)]
mod rules_engine_tests {
    use super::*;
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::NewMessageHeader;
    use am_core::rule::{ConditionField, ConditionOp, MatchType, RuleAction, RuleActionKind, RuleCondition, RuleInput};
    use am_storage::{accounts_repo, folders_repo, messages_repo, rules_repo};

    fn header(uid: i64, from: &str, subject: &str) -> NewMessageHeader {
        NewMessageHeader {
            uid, message_id_hdr: None, in_reply_to: None, references_hdr: None,
            from_address: from.into(), from_name: None, subject: subject.into(),
            date: 1000, seen: false, flagged: false, has_attachments: false, size: 0, snippet: String::new(),
        }
    }

    fn rule_input(field: ConditionField, value: &str, action: RuleActionKind, action_value: &str, enabled: bool) -> RuleInput {
        RuleInput {
            name: "r".into(), enabled, match_type: MatchType::All,
            conditions: vec![RuleCondition { field, op: ConditionOp::Contains, value: value.into() }],
            actions: vec![RuleAction { kind: action, value: action_value.into() }],
        }
    }

    fn seed(db: &Database) -> (i64, i64) {
        let acc = accounts_repo::insert_account(db, &NewAccount {
            email: "s@e.com".into(), display_name: "S".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = folders_repo::upsert_folder(db, acc.id, "INBOX", "Inbox", FolderType::Inbox).unwrap().id;
        (acc.id, folder)
    }

    #[test]
    fn flag_action_sets_flagged() {
        let db = Database::open_in_memory().unwrap();
        let (acc, folder) = seed(&db);
        messages_repo::insert_headers(&db, folder, &[header(1, "boss@work.com", "hi")]).unwrap();
        let ids = messages_repo::ids_by_uids(&db, folder, &[1]).unwrap();
        rules_repo::create_rule(&db, acc, &rule_input(ConditionField::From, "work.com", RuleActionKind::Flag, "", true)).unwrap();

        apply_rules_to_messages(&db, acc, &ids, 10_000).unwrap();

        let flagged: i64 = db.conn().query_row("SELECT flagged FROM messages WHERE id = ?1", rusqlite::params![ids[0]], |r| r.get(0)).unwrap();
        assert_eq!(flagged, 1);
    }

    #[test]
    fn mark_read_and_snooze_apply() {
        let db = Database::open_in_memory().unwrap();
        let (acc, folder) = seed(&db);
        messages_repo::insert_headers(&db, folder, &[header(1, "n@l.com", "promo")]).unwrap();
        let ids = messages_repo::ids_by_uids(&db, folder, &[1]).unwrap();
        rules_repo::create_rule(&db, acc, &rule_input(ConditionField::Subject, "promo", RuleActionKind::MarkRead, "", true)).unwrap();
        rules_repo::create_rule(&db, acc, &rule_input(ConditionField::Subject, "promo", RuleActionKind::Snooze, "2", true)).unwrap();

        apply_rules_to_messages(&db, acc, &ids, 10_000).unwrap();

        let (seen, wake): (i64, Option<i64>) = db.conn().query_row(
            "SELECT seen, snooze_wake_at FROM messages WHERE id = ?1", rusqlite::params![ids[0]],
            |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(seen, 1);
        assert_eq!(wake, Some(10_000 + 2 * 3600));
    }

    #[test]
    fn disabled_rule_and_non_match_do_nothing() {
        let db = Database::open_in_memory().unwrap();
        let (acc, folder) = seed(&db);
        messages_repo::insert_headers(&db, folder, &[header(1, "x@y.com", "hello")]).unwrap();
        let ids = messages_repo::ids_by_uids(&db, folder, &[1]).unwrap();
        rules_repo::create_rule(&db, acc, &rule_input(ConditionField::From, "y.com", RuleActionKind::Flag, "", false)).unwrap();
        rules_repo::create_rule(&db, acc, &rule_input(ConditionField::From, "other.com", RuleActionKind::Flag, "", true)).unwrap();

        apply_rules_to_messages(&db, acc, &ids, 10_000).unwrap();

        let flagged: i64 = db.conn().query_row("SELECT flagged FROM messages WHERE id = ?1", rusqlite::params![ids[0]], |r| r.get(0)).unwrap();
        assert_eq!(flagged, 0);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p am-sync rules_engine`
Expected: FAIL — `apply_rules_to_messages` not found.

- [ ] **Step 3: Add imports**

At the top of `crates/am-sync/src/service.rs`, ensure the `am_storage` use brings in `labels_repo`, `rules_repo`, `snooze_repo` (extend the existing `use am_storage::{...}` list to include them).

- [ ] **Step 4: Implement the engine**

Add these two functions to `crates/am-sync/src/service.rs` (next to `enqueue_flag`):

```rust
pub fn apply_rules_to_messages(
    db: &Database,
    account_id: i64,
    message_ids: &[i64],
    now: i64,
) -> Result<(), SyncError> {
    if message_ids.is_empty() {
        return Ok(());
    }
    let rules: Vec<am_core::rule::Rule> = rules_repo::list_rules(db, account_id)?
        .into_iter()
        .filter(|r| r.enabled)
        .collect();
    if rules.is_empty() {
        return Ok(());
    }
    for &message_id in message_ids {
        let view = match messages_repo::rule_message(db, message_id) {
            Ok(v) => v,
            Err(_) => continue,
        };
        for rule in &rules {
            if am_core::rule::rule_matches(rule, &view) {
                for action in &rule.actions {
                    apply_rule_action(db, message_id, action, now)?;
                }
            }
        }
    }
    Ok(())
}

fn apply_rule_action(
    db: &Database,
    message_id: i64,
    action: &am_core::rule::RuleAction,
    now: i64,
) -> Result<(), SyncError> {
    match action.kind {
        am_core::rule::RuleActionKind::Label => {
            if let Ok(label_id) = action.value.trim().parse::<i64>() {
                labels_repo::set_message_labels(db, label_id, &[message_id], true)?;
            }
        }
        am_core::rule::RuleActionKind::MarkRead => {
            enqueue_flag(db, message_id, MessageFlag::Seen, true)?;
        }
        am_core::rule::RuleActionKind::Flag => {
            enqueue_flag(db, message_id, MessageFlag::Flagged, true)?;
        }
        am_core::rule::RuleActionKind::Snooze => {
            let wake = am_core::rule::snooze_wake_at(now, &action.value);
            snooze_repo::snooze_messages(db, &[message_id], wake)?;
        }
    }
    Ok(())
}
```

- [ ] **Step 5: Run the engine tests**

Run: `cargo test -p am-sync rules_engine`
Expected: PASS (3 tests).

- [ ] **Step 6: Wire the hook into incremental_sync_folder**

In `crates/am-sync/src/service.rs`, inside `incremental_sync_folder`, the `if !new_uids.is_empty() { ... }` block currently ends with `assign_threads(db, account_id)?;`. Replace that block so it also runs rules on inbox folders:

```rust
    if !new_uids.is_empty() {
        let fetched = session.fetch_headers_by_uids(&new_uids).await?;
        let headers: Vec<NewMessageHeader> = fetched.iter().map(header_from_fetch).collect();
        messages_repo::insert_headers(db, folder_id, &headers)?;
        assign_threads(db, account_id)?;
        if folder.folder_type == am_core::folder::FolderType::Inbox {
            let new_ids = messages_repo::ids_by_uids(db, folder_id, &new_uids)?;
            apply_rules_to_messages(db, account_id, &new_ids, now_secs())?;
        }
    }
```

(`folder` is already in scope from `folders_repo::get_folder` near the top of the function; `now_secs()` is the existing helper used elsewhere in this file.)

- [ ] **Step 7: Verify the crate compiles + tests pass**

Run: `cargo test -p am-sync`
Expected: all PASS (existing + rules). (The hook path is exercised indirectly; the engine tests cover the logic.)

- [ ] **Step 8: Commit**

```bash
git add crates/am-sync/src/service.rs
git commit -m "feat(rules): apply engine and inbox sync hook"
```

---

### Task 4: `am-app` commands + bindings

**Files:**
- Modify: `crates/am-app/src/commands.rs` (5 commands + import)
- Modify: `crates/am-app/src/lib.rs` (register in `collect_commands!`)
- Regenerated: `src/ipc/bindings.ts`

**Interfaces:**
- Consumes: `am_storage::rules_repo`, `am_core::rule::{Rule, RuleInput}`.
- Produces (bindings): `commands.listRules/createRule/updateRule/setRuleEnabled/deleteRule`; types `Rule`, `RuleInput`, `RuleCondition`, `RuleAction`, `ConditionField`, `ConditionOp`, `RuleActionKind`, `MatchType`.

- [ ] **Step 1: Add the import**

In `crates/am-app/src/commands.rs`, add to the imports (near the other `am_core` uses):

```rust
use am_core::rule::{Rule, RuleInput};
```

- [ ] **Step 2: Add the five commands**

Append to `crates/am-app/src/commands.rs`:

```rust
#[tauri::command]
#[specta::specta]
pub fn list_rules(state: tauri::State<'_, AppState>, account_id: i64) -> Result<Vec<Rule>, String> {
    am_storage::rules_repo::list_rules(&state.db, account_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn create_rule(
    state: tauri::State<'_, AppState>,
    account_id: i64,
    input: RuleInput,
) -> Result<Rule, String> {
    am_storage::rules_repo::create_rule(&state.db, account_id, &input).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn update_rule(
    state: tauri::State<'_, AppState>,
    rule_id: i64,
    input: RuleInput,
) -> Result<(), String> {
    am_storage::rules_repo::update_rule(&state.db, rule_id, &input).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn set_rule_enabled(
    state: tauri::State<'_, AppState>,
    rule_id: i64,
    enabled: bool,
) -> Result<(), String> {
    am_storage::rules_repo::set_rule_enabled(&state.db, rule_id, enabled).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn delete_rule(state: tauri::State<'_, AppState>, rule_id: i64) -> Result<(), String> {
    am_storage::rules_repo::delete_rule(&state.db, rule_id).map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Register the commands**

In `crates/am-app/src/lib.rs`, add to the `collect_commands![ ... ]` list (after `commands::refresh_unread_badge,`):

```rust
            commands::list_rules,
            commands::create_rule,
            commands::update_rule,
            commands::set_rule_enabled,
            commands::delete_rule,
```

- [ ] **Step 4: Build + regenerate bindings**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
cargo build -p abeonmail
npm run gen:bindings
```
Expected: compiles; `src/ipc/bindings.ts` now contains `listRules`/`createRule`/`updateRule`/`setRuleEnabled`/`deleteRule` and the `Rule`/`RuleInput`/`RuleCondition`/`RuleAction`/`ConditionField`/`ConditionOp`/`RuleActionKind`/`MatchType` types.

- [ ] **Step 5: Confirm frontend still typechecks**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm run build`
Expected: clean (the regenerated bindings are consumed in Task 5; here just confirm no breakage).

- [ ] **Step 6: Commit**

```bash
git add crates/am-app/src/commands.rs crates/am-app/src/lib.rs src/ipc/bindings.ts
git commit -m "feat(rules): am-app rule commands and bindings"
```

---

### Task 5: Frontend — queries hooks + RulesSection + wiring

**Files:**
- Modify: `src/ipc/queries.ts` (5 rule hooks)
- Create: `src/features/settings/RulesSection.tsx`
- Create: `src/features/settings/RulesSection.test.tsx`
- Modify: `src/features/settings/SettingsOverlay.tsx` (wire `rules` → `RulesSection`)
- Modify: `src/features/settings/SettingsOverlay.test.tsx` (placeholder click already on "Accounts" since 7c — confirm; no change expected)

**Interfaces:**
- Consumes: `commands.listRules/createRule/updateRule/setRuleEnabled/deleteRule`; bindings types `Rule`, `RuleInput`, `RuleCondition`, `RuleAction`; `useAccounts`, `useLabels`.
- Produces: `useRules`, `useCreateRule`, `useUpdateRule`, `useSetRuleEnabled`, `useDeleteRule`; `RulesSection`.

- [ ] **Step 1: Add the query hooks**

In `src/ipc/queries.ts`, add `Rule`, `RuleInput` to the type import from `./bindings` (the existing `import type { ... } from "./bindings"` line), then append:

```ts
export function useRules(accountId: number | null) {
  return useQuery({
    queryKey: ["rules", accountId],
    queryFn: () => commands.listRules(accountId!).then(unwrap),
    enabled: accountId != null,
  });
}

export function useCreateRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { accountId: number; input: RuleInput }) =>
      commands.createRule(v.accountId, v.input).then(unwrap),
    onSuccess: (_data, v) => {
      queryClient.invalidateQueries({ queryKey: ["rules", v.accountId] });
    },
  });
}

export function useUpdateRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { ruleId: number; accountId: number; input: RuleInput }) =>
      commands.updateRule(v.ruleId, v.input).then(unwrap),
    onSuccess: (_data, v) => {
      queryClient.invalidateQueries({ queryKey: ["rules", v.accountId] });
    },
  });
}

export function useSetRuleEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { ruleId: number; accountId: number; enabled: boolean }) =>
      commands.setRuleEnabled(v.ruleId, v.enabled).then(unwrap),
    onSuccess: (_data, v) => {
      queryClient.invalidateQueries({ queryKey: ["rules", v.accountId] });
    },
  });
}

export function useDeleteRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { ruleId: number; accountId: number }) =>
      commands.deleteRule(v.ruleId).then(unwrap),
    onSuccess: (_data, v) => {
      queryClient.invalidateQueries({ queryKey: ["rules", v.accountId] });
    },
  });
}
```

- [ ] **Step 2: Write the failing RulesSection test**

Create `src/features/settings/RulesSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { RulesSection } from "./RulesSection";

const { createRule, setRuleEnabled, deleteRule } = vi.hoisted(() => ({
  createRule: vi.fn(),
  setRuleEnabled: vi.fn(),
  deleteRule: vi.fn(),
}));

const sampleRule = {
  id: 7,
  account_id: 1,
  name: "Work to label",
  enabled: true,
  match_type: "all",
  conditions: [{ field: "from", op: "contains", value: "work.com" }],
  actions: [{ kind: "flag", value: "" }],
  position: 0,
};

vi.mock("../../ipc/queries", () => ({
  useAccounts: () => ({ data: [{ id: 1, email: "a@x.com", display_name: "A", provider_type: "imap_password", color: null, position: 0, requires_reauth: false }] }),
  useLabels: () => ({ data: [{ id: 3, name: "Work", color: "#4f46e5" }] }),
  useRules: () => ({ data: [sampleRule] }),
  useCreateRule: () => ({ mutate: createRule }),
  useUpdateRule: () => ({ mutate: vi.fn() }),
  useSetRuleEnabled: () => ({ mutate: setRuleEnabled }),
  useDeleteRule: () => ({ mutate: deleteRule }),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("RulesSection", () => {
  it("lists existing rules", () => {
    const { getByText } = render(<RulesSection />);
    expect(getByText("Work to label")).toBeTruthy();
  });

  it("toggles a rule's enabled state", () => {
    const { getByLabelText } = render(<RulesSection />);
    fireEvent.click(getByLabelText("Enable rule Work to label"));
    expect(setRuleEnabled).toHaveBeenCalledWith({ ruleId: 7, accountId: 1, enabled: false });
  });

  it("deletes a rule", () => {
    const { getByLabelText } = render(<RulesSection />);
    fireEvent.click(getByLabelText("Delete rule Work to label"));
    expect(deleteRule).toHaveBeenCalledWith({ ruleId: 7, accountId: 1 });
  });

  it("adds a condition and action row and creates a rule", () => {
    const { getByLabelText, getByText } = render(<RulesSection />);
    fireEvent.change(getByLabelText("Rule name"), { target: { value: "My rule" } });
    fireEvent.change(getByLabelText("Condition 1 value"), { target: { value: "boss" } });
    fireEvent.click(getByText("Save rule"));
    expect(createRule).toHaveBeenCalledTimes(1);
    const arg = createRule.mock.calls[0][0];
    expect(arg.accountId).toBe(1);
    expect(arg.input.name).toBe("My rule");
    expect(arg.input.conditions.length).toBe(1);
    expect(arg.input.actions.length).toBe(1);
  });

  it("does not save a rule with an empty condition value", () => {
    const { getByText } = render(<RulesSection />);
    fireEvent.click(getByText("Save rule"));
    expect(createRule).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/settings/RulesSection.test.tsx`
Expected: FAIL — cannot resolve `./RulesSection`.

- [ ] **Step 4: Create RulesSection**

Create `src/features/settings/RulesSection.tsx`:

```tsx
import { useState } from "react";
import { Trash2 } from "lucide-react";
import {
  useAccounts,
  useLabels,
  useRules,
  useCreateRule,
  useUpdateRule,
  useSetRuleEnabled,
  useDeleteRule,
} from "../../ipc/queries";
import type { ConditionField, ConditionOp, RuleActionKind, MatchType } from "../../ipc/bindings";

type DraftCondition = { field: ConditionField; op: ConditionOp; value: string };
type DraftAction = { kind: RuleActionKind; value: string };

const FIELDS: { value: ConditionField; label: string }[] = [
  { value: "from", label: "From" },
  { value: "subject", label: "Subject" },
  { value: "recipient", label: "Recipient" },
  { value: "has_attachment", label: "Has attachment" },
];

const OPS: { value: ConditionOp; label: string }[] = [
  { value: "contains", label: "contains" },
  { value: "is", label: "is" },
];

const ACTION_KINDS: { value: RuleActionKind; label: string }[] = [
  { value: "label", label: "Apply label" },
  { value: "mark_read", label: "Mark as read" },
  { value: "flag", label: "Star" },
  { value: "snooze", label: "Snooze (hours)" },
];

function emptyCondition(): DraftCondition {
  return { field: "from", op: "contains", value: "" };
}

function emptyAction(): DraftAction {
  return { kind: "label", value: "" };
}

export function RulesSection() {
  const { data: accounts = [] } = useAccounts();
  const [chosenAccountId, setChosenAccountId] = useState<number | null>(null);
  const accountId = chosenAccountId ?? accounts[0]?.id ?? null;

  const { data: labels = [] } = useLabels();
  const { data: rules = [] } = useRules(accountId);
  const createRule = useCreateRule();
  const updateRule = useUpdateRule();
  const setRuleEnabled = useSetRuleEnabled();
  const deleteRule = useDeleteRule();

  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [matchType, setMatchType] = useState<MatchType>("all");
  const [conditions, setConditions] = useState<DraftCondition[]>([emptyCondition()]);
  const [actions, setActions] = useState<DraftAction[]>([emptyAction()]);

  function resetEditor() {
    setEditingId(null);
    setName("");
    setMatchType("all");
    setConditions([emptyCondition()]);
    setActions([emptyAction()]);
  }

  function loadRule(id: number) {
    const r = rules.find((x) => x.id === id);
    if (!r) return;
    setEditingId(r.id);
    setName(r.name);
    setMatchType(r.match_type);
    setConditions(r.conditions.length ? r.conditions.map((c) => ({ ...c })) : [emptyCondition()]);
    setActions(r.actions.length ? r.actions.map((a) => ({ ...a })) : [emptyAction()]);
  }

  function save() {
    if (accountId == null) return;
    const cleanConditions = conditions.filter(
      (c) => c.field === "has_attachment" || c.value.trim().length > 0
    );
    if (cleanConditions.length === 0 || actions.length === 0) return;
    const input = {
      name: name.trim() || "Rule",
      enabled: true,
      match_type: matchType,
      conditions: cleanConditions,
      actions,
    };
    if (editingId == null) {
      createRule.mutate({ accountId, input });
    } else {
      updateRule.mutate({ ruleId: editingId, accountId, input });
    }
    resetEditor();
  }

  return (
    <div className="settings-section">
      <label className="signatures-settings__account">
        Account
        <select
          aria-label="Rules account"
          value={accountId ?? ""}
          onChange={(e) => setChosenAccountId(Number(e.target.value))}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.email}
            </option>
          ))}
        </select>
      </label>

      <ul className="rules-settings__list">
        {rules.map((r) => (
          <li key={r.id} className="rules-settings__row">
            <button type="button" className="rules-settings__name" onClick={() => loadRule(r.id)}>
              {r.name}
            </button>
            <label className="rules-settings__enabled">
              <input
                type="checkbox"
                aria-label={`Enable rule ${r.name}`}
                checked={r.enabled}
                onChange={() =>
                  accountId != null &&
                  setRuleEnabled.mutate({ ruleId: r.id, accountId, enabled: !r.enabled })
                }
              />
              Enabled
            </label>
            <button
              type="button"
              aria-label={`Delete rule ${r.name}`}
              onClick={() => accountId != null && deleteRule.mutate({ ruleId: r.id, accountId })}
            >
              <Trash2 size={15} />
            </button>
          </li>
        ))}
      </ul>

      <div className="rules-settings__editor">
        <input
          type="text"
          aria-label="Rule name"
          placeholder="Rule name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label>
          Match
          <select aria-label="Match type" value={matchType} onChange={(e) => setMatchType(e.target.value as MatchType)}>
            <option value="all">all conditions</option>
            <option value="any">any condition</option>
          </select>
        </label>

        <div className="rules-settings__conditions">
          {conditions.map((c, i) => (
            <div key={i} className="rules-settings__condition-row">
              <select
                aria-label={`Condition ${i + 1} field`}
                value={c.field}
                onChange={(e) => {
                  const next = [...conditions];
                  next[i] = { ...c, field: e.target.value as ConditionField };
                  setConditions(next);
                }}
              >
                {FIELDS.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
              {c.field === "has_attachment" ? (
                <select
                  aria-label={`Condition ${i + 1} value`}
                  value={c.value || "true"}
                  onChange={(e) => {
                    const next = [...conditions];
                    next[i] = { ...c, op: "is", value: e.target.value };
                    setConditions(next);
                  }}
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <>
                  <select
                    aria-label={`Condition ${i + 1} operator`}
                    value={c.op}
                    onChange={(e) => {
                      const next = [...conditions];
                      next[i] = { ...c, op: e.target.value as ConditionOp };
                      setConditions(next);
                    }}
                  >
                    {OPS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    aria-label={`Condition ${i + 1} value`}
                    value={c.value}
                    onChange={(e) => {
                      const next = [...conditions];
                      next[i] = { ...c, value: e.target.value };
                      setConditions(next);
                    }}
                  />
                </>
              )}
              {conditions.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove condition ${i + 1}`}
                  onClick={() => setConditions(conditions.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <button type="button" onClick={() => setConditions([...conditions, emptyCondition()])}>
            Add condition
          </button>
        </div>

        <div className="rules-settings__actions-list">
          {actions.map((a, i) => (
            <div key={i} className="rules-settings__action-row">
              <select
                aria-label={`Action ${i + 1} kind`}
                value={a.kind}
                onChange={(e) => {
                  const next = [...actions];
                  next[i] = { kind: e.target.value as RuleActionKind, value: "" };
                  setActions(next);
                }}
              >
                {ACTION_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>{k.label}</option>
                ))}
              </select>
              {a.kind === "label" && (
                <select
                  aria-label={`Action ${i + 1} label`}
                  value={a.value}
                  onChange={(e) => {
                    const next = [...actions];
                    next[i] = { ...a, value: e.target.value };
                    setActions(next);
                  }}
                >
                  <option value="">Select label…</option>
                  {labels.map((l) => (
                    <option key={l.id} value={String(l.id)}>{l.name}</option>
                  ))}
                </select>
              )}
              {a.kind === "snooze" && (
                <input
                  type="number"
                  aria-label={`Action ${i + 1} hours`}
                  min={1}
                  value={a.value}
                  placeholder="24"
                  onChange={(e) => {
                    const next = [...actions];
                    next[i] = { ...a, value: e.target.value };
                    setActions(next);
                  }}
                />
              )}
              {actions.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove action ${i + 1}`}
                  onClick={() => setActions(actions.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <button type="button" onClick={() => setActions([...actions, emptyAction()])}>
            Add action
          </button>
        </div>

        <div className="rules-settings__editor-actions">
          <button type="button" onClick={resetEditor}>New rule</button>
          <button type="button" onClick={save}>Save rule</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the RulesSection test**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/settings/RulesSection.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 6: Wire RulesSection into SettingsOverlay**

In `src/features/settings/SettingsOverlay.tsx`, add an import after the other section imports:

```ts
import { RulesSection } from "./RulesSection";
```

and add a branch in the render conditional (e.g. after the `snooze` branch, before the final placeholder):

```tsx
          ) : active === "rules" ? (
            <RulesSection />
```

So the chain ends `... : active === "snooze" ? (<SnoozeSection />) : active === "rules" ? (<RulesSection />) : (<div className="settings-placeholder">Coming soon</div>)`.

- [ ] **Step 7: Confirm SettingsOverlay.test still green**

`src/features/settings/SettingsOverlay.test.tsx`'s placeholder test clicks "Accounts" (set in 7c) — still a placeholder, so no change is needed. Just confirm it passes in Step 8. (`Trash2` is already in `src/test/lucide-stub.js`, so no stub change.)

- [ ] **Step 8: Verify suite + build**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run && npm run build`
Expected: all PASS; build clean.

- [ ] **Step 9: Commit**

```bash
git add src/ipc/queries.ts src/features/settings/RulesSection.tsx src/features/settings/RulesSection.test.tsx src/features/settings/SettingsOverlay.tsx
git commit -m "feat(rules): rules settings section and query hooks"
```

---

## Final verification (after all tasks)

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
cargo test --workspace
npx vitest run
npm run build
```

Expected: all Rust tests green (am-core rule matching, am-storage rules_repo + helpers, am-sync engine), all frontend tests green, build clean. No IMAP/network is exercised by the rule tests. V10 migration applies cleanly on a fresh in-memory DB (covered by every am-storage test opening `Database::open_in_memory`).
