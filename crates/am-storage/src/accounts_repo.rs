use am_core::account::{Account, NewAccount, ProviderType};
use rusqlite::params;

use crate::db::{Database, StorageError};


fn row_to_account(row: &rusqlite::Row) -> rusqlite::Result<(i64, String, String, String, Option<String>, i64)> {
    Ok((
        row.get::<_, i64>(0)?,
        row.get::<_, String>(1)?,
        row.get::<_, String>(2)?,
        row.get::<_, String>(3)?,
        row.get::<_, Option<String>>(4)?,
        row.get::<_, i64>(5)?,
    ))
}

fn tuple_to_account(
    (id, email, display_name, provider, color, position): (i64, String, String, String, Option<String>, i64),
) -> Result<Account, StorageError> {
    Ok(Account {
        id,
        email,
        display_name,
        provider_type: ProviderType::from_db_str(&provider)
            .ok_or_else(|| StorageError::InvalidData(format!("unknown provider type: {provider}")))?,
        color,
        position,
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

pub fn get_account(db: &Database, id: i64) -> Result<Account, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT id, email, display_name, provider_type, color, position
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
        "SELECT id, email, display_name, provider_type, color, position
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
}
