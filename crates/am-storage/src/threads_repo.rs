use rusqlite::params;
use crate::db::{Database, StorageError};

pub fn find_by_message_ids(db: &Database, account_id: i64, ids: &[String]) -> Result<Option<i64>, StorageError> {
    if ids.is_empty() {
        return Ok(None);
    }
    let conn = db.conn();
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT thread_id FROM messages
         WHERE account_id = ? AND thread_id IS NOT NULL AND message_id_hdr IN ({placeholders})
         ORDER BY date DESC LIMIT 1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut bind: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(ids.len() + 1);
    bind.push(&account_id);
    for id in ids {
        bind.push(id);
    }
    let result = stmt.query_row(bind.as_slice(), |row| row.get::<_, i64>(0));
    match result {
        Ok(id) => Ok(Some(id)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(StorageError::Sqlite(e)),
    }
}

pub fn find_by_subject_root(db: &Database, account_id: i64, subject_root: &str) -> Result<Option<i64>, StorageError> {
    if subject_root.is_empty() {
        return Ok(None);
    }
    let conn = db.conn();
    let result = conn.query_row(
        "SELECT id FROM threads WHERE account_id = ?1 AND subject_root = ?2 ORDER BY last_date DESC LIMIT 1",
        params![account_id, subject_root],
        |row| row.get::<_, i64>(0),
    );
    match result {
        Ok(id) => Ok(Some(id)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(StorageError::Sqlite(e)),
    }
}

pub fn create(db: &Database, account_id: i64, subject_root: &str, last_date: i64) -> Result<i64, StorageError> {
    let conn = db.conn();
    conn.execute(
        "INSERT INTO threads (account_id, subject_root, last_date) VALUES (?1, ?2, ?3)",
        params![account_id, subject_root, last_date],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn recompute(db: &Database, thread_id: i64) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute(
        "UPDATE threads SET
            last_date = COALESCE((SELECT MAX(date) FROM messages WHERE thread_id = ?1), last_date),
            message_count = (SELECT count(*) FROM messages WHERE thread_id = ?1),
            unread_count = (SELECT count(*) FROM messages WHERE thread_id = ?1 AND seen = 0)
         WHERE id = ?1",
        params![thread_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use crate::folders_repo::upsert_folder;
    use crate::messages_repo::{insert_headers, assign_thread};
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::NewMessageHeader;

    fn sample_account() -> NewAccount {
        NewAccount {
            email: "threads@example.com".into(),
            display_name: "Threads".into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        }
    }

    fn make_header(uid: i64, date: i64, message_id: &str) -> NewMessageHeader {
        NewMessageHeader {
            uid,
            message_id_hdr: Some(message_id.to_string()),
            in_reply_to: None,
            references_hdr: None,
            from_address: "sender@example.com".into(),
            from_name: Some("Sender".into()),
            subject: format!("Subject {uid}"),
            date,
            seen: false,
            flagged: false,
            has_attachments: false,
            size: 512,
            snippet: String::new(),
        }
    }

    fn setup(db: &Database) -> (i64, i64) {
        let account = insert_account(db, &sample_account()).unwrap();
        let folder_id = upsert_folder(db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap().id;
        (account.id, folder_id)
    }

    #[test]
    fn create_and_find_by_subject_root() {
        let db = Database::open_in_memory().unwrap();
        let (account_id, _) = setup(&db);
        let thread_id = create(&db, account_id, "hello world", 1000).unwrap();
        let found = find_by_subject_root(&db, account_id, "hello world").unwrap();
        assert_eq!(found, Some(thread_id));
    }

    #[test]
    fn find_by_subject_root_empty_returns_none() {
        let db = Database::open_in_memory().unwrap();
        let (account_id, _) = setup(&db);
        let result = find_by_subject_root(&db, account_id, "").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn find_by_message_ids_empty_returns_none() {
        let db = Database::open_in_memory().unwrap();
        let (account_id, _) = setup(&db);
        let result = find_by_message_ids(&db, account_id, &[]).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn find_by_message_ids_matches_threaded_message() {
        let db = Database::open_in_memory().unwrap();
        let (account_id, folder_id) = setup(&db);
        insert_headers(&db, folder_id, &[make_header(1, 100, "<parent@example.com>")]).unwrap();
        let thread_id = create(&db, account_id, "project", 100).unwrap();
        let conn = db.conn();
        conn.execute(
            "UPDATE messages SET thread_id = ?1 WHERE message_id_hdr = ?2",
            params![thread_id, "<parent@example.com>"],
        ).unwrap();
        drop(conn);
        let ids = vec!["<parent@example.com>".to_string()];
        let found = find_by_message_ids(&db, account_id, &ids).unwrap();
        assert_eq!(found, Some(thread_id));
    }

    #[test]
    fn recompute_updates_counts_and_last_date() {
        let db = Database::open_in_memory().unwrap();
        let (account_id, folder_id) = setup(&db);
        let thread_id = create(&db, account_id, "test", 500).unwrap();
        insert_headers(&db, folder_id, &[make_header(1, 300, "<m1@x>"), make_header(2, 700, "<m2@x>")]).unwrap();
        {
            let conn = db.conn();
            conn.execute("UPDATE messages SET thread_id = ?1", params![thread_id]).unwrap();
        }
        recompute(&db, thread_id).unwrap();
        let conn = db.conn();
        let (last_date, msg_count, unread): (i64, i64, i64) = conn.query_row(
            "SELECT last_date, message_count, unread_count FROM threads WHERE id = ?1",
            params![thread_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(last_date, 700);
        assert_eq!(msg_count, 2);
        assert_eq!(unread, 2);
    }

    #[test]
    fn assign_thread_then_find_by_message_ids() {
        let db = Database::open_in_memory().unwrap();
        let (account_id, folder_id) = setup(&db);
        insert_headers(&db, folder_id, &[make_header(10, 100, "<root@example.com>")]).unwrap();
        let conn = db.conn();
        let msg_id: i64 = conn.query_row(
            "SELECT id FROM messages WHERE message_id_hdr = ?1",
            params!["<root@example.com>"],
            |row| row.get(0),
        ).unwrap();
        drop(conn);
        let thread_id = create(&db, account_id, "root subject", 100).unwrap();
        assign_thread(&db, msg_id, thread_id).unwrap();
        let ids = vec!["<root@example.com>".to_string()];
        let found = find_by_message_ids(&db, account_id, &ids).unwrap();
        assert_eq!(found, Some(thread_id));
    }
}
