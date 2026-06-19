use am_core::signature::Signature;
use rusqlite::{params, OptionalExtension};

use crate::db::{Database, StorageError};

pub fn list_signatures(db: &Database, account_id: i64) -> Result<Vec<Signature>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, name, html, is_default FROM signatures WHERE account_id=?1 ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![account_id], |r| {
        Ok(Signature {
            id: r.get(0)?,
            name: r.get(1)?,
            html: r.get(2)?,
            is_default: r.get::<_, i64>(3)? != 0,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn create_signature(
    db: &Database,
    account_id: i64,
    name: &str,
    html: &str,
    make_default: bool,
) -> Result<Signature, StorageError> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let existing: i64 = tx.query_row(
        "SELECT COUNT(*) FROM signatures WHERE account_id = ?1",
        params![account_id],
        |r| r.get(0),
    )?;
    let is_default = make_default || existing == 0;
    if is_default {
        tx.execute(
            "UPDATE signatures SET is_default = 0 WHERE account_id = ?1",
            params![account_id],
        )?;
    }
    tx.execute(
        "INSERT INTO signatures (account_id, name, html, is_default) VALUES (?1, ?2, ?3, ?4)",
        params![account_id, name, html, is_default as i64],
    )?;
    let id = tx.last_insert_rowid();
    tx.commit()?;
    Ok(Signature {
        id,
        name: name.to_string(),
        html: html.to_string(),
        is_default,
    })
}

pub fn update_signature(
    db: &Database,
    id: i64,
    name: &str,
    html: &str,
) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute(
        "UPDATE signatures SET name = ?2, html = ?3 WHERE id = ?1",
        params![id, name, html],
    )?;
    Ok(())
}

pub fn set_default_signature(
    db: &Database,
    account_id: i64,
    id: i64,
) -> Result<(), StorageError> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE signatures SET is_default = 0 WHERE account_id = ?1",
        params![account_id],
    )?;
    tx.execute(
        "UPDATE signatures SET is_default = 1 WHERE id = ?1 AND account_id = ?2",
        params![id, account_id],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn delete_signature(db: &Database, id: i64) -> Result<(), StorageError> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let row: Option<(i64, i64)> = tx
        .query_row(
            "SELECT account_id, is_default FROM signatures WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    tx.execute("DELETE FROM signatures WHERE id = ?1", params![id])?;
    if let Some((account_id, is_default)) = row {
        if is_default != 0 {
            let next: Option<i64> = tx.query_row(
                "SELECT MIN(id) FROM signatures WHERE account_id = ?1",
                params![account_id],
                |r| r.get(0),
            )?;
            if let Some(next_id) = next {
                tx.execute(
                    "UPDATE signatures SET is_default = 1 WHERE id = ?1",
                    params![next_id],
                )?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use crate::db::Database;
    use am_core::account::{NewAccount, ProviderType};

    fn acct(db: &Database) -> i64 {
        insert_account(
            db,
            &NewAccount {
                email: "sig@example.com".into(),
                display_name: "Sig".into(),
                provider_type: ProviderType::ImapPassword,
                color: None,
            },
        )
        .unwrap()
        .id
    }

    #[test]
    fn list_signatures_returns_inserted_row() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        {
            let conn = db.conn();
            conn.execute(
                "INSERT INTO signatures (account_id, name, html, is_default) VALUES (?1, ?2, ?3, ?4)",
                params![account_id, "Default", "<p>Best regards</p>", 1i64],
            )
            .unwrap();
        }
        let sigs = list_signatures(&db, account_id).unwrap();
        assert_eq!(sigs.len(), 1);
        assert_eq!(sigs[0].name, "Default");
        assert_eq!(sigs[0].html, "<p>Best regards</p>");
        assert!(sigs[0].is_default);
    }

    #[test]
    fn list_signatures_empty_when_none() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let sigs = list_signatures(&db, account_id).unwrap();
        assert!(sigs.is_empty());
    }

    #[test]
    fn create_first_signature_becomes_default() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let sig = create_signature(&db, account_id, "Work", "<p>BR</p>", false).unwrap();
        assert!(sig.is_default);
        assert_eq!(sig.name, "Work");
        let listed = list_signatures(&db, account_id).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].is_default);
    }

    #[test]
    fn create_with_make_default_unsets_previous_default() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let first = create_signature(&db, account_id, "Work", "<p>1</p>", false).unwrap();
        let second = create_signature(&db, account_id, "Casual", "<p>2</p>", true).unwrap();
        let listed = list_signatures(&db, account_id).unwrap();
        let by_id = |id: i64| listed.iter().find(|s| s.id == id).unwrap().is_default;
        assert!(!by_id(first.id));
        assert!(by_id(second.id));
    }

    #[test]
    fn create_non_default_keeps_existing_default() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let first = create_signature(&db, account_id, "Work", "<p>1</p>", false).unwrap();
        let second = create_signature(&db, account_id, "Casual", "<p>2</p>", false).unwrap();
        assert!(first.is_default);
        assert!(!second.is_default);
    }

    #[test]
    fn update_signature_changes_name_and_html() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let sig = create_signature(&db, account_id, "Work", "<p>old</p>", false).unwrap();
        update_signature(&db, sig.id, "Job", "<p>new</p>").unwrap();
        let listed = list_signatures(&db, account_id).unwrap();
        assert_eq!(listed[0].name, "Job");
        assert_eq!(listed[0].html, "<p>new</p>");
    }

    #[test]
    fn set_default_switches_between_signatures() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let first = create_signature(&db, account_id, "Work", "<p>1</p>", false).unwrap();
        let second = create_signature(&db, account_id, "Casual", "<p>2</p>", false).unwrap();
        set_default_signature(&db, account_id, second.id).unwrap();
        let listed = list_signatures(&db, account_id).unwrap();
        let by_id = |id: i64| listed.iter().find(|s| s.id == id).unwrap().is_default;
        assert!(!by_id(first.id));
        assert!(by_id(second.id));
    }

    #[test]
    fn delete_default_promotes_min_id() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let first = create_signature(&db, account_id, "Work", "<p>1</p>", false).unwrap();
        let second = create_signature(&db, account_id, "Casual", "<p>2</p>", true).unwrap();
        delete_signature(&db, second.id).unwrap();
        let listed = list_signatures(&db, account_id).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, first.id);
        assert!(listed[0].is_default);
    }

    #[test]
    fn delete_non_default_keeps_default() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let first = create_signature(&db, account_id, "Work", "<p>1</p>", false).unwrap();
        let second = create_signature(&db, account_id, "Casual", "<p>2</p>", false).unwrap();
        delete_signature(&db, second.id).unwrap();
        let listed = list_signatures(&db, account_id).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, first.id);
        assert!(listed[0].is_default);
    }

    #[test]
    fn signatures_are_isolated_per_account() {
        let db = Database::open_in_memory().unwrap();
        let a = acct(&db);
        let b = insert_account(
            &db,
            &NewAccount {
                email: "b@example.com".into(),
                display_name: "B".into(),
                provider_type: ProviderType::ImapPassword,
                color: None,
            },
        )
        .unwrap()
        .id;
        create_signature(&db, a, "A-sig", "<p>a</p>", true).unwrap();
        create_signature(&db, b, "B-sig", "<p>b</p>", true).unwrap();
        assert_eq!(list_signatures(&db, a).unwrap().len(), 1);
        assert_eq!(list_signatures(&db, b).unwrap().len(), 1);
        assert_eq!(list_signatures(&db, a).unwrap()[0].name, "A-sig");
    }
}
