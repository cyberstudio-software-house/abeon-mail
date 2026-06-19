use am_core::label::Label;
use am_core::smart::SmartMessageRow;
use rusqlite::{params, params_from_iter};

use crate::db::{Database, StorageError};
use crate::smart_repo::row_to_smart;

pub fn list_labels(db: &Database) -> Result<Vec<Label>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare("SELECT id, name, color FROM labels ORDER BY position, name")?;
    let rows = stmt.query_map([], |r| {
        Ok(Label { id: r.get(0)?, name: r.get(1)?, color: r.get(2)? })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn create_label(db: &Database, name: &str, color: &str) -> Result<Label, StorageError> {
    let conn = db.conn();
    conn.execute(
        "INSERT INTO labels (name, color) VALUES (?1, ?2)",
        params![name, color],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Label { id, name: name.to_string(), color: color.to_string() })
}

pub fn rename_label(db: &Database, id: i64, name: &str) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute("UPDATE labels SET name = ?2 WHERE id = ?1", params![id, name])?;
    Ok(())
}

pub fn set_label_color(db: &Database, id: i64, color: &str) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute("UPDATE labels SET color = ?2 WHERE id = ?1", params![id, color])?;
    Ok(())
}

pub fn delete_label(db: &Database, id: i64) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute("DELETE FROM labels WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn set_message_labels(
    db: &Database,
    label_id: i64,
    message_ids: &[i64],
    applied: bool,
) -> Result<(), StorageError> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    {
        if applied {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?1, ?2)",
            )?;
            for &mid in message_ids {
                stmt.execute(params![mid, label_id])?;
            }
        } else {
            let mut stmt = tx.prepare(
                "DELETE FROM message_labels WHERE message_id = ?1 AND label_id = ?2",
            )?;
            for &mid in message_ids {
                stmt.execute(params![mid, label_id])?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn labels_for_messages(
    db: &Database,
    message_ids: &[i64],
) -> Result<Vec<(i64, Label)>, StorageError> {
    if message_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = (1..=message_ids.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT ml.message_id, l.id, l.name, l.color
         FROM message_labels ml
         JOIN labels l ON l.id = ml.label_id
         WHERE ml.message_id IN ({placeholders})
         ORDER BY l.position, l.name"
    );
    let conn = db.conn();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(message_ids.iter()), |r| {
        Ok((
            r.get::<_, i64>(0)?,
            Label { id: r.get(1)?, name: r.get(2)?, color: r.get(3)? },
        ))
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn list_messages_by_label(
    db: &Database,
    label_id: i64,
    limit: i64,
    offset: i64,
    now: i64,
) -> Result<Vec<SmartMessageRow>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT m.id, m.account_id, m.folder_id, a.color,
                m.from_address, m.from_name, m.subject, m.date,
                m.seen, m.flagged, m.has_attachments, m.snippet
         FROM message_labels ml
         JOIN messages m ON m.id = ml.message_id
         JOIN accounts a ON a.id = m.account_id
         WHERE ml.label_id = ?1
           AND m.draft = 0
           AND m.deleted = 0
           AND (m.snooze_wake_at IS NULL OR m.snooze_wake_at <= ?4)
         ORDER BY m.date DESC
         LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![label_id, limit, offset, now], row_to_smart)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
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

    fn make_account(db: &Database, email: &str, color: Option<&str>) -> i64 {
        insert_account(db, &NewAccount {
            email: email.into(),
            display_name: email.into(),
            provider_type: ProviderType::ImapPassword,
            color: color.map(|s| s.to_string()),
        }).unwrap().id
    }

    fn make_folder(db: &Database, account_id: i64, name: &str, ft: FolderType) -> i64 {
        upsert_folder(db, account_id, name, name, ft).unwrap().id
    }

    fn header(uid: i64, subject: &str, date: i64) -> NewMessageHeader {
        NewMessageHeader {
            uid,
            message_id_hdr: Some(format!("<msg-{uid}@example.com>")),
            in_reply_to: None,
            references_hdr: None,
            from_address: "sender@example.com".into(),
            from_name: Some("Sender".into()),
            subject: subject.into(),
            date,
            seen: false,
            flagged: false,
            has_attachments: false,
            size: 100,
            snippet: "preview".into(),
        }
    }

    fn message_id_for(db: &Database, folder_id: i64, uid: i64) -> i64 {
        let conn = db.conn();
        conn.query_row(
            "SELECT id FROM messages WHERE folder_id = ?1 AND uid = ?2",
            params![folder_id, uid],
            |r| r.get(0),
        ).unwrap()
    }

    #[test]
    fn create_and_list_labels_ordered() {
        let db = Database::open_in_memory().unwrap();
        create_label(&db, "Work", "#4f46e5").unwrap();
        create_label(&db, "Personal", "#10b981").unwrap();

        let labels = list_labels(&db).unwrap();
        assert_eq!(labels.len(), 2);
        assert_eq!(labels[0].name, "Personal");
        assert_eq!(labels[1].name, "Work");
        assert_eq!(labels[1].color, "#4f46e5");
        assert!(labels[0].id > 0);
    }

    #[test]
    fn create_label_rejects_duplicate_name() {
        let db = Database::open_in_memory().unwrap();
        create_label(&db, "Work", "#4f46e5").unwrap();
        assert!(create_label(&db, "Work", "#10b981").is_err());
    }

    #[test]
    fn rename_and_recolor_label() {
        let db = Database::open_in_memory().unwrap();
        let l = create_label(&db, "Work", "#4f46e5").unwrap();
        rename_label(&db, l.id, "Job").unwrap();
        set_label_color(&db, l.id, "#ec4899").unwrap();

        let labels = list_labels(&db).unwrap();
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].name, "Job");
        assert_eq!(labels[0].color, "#ec4899");
    }

    #[test]
    fn delete_label_removes_row() {
        let db = Database::open_in_memory().unwrap();
        let l = create_label(&db, "Temp", "#0ea5e9").unwrap();
        delete_label(&db, l.id).unwrap();
        assert_eq!(list_labels(&db).unwrap().len(), 0);
    }

    #[test]
    fn apply_and_remove_message_labels_idempotent() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, "Hello", 1000)]).unwrap();
        let mid = message_id_for(&db, inbox, 1);
        let label = create_label(&db, "Work", "#4f46e5").unwrap();

        set_message_labels(&db, label.id, &[mid], true).unwrap();
        set_message_labels(&db, label.id, &[mid], true).unwrap();
        let pairs = labels_for_messages(&db, &[mid]).unwrap();
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].0, mid);
        assert_eq!(pairs[0].1.name, "Work");

        set_message_labels(&db, label.id, &[mid], false).unwrap();
        set_message_labels(&db, label.id, &[mid], false).unwrap();
        assert_eq!(labels_for_messages(&db, &[mid]).unwrap().len(), 0);
    }

    #[test]
    fn labels_for_messages_empty_ids_returns_empty() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(labels_for_messages(&db, &[]).unwrap().len(), 0);
    }

    #[test]
    fn list_messages_by_label_cross_account_ordered_desc() {
        let db = Database::open_in_memory().unwrap();
        let acc1 = make_account(&db, "a@example.com", Some("#111111"));
        let acc2 = make_account(&db, "b@example.com", Some("#222222"));
        let in1 = make_folder(&db, acc1, "INBOX", FolderType::Inbox);
        let in2 = make_folder(&db, acc2, "INBOX", FolderType::Inbox);
        insert_headers(&db, in1, &[header(1, "old", 1000)]).unwrap();
        insert_headers(&db, in2, &[header(2, "new", 3000)]).unwrap();
        let m1 = message_id_for(&db, in1, 1);
        let m2 = message_id_for(&db, in2, 2);
        let label = create_label(&db, "Shared", "#0ea5e9").unwrap();
        set_message_labels(&db, label.id, &[m1, m2], true).unwrap();

        let rows = list_messages_by_label(&db, label.id, 50, 0, i64::MAX).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].date, 3000);
        assert_eq!(rows[0].account_id, acc2);
        assert_eq!(rows[1].date, 1000);
    }

    #[test]
    fn list_messages_by_label_excludes_draft_and_deleted() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, "live", 1000), header(2, "draft", 2000), header(3, "deleted", 3000)]).unwrap();
        let m1 = message_id_for(&db, inbox, 1);
        let m2 = message_id_for(&db, inbox, 2);
        let m3 = message_id_for(&db, inbox, 3);
        let label = create_label(&db, "L", "#10b981").unwrap();
        set_message_labels(&db, label.id, &[m1, m2, m3], true).unwrap();
        {
            let conn = db.conn();
            conn.execute("UPDATE messages SET draft = 1 WHERE id = ?1", params![m2]).unwrap();
            conn.execute("UPDATE messages SET deleted = 1 WHERE id = ?1", params![m3]).unwrap();
        }

        let rows = list_messages_by_label(&db, label.id, 50, 0, i64::MAX).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].subject, "live");
    }

    #[test]
    fn deleting_message_cascades_message_labels() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com", None);
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, "Hello", 1000)]).unwrap();
        let mid = message_id_for(&db, inbox, 1);
        let label = create_label(&db, "Work", "#4f46e5").unwrap();
        set_message_labels(&db, label.id, &[mid], true).unwrap();

        crate::messages_repo::delete_by_uids(&db, inbox, &[1]).unwrap();
        assert_eq!(labels_for_messages(&db, &[mid]).unwrap().len(), 0);
        assert_eq!(list_labels(&db).unwrap().len(), 1);
    }
}
