use rusqlite::params;

use am_core::message::{Attachment, NewAttachment};

use crate::db::{Database, StorageError};

pub fn replace_for_message(
    db: &Database,
    message_id: i64,
    attachments: &[NewAttachment],
) -> Result<(), StorageError> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM attachments WHERE message_id = ?1", params![message_id])?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO attachments (message_id, filename, mime_type, size, content_id, is_inline, content, downloaded)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)",
        )?;
        for a in attachments {
            stmt.execute(params![
                message_id,
                a.filename,
                a.mime_type,
                a.size,
                a.content_id,
                a.is_inline as i64,
                a.content,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn list_meta(db: &Database, message_id: i64) -> Result<Vec<Attachment>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, filename, mime_type, size FROM attachments
         WHERE message_id = ?1 AND is_inline = 0 ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![message_id], |r| {
        Ok(Attachment {
            id: r.get(0)?,
            filename: r.get(1)?,
            mime_type: r.get(2)?,
            size: r.get(3)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get_content(
    db: &Database,
    attachment_id: i64,
) -> Result<(String, String, Vec<u8>), StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT filename, mime_type, content FROM attachments WHERE id = ?1",
        params![attachment_id],
        |r| {
            let content: Option<Vec<u8>> = r.get(2)?;
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, content.unwrap_or_default()))
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
        other => StorageError::Sqlite(other),
    })
}

pub fn inline_parts(
    db: &Database,
    message_id: i64,
) -> Result<Vec<(String, String, Vec<u8>)>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT content_id, mime_type, content FROM attachments
         WHERE message_id = ?1 AND content_id IS NOT NULL",
    )?;
    let rows = stmt.query_map(params![message_id], |r| {
        let content: Option<Vec<u8>> = r.get(2)?;
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, content.unwrap_or_default()))
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn calendar_content(db: &Database, message_id: i64) -> Result<Option<Vec<u8>>, StorageError> {
    let conn = db.conn();
    let row: Option<Vec<u8>> = conn
        .query_row(
            "SELECT content FROM attachments
             WHERE message_id = ?1 AND content IS NOT NULL
               AND (lower(mime_type) LIKE 'text/calendar%' OR lower(filename) LIKE '%.ics')
             ORDER BY id ASC LIMIT 1",
            params![message_id],
            |r| r.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    Ok(row)
}

pub fn needs_refresh(db: &Database, message_id: i64) -> Result<bool, StorageError> {
    let conn = db.conn();
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM attachments WHERE message_id = ?1 AND content IS NULL",
        params![message_id],
        |r| r.get(0),
    )?;
    Ok(count > 0)
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
            date: 1, seen: false, flagged: false, has_attachments: false, size: 0, snippet: "".into(),
        }]).unwrap();
        list_by_folder(db, folder.id, 1, 0, i64::MAX).unwrap().into_iter().next().unwrap().id
    }

    fn att(name: &str, inline: bool, cid: Option<&str>, content: &[u8]) -> NewAttachment {
        att_mime(name, "application/octet-stream", inline, cid, content)
    }

    fn att_mime(name: &str, mime: &str, inline: bool, cid: Option<&str>, content: &[u8]) -> NewAttachment {
        NewAttachment {
            filename: name.into(),
            mime_type: mime.into(),
            size: content.len() as i64,
            content_id: cid.map(|s| s.into()),
            is_inline: inline,
            content: content.to_vec(),
        }
    }

    #[test]
    fn replace_for_message_is_idempotent() {
        let db = Database::open_in_memory().unwrap();
        let msg_id = seed_message(&db);
        replace_for_message(&db, msg_id, &[att("a.pdf", false, None, b"x"), att("b.png", false, None, b"y")]).unwrap();
        replace_for_message(&db, msg_id, &[att("c.txt", false, None, b"z")]).unwrap();
        let conn = db.conn();
        let count: i64 = conn.query_row(
            "SELECT count(*) FROM attachments WHERE message_id = ?1", params![msg_id], |r| r.get(0),
        ).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn list_meta_excludes_inline_and_get_content_returns_bytes() {
        let db = Database::open_in_memory().unwrap();
        let msg_id = seed_message(&db);
        replace_for_message(&db, msg_id, &[
            att("doc.pdf", false, None, b"PDFDATA"),
            att("logo.png", true, Some("logo"), b"PNGDATA"),
        ]).unwrap();

        let meta = list_meta(&db, msg_id).unwrap();
        assert_eq!(meta.len(), 1);
        assert_eq!(meta[0].filename, "doc.pdf");

        let (filename, _mime, content) = get_content(&db, meta[0].id).unwrap();
        assert_eq!(filename, "doc.pdf");
        assert_eq!(content, b"PDFDATA");
    }

    #[test]
    fn needs_refresh_detects_legacy_null_content_rows() {
        let db = Database::open_in_memory().unwrap();
        let msg_id = seed_message(&db);

        // new-format rows carry content (even empty blobs are NOT NULL)
        replace_for_message(&db, msg_id, &[att("doc.pdf", false, None, b"PDFDATA")]).unwrap();
        assert!(!needs_refresh(&db, msg_id).unwrap());

        // simulate a legacy row written before content storage existed
        db.conn()
            .execute(
                "INSERT INTO attachments (message_id, filename, mime_type, size) VALUES (?1, 'legacy.png', '', 0)",
                params![msg_id],
            )
            .unwrap();
        assert!(needs_refresh(&db, msg_id).unwrap());

        // re-extraction replaces the rows with content-bearing ones
        replace_for_message(&db, msg_id, &[att("doc.pdf", false, None, b"PDFDATA")]).unwrap();
        assert!(!needs_refresh(&db, msg_id).unwrap());
    }

    #[test]
    fn calendar_content_returns_text_calendar_bytes() {
        let db = Database::open_in_memory().unwrap();
        let msg_id = seed_message(&db);
        replace_for_message(&db, msg_id, &[
            att("doc.pdf", false, None, b"PDFDATA"),
            att_mime("invite.ics", "text/calendar; method=REQUEST", false, None, b"BEGIN:VCALENDAR"),
        ]).unwrap();

        let bytes = calendar_content(&db, msg_id).unwrap();
        assert_eq!(bytes.as_deref(), Some(&b"BEGIN:VCALENDAR"[..]));
    }

    #[test]
    fn calendar_content_matches_ics_filename_without_calendar_mime() {
        let db = Database::open_in_memory().unwrap();
        let msg_id = seed_message(&db);
        replace_for_message(&db, msg_id, &[
            att("meeting.ics", false, None, b"ICSBYTES"),
        ]).unwrap();

        let bytes = calendar_content(&db, msg_id).unwrap();
        assert_eq!(bytes.as_deref(), Some(&b"ICSBYTES"[..]));
    }

    #[test]
    fn calendar_content_returns_none_for_pdf_only() {
        let db = Database::open_in_memory().unwrap();
        let msg_id = seed_message(&db);
        replace_for_message(&db, msg_id, &[
            att_mime("doc.pdf", "application/pdf", false, None, b"PDFDATA"),
        ]).unwrap();

        assert_eq!(calendar_content(&db, msg_id).unwrap(), None);
    }

    #[test]
    fn inline_parts_returns_cid_entries() {
        let db = Database::open_in_memory().unwrap();
        let msg_id = seed_message(&db);
        replace_for_message(&db, msg_id, &[
            att("doc.pdf", false, None, b"PDFDATA"),
            att("logo.png", true, Some("logo"), b"PNGDATA"),
        ]).unwrap();

        let parts = inline_parts(&db, msg_id).unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].0, "logo");
        assert_eq!(parts[0].2, b"PNGDATA");
    }
}
