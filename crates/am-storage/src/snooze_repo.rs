use am_core::smart::SmartMessageRow;
use rusqlite::params;

use crate::db::{Database, StorageError};

pub fn snooze_messages(db: &Database, ids: &[i64], wake_at: i64) -> Result<(), StorageError> {
    if ids.is_empty() {
        return Ok(());
    }
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    {
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("UPDATE messages SET snooze_wake_at = ? WHERE id IN ({placeholders})");
        let mut stmt = tx.prepare(&sql)?;
        let mut bind: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(ids.len() + 1);
        bind.push(&wake_at);
        for id in ids {
            bind.push(id);
        }
        stmt.execute(bind.as_slice())?;
    }
    tx.commit()?;
    Ok(())
}

pub fn unsnooze_messages(db: &Database, ids: &[i64]) -> Result<(), StorageError> {
    if ids.is_empty() {
        return Ok(());
    }
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    {
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("UPDATE messages SET snooze_wake_at = NULL WHERE id IN ({placeholders})");
        let mut stmt = tx.prepare(&sql)?;
        let bind: Vec<&dyn rusqlite::ToSql> = ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        stmt.execute(bind.as_slice())?;
    }
    tx.commit()?;
    Ok(())
}

pub fn list_snoozed(
    db: &Database,
    now: i64,
    limit: i64,
    offset: i64,
) -> Result<Vec<SmartMessageRow>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT m.id, m.account_id, m.folder_id, a.color,
                m.from_address, m.from_name, m.subject, m.date,
                m.seen, m.flagged, m.has_attachments, m.snippet, m.snooze_wake_at
         FROM messages m
         JOIN accounts a ON a.id = m.account_id
         WHERE m.snooze_wake_at IS NOT NULL
           AND m.snooze_wake_at > ?1
           AND m.draft = 0
           AND m.deleted = 0
         ORDER BY m.snooze_wake_at ASC
         LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![now, limit, offset], |row| {
        Ok(SmartMessageRow {
            message_id: row.get(0)?,
            account_id: row.get(1)?,
            folder_id: row.get(2)?,
            account_color: row.get(3)?,
            from_address: row.get(4)?,
            from_name: row.get(5)?,
            subject: row.get(6)?,
            date: row.get(7)?,
            seen: row.get::<_, i64>(8)? != 0,
            flagged: row.get::<_, i64>(9)? != 0,
            has_attachments: row.get::<_, i64>(10)? != 0,
            snippet: row.get(11)?,
            snooze_wake_at: row.get(12)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn wake_due(db: &Database, now: i64) -> Result<i64, StorageError> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let thread_ids: Vec<i64> = {
        let mut stmt = tx.prepare(
            "SELECT DISTINCT thread_id FROM messages
             WHERE snooze_wake_at IS NOT NULL AND snooze_wake_at <= ?1 AND thread_id IS NOT NULL",
        )?;
        let rows = stmt.query_map(params![now], |r| r.get::<_, i64>(0))?;
        let mut v = Vec::new();
        for r in rows {
            v.push(r?);
        }
        v
    };
    let count = tx.execute(
        "UPDATE messages SET snooze_wake_at = NULL, seen = 0
         WHERE snooze_wake_at IS NOT NULL AND snooze_wake_at <= ?1",
        params![now],
    )?;
    for tid in &thread_ids {
        tx.execute(
            "UPDATE threads SET unread_count =
                (SELECT count(*) FROM messages WHERE thread_id = ?1 AND seen = 0)
             WHERE id = ?1",
            params![tid],
        )?;
    }
    tx.commit()?;
    Ok(count as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use crate::folders_repo::upsert_folder;
    use crate::messages_repo::insert_headers;
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::NewMessageHeader;

    fn setup(db: &Database) -> i64 {
        let acc = insert_account(db, &NewAccount {
            email: "s@e.com".into(), display_name: "S".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap();
        upsert_folder(db, acc.id, "INBOX", "Inbox", FolderType::Inbox).unwrap().id
    }

    fn header(uid: i64) -> NewMessageHeader {
        NewMessageHeader {
            uid, message_id_hdr: Some(format!("<m{uid}@x>")), in_reply_to: None, references_hdr: None,
            from_address: "a@b.c".into(), from_name: None, subject: format!("S{uid}"), date: 1000,
            seen: true, flagged: false, has_attachments: false, size: 0, snippet: String::new(),
        }
    }

    fn wake_of(db: &Database, msg_id: i64) -> Option<i64> {
        db.conn().query_row(
            "SELECT snooze_wake_at FROM messages WHERE id = ?1",
            params![msg_id], |r| r.get(0),
        ).unwrap()
    }

    fn ids_for(db: &Database) -> Vec<i64> {
        let conn = db.conn();
        let mut stmt = conn.prepare("SELECT id FROM messages ORDER BY uid").unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, i64>(0)).unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    #[test]
    fn snooze_then_unsnooze_sets_and_clears_wake_at() {
        let db = Database::open_in_memory().unwrap();
        let folder = setup(&db);
        insert_headers(&db, folder, &[header(1)]).unwrap();
        let id: i64 = db.conn().query_row("SELECT id FROM messages WHERE uid = 1", [], |r| r.get(0)).unwrap();

        snooze_messages(&db, &[id], 5000).unwrap();
        assert_eq!(wake_of(&db, id), Some(5000));

        unsnooze_messages(&db, &[id]).unwrap();
        assert_eq!(wake_of(&db, id), None);
    }

    #[test]
    fn snooze_empty_ids_is_noop() {
        let db = Database::open_in_memory().unwrap();
        snooze_messages(&db, &[], 5000).unwrap();
        unsnooze_messages(&db, &[]).unwrap();
    }

    #[test]
    fn snooze_does_not_change_seen() {
        let db = Database::open_in_memory().unwrap();
        let folder = setup(&db);
        insert_headers(&db, folder, &[header(1)]).unwrap();
        let id: i64 = db.conn().query_row("SELECT id FROM messages WHERE uid = 1", [], |r| r.get(0)).unwrap();
        snooze_messages(&db, &[id], 5000).unwrap();
        let seen: i64 = db.conn().query_row("SELECT seen FROM messages WHERE id = ?1", params![id], |r| r.get(0)).unwrap();
        assert_eq!(seen, 1, "snooze must not touch seen");
    }

    #[test]
    fn list_snoozed_returns_future_only_sorted_ascending() {
        let db = Database::open_in_memory().unwrap();
        let folder = setup(&db);
        insert_headers(&db, folder, &[header(1), header(2), header(3)]).unwrap();
        let ids = ids_for(&db);
        snooze_messages(&db, &[ids[0]], 9000).unwrap();
        snooze_messages(&db, &[ids[1]], 7000).unwrap();
        snooze_messages(&db, &[ids[2]], 1000).unwrap();

        let rows: Vec<SmartMessageRow> = list_snoozed(&db, 5000, 10, 0).unwrap();
        assert_eq!(rows.len(), 2, "the elapsed one (1000) is excluded");
        assert_eq!(rows[0].snooze_wake_at, Some(7000), "ascending by wake time");
        assert_eq!(rows[1].snooze_wake_at, Some(9000));
    }

    #[test]
    fn wake_due_clears_and_marks_unread_and_counts() {
        let db = Database::open_in_memory().unwrap();
        let folder = setup(&db);
        insert_headers(&db, folder, &[header(1), header(2)]).unwrap();
        let ids = ids_for(&db);
        snooze_messages(&db, &[ids[0]], 1000).unwrap();
        snooze_messages(&db, &[ids[1]], 9000).unwrap();

        let count = wake_due(&db, 5000).unwrap();
        assert_eq!(count, 1, "only the elapsed message wakes");

        let conn = db.conn();
        let (wake0, seen0): (Option<i64>, i64) = conn.query_row(
            "SELECT snooze_wake_at, seen FROM messages WHERE id = ?1", params![ids[0]],
            |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(wake0, None);
        assert_eq!(seen0, 0, "woken message is marked unread");

        let wake1: Option<i64> = conn.query_row(
            "SELECT snooze_wake_at FROM messages WHERE id = ?1", params![ids[1]], |r| r.get(0)).unwrap();
        assert_eq!(wake1, Some(9000), "future message stays snoozed");
    }

    #[test]
    fn wake_due_recomputes_thread_unread_count() {
        let db = Database::open_in_memory().unwrap();
        let folder = setup(&db);
        insert_headers(&db, folder, &[header(1)]).unwrap();
        let ids = ids_for(&db);
        let tid = crate::threads_repo::create(&db, 1, "t", 1000).unwrap();
        crate::messages_repo::assign_thread(&db, ids[0], tid).unwrap();
        crate::threads_repo::recompute(&db, tid).unwrap();
        snooze_messages(&db, &[ids[0]], 1000).unwrap();

        wake_due(&db, 5000).unwrap();

        let unread: i64 = db.conn().query_row(
            "SELECT unread_count FROM threads WHERE id = ?1", params![tid], |r| r.get(0)).unwrap();
        assert_eq!(unread, 1, "thread unread_count reflects the now-unread woken message");
    }
}
