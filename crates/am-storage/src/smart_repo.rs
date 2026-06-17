use am_core::smart::{SmartFolderKind, SmartMessageRow};
use rusqlite::params;

use crate::db::{Database, StorageError};

pub fn list_smart_folder(
    db: &Database,
    kind: SmartFolderKind,
    limit: i64,
    offset: i64,
) -> Result<Vec<SmartMessageRow>, StorageError> {
    match kind {
        SmartFolderKind::AllInboxes => list_all_inboxes(db, limit, offset),
        SmartFolderKind::Unread => Ok(Vec::new()),
        SmartFolderKind::Flagged => Ok(Vec::new()),
    }
}

fn row_to_smart(row: &rusqlite::Row) -> rusqlite::Result<SmartMessageRow> {
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
    })
}

fn list_all_inboxes(db: &Database, limit: i64, offset: i64) -> Result<Vec<SmartMessageRow>, StorageError> {
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
         ORDER BY m.date DESC
         LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt.query_map(params![limit, offset], row_to_smart)?;
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

        let rows = list_smart_folder(&db, SmartFolderKind::AllInboxes, 10, 0).unwrap();

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

        let rows = list_smart_folder(&db, SmartFolderKind::AllInboxes, 10, 0).unwrap();
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

        let page1 = list_smart_folder(&db, SmartFolderKind::AllInboxes, 2, 0).unwrap();
        let page2 = list_smart_folder(&db, SmartFolderKind::AllInboxes, 2, 2).unwrap();
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

        let rows = list_smart_folder(&db, SmartFolderKind::AllInboxes, 10, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].message_id > 0, true);
        assert_eq!(rows[0].date, 1000);
    }
}
