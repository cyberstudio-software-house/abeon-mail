use rusqlite::params;
use crate::db::{Database, StorageError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedOp {
    pub id: i64,
    pub account_id: i64,
    pub op_type: String,
    pub payload: String,
    pub attempts: i64,
}

pub fn enqueue(db: &Database, account_id: i64, op_type: &str, payload: &str) -> Result<i64, StorageError> {
    let conn = db.conn();
    conn.execute(
        "INSERT INTO sync_queue (account_id, op_type, payload, state, attempts) VALUES (?1, ?2, ?3, 'pending', 0)",
        params![account_id, op_type, payload],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_due(db: &Database, account_id: i64, now: i64) -> Result<Vec<QueuedOp>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, account_id, op_type, payload, attempts FROM sync_queue
         WHERE account_id = ?1 AND state = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?2)
         ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![account_id, now], |row| {
        Ok(QueuedOp {
            id: row.get(0)?, account_id: row.get(1)?, op_type: row.get(2)?,
            payload: row.get(3)?, attempts: row.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

pub fn mark_done(db: &Database, id: i64) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute("DELETE FROM sync_queue WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn mark_retry(db: &Database, id: i64, next_retry_at: i64) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute(
        "UPDATE sync_queue SET attempts = attempts + 1, next_retry_at = ?2 WHERE id = ?1",
        params![id, next_retry_at],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use am_core::account::{NewAccount, ProviderType};

    fn acc(db: &Database) -> i64 {
        insert_account(db, &NewAccount {
            email: "q@e.com".into(), display_name: "Q".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap().id
    }

    #[test]
    fn enqueue_then_list_due() {
        let db = Database::open_in_memory().unwrap();
        let a = acc(&db);
        enqueue(&db, a, "set_flag", "{}").unwrap();
        assert_eq!(list_due(&db, a, 0).unwrap().len(), 1);
    }

    #[test]
    fn retry_hides_until_time() {
        let db = Database::open_in_memory().unwrap();
        let a = acc(&db);
        let id = enqueue(&db, a, "set_flag", "{}").unwrap();
        mark_retry(&db, id, 500).unwrap();
        assert!(list_due(&db, a, 100).unwrap().is_empty());
        assert_eq!(list_due(&db, a, 600).unwrap().len(), 1);
    }

    #[test]
    fn done_removes_row() {
        let db = Database::open_in_memory().unwrap();
        let a = acc(&db);
        let id = enqueue(&db, a, "set_flag", "{}").unwrap();
        mark_done(&db, id).unwrap();
        assert!(list_due(&db, a, 0).unwrap().is_empty());
    }
}
