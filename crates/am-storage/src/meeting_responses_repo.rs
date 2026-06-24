use am_core::meeting::RsvpStatus;
use rusqlite::params;

use crate::db::{Database, StorageError};

fn status_str(s: RsvpStatus) -> &'static str {
    match s {
        RsvpStatus::Accepted => "accepted",
        RsvpStatus::Tentative => "tentative",
        RsvpStatus::Declined => "declined",
    }
}

fn status_from(s: &str) -> Option<RsvpStatus> {
    match s {
        "accepted" => Some(RsvpStatus::Accepted),
        "tentative" => Some(RsvpStatus::Tentative),
        "declined" => Some(RsvpStatus::Declined),
        _ => None,
    }
}

pub fn set_response(
    db: &Database,
    message_id: i64,
    status: RsvpStatus,
    now: i64,
) -> Result<(), StorageError> {
    db.conn().execute(
        "INSERT INTO meeting_responses (message_id, status, responded_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(message_id) DO UPDATE SET status = excluded.status, responded_at = excluded.responded_at",
        params![message_id, status_str(status), now],
    )?;
    Ok(())
}

pub fn get_response(db: &Database, message_id: i64) -> Result<Option<RsvpStatus>, StorageError> {
    let conn = db.conn();
    let row: Option<String> = conn
        .query_row(
            "SELECT status FROM meeting_responses WHERE message_id = ?1",
            params![message_id],
            |r| r.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    Ok(row.and_then(|s| status_from(&s)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use crate::db::Database;
    use crate::folders_repo::upsert_folder;
    use crate::messages_repo::{insert_headers, list_by_folder};
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::meeting::RsvpStatus;
    use am_core::message::NewMessageHeader;

    fn seed_message(db: &Database) -> i64 {
        let account = insert_account(db, &NewAccount {
            email: "a@b.com".into(), display_name: "A".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = upsert_folder(db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        insert_headers(db, folder.id, &[NewMessageHeader {
            uid: 1, message_id_hdr: None, in_reply_to: None, references_hdr: None,
            from_address: "a@b.com".into(), from_name: None, subject: "s".into(),
            date: 1, seen: false, flagged: false, answered: false, has_attachments: false, size: 0, snippet: "".into(),
        }]).unwrap();
        list_by_folder(db, folder.id, 1, 0, i64::MAX).unwrap().into_iter().next().unwrap().id
    }

    #[test]
    fn set_then_get_roundtrips_and_upserts() {
        let db = Database::open_in_memory().unwrap();
        let msg_id = seed_message(&db);
        assert_eq!(get_response(&db, msg_id).unwrap(), None);
        set_response(&db, msg_id, RsvpStatus::Tentative, 100).unwrap();
        assert_eq!(get_response(&db, msg_id).unwrap(), Some(RsvpStatus::Tentative));
        set_response(&db, msg_id, RsvpStatus::Accepted, 200).unwrap();
        assert_eq!(get_response(&db, msg_id).unwrap(), Some(RsvpStatus::Accepted));
    }

    #[test]
    fn response_is_deleted_when_message_is_deleted() {
        let db = Database::open_in_memory().unwrap();
        let msg_id = seed_message(&db);
        set_response(&db, msg_id, RsvpStatus::Accepted, 100).unwrap();
        assert_eq!(get_response(&db, msg_id).unwrap(), Some(RsvpStatus::Accepted));
        db.conn()
            .execute("DELETE FROM messages WHERE id = ?1", params![msg_id])
            .unwrap();
        assert_eq!(get_response(&db, msg_id).unwrap(), None);
    }
}
