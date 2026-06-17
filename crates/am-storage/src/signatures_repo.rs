use am_core::signature::Signature;
use rusqlite::params;

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
}
