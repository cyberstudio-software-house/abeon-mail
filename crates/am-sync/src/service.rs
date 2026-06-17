use am_auth::endpoints::Endpoints;
use am_core::account::{Account, NewAccount, ProviderType};
use am_core::folder::FolderType;
use am_core::message::{MessageBody, NewMessageHeader, SyncProgress};
use am_protocols::imap::{FetchedHeader, ImapConfig, ImapSession, RemoteFolder};
use am_storage::{accounts_repo, folders_repo, messages_repo, Database, StorageError};

const INITIAL_SYNC_LIMIT: u32 = 200;
const INBOX_PATH: &str = "INBOX";

#[derive(Clone)]
pub struct AddAccountInput {
    pub email: String,
    pub display_name: String,
    pub password: String,
    pub endpoints: Endpoints,
}

impl std::fmt::Debug for AddAccountInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AddAccountInput")
            .field("email", &self.email)
            .field("display_name", &self.display_name)
            .field("password", &"***")
            .field("endpoints", &self.endpoints)
            .finish()
    }
}

#[derive(thiserror::Error, Debug)]
pub enum SyncError {
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("authentication failed")]
    Auth,
    #[error("credential not found")]
    CredentialMissing,
    #[error("invalid account settings")]
    InvalidSettings,
    #[error("keychain unavailable")]
    Keychain,
}

impl From<am_protocols::error::ProtocolError> for SyncError {
    fn from(e: am_protocols::error::ProtocolError) -> Self {
        match e {
            am_protocols::error::ProtocolError::Auth => SyncError::Auth,
            other => SyncError::Protocol(other.to_string()),
        }
    }
}

impl From<am_auth::AuthError> for SyncError {
    fn from(e: am_auth::AuthError) -> Self {
        match e {
            am_auth::AuthError::NotFound => SyncError::CredentialMissing,
            am_auth::AuthError::Keychain(_) => SyncError::Keychain,
        }
    }
}

fn folder_type_for(remote_path: &str, special_use: Option<&str>) -> FolderType {
    if remote_path.eq_ignore_ascii_case(INBOX_PATH) {
        return FolderType::Inbox;
    }
    match special_use {
        Some("\\Sent") => FolderType::Sent,
        Some("\\Drafts") => FolderType::Drafts,
        Some("\\Trash") => FolderType::Trash,
        Some("\\Junk") => FolderType::Spam,
        Some("\\Archive") => FolderType::Archive,
        _ => FolderType::Custom,
    }
}

fn imap_config(endpoints: &Endpoints, username: &str) -> ImapConfig {
    ImapConfig {
        host: endpoints.imap_host.clone(),
        port: endpoints.imap_port,
        tls: endpoints.imap_tls,
        username: username.to_string(),
    }
}

fn header_from_fetch(fetched: &FetchedHeader) -> NewMessageHeader {
    NewMessageHeader {
        uid: fetched.uid,
        message_id_hdr: fetched.message_id_hdr.clone(),
        from_address: fetched.from_address.clone(),
        from_name: fetched.from_name.clone(),
        subject: fetched.subject.clone(),
        date: fetched.date,
        seen: fetched.seen,
        flagged: fetched.flagged,
        has_attachments: false,
        size: fetched.size,
        snippet: String::new(),
    }
}

fn load_endpoints(db: &Database, account_id: i64) -> Result<Endpoints, SyncError> {
    let settings = accounts_repo::get_account_settings(db, account_id)?;
    serde_json::from_str(&settings).map_err(|_| SyncError::InvalidSettings)
}

fn upsert_remote_folders(
    db: &Database,
    account_id: i64,
    folders: &[RemoteFolder],
) -> Result<(), SyncError> {
    for folder in folders {
        let folder_type = folder_type_for(&folder.remote_path, folder.special_use.as_deref());
        folders_repo::upsert_folder(
            db,
            account_id,
            &folder.remote_path,
            &folder.name,
            folder_type,
        )?;
    }
    Ok(())
}

pub async fn add_account(db: &Database, input: AddAccountInput) -> Result<Account, SyncError> {
    am_auth::credentials::store_password(&input.email, &input.password)?;

    let settings = serde_json::to_string(&input.endpoints).map_err(|_| SyncError::InvalidSettings)?;
    let new_account = NewAccount {
        email: input.email.clone(),
        display_name: input.display_name.clone(),
        provider_type: ProviderType::ImapPassword,
        color: None,
    };
    let account =
        accounts_repo::insert_account_with_settings(db, &new_account, &input.email, &settings)?;

    let config = imap_config(&input.endpoints, &input.email);
    let mut session = ImapSession::connect(&config, &input.password).await?;
    let folders = session.list_folders().await?;
    session.logout().await?;

    upsert_remote_folders(db, account.id, &folders)?;

    initial_sync_inbox(db, account.id, |_| {}).await?;

    Ok(account)
}

pub async fn initial_sync_inbox(
    db: &Database,
    account_id: i64,
    progress: impl Fn(SyncProgress),
) -> Result<usize, SyncError> {
    let account = accounts_repo::get_account(db, account_id)?;
    let endpoints = load_endpoints(db, account_id)?;
    let password = am_auth::credentials::load_password(&account.email)?;

    let config = imap_config(&endpoints, &account.email);
    let mut session = ImapSession::connect(&config, &password).await?;
    let state = session.select(INBOX_PATH).await?;
    let fetched = session.fetch_recent_headers(INITIAL_SYNC_LIMIT).await?;
    session.logout().await?;

    let folder = folders_repo::list_folders(db, account_id)?
        .into_iter()
        .find(|f| f.remote_path.eq_ignore_ascii_case(INBOX_PATH))
        .ok_or(SyncError::Storage(StorageError::NotFound))?;

    let headers: Vec<NewMessageHeader> = fetched.iter().map(header_from_fetch).collect();
    let inserted = messages_repo::insert_headers(db, folder.id, &headers)?;

    folders_repo::set_uid_state(db, folder.id, state.uidvalidity, state.uidnext)?;

    let unread = fetched.iter().filter(|h| !h.seen).count() as i64;
    folders_repo::set_counts(db, folder.id, unread, state.exists)?;

    progress(SyncProgress {
        account_id,
        folder_id: folder.id,
        fetched: fetched.len() as i64,
        total: state.exists,
    });

    Ok(inserted)
}

pub async fn get_or_fetch_body(db: &Database, message_id: i64) -> Result<MessageBody, SyncError> {
    if let Some(body) = messages_repo::get_body(db, message_id)? {
        return Ok(body);
    }

    let (folder_id, uid) = messages_repo::message_uid(db, message_id)?;
    let folder = folders_repo::get_folder(db, folder_id)?;
    let account = accounts_repo::get_account(db, folder.account_id)?;
    let endpoints = load_endpoints(db, folder.account_id)?;
    let password = am_auth::credentials::load_password(&account.email)?;

    let config = imap_config(&endpoints, &account.email);
    let mut session = ImapSession::connect(&config, &password).await?;
    session.select(&folder.remote_path).await?;
    let raw = session.fetch_body(uid).await?;
    session.logout().await?;

    let parsed = am_mime::parse::parse_message(&raw);
    let body = MessageBody {
        message_id,
        text_plain: parsed.text_plain,
        text_html: parsed.text_html,
    };
    messages_repo::store_body(db, message_id, &body)?;
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_type_mapping_covers_special_use() {
        assert_eq!(folder_type_for("INBOX", None), FolderType::Inbox);
        assert_eq!(folder_type_for("inbox", None), FolderType::Inbox);
        assert_eq!(folder_type_for("Sent", Some("\\Sent")), FolderType::Sent);
        assert_eq!(folder_type_for("Drafts", Some("\\Drafts")), FolderType::Drafts);
        assert_eq!(folder_type_for("Trash", Some("\\Trash")), FolderType::Trash);
        assert_eq!(folder_type_for("Junk", Some("\\Junk")), FolderType::Spam);
        assert_eq!(folder_type_for("Archive", Some("\\Archive")), FolderType::Archive);
        assert_eq!(folder_type_for("Work", None), FolderType::Custom);
        assert_eq!(folder_type_for("All", Some("\\All")), FolderType::Custom);
    }

    #[test]
    fn header_from_fetch_clears_snippet_and_attachments() {
        let fetched = FetchedHeader {
            uid: 7,
            message_id_hdr: Some("<id@example.com>".into()),
            from_address: "a@b.com".into(),
            from_name: Some("A".into()),
            subject: "Hi".into(),
            date: 123,
            seen: true,
            flagged: false,
            size: 42,
        };
        let header = header_from_fetch(&fetched);
        assert_eq!(header.uid, 7);
        assert_eq!(header.subject, "Hi");
        assert_eq!(header.size, 42);
        assert!(header.seen);
        assert_eq!(header.snippet, "");
        assert!(!header.has_attachments);
    }

    #[test]
    fn sync_error_never_contains_password() {
        let err = SyncError::Auth;
        assert_eq!(err.to_string(), "authentication failed");
    }
}
