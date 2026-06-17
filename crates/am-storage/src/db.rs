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
    #[allow(dead_code)]
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

    #[allow(dead_code)]
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
