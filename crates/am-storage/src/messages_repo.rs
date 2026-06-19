use am_core::message::{MessageBody, MessageFlag, MessageHeader, NewMessageHeader};
use rusqlite::params;

use crate::db::{Database, StorageError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MessageLocator {
    pub account_id: i64,
    pub folder_id: i64,
    pub uid: i64,
}

fn flag_column(flag: MessageFlag) -> &'static str {
    match flag {
        MessageFlag::Seen => "seen",
        MessageFlag::Flagged => "flagged",
    }
}

pub fn set_flag(db: &Database, message_id: i64, flag: MessageFlag, value: bool) -> Result<(), StorageError> {
    let sql = format!("UPDATE messages SET {} = ?2 WHERE id = ?1", flag_column(flag));
    let conn = db.conn();
    let changed = conn.execute(&sql, params![message_id, value as i64])?;
    if changed == 0 {
        return Err(StorageError::NotFound);
    }
    Ok(())
}

pub fn set_flags_by_uid(db: &Database, folder_id: i64, uid: i64, seen: bool, flagged: bool) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute(
        "UPDATE messages SET seen = ?3, flagged = ?4 WHERE folder_id = ?1 AND uid = ?2",
        params![folder_id, uid, seen as i64, flagged as i64],
    )?;
    Ok(())
}

pub fn list_uids(db: &Database, folder_id: i64) -> Result<Vec<i64>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare("SELECT uid FROM messages WHERE folder_id = ?1 AND draft = 0 ORDER BY uid ASC")?;
    let rows = stmt.query_map(params![folder_id], |row| row.get::<_, i64>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn count_by_folder(db: &Database, folder_id: i64) -> Result<i64, StorageError> {
    let conn = db.conn();
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE folder_id = ?1",
        params![folder_id],
        |row| row.get::<_, i64>(0),
    )?)
}

pub fn delete_by_uids(db: &Database, folder_id: i64, uids: &[i64]) -> Result<usize, StorageError> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let mut count = 0usize;
    {
        let mut stmt = tx.prepare("DELETE FROM messages WHERE folder_id = ?1 AND uid = ?2 AND draft = 0")?;
        for uid in uids {
            count += stmt.execute(params![folder_id, uid])?;
        }
    }
    tx.commit()?;
    Ok(count)
}

pub fn delete_by_folder(db: &Database, folder_id: i64) -> Result<usize, StorageError> {
    let conn = db.conn();
    Ok(conn.execute("DELETE FROM messages WHERE folder_id = ?1 AND draft = 0", params![folder_id])?)
}

pub fn locate(db: &Database, message_id: i64) -> Result<MessageLocator, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT account_id, folder_id, uid FROM messages WHERE id = ?1",
        params![message_id],
        |row| Ok(MessageLocator {
            account_id: row.get(0)?,
            folder_id: row.get(1)?,
            uid: row.get(2)?,
        }),
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
        other => StorageError::Sqlite(other),
    })
}

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
    let mut inserted_ids: Vec<i64> = Vec::new();
    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO messages
             (account_id, folder_id, uid, message_id_hdr, in_reply_to, references_hdr, from_address, from_name, subject, date, seen, flagged, has_attachments, size, snippet)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        )?;
        for h in headers {
            let inserted = stmt.execute(params![
                account_id,
                folder_id,
                h.uid,
                h.message_id_hdr,
                h.in_reply_to,
                h.references_hdr,
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
            if inserted == 1 {
                inserted_ids.push(tx.last_insert_rowid());
            }
            count += inserted;
        }
    }
    for id in &inserted_ids {
        crate::search_repo::reindex_message_conn(&tx, *id)?;
    }
    tx.commit()?;
    Ok(count)
}

pub fn list_by_thread(db: &Database, thread_id: i64) -> Result<Vec<MessageHeader>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, account_id, folder_id, subject, from_address, from_name, date, seen, flagged, has_attachments, snippet
         FROM messages WHERE thread_id = ?1 AND draft = 0 ORDER BY date ASC",
    )?;
    let rows = stmt.query_map(params![thread_id], row_to_header)?;
    let mut out = Vec::new();
    for r in rows { out.push(tuple_to_header(r?)); }
    Ok(out)
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
         FROM messages WHERE folder_id = ?1 AND draft = 0
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

pub fn store_recipients(
    db: &Database,
    message_id: i64,
    to_addresses: &[String],
    cc_addresses: &[String],
) -> Result<(), StorageError> {
    let to_json = serde_json::to_string(to_addresses).unwrap_or_else(|_| "[]".to_string());
    let cc_json = serde_json::to_string(cc_addresses).unwrap_or_else(|_| "[]".to_string());
    let conn = db.conn();
    let changed = conn.execute(
        "UPDATE messages SET to_addresses = ?2, cc_addresses = ?3 WHERE id = ?1",
        params![message_id, to_json, cc_json],
    )?;
    if changed == 0 {
        return Err(StorageError::NotFound);
    }
    Ok(())
}

pub fn backfill_body_meta(
    db: &Database,
    message_id: i64,
    snippet: &str,
    has_attachments: bool,
) -> Result<(), StorageError> {
    let conn = db.conn();
    let changed = conn.execute(
        "UPDATE messages SET snippet = ?2, has_attachments = ?3 WHERE id = ?1",
        params![message_id, snippet, has_attachments as i64],
    )?;
    if changed == 0 {
        return Err(StorageError::NotFound);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadingRow {
    pub id: i64,
    pub message_id_hdr: Option<String>,
    pub in_reply_to: Option<String>,
    pub references_hdr: Option<String>,
    pub subject: String,
    pub date: i64,
}

pub fn list_unthreaded(db: &Database, account_id: i64) -> Result<Vec<ThreadingRow>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, message_id_hdr, in_reply_to, references_hdr, subject, date
         FROM messages WHERE account_id = ?1 AND thread_id IS NULL AND draft = 0 ORDER BY date ASC",
    )?;
    let rows = stmt.query_map(params![account_id], |row| {
        Ok(ThreadingRow {
            id: row.get(0)?,
            message_id_hdr: row.get(1)?,
            in_reply_to: row.get(2)?,
            references_hdr: row.get(3)?,
            subject: row.get(4)?,
            date: row.get(5)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn assign_thread(db: &Database, message_id: i64, thread_id: i64) -> Result<(), StorageError> {
    let conn = db.conn();
    let changed = conn.execute(
        "UPDATE messages SET thread_id = ?2 WHERE id = ?1",
        params![message_id, thread_id],
    )?;
    if changed == 0 {
        return Err(StorageError::NotFound);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposeSource {
    pub account_id: i64,
    pub from_address: String,
    pub from_name: Option<String>,
    pub subject: String,
    pub message_id_hdr: Option<String>,
    pub references_hdr: Option<String>,
}

pub fn get_compose_source(db: &Database, message_id: i64) -> Result<ComposeSource, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT account_id, from_address, from_name, subject, message_id_hdr, references_hdr FROM messages WHERE id=?1",
        params![message_id],
        |r| Ok(ComposeSource {
            account_id: r.get(0)?,
            from_address: r.get(1)?,
            from_name: r.get(2)?,
            subject: r.get(3)?,
            message_id_hdr: r.get(4)?,
            references_hdr: r.get(5)?,
        }),
    ).map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
        o => StorageError::Sqlite(o),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use crate::drafts_repo;
    use crate::folders_repo::upsert_folder;
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::outgoing::OutgoingMessage;
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
            in_reply_to: None,
            references_hdr: None,
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

    #[test]
    fn backfill_body_meta_updates_snippet_and_attachments() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        insert_headers(&db, folder_id, &[make_header(1, 1000)]).unwrap();
        let msg = list_by_folder(&db, folder_id, 1, 0).unwrap().into_iter().next().unwrap();
        backfill_body_meta(&db, msg.id, "new snippet", true).unwrap();
        let updated = get_header(&db, msg.id).unwrap();
        assert_eq!(updated.snippet, "new snippet");
        assert!(updated.has_attachments);
    }

    #[test]
    fn set_flag_toggles_seen_column() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        insert_headers(&db, folder_id, &[make_header(1, 1000)]).unwrap();
        let msg = list_by_folder(&db, folder_id, 1, 0).unwrap().into_iter().next().unwrap();
        set_flag(&db, msg.id, am_core::message::MessageFlag::Seen, true).unwrap();
        assert!(get_header(&db, msg.id).unwrap().seen);
    }

    #[test]
    fn list_and_delete_by_uids() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        insert_headers(&db, folder_id, &[make_header(1, 1), make_header(2, 2), make_header(3, 3)]).unwrap();
        assert_eq!(list_uids(&db, folder_id).unwrap(), vec![1, 2, 3]);
        let removed = delete_by_uids(&db, folder_id, &[2, 3]).unwrap();
        assert_eq!(removed, 2);
        assert_eq!(list_uids(&db, folder_id).unwrap(), vec![1]);
    }

    #[test]
    fn set_flags_by_uid_updates_both() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        insert_headers(&db, folder_id, &[make_header(9, 1)]).unwrap();
        set_flags_by_uid(&db, folder_id, 9, true, true).unwrap();
        let msg = list_by_folder(&db, folder_id, 1, 0).unwrap().into_iter().next().unwrap();
        assert!(msg.seen && msg.flagged);
    }

    #[test]
    fn locate_returns_account_folder_uid() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        insert_headers(&db, folder_id, &[make_header(7, 1)]).unwrap();
        let msg = list_by_folder(&db, folder_id, 1, 0).unwrap().into_iter().next().unwrap();
        let loc = locate(&db, msg.id).unwrap();
        assert_eq!(loc.folder_id, folder_id);
        assert_eq!(loc.uid, 7);
    }

    #[test]
    fn get_compose_source_roundtrip() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        let h = NewMessageHeader {
            uid: 1,
            message_id_hdr: Some("<hello@example.com>".into()),
            in_reply_to: None,
            references_hdr: Some("<ref1@example.com>".into()),
            from_address: "sender@example.com".into(),
            from_name: Some("Sender Name".into()),
            subject: "Test Subject".into(),
            date: 1000,
            seen: false,
            flagged: false,
            has_attachments: false,
            size: 512,
            snippet: "preview".into(),
        };
        insert_headers(&db, folder_id, &[h]).unwrap();
        let msg = list_by_folder(&db, folder_id, 1, 0).unwrap().into_iter().next().unwrap();
        let src = get_compose_source(&db, msg.id).unwrap();
        assert_eq!(src.from_address, "sender@example.com");
        assert_eq!(src.from_name.as_deref(), Some("Sender Name"));
        assert_eq!(src.subject, "Test Subject");
        assert_eq!(src.message_id_hdr.as_deref(), Some("<hello@example.com>"));
        assert_eq!(src.references_hdr.as_deref(), Some("<ref1@example.com>"));
    }

    #[test]
    fn list_unthreaded_then_assign() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        insert_headers(&db, folder_id, &[make_header(1, 100)]).unwrap();
        let account_id = get_header(&db, list_by_folder(&db, folder_id, 1, 0).unwrap()[0].id).unwrap().account_id;
        let unthreaded = list_unthreaded(&db, account_id).unwrap();
        assert_eq!(unthreaded.len(), 1);
        let conn_thread_id = {
            let conn = db.conn();
            conn.execute("INSERT INTO threads (account_id, subject_root, last_date) VALUES (?1, 's', 100)", params![account_id]).unwrap();
            conn.last_insert_rowid()
        };
        assign_thread(&db, unthreaded[0].id, conn_thread_id).unwrap();
        assert!(list_unthreaded(&db, account_id).unwrap().is_empty());
    }

    fn sample_outgoing() -> OutgoingMessage {
        OutgoingMessage {
            from_address: "me@example.com".into(),
            from_name: None,
            to: vec!["a@x.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Draft".into(),
            text_body: "body".into(),
            html_body: None,
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
        }
    }

    #[test]
    fn draft_row_excluded_from_list_by_folder() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        let account_id = {
            let conn = db.conn();
            conn.query_row("SELECT account_id FROM folders WHERE id = ?1", params![folder_id], |r| r.get::<_, i64>(0)).unwrap()
        };
        let draft_id = drafts_repo::save_draft(&db, account_id, None, &sample_outgoing()).unwrap();
        let drafts_folder_id = {
            let conn = db.conn();
            conn.query_row("SELECT folder_id FROM messages WHERE id = ?1", params![draft_id], |r| r.get::<_, i64>(0)).unwrap()
        };
        insert_headers(&db, drafts_folder_id, &[make_header(1, 1000)]).unwrap();
        let listed = list_by_folder(&db, drafts_folder_id, 100, 0).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed.iter().all(|m| m.id != draft_id));
        let (_, retrieved) = drafts_repo::get_draft(&db, draft_id).unwrap();
        assert_eq!(retrieved.subject, "Draft");
    }

    #[test]
    fn draft_row_excluded_from_list_uids() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        let account_id = {
            let conn = db.conn();
            conn.query_row("SELECT account_id FROM folders WHERE id = ?1", params![folder_id], |r| r.get::<_, i64>(0)).unwrap()
        };
        let draft_id = drafts_repo::save_draft(&db, account_id, None, &sample_outgoing()).unwrap();
        let drafts_folder_id = {
            let conn = db.conn();
            conn.query_row("SELECT folder_id FROM messages WHERE id = ?1", params![draft_id], |r| r.get::<_, i64>(0)).unwrap()
        };
        insert_headers(&db, drafts_folder_id, &[make_header(77, 1000)]).unwrap();
        let uids = list_uids(&db, drafts_folder_id).unwrap();
        assert_eq!(uids, vec![77]);
    }

    #[test]
    fn delete_by_folder_preserves_draft_rows() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        let account_id = {
            let conn = db.conn();
            conn.query_row("SELECT account_id FROM folders WHERE id = ?1", params![folder_id], |r| r.get::<_, i64>(0)).unwrap()
        };
        let draft_id = drafts_repo::save_draft(&db, account_id, None, &sample_outgoing()).unwrap();
        let drafts_folder_id = {
            let conn = db.conn();
            conn.query_row("SELECT folder_id FROM messages WHERE id = ?1", params![draft_id], |r| r.get::<_, i64>(0)).unwrap()
        };
        insert_headers(&db, drafts_folder_id, &[make_header(1, 1000)]).unwrap();
        let deleted = delete_by_folder(&db, drafts_folder_id).unwrap();
        assert_eq!(deleted, 1);
        assert!(drafts_repo::get_draft(&db, draft_id).is_ok());
    }

    #[test]
    fn delete_by_uids_preserves_draft_rows() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        let account_id = {
            let conn = db.conn();
            conn.query_row("SELECT account_id FROM folders WHERE id = ?1", params![folder_id], |r| r.get::<_, i64>(0)).unwrap()
        };
        let draft_id = drafts_repo::save_draft(&db, account_id, None, &sample_outgoing()).unwrap();
        let drafts_folder_id = {
            let conn = db.conn();
            conn.query_row("SELECT folder_id FROM messages WHERE id = ?1", params![draft_id], |r| r.get::<_, i64>(0)).unwrap()
        };
        let draft_uid: Option<i64> = {
            let conn = db.conn();
            conn.query_row("SELECT uid FROM messages WHERE id = ?1", params![draft_id], |r| r.get::<_, Option<i64>>(0)).unwrap()
        };
        insert_headers(&db, drafts_folder_id, &[make_header(99, 1000)]).unwrap();
        let uids_to_delete: Vec<i64> = draft_uid.into_iter().chain(std::iter::once(99)).collect();
        let deleted = delete_by_uids(&db, drafts_folder_id, &uids_to_delete).unwrap();
        assert_eq!(deleted, 1);
        assert!(drafts_repo::get_draft(&db, draft_id).is_ok());
    }

    #[test]
    fn store_recipients_persists_to_and_cc() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        insert_headers(&db, folder_id, &[make_header(1, 1000)]).unwrap();
        let msg = list_by_folder(&db, folder_id, 1, 0).unwrap().into_iter().next().unwrap();
        store_recipients(&db, msg.id, &["alice@example.com".to_string()], &[]).unwrap();
        let conn = db.conn();
        let to_json: String = conn.query_row(
            "SELECT to_addresses FROM messages WHERE id = ?1",
            params![msg.id],
            |r| r.get(0),
        ).unwrap();
        let to_vec: Vec<String> = serde_json::from_str(&to_json).unwrap();
        assert_eq!(to_vec, vec!["alice@example.com"]);
    }

    #[test]
    fn draft_row_excluded_from_list_unthreaded() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        let account_id = {
            let conn = db.conn();
            conn.query_row("SELECT account_id FROM folders WHERE id = ?1", params![folder_id], |r| r.get::<_, i64>(0)).unwrap()
        };
        drafts_repo::save_draft(&db, account_id, None, &sample_outgoing()).unwrap();
        let unthreaded = list_unthreaded(&db, account_id).unwrap();
        assert!(unthreaded.is_empty());
    }
}
