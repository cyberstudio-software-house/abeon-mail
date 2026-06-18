use rusqlite::params;

use crate::db::{Database, StorageError};

pub fn get_setting(db: &Database, key: &str) -> Result<Option<String>, StorageError> {
    let conn = db.conn();
    let value = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |row| {
            row.get::<_, String>(0)
        })
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    Ok(value)
}

pub fn set_setting(db: &Database, key: &str, value: &str) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn get_all_settings(db: &Database) -> Result<Vec<(String, String)>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key ASC")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_missing_key_returns_none() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(get_setting(&db, "appearance.theme").unwrap(), None);
    }

    #[test]
    fn set_then_get_roundtrips() {
        let db = Database::open_in_memory().unwrap();
        set_setting(&db, "appearance.theme", "dark").unwrap();
        assert_eq!(get_setting(&db, "appearance.theme").unwrap(), Some("dark".to_string()));
    }

    #[test]
    fn set_upserts_existing_key() {
        let db = Database::open_in_memory().unwrap();
        set_setting(&db, "appearance.density", "compact").unwrap();
        set_setting(&db, "appearance.density", "dense").unwrap();
        assert_eq!(get_setting(&db, "appearance.density").unwrap(), Some("dense".to_string()));
    }

    #[test]
    fn get_all_returns_every_pair_sorted() {
        let db = Database::open_in_memory().unwrap();
        set_setting(&db, "appearance.theme", "auto").unwrap();
        set_setting(&db, "appearance.accent", "#4f46e5").unwrap();
        let all = get_all_settings(&db).unwrap();
        assert_eq!(
            all,
            vec![
                ("appearance.accent".to_string(), "#4f46e5".to_string()),
                ("appearance.theme".to_string(), "auto".to_string()),
            ]
        );
    }
}
