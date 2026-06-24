use rusqlite::params;

use crate::db::{Database, StorageError};
use crate::search_repo::reindex_message_conn;
use crate::settings_repo::{get_setting, set_setting};

const REDECODE_FLAG: &str = "maint.redecode_headers_v1";

pub fn redecode_legacy_headers(
    db: &Database,
    decode: impl Fn(&str) -> String,
) -> Result<usize, StorageError> {
    if get_setting(db, REDECODE_FLAG)?.is_some() {
        return Ok(0);
    }

    let updated = {
        let conn = db.conn();
        let mut stmt = conn.prepare(
            "SELECT id, subject, from_name FROM messages
             WHERE subject LIKE ?1 OR from_name LIKE ?1",
        )?;
        let rows = stmt
            .query_map(params!["%=?%"], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, rusqlite::Error>>()?;
        drop(stmt);

        let mut count = 0usize;
        for (id, subject, from_name) in rows {
            let new_subject = decode(&subject);
            let new_from_name = from_name.as_ref().map(|s| decode(s));
            if new_subject == subject && new_from_name == from_name {
                continue;
            }
            conn.execute(
                "UPDATE messages SET subject = ?2, from_name = ?3 WHERE id = ?1",
                params![id, new_subject, new_from_name],
            )?;
            reindex_message_conn(&conn, id)?;
            count += 1;
        }
        count
    };

    set_setting(db, REDECODE_FLAG, "done")?;
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use crate::folders_repo::upsert_folder;
    use crate::messages_repo::{ids_by_uids, insert_headers};
    use crate::search_repo::reindex_message;
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::NewMessageHeader;
    use rusqlite::params;

    fn strip(s: &str) -> String {
        s.replace("=?UTF-8?Q?", "").replace("?=", "")
    }

    fn h(uid: i64, subject: &str, from_name: Option<&str>) -> NewMessageHeader {
        NewMessageHeader {
            uid,
            message_id_hdr: None,
            in_reply_to: None,
            references_hdr: None,
            from_address: "a@b.c".into(),
            from_name: from_name.map(|s| s.to_string()),
            subject: subject.into(),
            date: 1000,
            seen: false,
            flagged: false,
            answered: false,
            has_attachments: false,
            size: 0,
            snippet: String::new(),
        }
    }

    fn setup() -> (Database, i64) {
        let db = Database::open_in_memory().unwrap();
        let acc = insert_account(
            &db,
            &NewAccount {
                email: "s@e.com".into(),
                display_name: "S".into(),
                provider_type: ProviderType::ImapPassword,
                color: None,
            },
        )
        .unwrap();
        let folder = upsert_folder(&db, acc.id, "INBOX", "Inbox", FolderType::Inbox)
            .unwrap()
            .id;
        (db, folder)
    }

    #[test]
    fn redecodes_encoded_headers_updates_messages_and_fts_and_is_idempotent() {
        let (db, folder) = setup();
        insert_headers(
            &db,
            folder,
            &[
                h(1, "=?UTF-8?Q?Zlecenie?=", Some("=?UTF-8?Q?Jan?=")),
                h(2, "Czysty temat", Some("Anna")),
            ],
        )
        .unwrap();

        let id1 = ids_by_uids(&db, folder, &[1]).unwrap()[0];
        let id2 = ids_by_uids(&db, folder, &[2]).unwrap()[0];
        reindex_message(&db, id1).unwrap();

        let updated = redecode_legacy_headers(&db, strip).unwrap();
        assert_eq!(updated, 1, "only the row with '=?' should be rewritten");

        let subject: String = db
            .conn()
            .query_row("SELECT subject FROM messages WHERE id = ?1", params![id1], |r| r.get(0))
            .unwrap();
        assert_eq!(subject, "Zlecenie");

        let from_name: Option<String> = db
            .conn()
            .query_row("SELECT from_name FROM messages WHERE id = ?1", params![id1], |r| r.get(0))
            .unwrap();
        assert_eq!(from_name.as_deref(), Some("Jan"));

        let fts_subject: String = db
            .conn()
            .query_row("SELECT subject FROM search_fts WHERE rowid = ?1", params![id1], |r| r.get(0))
            .unwrap();
        assert_eq!(fts_subject, "Zlecenie", "search index must reflect decoded subject");

        let clean: String = db
            .conn()
            .query_row("SELECT subject FROM messages WHERE id = ?1", params![id2], |r| r.get(0))
            .unwrap();
        assert_eq!(clean, "Czysty temat", "rows without '=?' must stay untouched");

        let second = redecode_legacy_headers(&db, strip).unwrap();
        assert_eq!(second, 0, "second run must be a no-op (idempotent)");
    }
}
