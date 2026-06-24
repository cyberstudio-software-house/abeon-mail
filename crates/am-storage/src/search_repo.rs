use am_core::search::ParsedQuery;
use am_core::smart::SmartMessageRow;
use rusqlite::{params, Connection, OptionalExtension};

use crate::db::{Database, StorageError};
use crate::smart_repo::row_to_smart;

pub fn reindex_message_conn(conn: &Connection, message_id: i64) -> rusqlite::Result<()> {
    let (subject, from_address, to_addresses): (String, String, String) = conn.query_row(
        "SELECT subject, from_address, to_addresses FROM messages WHERE id = ?1",
        params![message_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;

    let body_text: String = conn
        .query_row(
            "SELECT COALESCE(text_plain, '') FROM message_bodies WHERE message_id = ?1",
            params![message_id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_default();

    let attachment_names: String = conn.query_row(
        "SELECT COALESCE(group_concat(filename, ' '), '') FROM attachments WHERE message_id = ?1",
        params![message_id],
        |r| r.get(0),
    )?;

    conn.execute("DELETE FROM search_fts WHERE rowid = ?1", params![message_id])?;
    conn.execute(
        "INSERT INTO search_fts (rowid, subject, from_address, to_addresses, body_text, attachment_names)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![message_id, subject, from_address, to_addresses, body_text, attachment_names],
    )?;
    Ok(())
}

pub fn reindex_message(db: &Database, message_id: i64) -> Result<(), StorageError> {
    let conn = db.conn();
    reindex_message_conn(&conn, message_id)?;
    Ok(())
}

pub fn search(
    db: &Database,
    parsed: &ParsedQuery,
    limit: i64,
    offset: i64,
) -> Result<Vec<SmartMessageRow>, StorageError> {
    if parsed.fts_match.is_none() && !parsed.require_attachment {
        return Ok(Vec::new());
    }

    let select = "SELECT m.id, m.account_id, m.folder_id, a.color,
            m.from_address, m.from_name, m.subject, m.date,
            m.seen, m.flagged, m.has_attachments, m.snippet";
    let exclusions =
        "m.draft = 0 AND m.deleted = 0 AND f.folder_type NOT IN ('trash', 'spam')";

    let conn = db.conn();
    let mut out = Vec::new();

    match &parsed.fts_match {
        Some(match_expr) => {
            let attach = if parsed.require_attachment {
                "AND m.has_attachments = 1"
            } else {
                ""
            };
            let sql = format!(
                "{select}
                 FROM search_fts s
                 JOIN messages m ON m.id = s.rowid
                 JOIN folders f ON f.id = m.folder_id
                 JOIN accounts a ON a.id = m.account_id
                 WHERE search_fts MATCH ?1 AND {exclusions} {attach}
                 ORDER BY m.date DESC
                 LIMIT ?2 OFFSET ?3"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![match_expr, limit, offset], row_to_smart)?;
            for r in rows {
                out.push(r?);
            }
        }
        None => {
            let sql = format!(
                "{select}
                 FROM messages m
                 JOIN folders f ON f.id = m.folder_id
                 JOIN accounts a ON a.id = m.account_id
                 WHERE {exclusions} AND m.has_attachments = 1
                 ORDER BY m.date DESC
                 LIMIT ?1 OFFSET ?2"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![limit, offset], row_to_smart)?;
            for r in rows {
                out.push(r?);
            }
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use crate::folders_repo::upsert_folder;
    use crate::messages_repo::{delete_by_uids, insert_headers, store_body, store_recipients};
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::{MessageBody, NewMessageHeader};
    use am_core::search::parse_query;

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

    fn header(uid: i64, subject: &str, from: &str, has_attachments: bool) -> NewMessageHeader {
        NewMessageHeader {
            uid,
            message_id_hdr: Some(format!("<msg-{uid}@example.com>")),
            in_reply_to: None,
            references_hdr: None,
            from_address: from.into(),
            from_name: Some("Sender".into()),
            subject: subject.into(),
            date: 1000 + uid,
            seen: false,
            flagged: false,
            answered: false,
            has_attachments,
            size: 512,
            snippet: "preview".into(),
        }
    }

    fn message_id_for(db: &Database, folder_id: i64, uid: i64) -> i64 {
        let conn = db.conn();
        conn.query_row(
            "SELECT id FROM messages WHERE folder_id = ?1 AND uid = ?2",
            params![folder_id, uid],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn headers_are_searchable_after_insert() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", Some("#ff0000"));
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, "Quarterly report", "alice@example.com", false)]).unwrap();

        let rows = search(&db, &parse_query("report"), 50, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].subject, "Quarterly report");
        assert_eq!(rows[0].account_color.as_deref(), Some("#ff0000"));
    }

    #[test]
    fn from_operator_matches_sender() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[
            header(1, "Hello", "alice@example.com", false),
            header(2, "Hi", "bob@example.com", false),
        ]).unwrap();

        let rows = search(&db, &parse_query("from:alice"), 50, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].from_address, "alice@example.com");
    }

    #[test]
    fn body_is_searchable_only_after_reindex() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, "No keyword here", "a@example.com", false)]).unwrap();
        let id = message_id_for(&db, inbox, 1);

        assert_eq!(search(&db, &parse_query("kangaroo"), 50, 0).unwrap().len(), 0);

        store_body(&db, id, &MessageBody {
            message_id: id,
            text_plain: Some("a wild kangaroo appears".into()),
            text_html: None,
        }).unwrap();
        reindex_message(&db, id).unwrap();

        assert_eq!(search(&db, &parse_query("kangaroo"), 50, 0).unwrap().len(), 1);
    }

    #[test]
    fn diacritics_are_folded() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, "Rapórt roczny", "a@example.com", false)]).unwrap();

        let rows = search(&db, &parse_query("raport"), 50, 0).unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn excludes_trash_spam_draft_deleted() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        let trash = make_folder(&db, acc, "Trash", FolderType::Trash);
        insert_headers(&db, inbox, &[header(1, "findme inbox", "a@example.com", false)]).unwrap();
        insert_headers(&db, trash, &[header(2, "findme trash", "a@example.com", false)]).unwrap();
        insert_headers(&db, inbox, &[header(3, "findme draft", "a@example.com", false)]).unwrap();
        {
            let conn = db.conn();
            conn.execute("UPDATE messages SET draft = 1 WHERE folder_id = ?1 AND uid = 3", params![inbox]).unwrap();
        }

        let rows = search(&db, &parse_query("findme"), 50, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].subject, "findme inbox");
    }

    #[test]
    fn attachment_only_query_lists_attachment_messages() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[
            header(1, "with file", "a@example.com", true),
            header(2, "no file", "a@example.com", false),
        ]).unwrap();

        let rows = search(&db, &parse_query("has:attachment"), 50, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].subject, "with file");
    }

    #[test]
    fn empty_query_returns_nothing() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, "anything", "a@example.com", false)]).unwrap();

        assert_eq!(search(&db, &parse_query(""), 50, 0).unwrap().len(), 0);
    }

    #[test]
    fn delete_removes_from_index_via_trigger() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, "deleteme soon", "a@example.com", false)]).unwrap();
        assert_eq!(search(&db, &parse_query("deleteme"), 50, 0).unwrap().len(), 1);

        delete_by_uids(&db, inbox, &[1]).unwrap();
        assert_eq!(search(&db, &parse_query("deleteme"), 50, 0).unwrap().len(), 0);
    }

    #[test]
    fn to_operator_matches_after_store_recipients() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, "No keyword in subject", "sender@example.com", false)]).unwrap();
        let id = message_id_for(&db, inbox, 1);

        assert_eq!(search(&db, &parse_query("to:alice"), 50, 0).unwrap().len(), 0);

        store_recipients(&db, id, &["alice@example.com".into()], &[]).unwrap();
        reindex_message(&db, id).unwrap();

        assert_eq!(search(&db, &parse_query("to:alice"), 50, 0).unwrap().len(), 1);
    }

    #[test]
    fn deleted_message_excluded_from_search() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[
            header(1, "findme deleted", "a@example.com", false),
            header(2, "findme alive", "a@example.com", false),
        ]).unwrap();
        let deleted_id = message_id_for(&db, inbox, 1);
        {
            let conn = db.conn();
            conn.execute("UPDATE messages SET deleted = 1 WHERE id = ?1", params![deleted_id]).unwrap();
        }
        let rows = search(&db, &parse_query("findme"), 50, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].subject, "findme alive");
    }

    #[test]
    fn results_ordered_date_desc_cross_account() {
        let db = Database::open_in_memory().unwrap();
        let acc1 = make_account(&db, "a@example.com", Some("#111111"));
        let acc2 = make_account(&db, "b@example.com", Some("#222222"));
        let in1 = make_folder(&db, acc1, "INBOX", FolderType::Inbox);
        let in2 = make_folder(&db, acc2, "INBOX", FolderType::Inbox);
        insert_headers(&db, in1, &[header(1, "shared topic old", "a@example.com", false)]).unwrap();
        insert_headers(&db, in2, &[header(2, "shared topic new", "b@example.com", false)]).unwrap();

        let rows = search(&db, &parse_query("shared"), 50, 0).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows[0].date >= rows[1].date);
    }
}
