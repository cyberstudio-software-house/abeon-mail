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
    fn migration_v3_adds_msgid_index() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='idx_messages_msgid'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
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

    #[test]
    fn migration_v4_adds_bcc_column() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('messages') WHERE name = 'bcc_addresses'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn migration_v7_search_fts_is_stored_and_roundtrips() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        conn.execute(
            "INSERT INTO search_fts (rowid, subject, from_address, to_addresses, body_text, attachment_names)
             VALUES (1, 'Quarterly report', 'alice@example.com', '[]', 'hello world', '')",
            [],
        )
        .unwrap();
        let subject: String = conn
            .query_row("SELECT subject FROM search_fts WHERE rowid = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(subject, "Quarterly report");

        let trigger_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name='messages_ad_fts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(trigger_count, 1);
    }

    #[test]
    fn migration_v13_adds_backfill_and_body_state_index() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        let col: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('folders') WHERE name = 'backfill_complete'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(col, 1);
        let idx: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='idx_messages_body_state'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx, 1);
    }

    #[test]
    fn migration_v14_adds_is_html_column() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('signatures') WHERE name='is_html'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn messages_table_has_answered_column() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('messages') WHERE name='answered'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
}
