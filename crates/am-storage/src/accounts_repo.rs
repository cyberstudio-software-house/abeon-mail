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

pub fn update_account(
    db: &Database,
    id: i64,
    display_name: &str,
    color: Option<&str>,
    settings: Option<&str>,
) -> Result<Account, StorageError> {
    {
        let conn = db.conn();
        let changed = conn.execute(
            "UPDATE accounts
             SET display_name = ?1,
                 color = COALESCE(?2, color),
                 settings = COALESCE(?3, settings)
             WHERE id = ?4",
            params![display_name, color, settings, id],
        )?;
        if changed == 0 {
            return Err(StorageError::NotFound);
        }
    }
    get_account(db, id)
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
    fn update_account_changes_name_and_settings_preserving_color() {
        let db = Database::open_in_memory().unwrap();
        let created =
            insert_account_with_settings(&db, &sample(), "user@example.com", "{\"a\":1}").unwrap();
        let updated =
            update_account(&db, created.id, "New Name", None, Some("{\"b\":2}")).unwrap();
        assert_eq!(updated.display_name, "New Name");
        assert_eq!(updated.color, created.color);
        assert_eq!(get_account_settings(&db, created.id).unwrap(), "{\"b\":2}");
    }

    #[test]
    fn update_account_keeps_settings_when_none() {
        let db = Database::open_in_memory().unwrap();
        let created =
            insert_account_with_settings(&db, &sample(), "user@example.com", "{\"a\":1}").unwrap();
        update_account(&db, created.id, "X", None, None).unwrap();
        assert_eq!(get_account_settings(&db, created.id).unwrap(), "{\"a\":1}");
    }

    #[test]
    fn update_missing_account_returns_not_found() {
        let db = Database::open_in_memory().unwrap();
        let err = update_account(&db, 999, "X", None, None).unwrap_err();
        assert!(matches!(err, StorageError::NotFound));
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
