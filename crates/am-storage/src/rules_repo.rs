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
