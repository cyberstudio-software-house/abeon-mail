use rusqlite::params;

use crate::db::{Database, StorageError};

pub fn replace_for_message(
    db: &Database,
    message_id: i64,
    names: &[String],
) -> Result<(), StorageError> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM attachments WHERE message_id = ?1", params![message_id])?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO attachments (message_id, filename, mime_type, size) VALUES (?1, ?2, '', 0)",
        )?;
        for name in names {
            stmt.execute(params![message_id, name])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use crate::folders_repo::upsert_folder;
    use crate::messages_repo::{insert_headers, list_by_folder};
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::NewMessageHeader;
    use crate::db::Database;

    #[test]
    fn replace_for_message_is_idempotent() {
        let db = Database::open_in_memory().unwrap();
        let account = insert_account(&db, &NewAccount {
            email: "a@b.com".into(), display_name: "A".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        insert_headers(&db, folder.id, &[NewMessageHeader {
            uid: 1, message_id_hdr: None, in_reply_to: None, references_hdr: None,
            from_address: "a@b.com".into(), from_name: None, subject: "s".into(),
            date: 1, seen: false, flagged: false, has_attachments: false, size: 0, snippet: "".into(),
        }]).unwrap();
        let msg = list_by_folder(&db, folder.id, 1, 0).unwrap().into_iter().next().unwrap();
        replace_for_message(&db, msg.id, &["a.pdf".into(), "b.png".into()]).unwrap();
        replace_for_message(&db, msg.id, &["c.txt".into()]).unwrap();
        let conn = db.conn();
        let count: i64 = conn.query_row(
            "SELECT count(*) FROM attachments WHERE message_id = ?1", params![msg.id], |r| r.get(0),
        ).unwrap();
        assert_eq!(count, 1);
    }
}
