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

pub fn fill_contact_search_keys(db: &Database) -> Result<usize, StorageError> {
    let rows = {
        let conn = db.conn();
        let mut stmt =
            conn.prepare("SELECT id, email, name FROM contacts_cache WHERE search_key = ''")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, rusqlite::Error>>()?;
        drop(stmt);
        rows
    };

    let conn = db.conn();
    let mut updated = 0usize;
    for (id, email, name) in rows {
        let key = crate::contacts_repo::normalize_search_key(name.as_deref(), &email);
        conn.execute(
            "UPDATE contacts_cache SET search_key = ?2 WHERE id = ?1",
            params![id, key],
        )?;
        updated += 1;
    }
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

    #[test]
    fn fill_contact_search_keys_indexes_backfilled_rows() {
        use crate::contacts_repo::suggest;

        let (db, _) = setup();
        let account_id: i64 = db
            .conn()
            .query_row("SELECT id FROM accounts LIMIT 1", [], |r| r.get(0))
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO contacts_cache (account_id, email, name, exchange_count, last_contact_at, search_key)
                 VALUES (?1, 'l.nowak@firma.pl', 'Łukasz Nowak', 3, 1000, '')",
                params![account_id],
            )
            .unwrap();

        assert!(suggest(&db, "lukasz", None, 8, 5_000).unwrap().is_empty());

        let filled = fill_contact_search_keys(&db).unwrap();
        assert_eq!(filled, 1);

        let found = suggest(&db, "lukasz", None, 8, 5_000).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].email, "l.nowak@firma.pl");

        assert_eq!(fill_contact_search_keys(&db).unwrap(), 0);
    }

    #[test]
    fn migration_v19_backfills_sent_recipients_and_answered_senders() {
        use crate::contacts_repo::suggest;
        use crate::messages_repo::store_recipients;

        let (db, inbox) = setup();
        let account_id: i64 = db
            .conn()
            .query_row("SELECT id FROM accounts LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let sent = upsert_folder(&db, account_id, "Sent", "Sent", FolderType::Sent)
            .unwrap()
            .id;

        let mut sent_header = h(1, "Sent one", None);
        sent_header.from_address = "me@example.com".into();
        insert_headers(&db, sent, &[sent_header]).unwrap();

        let mut answered = h(2, "Answered one", Some("Anna"));
        answered.from_address = "Anna@Dom.pl".into();
        answered.answered = true;
        insert_headers(&db, inbox, &[answered]).unwrap();

        let mut ignored = h(3, "Newsletter", None);
        ignored.from_address = "spam@ads.com".into();
        insert_headers(&db, inbox, &[ignored]).unwrap();

        let sent_msg = ids_by_uids(&db, sent, &[1]).unwrap()[0];
        store_recipients(
            &db,
            sent_msg,
            &["Jan@Firma.PL".into()],
            &["biuro@firma.pl".into()],
        )
        .unwrap();

        db.conn()
            .execute_batch(include_str!("migrations/V19__contacts_backfill.sql"))
            .unwrap();
        fill_contact_search_keys(&db).unwrap();

        assert_eq!(suggest(&db, "jan@firma.pl", None, 8, 5_000).unwrap().len(), 1);
        assert_eq!(
            suggest(&db, "biuro@firma.pl", None, 8, 5_000).unwrap().len(),
            1
        );
        let anna = suggest(&db, "anna@dom.pl", None, 8, 5_000).unwrap();
        assert_eq!(anna.len(), 1);
        assert_eq!(anna[0].name.as_deref(), Some("Anna"));
        assert!(suggest(&db, "spam@ads.com", None, 8, 5_000)
            .unwrap()
            .is_empty());
    }
}
