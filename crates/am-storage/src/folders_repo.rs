use am_core::folder::{Folder, FolderType};
use rusqlite::params;

use crate::db::{Database, StorageError};

fn folder_type_to_str(ft: &FolderType) -> &'static str {
    match ft {
        FolderType::Inbox => "inbox",
        FolderType::Sent => "sent",
        FolderType::Drafts => "drafts",
        FolderType::Trash => "trash",
        FolderType::Spam => "spam",
        FolderType::Archive => "archive",
        FolderType::Custom => "custom",
    }
}

fn folder_type_from_str(s: &str) -> Result<FolderType, StorageError> {
    match s {
        "inbox" => Ok(FolderType::Inbox),
        "sent" => Ok(FolderType::Sent),
        "drafts" => Ok(FolderType::Drafts),
        "trash" => Ok(FolderType::Trash),
        "spam" => Ok(FolderType::Spam),
        "archive" => Ok(FolderType::Archive),
        "custom" => Ok(FolderType::Custom),
        other => Err(StorageError::InvalidData(format!("unknown folder type: {other}"))),
    }
}

fn row_to_folder(row: &rusqlite::Row) -> rusqlite::Result<(i64, i64, String, String, String, i64, i64)> {
    Ok((
        row.get::<_, i64>(0)?,
        row.get::<_, i64>(1)?,
        row.get::<_, String>(2)?,
        row.get::<_, String>(3)?,
        row.get::<_, String>(4)?,
        row.get::<_, i64>(5)?,
        row.get::<_, i64>(6)?,
    ))
}

fn tuple_to_folder(
    (id, account_id, remote_path, name, folder_type, unread_count, total_count): (i64, i64, String, String, String, i64, i64),
) -> Result<Folder, StorageError> {
    Ok(Folder {
        id,
        account_id,
        remote_path,
        name,
        folder_type: folder_type_from_str(&folder_type)?,
        unread_count,
        total_count,
    })
}

pub fn upsert_folder(
    db: &Database,
    account_id: i64,
    remote_path: &str,
    name: &str,
    folder_type: FolderType,
) -> Result<Folder, StorageError> {
    let ft_str = folder_type_to_str(&folder_type);
    {
        let conn = db.conn();
        conn.execute(
            "INSERT INTO folders (account_id, remote_path, name, folder_type)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(account_id, remote_path) DO UPDATE SET name = excluded.name, folder_type = excluded.folder_type",
            params![account_id, remote_path, name, ft_str],
        )?;
    }
    let id = {
        let conn = db.conn();
        conn.query_row(
            "SELECT id FROM folders WHERE account_id = ?1 AND remote_path = ?2",
            params![account_id, remote_path],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
            other => StorageError::Sqlite(other),
        })?
    };
    get_folder(db, id)
}

pub fn list_folders(db: &Database, account_id: i64) -> Result<Vec<Folder>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, account_id, remote_path, name, folder_type, unread_count, total_count
         FROM folders WHERE account_id = ?1 ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![account_id], row_to_folder)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(tuple_to_folder(r?)?);
    }
    Ok(out)
}

pub fn get_folder(db: &Database, id: i64) -> Result<Folder, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT id, account_id, remote_path, name, folder_type, unread_count, total_count
         FROM folders WHERE id = ?1",
        params![id],
        row_to_folder,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound,
        other => StorageError::Sqlite(other),
    })
    .and_then(tuple_to_folder)
}

pub fn set_uid_state(
    db: &Database,
    folder_id: i64,
    uidvalidity: i64,
    uidnext: i64,
) -> Result<(), StorageError> {
    let conn = db.conn();
    let changed = conn.execute(
        "UPDATE folders SET uidvalidity = ?2, uidnext = ?3 WHERE id = ?1",
        params![folder_id, uidvalidity, uidnext],
    )?;
    if changed == 0 {
        return Err(StorageError::NotFound);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use am_core::account::{NewAccount, ProviderType};
    use crate::db::Database;

    fn sample_account() -> NewAccount {
        NewAccount {
            email: "test@example.com".into(),
            display_name: "Test".into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        }
    }

    #[test]
    fn upsert_creates_and_returns_folder() {
        let db = Database::open_in_memory().unwrap();
        let account = insert_account(&db, &sample_account()).unwrap();
        let folder = upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        assert_eq!(folder.account_id, account.id);
        assert_eq!(folder.remote_path, "INBOX");
        assert_eq!(folder.name, "Inbox");
        assert_eq!(folder.folder_type, FolderType::Inbox);
    }

    #[test]
    fn upsert_is_idempotent_on_same_remote_path() {
        let db = Database::open_in_memory().unwrap();
        let account = insert_account(&db, &sample_account()).unwrap();
        let first = upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        let second = upsert_folder(&db, account.id, "INBOX", "Renamed Inbox", FolderType::Custom).unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(second.name, "Renamed Inbox");
        assert_eq!(second.folder_type, FolderType::Custom);
    }

    #[test]
    fn list_folders_returns_all_for_account() {
        let db = Database::open_in_memory().unwrap();
        let account = insert_account(&db, &sample_account()).unwrap();
        upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        upsert_folder(&db, account.id, "Sent", "Sent", FolderType::Sent).unwrap();
        let folders = list_folders(&db, account.id).unwrap();
        assert_eq!(folders.len(), 2);
    }

    #[test]
    fn get_folder_not_found() {
        let db = Database::open_in_memory().unwrap();
        let err = get_folder(&db, 999).unwrap_err();
        assert!(matches!(err, StorageError::NotFound));
    }

    #[test]
    fn set_uid_state_updates_values() {
        let db = Database::open_in_memory().unwrap();
        let account = insert_account(&db, &sample_account()).unwrap();
        let folder = upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        set_uid_state(&db, folder.id, 12345, 100).unwrap();
        let conn = db.conn();
        let (uidvalidity, uidnext): (i64, i64) = conn.query_row(
            "SELECT uidvalidity, uidnext FROM folders WHERE id = ?1",
            params![folder.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(uidvalidity, 12345);
        assert_eq!(uidnext, 100);
    }
}
