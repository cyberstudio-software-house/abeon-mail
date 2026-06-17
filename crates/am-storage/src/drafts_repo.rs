use std::time::{SystemTime, UNIX_EPOCH};

use am_core::folder::FolderType;
use am_core::outgoing::{OutgoingAttachment, OutgoingMessage};
use rusqlite::params;

use crate::db::{Database, StorageError};
use crate::folders_repo::upsert_folder;

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn ensure_drafts_folder(db: &Database, account_id: i64) -> Result<i64, StorageError> {
    Ok(upsert_folder(db, account_id, "Drafts", "Drafts", FolderType::Drafts)?.id)
}

pub fn save_draft(
    db: &Database,
    account_id: i64,
    draft_id: Option<i64>,
    msg: &OutgoingMessage,
) -> Result<i64, StorageError> {
    let folder_id = ensure_drafts_folder(db, account_id)?;
    let to = serde_json::to_string(&msg.to).unwrap_or_else(|_| "[]".into());
    let cc = serde_json::to_string(&msg.cc).unwrap_or_else(|_| "[]".into());
    let bcc = serde_json::to_string(&msg.bcc).unwrap_or_else(|_| "[]".into());
    let references = if msg.references.is_empty() {
        None
    } else {
        Some(msg.references.join(" "))
    };

    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let id = match draft_id {
        Some(id) => {
            tx.execute(
                "UPDATE messages SET from_address=?2, from_name=?3, to_addresses=?4, cc_addresses=?5, bcc_addresses=?6, subject=?7, in_reply_to=?8, references_hdr=?9 WHERE id=?1 AND draft=1",
                params![id, msg.from_address, msg.from_name, to, cc, bcc, msg.subject, msg.in_reply_to, references],
            )?;
            id
        }
        None => {
            tx.execute(
                "INSERT INTO messages (account_id, folder_id, from_address, from_name, to_addresses, cc_addresses, bcc_addresses, subject, date, draft, in_reply_to, references_hdr)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?11)",
                params![account_id, folder_id, msg.from_address, msg.from_name, to, cc, bcc, msg.subject, now_secs(), msg.in_reply_to, references],
            )?;
            tx.last_insert_rowid()
        }
    };
    tx.execute(
        "INSERT INTO message_bodies (message_id, text_plain, text_html) VALUES (?1, ?2, ?3)
         ON CONFLICT(message_id) DO UPDATE SET text_plain=excluded.text_plain, text_html=excluded.text_html",
        params![id, msg.text_body, msg.html_body],
    )?;
    tx.execute("DELETE FROM attachments WHERE message_id = ?1", params![id])?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO attachments (message_id, filename, mime_type, size, content_id, blob_ref) VALUES (?1, ?2, ?3, 0, ?4, ?5)",
        )?;
        for att in &msg.attachments {
            stmt.execute(params![id, att.filename, att.mime_type, att.content_id, att.blob_ref])?;
        }
    }
    tx.commit()?;
    Ok(id)
}

pub fn get_draft(db: &Database, draft_id: i64) -> Result<(i64, OutgoingMessage), StorageError> {
    let conn = db.conn();
    let (account_id, from_address, from_name, to, cc, bcc, subject, in_reply_to, references): (
        i64,
        String,
        Option<String>,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT account_id, from_address, from_name, to_addresses, cc_addresses, bcc_addresses, subject, in_reply_to, references_hdr FROM messages WHERE id=?1 AND draft=1",
            params![draft_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                ))
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
            o => StorageError::Sqlite(o),
        })?;
    let (text_body, html_body): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT text_plain, text_html FROM message_bodies WHERE message_id=?1",
            params![draft_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((None, None));
    let mut attachments = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT filename, mime_type, content_id, blob_ref FROM attachments WHERE message_id=?1",
        )?;
        let rows = stmt.query_map(params![draft_id], |r| {
            Ok(OutgoingAttachment {
                filename: r.get(0)?,
                mime_type: r.get(1)?,
                content_id: r.get(2)?,
                blob_ref: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            })
        })?;
        for a in rows {
            attachments.push(a?);
        }
    }
    Ok((
        account_id,
        OutgoingMessage {
            from_address,
            from_name,
            to: serde_json::from_str(&to).unwrap_or_default(),
            cc: serde_json::from_str(&cc).unwrap_or_default(),
            bcc: serde_json::from_str(&bcc).unwrap_or_default(),
            subject,
            text_body: text_body.unwrap_or_default(),
            html_body,
            in_reply_to,
            references: references
                .map(|s| s.split_whitespace().map(String::from).collect())
                .unwrap_or_default(),
            attachments,
        },
    ))
}

pub fn list_draft_ids(db: &Database, account_id: i64) -> Result<Vec<i64>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id FROM messages WHERE account_id=?1 AND draft=1 ORDER BY id DESC",
    )?;
    let rows = stmt.query_map(params![account_id], |r| r.get::<_, i64>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn delete_draft(db: &Database, draft_id: i64) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute(
        "DELETE FROM messages WHERE id=?1 AND draft=1",
        params![draft_id],
    )?;
    Ok(())
}

pub fn set_server_uid(
    db: &Database,
    draft_id: i64,
    uid: Option<i64>,
) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute(
        "UPDATE messages SET uid=?2 WHERE id=?1 AND draft=1",
        params![draft_id, uid],
    )?;
    Ok(())
}

pub fn get_server_uid(db: &Database, draft_id: i64) -> Result<Option<i64>, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT uid FROM messages WHERE id=?1 AND draft=1",
        params![draft_id],
        |r| r.get::<_, Option<i64>>(0),
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
        o => StorageError::Sqlite(o),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use crate::db::Database;
    use am_core::account::{NewAccount, ProviderType};
    use am_core::outgoing::OutgoingMessage;

    fn acct(db: &Database) -> i64 {
        insert_account(
            db,
            &NewAccount {
                email: "me@e.com".into(),
                display_name: "Me".into(),
                provider_type: ProviderType::ImapPassword,
                color: None,
            },
        )
        .unwrap()
        .id
    }

    fn sample() -> OutgoingMessage {
        OutgoingMessage {
            from_address: "me@e.com".into(),
            from_name: Some("Me".into()),
            to: vec!["a@x.com".into()],
            cc: vec![],
            bcc: vec!["b@x.com".into()],
            subject: "Draft S".into(),
            text_body: "body".into(),
            html_body: Some("<p>body</p>".into()),
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
        }
    }

    #[test]
    fn save_then_get_draft_roundtrips() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let id = save_draft(&db, account_id, None, &sample()).unwrap();
        let (got_account, got) = get_draft(&db, id).unwrap();
        assert_eq!(got_account, account_id);
        assert_eq!(got.subject, "Draft S");
        assert_eq!(got.to, vec!["a@x.com".to_string()]);
        assert_eq!(got.bcc, vec!["b@x.com".to_string()]);
        assert_eq!(got.text_body, "body");
        assert_eq!(got.html_body.as_deref(), Some("<p>body</p>"));
    }

    #[test]
    fn save_with_existing_id_updates_in_place() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let id = save_draft(&db, account_id, None, &sample()).unwrap();
        let mut m = sample();
        m.subject = "Updated".into();
        let id2 = save_draft(&db, account_id, Some(id), &m).unwrap();
        assert_eq!(id, id2);
        assert_eq!(get_draft(&db, id).unwrap().1.subject, "Updated");
        assert_eq!(list_draft_ids(&db, account_id).unwrap().len(), 1);
    }

    #[test]
    fn delete_draft_removes_it() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let id = save_draft(&db, account_id, None, &sample()).unwrap();
        delete_draft(&db, id).unwrap();
        assert!(list_draft_ids(&db, account_id).unwrap().is_empty());
    }

    #[test]
    fn set_server_uid_roundtrips() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let id = save_draft(&db, account_id, None, &sample()).unwrap();
        assert_eq!(get_server_uid(&db, id).unwrap(), None);
        set_server_uid(&db, id, Some(42)).unwrap();
        assert_eq!(get_server_uid(&db, id).unwrap(), Some(42));
        set_server_uid(&db, id, None).unwrap();
        assert_eq!(get_server_uid(&db, id).unwrap(), None);
    }
}
