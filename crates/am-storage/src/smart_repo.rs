use am_core::smart::{SmartFolderKind, SmartMessageRow};
use rusqlite::params;

use crate::db::{Database, StorageError};

pub fn list_smart_folder(
    db: &Database,
    kind: SmartFolderKind,
    limit: i64,
    offset: i64,
    now: i64,
) -> Result<Vec<SmartMessageRow>, StorageError> {
    match kind {
        SmartFolderKind::AllInboxes => list_all_inboxes(db, limit, offset, now),
        SmartFolderKind::Unread => list_unread(db, limit, offset, now),
        SmartFolderKind::Flagged => list_flagged(db, limit, offset, now),
        SmartFolderKind::Snoozed => crate::snooze_repo::list_snoozed(db, now, limit, offset),
    }
}

pub(crate) fn row_to_smart(row: &rusqlite::Row) -> rusqlite::Result<SmartMessageRow> {
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
        snooze_wake_at: None,
    })
}

fn list_all_inboxes(db: &Database, limit: i64, offset: i64, now: i64) -> Result<Vec<SmartMessageRow>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT m.id, m.account_id, m.folder_id, a.color,
                m.from_address, m.from_name, m.subject, m.date,
                m.seen, m.flagged, m.has_attachments, m.snippet
         FROM messages m
         JOIN folders f ON f.id = m.folder_id
         JOIN accounts a ON a.id = m.account_id
         WHERE f.folder_type = 'inbox'
           AND m.draft = 0
           AND m.deleted = 0
           AND (m.snooze_wake_at IS NULL OR m.snooze_wake_at <= ?3)
         ORDER BY m.date DESC
         LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt.query_map(params![limit, offset, now], row_to_smart)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn list_unread(db: &Database, limit: i64, offset: i64, now: i64) -> Result<Vec<SmartMessageRow>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT m.id, m.account_id, m.folder_id, a.color,
                m.from_address, m.from_name, m.subject, m.date,
                m.seen, m.flagged, m.has_attachments, m.snippet
         FROM messages m
         JOIN folders f ON f.id = m.folder_id
         JOIN accounts a ON a.id = m.account_id
         WHERE m.seen = 0
           AND f.folder_type NOT IN ('trash', 'spam')
           AND m.draft = 0
           AND m.deleted = 0
           AND (m.snooze_wake_at IS NULL OR m.snooze_wake_at <= ?3)
         ORDER BY m.date DESC
         LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt.query_map(params![limit, offset, now], row_to_smart)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn list_flagged(db: &Database, limit: i64, offset: i64, now: i64) -> Result<Vec<SmartMessageRow>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT m.id, m.account_id, m.folder_id, a.color,
                m.from_address, m.from_name, m.subject, m.date,
                m.seen, m.flagged, m.has_attachments, m.snippet
         FROM messages m
         JOIN folders f ON f.id = m.folder_id
         JOIN accounts a ON a.id = m.account_id
         WHERE m.flagged = 1
           AND f.folder_type NOT IN ('trash', 'spam')
           AND m.draft = 0
           AND m.deleted = 0
           AND (m.snooze_wake_at IS NULL OR m.snooze_wake_at <= ?3)
         ORDER BY m.date DESC
         LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt.query_map(params![limit, offset, now], row_to_smart)?;
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
    use crate::folders_repo::upsert_folder;
    use crate::messages_repo::insert_headers;
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::NewMessageHeader;

    fn make_account(db: &Database, email: &str, color: Option<&str>) -> i64 {
        insert_account(
            db,
            &NewAccount {
                email: email.into(),
                display_name: email.into(),
                provider_type: ProviderType::ImapPassword,
                color: color.map(|s| s.to_string()),
            },
        )
        .unwrap()
        .id
    }

    fn make_folder(db: &Database, account_id: i64, name: &str, ft: FolderType) -> i64 {
        upsert_folder(db, account_id, name, name, ft).unwrap().id
    }

    fn make_msg(uid: i64, date: i64, seen: bool, flagged: bool, _draft: bool, _deleted: bool) -> NewMessageHeader {
        NewMessageHeader {
            uid,
            message_id_hdr: Some(format!("<msg-{uid}@example.com>")),
            in_reply_to: None,
            references_hdr: None,
            from_address: "sender@example.com".into(),
            from_name: Some("Sender".into()),
            subject: format!("Subject {uid}"),
            date,
            seen,
            flagged,
            has_attachments: false,
            size: 512,
            snippet: "preview".into(),
        }
    }

    fn raw_insert_flags(db: &Database, folder_id: i64, uid: i64, draft: bool, deleted: bool) {
        let conn = db.conn();
        conn.execute(
            "UPDATE messages SET draft = ?3, deleted = ?4 WHERE folder_id = ?1 AND uid = ?2",
            params![folder_id, uid, draft as i64, deleted as i64],
        )
        .unwrap();
    }

    #[test]
    fn all_inboxes_cross_account_ordered_date_desc() {
        let db = Database::open_in_memory().unwrap();

        let acc1 = make_account(&db, "a@example.com", Some("#ff0000"));
        let acc2 = make_account(&db, "b@example.com", Some("#00ff00"));

        let inbox1 = make_folder(&db, acc1, "INBOX", FolderType::Inbox);
        let inbox2 = make_folder(&db, acc2, "INBOX", FolderType::Inbox);

        insert_headers(&db, inbox1, &[make_msg(1, 1000, false, false, false, false)]).unwrap();
        insert_headers(&db, inbox2, &[make_msg(2, 3000, false, false, false, false)]).unwrap();
        insert_headers(&db, inbox1, &[make_msg(3, 2000, false, false, false, false)]).unwrap();

        let rows = list_smart_folder(&db, SmartFolderKind::AllInboxes, 10, 0, i64::MAX).unwrap();

        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].date, 3000, "first row should be most recent");
        assert_eq!(rows[1].date, 2000);
        assert_eq!(rows[2].date, 1000);

        let row_acc2 = rows.iter().find(|r| r.date == 3000).unwrap();
        assert_eq!(row_acc2.account_id, acc2);
        assert_eq!(row_acc2.account_color.as_deref(), Some("#00ff00"));

        let row_acc1_2000 = rows.iter().find(|r| r.date == 2000).unwrap();
        assert_eq!(row_acc1_2000.account_id, acc1);
        assert_eq!(row_acc1_2000.account_color.as_deref(), Some("#ff0000"));
    }

    #[test]
    fn all_inboxes_excludes_non_inbox_folders() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "c@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        let sent = make_folder(&db, acc, "Sent", FolderType::Sent);

        insert_headers(&db, inbox, &[make_msg(1, 1000, false, false, false, false)]).unwrap();
        insert_headers(&db, sent, &[make_msg(2, 2000, false, false, false, false)]).unwrap();

        let rows = list_smart_folder(&db, SmartFolderKind::AllInboxes, 10, 0, i64::MAX).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].date, 1000);
    }

    #[test]
    fn all_inboxes_pagination() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "d@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);

        insert_headers(
            &db,
            inbox,
            &[
                make_msg(1, 1000, false, false, false, false),
                make_msg(2, 3000, false, false, false, false),
                make_msg(3, 2000, false, false, false, false),
            ],
        )
        .unwrap();

        let page1 = list_smart_folder(&db, SmartFolderKind::AllInboxes, 2, 0, i64::MAX).unwrap();
        let page2 = list_smart_folder(&db, SmartFolderKind::AllInboxes, 2, 2, i64::MAX).unwrap();
        assert_eq!(page1.len(), 2);
        assert_eq!(page2.len(), 1);
        assert_eq!(page1[0].date, 3000);
        assert_eq!(page2[0].date, 1000);
    }

    #[test]
    fn all_inboxes_excludes_draft_and_deleted() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "e@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);

        insert_headers(
            &db,
            inbox,
            &[
                make_msg(1, 1000, false, false, false, false),
                make_msg(2, 2000, false, false, false, false),
                make_msg(3, 3000, false, false, false, false),
            ],
        )
        .unwrap();

        raw_insert_flags(&db, inbox, 2, true, false);
        raw_insert_flags(&db, inbox, 3, false, true);

        let rows = list_smart_folder(&db, SmartFolderKind::AllInboxes, 10, 0, i64::MAX).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].message_id > 0, true);
        assert_eq!(rows[0].date, 1000);
    }

    #[test]
    fn unread_excludes_trash_and_spam() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "f@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        let trash = make_folder(&db, acc, "Trash", FolderType::Trash);
        let spam = make_folder(&db, acc, "Spam", FolderType::Spam);

        insert_headers(&db, inbox, &[make_msg(1, 1000, false, false, false, false)]).unwrap();
        insert_headers(&db, trash, &[make_msg(2, 2000, false, false, false, false)]).unwrap();
        insert_headers(&db, spam, &[make_msg(3, 3000, false, false, false, false)]).unwrap();

        let rows = list_smart_folder(&db, SmartFolderKind::Unread, 10, 0, i64::MAX).unwrap();
        assert_eq!(rows.len(), 1, "only inbox unseen message should appear");
        assert_eq!(rows[0].date, 1000);
    }

    #[test]
    fn unread_excludes_seen_messages() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "g@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);

        insert_headers(&db, inbox, &[
            make_msg(1, 1000, true, false, false, false),
            make_msg(2, 2000, false, false, false, false),
        ]).unwrap();

        let rows = list_smart_folder(&db, SmartFolderKind::Unread, 10, 0, i64::MAX).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].date, 2000);
        assert!(!rows[0].seen);
    }

    #[test]
    fn unread_excludes_draft_and_deleted() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "h@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);

        insert_headers(&db, inbox, &[
            make_msg(1, 1000, false, false, false, false),
            make_msg(2, 2000, false, false, false, false),
            make_msg(3, 3000, false, false, false, false),
        ]).unwrap();
        raw_insert_flags(&db, inbox, 2, true, false);
        raw_insert_flags(&db, inbox, 3, false, true);

        let rows = list_smart_folder(&db, SmartFolderKind::Unread, 10, 0, i64::MAX).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].date, 1000);
    }

    #[test]
    fn flagged_excludes_trash_and_spam() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "i@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        let trash = make_folder(&db, acc, "Trash", FolderType::Trash);
        let spam = make_folder(&db, acc, "Spam", FolderType::Spam);

        insert_headers(&db, inbox, &[make_msg(1, 1000, false, true, false, false)]).unwrap();
        insert_headers(&db, trash, &[make_msg(2, 2000, false, true, false, false)]).unwrap();
        insert_headers(&db, spam, &[make_msg(3, 3000, false, true, false, false)]).unwrap();

        let rows = list_smart_folder(&db, SmartFolderKind::Flagged, 10, 0, i64::MAX).unwrap();
        assert_eq!(rows.len(), 1, "only inbox flagged message should appear");
        assert_eq!(rows[0].date, 1000);
    }

    #[test]
    fn flagged_excludes_unflagged_messages() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "j@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);

        insert_headers(&db, inbox, &[
            make_msg(1, 1000, false, false, false, false),
            make_msg(2, 2000, false, true, false, false),
        ]).unwrap();

        let rows = list_smart_folder(&db, SmartFolderKind::Flagged, 10, 0, i64::MAX).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].date, 2000);
        assert!(rows[0].flagged);
    }

    #[test]
    fn flagged_excludes_draft_and_deleted() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "k@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);

        insert_headers(&db, inbox, &[
            make_msg(1, 1000, false, true, false, false),
            make_msg(2, 2000, false, true, false, false),
            make_msg(3, 3000, false, true, false, false),
        ]).unwrap();
        raw_insert_flags(&db, inbox, 2, true, false);
        raw_insert_flags(&db, inbox, 3, false, true);

        let rows = list_smart_folder(&db, SmartFolderKind::Flagged, 10, 0, i64::MAX).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].date, 1000);
    }

    #[test]
    fn unread_cross_account_ordered_date_desc() {
        let db = Database::open_in_memory().unwrap();

        let acc1 = make_account(&db, "m@example.com", Some("#aa0000"));
        let acc2 = make_account(&db, "n@example.com", Some("#0000bb"));

        let inbox1 = make_folder(&db, acc1, "INBOX", FolderType::Inbox);
        let inbox2 = make_folder(&db, acc2, "INBOX", FolderType::Inbox);

        insert_headers(&db, inbox1, &[make_msg(1, 1000, false, false, false, false)]).unwrap();
        insert_headers(&db, inbox2, &[make_msg(2, 5000, false, false, false, false)]).unwrap();

        let rows = list_smart_folder(&db, SmartFolderKind::Unread, 10, 0, i64::MAX).unwrap();

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].date, 5000);
        assert_eq!(rows[1].date, 1000);
        assert_eq!(rows[0].account_id, acc2);
        assert_eq!(rows[1].account_id, acc1);
        assert!(!rows[0].seen);
        assert!(!rows[1].seen);
    }

    #[test]
    fn flagged_cross_account_ordered_date_desc() {
        let db = Database::open_in_memory().unwrap();

        let acc1 = make_account(&db, "o@example.com", Some("#cc0000"));
        let acc2 = make_account(&db, "p@example.com", Some("#0000dd"));

        let inbox1 = make_folder(&db, acc1, "INBOX", FolderType::Inbox);
        let inbox2 = make_folder(&db, acc2, "INBOX", FolderType::Inbox);

        insert_headers(&db, inbox1, &[make_msg(1, 2000, false, true, false, false)]).unwrap();
        insert_headers(&db, inbox2, &[make_msg(2, 8000, false, true, false, false)]).unwrap();

        let rows = list_smart_folder(&db, SmartFolderKind::Flagged, 10, 0, i64::MAX).unwrap();

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].date, 8000);
        assert_eq!(rows[1].date, 2000);
        assert_eq!(rows[0].account_id, acc2);
        assert_eq!(rows[1].account_id, acc1);
        assert!(rows[0].flagged);
        assert!(rows[1].flagged);
    }

    fn raw_set_snooze(db: &Database, folder_id: i64, uid: i64, wake: i64) {
        db.conn().execute(
            "UPDATE messages SET snooze_wake_at = ?3 WHERE folder_id = ?1 AND uid = ?2",
            params![folder_id, uid, wake],
        ).unwrap();
    }

    #[test]
    fn all_inboxes_hides_future_snoozed_shows_elapsed() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "snz@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[
            make_msg(1, 1000, false, false, false, false),
            make_msg(2, 2000, false, false, false, false),
        ]).unwrap();
        raw_set_snooze(&db, inbox, 1, 9000);
        raw_set_snooze(&db, inbox, 2, 3000);

        let rows = list_smart_folder(&db, SmartFolderKind::AllInboxes, 10, 0, 5000).unwrap();
        assert_eq!(rows.len(), 1, "future-snoozed hidden, elapsed shown");
        assert_eq!(rows[0].date, 2000);
    }

    #[test]
    fn snoozed_kind_lists_future_snoozed_ascending() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "snz2@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[
            make_msg(1, 1000, false, false, false, false),
            make_msg(2, 2000, false, false, false, false),
        ]).unwrap();
        raw_set_snooze(&db, inbox, 1, 9000);
        raw_set_snooze(&db, inbox, 2, 7000);

        let rows = list_smart_folder(&db, SmartFolderKind::Snoozed, 10, 0, 5000).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].snooze_wake_at, Some(7000));
        assert_eq!(rows[1].snooze_wake_at, Some(9000));
    }

    #[test]
    fn unread_and_flagged_pagination() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "l@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);

        insert_headers(&db, inbox, &[
            make_msg(1, 1000, false, true, false, false),
            make_msg(2, 3000, false, true, false, false),
            make_msg(3, 2000, false, true, false, false),
        ]).unwrap();

        let page1 = list_smart_folder(&db, SmartFolderKind::Flagged, 2, 0, i64::MAX).unwrap();
        let page2 = list_smart_folder(&db, SmartFolderKind::Flagged, 2, 2, i64::MAX).unwrap();
        assert_eq!(page1.len(), 2);
        assert_eq!(page1[0].date, 3000);
        assert_eq!(page2.len(), 1);
        assert_eq!(page2[0].date, 1000);

        insert_headers(&db, inbox, &[
            make_msg(4, 5000, false, false, false, false),
            make_msg(5, 4000, false, false, false, false),
        ]).unwrap();
        let u_page1 = list_smart_folder(&db, SmartFolderKind::Unread, 2, 0, i64::MAX).unwrap();
        assert_eq!(u_page1.len(), 2);
        assert_eq!(u_page1[0].date, 5000);
    }
}
