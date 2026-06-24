use am_core::message::{MessageBody, MessageFlag, MessageHeader, NewMessageHeader};
use rusqlite::params;

use crate::db::{Database, StorageError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MessageLocator {
    pub account_id: i64,
    pub folder_id: i64,
    pub uid: i64,
    pub thread_id: Option<i64>,
}

fn flag_column(flag: MessageFlag) -> &'static str {
    match flag {
        MessageFlag::Seen => "seen",
        MessageFlag::Flagged => "flagged",
        MessageFlag::Answered => "answered",
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

pub fn set_deleted(db: &Database, message_id: i64, value: bool) -> Result<(), StorageError> {
    let conn = db.conn();
    let changed = conn.execute(
        "UPDATE messages SET deleted = ?2 WHERE id = ?1",
        params![message_id, value as i64],
    )?;
    if changed == 0 {
        return Err(StorageError::NotFound);
    }
    Ok(())
}

pub fn set_flags_by_uid(db: &Database, folder_id: i64, uid: i64, seen: bool, flagged: bool, answered: bool) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute(
        "UPDATE messages SET seen = ?3, flagged = ?4, answered = ?5 WHERE folder_id = ?1 AND uid = ?2",
        params![folder_id, uid, seen as i64, flagged as i64, answered as i64],
    )?;
    Ok(())
}

pub fn find_id_by_message_id_hdr(db: &Database, account_id: i64, message_id_hdr: &str) -> Result<Option<i64>, StorageError> {
    let conn = db.conn();
    let result = conn.query_row(
        "SELECT id FROM messages WHERE account_id = ?1 AND message_id_hdr = ?2 AND draft = 0 ORDER BY id ASC LIMIT 1",
        params![account_id, message_id_hdr],
        |row| row.get::<_, i64>(0),
    );
    match result {
        Ok(id) => Ok(Some(id)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(StorageError::Sqlite(e)),
    }
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

pub fn uids_without_body(db: &Database, folder_id: i64, limit: i64) -> Result<Vec<(i64, i64)>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, uid FROM messages
         WHERE folder_id = ?1 AND draft = 0 AND deleted = 0 AND body_state = 'none'
         ORDER BY uid DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![folder_id, limit], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn count_without_body(db: &Database, folder_id: i64) -> Result<i64, StorageError> {
    let conn = db.conn();
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM messages
         WHERE folder_id = ?1 AND draft = 0 AND deleted = 0 AND body_state = 'none'",
        params![folder_id],
        |row| row.get::<_, i64>(0),
    )?)
}

pub fn count_active_by_folder(db: &Database, folder_id: i64) -> Result<i64, StorageError> {
    let conn = db.conn();
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE folder_id = ?1 AND draft = 0 AND deleted = 0",
        params![folder_id],
        |row| row.get::<_, i64>(0),
    )?)
}

pub fn mark_folder_seen(db: &Database, folder_id: i64) -> Result<usize, StorageError> {
    let conn = db.conn();
    Ok(conn.execute(
        "UPDATE messages SET seen = 1 WHERE folder_id = ?1 AND seen = 0 AND deleted = 0 AND draft = 0",
        params![folder_id],
    )?)
}

pub fn thread_ids_in_folder(db: &Database, folder_id: i64) -> Result<Vec<i64>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT DISTINCT thread_id FROM messages WHERE folder_id = ?1 AND thread_id IS NOT NULL",
    )?;
    let rows = stmt.query_map(params![folder_id], |row| row.get::<_, i64>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
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
        "SELECT account_id, folder_id, uid, thread_id FROM messages WHERE id = ?1",
        params![message_id],
        |row| Ok(MessageLocator {
            account_id: row.get(0)?,
            folder_id: row.get(1)?,
            uid: row.get(2)?,
            thread_id: row.get(3)?,
        }),
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
        other => StorageError::Sqlite(other),
    })
}

fn row_to_header(row: &rusqlite::Row) -> rusqlite::Result<(i64, i64, i64, String, String, Option<String>, i64, i64, i64, i64, String, i64)> {
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
        row.get::<_, i64>(11)?,
    ))
}

fn tuple_to_header(
    (id, account_id, folder_id, subject, from_address, from_name, date, seen, flagged, has_attachments, snippet, answered): (i64, i64, i64, String, String, Option<String>, i64, i64, i64, i64, String, i64),
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
        answered: answered != 0,
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
             (account_id, folder_id, uid, message_id_hdr, in_reply_to, references_hdr, from_address, from_name, subject, date, seen, flagged, has_attachments, size, snippet, answered)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
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
                h.snippet,
                h.answered as i64
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
        "SELECT id, account_id, folder_id, subject, from_address, from_name, date, seen, flagged, has_attachments, snippet, answered
         FROM messages
         WHERE thread_id = ?1 AND draft = 0 AND deleted = 0
           AND id IN (
             SELECT MIN(id) FROM messages
             WHERE thread_id = ?1 AND draft = 0 AND deleted = 0
             GROUP BY COALESCE(message_id_hdr, 'id:' || id)
           )
         ORDER BY date ASC",
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
    now: i64,
) -> Result<Vec<MessageHeader>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, account_id, folder_id, subject, from_address, from_name, date, seen, flagged, has_attachments, snippet, answered
         FROM messages WHERE folder_id = ?1 AND draft = 0 AND deleted = 0
           AND (snooze_wake_at IS NULL OR snooze_wake_at <= ?4)
         ORDER BY date DESC LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![folder_id, limit, offset, now], row_to_header)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(tuple_to_header(r?));
    }
    Ok(out)
}

pub fn get_header(db: &Database, id: i64) -> Result<MessageHeader, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT id, account_id, folder_id, subject, from_address, from_name, date, seen, flagged, has_attachments, snippet, answered
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

pub fn get_recipients(db: &Database, id: i64) -> Result<(Vec<String>, Vec<String>), StorageError> {
    let conn = db.conn();
    let (to_json, cc_json): (String, String) = conn
        .query_row(
            "SELECT to_addresses, cc_addresses FROM messages WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
            other => StorageError::Sqlite(other),
        })?;
    let to = serde_json::from_str::<Vec<String>>(&to_json).unwrap_or_default();
    let cc = serde_json::from_str::<Vec<String>>(&cc_json).unwrap_or_default();
    Ok((to, cc))
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
    conn.execute(
        "UPDATE messages SET body_state = 'downloaded' WHERE id = ?1",
        params![message_id],
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

pub fn ids_by_uids(db: &Database, folder_id: i64, uids: &[i64]) -> Result<Vec<i64>, StorageError> {
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    let conn = db.conn();
    let placeholders = uids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id FROM messages WHERE folder_id = ? AND uid IN ({placeholders}) ORDER BY uid ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut bind: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(uids.len() + 1);
    bind.push(&folder_id);
    for u in uids {
        bind.push(u);
    }
    let rows = stmt.query_map(bind.as_slice(), |r| r.get::<_, i64>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn account_id_for_message(db: &Database, message_id: i64) -> Result<i64, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT f.account_id FROM messages m JOIN folders f ON m.folder_id = f.id WHERE m.id = ?1",
        params![message_id],
        |r| r.get(0),
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
        other => StorageError::Sqlite(other),
    })
}

pub fn get_account_email_for_message(db: &Database, message_id: i64) -> Result<String, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT a.email FROM messages m JOIN folders f ON m.folder_id = f.id JOIN accounts a ON f.account_id = a.id WHERE m.id = ?1",
        params![message_id],
        |r| r.get(0),
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
        other => StorageError::Sqlite(other),
    })
}

pub fn rule_message(db: &Database, message_id: i64) -> Result<am_core::rule::RuleMessage, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT from_address, from_name, subject, has_attachments, to_addresses, cc_addresses
         FROM messages WHERE id = ?1",
        params![message_id],
        |r| {
            let to_json: String = r.get(4)?;
            let cc_json: String = r.get(5)?;
            let mut recipients: Vec<String> = serde_json::from_str(&to_json).unwrap_or_default();
            let cc: Vec<String> = serde_json::from_str(&cc_json).unwrap_or_default();
            recipients.extend(cc);
            Ok(am_core::rule::RuleMessage {
                from_address: r.get(0)?,
                from_name: r.get(1)?,
                subject: r.get(2)?,
                recipients,
                has_attachments: r.get::<_, i64>(3)? != 0,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
        other => StorageError::Sqlite(other),
    })
}

#[cfg(test)]
mod rule_helpers_tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use crate::folders_repo::upsert_folder;
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::NewMessageHeader;

    fn header(uid: i64) -> NewMessageHeader {
        NewMessageHeader {
            uid, message_id_hdr: None, in_reply_to: None, references_hdr: None,
            from_address: "a@b.c".into(), from_name: Some("AB".into()), subject: format!("S{uid}"),
            date: 1000, seen: false, flagged: false, answered: false, has_attachments: true, size: 0, snippet: String::new(),
        }
    }

    #[test]
    fn ids_by_uids_and_rule_message() {
        let db = Database::open_in_memory().unwrap();
        let acc = insert_account(&db, &NewAccount {
            email: "s@e.com".into(), display_name: "S".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = upsert_folder(&db, acc.id, "INBOX", "Inbox", FolderType::Inbox).unwrap().id;
        insert_headers(&db, folder, &[header(1), header(2)]).unwrap();

        let ids = ids_by_uids(&db, folder, &[1, 2]).unwrap();
        assert_eq!(ids.len(), 2);

        let view = rule_message(&db, ids[0]).unwrap();
        assert_eq!(view.from_address, "a@b.c");
        assert_eq!(view.from_name.as_deref(), Some("AB"));
        assert!(view.has_attachments);
    }

    #[test]
    fn account_accessors_resolve_id_and_email() {
        let db = Database::open_in_memory().unwrap();
        let acc = insert_account(&db, &NewAccount {
            email: "owner@e.com".into(), display_name: "Owner".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = upsert_folder(&db, acc.id, "INBOX", "Inbox", FolderType::Inbox).unwrap().id;
        insert_headers(&db, folder, &[header(1)]).unwrap();
        let msg_id = ids_by_uids(&db, folder, &[1]).unwrap()[0];

        assert_eq!(account_id_for_message(&db, msg_id).unwrap(), acc.id);
        assert_eq!(get_account_email_for_message(&db, msg_id).unwrap(), "owner@e.com");
    }

    #[test]
    fn account_accessors_not_found() {
        let db = Database::open_in_memory().unwrap();
        assert!(matches!(account_id_for_message(&db, 999).unwrap_err(), StorageError::NotFound));
        assert!(matches!(get_account_email_for_message(&db, 999).unwrap_err(), StorageError::NotFound));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use crate::drafts_repo;
    use crate::folders_repo::upsert_folder;
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::NewMessageHeader;
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
            answered: false,
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
        let result = list_by_folder(&db, folder_id, 10, 0, i64::MAX).unwrap();
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
        let page1 = list_by_folder(&db, folder_id, 2, 0, i64::MAX).unwrap();
        let page2 = list_by_folder(&db, folder_id, 2, 2, i64::MAX).unwrap();
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
        let msg = list_by_folder(&db, folder_id, 1, 0, i64::MAX).unwrap().into_iter().next().unwrap();
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
        let msg = list_by_folder(&db, folder_id, 1, 0, i64::MAX).unwrap().into_iter().next().unwrap();
        let result = get_body(&db, msg.id).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn message_uid_returns_folder_and_uid() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        insert_headers(&db, folder_id, &[make_header(42, 1000)]).unwrap();
        let msg = list_by_folder(&db, folder_id, 1, 0, i64::MAX).unwrap().into_iter().next().unwrap();
        let (fid, uid) = message_uid(&db, msg.id).unwrap();
        assert_eq!(fid, folder_id);
        assert_eq!(uid, 42);
    }

    #[test]
    fn backfill_body_meta_updates_snippet_and_attachments() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        insert_headers(&db, folder_id, &[make_header(1, 1000)]).unwrap();
        let msg = list_by_folder(&db, folder_id, 1, 0, i64::MAX).unwrap().into_iter().next().unwrap();
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
        let msg = list_by_folder(&db, folder_id, 1, 0, i64::MAX).unwrap().into_iter().next().unwrap();
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
        set_flags_by_uid(&db, folder_id, 9, true, true, false).unwrap();
        let msg = list_by_folder(&db, folder_id, 1, 0, i64::MAX).unwrap().into_iter().next().unwrap();
        assert!(msg.seen && msg.flagged);
    }

    #[test]
    fn insert_and_read_answered_roundtrips() {
        let db = Database::open_in_memory().unwrap();
        let account = crate::accounts_repo::insert_account(&db, &am_core::account::NewAccount {
            email: "a@e.com".into(), display_name: "A".into(),
            provider_type: am_core::account::ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = crate::folders_repo::upsert_folder(&db, account.id, "INBOX", "Inbox", am_core::folder::FolderType::Inbox).unwrap();
        insert_headers(&db, folder.id, &[NewMessageHeader {
            uid: 1, message_id_hdr: Some("<a@x>".into()), in_reply_to: None, references_hdr: None,
            from_address: "x@e.com".into(), from_name: None, subject: "Hi".into(), date: 100,
            seen: true, flagged: false, answered: true, has_attachments: false, size: 0, snippet: String::new(),
        }]).unwrap();
        let headers = list_by_folder(&db, folder.id, 10, 0, i64::MAX).unwrap();
        assert_eq!(headers.len(), 1);
        assert!(headers[0].answered);
    }

    #[test]
    fn locate_returns_account_folder_uid() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        insert_headers(&db, folder_id, &[make_header(7, 1)]).unwrap();
        let msg = list_by_folder(&db, folder_id, 1, 0, i64::MAX).unwrap().into_iter().next().unwrap();
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
            answered: false,
            has_attachments: false,
            size: 512,
            snippet: "preview".into(),
        };
        insert_headers(&db, folder_id, &[h]).unwrap();
        let msg = list_by_folder(&db, folder_id, 1, 0, i64::MAX).unwrap().into_iter().next().unwrap();
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
        let account_id = get_header(&db, list_by_folder(&db, folder_id, 1, 0, i64::MAX).unwrap()[0].id).unwrap().account_id;
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

    #[test]
    fn list_by_thread_dedupes_same_message_across_folders() {
        let db = Database::open_in_memory().unwrap();
        let account = insert_account(&db, &sample_account()).unwrap();
        let inbox = upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap().id;
        let archive = upsert_folder(&db, account.id, "[Gmail]/All Mail", "All Mail", FolderType::Archive).unwrap().id;

        let mut in_inbox = make_header(1, 1000);
        in_inbox.message_id_hdr = Some("<dup@example.com>".into());
        let mut in_archive = make_header(1, 1000);
        in_archive.message_id_hdr = Some("<dup@example.com>".into());
        insert_headers(&db, inbox, &[in_inbox]).unwrap();
        insert_headers(&db, archive, &[in_archive]).unwrap();

        let thread_id = {
            let conn = db.conn();
            conn.execute(
                "INSERT INTO threads (account_id, subject_root, last_date) VALUES (?1, 's', 1000)",
                params![account.id],
            ).unwrap();
            let id = conn.last_insert_rowid();
            conn.execute(
                "UPDATE messages SET thread_id = ?1 WHERE message_id_hdr = ?2",
                params![id, "<dup@example.com>"],
            ).unwrap();
            id
        };

        let msgs = list_by_thread(&db, thread_id).unwrap();
        assert_eq!(msgs.len(), 1);
    }

    #[test]
    fn list_by_thread_keeps_distinct_messages() {
        let db = Database::open_in_memory().unwrap();
        let account = insert_account(&db, &sample_account()).unwrap();
        let inbox = upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap().id;
        insert_headers(&db, inbox, &[make_header(1, 1000), make_header(2, 2000)]).unwrap();

        let thread_id = {
            let conn = db.conn();
            conn.execute(
                "INSERT INTO threads (account_id, subject_root, last_date) VALUES (?1, 's', 2000)",
                params![account.id],
            ).unwrap();
            let id = conn.last_insert_rowid();
            conn.execute("UPDATE messages SET thread_id = ?1", params![id]).unwrap();
            id
        };

        let msgs = list_by_thread(&db, thread_id).unwrap();
        assert_eq!(msgs.len(), 2);
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
        let listed = list_by_folder(&db, drafts_folder_id, 100, 0, i64::MAX).unwrap();
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
        let msg = list_by_folder(&db, folder_id, 1, 0, i64::MAX).unwrap().into_iter().next().unwrap();
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
    fn get_recipients_returns_stored_to_and_cc() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        insert_headers(&db, folder_id, &[make_header(1, 1000)]).unwrap();
        let msg = list_by_folder(&db, folder_id, 1, 0, i64::MAX).unwrap().into_iter().next().unwrap();
        store_recipients(
            &db,
            msg.id,
            &["alice@example.com".to_string(), "bob@example.com".to_string()],
            &["carol@example.com".to_string()],
        )
        .unwrap();
        let (to, cc) = get_recipients(&db, msg.id).unwrap();
        assert_eq!(to, vec!["alice@example.com", "bob@example.com"]);
        assert_eq!(cc, vec!["carol@example.com"]);
    }

    #[test]
    fn get_recipients_defaults_to_empty_when_unset() {
        let db = Database::open_in_memory().unwrap();
        let folder_id = setup(&db);
        insert_headers(&db, folder_id, &[make_header(1, 1000)]).unwrap();
        let msg = list_by_folder(&db, folder_id, 1, 0, i64::MAX).unwrap().into_iter().next().unwrap();
        let (to, cc) = get_recipients(&db, msg.id).unwrap();
        assert!(to.is_empty());
        assert!(cc.is_empty());
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

    #[test]
    fn set_deleted_hides_from_folder_and_thread_lists() {
        let db = Database::open_in_memory().unwrap();
        let account = crate::accounts_repo::insert_account(&db, &NewAccount {
            email: "d@e.com".into(), display_name: "D".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = crate::folders_repo::upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        let h = |uid: i64, msgid: &str| NewMessageHeader {
            uid, message_id_hdr: Some(msgid.into()), in_reply_to: None, references_hdr: None,
            from_address: "s@e.com".into(), from_name: None, subject: "S".into(), date: uid,
            seen: false, flagged: false, answered: false, has_attachments: false, size: 1, snippet: "x".into(),
        };
        insert_headers(&db, folder.id, &[h(1, "<a@e>"), h(2, "<b@e>")]).unwrap();
        let ids: Vec<i64> = list_by_folder(&db, folder.id, 50, 0, i64::MAX).unwrap().iter().map(|m| m.id).collect();
        assert_eq!(ids.len(), 2);
        let tid = crate::threads_repo::create(&db, account.id, "S", 2).unwrap();
        for id in &ids { assign_thread(&db, *id, tid).unwrap(); }

        set_deleted(&db, ids[0], true).unwrap();

        assert_eq!(list_by_folder(&db, folder.id, 50, 0, i64::MAX).unwrap().len(), 1);
        assert_eq!(list_by_thread(&db, tid).unwrap().len(), 1);
        set_deleted(&db, ids[0], false).unwrap();
        assert_eq!(list_by_folder(&db, folder.id, 50, 0, i64::MAX).unwrap().len(), 2);
    }

    #[test]
    fn mark_folder_seen_clears_unread_and_reports_count() {
        let db = Database::open_in_memory().unwrap();
        let folder = setup(&db);
        insert_headers(&db, folder, &[make_header(1, 1000), make_header(2, 2000)]).unwrap();
        assert_eq!(crate::folders_repo::recount_unread(&db, folder).unwrap(), 2);

        let changed = mark_folder_seen(&db, folder).unwrap();
        assert_eq!(changed, 2);
        assert_eq!(crate::folders_repo::recount_unread(&db, folder).unwrap(), 0);
    }

    #[test]
    fn thread_ids_in_folder_returns_distinct_non_null() {
        let db = Database::open_in_memory().unwrap();
        let account = insert_account(&db, &sample_account()).unwrap();
        let folder = upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap().id;
        insert_headers(&db, folder, &[make_header(1, 1000), make_header(2, 2000)]).unwrap();
        let ids = ids_by_uids(&db, folder, &[1, 2]).unwrap();
        let thread_id = crate::threads_repo::create(&db, account.id, "S", 1000).unwrap();
        db.conn().execute(
            "UPDATE messages SET thread_id = ?1 WHERE id IN (?2, ?3)",
            params![thread_id, ids[0], ids[1]],
        ).unwrap();

        let threads = thread_ids_in_folder(&db, folder).unwrap();
        assert_eq!(threads, vec![thread_id]);
    }

    #[test]
    fn body_state_tracks_download_and_pending_queries() {
        use am_core::account::{NewAccount, ProviderType};
        use am_core::folder::FolderType;
        use am_core::message::{MessageBody, NewMessageHeader};

        let db = Database::open_in_memory().unwrap();
        let account = crate::accounts_repo::insert_account(&db, &NewAccount {
            email: "p@e.com".into(), display_name: "P".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = crate::folders_repo::upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        let h = |uid: i64| NewMessageHeader {
            uid, message_id_hdr: Some(format!("<m{uid}@e>")), in_reply_to: None, references_hdr: None,
            from_address: "s@e.com".into(), from_name: None, subject: "S".into(), date: uid,
            seen: false, flagged: false, answered: false, has_attachments: false, size: 1, snippet: String::new(),
        };
        insert_headers(&db, folder.id, &[h(1), h(2)]).unwrap();

        assert_eq!(count_without_body(&db, folder.id).unwrap(), 2);
        let pending = uids_without_body(&db, folder.id, 10).unwrap();
        assert_eq!(pending.len(), 2);
        assert_eq!(pending[0].1, 2);

        let first_id = pending[0].0;
        store_body(&db, first_id, &MessageBody {
            message_id: first_id, text_plain: Some("hi".into()), text_html: None,
        }).unwrap();

        assert_eq!(count_without_body(&db, folder.id).unwrap(), 1);
        assert!(get_body(&db, first_id).unwrap().is_some());
        assert_eq!(uids_without_body(&db, folder.id, 10).unwrap().len(), 1);
    }

    #[test]
    fn count_active_by_folder_excludes_deleted() {
        use am_core::account::{NewAccount, ProviderType};
        use am_core::folder::FolderType;
        use am_core::message::NewMessageHeader;

        let db = Database::open_in_memory().unwrap();
        let account = crate::accounts_repo::insert_account(&db, &NewAccount {
            email: "a@e.com".into(), display_name: "A".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = crate::folders_repo::upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        let h = |uid: i64| NewMessageHeader {
            uid, message_id_hdr: Some(format!("<m{uid}@e>")), in_reply_to: None, references_hdr: None,
            from_address: "s@e.com".into(), from_name: None, subject: "S".into(), date: uid,
            seen: false, flagged: false, answered: false, has_attachments: false, size: 1, snippet: String::new(),
        };
        insert_headers(&db, folder.id, &[h(1), h(2)]).unwrap();
        assert_eq!(count_active_by_folder(&db, folder.id).unwrap(), 2);
        assert_eq!(count_by_folder(&db, folder.id).unwrap(), 2);

        let first_id = uids_without_body(&db, folder.id, 10).unwrap()[0].0;
        set_deleted(&db, first_id, true).unwrap();
        assert_eq!(count_active_by_folder(&db, folder.id).unwrap(), 1);
        assert_eq!(count_by_folder(&db, folder.id).unwrap(), 2);
    }
}
