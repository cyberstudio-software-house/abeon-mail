use am_core::message::{MessageBody, MessageHeader, NewMessageHeader};
use rusqlite::params;

use crate::db::{Database, StorageError};

fn row_to_header(row: &rusqlite::Row) -> rusqlite::Result<(i64, i64, i64, String, String, Option<String>, i64, i64, i64, i64, String)> {
    Ok((
        row.get::<_, i64>(0)?,
        row.get::<_, i64>(1)?,
        row.get::<_, i64>(2)?,
        row.get::<_, String>(3)?,
        row.get::<_, String>(4)?,
        row.get::<_, Option<String>>(5)?,
        row.get::<_, i64>(6)?,
        row.get::<_, i64>(7)?,
        row.get::<_, i64>(8)?,
        row.get::<_, i64>(9)?,
        row.get::<_, String>(10)?,
    ))
}

fn tuple_to_header(
    (id, account_id, folder_id, subject, from_address, from_name, date, seen, flagged, has_attachments, snippet): (i64, i64, i64, String, String, Option<String>, i64, i64, i64, i64, String),
) -> MessageHeader {
    MessageHeader {
        id,
        account_id,
        folder_id,
        subject,
        from_address,
        from_name,
        date,
        seen: seen != 0,
        flagged: flagged != 0,
        has_attachments: has_attachments != 0,
        snippet,
    }
}

pub fn insert_headers(
    db: &Database,
    folder_id: i64,
    headers: &[NewMessageHeader],
) -> Result<usize, StorageError> {
    let account_id = {
        let conn = db.conn();
        conn.query_row(
            "SELECT account_id FROM folders WHERE id = ?1",
            params![folder_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
            other => StorageError::Sqlite(other),
        })?
    };

    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let mut count = 0usize;
    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO messages
             (account_id, folder_id, uid, message_id_hdr, from_address, from_name, subject, date, seen, flagged, has_attachments, size, snippet)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        )?;
        for h in headers {
            let inserted = stmt.execute(params![
                account_id,
                folder_id,
                h.uid,
                h.message_id_hdr,
                h.from_address,
                h.from_name,
                h.subject,
                h.date,
                h.seen as i64,
                h.flagged as i64,
                h.has_attachments as i64,
                h.size,
                h.snippet
            ])?;
            count += inserted;
        }
    }
    tx.commit()?;
    Ok(count)
}

pub fn list_by_folder(
    db: &Database,
    folder_id: i64,
    limit: i64,
    offset: i64,
) -> Result<Vec<MessageHeader>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, account_id, folder_id, subject, from_address, from_name, date, seen, flagged, has_attachments, snippet
         FROM messages WHERE folder_id = ?1
         ORDER BY date DESC LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![folder_id, limit, offset], row_to_header)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(tuple_to_header(r?));
    }
    Ok(out)
}

pub fn get_header(db: &Database, id: i64) -> Result<MessageHeader, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT id, account_id, folder_id, subject, from_address, from_name, date, seen, flagged, has_attachments, snippet
         FROM messages WHERE id = ?1",
        params![id],
        row_to_header,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
        other => StorageError::Sqlite(other),
    })
    .map(tuple_to_header)
}

pub fn get_body(db: &Database, message_id: i64) -> Result<Option<MessageBody>, StorageError> {
    let conn = db.conn();
    let result = conn.query_row(
        "SELECT message_id, text_plain, text_html FROM message_bodies WHERE message_id = ?1",
        params![message_id],
        |row| {
            Ok(MessageBody {
                message_id: row.get(0)?,
                text_plain: row.get(1)?,
                text_html: row.get(2)?,
            })
        },
    );
    match result {
        Ok(body) => Ok(Some(body)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(other) => Err(StorageError::Sqlite(other)),
    }
}

pub fn store_body(db: &Database, message_id: i64, body: &MessageBody) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute(
        "INSERT INTO message_bodies (message_id, text_plain, text_html)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(message_id) DO UPDATE SET text_plain = excluded.text_plain, text_html = excluded.text_html",
        params![message_id, body.text_plain, body.text_html],
    )?;
    Ok(())
}

pub fn message_uid(db: &Database, message_id: i64) -> Result<(i64, i64), StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT folder_id, uid FROM messages WHERE id = ?1",
        params![message_id],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
        other => StorageError::Sqlite(other),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use crate::folders_repo::upsert_folder;
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use crate::db::Database;

    fn sample_account() -> NewAccount {
        NewAccount {
            email: "test@example.com".into(),
            display_name: "Test".into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        }
    }

    fn make_header(uid: i64, date: i64) -> NewMessageHeader {
        NewMessageHeader {
            uid,
            message_id_hdr: Some(format!("<msg-{uid}@example.com>")),
            from_address: "sender@example.com".into(),
            from_name: Some("Sender".into()),
            subject: format!("Subject {uid}"),
            date,
            seen: false,
            flagged: false,
            has_attachments: false,
            size: 1024,
            snippet: "Preview text".into(),
        }
    }

    fn setup(db: &Database) -> i64 {
        let account = insert_account(db, &sample_account()).unwrap();
        upsert_folder(db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap().id
    }

    #[test]
    fn insert_headers_returns_count() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        let headers = vec![make_header(1, 1000), make_header(2, 2000)];
        let count = insert_headers(&db, folder_id, &headers).unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn insert_headers_ignores_duplicate_uid() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        let headers = vec![make_header(1, 1000)];
        insert_headers(&db, folder_id, &headers).unwrap();
        let count = insert_headers(&db, folder_id, &headers).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn list_by_folder_ordered_date_desc() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        let headers = vec![make_header(1, 1000), make_header(2, 3000), make_header(3, 2000)];
        insert_headers(&db, folder_id, &headers).unwrap();
        let result = list_by_folder(&db, folder_id, 10, 0).unwrap();
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].date, 3000);
        assert_eq!(result[1].date, 2000);
        assert_eq!(result[2].date, 1000);
    }

    #[test]
    fn list_by_folder_respects_limit_offset() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        let headers = vec![make_header(1, 1000), make_header(2, 3000), make_header(3, 2000)];
        insert_headers(&db, folder_id, &headers).unwrap();
        let page1 = list_by_folder(&db, folder_id, 2, 0).unwrap();
        let page2 = list_by_folder(&db, folder_id, 2, 2).unwrap();
        assert_eq!(page1.len(), 2);
        assert_eq!(page2.len(), 1);
        assert_eq!(page1[0].date, 3000);
        assert_eq!(page2[0].date, 1000);
    }

    #[test]
    fn get_header_not_found() {
        let db = Database::open_in_memory().unwrap();
        let err = get_header(&db, 999).unwrap_err();
        assert!(matches!(err, StorageError::NotFound));
    }

    #[test]
    fn store_body_and_get_body_roundtrip() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        insert_headers(&db, folder_id, &[make_header(1, 1000)]).unwrap();
        let msg = list_by_folder(&db, folder_id, 1, 0).unwrap().into_iter().next().unwrap();
        let body = MessageBody {
            message_id: msg.id,
            text_plain: Some("Hello plain".into()),
            text_html: Some("<p>Hello</p>".into()),
        };
        store_body(&db, msg.id, &body).unwrap();
        let fetched = get_body(&db, msg.id).unwrap().unwrap();
        assert_eq!(fetched, body);
    }

    #[test]
    fn get_body_returns_none_when_absent() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        insert_headers(&db, folder_id, &[make_header(1, 1000)]).unwrap();
        let msg = list_by_folder(&db, folder_id, 1, 0).unwrap().into_iter().next().unwrap();
        let result = get_body(&db, msg.id).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn message_uid_returns_folder_and_uid() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        insert_headers(&db, folder_id, &[make_header(42, 1000)]).unwrap();
        let msg = list_by_folder(&db, folder_id, 1, 0).unwrap().into_iter().next().unwrap();
        let (fid, uid) = message_uid(&db, msg.id).unwrap();
        assert_eq!(fid, folder_id);
        assert_eq!(uid, 42);
    }
}
