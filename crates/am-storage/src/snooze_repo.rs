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
}
