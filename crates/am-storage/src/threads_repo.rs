use am_core::thread::ThreadSummary;
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

pub fn find_by_subject_root(db: &Database, account_id: i64, subject_root: &str) -> Result<Option<(i64, i64)>, StorageError> {
    if subject_root.is_empty() {
        return Ok(None);
    }
    let conn = db.conn();
    let result = conn.query_row(
        "SELECT id, last_date FROM threads WHERE account_id = ?1 AND subject_root = ?2 ORDER BY last_date DESC LIMIT 1",
        params![account_id, subject_root],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    );
    match result {
        Ok(pair) => Ok(Some(pair)),
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

pub fn list_for_folder(db: &Database, folder_id: i64, limit: i64, offset: i64, now: i64) -> Result<Vec<ThreadSummary>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT t.id, t.account_id, t.subject_root, t.last_date, t.message_count,
                (SELECT count(*) FROM messages WHERE thread_id = t.id AND draft = 0 AND deleted = 0 AND seen = 0
                  AND id IN (SELECT MIN(id) FROM messages WHERE thread_id = t.id AND draft = 0
                             GROUP BY COALESCE(message_id_hdr, 'id:' || id))),
                MAX(m.has_attachments), MAX(m.flagged),
                group_concat(DISTINCT COALESCE(m.from_name, m.from_address)),
                (SELECT snippet FROM messages WHERE thread_id = t.id ORDER BY date DESC LIMIT 1),
                (SELECT subject FROM messages WHERE thread_id = t.id ORDER BY date DESC LIMIT 1)
         FROM threads t
         JOIN messages m ON m.thread_id = t.id
         WHERE t.id IN (SELECT DISTINCT thread_id FROM messages
                        WHERE folder_id = ?1 AND thread_id IS NOT NULL AND draft = 0 AND deleted = 0
                          AND (snooze_wake_at IS NULL OR snooze_wake_at <= ?4))
           AND m.draft = 0
         GROUP BY t.id
         ORDER BY t.last_date DESC
         LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![folder_id, limit, offset, now], |row| {
        let participants_csv: Option<String> = row.get(8)?;
        let latest_subject: Option<String> = row.get(10)?;
        let subject_root: String = row.get(2)?;
        Ok(ThreadSummary {
            thread_id: row.get(0)?,
            account_id: row.get(1)?,
            subject: latest_subject.filter(|s| !s.is_empty()).unwrap_or(subject_root),
            last_date: row.get(3)?,
            message_count: row.get(4)?,
            unread_count: row.get(5)?,
            participants: participants_csv
                .map(|s| s.split(',').map(|p| p.to_string()).collect())
                .unwrap_or_default(),
            snippet: row.get::<_, Option<String>>(9)?.unwrap_or_default(),
            has_attachments: row.get::<_, i64>(6)? != 0,
            flagged: row.get::<_, i64>(7)? != 0,
        })
    })?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
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
        assert_eq!(found, Some((thread_id, 1000)));
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
    fn list_for_folder_groups_thread() {
        let db = Database::open_in_memory().unwrap();
        let account = crate::accounts_repo::insert_account(&db, &am_core::account::NewAccount {
            email: "t@e.com".into(), display_name: "T".into(),
            provider_type: am_core::account::ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = crate::folders_repo::upsert_folder(&db, account.id, "INBOX", "Inbox", am_core::folder::FolderType::Inbox).unwrap();
        crate::messages_repo::insert_headers(&db, folder.id, &[
            am_core::message::NewMessageHeader { uid: 1, message_id_hdr: Some("<a@x>".into()), in_reply_to: None, references_hdr: None,
                from_address: "x@e.com".into(), from_name: Some("X".into()), subject: "Hi".into(), date: 100,
                seen: true, flagged: false, has_attachments: false, size: 0, snippet: "first".into() },
            am_core::message::NewMessageHeader { uid: 2, message_id_hdr: Some("<b@x>".into()), in_reply_to: Some("<a@x>".into()), references_hdr: Some("<a@x>".into()),
                from_address: "y@e.com".into(), from_name: Some("Y".into()), subject: "Re: Hi".into(), date: 200,
                seen: false, flagged: true, has_attachments: false, size: 0, snippet: "second".into() },
        ]).unwrap();
        let tid = create(&db, account.id, "hi", 100).unwrap();
        for h in crate::messages_repo::list_by_folder(&db, folder.id, 10, 0, i64::MAX).unwrap() {
            crate::messages_repo::assign_thread(&db, h.id, tid).unwrap();
        }
        recompute(&db, tid).unwrap();
        let summaries = list_for_folder(&db, folder.id, 10, 0, i64::MAX).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].message_count, 2);
        assert_eq!(summaries[0].unread_count, 1);
        assert_eq!(summaries[0].snippet, "second");
        assert!(summaries[0].flagged);
    }

    #[test]
    fn list_for_folder_unread_count_is_dynamic_not_stale_stored() {
        let db = Database::open_in_memory().unwrap();
        let account = crate::accounts_repo::insert_account(&db, &am_core::account::NewAccount {
            email: "st@e.com".into(), display_name: "S".into(),
            provider_type: am_core::account::ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = crate::folders_repo::upsert_folder(&db, account.id, "INBOX", "Inbox", am_core::folder::FolderType::Inbox).unwrap();
        crate::messages_repo::insert_headers(&db, folder.id, &[
            am_core::message::NewMessageHeader { uid: 1, message_id_hdr: Some("<a@x>".into()), in_reply_to: None, references_hdr: None,
                from_address: "x@e.com".into(), from_name: Some("X".into()), subject: "Hi".into(), date: 100,
                seen: true, flagged: false, has_attachments: false, size: 0, snippet: "only".into() },
        ]).unwrap();
        let tid = create(&db, account.id, "hi", 100).unwrap();
        for h in crate::messages_repo::list_by_folder(&db, folder.id, 10, 0, i64::MAX).unwrap() {
            crate::messages_repo::assign_thread(&db, h.id, tid).unwrap();
        }
        {
            let conn = db.conn();
            conn.execute("UPDATE threads SET unread_count = 5 WHERE id = ?1", params![tid]).unwrap();
        }
        let summaries = list_for_folder(&db, folder.id, 10, 0, i64::MAX).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].unread_count, 0);
    }

    #[test]
    fn list_for_folder_dedupes_gmail_inbox_and_allmail_copies_for_unread() {
        let db = Database::open_in_memory().unwrap();
        let account = crate::accounts_repo::insert_account(&db, &am_core::account::NewAccount {
            email: "g@e.com".into(), display_name: "G".into(),
            provider_type: am_core::account::ProviderType::ImapPassword, color: None,
        }).unwrap();
        let inbox = crate::folders_repo::upsert_folder(&db, account.id, "INBOX", "Inbox", am_core::folder::FolderType::Inbox).unwrap();
        let allmail = crate::folders_repo::upsert_folder(&db, account.id, "[Gmail]/All", "All", am_core::folder::FolderType::Custom).unwrap();
        crate::messages_repo::insert_headers(&db, inbox.id, &[
            am_core::message::NewMessageHeader { uid: 1, message_id_hdr: Some("<dup@x>".into()), in_reply_to: None, references_hdr: None,
                from_address: "x@e.com".into(), from_name: None, subject: "Hi".into(), date: 100,
                seen: true, flagged: false, has_attachments: false, size: 0, snippet: "".into() },
        ]).unwrap();
        crate::messages_repo::insert_headers(&db, allmail.id, &[
            am_core::message::NewMessageHeader { uid: 2, message_id_hdr: Some("<dup@x>".into()), in_reply_to: None, references_hdr: None,
                from_address: "x@e.com".into(), from_name: None, subject: "Hi".into(), date: 100,
                seen: false, flagged: false, has_attachments: false, size: 0, snippet: "".into() },
        ]).unwrap();
        let tid = create(&db, account.id, "hi", 100).unwrap();
        for f in [inbox.id, allmail.id] {
            for h in crate::messages_repo::list_by_folder(&db, f, 10, 0, i64::MAX).unwrap() {
                crate::messages_repo::assign_thread(&db, h.id, tid).unwrap();
            }
        }
        let summaries = list_for_folder(&db, inbox.id, 10, 0, i64::MAX).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].unread_count, 0);
    }

    #[test]
    fn list_for_folder_hides_thread_when_all_messages_snoozed() {
        let db = Database::open_in_memory().unwrap();
        let account = crate::accounts_repo::insert_account(&db, &am_core::account::NewAccount {
            email: "th@e.com".into(), display_name: "T".into(),
            provider_type: am_core::account::ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = crate::folders_repo::upsert_folder(&db, account.id, "INBOX", "Inbox", am_core::folder::FolderType::Inbox).unwrap();
        crate::messages_repo::insert_headers(&db, folder.id, &[make_header(1, 100, "<a@x>")]).unwrap();
        let tid = create(&db, account.id, "hi", 100).unwrap();
        for h in crate::messages_repo::list_by_folder(&db, folder.id, 10, 0, 5000).unwrap() {
            crate::messages_repo::assign_thread(&db, h.id, tid).unwrap();
        }
        recompute(&db, tid).unwrap();

        let visible = list_for_folder(&db, folder.id, 10, 0, 5000).unwrap();
        assert_eq!(visible.len(), 1, "thread visible before snooze");

        db.conn().execute("UPDATE messages SET snooze_wake_at = 9000 WHERE folder_id = ?1", params![folder.id]).unwrap();
        let hidden = list_for_folder(&db, folder.id, 10, 0, 5000).unwrap();
        assert_eq!(hidden.len(), 0, "thread hidden when all messages future-snoozed");

        let woke = list_for_folder(&db, folder.id, 10, 0, 9001).unwrap();
        assert_eq!(woke.len(), 1, "thread reappears once wake time elapsed");
    }

    #[test]
    fn list_for_folder_excludes_fully_deleted_thread() {
        let db = Database::open_in_memory().unwrap();
        let account = crate::accounts_repo::insert_account(&db, &sample_account()).unwrap();
        let folder = crate::folders_repo::upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        crate::messages_repo::insert_headers(&db, folder.id, &[make_header(1, 100, "<x@e>")]).unwrap();
        let headers = crate::messages_repo::list_by_folder(&db, folder.id, 10, 0, i64::MAX).unwrap();
        let tid = create(&db, account.id, "hi", 100).unwrap();
        for h in &headers { crate::messages_repo::assign_thread(&db, h.id, tid).unwrap(); }
        assert_eq!(list_for_folder(&db, folder.id, 10, 0, i64::MAX).unwrap().len(), 1);

        crate::messages_repo::set_deleted(&db, headers[0].id, true).unwrap();
        assert_eq!(list_for_folder(&db, folder.id, 10, 0, i64::MAX).unwrap().len(), 0);
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
