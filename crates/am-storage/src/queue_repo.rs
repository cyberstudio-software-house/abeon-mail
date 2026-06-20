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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendErrorRow {
    pub id: i64,
    pub account_id: i64,
    pub payload: String,
    pub attempts: i64,
    pub state: String,
    pub last_error: String,
}

pub fn enqueue(db: &Database, account_id: i64, op_type: &str, payload: &str) -> Result<i64, StorageError> {
    let conn = db.conn();
    conn.execute(
        "INSERT INTO sync_queue (account_id, op_type, payload, state, attempts) VALUES (?1, ?2, ?3, 'pending', 0)",
        params![account_id, op_type, payload],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn enqueue_at(db: &Database, account_id: i64, op_type: &str, payload: &str, next_retry_at: i64) -> Result<i64, StorageError> {
    let conn = db.conn();
    conn.execute(
        "INSERT INTO sync_queue (account_id, op_type, payload, state, attempts, next_retry_at) VALUES (?1, ?2, ?3, 'pending', 0, ?4)",
        params![account_id, op_type, payload, next_retry_at],
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

pub fn list_pending_by_type(db: &Database, account_id: i64, op_type: &str) -> Result<Vec<QueuedOp>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, account_id, op_type, payload, attempts FROM sync_queue
         WHERE account_id = ?1 AND op_type = ?2 AND state = 'pending' ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![account_id, op_type], |row| {
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

pub fn mark_retry(db: &Database, id: i64, next_retry_at: i64, last_error: Option<&str>) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute(
        "UPDATE sync_queue SET attempts = attempts + 1, next_retry_at = ?2, last_error = ?3 WHERE id = ?1",
        params![id, next_retry_at, last_error],
    )?;
    Ok(())
}

pub fn mark_failed(db: &Database, id: i64, last_error: &str) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute(
        "UPDATE sync_queue SET state = 'failed', attempts = attempts + 1, last_error = ?2 WHERE id = ?1",
        params![id, last_error],
    )?;
    Ok(())
}

pub fn reset_for_retry(db: &Database, id: i64) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute(
        "UPDATE sync_queue SET state = 'pending', attempts = 0, next_retry_at = NULL, last_error = NULL WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn list_send_errors(db: &Database, account_id: i64) -> Result<Vec<SendErrorRow>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, account_id, payload, attempts, state, last_error FROM sync_queue
         WHERE account_id = ?1 AND op_type = 'send_message' AND last_error IS NOT NULL
         ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![account_id], |row| {
        Ok(SendErrorRow {
            id: row.get(0)?,
            account_id: row.get(1)?,
            payload: row.get(2)?,
            attempts: row.get(3)?,
            state: row.get(4)?,
            last_error: row.get(5)?,
        })
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
        mark_retry(&db, id, 500, None).unwrap();
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

    #[test]
    fn mark_failed_keeps_row_with_error_and_hides_from_due() {
        let db = Database::open_in_memory().unwrap();
        let a = acc(&db);
        let id = enqueue(&db, a, "send_message", "{\"draft_id\":1}").unwrap();
        mark_failed(&db, id, "connection failed: 465").unwrap();
        assert!(list_due(&db, a, 0).unwrap().is_empty());
        let errors = list_send_errors(&db, a).unwrap();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].id, id);
        assert_eq!(errors[0].state, "failed");
        assert_eq!(errors[0].last_error, "connection failed: 465");
        assert_eq!(errors[0].attempts, 1);
    }

    #[test]
    fn mark_retry_records_last_error() {
        let db = Database::open_in_memory().unwrap();
        let a = acc(&db);
        let id = enqueue(&db, a, "send_message", "{\"draft_id\":1}").unwrap();
        mark_retry(&db, id, 500, Some("temporary failure")).unwrap();
        let errors = list_send_errors(&db, a).unwrap();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].state, "pending");
        assert_eq!(errors[0].last_error, "temporary failure");
        assert_eq!(errors[0].attempts, 1);
    }

    #[test]
    fn list_send_errors_returns_only_send_with_error() {
        let db = Database::open_in_memory().unwrap();
        let a = acc(&db);
        enqueue(&db, a, "set_flag", "{}").unwrap();
        let pending_send = enqueue(&db, a, "send_message", "{\"draft_id\":1}").unwrap();
        let failed_send = enqueue(&db, a, "send_message", "{\"draft_id\":2}").unwrap();
        mark_failed(&db, failed_send, "boom").unwrap();
        let errors = list_send_errors(&db, a).unwrap();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].id, failed_send);
        assert_ne!(errors[0].id, pending_send);
    }

    #[test]
    fn reset_for_retry_requeues_and_clears_error() {
        let db = Database::open_in_memory().unwrap();
        let a = acc(&db);
        let id = enqueue(&db, a, "send_message", "{\"draft_id\":1}").unwrap();
        mark_failed(&db, id, "boom").unwrap();
        reset_for_retry(&db, id).unwrap();
        assert_eq!(list_due(&db, a, 0).unwrap().len(), 1);
        assert!(list_send_errors(&db, a).unwrap().is_empty());
    }

    #[test]
    fn enqueue_at_delays_until_due() {
        let db = Database::open_in_memory().unwrap();
        let a = acc(&db);
        enqueue_at(&db, a, "move_message", "{}", 500).unwrap();
        assert!(list_due(&db, a, 100).unwrap().is_empty());
        assert_eq!(list_due(&db, a, 600).unwrap().len(), 1);
    }

    #[test]
    fn list_pending_by_type_filters() {
        let db = Database::open_in_memory().unwrap();
        let a = acc(&db);
        enqueue(&db, a, "set_flag", "{}").unwrap();
        let mv = enqueue_at(&db, a, "move_message", "{\"message_id\":7}", 0).unwrap();
        let pending = list_pending_by_type(&db, a, "move_message").unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, mv);
    }
}
