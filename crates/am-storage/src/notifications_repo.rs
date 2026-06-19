use am_core::notification::NotificationContent;
use rusqlite::{params, OptionalExtension};

use crate::db::{Database, StorageError};

pub fn build_new_mail_notification(
    db: &Database,
    folder_id: i64,
    count: i64,
) -> Result<Option<NotificationContent>, StorageError> {
    let conn = db.conn();
    let folder_type: Option<String> = conn
        .query_row(
            "SELECT folder_type FROM folders WHERE id = ?1",
            params![folder_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(folder_type) = folder_type else {
        return Ok(None);
    };
    if folder_type != "inbox" {
        return Ok(None);
    }
    if count == 1 {
        let row: Option<(Option<String>, String, String)> = conn
            .query_row(
                "SELECT from_name, from_address, subject FROM messages
                 WHERE folder_id = ?1 AND draft = 0 AND deleted = 0
                 ORDER BY date DESC LIMIT 1",
                params![folder_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((from_name, from_address, subject)) = row else {
            return Ok(None);
        };
        let title = match from_name {
            Some(n) if !n.trim().is_empty() => n,
            _ => from_address,
        };
        let body = if subject.trim().is_empty() {
            "(no subject)".to_string()
        } else {
            subject
        };
        Ok(Some(NotificationContent { title, body }))
    } else {
        let email: Option<String> = conn
            .query_row(
                "SELECT a.email FROM folders f JOIN accounts a ON a.id = f.account_id WHERE f.id = ?1",
                params![folder_id],
                |r| r.get(0),
            )
            .optional()?;
        let title = email.unwrap_or_else(|| "AbeonMail".to_string());
        Ok(Some(NotificationContent {
            title,
            body: format!("{count} new messages"),
        }))
    }
}

pub fn count_inbox_unread(db: &Database) -> Result<i64, StorageError> {
    let conn = db.conn();
    let total: i64 = conn.query_row(
        "SELECT COALESCE(SUM(unread_count), 0) FROM folders WHERE folder_type = 'inbox'",
        [],
        |r| r.get(0),
    )?;
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::accounts_repo::insert_account;
    use crate::folders_repo::{set_counts, upsert_folder};
    use crate::messages_repo::insert_headers;
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::NewMessageHeader;

    fn make_account(db: &Database, email: &str) -> i64 {
        insert_account(db, &NewAccount {
            email: email.into(),
            display_name: email.into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        }).unwrap().id
    }

    fn make_folder(db: &Database, account_id: i64, name: &str, ft: FolderType) -> i64 {
        upsert_folder(db, account_id, name, name, ft).unwrap().id
    }

    fn header(uid: i64, from_name: Option<&str>, from_address: &str, subject: &str, date: i64) -> NewMessageHeader {
        NewMessageHeader {
            uid,
            message_id_hdr: Some(format!("<msg-{uid}@example.com>")),
            in_reply_to: None,
            references_hdr: None,
            from_address: from_address.into(),
            from_name: from_name.map(|s| s.to_string()),
            subject: subject.into(),
            date,
            seen: false,
            flagged: false,
            has_attachments: false,
            size: 100,
            snippet: "preview".into(),
        }
    }

    #[test]
    fn non_inbox_folder_returns_none() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com");
        let sent = make_folder(&db, acc, "Sent", FolderType::Sent);
        insert_headers(&db, sent, &[header(1, Some("X"), "x@example.com", "Hi", 1000)]).unwrap();
        assert!(build_new_mail_notification(&db, sent, 1).unwrap().is_none());
    }

    #[test]
    fn single_uses_sender_name_and_subject() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com");
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, Some("Alice"), "alice@example.com", "Lunch?", 1000)]).unwrap();
        let n = build_new_mail_notification(&db, inbox, 1).unwrap().unwrap();
        assert_eq!(n.title, "Alice");
        assert_eq!(n.body, "Lunch?");
    }

    #[test]
    fn single_falls_back_to_address_when_name_empty() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com");
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, None, "bob@example.com", "Re: project", 1000)]).unwrap();
        let n = build_new_mail_notification(&db, inbox, 1).unwrap().unwrap();
        assert_eq!(n.title, "bob@example.com");
        assert_eq!(n.body, "Re: project");
    }

    #[test]
    fn single_falls_back_to_no_subject() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com");
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, Some("Carol"), "carol@example.com", "", 1000)]).unwrap();
        let n = build_new_mail_notification(&db, inbox, 1).unwrap().unwrap();
        assert_eq!(n.title, "Carol");
        assert_eq!(n.body, "(no subject)");
    }

    #[test]
    fn multiple_aggregates_with_count_and_account_email() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "me@example.com");
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[
            header(1, Some("A"), "a@example.com", "One", 1000),
            header(2, Some("B"), "b@example.com", "Two", 2000),
            header(3, Some("C"), "c@example.com", "Three", 3000),
        ]).unwrap();
        let n = build_new_mail_notification(&db, inbox, 3).unwrap().unwrap();
        assert_eq!(n.title, "me@example.com");
        assert_eq!(n.body, "3 new messages");
    }

    #[test]
    fn count_inbox_unread_sums_inbox_folders_only() {
        let db = Database::open_in_memory().unwrap();
        let acc1 = make_account(&db, "a@example.com");
        let acc2 = make_account(&db, "b@example.com");
        let in1 = make_folder(&db, acc1, "INBOX", FolderType::Inbox);
        let in2 = make_folder(&db, acc2, "INBOX", FolderType::Inbox);
        let spam = make_folder(&db, acc1, "Spam", FolderType::Spam);
        set_counts(&db, in1, 3, 10).unwrap();
        set_counts(&db, in2, 4, 12).unwrap();
        set_counts(&db, spam, 9, 9).unwrap();
        assert_eq!(count_inbox_unread(&db).unwrap(), 7);
    }

    #[test]
    fn count_inbox_unread_zero_when_no_inbox() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(count_inbox_unread(&db).unwrap(), 0);
    }
}
