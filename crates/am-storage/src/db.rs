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
    #[error("invalid data: {0}")]
    InvalidData(String),
}

pub struct Database {
    conn: Mutex<Connection>,
}

fn apply_pragmas(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.pragma_update(None, "foreign_keys", "ON")
}

impl Database {
    pub fn open_in_memory() -> Result<Self, StorageError> {
        let mut conn = Connection::open_in_memory()?;
        apply_pragmas(&conn)?;
        migrations::runner()
            .run(&mut conn)
            .map_err(|e| StorageError::Migration(e.to_string()))?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn open(path: &str) -> Result<Self, StorageError> {
        let mut conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        apply_pragmas(&conn)?;
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

    #[test]
    fn in_memory_enables_foreign_keys() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        let fk_enabled: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
            .unwrap();
        assert_eq!(fk_enabled, 1);
    }

    #[test]
    fn migration_v2_adds_sync_columns() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('folders') WHERE name IN ('highestmodseq','last_synced_at')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
        let msg_cols: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('messages') WHERE name IN ('references_hdr','in_reply_to')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(msg_cols, 2);
    }
}
